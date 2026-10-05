import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import { isDefenseMode } from "@/runtime/defenseMode";
import type { CreepConfig } from "@/types/system";

export const COLONIZATION_SUPPORT_BODY: BodyPartConstant[] = [
  ...Array(15).fill(WORK), ...Array(5).fill(CARRY), ...Array(15).fill(MOVE),
];
const ROOM_NAME = /^[WE]\d+[NS]\d+$/;
export type ColonizationSupportPolicy = NonNullable<NonNullable<Memory["cfg"]>["colonizationSupport"]>[string];

export function readColonizationSupportPolicy(targetRoom: string): ColonizationSupportPolicy | undefined {
  const policy = Memory.cfg?.colonizationSupport?.[targetRoom];
  if (policy?.enabled !== true || !ROOM_NAME.test(targetRoom) || !ROOM_NAME.test(policy.sourceRoom) || policy.sourceRoom === targetRoom) return undefined;
  return policy;
}

export function supportConfigName(sourceRoom: string, targetRoom: string): string {
  return `${sourceRoom}:colonizationSupport:${targetRoom}:worker:0`;
}

export function supportIsComplete(targetRoom: string, sourceRoom: string): boolean {
  const policy = readColonizationSupportPolicy(targetRoom);
  if (!policy || policy.sourceRoom !== sourceRoom) return true;
  const runId = policy.runId ?? `${sourceRoom}:${targetRoom}:rcl6`;
  const state = Memory.runtime?.colonizationSupport?.[targetRoom];
  return (state?.runId === runId && state.status === "complete") ||
    (!!Game.rooms[targetRoom]?.controller?.my && Game.rooms[targetRoom].controller!.level >= 6);
}

/** 此许可只忽略已指定过境房的被动所有权；当前战斗能力仍阻止通行。 */
export function canUseColonizationTransit(sourceRoom: string, targetRoom: string, roomName: string): boolean {
  const policy = readColonizationSupportPolicy(targetRoom);
  if (policy?.sourceRoom !== sourceRoom || !policy?.allowedTransitRooms?.includes(roomName)) return false;
  const room = Game.rooms[roomName];
  if (!room) return true;
  const context = getTickContextService().getRoomContext(room)!;
  if (context.getHostilePowerCreeps().length > 0) return false;
  if (context.getHostileCreeps().some(creep => typeof creep.getActiveBodyparts !== "function" || creep.getActiveBodyparts(ATTACK) > 0 ||
      creep.getActiveBodyparts(RANGED_ATTACK) > 0 || creep.getActiveBodyparts(HEAL) > 0)) return false;
  return !context.getHostileStructures().some(structure => structure.structureType === STRUCTURE_TOWER &&
    (structure as StructureTower).store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST);
}

export function colonizationTransitKey(sourceRoom: string, targetRoom: string): string {
  const policy = readColonizationSupportPolicy(targetRoom);
  return policy?.sourceRoom === sourceRoom ? [...new Set(policy.allowedTransitRooms ?? [])].sort().join("|") : "";
}

function stopConfig(configName: string, sourceRoom: string, boostOwner: string): void {
  const service = getTickContextService();
  for (const spawn of service.getSpawnsByRoom(sourceRoom)) {
    if (spawn.memory.spawnList?.includes(configName)) spawn.memory.spawnList = spawn.memory.spawnList.filter(name => name !== configName);
  }
  const configs = getMemoryService().getCreepConfigStore();
  if (configs[configName]) delete configs[configName].roomName;
  releaseBoostLabs(boostOwner, sourceRoom);
  const spawning = service.getSpawnsByRoom(sourceRoom).some(spawn => spawn.spawning &&
    Memory.creeps?.[spawn.spawning.name]?.configName === configName);
  if (!spawning && service.getCreepsByConfigName(configName).length === 0) delete configs[configName];
}

/** 在 flagControl 内维持独立支援，不依赖 RCL3 后被移除的殖民旗。 */
export function runColonizationSupport(): void {
  const memory = getMemoryService();
  const policies = Memory.cfg?.colonizationSupport;
  if (!policies) return;
  const configs = memory.getCreepConfigStore();
  const states = memory.ensureRuntime().colonizationSupport ??= {};
  const service = getTickContextService();
  for (const [targetRoom, raw] of Object.entries(policies)) {
    if (!ROOM_NAME.test(targetRoom) || !raw || !ROOM_NAME.test(raw.sourceRoom) || raw.sourceRoom === targetRoom) continue;
    const sourceRoom = raw.sourceRoom;
    const configName = supportConfigName(sourceRoom, targetRoom);
    const boostOwner = `colonizationSupport:${sourceRoom}:${targetRoom}`;
    const runId = raw.runId ?? `${sourceRoom}:${targetRoom}:rcl6`;
    let state = states[targetRoom];
    if (!state || state.runId !== runId || state.sourceRoom !== sourceRoom) {
      if (state) stopConfig(supportConfigName(state.sourceRoom, targetRoom), state.sourceRoom, `colonizationSupport:${state.sourceRoom}:${targetRoom}`);
      state = states[targetRoom] = { sourceRoom, runId, status: "waiting_claim", updatedAt: Game.time };
    }
    const controller = Game.rooms[targetRoom]?.controller;
    if (controller?.my && controller.level >= 6) {
      state.status = "complete"; state.completedAt ??= Game.time;
    }
    state.updatedAt = Game.time;
    if (state.status === "complete" || raw.enabled !== true || !Game.rooms[sourceRoom]?.controller?.my ||
        !controller?.my || isDefenseMode(sourceRoom)) {
      if (state.status !== "complete") state.status = raw.enabled && !controller?.my ? "waiting_claim" : "paused";
      stopConfig(configName, sourceRoom, boostOwner);
      continue;
    }
    state.status = "supporting";
    const route = raw.routeRooms ?? Memory.data?.colonization?.[targetRoom]?.scoutRouteRooms ??
      configs[configName]?.args[1]?.split("|").filter(Boolean) ?? [];
    const args = [targetRoom, route.join("|"), boostOwner, "6", sourceRoom];
    const current = configs[configName];
    if (current?.role !== "colonizerWorker" || current.roomName !== sourceRoom ||
        current.args.join("\0") !== args.join("\0") || current.body?.join("|") !== COLONIZATION_SUPPORT_BODY.join("|")) {
      configs[configName] = { role: "colonizerWorker", roomName: sourceRoom, args, body: [...COLONIZATION_SUPPORT_BODY] } as CreepConfig;
    }
    const toBoost = service.getCreepsByConfigName(configName).filter(creep => creep.room.name === sourceRoom &&
      creep.body.some(part => part.type === WORK && part.hits > 0 && part.boost !== RESOURCE_CATALYZED_GHODIUM_ACID));
    if (toBoost.length > 0) {
      const needed = toBoost.reduce((sum, creep) => sum + creep.body.filter(part => part.type === WORK &&
        part.hits > 0 && part.boost !== RESOURCE_CATALYZED_GHODIUM_ACID).length * LAB_BOOST_MINERAL, 0);
      prepareBoosts(boostOwner, sourceRoom, 8, new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, needed]]), { requireLabEnergy: true });
    } else if (service.getCreepsByConfigName(configName).length > 0) {
      releaseBoostLabs(boostOwner, sourceRoom);
    }
  }
}
