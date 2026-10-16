import {
  predictPowerBankRecovery,
  predictPowerBankFinishTicks,
  powerBankAttackSustainable,
} from "@/runtime/powerBankCapability";
import {
  POWER_BANK_STATUS,
  POWER_BANK_BODY_TIERS,
  POWER_BANK_BOOST_REQUIREMENTS,
  POWER_BANK_MAX_ROUTE_ROOMS,
  getPowerBankConfigName,
  isPowerBankSearchRoom,
} from "@/runtime/powerBankConstants";
import {
  ATTACK_POWER,
  POWER_BANK_ROOM_TRAVEL_TICKS,
  POWER_BANK_COMBAT_TTL_MARGIN,
  derivePowerBankTierProfile,
  planPowerBankTimeline,
  selectBodyTier,
  assessViability,
  type PowerBankTierProfile,
} from "@/runtime/powerBankViability";
import { findBestDonorRoom, prepareBoosts, releaseBoostLabs, type BoostPrepResult } from "@/runtime/powerBankBoost";
import {
  getActivePowerBankBoostLabIds,
  getAssignedPowerBankBoostLabId,
  getPowerBankBoostPrep,
} from "@/runtime/powerBankBoostMemory";
import { cleanupStaleDiscoveries, ensureDiscoveryStore } from "@/runtime/powerBankDiscovery";
import {
  getPowerBankRoomThreat,
  hasPowerBankObserverCoverage,
  requestPowerBankObservation,
} from "@/runtime/powerBankObserver";
import { canMeasurePowerBankTravelThisTick, measurePowerBankTravel } from "@/runtime/powerBankPathDistance";
import { getPowerBankSearchRooms } from "@/runtime/powerBankSearch";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { clearMovementState, moveToTarget } from "@/roles/shared";
import type { CreepConfig } from "@/types/system";
import {
  ensureResourceTransferTaskStore,
  isHealthyReceiverCapacityCommitment,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  ATTACK_PROGRESS_TIMEOUT,
  getPowerBankLifecycleFailure,
  initializePowerBankTaskRuntime,
  isTerminalPowerBankStatus,
  markPowerBankProgress,
  setPowerBankBlocker,
  transitionPowerBankTask,
  updatePowerBankObservation,
} from "@/runtime/powerBankTaskState";
import { recordPowerBankHistory } from "@/runtime/powerBankStatus";
import { spawnProfiles } from "@/config/spawnProfiles";
import { getPowerBankOwnedAvoidRooms } from "@/runtime/powerBankTransit";
import { isSpawnActive } from "@/runtime/tickContext";
import { getPowerBankAdmissionRoute } from "@/runtime/powerBankRouteCache";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import { hasPlanningCpuHeadroom } from "@/runtime/planningCpuBudget";

const PATROL_SCOUT_CONFIG_NAME = "powerbank:patrol:scout:0";

const MAX_POWER_BANK_HAULER_PAIRS = 25;
const UNSUPPORTED_ROUTE_RETRY_TICKS = 100;
const UNSUPPORTED_ROUTE_CACHE_LIMIT = 128;
// 仅保存当前走廊超出证明能力的否定结论，不授权移动或准入；global reset 即丢弃。
const unsupportedRouteRetries = new Map<string, number>();
let unsupportedRouteLastTick = -1;
const POWER_BANK_HAULER_ARRIVAL_BUFFER = 25;
const HAULING_EMPTY_CONFIRM_TICKS = 100;
const REINFORCEMENT_INDEX = 1;
const REINFORCEMENT_TTL_BUFFER = 75;
const REINFORCEMENT_TRAVEL_STALL_TICKS = 15;
const REINFORCEMENT_REPATH_COOLDOWN = 10;
const REINFORCEMENT_PROGRESS_HISTORY_LIMIT = 32;
const BOOST_FINISHED_STATUSES = new Set<string>([
  POWER_BANK_STATUS.TRAVELLING,
  POWER_BANK_STATUS.ATTACKING,
  POWER_BANK_STATUS.HAULING,
]);

type PowerBankCreepMemory = CreepMemory & { taskId?: string };
type PowerBankReinforcementCreepMemory = PowerBankCreepMemory & { powerBankReinforcementStage?: PowerBankReinforcementStage };
type PowerBankTravelMemory = PowerBankCreepMemory & { powerBankTravelTaskId?: string };

const POWER_BANK_BOOST_PARTS: Partial<Record<ResourceConstant, BodyPartConstant>> = {
  [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: TOUGH,
  [RESOURCE_CATALYZED_UTRIUM_ACID]: ATTACK,
  [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: HEAL,
};

function tierKindToNumber(tierKind: string): PowerBankHarvestTier {
  if (tierKind === "rcl8") return 8;
  if (tierKind === "rcl7") return 7;
  return 6;
}

function getTaskStore(): Record<string, PowerBankHarvestTask> {
  return ensureDiscoveryStore();
}

function getConfigStore(): Record<string, CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function isSameLegacyScope(task: PowerBankHarvestTask, other: PowerBankHarvestTask): boolean {
  return other.sourceRoom === task.sourceRoom && other.targetRoom === task.targetRoom;
}

function canUseLegacyTaskScope(task: PowerBankHarvestTask): boolean {
  const activeScopedTasks = Object.values(getTaskStore()).filter((candidate) =>
    !isTerminalPowerBankStatus(candidate.status) && isSameLegacyScope(task, candidate),
  );
  if (isTerminalPowerBankStatus(task.status)) return activeScopedTasks.length === 0;
  return activeScopedTasks.length === 1 && activeScopedTasks[0].id === task.id;
}

function getTaskConfigNames(task: PowerBankHarvestTask): string[] {
  const prefix = `${task.sourceRoom}:powerbank:${task.targetRoom}:`;
  const allowLegacy = canUseLegacyTaskScope(task);
  const names: string[] = [];
  const previousSourceNames: string[] = [];

  // 同一 bank 中止后重新发现可能改选 sourceRoom；旧源房名下仍挂着本任务
  // taskId 的配置必须保持可达，否则 hauling/terminal 清理永远扫不到它们，
  // 孵化器又会为这些孤儿配置无限重排（出生即自杀烧能量循环）。
  // 一次读取当前配置；保留旧版“本来源 prefix 在前、旧来源 taskId 在后”顺序。
  for (const [name, config] of Object.entries(getConfigStore())) {
    if (name.startsWith(prefix) &&
        (config.taskId === task.id || (config.taskId === undefined && allowLegacy))) {
      names.push(name);
    } else if (config.taskId === task.id) {
      previousSourceNames.push(name);
    }
  }

  return names.concat(previousSourceNames);
}

function getCombatGeneration(task: PowerBankHarvestTask, index: number): number {
  if (index === (task.activeIndex ?? 0)) return task.activeGeneration ?? 0;
  if (task.reinforcement?.index === index) {
    return task.reinforcement.generation ?? (task.activeGeneration ?? 0) + 1;
  }
  return index;
}

function getActiveCombatIndex(task: PowerBankHarvestTask): number {
  return task.activeIndex ?? 0;
}

function getCombatConfigName(task: PowerBankHarvestTask, role: "attacker" | "healer", index: number): string {
  return getPowerBankConfigName(
    task.sourceRoom,
    task.targetRoom,
    role,
    index,
    task.id,
    getCombatGeneration(task, index),
  );
}

function getCombatConfigNames(
  task: PowerBankHarvestTask,
  role: "attacker" | "healer",
  index: number,
): string[] {
  const owned = getCombatConfigName(task, role, index);
  if (!canUseLegacyTaskScope(task)) return [owned];
  const legacy = getPowerBankConfigName(task.sourceRoom, task.targetRoom, role, index);
  return legacy === owned ? [owned] : [owned, legacy];
}

function ensureCombatConfigs(task: PowerBankHarvestTask, index: number): boolean {
  if (!task.tier) return false;

  const tierBodies = POWER_BANK_BODY_TIERS[task.tier];
  if (!tierBodies) return false;

  const configStore = getConfigStore();
  const encodedRoute = task.routeRooms?.join("|") ?? "";
  const generation = getCombatGeneration(task, index);

  configStore[getCombatConfigName(task, "attacker", index)] = {
    role: "powerBankAttacker",
    args: [task.targetRoom, encodedRoute],
    roomName: task.sourceRoom,
    body: tierBodies.attacker,
    taskId: task.id,
    powerBankGeneration: generation,
  };

  configStore[getCombatConfigName(task, "healer", index)] = {
    role: "powerBankHealer",
    args: [task.targetRoom, encodedRoute],
    roomName: task.sourceRoom,
    body: tierBodies.healer,
    taskId: task.id,
    powerBankGeneration: generation,
  };

  return true;
}

function getCombatCreep(task: PowerBankHarvestTask, role: "attacker" | "healer", index: number): Creep | undefined {
  for (const configName of getCombatConfigNames(task, role, index)) {
    const creep = getAssignableCreepByConfigName(configName, task.id);
    if (creep) return creep;
  }
  return undefined;
}

function setReinforcementStage(creep: Creep | undefined, stage?: PowerBankReinforcementStage): void {
  if (!creep) return;
  const mem = creep.memory as PowerBankReinforcementCreepMemory;
  if (stage) {
    mem.powerBankReinforcementStage = stage;
  } else {
    delete mem.powerBankReinforcementStage;
  }
}

function ensureCombatTaskIds(task: PowerBankHarvestTask, index: number, stage?: PowerBankReinforcementStage): void {
  for (const role of ["attacker", "healer"] as const) {
    for (const configName of getCombatConfigNames(task, role, index)) {
      for (const creep of getTickContextService().getCreepsByConfigName(configName)) {
        const mem = creep.memory as PowerBankReinforcementCreepMemory;
        if (mem.taskId === undefined || mem.taskId === task.id) {
          mem.taskId = task.id;
          (mem as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration =
            getCombatGeneration(task, index);
          if (stage) mem.powerBankReinforcementStage = stage;
        }
      }
    }
  }
}

function removeSpawnQueueEntry(configName: string): void {
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (!spawn.memory.spawnList) continue;
      spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
    }
  }
}

/** 批量清理队列与空闲配置；每次调用重读可变 Memory，不跨调用缓存。 */
function cleanupConfigNames(configNames: readonly string[], queueRoomName?: string): void {
  if (configNames.length === 0) return;
  const names = new Set(configNames);
  const tickContext = getTickContextService();
  const ownedSpawns = tickContext.getMyRooms().flatMap(room => tickContext.getSpawnsByRoom(room.name));
  const queueSpawns = queueRoomName === undefined ? ownedSpawns : tickContext.getSpawnsByRoom(queueRoomName);
  for (const spawn of queueSpawns) {
    if (!spawn.memory.spawnList) continue;
    spawn.memory.spawnList = spawn.memory.spawnList.filter(name => !names.has(name));
  }
  const spawningConfigNames = new Set<string>();
  const creepMemory = Memory.creeps || {};
  for (const spawn of ownedSpawns) {
    if (!spawn.spawning) continue;
    const configName = creepMemory[spawn.spawning.name]?.configName;
    if (configName) spawningConfigNames.add(configName);
  }
  const store = getConfigStore();
  for (const name of names) {
    if (tickContext.getCreepsByConfigName(name).length === 0 && !spawningConfigNames.has(name)) {
      delete store[name];
    }
  }
}

function cleanupCombatConfig(task: PowerBankHarvestTask, role: "attacker" | "healer", index: number): void {
  const configName = getCombatConfigName(task, role, index);
  cleanupConfigNames([configName]);
}

function cleanupReinforcement(task: PowerBankHarvestTask): void {
  const reinforcement = task.reinforcement;
  const index = reinforcement?.index ?? REINFORCEMENT_INDEX;
  if (reinforcement?.boostOwnerId && task.sourceRoom) {
    releaseBoostLabs(reinforcement.boostOwnerId, task.sourceRoom);
  }
  cleanupCombatConfig(task, "attacker", index);
  cleanupCombatConfig(task, "healer", index);
  delete task.reinforcement;
}

function cleanupPrimaryCombat(task: PowerBankHarvestTask): void {
  const index = getActiveCombatIndex(task);
  cleanupCombatConfig(task, "attacker", index);
  cleanupCombatConfig(task, "healer", index);
}

function retireCombatGeneration(task: PowerBankHarvestTask, index: number): void {
  for (const role of ["attacker", "healer"] as const) {
    for (const configName of getCombatConfigNames(task, role, index)) {
      removeSpawnQueueEntry(configName);
      for (const creep of getTickContextService().getCreepsByConfigName(configName)) {
        const memory = creep.memory as PowerBankReinforcementCreepMemory;
        if (memory.taskId !== undefined && memory.taskId !== task.id) continue;
        delete memory.taskId;
        delete memory.powerBankReinforcementStage;
        creep.suicide();
      }
      delete getConfigStore()[configName];
    }
  }
}

function cleanupAllCombatConfigs(task: PowerBankHarvestTask): void {
  const names = getTaskConfigNames(task).filter(configName => {
    const parts = configName.split(":");
    const role = parts[3];
    return role === "attacker" || role === "healer";
  });
  cleanupConfigNames(names);
}

function cleanupInactiveCombatConfigs(task: PowerBankHarvestTask): void {
  const activeConfigNames = new Set<string>();
  const attacker = task.attackerId ? Game.getObjectById(task.attackerId as Id<Creep>) : null;
  const healer = task.healerId ? Game.getObjectById(task.healerId as Id<Creep>) : null;

  if (attacker?.memory.configName) activeConfigNames.add(attacker.memory.configName);
  if (healer?.memory.configName) activeConfigNames.add(healer.memory.configName);

  const names = getTaskConfigNames(task).filter(configName => {
    if (activeConfigNames.has(configName)) return false;
    const parts = configName.split(":");
    const role = parts[3];
    return role === "attacker" || role === "healer";
  });
  cleanupConfigNames(names);
}

function cleanupOrphanPowerBankConfigs(tasks: PowerBankHarvestTask[]): void {
  return measureSampledCpuPhase("orphanCleanup", () => cleanupOrphanPowerBankConfigsImpl(tasks));
}

function cleanupOrphanPowerBankConfigsImpl(tasks: PowerBankHarvestTask[]): void {
  const activeTasks = tasks.filter((task) => !isTerminalPowerBankStatus(task.status));
  const activeTaskIds = new Set(activeTasks.map((task) => task.id));
  const activePrefixes = new Set(activeTasks.map((task) => `${task.sourceRoom}:powerbank:${task.targetRoom}:`));

  const configs = getCreepConfigService().list();
  const orphanNames: string[] = [];
  for (const [configName, config] of Object.entries(configs)) {
    const parts = configName.split(":");
    if (parts[1] !== "powerbank") continue;
    if (configName === PATROL_SCOUT_CONFIG_NAME) continue;

    if (config.taskId) {
      if (activeTaskIds.has(config.taskId)) continue;
    } else {
      const prefix = `${parts[0]}:powerbank:${parts[2]}:`;
      if (activePrefixes.has(prefix)) continue;
    }

    orphanNames.push(configName);
  }
  cleanupConfigNames(orphanNames);
}

function cleanupTaskConfigs(task: PowerBankHarvestTask): void {
  cleanupConfigNames(getTaskConfigNames(task), task.sourceRoom);
}

function neutralizeTaskCreeps(task: PowerBankHarvestTask): void {
  const seen = new Set<string>();
  const creepIds = [task.attackerId, task.healerId].filter(Boolean);
  for (const creepId of creepIds) {
    const creep = Game.getObjectById(creepId as Id<Creep>);
    if (!creep) continue;
    seen.add(creep.name);
    const mem = creep.memory as PowerBankReinforcementCreepMemory;
    delete mem.taskId;
    delete mem.powerBankReinforcementStage;
    creep.memory.working = false;
  }

  for (const configName of getTaskConfigNames(task)) {
    for (const creep of getTickContextService().getCreepsByConfigName(configName)) {
      if (seen.has(creep.name)) continue;
      const mem = creep.memory as PowerBankReinforcementCreepMemory;
      delete mem.taskId;
      delete mem.powerBankReinforcementStage;
      creep.memory.working = false;
    }
  }
}

function transitionToTerminal(task: PowerBankHarvestTask, status: "failed" | "aborted" | "complete", reason?: string): void {
  transitionPowerBankTask(task, status, reason);
}

function transitionTask(task: PowerBankHarvestTask, status: PowerBankHarvestStatus): void {
  transitionPowerBankTask(task, status);
}

function getActiveDangerRooms(targetRoom?: string, ownedRooms = getPowerBankOwnedAvoidRooms()): string[] {
  return measureSampledCpuPhase("dangerMerge", () => getActiveDangerRoomsImpl(targetRoom, ownedRooms));
}

function getActiveDangerRoomsImpl(targetRoom: string | undefined, ownedRooms: string[]): string[] {
  const transient = Object.entries(Memory.runtime?.transitDangerRooms ?? {})
    .filter(([, expiresAt]) => expiresAt > Game.time)
    .map(([roomName]) => roomName);
  const permanent = Object.keys(Memory.runtime?.powerBankPermanentDangerRooms ?? {});
  return [...new Set([...transient, ...permanent, ...ownedRooms])]
    .filter((roomName) => roomName !== targetRoom);
}

function findSafeRoute(fromRoom: string, toRoom: string, dangerRooms?: readonly string[]): string[] | null {
  if (dangerRooms === undefined) {
    const ownedRooms = getPowerBankOwnedAvoidRooms();
    if (ownedRooms.includes(toRoom)) return null;
    dangerRooms = getActiveDangerRooms(toRoom, ownedRooms);
  }
  const avoidRooms = new Set(dangerRooms);
  const route = measureSampledCpuPhase("route.findRaw", () => Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: (roomName) => avoidRooms.has(roomName) ? Infinity : 1,
  }));
  if (route === ERR_NO_PATH) return null;

  const rooms = [fromRoom];
  for (const step of route) {
    if (rooms[rooms.length - 1] !== step.room) rooms.push(step.room);
  }
  if (rooms[rooms.length - 1] !== toRoom) rooms.push(toRoom);
  return rooms;
}

