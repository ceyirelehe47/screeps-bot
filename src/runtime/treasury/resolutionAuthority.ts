/**
 * Treasury resolution authority（第十一轮 3.13.10，自 facade 抽出——
 * 3.13.8 的 resolution kernel 载体）。
 *
 * service 闭包私有的 reconciliation capability registry（WeakSet 防伪 +
 * 单次使用）与 validate/consume 实现、resolution kernel 对象组装、
 * pre-execution authorization fault 的 acknowledge-rolled-back 恢复协议。
 * capability 消费只发生在 staged resolution 写入成功之后（语义保留）；
 * 生产公开接口只暴露 issueTreasuryReconciliationCapability 与
 * resolveUnresolvedTransaction（facade 委托本模块）。
 */

import type { TreasuryReconciliationCapability } from "@/runtime/treasury/reconciliation";
import type {
  TreasuryReconciliationCapabilityConsumption,
} from "@/runtime/treasury/reconciliation";
import type { TreasuryFaultResolutionResult } from "@/runtime/treasury/faultResolution";
import type { TreasuryAuthorizationFaultEntry } from "@/runtime/treasury/authorizationFaults";
import {
  releaseTreasuryAuthorizationFaultEntry,
} from "@/runtime/treasury/authorizationFaults";
import {
  clearTreasuryWriteFaultMarkerForResolution,
  readTreasuryWriteFault,
} from "@/runtime/treasury/writeFault";
import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";
import {
  ensureTreasuryResolutionSlotAvailable,
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import type { TreasuryResolutionKernel } from "@/runtime/treasury/resolutionKernelChannel";
import type { TreasuryMetrics } from "@/runtime/treasury/types";

/** resolution authority 依赖（facade 闭包注入；metrics 为可变计数引用）。 */
export interface TreasuryResolutionAuthorityDeps {
  readonly serviceGeneration: number;
  readonly metrics: TreasuryMetrics;
}

export interface TreasuryResolutionAuthority {
  /** 签发注册（issueTreasuryReconciliationCapability 成功后调用）。 */
  registerCapability(capability: TreasuryReconciliationCapability): void;
  /** capability 只读验证（对象身份/单次未用/generation/tick——零消费）。 */
  validateReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;
  /** 校验并消费（单次使用；仅 staged resolution 写入成功后调用）。 */
  consumeReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;
  /** 挂载到 service 的 resolution kernel 对象（symbol 通道）。 */
  readonly kernel: TreasuryResolutionKernel;
  /** pre-execution authorization fault 的 acknowledge-rolled-back 恢复。 */
  resolvePreExecutionAuthorizationFault(
    input: { readonly transactionId?: string; readonly digest?: string; readonly acknowledgeRolledBack?: boolean } | undefined,
    fault: Readonly<TreasuryAuthorizationFaultEntry>,
  ): TreasuryFaultResolutionResult;
  /** 【第十二轮 3.1.7】forensic fault marker 的显式确认解除（authority 写入失败兜底）。 */
  resolveForensicAuthorizationFaultMarker(
    input: { readonly transactionId?: string; readonly digest?: string; readonly acknowledgeRolledBack?: boolean } | undefined,
  ): TreasuryFaultResolutionResult;
}

/**
 * 建立 resolution authority（service 闭包私有）：capability registry 与
 * 单次消费语义、resolution kernel 组装、pre-execution 恢复协议。
 */
export function createTreasuryResolutionAuthority(deps: TreasuryResolutionAuthorityDeps): TreasuryResolutionAuthority {
  const capabilityRegistry = new WeakSet<TreasuryReconciliationCapability>();
  const consumedCapabilities = new WeakSet<TreasuryReconciliationCapability>();

  const validate = (capability: unknown): TreasuryReconciliationCapabilityConsumption => {
    if (!capability || typeof capability !== "object" || !capabilityRegistry.has(capability as TreasuryReconciliationCapability)) {
      return {
        status: "rejected",
        reason: "invalid_capability",
        detail: "capability 未在本 service 实例签发（普通对象/JSON round-trip 副本/跨实例一律无效——结论只能来自注册 reconciler）",
      };
    }
    const typed = capability as TreasuryReconciliationCapability;
    if (consumedCapabilities.has(typed)) {
      return { status: "rejected", reason: "already_used", detail: "capability 已消费（单次使用）" };
    }
    if (typed.serviceGeneration !== deps.serviceGeneration) {
      return {
        status: "rejected",
        reason: "cross_generation",
        detail: "capability 由旧 Treasury service 签发（global reset 后必须由新 service 重新签发，不恢复旧 heap token）",
      };
    }
    if (typed.tick !== Game.time) {
      return {
        status: "rejected",
        reason: "cross_tick",
        detail: `capability 于 tick ${String(typed.tick)} 签发（当前 ${String(Game.time)}）——跨 tick 失效`,
      };
    }
    return { status: "valid", capability: typed };
  };

  const consume = (capability: unknown): TreasuryReconciliationCapabilityConsumption => {
    const validated = validate(capability);
    if (validated.status !== "valid") return validated;
    consumedCapabilities.add(validated.capability);
    return validated;
  };

  /**
   * pre-execution authorization fault 的 acknowledge-rolled-back 恢复
   *（第十一轮 3.13.1）：仅适用于 callback 未调用且 rollback 完整确认的
   * internal_authorization_fault——验证完整 authority identity（digest）
   * 后写 not-executed final tombstone（preExecution 标志）→ 清 marker →
   * 删 authority；幂等；global reset 后仍可完成；无任何无条件 clear 入口。
   */
  const resolvePreExecutionAuthorizationFault = (
    input: { readonly transactionId?: string; readonly digest?: string; readonly acknowledgeRolledBack?: boolean } | undefined,
    fault: Readonly<TreasuryAuthorizationFaultEntry>,
  ): TreasuryFaultResolutionResult => {
    const existing = readTreasuryResolutionTombstone(fault.transactionId);
    if (existing !== undefined && existing.stage === "final" && existing.resolution === "not-executed") {
      // 【第十二轮 3.3】幂等仅在完整 attempt identity 一致时成立：旧
      // tombstone 不得解决同 ID 的新 attempt。
      const attempt: TreasuryAttemptIdentity = {
        digest: fault.digest,
        ...(fault.contractDigest !== undefined ? { contractDigest: fault.contractDigest } : {}),
        ...(fault.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: fault.authorizationCohortDigest } : {}),
        ...(fault.durableIdentityDigest !== undefined ? { durableIdentityDigest: fault.durableIdentityDigest } : {}),
      };
      if (treasuryAttemptIdentityRelation(existing, attempt) !== "match") {
        deps.metrics.reconciliationCapabilitiesRejected += 1;
        return {
          status: "rejected",
          reason: "digest_mismatch",
          detail: `既有 not-executed tombstone 与该 fault authority 的 attempt identity 不一致（${fault.transactionId.slice(0, 48)}）——不得以旧 proof 解决新 attempt（fail closed）`,
        };
      }
      clearTreasuryWriteFaultMarkerForResolution(fault.transactionId, fault.digest);
      releaseTreasuryAuthorizationFaultEntry(fault.transactionId);
      return { status: "already_resolved", resolution: "not-executed", transactionId: fault.transactionId };
    }
    if (input?.acknowledgeRolledBack !== true) {
      deps.metrics.reconciliationCapabilitiesRejected += 1;
      return {
        status: "rejected",
        reason: "invalid_input",
        detail: "pre-execution authorization fault 需要 acknowledgeRolledBack: true（显式确认 callback 未调用且 rollback 完整——无任何无条件解除入口）",
      };
    }
    if (input.digest !== undefined && fault.digest !== input.digest) {
      deps.metrics.reconciliationCapabilitiesRejected += 1;
      return {
        status: "rejected",
        reason: "digest_mismatch",
        detail: `pre-execution fault authority digest 不匹配（entry ${fault.digest}，请求 ${input.digest}）`,
      };
    }
    const slotError = ensureTreasuryResolutionSlotAvailable();
    if (slotError !== null) {
      return { status: "rejected", reason: "resolution_store_full", detail: slotError };
    }
    const finalWrite = writeTreasuryResolutionTombstone({
      transactionId: fault.transactionId,
      digest: fault.digest,
      resolution: "not-executed",
      stage: "final",
      actionTick: fault.faultTick,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "pre-execution",
      source: "acknowledge-rolled-back",
      preExecution: true,
      ...(fault.contractDigest !== undefined ? { contractDigest: fault.contractDigest } : {}),
      ...(fault.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: fault.authorizationCohortDigest } : {}),
      ...(fault.durableIdentityDigest !== undefined ? { durableIdentityDigest: fault.durableIdentityDigest } : {}),
    });
    if (finalWrite.status === "rejected") {
      return {
        status: "rejected",
        reason: "resolution_store_fatal",
        detail: `final tombstone 写入失败（fault authority 保留，可重试）: ${finalWrite.detail}`,
      };
    }
    clearTreasuryWriteFaultMarkerForResolution(fault.transactionId, fault.digest);
    releaseTreasuryAuthorizationFaultEntry(fault.transactionId);
    deps.metrics.resolutionRecovered += 1;
    return {
      status: "resolved",
      resolution: "not-executed",
      transactionId: fault.transactionId,
      receiptWritten: false,
      reprepareAllowed: true,
      actionTick: fault.faultTick,
    };
  };

  /**
   * 【第十二轮 3.1.7】forensic fault marker 的显式确认解除：internal
   * authorization fault 的 authority 写入失败（store fatal/容量/identity
   * conflict/read-back 不一致）时发布的 forensic marker 没有 durable fault
   * authority——rollback 已完整、callback 零调用的事实由 marker 本身与本次
   * 显式 acknowledge 承载。写 not-executed final tombstone（绑定 marker
   * digest；无现代 identity 字段 = legacy 级 proof）→ 清 marker。幂等。
   */
  const resolveForensicAuthorizationFaultMarker = (
    input: { readonly transactionId?: string; readonly digest?: string; readonly acknowledgeRolledBack?: boolean } | undefined,
  ): TreasuryFaultResolutionResult => {
    const marker = readTreasuryWriteFault();
    if (
      marker === undefined ||
      marker.transactionId !== input?.transactionId ||
      marker.phase !== "internal_authorization_fault_forensic"
    ) {
      return { status: "rejected", reason: "not_found", detail: "不存在匹配的 forensic authorization fault marker" };
    }
    if (input.acknowledgeRolledBack !== true) {
      deps.metrics.reconciliationCapabilitiesRejected += 1;
      return {
        status: "rejected",
        reason: "invalid_input",
        detail: "forensic authorization fault 需要 acknowledgeRolledBack: true（显式确认 callback 未调用且 rollback 完整）",
      };
    }
    if (input.digest !== undefined && marker.digest !== input.digest) {
      deps.metrics.reconciliationCapabilitiesRejected += 1;
      return { status: "rejected", reason: "digest_mismatch", detail: `forensic marker digest 不匹配（marker ${marker.digest}，请求 ${input.digest}）` };
    }
    const existing = readTreasuryResolutionTombstone(marker.transactionId);
    if (existing !== undefined && existing.stage === "final" && existing.resolution === "not-executed" && existing.digest === marker.digest) {
      clearTreasuryWriteFaultMarkerForResolution(marker.transactionId, marker.digest);
      return { status: "already_resolved", resolution: "not-executed", transactionId: marker.transactionId };
    }
    const slotError = ensureTreasuryResolutionSlotAvailable();
    if (slotError !== null) {
      return { status: "rejected", reason: "resolution_store_full", detail: slotError };
    }
    const finalWrite = writeTreasuryResolutionTombstone({
      transactionId: marker.transactionId,
      digest: marker.digest,
      resolution: "not-executed",
      stage: "final",
      actionTick: marker.tick,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "pre-execution",
      source: "acknowledge-rolled-back-forensic",
      preExecution: true,
    });
    if (finalWrite.status === "rejected") {
      return { status: "rejected", reason: "resolution_store_fatal", detail: `final tombstone 写入失败（forensic marker 保留，可重试）: ${finalWrite.detail}` };
    }
    clearTreasuryWriteFaultMarkerForResolution(marker.transactionId, marker.digest);
    deps.metrics.resolutionRecovered += 1;
    return {
      status: "resolved",
      resolution: "not-executed",
      transactionId: marker.transactionId,
      receiptWritten: false,
      reprepareAllowed: true,
      actionTick: marker.tick,
    };
  };

  return {
    registerCapability: (capability) => {
      capabilityRegistry.add(capability);
    },
    validateReconciliationCapability: validate,
    consumeReconciliationCapability: consume,
    kernel: Object.freeze({
      validateReconciliationCapability: validate,
      consumeReconciliationCapability: consume,
    } satisfies TreasuryResolutionKernel),
    resolvePreExecutionAuthorizationFault,
    resolveForensicAuthorizationFaultMarker,
  };
}
