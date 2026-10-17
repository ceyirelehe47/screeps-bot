import {
  coordinatePowerBankPairMovement,
  getPowerBankTaskForCreep,
  pairReadyForCombat,
  resolvePowerBankPair,
  retireOrphanedPowerBankCombatCreep,
} from "@/roles/powerBankCombatPair";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const RETIRE_STATUSES: ReadonlySet<string> = new Set([
  "hauling",
  "complete",
  "failed",
  "aborted",
]);

export const powerBankAttackerRole: RoleFactory = (targetRoomArg?: string, encodedRouteRooms?: string) => ({
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
      retireOrphanedPowerBankCombatCreep(creep, encodedRouteRooms);
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
    if (bank && pairReadyForCombat(pair)) {
      const code = measureCreepIntent(() => creep.attack(bank));
      if (code === OK) task.attackStartedTick ??= Game.time;
    }

    return false;
  },
});
