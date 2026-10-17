import { warGeometry } from "@/roles/warGeometry";
import { getRefillableHostileTowers } from "@/runtime/combatTowerThreat";
import { warPartner } from "@/roles/warPartner";
import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { isWalkableConstructionSite, isWalkableStructure, parseEncodedRouteRooms } from "@/movement/common";
import { cancelMoveIntent, getMoveIntentReceipt, hasMoveDestinationConflict, issueMove, moveOffExit } from "@/movement/traffic";
import { getCreepMovementState } from "@/movement/creepState";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { constrainTowerDrainBreachPath, moveTowerDrainBorderAttack, runTowerDrainPair } from "@/roles/towerDrainPair";
import { measureCreepDecision, measureCreepIntent, measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";
import { canUseNeutralWallsAsWarObjectives, getCreepRebuildIgnoredStructures, isRebuildStructureRelevant } from "@/runtime/warRebuildScope";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8, routePurpose: "combat" } as const;
const TARGET_ROOM_MOVE_OPTIONS = {
  plainCost: 2,
  swampCost: 8,
  reusePath: 0,
  maxRooms: 1,
  ignoreCreeps: false,
} as const;
const ROUTE_BREACH_RESUME_TICKS = 5;
const COMBAT_APPROACH_MAX_OPS = 8000;
const COUNTERSTRIKE_RANGE = 2;
const COUNTERSTRIKE_SWAP_GRACE_TICKS = 1;

function moveWarAttackerToTarget(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  range: 0 | 1 | 2 | 3,
  options: Parameters<typeof moveToTarget>[3],
  towerDrain = false,
): ScreepsReturnCode {
  const targetPos = "pos" in target ? target.pos : target;
  const wasOutOfRange = creep.pos.getRangeTo(targetPos) > range;
  const previousIntent = getMoveIntentReceipt(creep);
  const drainMove = towerDrain ? moveTowerDrainBorderAttack(creep, targetPos, range) : undefined;
  const code = drainMove === undefined ? moveToTarget(creep, target, range, options) : drainMove;
  if (code === OK && wasOutOfRange) {
    creep.memory._warMoveIntentAt = Game.time;
    const intent = getMoveIntentReceipt(creep);
    const healer = findPairedWarHealer(creep);
    // OK 也可能是既有让位或原地等待；只协调本次新提交的移动。
    if (intent && intent !== previousIntent && healer && !followMovingWarAttacker(healer, creep)) {
      if (cancelMoveIntent(creep, intent)) {
        delete creep.memory._warMoveIntentAt;
        return ERR_BUSY;
      }
    }
  }
  return code;
}

function getHostileCreeps(room: Room): Creep[] {
  return room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) => creep.owner.username !== "Source Keeper",
  });
}

function getHostileStructures(room: Room, includeNeutralWalls = false, creep?: Creep): Structure[] {
  const hostile: Structure<StructureConstant>[] = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });
  const ignored = creep ? getCreepRebuildIgnoredStructures(creep) : undefined;
  if (!includeNeutralWalls || (creep && !canUseNeutralWallsAsWarObjectives(creep))) return hostile.filter(s => isRebuildStructureRelevant(s, ignored));
  const ids = new Set(hostile.map((structure) => structure.id));
  return [...hostile, ...room.find(FIND_STRUCTURES).filter((structure) => structure.structureType === STRUCTURE_WALL && !ids.has(structure.id))]
    .filter(s => isRebuildStructureRelevant(s, ignored));
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

  const hostileStructures = getHostileStructures(creep.room, false, creep);
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

export function findWarObjectiveTarget(creep: Creep, includeNeutralWalls = false): Creep | Structure | null {
  const hostileCreeps = getHostileCreeps(creep.room);
  const hostileStructures = getHostileStructures(creep.room, includeNeutralWalls, creep);
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
  if (residualBarriers.length > 0) return residualBarriers[0];
  // 设施和屏障清完后继续清理敌兵，避免战争任务仍在 clearing 而小队只驻守中心。
  return closest(hostileCreeps.filter(isDangerousHostile)) ?? closest(hostileCreeps);
}

