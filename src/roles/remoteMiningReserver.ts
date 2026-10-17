import type { RoleFactory } from "@/types/system";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getMyUsername } from "@/runtime/remoteMining";

/**
 * Passive remote mining reserver – travels to target room and reserves the
 * controller when it is neutral/unreserved or already self-reserved.
 *
 * Conservative v1: never overwrites hostile reservations, never claims or attacks.
 */
export const remoteMiningReserverRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, { plainCost: 2, swampCost: 10 });
      return false;
    }
    return true;
  },
  target: (creep): boolean => {
    const controller = creep.room.controller;
    if (!controller) return false;

    // Owned rooms (mine or hostile) – no action
    if (controller.my || controller.owner) return false;

    const reservation = controller.reservation?.username;
    if (reservation && reservation !== getMyUsername() && reservation !== "Invader") return false;
    const code = measureCreepIntent(() => reservation === "Invader"
      ? creep.attackController(controller) : creep.reserveController(controller));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
    }

    return false;
  },
});
