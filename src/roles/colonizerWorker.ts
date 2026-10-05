import { moveToTargetRoom } from "@/roles/shared";
import { workerRole } from "@/roles/worker";
import type { RoleFactory } from "@/types/system";

const PRESERVE_HOSTILE_STORAGE_RESOURCE_MIN = 50000;

function shouldClearHostileStorageForOwnStorage(room: Room): boolean {
  if (!room.controller?.my) {
    return false;
  }

  return room.controller.level >= 4;
}

function shouldPreserveHostileStorage(room: Room, structure: Structure): boolean {
  if (structure.structureType !== STRUCTURE_STORAGE) {
    return false;
  }

  if (shouldClearHostileStorageForOwnStorage(room)) {
    return false;
  }

  const storage = structure as StructureStorage;
  return storage.store.getUsedCapacity() >= PRESERVE_HOSTILE_STORAGE_RESOURCE_MIN;
}

function shouldSkipHostileDestroy(room: Room, structure: Structure): boolean {
  if (structure.structureType === STRUCTURE_KEEPER_LAIR) {
    return true;
  }

  if (shouldPreserveHostileStorage(room, structure)) {
    return true;
  }

  return false;
}

function destroyHostileStructuresInOwnedRoom(room: Room): void {
  if (!room.controller?.my) {
    return;
  }

  const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) => {
      return !shouldSkipHostileDestroy(room, structure);
    },
  });

  for (const structure of hostileStructures) {
    structure.destroy();
  }
}

export const colonizerWorkerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => {
  const baseRole = workerRole();

  return {
    source: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10 });
        return false;
      }

      destroyHostileStructuresInOwnedRoom(creep.room);

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10 });
        return false;
      }

      destroyHostileStructuresInOwnedRoom(creep.room);

      return baseRole.target(creep);
    },
  };
};
