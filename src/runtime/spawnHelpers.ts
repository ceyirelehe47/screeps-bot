import { replaceSpawnQueue, hasAcceptedSpawn } from "@/runtime/spawnRequests";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";

import { type CreepConfig } from "@/types/system";

/** 默认负载沿用“孵化中算一项 + 队列长度”，调用方可显式提供计划负载。 */
export function getSpawnQueueLoad(spawn: StructureSpawn): number {
  return (spawn.spawning ? 1 : 0) + (spawn.memory.spawnList?.length ?? 0);
}

export function selectLeastLoadedSpawn(
  spawns: readonly StructureSpawn[],
  load: (spawn: StructureSpawn) => number = getSpawnQueueLoad,
): StructureSpawn | undefined {
  return [...spawns].sort((left, right) => load(left) - load(right) || left.name.localeCompare(right.name))[0];
}

export function ensureConfigStore(): Readonly<Record<string, CreepConfig>> {
  return getCreepConfigService().readStore();
}

export function getBodyCost(body: readonly BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

export function getLiveCreepsByConfig(configName: string): Creep[] {
  return getTickContextService().getCreepsByConfigName(configName);
}

/** spawns 必须由调用方给出，保留全局、己方房间或任务来源各自的查询范围。 */
export function isConfigSpawning(configName: string, spawns: readonly StructureSpawn[]): boolean {
  const memory = Memory.creeps || {};
  return hasAcceptedSpawn(configName, new Set(spawns.map(spawn => spawn.name))) || spawns.some(spawn => !!spawn.spawning && memory[spawn.spawning.name]?.configName === configName);
}

export function isConfigQueuedInSpawns(spawns: readonly StructureSpawn[], configName: string): boolean {
  return spawns.some(spawn => spawn.memory.spawnList?.includes(configName) ?? false);
}

export function enqueueConfig(spawn: StructureSpawn, configName: string, toFront: boolean): void {
  const queue = spawn.memory.spawnList || [];
  if (toFront) replaceSpawnQueue(spawn, [configName, ...queue.filter(name => name !== configName)]);
  else if (!queue.includes(configName)) spawn.addTask(configName);
}

export function removeQueuedSpawnConfig(spawns: readonly StructureSpawn[], configName: string): void {
  for (const spawn of spawns) {
    if (spawn.memory.spawnList) replaceSpawnQueue(spawn, spawn.memory.spawnList.filter(name => name !== configName));
  }
}
