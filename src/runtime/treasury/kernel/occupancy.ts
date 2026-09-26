/**
 * Treasury Core Kernel——资源占用投影（从活跃聚合单一权威派生）。
 *
 * 占用规则（design III §6.1，Core Rewrite III 观察接管闭环）：
 * - pending / dispatching / outcome_unknown：保持 worst-case 全额占用
 *  （未确认的不能花、可能已发出的不能释放）。占用含两个投影：
 *  流出（max(0, −delta)，占用存量可花费额）与流入（max(0, +delta)，
 *  占用接收容量——unknown 的可能流入不成可花费资产，只占接收空间）。
 * - closing(committed)：**效果被当前可信观察覆盖前继续占用**。覆盖判定
 *  与 commands/kernel 清理门共用同一共享锚点链与时间序（coverage.ts：
 *  invocation → external → invocationBoundary；世界序优先、tick 严格大于
 *  兜底；观察上下文缺失或不可比 → 保守占用）。覆盖成立 → 同一效果已进入
 *  该观察，不再重复扣减——**记录保留与占用投影分离**（§3.2：仍有外部
 *  义务或未获清理预算的记录继续留在 active，但其已覆盖效果不占额度）。
 * - closing(not_executed / pending_cancellation) / retry_ready：确定未
 *  流出，不占用。
 * - 占用是活跃集合成员资格的投影——实例本地 overlay 只是可重建缓存，
 *  不是已确认效果的安全载体（R5：多实例/完整 reset 不产生责任空窗）。
 */

import type {
  TreasuryCoreMemory,
  TreasuryCoreOccupancyOptions,
  TreasuryCoreWorkRecord,
} from "@/runtime/treasury/kernel/types";
import { treasuryCoreCoverageAnchorOf, treasuryCoreObservationAdvancesPastAnchor } from "@/runtime/treasury/kernel/coverage";

/**
 * 一条聚合是否持有资源占用（options 详见 TreasuryCoreOccupancyOptions）。
 */
export function treasuryCoreWorkHoldsOccupancy(
  record: TreasuryCoreWorkRecord,
  options: TreasuryCoreOccupancyOptions = {},
): boolean {
  if (options.excludeAttemptId !== undefined && record.attemptId === options.excludeAttemptId) {
    return false;
  }
  switch (record.phase) {
    case "pending":
    case "dispatching":
    case "outcome_unknown":
      return true;
    case "closing":
      if (record.outcome !== "committed") return false;
      // 覆盖判定（Remediation II/R1/§3.1——统一共享锚点链 invocation →
      // external → invocationBoundary）：确定执行结论 + 观察已越过锚点 →
      // 效果已进入该观察，不再重复扣减（记录保留与占用投影分离——§3.2）。
      // 结果写回前中断、经 exact 对账 committed 的记录只有 invocationBoundary
      // （正常恢复状态，不是"结构上不应发生"）——观察越过边界序即覆盖。
      const anchor = treasuryCoreCoverageAnchorOf(record);
      if (anchor === null) return true; // 无任何调用侧事实：保守占用
      const covered = treasuryCoreObservationAdvancesPastAnchor(anchor, {
        worldSequence: options.observationWorldSequence,
        atTick: options.observationAsOfTick,
      });
      return covered !== true; // 无观察上下文/不可比/未越过 → 保守占用
    case "retry_ready":
      return false;
  }
}

export interface TreasuryCoreOccupancyTotals {
  /** per `room\0location\0resource` 的最坏流出占用合计。 */
  readonly byKey: ReadonlyMap<string, number>;
  /** per `room\0location` 的最坏流入占用合计（接收容量口径）。 */
  readonly inflowByLocation: ReadonlyMap<string, number>;
  readonly holdingWorkCount: number;
}

function locationKeyOf(roomName: string, locationKind: string): string {
  return `${roomName}\u0000${locationKind}`;
}

export function computeTreasuryCoreOccupancy(
  memory: TreasuryCoreMemory,
  options: TreasuryCoreOccupancyOptions = {},
): TreasuryCoreOccupancyTotals {
  const byKey = new Map<string, number>();
  const inflowByLocation = new Map<string, number>();
  let holdingWorkCount = 0;
  for (const record of Object.values(memory.active)) {
    if (!treasuryCoreWorkHoldsOccupancy(record, options)) continue;
    holdingWorkCount += 1;
    for (const leg of record.worstCase) {
      const key = `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
      const outflow = Math.max(0, -leg.delta);
      if (outflow > 0) byKey.set(key, (byKey.get(key) ?? 0) + outflow);
      const inflow = Math.max(0, leg.delta);
      if (inflow > 0) {
        const locKey = locationKeyOf(leg.roomName, leg.locationKind);
        inflowByLocation.set(locKey, (inflowByLocation.get(locKey) ?? 0) + inflow);
      }
    }
  }
  return { byKey, inflowByLocation, holdingWorkCount };
}

/** 指定 (room, location, resource) 的当前流出占用。 */
export function treasuryCoreOccupancyAt(
  memory: TreasuryCoreMemory,
  roomName: string,
  locationKind: string,
  resource: string,
  options: TreasuryCoreOccupancyOptions = {},
): number {
  let total = 0;
  for (const record of Object.values(memory.active)) {
    if (!treasuryCoreWorkHoldsOccupancy(record, options)) continue;
    for (const leg of record.worstCase) {
      if (leg.roomName === roomName && leg.locationKind === locationKind && leg.resource === resource) {
        total += Math.max(0, -leg.delta);
      }
    }
  }
  return total;
}

/** 指定 (room, location) 的当前流入占用（接收容量口径）。 */
export function treasuryCoreInflowOccupancyAt(
  memory: TreasuryCoreMemory,
  roomName: string,
  locationKind: string,
  options: TreasuryCoreOccupancyOptions = {},
): number {
  let total = 0;
  for (const record of Object.values(memory.active)) {
    if (!treasuryCoreWorkHoldsOccupancy(record, options)) continue;
    for (const leg of record.worstCase) {
      if (leg.roomName === roomName && leg.locationKind === locationKind) {
        total += Math.max(0, leg.delta);
      }
    }
  }
  return total;
}

/** 活跃聚合快照（只读视图；供 facade 容量口径与 metrics 使用）。 */
export function listTreasuryCoreActiveWorks(memory: TreasuryCoreMemory): readonly TreasuryCoreWorkRecord[] {
  return Object.values(memory.active).slice().sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1));
}
