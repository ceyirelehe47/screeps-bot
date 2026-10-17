import { getTickContextService } from "@/runtime/runtimeServices";
import { getSquadPolicy } from "./squadPolicy/index";
import { getRefillableHostileTowers } from "@/runtime/combatTowerThreat";
import { isRebuildStructureRelevant } from "@/runtime/warRebuildScope";
import type { HostilePresenceSnapshot, WarTask } from "./store";
import { WAR_CONTROLLER_CORE_STRUCTURES } from "./constants";
import { isTowerDrainDuoTask } from "./squadPolicy/index";

export let warMemo: { game: Game; tick: number; hostiles: Map<string, { room: Room; value: HostilePresenceSnapshot }> } | undefined;

export function resetWarObservationMemo(): void { warMemo = undefined; }

export function currentWarMemo() {
  if (warMemo?.game !== Game || warMemo.tick !== Game.time) warMemo = { game: Game, tick: Game.time, hostiles: new Map() };
  return warMemo;
}

export function isHostileReservation(room: Room): boolean {
  const controller = room.controller;
  if (!controller) {
    return false;
  }

  if (controller.my || controller.owner) {
    return false;
  }

  const myUser = Object.values(Game.spawns)[0]?.owner.username || getTickContextService().getAllCreeps()[0]?.owner.username;
  const reservation = controller.reservation;
  if (!reservation) {
    return false;
  }

  if (!myUser) {
    return true;
  }

  return reservation.username !== myUser;
}

export function getHostilePresence(room: Room, task?: WarTask): HostilePresenceSnapshot {
  const memo = currentWarMemo();
  const key = `${room.name}:${task?.squad}:${task?.sharedSquadWatchId}:${task?.rebuildIgnoreStructureIds?.join("|") ?? ""}`;
  const cached = memo.hostiles.get(key); if (cached?.room === room) return cached.value;
  const value = readHostilePresence(room, task); memo.hostiles.set(key, { room, value }); return value;
}

export function readHostilePresence(room: Room, task?: WarTask): HostilePresenceSnapshot {
  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) => creep.owner.username !== "Source Keeper",
  });

  const hostileStructures: Structure<StructureConstant>[] = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });

  const relevantStructures = hostileStructures.filter(s => isRebuildStructureRelevant(s, task?.rebuildIgnoreStructureIds));
  if (task && getSquadPolicy(task).countsNeutralWalls && !task.sharedSquadWatchId) {
    const seen = new Set(hostileStructures.map((structure) => structure.id));
    for (const wall of room.find(FIND_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_WALL,
    })) {
      if (!seen.has(wall.id) && isRebuildStructureRelevant(wall, task.rebuildIgnoreStructureIds)) {
        seen.add(wall.id);
        relevantStructures.push(wall);
      }
    }
  }

  const hostileReservation = isHostileReservation(room);
  return {
    present: hostileCreeps.length > 0 || relevantStructures.length > 0
      || (hostileReservation && !(task && getSquadPolicy(task).parallel)),
    hostileCreeps: hostileCreeps.length,
    hostileStructures: relevantStructures.length,
    hostileReservation,
  };
}

export function hasControllerAttackBlockers(room: Room): boolean {
  return room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) => WAR_CONTROLLER_CORE_STRUCTURES.has(structure.structureType),
  }).length > 0;
}

export function isControllerDowngradeReady(room: Room): boolean {
  const controller = room.controller;
  if (!controller?.owner || controller.my || controller.level <= 0) return false;
  return !hasControllerAttackBlockers(room);
}

export function isControllerDefeated(room: Room): boolean {
  const controller = room.controller;
  return !!controller && (controller.my || !controller.owner || controller.level <= 0);
}

export function defaultWarMapRoute(sourceRoom: string, targetRoom: string): { rooms?: string[]; trace: NonNullable<WarTask["routeTrace"]> } {
  const avoided: Record<string, string> = {};
  for (const room of Object.values(Game.rooms)) {
    if (room.name === sourceRoom || room.name === targetRoom || room.controller?.my || typeof room.find !== "function") continue;
    if (getRefillableHostileTowers(room).length > 0) avoided[room.name] = "current_tower_threat";
    else if (room.find(FIND_HOSTILE_CREEPS).some(actor => actor.body?.some(part => part.hits > 0 && (part.type === ATTACK || part.type === RANGED_ATTACK)))) avoided[room.name] = "current_combat_creep";
  }
  const trace: NonNullable<WarTask["routeTrace"]> = { hops: 0, avoided, policy: "map_combat" };
  if (!/^[WE]\d+[NS]\d+$/.test(sourceRoom) || !/^[WE]\d+[NS]\d+$/.test(targetRoom) || typeof Game.map?.findRoute !== "function") return { trace };
  const route = Game.map.findRoute(sourceRoom, targetRoom, { routeCallback: name => avoided[name] ? Infinity : 1 });
  if (!Array.isArray(route)) return { trace };
  const rooms = [sourceRoom, ...route.map((step) => step.room)];
  trace.hops = route.length;
  return { rooms: rooms[rooms.length - 1] === targetRoom ? rooms : undefined, trace };
}
