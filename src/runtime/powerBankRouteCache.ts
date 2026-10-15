import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import { getPowerBankRoomExits, getPowerBankRoomStatus } from "@/runtime/powerBankMapFacts";

/** 仅复用房间走廊；当前危险集合和真实地图连通性仍由每次调用证明。 */
const ROUTE_CACHE_LIMIT = 64;
const ROUTE_CACHE_TTL = 25;
const ROUTE_ROOM_LIMIT = 16;

interface RouteEntry {
  route: readonly string[] | null;
  tick: number;
  expiresAt: number;
}

const routes = new Map<string, RouteEntry>();
let previousTick = -1;
let previousGame: Game | undefined;
let previousMap: GameMap | undefined;
let previousReader: GameMap["findRoute"] | undefined;
let previousStatusReader: GameMap["getRoomStatus"] | undefined;
let previousExitReader: GameMap["describeExits"] | undefined;

function routeStillConnected(route: readonly string[], avoidRooms: readonly string[]): boolean {
  return measureSampledCpuPhase("route.validate", () => routeStillConnectedImpl(route, avoidRooms));
}

function routeStillConnectedImpl(route: readonly string[], avoidRooms: readonly string[]): boolean {
  if (route.length < 2 || route.length > ROUTE_ROOM_LIMIT || new Set(route).size !== route.length ||
      typeof Game.map.getRoomStatus !== "function" || typeof Game.map.describeExits !== "function") return false;
  const avoid = new Set(avoidRooms);
  try {
    for (let index = 0; index < route.length; index += 1) {
      const name = route[index];
      const status = getPowerBankRoomStatus(name);
      const open = Boolean(status && status.status !== "closed");
      if (!open || (index > 0 && avoid.has(name))) return false;
      if (index + 1 < route.length) {
        const exits = getPowerBankRoomExits(name);
        if (!exits || !Object.values(exits).includes(route[index + 1])) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function getPowerBankAdmissionRoute(
  fromRoom: string,
  toRoom: string,
  avoidRooms: readonly string[],
  findRoute: () => string[] | null,
): string[] | null {
  return measureSampledCpuPhase("route.cache", () => getPowerBankAdmissionRouteImpl(fromRoom, toRoom, avoidRooms, findRoute));
}

function getPowerBankAdmissionRouteImpl(
  fromRoom: string,
  toRoom: string,
  avoidRooms: readonly string[],
  findRoute: () => string[] | null,
): string[] | null {
  // 正常的新 tick 会重建 Game/map，不能把对象身份用于跨 tick 的几何键。
  // 同 tick 替换世界或时钟倒退则是另一份输入，清空包括 negative 的 memo。
  if (Game.time < previousTick || (Game.time === previousTick &&
      (previousGame !== Game || previousMap !== Game.map || previousReader !== Game.map.findRoute ||
       previousStatusReader !== Game.map.getRoomStatus || previousExitReader !== Game.map.describeExits))) routes.clear();
  previousTick = Game.time;
  previousGame = Game;
  previousMap = Game.map;
  previousReader = Game.map.findRoute;
  previousStatusReader = Game.map.getRoomStatus;
  previousExitReader = Game.map.describeExits;
  const worldSize = typeof Game.map.getWorldSize === "function" ? Game.map.getWorldSize() : undefined;
  const validWorld = Number.isSafeInteger(worldSize) && worldSize! > 0;
  const key = JSON.stringify([Game.shard?.name ?? "unknown", validWorld ? worldSize : null,
    fromRoom, toRoom, avoidRooms]);
  const cached = routes.get(key);
  if (cached && (cached.tick === Game.time || (cached.expiresAt > Game.time && cached.route &&
      routeStillConnected(cached.route, avoidRooms)))) {
    routes.delete(key);
    cached.tick = Game.time;
    routes.set(key, cached);
    return cached.route === null ? null : [...cached.route];
  }
  routes.delete(key);
  const route = findRoute();
  const reusable = validWorld && route && route[0] === fromRoom && route[route.length - 1] === toRoom &&
    routeStillConnected(route, avoidRooms);
  while (routes.size >= ROUTE_CACHE_LIMIT) routes.delete(routes.keys().next().value!);
  routes.set(key, { route: route === null ? null : Object.freeze([...route]), tick: Game.time,
    expiresAt: Game.time + (reusable ? ROUTE_CACHE_TTL : 1) });
  return route;
}
