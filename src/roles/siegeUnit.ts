import { moveToTarget, moveToTargetRoom } from "./shared";
import { prepareWarCombatBoost } from "@/runtime/war/boostPreparation";
import type { RoleFactory } from "@/types/system";
import { runSiegeFormation, siegeRally, siegeSlot } from "./siegeFormation";

const travel = { profile: "combat", routePurpose: "combat", reusePath: 4, ignoreCreeps: false } as const;

function runSiegeUnit(creep: Creep, target: string, route: string): boolean {
  const task = Memory.data?.war?.[target];
  if (
    !task ||
    task.squad !== "siege" ||
    task.status === "failed" ||
    task.status === "done" ||
    creep.memory._warQueued ||
    creep.memory._warDetached
  )
    return false;
  if (creep.room.name === target) {
    runSiegeFormation(creep, task);
    return false;
  }
  const wing = Math.floor(siegeSlot(creep) / 4);
  const staging = task.siegeStagingRoom ?? task.routeRooms?.[task.routeRooms.length - 2] ?? task.sourceRoom;
  const launched = creep.memory._siegeSlot !== undefined && task.siegeWings?.[wing];
  if (creep.getActiveBodyparts(HEAL)) {
    const injured = creep.pos
      .findInRange(FIND_MY_CREEPS, 1)
      .filter((c) => c.hits < c.hitsMax)
      .sort((a, b) => b.hitsMax - b.hits - (a.hitsMax - a.hits))[0];
    creep.heal(injured ?? creep);
  }
  const enemy = creep.pos
    .findInRange(FIND_HOSTILE_CREEPS, 3)
    .filter((c) => c.owner.username !== "Source Keeper")
    .sort((a, b) => a.hits - b.hits)[0];
  if (enemy) creep.rangedAttack(enemy);
  if (!launched && creep.room.name === staging) moveToTarget(creep, siegeRally(creep.room, target, wing), 2, travel);
  else {
    const rooms = route.split("|");
    const waypoint = rooms.indexOf(staging);
    const flank = launched && wing === 2 && task.routeOrigin !== "manual" ? task.siegeFlankRoute : undefined;
    const itinerary = flank?.length ? flank.join("|") : !launched && waypoint >= 0 ? rooms.slice(0, waypoint + 1).join("|") : route;
    moveToTargetRoom(creep, launched ? target : staging, itinerary, travel);
  }
  return false;
}

export const siegeUnitRole: RoleFactory = (target, route, boostTask, compounds) => ({
  prepare: (creep) => {
    const exhausted = Memory.data?.war?.[target]?.siegeExhausted;
    const available = exhausted?.length
      ? compounds?.split("|").filter((r) => !exhausted.includes(r as ResourceConstant)).join("|")
      : compounds;
    return prepareWarCombatBoost(creep, boostTask, available);
  },
  source: (creep) => runSiegeUnit(creep, target, route),
  target: (creep) => runSiegeUnit(creep, target, route),
});
