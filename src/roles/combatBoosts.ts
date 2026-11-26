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

  // 攻坚编组会同时占用数个实验室。沿可通行的路线领取任一缺少的强化。
  if (creep.memory.role === "siegeUnit") {
    const labs = compounds.filter(c => countBoostableParts(creep.body, c) > 0).flatMap(compound => {
      const id = getAssignedPowerBankBoostLabId(boostTaskId, compound);
      const lab = id && Game.getObjectById(id as Id<StructureLab>);
      return lab && lab.store.getUsedCapacity(compound) >= LAB_BOOST_MINERAL && lab.store.getUsedCapacity(RESOURCE_ENERGY) >= LAB_BOOST_ENERGY ? [lab] : [];
    }).sort((a,b) => creep.pos.getRangeTo(a)-creep.pos.getRangeTo(b));
    if (labs.length) {
      missingPrepSince.delete(creep.name);
      if (creep.pos.isNearTo(labs[0])) measureCreepIntent(() => labs[0].boostCreep(creep));
      else for (const lab of labs) {
        if (moveToTarget(creep, lab, 1, {reusePath: 0, maxRooms: 1, ignoreCreeps: false}) !== ERR_NO_PATH) break;
      }
      return "waiting";
    }
  }
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
