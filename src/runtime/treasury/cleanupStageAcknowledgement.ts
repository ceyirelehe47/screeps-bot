/**
 * 【Round 22 Remediation III 六】cleanup stage durable acknowledgement——
 * journal 阶段推进的唯一权威实现。
 *
 * Round 22 Remediation II 之前调用方直接组合
 * activate→mark→mark→complete 并选择性忽略 boolean：mark 返回 true 混合
 * "本次推进 / 幂等已达成"两种含义；complete 对 absent 返回 true；三个写
 * API 均无 read-back——"写入成功"只是函数没有抛异常，不是持久确认。
 *
 * 本模块把每个阶段收敛为单一结构化 ack 接口，固定协议（六.1）：
 *  1. journal store 健康探测（unhealthy → store_unhealthy，fatal 不得折叠
 *     为 absent）；
 *  2. 按 transaction ID 读取 entry（absent → absent）；
 *  3. 调用方提供 expected 时比较完整不可变 identity（任一不等 → conflict）；
 *  4. 验证前置阶段偏序与 settlementProofDurable（不成立 → blocked）；
 *  5. 重验对应外部 proof（marker：discharge + read-back；authority：
 *     release + resolver read-back；outcome/lineage：装配的 stage handlers）
 *     ——阶段 boolean 只是进度提示，不是安全证明；
 *  6. 写入阶段并检查底层写入结果（false → write_rejected）；
 *  7. Memory read-back（单键直读）：identity 未变、前置阶段仍成立、目标
 *     阶段确实已持久、后续阶段未被越级修改——任一不成立 → read_back_failed。
 *
 * 任一步失败：后续 destructive action 不得执行、entry 保留、外部 proof
 * 保留、返回结构化原因。ack 成功是执行下一阶段 destructive action 的唯一
 * 许可。
 *
 * 本模块是生产代码中 journal 写原语（markStage / activate / complete）的
 * 唯一合法调用方（架构测试守护）；Test-only fault injector 不暴露给生产
 * 业务（setTreasuryCleanupAckFaultForTest 仅测试 import）。
 */

import {
  peekTreasuryResolutionCleanupHealth,
  peekTreasuryResolutionCleanupStageHandlers,
  readBackTreasuryResolutionCleanupEntryFromMemory,
  readTreasuryResolutionCleanupEntry,
  markTreasuryResolutionCleanupStage,
  completeTreasuryResolutionCleanup,
  type TreasuryResolutionCleanupEntry,
  type TreasuryResolutionCleanupStage,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  dischargeTreasuryMarkerForAttempt,
  treasuryMarkerDischargeCompletesAttemptPhase,
  type TreasuryMarkerDischargeExpected,
} from "@/runtime/treasury/markerDischarge";
import type { TreasuryIdentityProfile } from "@/runtime/treasury/identityProfile";

/** ack 结果（不得只返回含义模糊的 boolean）。 */
export type TreasuryCleanupStageAckOutcome =
  | "acknowledged"
  | "already_acknowledged"
  | "absent"
  | "blocked"
  | "conflict"
  | "store_unhealthy"
  | "write_rejected"
  | "read_back_failed";

export interface TreasuryCleanupStageAckResult {
  readonly outcome: TreasuryCleanupStageAckOutcome;
  readonly detail: string;
  /** marker 阶段透传 discharge 的全局锁事实（其余阶段无此维度）。 */
  readonly globalWriteAdmissionStillLocked?: boolean;
}

