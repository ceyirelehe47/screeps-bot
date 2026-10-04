import {
  spawnMaxCarrier as spawnMaxCarrierCore,
  spawnMaxCarrierRaw as spawnMaxCarrierRawCore,
  type SpawnMaxCarrierResult,
} from "@/runtime/emergencySpawning";
import {
  getUpgraderStatus,
  startUpgrader,
  stopUpgrader,
} from "@/runtime/hubUpgradeControl";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import {
  getWarStatus,
  configureWarRebuildWatch,
  releaseWarTaskOwner,
  startWarPatrol,
  startWarRoom,
  stopWarRoom,
  type StartWarOptions,
  type StartWarPatrolOptions,
  type StartWarPatrolResult,
  type StartWarResult,
  type StopWarOptions,
  type StopWarResult,
  type WarBoostTier,
  type WarSquad,
  type WarStatusSnapshot,
} from "@/runtime/warControl";
import type { CreepConfig } from "@/types/system";

interface StopColonizationResult {
  ok: true;
  scope: "all" | "room";
  targetRoom?: string;
  stoppedColonizationRooms: string[];
  stoppedCrossShardTasks: string[];
  stoppedWarRooms: string[];
  removedConfigs: number;
  removedQueuedTasks: number;
  cancelledSpawns: number;
  suicidedCreeps: number;
}

function ensureConfigStore(): Record<string, CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function collectConfigNamesByPrefix(prefix: string): string[] {
  return Object.keys(getCreepConfigService().list(prefix));
}

function removeConfigFromSpawnQueue(configName: string): number {
  let removed = 0;
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      const queue = spawn.memory.spawnList;
      if (!queue || queue.length === 0) {
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

function cancelSpawnIfSpawningConfig(configName: string): number {
  const creepMemory = Memory.creeps || {};
  let cancelled = 0;
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      const spawningName = spawn.spawning.name;
      if (creepMemory[spawningName]?.configName !== configName) {
        continue;
      }

      const code = spawn.spawning.cancel();
      if (code === OK) {
        cancelled += 1;
      }
    }
  }

  return cancelled;
}

function suicideCreepsByConfig(configName: string): number {
  let suicided = 0;
  for (const creep of getTickContextService().getCreepsByConfigName(configName)) {
    if (creep.memory.configName !== configName) {
      continue;
    }

    const code = creep.suicide();
    if (code === OK) {
      suicided += 1;
    }
  }

  return suicided;
}

function removeConfig(configName: string): number {
  const store = ensureConfigStore();
  if (!store[configName]) {
    return 0;
  }

  delete store[configName];
  return 1;
}

function getCrossShardTaskConfigNames(task: NonNullable<Memory["data"]>["crossShardColonization"] extends Record<string, infer T> ? T : never): string[] {
  const names = new Set<string>();

  if (task.claimerConfigName) {
    names.add(task.claimerConfigName);
  }

  for (const configName of task.bootstrapConfigNames || []) {
    names.add(configName);
  }

  if (task.sourceRoom) {
    const prefix = `${task.sourceRoom}:crossShard:${task.targetShard}:${task.targetRoom}:`;
    for (const configName of collectConfigNamesByPrefix(prefix)) {
      names.add(configName);
    }
  }

  return [...names];
}

