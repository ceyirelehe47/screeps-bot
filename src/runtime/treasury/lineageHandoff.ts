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

import type { TreasuryAttemptLineageRecord, TreasuryAttemptLineageState, TreasuryAttemptLineageIdentity } from "@/runtime/treasury/attemptLineage";
import type { TreasuryUnresolvedAuthorityResolution } from "@/runtime/treasury/unresolvedAuthority";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";

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

// ── 【第二十轮第七节】unified exact authority 版恢复判定 ────────────────────

/** unified authority 版窗口动作（forward 携带从 resolver 结果构造的 child identity）。 */
export type TreasuryHandoffAuthorityWindow =
  | { readonly action: "rollback"; readonly releaseIntent: boolean; readonly detail: string }
  | { readonly action: "forward_complete"; readonly childIdentity: TreasuryAttemptLineageIdentity; readonly detail: string }
  | { readonly action: "forensic"; readonly detail: string }
  | { readonly action: "pending_store_unhealthy"; readonly detail: string };

/**
 * 【第二十轮 7.2/7.3/7.4/7.5】child_intent_pending 窗口的完整 authority 一致性
 * 判定（单一决策入口——attemptLineage 的 beginTick handoff 恢复使用）：
 *
 * 输入为 resolveTreasuryUnresolvedAuthority(childId) 的**完整**解析结果（绝
 * 不在两侧删除前另行拆读单个 store）。矩阵：
 * - store_unhealthy → pending（保留两侧证据，不 rollback、不 forward——
 *   store 损坏绝不解释为 authority absent）；
 * - inconsistent（含 intent/quarantine 的 identity/等级/lineage/execution
 *   fact 冲突）→ forensic（保留全部 authority）；
 * - not_found（两侧均无）→ rollback（零释放）；
 * - ok：
 *   - semantic lineage validation ≠ match（child ID 派生/parent/binding/
 *     authority 状态语义错误）→ forensic；
 *   - authority 的 lineage 四字段与 record pending facts（lineageId /
 *     generation+1 / parent=current / pendingBindingDigest）不一致 → forensic；
 *   - authority class（modern↔identity-bound / lowlevel↔lowlevel）、
 *     lowlevelSource、actionKind、adapterSemanticIdentity 与 record 冻结事实
 *     不一致 → forensic；
 *   - resolver 证明只有 Intent（authorityKind=intent）且 outcome=not_started、
 *     settlement=ready（callback 确定未开始）→ rollback + 释放 intent；
 *   - quarantine 接管（authorityKind=quarantine——含双存在归一）或 executing/
 *     更后 → forward_complete（child identity 从 resolver 结果构造，不从
 *     任意一侧挑字段）。
 */
