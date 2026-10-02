import { executeTreasuryFencedTerminalCargo } from "@/runtime/treasuryTerminalCargo";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { POWER_BANK_STATUS, isPowerBankPatrolRoom } from "@/runtime/powerBankConstants";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getCreepMovementState } from "@/movement/creepState";
import { getPositionAtDirection } from "@/movement/common";
import { findMyCreepAt } from "@/movement/traffic";
import type { RoleFactory } from "@/types/system";

const HAULING_EMPTY_CONFIRM_TICKS = 100;
const DELIVERY_RETRY_TICKS = 5;
const DELIVERY_CAPACITY_WAIT_TICKS = 25;
const DELIVERY_TRAVEL_TICKS_PER_ROOM = 50;
const DELIVERY_ROOM_BUFFER_TICKS = 50;

type PowerBankHaulerTask = PowerBankHarvestTask & {
  dangerousRooms?: string[];
  routeDangerRooms?: string[];
};

type PowerBankHaulerRuntimeMemory = PowerBankHaulerMemory & {
  powerBankDeliveryRetryAt?: number;
};

interface DeliveryCandidate {
  roomName: string;
  target: StructureTerminal | StructureStorage;
  routeLength: number;
  headroom: number;
}

type DeliveryBlockerReason = "capacity" | "route" | "ttl";

let deliveryReservationTick = -1;
let deliveryReservationMemory: Memory | null = null;
const deliveryReservations: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Task lookup
// ---------------------------------------------------------------------------

function getTaskForCreep(creep: Creep): PowerBankHaulerTask | null {
  const mem = creep.memory as PowerBankHaulerMemory;
  if (!mem.taskId) return null;
  return (Memory.data?.powerBankHarvest?.[mem.taskId] as PowerBankHaulerTask | undefined) ?? null;
}

function getSourceRoomName(creep: Creep): string {
  const task = getTaskForCreep(creep);
  if (task) return task.sourceRoom;
  return creep.memory.configName?.split(":")[0] || creep.room.name;
}

function getTargetRoomName(creep: Creep, targetRoom?: string): string | undefined {
  if (targetRoom) return targetRoom;

  const parts = creep.memory.configName?.split(":") || [];
  if (parts[1] === "powerbank" && parts[2]) {
    return parts[2];
  }

  return undefined;
}

function getTaskEncodedRoute(task: PowerBankHaulerTask | null, fallback?: string): string | undefined {
  if (!task?.routeRooms || task.routeRooms.length === 0) return fallback;
  const rooms = task.routeRooms.filter((roomName) => typeof roomName === "string" && roomName.length > 0);
  return rooms.length > 0 ? rooms.join("|") : fallback;
}

// ---------------------------------------------------------------------------
// Terminal state helpers
// ---------------------------------------------------------------------------

function isTerminalStatus(status: PowerBankHarvestStatus): boolean {
  return (
    status === POWER_BANK_STATUS.COMPLETE ||
    status === POWER_BANK_STATUS.FAILED ||
    status === POWER_BANK_STATUS.ABORTED
  );
}

// ---------------------------------------------------------------------------
// Power pickup in target room
// ---------------------------------------------------------------------------

function findDroppedPower(room: Room, bankPos: { x: number; y: number }): Resource | null {
  const resources = room.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_POWER,
  });
  if (resources.length === 0) return null;

  // Sort by proximity to bank position
  resources.sort((a, b) => {
    const da = Math.abs(a.pos.x - bankPos.x) + Math.abs(a.pos.y - bankPos.y);
    const db = Math.abs(b.pos.x - bankPos.x) + Math.abs(b.pos.y - bankPos.y);
    return da - db;
  });

  return resources[0];
}

function findAnyDroppedPower(room: Room): Resource | null {
  if (typeof room.find !== "function") {
    return null;
  }

  const resources = room.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_POWER,
  });
  if (resources.length === 0) return null;

  resources.sort((a, b) => b.amount - a.amount);
  return resources[0];
}

function findPowerBank(room: Room): StructurePowerBank | null {
  if (typeof room.find !== "function") {
    return null;
  }

  const banks = room.find(FIND_STRUCTURES, {
    filter: (structure): structure is StructurePowerBank => structure.structureType === STRUCTURE_POWER_BANK,
  });

  return banks[0] || null;
}

