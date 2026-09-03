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
  recordTreasuryCleanupCompletion,
  lookupTreasuryCleanupCompletion,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import { lookupTreasuryHistoricalCompletion } from "@/runtime/treasury/cleanupSupersessionAuthority";
import { reclaimTreasuryCleanupCompletionHeadroom } from "@/runtime/treasury/cleanupCompletionReplacement";
import {
  dischargeTreasuryMarkerForAttempt,
  treasuryMarkerDischargeCompletesAttemptPhase,
  type TreasuryMarkerDischargeExpected,
} from "@/runtime/treasury/markerDischarge";

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
  /**
   * 【Remediation IV 十】lineage 阶段的完成语义（finalized/already_final
   * → final；not_applicable → not_applicable）——completion authority 写入
   * 时持久化"lineage 已 final 或明确 not-applicable"的区分事实。
   */
  readonly lineageDisposition?: "final" | "not_applicable";
}

/**
 * 调用方已知的 attempt identity。【Remediation IV 十一.4】state-changing
 * 调用不再接受可选 partial expected——journal entry 自身是唯一 expected
 * 来源（ack 协议以 Memory read-back 与 entry 的完整 11 字段自洽比较承载
 * 防篡改，调用方不再可能以部分字段绕过其它维度比较）。
 */
export type TreasuryCleanupAckIdentity = Readonly<TreasuryResolutionCleanupEntry>;

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
  readonly lineageDisposition?: "final" | "not_applicable";
}

