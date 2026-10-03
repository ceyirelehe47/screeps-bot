import { POWER_BANK_STATUS, POWER_BANK_BODY_TIERS, POWER_BANK_BOOST_REQUIREMENTS, getPowerBankConfigName, isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import {
  ATTACK_POWER,
  POWER_BANK_ROOM_TRAVEL_TICKS,
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
import { getPowerBankRoomThreat, hasPowerBankObserverCoverage, requestPowerBankObservation } from "@/runtime/powerBankObserver";
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

const PATROL_SCOUT_CONFIG_NAME = "powerbank:patrol:scout:0";

const MAX_POWER_BANK_HAULER_PAIRS = 25;
const POWER_BANK_HAULER_ARRIVAL_BUFFER = 200;
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
  const all = getCreepConfigService().list(prefix);
  const allowLegacy = canUseLegacyTaskScope(task);
  const names = new Set(
    Object.entries(all)
      .filter(([, config]) => config.taskId === task.id || (config.taskId === undefined && allowLegacy))
      .map(([name]) => name),
  );

  // 同一 bank 中止后重新发现可能改选 sourceRoom；旧源房名下仍挂着本任务
  // taskId 的配置必须保持可达，否则 hauling/terminal 清理永远扫不到它们，
  // 孵化器又会为这些孤儿配置无限重排（出生即自杀烧能量循环）。
  for (const [name, config] of Object.entries(getCreepConfigService().list())) {
    if (config.taskId === task.id) {
      names.add(name);
    }
  }

  return [...names];
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

function removeSpawnQueueEntries(task: PowerBankHarvestTask): void {
  const ownedNames = new Set(getTaskConfigNames(task));
  for (const spawn of getTickContextService().getSpawnsByRoom(task.sourceRoom)) {
    if (!spawn.memory.spawnList) continue;
    spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => !ownedNames.has(name));
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

function removeConfigWhenIdle(configName: string): void {
  const liveCreeps = getTickContextService().getCreepsByConfigName(configName);
  if (liveCreeps.length > 0) return;

  const creepMemory = Memory.creeps || {};
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) continue;
      if (creepMemory[spawn.spawning.name]?.configName === configName) return;
    }
  }

  const store = getConfigStore();
  delete store[configName];
}

function cleanupCombatConfig(task: PowerBankHarvestTask, role: "attacker" | "healer", index: number): void {
  const configName = getCombatConfigName(task, role, index);
  removeSpawnQueueEntry(configName);
  removeConfigWhenIdle(configName);
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
  for (const configName of getTaskConfigNames(task)) {
    const parts = configName.split(":");
    const role = parts[3];
    if (role !== "attacker" && role !== "healer") continue;

    removeSpawnQueueEntry(configName);
    removeConfigWhenIdle(configName);
  }
}

function cleanupInactiveCombatConfigs(task: PowerBankHarvestTask): void {
  const activeConfigNames = new Set<string>();
  const attacker = task.attackerId ? Game.getObjectById(task.attackerId as Id<Creep>) : null;
  const healer = task.healerId ? Game.getObjectById(task.healerId as Id<Creep>) : null;

  if (attacker?.memory.configName) activeConfigNames.add(attacker.memory.configName);
  if (healer?.memory.configName) activeConfigNames.add(healer.memory.configName);

  for (const configName of getTaskConfigNames(task)) {
    if (activeConfigNames.has(configName)) continue;

    const parts = configName.split(":");
    const role = parts[3];
    if (role !== "attacker" && role !== "healer") continue;

    removeSpawnQueueEntry(configName);
    removeConfigWhenIdle(configName);
  }
}

function cleanupOrphanPowerBankConfigs(tasks: PowerBankHarvestTask[]): void {
  const activeTasks = tasks.filter((task) => !isTerminalPowerBankStatus(task.status));
  const activeTaskIds = new Set(activeTasks.map((task) => task.id));
  const activePrefixes = new Set(activeTasks.map((task) => `${task.sourceRoom}:powerbank:${task.targetRoom}:`));

  const configs = getCreepConfigService().list();
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

    removeSpawnQueueEntry(configName);
    removeConfigWhenIdle(configName);
  }
}

