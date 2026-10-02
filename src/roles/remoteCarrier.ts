import { executeTreasuryFencedTerminalCargo, isTerminalCargoBlocked } from "@/runtime/treasuryTerminalCargo";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { hasTerminalActionClaim } from "@/runtime/marketActionArbiter";
import {
  claimTerminalAmountOutsideMarketSaleExposure,
  getTerminalAmountOutsideMarketSaleExposure,
} from "@/runtime/marketSaleExposure";
import type { RoleFactory } from "@/types/system";

type RemoteHaulTarget = AnyStoreStructure | Ruin;

const T3_RESOURCES = new Set<ResourceConstant>([
  RESOURCE_CATALYZED_UTRIUM_ACID,
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
  RESOURCE_CATALYZED_KEANIUM_ACID,
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
  RESOURCE_CATALYZED_LEMERGIUM_ACID,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
  RESOURCE_CATALYZED_ZYNTHIUM_ACID,
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
  RESOURCE_CATALYZED_GHODIUM_ACID,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
]);
const outboundTravelEstimateCache = new Map<string, number>();

function getStoredResources(store: StoreDefinition): ResourceConstant[] {
  return (Object.keys(store) as ResourceConstant[]).filter((resource) => store.getUsedCapacity(resource) > 0);
}

function getFirstCarriedResource(creep: Creep): ResourceConstant | null {
  return getStoredResources(creep.store)[0] || null;
}

function isTerminalTarget(target: RemoteHaulTarget): target is StructureTerminal {
  return (
    "structureType" in target &&
    target.structureType === STRUCTURE_TERMINAL
  );
}

function getAvailableResourceAmount(
  target: RemoteHaulTarget,
  resource: ResourceConstant,
): number {
  const stored = target.store.getUsedCapacity(resource);
  if (!isTerminalTarget(target)) return stored;
  return Math.min(
    stored,
    getTerminalAmountOutsideMarketSaleExposure(
      target,
      resource,
      target.room?.name,
    ),
  );
}

function getBestResource(target: RemoteHaulTarget): ResourceConstant | null {
  const resources = getStoredResources(target.store)
    .filter(resource => getAvailableResourceAmount(target, resource) > 0);
  if (resources.length === 0) {
    return null;
  }

  return resources.sort((left, right) => {
    const leftTier = T3_RESOURCES.has(left) ? 1 : 0;
    const rightTier = T3_RESOURCES.has(right) ? 1 : 0;
    if (leftTier !== rightTier) {
      return rightTier - leftTier;
    }

    return (
      getAvailableResourceAmount(target, right) -
      getAvailableResourceAmount(target, left)
    );
  })[0];
}

function isWithdrawTarget(structure: Structure<StructureConstant>): structure is AnyStoreStructure {
  if (!("store" in structure)) {
    return false;
  }

  if (
    structure.structureType === STRUCTURE_CONTROLLER ||
    structure.structureType === STRUCTURE_SPAWN ||
    structure.structureType === STRUCTURE_EXTENSION
  ) {
    return false;
  }

  return (structure as AnyStoreStructure).store.getUsedCapacity() > 0;
}

function getRemoteHaulTargets(room: Room): RemoteHaulTarget[] {
  const structures = room.find(FIND_STRUCTURES, {
    filter: isWithdrawTarget,
  }) as AnyStoreStructure[];
  const ruins = room.find(FIND_RUINS, {
    filter: (ruin) => ruin.store.getUsedCapacity() > 0,
  });

  return [...structures, ...ruins];
}

function selectPickupTarget(creep: Creep): { target: RemoteHaulTarget; resource: ResourceConstant } | null {
  return measureCreepDecision(() => {
    const candidates = getRemoteHaulTargets(creep.room)
      .map((target) => ({
        target,
        resource: getBestResource(target),
      }))
      .filter((entry): entry is { target: RemoteHaulTarget; resource: ResourceConstant } => !!entry.resource)
      .sort((left, right) => {
        const leftTier = T3_RESOURCES.has(left.resource) ? 1 : 0;
        const rightTier = T3_RESOURCES.has(right.resource) ? 1 : 0;
        if (leftTier !== rightTier) {
          return rightTier - leftTier;
        }

        const leftAmount = getAvailableResourceAmount(left.target, left.resource);
        const rightAmount = getAvailableResourceAmount(right.target, right.resource);
        if (leftAmount !== rightAmount) {
          return rightAmount - leftAmount;
        }

        return creep.pos.getRangeTo(left.target.pos) - creep.pos.getRangeTo(right.target.pos);
      });

    return candidates[0] || null;
  });
}

function getDeliveryTarget(homeRoomName: string, resource: ResourceConstant): AnyStoreStructure | null {
  const homeRoom = Game.rooms[homeRoomName];
  if (!homeRoom) {
    return null;
  }

  if (homeRoom.terminal && homeRoom.terminal.store.getFreeCapacity(resource) > 0) {
    return homeRoom.terminal;
  }

  if (homeRoom.storage && homeRoom.storage.store.getFreeCapacity(resource) > 0) {
    return homeRoom.storage;
  }

  return null;
}

