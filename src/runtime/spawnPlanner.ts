import { selectLeastLoadedSpawn as selectSpawnByLoad } from "@/runtime/spawnHelpers";
import { isSpawnActive } from "@/runtime/tickContext";
import { spawnProfiles } from "@/config/spawnProfiles";
import { hasMatchingCreepBody } from "@/runtime/minerBodyPolicy";
import { isDefenseMode } from "@/runtime/defenseMode";
import { spawnMaxCarrierRaw } from "@/runtime/emergencySpawning";
import { getPlannedSourceContainerPos } from "@/runtime/roomPlannerConstruction";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import { isInsideSafeZone } from "@/runtime/safeZoneHelpers";
import { isRcl8MaintenanceUpgraderConfig } from "@/runtime/upgraderPolicy";
import { getPowerBankConfigName, POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
import { canSpawnDepositConfig } from "@/runtime/depositHarvest";
import { reconcileSpawnQueueOwnership } from "@/runtime/spawnQueueOwnership";
import { colonizationHarvesterPreSpawnThreshold } from "@/runtime/colonizationHarvesterPreSpawn";
import type { CreepConfig } from "@/types/system";
import { fixedBodyExceedsCapacity, isSpawnConfigEconomicallyBlocked } from "@/runtime/outboundMissionPolicy";
import { getRoleSpawnIntent } from "@/runtime/spawnIntent";

const CARRIER_PRESPAWN_BUFFER_TICKS = 30;
const UPGRADER_PRESPAWN_BUFFER_TICKS = 30;
const SOURCE_WORKER_COMMUTE_CACHE_TTL = 1000;
const LOCAL_SOURCE_RECOVERY_BUFFER_TICKS = 100;

interface SpawnPlanningContext {
  spawnTimeByConfigName: Map<string, number>;
  sourceWorkerThresholdByKey: Map<string, number>;
  configCreepsByName: Map<string, Creep[]>;
  spawningConfigNames: Set<string>;
}

const RESERVER_PRESPAWN_BUFFER_TICKS = 100;

function isNewRoomMiningRecovery(roomName: string): boolean {
  const policy = Memory.cfg?.colonizationSupport?.[roomName];
  const controller = Game.rooms[roomName]?.controller;
  return policy?.enabled === true && policy.sourceRoom !== roomName &&
    controller?.my === true && controller.level <= 6;
}

function hasRoomSourceWorker(roomName: string): boolean {
  return getTickContextService().getCreepsByRoom(roomName).some(creep =>
    creep.spawning !== true && (creep.memory.role === "harvester" || creep.memory.role === "miner" ||
      (creep.memory.role === "colonizerHarvester" && creep.memory.roleArgs?.[0] === roomName)));
}

function getSpawnRolePriority(role: CreepConfig["role"] | undefined): number {
  if (role === "carrier" || role === "remoteCarrier") {
    return 0;
  }

  if (role === "harvester" || role === "miner" || role === "colonizerHarvester" || role === "remoteMiningReserver") {
    return 1;
  }

  if (role === "mineralHarvester") {
    return 1;
  }

  if (role === "meleeAttacker" || role === "healer") {
    return 2;
  }

  if (role === "powerBankAttacker" || role === "powerBankHealer") {
    return 0;
  }

  if (role === "powerBankHauler") {
    return 1;
  }

  if (role === "depositHarvester") return 3;

  return 3;
}

function getSpawnConfigPriority(roomName: string, configName: string): number {
  const config = getCreepConfigService().get(configName);
  if (config?.role === "homeDefender") return -3;
  if (configName.startsWith(`${roomName}:manual:bootstrapHarvester:`)) return -2;
  if (config?.roomName === roomName &&
      ((config.role === "harvester" && configName.startsWith(`${roomName}:harvester:`)) ||
       (config.role === "miner" && configName.startsWith(`${roomName}:miner:`))) &&
      Game.rooms[roomName]?.controller?.my && !hasRoomSourceWorker(roomName) && !shouldSkipConfigInDefenseMode(config)) return -2;
  if (isRcl8MaintenanceUpgraderConfig(configName, config)) {
    return -1;
  }
  if (isEmergencyCarrierConfigName(roomName, configName)) {
    return 0;
  }
  if (config?.role === "carrier" && config.roomName === roomName) {
    return 1;
  }
  if (config?.roomName === roomName && (config.role === "miner" || config.role === "harvester")) return 1.5;
  if (configName.includes(":war:")) {
    return 2;
  }
  if (config?.role === "remoteCarrier" && config.args[2] === "invaderSalvage") return 2;
  if (config?.role === "upgrader" || config?.role === "hubUpgrader") {
    return 3;
  }
  return 4 + getSpawnRolePriority(config?.role);
}

function ensureQueue(spawn: StructureSpawn): string[] {
  if (!spawn.memory.spawnList) {
    spawn.memory.spawnList = [];
  }

  return spawn.memory.spawnList;
}

function isConfigQueued(spawn: StructureSpawn, configName: string): boolean {
  return spawn.memory.spawnList?.includes(configName) ?? false;
}

function createSpawnPlanningContext(): SpawnPlanningContext {
  const spawningConfigNames = new Set<string>();
  const tickContext = getTickContextService();
  const creepMemory = Memory.creeps || {};

  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      const configName = creepMemory[spawn.spawning.name]?.configName;
      if (typeof configName === "string") {
        spawningConfigNames.add(configName);
      }
    }
  }

  return {
    spawnTimeByConfigName: new Map<string, number>(),
    sourceWorkerThresholdByKey: new Map<string, number>(),
    configCreepsByName: new Map<string, Creep[]>(),
    spawningConfigNames,
  };
}

