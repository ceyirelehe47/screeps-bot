import { isDefenseMode } from "@/runtime/defenseMode";
import { buildStandardCarrierBody } from "@/runtime/carrierBodyPolicy";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";
import { requestCombatObservation } from "@/runtime/powerBankObserver";
import { isInvaderSalvageRoomClear, isInvaderSalvagePositionSafe } from "@/runtime/invaderSalvageSafety";
import { clearMovementState } from "@/roles/shared";

interface FlagHaulTask {
  targetRoom: string;
  sourceRoom: string;
  flagName: string;
  targetX: number;
  targetY: number;
  createdAt: number;
  updatedAt: number;
  emptyObservedAt?: number;
}

interface HaulableResourceSummary {
  energyAmount: number;
  nonEnergyAmount: number;
}

const FLAG_PREFIX = "HAUL";
const REMOTE_CARRIER_COUNT = 3;

function isInvaderFlag(flagName: string): boolean {
  return /^HAUL_[WE]\d+[NS]\d+_INVADER_/.test(flagName);
}

function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function getBodyCarryCapacity(body: BodyPartConstant[]): number {
  return body.filter((part) => part === CARRY).length * CARRY_CAPACITY;
}

function hasFlagHaulProductionCapability(spawn: StructureSpawn): boolean {
  return spawn.isActive() && spawn.room.energyCapacityAvailable >= getBodyCost([CARRY, MOVE]);
}

function getFlagHaulFlags(): Flag[] {
  return Object.values(Game.flags).filter((flag) => flag.name === FLAG_PREFIX || flag.name.startsWith(`${FLAG_PREFIX}_`));
}

function isRemoteHaulStructure(structure: Structure<StructureConstant>): structure is AnyStoreStructure {
  if (!("store" in structure)) {
    return false;
  }

  if (
    structure.structureType === STRUCTURE_CONTROLLER ||
    structure.structureType === STRUCTURE_SPAWN ||
    structure.structureType === STRUCTURE_EXTENSION
  ) {
    return false;
  }

  return (structure as AnyStoreStructure).store.getUsedCapacity() > 0;
}

function getStoredResources(store: StoreDefinition): ResourceConstant[] {
  return (Object.keys(store) as ResourceConstant[]).filter((resource) => store.getUsedCapacity(resource) > 0);
}

function addStoreResources(summary: HaulableResourceSummary, store: StoreDefinition): void {
  for (const resource of getStoredResources(store)) {
    const amount = store.getUsedCapacity(resource);
    if (resource === RESOURCE_ENERGY) {
      summary.energyAmount += amount;
    } else {
      summary.nonEnergyAmount += amount;
    }
  }
}

function getHaulableResourceSummary(room: Room, salvage = false, safeOnly = false): HaulableResourceSummary {
  const summary: HaulableResourceSummary = {
    energyAmount: 0,
    nonEnergyAmount: 0,
  };

  const structures = room.find(FIND_STRUCTURES, { filter: isRemoteHaulStructure });
  for (const structure of structures) {
    if (salvage && structure.structureType !== STRUCTURE_CONTAINER) continue;
    if (safeOnly && !isInvaderSalvagePositionSafe(room, structure.pos)) continue;
    addStoreResources(summary, structure.store);
  }

  const ruins = room.find(FIND_RUINS, {
    filter: (ruin) => ruin.store.getUsedCapacity() > 0,
  });
  for (const ruin of ruins) {
    if (safeOnly && !isInvaderSalvagePositionSafe(room, ruin.pos)) continue;
    addStoreResources(summary, ruin.store);
  }

  if (salvage) {
    for (const tombstone of room.find(FIND_TOMBSTONES)) {
      if (!safeOnly || isInvaderSalvagePositionSafe(room, tombstone.pos)) addStoreResources(summary, tombstone.store);
    }
    for (const resource of room.find(FIND_DROPPED_RESOURCES)) {
      if (safeOnly && !isInvaderSalvagePositionSafe(room, resource.pos)) continue;
      if (resource.resourceType === RESOURCE_ENERGY) summary.energyAmount += resource.amount;
      else summary.nonEnergyAmount += resource.amount;
    }
  }

  return summary;
}

