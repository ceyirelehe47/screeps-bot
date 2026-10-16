import { isWalkableStructure } from "@/movement/common";

// 跨 tick 层只保存数字与数组；房间、creep、structure 仅存在当前 tick 的快照中。
const terrainCache = new Map<string, Uint8Array>();
const terrainVersions = new Map<string, { signature: string; id: number }>();
let nextTerrainVersion = 0;
const staticCache = new Map<string, { signature: string; blocked: Uint8Array; swampTiles: number[] }>();
let tick = -1;
let token = 0; let lastGameToken = -1; let lastMapToken = -1; let lastReaderToken = -1;
const tokens = new WeakMap<object, number>();
function identity(value: object): number { let id = tokens.get(value); if (id === undefined) { id = ++token; tokens.set(value, id); } return id; }
const frames = new WeakMap<Game, { tick: number; snapshots: Map<string, { room: Room; value: ReturnType<typeof readGeometry> }> }>();

function boundedSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key); if (cache.size >= 16) cache.delete(cache.keys().next().value!); cache.set(key, value);
}
export function warTerrain(roomName: string): Uint8Array {
  resetEpoch();
  const cached = terrainCache.get(roomName);
  if (cached) {
    const version = terrainVersions.get(roomName) ?? { signature: cached.join(""), id: ++nextTerrainVersion };
    boundedSet(terrainVersions, roomName, version); boundedSet(terrainCache, roomName, cached); return cached;
  }
  const terrain = Game.map.getRoomTerrain(roomName); const values = new Uint8Array(2500);
  const native = terrain as unknown as { getRawBuffer?: () => Uint8Array };
  const raw = typeof native.getRawBuffer === "function" ? native.getRawBuffer() : undefined;
  for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) values[x * 50 + y] = raw?.length === 2500 ? raw[y * 50 + x] : terrain.get(x, y);
  const signature = values.join("");
  const old = terrainVersions.get(roomName);
  boundedSet(terrainVersions, roomName, old?.signature === signature ? old : { signature, id: ++nextTerrainVersion });
  boundedSet(terrainCache, roomName, values); return values;
}
function resetEpoch(): void {
  const gameToken = identity(Game); const mapToken = identity(Game.map); const readerToken = identity(Game.map.getRoomTerrain);
  if (Game.time < tick || Game.time === tick && lastGameToken !== gameToken || lastMapToken !== mapToken || lastReaderToken !== readerToken) {
    terrainCache.clear(); frames.delete(Game);
  }
  tick = Game.time; lastGameToken = gameToken; lastMapToken = mapToken; lastReaderToken = readerToken;
}
export function warTerrainVersion(roomName: string): number { warTerrain(roomName); return terrainVersions.get(roomName)!.id; }

function readGeometry(room: Room) {
  const structures = room.find(FIND_STRUCTURES);
  const naturals = [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS), ...room.find(FIND_DEPOSITS)];
  const terrain = warTerrain(room.name);
  const signature = `${warTerrainVersion(room.name)}:` + structures.map(s => `${s.id}:${s.structureType}:${s.pos.x}:${s.pos.y}:${isWalkableStructure(s) ? 1 : 0}:${Math.ceil(s.hits / 50000)}`).sort().join("|")
    + ";" + naturals.map(n => `${n.pos.x}:${n.pos.y}`).sort().join("|");
  let layer = staticCache.get(room.name);
  if (layer?.signature !== signature) {
    const blocked = new Uint8Array(2500);
    const roads = new Set(structures.filter(s => s.structureType === STRUCTURE_ROAD).map(s => s.pos.x * 50 + s.pos.y));
    const swampTiles: number[] = [];
    for (let i = 0; i < 2500; i++) {
      if (terrain[i] & TERRAIN_MASK_WALL) blocked[i] = 1;
      if (terrain[i] === TERRAIN_MASK_SWAMP && !roads.has(i)) swampTiles.push(i);
    }
    for (const object of [...structures.filter(s => !isWalkableStructure(s)), ...naturals]) blocked[object.pos.x * 50 + object.pos.y] = 1;
    layer = { signature, blocked, swampTiles }; boundedSet(staticCache, room.name, layer);
  }
  return { ...layer, structures, naturals, terrain };
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