function ensureSpawnPlannerRuntimeStore(): NonNullable<NonNullable<Memory["runtime"]>["spawnPlanner"]> {
  const runtime = getMemoryService().ensureRuntime();
  runtime.spawnPlanner = runtime.spawnPlanner || {
    sourceWorkerCommutes: {},
  };

  return runtime.spawnPlanner;
}

function getCachedSourceWorkerCommute(cacheKey: string): number | undefined {
  const cache = Memory.runtime?.spawnPlanner?.sourceWorkerCommutes?.[cacheKey];
  if (!cache) {
    return undefined;
  }

  if (Game.time - cache.updatedAt > SOURCE_WORKER_COMMUTE_CACHE_TTL) {
    delete Memory.runtime?.spawnPlanner?.sourceWorkerCommutes?.[cacheKey];
    return undefined;
  }

  return cache.commute;
}

function setCachedSourceWorkerCommute(cacheKey: string, commute: number): void {
  const store = ensureSpawnPlannerRuntimeStore();
  store.sourceWorkerCommutes[cacheKey] = {
    commute,
    updatedAt: Game.time,
  };
}

function getRoomCenterAnchor(spawn: StructureSpawn): RoomPosition {
  return spawn.room.storage?.pos || spawn.pos;
}

function getAnchorSpawnBuffer(anchor: RoomPosition, spawn: StructureSpawn): number {
  return Math.max(Math.abs(anchor.x - spawn.pos.x), Math.abs(anchor.y - spawn.pos.y));
}

function isConfigSpawning(configName: string, context: SpawnPlanningContext): boolean {
  return context.spawningConfigNames.has(configName);
}

function getConfigCreeps(configName: string, context?: SpawnPlanningContext): Creep[] {
  if (!context) {
    return getTickContextService().getCreepsByConfigName(configName);
  }

  const cached = context.configCreepsByName.get(configName);
  if (cached) {
    return cached;
  }

  const creeps = getTickContextService().getCreepsByConfigName(configName);
  context.configCreepsByName.set(configName, creeps);
  return creeps;
}

function getSourceIdFromConfig(config: CreepConfig): Id<Source> | undefined {
  if (config.role === "colonizerHarvester") {
    const sourceId = config.args[1];
    return sourceId ? (sourceId as Id<Source>) : undefined;
  }

  if (config.role === "harvester" || config.role === "miner") {
    const sourceId = config.args[0];
    return sourceId ? (sourceId as Id<Source>) : undefined;
  }

  return undefined;
}

function getMineralIdFromConfig(config: CreepConfig): Id<Mineral> | undefined {
  if (config.role !== "mineralHarvester") {
    return undefined;
  }

  const mineralId = config.args[0];
  return mineralId ? (mineralId as Id<Mineral>) : undefined;
}

function getSourceWorkerWorkPos(config: CreepConfig): RoomPosition | null {
  const mineralId = getMineralIdFromConfig(config);
  if (mineralId) {
    const mineral = Game.getObjectById(mineralId);
    if (!mineral) {
      return null;
    }

    const containers = mineral.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
    });
    if (containers.length > 0) {
      return containers[0].pos;
    }

    return mineral.pos;
  }

  const sourceId = getSourceIdFromConfig(config);
  if (!sourceId) {
    return null;
  }

  const source = Game.getObjectById(sourceId);
  if (!source) {
    return null;
  }

  const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
  });
  if (containers.length > 0) {
    return containers[0].pos;
  }

  return getPlannedSourceContainerPos(source) ?? source.pos;
}

function getSpawnBody(spawn: StructureSpawn, configName: string): BodyPartConstant[] {
  const config = getCreepConfigService().get(configName);
  if (!config) {
    return [WORK, MOVE];
  }

  if (config.body && config.body.length > 0) {
    return config.body;
  }

  return spawnProfiles[config.role](spawn.room);
}

function getSpawnTime(spawn: StructureSpawn, configName: string, context?: SpawnPlanningContext): number {
  if (context) {
    const cached = context.spawnTimeByConfigName.get(configName);
    if (cached !== undefined) {
      return cached;
    }
  }

  const body = getSpawnBody(spawn, configName);
  const spawnTime = body.length * CREEP_SPAWN_TIME;
  context?.spawnTimeByConfigName.set(configName, spawnTime);
  return spawnTime;
}

