import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { isDefenseMode } from "@/runtime/defenseMode";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { type CreepConfig } from "@/types/system";
import { type WarTask } from "./store";
import { type OutboundMissionOwner } from "@/runtime/outboundMissionRegistry";
import { hasAcceptedSpawn } from "@/runtime/spawnRequests";

/** 只认任务所有者和当前代，旧代/同目标的孤立配置不能借用在途豁免。 */
function ownsWarConfig(task: WarTask, name: string, config: CreepConfig): boolean {
  if (config.roomName !== task.sourceRoom || config.args[0] !== task.targetRoom) return false;
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  if (config.role === "claimer") return false;
  if (config.role !== "meleeAttacker" && config.role !== "healer") return false;
  if (task.activeGeneration) return name === task.activeGeneration.configNames[config.role];
  return name.startsWith(`${prefix}${config.role}:`) && /^\d+$/.test(name.slice(`${prefix}${config.role}:`.length));
}

/** status 可在首个 Spawn 前进入 clearing；必须另有已投入的排队、强化或出生证据。 */
export function canContinueWarMission(task: WarTask): boolean {
  if (isDefenseMode(task.sourceRoom) || Memory.data?.war?.[task.targetRoom] !== task ||
      !["staging", "clearing", "downgrading", "patrol_waiting"].includes(task.status)) return false;
  const reserve = isRoomInReserveMode(task.sourceRoom);
  if (!reserve) delete task.reserveContinuationUntil;
  if (reserve && task.reserveContinuationUntil !== undefined && Game.time >= task.reserveContinuationUntil) return false;
  const committed = (): true => {
    if (reserve) task.reserveContinuationUntil ??= Game.time + CREEP_LIFE_TIME;
    return true;
  };
  const generation = task.activeGeneration;
  if (generation?.boostGateOpenedAt !== undefined && generation.phase === "assembling") return committed();
  const service = getCreepConfigService();
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  const candidates = generation ? Object.values(generation.configNames) : [`${prefix}meleeAttacker:0`, `${prefix}meleeAttacker:1`, `${prefix}healer:0`];
  const names = new Set(candidates.filter(name => generation || service.get(name) && ownsWarConfig(task, name, service.get(name)!)));
  if (generation) for (const name of Object.values(generation.configNames)) names.add(name);
  else for (const member of Object.values(task.members ?? {})) {
    const config = service.get(member.configName);
    if (config && ownsWarConfig(task, member.configName, config)) names.add(member.configName);
  }
  const context = getTickContextService();
  if ([...names].some(name => context.getCreepsByConfigName(name).some(creep =>
    !creep.memory._warDetached && creep.memory.configName === name))) return committed();
  const sourceSpawns = context.getSpawnsByRoom(task.sourceRoom);
  const sourceNames = new Set(sourceSpawns.map(spawn => spawn.name));
  const pending = [...names].some(name => hasAcceptedSpawn(name, sourceNames)) || sourceSpawns.some(spawn =>
    ((spawn.memory.spawnList ?? []).some(name => names.has(name)) ||
      !!spawn.spawning && names.has(Memory.creeps?.[spawn.spawning.name]?.configName ?? "")));
  return pending ? committed() : false;
}

export const warMissionOwner: OutboundMissionOwner = {
  id: "war",
  matches: name => name.includes(":war:"),
  evaluate(name, config, mode) {
    const task = Memory.data?.war?.[config.args[0]];
    if (!mode.reserve && task && task.sourceRoom === config.roomName) delete task.reserveContinuationUntil;
    if (!mode.reserve || mode.defense) return { intent: "expedition", committed: false };
    if (name === `${config.roomName}:war:${config.args[0]}:controllerAttacker:0` && config.role === "claimer" && config.args[2] === "attack") {
      const active = task && task.sourceRoom === config.roomName && ["staging", "clearing", "downgrading", "patrol_waiting"].includes(task.status);
      const spawns = getTickContextService().getSpawnsByRoom(config.roomName!);
      const committed = !!active && (hasAcceptedSpawn(name, new Set(spawns.map(spawn => spawn.name))) || spawns.some(spawn =>
        (spawn.memory.spawnList ?? []).includes(name) || !!spawn.spawning && Memory.creeps?.[spawn.spawning.name]?.configName === name));
      return { intent: "expedition", committed };
    }
    return { intent: "expedition", committed: !!task && ownsWarConfig(task, name, config) && canContinueWarMission(task) };
  },
};
