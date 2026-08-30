/**
 * Treasury 显式 fault resolution 协议（第六轮建立、第七轮证据协议、第八轮
 * 重做为 **staged atomic resolution + service-issued capability**）。
 *
 * 背景：write-fault marker / durable quarantine / durable intent 只证明
 * "Game 结果未知或 commit 未完成"，无法证明 Game 动作是否发生。解锁必须
 * 携带结论语义——而结论不得由普通调用者自填：
 *
 * - **结论来源（第八轮）**：TreasuryService.issueTreasuryReconciliationCapability
 *   基于当前 exact post-fault observation + **受注册 action reconciler**
 *   （actionContracts registry）判定 committed / not-executed / uncertain，
 *   签发 opaque capability（reconciliation.ts——对象身份防伪、单次使用、
 *   generation/tick 有界）；resolve 函数只接受 capability（旧 evidence/
 *   guard 自由对象入口已移除）。跨 global reset 由新 service 重新签发。
 * - **staged atomic（第八轮 8.2）**：
 *   resolve-as-committed：prevalidate → resolution slot 预检（满载在任何
 *   原状态变化之前拒绝）→ 写 stage="resolving" tombstone（resolution-
 *   intent 落盘）→ receipt **刷新**（既有 receipt 真正更新到 resolution
 *   tick，见 receipts.refreshSettledReceiptForResolution；无则写入）→
 *   释放 quarantine/intent → 清匹配 marker → finalize（stage="final"）。
 *   resolve-as-not-executed：prevalidate → slot 预检 → 先写 **final**
 *   tombstone（可写性保证）→ 再释放 quarantine/intent + 清 marker——
 *   绝无"函数返回失败但 transaction 已可重新 prepare"的中间态。
 *   任何阶段中断由 resolutionStore.recoverStagedResolutions 在 beginTick
 *   幂等恢复（receipt 已写→继续 finalize；无进展→回滚 tombstone；
 *   final 未释放→补完成）。
 * - **时序前置**（第七轮保留）：transaction 不得仍属当前 active handle
 *   registry；当前 tick > 故障 tick；系统已建立故障后 shared observation；
 *   capability 的 observationTick 严格晚于故障 tick 且不晚于当前 tick。
 * - **phase 允许性**：not-executed 仅 execution-unknown 类 phase
 *   （executing_at_end_tick / action_threw_execution_unknown /
 *   action_returned_non_ok_abort_failed）；commit 类 phase 一律拒绝（不
 *   允许伪造"未执行"）。
 * - still_uncertain：reconciler 结论不足——保持 quarantine/intent 与全部
 *   占用，不解锁，零副作用。
 * - 幂等：重复调用 already_resolved（tombstone final / receipt）；错误
 *   transactionId / digest / capability / 时序 → 拒绝且 fault 不动。
 *
 * 安全边界（架构测试守护）：生产 tick 不得自动调用（仅显式管理/修复路径
 * 与测试可引用）；显式 repair（quarantine/intent store 元数据）只在本模块。
 */