export function stopColonization(targetRoom?: string): StopColonizationResult | string {
  const data = Memory.data;
  const colonizationStore = data?.colonization || {};
  const crossShardStore = data?.crossShardColonization || {};
  const warStore = data?.war || {};

  const colonizationRooms = Object.keys(colonizationStore).filter((roomName) => !targetRoom || roomName === targetRoom);
  const crossShardTaskEntries = Object.entries(crossShardStore).filter(([, task]) => !targetRoom || task.targetRoom === targetRoom);

  const warRooms = Object.keys(warStore).filter((roomName) => {
    if (targetRoom) {
      return roomName === targetRoom;
    }

    const warTask = warStore[roomName];
    return warTask.reason === "npc_reservation";
  });

  if (colonizationRooms.length === 0 && crossShardTaskEntries.length === 0 && warRooms.length === 0) {
    return targetRoom ? `ERR_NO_COLONIZATION_TASK:${targetRoom}` : "ERR_NO_COLONIZATION_TASK";
  }

  const configNames = new Set<string>();

  for (const roomName of colonizationRooms) {
    const task = colonizationStore[roomName];
    const prefix = `${task.sourceRoom}:colonize:${task.targetRoom}:`;
    for (const configName of collectConfigNamesByPrefix(prefix)) {
      configNames.add(configName);
    }
  }

  for (const [, task] of crossShardTaskEntries) {
    for (const configName of getCrossShardTaskConfigNames(task)) {
      configNames.add(configName);
    }
  }

  let removedConfigs = 0;
  let removedQueuedTasks = 0;
  let cancelledSpawns = 0;
  let suicidedCreeps = 0;

  for (const configName of configNames) {
    cancelledSpawns += cancelSpawnIfSpawningConfig(configName);
    removedQueuedTasks += removeConfigFromSpawnQueue(configName);
    suicidedCreeps += suicideCreepsByConfig(configName);
    removedConfigs += removeConfig(configName);
  }

  for (const roomName of colonizationRooms) {
    delete colonizationStore[roomName];
  }

  const stoppedCrossShardTasks: string[] = [];
  for (const [taskId] of crossShardTaskEntries) {
    stoppedCrossShardTasks.push(taskId);
    delete crossShardStore[taskId];
  }

  for (const roomName of warRooms) {
    const result = releaseWarTaskOwner(roomName, { suicide: true });
    if (typeof result === "string") continue;
    removedConfigs += result.removedConfigs;
    removedQueuedTasks += result.removedQueuedTasks;
    cancelledSpawns += result.cancelledSpawns;
    suicidedCreeps += result.suicidedCreeps;
  }

  return {
    ok: true,
    scope: targetRoom ? "room" : "all",
    targetRoom,
    stoppedColonizationRooms: colonizationRooms,
    stoppedCrossShardTasks,
    stoppedWarRooms: warRooms,
    removedConfigs,
    removedQueuedTasks,
    cancelledSpawns,
    suicidedCreeps,
  };
}

function formatStopColonizationResult(result: StopColonizationResult | string): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

export function stopColonizationRaw(targetRoom?: string): StopColonizationResult | string {
  return stopColonization(targetRoom);
}

export function stopColonizationCommand(targetRoom?: string): string {
  return formatStopColonizationResult(stopColonization(targetRoom));
}

function formatWarResult(result: StartWarResult | StartWarPatrolResult | StopWarResult | WarStatusSnapshot | string): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result, null, 2);
}

function parseRouteRooms(routeRooms?: string[] | string): string[] | undefined {
  if (Array.isArray(routeRooms)) {
    return routeRooms;
  }

  if (typeof routeRooms === "string" && routeRooms.length > 0) {
    return routeRooms.split("|").filter((roomName) => roomName.length > 0);
  }

  return undefined;
}

export function startWarRaw(targetRoom: string, sourceRoom: string, options: StartWarOptions = {}): StartWarResult | string {
  return startWarRoom(targetRoom, sourceRoom, options);
}

export function startWarCommand(
  targetRoom: string,
  sourceRoom: string,
  squad: WarSquad = "t3Duo",
  routeRooms?: string[] | string,
  oneShot = true,
): string {
  const boostTier: WarBoostTier | undefined = squad === "t3Duo" ? "t3" : undefined;
  return formatWarResult(startWarRaw(targetRoom, sourceRoom, {
    squad,
    boostTier,
    routeRooms: parseRouteRooms(routeRooms),
    oneShot,
  }));
}

