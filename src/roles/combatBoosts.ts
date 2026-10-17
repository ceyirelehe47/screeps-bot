import { countBoostableParts } from "@/runtime/boostParts";
import { moveToTarget } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getAssignedPowerBankBoostLabId } from "@/runtime/powerBankBoostMemory";

const missingPrepSince = new Map<string, { taskId: string; at: number }>();

function parseBoostCompounds(encodedBoostCompounds?: string): ResourceConstant[] {
  if (!encodedBoostCompounds) return [];
  return encodedBoostCompounds
    .split("|")
    .filter((compound): compound is ResourceConstant => compound.length > 0);
}

export type CombatBoostPreparation = "ready" | "waiting" | "missing";

export function prepareCombatBoost(
  creep: Creep,
  boostTaskId?: string,
  encodedBoostCompounds?: string,
): CombatBoostPreparation {
  const compounds = parseBoostCompounds(encodedBoostCompounds);
  if (!boostTaskId || compounds.length === 0) return "ready";

  const nextCompound = compounds.find((compound) => countBoostableParts(creep.body, compound) > 0);
  if (!nextCompound) { missingPrepSince.delete(creep.name); return "ready"; }

  const labId = getAssignedPowerBankBoostLabId(boostTaskId, nextCompound);
  const lab = labId ? Game.getObjectById(labId as Id<StructureLab>) : null;
  if (!lab || (lab.store.getUsedCapacity(nextCompound) ?? 0) < LAB_BOOST_MINERAL ||
      lab.store.getUsedCapacity(RESOURCE_ENERGY) < LAB_BOOST_ENERGY) {
    for (const name of missingPrepSince.keys()) if (!Game.creeps[name]) missingPrepSince.delete(name);
    let wait = missingPrepSince.get(creep.name);
    if (!wait || wait.taskId !== boostTaskId || wait.at > Game.time) {
      wait = { taskId: boostTaskId, at: Game.time }; missingPrepSince.set(creep.name, wait);
    }
    if (Game.time - wait.at >= 100) return "missing";
    return "waiting";
  }
  missingPrepSince.delete(creep.name);

  if ((lab.store.getUsedCapacity(nextCompound) ?? 0) < LAB_BOOST_MINERAL) return "waiting";
  if (lab.store.getUsedCapacity(RESOURCE_ENERGY) < LAB_BOOST_ENERGY) return "waiting";

  if (!creep.pos.isNearTo(lab)) {
    moveToTarget(creep, lab, 1, { reusePath: 3, maxRooms: 1 });
    return "waiting";
  }

  measureCreepIntent(() => lab.boostCreep(creep));
  return "waiting";
}
