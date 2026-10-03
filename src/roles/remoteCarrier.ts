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
import { getCachedStaticTravelMatrix } from "@/movement/routing";

type RemoteHaulTarget = AnyStoreStructure | Ruin | Tombstone | Resource;
const SALVAGE_MODE = "invaderSalvage";
const COMBAT_PARTS: readonly BodyPartConstant[] = [ATTACK, RANGED_ATTACK, HEAL, WORK];
const salvageIntentTicks = new WeakMap<Creep, number>();
let salvageSearchTick = -1;
let salvageSearchGame: Game | undefined;
let salvageSearches = 0;

function isDrop(target: RemoteHaulTarget): target is Resource {
  return "amount" in target && "resourceType" in target;
}

function hasCombatParts(creep: Creep): boolean {
  if (typeof creep.getActiveBodyparts === "function") {
    return COMBAT_PARTS.some((part) => creep.getActiveBodyparts(part) > 0);
  }
  if (!Array.isArray(creep.body)) return true;
  return creep.body.some((part) => part.hits > 0 && COMBAT_PARTS.includes(part.type));
}

export function getInvaderSalvageKeepers(room: Room): Creep[] {
  return room.find(FIND_HOSTILE_CREEPS).filter((creep) => creep.owner?.username === "Source Keeper");
}

function getInvaderSalvageHazards(room: Room): RoomPosition[] {
  return [...getInvaderSalvageKeepers(room).map((keeper) => keeper.pos),
    ...room.find(FIND_STRUCTURES).filter((structure) => structure.structureType === STRUCTURE_KEEPER_LAIR)
      .map((lair) => lair.pos)];
}

function outsideSalvageHazards(pos: RoomPosition, hazards: readonly RoomPosition[]): boolean {
  return hazards.every((hazard) => hazard.roomName === pos.roomName &&
    Math.max(Math.abs(hazard.x - pos.x), Math.abs(hazard.y - pos.y)) >= 6);
}

function salvageWorldPosition(pos: RoomPosition): [number, number] | undefined {
  if (!pos || !Number.isSafeInteger(pos.x) || pos.x < 0 || pos.x > 49 ||
    !Number.isSafeInteger(pos.y) || pos.y < 0 || pos.y > 49) return undefined;
  const match = /^([EW])(0|[1-9]\d*)([NS])(0|[1-9]\d*)$/.exec(pos.roomName);
  if (!match) return undefined;
  const horizontal = Number(match[2]); const vertical = Number(match[4]);
  const maximum = Math.floor(Number.MAX_SAFE_INTEGER / 50) - 1;
  if (!Number.isSafeInteger(horizontal) || !Number.isSafeInteger(vertical) ||
    horizontal > maximum || vertical > maximum) return undefined;
  return [(match[1] === "E" ? horizontal : -horizontal - 1) * 50 + pos.x,
    (match[3] === "S" ? vertical : -vertical - 1) * 50 + pos.y];
}

/** 只接受当前 Game 的可见房间；历史 Memory 情报不构成清场许可。 */
export function isInvaderSalvageRoomClear(room: Room | undefined): room is Room {
  return !!room && Game.rooms[room.name] === room &&
    !room.find(FIND_STRUCTURES).some((structure) => structure.structureType === STRUCTURE_INVADER_CORE ||
      (structure.structureType === STRUCTURE_TOWER && (structure as StructureTower).my !== true)) &&
    room.find(FIND_HOSTILE_POWER_CREEPS).length === 0 &&
    !room.find(FIND_HOSTILE_CREEPS).some((creep) => creep.owner?.username !== "Source Keeper" && hasCombatParts(creep));
}

export function isInvaderSalvagePositionSafe(room: Room, pos: RoomPosition): boolean {
  return Game.rooms[room.name] === room && pos.roomName === room.name &&
    outsideSalvageHazards(pos, getInvaderSalvageHazards(room));
}

function salvageTaskActive(creep: Creep): boolean {
  const config = creep.memory.configName ? getCreepConfigService().get(creep.memory.configName) : undefined;
  return !!config?.roomName && config.args[2] === SALVAGE_MODE;
}

function markSalvageIntent(creep: Creep): void {
  salvageIntentTicks.set(creep, Game.time);
}

