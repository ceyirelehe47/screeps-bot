import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { isWalkableStructure, parseEncodedRouteRooms } from "@/movement/common";
import { moveOffExit } from "@/movement/traffic";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;
const TARGET_ROOM_MOVE_OPTIONS = {
  plainCost: 2,
  swampCost: 8,
  reusePath: 0,
  maxRooms: 1,
  ignoreCreeps: false,
} as const;
const ROUTE_BREACH_RESUME_TICKS = 5;
const COUNTERSTRIKE_RANGE = 2;
const COUNTERSTRIKE_SWAP_GRACE_TICKS = 1;

function moveWarAttackerToTarget(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  range: 0 | 1 | 2 | 3,
  options: Parameters<typeof moveToTarget>[3],
): ScreepsReturnCode {
  const targetPos = "pos" in target ? target.pos : target;
  const wasOutOfRange = creep.pos.getRangeTo(targetPos) > range;
  const code = moveToTarget(creep, target, range, options);
  if (code === OK && wasOutOfRange) {
    creep.memory._warMoveIntentAt = Game.time;
  }
  return code;
}

function getHostileCreeps(room: Room): Creep[] {
  return room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) => creep.owner.username !== "Source Keeper",
  });
}

function getHostileStructures(room: Room): Structure[] {
  return room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });
}

export function findTarget(creep: Creep): Creep | Structure | null {
  const hostileCreeps = getHostileCreeps(creep.room);
  if (hostileCreeps.length > 0) {
    const dangerous = hostileCreeps
      .filter((hostile) => hostile.getActiveBodyparts(HEAL) > 0 || hostile.getActiveBodyparts(ATTACK) > 0)
      .sort((a, b) => creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos));
    if (dangerous.length > 0) {
      return dangerous[0];
    }

    return creep.pos.findClosestByRange(hostileCreeps);
  }

  const hostileStructures = getHostileStructures(creep.room);
  if (hostileStructures.length === 0) {
    return null;
  }

  const preferredOrder: StructureConstant[] = [
    STRUCTURE_TOWER,
    STRUCTURE_SPAWN,
    STRUCTURE_INVADER_CORE,
    STRUCTURE_RAMPART,
    STRUCTURE_WALL,
  ];
  for (const structureType of preferredOrder) {
    const candidates = hostileStructures.filter((structure) => structure.structureType === structureType);
    if (candidates.length > 0) {
      return creep.pos.findClosestByRange(candidates);
    }
  }

  return creep.pos.findClosestByRange(hostileStructures);
}

export function findWarObjectiveTarget(creep: Creep): Creep | Structure | null {
  const hostileCreeps = getHostileCreeps(creep.room);
  const hostileStructures = getHostileStructures(creep.room);
  const rampartPositions = new Set(
    hostileStructures
      .filter((structure) => structure.structureType === STRUCTURE_RAMPART)
      .map((structure) => `${structure.pos.x}:${structure.pos.y}`),
  );
  const isProtected = (target: Creep | Structure): boolean =>
    rampartPositions.has(`${target.pos.x}:${target.pos.y}`);
  const closest = <T extends Creep | Structure>(targets: T[]): T | null =>
    targets.length > 0 ? creep.pos.findClosestByRange(targets) : null;
  const coreOrder: StructureConstant[] = [
    STRUCTURE_SPAWN,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_INVADER_CORE,
  ];
  const utilityOrder: StructureConstant[] = [
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_NUKER,
    STRUCTURE_LAB,
    STRUCTURE_FACTORY,
    STRUCTURE_OBSERVER,
    STRUCTURE_LINK,
    STRUCTURE_EXTENSION,
    STRUCTURE_EXTRACTOR,
  ];

  for (const structureType of coreOrder) {
    const candidates = hostileStructures.filter((structure) => structure.structureType === structureType);
    const target = closest(candidates);
    if (target) return target;
  }

  const nonBarriers = hostileStructures.filter(
    (structure) => structure.structureType !== STRUCTURE_RAMPART && structure.structureType !== STRUCTURE_WALL,
  );
  for (const protectedState of [false, true]) {
    for (const structureType of utilityOrder) {
      const candidates = nonBarriers.filter(
        (structure) => structure.structureType === structureType && isProtected(structure) === protectedState,
      );
      const target = closest(candidates);
      if (target) return target;
    }

    const remaining = nonBarriers.filter(
      (structure) => !utilityOrder.includes(structure.structureType) && isProtected(structure) === protectedState,
    );
    const fallback = closest(remaining);
    if (fallback) return fallback;
  }

  const residualBarriers = hostileStructures
    .filter(isBreachTarget)
    .sort((left, right) => {
      const costDiff = getCombatBreachCost(left, hostileCreeps) - getCombatBreachCost(right, hostileCreeps);
      if (costDiff !== 0) return costDiff;
      if (left.hits !== right.hits) return left.hits - right.hits;
      return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
    });
  return residualBarriers[0] ?? null;
}

