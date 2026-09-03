/**
 * 【Round 22 Remediation IV 十五】per-defender unique rampart allocation。
 *
 * Remediation III 的接敌位置是 target-level 单一位置（hostile 最近的
 * boundary rampart）：多名 Defender 分配同一 target 时争抢同一格，显式
 * plan 路径也绕过了旧独立路径的 occupied-rampart 去重。
 *
 * 本模块是确定性 stable-greedy 分配器（纯函数、无 Game 写 API、无
 * PathFinder）：
 *  - Defender 按 primary 优先、secondary 随后、slot 字典序决胜稳定排序；
 *  - 每个 Defender 从其 target 的候选 Rampart 集合中选择（未被他属占用、
 *    非 occupied 标记、到目标距离、到 Defender 当前距离、Rampart ID 决胜）；
 *  - 已站在合法候选上的 Defender 保留自己的位置（不被后处理者抢占）；
 *  - 每个 Rampart 最多分配一名 Defender；候选不足时该 Defender 无位置
 *    （调用方按 hold/coverage 语义处理——不追逐边界外 hostile、不重复
 *    分配已占用位置）。
 *
 * 采集层提供候选集合（复用既有 boundary ramparts / occupied 检测 /
 * safe-zone 约束——本模块不建立平行防线模型）。
 */

/** 候选接敌位置（采集层给出：boundary rampart 候选 + 他属占用标记）。 */
export interface DefenderEngagementCandidatePosition {
  /** 稳定 ID（Rampart ID 或位置键）。 */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** 已被其它 my creep 占用（采集层检测——不得重复分配）。 */
  readonly occupied?: boolean;
}

/** 需要 positioning 的 Defender 输入（含排序所需的稳定事实）。 */
export interface DefenderRampartAllocationInput {
  readonly slot: string;
  readonly role: "primary" | "secondary";
  readonly x: number;
  readonly y: number;
  /** 该 Defender 的 combat target（候选集合的键）。 */
  readonly targetId: string;
}

function chebyshev(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

/**
 * per-defender 唯一 Rampart 分配（确定性 stable greedy）。
 * 返回 slot → 分配位置（无合适候选的 Defender 不出现在结果中）。
 */
export function allocateDefenderRampartPositions(input: {
  readonly defenders: readonly DefenderRampartAllocationInput[];
  /** targetId → 候选位置集合（按 front/coverage 语义由采集层提供）。 */
  readonly candidatesByTargetId: Readonly<Record<string, readonly DefenderEngagementCandidatePosition[]>>;
  /** target 的坐标（距离评分用）。 */
  readonly targetPositionById: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
}): Record<string, DefenderEngagementCandidatePosition> {
  const assigned: Record<string, DefenderEngagementCandidatePosition> = {};
  const usedCandidateIds = new Set<string>();
  // 稳定排序：primary 优先 → secondary 随后 → slot 字典序决胜。
  const ordered = [...input.defenders].sort((left, right) => {
    const roleRank = left.role === "primary" ? 0 : 1;
    const otherRoleRank = right.role === "primary" ? 0 : 1;
    if (roleRank !== otherRoleRank) return roleRank - otherRoleRank;
    return left.slot.localeCompare(right.slot);
  });
  for (const defender of ordered) {
    const candidates = input.candidatesByTargetId[defender.targetId] ?? [];
    const targetPosition = input.targetPositionById[defender.targetId];
    if (candidates.length === 0 || targetPosition === undefined) continue;
    let best: DefenderEngagementCandidatePosition | null = null;
    let bestKey: readonly number[] | null = null;
    for (const candidate of candidates) {
      if (candidate.occupied === true) continue;
      const candidateKey = `${candidate.x},${candidate.y}`;
      if (usedCandidateIds.has(candidateKey)) continue;
      // 已站在候选上 → 保留（distance-to-defender = 0 自然最优）。
      const score: readonly number[] = [
        chebyshev(candidate, targetPosition),
        chebyshev(candidate, defender),
      ];
      if (
        best === null ||
        score[0]! < bestKey![0]! ||
        (score[0]! === bestKey![0]! && (score[1]! < bestKey![1]! || (score[1]! === bestKey![1]! && candidate.id.localeCompare(best.id) < 0)))
      ) {
        best = candidate;
        bestKey = score;
      }
    }
    if (best !== null) {
      assigned[defender.slot] = best;
      usedCandidateIds.add(`${best.x},${best.y}`);
    }
  }
  return assigned;
}
