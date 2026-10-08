import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import { isDefenseMode } from "@/runtime/defenseMode";
import type { CreepConfig } from "@/types/system";
import { COLONIZATION_UPGRADER_BODY } from "@/config/colonizationSupport";
import { releaseWorkerTask } from "@/runtime/workerTaskPool";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";

export const COLONIZATION_SUPPORT_BODY = COLONIZATION_UPGRADER_BODY;
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

function stopConfig(configName: string, sourceRoom: string, boostOwner?: string): void {
  const service = getTickContextService();
  for (const spawn of service.getSpawnsByRoom(sourceRoom)) {
    if (spawn.memory.spawnList?.includes(configName)) spawn.memory.spawnList = spawn.memory.spawnList.filter(name => name !== configName);
  }
  const configs = getMemoryService().getCreepConfigStore();
  if (configs[configName]) delete configs[configName].roomName;
  if (boostOwner) releaseBoostLabs(boostOwner, sourceRoom);
  const spawning = service.getSpawnsByRoom(sourceRoom).some(spawn => spawn.spawning &&
    Memory.creeps?.[spawn.spawning.name]?.configName === configName);
  // 同tick交接会改写configName，旧索引不能证明新退役配置已无活体。
  if (!spawning && !Object.values(Game.creeps).some(creep => creep.memory.configName === configName)) delete configs[configName];
}

/** 只对实际就位、采力足够且不临近死亡的接班矿工计时。 */
function readySourceMiner(creep: Creep, source: Source): boolean {
  if (creep.spawning || creep.memory.ready !== true || creep.memory._colonizationRetiring ||
      creep.room.name !== source.room.name || (creep.ticksToLive ?? 0) <= 100 ||
      creep.pos.getRangeTo(source.pos) > 1) return false;
  const harvestPower = creep.body.reduce((sum, part) => {
    if (part.type !== WORK || part.hits <= 0) return sum;
    const boost = part.boost ? (BOOSTS[WORK] as Record<string, { harvest?: number }>)[part.boost] : undefined;
    return sum + HARVEST_POWER * (boost?.harvest ?? 1);
  }, 0);
  return harvestPower >= (source.energyCapacity || SOURCE_ENERGY_CAPACITY) / ENERGY_REGEN_TIME;
}

function retireSupportMiner(creep: Creep, configName: string, targetRoom: string): void {
  if (creep.memory._colonizationRetiring) return;
  const configs = getMemoryService().getCreepConfigStore();
  const config = configs[configName];
  const retiringName = `${configName}:retiring:${creep.name}`;
  configs[retiringName] = { role: "colonizerHarvester", args: [...(config?.args ?? creep.memory.roleArgs ?? [])] };
  creep.memory.configName = retiringName;
  creep.memory._colonizationRetiring = targetRoom;
}