interface AdmissionDangerContext {
  ownedRooms: readonly string[];
  avoidRooms: readonly string[];
  sortedAvoidRooms: readonly string[];
}

function getUnsupportedRouteRetryAt(key: string): number | undefined {
  if (Game.time < unsupportedRouteLastTick) unsupportedRouteRetries.clear();
  unsupportedRouteLastTick = Game.time;
  const retryAt = unsupportedRouteRetries.get(key);
  if (retryAt !== undefined && Game.time < retryAt) {
    unsupportedRouteRetries.delete(key);
    unsupportedRouteRetries.set(key, retryAt);
    return retryAt;
  }
  unsupportedRouteRetries.delete(key);
  return undefined;
}

function rememberUnsupportedRoute(key: string): number {
  const retryAt = Game.time + UNSUPPORTED_ROUTE_RETRY_TICKS;
  unsupportedRouteRetries.delete(key);
  while (unsupportedRouteRetries.size >= UNSUPPORTED_ROUTE_CACHE_LIMIT) {
    unsupportedRouteRetries.delete(unsupportedRouteRetries.keys().next().value!);
  }
  unsupportedRouteRetries.set(key, retryAt);
  return retryAt;
}

/** 正路线有界跨 tick 复用；本次准入的危险集合与当前地图事实共同核验。 */
function getAdmissionSafeRoute(fromRoom: string, toRoom: string, danger: AdmissionDangerContext): string[] | null {
  if (danger.ownedRooms.includes(toRoom)) return null;
  return getPowerBankAdmissionRoute(fromRoom, toRoom, danger.sortedAvoidRooms,
    () => findSafeRoute(fromRoom, toRoom, danger.sortedAvoidRooms));
}

function getRouteDistance(fromRoom: string, toRoom: string): number {
  const route = findSafeRoute(fromRoom, toRoom);
  return route ? Math.max(0, route.length - 1) : Infinity;
}

function getLocalCompoundStock(
  room: Room,
  resource: ResourceConstant,
  ownerId?: string,
): number {
  return measureSampledCpuPhase("resources.localStock", () => getLocalCompoundStockImpl(room, resource, ownerId));
}

function getLocalCompoundStockImpl(
  room: Room,
  resource: ResourceConstant,
  ownerId?: string,
): number {
  let total = 0;
  if (room.storage) total += room.storage.store.getUsedCapacity(resource);
  if (room.terminal) total += room.terminal.store.getUsedCapacity(resource);
  const reservedLabIds = measureSampledCpuPhase("resources.reservedLabs", () => getActivePowerBankBoostLabIds(room.name, ownerId));
  for (const lab of measureSampledCpuPhase("context.labs", () => getTickContextService().getRoomContext(room)!.getLabs())) {
    if (!reservedLabIds.has(lab.id)) total += (lab.store.getUsedCapacity(resource) ?? 0);
  }
  return total;
}

function getTrustedIncomingCompound(
  roomName: string,
  resource: ResourceConstant,
  ownerId: string,
): number {
  return measureSampledCpuPhase("resources.incoming", () => getTrustedIncomingCompoundImpl(roomName, resource, ownerId));
}

function getTrustedIncomingCompoundImpl(
  roomName: string,
  resource: ResourceConstant,
  ownerId: string,
): number {
  let total = 0;
  const ownerReason = `powerBankBoost:${ownerId}`;
  for (const transfer of Object.values(ensureResourceTransferTaskStore())) {
    if (
      transfer.status !== "pending" ||
      transfer.toRoomName !== roomName ||
      transfer.resource !== resource ||
      transfer.reason !== ownerReason ||
      !isHealthyReceiverCapacityCommitment(transfer)
    ) {
      continue;
    }
    total += transfer.remainingAmount;
  }
  return total;
}

function hasCompoundSupply(
  room: Room,
  resource: ResourceConstant,
  amount: number,
  ownerId: string,
): boolean {
  return measureSampledCpuPhase("resources.supply", () => hasCompoundSupplyImpl(room, resource, amount, ownerId));
}

function hasCompoundSupplyImpl(
  room: Room,
  resource: ResourceConstant,
  amount: number,
  ownerId: string,
): boolean {
  const available = getLocalCompoundStock(room, resource, ownerId) +
    getTrustedIncomingCompound(room.name, resource, ownerId);
  const deficit = Math.max(0, amount - available);
  if (deficit <= 0) return true;
  return measureSampledCpuPhase("resources.donor", () => findBestDonorRoom(resource, deficit, [room.name])) !== null;
}

function getStructurePowerHeadroom(structure: StructureStorage | StructureTerminal | null | undefined): number {
  if (!structure) return 0;
  return Math.max(
    structure.store.getFreeCapacity(RESOURCE_POWER) ?? 0,
    structure.store.getFreeCapacity() ?? 0,
  );
}

function getPowerReceivingHeadroom(room: Room): number {
  return getStructurePowerHeadroom(room.terminal) + getStructurePowerHeadroom(room.storage);
}

function getSpawnReadyIn(roomName: string): number[] {
  return measureSampledCpuPhase("source.spawnQueue", () => getSpawnReadyInImpl(roomName));
}

function getSpawnReadyInImpl(roomName: string): number[] {
  const configStore = getConfigStore();
  return measureSampledCpuPhase("context.spawns", () => getTickContextService().getSpawnsByRoom(roomName))
    .filter(isSpawnActive)
    .map((spawn) => {
      let readyIn = spawn.spawning?.remainingTime ?? 0;
      for (const configName of spawn.memory.spawnList ?? []) {
        const config = configStore[configName];
        const bodyLength = config?.body?.length ?? (
          config
            ? spawnProfiles[config.role](spawn.room).length
            : 50
        );
        readyIn += bodyLength * CREEP_SPAWN_TIME;
      }
      return readyIn;
    });
}

