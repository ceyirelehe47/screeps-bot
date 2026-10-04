import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import { requestCombatObservation, OBSERVATION_REQUEST_TTL } from "@/runtime/powerBankObserver";
import { clearMovementState } from "@/roles/shared";
import type { CreepConfig } from "@/types/system";
import { assessUnboostedNpc, isNpcWarTarget } from "@/runtime/warNpcPolicy";
import { getRefillableHostileTowers } from "@/runtime/combatTowerThreat";
import { ensureClearedNpcLootHandoff } from "@/runtime/flagHauling";
import { isRebuildStructureRelevant } from "@/runtime/warRebuildScope";

type WarStatus = "queued" | "staging" | "clearing" | "downgrading" | "patrol_waiting" | "done" | "failed";
export type WarSquad = "standard" | "t3Duo" | "towerDrainDuo";
export type WarBoostTier = "t3";
type WarRole = "meleeAttacker" | "healer";
type WarGenerationPhase = "preparing" | "assembling" | "deployed";

interface WarGenerationState {
  id: number;
  phase: WarGenerationPhase;
  createdAt: number;
  boostTaskId: string;
  boostGateOpenedAt?: number;
  deployedAt?: number;
  configNames: Record<WarRole, string>;
}

interface WarTask {
  targetRoom: string;
  sourceRoom: string;
  status: WarStatus;
  reason: "npc_reservation" | "manual";
  routeRooms?: string[];
  routeOrigin?: "map" | "manual";
  routePlannedAt?: number;
  routeTrace?: { hops: number; avoided: Record<string, string>; policy: "map_combat" | "manual" };
  npcAuto?: true;
  lootAfterClear?: true;
  rebuildIgnoreStructureIds?: string[];
  sharedSquadWatchId?: string;
  combatClearedAt?: number;
  combatClearSince?: number;
  squadDecision?: string;
  squadAssessedAt?: number;
  squad?: WarSquad;
  boostTier?: "t3";
  boostLabs?: string[];
  boostStatus?: "preparing" | "ready" | "failed";
  oneShot?: boolean;
  failReason?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  statusSince?: number;
  lastHostileSeenAt?: number;
  clearSince?: number;
  completedAt?: number;
  assetsReleasedAt?: number;
  controllerAttackerLastQueuedAt?: number;
  generationCounter?: number;
  activeGeneration?: WarGenerationState;
  patrolRooms?: string[];
  patrolIndex?: number;
  patrolInterval?: number;
  patrolNextSweepAt?: number;
}

interface HostilePresenceSnapshot {
  present: boolean;
  hostileCreeps: number;
  hostileStructures: number;
  hostileReservation: boolean;
}

export interface StopWarOptions {
  suicide?: boolean;
}

export interface StartWarOptions {
  routeRooms?: string[];
  squad?: WarSquad;
  boostTier?: WarBoostTier;
  oneShot?: boolean;
}

export interface StartWarPatrolOptions {
  intervalTicks?: number;
}