function isBreachTarget(structure: Structure): structure is StructureRampart | StructureWall {
  if (structure.structureType === STRUCTURE_WALL) return true;
  return structure.structureType === STRUCTURE_RAMPART;
}

function getTrackedWarBreachTarget(creep: Creep): StructureRampart | StructureWall | null {
  const targetId = creep.memory._warBreachTargetId;
  if (!targetId) return null;

  const target = Game.getObjectById(targetId);
  if (!target || target.pos.roomName !== creep.room.name || !isBreachTarget(target)) {
    delete creep.memory._warBreachTargetId;
    return null;
  }

  return target;
}

function getCombatBreachCost(structure: StructureRampart | StructureWall, hostileCreeps: Creep[]): number {
  if (structure.structureType === STRUCTURE_RAMPART) return 0xfe;
  if (
    hostileCreeps.some(
      (hostile) => hostile.getActiveBodyparts(RANGED_ATTACK) > 0 && hostile.pos.getRangeTo(structure.pos) <= 3,
    )
  ) {
    return 0xfe;
  }
  return Math.min(0xfe, 20 + Math.ceil(structure.hits / 50_000));
}

function findFirstBreachOnCombatPath(creep: Creep, target: Creep | Structure): StructureRampart | StructureWall | null {
  if (target.pos.roomName !== creep.room.name) return null;

  const structures = creep.room.find(FIND_STRUCTURES);
  const breaches = structures.filter(
    (structure): structure is StructureRampart | StructureWall =>
      isBreachTarget(structure) && !(structure.structureType === STRUCTURE_RAMPART && structure.my),
  );
  if (breaches.length === 0) return null;

  const coveringBreach = breaches.find(
    (breach) => breach.pos.x === target.pos.x && breach.pos.y === target.pos.y,
  );
  if (coveringBreach) return coveringBreach;

  const matrix = new PathFinder.CostMatrix();
  for (const structure of structures) {
    if (isBreachTarget(structure)) continue;
    if (structure.structureType === STRUCTURE_ROAD) {
      matrix.set(structure.pos.x, structure.pos.y, 1);
      continue;
    }
    if (!isWalkableStructure(structure)) {
      matrix.set(structure.pos.x, structure.pos.y, 0xff);
    }
  }

  const breachByPosition = new Map<string, StructureRampart | StructureWall>();
  const hostileCreeps = getHostileCreeps(creep.room);
  for (const breach of breaches) {
    matrix.set(breach.pos.x, breach.pos.y, getCombatBreachCost(breach, hostileCreeps));
    breachByPosition.set(`${breach.pos.x}:${breach.pos.y}`, breach);
  }
  for (const otherCreep of creep.room.find(FIND_MY_CREEPS)) {
    if (otherCreep.name !== creep.name) {
      matrix.set(otherCreep.pos.x, otherCreep.pos.y, 0xfe);
    }
  }
  for (const hostileCreep of hostileCreeps) {
    matrix.set(hostileCreep.pos.x, hostileCreep.pos.y, 0xfe);
  }

  const result = PathFinder.search(
    creep.pos,
    { pos: target.pos, range: 1 },
    {
      plainCost: 2,
      swampCost: 8,
      maxRooms: 1,
      roomCallback: (roomName) => (roomName === creep.room.name ? matrix : false),
    },
  );
  if (result.incomplete) return null;

  for (const step of result.path) {
    const breach = breachByPosition.get(`${step.x}:${step.y}`);
    if (breach) return breach;
  }
  return null;
}

function findAdjacentStructures(creep: Creep): Structure[] {
  if (typeof creep.pos.findInRange === "function") return creep.pos.findInRange(FIND_STRUCTURES, 1);
  if (typeof creep.room.find !== "function") return [];

  return creep.room.find(FIND_STRUCTURES).filter((structure) => creep.pos.getRangeTo(structure.pos) <= 1);
}

