import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { getPowerBankRoomExits, getPowerBankRoomStatus } from "@/runtime/powerBankMapFacts";

/** 高速公路与己方房间的走廊代价；普通房略贵，让 findRoute 偏向更早上高速。 */
export const POWER_BANK_ROUTE_COST_HIGHWAY = 1;
export const POWER_BANK_ROUTE_COST_NORMAL = 2;
/** Source Keeper 房可通行但有守卫与绕行，仅在明显更短时才穿越。 */
export const POWER_BANK_ROUTE_COST_KEEPER = 5;
/** PF 原生 maxRooms 上限；外扩后的允许房间集合不能超过它。 */
export const POWER_BANK_MAX_ALLOWED_ROOMS = 64;

function parseRoom(roomName: string): { x: number; y: number } | undefined {
  const match = /^[EW](0|[1-9]\d*)[NS](0|[1-9]\d*)$/.exec(roomName);
  if (!match) return undefined;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : undefined;
}

/** 按房名几何识别 SK 房：扇区坐标 4..6 的 3x3 区块，中心房除外。 */
export function isPowerBankKeeperRoom(roomName: string): boolean {
  const coordinates = parseRoom(roomName);
  if (!coordinates) return false;
  const x = coordinates.x % 10;
  const y = coordinates.y % 10;
  return x >= 4 && x <= 6 && y >= 4 && y <= 6 && !(x === 5 && y === 5);
}

/** findRoute 的房间代价；避让房为 Infinity，其余按真实通行难度分级。 */
export function getPowerBankRouteRoomCost(roomName: string, avoidRooms: ReadonlySet<string>): number {
  if (avoidRooms.has(roomName)) return Infinity;
  if (Game.rooms[roomName]?.controller?.my) return POWER_BANK_ROUTE_COST_HIGHWAY;
  if (isPowerBankSearchRoom(roomName)) return POWER_BANK_ROUTE_COST_HIGHWAY;
  if (isPowerBankKeeperRoom(roomName)) return POWER_BANK_ROUTE_COST_KEEPER;
  return POWER_BANK_ROUTE_COST_NORMAL;
}

/** 按真实代价求房间级走廊；返回含起终点的房名序列，不可达为 null。 */
export function findPowerBankCostedRoute(fromRoom: string, toRoom: string, avoidRooms: ReadonlySet<string>): string[] | null {
  const route = Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: (roomName: string) => roomName === toRoom ? (avoidRooms.has(roomName) ? Infinity : 1)
      : getPowerBankRouteRoomCost(roomName, avoidRooms),
  });
  if (route === ERR_NO_PATH || !Array.isArray(route)) return null;
  const rooms = [fromRoom];
  for (const step of route) {
    if (rooms[rooms.length - 1] !== step.room) rooms.push(step.room);
  }
  if (rooms[rooms.length - 1] !== toRoom) rooms.push(toRoom);
  return rooms;
}

/**
 * PF 允许房间 = 走廊 ∪ 走廊各房的相邻房。外扩房只放宽格子级搜索空间，
 * 仍排除避让房、可见敌方有主房与 closed 房；走廊本身的安全由调用方证明。
 */
export function expandPowerBankCorridor(routeRooms: readonly string[], avoidRooms: ReadonlySet<string>): string[] {
  const allowed = new Set(routeRooms);
  const result = [...routeRooms];
  for (const roomName of routeRooms) {
    let exits: ReturnType<typeof getPowerBankRoomExits> | null;
    try {
      exits = typeof Game.map.describeExits === "function" ? getPowerBankRoomExits(roomName) : null;
    } catch {
      exits = null;
    }
    if (!exits) continue;
    for (const neighbour of Object.values(exits)) {
      if (typeof neighbour !== "string" || allowed.has(neighbour) || avoidRooms.has(neighbour)) continue;
      if (result.length >= POWER_BANK_MAX_ALLOWED_ROOMS) return result;
      const visible = Game.rooms[neighbour];
      if (visible?.controller?.owner && !visible.controller.my) continue;
      let open = true;
      try {
        if (typeof Game.map.getRoomStatus === "function") {
          const status = getPowerBankRoomStatus(neighbour);
          open = status != null && status.status !== "closed";
        }
      } catch {
        open = false;
      }
      if (!open) continue;
      allowed.add(neighbour);
      result.push(neighbour);
    }
  }
  return result;
}