import { refreshSettledReceiptForResolution, hasSettledReceipt } from "@/runtime/treasury/receipts";
import {
  clearTreasuryWriteFaultMarkerForResolution,
  readTreasuryWriteFault,
} from "@/runtime/treasury/writeFault";
import {
  ensureTreasuryQuarantineStoreValidated,
  peekTreasuryQuarantineHealth,
  releaseTreasuryQuarantineEntry,
  repairTreasuryQuarantineStoreMetadataForResolution,
} from "@/runtime/treasury/quarantine";
import {
  ensureTreasuryIntentStoreValidated,
  releaseTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import {
  isTreasuryUnresolvedAuthorityNotExecutable,
  resolveTreasuryUnresolvedAuthority,
  type TreasuryUnresolvedAuthority,
} from "@/runtime/treasury/unresolvedAuthority";
import {
  committedResolutionSettledAtTick,
  deleteTreasuryResolutionTombstone,
  ensureTreasuryResolutionSlotAvailable,
  ensureTreasuryResolutionStoreValidated,
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import {
  consumeTreasuryReconciliationCapability,
  validateTreasuryReconciliationCapability,
  type TreasuryReconciliationCapability,
} from "@/runtime/treasury/reconciliation";
import { recordTreasuryResolutionEvent } from "@/runtime/treasury/resolutionEvents";

export type { TreasuryReconciliationConclusion } from "@/runtime/treasury/reconciliation";

/** resolution 输入（第八轮）：capability 取代旧 evidence/guard 自由对象。 */
export interface TreasuryFaultResolutionInput {
  readonly transactionId: string;
  /** 可选 digest 核对（提供时必须与 entry/capability 一致，否则拒绝）。 */
  readonly digest?: string;
  /** service 签发的 reconciliation capability（issueTreasuryReconciliationCapability）。 */
  readonly capability: TreasuryReconciliationCapability;
  /** 当前 service generation（capability 校验用；由调用方从 service 上下文提供）。 */
  readonly serviceGeneration: number;
}

export type TreasuryFaultResolutionResult =
  | {
      readonly status: "resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
      /** 本次调用是否实际写入/刷新 receipt（false = 幂等命中既有结算）。 */
      readonly receiptWritten: boolean;
      /** resolution 后是否允许重新 prepare 该 transactionId。 */
      readonly reprepareAllowed: boolean;
      /** 原 action tick（审计保留；receipt retention 从 settlement tick 起算）。 */
      readonly actionTick: number;
      /** receipt 结算 tick（resolve-as-committed 时存在 = resolution tick）。 */
      readonly settledAtTick?: number;
    }
  | {
      readonly status: "already_resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
    }
  | {
      /** reconciler 结论为 still_uncertain：保持隔离，不解锁，零副作用。 */
      readonly status: "uncertain";
      readonly transactionId: string;
      readonly detail: string;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "not_found"
        | "digest_mismatch"
        | "invalid_capability"
        | "active_handle_present"
        | "resolution_not_allowed"
        | "stale_observation"
        | "evidence_mismatch"
        | "reconciler_mismatch"
        | "receipt_store_fatal"
        | "quarantine_store_fatal"
        | "intent_store_fatal"
        | "authority_inconsistent"
        | "resolution_store_fatal"
        | "resolution_store_full"
        | "invalid_input";
      readonly detail: string;
    };

// ── resolution 计数器（resolutionEvents.ts 承载，facade 只读聚合） ─────────

export type { TreasuryResolutionCounters } from "@/runtime/treasury/resolutionEvents";
export { readTreasuryResolutionCounters } from "@/runtime/treasury/resolutionEvents";

function countRejected(): void {
  recordTreasuryResolutionEvent("rejected");
}

// ── 输入形状验证 ────────────────────────────────────────────────────────────

function describeInvalidInput(input: TreasuryFaultResolutionInput): string | null {
  if (!input || typeof input !== "object" || typeof input.transactionId !== "string" || input.transactionId.length === 0) {
    return "transactionId 缺失或非法";
  }
  if (input.digest !== undefined && (typeof input.digest !== "string" || input.digest.length === 0)) {
    return "digest 非法";
  }
  if (input.capability === undefined || input.capability === null || typeof input.capability !== "object") {
    return "capability 缺失（须经 service.issueTreasuryReconciliationCapability 签发）";
  }
  if (typeof input.serviceGeneration !== "number" || !Number.isSafeInteger(input.serviceGeneration)) {
    return "serviceGeneration 非安全整数";
  }
  return null;
}

/**
 * 共享前置验证链：形状 → capability 防伪/单次/generation/tick → quarantine
 * health（显式 load）→ 定位 entry（tombstone/receipt 幂等）→ digest →
 * active handle → tick 时序 → post-observation → conclusion 匹配 →
 * reconciler 绑定。返回 entry+capability 或拒绝/uncertain 结果。
 */
function prevalidate(
  input: TreasuryFaultResolutionInput,
): { authority: TreasuryUnresolvedAuthority; capability: TreasuryReconciliationCapability } | { stop: TreasuryFaultResolutionResult } {
  const inputError = describeInvalidInput(input);
  if (inputError !== null) {
    countRejected();
    return { stop: { status: "rejected", reason: "invalid_input", detail: inputError } };
  }
  // 幂等快路径（重复管理调用稳定 already_resolved）：entry 已释放且 final
  // tombstone / receipt / committed tombstone 窗口任一命中时直接幂等返回——
  // 不经 capability 校验/消费（resolved 状态不因重复调用改变）。
  const earlyAuthority = resolveTreasuryUnresolvedAuthority(input.transactionId);
  if (earlyAuthority.status === "not_found") {
    const earlyTombstone = readTreasuryResolutionTombstone(input.transactionId);
    if (earlyTombstone !== undefined && earlyTombstone.stage === "final") {
      return { stop: { status: "already_resolved", resolution: earlyTombstone.resolution, transactionId: input.transactionId } };
    }
    if (hasSettledReceipt(input.transactionId) !== undefined || committedResolutionSettledAtTick(input.transactionId) !== undefined) {
      return { stop: { status: "already_resolved", resolution: "committed", transactionId: input.transactionId } };
    }
  }
  // capability 防伪：对象身份/单次使用/generation/tick。
  const capabilityCheck = validateTreasuryReconciliationCapability(input.capability, input.serviceGeneration);
  if (capabilityCheck.status !== "valid") {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "invalid_capability",
        detail: `capability 校验失败（${capabilityCheck.reason}）: ${capabilityCheck.detail}`,
      },
    };
  }
  const capability = capabilityCheck.capability;
  // resolution 是写路径：显式触发 quarantine/intent store load 验证 + resolution
  // store 验证（不可信 store 上不得执行）。
  const quarantineFatal = ensureTreasuryQuarantineStoreValidated();
  const intentFatal = ensureTreasuryIntentStoreValidated();
  const resolutionFatal = ensureTreasuryResolutionStoreValidated();
  if (resolutionFatal !== null) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "resolution_store_fatal", detail: `${resolutionFatal}（不可信 store 上不得执行 resolution）` },
    };
  }
  if (intentFatal !== null) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "intent_store_fatal", detail: `${intentFatal}（不可信 intent store 上不得执行 resolution）` },
    };
  }
  const quarantineHealth = quarantineFatal !== null ? { healthy: false, detail: quarantineFatal } : peekTreasuryQuarantineHealth();
  if (!quarantineHealth.healthy) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "quarantine_store_fatal",
        detail: quarantineHealth.detail ?? "quarantine store 损坏（不可信 store 上不得执行 resolution）",
      },
    };
  }
  const authorityResolution = resolveTreasuryUnresolvedAuthority(input.transactionId);
  if (authorityResolution.status === "not_found") {
    // 幂等：先查 tombstone（receipt retention 过期后仍可判定），再查 receipt
    // 与 committed tombstone 窗口。
    const tombstone = readTreasuryResolutionTombstone(input.transactionId);
    if (tombstone !== undefined && tombstone.stage === "final") {
      return { stop: { status: "already_resolved", resolution: tombstone.resolution, transactionId: input.transactionId } };
    }
    if (hasSettledReceipt(input.transactionId) !== undefined || committedResolutionSettledAtTick(input.transactionId) !== undefined) {
      return { stop: { status: "already_resolved", resolution: "committed", transactionId: input.transactionId } };
    }
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "not_found",
        detail: `transactionId ${input.transactionId.slice(0, 48)} 不在 durable quarantine/intent（可能已解决或从未隔离）`,
      },
    };
  }
  if (authorityResolution.status === "inconsistent") {
    countRejected();
    return { stop: { status: "rejected", reason: "authority_inconsistent", detail: `${authorityResolution.detail}` } };
  }
  const authority = authorityResolution.authority;
  if (capability.transactionId !== input.transactionId) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "invalid_capability",
        detail: `capability 绑定 transactionId ${capability.transactionId}，请求 ${input.transactionId}`,
      },
    };
  }
  if (capability.digest !== authority.digest) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "digest_mismatch", detail: `capability digest ${capability.digest} 与 authority ${authority.digest} 不一致` },
    };
  }
  if (input.digest !== undefined && authority.digest !== input.digest) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "digest_mismatch", detail: `digest 不匹配（authority ${authority.digest}，请求 ${input.digest}）` },
    };
  }
  // reconciler 绑定：capability 的 reconcilerKind 必须与 entry 的 action kind
  // 一致（结论必须来自该 action 的注册 reconciler）。
  if (capability.reconcilerKind !== authority.actionKind) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "reconciler_mismatch",
        detail: `capability 的 reconciler kind ${capability.reconcilerKind} 与 authority action kind ${authority.actionKind} 不一致`,
      },
    };
  }
  // 时序：当前 tick 严格晚于故障 tick；capability 观察严格晚于故障 tick 且
  // 不晚于当前 tick（stale/未来观察均拒绝）。
  if (Game.time <= authority.recordedAt) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "resolution_not_allowed",
        detail: `当前 tick ${String(Game.time)} 未晚于故障 tick ${String(authority.recordedAt)}（同 tick 不得 resolution）`,
      },
    };
  }
  if (capability.postFaultEpoch.observedAtTick <= authority.recordedAt) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "resolution_not_allowed",
        detail: `capability 基于 tick ${String(capability.postFaultEpoch.observedAtTick)} 的观察——尚未建立故障后 shared observation（故障 tick ${String(authority.recordedAt)}）`,
      },
    };
  }
  if (capability.observationTick <= authority.recordedAt) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "stale_observation", detail: `capability 观察 tick ${String(capability.observationTick)} 不晚于故障 tick ${String(authority.recordedAt)}` },
    };
  }
  if (capability.observationTick > Game.time) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "invalid_input", detail: `capability 观察 tick ${String(capability.observationTick)} 晚于当前 tick ${String(Game.time)}` },
    };
  }
  if (capability.conclusion === "still_uncertain") {
    recordTreasuryResolutionEvent("uncertain");
    return {
      stop: {
        status: "uncertain",
        transactionId: input.transactionId,
        detail: "reconciler 结论为 still_uncertain——保持 quarantine/intent 与全部占用，不解锁",
      },
    };
  }
  // capability 单次使用：校验全链通过即消费（拒绝路径不消费——修正诊断后
  // 可重试；但 revision 型失效除外，见 validate 内部）。
  consumeTreasuryReconciliationCapability(capability);
  return { authority, capability };
}

