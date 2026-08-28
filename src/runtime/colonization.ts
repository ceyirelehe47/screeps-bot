import { runPlannerForRoom, savePlannerForRoom } from "@/modules/autoplanner";
import { spawnProfiles } from "@/config/spawnProfiles";
import { isRcl3ExtensionBuildoutComplete } from "@/runtime/roomPlannerConstruction";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { clearWarRoomTask, isWarRoomClearDone, requestWarRoomClear } from "@/runtime/warControl";
import { isDefenseMode } from "@/runtime/defenseMode";
import {
  COLONIZATION_TRAVEL_PATH_RETRY_INTERVAL,
  getCachedStaticTravelMatrix,
  getColonizationTravelPathKey,
} from "@/movement/routing";
import { recordMovementMetric } from "@/movement/metrics";
import type { CachedTravelPath, StoredRoomPosition } from "@/movement/types";

type ColonizationStatus = "claiming" | "clearing" | "waiting_plan" | "bootstrapping" | "managed";
type ColonizationMode = "normal" | "npcStronghold";

interface ColonizationTask {
  targetRoom: string;
  sourceRoom: string;
  status: ColonizationStatus;
  flagName: string;
  planReady: boolean;
  claimCompleted: boolean;
  scoutSafe?: boolean;
  scoutRouteRooms?: string[];
  cachedTravelPath?: CachedTravelPath;
  travelPathRetryAt?: number;
  travelPathRetryKey?: string;
  dangerousRooms?: string[];
  temporaryDangerousRooms?: Record<string, number>;
  permanentDangerousRooms?: string[];
  mode?: ColonizationMode;
  scoutedAt?: number;
  planRetryAt?: number;
  safeRouteRetryAt?: number;
  safeRouteRetryKey?: string;
  createdAt: number;
  updatedAt: number;
}

interface ParsedColonizationConfigName {
  sourceRoom: string;
  targetRoom: string;
}

const CLAIMER_BODY: BodyPartConstant[] = [CLAIM, MOVE];
const SCOUT_BODY: BodyPartConstant[] = [MOVE];
const BOOTSTRAP_WORKER_COUNT = 2;
const MAX_SAFE_ROUTE_LENGTH = 500;
const TEMP_DANGEROUS_ROOM_TTL = 1000;
const PLAN_RETRY_INTERVAL = 50;
const SAFE_ROUTE_RETRY_INTERVAL = 10;

let safeRouteCacheTick = -1;
const safeRouteCache = new Map<string, string[] | null>();
let routeLengthCacheTick = -1;
const routeLengthCache = new Map<string, number>();
let roomStatusCacheTick = -1;
const roomStatusCache = new Map<string, boolean>();
let visibleDangerCacheTick = -1;
const visibleDangerCache = new Map<string, boolean>();

function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function hasColonizationSquadProductionCapability(spawn: StructureSpawn): boolean {
  const minimumRequiredEnergyCapacity = Math.max(
    getBodyCost(SCOUT_BODY),
    getBodyCost(CLAIMER_BODY),
    getBodyCost(spawnProfiles.colonizerHarvester(spawn.room)),
    getBodyCost([WORK, CARRY, MOVE]),
  );

  return spawn.isActive() && spawn.room.energyCapacityAvailable >= minimumRequiredEnergyCapacity;
}

function ensureColonizationStore(): Record<string, ColonizationTask> {
  const data = getMemoryService().ensureData();
  if (!data.colonization) {
    data.colonization = {};
  }

  return data.colonization;
}

function ensureConfigStore(): Record<string, import("@/types/system").CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function getOwnedSpawnRooms(): string[] {
  const tickContext = getTickContextService();
  const roomNames = new Set<string>();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (hasColonizationSquadProductionCapability(spawn)) {
        if (isDefenseMode(spawn.room.name)) {
          continue;
        }
        roomNames.add(spawn.room.name);
      }
    }
  }
  return [...roomNames];
}