function findAdjacentHostiles(creep: Creep): Creep[] {
  if (typeof creep.pos.findInRange === "function") return creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1);
  if (typeof creep.room.find !== "function") return [];

  return creep.room.find(FIND_HOSTILE_CREEPS).filter((hostile) => creep.pos.getRangeTo(hostile.pos) <= 1);
}

function findWeakestAdjacentBreachTarget(creep: Creep, target?: Creep | Structure): StructureRampart | StructureWall | null {
  const blockers = findAdjacentStructures(creep).filter(isBreachTarget);
  if (blockers.length === 0) return null;

  return blockers.sort((left, right) => {
    if (left.hits !== right.hits) return left.hits - right.hits;
    if (target) {
      const leftRange = left.pos.getRangeTo(target.pos);
      const rightRange = right.pos.getRangeTo(target.pos);
      if (leftRange !== rightRange) return leftRange - rightRange;
    }

    return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
  })[0];
}

function findWeakestAdjacentHostileStructure(creep: Creep, target?: Creep | Structure): Structure | null {
  const hostileIds = new Set(getHostileStructures(creep.room).map((structure) => structure.id));
  const candidates = findAdjacentStructures(creep).filter((structure) => hostileIds.has(structure.id));
  if (candidates.length === 0) return null;

  return candidates.sort((left, right) => {
    if (left.hits !== right.hits) return left.hits - right.hits;
    if (target) {
      const leftRange = left.pos.getRangeTo(target.pos);
      const rightRange = right.pos.getRangeTo(target.pos);
      if (leftRange !== rightRange) return leftRange - rightRange;
    }
    return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
  })[0];
}

function attackAdjacentBreachTarget(creep: Creep, target: Creep | Structure): boolean {
  const blocker =
    findWeakestAdjacentBreachTarget(creep, target) ||
    findWeakestAdjacentHostileStructure(creep, target);
  if (!blocker) return false;

  measureCreepIntent(() => creep.attack(blocker));
  return true;
}

function isDangerousHostile(creep: Creep): boolean {
  return (
    creep.getActiveBodyparts(HEAL) > 0 ||
    creep.getActiveBodyparts(ATTACK) > 0 ||
    creep.getActiveBodyparts(RANGED_ATTACK) > 0
  );
}

function getHostileRampartPositions(room: Room): Set<string> {
  return new Set(
    getHostileStructures(room)
      .filter((structure) => structure.structureType === STRUCTURE_RAMPART)
      .map((rampart) => `${rampart.pos.x}:${rampart.pos.y}`),
  );
}

function isHostileProtectedByRampart(creep: Creep, hostile: Creep): boolean {
  return getHostileRampartPositions(creep.room).has(`${hostile.pos.x}:${hostile.pos.y}`);
}

function clearExpiredCounterstrikeSuppression(creep: Creep): void {
  const suppressedIds = creep.memory._warCounterstrikeSuppressedTargetIds;
  if (!suppressedIds?.length) return;

  const activeIds = suppressedIds.filter((suppressedId) => {
    const target = Game.getObjectById(suppressedId);
    return !!(
      target &&
      target.pos.roomName === creep.room.name &&
      creep.pos.getRangeTo(target.pos) <= COUNTERSTRIKE_RANGE &&
      !isHostileProtectedByRampart(creep, target)
    );
  });
  if (activeIds.length > 0) {
    creep.memory._warCounterstrikeSuppressedTargetIds = activeIds;
  } else {
    delete creep.memory._warCounterstrikeSuppressedTargetIds;
  }
}

interface CounterstrikeApproach {
  target: Creep;
  x: number;
  y: number;
  healerCoordinated: boolean;
  healerSwap: boolean;
}

interface CounterstrikeRoomState {
  terrain: RoomTerrain;
  occupants: Map<string, Creep | PowerCreep>;
  blockedStructures: Set<string>;
  naturalObstacles: Set<string>;
}

