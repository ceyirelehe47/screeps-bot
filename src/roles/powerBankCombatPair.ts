import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { isExitTile } from "@/movement/common";
import { getCachedStaticTravelMatrix } from "@/movement/routing";
import { getPowerBankOwnedAvoidRooms, isPowerBankTransitRoomAllowed, powerBankTransitOptions } from "@/runtime/powerBankTransit";
import {
  cancelMoveIntent, getMoveIntentAttemptedPosition, getMoveIntentDestination, getMoveIntentReceipt, issueMove, moveToAdjacentPosition,
  moveOffExit, type MoveIntentReceipt,
} from "@/movement/traffic";

type PowerBankCombatRuntimeMemory = CreepMemory & {
  taskId?: string;
  pairGeneration?: number;
};

type RuntimeReinforcementState = PowerBankReinforcementState & {
  generation?: number;
  combatReady?: boolean;
};

type RuntimePowerBankTask = PowerBankHarvestTask & {
  activeGeneration?: number;
  combatReady?: boolean;
  routeRooms?: string[];
  avoidRooms?: string[];
  reinforcement?: RuntimeReinforcementState;
};

export interface PowerBankPairContext {
  task: RuntimePowerBankTask;
  attacker: Creep;
  healer: Creep;
  generation?: number;
  stage: PowerBankHarvestStatus | PowerBankReinforcementStage;
  combatReady: boolean;
  reinforcement: boolean;
}

function findCreepById(id: string): Creep | null {
  const object = typeof Game.getObjectById === "function" ? Game.getObjectById(id as Id<Creep>) : null;
  if (object && "body" in object && "memory" in object) {
    return object as Creep;
  }

  for (const creep of Object.values(Game.creeps)) {
    if (creep.id === id) return creep;
  }
  return null;
}

export function getPowerBankTaskForCreep(creep: Creep): RuntimePowerBankTask | null {
  const taskId = (creep.memory as PowerBankCombatRuntimeMemory).taskId;
  if (!taskId) return null;
  return (Memory.data?.powerBankHarvest?.[taskId] as RuntimePowerBankTask | undefined) ?? null;
}

function hasMatchingGeneration(creep: Creep, generation: number | undefined): boolean {
  if (generation === undefined) return true;
  return (creep.memory as PowerBankCombatRuntimeMemory).pairGeneration === generation;
}

function hasMatchingTask(creep: Creep, task: RuntimePowerBankTask): boolean {
  return (creep.memory as PowerBankCombatRuntimeMemory).taskId === task.id;
}

function legacyReadiness(task: RuntimePowerBankTask): boolean {
  return task.combatReady !== false && task.attackerReady !== false && task.healerReady !== false;
}

/**
 * Resolves only the pair whose task-owned member ID and generation match the
 * running creep. Config-name or same-task fallbacks are intentionally avoided:
 * they can bind a freshly spawned replacement or another generation.
 */
export function resolvePowerBankPair(creep: Creep, task: RuntimePowerBankTask): PowerBankPairContext | null {
  const role = creep.memory.role;
  if (role !== "powerBankAttacker" && role !== "powerBankHealer") return null;
  if (!hasMatchingTask(creep, task)) return null;

  const memory = creep.memory as PowerBankCombatRuntimeMemory;
  const reinforcement = task.reinforcement;
  const selfIdKey = role === "powerBankAttacker" ? "attackerId" : "healerId";
  const selfIsReinforcement = !!reinforcement && (
    (memory.pairGeneration !== undefined && reinforcement.generation === memory.pairGeneration) ||
    reinforcement[selfIdKey] === creep.id
  );

  let attackerId: string | undefined;
  let healerId: string | undefined;
  let generation: number | undefined;
  let stage: PowerBankHarvestStatus | PowerBankReinforcementStage;
  let combatReady: boolean;

  if (selfIsReinforcement && reinforcement) {
    attackerId = reinforcement.attackerId;
    healerId = reinforcement.healerId;
    generation = reinforcement.generation;
    stage = reinforcement.stage;
    combatReady = generation === undefined
      ? reinforcement.combatReady !== false && reinforcement.attackerReady !== false && reinforcement.healerReady !== false
      : reinforcement.combatReady === true;
  } else {
    attackerId = task.attackerId;
    healerId = task.healerId;
    generation = task.activeGeneration;
    stage = task.status;
    combatReady = generation === undefined ? legacyReadiness(task) : task.combatReady === true;
  }

  const expectedSelfId = role === "powerBankAttacker" ? attackerId : healerId;
  if (!expectedSelfId || expectedSelfId !== creep.id || !attackerId || !healerId) return null;
  if (!hasMatchingGeneration(creep, generation)) return null;

  const attacker = role === "powerBankAttacker" ? creep : findCreepById(attackerId);
  const healer = role === "powerBankHealer" ? creep : findCreepById(healerId);
  if (!attacker || !healer) return null;
  if (attacker.memory.role !== "powerBankAttacker" || healer.memory.role !== "powerBankHealer") return null;
  if (!hasMatchingTask(attacker, task) || !hasMatchingTask(healer, task)) return null;
  if (!hasMatchingGeneration(attacker, generation) || !hasMatchingGeneration(healer, generation)) return null;

  return {
    task,
    attacker,
    healer,
    generation,
    stage,
    combatReady,
    reinforcement: selfIsReinforcement,
  };
}

