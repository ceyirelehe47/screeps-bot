import { colonizerWorkerRole } from "@/roles/colonizerWorker";
import { moveToCrossShardTarget } from "@/roles/crossShardTravel";
import type { RoleFactory } from "@/types/system";

export const crossShardColonizerWorkerRole: RoleFactory = (
  targetShard?: string,
  targetRoom?: string,
  portalRoom?: string,
  destinationRoom?: string,
) => {
  const baseRole = colonizerWorkerRole(targetRoom ?? "");

  return {
    source: (creep): boolean => {
      if (!targetShard || !targetRoom || !portalRoom) {
        return false;
      }

      if (!moveToCrossShardTarget(creep, targetShard, targetRoom, portalRoom, destinationRoom || undefined)) {
        return false;
      }

      return baseRole.source ? baseRole.source(creep) : false;
    },
    target: (creep): boolean => {
      if (!targetShard || !targetRoom || !portalRoom) {
        return false;
      }

      if (!moveToCrossShardTarget(creep, targetShard, targetRoom, portalRoom, destinationRoom || undefined)) {
        return false;
      }

      return baseRole.target(creep);
    },
  };
};
