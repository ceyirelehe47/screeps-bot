import { isDefenseMode } from "@/runtime/defenseMode";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import type { CreepConfig } from "@/types/system";
import type { WarTask } from "@/runtime/war/store";

/** 只控制新增昂贵出征，已部署单位与外矿收入继续执行。 */
export function canStartOutboundMission(roomName: string): boolean {
  return !isDefenseMode(roomName) && !isRoomInReserveMode(roomName);
}

/** 只认任务所有者和当前代，旧代/同目标的孤立配置不能借用在途豁免。 */
function ownsWarConfig(task: WarTask, name: string, config: CreepConfig): boolean {
  if (config.roomName !== task.sourceRoom || config.args[0] !== task.targetRoom) return false;
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  if (config.role === "claimer") return name === `${prefix}controllerAttacker:0` && config.args[2] === "attack";
  if (config.role !== "meleeAttacker" && config.role !== "healer") return false;
  if (task.activeGeneration) return name === task.activeGeneration.configNames[config.role];
  return name.startsWith(`${prefix}${config.role}:`) && /^\d+$/.test(name.slice(`${prefix}${config.role}:`.length));
}

/** status 可在首个 Spawn 前进入 clearing；必须另有已投入的排队、强化或出生证据。 */
export function canContinueWarMission(task: WarTask): boolean {
  if (isDefenseMode(task.sourceRoom) || Memory.data?.war?.[task.targetRoom] !== task ||
      !["staging", "clearing", "downgrading", "patrol_waiting"].includes(task.status)) return false;
  const generation = task.activeGeneration;
  if (generation?.boostGateOpenedAt !== undefined || generation?.phase === "deployed") return true;
  const store = Memory.data?.creepConfigs ?? {};
  const names = new Set(Object.entries(store).filter(([name, config]) => ownsWarConfig(task, name, config)).map(([name]) => name));
  if (generation) for (const name of Object.values(generation.configNames)) names.add(name);
  else for (const member of Object.values(task.members ?? {})) {
    if (member.configName.startsWith(`${task.sourceRoom}:war:${task.targetRoom}:`)) names.add(member.configName);
  }
  if ([...names].some(name => task.members?.[name]?.spawnedAt !== undefined || store[name]?.spawnOnce?.queuedAt !== undefined)) return true;
  if (Object.values(Game.creeps).some(creep => !creep.memory._warDetached && names.has(creep.memory.configName ?? ""))) return true;
  return Object.values(Game.spawns).some(spawn => spawn.room.name === task.sourceRoom &&
    ((spawn.memory.spawnList ?? []).some(name => names.has(name)) ||
      !!spawn.spawning && names.has(Memory.creeps?.[spawn.spawning.name]?.configName ?? "")));
}

export function isSpawnConfigEconomicallyBlocked(configName: string, config: CreepConfig): boolean {
  if (!config.roomName) return false;
  const defense = isDefenseMode(config.roomName);
  if (defense && ["colonizerHarvester", "remoteCarrier", "remoteDefender", "scout", "reserver"].includes(config.role)) return true;
  const blocked = !canStartOutboundMission(config.roomName) && (
    configName.includes(":war:") || configName.includes(":colonizationSupport:") ||
    ["powerBankAttacker", "powerBankHealer", "powerBankHauler", "depositHarvester", "claimer", "colonizerWorker", "colonizerUpgrader"].includes(config.role));
  if (!blocked || defense) return blocked;
  // RESERVE 只阻止新出征；已承诺任务继续使用原有生命周期/出生门控。
  if (config.taskId && ["powerBankAttacker", "powerBankHealer", "powerBankHauler"].includes(config.role)) {
    const task = Memory.data?.powerBankHarvest?.[config.taskId];
    if (task?.id === config.taskId && task.sourceRoom === config.roomName && task.targetRoom === config.args[0] &&
        ["preparing_boosts", "spawning", "renewing", "boosting", "travelling", "attacking", "hauling"].includes(task.status)) return false;
  }
  if (configName.includes(":war:")) {
    const task = Memory.data?.war?.[config.args[0]];
    if (task && ownsWarConfig(task, configName, config) && canContinueWarMission(task)) return false;
  }
  if (config.role === "depositHarvester" && config.taskId) {
    const task = Memory.data?.depositHarvest?.[config.taskId];
    if (task?.id === config.taskId && task.sourceRoom === config.roomName && task.status === "spawning" && task.generation === 0 &&
        task.configName === configName && configName === `${task.sourceRoom}:deposit:${task.id}:g0` &&
        config.args.length === 2 && config.args[0] === task.id && config.args[1] === task.sourceRoom) return false;
  }
  return true;
}

export function fixedBodyExceedsCapacity(config: CreepConfig, capacity: number): boolean {
  return !!config.body && (config.body.length > MAX_CREEP_SIZE ||
    config.body.reduce((sum, part) => sum + (BODYPART_COST[part] ?? Infinity), 0) > capacity);
}
