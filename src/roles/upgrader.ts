import { prepareCombatBoost } from "@/roles/combatBoosts";
import { pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { moveToTarget } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";
import { isDedicatedUpgraderControllerRunnable } from "@/runtime/upgraderPolicy";
import type { RoleFactory, RoleLifecycle } from "@/types/system";

type ControllerLocalEnergySource = StructureLink | StructureContainer;
type ControllerEnergySource = ControllerLocalEnergySource | StructureStorage;

function getActiveController(roomName: string | undefined, creep: Creep): StructureController | null {
  if (!roomName) return null;
  const configName = `${roomName}:upgrader:0`;
  const task = Memory.data?.manualUpgraders?.[roomName];
  const config = Memory.data?.creepConfigs?.[configName];
  if (
    task?.maintenance !== true ||
    creep.memory.configName !== configName ||
    config?.role !== "upgrader" ||
    config.roomName !== roomName
  ) {
    return null;
  }
  const controller = Game.rooms[roomName]?.controller;
  if (!controller || !isDedicatedUpgraderControllerRunnable(controller)) return null;
  return controller;
}

function findControllerEnergySource(creep: Creep, controller: StructureController): ControllerEnergySource | null {
  const candidates = measureCreepDecision(() => controller.room.find(FIND_STRUCTURES, {
    filter: (structure): structure is ControllerLocalEnergySource =>
      (structure.structureType === STRUCTURE_LINK || structure.structureType === STRUCTURE_CONTAINER) &&
      structure.pos.getRangeTo(controller.pos) <= 3 &&
      structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  }));

  candidates.sort((left, right) => {
    if (left.structureType !== right.structureType) {
      return left.structureType === STRUCTURE_LINK ? -1 : 1;
    }
    return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
  });
  if (candidates[0]) return candidates[0];

  const storage = controller.room.storage;
  return storage?.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ? storage : null;
}

/** 普通维护与殖民支援共用取能、直接升级执行；控制器准入由调用者限定。 */
export function controllerUpgraderRole(getController: (creep: Creep) => StructureController | null): RoleLifecycle {
  return {
    source: (creep): boolean => {
      const controller = getController(creep);
      if (!controller) return false;
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return true;

      const source = findControllerEnergySource(creep, controller);
      if (!source) {
        const result = pickupEnergyFromPreferredTarget(creep, { swampCost: 8 });
        const shouldSwitchToTarget = result.picked || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
        if (shouldSwitchToTarget) {
          releasePickupReservation(creep);
        } else if (!result.outOfRange) {
          moveToTarget(creep, controller, 3);
        }
        return shouldSwitchToTarget;
      }

      const code = measureCreepIntent(() => creep.withdraw(source, RESOURCE_ENERGY));
      if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, source, 1);
      }
      return false;
    },

    target: (creep): boolean => {
      const controller = getController(creep);
      if (!controller) return false;
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return true;

      const code = measureCreepIntent(() => creep.upgradeController(controller));
      if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, controller, 3);
      }
      return false;
    },
  };
}

export const upgraderRole: RoleFactory = (roomName?: string, boostTaskId?: string) => ({
  ...controllerUpgraderRole(creep => getActiveController(roomName, creep)),
  prepare: creep => getActiveController(roomName, creep)
    ? prepareCombatBoost(creep, boostTaskId, RESOURCE_CATALYZED_GHODIUM_ACID) : true,
});
