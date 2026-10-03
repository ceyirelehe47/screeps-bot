import type { RoleFactory } from "@/types/system";
import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { getPowerBankSearchRooms } from "@/runtime/powerBankSearch";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { moveToTargetRoom } from "@/roles/shared";

const TRANSIT_DANGER_TTL = 500;

interface PatrolMemory {
  patrolIndex?: number;
  patrolDirection?: 1 | -1;
  originRoomName?: string;
}

function ensurePatrolMemory(creep: Creep): PatrolMemory {
  if (!creep.memory._patrol) {
    creep.memory._patrol = {};
  }
  return creep.memory._patrol as PatrolMemory;
}

function getCurrentPatrolTarget(patrol: PatrolMemory, rooms: readonly string[]): string {
  const index = Number.isSafeInteger(patrol.patrolIndex) ? patrol.patrolIndex! : 0;
  return rooms[((index % rooms.length) + rooms.length) % rooms.length];
}

function advancePatrol(patrol: PatrolMemory, rooms: readonly string[]): void {
  const length = rooms.length;
  if (length <= 1) return;

  const rawIndex = patrol.patrolIndex ?? 0;
  const current = ((rawIndex % length) + length) % length;
  const direction = patrol.patrolDirection === -1 ? -1 : 1;
  const lastIndex = length - 1;

  if (current === lastIndex) {
    patrol.patrolIndex = lastIndex - 1;
    patrol.patrolDirection = -1;
    return;
  }

  if (current === 0 && direction === -1) {
    patrol.patrolIndex = 1;
    patrol.patrolDirection = 1;
    return;
  }

  patrol.patrolIndex = current + direction;
  patrol.patrolDirection = direction;
}

function scanRoomForPowerBanks(creep: Creep): void {
  if (!isPowerBankSearchRoom(creep.room.name)) {
    return;
  }

  const banks = creep.room.find(FIND_STRUCTURES).filter(
    (s): s is StructurePowerBank => s.structureType === STRUCTURE_POWER_BANK,
  );

  for (const bank of banks) {
    recordPowerBankDiscovery(bank);
  }
}

function hasHostileCombatPresence(room: Room): boolean {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  for (const h of hostiles) {
    if (
      h.getActiveBodyparts(ATTACK) > 0 ||
      h.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      h.getActiveBodyparts(HEAL) > 0
    ) {
      return true;
    }
  }
  if (room.find(FIND_HOSTILE_POWER_CREEPS).length > 0) {
    return true;
  }
  return false;
}

function hasHostileController(room: Room): boolean {
  if (room.controller?.owner && !room.controller.my) {
    return true;
  }
  if (room.controller?.reservation && !room.controller.my) {
    const myUser =
      Object.values(Game.spawns)[0]?.owner.username ||
      Object.values(Game.creeps)[0]?.owner.username;
    if (!myUser || room.controller.reservation.username !== myUser) {
      return true;
    }
  }
  return false;
}

function markTransitDanger(roomName: string): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.transitDangerRooms) Memory.runtime.transitDangerRooms = {};
  Memory.runtime.transitDangerRooms[roomName] = Game.time + TRANSIT_DANGER_TTL;
}

function markPermanentTransitDanger(roomName: string): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.powerBankPermanentDangerRooms) Memory.runtime.powerBankPermanentDangerRooms = {};
  Memory.runtime.powerBankPermanentDangerRooms[roomName] = true;
}

export function getActiveTransitDangerRooms(): string[] {
  const runtime = Memory.runtime;
  if (!runtime) return [];

  const now = Game.time;
  const active = new Set<string>();
  const permanent = runtime.powerBankPermanentDangerRooms;
  if (permanent) {
    for (const room of Object.keys(permanent)) {
      active.add(room);
    }
  }

  const temporary = runtime.transitDangerRooms;
  if (temporary) {
    for (const [room, expiresAt] of Object.entries(temporary)) {
      if (expiresAt <= now) {
        delete temporary[room];
        continue;
      }
      active.add(room);
    }
  }

  return [...active];
}

function checkAndMarkTransitDanger(creep: Creep): void {
  const roomName = creep.room.name;
  const lastHits = creep.memory._lastHits;
  const currentHits = creep.hits;
  creep.memory._lastHits = currentHits;

  const damaged = lastHits !== undefined && currentHits < lastHits;
  if (hasHostileController(creep.room)) {
    markPermanentTransitDanger(roomName);
  }
  if (damaged || hasHostileCombatPresence(creep.room)) {
    markTransitDanger(roomName);
  }
}

export const powerBankScoutRole: RoleFactory = () => ({
  source: (creep: Creep): boolean => {
    const patrol = ensurePatrolMemory(creep);
    const configName = creep.memory.configName;
    const configuredOrigin = configName ? Memory.data?.creepConfigs?.[configName]?.roomName : undefined;
    const origin = configuredOrigin || patrol.originRoomName || creep.room.name;
    if (patrol.originRoomName !== origin) {
      patrol.originRoomName = origin;
      patrol.patrolIndex = 0;
      patrol.patrolDirection = 1;
    }

    checkAndMarkTransitDanger(creep);
    scanRoomForPowerBanks(creep);

    const avoidRooms = getActiveTransitDangerRooms();
    const danger = new Set(avoidRooms);
    // 补盲覆盖所有己方来源的并集；无来源上下文的旧 Scout 才使用稳定原点。
    const sourceRooms = getPowerBankSearchRooms();
    const rooms = (sourceRooms.length > 0 ? sourceRooms : getPowerBankSearchRooms(origin))
      .filter((roomName) => !danger.has(roomName));
    if (rooms.length === 0) return false;
    const targetRoom = getCurrentPatrolTarget(patrol, rooms);

    if (creep.room.name === targetRoom) {
      advancePatrol(patrol, rooms);
      const nextTarget = getCurrentPatrolTarget(patrol, rooms);
      moveToTargetRoom(creep, nextTarget, undefined, { plainCost: 1, swampCost: 1, reusePath: 5, avoidRooms });
      return false;
    }

    moveToTargetRoom(creep, targetRoom, undefined, { plainCost: 1, swampCost: 1, reusePath: 5, avoidRooms });
    return false;
  },
  target: (): boolean => false,
});
