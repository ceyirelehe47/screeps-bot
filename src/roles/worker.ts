import type { RoleFactory } from "@/types/system";
import { pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { moveToRemoteWorkTarget, moveToTarget } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { assignWorkerTask, completeWorkerTaskIfDone, deferUnreachableWorkerTask, getWorkerTaskTarget, isWorkerTaskSafeForCreep, releaseWorkerTask } from "@/runtime/workerTaskPool";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";

export const workerRole: RoleFactory = () => ({
  source: (creep): boolean => {
    const result = pickupEnergyFromPreferredTarget(creep, { swampCost: 8 });
    const shouldSwitchToTarget = result.picked || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
    if (shouldSwitchToTarget) {
      releasePickupReservation(creep);
    }

    if (!result.picked && !result.outOfRange) {
      return shouldSwitchToTarget;
    }

    return shouldSwitchToTarget;
  },
  target: (creep): boolean => {
    const task = assignWorkerTask(creep);
    if (!task) {
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const target = getWorkerTaskTarget(task);
    if (!target) {
      releaseWorkerTask(creep);
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    if (!isWorkerTaskSafeForCreep(creep, task)) {
      releaseWorkerTask(creep);
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    if (task.type === "build") {
      const buildCode = measureCreepIntent(() => creep.build(target as ConstructionSite));
      const buildMoveCode = moveToRemoteWorkTarget(creep, target);
      if (buildCode === ERR_NOT_IN_RANGE && buildMoveCode === ERR_NO_PATH) {
        deferUnreachableWorkerTask(creep, task);
        return false;
      }

      if (buildCode === ERR_INVALID_TARGET || completeWorkerTaskIfDone(task)) {
        releaseWorkerTask(creep);
      }

      const shouldSwitchToSource = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
      if (shouldSwitchToSource) {
        releaseWorkerTask(creep);
      }

      return shouldSwitchToSource;
    }

    if (task.type === "upgrade") {
      const upgradeCode = measureCreepIntent(() => creep.upgradeController(target as StructureController));
      moveToRemoteWorkTarget(creep, target);
      if (upgradeCode === ERR_NOT_IN_RANGE) {
        return false;
      }

      if (upgradeCode === ERR_INVALID_TARGET || completeWorkerTaskIfDone(task)) {
        releaseWorkerTask(creep);
      }

      const shouldSwitchToSource = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
      if (shouldSwitchToSource) {
        releaseWorkerTask(creep);
      }

      return shouldSwitchToSource;
    }

    if (task.type === "repair") {
      const repairCode = measureCreepIntent(() => creep.repair(target as StructureRampart));
      const repairMoveCode = moveToRemoteWorkTarget(creep, target);
      if (repairCode === ERR_NOT_IN_RANGE) {
        if (repairMoveCode === ERR_NO_PATH) {
          releaseWorkerTask(creep);
        }
        return false;
      }

      if (repairCode === ERR_INVALID_TARGET || completeWorkerTaskIfDone(task)) {
        releaseWorkerTask(creep);
      }

      const shouldSwitchToSource = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
      if (shouldSwitchToSource) {
        releaseWorkerTask(creep);
      }

      return shouldSwitchToSource;
    }

    if (task.type === "dismantle") {
      const dismantleCode = measureCreepIntent(() => creep.dismantle(target as Structure<StructureConstant>));
      const dismantleMoveCode = moveToTarget(creep, target.pos, 1, {
        swampCost: 8,
        reusePath: 5,
        ignoreCreeps: true,
      });

      if (dismantleCode === ERR_NOT_IN_RANGE) {
        if (dismantleMoveCode === ERR_NO_PATH) {
          releaseWorkerTask(creep);
        }
        return false;
      }

      if (dismantleCode === ERR_INVALID_TARGET || completeWorkerTaskIfDone(task)) {
        releaseWorkerTask(creep);
      }

      return false;
    }

    releaseWorkerTask(creep);
    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});
