import { moveToTarget } from "@/roles/shared";
import { moveToCrossShardTarget } from "@/roles/crossShardTravel";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { recordCrossShardClaim } from "@/runtime/crossShardSignals";
import type { RoleFactory } from "@/types/system";

function markClaimed(creep: Creep): void {
  if (creep.room.controller?.my) {
    recordCrossShardClaim(creep.room.name, creep.name);
  }
}

export const crossShardClaimerRole: RoleFactory = (
  targetShard?: string,
  targetRoom?: string,
  portalRoom?: string,
  destinationRoom?: string,
) => ({
  source: (creep): boolean => {
    if (!targetShard || !targetRoom || !portalRoom) {
      return false;
    }

    if (!moveToCrossShardTarget(creep, targetShard, targetRoom, portalRoom, destinationRoom || undefined)) {
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    if (Game.shard.name !== targetShard || creep.room.name !== targetRoom) return true;
    const controller = creep.room.controller;
    if (!controller) {
      return false;
    }

    if (controller.my) {
      markClaimed(creep);
      return false;
    }

    const claimCode = measureCreepIntent(() => creep.claimController(controller));
    if (claimCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
      return false;
    }

    if (claimCode === ERR_INVALID_TARGET && controller.reservation && !controller.my) {
      const attackCode = measureCreepIntent(() => creep.attackController(controller));
      if (attackCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
      }
      return false;
    }

    if (claimCode === OK) {
      markClaimed(creep);
    }

    return false;
  },
});
