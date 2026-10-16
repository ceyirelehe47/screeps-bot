import { moveToTarget } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getAssignedPowerBankBoostLabId } from "@/runtime/powerBankBoostMemory";

const BOOSTED_PARTS: Partial<Record<ResourceConstant, BodyPartConstant>> = {
  [RESOURCE_CATALYZED_GHODIUM_ACID]: WORK,
  [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: TOUGH,
  [RESOURCE_CATALYZED_UTRIUM_ACID]: ATTACK,
  [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: HEAL,
  [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: MOVE,
};

function parseBoostCompounds(encodedBoostCompounds?: string): ResourceConstant[] {
  if (!encodedBoostCompounds) return [];
  return encodedBoostCompounds
    .split("|")
    .filter((compound): compound is ResourceConstant => compound.length > 0);
}

function countRemainingBoostParts(creep: Creep, compound: ResourceConstant): number {
  const partType = BOOSTED_PARTS[compound];
  if (!partType) return 0;
  return creep.body.filter((part) => part.type === partType && part.hits > 0 && part.boost !== compound).length;
}

export function prepareCombatBoost(
  creep: Creep,
  boostTaskId?: string,
  encodedBoostCompounds?: string,
): boolean {
  if (creep.memory._warQueued === true) return false;

  const compounds = parseBoostCompounds(encodedBoostCompounds);
  if (!boostTaskId || compounds.length === 0) return true;

  const nextCompound = compounds.find((compound) => countRemainingBoostParts(creep, compound) > 0);
  if (!nextCompound) return true;

  const labId = getAssignedPowerBankBoostLabId(boostTaskId, nextCompound);
  if (!labId) return false;

  const lab = Game.getObjectById(labId as Id<StructureLab>);
  if (!lab) return false;

  if ((lab.store.getUsedCapacity(nextCompound) ?? 0) < LAB_BOOST_MINERAL) return false;
  if (lab.store.getUsedCapacity(RESOURCE_ENERGY) < LAB_BOOST_ENERGY) return false;

  if (!creep.pos.isNearTo(lab)) {
    moveToTarget(creep, lab, 1, { reusePath: 3, maxRooms: 1 });
    return false;
  }

  measureCreepIntent(() => lab.boostCreep(creep));
  return false;
}