function isWalkableTile(pos: RoomPosition): boolean {
  return Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) !== TERRAIN_MASK_WALL;
}

function isPowerBankHaulerAt(pos: RoomPosition, excludeName: string): boolean {
  const occupant = findMyCreepAt(pos, excludeName);
  return occupant !== null && occupant.memory.role === "powerBankHauler";
}

function getSideDirections(dir: DirectionConstant): [DirectionConstant, DirectionConstant] {
  const cw: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
  const idx = cw.indexOf(dir);
  const prev = (idx + 7) % 8;
  const next = (idx + 1) % 8;
  return [cw[prev], cw[next]];
}

function waitAwayFromBank(creep: Creep, bankPos: { x: number; y: number }): void {
  const range = Math.max(
    Math.abs(creep.pos.x - bankPos.x),
    Math.abs(creep.pos.y - bankPos.y),
  );
  if (range >= 5) {
    return;
  }

  if (getCreepMovementState(creep.name)?.movementPushedAt === Game.time) {
    return;
  }

  const dx = creep.pos.x - bankPos.x;
  const dy = creep.pos.y - bankPos.y;
  let dir: DirectionConstant | null = null;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx === 0 && ady === 0) {
    dir = BOTTOM as DirectionConstant;
  } else if (adx >= 2 * ady) {
    dir = dx > 0 ? (RIGHT as DirectionConstant) : (LEFT as DirectionConstant);
  } else if (ady >= 2 * adx) {
    dir = dy > 0 ? (BOTTOM as DirectionConstant) : (TOP as DirectionConstant);
  } else if (dx > 0 && dy > 0) {
    dir = BOTTOM_RIGHT as DirectionConstant;
  } else if (dx > 0 && dy < 0) {
    dir = TOP_RIGHT as DirectionConstant;
  } else if (dx < 0 && dy > 0) {
    dir = BOTTOM_LEFT as DirectionConstant;
  } else {
    dir = TOP_LEFT as DirectionConstant;
  }

  const targetPos = getPositionAtDirection(creep.pos, dir);
  if (!targetPos) {
    return;
  }

  if (!isPowerBankHaulerAt(targetPos, creep.name)) {
    // Tactical directional move — not destination pathfinding
    measureCreepIntent(() => creep.move(dir!));
    return;
  }

  const [sideA, sideB] = getSideDirections(dir!);
  const sideAPos = getPositionAtDirection(creep.pos, sideA);
  if (sideAPos && isWalkableTile(sideAPos) && !isPowerBankHaulerAt(sideAPos, creep.name)) {
    // Tactical directional move — not destination pathfinding
    measureCreepIntent(() => creep.move(sideA));
    return;
  }

  const sideBPos = getPositionAtDirection(creep.pos, sideB);
  if (sideBPos && isWalkableTile(sideBPos) && !isPowerBankHaulerAt(sideBPos, creep.name)) {
    // Tactical directional move — not destination pathfinding
    measureCreepIntent(() => creep.move(sideB));
    return;
  }
}

function isExitCoordinate(x: number, y: number): boolean {
  return x <= 0 || x >= 49 || y <= 0 || y >= 49;
}

function getRangeToPosition(left: RoomPosition, right: { x: number; y: number }): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function findBankStagingPosition(creep: Creep, bankPos: RoomPosition): RoomPosition {
  const terrain = Game.map.getRoomTerrain(bankPos.roomName);
  let best: RoomPosition | null = null;
  let bestScore = Infinity;

  for (let x = Math.max(1, bankPos.x - 6); x <= Math.min(48, bankPos.x + 6); x += 1) {
    for (let y = Math.max(1, bankPos.y - 6); y <= Math.min(48, bankPos.y + 6); y += 1) {
      const range = Math.max(Math.abs(x - bankPos.x), Math.abs(y - bankPos.y));
      if (range < 5 || range > 6) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

      const score = Math.abs(creep.pos.x - x) + Math.abs(creep.pos.y - y) + (range - 5) * 20;
      if (score >= bestScore) continue;

      bestScore = score;
      best = new RoomPosition(x, y, bankPos.roomName);
    }
  }

  return best ?? new RoomPosition(
    Math.min(48, Math.max(1, bankPos.x)),
    Math.min(48, Math.max(1, bankPos.y + 5)),
    bankPos.roomName,
  );
}