/** 调用方已知的 attempt identity（与 journal entry 的不可变字段比较）。 */
export interface TreasuryCleanupAckIdentity {
  readonly digest?: string;
  readonly identityProfile?: TreasuryIdentityProfile;
  readonly proofClass?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

const ACK_IDENTITY_FIELDS = [
  "digest",
  "identityProfile",
  "proofClass",
  "contractDigest",
  "authorizationCohortDigest",
  "durableIdentityDigest",
  "lowlevelSource",
  "lineageId",
  "lineageGeneration",
  "parentTransactionId",
  "lineageBindingDigest",
] as const;

function identityMismatchDetail(entry: Readonly<TreasuryResolutionCleanupEntry>, expected: TreasuryCleanupAckIdentity): string | null {
  for (const field of ACK_IDENTITY_FIELDS) {
    const expectedValue = expected[field];
    if (expectedValue === undefined) continue;
    if (entry[field] !== expectedValue) {
      return `identity 字段 ${field} 不一致（journal ${String(entry[field]).slice(0, 24)} vs expected ${String(expectedValue).slice(0, 24)}）`;
    }
  }
  return null;
}

function stageBoolOf(entry: Readonly<TreasuryResolutionCleanupEntry>, stage: TreasuryResolutionCleanupStage): boolean {
  switch (stage) {
    case "marker_discharge":
      return entry.markerDischarged;
    case "authority_release":
      return entry.authorityReleased;
    case "outcome_finalization":
      return entry.outcomeFinalized;
    case "lineage_finalization":
      return entry.lineageFinalized;
  }
}

/** 前置阶段（偏序链上位于 stage 之前的全部阶段）是否持久成立。 */
function prerequisitesHold(entry: Readonly<TreasuryResolutionCleanupEntry>, stage: TreasuryResolutionCleanupStage): boolean {
  if (stage === "marker_discharge") return true;
  if (stage === "authority_release") return entry.markerDischarged;
  if (stage === "outcome_finalization") return entry.markerDischarged && entry.authorityReleased;
  return entry.markerDischarged && entry.authorityReleased && entry.outcomeFinalized;
}

// ── Test-only fault injector（不暴露给生产业务） ─────────────────────────────

export interface TreasuryCleanupAckFaultTarget {
  readonly transactionId: string;
  readonly stage: TreasuryResolutionCleanupStage | "settlement_proof" | "journal_completion";
  readonly phase: "before_write" | "after_write" | "after_delete";
}

export type TreasuryCleanupAckFaultEffect =
  | "write_rejected"
  | "revert_stage"
  | "tamper_identity"
  | "tamper_skip_prereq"
  | "tamper_advance_beyond"
  | "drop_entry"
  | "restore_entry";

export type TreasuryCleanupAckFaultInjector = (
  target: TreasuryCleanupAckFaultTarget,
) => TreasuryCleanupAckFaultEffect | null;

let ackFaultInjector: TreasuryCleanupAckFaultInjector | null = null;

/** test-only：注入阶段写入 / read-back / 删除的中断窗口。传 null 清除。 */
export function setTreasuryCleanupAckFaultForTest(injector: TreasuryCleanupAckFaultInjector | null): void {
  ackFaultInjector = injector;
}

function memoryEntryOf(transactionId: string): TreasuryResolutionCleanupEntry | undefined {
  const store = (Memory.runtime as { treasury?: { resolutionCleanup?: { entries?: Record<string, TreasuryResolutionCleanupEntry> } } } | undefined)
    ?.treasury?.resolutionCleanup;
  return store?.entries[`c:${transactionId}`];
}

function applyAfterWriteFault(
  transactionId: string,
  stage: TreasuryResolutionCleanupStage,
  effect: TreasuryCleanupAckFaultEffect,
): void {
  const entry = memoryEntryOf(transactionId);
  if (entry === undefined) return;
  if (effect === "revert_stage") {
    switch (stage) {
      case "marker_discharge":
        entry.markerDischarged = false;
        break;
      case "authority_release":
        entry.authorityReleased = false;
        break;
      case "outcome_finalization":
        entry.outcomeFinalized = false;
        break;
      case "lineage_finalization":
        entry.lineageFinalized = false;
        break;
    }
    return;
  }
  if (effect === "tamper_identity") {
    // fault 注入绕过只读视图（直改 Memory 持久对象——模拟写入被篡改）。
    (entry as { digest: string }).digest = `tampered:${entry.digest}`;
    return;
  }
  if (effect === "tamper_skip_prereq") {
    if (stage === "authority_release") entry.markerDischarged = false;
    if (stage === "outcome_finalization") entry.authorityReleased = false;
    if (stage === "lineage_finalization") entry.outcomeFinalized = false;
    return;
  }
  if (effect === "tamper_advance_beyond") {
    if (stage === "marker_discharge") entry.authorityReleased = true;
    if (stage === "authority_release") entry.outcomeFinalized = true;
    if (stage === "outcome_finalization") entry.lineageFinalized = true;
    return;
  }
  if (effect === "drop_entry") {
    const store = (Memory.runtime as { treasury?: { resolutionCleanup?: { entries?: Record<string, unknown>; entryCount?: number } } } | undefined)
      ?.treasury?.resolutionCleanup;
    if (store?.entries) {
      delete store.entries[`c:${transactionId}`];
      if (typeof store.entryCount === "number") store.entryCount -= 1;
    }
  }
}

// ── 单阶段通用 ack 协议 ─────────────────────────────────────────────────────

interface ExternalProofVerdict {
  readonly ok: boolean;
  readonly detail: string;
  readonly globalWriteAdmissionStillLocked?: boolean;
  readonly stageDetail?: string;
}

function acknowledgeCleanupStage(input: {
  readonly transactionId: string;
  readonly stage: TreasuryResolutionCleanupStage;
  readonly expected?: TreasuryCleanupAckIdentity;
  readonly external: (entry: Readonly<TreasuryResolutionCleanupEntry>) => ExternalProofVerdict;
}): TreasuryCleanupStageAckResult {
  const health = peekTreasuryResolutionCleanupHealth();
  if (!health.healthy) {
    return { outcome: "store_unhealthy", detail: `cleanup journal unhealthy: ${health.detail ?? "unknown"}` };
  }
  const entry = readTreasuryResolutionCleanupEntry(input.transactionId);
  if (entry === undefined) {
    return { outcome: "absent", detail: `cleanup entry ${input.transactionId.slice(0, 12)} 不存在（store 健康——非 fatal 折叠）` };
  }
  if (input.expected !== undefined) {
    const mismatch = identityMismatchDetail(entry, input.expected);
    if (mismatch !== null) {
      return { outcome: "conflict", detail: `ack ${input.stage} 拒绝：${mismatch}（零状态变化）` };
    }
  }
  if (!entry.settlementProofDurable) {
    return { outcome: "blocked", detail: `ack ${input.stage} 拒绝：settlement proof 未 durable（reservation 未激活）` };
  }
  if (!prerequisitesHold(entry, input.stage)) {
    return { outcome: "blocked", detail: `ack ${input.stage} 拒绝：前置阶段未持久确认（偏序强制）` };
  }
  const alreadyDone = stageBoolOf(entry, input.stage);
  // 外部 proof 每次重验（阶段 boolean 不是安全证明——幂等重跑）。
  const external = input.external(entry);
  if (!external.ok) {
    return {
      outcome: "blocked",
      detail: `ack ${input.stage} 拒绝：外部 proof 未成立（${external.detail}）——entry 与外部 proof 均保留`,
      ...(external.globalWriteAdmissionStillLocked !== undefined
        ? { globalWriteAdmissionStillLocked: external.globalWriteAdmissionStillLocked }
        : {}),
    };
  }
  if (alreadyDone) {
    return {
      outcome: "already_acknowledged",
      detail: `${input.stage} 已持久确认且外部 proof 复验成立（${external.detail}）`,
      ...(external.globalWriteAdmissionStillLocked !== undefined
        ? { globalWriteAdmissionStillLocked: external.globalWriteAdmissionStillLocked }
        : {}),
    };
  }
  const beforeFault = ackFaultInjector?.({ transactionId: input.transactionId, stage: input.stage, phase: "before_write" }) ?? null;
  if (beforeFault === "write_rejected") {
    return { outcome: "write_rejected", detail: `ack ${input.stage} 写入被拒（fault 注入——零状态变化）` };
  }
  if (!markTreasuryResolutionCleanupStage(input.transactionId, input.stage, external.stageDetail)) {
    return { outcome: "write_rejected", detail: `ack ${input.stage} 底层阶段写入返回 false（journal 保留，外部 proof 保留）` };
  }
  const afterFault = ackFaultInjector?.({ transactionId: input.transactionId, stage: input.stage, phase: "after_write" }) ?? null;
  if (afterFault !== null && afterFault !== "write_rejected" && afterFault !== "restore_entry") {
    applyAfterWriteFault(input.transactionId, input.stage, afterFault);
  }
  // Memory read-back（六.1）：identity 未变、前置仍成立、目标已持久、未越级。
  const readBack = readBackTreasuryResolutionCleanupEntryFromMemory(input.transactionId);
  if (readBack.status === "store_unhealthy") {
    return { outcome: "read_back_failed", detail: `ack ${input.stage} read-back store unhealthy: ${readBack.detail}` };
  }
  if (readBack.status === "absent" || readBack.entry === undefined) {
    return { outcome: "read_back_failed", detail: `ack ${input.stage} read-back 时 entry 消失（写入未持久确认）` };
  }
  const readBackEntry = readBack.entry;
  for (const field of ACK_IDENTITY_FIELDS) {
    if (readBackEntry[field] !== entry[field]) {
      return { outcome: "read_back_failed", detail: `ack ${input.stage} read-back identity 字段 ${field} 发生变化（写入未持久确认）` };
    }
  }
  if (!prerequisitesHold(readBackEntry, input.stage)) {
    return { outcome: "read_back_failed", detail: `ack ${input.stage} read-back 前置阶段不成立（写入未持久确认）` };
  }
  if (!stageBoolOf(readBackEntry, input.stage)) {
    return { outcome: "read_back_failed", detail: `ack ${input.stage} read-back 目标阶段布尔仍为 false（写入未持久确认）` };
  }
  const beyondChanged =
    (input.stage !== "lineage_finalization" && readBackEntry.lineageFinalized !== entry.lineageFinalized) ||
    (input.stage !== "outcome_finalization" && input.stage !== "lineage_finalization" && readBackEntry.outcomeFinalized !== entry.outcomeFinalized) ||
    (input.stage === "marker_discharge" && readBackEntry.authorityReleased !== entry.authorityReleased);
  if (beyondChanged) {
    return { outcome: "read_back_failed", detail: `ack ${input.stage} read-back 发现后续阶段被越级修改（写入未持久确认）` };
  }
  return {
    outcome: "acknowledged",
    detail: `${input.stage} 已写入并经 Memory read-back 确认（${external.detail}）`,
    ...(external.globalWriteAdmissionStillLocked !== undefined
      ? { globalWriteAdmissionStillLocked: external.globalWriteAdmissionStillLocked }
      : {}),
  };
}

// ── 公开阶段接口 ─────────────────────────────────────────────────────────────

function dischargeExpectedOf(entry: Readonly<TreasuryResolutionCleanupEntry>): TreasuryMarkerDischargeExpected {
  return {
    transactionId: entry.transactionId,
    digest: entry.digest,
    proofClass: entry.proofClass,
    identityProfile: entry.identityProfile,
    ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
    ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
    ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
    ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
    ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
    ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
    ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
    ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
  };
}

/**
 * 【六.2】marker discharge 阶段 ack：marker exact discharge（含 read-back）
 * → 持久 markerDischarged → journal read-back 确认。discharge blocked /
 * marker malformed / identity conflict / expected insufficient / 写入或
 * read-back 失败 / journal store unhealthy 均不得 release Authority。
 * unrelated marker：当前 attempt 阶段可完成（attemptMarkerDischarged），
 * global lock 保留、不删除其它 attempt marker。
 */
export function acknowledgeTreasuryCleanupMarkerDischarge(input: {
  readonly transactionId: string;
  readonly expected?: TreasuryCleanupAckIdentity;
}): TreasuryCleanupStageAckResult {
  return acknowledgeCleanupStage({
    transactionId: input.transactionId,
    stage: "marker_discharge",
    expected: input.expected,
    external: (entry) => {
      const discharge = dischargeTreasuryMarkerForAttempt(dischargeExpectedOf(entry));
      return {
        ok: treasuryMarkerDischargeCompletesAttemptPhase(discharge.outcome),
        detail: `${discharge.outcome}: ${discharge.detail}`,
        globalWriteAdmissionStillLocked: discharge.globalWriteAdmissionStillLocked,
        stageDetail: discharge.outcome,
      };
    },
  });
}

/**
 * 【六.3】authority release 阶段 ack：装配 handler（resolver 重确认 →
 * release → resolver read-back 必须 not_found）成功才持久 authorityReleased
 * 并 read-back。resolver ok / inconsistent / store_unhealthy 均不得进入
 * outcome finalization。handlers 未装配 → blocked（fail closed）。
 */
export function acknowledgeTreasuryCleanupAuthorityRelease(input: {
  readonly transactionId: string;
  readonly expected?: TreasuryCleanupAckIdentity;
}): TreasuryCleanupStageAckResult {
  const handlers = peekTreasuryResolutionCleanupStageHandlers();
  if (handlers === null) {
    return { outcome: "blocked", detail: "ack authority_release 拒绝：stage handlers 未装配（fail closed）" };
  }
  return acknowledgeCleanupStage({
    transactionId: input.transactionId,
    stage: "authority_release",
    expected: input.expected,
    external: (entry) => {
      const release = handlers.authorityRelease(entry);
      return {
        ok: release.status === "released" || release.status === "already_absent",
        detail: `${release.status}: ${release.detail}`,
      };
    },
  });
}

/**
 * 【六.4】outcome finalization 阶段 ack：committed 要求 release-trusted
 * Receipt 完整 match + final committed tombstone 已写入并 read-back + 相反
 * 结论 proof 不存在（或被确切证明 unrelated，由装配 handler 承载）；
 * not-executed 要求 final not-executed tombstone 完整 match + exact GRA
 * proof 完整 match + pending-release 状态与 retirement facts 一致。
 */
export function acknowledgeTreasuryCleanupOutcomeFinalization(input: {
  readonly transactionId: string;
  readonly expected?: TreasuryCleanupAckIdentity;
}): TreasuryCleanupStageAckResult {
  const handlers = peekTreasuryResolutionCleanupStageHandlers();
  if (handlers === null) {
    return { outcome: "blocked", detail: "ack outcome_finalization 拒绝：stage handlers 未装配（fail closed）" };
  }
  return acknowledgeCleanupStage({
    transactionId: input.transactionId,
    stage: "outcome_finalization",
    expected: input.expected,
    external: (entry) => {
      const outcome = handlers.outcomeFinalization(entry);
      return {
        ok: outcome.status === "finalized" || outcome.status === "already_final",
        detail: `${outcome.status}: ${outcome.detail}`,
      };
    },
  });
}

/**
 * 【六.5】lineage finalization 阶段 ack：rearm child committed 要求
 * matching lineage 已 chain_committed 且 read-back 完整 identity 匹配；
 * not-executed 要求 lineage 处于 rearm_ready 或 non-rearmable terminal 且
 * generation/parent/binding/exact identity 匹配；initial attempt 明确
 * not_applicable——仍经同一结构化接口，不得由调用点直接写 boolean。
 */
export function acknowledgeTreasuryCleanupLineageFinalization(input: {
  readonly transactionId: string;
  readonly expected?: TreasuryCleanupAckIdentity;
}): TreasuryCleanupStageAckResult {
  const handlers = peekTreasuryResolutionCleanupStageHandlers();
  if (handlers === null) {
    return { outcome: "blocked", detail: "ack lineage_finalization 拒绝：stage handlers 未装配（fail closed）" };
  }
  return acknowledgeCleanupStage({
    transactionId: input.transactionId,
    stage: "lineage_finalization",
    expected: input.expected,
    external: (entry) => {
      const lineage = handlers.lineageFinalization(entry);
      return {
        ok: lineage.status === "finalized" || lineage.status === "already_final" || lineage.status === "not_applicable",
        detail: `${lineage.status}: ${lineage.detail}`,
      };
    },
  });
}

/** cleanup 完成结果（删除 + read-back absent 才是完全完成）。 */
export interface TreasuryCleanupCompletionResult {
  readonly status: "completed" | "already_completed" | "cleanup_pending" | "store_unhealthy";
  readonly detail: string;
}

/**
 * 【六.6】journal completion ack：只有五个持久事实（settlementProofDurable /
 * markerDischarged / authorityReleased / outcomeFinalized / lineageFinalized）
 * 全部 read-back 为 true 才删除 entry；删除后重新读取 Memory 确认 entry
 * 不存在才返回 completed。删除失败或仍存在 → cleanup_pending（不得向调用
 * 者报告 fully complete）。
 */
export function completeTreasuryCleanupAcknowledged(transactionId: string): TreasuryCleanupCompletionResult {
  const health = peekTreasuryResolutionCleanupHealth();
  if (!health.healthy) {
    return { status: "store_unhealthy", detail: `cleanup journal unhealthy: ${health.detail ?? "unknown"}` };
  }
  const readBack0 = readBackTreasuryResolutionCleanupEntryFromMemory(transactionId);
  if (readBack0.status === "store_unhealthy") {
    return { status: "store_unhealthy", detail: readBack0.detail ?? "read-back store unhealthy" };
  }
  if (readBack0.status === "absent") {
    return { status: "already_completed", detail: "entry 已不存在（read-back 确认 absent——幂等已完成）" };
  }
  const entry = readBack0.entry!;
  if (
    !entry.settlementProofDurable ||
    !entry.markerDischarged ||
    !entry.authorityReleased ||
    !entry.outcomeFinalized ||
    !entry.lineageFinalized
  ) {
    return {
      status: "cleanup_pending",
      detail: `阶段未全部持久确认（proof=${String(entry.settlementProofDurable)} marker=${String(entry.markerDischarged)} authority=${String(entry.authorityReleased)} outcome=${String(entry.outcomeFinalized)} lineage=${String(entry.lineageFinalized)}）`,
    };
  }
  if (!completeTreasuryResolutionCleanup(transactionId)) {
    return { status: "cleanup_pending", detail: "cleanup entry 删除被拒（底层返回 false——entry 保留）" };
  }
  const afterFault = ackFaultInjector?.({ transactionId, stage: "journal_completion", phase: "after_delete" }) ?? null;
  if (afterFault === "restore_entry") {
    const store = (Memory.runtime as { treasury?: { resolutionCleanup?: { entries?: Record<string, unknown>; entryCount?: number } } } | undefined)
      ?.treasury?.resolutionCleanup;
    if (store?.entries) {
      store.entries[`c:${transactionId}`] = { ...entry, updatedAt: Game.time };
      if (typeof store.entryCount === "number") store.entryCount += 1;
    }
  }
  const readBack1 = readBackTreasuryResolutionCleanupEntryFromMemory(transactionId);
  if (readBack1.status === "present") {
    return { status: "cleanup_pending", detail: "删除后 read-back 仍存在 entry（journal completion 未持久确认）" };
  }
  if (readBack1.status === "store_unhealthy") {
    return { status: "store_unhealthy", detail: readBack1.detail ?? "删除后 read-back store unhealthy" };
  }
  return { status: "completed", detail: "cleanup entry 已删除并经 Memory read-back 确认 absent" };
}
