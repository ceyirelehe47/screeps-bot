/**
 * Treasury Core Kernel——纯状态转移函数（单一权威的状态判定层）。
 *
 * 本模块零副作用、零 IO：输入 (memory, command, ctx)，输出新 memory 或
 * 拒绝。持久化、read-back、permit 校验、action 调用都在 kernel.ts 的
 * 单一写入口内完成。恢复、GC、容量回收同样只能通过这里的转移规则——
 * 没有任何路径可以在 phase 之外直接删除/消费聚合（design §7.1）。
 *
 * 阶段不变量（每次转移后必须成立）：
 * - pending：无 invocation/external 事实，outcome=unknown，无 evidence。
 *   可经 cancel_pending 安全取消（§6.1：调用边界尚未成功开始的工作）。
 * - dispatching：当次调用边界已发布；只有当次调用者可推进（dispatch_result）
 *   或恢复/边界保守化（recover → outcome_unknown）。
 * - outcome_unknown：invocation 可能已发生；不可再调用、不可直接 rearm。
 * - closing：outcome 确定（committed/not_executed 且有证据）；不可再调用。
 * - retry_ready：not_executed 且清理完成；有界 retry 权利期限。
 * - closed 不落盘：移出 active，可选写 ring。
 *
 * Core Rewrite II：
 * - cancel_pending：正面确认（invocation/external 均为空 + pending）后才
 *   取消；有清理义务走 closing，无义务原子关闭；取消不生成 rearm 权利
 *  （pending_cancellation 证据的清理完成后直接退出，不进 retry_ready）。
 * - settle 命令只接受 adapter_reconcile（自报结论通道关闭——R07）。
 * - 计数器饱和（不回绕）；admit 检查 consumerKeys 数量上限（R09）。
 */

import {
  TREASURY_CORE_ACTIVE_LIMIT,
  TREASURY_CORE_CONSUMER_KEYS_MAX,
  TREASURY_CORE_COUNTER_SATURATION,
  TREASURY_CORE_ERROR_DETAIL_MAX,
  TREASURY_CORE_RETRY_RIGHT_TICKS,
  TREASURY_CORE_WORST_CASE_LEGS_MAX,
  type TreasuryCoreMemory,
  type TreasuryCoreOutcome,
  type TreasuryCorePhase,
  type TreasuryCoreRingEntry,
  type TreasuryCoreSettlementEvidence,
  type TreasuryCoreWorstCaseLeg,
  type TreasuryCoreWorkRecord,
  type TreasuryCoreIdentityFacts,
} from "@/runtime/treasury/kernel/types";
import { mintTreasuryCoreAttemptId } from "@/runtime/treasury/kernel/identity";
import { appendTreasuryCoreRingEntry } from "@/runtime/treasury/kernel/store";

export interface TreasuryCoreCommandContext {
  readonly nowTick: number;
}

export type TreasuryCoreEffect =
  | { readonly effect: "admitted"; readonly attemptId: string }
  | { readonly effect: "dispatch_started"; readonly attemptId: string }
  | { readonly effect: "outcome_recorded"; readonly attemptId: string; readonly outcome: TreasuryCoreOutcome }
  | { readonly effect: "still_uncertain"; readonly attemptId: string }
  | { readonly effect: "recovered_to_unknown"; readonly attemptId: string }
  | { readonly effect: "retry_ready"; readonly attemptId: string }
  | { readonly effect: "cancelled"; readonly attemptId: string; readonly ring: TreasuryCoreRingEntry | null }
  | { readonly effect: "closed"; readonly attemptId: string; readonly ring: TreasuryCoreRingEntry | null }
  | { readonly effect: "rearmed"; readonly parentAttemptId: string; readonly attemptId: string };

export type TreasuryCoreCommandResult =
  | { readonly status: "ok"; readonly memory: TreasuryCoreMemory; readonly effects: readonly TreasuryCoreEffect[] }
  | { readonly status: "rejected"; readonly reason: string };

