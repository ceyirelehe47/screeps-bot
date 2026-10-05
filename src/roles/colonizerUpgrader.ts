import { controllerUpgraderRole } from "@/roles/upgrader";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { moveToTargetRoom } from "@/roles/shared";
import { canUseColonizationTransit, supportIsComplete } from "@/runtime/colonizationSupport";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";
import type { RoleFactory } from "@/types/system";

export const colonizerUpgraderRole: RoleFactory = (targetRoom, encodedRouteRooms, boostOwner, stopRcl, sourceRoom) => {
  const valid = !!targetRoom && !!sourceRoom && !!boostOwner && stopRcl === "6";
  const core = controllerUpgraderRole(creep => {
    if (!valid || creep.room.name !== targetRoom || supportIsComplete(targetRoom, sourceRoom)) return null;
    const controller = creep.room.controller;
    return controller?.my && controller.level > 0 && controller.level < 6 ? controller : null;
  });
  const pauseForTravelOrCompletion = (creep: Creep): boolean => {
    if (!valid) return true;
    if (supportIsComplete(targetRoom, sourceRoom)) {
      releasePickupReservation(creep);
      if (creep.room.name === targetRoom && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        creep.drop(RESOURCE_ENERGY);
      } else if (creep.room.name !== sourceRoom) {
        moveToTargetRoom(creep, sourceRoom, encodedRouteRooms?.split("|").reverse().join("|"), { plainCost: 2, swampCost: 10 });
      }
      return true;
    }
    if (creep.room.name === targetRoom) return !creep.room.controller?.my;
    if (creep.room.name === sourceRoom && creep.store.getUsedCapacity() > 0) {
      const resource = Object.keys(creep.store).find(key => creep.store.getUsedCapacity(key as ResourceConstant) > 0);
      if (resource) creep.drop(resource as ResourceConstant);
      return true;
    }
    moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10,
      canMoveStep: pos => !Memory.cfg?.colonizationSupport?.[targetRoom]?.allowedTransitRooms?.includes(pos.roomName) ||
        canUseColonizationTransit(sourceRoom, targetRoom, pos.roomName) });
    return true;
  };
  return {
    prepare: creep => !valid || supportIsComplete(targetRoom, sourceRoom) ||
      prepareCombatBoost(creep, boostOwner, RESOURCE_CATALYZED_GHODIUM_ACID),
    source: creep => pauseForTravelOrCompletion(creep) ? false : core.source!(creep),
    target: creep => pauseForTravelOrCompletion(creep) ? false : core.target(creep),
  };
};