interface PowerBankSourceCandidate {
  room: Room;
  roomName: string;
  tier: PowerBankHarvestTier;
  profile: PowerBankTierProfile;
  energyCapacity: number;
  distance: number;
  pathDistance: number;
  combatTravelTicks: number;
  haulerOutboundTravelTicks: number;
  haulerReturnTravelTicks: number;
  routeRooms: string[];
  avoidRooms: string[];
  spawnReadyIn: number[];
  receivingHeadroom: number;
  viability: ReturnType<typeof assessViability>;
  timeline: ReturnType<typeof planPowerBankTimeline>;
  slack: number;
}

function evaluateSourceCandidates(task: PowerBankHarvestTask): {
  candidates: PowerBankSourceCandidate[];
  rejectionReasons: string[];
  pendingRetryAt?: number;
} {
  return measureSampledCpuPhase("candidates", () => evaluateSourceCandidatesImpl(task));
}

function evaluateSourceCandidatesImpl(task: PowerBankHarvestTask): {
  candidates: PowerBankSourceCandidate[];
  rejectionReasons: string[];
  pendingRetryAt?: number;
} {
  const candidates: PowerBankSourceCandidate[] = [];
  const rejectionReasons: string[] = [];
  let pendingRetryAt: number | undefined;
  // 同步评估内没有危险记录 writer；各来源/Spawn 共用一次读取。惰性创建，
  // 无合格来源时不扫描 intel；下一次入口即使同 tick 也重新读取可变 Memory。
  let dangerContext: AdmissionDangerContext | undefined;
  let unsupportedRouteScope: string | undefined;
  const getDangerContext = (): AdmissionDangerContext => {
    if (!dangerContext) {
      const ownedRooms = getPowerBankOwnedAvoidRooms();
      const avoidRooms = getActiveDangerRooms(task.targetRoom, ownedRooms);
      dangerContext = { ownedRooms, avoidRooms, sortedAvoidRooms: [...avoidRooms].sort() };
    }
    return dangerContext;
  };
  const getUnsupportedRouteKey = (sourceRoom: string, danger: AdmissionDangerContext): string => {
    if (unsupportedRouteScope === undefined) {
      const observedWorldSize = typeof Game.map.getWorldSize === "function" ? Game.map.getWorldSize() : undefined;
      const worldSize = Number.isSafeInteger(observedWorldSize) && observedWorldSize! > 0 ? observedWorldSize : null;
      unsupportedRouteScope = JSON.stringify([Game.shard?.name ?? "unknown", worldSize, task.targetRoom, danger.sortedAvoidRooms]);
    }
    return JSON.stringify([sourceRoom, unsupportedRouteScope]);
  };

  // 只做房间级安全路线与来源基本资格预评估。先尝试短走廊，防止每 tick
  // 重测靠前的远来源，把有限 PF 配额耗尽后永远到不了已可行的近来源。
  const sourceRoutes: Array<{ room: Room; routeRooms: string[]; avoidRooms: readonly string[] }> = [];
  measureSampledCpuPhase("source.routes", () => {
    for (const room of measureSampledCpuPhase("context.myRooms", () => getTickContextService().getMyRooms())) {
      if (!room.controller || room.controller.level < 6 || isDefenseMode(room.name)) continue;
      if (!measureSampledCpuPhase("context.spawns", () => getTickContextService().getSpawnsByRoom(room.name))
        .some(isSpawnActive)) continue;
      if (!hasPlanningCpuHeadroom()) {
        pendingRetryAt = Game.time + 1;
        break;
      }
      const danger = getDangerContext();
      const unsupportedKey = getUnsupportedRouteKey(room.name, danger);
      const heldUntil = getUnsupportedRouteRetryAt(unsupportedKey);
      if (heldUntil !== undefined) {
        rejectionReasons.push(`${room.name}:unsupported_route_length`);
        pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, heldUntil);
        continue;
      }
      const routeRooms = getAdmissionSafeRoute(room.name, task.targetRoom, danger);
      if (!routeRooms) {
        rejectionReasons.push(`${room.name}:no_safe_route`);
        continue;
      }
      if (routeRooms.length > POWER_BANK_MAX_ROUTE_ROOMS) {
        rejectionReasons.push(`${room.name}:unsupported_route_length`);
        pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, rememberUnsupportedRoute(unsupportedKey));
        continue;
      }
      sourceRoutes.push({ room, routeRooms, avoidRooms: danger.avoidRooms });
    }
    sourceRoutes.sort((left, right) => left.routeRooms.length - right.routeRooms.length ||
      left.room.name.localeCompare(right.room.name));
  });

  for (const { room, routeRooms, avoidRooms } of sourceRoutes) {
    if (!canMeasurePowerBankTravelThisTick() || !hasPlanningCpuHeadroom()) {
      pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, Game.time + 1);
      break;
    }
    if (!room.controller || room.controller.level < 6) continue;
    if (isDefenseMode(room.name)) continue;

    const spawnReadyIn = getSpawnReadyIn(room.name);
    if (spawnReadyIn.length === 0) continue;

    const tierResult = selectBodyTier(room.energyCapacityAvailable);
    if (!tierResult) {
      rejectionReasons.push(`${room.name}:insufficient_energy_capacity`);
      continue;
    }
    const tier = tierKindToNumber(tierResult.attackerTier);
    const profile = derivePowerBankTierProfile(tier);
    if (!profile) continue;
    const ownerId = `${task.id}:primary:g${task.activeGeneration ?? 0}`;
    const reservedLabs = measureSampledCpuPhase("resources.reservedLabs", () => getActivePowerBankBoostLabIds(room.name, ownerId));
    const availableLabCount = measureSampledCpuPhase("context.labs", () => getTickContextService().getRoomContext(room)!.getLabs()
      .filter(lab => !reservedLabs.has(lab.id)).length);

    const compoundAvailability = new Map<ResourceConstant, boolean>();
    for (const [compound, amount] of profile.requiredCompounds) {
      compoundAvailability.set(compound, hasCompoundSupply(room, compound, amount, ownerId));
    }

    // 已能证明不可投入的资源/设施条件先完成评估，既不消耗测路预算，
    // 也不让一个没有 Lab energy 或接收设施的来源阻塞其余合格来源。
    const receivingHeadroom = getPowerReceivingHeadroom(room);
    const resourceReasons: string[] = [];
    if ([...profile.requiredCompounds.keys()].some((compound) => !compoundAvailability.get(compound))) {
      resourceReasons.push("insufficient_boost_compound");
    }
    if (availableLabCount < profile.requiredCompounds.size) resourceReasons.push("insufficient_labs");
    const requiredLabEnergy = [...profile.requiredCompounds.values()]
      .reduce((sum, mineralAmount) =>
        sum + Math.ceil(mineralAmount / LAB_BOOST_MINERAL) * LAB_BOOST_ENERGY, 0);
    if (getLocalCompoundStock(room, RESOURCE_ENERGY, ownerId) < requiredLabEnergy) {
      resourceReasons.push("insufficient_lab_energy");
    }
    if (receivingHeadroom <= 0 && !measureSampledCpuPhase("context.myRooms", () => getTickContextService().getMyRooms())
      .some((candidate) => getPowerReceivingHeadroom(candidate) > 0)) {
      resourceReasons.push("insufficient_power_headroom");
    }
    if (resourceReasons.length > 0) {
      rejectionReasons.push(...resourceReasons.map((reason) => `${room.name}:${reason}`));
      continue;
    }

    const distance = Math.max(0, routeRooms.length - 1);
    const haulerCapacity = getPowerBankHaulerCapacity(room.energyCapacityAvailable);
    const returnTarget = getStructurePowerHeadroom(room.terminal) > 0
      ? room.terminal
      : getStructurePowerHeadroom(room.storage) > 0
        ? room.storage
        : room.terminal ?? room.storage;
    const spawns = measureSampledCpuPhase("context.spawns", () => getTickContextService().getSpawnsByRoom(room.name))
      .filter(isSpawnActive);
    const measurements: Array<Extract<ReturnType<typeof measurePowerBankTravel>, { status: "ready" }>> = [];
    let sourcePending = false;
    for (const spawn of spawns) {
      if (!canMeasurePowerBankTravelThisTick() || !hasPlanningCpuHeadroom()) {
        sourcePending = true;
        pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, Game.time + 1);
        break;
      }
      if (!spawn.pos || !returnTarget?.pos) {
        sourcePending = true;
        pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, Game.time + 5);
        continue;
      }
      const measurement = measureSampledCpuPhase("measureRequest", () => measurePowerBankTravel({
        sourceSpawnPos: spawn.pos,
        bankPos: new RoomPosition(task.bankPos.x, task.bankPos.y, task.targetRoom),
        returnTargetPos: returnTarget.pos,
        routeRooms,
        avoidRooms: [...avoidRooms],
        profile,
        haulerCarryParts: Math.ceil(haulerCapacity / CARRY_CAPACITY),
      }));
      if (measurement.status === "pending") {
        sourcePending = true;
        pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, measurement.retryAt);
        if (measurement.reason === "invalid_input") {
          rejectionReasons.push(`${room.name}:invalid_measurement_input`);
          break;
        }
      } else {
        measurements.push(measurement);
      }
    }
    if (sourcePending || measurements.length !== spawns.length) continue;
    // 任一 active Spawn 都可能承接配置；全部测完后取保守上界，不能只用
    // 最先命中预算的近 Spawn 掩盖另一个尚未证实的来源。
    const travel = {
      pathDistance: Math.max(...measurements.map((value) => value.pathDistance)),
      combatTravelTicks: Math.max(...measurements.map((value) => value.combatTravelTicks)),
      haulerOutboundTravelTicks: Math.max(...measurements.map((value) => value.haulerOutboundTravelTicks)),
      haulerReturnTravelTicks: Math.max(...measurements.map((value) => value.haulerReturnTravelTicks)),
    };
    const viability = assessViability({
      energyCapacity: room.energyCapacityAvailable,
      bankHits: task.hits,
      bankPower: task.power,
      ticksToDecay: Math.max(0, (task.bankExpiresAt ?? (Game.time + task.ticksToDecay)) - Game.time),
      freeTiles: task.freeTiles,
      routeDistance: distance,
      ...travel,
      currentTick: Game.time,
      hasCompounds: {
        xgho2: compoundAvailability.get(RESOURCE_CATALYZED_GHODIUM_ALKALIDE) ?? true,
        xuh2o: compoundAvailability.get(RESOURCE_CATALYZED_UTRIUM_ACID) ?? true,
        xlho2: compoundAvailability.get(RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE) ?? true,
      },
      isDefenseMode: false,
      haulerCapacity,
      spawnCount: spawnReadyIn.length,
      spawnReadyIn,
    });
    const timeline = planPowerBankTimeline({
      profile,
      currentTick: Game.time,
      bankHits: task.hits,
      bankPower: task.power,
      freeTiles: task.freeTiles,
      routeDistance: distance,
      ...travel,
      haulerCapacity,
      spawnReadyIn,
    });
    const reasons = [...viability.reasons];
    if (reasons.length > 0) {
      rejectionReasons.push(...reasons.map((reason) => `${room.name}:${reason}`));
      continue;
    }

    const expiresAt = task.bankExpiresAt ?? (Game.time + task.ticksToDecay);
    candidates.push({
      room,
      roomName: room.name,
      tier,
      profile,
      energyCapacity: room.energyCapacityAvailable,
      distance,
      ...travel,
      routeRooms,
      avoidRooms: [...avoidRooms],
      spawnReadyIn,
      receivingHeadroom,
      viability,
      timeline,
      slack: expiresAt - timeline.killTick,
    });
  }

  candidates.sort((left, right) =>
    right.slack - left.slack ||
    right.receivingHeadroom - left.receivingHeadroom ||
    left.pathDistance - right.pathDistance ||
    left.distance - right.distance ||
    left.roomName.localeCompare(right.roomName),
  );
  return { candidates, rejectionReasons: [...new Set(rejectionReasons)], pendingRetryAt };
}