// ── 命令载荷 ────────────────────────────────────────────────────────────────

export interface TreasuryCoreAdmitCommand {
  readonly type: "admit";
  readonly workKey: string;
  readonly identity: TreasuryCoreIdentityFacts;
  readonly worstCase: readonly TreasuryCoreWorstCaseLeg[];
  /** 受控外部消费者 key（有则 closing 阶段须逐一幂等释放确认）。 */
  readonly externalConsumers: readonly string[];
}

export interface TreasuryCoreDispatchStartCommand {
  readonly type: "dispatch_start";
  readonly attemptId: string;
  /** 当次许可绑定的 canonical 摘要（身份不匹配 → 拒绝，不推进）。 */
  readonly canonicalDigest: string;
}

export interface TreasuryCoreDispatchResultCommand {
  readonly type: "dispatch_result";
  readonly attemptId: string;
  readonly invocationAtTick: number;
  readonly external: { readonly accepted: boolean } | null;
  readonly outcome: "committed" | "not_executed" | "unknown";
  readonly evidence: TreasuryCoreSettlementEvidence | null;
  readonly error: string | null;
}

export interface TreasuryCoreSettleCommand {
  readonly type: "settle";
  readonly attemptId: string;
  /** adapter_reconcile 证据：结论由内核受控编排的 reconciler 得出（唯一通道）。 */
  readonly evidence: {
    readonly kind: "adapter_reconcile";
    readonly conclusion: "executed" | "not_executed" | "still_uncertain";
    readonly source: string;
  };
}

export interface TreasuryCoreAdvanceCleanupCommand {
  readonly type: "advance_cleanup";
  readonly attemptId: string;
  /** 释放端口已确认幂等完成的外部消费者 key（kernel 传入；本模块只做状态判定）。 */
  readonly releasedDuties: readonly string[];
}

export interface TreasuryCoreRearmCommand {
  readonly type: "rearm";
  readonly parentAttemptId: string;
  readonly identity: TreasuryCoreIdentityFacts;
  readonly worstCase: readonly TreasuryCoreWorstCaseLeg[];
}

export interface TreasuryCoreCloseCommand {
  readonly type: "close";
  readonly attemptId: string;
  readonly reason: "retry_expired" | "abandoned";
}

export interface TreasuryCoreRecoverCommand {
  readonly type: "recover_dispatching";
  readonly attemptId: string;
}

/** 安全取消（§6.1）：只结束确定未开始的当前 attempt。 */
export interface TreasuryCoreCancelPendingCommand {
  readonly type: "cancel_pending";
  readonly attemptId: string;
}

export type TreasuryCoreCommand =
  | TreasuryCoreAdmitCommand
  | TreasuryCoreDispatchStartCommand
  | TreasuryCoreDispatchResultCommand
  | TreasuryCoreSettleCommand
  | TreasuryCoreAdvanceCleanupCommand
  | TreasuryCoreRearmCommand
  | TreasuryCoreCloseCommand
  | TreasuryCoreRecoverCommand
  | TreasuryCoreCancelPendingCommand;

// ── 转移实现 ────────────────────────────────────────────────────────────────

const MAX_FRONTIER = 9_999_999_999;

/** 饱和递增（溢出不回绕、不抛错——纯诊断计数不得拖垮安全核心）。 */
function bumpCounter(memory: TreasuryCoreMemory, key: keyof TreasuryCoreMemory["counters"]): void {
  const current = memory.counters[key];
  if (current < TREASURY_CORE_COUNTER_SATURATION) {
    memory.counters[key] = current + 1;
  }
}

function getActive(memory: TreasuryCoreMemory, attemptId: string): TreasuryCoreWorkRecord | undefined {
  return memory.active[attemptId];
}

function withRecord(
  memory: TreasuryCoreMemory,
  attemptId: string,
  update: (record: TreasuryCoreWorkRecord) => TreasuryCoreWorkRecord | "remove",
): TreasuryCoreMemory {
  const current = getActive(memory, attemptId);
  if (current === undefined) return memory;
  const next = update(current);
  if (next === "remove") {
    delete memory.active[attemptId];
    return memory;
  }
  memory.active[attemptId] = next;
  return memory;
}

