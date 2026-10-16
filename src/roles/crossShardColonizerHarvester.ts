import { colonizerHarvesterRole } from "@/roles/colonizerHarvester";
import { moveToCrossShardTarget } from "@/roles/crossShardTravel";
import type { RoleFactory } from "@/types/system";

export const crossShardColonizerHarvesterRole: RoleFactory = (
  targetShard?: string,
  targetRoom?: string,
  portalRoom?: string,
  destinationRoom?: string,
) => {
  const baseRole = colonizerHarvesterRole(targetRoom ?? "");

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
    target: (): boolean => false,
  };
};
