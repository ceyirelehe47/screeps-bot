import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { createHarvesterRole } from "@/roles/harvester";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { type RoleFactory } from "@/types/system";
import { shouldPauseRemoteEnergyExtraction } from "@/runtime/energyInflowGuard";
import { canUseColonizationTransit, readColonizationSupportPolicy } from "@/runtime/colonizationSupport";

function shouldSkipFullContainerHarvestIntent(creep: Creep): boolean {
  const configName = creep.memory?.configName;
  if (
    configName?.includes(":remoteMine:") &&
    shouldPauseRemoteEnergyExtraction(configName.split(":")[0])
  ) {
    return true;
  }
  if (creep.body.some((part) => part.type === CARRY && part.hits > 0)) {
    return false;
  }
  return creep.pos.lookFor(LOOK_STRUCTURES).some((structure) => {
    if (structure.structureType !== STRUCTURE_CONTAINER) return false;
    return (structure as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
  });
}

export const colonizerHarvesterRole: RoleFactory = (targetRoom?: string, sourceId?: string, encodedRouteRooms?: string) => {
  const baseRole = createHarvesterRole(sourceId, {
    shouldSkipHarvestIntent: shouldSkipFullContainerHarvestIntent,
    harvestInRangeWhileWorkPosOccupied: creep => {
      const [, kind, supportedRoom, role] = (creep.memory.configName ?? "").split(":");
      return kind === "colonizationSupport" && role === "harvester" && supportedRoom === targetRoom;
    },
  });

  return {
    source: (creep): boolean => {
      const configName = creep.memory.configName;
      const [home, kind, supportedRoom, role] = (configName ?? "").split(":");
      const recycleRoom = creep.memory._colonizationRetiring;
      if (recycleRoom) {
        const service = getTickContextService();
        const spawn = service.getSpawnsByRoom(recycleRoom)[0] ?? service.getSpawnsByRoom(home)[0];
        if (spawn) {
          if (creep.room.name !== spawn.room.name) moveToTargetRoom(creep, spawn.room.name,
            spawn.room.name === targetRoom ? encodedRouteRooms : encodedRouteRooms?.split("|").reverse().join("|"),
            { plainCost: 2, swampCost: 10, canMoveStep: (pos: RoomPosition) =>
              !targetRoom || !readColonizationSupportPolicy(targetRoom)?.allowedTransitRooms?.includes(pos.roomName) ||
              canUseColonizationTransit(home, targetRoom, pos.roomName) });
          else if (spawn.recycleCreep(creep) === ERR_NOT_IN_RANGE) moveToTarget(creep, spawn, 1);
        }
        return false;
      }
      const persistentSupport = kind === "colonizationSupport" && role === "harvester" && supportedRoom === targetRoom;
      const supportPolicy = targetRoom ? readColonizationSupportPolicy(targetRoom) : undefined;
      const supportController = targetRoom ? Game.rooms[targetRoom]?.controller : undefined;
      const supportActive = supportPolicy?.sourceRoom === home && (!supportController || supportController.my && supportController.level < 6);
      if (persistentSupport && !supportActive && getCreepConfigService().get(configName!)?.roomName !== home) {
        if (creep.room.name !== home) {
          moveToTargetRoom(creep, home, encodedRouteRooms?.split("|").reverse().join("|"), { plainCost: 2, swampCost: 10 });
        } else {
          const spawn = getTickContextService().getSpawnsByRoom(home)[0];
          if (spawn && spawn.recycleCreep(creep) === ERR_NOT_IN_RANGE) moveToTarget(creep, spawn, 1);
        }
        return false;
      }
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10,
          ...(persistentSupport ? { canMoveStep: (pos: RoomPosition) =>
            !readColonizationSupportPolicy(targetRoom)?.allowedTransitRooms?.includes(pos.roomName) ||
            canUseColonizationTransit(home, targetRoom, pos.roomName) } : {}),
        });
        return false;
      }

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (): boolean => false,
  };
};