function estimateSourceWorkerPreSpawnThreshold(
  spawn: StructureSpawn, configName: string, config: CreepConfig, context?: SpawnPlanningContext,
): number {
  const priority = getSpawnConfigPriority(spawn.room.name, configName);
  const delay = (spawn.spawning?.remainingTime ?? 0) + (spawn.memory.spawnList ?? [])
    .filter(name => name !== configName && getSpawnConfigPriority(spawn.room.name, name) <= priority)
    .reduce((sum, name) => sum + getSpawnTime(spawn, name, context), 0);
  return baseSourceWorkerPreSpawnThreshold(spawn, configName, config, context) + delay;
}

function baseSourceWorkerPreSpawnThreshold(
  spawn: StructureSpawn,
  configName: string,
  config: CreepConfig,
  context?: SpawnPlanningContext,
): number {
  const supportThreshold = config.role === "colonizerHarvester"
    ? colonizationHarvesterPreSpawnThreshold(spawn, configName, config, getSpawnBody(spawn, configName)) : undefined;
  if (supportThreshold !== undefined) {
    return supportThreshold;
  }
  const workPos = getSourceWorkerWorkPos(config);
  if (!workPos) {
    return 0;
  }

  const anchor = getRoomCenterAnchor(spawn);
  const anchorBuffer = getAnchorSpawnBuffer(anchor, spawn);
  const cacheKey = `${spawn.room.name}:${anchor.roomName}:${anchor.x}:${anchor.y}:${workPos.roomName}:${workPos.x}:${workPos.y}`;
  const cached = context?.sourceWorkerThresholdByKey.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const persistedCommute = getCachedSourceWorkerCommute(cacheKey);
  if (persistedCommute !== undefined) {
    const threshold = persistedCommute + anchorBuffer + getSpawnTime(spawn, configName, context);
    context?.sourceWorkerThresholdByKey.set(cacheKey, threshold);
    return threshold;
  }

  const path = anchor.findPathTo(workPos, { ignoreCreeps: true, swampCost: 2 });
  const commuteTime = path.length + anchorBuffer;
  const produceTime = getSpawnTime(spawn, configName, context);
  const threshold = commuteTime + produceTime;

  context?.sourceWorkerThresholdByKey.set(cacheKey, threshold);
  setCachedSourceWorkerCommute(cacheKey, commuteTime - anchorBuffer);

  return threshold;
}