export function pairReadyForTravel(pair: PowerBankPairContext): boolean {
  return pair.combatReady;
}

export function pairReadyForCombat(pair: PowerBankPairContext): boolean {
  if (!pair.combatReady) return false;
  if (pair.attacker.room.name !== pair.healer.room.name) return false;
  if (!pair.attacker.pos.isNearTo(pair.healer.pos)) return false;
  if (pair.attacker.getActiveBodyparts(ATTACK) <= 0) return false;
  if (pair.attacker.getActiveBodyparts(TOUGH) <= 0) return false;
  if (pair.healer.getActiveBodyparts(HEAL) <= 0) return false;
  return true;
}

export function getPowerBankEncodedRoute(task: RuntimePowerBankTask, fallback?: string): string | undefined {
  const routeRooms = task.routeRooms;
  if (!Array.isArray(routeRooms) || routeRooms.length === 0) return fallback;
  const validRooms = routeRooms.filter((roomName): roomName is string => typeof roomName === "string" && roomName.length > 0);
  return validRooms.length > 0 ? validRooms.join("|") : fallback;
}

export function getPowerBankEncodedRouteBetween(
  task: Pick<RuntimePowerBankTask, "routeRooms"> | null | undefined,
  fromRoom: string,
  targetRoom: string,
  fallback?: string,
): string | undefined {
  const taskRouteRooms = task?.routeRooms;
  const routeRooms = Array.isArray(taskRouteRooms) && taskRouteRooms.length > 0
    ? taskRouteRooms
    : fallback?.split("|").filter((roomName) => roomName.length > 0) ?? [];
  if (routeRooms.length === 0) return undefined;
  const ownedRooms = new Set(getPowerBankOwnedAvoidRooms());
  if (routeRooms.some((roomName) => roomName !== fromRoom && ownedRooms.has(roomName))) return undefined;

  const fromIndex = routeRooms.lastIndexOf(fromRoom);
  const targetIndex = routeRooms.lastIndexOf(targetRoom);
  if (fromIndex >= 0 && targetIndex >= 0) {
    const segment = fromIndex <= targetIndex
      ? routeRooms.slice(fromIndex, targetIndex + 1)
      : routeRooms.slice(targetIndex, fromIndex + 1).reverse();
    return segment.join("|");
  }

  // A creep outside the snapshot must recover dynamically toward the requested
  // room; replaying the whole forward route can send a follower farther away.
  return undefined;
}

export function getPowerBankNextRouteRoom(task: RuntimePowerBankTask, currentRoom: string): string {
  const routeRooms = task.routeRooms;
  if (!Array.isArray(routeRooms) || routeRooms.length === 0) return task.targetRoom;
  const currentIndex = routeRooms.lastIndexOf(currentRoom);
  if (currentIndex < 0 || currentIndex + 1 >= routeRooms.length) return task.targetRoom;
  return routeRooms[currentIndex + 1];
}