function requirePhase(record: TreasuryCoreWorkRecord, phase: TreasuryCorePhase): string | null {
  return record.phase === phase ? null : `attempt ${record.attemptId} 阶段为 ${record.phase}，命令要求 ${phase}`;
}

function sameWorkKeyActive(memory: TreasuryCoreMemory, workKey: string): string | null {
  for (const record of Object.values(memory.active)) {
    if (record.workKey === workKey) {
      return `活动工作排他冲突：workKey ${workKey} 已有活跃聚合 ${record.attemptId}（phase=${record.phase}）`;
    }
  }
  return null;
}

function clampError(error: string | null): string | null {
  if (error === null) return null;
  return error.length > TREASURY_CORE_ERROR_DETAIL_MAX
    ? `${error.slice(0, TREASURY_CORE_ERROR_DETAIL_MAX - 3)}...`
    : error;
}

export function applyTreasuryCoreStateCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  switch (command.type) {
    case "admit":
      return admitCommand(memory, command, ctx);
    case "dispatch_start":
      return dispatchStartCommand(memory, command, ctx);
    case "dispatch_result":
      return dispatchResultCommand(memory, command, ctx);
    case "settle":
      return settleCommand(memory, command, ctx);
    case "advance_cleanup":
      return advanceCleanupCommand(memory, command, ctx);
    case "rearm":
      return rearmCommand(memory, command, ctx);
    case "close":
      return closeCommand(memory, command, ctx);
    case "recover_dispatching":
      return recoverCommand(memory, command, ctx);
    case "cancel_pending":
      return cancelPendingCommand(memory, command, ctx);
  }
}

function admitCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreAdmitCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  if (Object.keys(memory.active).length >= TREASURY_CORE_ACTIVE_LIMIT) {
    bumpCounter(memory, "rejectedAdmissions");
    return { status: "rejected", reason: `活跃集合满载（${String(TREASURY_CORE_ACTIVE_LIMIT)}），拒绝接纳` };
  }
  const conflict = sameWorkKeyActive(memory, command.workKey);
  if (conflict !== null) {
    bumpCounter(memory, "rejectedAdmissions");
    return { status: "rejected", reason: conflict };
  }
  if (command.worstCase.length === 0 || command.worstCase.length > TREASURY_CORE_WORST_CASE_LEGS_MAX) {
    bumpCounter(memory, "rejectedAdmissions");
    return { status: "rejected", reason: "worstCase 腿数非法" };
  }
  // 消费者数量上限（R09）：超限整体拒绝，不截断一半义务。
  if (command.externalConsumers.length > TREASURY_CORE_CONSUMER_KEYS_MAX) {
    bumpCounter(memory, "rejectedAdmissions");
    return {
      status: "rejected",
      reason: `externalConsumers 超过上限 ${String(TREASURY_CORE_CONSUMER_KEYS_MAX)}（超限安全输入整体拒绝）`,
    };
  }
  for (const key of command.externalConsumers) {
    if (typeof key !== "string" || key.length === 0 || key.length > 128) {
      bumpCounter(memory, "rejectedAdmissions");
      return { status: "rejected", reason: "externalConsumers 条目非法" };
    }
  }
  const nextFrontier = memory.issuance.frontier + 1;
  if (nextFrontier > MAX_FRONTIER) {
    bumpCounter(memory, "rejectedAdmissions");
    return { status: "rejected", reason: "发行 frontier 溢出（拒绝分配，不回绕）" };
  }
  const attemptId = mintTreasuryCoreAttemptId(nextFrontier, command.workKey, command.identity.canonicalDigest);
  const record: TreasuryCoreWorkRecord = {
    workKey: command.workKey,
    attemptId,
    generation: 1,
    parentAttemptId: null,
    phase: "pending",
    admittedAtTick: ctx.nowTick,
    updatedAtTick: ctx.nowTick,
    identity: command.identity,
    worstCase: command.worstCase,
    invocation: null,
    external: null,
    outcome: "unknown",
    outcomeEvidence: null,
    cleanup: { consumerKeys: [...command.externalConsumers], failures: 0 },
    retryDeadlineTick: null,
    lastError: null,
  };
  memory.issuance.frontier = nextFrontier;
  memory.active[attemptId] = record;
  bumpCounter(memory, "admitted");
  return { status: "ok", memory, effects: [{ effect: "admitted", attemptId }] };
}

function dispatchStartCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreDispatchStartCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  const record = getActive(memory, command.attemptId);
  if (record === undefined) {
    return { status: "rejected", reason: `attempt ${command.attemptId} 不在活跃集合（无执行许可）` };
  }
  const phaseProblem = requirePhase(record, "pending");
  if (phaseProblem !== null) return { status: "rejected", reason: phaseProblem };
  if (record.identity.canonicalDigest !== command.canonicalDigest) {
    return {
      status: "rejected",
      reason: `attempt ${command.attemptId} 身份冲突：许可绑定 ${command.canonicalDigest.slice(0, 12)}，聚合绑定 ${record.identity.canonicalDigest.slice(0, 12)}（原事实保留，不推进）`,
    };
  }
  withRecord(memory, command.attemptId, (r) => ({ ...r, phase: "dispatching", updatedAtTick: ctx.nowTick }));
  bumpCounter(memory, "dispatched");
  return { status: "ok", memory, effects: [{ effect: "dispatch_started", attemptId: command.attemptId }] };
}

function dispatchResultCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreDispatchResultCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  const record = getActive(memory, command.attemptId);
  if (record === undefined) {
    return { status: "rejected", reason: `attempt ${command.attemptId} 不在活跃集合` };
  }
  const phaseProblem = requirePhase(record, "dispatching");
  if (phaseProblem !== null) return { status: "rejected", reason: phaseProblem };
  const invocation = { atTick: command.invocationAtTick };
  const external = command.external === null ? null : { accepted: command.external.accepted, atTick: ctx.nowTick };
  if (command.outcome === "unknown") {
    withRecord(memory, command.attemptId, (r) => ({
      ...r,
      phase: "outcome_unknown",
      invocation,
      external,
      outcome: "unknown",
      lastError: clampError(command.error),
      updatedAtTick: ctx.nowTick,
    }));
    bumpCounter(memory, "unknown");
    return { status: "ok", memory, effects: [{ effect: "outcome_recorded", attemptId: command.attemptId, outcome: "unknown" }] };
  }
  if (command.outcome === "committed") {
    if (command.evidence === null) {
      return { status: "rejected", reason: "committed 结算必须携带证据（外部接受不构成无条件完成证明）" };
    }
    withRecord(memory, command.attemptId, (r) => ({
      ...r,
      phase: "closing",
      invocation,
      external,
      outcome: "committed",
      outcomeEvidence: { ...command.evidence, atTick: ctx.nowTick } as TreasuryCoreSettlementEvidence,
      lastError: clampError(command.error),
      updatedAtTick: ctx.nowTick,
    }));
    bumpCounter(memory, "settledCommitted");
    return { status: "ok", memory, effects: [{ effect: "outcome_recorded", attemptId: command.attemptId, outcome: "committed" }] };
  }
  if (command.evidence === null) {
    return { status: "rejected", reason: "not_executed 结算必须携带证据（不得凭失败状态释放风险）" };
  }
  withRecord(memory, command.attemptId, (r) => ({
    ...r,
    phase: "closing",
    invocation,
    external,
    outcome: "not_executed",
    outcomeEvidence: { ...command.evidence, atTick: ctx.nowTick } as TreasuryCoreSettlementEvidence,
    lastError: clampError(command.error),
    updatedAtTick: ctx.nowTick,
  }));
  bumpCounter(memory, "settledNotExecuted");
  return { status: "ok", memory, effects: [{ effect: "outcome_recorded", attemptId: command.attemptId, outcome: "not_executed" }] };
}

function settleCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreSettleCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  const record = getActive(memory, command.attemptId);
  if (record === undefined) return { status: "rejected", reason: `attempt ${command.attemptId} 不在活跃集合` };
  const phaseProblem = requirePhase(record, "outcome_unknown");
  if (phaseProblem !== null) return { status: "rejected", reason: phaseProblem };
  if (command.evidence.conclusion === "still_uncertain") {
    return { status: "ok", memory, effects: [{ effect: "still_uncertain", attemptId: command.attemptId }] };
  }
  const outcome: TreasuryCoreOutcome = command.evidence.conclusion === "executed" ? "committed" : "not_executed";
  const evidence: TreasuryCoreSettlementEvidence = { ...command.evidence, atTick: ctx.nowTick };
  withRecord(memory, command.attemptId, (r) => ({
    ...r,
    phase: "closing",
    outcome,
    outcomeEvidence: evidence,
    updatedAtTick: ctx.nowTick,
  }));
  if (outcome === "committed") bumpCounter(memory, "settledCommitted");
  else bumpCounter(memory, "settledNotExecuted");
  return { status: "ok", memory, effects: [{ effect: "outcome_recorded", attemptId: command.attemptId, outcome }] };
}

function advanceCleanupCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreAdvanceCleanupCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  const record = getActive(memory, command.attemptId);
  if (record === undefined) return { status: "rejected", reason: `attempt ${command.attemptId} 不在活跃集合` };
  const phaseProblem = requirePhase(record, "closing");
  if (phaseProblem !== null) return { status: "rejected", reason: phaseProblem };
  const remaining = record.cleanup.consumerKeys.filter((key) => !command.releasedDuties.includes(key));
  if (command.releasedDuties.some((key) => !record.cleanup.consumerKeys.includes(key))) {
    return { status: "rejected", reason: "释放清单包含不存在的消费者 key" };
  }
  if (remaining.length > 0) {
    // 本次推进未确认任何义务 → 失败计数（诊断有界，不无限累积故障记录）。
    const failures = command.releasedDuties.length === 0 ? record.cleanup.failures + 1 : record.cleanup.failures;
    withRecord(memory, command.attemptId, (r) => ({
      ...r,
      cleanup: { consumerKeys: remaining, failures: Math.min(failures, TREASURY_CORE_COUNTER_SATURATION) },
      updatedAtTick: ctx.nowTick,
    }));
    return { status: "ok", memory, effects: [] };
  }
  // 安全取消来源的清理完成：直接退出（取消不生成 rearm 权利——§6.1）。
  if (record.outcomeEvidence?.kind === "pending_cancellation") {
    const ringEntry: TreasuryCoreRingEntry = {
      attemptId: record.attemptId,
      workKey: record.workKey,
      generation: record.generation,
      terminalPhase: "abandoned",
      closedAtTick: ctx.nowTick,
    };
    withRecord(memory, command.attemptId, () => "remove");
    appendTreasuryCoreRingEntry(memory, ringEntry);
    return { status: "ok", memory, effects: [{ effect: "cancelled", attemptId: command.attemptId, ring: ringEntry }] };
  }
  if (record.outcome === "not_executed") {
    withRecord(memory, command.attemptId, (r) => ({
      ...r,
      phase: "retry_ready",
      retryDeadlineTick: ctx.nowTick + TREASURY_CORE_RETRY_RIGHT_TICKS,
      updatedAtTick: ctx.nowTick,
    }));
    return { status: "ok", memory, effects: [{ effect: "retry_ready", attemptId: command.attemptId }] };
  }
  // committed 且清理完成 → 真正退出活跃集合，可选写 ring。
  const ringEntry: TreasuryCoreRingEntry = {
    attemptId: record.attemptId,
    workKey: record.workKey,
    generation: record.generation,
    terminalPhase: "committed",
    closedAtTick: ctx.nowTick,
  };
  withRecord(memory, command.attemptId, () => "remove");
  appendTreasuryCoreRingEntry(memory, ringEntry);
  return { status: "ok", memory, effects: [{ effect: "closed", attemptId: command.attemptId, ring: ringEntry }] };
}

function rearmCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreRearmCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  const parent = getActive(memory, command.parentAttemptId);
  if (parent === undefined) {
    return { status: "rejected", reason: `前代 attempt ${command.parentAttemptId} 不在活跃集合（rearm 许可无效）` };
  }
  const phaseProblem = requirePhase(parent, "retry_ready");
  if (phaseProblem !== null) return { status: "rejected", reason: phaseProblem };
  if (parent.retryDeadlineTick === null || ctx.nowTick > parent.retryDeadlineTick) {
    return { status: "rejected", reason: "retry 权利已过期（过期的是 retry 权利，须走 close）" };
  }
  if (parent.identity.retryFactsDigest === null || command.identity.retryFactsDigest === null) {
    return { status: "rejected", reason: "前代或新 attempt 缺少 retry 语义事实（non-rearmable，不猜测）" };
  }
  if (parent.identity.retryFactsDigest !== command.identity.retryFactsDigest) {
    return {
      status: "rejected",
      reason: "retry 语义事实与前代不一致（改变动作参数/adapter 语义的 retry 必须拒绝）",
    };
  }
  if (command.identity.actionKind !== parent.identity.actionKind) {
    return { status: "rejected", reason: "retry 的 actionKind 与前代不一致" };
  }
  if (Object.keys(memory.active).length >= TREASURY_CORE_ACTIVE_LIMIT) {
    return { status: "rejected", reason: "活跃集合满载，rearm 延迟（不把未关闭责任搬进历史池）" };
  }
  const nextFrontier = memory.issuance.frontier + 1;
  if (nextFrontier > MAX_FRONTIER) {
    return { status: "rejected", reason: "发行 frontier 溢出（拒绝分配，不回绕）" };
  }
  const attemptId = mintTreasuryCoreAttemptId(nextFrontier, parent.workKey, command.identity.canonicalDigest);
  const ringEntry: TreasuryCoreRingEntry = {
    attemptId: parent.attemptId,
    workKey: parent.workKey,
    generation: parent.generation,
    terminalPhase: "not_executed",
    closedAtTick: ctx.nowTick,
  };
  withRecord(memory, parent.attemptId, () => "remove");
  appendTreasuryCoreRingEntry(memory, ringEntry);
  memory.active[attemptId] = {
    workKey: parent.workKey,
    attemptId,
    generation: parent.generation + 1,
    parentAttemptId: parent.attemptId,
    phase: "pending",
    admittedAtTick: ctx.nowTick,
    updatedAtTick: ctx.nowTick,
    identity: command.identity,
    worstCase: command.worstCase,
    invocation: null,
    external: null,
    outcome: "unknown",
    outcomeEvidence: null,
    cleanup: { consumerKeys: [...parent.cleanup.consumerKeys], failures: 0 },
    retryDeadlineTick: null,
    lastError: null,
  };
  memory.issuance.frontier = nextFrontier;
  bumpCounter(memory, "rearmings");
  return {
    status: "ok",
    memory,
    effects: [{ effect: "rearmed", parentAttemptId: parent.attemptId, attemptId }],
  };
}

function closeCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreCloseCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  const record = getActive(memory, command.attemptId);
  if (record === undefined) return { status: "rejected", reason: `attempt ${command.attemptId} 不在活跃集合` };
  const phaseProblem = requirePhase(record, "retry_ready");
  if (phaseProblem !== null) {
    return {
      status: "rejected",
      reason: `${phaseProblem}（仅已知安全的 retry_ready 工作可被关闭；执行未知的记录不能被 TTL 驱逐）`,
    };
  }
  if (command.reason === "retry_expired") {
    if (record.retryDeadlineTick === null || ctx.nowTick <= record.retryDeadlineTick) {
      return { status: "rejected", reason: "retry 期限未到（不可提前过期关闭）" };
    }
  }
  const ringEntry: TreasuryCoreRingEntry = {
    attemptId: record.attemptId,
    workKey: record.workKey,
    generation: record.generation,
    terminalPhase: command.reason === "retry_expired" ? "retry_expired" : "abandoned",
    closedAtTick: ctx.nowTick,
  };
  withRecord(memory, command.attemptId, () => "remove");
  appendTreasuryCoreRingEntry(memory, ringEntry);
  return { status: "ok", memory, effects: [{ effect: "closed", attemptId: command.attemptId, ring: ringEntry }] };
}

function recoverCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreRecoverCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  const record = getActive(memory, command.attemptId);
  if (record === undefined) return { status: "rejected", reason: `attempt ${command.attemptId} 不在活跃集合` };
  const phaseProblem = requirePhase(record, "dispatching");
  if (phaseProblem !== null) return { status: "rejected", reason: phaseProblem };
  // 恢复只能保守化：可能已进入 → 结果未知。不重发、不消费许可、不推导
  // not_executed（未知不能由年龄/缺记录推导成未执行）。
  withRecord(memory, command.attemptId, (r) => ({
    ...r,
    phase: "outcome_unknown",
    outcome: "unknown",
    updatedAtTick: ctx.nowTick,
  }));
  bumpCounter(memory, "unknown");
  return { status: "ok", memory, effects: [{ effect: "recovered_to_unknown", attemptId: command.attemptId }] };
}

/**
 * 安全取消（§6.1）：只结束已知未开始的当前 attempt。
 * - 正面确认：phase=pending 且 invocation=null 且 external=null（无任何
 *   “可能已进入动作”的事实）。dispatching/unknown 不能被取消成未执行。
 * - 有清理义务 → 进入 closing（pending_cancellation 证据）；义务经既有
 *   幂等释放协议完成后退出（不生成 rearm 权利）。
 * - 无义务 → 同一命令原子安全关闭（ring terminalPhase=abandoned）。
 * - 取消写回失败不释放占用、不报告完成（由写协议保证）。
 */
function cancelPendingCommand(
  memory: TreasuryCoreMemory,
  command: TreasuryCoreCancelPendingCommand,
  ctx: TreasuryCoreCommandContext,
): TreasuryCoreCommandResult {
  const record = getActive(memory, command.attemptId);
  if (record === undefined) return { status: "rejected", reason: `attempt ${command.attemptId} 不在活跃集合` };
  const phaseProblem = requirePhase(record, "pending");
  if (phaseProblem !== null) {
    return { status: "rejected", reason: `${phaseProblem}（只有确定未开始的 pending 可安全取消）` };
  }
  if (record.invocation !== null || record.external !== null) {
    return { status: "rejected", reason: "存在调用边界事实（不可凭取消抹除已发生的调用）" };
  }
  if (record.cleanup.consumerKeys.length > 0) {
    withRecord(memory, command.attemptId, (r) => ({
      ...r,
      phase: "closing",
      outcome: "not_executed",
      outcomeEvidence: { kind: "pending_cancellation", conclusion: "not_executed", source: "kernel:safe_cancel", atTick: ctx.nowTick },
      updatedAtTick: ctx.nowTick,
    }));
    return { status: "ok", memory, effects: [{ effect: "cancelled", attemptId: command.attemptId, ring: null }] };
  }
  const ringEntry: TreasuryCoreRingEntry = {
    attemptId: record.attemptId,
    workKey: record.workKey,
    generation: record.generation,
    terminalPhase: "abandoned",
    closedAtTick: ctx.nowTick,
  };
  withRecord(memory, command.attemptId, () => "remove");
  appendTreasuryCoreRingEntry(memory, ringEntry);
  return { status: "ok", memory, effects: [{ effect: "cancelled", attemptId: command.attemptId, ring: ringEntry }] };
}