function getCounterstrikeRoomState(room: Room): CounterstrikeRoomState {
  return {
    terrain: room.getTerrain(),
    occupants: new Map(
      [...room.find(FIND_CREEPS), ...room.find(FIND_POWER_CREEPS)]
        .map((occupant) => [`${occupant.pos.x}:${occupant.pos.y}`, occupant]),
    ),
    blockedStructures: new Set(
      room
        .find(FIND_STRUCTURES)
        .filter((structure) => !isWalkableStructure(structure))
        .map((structure) => `${structure.pos.x}:${structure.pos.y}`),
    ),
    naturalObstacles: new Set(
      [
        ...room.find(FIND_SOURCES),
        ...room.find(FIND_MINERALS),
        ...room.find(FIND_DEPOSITS),
      ].map((obstacle) => `${obstacle.pos.x}:${obstacle.pos.y}`),
    ),
  };
}

function isCounterstrikeApproachWalkable(
  roomState: CounterstrikeRoomState,
  x: number,
  y: number,
  allowedOccupantName?: string,
): boolean {
  const key = `${x}:${y}`;
  if (roomState.terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
  if (roomState.blockedStructures.has(key) || roomState.naturalObstacles.has(key)) return false;
  const occupant = roomState.occupants.get(key);
  return !occupant || occupant.name === allowedOccupantName;
}

function getCounterstrikeThreat(hostile: Creep): number {
  return (
    hostile.getActiveBodyparts(HEAL) * 3 +
    hostile.getActiveBodyparts(RANGED_ATTACK) * 2 +
    hostile.getActiveBodyparts(ATTACK)
  );
}

function findCounterstrikeApproach(creep: Creep, coordinatedHealer?: Creep): CounterstrikeApproach | null {
  clearExpiredCounterstrikeSuppression(creep);
  const suppressedIds = new Set(creep.memory._warCounterstrikeSuppressedTargetIds ?? []);
  const protectedPositions = getHostileRampartPositions(creep.room);
  const candidates = getHostileCreeps(creep.room)
    .filter(
      (hostile) =>
        !suppressedIds.has(hostile.id) &&
        isDangerousHostile(hostile) &&
        creep.pos.getRangeTo(hostile.pos) === COUNTERSTRIKE_RANGE &&
        !protectedPositions.has(`${hostile.pos.x}:${hostile.pos.y}`),
    )
    .sort((left, right) => {
      const rangeDiff = creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
      if (rangeDiff !== 0) return rangeDiff;
      if (left.hits !== right.hits) return left.hits - right.hits;
      return getCounterstrikeThreat(right) - getCounterstrikeThreat(left);
    });
  if (candidates.length === 0) return null;

  const healer = coordinatedHealer?.memory._warPartnerConfigName === creep.memory.configName
    ? coordinatedHealer
    : findPairedWarHealer(creep);
  const healerCanCoordinate = !!(
    healer &&
    !creep.memory._warDetached &&
    !healer.memory._warDetached &&
    healer.room.name === creep.room.name &&
    creep.pos.isNearTo(healer.pos)
  );
  const roomState = getCounterstrikeRoomState(creep.room);

  for (const target of candidates) {
    const approaches: CounterstrikeApproach[] = [];
    for (let x = Math.max(1, target.pos.x - 1); x <= Math.min(48, target.pos.x + 1); x += 1) {
      for (let y = Math.max(1, target.pos.y - 1); y <= Math.min(48, target.pos.y + 1); y += 1) {
        if (x === target.pos.x && y === target.pos.y) continue;
        if (Math.max(Math.abs(x - creep.pos.x), Math.abs(y - creep.pos.y)) !== 1) continue;
        const occupant = roomState.occupants.get(`${x}:${y}`);
        const healerSwap = !!occupant && healerCanCoordinate && occupant.name === healer?.name;
        if (!isCounterstrikeApproachWalkable(roomState, x, y, healerSwap ? healer?.name : undefined)) continue;
        if (
          !occupant &&
          healerCanCoordinate &&
          healer &&
          Math.max(Math.abs(x - healer.pos.x), Math.abs(y - healer.pos.y)) > 1
        ) {
          continue;
        }
        approaches.push({ target, x, y, healerCoordinated: healerCanCoordinate, healerSwap });
      }
    }
    approaches.sort((left, right) => Number(left.healerSwap) - Number(right.healerSwap));
    if (approaches.length > 0) return approaches[0];
  }

  return null;
}

function getDirectionToCoordinates(creep: Creep, x: number, y: number): DirectionConstant | null {
  return creep.pos.getDirectionTo({ x, y, roomName: creep.room.name } as RoomPosition);
}

function hasExposedAdjacentHostile(creep: Creep): boolean {
  const protectedPositions = getHostileRampartPositions(creep.room);
  return getHostileCreeps(creep.room).some(
    (hostile) =>
      creep.pos.isNearTo(hostile.pos) &&
      !protectedPositions.has(`${hostile.pos.x}:${hostile.pos.y}`),
  );
}

function isCounterstrikeCoordinationValid(
  creep: Creep,
  healer: Creep,
  target: Creep,
  state: NonNullable<CreepMemory["_warCounterstrike"]>,
): boolean {
  if (!state.healerCoordinated || creep.memory._warDetached || healer.memory._warDetached) return false;
  if (creep.pos.x !== state.originX || creep.pos.y !== state.originY) return false;
  if (healer.room.name !== creep.room.name || !creep.pos.isNearTo(healer.pos)) return false;
  if (target.pos.roomName !== creep.room.name || !isDangerousHostile(target)) return false;
  if (target.pos.x !== state.targetX || target.pos.y !== state.targetY) return false;
  if (creep.pos.getRangeTo(target.pos) !== COUNTERSTRIKE_RANGE) return false;
  if (Math.max(Math.abs(state.approachX - target.pos.x), Math.abs(state.approachY - target.pos.y)) > 1) return false;
  if (isHostileProtectedByRampart(creep, target) || hasExposedAdjacentHostile(creep)) return false;

  if (state.healerSwap) {
    if (healer.pos.x !== state.approachX || healer.pos.y !== state.approachY) return false;
  } else if (Math.max(Math.abs(state.approachX - healer.pos.x), Math.abs(state.approachY - healer.pos.y)) > 1) {
    return false;
  }

  const roomState = getCounterstrikeRoomState(creep.room);
  return isCounterstrikeApproachWalkable(
    roomState,
    state.approachX,
    state.approachY,
    state.healerSwap ? healer.name : undefined,
  );
}

export function isWarCounterstrikeCoordinationValid(
  attacker: Creep,
  healer: Creep,
  state: NonNullable<CreepMemory["_warCounterstrike"]>,
): boolean {
  const target = Game.getObjectById(state.targetId);
  return !!target && isCounterstrikeCoordinationValid(attacker, healer, target, state);
}

export function shouldWarHealerHoldForCounterstrike(attacker: Creep, healer: Creep, targetRoom: string): boolean {
  if (attacker.room.name !== targetRoom || healer.room.name !== targetRoom) return false;
  if (attacker.memory._warDetached || healer.memory._warDetached || !attacker.pos.isNearTo(healer.pos)) return false;
  if (attacker.memory._warCounterstrike || hasExposedAdjacentHostile(attacker)) return false;
  if (healer.memory._warPartnerConfigName !== attacker.memory.configName) return false;
  return findCounterstrikeApproach(attacker, healer)?.healerCoordinated === true;
}

function isCoordinatedCounterstrikeReady(
  creep: Creep,
  target: Creep,
  state: NonNullable<CreepMemory["_warCounterstrike"]>,
): boolean {
  if (!state.healerCoordinated || Game.time !== state.createdAt + 2) return false;
  if (state.healerReadyAt !== state.createdAt + COUNTERSTRIKE_SWAP_GRACE_TICKS) return false;
  const healer = findPairedWarHealer(creep);
  return !!healer && isCounterstrikeCoordinationValid(creep, healer, target, state);
}

function runCounterstrikeApproach(creep: Creep): boolean {
  clearExpiredCounterstrikeSuppression(creep);
  const state = creep.memory._warCounterstrike;
  if (state) {
    const target = Game.getObjectById(state.targetId);
    if (
      !target ||
      target.pos.roomName !== creep.room.name ||
      !isDangerousHostile(target) ||
      isHostileProtectedByRampart(creep, target)
    ) {
      delete creep.memory._warCounterstrike;
      return false;
    }
    if (creep.pos.isNearTo(target.pos)) return false;
    if (state.healerCoordinated && Game.time <= state.createdAt + 1) return true;
    if (isCoordinatedCounterstrikeReady(creep, target, state)) {
      const direction = getDirectionToCoordinates(creep, state.approachX, state.approachY);
      if (direction) {
        clearMovementState(creep);
        measureCreepIntent(() => creep.move(direction));
      }
      return true;
    }
    delete creep.memory._warCounterstrike;
    return false;
  }

  const approach = findCounterstrikeApproach(creep);
  if (!approach) return false;

  creep.memory._warCounterstrike = {
    targetId: approach.target.id,
    targetX: approach.target.pos.x,
    targetY: approach.target.pos.y,
    createdAt: Game.time,
    originX: creep.pos.x,
    originY: creep.pos.y,
    approachX: approach.x,
    approachY: approach.y,
    healerCoordinated: approach.healerCoordinated || undefined,
    healerSwap: approach.healerSwap || undefined,
  };
  const suppressedIds = creep.memory._warCounterstrikeSuppressedTargetIds ?? [];
  if (!suppressedIds.includes(approach.target.id)) {
    creep.memory._warCounterstrikeSuppressedTargetIds = [...suppressedIds, approach.target.id];
  }
  if (approach.healerCoordinated) return true;

  const direction = getDirectionToCoordinates(creep, approach.x, approach.y);
  if (direction) {
    clearMovementState(creep);
    measureCreepIntent(() => creep.move(direction));
  }
  return true;
}

function attackAdjacentHostileOnRoute(creep: Creep): boolean {
  const protectedPositions = new Set(
    findAdjacentStructures(creep)
      .filter(
        (structure): structure is StructureRampart =>
          structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my,
      )
      .map((rampart) => `${rampart.pos.x}:${rampart.pos.y}`),
  );
  const adjacent = findAdjacentHostiles(creep).filter(
    (hostile) =>
      hostile.owner?.username &&
      hostile.owner.username !== "Source Keeper" &&
      !protectedPositions.has(`${hostile.pos.x}:${hostile.pos.y}`),
  );
  if (adjacent.length === 0) return false;

  return adjacent
    .sort((left, right) => {
      const leftDangerous = isDangerousHostile(left);
      const rightDangerous = isDangerousHostile(right);
      if (leftDangerous !== rightDangerous) return leftDangerous ? -1 : 1;
      if (left.hits !== right.hits) return left.hits - right.hits;
      return creep.pos.getRangeTo(left.pos) - creep.pos.getRangeTo(right.pos);
    })
    .some((target) => measureCreepIntent(() => creep.attack(target)) === OK);
}

function attackWeakestAdjacentBreachTarget(creep: Creep): boolean {
  const blocker = findWeakestAdjacentBreachTarget(creep);
  if (!blocker) return false;

  measureCreepIntent(() => creep.attack(blocker));
  return true;
}

function attackAdjacentWhileHoldingFormation(creep: Creep, includeBreach: boolean): void {
  if (attackAdjacentHostileOnRoute(creep)) return;
  if (includeBreach) attackWeakestAdjacentBreachTarget(creep);
}

function attackRouteBreachWhileTraveling(creep: Creep): boolean {
  if (attackAdjacentHostileOnRoute(creep)) return false;
  if (creep.room.controller?.my) {
    delete creep.memory._warBreachTargetId;
    delete creep.memory._warBreachResumeUntil;
    return false;
  }

  const trackedId = creep.memory._warBreachTargetId;
  if (trackedId) {
    const tracked = Game.getObjectById(trackedId);
    if (!tracked || tracked.pos.roomName !== creep.room.name) {
      delete creep.memory._warBreachTargetId;
      creep.memory._warBreachResumeUntil = Game.time + ROUTE_BREACH_RESUME_TICKS;
      return false;
    }

    const attackCode = measureCreepIntent(() => creep.attack(tracked));
    if (attackCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, tracked, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
    }
    return true;
  }

  const resumeUntil = creep.memory._warBreachResumeUntil;
  if (resumeUntil !== undefined) {
    if (Game.time < resumeUntil) return false;
    delete creep.memory._warBreachResumeUntil;
  }

  const blocker = findWeakestAdjacentBreachTarget(creep);
  if (!blocker) return false;

  creep.memory._warBreachTargetId = blocker.id;
  measureCreepIntent(() => creep.attack(blocker));
  return true;
}

function travelToWarTargetRoom(creep: Creep, targetRoom: string, encodedRouteRooms?: string): void {
  const moveCode = moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
  if (moveCode === ERR_NO_PATH) {
    attackRouteBreachWhileTraveling(creep);
    return;
  }

  // A wall beside the squad is not a reason to stop a valid patrol route.
  delete creep.memory._warBreachTargetId;
  delete creep.memory._warBreachResumeUntil;
  attackAdjacentHostileOnRoute(creep);
}

function findPairedWarHealer(creep: Creep): Creep | null {
  const healerConfigName = creep.memory._warPartnerConfigName;
  if (!healerConfigName) return null;

  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "healer") continue;
    if (candidate.memory.configName !== healerConfigName) continue;
    return candidate;
  }

  return null;
}