function selectSourceRoom(targetRoom: string, preferredRoom?: string): string | null {
  const ownedSpawnRooms = getOwnedSpawnRooms();
  if (ownedSpawnRooms.length === 0) {
    return null;
  }

  if (preferredRoom && ownedSpawnRooms.includes(preferredRoom)) {
    return preferredRoom;
  }

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

function getPreferredSourceFromFlagName(flagName: string): string | undefined {
  if (!flagName.startsWith("CL_")) {
    return undefined;
  }

  const match = /^CL_([WE]\d+[NS]\d+)/.exec(flagName.trim());
  return match?.[1];
}

function getColonizationFlags(): Flag[] {
  return Object.values(Game.flags).filter((flag) => flag.name === "CL" || flag.name.startsWith("CL_"));
}

function getTaskConfigName(
  task: ColonizationTask,
  role: "scout" | "claimer" | "harvester" | "worker",
  indexOrSourceId: string,
): string {
  return `${task.sourceRoom}:colonize:${task.targetRoom}:${role}:${indexOrSourceId}`;
}

function getTaskConfigNames(task: ColonizationTask): string[] {
  const prefix = `${task.sourceRoom}:colonize:${task.targetRoom}:`;
  return Object.keys(getCreepConfigService().list(prefix));
}

function parseColonizationConfigName(configName: string): ParsedColonizationConfigName | null {
  const parts = configName.split(":");
  if (parts.length < 5 || parts[1] !== "colonize") {
    return null;
  }

  return {
    sourceRoom: parts[0],
    targetRoom: parts[2],
  };
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return getTickContextService().getCreepsByConfigName(configName);
}

function getSpawnsForRoom(roomName: string): StructureSpawn[] {
  return getTickContextService().getSpawnsByRoom(roomName);
}

function isConfigQueuedInSpawns(spawns: StructureSpawn[], configName: string): boolean {
  return spawns.some((spawn) => spawn.memory.spawnList?.includes(configName) ?? false);
}

function getSpawnQueueLoad(spawn: StructureSpawn): number {
  return (spawn.spawning ? 1 : 0) + (spawn.memory.spawnList?.length ?? 0);
}

function selectLeastLoadedSpawn(spawns: StructureSpawn[]): StructureSpawn | undefined {
  if (spawns.length === 0) return undefined;

  return [...spawns].sort((left, right) => {
    const loadDiff = getSpawnQueueLoad(left) - getSpawnQueueLoad(right);
    if (loadDiff !== 0) return loadDiff;
    return left.name.localeCompare(right.name);
  })[0];
}

function getSpawnForRoom(roomName: string): StructureSpawn | null {
  return getTickContextService().getPrimarySpawnByRoom(roomName) || null;
}

function enqueueConfig(spawn: StructureSpawn, configName: string, toFront: boolean): void {
  const queue = spawn.memory.spawnList || [];
  if (toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName);
  }
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
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

function upsertConfig(
  configName: string,
  config: import("@/types/system").CreepConfig,
): void {
  const store = ensureConfigStore();
  store[configName] = config;
}

function removeConfigWhenIdle(configName: string): void {
  const liveCount = getLiveCreepsByConfig(configName).length;
  if (liveCount > 0) {
    return;
  }

  const store = ensureConfigStore();
  if (store[configName]) {
    delete store[configName];
  }
}

function removeQueuedConfigFromSourceRoom(sourceRoom: string, configName: string): void {
  for (const spawn of getTickContextService().getSpawnsByRoom(sourceRoom)) {
    if (spawn.memory.spawnList) {
      spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
    }
  }
}

function removeQueuedConfig(task: ColonizationTask, configName: string): void {
  removeQueuedConfigFromSourceRoom(task.sourceRoom, configName);
}

function getMyUsername(): string | null {
  const firstSpawn = Object.values(Game.spawns)[0];
  if (firstSpawn) {
    return firstSpawn.owner.username;
  }

  const firstCreep = Object.values(Game.creeps)[0];
  if (firstCreep) {
    return firstCreep.owner.username;
  }

  return null;
}

function hasHostileCombatCreeps(room: Room): boolean {
  const hostileCombatCreeps = room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) =>
      creep.getActiveBodyparts(ATTACK) > 0 ||
      creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      creep.getActiveBodyparts(HEAL) > 0,
  });
  return hostileCombatCreeps.length > 0;
}

function hasHostilePowerCreepPresence(room: Room): boolean {
  return room.find(FIND_HOSTILE_POWER_CREEPS).length > 0;
}

function hasHostileStructurePresence(room: Room): boolean {
  const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });
  return hostileStructures.length > 0;
}

function isDangerousVisibleRoom(roomName: string, myUsername: string | null): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    return false;
  }

  const controller = room.controller;
  if (controller?.owner && !controller.my) {
    return true;
  }

  if (controller?.reservation) {
    if (!myUsername) {
      return true;
    }

    if (controller.reservation.username !== myUsername) {
      return true;
    }
  }

  if (hasHostileStructurePresence(room)) {
    return true;
  }

  if (!controller?.owner && !controller?.my) {
    return false;
  }

  if (hasHostilePowerCreepPresence(room)) {
    return true;
  }

  if (hasHostileCombatCreeps(room)) {
    return true;
  }

  return false;
}

function ensureDangerTracking(task: ColonizationTask): void {
  task.permanentDangerousRooms = task.permanentDangerousRooms || [];

  if (!task.temporaryDangerousRooms) {
    const migratedDangerousRooms = task.dangerousRooms || [];
    const temporaryDangerousRooms: Record<string, number> = {};
    for (const roomName of migratedDangerousRooms) {
      if (roomName === task.sourceRoom) {
        continue;
      }

      temporaryDangerousRooms[roomName] = Game.time + TEMP_DANGEROUS_ROOM_TTL;
    }

    task.temporaryDangerousRooms = temporaryDangerousRooms;
  }
}

function refreshDangerousRooms(task: ColonizationTask): void {
  ensureDangerTracking(task);

  for (const [roomName, expiresAt] of Object.entries(task.temporaryDangerousRooms || {})) {
    if (expiresAt <= Game.time) {
      delete task.temporaryDangerousRooms![roomName];
    }
  }

  const dangerousRoomSet = new Set<string>(task.permanentDangerousRooms || []);
  for (const roomName of Object.keys(task.temporaryDangerousRooms || {})) {
    dangerousRoomSet.add(roomName);
  }

  dangerousRoomSet.delete(task.sourceRoom);
  task.dangerousRooms = [...dangerousRoomSet];
}

function markTemporaryDangerousRoom(task: ColonizationTask, roomName: string): boolean {
  if (roomName === task.sourceRoom) {
    return false;
  }

  ensureDangerTracking(task);
  if ((task.permanentDangerousRooms || []).includes(roomName)) {
    return false;
  }

  const wasMarked = !!task.temporaryDangerousRooms?.[roomName];
  task.temporaryDangerousRooms![roomName] = Game.time + TEMP_DANGEROUS_ROOM_TTL;
  refreshDangerousRooms(task);
  return !wasMarked;
}

function markPermanentDangerousRoom(task: ColonizationTask, roomName: string): boolean {
  if (roomName === task.sourceRoom) {
    return false;
  }

  ensureDangerTracking(task);
  if ((task.permanentDangerousRooms || []).includes(roomName)) {
    delete task.temporaryDangerousRooms![roomName];
    refreshDangerousRooms(task);
    return false;
  }

  task.permanentDangerousRooms!.push(roomName);
  delete task.temporaryDangerousRooms![roomName];
  refreshDangerousRooms(task);
  return true;
}

function hasHostileCreepAttackInRoom(room: Room): boolean {
  if (hasHostileCombatCreeps(room)) {
    return true;
  }

  return hasHostilePowerCreepPresence(room);
}

function isRoomHostileOwned(room: Room): boolean {
  return !!room.controller?.owner && !room.controller.my;
}

function isRoomNameHostileOwned(roomName: string): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    return false;
  }

  return isRoomHostileOwned(room);
}

