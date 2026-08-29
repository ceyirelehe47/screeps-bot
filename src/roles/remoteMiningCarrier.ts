import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getMyUsername } from "@/runtime/remoteMining";
import { getTickContextService } from "@/runtime/runtimeServices";

import type { RoomTickContext } from "@/runtime/tickContext";
import type { RoleFactory } from "@/types/system";

const MAINTENANCE_RESERVE_ENERGY = 100;
const MAINTAINABLE_TYPES = new Set<string>([STRUCTURE_ROAD, STRUCTURE_CONTAINER]);

// Per-tick safety result cache keyed by target room. Two carriers sharing one
// visible remote room in the same tick reuse this boolean instead of re-running
// the hostile/structure/keeper-lair scans. Resets each Game.time.
let safetyCacheTick = -1;
const safetyCache = new Map<string, boolean>();

/** Test-only reset of the per-tick safety result cache; not a runtime API. */
export function clearRemoteSafetyCacheForTest(): void {
  safetyCache.clear();
  safetyCacheTick = -1;
}

function getRoomContext(room: Room): RoomTickContext | null {
  return getTickContextService().getRoomContext(room);
}

function getHomeRoomName(creep: Creep): string {
  return creep.memory.configName?.split(":")[0] || creep.room.name;
}

// 远采任务只接受基本方向相邻房（CARDINAL_EXIT_DIRECTIONS 约束），去程/
// 回程路线由任务结构直接确定为两房序列，无需持久化或失效管理；传入错误
// 序列（未来若放宽相邻约束）时 routing 层会自然回退到动态路线，安全。
function getOutboundEncodedRoute(homeRoomName: string, targetRoom: string): string {
  return `${homeRoomName}|${targetRoom}`;
}

function getRetreatEncodedRoute(homeRoomName: string, targetRoom: string): string {
  return `${targetRoom}|${homeRoomName}`;
}

function isRemoteSuspendedOrDangerous(targetRoom: string): boolean {
  const tick = Game.time;
  if (safetyCacheTick !== tick) {
    safetyCache.clear();
    safetyCacheTick = tick;
  }
  const cached = safetyCache.get(targetRoom);
  if (cached !== undefined) {
    return cached;
  }
  const remoteTask = Memory.data?.remoteMining?.[targetRoom];
  // "defending" means an NPC Invader is present; carriers must avoid the room like "suspended".
  if (remoteTask?.status === "suspended" || remoteTask?.status === "defending") {
    safetyCache.set(targetRoom, true);
    return true;
  }
  const visibleRoom = Game.rooms[targetRoom];
  const dangerous = visibleRoom ? !isRemoteRoomVisibleSafe(visibleRoom) : false;
  safetyCache.set(targetRoom, dangerous);
  return dangerous;
}

function isRemoteRoomVisibleSafe(room: Room): boolean {
  const controller = room.controller;
  if (controller?.owner && !controller.my) return false;
  if (controller?.reservation && controller.reservation.username !== getMyUsername()) return false;

  // Use tick-context cached accessors so repeated safety checks for the same
  // visible room do not re-issue raw room.find() scans within one tick.
  const ctx = getRoomContext(room);

  const hostiles = ctx ? ctx.getHostileCreeps() : room.find(FIND_HOSTILE_CREEPS);
  if (hostiles.length > 0) {
    const dangerousParts: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, HEAL];
    for (const creep of hostiles) {
      for (const part of dangerousParts) {
        if (typeof creep.getActiveBodyparts === "function") {
          if (creep.getActiveBodyparts(part) > 0) return false;
        } else if (creep.body && Array.isArray(creep.body)) {
          if (creep.body.some((bp: BodyPartDefinition) => bp.type === part && bp.hits > 0)) return false;
        }
      }
    }
  }

  const hostileStructures = ctx ? ctx.getHostileStructures() : room.find(FIND_HOSTILE_STRUCTURES);
  if (hostileStructures.some((s) => s.structureType !== STRUCTURE_CONTROLLER)) return false;

  const structures = ctx ? ctx.getStructures() : room.find(FIND_STRUCTURES);
  if (structures.some((s) => s.structureType === STRUCTURE_KEEPER_LAIR)) return false;

  return true;
}