/**
 * resolve-as-committed（staged）：slot 预检 → resolving tombstone → receipt
 * 刷新（resolution tick）→ 释放 quarantine/intent → 清 marker → finalize。
 * 原 action tick 保留在 tombstone（审计）；不向当前 tick overlay/journal
 * 重放历史动作。
 */
export function resolveTreasuryQuarantinedTransactionAsCommitted(
  input: TreasuryFaultResolutionInput,
): TreasuryFaultResolutionResult {
  const pre = prevalidate(input);
  if ("stop" in pre) return pre.stop;
  const { authority, capability } = pre;
  if (capability.conclusion !== "observed_committed") {
    countRejected();
    return {
      status: "rejected",
      reason: "evidence_mismatch",
      detail: `resolve-as-committed 需要 observed_committed 结论（got ${capability.conclusion}）`,
    };
  }
  // staged 第 1 步：slot 预检（任何原状态变化之前）。
  const slotError = ensureTreasuryResolutionSlotAvailable();
  if (slotError !== null) {
    countRejected();
    return { status: "rejected", reason: "resolution_store_full", detail: slotError };
  }
  // staged 第 2 步：resolving tombstone 落盘（resolution-intent）。
  const resolvingWrite = writeTreasuryResolutionTombstone({
    transactionId: authority.transactionId,
    digest: authority.digest,
    resolution: "committed",
    stage: "resolving",
    actionTick: authority.actionTick,
    settledAtTick: Game.time,
    observationTick: capability.observationTick,
    resolvedAtTick: Game.time,
    reconcilerKind: capability.reconcilerKind,
    source: "capability",
  });
  if (resolvingWrite.status === "rejected") {
    countRejected();
    return { status: "rejected", reason: "resolution_store_fatal", detail: `resolving tombstone 写入失败: ${resolvingWrite.detail}` };
  }
  // staged 第 3 步：receipt 刷新（既有 receipt 真正更新到 resolution tick）。
  const receipt = refreshSettledReceiptForResolution(authority.transactionId, Game.time);
  if (receipt.status === "fatal") {
    // receipt 不可写：回滚 tombstone（零原状态变化），quarantine/marker 不动。
    deleteTreasuryResolutionTombstone(authority.transactionId);
    countRejected();
    return { status: "rejected", reason: "receipt_store_fatal", detail: receipt.detail };
  }
  // staged 第 4-6 步：释放 quarantine/intent → 清匹配 marker → finalize。
  releaseTreasuryQuarantineEntry(authority.transactionId);
  releaseTreasuryIntentEntry(authority.transactionId);
  clearTreasuryWriteFaultMarkerForResolution(authority.transactionId, authority.digest);
  const finalizeWrite = writeTreasuryResolutionTombstone({
    transactionId: authority.transactionId,
    digest: authority.digest,
    resolution: "committed",
    stage: "final",
    actionTick: authority.actionTick,
    settledAtTick: Game.time,
    observationTick: capability.observationTick,
    resolvedAtTick: Game.time,
    reconcilerKind: capability.reconcilerKind,
    source: "capability",
  });
  if (finalizeWrite.status === "rejected") {
    // finalize 失败：保持 resolving（beginTick 恢复幂等完成——receipt 已写、
    // quarantine 已释放），显式返回 faulted 语义（resolution_store_fatal）。
    countRejected();
    return {
      status: "rejected",
      reason: "resolution_store_fatal",
      detail: `finalize 写入失败（恢复将在下一 beginTick 幂等完成）: ${finalizeWrite.detail}`,
    };
  }
  recordTreasuryResolutionEvent("committed");
  return {
    status: "resolved",
    resolution: "committed",
    transactionId: authority.transactionId,
    receiptWritten: true,
    reprepareAllowed: false, // receipt 已刷新：同 id 重放命中 already_settled（防重放）
    actionTick: authority.actionTick,
    settledAtTick: Game.time,
  };
}