function shouldPreSpawnCarrier(spawn: StructureSpawn, configName: string, context?: SpawnPlanningContext): boolean {
  const creeps = getConfigCreeps(configName, context);
  if (creeps.length === 0) {
    return true;
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = getSpawnTime(spawn, configName, context) + CARRIER_PRESPAWN_BUFFER_TICKS;
  const soonestDying = creeps.reduce((minCreep, creep) =>
    (creep.ticksToLive ?? Infinity) < (minCreep.ticksToLive ?? Infinity) ? creep : minCreep,
  );

  return (soonestDying.ticksToLive ?? Infinity) <= threshold;
}

function shouldPreSpawnUpgrader(spawn: StructureSpawn, configName: string, context?: SpawnPlanningContext): boolean {
  const creeps = getConfigCreeps(configName, context);
  if (creeps.length === 0) {
    return true;
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = getSpawnTime(spawn, configName, context) + UPGRADER_PRESPAWN_BUFFER_TICKS;
  return (creeps[0].ticksToLive ?? Infinity) <= threshold;
}

function shouldPreSpawnSourceWorker(
  spawn: StructureSpawn,
  configName: string,
  config: CreepConfig,
  context?: SpawnPlanningContext,
): boolean {
  const creeps = getConfigCreeps(configName, context);
  if (creeps.length === 0) {
    return true;
  }

  if (config.role === "miner") {
    const expectedBody = getSpawnBody(spawn, configName);
    if (!hasMatchingCreepBody(creeps, expectedBody)) {
      return true;
    }
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = estimateSourceWorkerPreSpawnThreshold(spawn, configName, config, context) +
    (config.role !== "colonizerHarvester" && !spawn.room.storage && isNewRoomMiningRecovery(spawn.room.name)
      ? LOCAL_SOURCE_RECOVERY_BUFFER_TICKS : 0);
  const soonestDying = creeps.reduce((minCreep, creep) =>
    (creep.ticksToLive ?? Infinity) < (minCreep.ticksToLive ?? Infinity) ? creep : minCreep,
  );

  return (soonestDying.ticksToLive ?? Infinity) <= threshold;
}

function shouldPreSpawnReserver(
  spawn: StructureSpawn,
  configName: string,
  context?: SpawnPlanningContext,
): boolean {
  const creeps = getConfigCreeps(configName, context);
  if (creeps.length === 0) {
    return true;
  }

  if (creeps.length >= 2) {
    return false;
  }

  const threshold = getSpawnTime(spawn, configName, context) + RESERVER_PRESPAWN_BUFFER_TICKS;
  const soonestDying = creeps.reduce((minCreep, creep) =>
    (creep.ticksToLive ?? Infinity) < (minCreep.ticksToLive ?? Infinity) ? creep : minCreep,
  );

  return (soonestDying.ticksToLive ?? Infinity) <= threshold;
}

const POWER_BANK_COMBAT_RETIRED_STATUSES: ReadonlySet<string> = new Set([
  POWER_BANK_STATUS.HAULING,
  POWER_BANK_STATUS.COMPLETE,
  POWER_BANK_STATUS.FAILED,
  POWER_BANK_STATUS.ABORTED,
]);

function stripConfigFromAllSpawnQueues(configName: string): void {
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (spawn.memory.spawnList?.includes(configName)) {
        spawn.memory.spawnList = spawn.memory.spawnList.filter((item) => item !== configName);
      }
    }
  }
}

function isConfigActivelySpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (spawn.spawning && creepMemory[spawn.spawning.name]?.configName === configName) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 孵化器侧兜底：任务不再需要 combat creep（hauling/终态/任务消失），或配置
 * 挂在已换源的旧源房名下（同 bank 重新发现后改选 sourceRoom）时，禁止重排
 * 并清掉孤儿配置与队列残留，阻断“排队→孵化→出生即自杀→再排队”的烧能量
 * 死循环。有活体/孵化中的 creep 时保留配置，等其自然消亡后下一轮清理。
 * 手动创建的无 taskId combat 配置同样会被清理——这类 creep 出生后本就走
 * role 端孤儿退役逻辑自杀，语义保持一致。
 */
function pruneRetiredPowerBankCombatConfig(configName: string, context?: SpawnPlanningContext): void {
  stripConfigFromAllSpawnQueues(configName);
  if (getConfigCreeps(configName, context).length > 0) return;
  if (isConfigActivelySpawning(configName)) return;
  getCreepConfigService().remove(configName);
}

function shouldQueuePowerBankCombatConfig(
  configName: string,
  config: CreepConfig,
  context?: SpawnPlanningContext,
): boolean {
  const task = config.taskId ? Memory.data?.powerBankHarvest?.[config.taskId] : undefined;
  if (
    !config.taskId ||
    !task ||
    POWER_BANK_COMBAT_RETIRED_STATUSES.has(task.status) ||
    config.roomName !== task.sourceRoom
  ) {
    pruneRetiredPowerBankCombatConfig(configName, context);
    return false;
  }

  // 与 shouldQueueConfig 的防御模式跳过保持一致：防御模式下不再为出房作
  // 战角色排队（任务侧会在后续 tick 转终态并走 prune 分支）。
  if (config.roomName && shouldSkipConfigInDefenseMode(config)) {
    return false;
  }

  return getConfigCreeps(configName, context).length === 0;
}

function queuePowerBankCombatConfig(
  spawns: StructureSpawn[],
  configName: string,
  config: CreepConfig,
  context: SpawnPlanningContext,
): void {
  if (!shouldQueuePowerBankCombatConfig(configName, config, context)) {
    return;
  }

  if (isConfigQueuedInSpawns(spawns, configName) || isConfigSpawning(configName, context)) {
    return;
  }

  const targetSpawn = selectLeastLoadedSpawn(spawns);
  if (targetSpawn) {
    queueConfig(targetSpawn, configName);
  }
}

function shouldQueueConfig(
  spawns: StructureSpawn[],
  estimateSpawn: StructureSpawn,
  configName: string,
  config: CreepConfig,
  context?: SpawnPlanningContext,
): boolean {
  if (fixedBodyExceedsCapacity(config, estimateSpawn.room.energyCapacityAvailable) || isSpawnConfigEconomicallyBlocked(configName, config)) return false;
  if (isConfigQueuedInSpawns(spawns, configName) || isConfigSpawning(configName, context || createSpawnPlanningContext())) {
    return false;
  }

  if (config.spawnOnce?.queuedAt !== undefined) {
    return false;
  }

  if (config.roomName && shouldSkipConfigInDefenseMode(config)) {
    return false;
  }

  if (config.role === "mineralHarvester") {
    const mineralId = getMineralIdFromConfig(config);
    if (mineralId) {
      const mineral = Game.getObjectById<Mineral>(mineralId);
      if (!mineral || mineral.mineralAmount <= 0) {
        return false;
      }
    } else {
      return false;
    }

    return shouldPreSpawnSourceWorker(estimateSpawn, configName, config, context);
  }

  if (
    config.role === "harvester" ||
    config.role === "miner" ||
    config.role === "colonizerHarvester"
  ) {
    return shouldPreSpawnSourceWorker(estimateSpawn, configName, config, context);
  }

  if (config.role === "carrier") {
    return shouldPreSpawnCarrier(estimateSpawn, configName, context);
  }

  if (config.role === "upgrader" || config.role === "hubUpgrader") {
    if (!isRcl8MaintenanceUpgraderConfig(configName, config)) {
      return false;
    }
    return shouldPreSpawnUpgrader(estimateSpawn, configName, context);
  }

  if (config.role === "remoteMiningReserver") {
    return shouldPreSpawnReserver(estimateSpawn, configName, context);
  }

  return getConfigCreeps(configName, context).length === 0;
}

function isWorkPositionOutsideSafeZone(roomName: string, workPos: RoomPosition | null): boolean {
  if (!workPos) {
    return false;
  }

  const safeZone = getSafeZone(roomName);
  if (safeZone.size === 0) {
    return false;
  }

  return workPos.roomName !== roomName || !isInsideSafeZone(workPos, safeZone);
}

function shouldSkipConfigInDefenseMode(config: CreepConfig): boolean {
  const roomName = config.roomName;
  if (!roomName || !isDefenseMode(roomName)) {
    return false;
  }

  if (getRoleSpawnIntent(config.role) !== "local") {
    return true;
  }

  if (config.role === "harvester" || config.role === "miner" || config.role === "mineralHarvester") {
    return isWorkPositionOutsideSafeZone(roomName, getSourceWorkerWorkPos(config));
  }

  return false;
}

function queueConfig(spawn: StructureSpawn, configName: string, options?: { toFront?: boolean }): void {
  const queue = ensureQueue(spawn);
  const config = getCreepConfigService().get(configName);

  if (options?.toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((item) => item !== configName)];
    if (config?.spawnOnce && config.spawnOnce.queuedAt === undefined) {
      config.spawnOnce.queuedAt = Game.time;
    }
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName);
    if (config?.spawnOnce && config.spawnOnce.queuedAt === undefined) {
      config.spawnOnce.queuedAt = Game.time;
    }
  }
}