function isTaskColonizationConfig(configName: string, task: ColonizationTask): boolean {
  const prefix = `${task.sourceRoom}:colonize:${task.targetRoom}:`;
  return configName.startsWith(prefix);
}

function getTaskSquadCreeps(task: ColonizationTask): Creep[] {
  const configNames = getTaskConfigNames(task);
  const squad: Creep[] = [];
  const seen = new Set<string>();

  for (const configName of configNames) {
    for (const creep of getLiveCreepsByConfig(configName)) {
      if (seen.has(creep.name)) {
        continue;
      }

      seen.add(creep.name);
      squad.push(creep);
    }
  }

  return squad;
}

function updateDangerousRoomsFromSquadDamage(task: ColonizationTask): void {
  refreshDangerousRooms(task);

  const squad = getTaskSquadCreeps(task);
  for (const creep of squad) {
    const previousHits = creep.memory.colonizationLastHits;
    const hostileOwnedRoom = isRoomHostileOwned(creep.room);
    const hostileCreepAttack = hasHostileCreepAttackInRoom(creep.room);

    if (previousHits !== undefined && creep.hits < previousHits) {
      if (hostileOwnedRoom) {
        const newlyMarked = markPermanentDangerousRoom(task, creep.room.name);
        if (newlyMarked) {
          console.log(`[colonization] permanent dangerous room: ${creep.room.name} (squad attacked in owned room)`);
        }
      } else if (hostileCreepAttack) {
        const newlyMarked = markTemporaryDangerousRoom(task, creep.room.name);
        if (newlyMarked) {
          const expiresAt = task.temporaryDangerousRooms?.[creep.room.name] || Game.time + TEMP_DANGEROUS_ROOM_TTL;
          console.log(`[colonization] temporary dangerous room: ${creep.room.name} (expires at ${expiresAt})`);
        }
      }
    }

    creep.memory.colonizationLastHits = creep.hits;
    creep.memory.colonizationLastSeenAt = Game.time;
    creep.memory.colonizationLastRoomName = creep.room.name;
    creep.memory.colonizationLastRoomHostileOwned = hostileOwnedRoom;
    creep.memory.colonizationLastHadHostileCreepAttack = hostileCreepAttack;
    creep.memory.colonizationDeathHandled = false;
  }

  const creepMemoryStore = Memory.creeps || {};
  for (const [creepName, creepMemory] of Object.entries(creepMemoryStore)) {
    if (!creepMemory.configName || !isTaskColonizationConfig(creepMemory.configName, task)) {
      continue;
    }

    if (Game.creeps[creepName]) {
      continue;
    }

    if (creepMemory.colonizationDeathHandled) {
      continue;
    }

    const lastSeenAt = creepMemory.colonizationLastSeenAt;
    if (lastSeenAt === undefined || Game.time - lastSeenAt > 2) {
      continue;
    }

    const lastRoomName = creepMemory.colonizationLastRoomName;
    if (!lastRoomName) {
      creepMemory.colonizationDeathHandled = true;
      continue;
    }

    const hostileOwnedRoom = creepMemory.colonizationLastRoomHostileOwned || isRoomNameHostileOwned(lastRoomName);
    if (hostileOwnedRoom) {
      const newlyMarked = markPermanentDangerousRoom(task, lastRoomName);
      if (newlyMarked) {
        console.log(`[colonization] permanent dangerous room: ${lastRoomName} (squad lost in owned room)`);
      }
      creepMemory.colonizationDeathHandled = true;
      continue;
    }

    if (creepMemory.colonizationLastHadHostileCreepAttack) {
      const newlyMarked = markTemporaryDangerousRoom(task, lastRoomName);
      if (newlyMarked) {
        const expiresAt = task.temporaryDangerousRooms?.[lastRoomName] || Game.time + TEMP_DANGEROUS_ROOM_TTL;
        console.log(`[colonization] temporary dangerous room: ${lastRoomName} (squad lost, expires at ${expiresAt})`);
      }
    }

    creepMemory.colonizationDeathHandled = true;
  }
}

function estimateRouteLengthInner(task: ColonizationTask, routeRooms: string[]): number {
  const allowedRooms = new Set(routeRooms);
  if (!allowedRooms.has(task.sourceRoom) || !allowedRooms.has(task.targetRoom)) {
    return Infinity;
  }

  const spawn = getSpawnForRoom(task.sourceRoom);
  const startPos = spawn ? spawn.pos : new RoomPosition(25, 25, task.sourceRoom);
  const targetPos = new RoomPosition(25, 25, task.targetRoom);

  const search = PathFinder.search(
    startPos,
    { pos: targetPos, range: 20 },
    {
      maxOps: 20000,
      maxRooms: Math.max(1, allowedRooms.size),
      plainCost: 2,
      swampCost: 10,
      roomCallback: (roomName) => {
        if (!allowedRooms.has(roomName)) {
          return false;
        }

        // 与持久路径生成同一套静态矩阵，估算长度才会反映真实可走性。
        return getCachedStaticTravelMatrix(roomName).clone();
      },
    },
  );

  if (search.incomplete) {
    return Infinity;
  }

  return search.path.length;
}

function estimateRouteLength(task: ColonizationTask, routeRooms: string[]): number {
  if (routeLengthCacheTick !== Game.time) {
    routeLengthCache.clear();
    routeLengthCacheTick = Game.time;
  }

  const cacheKey = `${task.sourceRoom}->${task.targetRoom}:${routeRooms.join("|")}`;
  const cached = routeLengthCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = estimateRouteLengthInner(task, routeRooms);
  routeLengthCache.set(cacheKey, result);
  return result;
}

function isRoomStatusNormal(roomName: string): boolean {
  if (roomStatusCacheTick !== Game.time) {
    roomStatusCache.clear();
    roomStatusCacheTick = Game.time;
  }

  const cached = roomStatusCache.get(roomName);
  if (cached !== undefined) {
    return cached;
  }

  const result = Game.map.getRoomStatus(roomName).status === "normal";
  roomStatusCache.set(roomName, result);
  return result;
}