function getTargetRoomMoveOptions(creep: Creep) {
  const healer = findPairedWarHealer(creep);
  if (!healer || healer.room.name !== creep.room.name) {
    return TARGET_ROOM_MOVE_OPTIONS;
  }

  return {
    ...TARGET_ROOM_MOVE_OPTIONS,
    costCallback: (roomName: string, matrix: CostMatrix): CostMatrix => {
      if (roomName === healer.room.name) {
        matrix.set(healer.pos.x, healer.pos.y, 1);
      }
      return matrix;
    },
  };
}

function expectsWarHealer(creep: Creep): boolean {
  return creep.memory._warDetached !== true
    && typeof creep.memory._warPartnerConfigName === "string"
    && creep.memory._warPartnerConfigName.length > 0;
}

function synchronizeWarPartnerConfigName(creep: Creep, partnerConfigName?: string): void {
  if (partnerConfigName && creep.memory._warDetached !== true) {
    creep.memory._warPartnerConfigName = partnerConfigName;
    return;
  }
  delete creep.memory._warPartnerConfigName;
}

function isOnExitDirection(pos: RoomPosition, direction: DirectionConstant): boolean {
  if (direction === TOP) return pos.y <= 0;
  if (direction === RIGHT) return pos.x >= 49;
  if (direction === BOTTOM) return pos.y >= 49;
  if (direction === LEFT) return pos.x <= 0;
  return false;
}