function hasHaulableResources(summary: HaulableResourceSummary): boolean {
  return summary.energyAmount + summary.nonEnergyAmount > 0;
}

function shouldCancelForSmallEnergyOnly(summary: HaulableResourceSummary, sourceRoom: Room): boolean {
  if (summary.nonEnergyAmount > 0 || summary.energyAmount <= 0) {
    return false;
  }

  return summary.energyAmount < getBodyCarryCapacity(buildStandardCarrierBody(sourceRoom.energyCapacityAvailable));
}

function getPreferredSourceFromFlagName(flagName: string): string | undefined {
  if (!flagName.startsWith(`${FLAG_PREFIX}_`)) {
    return undefined;
  }

  const match = /^HAUL_([WE]\d+[NS]\d+)/.exec(flagName.trim());
  return match?.[1];
}

function getOwnedSpawnRooms(): string[] {
  const tickContext = getTickContextService();
  const roomNames = new Set<string>();

  for (const room of tickContext.getMyRooms()) {
    if (isDefenseMode(room.name)) {
      continue;
    }

    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (hasFlagHaulProductionCapability(spawn)) {
        roomNames.add(room.name);
      }
    }
  }

  return [...roomNames];
}

function selectSourceRoom(targetRoom: string, preferredRoom?: string, requirePreferred = false): string | null {
  const ownedSpawnRooms = getOwnedSpawnRooms();
  if (ownedSpawnRooms.length === 0) {
    return null;
  }

  if (preferredRoom && ownedSpawnRooms.includes(preferredRoom)) {
    return preferredRoom;
  }
  if (requirePreferred) return null;

  let bestRoom: string | null = null;
  let minDistance = Infinity;

  for (const roomName of ownedSpawnRooms) {
    const distance = Game.map.getRoomLinearDistance(roomName, targetRoom);
    if (distance < minDistance) {
      minDistance = distance;
      bestRoom = roomName;
    }
  }

  return bestRoom;
}

function ensureFlagHaulStore(): Record<string, FlagHaulTask> {
  const data = getMemoryService().ensureData();
  if (!data.flagHauling) {
    data.flagHauling = {};
  }

  return data.flagHauling;
}

function getConfigName(task: FlagHaulTask, index: number): string {
  const suffix = index === 0 ? "" : `:${index + 1}`;
  return `${task.sourceRoom}:haul:${task.targetRoom}:carrier:${task.flagName}${suffix}`;
}

function getConfigNames(task: FlagHaulTask): string[] {
  const names: string[] = [];
  for (let i = 0; i < REMOTE_CARRIER_COUNT; i++) {
    names.push(getConfigName(task, i));
  }

  return names;
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return getTickContextService().getCreepsByConfigName(configName);
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};

  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      if (creepMemory[spawn.spawning.name]?.configName === configName) {
        return true;
      }
    }
  }

  return false;
}

function removeQueuedConfig(task: FlagHaulTask, configName: string): void {
  for (const spawn of getTickContextService().getSpawnsByRoom(task.sourceRoom)) {
    if (spawn.memory.spawnList) {
      spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
    }
  }
}

function retireEmptySalvageMember(task: FlagHaulTask, creep: Creep): void {
  creep.memory._recycleToRoom = task.sourceRoom;
  delete creep.memory.configName;
  clearMovementState(creep);
}

function trimSalvageConfig(task: FlagHaulTask, name: string): void {
  const store = getMemoryService().getCreepConfigStore();
  removeQueuedConfig(task, name);
  for (const spawn of getTickContextService().getSpawnsByRoom(task.sourceRoom)) {
    if (spawn.spawning && Memory.creeps?.[spawn.spawning.name]?.configName === name) spawn.spawning.cancel();
  }
  const live = getLiveCreepsByConfig(name);
  for (const creep of live) {
    if (creep.store.getUsedCapacity() === 0) retireEmptySalvageMember(task, creep);
    else creep.memory.working = true;
  }
  if (live.some(creep => creep.store.getUsedCapacity() > 0)) {
    if (store[name]) delete store[name].roomName;
  } else delete store[name];
}