function isDangerousVisibleRoomCached(roomName: string, myUsername: string | null): boolean {
  if (visibleDangerCacheTick !== Game.time) {
    visibleDangerCache.clear();
    visibleDangerCacheTick = Game.time;
  }

  const cacheKey = `${myUsername ?? ""}:${roomName}`;
  const cached = visibleDangerCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = isDangerousVisibleRoom(roomName, myUsername);
  visibleDangerCache.set(cacheKey, result);
  return result;
}

function findSafeRouteInner(task: ColonizationTask): string[] | null {
  const myUsername = getMyUsername();
  const dangerousRooms = new Set(task.dangerousRooms ?? []);
  const route = Game.map.findRoute(task.sourceRoom, task.targetRoom, {
    routeCallback: (roomName) => {
      if (roomName === task.sourceRoom || roomName === task.targetRoom) {
        return 1;
      }

      if (dangerousRooms.has(roomName)) {
        return Infinity;
      }

      if (!isRoomStatusNormal(roomName)) {
        return Infinity;
      }

      if (isDangerousVisibleRoomCached(roomName, myUsername)) {
        return Infinity;
      }

      return 2;
    },
  });

  if (route === ERR_NO_PATH) {
    return null;
  }

  const routeRooms: string[] = [task.sourceRoom];
  for (const step of route) {
    if (step.room === task.sourceRoom) {
      continue;
    }

    if (routeRooms[routeRooms.length - 1] !== step.room) {
      routeRooms.push(step.room);
    }
  }

  if (routeRooms[routeRooms.length - 1] !== task.targetRoom) {
    routeRooms.push(task.targetRoom);
  }

  const routeLength = estimateRouteLength(task, routeRooms);
  if (routeLength > MAX_SAFE_ROUTE_LENGTH) {
    return null;
  }

  return routeRooms;
}

function findSafeRoute(task: ColonizationTask): string[] | null {
  if (safeRouteCacheTick !== Game.time) {
    safeRouteCache.clear();
    safeRouteCacheTick = Game.time;
  }

  const dangerousRooms = [...(task.dangerousRooms ?? [])].sort();
  const cacheKey = `${task.sourceRoom}->${task.targetRoom}:${dangerousRooms.join("|")}`;
  const cached = safeRouteCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = findSafeRouteInner(task);
  safeRouteCache.set(cacheKey, result);
  return result;
}

function getSafeRouteRetryKey(task: ColonizationTask): string {
  const dangerousRooms = [...(task.dangerousRooms ?? [])].sort();
  return `${task.sourceRoom}->${task.targetRoom}:${dangerousRooms.join("|")}`;
}

function clearSafeRouteRetry(task: ColonizationTask): void {
  delete task.safeRouteRetryAt;
  delete task.safeRouteRetryKey;
}

function getDangerousRoomKey(task: ColonizationTask): string[] {
  return [...new Set(task.dangerousRooms ?? [])].sort();
}

function isValidRoomPosition(pos: RoomPosition | undefined): pos is RoomPosition {
  return !!pos && typeof pos.x === "number" && typeof pos.y === "number" && typeof pos.roomName === "string";
}

function getColonizationStartPos(task: ColonizationTask): RoomPosition {
  const spawn = getSpawnForRoom(task.sourceRoom);
  if (isValidRoomPosition(spawn?.pos)) {
    return spawn.pos;
  }

  return new RoomPosition(25, 25, task.sourceRoom);
}

function getExpectedTravelPathKey(task: ColonizationTask, routeRooms: string[]): string {
  return getColonizationTravelPathKey(task.sourceRoom, task.targetRoom, routeRooms, getDangerousRoomKey(task));
}

function isCachedTravelPathUsable(task: ColonizationTask, routeRooms: string[]): boolean {
  const cachedPath = task.cachedTravelPath;
  if (!cachedPath || cachedPath.positions.length === 0) {
    return false;
  }

  return (
    cachedPath.key === getExpectedTravelPathKey(task, routeRooms) &&
    cachedPath.sourceRoom === task.sourceRoom &&
    cachedPath.targetRoom === task.targetRoom &&
    cachedPath.routeRooms.join("|") === routeRooms.join("|")
  );
}

function createTravelPathRoomCallback(task: ColonizationTask, routeRooms: string[]): (roomName: string) => boolean | CostMatrix {
  const allowedRooms = new Set(routeRooms);
  const dangerousRooms = new Set(task.dangerousRooms ?? []);

  return (roomName: string): boolean | CostMatrix => {
    if (!allowedRooms.has(roomName)) {
      return false;
    }
    if (roomName !== task.sourceRoom && roomName !== task.targetRoom && dangerousRooms.has(roomName)) {
      return false;
    }

    // 返回空 CostMatrix 不会让引擎补回默认障碍（Source/Mineral/Deposit/
    // Controller/Portal/不可通行结构都会被穿过），持久路径必须与实时跨房
    // 移动共用同一套静态矩阵。矩阵按拓扑指纹跨 tick 缓存且不含动态 creep
    // （持久路径不能烘入当 tick 的 creep 位置）；不可见房间由其内部退化为
    // terrain-only。PathFinder 可能改写返回的矩阵，因此传 clone。
    return getCachedStaticTravelMatrix(roomName).clone();
  };
}

