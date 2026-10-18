import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

export const POWER_CREEP_OPS_SUPPLY_REASON = "powerCreep:ops";
const OPS_LOW_WATER_PER_CREEP = 500;
const OPS_TARGET_PER_CREEP = 2_000;

export interface PowerCreepOpsRoomPolicy {
  lowWater: number;
  target: number;
  carried: number;
}

/** 只统计本 shard 已出生、拥有耗 OPS 技能的 PC；不改变其归属或任务。 */
export function collectPowerCreepOpsRoomPolicies(): Map<string, PowerCreepOpsRoomPolicy> {
  const policies = new Map<string, PowerCreepOpsRoomPolicy>();
  for (const pc of Object.values(Game.powerCreeps || {})) {
    if (!Number.isFinite(pc.ticksToLive) || (pc.ticksToLive ?? 0) <= 0 || !pc.room || !pc.pos ||
        (pc.shard && pc.shard !== Game.shard?.name)) continue;
    const consumesOps = Object.entries(pc.powers).some(([power, data]) => {
      const cost = (POWER_INFO[Number(power) as PowerConstant] as { ops?: number | number[] } | undefined)?.ops;
      return data.level > 0 && (Array.isArray(cost) ? (cost[data.level - 1] || 0) : (cost || 0)) > 0;
    });
    if (!consumesOps) continue;
    const homeRoom = pc.memory.homeRoom || pc.name;
    if (!Game.rooms[homeRoom]?.controller?.my) continue;
    const policy = policies.get(homeRoom) || { lowWater: 0, target: 0, carried: 0 };
    policy.lowWater += OPS_LOW_WATER_PER_CREEP;
    policy.target += OPS_TARGET_PER_CREEP;
    policy.carried += pc.store.getUsedCapacity(RESOURCE_OPS);
    policies.set(homeRoom, policy);
  }
  return policies;
}

/** undefined 为普通运输；专用补给失去现役消费者后返回 0，交由执行器取消。 */
export function getPowerCreepOpsShipmentNeed(task: ResourceTransferTask, stock: number): number | undefined {
  if (task.origin !== "automatic" || task.resource !== RESOURCE_OPS || task.reason !== POWER_CREEP_OPS_SUPPLY_REASON) return undefined;
  const policy = collectPowerCreepOpsRoomPolicies().get(task.toRoomName);
  return policy ? Math.max(0, policy.target - policy.carried - stock) : 0;
}