export interface StartWarResult {
  ok: true;
  targetRoom: string;
  sourceRoom: string;
  status: WarStatus;
  reason: "manual";
  squad?: WarSquad;
  routeRooms?: string[];
  routeTrace?: WarTask["routeTrace"];
  squadDecision?: string;
  boostTier?: WarBoostTier;
  oneShot: boolean;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface StopWarResult {
  ok: true;
  targetRoom: string;
  removedTask: boolean;
  removedConfigs: number;
  removedQueuedTasks: number;
  cancelledSpawns: number;
  suicidedCreeps: number;
  releasedBoosts: boolean;
}

interface WarTaskAssetReleaseOptions {
  suicide?: boolean;
}

interface WarTaskAssetReleaseResult {
  removedConfigs: number;
  removedQueuedTasks: number;
  cancelledSpawns: number;
  detachedCreeps: number;
  suicidedCreeps: number;
  releasedBoosts: boolean;
}

export interface StartWarPatrolResult extends StartWarResult {
  patrolRooms: string[];
  patrolIndex: number;
  patrolInterval: number;
}

export interface WarStatusCreepSnapshot {
  name: string;
  role?: string;
  configName?: string;
  roomName: string;
  x: number;
  y: number;
  hits: number;
  hitsMax: number;
  boostedParts: number;
  spawning: boolean;
  detached: boolean;
}

export interface WarStatusTaskSnapshot {
  targetRoom: string;
  sourceRoom: string;
  status: WarStatus;
  reason: "npc_reservation" | "manual";
  squad?: WarSquad;
  routeRooms?: string[];
  routeTrace?: WarTask["routeTrace"];
  squadDecision?: string;
  boostTier?: "t3";
  oneShot: boolean;
  boostStatus?: "preparing" | "ready" | "failed";
  attempts: number;
  age: number;
  statusAge: number;
  clearTicks: number;
  targetVisible: boolean;
  hostileCreeps: number;
  hostileStructures: number;
  hostileReservation: boolean;
  sourceEnergyAvailable?: number;
  sourceEnergyCapacity?: number;
  creeps: WarStatusCreepSnapshot[];
  queuedConfigs: string[];
  generationId?: number;
  generationPhase?: WarGenerationPhase;
  boostGateOpen: boolean;
  generationAge: number;
  deployedAge: number;
  controllerLevel?: number;
  controllerOwner?: string;
  controllerTicksToDowngrade?: number;
  controllerUpgradeBlocked?: number;
  controllerAttackerConfigName?: string;
  controllerAttackerLastQueuedAt?: number;
  controllerAttackerNextQueueAt?: number;
  patrolRooms?: string[];
  patrolIndex?: number;
  patrolInterval?: number;
  patrolNextSweepAt?: number;
  patrolNextSweepIn?: number;
}

export interface WarStatusSnapshot {
  ok: true;
  tick: number;
  tasks: WarStatusTaskSnapshot[];
}

const MELEE_COUNT = 2;
const HEALER_COUNT = 1;
const DUO_MELEE_COUNT = 1;
const DUO_HEALER_COUNT = 1;
const MAX_STAGING_TICKS = 2500;
const CONTROLLER_ATTACKER_QUEUE_INTERVAL = 1000;
const WAR_CLEAR_DEBOUNCE_TICKS = 20;
const DEFAULT_PATROL_INTERVAL_TICKS = 1000;
const MIN_PATROL_INTERVAL_TICKS = 20;
const WAR_CONTROLLER_ATTACK_CONFIG_SUFFIX = "controllerAttacker:0";
const WAR_CONTROLLER_CORE_STRUCTURES = new Set<StructureConstant>([
  STRUCTURE_SPAWN,
  STRUCTURE_TOWER,
]);

const WAR_T3_TOUGH = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
const WAR_T3_ATTACK = RESOURCE_CATALYZED_UTRIUM_ACID;
const WAR_T3_HEAL = RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE;
const WAR_T3_MOVE = RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE;

const T3_ATTACKER_BODY: BodyPartConstant[] = [
  TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
  ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
  ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
  ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
  MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
];

const T3_HEALER_BODY: BodyPartConstant[] = [
  TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
  HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL,
  HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL,
  MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
];

const TOWER_DRAIN_ATTACKER_BODY: BodyPartConstant[] = [
  ...Array<BodyPartConstant>(25).fill(ATTACK),
  ...Array<BodyPartConstant>(25).fill(MOVE),
];
// 前部承伤时保留完整移动能力，尾部治疗部件供退房后的恢复使用。
const TOWER_DRAIN_HEALER_BODY: BodyPartConstant[] = [
  ...Array<BodyPartConstant>(20).fill(HEAL),
  ...Array<BodyPartConstant>(25).fill(MOVE),
  ...Array<BodyPartConstant>(5).fill(HEAL),
];

const T3_ATTACKER_BOOSTS: ResourceConstant[] = [WAR_T3_MOVE, WAR_T3_TOUGH, WAR_T3_ATTACK];
const T3_HEALER_BOOSTS: ResourceConstant[] = [WAR_T3_MOVE, WAR_T3_TOUGH, WAR_T3_HEAL];
const T3_BOOST_PARTS: Partial<Record<ResourceConstant, BodyPartConstant>> = {
  [WAR_T3_MOVE]: MOVE,
  [WAR_T3_TOUGH]: TOUGH,
  [WAR_T3_ATTACK]: ATTACK,
  [WAR_T3_HEAL]: HEAL,
};
const T3_DUO_BOOST_AMOUNTS = new Map<ResourceConstant, number>([
  [WAR_T3_TOUGH, 20 * LAB_BOOST_MINERAL],
  [WAR_T3_ATTACK, 30 * LAB_BOOST_MINERAL],
  [WAR_T3_HEAL, 20 * LAB_BOOST_MINERAL],
  [WAR_T3_MOVE, 18 * LAB_BOOST_MINERAL],
]);

function ensureWarStore(): Record<string, WarTask> {
  const data = getMemoryService().ensureData();
  if (!data.war) {
    data.war = {};
  }

  return data.war;
}

function ensureConfigStore(): Record<string, CreepConfig> {
  return getMemoryService().getCreepConfigStore();
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

function getConfigName(task: WarTask, role: WarRole, index: number): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:${role}:${index}`;
}

function getGenerationConfigName(task: WarTask, generationId: number, role: WarRole): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:g${generationId}:${role}:0`;
}

function getGenerationBoostTaskId(task: WarTask, generationId: number): string {
  return `war:${task.sourceRoom}:${task.targetRoom}:g${generationId}`;
}

function isT3DuoTask(task: WarTask): boolean {
  return !isTowerDrainDuoTask(task) && (task.squad === "t3Duo" || task.boostTier === "t3");
}

function isTowerDrainDuoTask(task: WarTask): boolean {
  return task.squad === "towerDrainDuo";
}

function isDuoTask(task: WarTask): boolean {
  return isTowerDrainDuoTask(task) || isT3DuoTask(task);
}

function getMeleeCount(task: WarTask): number {
  return isDuoTask(task) ? DUO_MELEE_COUNT : MELEE_COUNT;
}

function getHealerCount(task: WarTask): number {
  return isDuoTask(task) ? DUO_HEALER_COUNT : HEALER_COUNT;
}

function getLegacyWarBoostTaskId(task: WarTask): string {
  return `war:${task.sourceRoom}:${task.targetRoom}`;
}

function isPatrolTask(task: WarTask): boolean {
  return Array.isArray(task.patrolRooms) && task.patrolRooms.length > 0;
}

function getPatrolInterval(task: WarTask): number {
  return Math.max(MIN_PATROL_INTERVAL_TICKS, task.patrolInterval ?? DEFAULT_PATROL_INTERVAL_TICKS);
}

function encodeBoosts(compounds: ResourceConstant[]): string {
  return compounds.join("|");
}

function getRoleArgs(
  task: WarTask,
  role: WarRole,
  encodedRoute: string,
  boostTaskId = getLegacyWarBoostTaskId(task),
  partnerConfigName = "",
): string[] {
  if (isTowerDrainDuoTask(task)) {
    return [task.targetRoom, encodedRoute, "", "", partnerConfigName, "towerDrainDuo"];
  }
  if (!isT3DuoTask(task)) {
    return [task.targetRoom, encodedRoute, "", "", partnerConfigName];
  }

  return [
    task.targetRoom,
    encodedRoute,
    boostTaskId,
    encodeBoosts(role === "meleeAttacker" ? T3_ATTACKER_BOOSTS : T3_HEALER_BOOSTS),
    partnerConfigName,
  ];
}

function getCombatPartnerConfigName(task: WarTask, role: WarRole, index: number): string {
  if (isDuoTask(task)) {
    const generation = ensureActiveGeneration(task);
    return role === "meleeAttacker"
      ? generation.configNames.healer
      : generation.configNames.meleeAttacker;
  }

  if (role === "meleeAttacker") {
    return index < getHealerCount(task) ? getConfigName(task, "healer", index) : "";
  }
  return index < getMeleeCount(task) ? getConfigName(task, "meleeAttacker", index) : "";
}

function getRoleBody(task: WarTask, role: WarRole): BodyPartConstant[] | undefined {
  if (isTowerDrainDuoTask(task)) {
    return role === "meleeAttacker" ? [...TOWER_DRAIN_ATTACKER_BODY] : [...TOWER_DRAIN_HEALER_BODY];
  }
  if (!isT3DuoTask(task)) return undefined;
  return role === "meleeAttacker" ? [...T3_ATTACKER_BODY] : [...T3_HEALER_BODY];
}

function resetWarCreepTargetState(creep: Creep): void {
  clearMovementState(creep);
  delete creep.memory._warBreachTargetId;
  delete creep.memory._warBreachResumeUntil;
  delete creep.memory._warCounterstrike;
  delete creep.memory._warCounterstrikeSuppressedTargetIds;
  delete creep.memory._warQueued;
  delete creep.memory._warTowerDrain;
}

function synchronizeGenerationRoleArgs(task: WarTask, resetTargets: boolean): void {
  const generation = task.activeGeneration;
  if (!generation) return;

  const encodedRoute = task.routeRooms?.join("|") || "";
  const store = ensureConfigStore();
  for (const role of ["meleeAttacker", "healer"] as const) {
    const configName = generation.configNames[role];
    const partnerConfigName = role === "meleeAttacker"
      ? generation.configNames.healer
      : generation.configNames.meleeAttacker;
    const args = getRoleArgs(task, role, encodedRoute, generation.boostTaskId, partnerConfigName);
    if (store[configName]) {
      store[configName].args = args;
    }
    for (const creep of getLiveCreepsByConfig(configName)) {
      if (creep.memory.roleArgs?.[1] !== undefined && creep.memory.roleArgs[1] !== encodedRoute) clearMovementState(creep);
      creep.memory.roleArgs = [...args];
      if (resetTargets) resetWarCreepTargetState(creep);
    }
  }
}

function updatePatrolAssignments(task: WarTask): void {
  synchronizeGenerationRoleArgs(task, true);
}

function advancePatrol(task: WarTask, nextIndex: number): boolean {
  const patrolRooms = task.patrolRooms;
  if (!patrolRooms?.[nextIndex]) return false;

  const store = ensureWarStore();
  const previousTarget = task.targetRoom;
  const nextTarget = patrolRooms[nextIndex];
  const collision = store[nextTarget];
  if (collision && collision !== task) {
    const terminal = collision.status === "done" || collision.status === "failed";
    if (terminal) {
      releaseWarTaskAssets(collision);
    }
    if (!terminal || hasTaskWarActivity(collision)) {
      task.failReason = `patrol_target_busy:${nextTarget}`;
      task.clearSince = Game.time;
      setTaskStatus(task, "clearing");
      return false;
    }
    delete store[nextTarget];
  }

  if (store[previousTarget] === task) {
    delete store[previousTarget];
  }
  task.targetRoom = nextTarget;
  task.patrolIndex = nextIndex;
  task.patrolNextSweepAt = undefined;
  task.routeRooms = undefined;
  task.clearSince = undefined;
  task.completedAt = undefined;
  task.controllerAttackerLastQueuedAt = undefined;
  task.failReason = undefined;
  task.attempts += 1;
  setTaskStatus(task, "staging");
  store[nextTarget] = task;
  updatePatrolAssignments(task);
  return true;
}

function completePatrolTarget(task: WarTask): boolean {
  if (!isPatrolTask(task)) return false;

  const patrolRooms = task.patrolRooms!;
  const currentIndex = Math.max(0, task.patrolIndex ?? patrolRooms.indexOf(task.targetRoom));
  if (currentIndex + 1 < patrolRooms.length) {
    advancePatrol(task, currentIndex + 1);
    return true;
  }

  task.clearSince = undefined;
  task.patrolIndex = patrolRooms.length - 1;
  task.patrolNextSweepAt = Game.time + getPatrolInterval(task);
  setTaskStatus(task, "patrol_waiting");
  return true;
}

function getExpectedTaskConfigNames(task: WarTask): string[] {
  if (isDuoTask(task) && task.activeGeneration) {
    return Object.values(task.activeGeneration.configNames);
  }

  const names: string[] = [];
  for (let i = 0; i < getMeleeCount(task); i++) {
    names.push(getConfigName(task, "meleeAttacker", i));
  }
  for (let i = 0; i < getHealerCount(task); i++) {
    names.push(getConfigName(task, "healer", i));
  }
  return names;
}

function getTaskConfigNames(task: WarTask): string[] {
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  const names = new Set<string>(getExpectedTaskConfigNames(task));
  names.add(getControllerAttackConfigName(task));
  for (const configName of Object.keys(getCreepConfigService().list(prefix))) {
    names.add(configName);
  }
  for (const creepMemory of Object.values(Memory.creeps || {})) {
    if (creepMemory._warDetached !== true && creepMemory.configName?.startsWith(prefix)) {
      names.add(creepMemory.configName);
    }
  }
  return [...names];
}

function hasTaskWarActivity(task: WarTask): boolean {
  const spawns = getSpawnsForRoom(task.sourceRoom);
  return getTaskConfigNames(task).some((configName) =>
    getLiveCreepsByConfig(configName).length > 0
    || isConfigQueuedInSpawns(spawns, configName)
    || isConfigSpawning(configName)
  );
}

let transferredMembers: { game: Game; tick: number; byConfig: Map<string, Creep[]> } | undefined;

function getLiveCreepsByConfig(configName: string): Creep[] {
  const transferred = transferredMembers?.game === Game && transferredMembers.tick === Game.time ? transferredMembers.byConfig.get(configName) : undefined;
  return (transferred ?? getTickContextService().getCreepsByConfigName(configName)).filter(
    (creep) => Game.creeps[creep.name] === creep && creep.memory._warDetached !== true && creep.memory.configName === configName,
  );
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

function enqueueConfig(spawn: StructureSpawn, configName: string, toFront: boolean): void {
  const queue = spawn.memory.spawnList || [];
  const config = ensureConfigStore()[configName];
  if (toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
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

function shouldQueueWarConfig(config: CreepConfig | undefined): boolean {
  return config?.spawnOnce?.queuedAt === undefined;
}

function removeQueuedConfig(task: WarTask, configName: string): void {
  for (const spawn of getTickContextService().getSpawnsByRoom(task.sourceRoom)) {
    if (spawn.memory.spawnList) {
      spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
    }
  }
}

function removeQueuedConfigByName(configName: string): number {
  let removed = 0;
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      const queue = spawn.memory.spawnList;
      if (!queue) {
        continue;
      }

      const next = queue.filter((name) => name !== configName);
      if (next.length !== queue.length) {
        spawn.memory.spawnList = next;
        removed += queue.length - next.length;
      }
    }
  }
  return removed;
}

function collectSpawningForConfigs(configNames: ReadonlySet<string>): Spawning[] {
  const creepMemory = Memory.creeps || {};
  const spawning = new Set<Spawning>();
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      const spawningName = spawn.spawning.name;
      const configName = creepMemory[spawningName]?.configName;
      if (!configName || !configNames.has(configName)) {
        continue;
      }
      spawning.add(spawn.spawning);
    }
  }
  return [...spawning];
}

function detachWarTaskCreeps(
  configNames: ReadonlySet<string>,
  suicide: boolean,
): { detachedCreeps: number; suicidedCreeps: number } {
  const detachedNames = new Set<string>();
  let suicided = 0;
  for (const [creepName, creep] of Object.entries(Game.creeps)) {
    const configName = creep.memory.configName;
    if (!configName || !configNames.has(configName)) continue;
    if (suicide && creep.suicide() === OK) {
      suicided += 1;
    }
    creep.memory._warDetached = true;
    delete creep.memory._warPartnerConfigName;
    delete creep.memory.configName;
    detachedNames.add(creepName);
  }

  for (const [creepName, memory] of Object.entries(Memory.creeps || {})) {
    const configName = memory.configName;
    if (!configName || !configNames.has(configName)) continue;
    memory._warDetached = true;
    delete memory._warPartnerConfigName;
    delete memory.configName;
    detachedNames.add(creepName);
  }

  return { detachedCreeps: detachedNames.size, suicidedCreeps: suicided };
}

function removeConfigWhenIdle(configName: string): void {
  if (getLiveCreepsByConfig(configName).length > 0 || isConfigSpawning(configName)) {
    return;
  }

  const store = ensureConfigStore();
  if (store[configName]) {
    delete store[configName];
  }
}

function removeConfig(configName: string): number {
  const store = ensureConfigStore();
  if (!store[configName]) {
    return 0;
  }

  delete store[configName];
  return 1;
}