function cacheColonizationTravelPath(task: ColonizationTask): void {
  const routeRooms = task.scoutRouteRooms;
  if (!routeRooms || routeRooms.length === 0 || !isScoutRouteShapeValid(task) || isScoutRouteInterruptedByDanger(task)) {
    delete task.cachedTravelPath;
    return;
  }

  if (isCachedTravelPathUsable(task, routeRooms)) {
    return;
  }

  // 生成失败 / 被运行时验证删除后的重试节流：同一 key 在窗口内不再执行
  // 20000-op 的完整 search。路线被真实阻断的任务会持续 incomplete，若无
  // 节流将每 tick 重搜（殖民系高 CPU 放大器）；节流命中期间 creep 走
  // 实时寻路兜底。key 变化（路线/危险房/版本升级）立即重试。
  const expectedKey = getExpectedTravelPathKey(task, routeRooms);
  if (task.travelPathRetryKey === expectedKey && (task.travelPathRetryAt ?? 0) > Game.time) {
    recordMovementMetric("colonizationPathRegeneratesThrottled", task.targetRoom);
    return;
  }

  const startPos = getColonizationStartPos(task);
  const targetPos = new RoomPosition(25, 25, task.targetRoom);
  const search = PathFinder.search(startPos, { pos: targetPos, range: 1 }, {
    maxOps: 20000,
    maxRooms: Math.max(1, routeRooms.length),
    plainCost: 2,
    swampCost: 10,
    roomCallback: createTravelPathRoomCallback(task, routeRooms),
  });

  if (search.incomplete || search.path.length === 0) {
    delete task.cachedTravelPath;
    task.travelPathRetryKey = expectedKey;
    task.travelPathRetryAt = Game.time + COLONIZATION_TRAVEL_PATH_RETRY_INTERVAL;
    return;
  }

  const positions: StoredRoomPosition[] = search.path
    .filter((pos) => typeof pos.x === "number" && typeof pos.y === "number" && typeof pos.roomName === "string")
    .map((pos) => ({ x: pos.x, y: pos.y, roomName: pos.roomName }));
  if (positions.length === 0) {
    delete task.cachedTravelPath;
    task.travelPathRetryKey = expectedKey;
    task.travelPathRetryAt = Game.time + COLONIZATION_TRAVEL_PATH_RETRY_INTERVAL;
    return;
  }

  task.cachedTravelPath = {
    key: expectedKey,
    sourceRoom: task.sourceRoom,
    targetRoom: task.targetRoom,
    routeRooms: [...routeRooms],
    positions,
    generatedAt: Game.time,
  };
  task.travelPathRetryKey = undefined;
  task.travelPathRetryAt = undefined;
  recordMovementMetric("colonizationPathRebuilds", task.targetRoom);
}

function tryFindSafeRoute(task: ColonizationTask): string[] | null {
  const retryKey = getSafeRouteRetryKey(task);
  if (task.safeRouteRetryKey === retryKey && (task.safeRouteRetryAt ?? 0) > Game.time) {
    return null;
  }

  const route = findSafeRoute(task);
  if (route) {
    clearSafeRouteRetry(task);
    return route;
  }

  task.safeRouteRetryKey = retryKey;
  task.safeRouteRetryAt = Game.time + SAFE_ROUTE_RETRY_INTERVAL;
  return null;
}

function isAdjacentRoomByName(fromRoom: string, toRoom: string): boolean {
  const exits = Game.map.describeExits(fromRoom);
  if (!exits) {
    return false;
  }

  return Object.values(exits).some((roomName) => roomName === toRoom);
}

function normalizeObservedRoute(task: ColonizationTask, observedRooms: string[]): string[] | null {
  const route: string[] = [];
  for (const observedRoom of observedRooms) {
    const roomName = observedRoom.trim();
    if (roomName.length === 0) {
      continue;
    }

    if (route.length > 0 && route[route.length - 1] === roomName) {
      continue;
    }

    const existingIndex = route.indexOf(roomName);
    if (existingIndex >= 0) {
      route.splice(existingIndex + 1);
      continue;
    }

    route.push(roomName);
  }

  if (route.length === 0) {
    return null;
  }

  const sourceIndex = route.indexOf(task.sourceRoom);
  if (sourceIndex >= 0) {
    route.splice(0, sourceIndex);
  } else {
    route.unshift(task.sourceRoom);
  }

  const targetIndex = route.indexOf(task.targetRoom);
  if (targetIndex >= 0) {
    route.splice(targetIndex + 1);
  } else {
    route.push(task.targetRoom);
  }

  for (let i = 0; i < route.length - 1; i++) {
    if (!isAdjacentRoomByName(route[i], route[i + 1])) {
      return null;
    }
  }

  if (route[0] !== task.sourceRoom || route[route.length - 1] !== task.targetRoom) {
    return null;
  }

  return route;
}

function getObservedScoutRoute(task: ColonizationTask, scouts: Creep[]): string[] | null {
  let bestRoute: string[] | null = null;
  let bestRouteLength = Infinity;

  for (const scout of scouts) {
    const observedRoute = scout.memory.scoutVisitedRooms;
    if (!observedRoute || observedRoute.length === 0) {
      continue;
    }

    const normalizedRoute = normalizeObservedRoute(task, observedRoute);
    if (!normalizedRoute) {
      continue;
    }

    const routeLength = estimateRouteLength(task, normalizedRoute);
    if (routeLength > MAX_SAFE_ROUTE_LENGTH) {
      continue;
    }

    if (routeLength < bestRouteLength) {
      bestRouteLength = routeLength;
      bestRoute = normalizedRoute;
    }
  }

  return bestRoute;
}

function isScoutRouteShapeValid(task: ColonizationTask): boolean {
  const route = task.scoutRouteRooms;
  if (!route || route.length === 0) {
    return false;
  }

  if (route[0] !== task.sourceRoom || route[route.length - 1] !== task.targetRoom) {
    return false;
  }

  for (let i = 0; i < route.length - 1; i++) {
    if (!isAdjacentRoomByName(route[i], route[i + 1])) {
      return false;
    }
  }

  return true;
}

function isScoutRouteInterruptedByDanger(task: ColonizationTask): boolean {
  const route = task.scoutRouteRooms;
  if (!route || route.length === 0) {
    return true;
  }

  const dangerous = new Set(task.dangerousRooms || []);
  for (const roomName of route) {
    if (roomName === task.sourceRoom || roomName === task.targetRoom) {
      continue;
    }

    if (dangerous.has(roomName)) {
      return true;
    }
  }

  return false;
}

