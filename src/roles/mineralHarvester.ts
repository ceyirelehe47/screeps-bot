import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { shouldPauseNativeMineralHarvest } from "@/runtime/mineralHarvestPolicy";

function getMineral(mineralId?: string): Mineral | null {
  if (!mineralId) {
    return null;
  }

  return Game.getObjectById(mineralId as Id<Mineral>);
}

function getAdjacentContainer(mineral: Mineral): StructureContainer | null {
  const containers = mineral.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
  });

  return (containers[0] as StructureContainer | undefined) ?? null;
}

export const mineralHarvesterRole: RoleFactory = (mineralId?: string) => ({
  source: (creep): boolean => {
    const mineral = getMineral(mineralId);
    if (!mineral || mineral.mineralAmount <= 0) {
      return false;
    }
    if (shouldPauseNativeMineralHarvest(creep.room, mineral.mineralType)) {
      return false;
    }

    const container = getAdjacentContainer(mineral);
    if (!container) {
      return false;
    }

    if (container.store.getFreeCapacity(mineral.mineralType) <= 0) {
      return false;
    }

    if (!creep.pos.isEqualTo(container.pos)) {
      moveToTarget(creep, container.pos, 0, { reusePath: 5, allowSourceContainerTarget: true });
      return false;
    }

    const harvestCode = measureCreepIntent(() => creep.harvest(mineral));
    if (harvestCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, mineral);
    }

    return false;
  },
  target: (): boolean => false,
});
