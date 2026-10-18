import { queuedConfigNames, queuedSpawns, spawningForConfig } from "./spawnIndex";
import { getSquadPolicy, getHealerCount, getMeleeCount } from "./squadPolicy/index";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { type CreepConfig } from "@/types/system";
import { DEFAULT_PATROL_INTERVAL_TICKS, MIN_PATROL_INTERVAL_TICKS, WAR_CONTROLLER_ATTACK_CONFIG_SUFFIX } from "./constants";

export type WarStatus = "queued" | "staging" | "clearing" | "downgrading" | "patrol_waiting" | "done" | "failed";

export type WarSquad = "standard" | "t3Duo" | "towerDrainDuo";

export type WarBoostTier = "t3";

export type WarRole = "meleeAttacker" | "healer";

export type WarGenerationPhase = "preparing" | "assembling" | "deployed";

export interface WarGenerationState {
  id: number;
  phase: WarGenerationPhase;
  createdAt: number;
  boostTaskId: string;
  boostGateOpenedAt?: number;
  deployedAt?: number;
  argsVersion?: string;
  configNames: Record<WarRole, string>;
}

export interface WarMember { configName: string; creepNames: string[]; spawnedAt?: number }

/** spawnCreep(OK) 当帧登记，停止任务时不依赖尚未出现的 Game.creeps/native spawning。 */
export function registerWarSpawn(configName: string, creepName: string): void {
  if (!configName.includes(":war:")) return;
  const task = Object.values(Memory.data?.war ?? {}).find(candidate => candidate.members?.[configName]
    || configName.startsWith(`${candidate.sourceRoom}:war:${candidate.targetRoom}:`));
  if (!task) return;
  const members = task.members ??= {};
  const member = members[configName] ??= { configName, creepNames: [] };
  if (!Array.isArray(member.creepNames)) member.creepNames = [];
  if (!member.creepNames.includes(creepName)) member.creepNames.push(creepName);
  member.spawnedAt ??= Game.time;
}

export interface WarTask {
  reserveContinuationUntil?: number;
  entryEffect?: string;
  members?: Record<string, WarMember>;
  membersVersion?: 1;
  nextCheckAt?: number;
  scheduleKey?: string;
  sharedRetiredAt?: number;
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
  tactic?: "t3TowerDrainDuo";
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

export interface HostilePresenceSnapshot {
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
  tactic?: "t3TowerDrainDuo";
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
  tactic?: "t3TowerDrainDuo";
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

export interface WarTaskAssetReleaseOptions {
  suicide?: boolean;
}

export interface WarTaskAssetReleaseResult {
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
  tactic?: "t3TowerDrainDuo";
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

export function sameArray(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean { return Array.isArray(left) && left.length === right.length && left.every((value, i) => value === right[i]); }

export function warOffset(name: string, period: number): number { let hash = 0; for (let i = 0; i < name.length; i++) hash = (Math.imul(hash, 31) + name.charCodeAt(i)) >>> 0; return hash % period; }

export function warPeriodicDue(last: number | undefined, room: string): boolean {
  if (last === undefined || last <= 0) return true;
  return Game.time - last >= 100 || Game.time > last && Game.time % 100 === warOffset(room, 100);
}

export function ensureWarStore(): Record<string, WarTask> {
  const data = getMemoryService().ensureData();
  if (!data.war) {
    data.war = {};
  }

  return data.war;
}

export function ensureConfigStore(): Readonly<Record<string, CreepConfig>> {
  return getCreepConfigService().readStore();
}

export function getConfigName(task: WarTask, role: WarRole, index: number): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:${role}:${index}`;
}

export function getGenerationConfigName(task: WarTask, generationId: number, role: WarRole): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:g${generationId}:${role}:0`;
}

export function getGenerationBoostTaskId(task: WarTask, generationId: number): string {
  return `war:${task.sourceRoom}:${task.targetRoom}:g${generationId}`;
}

export function getLegacyWarBoostTaskId(task: WarTask): string {
  return `war:${task.sourceRoom}:${task.targetRoom}`;
}

export function isPatrolTask(task: WarTask): boolean {
  return Array.isArray(task.patrolRooms) && task.patrolRooms.length > 0;
}

export function getPatrolInterval(task: WarTask): number {
  return Math.max(MIN_PATROL_INTERVAL_TICKS, task.patrolInterval ?? DEFAULT_PATROL_INTERVAL_TICKS);
}

export function getExpectedTaskConfigNames(task: WarTask): string[] {
  if (getSquadPolicy(task).duo && task.activeGeneration) {
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

export function getTaskConfigNames(task: WarTask): string[] {
  const expected = [...getExpectedTaskConfigNames(task), getControllerAttackConfigName(task)];
  if (task.membersVersion !== 1 || !task.members) {
    const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
    const names = new Set([...expected, ...Object.keys(getCreepConfigService().list(prefix)), ...queuedConfigNames(prefix)]);
    const memories = Object.entries(Memory.creeps || {});
    for (const [, memory] of memories) if (!memory._warDetached && memory.configName?.startsWith(prefix)) names.add(memory.configName);
    task.members = Object.fromEntries([...names].map(configName => [configName, { configName,
      creepNames: memories.filter(([, memory]) => !memory._warDetached && memory.configName === configName).map(([name]) => name) }]));
    task.membersVersion = 1;
  }
  const members = task.members ??= {};
  for (const configName of expected) members[configName] ??= { configName, creepNames: [] };
  for (const member of Object.values(members)) {
    const live = getLiveCreepsByConfig(member.configName);
    const names = [...new Set([...member.creepNames.filter(name => Memory.creeps?.[name]?.configName === member.configName), ...live.map(c => c.name),
      ...spawningForConfig(member.configName).map(actor => actor.name)])];
    if (!sameArray(member.creepNames, names)) member.creepNames = names;
    if (live.length && member.spawnedAt === undefined) member.spawnedAt = Game.time;
    if (!expected.includes(member.configName) && !names.length && !queuedSpawns(member.configName).length && !ensureConfigStore()[member.configName]) delete members[member.configName];
  }
  return Object.keys(members);
}

export function getLiveCreepsByConfig(configName: string): Creep[] {
  return getTickContextService().getCreepsByConfigName(configName).filter(
    (creep) => Game.creeps[creep.name] === creep && creep.memory._warDetached !== true && creep.memory.configName === configName,
  );
}

export function getControllerAttackConfigName(task: WarTask): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:${WAR_CONTROLLER_ATTACK_CONFIG_SUFFIX}`;
}