export function getPowerBankAvoidRooms(task: RuntimePowerBankTask): string[] {
  const avoidRooms = new Set<string>(getPowerBankOwnedAvoidRooms());
  if (Array.isArray(task.avoidRooms)) {
    for (const roomName of task.avoidRooms) {
      if (typeof roomName === "string" && roomName.length > 0) avoidRooms.add(roomName);
    }
  }

  // Compatibility for active tasks created before task-level route snapshots.
  const runtime = Memory.runtime;
  for (const [roomName, expiresAt] of Object.entries(runtime?.transitDangerRooms ?? {})) {
    if (typeof expiresAt === "number" && expiresAt > Game.time) avoidRooms.add(roomName);
  }
  for (const [roomName, dangerous] of Object.entries(runtime?.powerBankPermanentDangerRooms ?? {})) {
    if (dangerous) avoidRooms.add(roomName);
  }

  avoidRooms.delete(task.sourceRoom);
  avoidRooms.delete(task.targetRoom);
  return [...avoidRooms];
}

const PAIR_TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;
const PAIR_DIRECTIONS: readonly DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
let pairMovementGame: typeof Game | undefined;
let pairMovementTick = -1;
let pairMovementCalls = new WeakMap<Creep, { task: RuntimePowerBankTask; healer: Creep; generation?: number }>();

type PairPosition = Readonly<{ x: number; y: number; roomName: string }>;

function samePairPosition(left: PairPosition, right: PairPosition): boolean {
  return left.roomName === right.roomName && left.x === right.x && left.y === right.y;
}

function hasForeignMovement(creep: Creep): boolean {
  const state = getCreepMovementState(creep);
  const spawnYield = creep.memory._spawnYield;
  return !!getMoveIntentReceipt(creep) || state?.movementPushedAt === Game.time ||
    !!(spawnYield && Game.time - spawnYield.tick >= 0 && Game.time - spawnYield.tick <= 2);
}

function canPairMemberMove(creep: Creep): boolean {
  return !creep.spawning && creep.fatigue === 0 && creep.getActiveBodyparts(MOVE) > 0 && !hasForeignMovement(creep);
}

function holdPairMember(creep: Creep): void {
  if (!hasForeignMovement(creep)) clearMovementState(creep);
}

/** 共享静态矩阵保留地形/自然物/结构校验，动态占位仍每次读取。 */
function isPairTileOpen(pos: PairPosition, pair: PowerBankPairContext): boolean {
  if (pos.roomName !== pair.attacker.room.name && !isPowerBankTransitRoomAllowed(pos.roomName)) return false;
  if (getCachedStaticTravelMatrix(pos.roomName).get(pos.x, pos.y) >= 255) return false;
  const occupants: AnyCreep[] = [
    ...Object.values(Game.creeps),
    ...Object.values(Game.powerCreeps || {}).filter((creep) => creep.ticksToLive != null),
  ];
  const room = Game.rooms[pos.roomName];
  if (room && typeof room.lookForAt === "function") {
    occupants.push(...room.lookForAt(LOOK_CREEPS, pos.x, pos.y));
    occupants.push(...room.lookForAt(LOOK_POWER_CREEPS, pos.x, pos.y));
  }
  return !occupants.some((creep) =>
    creep !== pair.attacker && creep !== pair.healer && samePairPosition(creep.pos, pos));
}

function markPairMoving(pair: PowerBankPairContext): void {
  ensureCreepMovementState(pair.attacker).pathingRequestedAt = Game.time;
  ensureCreepMovementState(pair.healer).pathingRequestedAt = Game.time;
}

function movePairFollowerToAttacker(pair: PowerBankPairContext): void {
  holdPairMember(pair.attacker);
  if (!canPairMemberMove(pair.healer)) return;
  const options = { ...PAIR_TRAVEL_OPTIONS, ignoreCreeps: false, reusePath: 0, maxRooms: 1 };
  const result = moveToTarget(pair.healer, pair.attacker, 1, options);
  if (result === ERR_NO_PATH) moveToTarget(pair.healer, pair.attacker, 1, { ...options, ignoreCreeps: true });
}

function cancelPairAdvance(pair: PowerBankPairContext, receipt: MoveIntentReceipt): boolean {
  const canceled = cancelMoveIntent(pair.attacker, receipt);
  // 撤销成功即无 receipt，可以清理 active 占位；撤销失败仍保留红的真实意图。
  holdPairMember(pair.attacker);
  holdPairMember(pair.healer);
  return canceled;
}

