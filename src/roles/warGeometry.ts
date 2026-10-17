import { isWalkableStructure } from "@/movement/common";

// 跨 tick 层只保存数字与数组；房间、creep、structure 仅存在当前 tick 的快照中。
const terrainCache = new Map<string, { values: Uint8Array; id: number }>();
let nextTerrainVersion = 0;
interface GeometryObjectState {
  x: number; y: number; type?: StructureConstant; walkable?: boolean; hitsBucket?: number;
}
interface GeometryLayer {
  signature: string;
  blocked: Uint8Array;
  swampTiles: number[];
  terrainVersion: number;
  objects: Map<string, GeometryObjectState>;
}
const staticCache = new Map<string, GeometryLayer>();
let nextGeometryVersion = 0;
let tick = -1;
let lastGame: Game | undefined;
let lastShard: string | undefined;
let frames = new WeakMap<Game, { tick: number; snapshots: Map<string, { room: Room; value: ReturnType<typeof readGeometry> }> }>();

/** 测试可在同一房名装载另一张地图；真实房间地形则跨 tick 不变。 */
export function clearWarGeometryForTest(): void {
  terrainCache.clear(); staticCache.clear(); frames = new WeakMap();
  tick = -1; lastGame = undefined; lastShard = undefined;
  // 版本号保持单调，避免下游缓存把新测试世界误认成旧几何。
}

function boundedSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key); if (cache.size >= 16) cache.delete(cache.keys().next().value!); cache.set(key, value);
}
export function warTerrain(roomName: string): Uint8Array {
  resetEpoch();
  const cached = terrainCache.get(roomName);
  if (cached) {
    boundedSet(terrainCache, roomName, cached); return cached.values;
  }
  const terrain = Game.map.getRoomTerrain(roomName); const values = new Uint8Array(2500);
  const native = terrain as unknown as { getRawBuffer?: () => Uint8Array };
  const raw = typeof native.getRawBuffer === "function" ? native.getRawBuffer() : undefined;
  for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) values[x * 50 + y] = raw?.length === 2500 ? raw[y * 50 + x] : terrain.get(x, y);
  boundedSet(terrainCache, roomName, { values, id: ++nextTerrainVersion }); return values;
}
function resetEpoch(): void {
  // Game / map / reader 的原生包装器每 tick 可重建，不能作为地形失效条件。
  // 同 tick 更换 Game、时间回退或切 shard 则属于另一运行世界（含测试重置）。
  if (Game.time < tick || Game.time === tick && lastGame !== Game || lastShard !== Game.shard?.name) {
    terrainCache.clear(); staticCache.clear(); frames.delete(Game);
  }
  tick = Game.time; lastGame = Game; lastShard = Game.shard?.name;
}
export function warTerrainVersion(roomName: string): number { warTerrain(roomName); return terrainCache.get(roomName)!.id; }

function readGeometry(room: Room) {
  const structures = room.find(FIND_STRUCTURES);
  const naturals = [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS), ...room.find(FIND_DEPOSITS)];
  const terrain = warTerrain(room.name);
  const terrainVersion = warTerrainVersion(room.name);
  let layer = staticCache.get(room.name);
  // 逐实体精确比较，保留同数量替换、公共 rampart 和破墙代价的实时失效；
  // 稳定 tick 不再为每座墙拼接长字符串并排序，也不依赖可能碰撞的摘要。
  const unchanged = layer && layer.terrainVersion === terrainVersion
    && layer.objects.size === structures.length + naturals.length
    && structures.every(s => {
      const old = layer!.objects.get(s.id);
      return old?.type === s.structureType && old.x === s.pos.x && old.y === s.pos.y
        && old.walkable === isWalkableStructure(s) && old.hitsBucket === Math.ceil((s.hits ?? 0) / 50000);
    })
    && naturals.every(n => {
      const old = layer!.objects.get(n.id);
      return old !== undefined && old.type === undefined && old.x === n.pos.x && old.y === n.pos.y;
    });
  if (!unchanged) {
    const blocked = new Uint8Array(2500);
    const roads = new Set(structures.filter(s => s.structureType === STRUCTURE_ROAD).map(s => s.pos.x * 50 + s.pos.y));
    const swampTiles: number[] = [];
    for (let i = 0; i < 2500; i++) {
      if (terrain[i] & TERRAIN_MASK_WALL) blocked[i] = 1;
      if (terrain[i] === TERRAIN_MASK_SWAMP && !roads.has(i)) swampTiles.push(i);
    }
    for (const object of [...structures.filter(s => !isWalkableStructure(s)), ...naturals]) blocked[object.pos.x * 50 + object.pos.y] = 1;
    const objects = new Map<string, GeometryObjectState>();
    for (const s of structures) objects.set(s.id, { x: s.pos.x, y: s.pos.y, type: s.structureType,
      walkable: isWalkableStructure(s), hitsBucket: Math.ceil((s.hits ?? 0) / 50000) });
    for (const n of naturals) objects.set(n.id, { x: n.pos.x, y: n.pos.y });
    layer = { signature: `${terrainVersion}:${++nextGeometryVersion}`, blocked, swampTiles, terrainVersion, objects };
    boundedSet(staticCache, room.name, layer);
  }
  const { signature, blocked, swampTiles } = layer!;
  return { signature, blocked, swampTiles, structures, naturals, terrain };
}
/** 几何签名每个 tick 由新鲜实体建立；不会把动态塔伤或退路许可缓存到这里。 */
export function warGeometry(room: Room, refresh = false): ReturnType<typeof readGeometry> {
  resetEpoch();
  let frame = frames.get(Game);
  if (!frame || frame.tick !== Game.time) { frame = { tick: Game.time, snapshots: new Map() }; frames.set(Game, frame); }
  const snapshots = frame.snapshots;
  const old = snapshots.get(room.name); if (!refresh && old?.room === room) return old.value;
  const value = readGeometry(room); snapshots.set(room.name, { room, value }); return value;
}