function moveOffExitIntoRoom(creep: Creep): boolean {
  if (creep.pos.x > 0 && creep.pos.x < 49 && creep.pos.y > 0 && creep.pos.y < 49) return false;
  moveOffExit(creep);
  return true;
}

function moveToPartnerRoom(creep: Creep, roomName: string): void {
  const exitDirection = creep.room.findExitTo?.(roomName);
  if (
    typeof exitDirection === "number" &&
    exitDirection >= TOP &&
    exitDirection <= LEFT &&
    isOnExitDirection(creep.pos, exitDirection as DirectionConstant)
  ) {
    measureCreepIntent(() => creep.move(exitDirection as DirectionConstant));
    return;
  }

  moveToTargetRoom(creep, roomName, undefined, TRAVEL_OPTIONS);
}

function isPoisedToCrossInto(creep: Creep, targetRoom: string): boolean {
  if (creep.room.name === targetRoom) return false;

  const exitDirection = creep.room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return false;
  return isOnExitDirection(creep.pos, exitDirection as DirectionConstant);
}

function isReadyToCrossWithHealer(creep: Creep, healer: Creep, targetRoom: string): boolean {
  const exitDirection = creep.room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return true;
  if (!isOnExitDirection(creep.pos, exitDirection as DirectionConstant)) return true;

  return isOnExitDirection(healer.pos, exitDirection as DirectionConstant);
}