/** 双意图的第二次提交失败时，只撤销协调器刚提交的领队意图。 */
function completePairStep(
  pair: PowerBankPairContext,
  leaderReceipt: MoveIntentReceipt,
  followerDestination: PairPosition,
  followerDirection?: DirectionConstant,
): void {
  const leaderTo = leaderReceipt.to;
  // 分队重聚也逐成员检查：红已经误入敌房不能成为把绿带进去的许可。
  if ((leaderTo && leaderTo.roomName !== pair.attacker.room.name && !isPowerBankTransitRoomAllowed(leaderTo.roomName)) ||
      (followerDestination.roomName !== pair.healer.room.name && !isPowerBankTransitRoomAllowed(followerDestination.roomName))) {
    cancelPairAdvance(pair, leaderReceipt);
    return;
  }
  const direction = followerDirection ?? pair.healer.pos.getDirectionTo(new RoomPosition(followerDestination.x, followerDestination.y, followerDestination.roomName));
  const followerAttempted = getMoveIntentAttemptedPosition(pair.healer.pos, direction);
  if (!leaderTo || !leaderReceipt.attempted || !followerAttempted ||
      !isPairTileOpen(leaderReceipt.attempted, pair) || !isPairTileOpen(followerAttempted, pair) || !isPairTileOpen(leaderTo, pair) || !isPairTileOpen(followerDestination, pair) ||
      samePairPosition(leaderTo, followerDestination) || leaderTo.roomName !== followerDestination.roomName ||
      Math.max(Math.abs(leaderTo.x - followerDestination.x), Math.abs(leaderTo.y - followerDestination.y)) > 1) {
    cancelPairAdvance(pair, leaderReceipt);
    return;
  }
  const code = followerDirection === undefined
    ? moveToAdjacentPosition(pair.healer, new RoomPosition(followerDestination.x, followerDestination.y, followerDestination.roomName))
    : issueMove(pair.healer, followerDirection);
  if (code !== OK) cancelPairAdvance(pair, leaderReceipt);
}

function nextPairRouteRoom(pair: PowerBankPairContext, fallback?: string): string | undefined {
  const encoded = getPowerBankEncodedRouteBetween(pair.task, pair.attacker.room.name, pair.task.targetRoom, fallback);
  const next = encoded?.split("|")[1];
  if (next) return next;
  const avoids = new Set(getPowerBankAvoidRooms(pair.task));
  if (typeof Game.map.findRoute === "function") {
    const route = Game.map.findRoute(pair.attacker.room.name, pair.task.targetRoom, {
      routeCallback: (name) => name !== pair.attacker.room.name && avoids.has(name) ? Infinity : 1,
    });
    return Array.isArray(route) ? route[0]?.room : undefined;
  }
  const exit = pair.attacker.room.findExitTo?.(pair.task.targetRoom);
  return exit && exit > 0 ? Game.map.describeExits(pair.attacker.room.name)?.[exit as ExitConstant] : undefined;
}

function pairExitDirection(pair: PowerBankPairContext, nextRoom: string | undefined): DirectionConstant | undefined {
  if (!nextRoom) return undefined;
  const exits = Game.map.describeExits(pair.attacker.room.name);
  const pos = pair.attacker.pos;
  if (pos.x <= 1 && exits?.[LEFT] === nextRoom) return LEFT;
  if (pos.x >= 48 && exits?.[RIGHT] === nextRoom) return RIGHT;
  if (pos.y <= 1 && exits?.[TOP] === nextRoom) return TOP;
  if (pos.y >= 48 && exits?.[BOTTOM] === nextRoom) return BOTTOM;
  return undefined;
}

/** 两人先在 1/48 的房内安全排位；0/49 是迁房入口，不可拿作等待格。 */
function alignPairAtExit(pair: PowerBankPairContext, direction: DirectionConstant): boolean {
  const redDestination = getMoveIntentDestination(pair.attacker.pos, direction);
  const greenDestination = getMoveIntentDestination(pair.healer.pos, direction);
  if (redDestination && greenDestination && redDestination.roomName === greenDestination.roomName &&
      !samePairPosition(redDestination, greenDestination) &&
      Math.max(Math.abs(redDestination.x - greenDestination.x), Math.abs(redDestination.y - greenDestination.y)) <= 1) return false;
  const axis = direction === LEFT ? 1 : direction === RIGHT ? 48 : direction === TOP ? 1 : 48;
  const candidates = direction === LEFT || direction === RIGHT
    ? [{ x: axis, y: pair.attacker.pos.y - 1 }, { x: axis, y: pair.attacker.pos.y + 1 }]
    : [{ x: pair.attacker.pos.x - 1, y: axis }, { x: pair.attacker.pos.x + 1, y: axis }];
  const candidate = candidates
    .filter((pos) => pos.x >= 1 && pos.x <= 48 && pos.y >= 1 && pos.y <= 48)
    .map((pos) => new RoomPosition(pos.x, pos.y, pair.attacker.room.name))
    .find((pos) => pair.healer.pos.getRangeTo(pos) <= 1 && isPairTileOpen(pos, pair));
  holdPairMember(pair.attacker);
  if (candidate) {
    ensureCreepMovementState(pair.healer).pathingRequestedAt = Game.time;
    moveToAdjacentPosition(pair.healer, candidate);
  } else holdPairMember(pair.healer);
  return true;
}