function cleanupFlagHaulConfig(task: FlagHaulTask): boolean {
  const store = getMemoryService().getCreepConfigStore();
  let canDelete = true;

  for (const configName of getConfigNames(task)) {
    const config = store[configName];
    removeQueuedConfig(task, configName);
    if (config?.roomName) {
      delete config.roomName;
    }

    const liveCreeps = getLiveCreepsByConfig(configName);
    for (const creep of liveCreeps) {
      if (creep.store.getUsedCapacity() === 0) {
        if (isInvaderFlag(task.flagName)) retireEmptySalvageMember(task, creep);
        else creep.suicide();
      }
    }

    if (isConfigSpawning(configName) || liveCreeps.some((creep) => creep.store.getUsedCapacity() > 0)) {
      canDelete = false;
    }
  }

  if (!canDelete) {
    return false;
  }

  for (const configName of getConfigNames(task)) {
    if (store[configName]) {
      delete store[configName];
    }
  }

  return true;
}

function upsertFlagHaulConfig(task: FlagHaulTask, configName: string, amount?: number): void {
  const room = Game.rooms[task.sourceRoom];
  if (!room) {
    return;
  }

  const store = getMemoryService().getCreepConfigStore();
  const existing = store[configName];
  const live = getLiveCreepsByConfig(configName).filter(creep => !creep.memory._recycleToRoom);
  const active = live.length > 0 || isConfigSpawning(configName);
  const budget = amount === undefined ? room.energyCapacityAvailable : Math.min(room.energyCapacityAvailable,
    Math.max(1, Math.ceil(amount / CARRY_CAPACITY)) * (BODYPART_COST[CARRY] + BODYPART_COST[MOVE]));
  const body = active && existing?.body ? existing.body : buildStandardCarrierBody(budget);
  const nextConfig: CreepConfig = {
    role: "remoteCarrier",
    args: isInvaderFlag(task.flagName)
      ? [task.targetRoom, `${task.targetX},${task.targetY}`, "invaderSalvage"]
      : [task.targetRoom, String(task.targetX), String(task.targetY)],
    roomName: task.sourceRoom,
    body,
    ...(isInvaderFlag(task.flagName) ? { spawnOnce: active || getTickContextService().getSpawnsByRoom(task.sourceRoom).some(s => s.memory.spawnList?.includes(configName))
      ? { queuedAt: existing?.spawnOnce?.queuedAt ?? Game.time } : {} } : {}),
  };

  if (
    existing?.role === nextConfig.role &&
    existing.roomName === nextConfig.roomName &&
    existing.args.join("|") === nextConfig.args.join("|") &&
    existing.body?.join("|") === body.join("|")
    && existing.spawnOnce?.queuedAt === nextConfig.spawnOnce?.queuedAt
  ) {
    return;
  }

  store[configName] = nextConfig;
}

function upsertSalvageConfigs(task: FlagHaulTask, amount: number): void {
  const source = Game.rooms[task.sourceRoom];
  if (!source) return;
  const names = getConfigNames(task);
  const bodyCapacity = getBodyCarryCapacity(buildStandardCarrierBody(source.energyCapacityAvailable));
  const capacity = Math.max(bodyCapacity, ...names.flatMap(name => getLiveCreepsByConfig(name)
    .filter(c => !c.memory._recycleToRoom).map(c => typeof c.store.getCapacity === "function" ? c.store.getCapacity() ?? bodyCapacity : bodyCapacity)));
  const count = Math.max(1, Math.min(names.length, Math.ceil(amount / Math.max(1, capacity))));
  const rank = (name: string): number => {
    const live = getLiveCreepsByConfig(name).filter(c => !c.memory._recycleToRoom);
    if (!live.length) return isConfigSpawning(name) ? 2000 : 4000;
    return Math.min(...live.map(c => (c.pos?.roomName === task.targetRoom ? 0 : 1000) +
      (c.memory.working && c.store.getUsedCapacity() > 0 ? 2500 : 0) + (1500 - (c.ticksToLive ?? 1500)) / 1500));
  };
  const selected = new Set([...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, count));
  for (const name of names) {
    if (selected.has(name)) upsertFlagHaulConfig(task, name, Math.ceil(amount / count));
    else trimSalvageConfig(task, name);
  }
}