function isBreachTarget(structure: Structure): structure is StructureRampart | StructureWall {
  if (structure.structureType === STRUCTURE_WALL) return true;
  return structure.structureType === STRUCTURE_RAMPART;
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

function chooseWarApproach(creep: Creep, includeNeutralWalls: boolean) {
  return measureSampledCpuPhase("war.chooseWarApproach", () => measureCreepDecision(() => computeWarApproach(creep, includeNeutralWalls)));
}
const candidateCursors = new Map<string, { cursor: number; targetId?: string }>();
const approachFrames = new WeakMap<Game, { tick: number; matrices: Map<string, CostMatrix> }>();
let lastApproachTick = -1;
const approachResults = new Map<string, { tick: number; signature: string; x: number; y: number; open: boolean; breach?: string; path?: RoomPosition[] }>();
function approachTickMemo() {
  let frame = approachFrames.get(Game);
  if (!frame || frame.tick !== Game.time) {
    if (Game.time <= lastApproachTick || Game.time - lastApproachTick > 5) { approachResults.clear(); candidateCursors.clear(); }
    frame = { tick: Game.time, matrices: new Map() }; approachFrames.set(Game, frame);
  }
  lastApproachTick = Game.time; return frame;
}

function findCombatApproach(creep: Creep, target: Creep | Structure, towerDrain = false): WarCombatApproach {
  approachTickMemo();
  const signature = `${warGeometry(creep.room).signature}:${target.pos.x}:${target.pos.y}:${getCreepRebuildIgnoredStructures(creep)?.join("|")}`;
  const key = `${creep.name}:${target.id}:${towerDrain}`;
  const old = approachResults.get(key);
  const breach = old?.breach ? Game.getObjectById(old.breach as Id<StructureWall>) : null;
  // 只复用目标/屏障选择；临近攻击格、目标死亡、几何变化和跨区跳位均重新决策。
  const cursor = old?.path?.findIndex(step => step.x === creep.pos.x && step.y === creep.pos.y) ?? -1;
  const remaining = old?.path && (cursor >= 0 ? old.path.slice(cursor + 1) : old.x === creep.pos.x && old.y === creep.pos.y ? old.path : undefined);
  const next = remaining?.[0];
  if (old && Game.time - old.tick < 4 && old.signature === signature && creep.pos.getRangeTo(target.pos) > 1
    && Math.max(Math.abs(creep.pos.x - old.x), Math.abs(creep.pos.y - old.y)) <= 4
    && (!old.open || !old.path || next && isWarFollowTileOpen(creep, next))
    && (!old.breach || breach && creep.pos.getRangeTo(breach.pos) > 1)) return { open: old.open, breach, path: remaining };
  const result = searchCombatApproach(creep, target, towerDrain);
  if (approachResults.size >= 128) approachResults.delete(approachResults.keys().next().value!);
  approachResults.set(key, { tick: Game.time, signature, x: creep.pos.x, y: creep.pos.y, open: result.open, breach: result.breach?.id, path: result.path });
  return result;
}
interface WarCombatApproach { open: boolean; breach: StructureRampart | StructureWall | null; path?: RoomPosition[] }

/** 先证明开放路线；不把拆墙耗时折成少量移动代价，也不让旧破墙目标锁住现成通道。 */
function searchCombatApproach(creep: Creep, target: Creep | Structure, towerDrain = false): WarCombatApproach {
  if (target.pos.roomName !== creep.room.name) return { open: false, breach: null };
  const geometry = warGeometry(creep.room);
  const structures = geometry.structures;
  const barriers = structures.filter((s): s is StructureRampart | StructureWall => isBreachTarget(s) && !(s.structureType === STRUCTURE_RAMPART && s.my));
  const covering = barriers.find((s) => s.structureType === STRUCTURE_RAMPART && s.pos.x === target.pos.x && s.pos.y === target.pos.y);
  if (covering) return { open: false, breach: covering };
  if (creep.pos.getRangeTo(target.pos) <= 1) return { open: true, breach: null };
  if (barriers.length === 0 && !towerDrain) return { open: true, breach: null };
  const naturals = geometry.naturals;
  const geometryMatrix = (): CostMatrix => {
    const result = new PathFinder.CostMatrix();
    for (const structure of structures) if (structure.structureType === STRUCTURE_ROAD) result.set(structure.pos.x, structure.pos.y, 1);
    for (const structure of structures) if (!isWalkableStructure(structure)) result.set(structure.pos.x, structure.pos.y, 0xff);
    for (const natural of naturals) result.set(natural.pos.x, natural.pos.y, 0xff);
    return result;
  };
  const memo = approachTickMemo();
  const geometryKey = `${creep.room.name}:${geometry.signature}`;
  let base = memo.matrices.get(geometryKey);
  if (!base) { base = geometryMatrix(); memo.matrices.set(geometryKey, base); }
  const matrix = base.clone();
  const healer = findPairedWarHealer(creep);
  for (const site of creep.room.find(FIND_CONSTRUCTION_SITES)) {
    if (site.my && !isWalkableConstructionSite(site)) matrix.set(site.pos.x, site.pos.y, 0xff);
  }
  if (creep.room.controller) matrix.set(creep.room.controller.pos.x, creep.room.controller.pos.y, 0xff);
  for (const other of [...creep.room.find(FIND_MY_CREEPS), ...getHostileCreeps(creep.room), ...creep.room.find(FIND_HOSTILE_POWER_CREEPS),
    ...Object.values(Game.powerCreeps || {}).filter(unit => unit.ticksToLive != null && unit.room?.name === creep.room.name)]) {
    if (other.name !== creep.name && other.name !== healer?.name) matrix.set(other.pos.x, other.pos.y, 0xfe);
  }
  if (towerDrain) constrainTowerDrainBreachPath(creep, creep.room.name, matrix);
  const search = (costs: CostMatrix) => PathFinder.search(creep.pos, { pos: target.pos, range: 1 }, {
    plainCost: 2, swampCost: 8, maxRooms: 1, maxOps: COMBAT_APPROACH_MAX_OPS,
    roomCallback: (roomName) => roomName === creep.room.name ? costs : false,
  });
  const openPath = search(matrix);
  const end = openPath.path[openPath.path.length - 1];
  if (!openPath.incomplete && end && Math.max(Math.abs(end.x - target.pos.x), Math.abs(end.y - target.pos.y)) <= 1
    && openPath.path.every((step) => matrix.get(step.x, step.y) < 0xff)) return { open: true, breach: null, path: openPath.path };
  // 开放搜索耗尽预算时仍做有界突破搜索；只有完整突破路径才授予屏障攻击许可。
  // 退路门按当前未拆墙的世界封锁墙后区域。突破搜索只用原物理几何寻找第一道屏障，
  // 不能继承袋外的255；这不授予墙后移动许可，实际每步仍走 fresh 安全回调。
  const breachMatrix = base.clone();
  const breachByPosition = new Map<string, StructureRampart | StructureWall>();
  const hostileCreeps = getHostileCreeps(creep.room);
  for (const barrier of barriers) {
    if (isWalkableStructure(barrier)) continue;
    breachMatrix.set(barrier.pos.x, barrier.pos.y, getCombatBreachCost(barrier, hostileCreeps));
    breachByPosition.set(`${barrier.pos.x}:${barrier.pos.y}`, barrier);
  }
  for (const other of [...creep.room.find(FIND_MY_CREEPS), ...hostileCreeps]) if (other.name !== creep.name) breachMatrix.set(other.pos.x, other.pos.y, 0xfe);
  const result = search(breachMatrix);
  if (!result.incomplete) for (const step of result.path) {
    const breach = breachByPosition.get(`${step.x}:${step.y}`);
    if (breach) return { open: false, breach };
  }
  return { open: false, breach: null };
}

function computeWarApproach(creep: Creep, includeNeutralWalls: boolean): { target: Creep | Structure; approach: WarCombatApproach } | null {
  const preferred = findWarObjectiveTarget(creep, includeNeutralWalls);
  if (!preferred) return null;
  const first = findCombatApproach(creep, preferred, includeNeutralWalls);
  if (first.open) return { target: preferred, approach: first };
  // 最近的目标被封住时，先处理同类或其它核心可达目标，不能把全队锁在一面墙前。
  const order: StructureConstant[] = [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_INVADER_CORE];
  const structures = getHostileStructures(creep.room, includeNeutralWalls, creep)
    .filter((structure) => structure.id !== preferred.id && !isBreachTarget(structure));
  // 相邻目标无需寻路，不受远处候选的轮询预算影响；仍检查覆盖它的 rampart。
  for (const target of structures.filter(s => creep.pos.getRangeTo(s.pos) <= 1)) {
    const approach = findCombatApproach(creep, target, includeNeutralWalls);
    if (approach.open) return { target, approach };
  }
  const candidates = order.flatMap(type => structures.filter(s => s.structureType === type && creep.pos.getRangeTo(s.pos) > 1)
    .sort((a, b) => creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos)));
  const unique = [...new Map(candidates.map(target => [target.id, target])).values()];
  if (unique.length) {
    const state = candidateCursors.get(creep.name) ?? { cursor: 0 };
    const selected = unique.find(target => target.id === state.targetId);
    const index = selected ? unique.indexOf(selected) : state.cursor % unique.length;
    const target = unique[index];
    if (candidateCursors.size >= 128) candidateCursors.delete(candidateCursors.keys().next().value!);
    candidateCursors.set(creep.name, state);
    const approach = findCombatApproach(creep, target, includeNeutralWalls);
    if (approach.open) {
      state.targetId = target.id;
      return { target, approach };
    }
    // 只有当前目标失效或被封住才轮转，避免在可达目标与拆墙之间来回切换。
    delete state.targetId;
    state.cursor = index + 1;
  }
  return { target: preferred, approach: first };
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
  const hostileIds = new Set(getHostileStructures(creep.room, false, creep).map((structure) => structure.id));
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

const counterstrikeFrames = new WeakMap<Game, { tick: number; rooms: Map<string, { room: Room; state: CounterstrikeRoomState }> }>();
function getCounterstrikeRoomState(room: Room): CounterstrikeRoomState {
  let counterstrikeMemo = counterstrikeFrames.get(Game);
  if (!counterstrikeMemo || counterstrikeMemo.tick !== Game.time) { counterstrikeMemo = { tick: Game.time, rooms: new Map() }; counterstrikeFrames.set(Game, counterstrikeMemo); }
  const old = counterstrikeMemo.rooms.get(room.name); if (old?.room === room) return old.state;
  const state: CounterstrikeRoomState = {
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
  counterstrikeMemo.rooms.set(room.name, { room, state }); return state;
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

function findPairedWarHealer(creep: Creep): Creep | null { return warPartner(creep, "healer") ?? null; }

function isWarFollowTileOpen(attacker: Creep, tile: Readonly<{ x: number; y: number; roomName: string }>): boolean {
  const room = attacker.room;
  if (typeof room.lookAt === "function") {
    return room.lookAt(tile.x, tile.y).every((look) =>
      look.terrain !== "wall" && !look.source && !look.mineral && !look.deposit
      && (!look.structure || look.structure.structureType !== STRUCTURE_PORTAL && isWalkableStructure(look.structure))
      && (!look.constructionSite || !look.constructionSite.my || isWalkableConstructionSite(look.constructionSite))
      && (!look.creep || look.creep === attacker) && !look.powerCreep,
    );
  }
  // 保留无 lookAt 的房间适配器；生产原生房间只查询上面的两个格子。
  const at = (object: { pos: RoomPosition }): boolean => object.pos.x === tile.x && object.pos.y === tile.y;
  return Game.map.getRoomTerrain(room.name).get(tile.x, tile.y) !== TERRAIN_MASK_WALL
    && !room.find(FIND_STRUCTURES).some(s => at(s) && (s.structureType === STRUCTURE_PORTAL || !isWalkableStructure(s)))
    && !room.find(FIND_CONSTRUCTION_SITES).some(s => at(s) && s.my && !isWalkableConstructionSite(s))
    && ![...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS), ...room.find(FIND_DEPOSITS)].some(at)
    && !(room.controller && at(room.controller))
    && ![...Object.values(Game.creeps), ...room.find(FIND_HOSTILE_CREEPS), ...room.find(FIND_HOSTILE_POWER_CREEPS), ...Object.values(Game.powerCreeps || {})]
      .some(unit => unit !== attacker && unit.room?.name === room.name && at(unit));
}

/** 红绿任一执行序都可补齐同帧跟随；不覆盖已提交的安全移动或出口专用协调。 */
export function followMovingWarAttacker(healer: Creep, attacker: Creep): boolean {
  if (attacker.memory._warMoveIntentAt !== Game.time) return true;
  if (attacker.memory._warDetached || healer.memory._warDetached || attacker.memory._warRetireToRoom || healer.memory._warRetireToRoom
    || attacker.memory._recycleToRoom || healer.memory._recycleToRoom || attacker.spawning || healer.spawning
    || attacker.memory._warPartnerConfigName !== healer.memory.configName || healer.memory._warPartnerConfigName !== attacker.memory.configName) return true;
  const intent = getMoveIntentReceipt(attacker);
  const interior = (pos: Readonly<{ x: number; y: number }>): boolean => pos.x > 0 && pos.x < 49 && pos.y > 0 && pos.y < 49;
  if (!intent?.to || intent.to.roomName !== healer.room.name || attacker.room.name !== healer.room.name
    || !interior(intent.from) || !interior(intent.to) || !interior(healer.pos) || !healer.pos.isNearTo(attacker.pos)) return true;
  if (Math.max(Math.abs(intent.to.x - healer.pos.x), Math.abs(intent.to.y - healer.pos.y)) <= 1) return true;
  if (healer.fatigue > 0 || healer.getActiveBodyparts(MOVE) <= 0
    || hasMoveDestinationConflict(intent.to, [attacker, healer]) || !isWarFollowTileOpen(attacker, intent.to)) return false;
  const healerIntent = getMoveIntentReceipt(healer);
  if (healerIntent) {
    return !!healerIntent.to && healerIntent.to.roomName === intent.to.roomName
      && (healerIntent.to.x !== intent.to.x || healerIntent.to.y !== intent.to.y)
      && Math.max(Math.abs(intent.to.x - healerIntent.to.x), Math.abs(intent.to.y - healerIntent.to.y)) <= 1
      && !hasMoveDestinationConflict(healerIntent.to, [attacker, healer]) && isWarFollowTileOpen(attacker, healerIntent.to);
  }
  if (getCreepMovementState(healer)?.movementPushedAt === Game.time || hasMoveDestinationConflict(intent.from, [attacker, healer])
    || !isWarFollowTileOpen(attacker, intent.from)) return false;
  const direction = healer.pos.getDirectionTo(attacker.pos);
  if (!direction) return false;
  clearMovementState(healer);
  return issueMove(healer, direction) === OK;
}

function getTargetRoomMoveOptions(creep: Creep, towerDrain = false) {
  const baseOptions = { ...TARGET_ROOM_MOVE_OPTIONS, reusePath: !towerDrain && getRefillableHostileTowers(creep.room).length === 0 ? 3 : 0 };
  const healer = findPairedWarHealer(creep);
  if ((!healer || healer.room.name !== creep.room.name) && !towerDrain) {
    return baseOptions;
  }

  return {
    ...baseOptions,
    costCallback: (roomName: string, matrix: CostMatrix): CostMatrix => {
      // 配对成员使用通用占位/让路代价，不能把搭档所在格人为降到道路代价。
      return towerDrain ? constrainTowerDrainBreachPath(creep, roomName, matrix) : matrix;
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
  tactic?: string,
) => ({
  prepare: (creep): boolean => {
    synchronizeWarPartnerConfigName(creep, partnerConfigName);
    return prepareCombatBoost(creep, boostTaskId, encodedBoostCompounds);
  },
  source: (creep): boolean => {
    synchronizeWarPartnerConfigName(creep, partnerConfigName);
    if ((tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo") && targetRoom && runTowerDrainPair(creep, targetRoom, partnerConfigName ?? "", tactic === "t3TowerDrainDuo")) return false;
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
    if ((tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo") && targetRoom && runTowerDrainPair(creep, targetRoom, partnerConfigName ?? "", tactic === "t3TowerDrainDuo")) return false;
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

    if ((tactic !== "towerDrainDuo" && tactic !== "t3TowerDrainDuo") && targetRoom && creep.room.name === targetRoom && runCounterstrikeApproach(creep)) return false;

    const targetMoveOptions = targetRoom ? getTargetRoomMoveOptions(creep, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo")) : TARGET_ROOM_MOVE_OPTIONS;
    const warApproach = targetRoom ? chooseWarApproach(creep, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo")) : null;
    const target = targetRoom ? warApproach?.target : measureCreepDecision(() => findTarget(creep));
    if (!target) {
      delete creep.memory._warBreachTargetId;
      if (targetRoom) {
        moveWarAttackerToTarget(creep, new RoomPosition(25, 25, targetRoom), 3, targetMoveOptions, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo"));
      }
      return false;
    }

    const approach = warApproach?.approach;
    if (targetRoom) {
      const plannedBreach = approach?.breach;
      if (plannedBreach) {
        creep.memory._warBreachTargetId = plannedBreach.id;
        const breachCode = measureCreepIntent(() => creep.attack(plannedBreach));
        if (breachCode === ERR_NOT_IN_RANGE) {
          moveWarAttackerToTarget(creep, plannedBreach, 1, targetMoveOptions, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo"));
        }
        return false;
      }
      delete creep.memory._warBreachTargetId;
      if (approach && !approach.open) {
        // 搜索未证明可走或可突破的路径时，邻墙不构成攻击许可。
        return false;
      }
    }

    const code = measureCreepIntent(() => creep.attack(target));
    if (code === ERR_NOT_IN_RANGE) {
      const verifiedOptions = approach?.path ? {
        ...targetMoveOptions,
        verifiedPath: approach.path,
        canMoveStep: (pos: RoomPosition) => {
          const healer = findPairedWarHealer(creep);
          const partnerTile = healer && healer.room.name === pos.roomName && healer.pos.x === pos.x && healer.pos.y === pos.y;
          if (!partnerTile && !isWarFollowTileOpen(creep, pos)) return false;
          if (warGeometry(creep.room).blocked[pos.x * 50 + pos.y]) return false;
          if (tactic !== "towerDrainDuo" && tactic !== "t3TowerDrainDuo") return true;
          const matrix = constrainTowerDrainBreachPath(creep, pos.roomName, new PathFinder.CostMatrix());
          return matrix.get(pos.x, pos.y) < 0xff;
        },
      } : targetMoveOptions;
      const moveCode = moveWarAttackerToTarget(creep, target, 1, verifiedOptions, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo"));
      if (moveCode === ERR_NO_PATH && creep.room.name === target.pos.roomName && !approach?.open) {
        attackAdjacentBreachTarget(creep, target);
      }
      return false;
    }

    // 战争目标失效后下一 tick 重新证明 approach，不能直接改打最近的屏障。
    if (code === ERR_INVALID_TARGET && !targetRoom && (target as Creep | Structure).id) {
      const fallback = creep.pos.findClosestByRange(getHostileStructures(creep.room, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo"), creep));
      if (fallback) {
        const fallbackCode = measureCreepIntent(() => creep.attack(fallback));
        if (fallbackCode === ERR_NOT_IN_RANGE) {
          moveWarAttackerToTarget(creep, fallback, 1, targetMoveOptions, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo"));
        }
      }
    }

    return false;
  },
});
