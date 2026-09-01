/**
 * 【第十八轮 24.2】child handoff 状态机——单一权威的纯决策模块。
 *
 * handoff 的 durable mutation 由 attemptLineage 的协议 helper 承担（stage/
 * rollback/activate——store 权威）；本模块提供跨模块共用的**决策语义**：
 * - capability 消费的严格期望（预期 state 与 revision——删除 skip-all-
 *   revision 旁路后的唯一权威推导）；
 * - capability binding 与 lineage record 的完整匹配矩阵（§6.2：lineage 存在/
 *   lineageId/child/generation/binding/retry semantic 一致）；
 * - global reset 恢复窗口分类（intent 缺失/ready/executing/quarantine ×
 *   proof 匹配 → 回滚 / 前向补完成 / forensic）。
 *
 * 纯函数零 store 访问（type-only import——不与 attemptLineage/rearmCapability
 * 构成运行时循环依赖）。
 */

import type { TreasuryAttemptLineageRecord, TreasuryAttemptLineageState } from "@/runtime/treasury/attemptLineage";

/** capability 消费时的预期 lineage 状态（intent 已写入、read-back 已验证）。 */
export const TREASURY_HANDOFF_CONSUME_EXPECTED_STATE: TreasuryAttemptLineageState = "child_intent_pending";

/** capability 消费允许的明确 revision（签发 revision + 1——child_intent_pending 推进）。 */
export function expectedTreasuryHandoffConsumeRevision(
  capabilityLineageRecordRevision: number,
): number {
  return capabilityLineageRecordRevision + 1;
}

/**
 * capability binding 与 lineage record 的完整匹配矩阵（consume 严格验证——
 * §6.2）：lineageId、child（=record.nextChildTransactionId）、generation
 * （=record.generation+1）、binding（=record.pendingBindingDigest）、retry
 * semantic（=record.retrySemanticDigest）全部一致。
 */
export function treasuryRearmCapabilityBindingMatchesLineageRecord(
  binding: {
    readonly lineageId: string;
    readonly childTransactionId: string;
    readonly generation: number;
    readonly bindingDigest: string;
    readonly retrySemanticDigest: string;
  },
  record: Readonly<TreasuryAttemptLineageRecord>,
): { readonly status: "matched" } | { readonly status: "rejected"; readonly detail: string } {
  if (binding.lineageId !== record.lineageId) {
    return { status: "rejected", detail: `capability 绑定 lineage ${binding.lineageId.slice(0, 12)} 与 record ${record.lineageId.slice(0, 12)} 不一致` };
  }
  if (record.state !== TREASURY_HANDOFF_CONSUME_EXPECTED_STATE) {
    return { status: "rejected", detail: `lineage 状态 ${String(record.state)} 不是预期的 ${TREASURY_HANDOFF_CONSUME_EXPECTED_STATE}（capability 不得消费）` };
  }
  if (record.nextChildTransactionId !== binding.childTransactionId) {
    return { status: "rejected", detail: "capability 绑定 child 与 lineage 冻结的 nextChildTransactionId 不一致" };
  }
  if (record.generation + 1 !== binding.generation) {
    return { status: "rejected", detail: `capability 绑定 generation ${String(binding.generation)} 与 lineage 下一代（${String(record.generation + 1)}）不一致` };
  }
  if (record.pendingBindingDigest !== binding.bindingDigest) {
    return { status: "rejected", detail: "capability 绑定 binding digest 与 lineage pendingBindingDigest 不一致（handoff facts 被篡改或非本 handoff）" };
  }
  if (record.retrySemanticDigest !== binding.retrySemanticDigest) {
    return { status: "rejected", detail: "capability 绑定 retry semantic digest 与 lineage record 不一致" };
  }
  return { status: "matched" };
}

/** 恢复窗口的 intent/quarantine lineage proof 视图（持久 entry 的共同形状）。 */
export interface TreasuryHandoffEntryProofView {
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly lineageBindingDigest?: string;
}

/** entry（intent/quarantine）proof 与 handoff facts 匹配（generation = record+1）。 */
export function treasuryHandoffEntryProofMatches(
  entry: TreasuryHandoffEntryProofView | undefined,
  record: Readonly<TreasuryAttemptLineageRecord>,
): boolean {
  if (entry === undefined) return false;
  return (
    entry.lineageId === record.lineageId &&
    entry.lineageGeneration === record.generation + 1 &&
    entry.lineageBindingDigest === record.pendingBindingDigest &&
    entry.lineageBindingDigest !== undefined
  );
}