function upsertFlagHaulConfigs(task: FlagHaulTask): void {
  for (const configName of getConfigNames(task)) {
    upsertFlagHaulConfig(task, configName);
  }
}

function upsertFlagHaulTask(flag: Flag): boolean {
  const targetRoom = flag.pos.roomName;
  const salvage = isInvaderFlag(flag.name);
  if (salvage) {
    requestCombatObservation(targetRoom);
    if (!flag.name.endsWith(`_INVADER_${targetRoom}`)) return false;
  }
  const targetRoomVisible = Game.rooms[targetRoom];
  if (targetRoomVisible?.controller?.my) {
    return true;
  }

  const resourceSummary = targetRoomVisible ? getHaulableResourceSummary(targetRoomVisible, salvage) : null;
  if (!salvage && resourceSummary && !hasHaulableResources(resourceSummary)) {
    flag.remove();
    return true;
  }

  const sourceRoom = selectSourceRoom(targetRoom, getPreferredSourceFromFlagName(flag.name), salvage);
  if (!sourceRoom) {
    return false;
  }

  const sourceRoomVisible = Game.rooms[sourceRoom];
  if (!salvage && resourceSummary && sourceRoomVisible && shouldCancelForSmallEnergyOnly(resourceSummary, sourceRoomVisible)) {
    flag.remove();
    return true;
  }

  const store = ensureFlagHaulStore();
  const existing = store[flag.name];
  const now = Game.time;

  if (existing && existing.sourceRoom !== sourceRoom) {
    cleanupFlagHaulConfig(existing);
  }

  store[flag.name] = {
    targetRoom,
    sourceRoom,
    flagName: flag.name,
    targetX: flag.pos.x,
    targetY: flag.pos.y,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.emptyObservedAt === undefined ? {} : { emptyObservedAt: existing.emptyObservedAt }),
  };

  if (!existing) {
    console.log(`[flag-haul] started: flag=${flag.name} target=${targetRoom} source=${sourceRoom}`);
  }

  return true;
}

function processFlagHaulTask(task: FlagHaulTask): boolean {
  if (isInvaderFlag(task.flagName)) {
    requestCombatObservation(task.targetRoom);
    const store = getMemoryService().getCreepConfigStore();
    const pause = (): void => {
      for (const name of getConfigNames(task)) {
        removeQueuedConfig(task, name);
        if (store[name]) delete store[name].roomName;
        for (const creep of getLiveCreepsByConfig(name)) {
          if (creep.store.getUsedCapacity() > 0) creep.memory.working = true;
        }
      }
    };
    const room = Game.rooms[task.targetRoom];
    if (!room) {
      pause(); task.updatedAt = Game.time; return true;
    }
    if (isDefenseMode(task.sourceRoom) || !isInvaderSalvageRoomClear(room)) {
      pause(); delete task.emptyObservedAt; task.updatedAt = Game.time; return true;
    }
    const summary = getHaulableResourceSummary(room, true);
    if (!hasHaulableResources(summary)) {
      pause();
      task.emptyObservedAt ??= Game.time;
      if (task.emptyObservedAt < Game.time && getConfigNames(task).every((name) =>
        !isConfigSpawning(name) && getLiveCreepsByConfig(name).every((creep) => creep.store.getUsedCapacity() === 0))) {
        Game.flags[task.flagName]?.remove();
        return cleanupFlagHaulConfig(task);
      }
      return true;
    }
    delete task.emptyObservedAt;
    const safe = getHaulableResourceSummary(room, true, true);
    if (!hasHaulableResources(safe)) {
      pause(); return true;
    }
    upsertSalvageConfigs(task, safe.energyAmount + safe.nonEnergyAmount); task.updatedAt = Game.time; return true;
  }
  if (isDefenseMode(task.sourceRoom)) {
    cleanupFlagHaulConfig(task);
    task.updatedAt = Game.time;
    return true;
  }

  const targetRoom = Game.rooms[task.targetRoom];
  if (targetRoom?.controller?.my) {
    return cleanupFlagHaulConfig(task);
  }

  upsertFlagHaulConfigs(task);
  task.updatedAt = Game.time;
  return true;
}