function isHostileReservation(room: Room): boolean {
  const controller = room.controller;
  if (!controller) {
    return false;
  }

  if (controller.my || controller.owner) {
    return false;
  }

  const myUser = Object.values(Game.spawns)[0]?.owner.username || Object.values(Game.creeps)[0]?.owner.username;
  const reservation = controller.reservation;
  if (!reservation) {
    return false;
  }

  if (!myUser) {
    return true;
  }

  return reservation.username !== myUser;
}

function getHostilePresence(room: Room, task?: WarTask): HostilePresenceSnapshot {
  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) => creep.owner.username !== "Source Keeper",
  });

  const hostileStructures: Structure<StructureConstant>[] = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });

  const relevantStructures = hostileStructures.filter(s => isRebuildStructureRelevant(s, task?.rebuildIgnoreStructureIds));
  if (task && isTowerDrainDuoTask(task) && !task.sharedSquadWatchId) {
    const seen = new Set(hostileStructures.map((structure) => structure.id));
    for (const wall of room.find(FIND_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_WALL,
    })) {
      if (!seen.has(wall.id) && isRebuildStructureRelevant(wall, task.rebuildIgnoreStructureIds)) {
        seen.add(wall.id);
        relevantStructures.push(wall);
      }
    }
  }

  const hostileReservation = isHostileReservation(room);
  return {
    present: hostileCreeps.length > 0 || relevantStructures.length > 0
      || (hostileReservation && !(task && isTowerDrainDuoTask(task))),
    hostileCreeps: hostileCreeps.length,
    hostileStructures: relevantStructures.length,
    hostileReservation,
  };
}

function setTaskStatus(task: WarTask, status: WarStatus): void {
  if (task.status === status) {
    return;
  }

  task.status = status;
  task.statusSince = Game.time;
}

function createGeneration(task: WarTask, id: number): WarGenerationState {
  return {
    id,
    phase: isTowerDrainDuoTask(task) ? "assembling" : "preparing",
    createdAt: Game.time,
    boostTaskId: getGenerationBoostTaskId(task, id),
    configNames: {
      meleeAttacker: getGenerationConfigName(task, id, "meleeAttacker"),
      healer: getGenerationConfigName(task, id, "healer"),
    },
  };
}

function hasConfigActivity(task: WarTask, configName: string): boolean {
  const spawns = getSpawnsForRoom(task.sourceRoom);
  return getLiveCreepsByConfig(configName).length > 0
    || isConfigQueuedInSpawns(spawns, configName)
    || isConfigSpawning(configName);
}

function ensureActiveGeneration(task: WarTask): WarGenerationState {
  if (task.activeGeneration) return task.activeGeneration;

  const legacyConfigNames = {
    meleeAttacker: getConfigName(task, "meleeAttacker", 0),
    healer: getConfigName(task, "healer", 0),
  };
  const hasLegacyActivity = Object.values(legacyConfigNames).some((configName) =>
    hasConfigActivity(task, configName)
  );

  if (hasLegacyActivity) {
    const liveLegacyCreeps = Object.values(legacyConfigNames).flatMap((configName) =>
      getLiveCreepsByConfig(configName)
    );
    const deployed = liveLegacyCreeps.some((creep) => creep.room.name !== task.sourceRoom);
    task.generationCounter = Math.max(task.generationCounter ?? 0, 0);
    task.activeGeneration = {
      id: 0,
      phase: deployed ? "deployed" : "assembling",
      createdAt: Game.time,
      boostTaskId: getLegacyWarBoostTaskId(task),
      boostGateOpenedAt: isT3DuoTask(task) ? Game.time : undefined,
      deployedAt: deployed ? Game.time : undefined,
      configNames: legacyConfigNames,
    };
    return task.activeGeneration;
  }

  for (const configName of Object.values(legacyConfigNames)) {
    removeConfigWhenIdle(configName);
  }
  const nextId = Math.max(task.generationCounter ?? 0, 0) + 1;
  task.generationCounter = nextId;
  task.activeGeneration = createGeneration(task, nextId);
  return task.activeGeneration;
}

function getCombatConfigName(task: WarTask, role: WarRole, index: number): string {
  if (isDuoTask(task)) {
    return ensureActiveGeneration(task).configNames[role];
  }
  return getConfigName(task, role, index);
}