export function startWarPatrolRaw(
  sourceRoom: string,
  targetRooms: string[] | string,
  options: StartWarPatrolOptions = {},
): StartWarPatrolResult | string {
  const rooms = Array.isArray(targetRooms) ? targetRooms : (parseRouteRooms(targetRooms) ?? []);
  return startWarPatrol(sourceRoom, rooms, options);
}

export function startWarPatrolCommand(
  sourceRoom: string,
  targetRooms: string[] | string,
  intervalTicks = 1000,
): string {
  return formatWarResult(startWarPatrolRaw(sourceRoom, targetRooms, { intervalTicks }));
}

export function stopWarRaw(targetRoom: string, options?: StopWarOptions): StopWarResult | string {
  return stopWarRoom(targetRoom, options);
}

export function stopWarCommand(targetRoom: string, suicide?: boolean): string {
  return formatWarResult(stopWarRaw(targetRoom, { suicide: suicide === true }));
}

export function warStatusRaw(targetRoom?: string): WarStatusSnapshot {
  return getWarStatus(targetRoom);
}

export function warStatusCommand(targetRoom?: string): string {
  return formatWarResult(warStatusRaw(targetRoom));
}

export function spawnMaxCarrier(roomName: string): SpawnMaxCarrierResult | string {
  return spawnMaxCarrierCore(roomName);
}

function formatSpawnMaxCarrierResult(result: SpawnMaxCarrierResult | string): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

export function spawnMaxCarrierRaw(roomName: string): SpawnMaxCarrierResult | string {
  return spawnMaxCarrierRawCore(roomName);
}

export function spawnMaxCarrierCommand(roomName: string): string {
  return formatSpawnMaxCarrierResult(spawnMaxCarrier(roomName));
}

function formatUpgraderResult(result: ReturnType<typeof startUpgrader> | ReturnType<typeof stopUpgrader> | ReturnType<typeof getUpgraderStatus>): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

export function startUpgraderRaw(roomName: string): ReturnType<typeof startUpgrader> {
  return startUpgrader(roomName);
}

export function startUpgraderCommand(roomName: string): string {
  return formatUpgraderResult(startUpgraderRaw(roomName));
}

export function stopUpgraderRaw(roomName: string): ReturnType<typeof stopUpgrader> {
  return stopUpgrader(roomName);
}

export function stopUpgraderCommand(roomName: string): string {
  return formatUpgraderResult(stopUpgraderRaw(roomName));
}

export function upgraderStatusRaw(roomName?: string): ReturnType<typeof getUpgraderStatus> {
  return getUpgraderStatus(roomName);
}

export function upgraderStatusCommand(roomName?: string): string {
  return formatUpgraderResult(upgraderStatusRaw(roomName));
}

export function registerOperationsConsoleCommands(): void {
  global.spawnMaxCarrier = spawnMaxCarrierCommand;
  global.spawnMaxCarrierRaw = spawnMaxCarrierRaw;
  global.startUpgrader = startUpgraderCommand;
  global.startUpgraderRaw = startUpgraderRaw;
  global.stopUpgrader = stopUpgraderCommand;
  global.stopUpgraderRaw = stopUpgraderRaw;
  global.upgraderStatus = upgraderStatusCommand;
  global.upgraderStatusRaw = upgraderStatusRaw;
  global.stopColonization = stopColonizationCommand;
  global.stopColonizationRaw = stopColonizationRaw;
  global.stopWar = stopWarCommand;
  global.stopWarRaw = stopWarRaw;
  global.startWarRebuildWatch = (sourceRoom: string, targetRooms: string[], enemyUsername: string, intervalTicks = 100) =>
    JSON.stringify(configureWarRebuildWatch(sourceRoom, targetRooms, enemyUsername, intervalTicks));
  global.startWar = startWarCommand;
  global.startWarRaw = startWarRaw;
  global.startWarPatrol = startWarPatrolCommand;
  global.startWarPatrolRaw = startWarPatrolRaw;
  global.warStatus = warStatusCommand;
  global.warStatusRaw = warStatusRaw;
}