/** 只承接已确认清空的现有 NPC 战争目标；同帧发布生产配置，不等待下一轮人工巡查。 */
export function ensureClearedNpcLootHandoff(sourceRoom: string, targetRoom: string): boolean {
  const room = Game.rooms[targetRoom];
  if (!Game.rooms[sourceRoom]?.controller?.my || isDefenseMode(sourceRoom)
    || !getTickContextService().getSpawnsByRoom(sourceRoom).some(hasFlagHaulProductionCapability)
    || !isInvaderSalvageRoomClear(room) || room.controller?.my) return false;
  if (Object.values(Memory.data?.powerBankHarvest ?? {}).some(t => t.targetRoom === targetRoom &&
    !["complete", "failed", "aborted"].includes(t.status))) return false;
  const summary = getHaulableResourceSummary(room, true, true);
  if (!hasHaulableResources(summary)) return false;
  const name = `HAUL_${sourceRoom}_INVADER_${targetRoom}`;
  const tasks = ensureFlagHaulStore();
  if (tasks[name] || Game.flags[name]) return true;
  const targets = [
    ...room.find(FIND_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER && "store" in s && (s as StructureContainer).store.getUsedCapacity() > 0),
    ...room.find(FIND_RUINS).filter(r => r.store.getUsedCapacity() > 0),
    ...room.find(FIND_TOMBSTONES).filter(t => t.store.getUsedCapacity() > 0),
    ...room.find(FIND_DROPPED_RESOURCES).filter(r => r.amount > 0),
  ];
  const target = targets.find(t => isInvaderSalvagePositionSafe(room, t.pos));
  if (!target || typeof room.createFlag !== "function" || room.createFlag(target.pos, name) !== name) return false;
  const task: FlagHaulTask = { sourceRoom, targetRoom, flagName: name, targetX: target.pos.x, targetY: target.pos.y,
    createdAt: Game.time, updatedAt: Game.time };
  tasks[name] = task;
  upsertSalvageConfigs(task, summary.energyAmount + summary.nonEnergyAmount);
  requestCombatObservation(targetRoom);
  return true;
}

export function runFlagHaulingByFlag(): void {
  const flags = getFlagHaulFlags();
  const remoteFlagNames = new Set<string>();

  for (const flag of flags) {
    const scheduled = upsertFlagHaulTask(flag);
    const targetRoom = Game.rooms[flag.pos.roomName];
    if (!targetRoom?.controller?.my) {
      remoteFlagNames.add(flag.name);
    }
    if (!scheduled && Game.time % 100 === 0) {
      console.log(`[flag-haul] flag pending: ${flag.name} room=${flag.pos.roomName} reason=no_source_room`);
    }
  }

  const store = ensureFlagHaulStore();
  for (const task of Object.values(store)) {
    if (!remoteFlagNames.has(task.flagName) || !Game.flags[task.flagName]) {
      const cleaned = cleanupFlagHaulConfig(task);
      if (cleaned) {
        delete store[task.flagName];
        console.log(`[flag-haul] cancelled: flag=${task.flagName} target=${task.targetRoom}`);
      }
      continue;
    }

    processFlagHaulTask(task);
  }
}
