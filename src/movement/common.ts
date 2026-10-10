export function getTargetPos(target: RoomPosition | { pos: RoomPosition }): RoomPosition {
  // Duck-typing: RoomPosition has x/y/roomName but no 'pos'; game objects have 'pos'.
  // Avoids instanceof which fails when RoomPosition is not defined in test environments.
  if ("pos" in target) return (target as { pos: RoomPosition }).pos;
  return target as RoomPosition;
}

export function isStandardCreep(creep: AnyCreep): creep is Creep {
  return !("powers" in creep);
}

export function getPosKey(pos: RoomPosition): string {
  return `${pos.roomName}:${pos.x}:${pos.y}`;
}

export function isExitTile(pos: RoomPosition): boolean {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

// 方向常量固定；模块加载时创建一次，避免每次邻位查询分配九个对象。
const directionOffsets: Readonly<Record<DirectionConstant, { readonly x: number; readonly y: number }>> = {
  [TOP]: { x: 0, y: -1 },
  [TOP_RIGHT]: { x: 1, y: -1 },
  [RIGHT]: { x: 1, y: 0 },
  [BOTTOM_RIGHT]: { x: 1, y: 1 },
  [BOTTOM]: { x: 0, y: 1 },
  [BOTTOM_LEFT]: { x: -1, y: 1 },
  [LEFT]: { x: -1, y: 0 },
  [TOP_LEFT]: { x: -1, y: -1 },
};

export function getPositionAtDirection(pos: RoomPosition, direction: DirectionConstant): RoomPosition | null {
  const offset = directionOffsets[direction];
  const x = pos.x + offset.x;
  const y = pos.y + offset.y;
  if (x < 0 || x > 49 || y < 0 || y > 49) {
    return null;
  }

  return new RoomPosition(x, y, pos.roomName);
}

// 只保存字符串推导出的纯数据；不持有 Room/Creep，也不绑定当帧视野或许可。
const encodedRouteRoomsCache = new Map<string, readonly string[]>();
const ENCODED_ROUTE_CACHE_LIMIT = 128;
const ENCODED_ROUTE_CACHE_MAX_LENGTH = 4096;

export function parseEncodedRouteRooms(encodedRouteRooms?: string): string[] {
  if (!encodedRouteRooms) {
    return [];
  }

  const cacheable = encodedRouteRooms.length <= ENCODED_ROUTE_CACHE_MAX_LENGTH;
  const cached = cacheable ? encodedRouteRoomsCache.get(encodedRouteRooms) : undefined;
  if (cached) {
    encodedRouteRoomsCache.delete(encodedRouteRooms);
    encodedRouteRoomsCache.set(encodedRouteRooms, cached);
    return [...cached];
  }

  const rooms = encodedRouteRooms
    .split("|")
    .map((roomName) => roomName.trim())
    .filter((roomName) => roomName.length > 0);
  if (cacheable) {
    if (encodedRouteRoomsCache.size >= ENCODED_ROUTE_CACHE_LIMIT) {
      encodedRouteRoomsCache.delete(encodedRouteRoomsCache.keys().next().value!);
    }
    encodedRouteRoomsCache.set(encodedRouteRooms, Object.freeze([...rooms]));
  }
  return rooms;
}

export function isWalkableStructure(structure: Structure<StructureConstant>): boolean {
  switch (structure.structureType) {
    case STRUCTURE_ROAD:
    case STRUCTURE_CONTAINER:
    case STRUCTURE_PORTAL:
      return true;
    case STRUCTURE_RAMPART: {
      const rampart = structure as StructureRampart;
      return rampart.my || rampart.isPublic;
    }
    default:
      return false;
  }
}

export function isWalkableConstructionSite(site: ConstructionSite): boolean {
  return (
    site.structureType === STRUCTURE_ROAD ||
    site.structureType === STRUCTURE_CONTAINER ||
    site.structureType === STRUCTURE_RAMPART
  );
}