/** 兼容既有已拆分的边界队形：红走确切内侧格，绿同帧进入红旧格。 */
function rejoinAcrossPairExit(pair: PowerBankPairContext): boolean {
  if (!isExitTile(pair.attacker.pos)) return false;
  const direction = PAIR_DIRECTIONS.find((candidate) => {
    const destination = getMoveIntentDestination(pair.healer.pos, candidate);
    return destination && samePairPosition(destination, pair.attacker.pos);
  });
  if (direction === undefined) return false;
  if (!canPairMemberMove(pair.attacker) || !canPairMemberMove(pair.healer)) return true;
  markPairMoving(pair);
  const greenAttempted = getMoveIntentAttemptedPosition(pair.healer.pos, direction);
  const greenDestination = pair.attacker.pos;
  const code = moveOffExit(pair.attacker, true, (_direction, inner) =>
    !!greenAttempted && isPairTileOpen(greenAttempted, pair) && isPairTileOpen(greenDestination, pair) &&
    isPairTileOpen(inner, pair) && !samePairPosition(inner, greenDestination) &&
    Math.max(Math.abs(inner.x - greenDestination.x), Math.abs(inner.y - greenDestination.y)) <= 1);
  if (code === OK) {
    const receipt = getMoveIntentReceipt(pair.attacker);
    if (receipt) completePairStep(pair, receipt, greenDestination, direction);
  } else {
    holdPairMember(pair.attacker);
    holdPairMember(pair.healer);
  }
  return true;
}

function canPairLeaveExit(pair: PowerBankPairContext, direction: DirectionConstant, leaderDestination: RoomPosition): boolean {
  const greenAttempted = getMoveIntentAttemptedPosition(pair.healer.pos, direction);
  const greenDestination = getMoveIntentDestination(pair.healer.pos, direction);
  return !!greenAttempted && !!greenDestination && greenDestination.roomName === leaderDestination.roomName &&
    !samePairPosition(leaderDestination, greenDestination) &&
    Math.max(Math.abs(leaderDestination.x - greenDestination.x), Math.abs(leaderDestination.y - greenDestination.y)) <= 1 &&
    isPairTileOpen(leaderDestination, pair) && isPairTileOpen(greenAttempted, pair) && isPairTileOpen(greenDestination, pair);
}

