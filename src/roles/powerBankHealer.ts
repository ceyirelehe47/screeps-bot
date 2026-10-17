import {
  coordinatePowerBankPairMovement,
  getPowerBankTaskForCreep,
  resolvePowerBankPair,
  retireOrphanedPowerBankCombatCreep,
} from "@/roles/powerBankCombatPair";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { powerBankAttackSustainable } from "@/runtime/powerBankCapability";
import type { RoleFactory } from "@/types/system";

const RETIRE_STATUSES: ReadonlySet<string> = new Set([
  "hauling",
  "complete",
  "failed",
  "aborted",
]);

function canHeal(creep: Creep): boolean {
  return creep.getActiveBodyparts(HEAL) > 0;
}

function healPairedAttacker(creep: Creep, attacker: Creep): { sameRoom: boolean; range: number } {
  const sameRoom = attacker.room.name === creep.room.name;
  const range = sameRoom ? creep.pos.getRangeTo(attacker.pos) : Infinity;

  if (canHeal(creep) && creep.hits < creep.hitsMax && attacker.hits === attacker.hitsMax && !powerBankAttackSustainable(attacker, creep)) {
    measureCreepIntent(() => creep.heal(creep));
    return { sameRoom, range };
  }
  if (canHeal(creep) && sameRoom) {
    if (range <= 1) {
      measureCreepIntent(() => creep.heal(attacker));
    } else if (range <= 3) {
      measureCreepIntent(() => creep.rangedHeal(attacker));
    }
  }

  if (canHeal(creep) && creep.hits < creep.hitsMax && (!sameRoom || range > 3)) {
    measureCreepIntent(() => creep.heal(creep));
  }

  return { sameRoom, range };
}

function selfHealIfPossible(creep: Creep): void {
  if (canHeal(creep) && creep.hits < creep.hitsMax) {
    measureCreepIntent(() => creep.heal(creep));
  }
}

export const powerBankHealerRole: RoleFactory = (_targetRoomArg?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    const task = getPowerBankTaskForCreep(creep);
    if (!task) {
      retireOrphanedPowerBankCombatCreep(creep, encodedRouteRooms);
      return false;
    }
    if (RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const pair = resolvePowerBankPair(creep, task);
    if (!pair) {
      selfHealIfPossible(creep);
      return false;
    }

    if (pair.stage === "travelling" || (pair.stage === "attacking" && creep.room.name !== task.targetRoom)) {
      healPairedAttacker(creep, pair.attacker);
      coordinatePowerBankPairMovement(pair, encodedRouteRooms);
      return false;
    }

    return pair.stage === "attacking";
  },

  target: (creep): boolean => {
    const task = getPowerBankTaskForCreep(creep);
    if (!task) {
      retireOrphanedPowerBankCombatCreep(creep, encodedRouteRooms);
      return false;
    }
    if (RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const pair = resolvePowerBankPair(creep, task);
    if (!pair) {
      selfHealIfPossible(creep);
      return false;
    }

    if (pair.stage === "travelling" || (pair.stage === "attacking" && creep.room.name !== task.targetRoom)) {
      healPairedAttacker(creep, pair.attacker);
      coordinatePowerBankPairMovement(pair, encodedRouteRooms);
      return false;
    }
    if (pair.stage !== "attacking") return false;

    healPairedAttacker(creep, pair.attacker);
    coordinatePowerBankPairMovement(pair, encodedRouteRooms);
    return false;
  },
});
