/**
 * Treasury Core Kernel——资源占用投影（从活跃聚合单一权威派生）。
 *
 * 占用规则（design II §5.2，Core Rewrite II 修正）：
 * - pending / dispatching / outcome_unknown：保持 worst-case 全额占用
 *  （未确认的不能花、可能已发出的不能释放）。占用含两个投影：
 *  流出（max(0, −delta)，占用存量可花费额）与流入（max(0, +delta)，
 *  占用接收容量——unknown 的可能流入不成可花费资产，只占接收空间）。
 * - closing（committed 或 not_executed）：不占用。已确认效果的表达转交：
 *  同一 tick 由 facade applied overlay（世界效果已发生、观察快照 stale），
 *  跨 tick 由刷新后的观察承担——同一责任唯一扣减归属，不双扣（B09）。
 * - closing(not_executed) / retry_ready：确定未流出，不占用。
 * - 占用是活跃集合成员资格的投影——不存在第二份 attempt authority，
 *  也不存在“清理完成改一个 done 标签就提前释放”的路径。
 */

import type { TreasuryCoreMemory, TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";

/**
 * 一条聚合是否持有资源占用。
 *
 * closing 的区分（design II §5.2）：
 * - closing(committed, adapter_execution_semantics)：dispatch 时刻确认的
 *   效果已由本 tick applied overlay 表达（跨 tick 由刷新观察表达）——
 *   不占用（同一责任唯一扣减归属，不双扣）。
 * - closing(committed, adapter_reconcile)：对账确认的效果发生时刻不确定
 *   （观察边界不明）——保守保持占用，直到聚合退出（§3：未能证明具体
 *   效果已进入观察时可保守扣留）。
 */
export function treasuryCoreWorkHoldsOccupancy(record: TreasuryCoreWorkRecord): boolean {
  switch (record.phase) {
    case "pending":
    case "dispatching":
    case "outcome_unknown":
      return true;
    case "closing":
      if (record.outcome !== "committed") return false;
      return record.outcomeEvidence?.kind === "adapter_reconcile";
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

export function computeTreasuryCoreOccupancy(memory: TreasuryCoreMemory): TreasuryCoreOccupancyTotals {
  const byKey = new Map<string, number>();
  const inflowByLocation = new Map<string, number>();
  let holdingWorkCount = 0;
  for (const record of Object.values(memory.active)) {
    if (!treasuryCoreWorkHoldsOccupancy(record)) continue;
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
): number {
  let total = 0;
  for (const record of Object.values(memory.active)) {
    if (!treasuryCoreWorkHoldsOccupancy(record)) continue;
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
): number {
  let total = 0;
  for (const record of Object.values(memory.active)) {
    if (!treasuryCoreWorkHoldsOccupancy(record)) continue;
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