/** 任一角色首先执行都为整对提交一次移动，后续 source/target 不再覆盖。 */
export function coordinatePowerBankPairMovement(pair: PowerBankPairContext, fallbackEncodedRoute?: string): void {
  if (pairMovementGame !== Game || pairMovementTick !== Game.time) {
    pairMovementGame = Game;
    pairMovementTick = Game.time;
    pairMovementCalls = new WeakMap();
  }
  const previous = pairMovementCalls.get(pair.attacker);
  if (previous?.task === pair.task && previous.healer === pair.healer && previous.generation === pair.generation) {
    // mount source→target 切换会清理 heap state；保留已提交意图的交通占位，绝不重发。
    for (const member of [pair.attacker, pair.healer]) {
      if (getMoveIntentReceipt(member)) ensureCreepMovementState(member).pathingRequestedAt = Game.time;
    }
    return;
  }
  pairMovementCalls.set(pair.attacker, { task: pair.task, healer: pair.healer, generation: pair.generation });
  if (!pairReadyForTravel(pair) || hasForeignMovement(pair.attacker) || hasForeignMovement(pair.healer)) return;
  if (pair.attacker.room.name !== pair.healer.room.name) {
    if (rejoinAcrossPairExit(pair)) return;
    holdPairMember(pair.attacker);
    if (canPairMemberMove(pair.healer)) {
      moveToTargetRoom(pair.healer, pair.attacker.room.name,
        getPowerBankEncodedRouteBetween(pair.task, pair.healer.room.name, pair.attacker.room.name, fallbackEncodedRoute),
        powerBankTransitOptions(pair.healer, { ...PAIR_TRAVEL_OPTIONS, avoidRooms: getPowerBankAvoidRooms(pair.task) }));
    }
    return;
  }
  if (!pair.attacker.pos.isNearTo(pair.healer.pos)) {
    movePairFollowerToAttacker(pair);
    return;
  }
  if (!canPairMemberMove(pair.attacker) || !canPairMemberMove(pair.healer)) {
    holdPairMember(pair.attacker);
    holdPairMember(pair.healer);
    return;
  }

  const travelling = pair.attacker.room.name !== pair.task.targetRoom;
  if (travelling) {
    const direction = pairExitDirection(pair, nextPairRouteRoom(pair, fallbackEncodedRoute));
    if (direction !== undefined && alignPairAtExit(pair, direction)) return;
  }
  markPairMoving(pair);
  if (isExitTile(pair.attacker.pos)) {
    // 共享候选排序只增加搭档可同步离入口的过滤，不在失败后反复尝试同一坏格。
    moveOffExit(pair.attacker, true, (direction, pos) => canPairLeaveExit(pair, direction, pos));
  } else if (travelling) {
    moveToTargetRoom(pair.attacker, pair.task.targetRoom,
      getPowerBankEncodedRouteBetween(pair.task, pair.attacker.room.name, pair.task.targetRoom, fallbackEncodedRoute),
      powerBankTransitOptions(pair.attacker, { ...PAIR_TRAVEL_OPTIONS, avoidRooms: getPowerBankAvoidRooms(pair.task) }));
  } else if (pair.stage === "attacking" && pairReadyForCombat(pair)) {
    const bank = Game.getObjectById(pair.task.bankId as Id<StructurePowerBank>);
    if (bank && pair.attacker.pos.getRangeTo(bank) > 1) {
      const options = { ...PAIR_TRAVEL_OPTIONS, ignoreCreeps: false, reusePath: 0, maxRooms: 1 };
      const code = moveToTarget(pair.attacker, bank, 1, options);
      if (code === ERR_NO_PATH) moveToTarget(pair.attacker, bank, 1, { ...options, ignoreCreeps: true });
    }
  }
  const receipt = getMoveIntentReceipt(pair.attacker);
  if (!receipt) {
    holdPairMember(pair.attacker);
    holdPairMember(pair.healer);
    return;
  }
  if (receipt.to?.roomName === pair.attacker.room.name) {
    const followDirection = pair.healer.pos.getDirectionTo(new RoomPosition(receipt.from.x, receipt.from.y, receipt.from.roomName));
    const followDestination = getMoveIntentDestination(pair.healer.pos, followDirection);
    if (followDestination && samePairPosition(followDestination, receipt.from)) {
      completePairStep(pair, receipt, receipt.from);
    } else {
      // 跟进领队旧入口 0/49 会被 Engine 送回上一房；改为同方向内移的并行队形。
      const parallel = getMoveIntentDestination(pair.healer.pos, receipt.direction);
      if (parallel && parallel.roomName === receipt.to.roomName) completePairStep(pair, receipt, parallel, receipt.direction);
      else cancelPairAdvance(pair, receipt);
    }
  } else {
    // 领队实际接受的边界方向，应用于绿的独立出口格，不能拿 OK 猜方向。
    const destination = getMoveIntentDestination(pair.healer.pos, receipt.direction);
    if (!destination || destination.roomName !== receipt.to?.roomName) {
      const canceled = cancelPairAdvance(pair, receipt);
      // Legacy 动态路由可能选择不同于 findExitTo 的避险出口。以真实 receipt
      // 纠正预排方向，只在领队已撤回、绿仍在原房时排位，不猜新的寻路路线。
      if (canceled && receipt.to && receipt.attempted && destination?.roomName === pair.healer.room.name) {
        const attempted = receipt.attempted;
        const exit = attempted.x === 0 ? LEFT : attempted.x === 49 ? RIGHT : attempted.y === 0 ? TOP : BOTTOM;
        alignPairAtExit(pair, exit);
      }
    } else completePairStep(pair, receipt, destination, receipt.direction);
  }
}