function moveToBankVicinity(creep: Creep, bankPos: RoomPosition | { x: number; y: number; roomName?: string }): void {
  const roomName = bankPos.roomName || creep.room.name;
  const targetPos = bankPos.roomName ? bankPos as RoomPosition : new RoomPosition(bankPos.x, bankPos.y, roomName);
  const range = getRangeToPosition(creep.pos, targetPos);

  if (creep.room.name === targetPos.roomName && range < 5) {
    waitAwayFromBank(creep, targetPos);
    return;
  }
  if (creep.room.name === targetPos.roomName && range <= 6 && !isExitCoordinate(creep.pos.x, creep.pos.y)) {
    return;
  }

  const stagingPos = findBankStagingPosition(creep, targetPos);

  moveToTarget(creep, stagingPos, 0, {
    reusePath: 10,
    ignoreCreeps: true,
    avoidExitTiles: true,
  });
}

// ---------------------------------------------------------------------------
// Delivery to an owned room terminal/storage
// ---------------------------------------------------------------------------

function getPowerUsed(creep: Creep): number {
  return creep.store.getUsedCapacity(RESOURCE_POWER) || 0;
}

function getPowerFree(creep: Creep): number {
  return creep.store.getFreeCapacity(RESOURCE_POWER) || 0;
}

function getPowerHeadroom(structure: StructureTerminal | StructureStorage | undefined): number {
  if (!structure) return 0;
  return structure.store.getFreeCapacity(RESOURCE_POWER) || 0;
}

function refreshDeliveryReservations(): void {
  if (deliveryReservationTick === Game.time && deliveryReservationMemory === Memory) return;
  deliveryReservationTick = Game.time;
  deliveryReservationMemory = Memory;
  for (const id of Object.keys(deliveryReservations)) delete deliveryReservations[id];
}

function getAvailablePowerHeadroom(structure: StructureTerminal | StructureStorage): number {
  refreshDeliveryReservations();
  return Math.max(0, getPowerHeadroom(structure) - (deliveryReservations[structure.id] ?? 0));
}

function reserveDeliveryHeadroom(structure: StructureTerminal | StructureStorage, amount: number): void {
  refreshDeliveryReservations();
  deliveryReservations[structure.id] = (deliveryReservations[structure.id] ?? 0) + amount;
}

function getPreferredDeliveryStructure(room: Room): StructureTerminal | StructureStorage | null {
  if (room.terminal && getAvailablePowerHeadroom(room.terminal) > 0) {
    return room.terminal;
  }
  if (room.storage && getAvailablePowerHeadroom(room.storage) > 0) {
    return room.storage;
  }
  return null;
}

function getTaskDangerRooms(task: PowerBankHaulerTask | null): string[] {
  const dangerous = new Set<string>([
    ...(task?.avoidRooms ?? []),
    ...(task?.dangerousRooms ?? []),
    ...(task?.routeDangerRooms ?? []),
  ]);
  const runtime = Memory.runtime;
  for (const roomName of Object.keys(runtime?.powerBankPermanentDangerRooms ?? {})) {
    dangerous.add(roomName);
  }
  for (const [roomName, expiresAt] of Object.entries(runtime?.transitDangerRooms ?? {})) {
    if (expiresAt > Game.time) dangerous.add(roomName);
  }
  if (task) {
    dangerous.delete(task.sourceRoom);
    dangerous.delete(task.targetRoom);
  }
  return [...dangerous];
}

function roomHasHostiles(room: Room): boolean {
  if (typeof room.find !== "function") return false;
  return room.find(FIND_HOSTILE_CREEPS).length > 0;
}

function isSafeOwnedDeliveryRoom(room: Room, dangerousRooms: Set<string>): boolean {
  return room.controller?.my === true && !dangerousRooms.has(room.name) && !roomHasHostiles(room);
}

function findSafeRouteLength(fromRoom: string, toRoom: string, dangerousRooms: Set<string>): number | null {
  if (fromRoom === toRoom) return 0;
  if (typeof Game.map.findRoute !== "function") return null;

  const route = Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: (roomName) => dangerousRooms.has(roomName) ? Infinity : 1,
  });
  return Array.isArray(route) ? route.length : null;
}

