/**
 * Outcome / settlement / phase 语义矩阵权威（第十一轮 3.13.6）。
 *
 * 单一矩阵：每 execution outcome 的合法 settlement 集合、quarantine fault
 * phase 与 outcome 的强制映射（本模块零依赖——phase 推导值由调用方传入，
 * cross-store finalized proof 由 facade 层组合 receipts/resolutionStore
 * 实现）。非法组合 → store unhealthy（fatal fail closed）→ authority 不可
 * 签发、resolution 拒绝、write readiness=false；returned_ok 永不通过损坏
 * 数据或错误组合退化为可 not-executed；proof 缺失不得自动删除或直接释放。
 *
 * 校验接入点：progressTreasuryIntent 的目标组合、intent/quarantine load
 * 全量验证、beginTick 恢复的 finalized proof 检查。
 */

/**
 * intent 语义矩阵：outcome → 合法 settlement 集合。
 * - not_started ∈ {ready, finalized}（写后短暂 ready / 确认未执行关闭；
 *   pre-execution authorization fault 在专用 authorizationFaults store，
 *   intent 侧的 not_started+faulted/pending_* 属非法组合）；
 * - started_unknown ∈ {executing, faulted, quarantined, resolving, finalized}；
 * - returned_non_ok ∈ {pending_abort, faulted, quarantined, resolving, finalized}；
 * - returned_ok ∈ {pending_commit, faulted, quarantined, resolving, finalized}；
 * - aborted_final 仅 legacy 终态 {finalized}（不得参与新写路径）。
 */
export const TREASURY_INTENT_SEMANTIC_MATRIX: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  not_started: new Set(["ready", "finalized"]),
  started_unknown: new Set(["executing", "faulted", "quarantined", "resolving", "finalized"]),
  returned_non_ok: new Set(["pending_abort", "faulted", "quarantined", "resolving", "finalized"]),
  returned_ok: new Set(["pending_commit", "faulted", "quarantined", "resolving", "finalized"]),
  aborted_final: new Set(["finalized"]),
});

/** intent (outcome, settlement) 组合校验（null = 合法，否则违规描述）。 */
export function intentSemanticViolation(outcome: string, settlement: string): string | null {
  const allowed = TREASURY_INTENT_SEMANTIC_MATRIX[outcome];
  if (allowed === undefined) {
    return `未知 outcome: ${String(outcome).slice(0, 32)}`;
  }
  if (!allowed.has(settlement)) {
    return `非法 outcome/settlement 组合（outcome ${String(outcome)} 不得处于 settlement ${String(settlement)}）`;
  }
  return null;
}

/**
 * quarantine (phase, outcome) 组合校验：outcome 必须等于 phase 的单调推导
 * 值（derived 由调用方以 outcomeOfTreasuryFaultPhase 计算），或保留更高
 * 事实等级（returned_ok/returned_non_ok 事实不因 executing_at_end_tick
 * 类 phase 降级——第十轮事实单调性的矩阵化表达）。null = 合法。
 */
export function quarantineSemanticViolation(derived: string | null, outcome: string): string | null {
  if (derived === null) {
    return `未知 fault phase（outcome 推导失败），实际 outcome ${String(outcome).slice(0, 32)}`;
  }
  if (outcome === derived) return null;
  if (outcome === "returned_ok" && derived === "started_unknown") return null;
  if (outcome === "returned_non_ok" && derived === "started_unknown") return null;
  return `非法 phase/outcome 组合（phase 单调推导 outcome ${derived}，实际 ${String(outcome)}）`;
}
