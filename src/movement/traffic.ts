import { ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { recordMovementMetric } from "@/movement/metrics";
import { getTickContextService } from "@/runtime/runtimeServices";
import type { RoomTickContext } from "@/runtime/tickContext";
import {
  getPositionAtDirection,
  isExitTile,
  isStandardCreep,
  isWalkableConstructionSite,
  isWalkableStructure,
} from "@/movement/common";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";

const ALL_DIRECTIONS: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

export function findMyCreepAt(pos: RoomPosition, excludeName?: string): Creep | null {
  const roomContext = getTickContextService().getRoomContext(pos.roomName);
  const myCreeps = roomContext?.getMyCreeps() || [];
  return myCreeps.find((c) => c.name !== excludeName && c.pos.x === pos.x && c.pos.y === pos.y) || null;
}

export function findMyOwnedUnitAt(pos: RoomPosition, exclude?: AnyCreep): AnyCreep | null {
  const roomContext = getTickContextService().getRoomContext(pos.roomName);
  const myCreeps = roomContext?.getMyCreeps() || [];
  const creep = myCreeps.find(
    (candidate) => candidate !== exclude && candidate.pos.x === pos.x && candidate.pos.y === pos.y,
  );
  if (creep) {
    return creep;
  }

  return Object.values(Game.powerCreeps || {}).find(
    (candidate) => candidate !== exclude &&
      candidate.ticksToLive != null &&
      candidate.room?.name === pos.roomName &&
      candidate.pos.x === pos.x &&
      candidate.pos.y === pos.y,
  ) || null;
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export function isBlockerActivelyMoving(blocker: AnyCreep): boolean {
  const receipt = getMoveIntentReceipt(blocker);
  if (receipt?.to && (receipt.to.roomName !== blocker.pos.roomName || receipt.to.x !== blocker.pos.x || receipt.to.y !== blocker.pos.y)) return true;
  const state = getCreepMovementState(blocker);
  if (!state) {
    return false;
  }
  // A creep with an active path/travel state is still on its own route even if
  // it has not executed yet this tick. Do not let earlier creeps in iteration
  // order push it away and create yield loops; idle roles must clear movement
  // state when they intentionally stop.
  if (state.pathingRequestedAt === Game.time) {
    return true;
  }
  const recentlyRequested = state.pathingRequestedAt !== undefined && state.pathingRequestedAt >= Game.time - 1;
  if (recentlyRequested && state.movePathState && state.movePathState.expiresAt > Game.time) {
    return true;
  }
  if (recentlyRequested && state.travelState && state.travelState.targetRoom !== blocker.room?.name) {
    return true;
  }
  return false;
}

/**
 * Pushes a stationary blocker to a nearby free tile.
 * Returns true if the blocker was successfully moved.
 */
export function pushBlockingCreep(pusher: AnyCreep, blocker: AnyCreep): boolean {
  for (const candidate of getYieldCandidatePositions(pusher, blocker)) {
    const occupant = findMyOwnedUnitAt(candidate, blocker);
    if (occupant && occupant !== pusher) {
      continue;
    }
    if (moveBlockerToYieldPosition(pusher, blocker, candidate)) {
      return true;
    }
  }
  return false;
}

export function moveToAdjacentPosition(creep: AnyCreep, nextPos: RoomPosition): ScreepsReturnCode {
  if (creep.pos.getRangeTo(nextPos) > 1) {
    return ERR_NO_PATH;
  }

  const direction = creep.pos.getDirectionTo(nextPos);
  const attempted = getMoveIntentAttemptedPosition(creep.pos, direction);
  if (!attempted || attempted.roomName !== nextPos.roomName || attempted.x !== nextPos.x || attempted.y !== nextPos.y) return ERR_NO_PATH;
  const destination = getMoveIntentDestination(creep.pos, direction);
  if (destination && hasMoveDestinationConflict(destination, [creep])) return ERR_BUSY;
  const blockingCreep = findMyOwnedUnitAt(nextPos, creep);
  if (!blockingCreep) {
    return issueMove(creep, direction);
  }

  if (isHeadOnWarDuoSwap(creep, blockingCreep)) {
    if (pushBlockingCreep(creep, blockingCreep)) {
      return issueMove(creep, direction);
    }
    return ERR_BUSY;
  }

  if (isBlockerActivelyMoving(blockingCreep)) {
    return issueMove(creep, direction);
  }

  if (pushBlockingCreep(creep, blockingCreep)) {
    return issueMove(creep, direction);
  }

  return ERR_BUSY;
}

export interface MoveIntentReceipt {
  readonly tick: number;
  readonly actorId: string;
  readonly direction: DirectionConstant;
  readonly from: Readonly<{ x: number; y: number; roomName: string }>;
  /** 引擎原房坐标估计；任一轴越界时整步忽略，保留原坐标。 */
  readonly attempted: Readonly<{ x: number; y: number; roomName: string }> | null;
  /** 可达出口迁房后的预期格；仅证明提交，实际碰撞/accessibleRooms 仍以下 tick 为准。 */
  readonly to: Readonly<{ x: number; y: number; roomName: string }> | null;
}

// 每个 Game/tick 仅保留每个 actor 最后一次成功 move，不写 Memory。
let receiptGame: typeof Game | undefined;
let receiptTick = -1;
let moveReceipts = new WeakMap<AnyCreep, MoveIntentReceipt>();
let destinationActors = new Map<string, Set<AnyCreep>>();

function currentMoveReceipts(): WeakMap<AnyCreep, MoveIntentReceipt> {
  if (receiptGame !== Game || receiptTick !== Game.time) {
    receiptGame = Game;
    receiptTick = Game.time;
    moveReceipts = new WeakMap<AnyCreep, MoveIntentReceipt>();
    destinationActors = new Map();
  }
  return moveReceipts;
}

const destinationKey = (pos: Readonly<{ x: number; y: number; roomName: string }>): string => `${pos.roomName}:${pos.x}:${pos.y}`;

/** 所有角色共享当帧已提交的落点；让路不能再把另一个单位推入这些格。 */
export function hasMoveDestinationConflict(pos: Readonly<{ x: number; y: number; roomName: string }>, except: readonly AnyCreep[] = []): boolean {
  currentMoveReceipts();
  return [...(destinationActors.get(destinationKey(pos)) ?? [])].some(actor => !except.includes(actor));
}

function removeMoveDestination(actor: AnyCreep, receipt: MoveIntentReceipt | undefined): void {
  if (!receipt?.to) return;
  const key = destinationKey(receipt.to);
  const actors = destinationActors.get(key);
  actors?.delete(actor);
  if (actors?.size === 0) destinationActors.delete(key);
}

const MOVE_RECEIPT_OFFSETS: Record<DirectionConstant, readonly [number, number]> = {
  [TOP]: [0, -1], [TOP_RIGHT]: [1, -1], [RIGHT]: [1, 0], [BOTTOM_RIGHT]: [1, 1],
  [BOTTOM]: [0, 1], [BOTTOM_LEFT]: [-1, 1], [LEFT]: [-1, 0], [TOP_LEFT]: [-1, -1],
};

export function getMoveIntentAttemptedPosition(
  pos: Pick<RoomPosition, "x" | "y" | "roomName">,
  direction: DirectionConstant,
): Readonly<{ x: number; y: number; roomName: string }> | null {
  const offset = MOVE_RECEIPT_OFFSETS[direction];
  if (!offset) return null;
  const x = pos.x + offset[0], y = pos.y + offset[1];
  // 普通/PowerCreep 共用 creeps/move：任一轴越界就忽略整步，不能保留另一轴位移。
  const rejected = x < 0 || x > 49 || y < 0 || y > 49;
  return Object.freeze({
    x: rejected ? pos.x : x,
    y: rejected ? pos.y : y,
    roomName: pos.roomName,
  });
}

export function getMoveIntentDestination(
  pos: Pick<RoomPosition, "x" | "y" | "roomName">,
  direction: DirectionConstant,
): Readonly<{ x: number; y: number; roomName: string }> | null {
  // tick 在移动后独立处理边缘；被忽略的越界 move 仍可能从原坐标迁房。
  const attempted = getMoveIntentAttemptedPosition(pos, direction);
  if (!attempted) return null;
  const { x, y, roomName } = attempted;
  const edgeX = x === 0 || x === 49;
  const edgeY = y === 0 || y === 49;
  // 角点存在双轴出口；协调器不把一个单轴 map 关系当成完整跨房证明。
  if (edgeX && edgeY) return null;
  if (!edgeX && !edgeY) return attempted;
  const exit = edgeX ? (x === 0 ? LEFT : RIGHT) : (y === 0 ? TOP : BOTTOM);
  const nextRoom = Game.map?.describeExits?.(roomName)?.[exit];
  if (!nextRoom || Game.map.getRoomStatus?.(nextRoom)?.status === "closed") return null;
  return Object.freeze({ x: edgeX ? (x === 0 ? 49 : 0) : x, y: edgeY ? (y === 0 ? 49 : 0) : y, roomName: nextRoom });
}

export function getMoveIntentReceipt(creep: AnyCreep): MoveIntentReceipt | undefined {
  return currentMoveReceipts().get(creep);
}

/** 与原 native 调用、Profiler、返回值一致；失败尝试不覆盖先前成功意图。 */
export function issueMove(creep: AnyCreep, direction: DirectionConstant): CreepMoveReturnCode {
  const from = Object.freeze({ x: creep.pos.x, y: creep.pos.y, roomName: creep.pos.roomName });
  const code = isStandardCreep(creep)
    ? measureCreepIntent(() => creep.move(direction))
    : creep.move(direction);
  if (code === OK) {
    const receipts = currentMoveReceipts();
    removeMoveDestination(creep, receipts.get(creep));
    const receipt = Object.freeze({
      tick: Game.time, actorId: creep.id ?? creep.name, direction, from,
      attempted: getMoveIntentAttemptedPosition(from, direction),
      to: getMoveIntentDestination(from, direction),
    });
    receipts.set(creep, receipt);
    if (receipt.to) {
      const key = destinationKey(receipt.to);
      const actors = destinationActors.get(key) ?? new Set<AnyCreep>();
      actors.add(creep); destinationActors.set(key, actors);
    }
  }
  return code;
}

/** 只撤销调用者持有的当前成功意图，不碰此前其它调用者的意图。 */
export function cancelMoveIntent(creep: Creep, receipt: MoveIntentReceipt): boolean {
  const receipts = currentMoveReceipts();
  if (receipts.get(creep) !== receipt || typeof creep.cancelOrder !== "function") return false;
  if (creep.cancelOrder("move") !== OK) return false;
  removeMoveDestination(creep, receipt);
  receipts.delete(creep);
  return true;
}

function isHeadOnWarDuoSwap(attacker: AnyCreep, healer: AnyCreep): boolean {
  if (!isStandardCreep(attacker) || !isStandardCreep(healer)) return false;
  if (attacker.memory.role !== "meleeAttacker" || healer.memory.role !== "healer") return false;
  if (attacker.memory._warDetached === true || healer.memory._warDetached === true) return false;

  const attackerConfig = attacker.memory.configName;
  const healerConfig = healer.memory.configName;
  if (!attackerConfig?.includes(":war:") || !attackerConfig.includes(":meleeAttacker:")) return false;
  if (!healerConfig?.includes(":war:") || !healerConfig.includes(":healer:")) return false;
  if (attacker.memory._warPartnerConfigName !== healerConfig) return false;
  if (healer.memory._warPartnerConfigName !== attackerConfig) return false;

  const nextStep = getPlannedNextStep(healer);
  return nextStep?.x === attacker.pos.x && nextStep.y === attacker.pos.y;
}

function getPlannedNextStep(creep: AnyCreep): { x: number; y: number } | null {
  const movePathState = getCreepMovementState(creep)?.movePathState;
  const steps = movePathState?.steps;
  if (!steps || steps.length === 0) return null;

  // 与 pathing.getNextStoredPathStep 相同的游标策略：正常前进只查 cursor 窗口。
  const cursor = Number.isInteger(movePathState.cursor) ? (movePathState.cursor as number) : -1;
  const windowEnd = Math.min(steps.length, cursor + 3);
  for (let index = Math.max(0, cursor); index < windowEnd; index += 1) {
    const step = steps[index];
    if (step.x === creep.pos.x && step.y === creep.pos.y) return steps[index + 1] ?? null;
  }

  const exactIndex = steps.findIndex((step) => step.x === creep.pos.x && step.y === creep.pos.y);
  if (exactIndex >= 0) return steps[exactIndex + 1] ?? null;

  let closest: { x: number; y: number } | null = null;
  let closestRange = Infinity;
  for (const step of steps) {
    const range = Math.max(Math.abs(creep.pos.x - step.x), Math.abs(creep.pos.y - step.y));
    if (range >= closestRange) continue;
    closest = step;
    closestRange = range;
  }

  return closestRange <= 1 ? closest : null;
}

function moveBlockerToYieldPosition(pusher: AnyCreep, blocker: AnyCreep, yieldPos: RoomPosition): boolean {
  const moveCode = issueMove(blocker, blocker.pos.getDirectionTo(yieldPos));
  if (moveCode !== OK) {
    return false;
  }

  const blockerState = ensureCreepMovementState(blocker);
  delete blockerState.movePathState;
  blockerState.movementPushedAt = Game.time;
  recordMovementMetric("yieldPushes", pusher.room?.name);
  return true;
}

// ─── Yield position selection ─────────────────────────────────────────────────

function getYieldCandidatePositions(pusher: AnyCreep, blocker: AnyCreep): RoomPosition[] {
  const candidates: Array<{ pos: RoomPosition; score: number }> = [];
  const haulerPair = isPowerBankHauler(pusher) && isPowerBankHauler(blocker);

  for (const direction of ALL_DIRECTIONS) {
    const pos = getPositionAtDirection(blocker.pos, direction);
    if (!pos || !isYieldTileWalkable(pos, blocker) || hasMoveDestinationConflict(pos, [blocker])) {
      continue;
    }
    if (haulerPair && pos.x === pusher.pos.x && pos.y === pusher.pos.y) {
      continue;
    }
    let score = scoreYieldPosition(pos, blocker, pusher);
    const occupant = findMyOwnedUnitAt(pos, blocker);
    if (occupant && occupant !== pusher) {
      score -= 15;
    }
    candidates.push({ pos, score });
  }

  return candidates.sort((a, b) => b.score - a.score).map((e) => e.pos);
}

function isPowerBankHauler(creep: AnyCreep): boolean {
  return isStandardCreep(creep) && creep.memory.role === "powerBankHauler";
}

function scoreYieldPosition(pos: RoomPosition, blocker: AnyCreep, pusher: AnyCreep): number {
  let score = 0;

  if (pos.x === pusher.pos.x && pos.y === pusher.pos.y) {
    score += 20;
  }

  if (!isExitTile(pos)) {
    score += 4;
  }

  const terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
  score += terrain === TERRAIN_MASK_SWAMP ? -2 : 1;

  // Stationary creeps with a work anchor should stay close to it.
  const workAnchor = getCreepMovementState(blocker)?.workAnchor;
  if (workAnchor && workAnchor.roomName === pos.roomName) {
    const anchorPos = new RoomPosition(workAnchor.x, workAnchor.y, workAnchor.roomName);
    const dist = pos.getRangeTo(anchorPos);
    if (dist <= workAnchor.range) {
      // Strongly prefer staying within work range — this dominates swap and terrain bonuses.
      score += 30;
    } else {
      score -= dist;
    }
  }

  return score;
}

// Source / Mineral / Deposit / Controller 都是 OBSTACLE_OBJECT_TYPES；Portal
// 格物理可站但站上即被随机传送。被动让位（push / yield / moveOffExit）绝不
// 能把 creep 推上这些格子——主动进 Portal 只属于 crossShardTravel 的显式
// 目标（allowPortalTarget）。索引按 tick 缓存，避免每个候选格重复扫描
// （数量极少：每房 ≤2 source、≤1 mineral、≤1 deposit、≤1 controller）。
let naturalObstacleCacheTick = -1;
const naturalObstacleCache = new Map<string, Set<number>>();

// Test-only reset of the per-tick natural obstacle index; not a runtime API.
export function clearTrafficNaturalObstacleCacheForTest(): void {
  naturalObstacleCache.clear();
  naturalObstacleCacheTick = -1;
}

function isNaturalObstacleTile(roomContext: RoomTickContext, pos: RoomPosition): boolean {
  if (naturalObstacleCacheTick !== Game.time) {
    naturalObstacleCache.clear();
    naturalObstacleCacheTick = Game.time;
  }

  let tiles = naturalObstacleCache.get(pos.roomName);
  if (!tiles) {
    tiles = new Set<number>();
    const controller = roomContext.room.controller;
    if (controller?.pos) {
      tiles.add(controller.pos.y * 50 + controller.pos.x);
    }
    for (const source of roomContext.getSources()) {
      tiles.add(source.pos.y * 50 + source.pos.x);
    }
    for (const mineral of roomContext.getMinerals()) {
      tiles.add(mineral.pos.y * 50 + mineral.pos.x);
    }
    for (const deposit of roomContext.getDeposits()) {
      tiles.add(deposit.pos.y * 50 + deposit.pos.x);
    }
    naturalObstacleCache.set(pos.roomName, tiles);
  }

  return tiles.has(pos.y * 50 + pos.x);
}

function isYieldTileWalkable(pos: RoomPosition, blocker: AnyCreep): boolean {
  const blockerRoom = blocker.room;
  if (!blockerRoom || pos.roomName !== blockerRoom.name) {
    return false;
  }
  if (Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
    return false;
  }

  const roomContext = getTickContextService().getRoomContext(blockerRoom);
  if (!roomContext) {
    return false;
  }

  if (isNaturalObstacleTile(roomContext, pos)) {
    return false;
  }

  for (const structure of roomContext.getStructures()) {
    if (structure.pos.x === pos.x && structure.pos.y === pos.y) {
      // Portal 物理上可通行（isWalkableStructure=true），但被动让位把 creep
      // 推上传送门等于将其随机传送，必须在结构可走判定之前显式拒绝。
      if (structure.structureType === STRUCTURE_PORTAL) {
        return false;
      }
      if (!isWalkableStructure(structure)) {
        return false;
      }
    }
  }

  for (const site of roomContext.getConstructionSites()) {
    if (site.pos.x === pos.x && site.pos.y === pos.y && site.my && !isWalkableConstructionSite(site)) {
      return false;
    }
  }

  return true;
}

// ─── Exit recovery ────────────────────────────────────────────────────────────

export function moveOffExit(
  creep: AnyCreep,
  avoidSwamp = true,
  acceptStep?: (direction: DirectionConstant, pos: RoomPosition) => boolean,
): ScreepsReturnCode {
  let swampDirection: DirectionConstant | undefined;

  for (const direction of [TOP, RIGHT, BOTTOM, LEFT, TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT, TOP_LEFT] as DirectionConstant[]) {
    const pos = getPositionAtDirection(creep.pos, direction);
    if (!pos || isExitTile(pos) || !isYieldTileWalkable(pos, creep)) {
      continue;
    }
    if (findMyOwnedUnitAt(pos, creep)) {
      continue;
    }

    if (acceptStep && !acceptStep(direction, pos)) continue;

    const terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
    if (avoidSwamp && terrain === TERRAIN_MASK_SWAMP) {
      swampDirection = direction;
      continue;
    }

    return issueMove(creep, direction);
  }

  if (swampDirection) {
    return issueMove(creep, swampDirection);
  }

  return ERR_NO_PATH;
}
