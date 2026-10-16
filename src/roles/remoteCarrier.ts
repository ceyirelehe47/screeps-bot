import { executeTreasuryFencedTerminalCargo, isTerminalCargoBlocked } from "@/runtime/treasuryTerminalCargo";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { hasTerminalActionClaim } from "@/runtime/marketActionArbiter";
import {
  claimTerminalAmountOutsideMarketSaleExposure,
  getTerminalAmountOutsideMarketSaleExposure,
} from "@/runtime/marketSaleExposure";
import type { RoleFactory } from "@/types/system";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { requestCombatObservation } from "@/runtime/powerBankObserver";
import { getMoveIntentReceipt } from "@/movement/traffic";
import { getPowerBankOwnedAvoidRooms } from "@/runtime/powerBankTransit";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getInvaderSalvageHazards, isInvaderSalvageRoomClear, isInvaderSalvagePositionSafe,
  isInvaderSalvageTransitAllowed, invaderSalvageRouteCost, outsideInvaderSalvageHazards as outsideSalvageHazards } from "@/runtime/invaderSalvageSafety";
export {
  isInvaderSalvageRoomClear,
  isInvaderSalvagePositionSafe,
  getInvaderSalvageKeepers,
} from "@/runtime/invaderSalvageSafety";

type RemoteHaulTarget = AnyStoreStructure | Ruin | Tombstone | Resource;
const SALVAGE_MODE = "invaderSalvage";
const SALVAGE_DANGER_TTL = 500;
const salvageIntentTicks = new WeakMap<Creep, number>();
let salvageSearchTick = -1;
let salvageSearchGame: Game | undefined;
let salvageSearches = 0;
let salvageTurnNames: string[] = [];

function isDrop(target: RemoteHaulTarget): target is Resource {
  return "amount" in target && "resourceType" in target;
}

function getManagedSalvageTask(creep: Creep) {
  return Object.values(Memory.data?.flagHauling ?? {}).find(task => {
    const base = `${task.sourceRoom}:haul:${task.targetRoom}:carrier:${task.flagName}`;
    return creep.memory.configName === base || creep.memory.configName?.startsWith(base + ":");
  });
}

function salvageTaskActive(creep: Creep): boolean {
  const config = creep.memory.configName ? getCreepConfigService().get(creep.memory.configName) : undefined;
  if (config?.args[2] !== SALVAGE_MODE) return false;
  const managed = getManagedSalvageTask(creep);
  if (managed) return !!Game.flags[managed.flagName] && managed.emptyObservedAt === undefined && !isDefenseMode(managed.sourceRoom);
  return !!config.roomName;
}

function markSalvageIntent(creep: Creep): void {
  salvageIntentTicks.set(creep, Game.time);
}

function getSalvageAvoidRooms(targetRoom: string, currentRoom: string): string[] {
  const runtime = Memory.runtime ??= {};
  const dangerous = runtime.invaderSalvageDangerRooms ??= {};
  for (const [name, expiresAt] of Object.entries(dangerous)) {
    if (!Number.isFinite(expiresAt) || expiresAt <= Game.time) delete dangerous[name];
  }
  for (const room of Object.values(Game.rooms)) {
    const roomName = room.name;
    if (isInvaderSalvageTransitAllowed(room, roomName)) delete dangerous[roomName];
    else dangerous[roomName] = Game.time + SALVAGE_DANGER_TTL;
  }
  for (const name of Object.keys(dangerous)) {
    if (!Game.rooms[name] && Game.map.getRoomLinearDistance(currentRoom, name) <= 2) requestCombatObservation(name);
  }
  const owned = getPowerBankOwnedAvoidRooms().filter(name => name !== targetRoom && Memory.runtime?.powerBankOwnedRoomIntel?.[name]?.owner !== "Invader");
  return [...new Set([...owned, ...Object.keys(dangerous)])];
}