function suppressRcl8MaintenanceReplacement(
  spawns: StructureSpawn[],
  configName: string,
  config: CreepConfig,
  context: SpawnPlanningContext,
): boolean {
  if (
    !isRcl8MaintenanceUpgraderConfig(configName, config) ||
    !getConfigCreeps(configName, context).some((creep) => creep.spawning !== true)
  ) {
    return false;
  }

  for (const spawn of spawns) {
    if (spawn.memory.spawnList?.includes(configName)) {
      spawn.memory.spawnList = spawn.memory.spawnList.filter((item) => item !== configName);
    }

    if (
      spawn.spawning &&
      Memory.creeps?.[spawn.spawning.name]?.configName === configName
    ) {
      spawn.spawning.cancel();
    }
  }

  return true;
}

function queueMissingConfig(
  spawns: StructureSpawn[],
  configName: string,
  config: CreepConfig,
  context: SpawnPlanningContext,
): void {
  if (suppressRcl8MaintenanceReplacement(spawns, configName, config, context)) {
    return;
  }

  const emergencySpawn = config.role === "carrier" && config.roomName
    ? findQueuedEmergencyCarrierSpawn(spawns, config.roomName)
    : undefined;
  const targetSpawn = emergencySpawn || selectLeastLoadedSpawn(spawns);
  if (!targetSpawn) {
    return;
  }

  if (shouldQueueConfig(spawns, targetSpawn, configName, config, context)) {
    const shouldInsertAtFront = isRcl8MaintenanceUpgraderConfig(configName, config) ||
      (!emergencySpawn && config.role === "carrier" && getConfigCreeps(configName, context).length === 0);
    queueConfig(targetSpawn, configName, { toFront: shouldInsertAtFront });
  }
}

function isConfigQueuedInSpawns(spawns: StructureSpawn[], configName: string): boolean {
  const activeSpawns = spawns.filter(isSpawnActive);
  const candidates = activeSpawns.length > 0 ? activeSpawns : spawns;
  return candidates.some((spawn) => isConfigQueued(spawn, configName));
}

function selectLeastLoadedSpawn(spawns: StructureSpawn[]): StructureSpawn | undefined {
  if (spawns.length === 0) return undefined;

  const activeSpawns = spawns.filter(isSpawnActive);
  const candidates = activeSpawns.length > 0 ? activeSpawns : spawns;

  return selectSpawnByLoad(candidates);
}

function findQueuedEmergencyCarrierSpawn(spawns: StructureSpawn[], roomName: string): StructureSpawn | undefined {
  const activeSpawns = spawns.filter(isSpawnActive);
  const candidates = activeSpawns.length > 0 ? activeSpawns : spawns;
  return candidates.find((spawn) =>
    spawn.memory.spawnList?.some((configName) => isEmergencyCarrierConfigName(roomName, configName)),
  );
}

function queuePowerBankHaulerConfig(
  spawns: StructureSpawn[],
  configName: string,
  config: CreepConfig,
  context: SpawnPlanningContext,
): void {
  if (spawns.length === 0) return;
  if (isPowerBankHaulingExhausted(configName, config)) return;
  if (isConfigQueuedInSpawns(spawns, configName)) return;
  if (isConfigSpawning(configName, context)) return;
  if (config.roomName && shouldSkipConfigInDefenseMode(config)) return;
  if (getConfigCreeps(configName, context).length > 0) return;

  const targetSpawn = selectLeastLoadedSpawn(spawns);
  if (targetSpawn) {
    queueConfig(targetSpawn, configName);
  }
}