/** beginTick 恢复窗口分类（child_intent_pending 状态的决策）。 */
export type TreasuryHandoffRecoveryWindow =
  | { readonly action: "rollback"; readonly releaseIntent: boolean; readonly detail: string }
  | { readonly action: "forward_complete"; readonly detail: string }
  | { readonly action: "forensic"; readonly detail: string };

/**
 * 窗口判定（§6.3 / 【第十九轮 B】双 authority 版——intent 存在时同样读取
 * quarantine，绝不因一侧存在而忽略另一侧）：
 * - 任一侧 lineage proof 冲突（binding/generation/lineage 不匹配或部分
 *   存在）→ forensic isolation（保留全部 authority，不猜测）；
 * - rollback 仅当 callback **确定未开始**：intent 为一致 not_started/ready
 *   且**无任何匹配或冲突的 quarantine**（quarantine 是 Game callback 后
 *   写入的 durable 事实——存在即说明 callback 可能已开始）；
 * - intent 一致 ready 但 quarantine 匹配存在（转移中断窗口：quarantine 写
 *   成功、intent 删除前中断）→ forward_complete（绝不回滚）；
 * - intent 已 executing/更后 → forward_complete（无冲突 quarantine 时）；
 * - intent 缺失但 quarantine proof 匹配 → forward_complete；
 * - intent 与 quarantine 均缺失 → rollback（零释放——无 intent 可释放）。
 */
export function classifyTreasuryHandoffRecoveryWindow(input: {
  readonly record: Readonly<TreasuryAttemptLineageRecord>;
  readonly intent:
    | (TreasuryHandoffEntryProofView & { readonly outcome?: string; readonly settlement?: string })
    | undefined;
  readonly quarantine: TreasuryHandoffEntryProofView | undefined;
}): TreasuryHandoffRecoveryWindow {
  const { record, intent, quarantine } = input;
  // 【第十九轮 B.3】两侧 proof 独立验证先行：intent 冲突或 quarantine 冲突
  // 都进入 forensic（保留全部 authority——不因一侧"看起来正常"而放行）。
  if (intent !== undefined && !treasuryHandoffEntryProofMatches(intent, record)) {
    return {
      action: "forensic",
      detail: "child_intent_pending 窗口 intent lineage proof 冲突（binding/generation/lineage 不匹配或缺失）",
    };
  }
  if (quarantine !== undefined && !treasuryHandoffEntryProofMatches(quarantine, record)) {
    return {
      action: "forensic",
      detail: "child_intent_pending 窗口 quarantine lineage proof 冲突（intent 存在时同样验证——双 authority 任一冲突即 forensic，不猜测）",
    };
  }
  // 【第十九轮 B.4/B.6】rollback 条件：intent 一致 not_started/ready 且无任何
  // quarantine（execution-started 的持久信号为零）。Intent ready 与 quarantine
  // 并存时绝不回滚（quarantine 的存在本身即 callback 后事实）。
  if (intent !== undefined && intent.outcome === "not_started" && intent.settlement === "ready" && quarantine === undefined) {
    return {
      action: "rollback",
      releaseIntent: true,
      detail: "intent 一致 not_started/ready 且无任何 quarantine（execution-started 未持久化——callback 确定未开始）",
    };
  }
  if (quarantine !== undefined) {
    return {
      action: "forward_complete",
      detail: intent !== undefined
        ? "intent 与 quarantine 并存（转移中断窗口——quarantine proof 匹配且是 callback 后事实，前向补完成，绝不回滚）"
        : "intent 已转 quarantine 且 lineage proof 匹配（authority 接管——前向补完成接管）",
    };
  }
  if (intent !== undefined) {
    return {
      action: "forward_complete",
      detail: `intent 已进入 ${String(intent.settlement)}（callback 可能已开始——前向补完成接管）`,
    };
  }
  return {
    action: "rollback",
    releaseIntent: false,
    detail: "intent 与 quarantine 均缺失（callback 确定未开始）",
  };
}
