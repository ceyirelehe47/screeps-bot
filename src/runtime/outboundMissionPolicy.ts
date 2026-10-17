import { isDefenseMode } from "@/runtime/defenseMode";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import type { CreepConfig } from "@/types/system";

/** 只控制新增昂贵出征，已部署单位与外矿收入继续执行。 */
export function canStartOutboundMission(roomName: string): boolean {
  return !isDefenseMode(roomName) && !isRoomInReserveMode(roomName);
}

export function isSpawnConfigEconomicallyBlocked(configName: string, config: CreepConfig): boolean {
  if (!config.roomName) return false;
  if (isDefenseMode(config.roomName) && ["colonizerHarvester", "remoteCarrier", "remoteDefender", "scout", "reserver"].includes(config.role)) return true;
  // RESERVE 只阻止启动新 PB；已承诺任务仍需补齐搭档和运输队，否则白耗已孵化单位。
  if (!isDefenseMode(config.roomName) && config.taskId &&
      ["powerBankAttacker", "powerBankHealer", "powerBankHauler"].includes(config.role)) {
    const task = Memory.data?.powerBankHarvest?.[config.taskId];
    if (task?.id === config.taskId && task.sourceRoom === config.roomName && task.targetRoom === config.args[0] &&
        ["preparing_boosts", "spawning", "renewing", "boosting", "travelling", "attacking", "hauling"].includes(task.status)) return false;
  }
  return !canStartOutboundMission(config.roomName) && (
    configName.includes(":war:") || configName.includes(":colonizationSupport:") ||
    ["powerBankAttacker", "powerBankHealer", "powerBankHauler", "depositHarvester", "claimer", "colonizerWorker", "colonizerUpgrader"].includes(config.role));
}

export function fixedBodyExceedsCapacity(config: CreepConfig, capacity: number): boolean {
  return !!config.body && (config.body.length > MAX_CREEP_SIZE ||
    config.body.reduce((sum, part) => sum + (BODYPART_COST[part] ?? Infinity), 0) > capacity);
}
