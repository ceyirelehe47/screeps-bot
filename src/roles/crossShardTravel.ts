import { moveToTarget, moveToTargetRoom } from "@/roles/shared";

function findTargetPortal(
  room: Room,
  targetShard: string,
  destinationRoom?: string,
): StructurePortal | null {
  const portals = room.find(FIND_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_PORTAL,
  }) as StructurePortal[];

  const candidates = portals.filter((portal) => {
    const destination = portal.destination;
    if (!destination || !("shard" in destination)) {
      return false;
    }

    if (destination.shard !== targetShard) {
      return false;
    }

    if (destinationRoom && destination.room !== destinationRoom) {
      return false;
    }

    return true;
  });

  if (candidates.length === 0) {
    return null;
  }

  return room.getPositionAt(25, 25)?.findClosestByRange(candidates) || candidates[0];
}

export function moveToCrossShardTarget(
  creep: Creep,
  targetShard: string,
  targetRoom: string,
  portalRoom: string,
  destinationRoom?: string,
): boolean {
  if (Game.shard.name !== targetShard) {
    if (creep.room.name !== portalRoom) {
      moveToTargetRoom(creep, portalRoom, undefined, { plainCost: 2, swampCost: 8, travelRange: 3 });
      return false;
    }

    const portal = findTargetPortal(creep.room, targetShard, destinationRoom);
    if (!portal) {
      moveToTarget(creep, new RoomPosition(25, 25, creep.room.name), 3, {
        plainCost: 2,
        swampCost: 8,
        reusePath: 3,
        maxRooms: 1,
      });
      return false;
    }

    // range=0 要求踏上 Portal 本体：静态矩阵默认把 Portal 当障碍，必须显式豁免目标格。
    moveToTarget(creep, portal, 0, {
      plainCost: 2,
      swampCost: 8,
      reusePath: 3,
      maxRooms: 1,
      allowPortalTarget: true,
    });
    return false;
  }

  if (creep.room.name !== targetRoom) {
    moveToTargetRoom(creep, targetRoom, undefined, { plainCost: 2, swampCost: 8 });
    return false;
  }

  return true;
}
