import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { getTickContextService } from "@/runtime/runtimeServices";

/** 普通 Observer 的原生范围；这是搜索半径，不是固定房间名单。 */
export const POWER_BANK_SEARCH_RADIUS = 10;

interface WorldRoomCoordinates { x: number; y: number }

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
    const status = Game.map.getRoomStatus(roomName);
    return status !== null && status.status !== "closed";
  } catch {
    return false;
  }
}

/**
 * 由当前来源房位置生成候选高速房。Observer 的覆盖判定和 Scout 的补盲
 * 使用同一集合，但此集合不作为已接受任务的生命周期许可。
 */
export function getPowerBankSearchRooms(originRoomName?: string): string[] {
  const origins = originRoomName ? [originRoomName] : getTickContextService().getMyRooms()
    .filter((room) => (room.controller?.level ?? 0) >= 6)
    .map((room) => room.name);
  const worldSize = typeof Game.map.getWorldSize === "function" ? Game.map.getWorldSize() : undefined;
  const worldMinimum = worldSize !== undefined && Number.isSafeInteger(worldSize) && worldSize > 0
    ? -Math.floor(worldSize / 2) : undefined;
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
  return [...rooms].filter(isOpenWorldRoom).sort();
}
