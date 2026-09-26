/**
 * Treasury Core Kernel——效果覆盖判定（共享纯能力，Remediation II/R1/§3.1）。
 *
 * 统一三处此前各自演化的锚点选择实现（occupancy 占用投影、beginTick
 * committed 清理门、commands 的观察接管转移）为同一份判定：
 *
 * 两层条件（§3.1）：
 * 1. 先有受控的确定执行结论（closing + committed——调用方负责阶段前提）；
 * 2. 再验证该效果与适用可信观察的时间先后关系。
 *
 * 锚点链：invocation（实际调用）→ external（外部接口接受，晚到 reconcile
 * 的正面事实；无世界序——保守 tick 边界）→ invocationBoundary（调用边界，
 * "调用已获准进入，此后可能发生"——不是 executed 证据，只是效果可能发生
 * 的下界时点）。三者皆缺 → 无锚点（保守：不判覆盖）。
 *
 * 时间序：观察构建世界序 > 锚点世界序 → 效果已进入该观察（同步生效模型：
 * 观察构建于效果之后，必含效果）。世界序缺失（旧记录/external 锚点）时
 * 回退 tick 严格大于（同 tick 观察不判覆盖——保守）。观察上下文缺失或
 * 无可比事实 → 不判覆盖（保守占用/保留）。
 */

import type { TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";

/** 效果时点锚点（atTick 必有；worldSequence 可缺——external 锚点与旧记录）。 */
export interface TreasuryCoreCoverageAnchor {
  readonly atTick: number;
  readonly worldSequence?: number;
}

/** 观察侧时间事实（worldSequence 可缺——旧观察/未提供）。 */
export interface TreasuryCoreObservationTimeFact {
  readonly atTick?: number;
  readonly worldSequence?: number;
}

/**
 * 效果覆盖锚点（invocation → external → invocationBoundary 链，§4.2）。
 * 返回 null = 无任何调用侧事实（保守：不判覆盖）。
 */
export function treasuryCoreCoverageAnchorOf(record: TreasuryCoreWorkRecord): TreasuryCoreCoverageAnchor | null {
  if (record.invocation !== null) {
    return { atTick: record.invocation.atTick, worldSequence: record.invocation.worldSequence };
  }
  if (record.external !== null) {
    // external 无受控世界序（外部接口时间不可与世界序对齐）——tick 边界保守。
    return { atTick: record.external.atTick };
  }
  if (record.invocationBoundary !== null) {
    return { atTick: record.invocationBoundary.atTick, worldSequence: record.invocationBoundary.worldSequence };
  }
  return null;
}

/**
 * 观察时间序是否已越过锚点（覆盖的时间先后条件）。
 * - 双方世界序齐备：观察序 > 锚点序 → true；
 * - 任一侧缺世界序：回退观察 atTick 严格大于锚点 atTick；
 * - 无可比事实（缺观察上下文）：返回 null（保守——调用方按未覆盖处理）。
 */
export function treasuryCoreObservationAdvancesPastAnchor(
  anchor: TreasuryCoreCoverageAnchor,
  observation: TreasuryCoreObservationTimeFact,
): boolean | null {
  if (observation.worldSequence !== undefined && anchor.worldSequence !== undefined) {
    return observation.worldSequence > anchor.worldSequence;
  }
  if (observation.atTick === undefined) return null;
  return observation.atTick > anchor.atTick;
}