function getPowerBankHaulerCapacity(energyCapacity: number): number {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(MAX_POWER_BANK_HAULER_PAIRS, Math.floor(energyCapacity / pairCost)));
  return pairCount * CARRY_CAPACITY;
}

function getPowerBankHaulerSpawnTime(energyCapacity: number): number {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(MAX_POWER_BANK_HAULER_PAIRS, Math.floor(energyCapacity / pairCost)));
  return pairCount * 2 * CREEP_SPAWN_TIME;
}

function estimateHaulerBatchSpawnTicks(task: PowerBankHarvestTask, energyCapacity: number): number {
  const haulerCount = getRequiredHaulerCount(task);
  const singleHaulerSpawnTime = getPowerBankHaulerSpawnTime(energyCapacity);
  const spawnReadyIn = getSpawnReadyIn(task.sourceRoom);
  if (spawnReadyIn.length === 0) return Infinity;

  const lanes = [...spawnReadyIn];
  const completionTicks: number[] = [];
  for (let index = 0; index < haulerCount; index += 1) {
    let laneIndex = 0;
    for (let candidate = 1; candidate < lanes.length; candidate += 1) {
      if (lanes[candidate] < lanes[laneIndex]) laneIndex = candidate;
    }
    lanes[laneIndex] += singleHaulerSpawnTime;
    completionTicks.push(lanes[laneIndex]);
  }
  return Math.max(0, ...completionTicks);
}

function estimateOneWayRoomTravelTicks(task: PowerBankHarvestTask): number {
  if (task.haulerOutboundTravelTicks !== undefined) return task.haulerOutboundTravelTicks;
  const routeDistance = task.routeDistance ?? getRouteDistance(task.sourceRoom, task.targetRoom);
  if (!Number.isFinite(routeDistance)) {
    return Infinity;
  }
  return Math.ceil(routeDistance * POWER_BANK_ROOM_TRAVEL_TICKS);
}

function estimateRemainingAttackTicks(bank: StructurePowerBank, attacker: Creep, healer?: Creep): number {
  return predictPowerBankFinishTicks(bank.hits, attacker, healer);
}

function shouldSpawnHaulers(task: PowerBankHarvestTask, bank: StructurePowerBank, attacker: Creep, healer: Creep): boolean {
  if (task.attackStartedTick === undefined) return false;

  const sourceRoom = Game.rooms[task.sourceRoom];
  const energyCapacity = sourceRoom?.energyCapacityAvailable ?? 0;
  const spawnTime = estimateHaulerBatchSpawnTicks(task, energyCapacity);
  const travelTime = estimateOneWayRoomTravelTicks(task);
  const remainingAttackTicks = estimateRemainingAttackTicks(bank, attacker, healer);
  if (!Number.isFinite(travelTime) || !Number.isFinite(remainingAttackTicks)) {
    return false;
  }
  task.plannedKillTick = Game.time + remainingAttackTicks;
  task.plannedHaulerSpawnStartTick = Math.max(task.attackStartedTick, task.plannedKillTick - spawnTime - travelTime - POWER_BANK_HAULER_ARRIVAL_BUFFER);
  task.plannedHaulerArrivalTick = Math.max(Game.time, task.plannedHaulerSpawnStartTick) + spawnTime + travelTime;
  return remainingAttackTicks <= spawnTime + travelTime + POWER_BANK_HAULER_ARRIVAL_BUFFER;
}

/** 边界的0/49落点重合，用49格房间坐标求剩余移动下界；不把房数硬乘50。 */
function minimumRemainingTravel(pos: RoomPosition, goal: RoomPosition): number {
  const point = (p: RoomPosition): readonly [number, number] | null => {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(p.roomName);
    if (!match || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const x = match[1] === "E" ? Number(match[2]) : -Number(match[2]) - 1;
    const y = match[3] === "S" ? Number(match[4]) : -Number(match[4]) - 1;
    return [x * 49 + p.x, y * 49 + p.y];
  };
  const a = point(pos), b = point(goal);
  return a && b ? Math.max(0, Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) - 1) : 0;
}

function abortUnfinishablePair(task: PowerBankHarvestTask, bank: StructurePowerBank, pair: ActivePowerBankPair): boolean {
  const finish = estimateRemainingAttackTicks(bank, pair.attacker, pair.healer);
  const travel = Math.max(minimumRemainingTravel(pair.attacker.pos, bank.pos), minimumRemainingTravel(pair.healer.pos, bank.pos));
  const ttl = Math.min(pair.attacker.ticksToLive ?? CREEP_LIFE_TIME, pair.healer.ticksToLive ?? CREEP_LIFE_TIME);
  if (finish + travel + POWER_BANK_COMBAT_TTL_MARGIN < ttl) return false;
  // 即使理想通路下也不能一队完成：停止投入，现役空载成员通过共用交通回收。
  const configs = new Set(getTaskConfigNames(task));
  for (const name of configs) {
    for (const creep of getTickContextService().getCreepsByConfigName(name)) {
      if ((creep.memory as PowerBankCreepMemory).taskId !== undefined && (creep.memory as PowerBankCreepMemory).taskId !== task.id) continue;
      if ((creep.store?.getUsedCapacity() ?? 0) > 0) continue;
      creep.memory._recycleToRoom = task.sourceRoom;
      clearMovementState(creep);
    }
  }
  for (const spawn of Object.values(Game.spawns)) {
    const spawning = spawn.spawning;
    const name = spawning && (Game.creeps[spawning.name]?.memory ?? Memory.creeps?.[spawning.name])?.configName;
    if (spawning && name && configs.has(name) && typeof spawning.cancel === "function") spawning.cancel();
  }
  for (const actor of [pair.attacker, pair.healer]) {
    actor.memory._recycleToRoom = task.sourceRoom;
    clearMovementState(actor);
  }
  transitionToTerminal(task, "aborted", "one_pair_runtime_ttl_insufficient");
  return true;
}

function getRequiredHaulerCount(task: PowerBankHarvestTask): number {
  if (task.haulerCount !== undefined) return task.haulerCount;

  const room = Game.rooms[task.sourceRoom];
  const energyCapacity = room?.energyCapacityAvailable ?? 0;
  const haulerCapacity = getPowerBankHaulerCapacity(energyCapacity);
  return Math.max(1, Math.ceil(task.power / haulerCapacity));
}

function getTaskHaulers(task: PowerBankHarvestTask): Creep[] {
  const haulers: Creep[] = [];
  for (const configName of getTaskConfigNames(task)) {
    if (!configName.includes(":hauler:")) continue;
    haulers.push(...getTickContextService().getCreepsByConfigName(configName));
  }
  return haulers;
}

function ensureHaulerConfigs(task: PowerBankHarvestTask): void {
  if (!task.sourceRoom) return;

  const configStore = getConfigStore();
  const haulerCount = getRequiredHaulerCount(task);
  task.haulerCount = haulerCount;
  const encodedRoute = task.routeRooms?.join("|") ?? "";

  for (let index = 0; index < haulerCount; index += 1) {
    const configName = getPowerBankConfigName(
      task.sourceRoom,
      task.targetRoom,
      "hauler",
      index,
      task.id,
      0,
    );
    configStore[configName] = {
      role: "powerBankHauler",
      args: [task.targetRoom, encodedRoute],
      roomName: task.sourceRoom,
      taskId: task.id,
      powerBankGeneration: 0,
    };

    for (const creep of getTickContextService().getCreepsByConfigName(configName)) {
      const mem = creep.memory as PowerBankCreepMemory;
      if (mem.taskId === undefined || mem.taskId === task.id) {
        mem.taskId = task.id;
      }
    }
  }
}

function getAssignableCreepByConfigName(configName: string, taskId: string): Creep | undefined {
  return getTickContextService().getCreepsByConfigName(configName).find((creep) => {
    const mem = creep.memory as PowerBankCreepMemory;
    return mem.taskId === undefined || mem.taskId === taskId;
  });
}

function processDiscovered(task: PowerBankHarvestTask): void {
  return measureSampledCpuPhase("discovered", () => processDiscoveredImpl(task));
}

function processDiscoveredImpl(task: PowerBankHarvestTask): void {
  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) {
    requestPowerBankObservation(task.targetRoom);
    setPowerBankBlocker(task, "target_not_visible", 1);
    return;
  }
  const bank = targetRoom.find(FIND_STRUCTURES).find(
    (structure): structure is StructurePowerBank => structure.structureType === STRUCTURE_POWER_BANK && structure.id === task.bankId,
  );
  if (!bank) {
    requestPowerBankObservation(task.targetRoom);
    setPowerBankBlocker(task, "target_bank_unconfirmed", 1);
    return;
  }
  if (getPowerBankRoomThreat(targetRoom)) {
    requestPowerBankObservation(task.targetRoom);
    setPowerBankBlocker(task, "target_combat_threat", 5);
    return;
  }
  updatePowerBankObservation(task, bank);
  task.bankPos = { x: bank.pos.x, y: bank.pos.y };
  // discovered 准入可顺延，战斗/运输/生命周期仍由其它分支照常处理。
  // CPU 不足时底层测量不消费配额，单看次数会让所有任务反复扫描来源；
  // 因此在昂贵评估前检查余量，已有 cached-ready 的新准入也等余量恢复。
  // 当前视野、Bank、威胁与观测更新已经完成，等待不冒充失败或取得名额。
  if (!canMeasurePowerBankTravelThisTick() || !hasPlanningCpuHeadroom()) {
    requestPowerBankObservation(task.targetRoom);
    setPowerBankBlocker(task, "path_measurement_pending", 1);
    return;
  }
  const evaluation = evaluateSourceCandidates(task);
  // 只有实际耗尽当帧新测量预算才计作获得过名额。失去视野、退避或
  // 资源不合格不能把等待任务排到队尾；记录随任务存活，global reset 不清零。
  if (!canMeasurePowerBankTravelThisTick()) task.admissionLastMeasuredAt = Game.time;
  const selected = evaluation.candidates[0];
  if (!selected && evaluation.pendingRetryAt !== undefined) {
    requestPowerBankObservation(task.targetRoom);
    setPowerBankBlocker(task, "path_measurement_pending", Math.max(1, evaluation.pendingRetryAt - Game.time));
    return;
  }
  if (!selected) {
    const reasons = evaluation.rejectionReasons.length > 0
      ? evaluation.rejectionReasons.join(",")
      : "no_eligible_source_room";
    transitionToTerminal(task, "failed", reasons);
    return;
  }

  // 只声明当前已证明候选中的最佳来源。其他来源尚未获得完整几何证据
  // 不等于不可达，也不能无限否决此来源所有 Spawn 已完成的准入证明。

  task.sourceRoom = selected.roomName;
  task.tier = selected.tier;
  task.routeDistance = selected.distance;
  task.pathDistance = selected.pathDistance;
  task.combatTravelTicks = selected.combatTravelTicks;
  task.haulerOutboundTravelTicks = selected.haulerOutboundTravelTicks;
  task.haulerReturnTravelTicks = selected.haulerReturnTravelTicks;
  task.routeRooms = selected.routeRooms;
  task.avoidRooms = selected.avoidRooms;
  task.haulerCount = selected.timeline.haulerCount;
  task.plannedDps = selected.profile.dpsPerAttacker;
  task.plannedHps = selected.profile.healerHPS;
  task.plannedTtk = selected.timeline.ttk;
  task.plannedKillTick = selected.timeline.killTick;
  task.plannedHaulerSpawnStartTick = selected.timeline.haulerSpawnStartTick;
  task.plannedHaulerArrivalTick = selected.timeline.haulerArrivalTick;
  task.minimumCombatTtl = Math.min(
    CREEP_LIFE_TIME - 25,
    selected.timeline.travelTime + selected.timeline.ttk + selected.timeline.boostPrepTime + POWER_BANK_COMBAT_TTL_MARGIN,
  );
  task.activeGeneration = 0;
  task.activeIndex = 0;
  task.primaryBoostOwnerId = `${task.id}:primary:g0`;
  task.primaryBoostLabs = [];
  task.combatReady = false;
  transitionTask(task, POWER_BANK_STATUS.PREPARING_BOOSTS);
}