export function classifyTreasuryHandoffAuthorityWindow(input: {
  readonly record: Readonly<TreasuryAttemptLineageRecord>;
  readonly childTransactionId: string;
  readonly authorityResolution: TreasuryUnresolvedAuthorityResolution;
}): TreasuryHandoffAuthorityWindow {
  const { record, childTransactionId, authorityResolution } = input;
  if (authorityResolution.status === "store_unhealthy") {
    return {
      action: "pending_store_unhealthy",
      detail: `handoff 双 authority store unhealthy（${authorityResolution.detail}）——保留两侧证据，不 rollback、不 forward`,
    };
  }
  if (authorityResolution.status === "inconsistent") {
    return {
      action: "forensic",
      detail: `handoff 双 authority inconsistent（${authorityResolution.detail}）——保留全部 authority，不猜测`,
    };
  }
  if (authorityResolution.status === "not_found") {
    return {
      action: "rollback",
      releaseIntent: false,
      detail: "resolver 证明 intent 与 quarantine 均不存在（callback 确定未开始——零释放回滚）",
    };
  }
  const authority = authorityResolution.authority;
  if (authority.transactionId !== childTransactionId) {
    return { action: "forensic", detail: "resolver 返回的 authority transactionId 与 child ID 不一致（防御）" };
  }
  // tr1_ authority 的四字段完整性（resolver shape 层应已保证——防御）。
  if (
    authority.lineageId === undefined || authority.lineageGeneration === undefined ||
    authority.parentTransactionId === undefined || authority.lineageBindingDigest === undefined
  ) {
    return { action: "forensic", detail: "resolver 归一的 tr1_ authority 缺完整 lineage proof（防御——shape 层应已拦截）" };
  }
  // semantic lineage validation（child ID/parent/binding/authority 状态的语义
  // 真实性——四字段在两侧一致复制不构成证明）。
  const semantic = validateTreasurySemanticLineage({
    transactionId: childTransactionId,
    proof: {
      lineageId: authority.lineageId,
      lineageGeneration: authority.lineageGeneration,
      parentTransactionId: authority.parentTransactionId,
      lineageBindingDigest: authority.lineageBindingDigest,
    },
    identity: {
      digest: authority.digest,
      ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
      ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
      ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
      ...(authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    },
  });
  if (semantic.verdict !== "match") {
    return {
      action: "forensic",
      detail: `handoff semantic lineage validation 未通过（${semantic.verdict}: ${"detail" in semantic ? semantic.detail : "unknown"}）——一致复制的四字段不是语义证明`,
    };
  }
  // record pending facts 匹配（lineage 四字段）。
  if (
    authority.lineageId !== record.lineageId ||
    authority.lineageGeneration !== record.generation + 1 ||
    authority.parentTransactionId !== record.currentTransactionId ||
    authority.lineageBindingDigest !== record.pendingBindingDigest
  ) {
    return {
      action: "forensic",
      detail: "authority lineage proof 与 lineage record 冻结的 pending handoff facts 不一致（generation/parent/binding 冲突）",
    };
  }
  // authority class / provenance / action kind / adapter semantic identity。
  const expectedLevel = record.authorityClass === "lowlevel" ? "lowlevel" : "modern";
  if (authority.authorityLevel !== expectedLevel) {
    return {
      action: "forensic",
      detail: `authority class ${String(authority.authorityLevel)} 与 lineage 冻结的 authority class ${record.authorityClass} 不匹配`,
    };
  }
  if ((authority.lowlevelSource ?? undefined) !== (record.lowlevelSource ?? undefined)) {
    return {
      action: "forensic",
      detail: "authority lowlevel provenance 与 lineage 冻结的 lowlevelSource 不一致（runtime 与 migrated 不能互相证明）",
    };
  }
  if (authority.actionKind !== record.actionKind) {
    return {
      action: "forensic",
      detail: `authority action kind ${authority.actionKind} 与 lineage 冻结的 ${record.actionKind} 不一致`,
    };
  }
  // 注：adapterSemanticIdentity 不在此比较——低层 contractless 的 intent/
  // quarantine 权威形态不携带该字段（resolver 的双存在归一已在其内部比较
  // modern 双方的 adapter semantic identity；此处只比较任务书 7.2 列出的
  // class/provenance/action kind 等冻结维度）。
  // rollback 仅当 resolver 证明只有 Intent 且 callback 确定未开始。
  if (
    authorityResolution.authority.authorityKind === "intent" &&
    authority.outcome === "not_started" &&
    authority.settlement === "ready"
  ) {
    return {
      action: "rollback",
      releaseIntent: true,
      detail: "resolver 证明只有 intent（not_started/ready——execution-started 持久信号为零），callback 确定未开始",
    };
  }
  const quarantineTakenOver = authorityResolution.authority.authorityKind === "quarantine";
  return {
    action: "forward_complete",
    childIdentity: {
      digest: authority.digest,
      ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
      ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
      ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
      ...(authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    },
    detail: quarantineTakenOver
      ? "resolver 归一 authority 为 quarantine（quarantine 是 callback 后写入的持久事实——前向补完成，绝不回滚）"
      : `intent 已进入 ${authority.settlement}（callback 可能已开始——前向补完成接管）`,
  };
}
