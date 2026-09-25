import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getPlannedSourceContainerPos } from "@/runtime/roomPlannerConstruction";
import { getSourceAdjacentLink } from "@/runtime/sourceLink";
import { shouldPauseEnergyExtraction } from "@/runtime/energyInflowGuard";

function getSource(sourceId?: string): Source | null {
  if (!sourceId) {
    return null;
  }

  return Game.getObjectById(sourceId as Id<Source>);
}

export const minerRole: RoleFactory = (sourceId?: string) => ({
  source: (creep): boolean => {
    const source = getSource(sourceId);
    if (!source) {
      return false;
    }

    const workPos: RoomPosition | null =
      getPlannedSourceContainerPos(source) ??
      (
        source.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: (s) => s.structureType === STRUCTURE_CONTAINER,
        }) as StructureContainer[]
      )[0]?.pos ??
      null;

    if (workPos) {
      if (!creep.pos.isEqualTo(workPos)) {
        const occupants = workPos.lookFor(LOOK_CREEPS);
        const isOccupiedByAlly = occupants.some((c) => (c as Creep).my);
        if (!isOccupiedByAlly) {
          moveToTarget(creep, workPos, 0, { reusePath: 5, allowSourceContainerTarget: true });
          return false;
        }
        if (!creep.pos.inRangeTo(workPos, 1)) {
          moveToTarget(creep, workPos, 1, { reusePath: 5 });
          return false;
        }
      }
    }

    if (shouldPauseEnergyExtraction(creep.room.name)) {
      return false;
    }

    const harvestCode = measureCreepIntent(() => creep.harvest(source));
    if (harvestCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, source);
    }

    return creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
  },
  target: (creep): boolean => {
    const source = getSource(sourceId);
    if (!source) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const link = getSourceAdjacentLink(source);
    if (!link) {
      return true;
    }

    const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    if (usedEnergy <= 0) {
      return true;
    }

    const capacity = creep.store.getCapacity(RESOURCE_ENERGY);
    if (capacity > 0 && usedEnergy < capacity) {
      return true;
    }

    const linkFreeCapacity = link.store.getFreeCapacity(RESOURCE_ENERGY);
    if (linkFreeCapacity <= 0) {
      return false;
    }

    const transferCode = measureCreepIntent(() => creep.transfer(link, RESOURCE_ENERGY));
    if (transferCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, link);
      return false;
    }

    if (transferCode === OK) {
      return true;
    }

    if (transferCode === ERR_FULL) {
      return false;
    }

    return false;
  },
});