function requestScoutRescan(task: ColonizationTask, reason: string): void {
  const hadRoute = !!task.scoutRouteRooms && task.scoutRouteRooms.length > 0;
  if (!task.scoutSafe && !hadRoute) {
    return;
  }

  task.scoutSafe = false;
  task.scoutRouteRooms = undefined;
  delete task.cachedTravelPath;
  task.scoutedAt = undefined;

  const claimerConfigName = getTaskConfigName(task, "claimer", "0");
  removeQueuedConfig(task, claimerConfigName);
  removeConfigWhenIdle(claimerConfigName);

  const scoutConfigName = getTaskConfigName(task, "scout", "0");
  for (const scout of getLiveCreepsByConfig(scoutConfigName)) {
    scout.suicide();
  }
  removeQueuedConfig(task, scoutConfigName);
  removeConfigWhenIdle(scoutConfigName);

  console.log(`[colonization] rescout ${task.targetRoom}: ${reason}`);
}

function ensureScout(task: ColonizationTask): void {
  const configName = getTaskConfigName(task, "scout", "0");
  upsertConfig(configName, {
    role: "scout",
    args: [task.targetRoom, task.scoutRouteRooms?.join("|") || ""],
    roomName: task.sourceRoom,
    body: SCOUT_BODY,
  });

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    return;
  }

  const hasLive = getLiveCreepsByConfig(configName).length > 0;
  const queued = isConfigQueuedInSpawns(spawns, configName);
  const spawning = isConfigSpawning(configName);

  if (!hasLive && !queued && !spawning) {
    const targetSpawn = selectLeastLoadedSpawn(spawns);
    if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
  }
}

function abandonColonization(task: ColonizationTask, reason: string): void {
  if (task.status === "clearing") {
    clearWarRoomTask(task.targetRoom);
  }
  const configNames = getTaskConfigNames(task);
  const store = ensureColonizationStore();
  const configStore = ensureConfigStore();
  let removedAll = true;

  for (const configName of configNames) {
    const liveCreeps = getLiveCreepsByConfig(configName);
    for (const creep of liveCreeps) {
      creep.suicide();
    }
    removeQueuedConfig(task, configName);

    const config = configStore[configName];
    if (config?.roomName) {
      delete config.roomName;
    }

    if (isConfigSpawning(configName) || liveCreeps.length > 0) {
      removedAll = false;
      continue;
    }

    removeConfigWhenIdle(configName);
  }

  if (removedAll) {
    delete store[task.targetRoom];
  }
  console.log(`[colonization] abandon ${task.targetRoom}: ${reason}`);
}

function cleanupOrphanedColonizationConfigs(tasks: Record<string, ColonizationTask>): void {
  const configStore = ensureConfigStore();

  for (const [configName, config] of Object.entries(configStore)) {
    const parsed = parseColonizationConfigName(configName);
    if (!parsed) {
      continue;
    }

    const task = tasks[parsed.targetRoom];
    if (task?.sourceRoom === parsed.sourceRoom) {
      continue;
    }

    const liveCreeps = getLiveCreepsByConfig(configName);
    for (const creep of liveCreeps) {
      creep.suicide();
    }

    removeQueuedConfigFromSourceRoom(parsed.sourceRoom, configName);
    if (config.roomName) {
      delete config.roomName;
    }

    if (isConfigSpawning(configName) || liveCreeps.length > 0) {
      continue;
    }

    delete configStore[configName];
  }
}

function ensureScoutSafety(task: ColonizationTask): "pending" | "safe" | "abandon" {
  if (task.scoutSafe) {
    clearSafeRouteRetry(task);
    return "safe";
  }

  if (task.scoutRouteRooms && task.scoutRouteRooms.length > 0) {
    if (!isScoutRouteShapeValid(task) || isScoutRouteInterruptedByDanger(task)) {
      const recoveredRoute = tryFindSafeRoute(task);
      if (recoveredRoute) {
        task.scoutRouteRooms = recoveredRoute;
      } else {
        requestScoutRescan(task, "pending scout route invalid or interrupted by dangerous room");
      }
    }
  }

  const scoutConfigName = getTaskConfigName(task, "scout", "0");
  const scouts = getLiveCreepsByConfig(scoutConfigName);

  const scoutsInTarget = scouts.filter((scout) => scout.room.name === task.targetRoom);
  if (scoutsInTarget.length > 0) {
    const observedRoute = getObservedScoutRoute(task, scoutsInTarget);
    if (observedRoute) {
      task.scoutRouteRooms = observedRoute;
      clearSafeRouteRetry(task);
    }

    if (!task.scoutRouteRooms || task.scoutRouteRooms.length === 0) {
      const recoveredRoute = tryFindSafeRoute(task);
      if (recoveredRoute) {
        task.scoutRouteRooms = recoveredRoute;
      }
    }

    const targetRoom = Game.rooms[task.targetRoom];
    if (targetRoom) {
      const hasInvaderCore =
        targetRoom.find(FIND_HOSTILE_STRUCTURES, {
          filter: (structure) => structure.structureType === STRUCTURE_INVADER_CORE,
        }).length > 0;
      task.mode = hasInvaderCore ? "npcStronghold" : "normal";
      task.scoutedAt = Game.time;
    }

    task.scoutSafe = true;
    clearSafeRouteRetry(task);
    removeQueuedConfig(task, scoutConfigName);
    removeConfigWhenIdle(scoutConfigName);
    return "safe";
  }

  if (!task.scoutRouteRooms || task.scoutRouteRooms.length === 0) {
    const safeRoute = tryFindSafeRoute(task);
    if (safeRoute) {
      task.scoutRouteRooms = safeRoute;
    }
  }

  ensureScout(task);
  return "pending";
}

function hasSavedPlanWithSpawn(roomName: string): boolean {
  const layout = Memory.data?.roomPlanner?.[roomName]?.layout;
  return (layout?.[STRUCTURE_SPAWN]?.length ?? 0) > 0;
}

