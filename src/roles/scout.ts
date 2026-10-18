import { retireCreep } from "@/runtime/retirement";
import type { RoleFactory } from "@/types/system";
import { isExitTile } from "@/movement/common";
import { getCurrentScoutRoute, moveToTargetRoom } from "@/roles/shared";

function shouldKeepScoutAliveForRemoteObservation(targetRoom: string): boolean {
  const task = Memory.data?.remoteMining?.[targetRoom];
  return task?.status === "suspended" ||
    (task?.status === "defending" && task.defenseReason === "npc_invader_core");
}

function recordVisitedRoom(creep: Creep): void {
  const route = creep.memory.scoutVisitedRooms || [];
  const roomName = creep.room.name;

  if (route.length === 0) {
    route.push(roomName);
    creep.memory.scoutVisitedRooms = route;
    return;
  }

  const lastRoom = route[route.length - 1];
  if (lastRoom === roomName) {
    creep.memory.scoutVisitedRooms = route;
    return;
  }

  const existingIndex = route.lastIndexOf(roomName);
  if (existingIndex >= 0) {
    route.splice(existingIndex + 1);
  } else {
    route.push(roomName);
  }

  creep.memory.scoutVisitedRooms = route;
}

export const scoutRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (!targetRoom) {
      return false;
    }

    recordVisitedRoom(creep);

    if (creep.room.name === targetRoom && !isExitTile(creep.pos)) {
      if (!shouldKeepScoutAliveForRemoteObservation(targetRoom)) {
        retireCreep(creep, { owner: "scout", mode: "suicide" });
      }
      return false;
    }

    const activeRoute = getCurrentScoutRoute(targetRoom, encodedRouteRooms);
    moveToTargetRoom(creep, targetRoom, activeRoute, { plainCost: 2, swampCost: 10, reusePath: 5, profile: "travel" });

    return false;
  },
  target: (): boolean => false,
});