/** 回收业务只提供禁区与新鲜视野门，移动执行复用统一房内寻路。 */
function moveSalvageSafely(creep: Creep, goal: RoomPosition, range = 1): void {
  if (salvageSearchTick !== Game.time || salvageSearchGame !== Game) {
    salvageSearchTick = Game.time; salvageSearchGame = Game; salvageSearches = 0;
    const participants = Object.values(Game.creeps).filter((actor) => !actor.spawning && !actor.memory._recycleToRoom && actor.memory.role === "remoteCarrier"
      && (actor.memory.roleArgs?.[2] === SALVAGE_MODE || (actor.memory.configName && getCreepConfigService().get(actor.memory.configName)?.args[2] === SALVAGE_MODE)))
      .map((actor) => actor.name).sort();
    const start = participants.length ? Game.time % participants.length : 0;
    salvageTurnNames = [...participants.slice(start), ...participants.slice(0, start)].slice(0, 2);
  }
  if (salvageTurnNames.length && !salvageTurnNames.includes(creep.name)) return;
  if (salvageSearches >= 2) return;
  salvageSearches += 1;
  const options = {
    avoidRooms: getSalvageAvoidRooms(goal.roomName, creep.room.name),
    routePolicyKey: `invaderSalvage:${goal.roomName}`,
    routeRoomCost: (name: string) => (Memory.runtime?.invaderSalvageDangerRooms?.[name] ?? 0) > Game.time ? Infinity : invaderSalvageRouteCost(name, goal.roomName),
    plainCost: 2, swampCost: 10, ignoreCreeps: false, reusePath: 0,
    costCallback: (roomName: string, matrix: CostMatrix): CostMatrix => {
      const room = Game.rooms[roomName];
      if (!room) return matrix;
      for (const hazard of getInvaderSalvageHazards(room)) {
        for (let dx = -hazard.radius; dx <= hazard.radius; dx++) for (let dy = -hazard.radius; dy <= hazard.radius; dy++) {
          const x = hazard.pos.x + dx; const y = hazard.pos.y + dy;
          if (x >= 0 && x < 50 && y >= 0 && y < 50) matrix.set(x, y, 255);
        }
      }
      // 相邻房的 Keeper 禁区也约束出口选择，不能一直选中危险落点后原地等许可。
      const exits = typeof Game.map.describeExits === "function" ? Game.map.describeExits(roomName) : null;
      for (const [direction, nextName] of Object.entries(exits ?? {})) {
        const next = nextName && Game.rooms[nextName];
        if (!next) continue;
        const hazards = getInvaderSalvageHazards(next);
        if (!hazards.length) continue;
        const exit = Number(direction);
        if (![TOP, RIGHT, BOTTOM, LEFT].some((value) => value === exit)) continue;
        for (let coordinate = 0; coordinate < 50; coordinate++) {
          const horizontal = exit === LEFT || exit === RIGHT;
          const x = horizontal ? (exit === LEFT ? 0 : 49) : coordinate;
          const y = horizontal ? coordinate : (exit === TOP ? 0 : 49);
          const entry = new RoomPosition(horizontal ? 49 - x : x, horizontal ? y : 49 - y, next.name);
          if (!outsideSalvageHazards(entry, hazards)) matrix.set(x, y, 255);
        }
      }
      return matrix;
    },
    canMoveStep: (destination: RoomPosition): boolean => {
      const room = Game.rooms[destination.roomName];
      if (!room) { requestCombatObservation(destination.roomName); return false; }
      return (room.name === creep.room.name || isInvaderSalvageTransitAllowed(room, goal.roomName)) &&
        isInvaderSalvagePositionSafe(room, destination);
    },
  };
  if (creep.room.name === goal.roomName) {
    moveToTarget(creep, goal, Math.min(3, Math.max(0, range)) as 0 | 1 | 2 | 3, options);
  } else moveToTargetRoom(creep, goal.roomName, undefined, options);
  if (getMoveIntentReceipt(creep)) markSalvageIntent(creep);
}

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
const outboundTravelEstimateCache = new Map<string, { ticks: number; expiresAt: number }>();
let outboundEstimateTick = -1;
let outboundEstimateGame: Game | undefined;

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
  if (isDrop(target)) return target.resourceType === resource ? target.amount : 0;
  const stored = (target.store.getUsedCapacity(resource) ?? 0);
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
  if (isDrop(target)) return target.amount > 0 ? target.resourceType : null;
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
    structure.structureType === STRUCTURE_EXTENSION ||
    structure.structureType === STRUCTURE_NUKER
  ) {
    return false;
  }

  return ((structure as AnyStoreStructure).store.getUsedCapacity() ?? 0) > 0;
}

