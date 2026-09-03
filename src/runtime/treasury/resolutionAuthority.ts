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
import { treasuryExactAttemptIdentityOfIdentityInput } from "@/runtime/treasury/exactAttemptIdentity";
import {
  clearTreasuryForensicMarkerForAcknowledgedRollback,
  readTreasuryWriteFault,
} from "@/runtime/treasury/writeFault";
import {
  openTreasuryResolutionCleanup,
  treasuryResolutionCleanupOpenInputOfFacts,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  advanceTreasuryResolutionCleanupPhases,
  treasuryCleanupStatusOfAdvance,
} from "@/runtime/treasury/resolutionCleanupCoordinator";
import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";
import {
  ensureTreasuryResolutionSlotAvailable,
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import {
  createTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  retireTreasuryLineageCurrentAttempt,
  convergeTreasuryLineageRetirementFromFacts,
  type TreasuryAttemptLineageIdentity,
} from "@/runtime/treasury/attemptLineage";
import {
  computeTreasuryModernRetrySemanticDigest,
  computeTreasuryLowlevelRetrySemanticDigest,
  modernRetrySemanticFactsOfEntry,
  lowlevelRetrySemanticFactsOfEntry,
} from "@/runtime/treasury/retrySemanticIdentity";
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
 * 【第十七轮第六节】immediate（pre-execution）not-executed 的 lineage
 * publication：retirement 权威建立。identity-bound/lowlevel 且 retry facts
 * 可计算 → rearmable retiring；legacy/forensic 或 facts 不足 →
 * non-rearmable retired（永久阻断 parent ID，不签发 capability）。lineage
 * 写失败 → pending（beginTick backfill 重试；不猜测）。
 */
function publishImmediateNotExecutedLineage(
  fault: Readonly<TreasuryAuthorizationFaultEntry>,
  faultProofLevel: "identity-bound" | "lowlevel" | "legacy" | "forensic",
): "published" | "pending" {
  const modernClass = faultProofLevel === "identity-bound";
  const lowlevelClass = faultProofLevel === "lowlevel";
  const retrySemanticDigest = (() => {
    if (modernClass) {
      const facts = modernRetrySemanticFactsOfEntry({
        actionKind: fault.actionKind,
        kind: fault.actionKind,
        adapterVersion: fault.adapterVersion,
        // authorization-fault entry 不持久化 adapter retry facts——immediate
        // not-executed 只能 non-rearmable（digest 不可重建，不猜测）。
        adapterSemanticIdentity: fault.adapterSemanticIdentity,
        postings: fault.postings,
        structureFacts: fault.structureFacts,
        source: fault.source,
        ownerIdentity: fault.ownerIdentity,
      });
      return facts === null ? null : computeTreasuryModernRetrySemanticDigest(facts);
    }
    if (lowlevelClass) {
      const facts = lowlevelRetrySemanticFactsOfEntry({
        kind: fault.actionKind ?? "",
        source: fault.source,
        postings: fault.postings,
        lowlevelSource: fault.lowlevelSource ?? "",
      });
      return facts === null ? null : computeTreasuryLowlevelRetrySemanticDigest(facts);
    }
    return null;
  })();
  const identity: TreasuryAttemptLineageIdentity = {
    digest: fault.digest,
    ...(fault.contractDigest !== undefined ? { contractDigest: fault.contractDigest } : {}),
    ...(fault.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: fault.authorizationCohortDigest } : {}),
    ...(fault.durableIdentityDigest !== undefined ? { durableIdentityDigest: fault.durableIdentityDigest } : {}),
    ...(lowlevelClass && fault.lowlevelSource !== undefined ? { lowlevelSource: fault.lowlevelSource } : {}),
  };
  const rearmable = retrySemanticDigest !== null;
  const existing = lookupTreasuryAttemptLineageByAttemptId(fault.transactionId);
  if (existing !== undefined) {
    // 既有 chain 的 current 退休（单一权威 helper；非 child_active 状态由
    // 状态机拒绝 → pending，fail closed）。
    const updated = retireTreasuryLineageCurrentAttempt({
      lineageId: existing.lineageId,
      ...(retrySemanticDigest !== null ? { retrySemanticDigest } : {}),
    });
    return updated.status === "rejected" ? "pending" : "published";
  }
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: fault.transactionId,
    rootIdentity: identity,
    actionKind: fault.actionKind ?? fault.digest.slice(0, 8),
    ...(fault.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: fault.adapterSemanticIdentity } : {}),
    ...(fault.ownerIdentity !== undefined ? { ownerIdentity: fault.ownerIdentity } : {}),
    authorityClass: lowlevelClass ? "lowlevel" : "identity-bound",
    ...(lowlevelClass && fault.lowlevelSource !== undefined ? { lowlevelSource: fault.lowlevelSource } : {}),
    rearmable,
    ...(retrySemanticDigest !== null ? { retrySemanticDigest } : {}),
    ...(rearmable ? {} : { nonRearmReason: retrySemanticDigest === null ? "retry semantic facts 不足（immediate authority 无完整 action 语义）" : "non-rearmable" }),
  });
  return created.status === "rejected" ? "pending" : "published";
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
      // 【第二十轮 8】exact attempt identity 单一构造（durable/lowlevel 维度
      // 经 helper——authorization-fault entry 不携带 lineage proof，class 按
      // fault facts 推导）。
      const attemptExact = treasuryExactAttemptIdentityOfIdentityInput(fault.transactionId, {
        digest: fault.digest,
        ...(fault.contractDigest !== undefined ? { contractDigest: fault.contractDigest } : {}),
        ...(fault.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: fault.authorizationCohortDigest } : {}),
        ...(fault.durableIdentityDigest !== undefined ? { durableIdentityDigest: fault.durableIdentityDigest } : {}),
      });
      if (attemptExact === null) {
        return {
          status: "rejected",
          reason: "digest_mismatch",
          detail: "fault authority 的 attempt identity 无法构造完整 exact 视图（digest 缺失——防御 fail closed）",
        };
      }
      if (treasuryAttemptIdentityRelation(existing, attemptExact) !== "match") {
        deps.metrics.reconciliationCapabilitiesRejected += 1;
        return {
          status: "rejected",
          reason: "digest_mismatch",
          detail: `既有 not-executed tombstone 与该 fault authority 的 attempt identity 不一致（${fault.transactionId.slice(0, 48)}）——不得以旧 proof 解决新 attempt（fail closed）`,
        };
      }
      // 【Round 22 remediation B.5】幂等重入路径同样经统一 discharge +
      // cleanup journal（旧 boolean clear 无生产 caller）：final tombstone
      // 已存在（settlement proof 持久化）——open 幂等补开，discharge 未完成
      // 时 fault authority 保留（fail closed，恢复稍后重试）。
      const reopenIdentity = {
        transactionId: fault.transactionId,
        digest: fault.digest,
        proofClass: existing.proofLevel,
        ...(fault.contractDigest !== undefined ? { contractDigest: fault.contractDigest } : {}),
        ...(fault.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: fault.authorizationCohortDigest } : {}),
        ...(fault.durableIdentityDigest !== undefined ? { durableIdentityDigest: fault.durableIdentityDigest } : {}),
        ...(existing.lowlevelSource !== undefined ? { lowlevelSource: existing.lowlevelSource } : {}),
      };
      const reopenCleanup = openTreasuryResolutionCleanup(
        treasuryResolutionCleanupOpenInputOfFacts({ ...reopenIdentity, resolution: "not-executed" }),
      );
      if (reopenCleanup.status === "rejected" || reopenCleanup.status === "conflict") {
        deps.metrics.reconciliationCapabilitiesRejected += 1;
        return {
          status: "rejected",
          reason: "resolution_store_fatal",
          detail: `cleanup journal ${reopenCleanup.status}: ${reopenCleanup.detail}（fault authority 保留，重试）`,
        };
      }
      // 【Remediation III 六/八】幂等重入路径的 cleanup 阶段推进统一经
      // coordinator（authorization fault entry 的释放经 facade 装配的
      // authority handler——不绕过、不手工 mark）。settlement 结论已定
      //（final tombstone 存在），cleanup pending 由 beginTick 恢复幂等补
      // 完成——只有 store 异常才拒绝重入。
      const reopenAdvance = advanceTreasuryResolutionCleanupPhases({ transactionId: fault.transactionId });
      if (reopenAdvance.status === "absent" || reopenAdvance.status === "store_unhealthy") {
        deps.metrics.reconciliationCapabilitiesRejected += 1;
        return {
          status: "rejected",
          reason: "resolution_store_fatal",
          detail: `cleanup advance ${reopenAdvance.status}: ${reopenAdvance.detail}（fault authority 保留，重试）`,
        };
      }
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
    // 【第十四轮第十一节】pre-execution fault authority 等级 → 显式 proof
    // class（modern → identity-bound；lowlevel → lowlevel；legacy → legacy；
    // forensic → forensic——禁止由 optional 字段隐式猜测）。
    const faultProofLevel =
      fault.authorityLevel === "modern"
        ? ("identity-bound" as const)
        : fault.authorityLevel === "lowlevel"
          ? ("lowlevel" as const)
          : fault.authorityLevel === "legacy"
            ? ("legacy" as const)
            : ("forensic" as const);
    const finalWrite = writeTreasuryResolutionTombstone({
      transactionId: fault.transactionId,
      digest: fault.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: faultProofLevel,
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
    // 【第十七轮第六节/第十四节】immediate not-executed 同样建立 lineage
    // replacement（retirement 权威）。【Remediation III 六/八】cleanup 阶段
    // 推进统一经 coordinator——marker discharge / authorization fault 释放 /
    // outcome / lineage / journal completion 全部经结构化 ack（写入 +
    // Memory read-back），不再直接组合 mark 并忽略 boolean。
    const lineagePublished = publishImmediateNotExecutedLineage(fault, faultProofLevel);
    const faultCleanupIdentity = {
      transactionId: fault.transactionId,
      digest: fault.digest,
      proofClass: faultProofLevel,
      ...(fault.contractDigest !== undefined ? { contractDigest: fault.contractDigest } : {}),
      ...(fault.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: fault.authorizationCohortDigest } : {}),
      ...(fault.durableIdentityDigest !== undefined ? { durableIdentityDigest: fault.durableIdentityDigest } : {}),
      ...(faultProofLevel === "lowlevel" && fault.lowlevelSource !== undefined ? { lowlevelSource: fault.lowlevelSource } : {}),
    };
    const faultCleanupOpen = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({ ...faultCleanupIdentity, resolution: "not-executed" }),
    );
    if (faultCleanupOpen.status === "rejected" || faultCleanupOpen.status === "conflict") {
      deps.metrics.reconciliationCapabilitiesRejected += 1;
      return {
        status: "rejected",
        reason: "resolution_store_fatal",
        detail: `cleanup journal ${faultCleanupOpen.status}: ${faultCleanupOpen.detail}（fault authority 保留，重试）`,
      };
    }
    const faultAdvance = advanceTreasuryResolutionCleanupPhases({ transactionId: fault.transactionId });
    if (faultAdvance.status === "absent" || faultAdvance.status === "store_unhealthy") {
      deps.metrics.reconciliationCapabilitiesRejected += 1;
      return {
        status: "resolved",
        resolution: "not-executed",
        transactionId: fault.transactionId,
        receiptWritten: false,
        sameIdRetryAllowed: false,
        actionTick: fault.faultTick,
        retirement: "pending_cleanup",
        cleanup: { settlement: "not-executed" as const, stage: "journal_completion_pending" as const, globalWriteAdmissionStillLocked: true },
        globalWriteAdmissionStillLocked: true,
      };
    }
    deps.metrics.resolutionRecovered += 1;
    if (faultAdvance.status !== "completed") {
      // cleanup 阶段未全部持久确认：按 pendingStage 映射明确 pending 语义
      //（marker → pending_cleanup；authority → authority_release_pending；
      // outcome/GRA → exact_proof_pending；lineage → lineage_finalization_
      // pending；journal completion → pending_cleanup）——绝不伪装 complete。
      const faultRetirementPending =
        faultAdvance.pendingStage === "marker_discharge"
          ? "pending_cleanup"
          : faultAdvance.pendingStage === "authority_release"
            ? "authority_release_pending"
            : faultAdvance.pendingStage === "outcome_finalization"
              ? "exact_proof_pending"
              : faultAdvance.pendingStage === "lineage_finalization"
                ? "lineage_finalization_pending"
                : "pending_cleanup";
      return {
        status: "resolved",
        resolution: "not-executed",
        transactionId: fault.transactionId,
        receiptWritten: false,
        sameIdRetryAllowed: false,
        actionTick: fault.faultTick,
        retirement: faultRetirementPending,
        cleanup: treasuryCleanupStatusOfAdvance("not-executed", faultAdvance),
        ...(faultAdvance.globalWriteAdmissionLockedKnown
          ? { globalWriteAdmissionStillLocked: faultAdvance.globalWriteAdmissionStillLocked }
          : {}),
      };
    }
    const retrySemanticReady = faultProofLevel === "identity-bound" || faultProofLevel === "lowlevel";
    return {
      status: "resolved",
      resolution: "not-executed",
      transactionId: fault.transactionId,
      receiptWritten: false,
      sameIdRetryAllowed: false, // 【第十六轮第五节】同 ID 永不可直接重新执行（显式 rearm）
      actionTick: fault.faultTick,
      // 【第十七轮第六节】retirement 状态（child ID 只经 opaque capability
      // 交付——不再返回 rearmChildTransactionId 字符串）。【11.1】只有全部
      // 阶段 acknowledged 且 journal 删除 read-back 后才返回 complete_*。
      retirement:
        lineagePublished === "pending"
          ? "pending_publication"
          : retrySemanticReady
            ? "complete_rearm_ready"
            : "complete_non_rearmable",
      cleanup: treasuryCleanupStatusOfAdvance("not-executed", faultAdvance),
      globalWriteAdmissionStillLocked: faultAdvance.globalWriteAdmissionStillLocked,
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
    // 【第十三轮第十一节】marker 携带的完整 attempt identity（redemption
    // 故障前已计算）；缺失（旧 marker）= legacy forensic proof。
    const markerAttempt: TreasuryAttemptIdentity = {
      digest: marker.digest,
      ...(marker.attemptIdentity?.contractDigest !== undefined ? { contractDigest: marker.attemptIdentity.contractDigest } : {}),
      ...(marker.attemptIdentity?.authorizationCohortDigest !== undefined
        ? { authorizationCohortDigest: marker.attemptIdentity.authorizationCohortDigest }
        : {}),
      ...(marker.attemptIdentity?.durableIdentityDigest !== undefined
        ? { durableIdentityDigest: marker.attemptIdentity.durableIdentityDigest }
        : {}),
    };
    const existing = readTreasuryResolutionTombstone(marker.transactionId);
    if (existing !== undefined && existing.stage === "final" && existing.resolution === "not-executed") {
      // already_resolved 必须比较完整 attempt identity——同 id、同普通 digest
      // 但不同 owner/policy/cohort 的 attempt 不得共享 forensic tombstone。
      // marker 缺 identity 字段 = legacy forensic proof：只与同为 legacy（无
      // 现代身份）的 tombstone 幂等；tombstone 携带现代身份时证明不足，
      // 不得 already_resolved（fail closed，显式处理）。
      const markerModern =
        marker.attemptIdentity?.durableIdentityDigest !== undefined ||
        marker.attemptIdentity?.authorizationCohortDigest !== undefined;
      const tombstoneModern =
        existing.durableIdentityDigest !== undefined || existing.authorizationCohortDigest !== undefined;
      if (!markerModern && tombstoneModern) {
        deps.metrics.reconciliationCapabilitiesRejected += 1;
        return {
          status: "rejected",
          reason: "digest_mismatch",
          detail: `既有 not-executed tombstone 携带现代 attempt identity，而 forensic marker 为 legacy proof（无 identity 字段）——证明不足，不得 already_resolved 或覆盖（${marker.transactionId.slice(0, 48)}，显式处理）`,
        };
      }
      if (treasuryAttemptIdentityRelation(existing, markerAttempt) === "match") {
        clearTreasuryForensicMarkerForAcknowledgedRollback({
          transactionId: marker.transactionId,
          digest: marker.digest,
          ...(marker.authorityClass !== undefined ? { authorityClass: marker.authorityClass } : {}),
          ...(marker.attemptIdentity?.contractDigest !== undefined ? { contractDigest: marker.attemptIdentity.contractDigest } : {}),
          ...(marker.attemptIdentity?.authorizationCohortDigest !== undefined
            ? { authorizationCohortDigest: marker.attemptIdentity.authorizationCohortDigest }
            : {}),
          ...(marker.attemptIdentity?.durableIdentityDigest !== undefined
            ? { durableIdentityDigest: marker.attemptIdentity.durableIdentityDigest }
            : {}),
          ...(marker.lowlevelSource !== undefined ? { lowlevelSource: marker.lowlevelSource } : {}),
          ...(marker.lineageBindingDigest !== undefined ? { lineageBindingDigest: marker.lineageBindingDigest } : {}),
          ...(marker.attemptGeneration !== undefined ? { attemptGeneration: marker.attemptGeneration } : {}),
        });
        return { status: "already_resolved", resolution: "not-executed", transactionId: marker.transactionId };
      }
      deps.metrics.reconciliationCapabilitiesRejected += 1;
      return {
        status: "rejected",
        reason: "digest_mismatch",
        detail: `既有 not-executed tombstone 与 forensic marker 的 attempt identity 不一致（${marker.transactionId.slice(0, 48)}）——不得以旧 proof 解决新 attempt 或共享 tombstone（fail closed，显式处理）`,
      };
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
      /** 【第十四轮第十一节】forensic 管理协议的显式 proof class（允许部分身份字段）。 */
      proofLevel: "forensic",
      actionTick: marker.tick,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "pre-execution",
      source: "acknowledge-rolled-back-forensic",
      preExecution: true,
      // tombstone 与 marker 绑定同一 attempt identity。
      ...(marker.attemptIdentity?.contractDigest !== undefined ? { contractDigest: marker.attemptIdentity.contractDigest } : {}),
      ...(marker.attemptIdentity?.authorizationCohortDigest !== undefined
        ? { authorizationCohortDigest: marker.attemptIdentity.authorizationCohortDigest }
        : {}),
      ...(marker.attemptIdentity?.durableIdentityDigest !== undefined
        ? { durableIdentityDigest: marker.attemptIdentity.durableIdentityDigest }
        : {}),
    });
    if (finalWrite.status === "rejected") {
      return { status: "rejected", reason: "resolution_store_fatal", detail: `final tombstone 写入失败（forensic marker 保留，可重试）: ${finalWrite.detail}` };
    }
    clearTreasuryForensicMarkerForAcknowledgedRollback({
      transactionId: marker.transactionId,
      digest: marker.digest,
      ...(marker.authorityClass !== undefined ? { authorityClass: marker.authorityClass } : {}),
      ...(marker.attemptIdentity?.contractDigest !== undefined ? { contractDigest: marker.attemptIdentity.contractDigest } : {}),
      ...(marker.attemptIdentity?.authorizationCohortDigest !== undefined
        ? { authorizationCohortDigest: marker.attemptIdentity.authorizationCohortDigest }
        : {}),
      ...(marker.attemptIdentity?.durableIdentityDigest !== undefined
        ? { durableIdentityDigest: marker.attemptIdentity.durableIdentityDigest }
        : {}),
      ...(marker.lowlevelSource !== undefined ? { lowlevelSource: marker.lowlevelSource } : {}),
      ...(marker.lineageBindingDigest !== undefined ? { lineageBindingDigest: marker.lineageBindingDigest } : {}),
      ...(marker.attemptGeneration !== undefined ? { attemptGeneration: marker.attemptGeneration } : {}),
    });
    deps.metrics.resolutionRecovered += 1;
    return {
      status: "resolved",
      resolution: "not-executed",
      transactionId: marker.transactionId,
      receiptWritten: false,
      sameIdRetryAllowed: false, // 【第十六轮第五节】同 ID 永不可直接重新执行（显式 rearm）
      actionTick: marker.tick,
      // forensic proof 等级不可 rearm（无完整可验证 attempt identity）——不返回 child ID。
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
