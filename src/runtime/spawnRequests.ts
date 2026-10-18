/** 孵化队列唯一写入者。调用方提交完整计划或单项请求，不保留可写数组。 */
const EMPTY_QUEUE: readonly string[] = Object.freeze([]);
let revision = 0;
let tick = -1;
let game: typeof Game | undefined;
const accepted = new Map<string, { spawnName: string; configName: string; creepName: string }>();

function beginTick(): void {
  if (game !== Game || tick !== Game.time) {
    game = Game; tick = Game.time; accepted.clear();
  }
}

export function readSpawnQueue(spawn: StructureSpawn): readonly string[] {
  return spawn.memory.spawnList ? Object.freeze(spawn.memory.spawnList) : EMPTY_QUEUE;
}

export function replaceSpawnQueue(spawn: StructureSpawn, names: readonly string[]): boolean {
  const current = readSpawnQueue(spawn);
  if (current.length === names.length && current.every((name, index) => name === names[index])) return false;
  spawn.memory.spawnList = [...names];
  revision++;
  return true;
}

export function requestSpawn(spawn: StructureSpawn, configName: string, toFront = false): number {
  const queue = readSpawnQueue(spawn);
  if (toFront) replaceSpawnQueue(spawn, [configName, ...queue.filter(name => name !== configName)]);
  else if (!queue.includes(configName)) replaceSpawnQueue(spawn, [...queue, configName]);
  return readSpawnQueue(spawn).length;
}

export function consumeSpawnRequest(spawn: StructureSpawn, expected: string): boolean {
  const queue = readSpawnQueue(spawn);
  if (queue[0] !== expected) return false;
  replaceSpawnQueue(spawn, queue.slice(1));
  return true;
}

export function rejectSpawnRequest(spawn: StructureSpawn, configName: string,
  reason: "missing_config" | "body_capacity" | "defense" | "reserve"): void {
  spawn.memory._lastSpawnReject = { tick: Game.time, configName, reason };
  consumeSpawnRequest(spawn, configName);
}

export function recordAcceptedSpawn(spawn: StructureSpawn, configName: string, creepName: string): void {
  beginTick();
  accepted.set(spawn.name, { spawnName: spawn.name, configName, creepName });
  revision++;
}

/** 引擎的 spawning 在下一 tick 才反映成功 intent；GC 和准入必须也看本 tick 收据。 */
export function hasAcceptedSpawn(configName: string, spawnNames?: ReadonlySet<string>): boolean {
  beginTick();
  return [...accepted.values()].some(receipt => receipt.configName === configName && (!spawnNames || spawnNames.has(receipt.spawnName)));
}

export function hasSpawnAcceptedIntent(spawnName: string): boolean { beginTick(); return accepted.has(spawnName); }

export function getAcceptedSpawnReceipts(): readonly Readonly<{ spawnName: string; configName: string; creepName: string }>[] {
  beginTick();
  return [...accepted.values()].map(receipt => Object.freeze({ ...receipt }));
}

export function getSpawnRequestRevision(): number { return revision; }