function ensurePlanReady(task: ColonizationTask): void {
  if (hasSavedPlanWithSpawn(task.targetRoom)) {
    task.planReady = true;
    delete task.planRetryAt;
    return;
  }

  task.planReady = false;

  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) {
    return;
  }

  if ((task.planRetryAt ?? 0) > Game.time) {
    return;
  }

  const planned = runPlannerForRoom(task.targetRoom);
  if (!planned) {
    task.planRetryAt = Game.time + PLAN_RETRY_INTERVAL;
    return;
  }

  const saved = savePlannerForRoom(task.targetRoom);
  if (saved && hasSavedPlanWithSpawn(task.targetRoom)) {
    task.planReady = true;
    delete task.planRetryAt;
    return;
  }

  task.planRetryAt = Game.time + PLAN_RETRY_INTERVAL;
}

function ensureClaimer(task: ColonizationTask): void {
  const configName = getTaskConfigName(task, "claimer", "0");
  const encodedRouteRooms = task.scoutRouteRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "claimer",
    args: [task.targetRoom, encodedRouteRooms],
    roomName: task.sourceRoom,
    body: CLAIMER_BODY,
  });

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    return;
  }

  const hasLive = getLiveCreepsByConfig(configName).length > 0;
  const queued = isConfigQueuedInSpawns(spawns, configName);
  const spawning = isConfigSpawning(configName);

  if (!hasLive && !queued && !spawning) {
    const targetSpawn = selectLeastLoadedSpawn(spawns);
    if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
  }
}

function ensureBootstrapHarvester(task: ColonizationTask, sourceId: Id<Source>): void {
  const configName = getTaskConfigName(task, "harvester", sourceId);
  const encodedRouteRooms = task.scoutRouteRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "colonizerHarvester",
    args: [task.targetRoom, sourceId, encodedRouteRooms],
    roomName: task.sourceRoom,
  });
}

function ensureBootstrapWorker(task: ColonizationTask, index: number): void {
  const configName = getTaskConfigName(task, "worker", String(index));
  const encodedRouteRooms = task.scoutRouteRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "colonizerWorker",
    args: [task.targetRoom, encodedRouteRooms],
    roomName: task.sourceRoom,
  });
}

function hasOwnedSpawnInTargetRoom(task: ColonizationTask): boolean {
  return getTickContextService().getSpawnsByRoom(task.targetRoom).length > 0;
}

function isManagedColonizationExtensionReady(task: ColonizationTask): boolean {
  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) {
    return false;
  }

  return isRcl3ExtensionBuildoutComplete(targetRoom);
}

function cleanupColonizationConfigs(task: ColonizationTask): boolean {
  const configNames = getTaskConfigNames(task);
  const store = ensureConfigStore();
  let removedAll = true;

  for (const configName of configNames) {
    removeQueuedConfig(task, configName);

    const config = store[configName];
    if (config?.roomName) {
      delete config.roomName;
    }

    if (isConfigSpawning(configName)) {
      removedAll = false;
      continue;
    }

    const liveCount = getLiveCreepsByConfig(configName).length;
    if (liveCount > 0) {
      removedAll = false;
      continue;
    }

    removeConfigWhenIdle(configName);
  }

  return removedAll;
}

function hasLocalLiveSourceWorker(task: ColonizationTask, sourceId: string): boolean {
  const sourceWorkerConfigs = getCreepConfigService().list(`${task.targetRoom}:`);
  const sourceConfigNames = [`${task.targetRoom}:harvester:${sourceId}`, `${task.targetRoom}:miner:${sourceId}`];

  return sourceConfigNames.some((configName) => {
    const config = sourceWorkerConfigs[configName];
    if (!config?.roomName) {
      return false;
    }

    return getLiveCreepsByConfig(configName).length > 0;
  });
}

function hasLocalSourceWorkerHandoff(task: ColonizationTask): boolean {
  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) {
    return false;
  }

  const sourceWorkerConfigs = getCreepConfigService().list(`${task.targetRoom}:`);
  const sources = targetRoom.find(FIND_SOURCES);
  if (sources.length === 0) {
    return false;
  }

  return sources.every((source) => {
    const sourceConfigNames = [
      `${task.targetRoom}:harvester:${source.id}`,
      `${task.targetRoom}:miner:${source.id}`,
    ];

    return sourceConfigNames.some((configName) => {
      const config = sourceWorkerConfigs[configName];
      if (!config?.roomName) {
        return false;
      }

      return getLiveCreepsByConfig(configName).length > 0 || isConfigSpawning(configName);
    });
  });
}

function retireHandedOffHarvesters(task: ColonizationTask): void {
  const store = ensureConfigStore();

  for (const configName of getTaskConfigNames(task)) {
    const config = store[configName];
    if (config?.role !== "colonizerHarvester") {
      continue;
    }

    const sourceId = config.args[1];
    if (!sourceId || !hasLocalLiveSourceWorker(task, sourceId)) {
      continue;
    }

    for (const creep of getLiveCreepsByConfig(configName)) {
      creep.suicide();
    }

    removeQueuedConfig(task, configName);
    if (config.roomName) {
      delete config.roomName;
    }

    if (isConfigSpawning(configName)) {
      continue;
    }

    delete store[configName];
  }
}