function getPrimaryBoostOwner(task: PowerBankHarvestTask): string {
  task.primaryBoostOwnerId ??= getPowerBankBoostPrep(task.id) || task.boostLabs.length > 0
    ? task.id
    : `${task.id}:primary:g${task.activeGeneration ?? 0}`;
  return task.primaryBoostOwnerId;
}

function getReinforcementBoostOwner(
  task: PowerBankHarvestTask,
  reinforcement: PowerBankReinforcementState,
): string {
  reinforcement.generation ??= (task.activeGeneration ?? 0) + 1;
  reinforcement.boostOwnerId ??=
    `${task.id}:reinforcement:g${reinforcement.generation}`;
  return reinforcement.boostOwnerId;
}

function refreshPowerBankBoostPrep(
  task: PowerBankHarvestTask,
  ownerId: string,
  requiredAmounts?: ReadonlyMap<ResourceConstant, number>,
): BoostPrepResult {
  if (!task.tier) return { status: "ready", labs: [] };
  const result = prepareBoosts(
    ownerId,
    task.sourceRoom,
    task.tier,
    requiredAmounts,
    { requireLabEnergy: true },
  );
  if (ownerId === getPrimaryBoostOwner(task)) {
    task.primaryBoostLabs = result.labs;
    task.boostLabs = result.labs;
  } else if (task.reinforcement?.boostOwnerId === ownerId) {
    task.reinforcement.boostLabs = result.labs;
  }
  return result;
}

function processPreparingBoosts(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  if (!task.tier) {
    transitionToTerminal(task, "failed", "missing_tier");
    return;
  }

  const result = refreshPowerBankBoostPrep(task, getPrimaryBoostOwner(task));

  if (result.status === "ready" || (result.status === "preparing" && result.labs.length > 0)) {
    transitionTask(task, POWER_BANK_STATUS.SPAWNING);
  } else if (result.status === "failed") {
    transitionToTerminal(task, "failed", result.reason ?? "boost_prep_failed");
  }
}

function processSpawning(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  if (!task.tier) {
    transitionToTerminal(task, "failed", "missing_tier");
    return;
  }

  const boostResult = refreshPowerBankBoostPrep(task, getPrimaryBoostOwner(task));
  if (boostResult.status === "failed") {
    transitionToTerminal(task, "failed", boostResult.reason ?? "boost_prep_failed_during_spawning");
    return;
  }

  if (!ensureCombatConfigs(task, getActiveCombatIndex(task))) {
    transitionToTerminal(task, "failed", "invalid_tier");
    return;
  }

  transitionTask(task, POWER_BANK_STATUS.RENEWING);
}

function getRequiredBoostsForRole(tier: number, role: "attacker" | "healer"): ResourceConstant[] {
  const requirements = POWER_BANK_BOOST_REQUIREMENTS[tier];
  if (!requirements) return [];
  return requirements[role];
}

function getBoostedPartType(compound: ResourceConstant): BodyPartConstant | undefined {
  return POWER_BANK_BOOST_PARTS[compound];
}

function countBodyPartsForBoost(body: BodyPartConstant[], compound: ResourceConstant): number {
  const partType = getBoostedPartType(compound);
  if (!partType) return 0;
  return body.filter((part) => part === partType).length;
}

function countRemainingBoostParts(creep: Creep, compound: ResourceConstant): number {
  const partType = getBoostedPartType(compound);
  if (!partType) return 0;
  return creep.body.filter((part) => part.type === partType && part.hits > 0 && part.boost !== compound).length;
}

function addRemainingBoostAmountsForRole(
  amounts: Map<ResourceConstant, number>,
  tier: number,
  role: "attacker" | "healer",
  creep: Creep | null,
): void {
  const requirements = getRequiredBoostsForRole(tier, role);
  const tierBodies = POWER_BANK_BODY_TIERS[tier];
  if (!tierBodies) return;

  for (const compound of requirements) {
    const partCount = creep
      ? countRemainingBoostParts(creep, compound)
      : countBodyPartsForBoost(tierBodies[role], compound);
    if (partCount <= 0) continue;
    amounts.set(compound, (amounts.get(compound) ?? 0) + partCount * LAB_BOOST_MINERAL);
  }
}

function getRemainingBoostAmounts(
  tier: number,
  attacker: Creep | null,
  healer: Creep | null,
): Map<ResourceConstant, number> {
  const amounts = new Map<ResourceConstant, number>();
  addRemainingBoostAmountsForRole(amounts, tier, "attacker", attacker);
  addRemainingBoostAmountsForRole(amounts, tier, "healer", healer);
  return amounts;
}

function isBoostSatisfied(creep: Creep, requiredCompounds: ResourceConstant[]): boolean {
  if (requiredCompounds.length === 0) return true;
  return requiredCompounds.every((compound) =>
    countRemainingBoostParts(creep, compound) === 0,
  );
}

function getNextMissingBoost(creep: Creep, requiredCompounds: ResourceConstant[]): ResourceConstant | undefined {
  return requiredCompounds.find((compound) =>
    countRemainingBoostParts(creep, compound) > 0,
  );
}

function applyNextBoost(
  creep: Creep,
  ownerId: string,
  requiredCompounds: ResourceConstant[],
): { status: "boosted" | "moving" | "waiting" | "no_lab" | "no_resources" | "fatal"; code?: ScreepsReturnCode } {
  if (isBoostSatisfied(creep, requiredCompounds)) return { status: "boosted" };

  const nextCompound = getNextMissingBoost(creep, requiredCompounds);
  if (!nextCompound) return { status: "boosted" };

  const labId = getAssignedPowerBankBoostLabId(ownerId, nextCompound);
  if (!labId) return { status: "no_lab" };

  const lab = Game.getObjectById(labId as Id<StructureLab>);
  if (!lab) return { status: "no_lab" };

  if (
    (lab.store.getUsedCapacity(nextCompound) ?? 0) < LAB_BOOST_MINERAL ||
    (lab.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) < LAB_BOOST_ENERGY
  ) {
    return { status: "no_resources" };
  }

  if (creep.pos.isNearTo(lab)) {
    const code = lab.boostCreep(creep);
    if (code === OK) return { status: "boosted", code };
    if (code === ERR_TIRED || code === ERR_BUSY || code === ERR_NOT_ENOUGH_RESOURCES) {
      return {
        status: code === ERR_NOT_ENOUGH_RESOURCES ? "no_resources" : "waiting",
        code,
      };
    }
    if (code !== ERR_NOT_IN_RANGE) return { status: "fatal", code };
  }

  moveToTarget(creep, lab, 1, { reusePath: 3, maxRooms: 1 });
  return { status: "moving", code: ERR_NOT_IN_RANGE };
}

function handleBoostApplyResult(
  task: PowerBankHarvestTask,
  role: "attacker" | "healer",
  result: ReturnType<typeof applyNextBoost>,
): boolean {
  if (result.status === "fatal") {
    transitionToTerminal(task, "aborted", `boost_${role}_error:${result.code ?? "unknown"}`);
    return false;
  }
  if (result.status === "no_lab" || result.status === "no_resources" || result.status === "waiting") {
    setPowerBankBlocker(task, `boost_${role}_${result.status}`, 3);
  }
  return true;
}

function processBoosting(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  const activeIndex = getActiveCombatIndex(task);
  const attacker = getCombatCreep(task, "attacker", activeIndex);
  const healer = getCombatCreep(task, "healer", activeIndex);

  const tier = task.tier ?? 8;
  const ownerId = getPrimaryBoostOwner(task);
  const boostResult = refreshPowerBankBoostPrep(
    task,
    ownerId,
    getRemainingBoostAmounts(tier, attacker ?? null, healer ?? null),
  );
  if (boostResult.status === "failed") {
    transitionToTerminal(task, "failed", boostResult.reason ?? "boost_prep_failed_during_boosting");
    return;
  }
  if (!attacker && !healer) return;

  const attackerCompounds = getRequiredBoostsForRole(tier, "attacker");
  const healerCompounds = getRequiredBoostsForRole(tier, "healer");

  if (attacker) {
    if (!handleBoostApplyResult(task, "attacker", applyNextBoost(attacker, ownerId, attackerCompounds))) return;
  }
  if (healer) {
    if (!handleBoostApplyResult(task, "healer", applyNextBoost(healer, ownerId, healerCompounds))) return;
  }

  const attackerReady = !!attacker && isBoostSatisfied(attacker, attackerCompounds);
  const healerReady = !!healer && isBoostSatisfied(healer, healerCompounds);

  task.attackerReady = attackerReady;
  task.healerReady = healerReady;

  if (attacker && healer && attackerReady && healerReady) {
    task.attackerId = attacker.id as string;
    task.healerId = healer.id as string;
    task.combatReady = true;
    const generation = task.activeGeneration ?? 0;
    const attackerMemory = attacker.memory as PowerBankCreepMemory & { pairGeneration?: number };
    const healerMemory = healer.memory as PowerBankCreepMemory & { pairGeneration?: number };
    attackerMemory.taskId = task.id;
    attackerMemory.pairGeneration = generation;
    healerMemory.taskId = task.id;
    healerMemory.pairGeneration = generation;
    releaseFinishedBoostLabs(task, ownerId, true);
    transitionTask(task, POWER_BANK_STATUS.TRAVELLING);
  }
}

function releaseFinishedBoostLabs(
  task: PowerBankHarvestTask,
  ownerId = getPrimaryBoostOwner(task),
  primary = ownerId === getPrimaryBoostOwner(task),
): void {
  if (!task.sourceRoom) return;
  const labs = primary
    ? task.primaryBoostLabs ?? task.boostLabs
    : task.reinforcement?.boostLabs ?? [];
  if (labs.length === 0 && !getPowerBankBoostPrep(ownerId)) return;

  releaseBoostLabs(ownerId, task.sourceRoom);
  if (primary) {
    task.primaryBoostLabs = [];
    task.boostLabs = [];
  } else if (task.reinforcement?.boostOwnerId === ownerId) {
    task.reinforcement.boostLabs = [];
  }
}

function isCreepBoosted(creep: Creep): boolean {
  return creep.body.some((part) => !!part.boost);
}

function getMinimumCombatTtl(task: PowerBankHarvestTask): number {
  if (task.minimumCombatTtl !== undefined) return task.minimumCombatTtl;
  const travel = task.combatTravelTicks ?? Math.ceil((task.routeDistance ?? 5) * POWER_BANK_ROOM_TRAVEL_TICKS);
  return Math.min(CREEP_LIFE_TIME - 25, travel + 100);
}

function attemptRenewCreep(
  task: PowerBankHarvestTask,
  creep: Creep,
  role: "attacker" | "healer",
  minimumTtl: number,
): "ready" | "waiting" | "fatal" {
  if ((creep.ticksToLive ?? CREEP_LIFE_TIME) >= minimumTtl) return "ready";
  if (isCreepBoosted(creep)) {
    transitionToTerminal(task, "aborted", `boosted_${role}_ttl_insufficient`);
    return "fatal";
  }

  const spawns = getTickContextService().getSpawnsByRoom(task.sourceRoom)
    .filter((spawn) => typeof spawn.isActive !== "function" || spawn.isActive());
  const spawn = spawns.find((candidate) => creep.pos.isNearTo(candidate)) ?? spawns[0];
  if (!spawn) {
    setPowerBankBlocker(task, "renew_spawn_unavailable", 5);
    return "waiting";
  }

  const code = spawn.renewCreep(creep);
  if (code === OK) {
    markPowerBankProgress(task);
    return "waiting";
  }
  if (code === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, spawn, 1, { reusePath: 3, maxRooms: 1 });
    setPowerBankBlocker(task, `renew_${role}_not_in_range`, 1);
    return "waiting";
  }
  if (code === ERR_BUSY || code === ERR_NOT_ENOUGH_ENERGY || code === ERR_FULL) {
    setPowerBankBlocker(task, `renew_${role}_blocked:${code}`, 3);
    return code === ERR_FULL ? "ready" : "waiting";
  }

  transitionToTerminal(task, "aborted", `renew_${role}_error:${code}`);
  return "fatal";
}