function canReachDeliveryTarget(
  creep: Creep,
  target: StructureTerminal | StructureStorage,
  routeLength: number,
): boolean {
  if (creep.ticksToLive === undefined) return true;
  const requiredTicks = routeLength === 0 && creep.room.name === target.pos.roomName
    ? creep.pos.getRangeTo(target.pos) + 5
    : routeLength * DELIVERY_TRAVEL_TICKS_PER_ROOM + DELIVERY_ROOM_BUFFER_TICKS;
  return creep.ticksToLive > requiredTicks;
}

function makeDeliveryCandidate(
  creep: Creep,
  room: Room,
  dangerousRooms: Set<string>,
): DeliveryCandidate | null {
  if (!isSafeOwnedDeliveryRoom(room, dangerousRooms)) return null;
  const target = getPreferredDeliveryStructure(room);
  if (!target) return null;
  const routeLength = findSafeRouteLength(creep.room.name, room.name, dangerousRooms);
  if (routeLength === null || !canReachDeliveryTarget(creep, target, routeLength)) return null;

  return {
    roomName: room.name,
    target,
    routeLength,
    headroom: getAvailablePowerHeadroom(target),
  };
}

function selectDeliveryCandidate(creep: Creep, task: PowerBankHaulerTask | null): DeliveryCandidate | null {
  const sourceRoomName = getSourceRoomName(creep);
  const dangerousRooms = new Set(getTaskDangerRooms(task));
  const sourceRoom = Game.rooms[sourceRoomName] ?? (creep.room.name === sourceRoomName ? creep.room : undefined);
  if (sourceRoom) {
    const sourceCandidate = makeDeliveryCandidate(creep, sourceRoom, dangerousRooms);
    if (sourceCandidate) return sourceCandidate;
  }

  const memory = creep.memory as PowerBankHaulerRuntimeMemory;
  const alternateCandidates = Object.values(Game.rooms)
    .filter((room) => room.name !== sourceRoomName)
    .map((room) => makeDeliveryCandidate(creep, room, dangerousRooms))
    .filter((candidate): candidate is DeliveryCandidate => candidate !== null)
    .sort((left, right) => {
      const rememberedLeft = left.roomName === memory.powerBankDeliveryRoom ? 1 : 0;
      const rememberedRight = right.roomName === memory.powerBankDeliveryRoom ? 1 : 0;
      if (rememberedLeft !== rememberedRight) return rememberedRight - rememberedLeft;
      if (left.routeLength !== right.routeLength) return left.routeLength - right.routeLength;
      if (left.headroom !== right.headroom) return right.headroom - left.headroom;
      return left.roomName.localeCompare(right.roomName);
    });

  return alternateCandidates[0] ?? null;
}

function classifyDeliveryBlocker(creep: Creep, task: PowerBankHaulerTask | null): DeliveryBlockerReason {
  const dangerousRooms = new Set(getTaskDangerRooms(task));
  let hasSafeHeadroom = false;
  let hasRouteWithoutEnoughTtl = false;

  for (const room of Object.values(Game.rooms)) {
    if (!isSafeOwnedDeliveryRoom(room, dangerousRooms)) continue;
    const target = getPreferredDeliveryStructure(room);
    if (!target) continue;
    hasSafeHeadroom = true;
    const routeLength = findSafeRouteLength(creep.room.name, room.name, dangerousRooms);
    if (routeLength !== null && !canReachDeliveryTarget(creep, target, routeLength)) {
      hasRouteWithoutEnoughTtl = true;
    }
  }

  if (!hasSafeHeadroom) return "capacity";
  return hasRouteWithoutEnoughTtl ? "ttl" : "route";
}

function clearDeliveryBlocker(creep: Creep, task: PowerBankHaulerTask | null): void {
  const memory = creep.memory as PowerBankHaulerRuntimeMemory;
  delete memory.capacityBlockedSince;
  delete memory.powerBankDeliveryRetryAt;
  if (task?.blocker?.startsWith("hauler_delivery_")) {
    delete task.blocker;
    delete task.nextAttemptAt;
  }
}

