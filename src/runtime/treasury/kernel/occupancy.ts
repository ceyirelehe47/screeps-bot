/**
 * Treasury Core Kernel——资源占用投影（从活跃聚合单一权威派生）。
 *
 * 占用规则（design III §6.1，Core Rewrite III 观察接管闭环）：
 * - pending / dispatching / outcome_unknown：保持 worst-case 全额占用
 *  （未确认的不能花、可能已发出的不能释放）。占用含两个投影：
 *  流出（max(0, −delta)，占用存量可花费额）与流入（max(0, +delta)，
 *  占用接收容量——unknown 的可能流入不成可花费资产，只占接收空间）。
 * - closing(committed)：**效果被当前授权观察接管前继续占用**。覆盖判定
 *  优先用受控世界序（epoch.worldSequence vs invocation.worldSequence——
 *  同步生效模型下 fresh 观察包含本 tick 已发生效果，不与占用双扣）；
 *  世界序缺失时回退 tick 边界（observedAtTick vs invocation.atTick）：
 *    观察序未超过效果锚点 → 该观察不可能包含此效果 → 占用（保守）。
 *  该规则天然涵盖同 tick execution_semantics（未覆盖）与晚到 reconcile
 *  （invocation 时刻久远、观察已新 → 已覆盖）。无观察上下文
 *  （observationAsOfTick 未提供）时保守占用。
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
      if (record.invocation === null) return true; // 结构上不应发生；保守占用
      // 世界序判定（§6.2）：观察构建序 > 调用边界世界序 → 受控世界已在
      // 调用后真实更新且该观察构建于其后 → 效果已进入该观察。
      if (options.observationWorldSequence !== undefined && record.invocation.worldSequence !== undefined) {
        return !(options.observationWorldSequence > record.invocation.worldSequence);
      }
      if (options.observationAsOfTick === undefined) return true; // 无观察上下文：保守
      // tick 边界兜底（旧记录/世界序缺失）：观察 asOfTick ≤ 效果时点 →
      // 效果尚未被该观察覆盖 → 原聚合继续承担。
      return options.observationAsOfTick <= record.invocation.atTick;
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