function moveAcrossExitToTargetRoom(creep: Creep, targetRoom: string): boolean {
  const exitDirection = creep.room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return false;
  if (!isOnExitDirection(creep.pos, exitDirection as DirectionConstant)) return false;

  measureCreepIntent(() => creep.move(exitDirection as DirectionConstant));
  return true;
}

function isNextWarRouteRoom(
  creep: Creep,
  partnerRoom: string,
  targetRoom: string,
  encodedRouteRooms?: string,
): boolean {
  const sourceRoom = creep.memory.configName?.split(":")[0];
  const orderedRooms = [sourceRoom, ...parseEncodedRouteRooms(encodedRouteRooms), targetRoom].filter(
    (roomName, index, rooms): roomName is string => !!roomName && rooms.indexOf(roomName) === index,
  );
  const currentIndex = orderedRooms.indexOf(creep.room.name);
  return currentIndex >= 0 && orderedRooms[currentIndex + 1] === partnerRoom;
}

function waitForWarHealerFormation(
  creep: Creep,
  targetRoom: string,
  encodedRouteRooms?: string,
): boolean {
  if (!expectsWarHealer(creep)) return false;

  const healer = findPairedWarHealer(creep);
  if (!healer) return true;

  if (creep.room.name === targetRoom) {
    if (healer.room.name !== creep.room.name) {
      if (isPoisedToCrossInto(healer, targetRoom)) {
        moveOffExitIntoRoom(creep);
        return true;
      }
      moveToPartnerRoom(creep, healer.room.name);
      return true;
    }

    return !creep.pos.isNearTo(healer.pos);
  }

  if (healer.room.name !== creep.room.name) {
    if (isNextWarRouteRoom(creep, healer.room.name, targetRoom, encodedRouteRooms)) {
      moveToPartnerRoom(creep, healer.room.name);
      return true;
    }
    if (healer.room.name === targetRoom && moveAcrossExitToTargetRoom(creep, targetRoom)) return true;
    moveOffExitIntoRoom(creep);
    return true;
  }

  if (!creep.pos.isNearTo(healer.pos)) {
    moveOffExitIntoRoom(creep);
    return true;
  }
  return !isReadyToCrossWithHealer(creep, healer, targetRoom);
}

