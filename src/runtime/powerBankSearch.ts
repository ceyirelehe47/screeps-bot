import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { getPowerBankRoomStatus } from "@/runtime/powerBankMapFacts";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";

/** 普通 Observer 的原生范围；这是搜索半径，不是固定房间名单。 */
export const POWER_BANK_SEARCH_RADIUS = 10;

interface WorldRoomCoordinates { x: number; y: number }

let searchMemoGame: Game | undefined;
let searchMemoTick: number | undefined;
let searchMemoMap: GameMap | undefined;
let searchMemoStatusReader: GameMap["getRoomStatus"] | undefined;
const searchMemo = new Map<string, readonly string[]>();
// 仅缓存纯几何候选；开放状态仍由下面的 tick memo 每帧重新读取。
const geometryMemo = new Map<string, readonly string[]>();
const GEOMETRY_MEMO_LIMIT = 32;

function parseWorldRoom(roomName: string): WorldRoomCoordinates | undefined {
  const match = /^([EW])(0|[1-9]\d*)([NS])(0|[1-9]\d*)$/.exec(roomName);
  if (!match) return undefined;
  const horizontal = Number(match[2]);
  const vertical = Number(match[4]);
  if (!Number.isSafeInteger(horizontal) || !Number.isSafeInteger(vertical)) return undefined;
  return {
    x: match[1] === "E" ? horizontal : -horizontal - 1,
    y: match[3] === "S" ? vertical : -vertical - 1,
  };
}

function worldRoomName(x: number, y: number): string {
  return `${x >= 0 ? `E${x}` : `W${-x - 1}`}${y >= 0 ? `S${y}` : `N${-y - 1}`}`;
}

function isOpenWorldRoom(roomName: string): boolean {
  if (typeof Game.map.getRoomStatus !== "function") return true;
  try {
    const status = getPowerBankRoomStatus(roomName);
    return status !== null && status.status !== "closed";
  } catch {
    return false;
  }
}

function getGeometryRooms(key: string, origins: readonly string[], worldSize: number | undefined): readonly string[] {
  const cached = geometryMemo.get(key);
  if (cached) return cached;
  const worldMinimum = worldSize !== undefined ? -Math.floor(worldSize / 2) : undefined;
  const rooms = new Set<string>();
  for (const origin of origins) {
    const coordinates = parseWorldRoom(origin);
    if (!coordinates) continue;
    if (!Number.isSafeInteger(coordinates.x - POWER_BANK_SEARCH_RADIUS) ||
        !Number.isSafeInteger(coordinates.x + POWER_BANK_SEARCH_RADIUS) ||
        !Number.isSafeInteger(coordinates.y - POWER_BANK_SEARCH_RADIUS) ||
        !Number.isSafeInteger(coordinates.y + POWER_BANK_SEARCH_RADIUS)) continue;
    for (let x = coordinates.x - POWER_BANK_SEARCH_RADIUS; x <= coordinates.x + POWER_BANK_SEARCH_RADIUS; x += 1) {
      for (let y = coordinates.y - POWER_BANK_SEARCH_RADIUS; y <= coordinates.y + POWER_BANK_SEARCH_RADIUS; y += 1) {
        if (worldMinimum !== undefined &&
            (x < worldMinimum || y < worldMinimum || x >= worldMinimum + worldSize! || y >= worldMinimum + worldSize!)) continue;
        const roomName = worldRoomName(x, y);
        if (isPowerBankSearchRoom(roomName)) rooms.add(roomName);
      }
    }
  }
  // 顺序只由几何输入决定；先在跨 tick 缓存中排序，再逐帧过滤开放状态。
  const result = Object.freeze([...rooms].sort());
  if (geometryMemo.size >= GEOMETRY_MEMO_LIMIT) geometryMemo.delete(geometryMemo.keys().next().value!);
  geometryMemo.set(key, result);
  return result;
}

function getSearchInputs(originRoomName?: string) {
  // 这里只读少量来源；不能沿用仅按 tick 缓存的来源列表，否则同 tick 的
  // Game 身份或来源成员变化会让完整输入 key 仍指向旧集合。
  return measureSampledCpuPhase("sourceInputs", () => {
    const origins = [...new Set(originRoomName ? [originRoomName] : Object.values(Game.rooms)
      .filter((room) => room.controller?.my && (room.controller.level ?? 0) >= 6)
      .map((room) => room.name))].sort();
    const observedWorldSize = typeof Game.map.getWorldSize === "function" ? Game.map.getWorldSize() : undefined;
    const worldSize = observedWorldSize !== undefined && Number.isSafeInteger(observedWorldSize) && observedWorldSize > 0
      ? observedWorldSize : undefined;
    const statusReader = typeof Game.map.getRoomStatus === "function" ? Game.map.getRoomStatus : undefined;
    return { origins, worldSize, statusReader };
  });
}

/** 纯几何高速房候选；调用方在选择实际目标时另行检查本帧开放状态。 */
export function getPowerBankSearchCandidates(originRoomName?: string): string[] {
  return measureSampledCpuPhase("searchCandidates", () => {
    const { origins, worldSize } = getSearchInputs(originRoomName);
    const key = JSON.stringify([POWER_BANK_SEARCH_RADIUS, origins, worldSize ?? null]);
    return [...measureSampledCpuPhase("geometry", () => getGeometryRooms(key, origins, worldSize))];
  });
}

/** 完整的本帧开放房间目录；保留准入与其它完整目录消费者的 fresh 语义。 */
export function getPowerBankSearchRooms(originRoomName?: string): string[] {
  return measureSampledCpuPhase("searchCatalog", () => getPowerBankSearchRoomsImpl(originRoomName));
}

function getPowerBankSearchRoomsImpl(originRoomName?: string): string[] {
  const { origins, worldSize, statusReader } = getSearchInputs(originRoomName);
  if (searchMemoGame !== Game || searchMemoTick !== Game.time ||
      searchMemoMap !== Game.map || searchMemoStatusReader !== statusReader) {
    searchMemo.clear();
    searchMemoGame = Game;
    searchMemoTick = Game.time;
    searchMemoMap = Game.map;
    searchMemoStatusReader = statusReader;
  }
  const key = JSON.stringify([POWER_BANK_SEARCH_RADIUS, origins, worldSize ?? null]);
  const cached = searchMemo.get(key);
  if (cached) return [...cached];
  const geometry = measureSampledCpuPhase("geometry", () => getGeometryRooms(key, origins, worldSize));
  const result = measureSampledCpuPhase("openStatus", () => geometry.filter(isOpenWorldRoom));
  searchMemo.set(key, result);
  return [...result];
}