function getControllerAttackConfigName(task: WarTask): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:${WAR_CONTROLLER_ATTACK_CONFIG_SUFFIX}`;
}

function hasControllerAttackBlockers(room: Room): boolean {
  return room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) => WAR_CONTROLLER_CORE_STRUCTURES.has(structure.structureType),
  }).length > 0;
}

function isControllerDowngradeReady(room: Room): boolean {
  const controller = room.controller;
  if (!controller?.owner || controller.my || controller.level <= 0) return false;
  return !hasControllerAttackBlockers(room);
}

function isControllerDefeated(room: Room): boolean {
  const controller = room.controller;
  return !!controller && (controller.my || !controller.owner || controller.level <= 0);
}

function getControllerAttackBody(sourceRoomName: string): BodyPartConstant[] {
  const roomCapacity = Game.rooms[sourceRoomName]?.energyCapacityAvailable ?? 0;
  const spawnCapacity = getSpawnsForRoom(sourceRoomName).reduce(
    (maximum, spawn) => Math.max(maximum, spawn.room.energyCapacityAvailable ?? 0),
    0,
  );
  const energyCapacity = Math.max(roomCapacity, spawnCapacity);
  const pairCost = BODYPART_COST[CLAIM] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(25, Math.floor(energyCapacity / pairCost)));
  return [
    ...Array(pairCount).fill(CLAIM),
    ...Array(pairCount).fill(MOVE),
  ];
}

function inferControllerAttackerQueuedAt(creep: Creep): number | undefined {
  if (creep.ticksToLive === undefined) return undefined;
  const livedTicks = Math.max(0, CREEP_CLAIM_LIFE_TIME - creep.ticksToLive);
  return Game.time - livedTicks - creep.body.length * CREEP_SPAWN_TIME;
}

function ensureControllerAttackConfig(task: WarTask): void {
  if (Object.values(Memory.cfg?.warRebuildWatch ?? {}).some(watch => watch.sharedSquad
    && watch.sourceRoom === task.sourceRoom && watch.targetRooms.includes(task.targetRoom))) return;
  const configName = getControllerAttackConfigName(task);
  const encodedRoute = task.routeRooms?.join("|") || "";
  const store = ensureConfigStore();
  const existing = store[configName];
  const liveCreeps = getLiveCreepsByConfig(configName);
  const existingQueuedAt = existing?.spawnOnce?.queuedAt;
  if (
    existingQueuedAt !== undefined
    && (task.controllerAttackerLastQueuedAt === undefined || existingQueuedAt > task.controllerAttackerLastQueuedAt)
  ) {
    task.controllerAttackerLastQueuedAt = existingQueuedAt;
  }
  if (task.controllerAttackerLastQueuedAt === undefined) {
    const inferredQueuedAt = liveCreeps
      .map(inferControllerAttackerQueuedAt)
      .filter((tick): tick is number => tick !== undefined)
      .reduce<number | undefined>((earliest, tick) => earliest === undefined ? tick : Math.min(earliest, tick), undefined);
    task.controllerAttackerLastQueuedAt = inferredQueuedAt;
  }

  const spawns = getSpawnsForRoom(task.sourceRoom);
  const queued = isConfigQueuedInSpawns(spawns, configName);
  const spawning = isConfigSpawning(configName);
  const active = liveCreeps.length > 0 || queued || spawning;
  const targetController = Game.rooms[task.targetRoom]?.controller;
  if (!active && targetController && (targetController.upgradeBlocked ?? 0) <= 0) {
    task.controllerAttackerLastQueuedAt = undefined;
  }

  const lastQueuedAt = task.controllerAttackerLastQueuedAt;
  const queueDue = lastQueuedAt === undefined || Game.time - lastQueuedAt >= CONTROLLER_ATTACKER_QUEUE_INTERVAL;

  store[configName] = {
    role: "claimer",
    args: [task.targetRoom, encodedRoute, "attack"],
    roomName: task.sourceRoom,
    body: getControllerAttackBody(task.sourceRoom),
    spawnOnce: queueDue && !active ? {} : { queuedAt: lastQueuedAt },
  };

  if (
    spawns.length === 0
    || active
    || !queueDue
  ) {
    return;
  }

  const spawn = selectLeastLoadedSpawn(spawns);
  if (spawn) {
    enqueueConfig(spawn, configName, true);
    task.controllerAttackerLastQueuedAt = Game.time;
  }
}

function clearControllerAttackConfig(task: WarTask): void {
  const configName = getControllerAttackConfigName(task);
  removeQueuedConfig(task, configName);
  removeConfig(configName);
}

function ensureCombatConfigs(task: WarTask): void {
  const store = ensureConfigStore();
  const encodedRoute = task.routeRooms?.join("|") || "";
  const generation = isDuoTask(task) ? ensureActiveGeneration(task) : undefined;
  if (generation?.phase === "deployed") return;

  for (let i = 0; i < getMeleeCount(task); i++) {
    const configName = getCombatConfigName(task, "meleeAttacker", i);
    const existing = store[configName];
    store[configName] = {
      role: "meleeAttacker",
      args: getRoleArgs(
        task,
        "meleeAttacker",
        encodedRoute,
        generation?.boostTaskId,
        getCombatPartnerConfigName(task, "meleeAttacker", i),
      ),
      roomName: task.sourceRoom,
      body: getRoleBody(task, "meleeAttacker"),
      spawnOnce: task.oneShot || isTowerDrainDuoTask(task) ? (existing?.spawnOnce ?? {}) : undefined,
    };
  }

  for (let i = 0; i < getHealerCount(task); i++) {
    const configName = getCombatConfigName(task, "healer", i);
    const existing = store[configName];
    store[configName] = {
      role: "healer",
      args: getRoleArgs(
        task,
        "healer",
        encodedRoute,
        generation?.boostTaskId,
        getCombatPartnerConfigName(task, "healer", i),
      ),
      roomName: task.sourceRoom,
      body: getRoleBody(task, "healer"),
      spawnOnce: task.oneShot || isTowerDrainDuoTask(task) ? (existing?.spawnOnce ?? {}) : undefined,
    };
  }

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    return;
  }

  for (let i = 0; i < getMeleeCount(task); i++) {
    const configName = getCombatConfigName(task, "meleeAttacker", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = isConfigQueuedInSpawns(spawns, configName);
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning && shouldQueueWarConfig(store[configName])) {
      const targetSpawn = selectLeastLoadedSpawn(spawns);
      if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
    }
  }

  for (let i = 0; i < getHealerCount(task); i++) {
    const configName = getCombatConfigName(task, "healer", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = isConfigQueuedInSpawns(spawns, configName);
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning && shouldQueueWarConfig(store[configName])) {
      const targetSpawn = selectLeastLoadedSpawn(spawns);
      if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
    }
  }
}

function getGenerationCreeps(generation: WarGenerationState): Creep[] {
  return Object.values(generation.configNames).flatMap((configName) =>
    getLiveCreepsByConfig(configName)
  );
}

function isGenerationComplete(generation: WarGenerationState): boolean {
  return getLiveCreepsByConfig(generation.configNames.meleeAttacker).length > 0
    && getLiveCreepsByConfig(generation.configNames.healer).length > 0;
}

function cleanupGenerationConfigs(task: WarTask, generation: WarGenerationState): void {
  for (const configName of Object.values(generation.configNames)) {
    removeQueuedConfig(task, configName);
    removeConfig(configName);
  }
}

function reconcileGenerationLifecycle(task: WarTask): boolean {
  if (!isDuoTask(task)) return false;

  const generation = ensureActiveGeneration(task);
  const generationCreeps = getGenerationCreeps(generation);
  synchronizeGenerationRoleArgs(task, false);

  if (
    generation.phase === "assembling"
    && generationCreeps.some((creep) => creep.room.name !== task.sourceRoom)
  ) {
    generation.phase = "deployed";
    generation.deployedAt = Game.time;
    if (isT3DuoTask(task)) {
      releaseBoostLabs(generation.boostTaskId, task.sourceRoom);
      task.boostLabs = [];
    }
    cleanupGenerationConfigs(task, generation);
  }

  // 每个耗塔 generation 的角色只生成一次。排队/生成中不是损失；
  // 已排队过而当前完全没有活动的角色，才表示本代在出发前耗尽。
  const exhaustedBeforeDeployment = isTowerDrainDuoTask(task)
    && generation.phase === "assembling"
    && Object.values(generation.configNames).some((configName) =>
      ensureConfigStore()[configName]?.spawnOnce?.queuedAt !== undefined
      && !hasConfigActivity(task, configName)
    );
  if (!exhaustedBeforeDeployment && (generation.phase !== "deployed" || isGenerationComplete(generation))) {
    return false;
  }

  const generationConfigs = new Set(Object.values(generation.configNames));
  const unfinishedSpawns = isTowerDrainDuoTask(task) ? collectSpawningForConfigs(generationConfigs) : [];
  detachWarTaskCreeps(generationConfigs, isPatrolTask(task));
  for (const spawn of unfinishedSpawns) spawn.cancel();
  cleanupGenerationConfigs(task, generation);

  if (task.oneShot) {
    transitionWarTaskTerminal(task, "failed", "generation_exhausted");
    return true;
  }

  const nextId = Math.max(task.generationCounter ?? generation.id, generation.id) + 1;
  task.generationCounter = nextId;
  task.activeGeneration = createGeneration(task, nextId);
  task.boostStatus = isT3DuoTask(task) ? "preparing" : undefined;
  task.failReason = undefined;
  return true;
}

function getGenerationRemainingBoostAmounts(
  task: WarTask,
  generation: WarGenerationState,
): Map<ResourceConstant, number> {
  const amounts = new Map<ResourceConstant, number>();
  const spawns = getSpawnsForRoom(task.sourceRoom);

  for (const role of ["meleeAttacker", "healer"] as const) {
    const configName = generation.configNames[role];
    const creep = getLiveCreepsByConfig(configName)[0];
    if (!creep && task.oneShot) {
      const config = ensureConfigStore()[configName];
      const active = isConfigQueuedInSpawns(spawns, configName) || isConfigSpawning(configName);
      if (!active && config?.spawnOnce?.queuedAt !== undefined) {
        continue;
      }
    }

    const body = creep?.body ?? (getRoleBody(task, role) ?? []).map((type) => ({
      type,
      hits: 100,
    } as BodyPartDefinition));
    const compounds = role === "meleeAttacker" ? T3_ATTACKER_BOOSTS : T3_HEALER_BOOSTS;
    for (const compound of compounds) {
      const partType = T3_BOOST_PARTS[compound];
      if (!partType) continue;
      const partCount = body.filter((part) =>
        part.type === partType && part.hits > 0 && part.boost !== compound
      ).length;
      if (partCount <= 0) continue;
      amounts.set(compound, (amounts.get(compound) ?? 0) + partCount * LAB_BOOST_MINERAL);
    }
  }

  return amounts;
}

function prepareCombatSquad(task: WarTask): boolean {
  if (isTowerDrainDuoTask(task)) {
    const generation = ensureActiveGeneration(task);
    if (generation.phase === "preparing") generation.phase = "assembling";
    task.boostTier = undefined;
    task.boostStatus = undefined;
    task.boostLabs = undefined;
    return true;
  }
  if (!isT3DuoTask(task)) return true;

  const generation = ensureActiveGeneration(task);
  if (generation.phase === "deployed") return true;
  if (generation.boostGateOpenedAt !== undefined) {
    const remainingAmounts = getGenerationRemainingBoostAmounts(task, generation);
    const result = prepareBoosts(
      generation.boostTaskId,
      task.sourceRoom,
      0,
      remainingAmounts,
      { requireLabEnergy: true },
    );
    task.boostLabs = result.labs;
    task.boostStatus = result.status;
    task.failReason = result.reason;
    if (result.status === "failed" && result.reason === "insufficient_labs") {
      task.boostStatus = "preparing";
    }
    return true;
  }

  const result = prepareBoosts(
    generation.boostTaskId,
    task.sourceRoom,
    0,
    T3_DUO_BOOST_AMOUNTS,
    { requireLabEnergy: true },
  );
  task.boostLabs = result.labs;
  task.boostStatus = result.status;
  task.failReason = result.reason;

  if (result.status === "failed" && result.reason === "insufficient_labs") {
    task.boostStatus = "preparing";
    return false;
  }

  if (result.status === "failed") {
    transitionWarTaskTerminal(task, "failed", result.reason);
    return false;
  }

  if (result.status === "preparing") {
    return false;
  }

  generation.boostGateOpenedAt = Game.time;
  generation.phase = "assembling";
  return true;
}

function releaseWarBoosts(task: WarTask): void {
  if (!isT3DuoTask(task)) return;
  releaseBoostLabs(
    task.activeGeneration?.boostTaskId ?? getLegacyWarBoostTaskId(task),
    task.sourceRoom,
  );
  task.boostLabs = [];
}

function releaseWarTaskAssets(
  task: WarTask,
  options: WarTaskAssetReleaseOptions = {},
): WarTaskAssetReleaseResult {
  const configNames = new Set(getTaskConfigNames(task));
  const spawning = collectSpawningForConfigs(configNames);
  let removedQueuedTasks = 0;
  let removedConfigs = 0;
  for (const configName of configNames) {
    removedQueuedTasks += removeQueuedConfigByName(configName);
  }

  const detached = detachWarTaskCreeps(configNames, options.suicide === true);
  let cancelledSpawns = 0;
  for (const spawnState of spawning) {
    if (spawnState.cancel() === OK) cancelledSpawns += 1;
  }
  for (const configName of configNames) {
    removedConfigs += removeConfig(configName);
  }

  const releasedBoosts = isT3DuoTask(task);
  releaseWarBoosts(task);
  if (
    typeof task.assetsReleasedAt !== "number"
    || !Number.isFinite(task.assetsReleasedAt)
    || task.assetsReleasedAt < 0
  ) {
    task.assetsReleasedAt = Game.time;
  }
  return {
    removedConfigs,
    removedQueuedTasks,
    cancelledSpawns,
    detachedCreeps: detached.detachedCreeps,
    suicidedCreeps: detached.suicidedCreeps,
    releasedBoosts,
  };
}

function transitionWarTaskTerminal(
  task: WarTask,
  status: Extract<WarStatus, "done" | "failed">,
  failReason?: string | null,
): WarTaskAssetReleaseResult {
  setTaskStatus(task, status);
  task.completedAt ??= Game.time;
  if (failReason === null) {
    task.failReason = undefined;
  } else if (failReason !== undefined) {
    task.failReason = failReason;
  }
  return releaseWarTaskAssets(task);
}

function disableTaskProduction(task: WarTask): void {
  for (const configName of getTaskConfigNames(task)) {
    removeQueuedConfig(task, configName);
    removeConfig(configName);
  }
}

function processControllerVictory(task: WarTask): void {
  task.clearSince ??= Game.time;
  setTaskStatus(task, "clearing");
  if (!isPatrolTask(task)) {
    disableTaskProduction(task);
    releaseWarBoosts(task);
  }

  if (Game.time - task.clearSince + 1 < WAR_CLEAR_DEBOUNCE_TICKS) {
    return;
  }

  if (completePatrolTarget(task)) return;
  transitionWarTaskTerminal(task, "done", null);
}

function getQueuedConfigs(task: WarTask): string[] {
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  const generationConfigs = new Set(Object.values(task.activeGeneration?.configNames ?? {}));
  const queued = new Set<string>();
  for (const spawn of getSpawnsForRoom(task.sourceRoom)) {
    for (const configName of spawn.memory.spawnList || []) {
      if (configName.startsWith(prefix) || generationConfigs.has(configName)) {
        queued.add(configName);
      }
    }
  }
  return [...queued];
}

function getTaskCreeps(task: WarTask): WarStatusCreepSnapshot[] {
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  const generationConfigs = new Set(Object.values(task.activeGeneration?.configNames ?? {}));
  return Object.values(Game.creeps)
    .filter((creep) => {
      const configName = creep.memory.configName;
      return !!configName && (configName.startsWith(prefix) || generationConfigs.has(configName));
    })
    .map((creep) => ({
      name: creep.name,
      role: creep.memory.role,
      configName: creep.memory.configName,
      roomName: creep.room.name,
      x: creep.pos.x,
      y: creep.pos.y,
      hits: creep.hits,
      hitsMax: creep.hitsMax,
      boostedParts: creep.body.filter((part) => !!part.boost).length,
      spawning: !!creep.spawning,
      detached: creep.memory._warDetached === true,
    }));
}

function buildTaskStatusSnapshot(task: WarTask): WarStatusTaskSnapshot {
  const room = Game.rooms[task.targetRoom];
  const hostile = room ? getHostilePresence(room, task) : undefined;
  const sourceRoom = Game.rooms[task.sourceRoom];
  const generation = task.activeGeneration;
  const controller = room?.controller;
  return {
    targetRoom: task.targetRoom,
    sourceRoom: task.sourceRoom,
    status: task.status,
    reason: task.reason,
    squad: task.squad,
    routeRooms: task.routeRooms,
    routeTrace: task.routeTrace,
    squadDecision: task.squadDecision,
    boostTier: task.boostTier,
    oneShot: task.oneShot === true,
    boostStatus: task.boostStatus,
    attempts: task.attempts,
    age: Math.max(0, Game.time - task.createdAt),
    statusAge: Math.max(0, Game.time - (task.statusSince ?? task.createdAt)),
    clearTicks: task.clearSince === undefined ? 0 : Math.max(0, Game.time - task.clearSince + 1),
    targetVisible: !!room,
    hostileCreeps: hostile?.hostileCreeps ?? 0,
    hostileStructures: hostile?.hostileStructures ?? 0,
    hostileReservation: hostile?.hostileReservation ?? false,
    sourceEnergyAvailable: sourceRoom?.energyAvailable,
    sourceEnergyCapacity: sourceRoom?.energyCapacityAvailable,
    creeps: getTaskCreeps(task),
    queuedConfigs: getQueuedConfigs(task),
    generationId: generation?.id,
    generationPhase: generation?.phase,
    boostGateOpen: generation?.boostGateOpenedAt !== undefined,
    generationAge: generation ? Math.max(0, Game.time - generation.createdAt) : 0,
    deployedAge: generation?.deployedAt === undefined ? 0 : Math.max(0, Game.time - generation.deployedAt),
    controllerLevel: controller?.level,
    controllerOwner: controller?.owner?.username,
    controllerTicksToDowngrade: controller?.ticksToDowngrade,
    controllerUpgradeBlocked: controller?.upgradeBlocked,
    controllerAttackerConfigName:
      task.status === "downgrading" ? getControllerAttackConfigName(task) : undefined,
    controllerAttackerLastQueuedAt: task.controllerAttackerLastQueuedAt,
    controllerAttackerNextQueueAt: task.controllerAttackerLastQueuedAt === undefined
      ? undefined
      : task.controllerAttackerLastQueuedAt + CONTROLLER_ATTACKER_QUEUE_INTERVAL,
    patrolRooms: task.patrolRooms,
    patrolIndex: task.patrolIndex,
    patrolInterval: task.patrolInterval,
    patrolNextSweepAt: task.patrolNextSweepAt,
    patrolNextSweepIn: task.patrolNextSweepAt === undefined
      ? undefined
      : Math.max(0, task.patrolNextSweepAt - Game.time),
  };
}

function writeWarTelemetry(): void {
  const analytics = getMemoryService().ensureAnalytics();
  analytics.war = {
    updatedAt: Game.time,
    clearDebounceTicks: WAR_CLEAR_DEBOUNCE_TICKS,
    tasks: Object.fromEntries(
      Object.values(ensureWarStore()).map((task) => [task.targetRoom, buildTaskStatusSnapshot(task)]),
    ),
  };
}

function runNpcLootHandoffs(store: Record<string, WarTask>): void {
  for (const task of Object.values(store)) {
    if (task.status === "failed") continue;
    const room = Game.rooms[task.targetRoom];
    if (!room) continue;
    const authority = room.controller?.owner?.username ?? room.controller?.reservation?.username;
    if (authority === "Invader" || authority === "TooAngel" || (!authority && room.find(FIND_HOSTILE_STRUCTURES)
      .some(s => s.structureType === STRUCTURE_INVADER_CORE))) task.lootAfterClear = true;
    if (!task.lootAfterClear) continue;
    const hostile = getHostilePresence(room, task);
    if (hostile.hostileCreeps || hostile.hostileStructures) {
      if (!task.sharedSquadWatchId) delete task.combatClearSince;
      continue;
    }
    task.combatClearSince ??= Game.time;
    if (Game.time - task.combatClearSince + 1 >= WAR_CLEAR_DEBOUNCE_TICKS) ensureClearedNpcLootHandoff(task.sourceRoom, task.targetRoom);
  }
}

function processTask(task: WarTask): void {
  if (!task.routeTrace && task.routeRooms) task.routeTrace = { hops: Math.max(0, task.routeRooms.length - 1), avoided: {}, policy: task.routeOrigin === "map" ? "map_combat" : "manual" };
  if (task.routeOrigin === "map" && Game.time - (task.routePlannedAt ?? 0) >= 100) {
    const plan = defaultWarMapRoute(task.sourceRoom, task.targetRoom);
    const route = plan.rooms;
    task.routeTrace = plan.trace;
    task.routePlannedAt = Game.time;
    if (route && route.join("|") !== task.routeRooms?.join("|")) {
      task.routeRooms = route;
      synchronizeGenerationRoleArgs(task, false);
    }
  }
  if (task.npcAuto && isTowerDrainDuoTask(task) && task.squadAssessedAt !== undefined && Game.time - task.squadAssessedAt < 100 && task.failReason?.startsWith("npc_")) return;
  if (task.npcAuto && isTowerDrainDuoTask(task) && (task.squadAssessedAt === undefined || Game.time - task.squadAssessedAt >= 100)) {
    task.squadAssessedAt = Game.time;
    const room = Game.rooms[task.targetRoom];
    if (!room) { requestCombatObservation(task.targetRoom); task.failReason = "npc_policy_awaiting_vision"; return; }
    if (!isNpcWarTarget(room)) {
      // 空房继续既有清空判定；出现其它玩家的实际实体时停止自动升级。
      const otherOwner = room.controller?.owner?.username;
      if (otherOwner && otherOwner !== "Invader" && otherOwner !== "TooAngel") { task.failReason = "npc_identity_changed"; return; }
    }
    const decision = assessUnboostedNpc(room, task.routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[task.sourceRoom]?.energyCapacityAvailable);
    task.squadAssessedAt = Game.time;
    task.squadDecision = decision.reason;
    if (decision.reason === "entry_not_proven") { task.failReason = "npc_entry_not_proven"; return; }
    if (!decision.sufficient) {
      requestWarRoomClear(task.targetRoom, task.sourceRoom, { npcAuto: true });
      // 下一帧由源房调度器重新准入，不能绕过已有T3队伍的串行生产所有权。
      setTaskStatus(ensureWarStore()[task.targetRoom], "queued");
      return;
    }
    if (task.failReason?.startsWith("npc_")) delete task.failReason;
  }
  if (task.npcAuto) {
    const capacity = Game.rooms[task.sourceRoom]?.energyCapacityAvailable;
    const bodies = isTowerDrainDuoTask(task) ? [TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY] : [T3_ATTACKER_BODY, T3_HEALER_BODY];
    if (capacity !== undefined && bodies.some(body => body.reduce((sum, part) => sum + BODYPART_COST[part], 0) > capacity)) {
      task.failReason = "npc_source_capacity_insufficient";
      return;
    }
    if (task.failReason === "npc_source_capacity_insufficient") delete task.failReason;
  }
  if (isTowerDrainDuoTask(task)) requestCombatObservation(task.targetRoom);
  task.statusSince ??= task.createdAt;

  if (task.status === "patrol_waiting") {
    if (reconcileGenerationLifecycle(task)) return;
    if (Game.time < (task.patrolNextSweepAt ?? Game.time)) {
      if (!prepareCombatSquad(task)) return;
      ensureCombatConfigs(task);
      return;
    }
    if (!advancePatrol(task, 0)) return;
  }

  const room = Game.rooms[task.targetRoom];
  const stagingTooLong =
    task.status === "staging"
    && task.failReason !== "insufficient_labs"
    && Game.time - task.statusSince > MAX_STAGING_TICKS;
  if (stagingTooLong) {
    transitionWarTaskTerminal(task, "failed", "staging_timeout");
    return;
  }

  if (
    room
    && !isTowerDrainDuoTask(task)
    && task.reason === "manual"
    && !isPatrolTask(task)
    && isControllerDefeated(room)
    && !hasControllerAttackBlockers(room)
  ) {
    processControllerVictory(task);
    return;
  }

  if (reconcileGenerationLifecycle(task)) {
    return;
  }

  if (!room) {
    setTaskStatus(task, "staging");
    task.clearSince = undefined;
    if (!prepareCombatSquad(task)) return;
    ensureCombatConfigs(task);
    return;
  }

  const hostile = getHostilePresence(room, task);
  if (!isTowerDrainDuoTask(task) && task.reason === "manual" && !isPatrolTask(task) && isControllerDowngradeReady(room)) {
    task.clearSince = undefined;
    const combatReady = prepareCombatSquad(task);
    if (combatReady) ensureCombatConfigs(task);
    setTaskStatus(task, "downgrading");
    ensureControllerAttackConfig(task);
    return;
  }

  clearControllerAttackConfig(task);
  if (!hostile.present) {
    task.clearSince ??= Game.time;
    if (Game.time - task.clearSince + 1 < WAR_CLEAR_DEBOUNCE_TICKS) {
      setTaskStatus(task, "clearing");
      if (!prepareCombatSquad(task)) return;
      ensureCombatConfigs(task);
      return;
    }

    if (!completePatrolTarget(task)) {
      transitionWarTaskTerminal(task, "done", null);
    }
    return;
  }

  task.lastHostileSeenAt = Game.time;
  task.clearSince = undefined;
  setTaskStatus(task, "clearing");
  if (!prepareCombatSquad(task)) return;
  ensureCombatConfigs(task);
}

function setTaskCreepsQueued(task: WarTask, queued: boolean): void {
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  const generationConfigs = new Set(Object.values(task.activeGeneration?.configNames ?? {}));
  for (const creep of Object.values(Game.creeps)) {
    const configName = creep.memory.configName;
    if (!configName || (!configName.startsWith(prefix) && !generationConfigs.has(configName))) continue;
    if (queued) {
      creep.memory._warQueued = true;
    } else {
      delete creep.memory._warQueued;
    }
  }
}

function parkQueuedFrontline(task: WarTask): void {
  setTaskStatus(task, "queued");
  task.clearSince = undefined;
  task.boostStatus = undefined;
  task.failReason = "frontline_queued";
  disableTaskProduction(task);
  releaseWarBoosts(task);
  setTaskCreepsQueued(task, true);
}

function activateFrontline(task: WarTask): void {
  if (task.status === "queued") {
    setTaskStatus(task, "staging");
    if (task.failReason === "frontline_queued") {
      task.failReason = undefined;
    }
    if (isT3DuoTask(task)) {
      task.boostStatus = "preparing";
    }
  }
  setTaskCreepsQueued(task, false);
}

function defaultWarMapRoute(sourceRoom: string, targetRoom: string): { rooms?: string[]; trace: NonNullable<WarTask["routeTrace"]> } {
  const avoided: Record<string, string> = {};
  for (const room of Object.values(Game.rooms)) {
    if (room.name === sourceRoom || room.name === targetRoom || room.controller?.my || typeof room.find !== "function") continue;
    if (getRefillableHostileTowers(room).length > 0) avoided[room.name] = "current_tower_threat";
    else if (room.find(FIND_HOSTILE_CREEPS).some(actor => actor.body?.some(part => part.hits > 0 && (part.type === ATTACK || part.type === RANGED_ATTACK)))) avoided[room.name] = "current_combat_creep";
  }
  const trace: NonNullable<WarTask["routeTrace"]> = { hops: 0, avoided, policy: "map_combat" };
  if (!/^[WE]\d+[NS]\d+$/.test(sourceRoom) || !/^[WE]\d+[NS]\d+$/.test(targetRoom) || typeof Game.map?.findRoute !== "function") return { trace };
  const route = Game.map.findRoute(sourceRoom, targetRoom, { routeCallback: name => avoided[name] ? Infinity : 1 });
  if (!Array.isArray(route)) return { trace };
  const rooms = [sourceRoom, ...route.map((step) => step.room)];
  trace.hops = route.length;
  return { rooms: rooms[rooms.length - 1] === targetRoom ? rooms : undefined, trace };
}

export function requestWarRoomClear(
  targetRoom: string,
  sourceRoom: string,
  options?: { routeRooms?: string[]; reason?: "npc_reservation" | "manual"; squad?: WarSquad; boostTier?: WarBoostTier; oneShot?: boolean; npcAuto?: true },
): void {
  const store = ensureWarStore();
  const existing = store[targetRoom];
  const now = Game.time;
  const restarting = !existing || existing.status === "done" || existing.status === "failed";
  const npcAuto = options?.squad !== undefined || options?.boostTier !== undefined ? undefined
    : options?.npcAuto ?? existing?.npcAuto ?? ((!existing || restarting) && (options?.reason === "npc_reservation" || Game.rooms[targetRoom] && isNpcWarTarget(Game.rooms[targetRoom])) ? true : undefined);
  const inheritedRoute = existing?.sourceRoom === sourceRoom ? existing.routeRooms : undefined;
  const plan = options?.routeRooms || inheritedRoute ? undefined : defaultWarMapRoute(sourceRoom, targetRoom);
  const routeRooms = options?.routeRooms ?? inheritedRoute ?? plan?.rooms;
  const decision = npcAuto && Game.rooms[targetRoom] ? assessUnboostedNpc(Game.rooms[targetRoom], routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[sourceRoom]?.energyCapacityAvailable) : undefined;
  const needsT3 = !restarting && existing?.squad === "t3Duo" || decision && !decision.sufficient && decision.reason !== "entry_not_proven";
  const squad = options?.squad ?? (npcAuto ? needsT3 ? "t3Duo" : "towerDrainDuo" : existing?.squad);
  const changedSquad = !!existing && existing.squad !== squad;
  const restart = !existing || existing.status === "done" || existing.status === "failed"
    || existing.sourceRoom !== sourceRoom || changedSquad;
  const nextStatus: WarStatus = restart ? "staging" : existing.status;
  const nextAttempts = restart ? (existing?.attempts ?? 0) + 1 : (existing?.attempts ?? 1);

  if (existing && restart) {
    releaseWarTaskAssets(existing);
  }

  store[targetRoom] = {
    targetRoom,
    sourceRoom,
    status: nextStatus,
    reason: options?.reason ?? existing?.reason ?? "npc_reservation",
    routeRooms,
    routeOrigin: options?.routeRooms ? "manual" : existing?.sourceRoom === sourceRoom && existing.routeRooms ? existing.routeOrigin ?? "manual" : "map",
    routePlannedAt: options?.routeRooms || !existing?.routeRooms ? now : existing.routePlannedAt,
    routeTrace: options?.routeRooms ? { hops: Math.max(0, options.routeRooms.length - 1), avoided: {}, policy: "manual" } : inheritedRoute ? existing?.routeTrace ?? { hops: inheritedRoute.length - 1, avoided: {}, policy: existing?.routeOrigin === "map" ? "map_combat" : "manual" } : plan?.trace,
    npcAuto,
    squadDecision: npcAuto ? decision?.reason ?? "awaiting_vision" : "explicit_or_player_default",
    squadAssessedAt: npcAuto && decision && decision.reason !== "entry_not_proven" ? now : undefined,
    squad,
    boostTier: squad === "towerDrainDuo" ? undefined : options?.boostTier ?? (npcAuto && squad === "t3Duo" ? "t3" : existing?.boostTier),
    boostLabs: restart ? undefined : existing?.boostLabs,
    boostStatus: restart ? undefined : existing?.boostStatus,
    oneShot: options?.oneShot ?? existing?.oneShot,
    failReason: restart ? undefined : existing?.failReason,
    attempts: nextAttempts,
    createdAt: restart ? now : (existing?.createdAt ?? now),
    statusSince: restart ? now : (existing?.statusSince ?? now),
    lastHostileSeenAt: restart ? undefined : existing?.lastHostileSeenAt,
    clearSince: restart ? undefined : existing?.clearSince,
    updatedAt: now,
    completedAt: restart ? undefined : existing?.completedAt,
    assetsReleasedAt: restart ? undefined : existing?.assetsReleasedAt,
    controllerAttackerLastQueuedAt: restart ? undefined : existing?.controllerAttackerLastQueuedAt,
    generationCounter: restart
      ? (existing?.sourceRoom === sourceRoom
        ? Math.max(existing.generationCounter ?? 0, existing.activeGeneration?.id ?? 0)
        : undefined)
      : existing?.generationCounter,
    activeGeneration: restart ? undefined : existing?.activeGeneration,
  };
}

export function startWarRoom(targetRoom: string, sourceRoom: string, options: StartWarOptions = {}): StartWarResult | string {
  if (!targetRoom || !sourceRoom) {
    return "ERR_INVALID_ARGS:startWar(targetRoom, sourceRoom)";
  }

  const npcAuto = options.squad === undefined && options.boostTier === undefined && !!Game.rooms[targetRoom] && isNpcWarTarget(Game.rooms[targetRoom]);
  const squad = npcAuto ? undefined : options.squad ?? "t3Duo";
  const boostTier = squad === "towerDrainDuo" ? undefined : options.boostTier ?? (squad === "t3Duo" ? "t3" : undefined);
  const oneShot = options.oneShot ?? true;

  requestWarRoomClear(targetRoom, sourceRoom, {
    routeRooms: options.routeRooms,
    reason: "manual",
    squad,
    boostTier,
    oneShot,
    npcAuto: npcAuto ? true : undefined,
  });

  const task = ensureWarStore()[targetRoom];
  return {
    ok: true,
    targetRoom: task.targetRoom,
    sourceRoom: task.sourceRoom,
    status: task.status,
    reason: "manual",
    squad: task.squad,
    boostTier: task.boostTier,
    oneShot: task.oneShot === true,
    attempts: task.attempts,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function startWarPatrol(
  sourceRoom: string,
  targetRooms: string[],
  options: StartWarPatrolOptions = {},
): StartWarPatrolResult | string {
  const patrolRooms = [...new Set(targetRooms.filter((roomName) => roomName.length > 0))];
  if (!sourceRoom || patrolRooms.length === 0) {
    return "ERR_INVALID_ARGS:startWarPatrol(sourceRoom, targetRooms, options?)";
  }

  const store = ensureWarStore();
  for (const task of Object.values(store)) {
    const terminal = task.status === "done" || task.status === "failed";
    const overlapsPatrol = patrolRooms.some((roomName) =>
      task.targetRoom === roomName || task.patrolRooms?.includes(roomName)
    );
    if (terminal && (task.sourceRoom === sourceRoom || overlapsPatrol)) {
      releaseWarTaskAssets(task);
    }
  }

  const sourceConflict = Object.values(store).find((task) =>
    task.sourceRoom === sourceRoom && task.status !== "done" && task.status !== "failed"
  );
  if (sourceConflict) {
    return `ERR_SOURCE_FRONTLINE_ACTIVE:${sourceRoom}:${sourceConflict.targetRoom}`;
  }

  const sourceActivity = Object.values(store).find((task) =>
    task.sourceRoom === sourceRoom && hasTaskWarActivity(task)
  );
  if (sourceActivity) {
    return `ERR_SOURCE_WAR_ACTIVITY:${sourceRoom}:${sourceActivity.targetRoom}`;
  }

  for (const roomName of patrolRooms) {
    const collision = Object.values(store).find((task) =>
      task.targetRoom === roomName || task.patrolRooms?.includes(roomName)
    );
    if (!collision) continue;

    const terminal = collision.status === "done" || collision.status === "failed";
    if (!terminal) {
      return `ERR_PATROL_TARGET_ACTIVE:${roomName}`;
    }
    if (hasTaskWarActivity(collision)) {
      return `ERR_PATROL_TARGET_ACTIVITY:${roomName}`;
    }
  }

  for (const [key, task] of Object.entries(store)) {
    const overlapsPatrol = patrolRooms.some((roomName) =>
      task.targetRoom === roomName || task.patrolRooms?.includes(roomName)
    );
    if (
      (task.sourceRoom === sourceRoom || overlapsPatrol)
      && (task.status === "done" || task.status === "failed")
    ) {
      delete store[key];
    }
  }

  const intervalTicks = Number.isFinite(options.intervalTicks)
    ? Math.max(MIN_PATROL_INTERVAL_TICKS, Math.floor(options.intervalTicks!))
    : DEFAULT_PATROL_INTERVAL_TICKS;
  const result = startWarRoom(patrolRooms[0], sourceRoom, {
    squad: "t3Duo",
    boostTier: "t3",
    oneShot: false,
  });
  if (typeof result === "string") return result;

  const task = store[patrolRooms[0]];
  task.patrolRooms = patrolRooms;
  task.patrolIndex = 0;
  task.patrolInterval = intervalTicks;
  task.patrolNextSweepAt = undefined;
  return {
    ...result,
    patrolRooms: [...patrolRooms],
    patrolIndex: 0,
    patrolInterval: intervalTicks,
  };
}

export function isWarRoomClearDone(roomName: string): boolean {
  const task = Memory.data?.war?.[roomName];
  return task?.status === "done";
}

export function clearWarRoomTask(roomName: string): void {
  releaseWarTaskOwner(roomName);
}

export function releaseWarTaskOwner(taskKey: string, options: StopWarOptions = {}): StopWarResult | string {
  const store = Memory.data?.war;
  if (!store || !Object.prototype.hasOwnProperty.call(store, taskKey)) {
    return `ERR_NO_WAR_TASK:${taskKey}`;
  }
  const task = store[taskKey];
  const released = releaseWarTaskAssets(task, options);
  delete store[taskKey];
  writeWarTelemetry();

  return {
    ok: true,
    targetRoom: task.targetRoom,
    removedTask: true,
    removedConfigs: released.removedConfigs,
    removedQueuedTasks: released.removedQueuedTasks,
    cancelledSpawns: released.cancelledSpawns,
    suicidedCreeps: released.suicidedCreeps,
    releasedBoosts: released.releasedBoosts,
  };
}

export function stopWarRoom(targetRoom: string, options: StopWarOptions = {}): StopWarResult | string {
  const store = Memory.data?.war;
  if (!store) {
    return `ERR_NO_WAR_TASK:${targetRoom}`;
  }
  const taskEntry = Object.entries(store).find(([key, candidate]) =>
    key === targetRoom || candidate.targetRoom === targetRoom || candidate.patrolRooms?.includes(targetRoom)
  );
  if (!taskEntry) {
    return `ERR_NO_WAR_TASK:${targetRoom}`;
  }
  return releaseWarTaskOwner(taskEntry[0], options);
}

export function getWarStatus(targetRoom?: string): WarStatusSnapshot {
  return {
    ok: true,
    tick: Game.time,
    tasks: Object.values(ensureWarStore())
      .filter((task) => !targetRoom || task.targetRoom === targetRoom || task.patrolRooms?.includes(targetRoom))
      .map((task) => buildTaskStatusSnapshot(task)),
  };
}

/** 注册观察后补剿策略；不重启现役任务，也不立即孵化小队。 */
export function configureWarRebuildWatch(sourceRoom: string, targetRooms: string[], enemyUsername: string, intervalTicks = 100, sharedSquad = false): { ok: true; id: string } | string {
  const rooms = [...new Set(targetRooms)].sort();
  const validRoom = (name: string) => /^[WE]\d+[NS]\d+$/.test(name);
  const source = Game.rooms[sourceRoom];
  if (!source?.controller?.my || !validRoom(sourceRoom) || !rooms.length || rooms.some((name) => !validRoom(name) || name === sourceRoom)
    || !enemyUsername || enemyUsername === source.controller.owner?.username || !Number.isFinite(intervalTicks) || intervalTicks < 1) return "ERR_INVALID_REBUILD_WATCH";
  const id = `${sourceRoom}:${enemyUsername}:${rooms.join("|")}`;
  getMemoryService().ensureCfg().warRebuildWatch ??= {};
  getMemoryService().ensureCfg().warRebuildWatch![id] = { sourceRoom, targetRooms: rooms, enemyUsername, intervalTicks: Math.floor(intervalTicks), ...(sharedSquad ? { sharedSquad: true } : {}) };
  return { ok: true, id };
}

/** 只退役战斗成员，控制器攻击者继续执行；已有生产也归同一所有权收口。 */
function retireSharedCombat(task: WarTask): void {
  const names = new Set(getTaskConfigNames(task).filter((name) => name !== getControllerAttackConfigName(task)));
  const spawning = collectSpawningForConfigs(names);
  for (const creep of Object.values(Game.creeps)) {
    if (!creep.memory.configName || !names.has(creep.memory.configName)) continue;
    creep.memory._warRetireToRoom = task.sourceRoom;
    resetWarCreepTargetState(creep);
  }
  detachWarTaskCreeps(names, false);
  for (const spawn of spawning) spawn.cancel();
  for (const name of names) { removeQueuedConfigByName(name); removeConfig(name); }
  releaseWarBoosts(task);
  delete task.activeGeneration;
}

function retireSharedController(task: WarTask): void {
  const name = getControllerAttackConfigName(task);
  const spawning = collectSpawningForConfigs(new Set([name]));
  for (const actor of getLiveCreepsByConfig(name)) {
    actor.memory._recycleToRoom = task.sourceRoom;
    resetWarCreepTargetState(actor);
    delete actor.memory.configName;
  }
  for (const spawn of spawning) spawn.cancel();
  clearControllerAttackConfig(task);
  delete task.controllerAttackerLastQueuedAt;
}

function sharedSquadScore(task: WarTask): number {
  const generation = task.activeGeneration;
  if (!generation) return 0;
  const members = Object.values(generation.configNames).map((name) => getLiveCreepsByConfig(name)[0]);
  if (members.some((creep) => !creep || creep.spawning)) return 1;
  const attacker = members[0]!;
  const power = attacker.body.reduce((sum, part) => sum + (part.type === ATTACK && part.hits > 0
    ? ATTACK_POWER * (part.boost ? (BOOSTS[ATTACK][part.boost]?.attack ?? 1) : 1) : 0), 0);
  return 1_000_000 + power * 1000 + Math.min(...members.map((creep) => creep!.ticksToLive ?? 0));
}

/** 完成目标后原子换名和搭档；不会为下一房再孵化另一对成员。 */
function transferSharedGeneration(from: WarTask, to: WarTask): boolean {
  const previous = from.activeGeneration;
  if (!previous || previous.phase !== "deployed") return false;
  const roles: WarRole[] = ["meleeAttacker", "healer"];
  const members = roles.map((role) => getLiveCreepsByConfig(previous.configNames[role])[0]);
  if (members.some((creep) => !creep || creep.spawning)) return false;
  const id = Math.max(to.generationCounter ?? 0, previous.id) + 1;
  const generation: WarGenerationState = { ...previous, id, boostTaskId: getGenerationBoostTaskId(to, id), configNames: {
    meleeAttacker: getGenerationConfigName(to, id, "meleeAttacker"),
    healer: getGenerationConfigName(to, id, "healer"),
  } };
  to.squad = from.squad;
  to.boostTier = from.boostTier;
  to.boostStatus = from.boostStatus;
  to.activeGeneration = generation;
  to.generationCounter = id;
  to.npcAuto = true;
  const store = ensureConfigStore();
  if (transferredMembers?.game !== Game || transferredMembers.tick !== Game.time) transferredMembers = { game: Game, tick: Game.time, byConfig: new Map() };
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index];
    const member = members[index]!;
    const name = generation.configNames[role];
    removeQueuedConfigByName(previous.configNames[role]);
    removeConfig(previous.configNames[role]);
    member.memory.configName = name;
    member.memory._warPartnerConfigName = generation.configNames[role === "meleeAttacker" ? "healer" : "meleeAttacker"];
    resetWarCreepTargetState(member);
    store[name] = { role, roomName: to.sourceRoom, args: [], body: getRoleBody(to, role), spawnOnce: { queuedAt: previous.createdAt } };
    transferredMembers!.byConfig.set(name, [member]);
  }
  synchronizeGenerationRoleArgs(to, false);
  delete from.activeGeneration;
  releaseWarBoosts(from);
  setTaskStatus(to, "staging");
  delete to.failReason;
  return true;
}

/** 同组所有房间保留独立任务/降级器，只有一份战斗世代能够生产或出征。 */
function runSharedWarSquads(store: Record<string, WarTask>): Set<WarTask> {
  const managed = new Set<WarTask>();
  for (const task of Object.values(store)) {
    if (task.sharedSquadWatchId && !Memory.cfg?.warRebuildWatch?.[task.sharedSquadWatchId]?.sharedSquad) {
      delete task.sharedSquadWatchId;
      delete task.combatClearedAt;
      delete task.combatClearSince;
    }
  }
  for (const [id, config] of Object.entries(Memory.cfg?.warRebuildWatch ?? {})) {
    if (!config.sharedSquad) continue;
    const state = getMemoryService().ensureRuntime().warRebuildWatch ??= {};
    const watch = state[id] ??= { clearedRooms: [], targets: {} };
    const tasks = config.targetRooms.map((name) => store[name]).filter((task): task is WarTask => !!task
      && task.sourceRoom === config.sourceRoom && task.status !== "done" && task.status !== "failed" && !managed.has(task));
    for (const task of tasks) {
      managed.add(task);
      task.sharedSquadWatchId = id;
      retireSharedController(task);
      if (!Game.rooms[config.sourceRoom]?.controller?.my) {
        retireSharedCombat(task);
        task.failReason = "shared_source_not_owned";
        continue;
      }
      if (task.failReason === "shared_source_not_owned") delete task.failReason;
      if (task.combatClearedAt === undefined) requestCombatObservation(task.targetRoom);
      const room = Game.rooms[task.targetRoom];
      if (!room) continue;
      if (room.controller?.my || (room.controller?.owner && room.controller.owner.username !== config.enemyUsername)) {
        task.failReason = "shared_target_owner_changed";
        retireSharedCombat(task);
        continue;
      }
      if ((task.squad === "t3Duo" || task.boostTier === "t3") && isNpcWarTarget(room)) {
        const decision = assessUnboostedNpc(room, task.routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[task.sourceRoom]?.energyCapacityAvailable);
        if (decision.sufficient) {
          // 无强化优先也覆盖现役选择；只有新鲜能力证据充足才撤回旧T3。
          retireSharedCombat(task);
          task.squad = "towerDrainDuo";
          delete task.boostTier;
          delete task.boostStatus;
          task.npcAuto = true;
          task.squadAssessedAt = Game.time;
          task.squadDecision = decision.reason;
        }
      }
      const hostile = getHostilePresence(room, task);
      if (hostile.hostileCreeps > 0 || hostile.hostileStructures > 0) {
        delete task.combatClearedAt;
        delete task.combatClearSince;
      } else {
        if (task.rebuildIgnoreStructureIds && task.activeGeneration && task.activeGeneration.phase !== "deployed") retireSharedCombat(task);
        task.combatClearSince ??= Game.time;
        if (Game.time - task.combatClearSince + 1 >= WAR_CLEAR_DEBOUNCE_TICKS) task.combatClearedAt ??= Game.time;
      }
    }
    const pending = tasks.filter((task) => task.combatClearedAt === undefined && !task.failReason?.startsWith("shared_target_owner") && task.failReason !== "shared_source_not_owned");
    let owner = tasks.find((task) => task.targetRoom === watch.sharedSquadOwner && task.failReason !== "shared_target_owner_changed" && task.failReason !== "shared_source_not_owned");
    if (!owner) owner = [...pending].sort((a, b) => sharedSquadScore(b) - sharedSquadScore(a))[0];
    // 换策略时先收回重复生产/成员，再决定是否把现役成员交给下一房。
    for (const task of tasks) if (task !== owner) retireSharedCombat(task);
    if (owner?.combatClearedAt !== undefined) {
      const next = pending[0];
      if (next) transferSharedGeneration(owner, next);
      if (!next || owner.activeGeneration) retireSharedCombat(owner);
      owner = next;
    }
    watch.sharedSquadOwner = owner?.targetRoom;
    for (const task of tasks) {
      const room = Game.rooms[task.targetRoom];
      if (task.failReason === "shared_target_owner_changed" || task.failReason === "shared_source_not_owned") continue;
      if (task.combatClearedAt !== undefined) {
        if (room && isControllerDefeated(room)) transitionWarTaskTerminal(task, "done", null);
        else { setTaskStatus(task, "downgrading"); ensureControllerAttackConfig(task); }
        continue;
      }
      if (task !== owner) {
        setTaskStatus(task, "queued");
        task.failReason = "shared_squad_queued";
        if (room && isControllerDowngradeReady(room)) ensureControllerAttackConfig(task);
        continue;
      }
      // 清空去抖只等视野稳定；不能为了等这几十tick再孵化一队。
      if (task.combatClearSince !== undefined) {
        setTaskStatus(task, "clearing");
        if (room && isControllerDowngradeReady(room)) ensureControllerAttackConfig(task);
        continue;
      }
      // 现役强化成员继续使用；只有真的需要新世代时重新评估无强化能力。
      if (task.activeGeneration?.phase === "deployed" && !isGenerationComplete(task.activeGeneration)) retireSharedCombat(task);
      if (!task.activeGeneration && room && isNpcWarTarget(room)) {
        const decision = assessUnboostedNpc(room, task.routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[task.sourceRoom]?.energyCapacityAvailable);
        if (decision.reason === "entry_not_proven") { task.failReason = "npc_entry_not_proven"; continue; }
        task.squad = decision.sufficient ? "towerDrainDuo" : "t3Duo";
        task.boostTier = decision.sufficient ? undefined : "t3";
        task.npcAuto = true;
        task.squadAssessedAt = Game.time;
        task.squadDecision = decision.reason;
      }
      activateFrontline(task);
      if (task.failReason === "shared_squad_queued") delete task.failReason;
      processTask(task);
    }
  }
  return managed;
}

/** 复用观察调度和War唯一目标任务；无新鲜视野不派队，战斗中不重复派队。 */
function runWarRebuildWatches(store: Record<string, WarTask>): void {
  const configs = Memory.cfg?.warRebuildWatch;
  if (!configs || Object.keys(configs).length === 0) return;
  const runtime = getMemoryService().ensureRuntime();
  runtime.warRebuildWatch ??= {};
  for (const id of Object.keys(runtime.warRebuildWatch)) if (!configs[id]) delete runtime.warRebuildWatch[id];
  for (const [id, config] of Object.entries(configs)) {
    const state = runtime.warRebuildWatch[id] ??= { clearedRooms: [], targets: {} };
    const targets = [...new Set(config.targetRooms)];
    for (const name of targets) {
      if (store[name]?.sourceRoom !== config.sourceRoom || (store[name].status !== "done" && store[name].combatClearedAt === undefined)
        || state.clearedRooms.includes(name)) continue;
      state.clearedRooms.push(name);
      // 清场完成帧已有的残留实体是基线；失去视野时，已确认清空的结果仍保留。
      const target = state.targets[name] ??= {};
      target.lastTriggeredEvidenceIds ??= Game.rooms[name] ? getWarRebuildEvidence(Game.rooms[name], config.enemyUsername)
        .filter(item => !item.startsWith("creep:")) : [];
    }
    // 每房完成记录独立于短期War任务，避免200tick终态清理丢掉首轮成果。
    if (state.armedAt === undefined) {
      if (targets.length === 0 || !targets.every((name) => state.clearedRooms.includes(name))) continue;
      state.armedAt = Game.time;
    }
    for (const name of targets) {
      const target = state.targets[name] ??= {};
      const task = store[name];
      if (!Game.rooms[config.sourceRoom]?.controller?.my) { target.blocker = "source_not_owned"; continue; }
      if (Game.rooms[name]?.controller?.my) { target.blocker = "target_owned"; continue; }
      if (task && task.status !== "done" && task.status !== "failed" && task.combatClearedAt === undefined) { target.blocker = "clear_active"; delete target.pendingObservationAt; continue; }
      if (task?.status === "failed" || target.blocker === "clear_failed") { target.blocker = "clear_failed"; continue; }
      const interval = Math.max(1, Math.floor(config.intervalTicks));
      if (target.pendingObservationAt === undefined) {
        if (Game.time < (target.nextObservationAt ?? Game.time)) continue;
        target.nextObservationAt = Game.time + interval;
        if (!requestCombatObservation(name)) { target.blocker = "observer_unavailable"; continue; }
        target.pendingObservationAt = Game.time;
        target.blocker = "awaiting_vision";
        continue;
      }
      const room = Game.rooms[name];
      if (!room) {
        if (Game.time - target.pendingObservationAt > OBSERVATION_REQUEST_TTL) { delete target.pendingObservationAt; target.blocker = "observer_timeout"; }
        continue;
      }
      target.lastSeenAt = Game.time;
      delete target.pendingObservationAt;
      target.blocker = undefined;
      if (room.controller?.owner && room.controller.owner.username !== config.enemyUsername) { target.blocker = "target_owner_changed"; continue; }
      // 控制器归属本身不是重建。观察到对手creep或新造的实体/工地才启动。
      const evidence = getWarRebuildEvidence(room, config.enemyUsername);
      // 手动结束首轮任务或旧监视状态没有基线时，首次观察只登记旧建筑/工地。
      // 对方 creep 仍是即时重建证据，不能因首次扫描而吞掉。
      const previous = new Set(target.lastTriggeredEvidenceIds ?? evidence.filter(item => !item.startsWith("creep:")));
      const newEvidence = evidence.some((item) => !previous.has(item));
      target.lastTriggeredEvidenceIds = evidence;
      // 减少旧证据不是重建；例如creep已被击杀，但其工地仍残留。
      if (!newEvidence) continue;
      requestWarRoomClear(name, config.sourceRoom, { reason: "manual", npcAuto: true, oneShot: false });
      // 补剿处理新入侵者/新建筑，旧空墙与被动设施不要求再拆一轮。
      // 挡住实际目标的墙仍由角色的通用破障路径处理。
      store[name].rebuildIgnoreStructureIds = [...new Set([
        ...[...previous].filter(item => item.startsWith("structure:")).map(item => item.slice("structure:".length)),
        ...room.find(FIND_STRUCTURES).filter(s => s.structureType === STRUCTURE_WALL).map(s => s.id),
      ])];
      target.lastTriggeredAt = Game.time;
      target.triggerCount = (target.triggerCount ?? 0) + 1;
      target.blocker = "clear_active";
    }
  }
}

function getWarRebuildEvidence(room: Room, enemyUsername: string): string[] {
  return [
    ...room.find(FIND_HOSTILE_CREEPS).filter(c => c.owner.username === enemyUsername).map(c => `creep:${c.id}`),
    ...room.find(FIND_HOSTILE_CONSTRUCTION_SITES).filter(s => s.owner.username === enemyUsername).map(s => `site:${s.id}`),
    ...room.find(FIND_HOSTILE_STRUCTURES).filter(s => s.structureType !== STRUCTURE_CONTROLLER
      && s.structureType !== STRUCTURE_KEEPER_LAIR && "owner" in s && (s as OwnedStructure).owner.username === enemyUsername).map(s => `structure:${s.id}`),
  ].sort();
}

export function runWarControl(): void {
  const store = ensureWarStore();
  const tasks = Object.values(store);
  for (const task of tasks) {
    const terminal = task.status === "done" || task.status === "failed";
    if (terminal && (
      typeof task.assetsReleasedAt !== "number"
      || !Number.isFinite(task.assetsReleasedAt)
      || task.assetsReleasedAt < 0
    )) {
      releaseWarTaskAssets(task);
    }
  }
  const sharedTasks = runSharedWarSquads(store);
  const tasksBySource = new Map<string, WarTask[]>();
  for (const task of tasks) {
    if (sharedTasks.has(task)) continue;
    const sourceTasks = tasksBySource.get(task.sourceRoom) ?? [];
    sourceTasks.push(task);
    tasksBySource.set(task.sourceRoom, sourceTasks);
  }

  for (const sourceTasks of tasksBySource.values()) {
    const candidates = sourceTasks.filter(
      (task) => task.status !== "done" && task.status !== "failed",
    );
    const serialCandidates = candidates.filter((task) => !isTowerDrainDuoTask(task));
    const active = serialCandidates.find((task) => task.status !== "queued") ?? serialCandidates[0];

    for (const task of serialCandidates) {
      if (task !== active) {
        parkQueuedFrontline(task);
      }
    }

    if (active) {
      activateFrontline(active);
      processTask(active);
    }
    // 耗塔任务使用各自的双人 generation，允许同母房多个目标并行。
    for (const task of candidates.filter(isTowerDrainDuoTask)) {
      activateFrontline(task);
      processTask(task);
    }
  }

  for (const task of tasks) {
    task.updatedAt = Game.time;
  }
  runWarRebuildWatches(store);
  runNpcLootHandoffs(store);
  writeWarTelemetry();
}