export const meleeAttackerRole: RoleFactory = (
  targetRoom?: string,
  encodedRouteRooms?: string,
  boostTaskId?: string,
  encodedBoostCompounds?: string,
  partnerConfigName?: string,
) => ({
  prepare: (creep): boolean => {
    synchronizeWarPartnerConfigName(creep, partnerConfigName);
    return prepareCombatBoost(creep, boostTaskId, encodedBoostCompounds);
  },
  source: (creep): boolean => {
    synchronizeWarPartnerConfigName(creep, partnerConfigName);
    if (targetRoom && waitForWarHealerFormation(creep, targetRoom, encodedRouteRooms)) {
      attackAdjacentWhileHoldingFormation(creep, creep.room.name === targetRoom);
      return false;
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      travelToWarTargetRoom(creep, targetRoom, encodedRouteRooms);
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    synchronizeWarPartnerConfigName(creep, partnerConfigName);
    if (targetRoom && waitForWarHealerFormation(creep, targetRoom, encodedRouteRooms)) {
      attackAdjacentWhileHoldingFormation(creep, creep.room.name === targetRoom);
      return false;
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      travelToWarTargetRoom(creep, targetRoom, encodedRouteRooms);
      return false;
    }

    if (targetRoom && attackAdjacentHostileOnRoute(creep)) {
      delete creep.memory._warCounterstrike;
      return false;
    }

    if (targetRoom && creep.room.name === targetRoom && runCounterstrikeApproach(creep)) return false;

    const targetMoveOptions = targetRoom ? getTargetRoomMoveOptions(creep) : TARGET_ROOM_MOVE_OPTIONS;
    const target = measureCreepDecision(() => (targetRoom ? findWarObjectiveTarget(creep) : findTarget(creep)));
    if (!target) {
      delete creep.memory._warBreachTargetId;
      if (targetRoom) {
        moveWarAttackerToTarget(creep, new RoomPosition(25, 25, targetRoom), 3, targetMoveOptions);
      }
      return false;
    }

    if (targetRoom) {
      const plannedBreach =
        getTrackedWarBreachTarget(creep) ||
        measureCreepDecision(() => findFirstBreachOnCombatPath(creep, target));
      if (plannedBreach) {
        creep.memory._warBreachTargetId = plannedBreach.id;
        const breachCode = measureCreepIntent(() => creep.attack(plannedBreach));
        if (breachCode === ERR_NOT_IN_RANGE) {
          moveWarAttackerToTarget(creep, plannedBreach, 1, targetMoveOptions);
        }
        return false;
      }
      delete creep.memory._warBreachTargetId;
    }

    const code = measureCreepIntent(() => creep.attack(target));
    if (code === ERR_NOT_IN_RANGE) {
      const moveCode = moveWarAttackerToTarget(creep, target, 1, targetMoveOptions);
      if (moveCode === ERR_NO_PATH && creep.room.name === target.pos.roomName) {
        attackAdjacentBreachTarget(creep, target);
      }
      return false;
    }

    if (code === ERR_INVALID_TARGET && (target as Creep | Structure).id) {
      const fallback = creep.pos.findClosestByRange(getHostileStructures(creep.room));
      if (fallback) {
        const fallbackCode = measureCreepIntent(() => creep.attack(fallback));
        if (fallbackCode === ERR_NOT_IN_RANGE) {
          moveWarAttackerToTarget(creep, fallback, 1, targetMoveOptions);
        }
      }
    }

    return false;
  },
});