function cleanupTaskConfigs(task: PowerBankHarvestTask): void {
  const configNames = getTaskConfigNames(task);
  removeSpawnQueueEntries(task);
  for (const configName of configNames) {
    removeConfigWhenIdle(configName);
  }
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

function getActiveDangerRooms(targetRoom?: string): string[] {
  const transient = Object.entries(Memory.runtime?.transitDangerRooms ?? {})
    .filter(([, expiresAt]) => expiresAt > Game.time)
    .map(([roomName]) => roomName);
  const permanent = Object.keys(Memory.runtime?.powerBankPermanentDangerRooms ?? {});
  return [...new Set([...transient, ...permanent])]
    .filter((roomName) => roomName !== targetRoom);
}

function findSafeRoute(fromRoom: string, toRoom: string): string[] | null {
  const avoidRooms = new Set(getActiveDangerRooms(toRoom));
  const route = Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: (roomName) => avoidRooms.has(roomName) ? Infinity : 1,
  });
  if (route === ERR_NO_PATH) return null;

  const rooms = [fromRoom];
  for (const step of route) {
    if (rooms[rooms.length - 1] !== step.room) rooms.push(step.room);
  }
  if (rooms[rooms.length - 1] !== toRoom) rooms.push(toRoom);
  return rooms;
}

let admissionRouteMemoGame: Game | undefined;
let admissionRouteMemoTick = -1;
let admissionRouteMemoMap: GameMap | undefined;
let admissionRouteMemoReader: GameMap["findRoute"] | undefined;
const admissionRouteMemo = new Map<string, readonly string[] | null>();

/** 同 tick 复用房间级 route；危险集合变化必须重新规划，不缓存资源准入。 */
function getAdmissionSafeRoute(fromRoom: string, toRoom: string): string[] | null {
  if (admissionRouteMemoGame !== Game || admissionRouteMemoTick !== Game.time ||
    admissionRouteMemoMap !== Game.map || admissionRouteMemoReader !== Game.map.findRoute) {
    admissionRouteMemo.clear();
    admissionRouteMemoGame = Game;
    admissionRouteMemoTick = Game.time;
    admissionRouteMemoMap = Game.map;
    admissionRouteMemoReader = Game.map.findRoute;
  }
  const key = JSON.stringify([fromRoom, toRoom, getActiveDangerRooms(toRoom).sort()]);
  const cached = admissionRouteMemo.get(key);
  if (cached !== undefined) return cached === null ? null : [...cached];
  const route = findSafeRoute(fromRoom, toRoom);
  if (admissionRouteMemo.size >= 64) {
    const oldest = admissionRouteMemo.keys().next().value as string | undefined;
    if (oldest !== undefined) admissionRouteMemo.delete(oldest);
  }
  admissionRouteMemo.set(key, route === null ? null : Object.freeze([...route]));
  return route;
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
  let total = 0;
  if (room.storage) total += room.storage.store.getUsedCapacity(resource);
  if (room.terminal) total += room.terminal.store.getUsedCapacity(resource);
  const reservedLabIds = getActivePowerBankBoostLabIds(room.name, ownerId);
  for (const structure of room.find(FIND_MY_STRUCTURES)) {
    if (structure.structureType !== STRUCTURE_LAB) continue;
    const lab = structure as StructureLab;
    if (!reservedLabIds.has(lab.id)) total += lab.store.getUsedCapacity(resource);
  }
  return total;
}

function getTrustedIncomingCompound(
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
  const available = getLocalCompoundStock(room, resource, ownerId) +
    getTrustedIncomingCompound(room.name, resource, ownerId);
  const deficit = Math.max(0, amount - available);
  if (deficit <= 0) return true;
  return findBestDonorRoom(resource, deficit, [room.name]) !== null;
}