/** 在 flagControl 内维持独立支援，不依赖 RCL3 后被移除的殖民旗。 */
export function runColonizationSupport(): void {
  const memory = getMemoryService();
  const policies = Memory.cfg?.colonizationSupport;
  const existing = Memory.data?.creepConfigs ?? {};
  // 增援矿工与仍然有效的支援策略同寿，不依赖已结束的殖民旗任务。
  for (const name of Object.keys(existing)) {
    const [home, kind, target, role] = name.split(":");
    if (kind !== "colonizationSupport" || role !== "harvester") continue;
    const policy = readColonizationSupportPolicy(target);
    const controller = Game.rooms[target]?.controller;
    if (policy?.sourceRoom !== home || !controller?.my || controller.level >= 6 ||
        !Game.rooms[home]?.controller?.my || isDefenseMode(home)) stopConfig(name, home);
  }
  if (!policies) return;
  const configs = memory.getCreepConfigStore();
  const states = memory.ensureRuntime().colonizationSupport ??= {};
  const service = getTickContextService();
  for (const [targetRoom, raw] of Object.entries(policies)) {
    if (!ROOM_NAME.test(targetRoom) || !raw || !ROOM_NAME.test(raw.sourceRoom) || raw.sourceRoom === targetRoom) continue;
    const sourceRoom = raw.sourceRoom;
    const runId = raw.runId ?? `${sourceRoom}:${targetRoom}:rcl6`;
    const configName = supportConfigName(sourceRoom, targetRoom);
    const retiringPrefix = `${configName}:retiring:`;
    const boostOwner = `colonizationSupport:${sourceRoom}:${targetRoom}`;
    // 旧身体无法原地替换：独立保留现役配置，不补员，空出常规名孵化新身体。
    for (const name of Object.keys(configs).filter(name => name.startsWith(retiringPrefix))) {
      delete configs[name].roomName;
      if (service.getCreepsByConfigName(name).length === 0) delete configs[name];
    }
    const previousState = states[targetRoom];
    const savedRoute = previousState?.sourceRoom === sourceRoom && previousState.runId === runId ? previousState.routeRooms : undefined;
    const route = raw.routeRooms ?? Memory.data?.colonization?.[targetRoom]?.scoutRouteRooms ??
      (configs[configName]?.args[1] ? configs[configName].args[1].split("|").filter(Boolean) : savedRoute) ?? [];
    const args = [targetRoom, route.join("|"), boostOwner, "6", sourceRoom];
    const liveConfigNames = [configName, ...Object.keys(configs).filter(name => name.startsWith(retiringPrefix))];
    // 原位转换现役与过渡支援，释放 worker 租约，不重新孵化或重做已经完成的增强。
    for (const name of liveConfigNames) {
      if (configs[name] && (configs[name].role !== "colonizerUpgrader" || configs[name].args.join("\0") !== args.join("\0"))) {
        configs[name].role = "colonizerUpgrader";
        configs[name].args = [...args];
      }
      for (const creep of service.getCreepsByConfigName(name)) {
        if (creep.memory.role === "colonizerUpgrader" && creep.memory.roleArgs?.join("\0") === args.join("\0")) continue;
        releaseWorkerTask(creep); releasePickupReservation(creep);
        creep.memory.role = "colonizerUpgrader";
        creep.memory.roleArgs = [...args];
        creep.memory.ready = false;
      }
    }
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
    state.routeRooms = [...route];
    if (state.status === "complete" || raw.enabled !== true || !Game.rooms[sourceRoom]?.controller?.my ||
        !controller?.my || isDefenseMode(sourceRoom)) {
      if (state.status !== "complete") state.status = raw.enabled && !controller?.my ? "waiting_claim" : "paused";
      stopConfig(configName, sourceRoom, boostOwner);
      for (const name of Object.keys(configs).filter(name => name.startsWith(`${sourceRoom}:colonizationSupport:${targetRoom}:harvester:`))) {
        stopConfig(name, sourceRoom);
      }
      continue;
    }
    state.status = "supporting";
    const miningPrefix = `${sourceRoom}:colonizationSupport:${targetRoom}:harvester:`;
    const validMiningNames = new Set<string>();
    const handoffs = state.miningHandoffs ??= {};
    const localCanSpawnFiveWork = (Game.rooms[targetRoom].energyCapacityAvailable ?? 0) >= 5 * BODYPART_COST[WORK] + 3 * BODYPART_COST[MOVE]
      && service.getSpawnsByRoom(targetRoom).some(spawn => spawn.isActive());
    for (const source of service.getRoomContext(Game.rooms[targetRoom])!.getSources()) {
      const miningName = `${miningPrefix}${source.id}`;
      validMiningNames.add(miningName);
      const supportMiners = service.getCreepsByConfigName(miningName).filter(creep => !creep.memory._colonizationRetiring);
      const localMiners = service.getCreepsByRoom(targetRoom).filter(creep => {
        const config = configs[creep.memory.configName ?? ""];
        const args = config?.args ?? creep.memory.roleArgs;
        return creep.memory.role === "harvester" &&
          creep.memory.configName?.startsWith(`${targetRoom}:harvester:`) && args?.[0] === source.id;
      });
      const successor = [...localMiners.filter(creep => readySourceMiner(creep, source)),
        ...supportMiners.filter(creep => readySourceMiner(creep, source)).sort((left, right) => (right.ticksToLive ?? 0) - (left.ticksToLive ?? 0))][0];
      if (!successor) delete handoffs[source.id];
      else if (handoffs[source.id]?.creepName !== successor.name) handoffs[source.id] = { creepName: successor.name, readySince: Game.time };
      const ready = successor && Game.time - handoffs[source.id].readySince >= 5;
      if (ready) {
        for (const creep of supportMiners) if (creep !== successor) retireSupportMiner(creep, miningName, targetRoom);
        if (localMiners.includes(successor)) {
          stopConfig(miningName, sourceRoom);
          continue;
        }
      }
      // 本地可生产5WORK后停止外部补员；已有矿工等本地实际就位后回收。
      configs[miningName] = {
        role: "colonizerHarvester", roomName: !localCanSpawnFiveWork || supportMiners.length > 0 ? sourceRoom : undefined,
        args: [targetRoom, source.id, route.join("|")],
        ...(localCanSpawnFiveWork ? { spawnOnce: { queuedAt: configs[miningName]?.spawnOnce?.queuedAt ?? Game.time } } : {}),
      };
      if (localCanSpawnFiveWork) {
        for (const spawn of service.getSpawnsByRoom(sourceRoom)) {
          if (spawn.memory.spawnList?.includes(miningName)) spawn.memory.spawnList = spawn.memory.spawnList.filter(name => name !== miningName);
        }
      }
    }
    for (const name of Object.keys(configs).filter(name => name.startsWith(miningPrefix))) {
      if (!validMiningNames.has(name)) stopConfig(name, sourceRoom);
    }
    const current = configs[configName];
    if (current?.role !== "colonizerUpgrader" || current.roomName !== sourceRoom ||
        current.args.join("\0") !== args.join("\0") || current.body?.join("|") !== COLONIZATION_SUPPORT_BODY.join("|")) {
      configs[configName] = { role: "colonizerUpgrader", roomName: sourceRoom, args, body: [...COLONIZATION_SUPPORT_BODY] } as CreepConfig;
    }
    for (const creep of service.getCreepsByConfigName(configName)) {
      if (creep.spawning || creep.body.map(part => part.type).join("|") === COLONIZATION_SUPPORT_BODY.join("|")) continue;
      const retiringName = `${retiringPrefix}${creep.name}`;
      configs[retiringName] = { role: "colonizerUpgrader", args: [...args], body: creep.body.map(part => part.type) } as CreepConfig;
      creep.memory.configName = retiringName;
    }
    const helpersAtSource = service.getCreepsByRoom(sourceRoom).filter(creep =>
      creep.memory.configName === configName || creep.memory.configName?.startsWith(retiringPrefix));
    const toBoost = helpersAtSource.filter(creep =>
      creep.body.some(part => part.type === WORK && part.hits > 0 && part.boost !== RESOURCE_CATALYZED_GHODIUM_ACID));
    if (toBoost.length > 0) {
      const needed = toBoost.reduce((sum, creep) => sum + creep.body.filter(part => part.type === WORK &&
        part.hits > 0 && part.boost !== RESOURCE_CATALYZED_GHODIUM_ACID).length * LAB_BOOST_MINERAL, 0);
      prepareBoosts(boostOwner, sourceRoom, 8, new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, needed]]), { requireLabEnergy: true });
    } else if (helpersAtSource.length > 0 || service.getCreepsByConfigName(configName).length > 0) {
      releaseBoostLabs(boostOwner, sourceRoom);
    }
  }
}