interface ParsedPowerBankHaulerConfig {
  sourceRoom: string;
  targetRoom: string;
  index: number;
  ownerToken?: string;
  generation?: number;
}

type OwnedPowerBankConfig = CreepConfig & {
  taskId?: string;
  powerBankGeneration?: number;
};

function parsePowerBankHaulerConfigName(configName: string): ParsedPowerBankHaulerConfig | null {
  const parts = configName.split(":");
  if (parts.length !== 5 && parts.length !== 8) return null;
  if (parts[1] !== "powerbank" || parts[3] !== "hauler") return null;

  const index = Number(parts[4]);
  if (!Number.isSafeInteger(index) || index < 0) return null;

  const parsed: ParsedPowerBankHaulerConfig = {
    sourceRoom: parts[0],
    targetRoom: parts[2],
    index,
  };
  if (parts.length === 5) return parsed;

  const generationMatch = /^g(\d+)$/.exec(parts[7]);
  if (parts[5] !== "owner" || !/^[0-9a-z]{7}$/.test(parts[6]) || !generationMatch) return null;

  const generation = Number(generationMatch[1]);
  if (!Number.isSafeInteger(generation)) return null;
  parsed.ownerToken = parts[6];
  parsed.generation = generation;
  return parsed;
}

function taskMatchesPowerBankConfigRooms(
  task: PowerBankHarvestTask,
  parsed: ParsedPowerBankHaulerConfig,
): boolean {
  return task.sourceRoom === parsed.sourceRoom && task.targetRoom === parsed.targetRoom;
}

function findPowerBankHaulerOwnerTask(
  configName: string,
  config: CreepConfig,
  parsed: ParsedPowerBankHaulerConfig,
  tasks: Record<string, PowerBankHarvestTask>,
): PowerBankHarvestTask | undefined {
  const ownedConfig = config as OwnedPowerBankConfig;
  if (typeof ownedConfig.taskId === "string") {
    const task = tasks[ownedConfig.taskId];
    if (!task || !taskMatchesPowerBankConfigRooms(task, parsed)) return undefined;

    if (
      parsed.ownerToken !== undefined &&
      parsed.generation !== undefined &&
      getPowerBankConfigName(
        parsed.sourceRoom,
        parsed.targetRoom,
        "hauler",
        parsed.index,
        ownedConfig.taskId,
        parsed.generation,
      ) !== configName
    ) {
      return undefined;
    }

    if (
      parsed.generation !== undefined &&
      ownedConfig.powerBankGeneration !== undefined &&
      ownedConfig.powerBankGeneration !== parsed.generation
    ) {
      return undefined;
    }
    return task;
  }

  if (parsed.ownerToken !== undefined && parsed.generation !== undefined) {
    const ownerMatches = Object.entries(tasks).filter(([taskId, task]) =>
      taskMatchesPowerBankConfigRooms(task, parsed) &&
      getPowerBankConfigName(
        parsed.sourceRoom,
        parsed.targetRoom,
        "hauler",
        parsed.index,
        taskId,
        parsed.generation,
      ) === configName,
    );
    return ownerMatches.length === 1 ? ownerMatches[0][1] : undefined;
  }

  // Legacy configs have no provable owner. Preserve old tasks only when the
  // source/target pair identifies exactly one task; concurrent tasks must not
  // suppress each other's hauler requests.
  const legacyMatches = Object.values(tasks).filter((task) => taskMatchesPowerBankConfigRooms(task, parsed));
  return legacyMatches.length === 1 ? legacyMatches[0] : undefined;
}

function isPowerBankHaulingExhausted(configName: string, config: CreepConfig): boolean {
  const parsed = parsePowerBankHaulerConfigName(configName);
  if (!parsed) return false;

  const tasks = Memory.data?.powerBankHarvest;
  if (!tasks) return false;

  const ownerTask = findPowerBankHaulerOwnerTask(configName, config, parsed, tasks);
  return ownerTask?.status === "hauling" && ownerTask.haulingEmptySince !== undefined;
}

function prioritizeSpawnQueue(spawn: StructureSpawn): void {
  const queue = ensureQueue(spawn);
  if (queue.length < 2) {
    return;
  }

  let previousPriority = getSpawnConfigPriority(spawn.room.name, queue[0]);
  for (let index = 1; index < queue.length; index++) {
    const priority = getSpawnConfigPriority(spawn.room.name, queue[index]);
    if (priority < previousPriority) {
      spawn.memory.spawnList = [...queue]
        .map((configName, queueIndex) => {
          return {
            configName,
            index: queueIndex,
            priority: getSpawnConfigPriority(spawn.room.name, configName),
          };
        })
        .sort((a, b) => {
          if (a.priority !== b.priority) {
            return a.priority - b.priority;
          }

          return a.index - b.index;
        })
        .map((item) => item.configName);
      return;
    }

    previousPriority = priority;
  }
}

