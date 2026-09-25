import { createHarvesterRole } from "@/roles/harvester";
import { moveToTargetRoom } from "@/roles/shared";
import type { RoleFactory } from "@/types/system";
import { shouldPauseEnergyExtraction } from "@/runtime/energyInflowGuard";

function shouldSkipFullContainerHarvestIntent(creep: Creep): boolean {
  const configName = creep.memory?.configName;
  if (
    configName?.includes(":remoteMine:") &&
    shouldPauseEnergyExtraction(configName.split(":")[0])
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
  });

  return {
    source: (creep): boolean => {
      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10 });
        return false;
      }

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (): boolean => false,
  };
};
