import { moveToTarget, moveToTargetRoom } from "./shared";
import { prepareWarCombatBoost } from "@/runtime/war/boostPreparation";
import type { RoleFactory } from "@/types/system";
import { runSiegeFormation, runSiegeRelief, siegeRally, siegeSlot } from "./siegeFormation";

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
    if (creep.memory._siegeReliefSlot !== undefined) {
      runSiegeRelief(creep, task, creep.memory._siegeReliefSlot);
      return false;
    }
    runSiegeFormation(creep, task);
    // 被拆的 Spawn 会重开工。碰到可踩掉的工地时只借一步，最后一座消失后持续清场。
    const sites = creep.room.find(FIND_HOSTILE_CONSTRUCTION_SITES).filter(s => s.structureType === STRUCTURE_SPAWN &&
      !creep.room.lookForAt(LOOK_STRUCTURES, s.pos).some(p => p.structureType === STRUCTURE_RAMPART));
    if (sites.length && !creep.fatigue) {
      const site = creep.pos.findClosestByRange(sites);
      if (site && creep.pos.isNearTo(site)) creep.move(creep.pos.getDirectionTo(site));
      else if (site && !creep.room.find(FIND_HOSTILE_SPAWNS).length && creep.getActiveBodyparts(WORK))
        moveToTarget(creep, site, 0, { ...travel, maxRooms: 1 });
    }
    return false;
  }
  const wing = Math.floor((creep.memory._siegeReliefSlot ?? siegeSlot(creep)) / 4);
  const staging = task.siegeStagingRoom ?? task.routeRooms?.[task.routeRooms.length - 2] ?? task.sourceRoom;
  const launched = (creep.memory._siegeSlot !== undefined || creep.memory._siegeReliefSlot !== undefined) && task.siegeWings?.[wing];
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
  if (!launched && creep.room.name === staging) moveToTarget(creep, siegeRally(creep.room, target, 0), 2, travel);
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
    // 强化等待从出舱开始。50 节身体孵化需要 150 tick，不能用这段时间触发回收。
    if (creep.spawning) return false;
    const exhausted = Memory.data?.war?.[target]?.siegeExhausted;
    const available = exhausted?.length
      ? compounds?.split("|").filter((r) => !exhausted.includes(r as ResourceConstant)).join("|")
      : compounds;
    return prepareWarCombatBoost(creep, boostTask, available);
  },
  source: (creep) => runSiegeUnit(creep, target, route),
  target: (creep) => runSiegeUnit(creep, target, route),
});
