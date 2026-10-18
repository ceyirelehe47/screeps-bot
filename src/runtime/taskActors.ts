import { hasAcceptedSpawn, getAcceptedSpawnReceipts } from "@/runtime/spawnRequests";
import { getTickContextService } from "@/runtime/runtimeServices";

/** 活体或原生出生引用尚在时不得删除任务；排队由任务终态清理自行取消。 */
export function hasTaskActors(configNames: readonly string[], taskId?: string, creepNames: readonly string[] = []): boolean {
  const configs = new Set(configNames), names = new Set(creepNames);
  const matches = (name: string, memory?: CreepMemory) => names.has(name) ||
    !!memory?.configName && configs.has(memory.configName) || !!taskId && (memory as CreepMemory & { taskId?: string } | undefined)?.taskId === taskId;
  const context = getTickContextService();
  return configNames.some(name => hasAcceptedSpawn(name)) || getAcceptedSpawnReceipts().some(receipt => names.has(receipt.creepName)) || context.getAllCreeps().some(creep => matches(creep.name, creep.memory)) ||
    context.getAllSpawns().some(spawn => !!spawn.spawning && matches(spawn.spawning.name, Memory.creeps?.[spawn.spawning.name]));
}
