import { controllerUpgraderRole } from "@/roles/upgrader";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { moveToTargetRoom } from "@/roles/shared";
import { canUseColonizationTransit, supportIsComplete } from "@/runtime/colonizationSupport";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { spawnProfiles } from "@/config/spawnProfiles";
import type { RoleFactory } from "@/types/system";

/** 先支付已经排队的本地矿工，再让强化升级者消费新收入。 */
function miningReplacementNeedsEnergy(room: Room): boolean {
  const configs = getCreepConfigService();
  return getTickContextService().getSpawnsByRoom(room.name).some(spawn =>
    (spawn.memory.spawnList ?? []).some(name => {
      const config = configs.get(name);
      if (config?.roomName !== room.name || !(
        (config.role === "harvester" && name.startsWith(`${room.name}:harvester:`)) ||
        (config.role === "miner" && name.startsWith(`${room.name}:miner:`))
      )) return false;
      const body = config.body?.length ? config.body : spawnProfiles[config.role](room);
      return body.reduce((sum, part) => sum + BODYPART_COST[part], 0) > room.energyAvailable;
    }));
}

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
    if (creep.room.name === targetRoom) {
      if (!creep.room.controller?.my) return true;
      if (miningReplacementNeedsEnergy(creep.room)) {
        releasePickupReservation(creep);
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) creep.drop(RESOURCE_ENERGY);
        return true;
      }
      return false;
    }
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