function isCarryStoreFull(creep: Creep): boolean {
  return (creep.store.getFreeCapacity() ?? 0) <= 0;
}

function getHomeRoomName(creep: Creep): string {
  return creep.memory.configName?.split(":")[0] || creep.room.name;
}

function getOutboundTravelCacheKey(startPos: RoomPosition, targetRoom: string): string {
  return `${startPos.roomName}:${startPos.x}:${startPos.y}->${targetRoom}:25:25`;
}

function estimateOutboundTravelTicks(startPos: RoomPosition, targetRoom: string): number {
  const cacheKey = getOutboundTravelCacheKey(startPos, targetRoom);
  const cached = outboundTravelEstimateCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const search = PathFinder.search(startPos, { pos: new RoomPosition(25, 25, targetRoom), range: 1 }, {
    maxOps: 10000,
    maxRooms: 16,
    plainCost: 2,
    swampCost: 10,
  });
  const estimate = search.incomplete ? Infinity : search.path.length;
  outboundTravelEstimateCache.set(cacheKey, estimate);

  return estimate;
}

function shouldRetireBeforeDeparture(creep: Creep, targetRoom: string): boolean {
  if (creep.ticksToLive === undefined) {
    return false;
  }

  const homeRoomName = getHomeRoomName(creep);
  const homeRoom = Game.rooms[homeRoomName] || creep.room;
  const startPos = homeRoom.storage?.pos || creep.pos;

  return creep.ticksToLive < estimateOutboundTravelTicks(startPos, targetRoom) * 2 + 50;
}

export const remoteCarrierRole: RoleFactory = (targetRoom: string, targetX?: string, targetY?: string) => ({
  prepare: (creep): boolean => {
    if (creep.store.getUsedCapacity() > 0) {
      return true;
    }

    if (creep.room.name !== targetRoom) {
      const homeRoomName = getHomeRoomName(creep);
      if (creep.room.name === homeRoomName && shouldRetireBeforeDeparture(creep, targetRoom)) {
        creep.suicide();
        return false;
      }

      moveToTargetRoom(creep, targetRoom, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    return true;
  },
  source: (creep): boolean => {
    if (creep.store.getUsedCapacity() > 0 && isCarryStoreFull(creep)) {
      return true;
    }

    if (creep.room.name !== targetRoom) {
      const homeRoomName = getHomeRoomName(creep);
      if (creep.room.name === homeRoomName && shouldRetireBeforeDeparture(creep, targetRoom)) {
        creep.suicide();
        return false;
      }

      moveToTargetRoom(creep, targetRoom, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    const assignment = selectPickupTarget(creep);
    if (!assignment) {
      if (creep.store.getUsedCapacity() > 0) {
        return true;
      }

      const x = Number(targetX);
      const y = Number(targetY);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        moveToTarget(creep, new RoomPosition(x, y, targetRoom), 3);
      }
      return false;
    }

    let exposureClaim:
      | ReturnType<typeof claimTerminalAmountOutsideMarketSaleExposure>
      | undefined;
    let code: ScreepsReturnCode;
    try {
      code = measureCreepIntent(() => {
        if (!isTerminalTarget(assignment.target)) {
          return creep.withdraw(assignment.target, assignment.resource);
        }

        const roomName = assignment.target.room?.name || creep.room.name;
        if (hasTerminalActionClaim(roomName) || isTerminalCargoBlocked(assignment.target)) return ERR_BUSY;
        const requestedAmount = Math.min(
          creep.store.getFreeCapacity(assignment.resource) ?? 0,
          getAvailableResourceAmount(
            assignment.target,
            assignment.resource,
          ),
        );
        if (requestedAmount <= 0) return ERR_NOT_ENOUGH_RESOURCES;
        exposureClaim = claimTerminalAmountOutsideMarketSaleExposure(
          assignment.target,
          assignment.resource,
          requestedAmount,
          roomName,
        ) || undefined;
        if (!exposureClaim) return ERR_NOT_ENOUGH_RESOURCES;
        return executeTreasuryFencedTerminalCargo(assignment.target, () => creep.withdraw(
          assignment.target,
          assignment.resource,
          exposureClaim.amount,
        ));
      });
    } catch (error) {
      exposureClaim?.release();
      throw error;
    }
    if (code === ERR_NOT_IN_RANGE) {
      exposureClaim?.release();
      moveToTarget(creep, assignment.target);
      return false;
    }
    if (code !== OK) {
      exposureClaim?.release();
    }

    return isCarryStoreFull(creep);
  },
  target: (creep): boolean => {
    const resource = getFirstCarriedResource(creep);
    if (!resource) {
      return true;
    }

    const homeRoomName = getHomeRoomName(creep);
    if (creep.room.name !== homeRoomName) {
      moveToTargetRoom(creep, homeRoomName, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    const target = getDeliveryTarget(homeRoomName, resource);
    if (!target) {
      return false;
    }

    const code = measureCreepIntent(() => executeTreasuryFencedTerminalCargo(target, () => creep.transfer(target, resource)));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target);
      return false;
    }

    return creep.store.getUsedCapacity() === 0;
  },
});