function getCarriedEnergy(creep: Creep): number {
  return creep.store.getUsedCapacity(RESOURCE_ENERGY);
}

function getFreeCapacity(creep: Creep): number {
  return creep.store.getFreeCapacity(RESOURCE_ENERGY);
}

function isFull(creep: Creep): boolean {
  return getFreeCapacity(creep) <= 0;
}

function isEmpty(creep: Creep): boolean {
  return getCarriedEnergy(creep) === 0;
}

function retireIfLowTtl(creep: Creep): void {
  if (typeof creep.ticksToLive === "number" && creep.ticksToLive < 150) {
    if (typeof creep.suicide === "function") {
      creep.suicide();
    }
  }
}

function samePosition(left: RoomPosition, right: RoomPosition): boolean {
  return left.x === right.x && left.y === right.y && left.roomName === right.roomName;
}

function getRemoteSourceWorkPos(targetRoom: string, sourceId: string | undefined): RoomPosition | null {
  if (!sourceId) return null;
  const pos = Memory.data?.remoteMining?.[targetRoom]?.containerPositions?.[sourceId];
  if (!pos || pos.roomName !== targetRoom) return null;
  return new RoomPosition(pos.x, pos.y, pos.roomName);
}

function findSourceContainer(room: Room, sourcePos: RoomPosition, workPos?: RoomPosition | null): StructureContainer | null {
  const ctx = getRoomContext(room);
  const containers = ctx
    ? ctx.getContainers()
    : room.find(FIND_STRUCTURES, {
        filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER,
      });
  for (const container of containers) {
    if (workPos ? samePosition(container.pos, workPos) : sourcePos.getRangeTo(container.pos) <= 2) {
      return container;
    }
  }
  return null;
}

function findSourceContainerSite(room: Room, sourcePos: RoomPosition, workPos?: RoomPosition | null): ConstructionSite | null {
  const ctx = getRoomContext(room);
  const sites = ctx ? ctx.getConstructionSites() : room.find(FIND_CONSTRUCTION_SITES);
  for (const site of sites) {
    if (
      site.my &&
      site.structureType === STRUCTURE_CONTAINER &&
      (workPos ? samePosition(site.pos, workPos) : sourcePos.getRangeTo(site.pos) <= 2)
    ) {
      return site;
    }
  }
  return null;
}

function findDroppedEnergyNear(room: Room, pos: RoomPosition, exact = false): Resource | null {
  const ctx = getRoomContext(room);
  const resources = ctx
    ? ctx.getDroppedEnergyResources()
    : room.find(FIND_DROPPED_RESOURCES, {
        filter: (r): r is Resource => r.resourceType === RESOURCE_ENERGY,
      });
  for (const resource of resources) {
    if (resource.amount > 0 && (exact ? samePosition(resource.pos, pos) : pos.getRangeTo(resource.pos) <= 2)) {
      return resource;
    }
  }
  return null;
}


interface SourceEnergyTarget {
  sourceId: string;
  sourcePos: RoomPosition;
  container: StructureContainer | null;
  dropped: Resource | null;
  energy: number;
  workPos: RoomPosition | null;
}

function selectBestSourceTarget(room: Room, targetRoom: string): {
  sourceId: string;
  sourcePos: RoomPosition;
  container: StructureContainer | null;
  dropped: Resource | null;
  workPos: RoomPosition | null;
} | null {
  const sourceIds: string[] = Memory.data?.remoteMining?.[targetRoom]?.sourceIds ?? [];
  if (sourceIds.length === 0) return null;

  const candidates: SourceEnergyTarget[] = [];
  for (const sourceId of sourceIds) {
    const source = Game.getObjectById(sourceId as Id<Source>);
    if (!source) continue;
    const workPos = getRemoteSourceWorkPos(targetRoom, sourceId);
    const container = findSourceContainer(room, source.pos, workPos);
    const dropped = findDroppedEnergyNear(room, workPos ?? source.pos, !!workPos);
    const containerEnergy = container?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    const droppedEnergy = dropped?.amount ?? 0;
    const totalEnergy = containerEnergy + droppedEnergy;
    candidates.push({ sourceId, sourcePos: source.pos, container, dropped, energy: totalEnergy, workPos });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.energy - a.energy);
  return candidates[0];
}