function processTask(task: ColonizationTask): void {
  if (isDefenseMode(task.sourceRoom)) return;

  updateDangerousRoomsFromSquadDamage(task);
  ensurePlanReady(task);

  if (hasOwnedSpawnInTargetRoom(task)) {
    const targetRoomRcl = Game.rooms[task.targetRoom]?.controller?.level ?? 0;
    if (targetRoomRcl >= 3) {
      task.status = "managed";
      if (!isManagedColonizationExtensionReady(task)) {
        return;
      }

      retireHandedOffHarvesters(task);
      if (!hasLocalSourceWorkerHandoff(task)) {
        return;
      }

      const cleaned = cleanupColonizationConfigs(task);
      if (cleaned) {
        const store = ensureColonizationStore();
        delete store[task.targetRoom];
        Game.flags[task.flagName]?.remove();
        console.log(`[colonization] complete: ${task.targetRoom} rcl≥3, flag removed`);
      }
      return;
    }
  }

  const targetRoom = Game.rooms[task.targetRoom];
  const hasMyController = !!targetRoom?.controller?.my;
  if (!hasMyController) {
    if (task.scoutSafe) {
      if (!isScoutRouteShapeValid(task)) {
        requestScoutRescan(task, "cached scout route invalid or disconnected");
      } else if (isScoutRouteInterruptedByDanger(task)) {
        requestScoutRescan(task, "cached scout route interrupted by dangerous room");
      }
    }

    const claimerConfigName = getTaskConfigName(task, "claimer", "0");
    removeQueuedConfig(task, claimerConfigName);
    removeConfigWhenIdle(claimerConfigName);

    const scoutSafety = ensureScoutSafety(task);
    if (scoutSafety === "abandon") {
      abandonColonization(task, "no safe route or route length exceeded 500");
      return;
    }

    if (scoutSafety !== "safe") {
      return;
    }

    if (task.status === "clearing") {
      if (!isWarRoomClearDone(task.targetRoom)) {
        requestWarRoomClear(task.targetRoom, task.sourceRoom, {
          routeRooms: task.scoutRouteRooms,
          reason: "npc_reservation",
        });
        return;
      }

      clearWarRoomTask(task.targetRoom);
      task.status = "claiming";
      task.mode = "normal";
    }

    if (task.mode === "npcStronghold") {
      task.status = "clearing";
      requestWarRoomClear(task.targetRoom, task.sourceRoom, {
        routeRooms: task.scoutRouteRooms,
        reason: "npc_reservation",
      });
      return;
    }

    task.status = "claiming";

    const scoutConfigName = getTaskConfigName(task, "scout", "0");
    removeQueuedConfig(task, scoutConfigName);
    removeConfigWhenIdle(scoutConfigName);

    if (!task.scoutRouteRooms || task.scoutRouteRooms.length === 0) {
      const recoveredRoute = tryFindSafeRoute(task);
      if (!recoveredRoute) {
        task.scoutSafe = false;
        return;
      }

      task.scoutRouteRooms = recoveredRoute;
    }

    cacheColonizationTravelPath(task);

    ensureClaimer(task);
    return;
  }

  task.claimCompleted = true;
  task.status = task.planReady ? "bootstrapping" : "waiting_plan";
  removeConfigWhenIdle(getTaskConfigName(task, "claimer", "0"));

  cacheColonizationTravelPath(task);

  if (task.status !== "bootstrapping") {
    return;
  }

  if (!targetRoom) {
    return;
  }

  const sources = targetRoom.find(FIND_SOURCES);
  for (const source of sources) {
    ensureBootstrapHarvester(task, source.id);
  }

  for (let i = 0; i < BOOTSTRAP_WORKER_COUNT; i++) {
    ensureBootstrapWorker(task, i);
  }
}

function upsertColonizationTask(flag: Flag): boolean {
  const targetRoom = flag.pos.roomName;
  const preferredRoom = getPreferredSourceFromFlagName(flag.name);
  const sourceRoom = selectSourceRoom(targetRoom, preferredRoom);

  if (!sourceRoom) {
    return false;
  }

  const store = ensureColonizationStore();
  const existing = store[targetRoom];
  const now = Game.time;

  if (existing && existing.sourceRoom !== sourceRoom) {
    cleanupColonizationConfigs(existing);
    if (existing.status === "clearing") {
      clearWarRoomTask(targetRoom);
    }
  }

  store[targetRoom] = {
    targetRoom,
    sourceRoom,
    status: existing?.status ?? "claiming",
    flagName: flag.name,
    planReady: existing?.planReady ?? false,
    claimCompleted: existing?.claimCompleted ?? false,
    scoutSafe: existing?.scoutSafe ?? false,
    scoutRouteRooms: existing?.scoutRouteRooms,
    cachedTravelPath: existing?.sourceRoom === sourceRoom ? existing?.cachedTravelPath : undefined,
    travelPathRetryAt: existing?.sourceRoom === sourceRoom ? existing?.travelPathRetryAt : undefined,
    travelPathRetryKey: existing?.sourceRoom === sourceRoom ? existing?.travelPathRetryKey : undefined,
    dangerousRooms: existing?.dangerousRooms ?? [],
    temporaryDangerousRooms: existing?.temporaryDangerousRooms,
    permanentDangerousRooms: existing?.permanentDangerousRooms,
    mode: existing?.mode,
    scoutedAt: existing?.scoutedAt,
    planRetryAt: existing?.planRetryAt,
    safeRouteRetryAt: existing?.safeRouteRetryAt,
    safeRouteRetryKey: existing?.safeRouteRetryKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (!existing) {
    const task = store[targetRoom];
    console.log(
      `[colonization] started: flag=${flag.name} target=${targetRoom} source=${task.sourceRoom} status=${task.status}`,
    );
  }

  return true;
}

export function isColonizationBootstrapRoom(roomName: string): boolean {
  const task = Memory.data?.colonization?.[roomName];
  if (!task || isDefenseMode(task.sourceRoom)) {
    return false;
  }

  if (task.status === "bootstrapping") {
    return true;
  }

  return task.status === "managed" && !isManagedColonizationExtensionReady(task);
}

export function runColonizationByFlag(): void {
  const flags = getColonizationFlags();
  for (const flag of flags) {
    const scheduled = upsertColonizationTask(flag);
    if (!scheduled && Game.time % 100 === 0) {
      console.log(`[colonization] flag pending: ${flag.name} room=${flag.pos.roomName} reason=no_source_room`);
    }
  }

  const store = ensureColonizationStore();
  for (const task of Object.values(store)) {
    if (!Game.flags[task.flagName]) {
      abandonColonization(task, "flag removed by player");
      continue;
    }

    if (isDefenseMode(task.sourceRoom)) {
      cleanupColonizationConfigs(task);
      if (task.status === "clearing") {
        clearWarRoomTask(task.targetRoom);
      }
      task.updatedAt = Game.time;
      continue;
    }

    processTask(task);
    task.updatedAt = Game.time;
  }

  cleanupOrphanedColonizationConfigs(store);
}