function getRemoteHaulTargets(room: Room, salvage = false): RemoteHaulTarget[] {
  const structures = room.find(FIND_STRUCTURES, {
    filter: isWithdrawTarget,
  }) as AnyStoreStructure[];
  const ruins = room.find(FIND_RUINS, {
    filter: (ruin) => ruin.store.getUsedCapacity() > 0,
  });

  if (!salvage) return [...structures, ...ruins];
  return [...structures.filter((structure) => structure.structureType === STRUCTURE_CONTAINER), ...ruins,
    ...room.find(FIND_TOMBSTONES).filter((target) => target.store.getUsedCapacity() > 0),
    ...room.find(FIND_DROPPED_RESOURCES).filter((target) => target.amount > 0)];
}

function selectPickupTarget(creep: Creep, salvage = false): { target: RemoteHaulTarget; resource: ResourceConstant } | null {
  return measureCreepDecision(() => {
    const rejected = creep.memory.remoteCarrierRejectedTargets;
    if (rejected) for (const [id, until] of Object.entries(rejected)) if (until <= Game.time) delete rejected[id];
    const candidates = getRemoteHaulTargets(creep.room, salvage)
      .filter(target => (rejected?.[target.id] ?? 0) <= Game.time)
      .filter(target => !("my" in target && target.my === false && target.pos.lookFor(LOOK_STRUCTURES)
        .some(s => s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my && !(s as StructureRampart).isPublic)))
      .filter((target) => !salvage || isInvaderSalvagePositionSafe(creep.room, target.pos))
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
  if (Game.time < outboundEstimateTick || (Game.time === outboundEstimateTick && outboundEstimateGame !== Game)) outboundTravelEstimateCache.clear();
  outboundEstimateTick = Game.time;
  outboundEstimateGame = Game;
  const cacheKey = getOutboundTravelCacheKey(startPos, targetRoom);
  const cached = outboundTravelEstimateCache.get(cacheKey);
  if (cached && cached.expiresAt > Game.time) {
    return cached.ticks;
  }

  const search = PathFinder.search(startPos, { pos: new RoomPosition(25, 25, targetRoom), range: 1 }, {
    maxOps: 10000,
    maxRooms: 16,
    plainCost: 2,
    swampCost: 10,
  });
  const estimate = search.incomplete ? Math.max(50, Game.map.getRoomLinearDistance(startPos.roomName, targetRoom) * 50) : search.path.length;
  if (outboundTravelEstimateCache.size >= 128) outboundTravelEstimateCache.delete(outboundTravelEstimateCache.keys().next().value!);
  outboundTravelEstimateCache.set(cacheKey, { ticks: estimate, expiresAt: Game.time + (search.incomplete ? 25 : 500) });

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

export const remoteCarrierRole: RoleFactory = (targetRoom: string, targetX?: string, targetY?: string) => {
  const salvage = targetY === SALVAGE_MODE;
  return ({
  prepare: (creep): boolean => {
    if (salvage) {
      requestCombatObservation(targetRoom);
      return true; // source/target 每 tick 根据实际 Store 决定，不能提前离开准备门。
    }
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
    if (salvage) {
      requestCombatObservation(targetRoom);
      if (salvageIntentTicks.get(creep) === Game.time) return false;
      const room = Game.rooms[targetRoom];
      if (!room && creep.store.getUsedCapacity() > 0) return true;
      if (!salvageTaskActive(creep) || (room && !isInvaderSalvageRoomClear(room)) ||
        (!room && (Memory.runtime?.invaderSalvageDangerRooms?.[targetRoom] ?? 0) > Game.time)) {
        if (creep.store.getUsedCapacity() > 0) return true;
        const home = getHomeRoomName(creep);
        if (creep.room.name !== home) moveSalvageSafely(creep, new RoomPosition(25, 25, home), 20);
        return false;
      }
      if (creep.room.name !== targetRoom) {
        // 远处目标和下一房不必同帧可见；实际落点仍须通过共用下一步的新鲜敌情门。
        const candidate = room ? getRemoteHaulTargets(room, true).find((target) => isInvaderSalvagePositionSafe(room, target.pos)) : undefined;
        if (!room || candidate) moveSalvageSafely(creep, candidate?.pos ?? new RoomPosition(25, 25, targetRoom));
        return false;
      }
      if (!room) return false;
    }
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

    const assignment = selectPickupTarget(creep, salvage);
    if (!assignment) {
      if (creep.store.getUsedCapacity() > 0) {
        return true;
      }

      if (salvage) return false;
      const x = Number(targetX);
      const y = Number(targetY);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        moveToTarget(creep, new RoomPosition(x, y, targetRoom), 3);
      }
      return false;
    }

    if (salvage && !isInvaderSalvagePositionSafe(creep.room, creep.pos)) {
      if (creep.store.getUsedCapacity() > 0) return true;
      moveSalvageSafely(creep, assignment.target.pos);
      return false;
    }

    let exposureClaim:
      | ReturnType<typeof claimTerminalAmountOutsideMarketSaleExposure>
      | undefined;
    let code: ScreepsReturnCode;
    try {
      code = measureCreepIntent(() => {
        if (!isTerminalTarget(assignment.target)) {
          if (isDrop(assignment.target)) return creep.pickup(assignment.target);
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
        const claimedAmount = exposureClaim.amount;
        const terminalTarget = assignment.target;
        return executeTreasuryFencedTerminalCargo(terminalTarget, () => creep.withdraw(
          terminalTarget,
          assignment.resource,
          claimedAmount,
        ));
      });
    } catch (error) {
      exposureClaim?.release();
      throw error;
    }
    if (code === ERR_NOT_IN_RANGE) {
      exposureClaim?.release();
      if (salvage) moveSalvageSafely(creep, assignment.target.pos);
      else moveToTarget(creep, assignment.target);
      return false;
    }
    if (code !== OK) {
      exposureClaim?.release();
      if (code === ERR_NOT_OWNER || code === ERR_INVALID_TARGET) {
        const rejected = creep.memory.remoteCarrierRejectedTargets ??= {};
        if (Object.keys(rejected).length >= 16) delete rejected[Object.keys(rejected)[0]];
        rejected[assignment.target.id] = Game.time + 50;
      }
    }
    if (salvage && code === OK) { markSalvageIntent(creep); return false; }
    return isCarryStoreFull(creep);
  },
  target: (creep): boolean => {
    if (salvage) requestCombatObservation(targetRoom);
    if (salvage && salvageIntentTicks.get(creep) === Game.time) return false;
    const resource = getFirstCarriedResource(creep);
    if (!resource) {
      return true;
    }

    const homeRoomName = getHomeRoomName(creep);
    if (creep.room.name !== homeRoomName) {
      if (salvage) moveSalvageSafely(creep, new RoomPosition(25, 25, homeRoomName), 20);
      else moveToTargetRoom(creep, homeRoomName, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    const target = getDeliveryTarget(homeRoomName, resource);
    if (!target) {
      return false;
    }

    const code = measureCreepIntent(() => executeTreasuryFencedTerminalCargo(target, () => creep.transfer(target, resource)));
    if (code === ERR_NOT_IN_RANGE) {
      if (salvage) moveSalvageSafely(creep, target.pos);
      else moveToTarget(creep, target);
      return false;
    }
    if (salvage && code === OK) { markSalvageIntent(creep); return false; }
    return creep.store.getUsedCapacity() === 0;
  },
  });
};