function processRenewing(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  const boostResult = refreshPowerBankBoostPrep(task, getPrimaryBoostOwner(task));
  if (boostResult.status === "failed") {
    transitionToTerminal(task, "failed", boostResult.reason ?? "boost_prep_failed_during_renewing");
    return;
  }

  const activeIndex = getActiveCombatIndex(task);
  const attacker = getCombatCreep(task, "attacker", activeIndex);
  const healer = getCombatCreep(task, "healer", activeIndex);

  if (!attacker || !healer) {
    task.combatReady = false;
    task.attackerReady = !!attacker;
    task.healerReady = !!healer;
    setPowerBankBlocker(task, !attacker && !healer
      ? "combat_pair_not_spawned"
      : !attacker
        ? "attacker_not_spawned"
        : "healer_not_spawned", 3);
    return;
  }

  const generation = task.activeGeneration ?? 0;
  (attacker.memory as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration = generation;
  (healer.memory as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration = generation;
  const minimumTtl = getMinimumCombatTtl(task);
  const attackerRenew = attemptRenewCreep(task, attacker, "attacker", minimumTtl);
  if (attackerRenew === "fatal") return;
  const healerRenew = attemptRenewCreep(task, healer, "healer", minimumTtl);
  if (healerRenew === "fatal") return;

  task.attackerReady = attackerRenew === "ready";
  task.healerReady = healerRenew === "ready";
  if (attackerRenew === "ready" && healerRenew === "ready") {
    task.attackerReady = false;
    task.healerReady = false;
    task.combatReady = false;
    transitionTask(task, POWER_BANK_STATUS.BOOSTING);
  }
}

function processTravelling(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  if (!task.attackerId || !task.healerId) {
    task.combatReady = false;
    transitionTask(task, POWER_BANK_STATUS.RENEWING);
    setPowerBankBlocker(task, "missing_creep_ids", 1);
    return;
  }

  const attacker = Game.getObjectById(task.attackerId as Id<Creep>);
  const healer = Game.getObjectById(task.healerId as Id<Creep>);

  if (!attacker || !healer) {
    task.attackerId = undefined;
    task.healerId = undefined;
    task.combatReady = false;
    transitionTask(task, POWER_BANK_STATUS.RENEWING);
    setPowerBankBlocker(task, "combat_member_changed_in_transit", 1);
    return;
  }

  clearBoostMovementState(attacker, task.id);
  clearBoostMovementState(healer, task.id);

  const generation = task.activeGeneration ?? 0;
  const attackerGeneration = (attacker.memory as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration;
  const healerGeneration = (healer.memory as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration;
  const pairReady = task.combatReady === true &&
    attackerGeneration === generation &&
    healerGeneration === generation &&
    attacker.getActiveBodyparts(ATTACK) > 0 &&
    attacker.getActiveBodyparts(TOUGH) > 0 &&
    healer.getActiveBodyparts(HEAL) > 0;

  if (!pairReady) {
    task.combatReady = false;
    transitionTask(task, POWER_BANK_STATUS.RENEWING);
    setPowerBankBlocker(task, "combat_pair_not_ready_in_transit", 1);
    return;
  }

  if (
    attacker.room.name === task.targetRoom &&
    healer.room.name === task.targetRoom &&
    attacker.pos.isNearTo(healer)
  ) {
    transitionTask(task, POWER_BANK_STATUS.ATTACKING);
    task.lastBankProgressAt = Game.time;
    task.lastBankHits = undefined;
  }
}

function clearBoostMovementState(creep: Creep, taskId: string): void {
  const memory = creep.memory as PowerBankTravelMemory;
  if (memory.powerBankTravelTaskId === taskId) return;

  delete memory._move;
  memory.powerBankTravelTaskId = taskId;
}

interface ActivePowerBankPair {
  attacker: Creep;
  healer: Creep;
}

function getActiveCombatPair(task: PowerBankHarvestTask): ActivePowerBankPair | null {
  if (!task.attackerId || !task.healerId) return null;
  const attacker = Game.getObjectById(task.attackerId as Id<Creep>);
  const healer = Game.getObjectById(task.healerId as Id<Creep>);
  if (!attacker || !healer) return null;
  const generation = task.activeGeneration ?? 0;
  const attackerMemory = attacker.memory as PowerBankCreepMemory & { pairGeneration?: number };
  const healerMemory = healer.memory as PowerBankCreepMemory & { pairGeneration?: number };
  if (attackerMemory.pairGeneration === undefined) attackerMemory.pairGeneration = generation;
  if (healerMemory.pairGeneration === undefined) healerMemory.pairGeneration = generation;
  if (
    attackerMemory.pairGeneration !== generation ||
    healerMemory.pairGeneration !== generation
  ) {
    return null;
  }
  return { attacker, healer };
}

function isPairCombatCapable(pair: ActivePowerBankPair): boolean {
  return pair.attacker.getActiveBodyparts(ATTACK) > 0 &&
    pair.attacker.getActiveBodyparts(TOUGH) > 0 &&
    pair.healer.getActiveBodyparts(HEAL) > 0;
}

function isReinforcementOwnedAndReady(
  task: PowerBankHarvestTask,
  reinforcement: PowerBankReinforcementState,
  attacker: Creep,
  healer: Creep,
): boolean {
  const generation = reinforcement.generation;
  const attackerMemory = attacker.memory as PowerBankCreepMemory & { pairGeneration?: number };
  const healerMemory = healer.memory as PowerBankCreepMemory & { pairGeneration?: number };
  if (attacker.memory.role !== "powerBankAttacker" || healer.memory.role !== "powerBankHealer") return false;
  if (attackerMemory.taskId !== task.id || healerMemory.taskId !== task.id) return false;
  if (
    generation !== undefined &&
    (attackerMemory.pairGeneration !== generation || healerMemory.pairGeneration !== generation)
  ) return false;
  if (attacker.room.name !== task.targetRoom || healer.room.name !== task.targetRoom) return false;
  if (!attacker.pos.isNearTo(healer)) return false;
  return isPairCombatCapable({ attacker, healer });
}

function promoteReinforcement(task: PowerBankHarvestTask): ActivePowerBankPair | null {
  const reinforcement = task.reinforcement;
  if (
    !reinforcement?.combatReady ||
    reinforcement.stage !== "attacking" ||
    !reinforcement.attackerId ||
    !reinforcement.healerId
  ) {
    return null;
  }

  const attacker = Game.getObjectById(reinforcement.attackerId as Id<Creep>);
  const healer = Game.getObjectById(reinforcement.healerId as Id<Creep>);
  if (!attacker || !healer) return null;

  const oldIndex = getActiveCombatIndex(task);
  if (oldIndex === reinforcement.index) return null;
  const activeGeneration = task.activeGeneration ?? 0;
  if (reinforcement.generation !== undefined && reinforcement.generation <= activeGeneration) return null;
  const activeIds = new Set([task.attackerId, task.healerId].filter((id): id is string => !!id));
  if (activeIds.has(attacker.id as string) || activeIds.has(healer.id as string)) return null;
  if (!isReinforcementOwnedAndReady(task, reinforcement, attacker, healer)) return null;

  retireCombatGeneration(task, oldIndex);
  task.activeGeneration = reinforcement.generation ?? (task.activeGeneration ?? 0) + 1;
  task.activeIndex = reinforcement.index;
  task.attackerId = reinforcement.attackerId;
  task.healerId = reinforcement.healerId;
  task.combatReady = true;
  task.primaryBoostOwnerId = reinforcement.boostOwnerId;
  task.primaryBoostLabs = [];
  setReinforcementStage(attacker);
  setReinforcementStage(healer);
  delete task.reinforcement;
  markPowerBankProgress(task);
  return { attacker, healer };
}

function shouldProactivelyHandoff(
  task: PowerBankHarvestTask,
  pair: ActivePowerBankPair,
  bank: StructurePowerBank,
): boolean {
  const reinforcement = task.reinforcement;
  if (
    !reinforcement?.combatReady ||
    reinforcement.stage !== "attacking" ||
    !reinforcement.attackerId ||
    !reinforcement.healerId
  ) return false;

  const remainingAttackTicks = estimateRemainingAttackTicks(bank, pair.attacker, pair.healer);
  if (!Number.isFinite(remainingAttackTicks)) return false;
  const pairTtl = Math.min(
    pair.attacker.ticksToLive ?? CREEP_LIFE_TIME,
    pair.healer.ticksToLive ?? CREEP_LIFE_TIME,
  );
  return pairTtl <= remainingAttackTicks + REINFORCEMENT_TTL_BUFFER;
}

function resetChangedActivePair(task: PowerBankHarvestTask): void {
  task.attackerId = undefined;
  task.healerId = undefined;
  task.attackerReady = false;
  task.healerReady = false;
  task.combatReady = false;
  task.primaryBoostOwnerId = `${task.id}:primary:g${task.activeGeneration ?? 0}`;
  transitionTask(task, POWER_BANK_STATUS.RENEWING);
  setPowerBankBlocker(task, "active_pair_member_changed", 1);
}

function processAttacking(task: PowerBankHarvestTask): void {
  if (!task.reinforcement) cleanupInactiveCombatConfigs(task);

  const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);
  if (!bank) {
    if (!Game.rooms[task.targetRoom]) {
      if (!getActiveCombatPair(task) && !task.reinforcement?.attackerId) {
        task.attackerId = undefined;
        task.healerId = undefined;
        task.combatReady = false;
        setPowerBankBlocker(task, "target_not_visible_and_pair_missing", 3);
      }
      return;
    }

    task.lastVisibleAt = Game.time;
    task.bankGoneTick ??= Game.time;
    task.haulingStartedTick ??= Game.time;
    task.haulingDeadlineAt ??= Game.time + 1200;
    if (task.bankExpiresAt !== undefined && Game.time >= task.bankExpiresAt) {
      task.outcome = "expired";
    }
    transitionTask(task, POWER_BANK_STATUS.HAULING);
    cleanupAllCombatConfigs(task);
    cleanupReinforcement(task);
    ensureHaulerConfigs(task);
    retireCombatCreeps(task);
    return;
  }

  updatePowerBankObservation(task, bank);
  processReinforcement(task);

  let pair = getActiveCombatPair(task);
  if (
    pair &&
    (!isPairCombatCapable(pair) || task.blocker === "attack_no_progress")
  ) {
    pair = promoteReinforcement(task) ?? pair;
  }
  if (pair && shouldProactivelyHandoff(task, pair, bank)) {
    pair = promoteReinforcement(task) ?? pair;
  }
  if (!pair) pair = promoteReinforcement(task);
  if (!pair) {
    if (task.reinforcement) {
      setPowerBankBlocker(task, "active_pair_missing_waiting_reinforcement", 1);
      return;
    }
    resetChangedActivePair(task);
    return;
  }
  if (abortUnfinishablePair(task, bank, pair)) return;

  const combatCapable = isPairCombatCapable(pair);
  // combatReady记录已通过的出生/强化门，身体损毁不能把它改回未准备状态，
  // 否则暂时分离的治疗者连共用补位都无法执行。攻击能力由角色逐帧核对。
  if (task.combatReady === false && task.attackerReady !== false && task.healerReady !== false) task.combatReady = true;
  if (!combatCapable) {
    setPowerBankBlocker(task, "active_pair_missing_effective_parts", 1);
  } else if (pair.attacker.room.name !== pair.healer.room.name || !pair.attacker.pos.isNearTo(pair.healer)) {
    setPowerBankBlocker(task, "active_pair_not_adjacent", 1);
  }

  const recovering = !combatCapable || !powerBankAttackSustainable(pair.attacker, pair.healer);
  const recovery = recovering ? predictPowerBankRecovery(pair.attacker, pair.healer) : { ticks: 0 };
  let recoveryProgress = false;
  if (recovering && Number.isFinite(recovery.ticks)) {
    const hits = pair.attacker.hits + pair.healer.hits;
    if (task.combatRecoveryHits === undefined || hits > task.combatRecoveryHits) task.combatRecoveryProgressAt = Game.time;
    task.combatRecoveryHits = hits;
    recoveryProgress = Game.time - (task.combatRecoveryProgressAt ?? 0) <= ATTACK_PROGRESS_TIMEOUT;
    if (recoveryProgress) setPowerBankBlocker(task, "active_pair_recovering", 1);
  } else {
    delete task.combatRecoveryHits; delete task.combatRecoveryProgressAt;
    if (task.blocker === "active_pair_recovering") delete task.blocker;
  }
  if (task.blocker === "attack_no_progress" && Game.time % REINFORCEMENT_REPATH_COOLDOWN === 0) {
    clearMovementState(pair.attacker); clearMovementState(pair.healer);
  }
  processReinforcement(task);
  if (!combatCapable || shouldProactivelyHandoff(task, pair, bank) || task.blocker === "attack_no_progress") pair = promoteReinforcement(task) ?? pair;
  if (!task.reinforcement) cleanupInactiveCombatConfigs(task);
  if (shouldSpawnHaulers(task, bank, pair.attacker, pair.healer)) ensureHaulerConfigs(task);
}

function resetReinforcementForMemberChange(
  task: PowerBankHarvestTask,
  reinforcement: PowerBankReinforcementState,
  attacker?: Creep,
  healer?: Creep,
): void {
  const attackerChanged = !!reinforcement.attackerId && reinforcement.attackerId !== attacker?.id;
  const healerChanged = !!reinforcement.healerId && reinforcement.healerId !== healer?.id;
  if (!attackerChanged && !healerChanged) return;

  if (reinforcement.boostOwnerId) {
    releaseBoostLabs(reinforcement.boostOwnerId, task.sourceRoom);
  }
  reinforcement.attackerId = attacker?.id as string | undefined;
  reinforcement.healerId = healer?.id as string | undefined;
  reinforcement.attackerReady = false;
  reinforcement.healerReady = false;
  reinforcement.combatReady = false;
  reinforcement.boostLabs = [];
  reinforcement.stage = attacker && healer ? "renewing" : "spawning";
  reinforcement.lastMemberChangeAt = Game.time;
  markPowerBankProgress(task);
}

function getReinforcementProgressIdentity(
  reinforcement: PowerBankReinforcementState,
): string {
  return [
    reinforcement.stage,
    reinforcement.attackerId ?? "",
    reinforcement.healerId ?? "",
  ].join("|");
}

function getReinforcementPairPosKey(
  attacker?: Creep,
  healer?: Creep,
): string {
  const attackerPos = attacker
    ? `${attacker.room.name}:${attacker.pos.x}:${attacker.pos.y}`
    : "missing";
  const healerPos = healer
    ? `${healer.room.name}:${healer.pos.x}:${healer.pos.y}`
    : "missing";
  return [
    attackerPos,
    healerPos,
  ].join("|");
}

function observeReinforcementProgress(
  reinforcement: PowerBankReinforcementState,
  attacker?: Creep,
  healer?: Creep,
): void {
  const progressIdentity = getReinforcementProgressIdentity(reinforcement);
  const pairPosKey = getReinforcementPairPosKey(attacker, healer);
  if (reinforcement.progressIdentityKey !== progressIdentity) {
    reinforcement.progressIdentityKey = progressIdentity;
    reinforcement.stageEnteredAt = Game.time;
    reinforcement.lastPairPosKey = pairPosKey;
    reinforcement.recentPairPosKeys = [pairPosKey];
    reinforcement.lastProgressAt = Game.time;
    delete reinforcement.blocker;
    return;
  }

  reinforcement.lastPairPosKey = pairPosKey;
  const storedPairPosKeys = reinforcement.recentPairPosKeys;
  let recentPairPosKeys = Array.isArray(storedPairPosKeys)
    ? storedPairPosKeys.filter((key): key is string => typeof key === "string")
    : [];
  if (recentPairPosKeys.length > REINFORCEMENT_PROGRESS_HISTORY_LIMIT) {
    recentPairPosKeys = recentPairPosKeys.slice(-REINFORCEMENT_PROGRESS_HISTORY_LIMIT);
  }
  reinforcement.recentPairPosKeys = recentPairPosKeys;
  if (!recentPairPosKeys.includes(pairPosKey)) {
    recentPairPosKeys.push(pairPosKey);
    if (recentPairPosKeys.length > REINFORCEMENT_PROGRESS_HISTORY_LIMIT) {
      recentPairPosKeys.splice(0, recentPairPosKeys.length - REINFORCEMENT_PROGRESS_HISTORY_LIMIT);
    }
    reinforcement.recentPairPosKeys = recentPairPosKeys;
    reinforcement.lastProgressAt = Game.time;
    delete reinforcement.blocker;
    return;
  }

  reinforcement.stageEnteredAt ??= Game.time;
  reinforcement.lastProgressAt ??= Game.time;
  if (
    reinforcement.stage !== "travelling" ||
    !attacker ||
    !healer ||
    attacker.fatigue > 0 ||
    healer.fatigue > 0 ||
    Game.time - reinforcement.lastProgressAt < REINFORCEMENT_TRAVEL_STALL_TICKS
  ) return;

  reinforcement.blocker = "reinforcement_travel_no_progress";
  if (
    reinforcement.lastRepathAt !== undefined &&
    Game.time - reinforcement.lastRepathAt < REINFORCEMENT_REPATH_COOLDOWN
  ) return;

  clearMovementState(attacker);
  clearMovementState(healer);
  reinforcement.lastRepathAt = Game.time;
}

function processReinforcement(task: PowerBankHarvestTask): void {
  const reinforcement = task.reinforcement;
  if (!reinforcement) return;
  getReinforcementBoostOwner(task, reinforcement);

  if (!ensureCombatConfigs(task, reinforcement.index)) {
    cleanupReinforcement(task);
    setPowerBankBlocker(task, "reinforcement_invalid_tier", 5);
    return;
  }

  ensureCombatTaskIds(task, reinforcement.index, reinforcement.stage);
  const attacker = getCombatCreep(task, "attacker", reinforcement.index);
  const healer = getCombatCreep(task, "healer", reinforcement.index);
  resetReinforcementForMemberChange(task, reinforcement, attacker, healer);
  observeReinforcementProgress(reinforcement, attacker, healer);

  if (reinforcement.stage === "spawning") {
    if (!attacker || !healer) {
      setPowerBankBlocker(task, "reinforcement_spawning", 3);
      return;
    }
    reinforcement.attackerId = attacker.id as string;
    reinforcement.healerId = healer.id as string;
    reinforcement.lastMemberChangeAt = Game.time;
    reinforcement.stage = "renewing";
    setReinforcementStage(attacker, "renewing");
    setReinforcementStage(healer, "renewing");
    markPowerBankProgress(task);
  }

  if (reinforcement.stage === "renewing") {
    processReinforcementRenewing(task, reinforcement, attacker, healer);
    return;
  }
  if (reinforcement.stage === "boosting") {
    processReinforcementBoosting(task, reinforcement, attacker, healer);
    if (task.reinforcement === reinforcement) {
      observeReinforcementProgress(reinforcement, attacker, healer);
    }
    return;
  }
  if (reinforcement.stage === "travelling") {
    if (!attacker || !healer) {
      cleanupReinforcement(task);
      setPowerBankBlocker(task, "reinforcement_died_in_transit", 3);
      return;
    }
    setReinforcementStage(attacker, "travelling");
    setReinforcementStage(healer, "travelling");
    if (
      reinforcement.combatReady === true &&
      attacker.room.name === task.targetRoom &&
      healer.room.name === task.targetRoom &&
      attacker.pos.isNearTo(healer)
    ) {
      reinforcement.stage = "attacking";
      setReinforcementStage(attacker, "attacking");
      setReinforcementStage(healer, "attacking");
      observeReinforcementProgress(reinforcement, attacker, healer);
      markPowerBankProgress(task);
    }
  }
}

function processReinforcementRenewing(
  task: PowerBankHarvestTask,
  reinforcement: PowerBankReinforcementState,
  attacker?: Creep,
  healer?: Creep,
): void {
  if (!attacker || !healer) return;
  const ownerId = getReinforcementBoostOwner(task, reinforcement);
  const boostResult = refreshPowerBankBoostPrep(task, ownerId);
  if (boostResult.status === "failed") {
    cleanupReinforcement(task);
    setPowerBankBlocker(task, boostResult.reason ?? "reinforcement_boost_prep_failed", 5);
    return;
  }

  const generation = reinforcement.generation ?? 1;
  (attacker.memory as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration = generation;
  (healer.memory as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration = generation;
  const minTtl = getMinimumCombatTtl(task);
  const attackerRenew = attemptRenewCreep(task, attacker, "attacker", minTtl);
  if (attackerRenew === "fatal") return;
  const healerRenew = attemptRenewCreep(task, healer, "healer", minTtl);
  if (healerRenew === "fatal") return;
  reinforcement.attackerReady = attackerRenew === "ready";
  reinforcement.healerReady = healerRenew === "ready";

  if (attackerRenew === "ready" && healerRenew === "ready") {
    reinforcement.attackerReady = false;
    reinforcement.healerReady = false;
    reinforcement.combatReady = false;
    reinforcement.stage = "boosting";
    setReinforcementStage(attacker, "boosting");
    setReinforcementStage(healer, "boosting");
    markPowerBankProgress(task);
  }
}

function processReinforcementBoosting(
  task: PowerBankHarvestTask,
  reinforcement: PowerBankReinforcementState,
  attacker?: Creep,
  healer?: Creep,
): void {
  if (!attacker || !healer) return;
  const tier = task.tier ?? 8;
  const ownerId = getReinforcementBoostOwner(task, reinforcement);
  const boostResult = refreshPowerBankBoostPrep(
    task,
    ownerId,
    getRemainingBoostAmounts(tier, attacker, healer),
  );
  if (boostResult.status === "failed") {
    cleanupReinforcement(task);
    setPowerBankBlocker(task, boostResult.reason ?? "reinforcement_boost_failed", 5);
    return;
  }

  const attackerCompounds = getRequiredBoostsForRole(tier, "attacker");
  const healerCompounds = getRequiredBoostsForRole(tier, "healer");
  if (!handleBoostApplyResult(task, "attacker", applyNextBoost(attacker, ownerId, attackerCompounds))) return;
  if (!handleBoostApplyResult(task, "healer", applyNextBoost(healer, ownerId, healerCompounds))) return;

  const attackerReady = isBoostSatisfied(attacker, attackerCompounds);
  const healerReady = isBoostSatisfied(healer, healerCompounds);
  reinforcement.attackerReady = attackerReady;
  reinforcement.healerReady = healerReady;

  if (attackerReady && healerReady) {
    reinforcement.attackerId = attacker.id as string;
    reinforcement.healerId = healer.id as string;
    reinforcement.combatReady = true;
    setReinforcementStage(attacker, "travelling");
    setReinforcementStage(healer, "travelling");
    clearBoostMovementState(attacker, task.id);
    clearBoostMovementState(healer, task.id);
    releaseFinishedBoostLabs(task, ownerId, false);
    reinforcement.stage = "travelling";
    markPowerBankProgress(task);
  }
}

function retireCombatCreeps(task: PowerBankHarvestTask): void {
  const attacker = task.attackerId ? Game.getObjectById(task.attackerId as Id<Creep>) : null;
  const healer = task.healerId ? Game.getObjectById(task.healerId as Id<Creep>) : null;

  attacker?.suicide();
  healer?.suicide();
}

function processHauling(task: PowerBankHarvestTask): void {
  task.haulingStartedTick ??= Game.time;
  task.haulingDeadlineAt ??= task.haulingStartedTick + 1200;
  cleanupAllCombatConfigs(task);

  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) {
    setPowerBankBlocker(task, "hauling_target_not_visible", 3);
    ensureHaulerConfigs(task);
    return;
  }
  task.lastVisibleAt = Game.time;

  const droppedPower = targetRoom.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_POWER,
  });

  const totalDropped = droppedPower.reduce((sum, r) => sum + r.amount, 0);
  const haulers = getTaskHaulers(task);
  const carriedPower = haulers.reduce(
    (sum, creep) => sum + creep.store.getUsedCapacity(RESOURCE_POWER),
    0,
  );
  task.pickedUpPower = Math.max(
    task.pickedUpPower ?? 0,
    (task.deliveredPower ?? 0) + carriedPower,
  );
  task.observedPower = Math.max(
    task.observedPower ?? 0,
    totalDropped + carriedPower + (task.deliveredPower ?? 0),
  );

  if (totalDropped > 0) {
    delete task.haulingEmptySince;
    markPowerBankProgress(task);
    ensureHaulerConfigs(task);
    return;
  }

  task.haulingEmptySince ??= Game.time;

  const emptyConfirmed = Game.time - task.haulingEmptySince >= HAULING_EMPTY_CONFIRM_TICKS;
  if (carriedPower <= 0 && emptyConfirmed) {
    const delivered = task.deliveredPower ?? 0;
    const accountedPower = Math.max(task.power, task.observedPower ?? 0, task.pickedUpPower ?? 0);
    task.lostPower = Math.max(0, accountedPower - delivered);
    if (delivered >= task.power && task.power > 0) {
      task.outcome = "success";
      transitionToTerminal(task, "complete");
    } else if (delivered > 0) {
      task.outcome = "partial";
      transitionToTerminal(task, "complete");
    } else if (task.outcome === "expired" || (task.bankExpiresAt !== undefined && task.bankGoneTick !== undefined && task.bankGoneTick >= task.bankExpiresAt)) {
      task.outcome = "expired";
      transitionToTerminal(task, "failed", "bank_expired_without_power");
    } else if (task.power > 0) {
      task.outcome = "contested";
      transitionToTerminal(task, "failed", "power_not_observed_or_stolen");
    } else {
      task.outcome = "zero_yield";
      transitionToTerminal(task, "failed", "zero_power_yield");
    }
  }
}

function processTerminalCleanup(task: PowerBankHarvestTask): void {
  return measureSampledCpuPhase("terminalCleanup", () => processTerminalCleanupImpl(task));
}

function processTerminalCleanupImpl(task: PowerBankHarvestTask): void {
  if (task.terminalCleanupDone) return;
  if (task.sourceRoom) {
    const primaryOwner = getPrimaryBoostOwner(task);
    if (
      (task.primaryBoostLabs ?? task.boostLabs).length > 0 ||
      !!getPowerBankBoostPrep(primaryOwner)
    ) {
      releaseBoostLabs(primaryOwner, task.sourceRoom);
    }
    if (task.reinforcement?.boostOwnerId) {
      releaseBoostLabs(task.reinforcement.boostOwnerId, task.sourceRoom);
    }
    task.primaryBoostLabs = [];
    task.boostLabs = [];
  }

  neutralizeTaskCreeps(task);
  cleanupTaskConfigs(task);
  recordPowerBankHistory(task);
  task.terminalCleanupDone = true;
}

/**
 * Idempotent early task ownership: assigns taskId to currently spawned
 * attacker/healer creeps before role `.work()` can run.  Assigns independently
 * per role when `taskId` is absent or already equals `task.id`.  Never
 * overwrites a different existing taskId.
 */
function ensureCreepTaskIds(task: PowerBankHarvestTask): void {
  const activeIndex = getActiveCombatIndex(task);
  const generation = task.activeGeneration ?? 0;
  for (const attackerConfigName of getCombatConfigNames(task, "attacker", activeIndex)) {
    for (const creep of getTickContextService().getCreepsByConfigName(attackerConfigName)) {
      const mem = creep.memory as PowerBankCreepMemory;
      if (mem.taskId === undefined || mem.taskId === task.id) {
        mem.taskId = task.id;
        (mem as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration = generation;
      }
    }
  }

  for (const healerConfigName of getCombatConfigNames(task, "healer", activeIndex)) {
    for (const creep of getTickContextService().getCreepsByConfigName(healerConfigName)) {
      const mem = creep.memory as PowerBankCreepMemory;
      if (mem.taskId === undefined || mem.taskId === task.id) {
        mem.taskId = task.id;
        (mem as PowerBankCreepMemory & { pairGeneration?: number }).pairGeneration = generation;
      }
    }
  }
}

function processTask(task: PowerBankHarvestTask): void {
  return measureSampledCpuPhase("task", () => processTaskImpl(task));
}

function processTaskImpl(task: PowerBankHarvestTask): void {
  initializePowerBankTaskRuntime(task);
  if (isTerminalPowerBankStatus(task.status)) return;

  if (!isPowerBankSearchRoom(task.targetRoom)) {
    transitionToTerminal(task, "aborted", "outside_powerbank_search_rooms");
    return;
  }

  const lifecycleFailure = getPowerBankLifecycleFailure(task);
  if (lifecycleFailure) {
    if (lifecycleFailure === "attack_no_progress") {
      const progressAge = Game.time - (task.lastBankProgressAt ?? Game.time);
      task.blocker = lifecycleFailure;
      delete task.nextAttemptAt;
      if (progressAge > 250) {
        transitionToTerminal(task, "failed", lifecycleFailure);
        return;
      }
    } else if (lifecycleFailure === "hauling_timeout") {
      const delivered = task.deliveredPower ?? 0;
      task.lostPower = Math.max(0, Math.max(task.power, task.observedPower ?? 0) - delivered);
      if (delivered > 0) {
        task.outcome = "partial";
        transitionToTerminal(task, "complete");
      } else {
        task.outcome = "lost";
        transitionToTerminal(task, "failed", lifecycleFailure);
      }
      return;
    } else {
      if (lifecycleFailure === "bank_expired") task.outcome = "expired";
      transitionToTerminal(task, "failed", lifecycleFailure);
      return;
    }
  }

  if (task.nextAttemptAt !== undefined && Game.time < task.nextAttemptAt) {
    return;
  }
  if (task.status === POWER_BANK_STATUS.TRAVELLING) {
    const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);
    const pair = getActiveCombatPair(task);
    if (bank && pair && abortUnfinishablePair(task, bank, pair)) return;
    if (!bank && !Game.rooms[task.targetRoom]) requestPowerBankObservation(task.targetRoom);
  }

  if (BOOST_FINISHED_STATUSES.has(task.status)) {
    releaseFinishedBoostLabs(task);
  }

  // Assign task ownership before early returns in pre-travel statuses
  if (
    task.status === POWER_BANK_STATUS.SPAWNING ||
    task.status === POWER_BANK_STATUS.RENEWING ||
    task.status === POWER_BANK_STATUS.BOOSTING
  ) {
    ensureCreepTaskIds(task);
  }

  switch (task.status) {
    case POWER_BANK_STATUS.DISCOVERED:
      processDiscovered(task);
      break;
    case POWER_BANK_STATUS.PREPARING_BOOSTS:
      processPreparingBoosts(task);
      break;
    case POWER_BANK_STATUS.SPAWNING:
      processSpawning(task);
      break;
    case POWER_BANK_STATUS.BOOSTING:
      processBoosting(task);
      break;
    case POWER_BANK_STATUS.RENEWING:
      processRenewing(task);
      break;
    case POWER_BANK_STATUS.TRAVELLING:
      processTravelling(task);
      break;
    case POWER_BANK_STATUS.ATTACKING:
      processAttacking(task);
      break;
    case POWER_BANK_STATUS.HAULING:
      processHauling(task);
      break;
    case POWER_BANK_STATUS.FAILED:
    case POWER_BANK_STATUS.ABORTED:
    case POWER_BANK_STATUS.COMPLETE:
      break;
  }
}

function maintainPatrolScout(): void {
  return measureSampledCpuPhase("scout", maintainPatrolScoutImpl);
}

function maintainPatrolScoutImpl(): void {
  const configStore = getConfigStore();
  if (hasPowerBankObserverCoverage()) {
    if (configStore[PATROL_SCOUT_CONFIG_NAME]) {
      delete configStore[PATROL_SCOUT_CONFIG_NAME];
    }
    return;
  }

  const existingScouts = getTickContextService().getCreepsByConfigName(PATROL_SCOUT_CONFIG_NAME);
  if (existingScouts.length > 0) return;

  if (configStore[PATROL_SCOUT_CONFIG_NAME]) {
    const creepMemory = Memory.creeps || {};
    for (const room of getTickContextService().getMyRooms()) {
      for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
        if (!spawn.spawning) continue;
        if (creepMemory[spawn.spawning.name]?.configName === PATROL_SCOUT_CONFIG_NAME) return;
      }
    }
    delete configStore[PATROL_SCOUT_CONFIG_NAME];
  }

  const eligibleRooms = getTickContextService().getMyRooms().filter(r => {
    if ((r.controller?.level ?? 0) < 6) return false;
    const spawns = getTickContextService().getSpawnsByRoom(r.name);
    return spawns.length > 0;
  });

  if (eligibleRooms.length === 0) return;

  let sourceRoom = eligibleRooms[0].name;
  let sourceMinDist = Infinity;
  const patrolRooms = getPowerBankSearchRooms();
  if (patrolRooms.length === 0) return;
  for (const room of eligibleRooms) {
    let minDist = Infinity;
    for (const patrolRoom of patrolRooms) {
      // 这里只选择侦察起点；扩大扫描集合后不能对每个组合发布 findRoute 搜索。
      const dist = Game.map.getRoomLinearDistance(room.name, patrolRoom);
      if (dist < minDist) minDist = dist;
    }
    if (minDist < sourceMinDist) {
      sourceMinDist = minDist;
      sourceRoom = room.name;
    }
  }

  configStore[PATROL_SCOUT_CONFIG_NAME] = {
    role: "powerBankScout",
    args: [],
    roomName: sourceRoom,
  };
}

function orderAdmissionTasks(tasks: PowerBankHarvestTask[]): PowerBankHarvestTask[] {
  const lastMeasuredAt = (task: PowerBankHarvestTask): number => {
    const tick = task.admissionLastMeasuredAt;
    return typeof tick === "number" && Number.isFinite(tick) && tick >= 0 && tick <= Game.time ? tick : -1;
  };
  const waiting = tasks.filter(task => task.status === POWER_BANK_STATUS.DISCOVERED)
    .sort((left, right) => lastMeasuredAt(left) - lastMeasuredAt(right));
  let index = 0;
  // 只重排 discovered 所占的位置，保留战斗、运输与终态清理的原有相对顺序。
  return tasks.map(task => task.status === POWER_BANK_STATUS.DISCOVERED ? waiting[index++] : task);
}

export function runPowerBankHarvest(): void {
  return measureSampledCpuPhase("pb.manager", runPowerBankHarvestImpl);
}

function runPowerBankHarvestImpl(): void {
  maintainPatrolScout();
  measureSampledCpuPhase("staleCleanup", cleanupStaleDiscoveries);

  const store = measureSampledCpuPhase("setup", getTaskStore);
  const tasks = measureSampledCpuPhase("setup", () => Object.values(store));

  for (const task of measureSampledCpuPhase("setup", () => orderAdmissionTasks(tasks))) {
    processTask(task);
  }

  for (const task of tasks) {
    if (isTerminalPowerBankStatus(task.status)) {
      processTerminalCleanup(task);
      delete store[task.id];
    }
  }

  cleanupOrphanPowerBankConfigs(Object.values(store));
}