/** Build the source container construction site near the assigned source.
 *  Only builds when the carrier has surplus energy (above reserve) and a WORK part.
 *  Returns true if a build intent was issued. */
function buildSourceContainerSite(creep: Creep, sourcePos: RoomPosition, workPos?: RoomPosition | null): boolean {
  const surplus = getCarriedEnergy(creep) - MAINTENANCE_RESERVE_ENERGY;
  if (surplus <= 0) return false;

  const workParts = creep.getActiveBodyparts(WORK);
  if (workParts <= 0) return false;

  const site = findSourceContainerSite(creep.room, sourcePos, workPos);
  if (!site) return false;

  const range = creep.pos.getRangeTo(site.pos);
  if (range > 3) return false;

  const code = measureCreepIntent(() => creep.build(site));
  return code === OK;
}

/** One maintenance intent per tick: repair roads/containers or build road/container sites within range 3.
 *  Never spends below MAINTENANCE_RESERVE_ENERGY. Returns true if an intent was issued. */
function runMaintenance(creep: Creep): boolean {
  const surplus = getCarriedEnergy(creep) - MAINTENANCE_RESERVE_ENERGY;
  if (surplus <= 0) {
    return false;
  }

  const workParts = creep.getActiveBodyparts(WORK);
  if (workParts <= 0) {
    return false;
  }

  const pos = creep.pos;
  const ctx = getRoomContext(creep.room);
  const structures = ctx ? ctx.getStructures() : creep.room.find(FIND_STRUCTURES);

  const repairTargets = structures.filter(
    (s): s is StructureRoad | StructureContainer =>
      MAINTAINABLE_TYPES.has(s.structureType) &&
      s.hits < s.hitsMax &&
      pos.getRangeTo(s.pos) <= 3,
  );
  if (repairTargets.length > 0) {
    repairTargets.sort((a, b) => a.hits - b.hits);
    const code = measureCreepIntent(() => creep.repair(repairTargets[0]));
    if (code === OK) {
      return true;
    }
  }

  const sites = ctx ? ctx.getConstructionSites() : creep.room.find(FIND_CONSTRUCTION_SITES);
  const buildTargets = sites.filter(
    (s): s is ConstructionSite =>
      s.my &&
      MAINTAINABLE_TYPES.has(s.structureType) &&
      pos.getRangeTo(s.pos) <= 3,
  );
  if (buildTargets.length > 0) {
    const code = measureCreepIntent(() => creep.build(buildTargets[0]));
    if (code === OK) {
      return true;
    }
  }

  return false;
}

/** Get delivery target: storage first, then terminal. */
function getDeliveryTarget(homeRoomName: string): AnyStoreStructure | null {
  const homeRoom = Game.rooms[homeRoomName];
  if (!homeRoom) {
    return null;
  }

  if (homeRoom.storage && homeRoom.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    return homeRoom.storage;
  }

  if (homeRoom.terminal && homeRoom.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    return homeRoom.terminal;
  }

  return null;
}

