import { getTickContextService } from "@/runtime/runtimeServices";
import { getSpawnRequestRevision } from "@/runtime/spawnRequests";

// 只在战争调度调用内缓存可变队列；其它模块或 console 调用不会读到旧队列。
let depth = 0;
let queues: Map<string, StructureSpawn[]> | undefined;
let queueRevision = -1;
const cancellationFrames = new WeakMap<Game, { tick: number; cancelled: Set<Spawning>; attempted: Map<Spawning, ScreepsReturnCode> }>();
function cancellationFrame() {
  let frame = cancellationFrames.get(Game);
  if (!frame || frame.tick !== Game.time) { frame = { tick: Game.time, cancelled: new Set(), attempted: new Map() }; cancellationFrames.set(Game, frame); }
  return frame;
}
export function withWarSpawnIndex<T>(work: () => T): T {
  if (depth++ === 0) queues = undefined;
  try { return work(); } finally { if (--depth === 0) queues = undefined; }
}
function queueIndex(): Map<string, StructureSpawn[]> {
  const revision = getSpawnRequestRevision();
  if (depth && queues && queueRevision === revision) return queues;
  const index = new Map<string, StructureSpawn[]>();
  for (const spawn of getTickContextService().getAllSpawns()) for (const name of spawn.memory.spawnList ?? []) {
    const entries = index.get(name) ?? []; if (!entries.includes(spawn)) entries.push(spawn); index.set(name, entries);
  }
  if (depth) { queues = index; queueRevision = revision; }
  return index;
}
export function invalidateWarSpawnQueues(): void { queues = undefined; }
export function queuedSpawns(name: string): StructureSpawn[] { return queueIndex().get(name) ?? []; }
export function queuedConfigNames(prefix: string): string[] { return [...queueIndex().keys()].filter(name => name.startsWith(prefix)); }
export function spawningForConfig(name: string): Spawning[] {
  const frame = cancellationFrame();
  return getTickContextService().getSpawningByConfigName(name).filter(actor => !frame.cancelled.has(actor));
}
export function cancelSpawning(actor: Spawning): ScreepsReturnCode {
  const frame = cancellationFrame();
  if (frame.attempted.has(actor)) return frame.attempted.get(actor)!;
  const code = actor.cancel(); frame.attempted.set(actor, code);
  if (code === OK) frame.cancelled.add(actor); return code;
}