/** 全路径证明几何与已可见禁区；未知未来房间不代表安全，只发布 fresh 下一步。 */
function moveSalvageSafely(creep: Creep, goal: RoomPosition, range = 1): void {
  if (salvageSearchTick !== Game.time || salvageSearchGame !== Game) {
    salvageSearchTick = Game.time; salvageSearchGame = Game; salvageSearches = 0;
  }
  if (salvageSearches >= 2) return;
  salvageSearches += 1;
  try {
    const matrices = new Map<string, CostMatrix | false>();
    const hazardsByRoom = new Map<string, readonly RoomPosition[]>();
    const matrixFor = (roomName: string): CostMatrix | false => {
      const cached = matrices.get(roomName);
      if (cached !== undefined) return cached;
      const status = Game.map.getRoomStatus(roomName);
      if (!status || status.status === "closed") return false;
      const room = Game.rooms[roomName];
      if (room && roomName !== creep.room.name && !isInvaderSalvageRoomClear(room)) return false;
      const matrix = getCachedStaticTravelMatrix(roomName).clone();
      const hazards = room ? getInvaderSalvageHazards(room) : [];
      hazardsByRoom.set(roomName, hazards);
      for (const hazard of hazards) {
        for (let dx = -5; dx <= 5; dx += 1) for (let dy = -5; dy <= 5; dy += 1) {
          const x = hazard.x + dx; const y = hazard.y + dy;
          if (x >= 0 && x < 50 && y >= 0 && y < 50) matrix.set(x, y, 255);
        }
      }
      matrices.set(roomName, matrix);
      return matrix;
    };
    const path = PathFinder.search(creep.pos, { pos: goal, range }, {
      plainCost: 2, swampCost: 10, maxRooms: 16, maxOps: 6_000, roomCallback: matrixFor,
    });
    if (path.incomplete || !Array.isArray(path.path) || path.path.length === 0) return;
    const origin = salvageWorldPosition(creep.pos);
    const target = salvageWorldPosition(goal);
    if (!origin || !target) return;
    let previous = origin;
    for (const step of path.path) {
      const world = salvageWorldPosition(step);
      const matrix = matrixFor(step.roomName);
      if (!world || Math.max(Math.abs(world[0] - previous[0]), Math.abs(world[1] - previous[1])) !== 1 ||
        Math.abs(Math.floor(world[0] / 50) - Math.floor(previous[0] / 50)) +
          Math.abs(Math.floor(world[1] / 50) - Math.floor(previous[1] / 50)) > 1 ||
        !matrix || matrix.get(step.x, step.y) === 255 ||
        (Game.rooms[step.roomName] && !outsideSalvageHazards(step, hazardsByRoom.get(step.roomName) ?? []))) return;
      previous = world;
    }
    const final = path.path[path.path.length - 1];
    if (final.roomName !== goal.roomName ||
      Math.max(Math.abs(previous[0] - target[0]), Math.abs(previous[1] - target[1])) > range) return;
    const next = path.path[0];
    const nextRoom = Game.rooms[next.roomName];
    if (!nextRoom) { requestCombatObservation(next.roomName); return; }
    if (next.roomName !== creep.room.name && !isInvaderSalvageRoomClear(nextRoom)) return;
    const matrix = matrixFor(next.roomName);
    if (!matrix || matrix.get(next.x, next.y) === 255 || !isInvaderSalvagePositionSafe(nextRoom, next)) return;
    const [x, y] = origin; const [nx, ny] = salvageWorldPosition(next)!;
    const dx = Math.sign(nx - x); const dy = Math.sign(ny - y);
    const direction = dy < 0 ? (dx < 0 ? TOP_LEFT : dx > 0 ? TOP_RIGHT : TOP)
      : dy > 0 ? (dx < 0 ? BOTTOM_LEFT : dx > 0 ? BOTTOM_RIGHT : BOTTOM)
        : dx < 0 ? LEFT : RIGHT;
    if (measureCreepIntent(() => creep.move(direction)) === OK) markSalvageIntent(creep);
  } catch { /* incomplete/unknown safety 保持等待，不发布未经证明的步。 */ }
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
  if (isDrop(target)) return target.resourceType === resource ? target.amount : 0;
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
    structure.structureType === STRUCTURE_EXTENSION
  ) {
    return false;
  }

  return (structure as AnyStoreStructure).store.getUsedCapacity() > 0;
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
    const candidates = getRemoteHaulTargets(creep.room, salvage)
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
      if (!salvageTaskActive(creep) || !isInvaderSalvageRoomClear(room)) {
        if (creep.store.getUsedCapacity() > 0) return true;
        const home = getHomeRoomName(creep);
        if (creep.room.name !== home) moveSalvageSafely(creep, new RoomPosition(25, 25, home), 20);
        return false;
      }
      if (creep.room.name !== targetRoom) {
        const candidate = getRemoteHaulTargets(room, true).find((target) => isInvaderSalvagePositionSafe(room, target.pos));
        if (candidate) moveSalvageSafely(creep, candidate.pos);
        return false;
      }
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
        const terminalTarget = assignment.target;
        return executeTreasuryFencedTerminalCargo(terminalTarget, () => creep.withdraw(
          terminalTarget,
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
      if (salvage) moveSalvageSafely(creep, assignment.target.pos);
      else moveToTarget(creep, assignment.target);
      return false;
    }
    if (code !== OK) {
      exposureClaim?.release();
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