export const remoteMiningCarrierRole: RoleFactory = (targetRoom: string, sourceId?: string) => {
  return {
    source: (creep): boolean => {
      const homeRoomName = getHomeRoomName(creep);

      if (isRemoteSuspendedOrDangerous(targetRoom)) {
        if (creep.room.name !== homeRoomName) {
          moveToTargetRoom(creep, homeRoomName, getRetreatEncodedRoute(homeRoomName, targetRoom), { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
        }
        return false;
      }

      if (isFull(creep)) {
        delete creep.memory._rmcSelectedSource;
        return true;
      }

      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, getOutboundEncodedRoute(homeRoomName, targetRoom), { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
        if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
          runMaintenance(creep);
        }
        return false;
      }

      let resolvedSourcePos: RoomPosition | null = null;
      let resolvedWorkPos: RoomPosition | null = null;
      let resolvedContainer: StructureContainer | null = null;
      let resolvedDropped: Resource | null = null;

      if (sourceId) {
        const source = Game.getObjectById(sourceId as Id<Source>);
        resolvedWorkPos = getRemoteSourceWorkPos(targetRoom, sourceId);
        resolvedSourcePos = source?.pos || resolvedWorkPos || creep.pos;
        resolvedContainer = source ? findSourceContainer(creep.room, source.pos, resolvedWorkPos) : null;
      } else {
        const best = selectBestSourceTarget(creep.room, targetRoom);
        if (best) {
          creep.memory._rmcSelectedSource = best.sourceId;
          resolvedSourcePos = best.sourcePos;
          resolvedWorkPos = best.workPos;
          resolvedContainer = best.container;
          resolvedDropped = best.dropped;
        } else {
          resolvedSourcePos = creep.pos;
        }
      }

      const sourcePos = resolvedSourcePos || creep.pos;
      const container = resolvedContainer;

      if (container) {
        const containerEnergy = container.store.getUsedCapacity(RESOURCE_ENERGY);

        if (containerEnergy > 0) {
          const code = measureCreepIntent(() => creep.withdraw(container, RESOURCE_ENERGY));
          if (code === ERR_NOT_IN_RANGE) {
            moveToTarget(creep, container, 1);
            if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
              runMaintenance(creep);
            }
            return false;
          }
          if (code === OK) {
            if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
              runMaintenance(creep);
            }
            return true;
          }
        }
      }

      const containerSite = findSourceContainerSite(creep.room, sourcePos, resolvedWorkPos);

      if (buildSourceContainerSite(creep, sourcePos, resolvedWorkPos)) {
        return true;
      }

      const dropPos = container?.pos || containerSite?.pos || sourcePos;
      const dropped = resolvedDropped ?? findDroppedEnergyNear(creep.room, dropPos, !!(resolvedWorkPos && samePosition(dropPos, resolvedWorkPos)));
      if (dropped) {
        const code = measureCreepIntent(() => creep.pickup(dropped));
        if (code === ERR_NOT_IN_RANGE) {
          moveToTarget(creep, dropped, 1);
          return false;
        }
        if (code === OK) {
          return true;
        }
      }

      if (getCarriedEnergy(creep) > 0) {
        return true;
      }

      let issuedMove = false;
      if (containerSite && creep.pos.getRangeTo(containerSite.pos) > 3) {
        moveToTarget(creep, containerSite.pos, 2);
        issuedMove = true;
      } else if (creep.pos.getRangeTo(sourcePos) > 3) {
        moveToTarget(creep, sourcePos, 3);
        issuedMove = true;
      }
      if (!issuedMove) {
        clearMovementState(creep);
      }

      if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
        runMaintenance(creep);
      }

      return false;
    },

    target: (creep): boolean => {
      const homeRoomName = getHomeRoomName(creep);
      const suspended = isRemoteSuspendedOrDangerous(targetRoom);

      if (isEmpty(creep)) {
        if (suspended) {
          if (creep.room.name !== homeRoomName) {
            moveToTargetRoom(creep, homeRoomName, getRetreatEncodedRoute(homeRoomName, targetRoom), { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
          }
          return false;
        }
        if (creep.room.name === homeRoomName) {
          retireIfLowTtl(creep);
        }
        return true;
      }

      if (suspended && creep.room.name !== homeRoomName) {
        moveToTargetRoom(creep, homeRoomName, getRetreatEncodedRoute(homeRoomName, targetRoom), { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
        return false;
      }

      if (!suspended && creep.room.name !== homeRoomName) {
        moveToTargetRoom(creep, homeRoomName, getRetreatEncodedRoute(homeRoomName, targetRoom), { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
        if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
          runMaintenance(creep);
        }
        return false;
      }

      const target = measureCreepDecision(() => getDeliveryTarget(homeRoomName));
      if (!target) {
        return false;
      }

      const code = measureCreepIntent(() => creep.transfer(target, RESOURCE_ENERGY));
      if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, target, 1);
        return false;
      }

      if (isEmpty(creep)) {
        retireIfLowTtl(creep);
      }

      return isEmpty(creep);
    },
  };
};
