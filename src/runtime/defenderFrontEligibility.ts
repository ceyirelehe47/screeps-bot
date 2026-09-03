/**
 * 【Round 22 Remediation IV 十三】defender front eligibility——Tower 与
 * Defender 的 target eligibility 单一语义源。
 *
 * Remediation III 的 planner 把全部 homeDefender 放进同一全房间 actor 池：
 * 多 front 时 Defender 可能被房间级 primary 拉到其它 front（跨 front 迁移），
 * kill feasibility 也可能计入其它 front 的 Defender 虚构本 tick 击杀能力。
 *
 * 本模块定义默认 eligibility：
 *  - Tower：房间内任意合法 hostile（火力调度是房间级的）；
 *  - Defender：默认只对其 assigned front 的 hostile 可用（eligible 集合 =
 *    front 的 hostile ID 集合）；未分配 front 的 Defender 采用明确保守行为
 *    （room-scope：无法确定其 front 归属时不剥夺其既有的全房间防御语义，
 *    但不标记为可增援——不参与跨 front 语义）；
 *  - 跨 front 增援只允许既有协调系统显式标记（reinforcementAllowed）。
 *
 * planner / fallback revision / 采集层共用同一集合判定（预计算——内层不
 * 重复扫描 front）。
 */

/** Defender 的 front eligibility 事实（采集层一次计算，planner 只读集合）。 */
export interface DefenderFrontEligibility {
  /** assigned front ID（未分配 = undefined——room-scope 保守默认）。 */
  readonly frontId?: string;
  /** 该 Defender 允许处理的 hostile ID 集合（含跨 front 增援时的并集）。 */
  readonly eligibleHostileIds: ReadonlySet<string>;
  /** 是否被既有协调系统显式标记为可跨 front 增援。 */
  readonly reinforcementAllowed: boolean;
}

/**
 * 构造 Defender 的 eligibility：assigned front 存在 → front 集合；
 * front 不存在（未分配/已失效）→ room 全量集合（room-scope 保守默认——
 * 不剥夺既有防御语义，也不虚构增援标记）。reinforcementAllowed=true 时
 * 集合为 room 全量（显式增援语义）。
 */
export function defenderFrontEligibilityOf(input: {
  readonly frontId?: string;
  readonly frontHostileIds?: readonly string[];
  readonly roomHostileIds: readonly string[];
  readonly reinforcementAllowed?: boolean;
}): DefenderFrontEligibility {
  const reinforcementAllowed = input.reinforcementAllowed === true;
  if (reinforcementAllowed || input.frontId === undefined || input.frontHostileIds === undefined) {
    return {
      ...(input.frontId !== undefined ? { frontId: input.frontId } : {}),
      eligibleHostileIds: new Set(input.roomHostileIds),
      reinforcementAllowed,
    };
  }
  return {
    frontId: input.frontId,
    eligibleHostileIds: new Set(input.frontHostileIds),
    reinforcementAllowed,
  };
}

/** actor（tower/defender）对目标是否 eligible（集合判定——O(1)）。 */
export function isHostileEligibleForActor(
  eligibility: { readonly eligibleHostileIds: ReadonlySet<string> } | undefined,
  hostileId: string,
): boolean {
  if (eligibility === undefined) return true;
  return eligibility.eligibleHostileIds.has(hostileId);
}