function reportDeliveryBlocker(
  creep: Creep,
  task: PowerBankHaulerTask | null,
  reason: DeliveryBlockerReason,
): void {
  const memory = creep.memory as PowerBankHaulerRuntimeMemory;
  memory.capacityBlockedSince ??= Game.time;
  memory.powerBankDeliveryRetryAt = Game.time + DELIVERY_RETRY_TICKS;

  if (!task) return;
  const waitedTicks = Game.time - memory.capacityBlockedSince;
  task.blocker = reason === "ttl"
    ? "hauler_delivery_ttl_insufficient"
    : reason === "route"
      ? "hauler_delivery_route_unavailable"
      : waitedTicks >= DELIVERY_CAPACITY_WAIT_TICKS
      ? "hauler_delivery_capacity_timeout"
      : "hauler_delivery_capacity";
  task.nextAttemptAt = memory.powerBankDeliveryRetryAt;
}

function recordDeliveredPower(task: PowerBankHaulerTask | null, amount: number): void {
  if (!task || amount <= 0) return;
  task.deliveredPower = (task.deliveredPower ?? 0) + amount;
  task.lastProgressAt = Game.time;
}

function deliverPower(creep: Creep, fallbackEncodedRoute?: string): boolean {
  const task = getTaskForCreep(creep);
  const power = getPowerUsed(creep);
  if (power <= 0) return true;

  const memory = creep.memory as PowerBankHaulerRuntimeMemory;
  if (memory.powerBankDeliveryRetryAt !== undefined && Game.time < memory.powerBankDeliveryRetryAt) {
    return false;
  }

  const candidate = selectDeliveryCandidate(creep, task);
  if (!candidate) {
    // Owned rooms are always visible in the live runtime. Preserve the legacy
    // journey to source when a test/old runtime snapshot has no source vision.
    const sourceRoom = getSourceRoomName(creep);
    if (!Game.rooms[sourceRoom] && creep.room.name !== sourceRoom) {
      moveToTargetRoom(creep, sourceRoom, getTaskEncodedRoute(task, fallbackEncodedRoute), {
        travelRange: 3,
        reusePath: 10,
        avoidRooms: getTaskDangerRooms(task),
      });
      return false;
    }

    reportDeliveryBlocker(creep, task, classifyDeliveryBlocker(creep, task));
    return false;
  }

  clearDeliveryBlocker(creep, task);
  memory.powerBankDeliveryRoom = candidate.roomName;

  if (creep.room.name !== candidate.roomName) {
    const sourceRoom = getSourceRoomName(creep);
    const encodedRoute = candidate.roomName === sourceRoom
      ? getTaskEncodedRoute(task, fallbackEncodedRoute)
      : undefined;
    moveToTargetRoom(creep, candidate.roomName, encodedRoute, {
      travelRange: 3,
      reusePath: 10,
      avoidRooms: getTaskDangerRooms(task),
    });
    return false;
  }

  const resource = RESOURCE_POWER as ResourceConstant;
  const transferable = Math.min(power, getAvailablePowerHeadroom(candidate.target));
  if (transferable <= 0) {
    reportDeliveryBlocker(creep, task, "capacity");
    return false;
  }
  const code = measureCreepIntent(() => executeTreasuryFencedTerminalCargo(candidate.target, () => creep.transfer(candidate.target, resource, transferable)));
  if (code === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, candidate.target);
  } else if (code === OK) {
    reserveDeliveryHeadroom(candidate.target, transferable);
    recordDeliveredPower(task, transferable);
    clearDeliveryBlocker(creep, task);
  }

  // Screeps actions are intents; wait for the next tick's store snapshot before
  // switching phase, otherwise terminal cleanup can submit/count the same cargo
  // twice in one mounted lifecycle call.
  return code === OK && getPowerUsed(creep) <= 0;
}

function retireIfEmpty(creep: Creep): boolean {
  if (getPowerUsed(creep) > 0) return false;
  creep.suicide();
  return true;
}

function isHaulingEmptyConfirmed(task: PowerBankHarvestTask): boolean {
  return task.haulingEmptySince !== undefined && Game.time - task.haulingEmptySince >= HAULING_EMPTY_CONFIRM_TICKS;
}