function acknowledgeCleanupStage(input: {
  readonly transactionId: string;
  readonly stage: TreasuryResolutionCleanupStage;
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
  // 【Remediation IV 十一.4】journal entry 是唯一 expected 来源：heap 读取
  // 与 Memory read-back 的完整 11 字段自洽比较（任何维度被篡改 → conflict，
  // 零状态变化）——调用方不再可能以部分 expected 字段绕过其它维度。
  const identityReadBack = readBackTreasuryResolutionCleanupEntryFromMemory(input.transactionId);
  if (identityReadBack.status === "store_unhealthy") {
    return { outcome: "store_unhealthy", detail: `cleanup journal read-back unhealthy: ${identityReadBack.detail ?? "unknown"}` };
  }
  if (identityReadBack.status === "absent" || identityReadBack.entry === undefined) {
    return { outcome: "conflict", detail: `ack ${input.stage} 拒绝：Memory read-back entry 缺失（heap 与 Memory 不一致）` };
  }
  for (const field of ACK_IDENTITY_FIELDS) {
    if (identityReadBack.entry[field] !== entry[field]) {
      return { outcome: "conflict", detail: `ack ${input.stage} 拒绝：identity 字段 ${field} 在 Memory read-back 中不一致（篡改/损坏——零状态变化）` };
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
      ...(external.lineageDisposition !== undefined ? { lineageDisposition: external.lineageDisposition } : {}),
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
    ...(external.lineageDisposition !== undefined ? { lineageDisposition: external.lineageDisposition } : {}),
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
}): TreasuryCleanupStageAckResult {
  return acknowledgeCleanupStage({
    transactionId: input.transactionId,
    stage: "marker_discharge",
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
}): TreasuryCleanupStageAckResult {
  const handlers = peekTreasuryResolutionCleanupStageHandlers();
  if (handlers === null) {
    return { outcome: "blocked", detail: "ack authority_release 拒绝：stage handlers 未装配（fail closed）" };
  }
  return acknowledgeCleanupStage({
    transactionId: input.transactionId,
    stage: "authority_release",
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
}): TreasuryCleanupStageAckResult {
  const handlers = peekTreasuryResolutionCleanupStageHandlers();
  if (handlers === null) {
    return { outcome: "blocked", detail: "ack outcome_finalization 拒绝：stage handlers 未装配（fail closed）" };
  }
  return acknowledgeCleanupStage({
    transactionId: input.transactionId,
    stage: "outcome_finalization",
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
}): TreasuryCleanupStageAckResult {
  const handlers = peekTreasuryResolutionCleanupStageHandlers();
  if (handlers === null) {
    return { outcome: "blocked", detail: "ack lineage_finalization 拒绝：stage handlers 未装配（fail closed）" };
  }
  return acknowledgeCleanupStage({
    transactionId: input.transactionId,
    stage: "lineage_finalization",
    external: (entry) => {
      const lineage = handlers.lineageFinalization(entry);
      return {
        ok: lineage.status === "finalized" || lineage.status === "already_final" || lineage.status === "not_applicable",
        detail: `${lineage.status}: ${lineage.detail}`,
        lineageDisposition: lineage.status === "not_applicable" ? "not_applicable" : "final",
      };
    },
  });
}

/** cleanup 完成结果（completion proof 持久 + journal 删除 + 双 read-back 才是完全完成）。 */
export interface TreasuryCleanupCompletionResult {
  readonly status: "completed" | "already_completed" | "cleanup_pending" | "store_unhealthy" | "no_cleanup_authority";
  readonly detail: string;
}

/**
 * 【六.6 + Remediation IV 十.2】journal completion ack——固定写入顺序：
 *
 *   五个持久事实全部 read-back true
 *     → completion candidate 写入 + Memory read-back + exact identity 重新验证
 *     → 删除 journal entry
 *     → journal 删除 read-back absent
 *     → fully complete
 *
 * completion 写入失败 / read-back 冲突 → journal 保留（completion pending，
 * 下 tick 幂等重试）；journal 删除失败 → completion 存在、journal pending
 * （下 tick 幂等删除）。entry 已不存在时经 completion authority 区分合法
 * 完成（match → already_completed）与无权威的意外缺失（absent →
 * no_cleanup_authority——不得向调用者报告完成）。
 */
export function completeTreasuryCleanupAcknowledged(input: {
  readonly transactionId: string;
  readonly lineageDisposition: "final" | "not_applicable";
  readonly globalWriteAdmissionStillLocked?: boolean;
}): TreasuryCleanupCompletionResult {
  const { transactionId } = input;
  const health = peekTreasuryResolutionCleanupHealth();
  if (!health.healthy) {
    return { status: "store_unhealthy", detail: `cleanup journal unhealthy: ${health.detail ?? "unknown"}` };
  }
  const readBack0 = readBackTreasuryResolutionCleanupEntryFromMemory(transactionId);
  if (readBack0.status === "store_unhealthy") {
    return { status: "store_unhealthy", detail: readBack0.detail ?? "read-back store unhealthy" };
  }
  if (readBack0.status === "absent") {
    // 【Remediation IV 十.3】journal absent 不再自动等于完成：matching
    // completion authority 才能证明合法完成；absent → no_cleanup_authority
    // （journal 从未创建 / 被错误删除 / Memory 损坏丢失——fail closed）。
    // 【Remediation VI 4.2/4.3】completion 也 absent 时，持久完成权威是
    // durable historical authority（GRA/tombstone 不再单独证明——它们
    // 只证明 settlement/retirement，且有各自 retention 生命周期）。
    const completion = lookupTreasuryCleanupCompletion(transactionId);
    if (completion.verdict === "match") {
      return { status: "already_completed", detail: "entry 已删除且 matching completion authority 存在（幂等已完成）" };
    }
    if (completion.verdict === "absent") {
      const historical = lookupTreasuryHistoricalCompletion(transactionId);
      if (historical.verdict === "match") {
        return { status: "already_completed", detail: `entry 与 completion 均已回收，durable historical authority 持续证明完成（outcome=${historical.record.resolution}）` };
      }
      if (historical.verdict === "store_unhealthy") {
        return { status: "store_unhealthy", detail: `historical authority store unhealthy: ${historical.detail}` };
      }
      return { status: "no_cleanup_authority", detail: "journal entry 不存在且无 completion / durable historical authority（不得视为已完成——fail closed）" };
    }
    return { status: "store_unhealthy", detail: `completion authority ${completion.verdict}: ${completion.detail}` };
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
  // 【十.2】completion proof 先于 journal 删除持久化（写入 + read-back +
  // exact identity 重新验证——recordTreasuryCleanupCompletion 内部承载）。
  // 【Remediation VI 4.6】满载 fail closed 前先做 bounded headroom 回收——
  // **只有结构化 reason=capacity_exhausted 才允许触发 reclaim**（identity
  // conflict / invalid / unhealthy / read-back 失败一律零全局 GC 副作用）；
  // 回收 = exact archive（completion 验证 → durable historical authority
  // 写入 read-back → 删除 read-back，统一 supersession authority 入口），
  // 回收后重试一次：normal path 零扫描，仅满载这一罕见状态发生 bounded
  // （≤硬容量）回收。
  let completionWrite = recordTreasuryCleanupCompletion({
    entry,
    lineageDisposition: input.lineageDisposition,
    globalWriteAdmissionStillLocked: input.globalWriteAdmissionStillLocked ?? false,
  });
  if (completionWrite.status === "rejected" && completionWrite.reason === "capacity_exhausted") {
    const headroom = reclaimTreasuryCleanupCompletionHeadroom({ minSlots: 1 });
    if (headroom.reclaimed > 0) {
      completionWrite = recordTreasuryCleanupCompletion({
        entry,
        lineageDisposition: input.lineageDisposition,
        globalWriteAdmissionStillLocked: input.globalWriteAdmissionStillLocked ?? false,
      });
    }
  }
  if (completionWrite.status === "rejected") {
    return { status: "cleanup_pending", detail: `completion proof 写入失败（journal 保留）: ${completionWrite.detail}` };
  }
  if (!completeTreasuryResolutionCleanup(transactionId)) {
    // journal 删除失败：completion 已存在——下 tick 幂等重删（journal pending）。
    return { status: "cleanup_pending", detail: "cleanup entry 删除被拒（completion 已持久——下 tick 幂等删除）" };
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
    return { status: "cleanup_pending", detail: "删除后 read-back 仍存在 entry（completion 已持久——journal completion 未确认）" };
  }
  if (readBack1.status === "store_unhealthy") {
    return { status: "store_unhealthy", detail: readBack1.detail ?? "删除后 read-back store unhealthy" };
  }
  return { status: "completed", detail: "completion proof 已持久且 cleanup entry 删除经 Memory read-back 确认 absent" };
}
