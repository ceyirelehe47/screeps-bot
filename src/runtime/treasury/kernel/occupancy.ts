/**
 * Treasury Core Kernel——资源占用投影（从活跃聚合单一权威派生）。
 *
 * 占用规则（design §6.2）：
 * - pending / dispatching / outcome_unknown / closing(committed)：保持
 *   worst-case 全额占用（未确认的不能花、可能已发出的不能释放、已发出
 *   的要等世界观察刷新后随聚合退出）。
 * - closing(not_executed) / retry_ready：确定未流出，不占用。
 * - 占用是活跃集合成员资格的投影——不存在第二份 attempt authority，
 *   也不存在“清理完成改一个 done 标签就提前释放”的路径。
 */

import type { TreasuryCoreMemory, TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";

/** 一条聚合是否持有资源占用。 */
export function treasuryCoreWorkHoldsOccupancy(record: TreasuryCoreWorkRecord): boolean {
  switch (record.phase) {
    case "pending":
    case "dispatching":
    case "outcome_unknown":
      return true;
    case "closing":
      return record.outcome === "committed";
    case "retry_ready":
      return false;
  }
}

export interface TreasuryCoreOccupancyTotals {
  /** per `room\0location\0resource` 的占用合计（与旧口径 key 兼容）。 */
  readonly byKey: ReadonlyMap<string, number>;
  readonly holdingWorkCount: number;
}

export function computeTreasuryCoreOccupancy(memory: TreasuryCoreMemory): TreasuryCoreOccupancyTotals {
  const byKey = new Map<string, number>();
  let holdingWorkCount = 0;
  for (const record of Object.values(memory.active)) {
    if (!treasuryCoreWorkHoldsOccupancy(record)) continue;
    holdingWorkCount += 1;
    for (const leg of record.worstCase) {
      const key = `${leg.roomName}\0${leg.locationKind}\0${leg.resource}`;
      byKey.set(key, (byKey.get(key) ?? 0) + Math.max(0, -leg.delta));
    }
  }
  return { byKey, holdingWorkCount };
}

/** 指定 (room, location, resource) 的当前占用。 */
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

/** 活跃聚合快照（只读视图；供 facade 容量口径与 metrics 使用）。 */
export function listTreasuryCoreActiveWorks(memory: TreasuryCoreMemory): readonly TreasuryCoreWorkRecord[] {
  return Object.values(memory.active).slice().sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1));
}