function salvagePower(creep: Creep, targetRoom?: string, encodedRouteRooms?: string): boolean {
  const resolvedTargetRoom = getTargetRoomName(creep, targetRoom);
  if (!resolvedTargetRoom) {
    return true;
  }

  if (!isPowerBankPatrolRoom(resolvedTargetRoom)) {
    return true;
  }

  if (getPowerUsed(creep) > 0) {
    return deliverPower(creep, encodedRouteRooms);
  }

  if (creep.room.name !== resolvedTargetRoom) {
    moveToTargetRoom(creep, resolvedTargetRoom, encodedRouteRooms, { travelRange: 3, reusePath: 10 });
    return false;
  }

  const dropped = findAnyDroppedPower(creep.room);
  if (dropped) {
    const code = measureCreepIntent(() => creep.pickup(dropped));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, dropped);
    }
    return getPowerFree(creep) <= 0;
  }

  const bank = findPowerBank(creep.room);
  if (bank) {
    moveToBankVicinity(creep, bank.pos);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Role lifecycle
// ---------------------------------------------------------------------------

export const powerBankHaulerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  prepare: (creep): boolean => {
    // Haulers are task-bound — skip generic energy assignments
    const task = getTaskForCreep(creep);
    if (!task) {
      return salvagePower(creep, targetRoom, encodedRouteRooms);
    }

    // If terminal status and holding power, go deliver
    if (isTerminalStatus(task.status) && getPowerUsed(creep) > 0) {
      return true;
    }

    if (isTerminalStatus(task.status)) {
      return retireIfEmpty(creep);
    }

    return true;
  },

  source: (creep): boolean => {
    const task = getTaskForCreep(creep);

    // No task — salvage dropped power for aborted/replaced squads.
    if (!task) {
      const done = salvagePower(creep, targetRoom, encodedRouteRooms);
      if (done) retireIfEmpty(creep);
      return done;
    }

    // Terminal status — deliver held power, then done
    if (isTerminalStatus(task.status)) {
      if (getPowerUsed(creep) > 0) {
        return deliverPower(creep, encodedRouteRooms);
      }
      return retireIfEmpty(creep);
    }

    // Travel to target room
    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, getTaskEncodedRoute(task, encodedRouteRooms), {
        travelRange: 3,
        reusePath: 10,
        avoidRooms: getTaskDangerRooms(task),
      });
      return false;
    }

    // In target room before pickup — stage near the bank at a safe range.
    if (task.status !== POWER_BANK_STATUS.HAULING) {
      const bankPos = task.bankPos;
      moveToBankVicinity(creep, { ...bankPos, roomName: task.targetRoom });
      return false;
    }

    // Hauling phase — bank destroyed, pick up dropped power
    if (task.status === POWER_BANK_STATUS.HAULING) {
      if (isHaulingEmptyConfirmed(task)) {
        return retireIfEmpty(creep);
      }

      // Already full — go deliver
      if (getPowerFree(creep) <= 0) {
        return true;
      }

      const dropped = findDroppedPower(creep.room, task.bankPos);
      if (!dropped) {
        // No more power on ground
        if (getPowerUsed(creep) > 0) {
          return true;
        }
        return false;
      }

      const code = measureCreepIntent(() => creep.pickup(dropped));
      if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, dropped);
      }

      // Done sourcing when full
      return getPowerFree(creep) <= 0;
    }

    return false;
  },

  target: (creep): boolean => {
    // Deliver held power to source room
    if (getPowerUsed(creep) > 0) {
      return deliverPower(creep, encodedRouteRooms);
    }

    // Nothing to deliver — check if we should go back for more
    const task = getTaskForCreep(creep);

    if (!task || isTerminalStatus(task.status)) {
      return retireIfEmpty(creep);
    }

    // Still in hauling phase — go back for more power
    if (task.status === POWER_BANK_STATUS.HAULING && targetRoom) {
      if (isHaulingEmptyConfirmed(task)) {
        return retireIfEmpty(creep);
      }

      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, getTaskEncodedRoute(task, encodedRouteRooms), {
          travelRange: 3,
          reusePath: 10,
          avoidRooms: getTaskDangerRooms(task),
        });
        return false;
      }
      // Switch back to source phase
      return false;
    }

    return true;
  },
});
