import {
  coordinatePowerBankPairMovement,
  getPowerBankTaskForCreep,
  pairReadyForCombat,
  resolvePowerBankPair,
} from "@/roles/powerBankCombatPair";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const RETIRE_STATUSES: ReadonlySet<string> = new Set([
  "hauling",
  "complete",
  "failed",
  "aborted",
]);

function retireIfOrphanedPowerBankCreep(creep: Creep): boolean {
  if (!creep.memory.configName?.includes(":powerbank:")) return false;
  creep.suicide();
  return true;
}

export const powerBankAttackerRole: RoleFactory = (targetRoomArg?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    const task = getPowerBankTaskForCreep(creep);
    if (!task) {
      retireIfOrphanedPowerBankCreep(creep);
      return false;
    }
    if (RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const pair = resolvePowerBankPair(creep, task);
    if (!pair) return false;

    const targetRoom = task.targetRoom || targetRoomArg;
    if (pair.stage === "travelling" || (pair.stage === "attacking" && creep.room.name !== targetRoom)) {
      coordinatePowerBankPairMovement(pair, encodedRouteRooms);
      return false;
    }

    return pair.stage === "attacking";
  },

  target: (creep): boolean => {
    const task = getPowerBankTaskForCreep(creep);
    if (!task) {
      retireIfOrphanedPowerBankCreep(creep);
      return false;
    }
    if (RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    const pair = resolvePowerBankPair(creep, task);
    if (!pair) return false;

    const targetRoom = task.targetRoom || targetRoomArg;
    if (pair.stage === "travelling" || (pair.stage === "attacking" && creep.room.name !== targetRoom)) {
      coordinatePowerBankPairMovement(pair, encodedRouteRooms);
      return false;
    }
    if (pair.stage !== "attacking") return false;

    coordinatePowerBankPairMovement(pair, encodedRouteRooms);
    const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);
    // 管理器拥有阶段切换；本角色只对当帧仍有效且贴身的搭档发攻击。
    if (bank && pairReadyForCombat(pair)) measureCreepIntent(() => creep.attack(bank));

    return false;
  },
});