function getStructurePowerHeadroom(structure: StructureStorage | StructureTerminal | null): number {
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
  const configStore = getConfigStore();
  return getTickContextService().getSpawnsByRoom(roomName)
    .filter((spawn) => typeof spawn.isActive !== "function" || spawn.isActive())
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
  const candidates: PowerBankSourceCandidate[] = [];
  const rejectionReasons: string[] = [];
  let pendingRetryAt: number | undefined;

  // 只做房间级安全路线与来源基本资格预评估。先尝试短走廊，防止每 tick
  // 重测靠前的远来源，把有限 PF 配额耗尽后永远到不了已可行的近来源。
  const sourceRoutes: Array<{ room: Room; routeRooms: string[] }> = [];
  for (const room of getTickContextService().getMyRooms()) {
    if (!room.controller || room.controller.level < 6 || isDefenseMode(room.name)) continue;
    if (!getTickContextService().getSpawnsByRoom(room.name)
      .some((spawn) => typeof spawn.isActive !== "function" || spawn.isActive())) continue;
    const routeRooms = getAdmissionSafeRoute(room.name, task.targetRoom);
    if (!routeRooms) {
      rejectionReasons.push(`${room.name}:no_safe_route`);
      continue;
    }
    sourceRoutes.push({ room, routeRooms });
  }
  sourceRoutes.sort((left, right) => left.routeRooms.length - right.routeRooms.length ||
    left.room.name.localeCompare(right.room.name));

  for (const { room, routeRooms } of sourceRoutes) {
    if (!canMeasurePowerBankTravelThisTick()) {
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
    const reservedLabs = getActivePowerBankBoostLabIds(room.name, ownerId);
    const availableLabCount = room.find(FIND_MY_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_LAB && !reservedLabs.has(structure.id),
    }).length;

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
    if (receivingHeadroom <= 0 && !getTickContextService().getMyRooms()
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
    const spawns = getTickContextService().getSpawnsByRoom(room.name)
      .filter((spawn) => typeof spawn.isActive !== "function" || spawn.isActive());
    const measurements: Array<Extract<ReturnType<typeof measurePowerBankTravel>, { status: "ready" }>> = [];
    let sourcePending = false;
    for (const spawn of spawns) {
      if (!canMeasurePowerBankTravelThisTick()) {
        sourcePending = true;
        pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, Game.time + 1);
        break;
      }
      if (!spawn.pos || !returnTarget?.pos) {
        sourcePending = true;
        pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, Game.time + 5);
        continue;
      }
      const measurement = measurePowerBankTravel({
        sourceSpawnPos: spawn.pos,
        bankPos: new RoomPosition(task.bankPos.x, task.bankPos.y, task.targetRoom),
        returnTargetPos: returnTarget.pos,
        routeRooms,
        avoidRooms: getActiveDangerRooms(task.targetRoom),
        profile,
        haulerCarryParts: Math.ceil(haulerCapacity / CARRY_CAPACITY),
      });
      if (measurement.status === "pending") {
        sourcePending = true;
        pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, measurement.retryAt);
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
      avoidRooms: getActiveDangerRooms(task.targetRoom),
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

function estimateRemainingAttackTicks(task: PowerBankHarvestTask, bank: StructurePowerBank): number {
  const tier = task.tier ?? 6;
  const tierBody = POWER_BANK_BODY_TIERS[tier] ?? POWER_BANK_BODY_TIERS[6];
  const attackParts = tierBody.attacker.filter((part) => part === ATTACK).length;
  const boostedDamage = attackParts * ATTACK_POWER * 4;
  if (boostedDamage <= 0) {
    return Infinity;
  }
  return Math.ceil(bank.hits / boostedDamage);
}

function shouldSpawnHaulers(task: PowerBankHarvestTask, bank: StructurePowerBank): boolean {
  if (
    task.plannedHaulerSpawnStartTick !== undefined &&
    Game.time >= task.plannedHaulerSpawnStartTick
  ) {
    return true;
  }

  const sourceRoom = Game.rooms[task.sourceRoom];
  const energyCapacity = sourceRoom?.energyCapacityAvailable ?? 0;
  const spawnTime = estimateHaulerBatchSpawnTicks(task, energyCapacity);
  const travelTime = estimateOneWayRoomTravelTicks(task);
  const remainingAttackTicks = estimateRemainingAttackTicks(task, bank);
  if (!Number.isFinite(travelTime) || !Number.isFinite(remainingAttackTicks)) {
    return false;
  }

  return remainingAttackTicks <= spawnTime + travelTime + POWER_BANK_HAULER_ARRIVAL_BUFFER;
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
  // 预算只允许一次新几何测量。等待阶段不能在每个 discovered 任务上
  // 重做来源评估；有预算后再评估，只有本来源所有 Spawn 的完整证据
  // 与新鲜资源门通过时才允许它进入已证明候选。
  if (!canMeasurePowerBankTravelThisTick()) {
    requestPowerBankObservation(task.targetRoom);
    setPowerBankBlocker(task, "path_measurement_pending", 1);
    return;
  }
  const evaluation = evaluateSourceCandidates(task);
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
    selected.timeline.travelTime + Math.min(selected.timeline.ttk, 900) + 100,
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

  const remainingAttackTicks = estimateRemainingAttackTicks(task, bank);
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

  const combatCapable = isPairCombatCapable(pair);
  if (!combatCapable) {
    task.combatReady = false;
    setPowerBankBlocker(task, "active_pair_missing_effective_parts", 1);
  } else if (pair.attacker.room.name !== pair.healer.room.name || !pair.attacker.pos.isNearTo(pair.healer)) {
    setPowerBankBlocker(task, "active_pair_not_adjacent", 1);
  }

  maybeRequestReinforcement(
    task,
    pair,
    bank,
    !combatCapable || task.blocker === "attack_no_progress",
  );
  processReinforcement(task);
  if (!task.reinforcement) cleanupInactiveCombatConfigs(task);
  if (shouldSpawnHaulers(task, bank)) ensureHaulerConfigs(task);
}

function estimateReinforcementLeadTicks(task: PowerBankHarvestTask): number {
  if (!task.tier) return Infinity;
  const profile = derivePowerBankTierProfile(task.tier);
  if (!profile) return Infinity;
  const spawnReadyIn = getSpawnReadyIn(task.sourceRoom);
  const sourceRoom = Game.rooms[task.sourceRoom];
  if (spawnReadyIn.length === 0 || !sourceRoom) return Infinity;
  const timeline = planPowerBankTimeline({
    profile,
    currentTick: Game.time,
    bankHits: 0,
    bankPower: 0,
    freeTiles: Math.max(1, task.freeTiles),
    routeDistance: task.routeDistance ?? 5,
    combatTravelTicks: task.combatTravelTicks,
    haulerOutboundTravelTicks: task.haulerOutboundTravelTicks,
    haulerReturnTravelTicks: task.haulerReturnTravelTicks,
    haulerCapacity: getPowerBankHaulerCapacity(sourceRoom.energyCapacityAvailable),
    spawnReadyIn,
  });
  return timeline.combatArrivalTick - Game.time;
}

function maybeRequestReinforcement(
  task: PowerBankHarvestTask,
  pair: ActivePowerBankPair,
  bank: StructurePowerBank,
  force = false,
): void {
  if (task.reinforcement) return;
  const pairTtl = Math.min(
    pair.attacker.ticksToLive ?? CREEP_LIFE_TIME,
    pair.healer.ticksToLive ?? CREEP_LIFE_TIME,
  );
  const remainingAttackTicks = estimateRemainingAttackTicks(task, bank);
  const leadTicks = estimateReinforcementLeadTicks(task);
  if (!Number.isFinite(remainingAttackTicks) || !Number.isFinite(leadTicks)) return;
  if (!force && pairTtl > remainingAttackTicks + leadTicks + REINFORCEMENT_TTL_BUFFER) return;

  const generation = (task.activeGeneration ?? 0) + 1;
  task.reinforcement = {
    index: generation,
    generation,
    stage: "spawning",
    attackerReady: false,
    healerReady: false,
    combatReady: false,
    boostOwnerId: `${task.id}:reinforcement:g${generation}`,
    boostLabs: [],
  };
  markPowerBankProgress(task);
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

export function runPowerBankHarvest(): void {
  maintainPatrolScout();
  cleanupStaleDiscoveries();

  const store = getTaskStore();
  const tasks = Object.values(store);

  for (const task of tasks) {
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