function hasLiveCarrierInRoom(roomName: string): boolean {
  return getTickContextService().getCreepsByRoom(roomName).some((creep) => creep.memory.role === "carrier");
}

function hasSpawningCarrierInRoom(roomName: string): boolean {
  const creepMemory = Memory.creeps || {};
  const creepConfigs = getCreepConfigService();
  for (const spawn of getTickContextService().getSpawnsByRoom(roomName)) {
    if (!spawn.spawning) {
      continue;
    }

    const spawningName = spawn.spawning.name;
    const spawningMemory = creepMemory[spawningName];
    if (spawningMemory?.role === "carrier") {
      return true;
    }

    const configName = spawningMemory?.configName;
    if (!configName) {
      continue;
    }

    const config = creepConfigs.get(configName);
    if (config?.role === "carrier") {
      return true;
    }
  }

  return false;
}

function isEmergencyCarrierConfigName(roomName: string, configName: string): boolean {
  return configName.startsWith(`${roomName}:manual:maxcarrier:`);
}

function isSpawnableEmergencyCarrierConfig(spawn: StructureSpawn, roomName: string, configName: string): boolean {
  if (!isEmergencyCarrierConfigName(roomName, configName)) {
    return false;
  }

  const config = getCreepConfigService().get(configName);
  if (config?.role !== "carrier" || config.roomName !== roomName || !config.body ||
      config.body.length === 0 || config.body.length > MAX_CREEP_SIZE) {
    return false;
  }

  const bodyCost = config.body.reduce((sum, part) => {
    const partCost = BODYPART_COST[part];
    return typeof partCost === "number" && Number.isFinite(partCost) ? sum + partCost : Number.NaN;
  }, 0);
  return Number.isFinite(bodyCost) && bodyCost <= spawn.room.energyCapacityAvailable;
}

function pruneEmergencyCarrierQueue(roomName: string, keepOne: boolean): boolean {
  const creepConfigs = getCreepConfigService();
  const spawns = getTickContextService().getSpawnsByRoom(roomName);
  const activeSpawns = spawns.filter(isSpawnActive);
  const eligibleSpawns = new Set(activeSpawns.length > 0 ? activeSpawns : spawns);
  let kept = false;

  for (const spawn of spawns) {
    const queue = spawn.memory.spawnList;
    if (!queue?.some((configName) => isEmergencyCarrierConfigName(roomName, configName))) {
      continue;
    }

    spawn.memory.spawnList = queue.filter((configName) => {
      if (!isEmergencyCarrierConfigName(roomName, configName)) {
        return true;
      }

      if (!isSpawnableEmergencyCarrierConfig(spawn, roomName, configName)) {
        creepConfigs.remove(configName);
        return false;
      }

      if (keepOne && !kept && eligibleSpawns.has(spawn)) {
        kept = true;
        return true;
      }

      creepConfigs.remove(configName);
      return false;
    });
  }

  return kept;
}

function ensureEmergencyCarrier(spawn: StructureSpawn): void {
  const roomName = spawn.room.name;
  const hasLiveCarrier = hasLiveCarrierInRoom(roomName);
  const hasSpawningCarrier = hasSpawningCarrierInRoom(roomName);
  const hasQueuedEmergencyCarrier = pruneEmergencyCarrierQueue(
    roomName,
    !hasLiveCarrier && !hasSpawningCarrier,
  );

  if (hasLiveCarrier || hasSpawningCarrier || hasQueuedEmergencyCarrier) {
    return;
  }

  spawnMaxCarrierRaw(roomName);
}

/** 无本地采矿单位且满体型无法支付时，先恢复收入，避免 carrier 队首永久等能量。 */
function ensureRecoveryHarvester(
  room: Room, spawns: StructureSpawn[], configs: Record<string, CreepConfig>, context: SpawnPlanningContext,
): boolean {
  if (!room.controller?.my) return false;
  const local = Object.entries(configs).filter(([name, config]) => config.roomName === room.name &&
    ((name.startsWith(`${room.name}:harvester:`) && config.role === "harvester") ||
     (name.startsWith(`${room.name}:miner:`) && config.role === "miner")));
  if (local.length === 0 || hasRoomSourceWorker(room.name)) return false;
  if (local.some(([name]) => isConfigSpawning(name, context))) return false;
  const prefix = `${room.name}:manual:bootstrapHarvester:`;
  if (Object.keys(configs).some(name => name.startsWith(prefix) &&
      (isConfigQueuedInSpawns(spawns, name) || isConfigSpawning(name, context)))) return true;
  const targetSpawn = selectLeastLoadedSpawn(spawns.filter(isSpawnActive));
  if (!targetSpawn || local.some(([name]) => getSpawnBody(targetSpawn, name)
    .reduce((sum, part) => sum + BODYPART_COST[part], 0) <= room.energyAvailable)) return false;
  if (room.energyAvailable < BODYPART_COST[WORK] + BODYPART_COST[MOVE]) return true;
  const entry = local.find(([, config]) => !shouldSkipConfigInDefenseMode(config) &&
    Game.getObjectById<Source>(config.args[0] as Id<Source>)?.energy);
  if (!entry) return false;
  const [, config] = entry;
  const body: BodyPartConstant[] = room.energyAvailable >= 250 ? [WORK, WORK, MOVE] : [WORK, MOVE];
  const name = `${prefix}${Game.time}`;
  getMemoryService().getCreepConfigStore()[name] = { role: "harvester", args: [config.args[0]], roomName: room.name, body };
  queueConfig(targetSpawn, name, { toFront: true });
  return true;
}

