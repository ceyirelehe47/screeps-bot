import { moveToTargetRoom } from "@/roles/shared";
import { workerRole } from "@/roles/worker";
import type { RoleFactory } from "@/types/system";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { supportIsComplete, canUseColonizationTransit } from "@/runtime/colonizationSupport";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";
import { releaseWorkerTask } from "@/runtime/workerTaskPool";

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

export const colonizerWorkerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string, boostOwner?: string, stopRcl?: string, sourceRoom?: string) => {
  const baseRole = workerRole();
  const support = !!boostOwner && stopRcl === "6" && !!sourceRoom && !!targetRoom;
  const returnHomeIfComplete = (creep: Creep): boolean => {
    if (!support || !supportIsComplete(targetRoom!, sourceRoom!)) return false;
    releasePickupReservation(creep); releaseWorkerTask(creep);
    if (creep.room.name === targetRoom && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      creep.drop(RESOURCE_ENERGY);
    } else if (creep.room.name !== sourceRoom) {
      moveToTargetRoom(creep, sourceRoom!, encodedRouteRooms?.split("|").reverse().join("|"), { plainCost: 2, swampCost: 10 });
    }
    return true;
  };
  const travel = (creep: Creep): void => {
    if (support && creep.room.name === sourceRoom && creep.store.getUsedCapacity() > 0) {
      const resource = Object.keys(creep.store).find(key => creep.store.getUsedCapacity(key as ResourceConstant) > 0);
      if (resource) creep.drop(resource as ResourceConstant);
      return;
    }
    moveToTargetRoom(creep, targetRoom!, encodedRouteRooms, { plainCost: 2, swampCost: 10,
      canMoveStep: support ? pos => !Memory.cfg?.colonizationSupport?.[targetRoom!]?.allowedTransitRooms?.includes(pos.roomName) ||
        canUseColonizationTransit(sourceRoom!, targetRoom!, pos.roomName) : undefined });
  };

  return {
    prepare: support ? creep => supportIsComplete(targetRoom!, sourceRoom!) ||
      prepareCombatBoost(creep, boostOwner, RESOURCE_CATALYZED_GHODIUM_ACID) : undefined,
    source: (creep): boolean => {
      if (returnHomeIfComplete(creep)) return false;
      if (support && creep.room.name === targetRoom && !creep.room.controller?.my) return false;
      if (targetRoom && creep.room.name !== targetRoom) {
        travel(creep);
        return false;
      }

      destroyHostileStructuresInOwnedRoom(creep.room);

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (creep): boolean => {
      if (returnHomeIfComplete(creep)) return false;
      if (support && creep.room.name === targetRoom && !creep.room.controller?.my) return false;
      if (targetRoom && creep.room.name !== targetRoom) {
        travel(creep);
        return false;
      }

      destroyHostileStructuresInOwnedRoom(creep.room);

      return baseRole.target(creep);
    },
  };
};