/**
 * resolve-as-not-executed（staged）：先保证 final tombstone 可写（slot 预检
 * + 写 final）再释放 quarantine/intent——失败时 quarantine 保留（函数返回
 * rejected 但 transaction 仍被 transaction_quarantined 阻断，绝无"可重新
 * prepare"的中间态）。不写 receipt、不生成 committed projection。
 */
export function resolveTreasuryQuarantinedTransactionAsNotExecuted(
  input: TreasuryFaultResolutionInput,
): TreasuryFaultResolutionResult {
  const pre = prevalidate(input);
  if ("stop" in pre) return pre.stop;
  const { authority, capability } = pre;
  if (capability.conclusion !== "observed_not_executed") {
    countRejected();
    return {
      status: "rejected",
      reason: "evidence_mismatch",
      detail: `resolve-as-not-executed 需要 observed_not_executed 结论（got ${capability.conclusion}）`,
    };
  }
  if (!isTreasuryUnresolvedAuthorityNotExecutable(authority)) {
    countRejected();
    return {
      status: "rejected",
      reason: "resolution_not_allowed",
      detail: `phase ${authority.phase} 表示 Game callback 已确认成功或终态（authorityKind 与 phase 见 detail）——不允许 resolve-as-not-executed；只能 resolve-as-committed`,
    };
  }
  // staged 第 1 步：slot 预检（任何原状态变化之前）。
  const slotError = ensureTreasuryResolutionSlotAvailable();
  if (slotError !== null) {
    countRejected();
    return { status: "rejected", reason: "resolution_store_full", detail: slotError };
  }
  // staged 第 2 步：**先写 final tombstone**（可写性保证），再释放。
  const finalWrite = writeTreasuryResolutionTombstone({
    transactionId: authority.transactionId,
    digest: authority.digest,
    resolution: "not-executed",
    stage: "final",
    actionTick: authority.actionTick,
    observationTick: capability.observationTick,
    resolvedAtTick: Game.time,
    reconcilerKind: capability.reconcilerKind,
    source: "capability",
  });
  if (finalWrite.status === "rejected") {
    countRejected();
    return { status: "rejected", reason: "resolution_store_fatal", detail: `final tombstone 写入失败（quarantine 保留，可重试）: ${finalWrite.detail}` };
  }
  // staged 第 3 步：释放 quarantine/intent + 清 marker（中断由恢复补完成）。
  releaseTreasuryQuarantineEntry(authority.transactionId);
  releaseTreasuryIntentEntry(authority.transactionId);
  clearTreasuryWriteFaultMarkerForResolution(authority.transactionId, authority.digest);
  recordTreasuryResolutionEvent("notExecuted");
  return {
    status: "resolved",
    resolution: "not-executed",
    transactionId: authority.transactionId,
    receiptWritten: false, // 绝不写 receipt / committed projection
    reprepareAllowed: true, // Game 未执行：允许以同 id 重新 prepare
    actionTick: authority.actionTick,
  };
}

/**
 * 显式 repair（第七轮，quarantine 元数据 + 第八轮 intent 元数据）：全量
 * 验证现存 entries 合法后修复 store 元数据；任何 entry 损坏 → 拒绝（原
 * 数据不动，交人工处理）。绝不删除任何 entry。
 */
export function repairTreasuryQuarantineStoreForResolution(): { status: "repaired" | "rejected"; detail: string } {
  return repairTreasuryQuarantineStoreMetadataForResolution();
}

/** 诊断：当前 unresolved write-fault marker（只读）。 */
export function currentTreasuryWriteFaultMarker(): ReturnType<typeof readTreasuryWriteFault> {
  return readTreasuryWriteFault();
}