/**
 * RCL1 with zero creeps in the room: only queue one harvester and skip
 * everything else (carrier, workers, etc.) so the very first creep to
 * land is always a harvester, not a carrier.
 */
function tryQueueInitialHarvester(
  room: Room,
  spawns: StructureSpawn[],
  configs: Record<string, CreepConfig>,
  context: SpawnPlanningContext,
): boolean {
  if ((room.controller?.level ?? 0) !== 1) return false;
  if (getTickContextService().getCreepsByRoom(room.name).length > 0) return false;

  const harvesterEntry = Object.entries(configs).find(
    ([, cfg]) => cfg.roomName === room.name && cfg.role === "harvester",
  );
  const creepConfigs = getCreepConfigService();
  for (const configName of Object.keys(configs)) {
    if (isEmergencyCarrierConfigName(room.name, configName)) {
      creepConfigs.remove(configName);
    }
  }
  for (const spawn of spawns) {
    for (const configName of spawn.memory.spawnList ?? []) {
      const config = creepConfigs.get(configName);
      if (config?.spawnOnce?.queuedAt !== undefined && !isConfigSpawning(configName, context)) {
        delete config.spawnOnce.queuedAt;
      }
    }
    spawn.memory.spawnList = [];
  }
  if (!harvesterEntry) return true;

  const [configName] = harvesterEntry;
  if (!isConfigSpawning(configName, context)) {
    const targetSpawn = selectLeastLoadedSpawn(spawns);
    if (targetSpawn) {
      queueConfig(targetSpawn, configName);
    }
  }
  return true;
}

export function scheduleSpawnTasks(): void {
  const tickContext = getTickContextService();
  const planningContext = createSpawnPlanningContext();
  const spawnByRoom = new Map<string, StructureSpawn>();
  const spawnsByRoom = new Map<string, StructureSpawn[]>();
  for (const room of tickContext.getMyRooms()) {
    spawnsByRoom.set(room.name, tickContext.getSpawnsByRoom(room.name));
    const spawn = tickContext.getPrimarySpawnByRoom(room.name);
    if (spawn) {
      spawnByRoom.set(room.name, spawn);
    }
  }

  const initialConfigs = getCreepConfigService().list();

  // RCL1 rooms with no creeps get exactly one harvester queued; skip all other logic.
  const initialHarvesterRooms = new Set<string>();
  for (const room of tickContext.getMyRooms()) {
    const spawns = spawnsByRoom.get(room.name) ?? [];
    if (tryQueueInitialHarvester(room, spawns, initialConfigs, planningContext)) {
      initialHarvesterRooms.add(room.name);
    }
  }

  for (const spawn of spawnByRoom.values()) {
    if (!initialHarvesterRooms.has(spawn.room.name) && !ensureRecoveryHarvester(
      spawn.room, spawnsByRoom.get(spawn.room.name) ?? [], initialConfigs, planningContext,
    )) {
      ensureEmergencyCarrier(spawn);
    }
  }

  const configs = getCreepConfigService().list();
  for (const [configName, config] of Object.entries(configs)) {
    if (!config.roomName) {
      continue;
    }

    if (initialHarvesterRooms.has(config.roomName)) {
      continue;
    }

    if (config.role === "depositHarvester" && !canSpawnDepositConfig(configName, config)) continue;

    if (config.role === "powerBankHauler") {
      queuePowerBankHaulerConfig(spawnsByRoom.get(config.roomName) ?? [], configName, config, planningContext);
      continue;
    }

    if (config.role === "powerBankAttacker" || config.role === "powerBankHealer") {
      queuePowerBankCombatConfig(spawnsByRoom.get(config.roomName) ?? [], configName, config, planningContext);
      continue;
    }

    queueMissingConfig(spawnsByRoom.get(config.roomName) ?? [], configName, config, planningContext);
  }

  const knownConfigNames = new Set(Object.keys(getCreepConfigService().list()));
  for (const spawns of spawnsByRoom.values()) {
    reconcileSpawnQueueOwnership(spawns, {
      knownConfigNames,
      spawningConfigNames: planningContext.spawningConfigNames,
    });
  }

  for (const spawn of Array.from(spawnsByRoom.values()).flat()) {
    prioritizeSpawnQueue(spawn);
  }
}
