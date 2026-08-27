import { measureCreepPathing } from "@/runtime/cpuPhaseProfiler";
import { clearCreepMovementState, ensureCreepMovementState } from "@/movement/creepState";
import { recordMovementMetric } from "@/movement/metrics";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";
import { isPositionAllowedForCreep, shouldRestrictToSafeZone } from "@/runtime/safeZoneHelpers";
import {
  getPosKey,
  getTargetPos,
  isExitTile,
  isStandardCreep,
  isWalkableConstructionSite,
  isWalkableStructure,
} from "@/movement/common";
import { moveOffExit, moveToAdjacentPosition } from "@/movement/traffic";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";
import type { MovePathState, MoveToTargetOptions, RoomCostMatrixCacheEntry, WorkAnchor } from "@/movement/types";

const MOVE_PATH_CACHE_TTL = 20;
// 单次 ERR_BUSY 只累计 soft-stuck；连续多个 tick 无位置进展才重新寻路。
const PATH_STUCK_REPATH_THRESHOLD = 3;
const roomBaseCostMatrixCache = new Map<string, RoomCostMatrixCacheEntry>();
// 指纹正常情况下覆盖所有拓扑变化，TTL 仅作为指纹碰撞/漏检的兜底。
const ROOM_BASE_COST_MATRIX_CACHE_TTL = 100;
const ROOM_BASE_COST_MATRIX_CACHE_MAX = 100;
// 仅供测试观测缓存重建次数，生产路径不读取。
let roomBaseCostMatrixBuildCount = 0;

export function clearMovementState(creep: Creep): void {
  recordMovementMetric("stateClears", creep.room.name);
  clearCreepMovementState(creep.name);
  delete creep.memory._move;
}

export function moveToTarget(
  creep: AnyCreep,
  target: RoomPosition | { pos: RoomPosition },
  range: 0 | 1 | 2 | 3 = 1,
  options: MoveToTargetOptions = {},
): ScreepsReturnCode {
  const room = creep.room;
  if (!room) {
    return ERR_INVALID_TARGET;
  }
  recordMovementMetric("pathRequests", room.name);

  const movementState = ensureCreepMovementState(creep);

  if (movementState.movementPushedAt === Game.time) {
    return OK;
  }

  const targetPos = getTargetPos(target);

  if (room.name !== targetPos.roomName) {
    delete movementState.movePathState;
    return ERR_INVALID_TARGET;
  }

  if (creep.pos.getRangeTo(targetPos) <= range) {
    delete movementState.movePathState;
    return OK;
  }

  if (isStandardCreep(creep) && shouldRestrictToSafeZone(creep) && !isPositionAllowedForCreep(creep, targetPos)) {
    delete movementState.movePathState;
    return ERR_NO_PATH;
  }

  movementState.pathingRequestedAt = Game.time;

  if (sameRoomNonEdgeMoveNeedsExitRecovery(creep, targetPos)) {
    recordMovementMetric("exitRecoveries", room.name);
    const exitRecoveryCode = moveOffExit(creep);
    if (exitRecoveryCode === OK || exitRecoveryCode === ERR_TIRED) {
      return exitRecoveryCode;
    }
  }

  const reusePath = options.reusePath ?? 5;
  // 卡死恢复：连续无进展达到阈值后强制绕开 creep 重新寻路（与跨房 travel 的
  // stuckTicks>=2 → ignoreCreeps:false 策略一致）。判定用"上一 tick 结束时的
  // stuckTicks + 本次无进展即达阈值"的先行式：若本次实际恢复了位置，最多多
  // 一次带 creep 避让的重寻路，语义不受影响。
  const cachedState = movementState.movePathState;
  const stuckNeedsRepath = !!cachedState && cachedState.stuckTicks + 1 >= PATH_STUCK_REPATH_THRESHOLD;
  const ignoreCreeps = stuckNeedsRepath ? false : options.ignoreCreeps ?? true;
  // costCallback without cacheKey disables path caching to avoid stale safe-zone paths
  const noCacheReuse = !!options.costCallback && !options.cacheKey;
  const movePathKey = `${room.name}:${targetPos.roomName}:${targetPos.x}:${targetPos.y}:r${range}:i${
    ignoreCreeps ? 1 : 0
  }:s${options.swampCost ?? "d"}:p${options.plainCost ?? "d"}:m${options.maxRooms ?? "d"}:e${options.avoidExitTiles ? 1 : 0}:sc${
    options.allowSourceContainerTarget ? 1 : 0
  }:c${options.cacheKey ?? ""}`;

  {
    const currentPosKey = getPosKey(creep.pos);
    const movePathState = movementState.movePathState;
    const canReuse = !noCacheReuse;
    const isMatchingState =
      canReuse &&
      movePathState &&
      movePathState.key === movePathKey &&
      movePathState.targetRoom === targetPos.roomName &&
      movePathState.targetX === targetPos.x &&
      movePathState.targetY === targetPos.y &&
      movePathState.range === range &&
      movePathState.expiresAt > Game.time;

    if (isMatchingState && movePathState && movePathState.steps.length > 0) {
      if (movePathState.lastPosKey === currentPosKey && (!isStandardCreep(creep) || creep.fatigue === 0)) {
        movePathState.stuckTicks += 1;
      } else {
        movePathState.stuckTicks = 0;
      }
      movePathState.lastPosKey = currentPosKey;

      if (movePathState.stuckTicks >= PATH_STUCK_REPATH_THRESHOLD) {
        // 位置连续多 tick 无进展：路径视为失效，落入下方重新寻路（ignoreCreeps 已被强制为 false）。
        delete movementState.movePathState;
      } else {
        const cachedMoveCode = followStoredRoomPath(creep, movePathState, targetPos, range);
        if (cachedMoveCode === OK || cachedMoveCode === ERR_TIRED || cachedMoveCode === ERR_BUSY) {
          recordMovementMetric("pathCacheHits", room.name);
          return cachedMoveCode;
        }

        delete movementState.movePathState;
      }
    }

    recordMovementMetric("pathRepaths", room.name);

    const path = measureCreepPathing(() =>
      creep.pos.findPathTo(targetPos, {
        range,
        swampCost: options.swampCost,
        plainCost: options.plainCost,
        ignoreCreeps,
        maxRooms: options.maxRooms,
        costCallback: (roomName, matrix) => buildRoomCostMatrix(creep, room, roomName, matrix, options, targetPos),
      }),
    );

    if (path.length > 0) {
      const steps = path.map((step) => ({ x: step.x, y: step.y }));
      const currentPosKey2 = getPosKey(creep.pos);
      movementState.movePathState = {
        key: movePathKey,
        steps,
        cursor: -1,
        targetRoom: targetPos.roomName,
        targetX: targetPos.x,
        targetY: targetPos.y,
        range,
        lastPosKey: currentPosKey2,
        stuckTicks: 0,
        expiresAt: noCacheReuse ? Game.time : (reusePath === 0 ? Game.time : Game.time + Math.max(MOVE_PATH_CACHE_TTL, reusePath)),
      };

      const followPathCode = followStoredRoomPath(creep, movementState.movePathState, targetPos, range);
      if (followPathCode === OK || followPathCode === ERR_TIRED || followPathCode === ERR_BUSY) {
        return followPathCode;
      }

      delete movementState.movePathState;
    }
  }

  return ERR_NO_PATH;
}

export function moveToRemoteWorkTarget(creep: Creep, target: RoomPosition | { pos: RoomPosition }): ScreepsReturnCode {
  const targetPos = getTargetPos(target);
  const movementState = ensureCreepMovementState(creep.name);
  if (creep.pos.getRangeTo(targetPos) <= 3) {
    movementState.workAnchor = { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName, range: 3 } satisfies WorkAnchor;
    return OK;
  }

  delete movementState.workAnchor;
  return moveToTarget(creep, targetPos, 3, {
    swampCost: 8,
    reusePath: 5,
    ignoreCreeps: true,
  });
}

function sameRoomNonEdgeMoveNeedsExitRecovery(creep: AnyCreep, targetPos: RoomPosition): boolean {
  return creep.pos.roomName === targetPos.roomName && isExitTile(creep.pos) && !isExitTile(targetPos);
}

function buildRoomCostMatrix(
  creep: AnyCreep,
  creepRoom: Room,
  roomName: string,
  matrix: CostMatrix,
  options: MoveToTargetOptions,
  targetPos: RoomPosition,
): CostMatrix {
  if (roomName !== creepRoom.name) {
    return matrix;
  }

  const roomContext = getTickContextService().getRoomContext(creepRoom);
  if (!roomContext) {
    if (options.costCallback) {
      return options.costCallback(roomName, matrix);
    }
    return matrix;
  }

  // fallbackMatrix（引擎传入的矩阵）在 ignoreCreeps=false 时已被引擎写入当
  // 前 creep/PowerCreep 障碍，绝不能作为跨 tick 缓存的输入；静态矩阵完全由
  // 自行读取的 terrain + 结构/工地构成，动态 creep 障碍每 tick 在 clone 上叠加。
  const roomMatrix = getCachedRoomBaseCostMatrix(creepRoom, roomContext, options);

  if (options.avoidExitTiles) {
    applyExitTileAvoidance(roomMatrix, targetPos, roomName);
  }

  applySourceContainerPositionAvoidance(roomMatrix, roomName, targetPos, options);

  if (!(options.ignoreCreeps ?? true)) {
    for (const otherCreep of roomContext.getMyCreeps()) {
      if (otherCreep === creep) {
        continue;
      }
      roomMatrix.set(otherCreep.pos.x, otherCreep.pos.y, 0xfe);
    }
    for (const hostileCreep of roomContext.getHostileCreeps()) {
      roomMatrix.set(hostileCreep.pos.x, hostileCreep.pos.y, 0xfe);
    }
    for (const hostilePowerCreep of roomContext.getHostilePowerCreeps()) {
      roomMatrix.set(hostilePowerCreep.pos.x, hostilePowerCreep.pos.y, 0xfe);
    }
    for (const otherPowerCreep of Object.values(Game.powerCreeps || {})) {
      if (otherPowerCreep === creep || otherPowerCreep.ticksToLive == null || otherPowerCreep.room?.name !== roomName) {
        continue;
      }
      roomMatrix.set(otherPowerCreep.pos.x, otherPowerCreep.pos.y, 0xfe);
    }
  }

  if (options.costCallback && roomName === creepRoom.name) {
    return options.costCallback(roomName, roomMatrix);
  }

  return roomMatrix;
}

function applyExitTileAvoidance(matrix: CostMatrix, targetPos: RoomPosition, roomName: string): void {
  for (let index = 0; index < 50; index += 1) {
    blockExitTile(matrix, 0, index, targetPos, roomName);
    blockExitTile(matrix, 49, index, targetPos, roomName);
    blockExitTile(matrix, index, 0, targetPos, roomName);
    blockExitTile(matrix, index, 49, targetPos, roomName);
  }
}

function blockExitTile(matrix: CostMatrix, x: number, y: number, targetPos: RoomPosition, roomName: string): void {
  if (targetPos.roomName === roomName && targetPos.x === x && targetPos.y === y) {
    return;
  }

  matrix.set(x, y, 0xff);
}

function applySourceContainerPositionAvoidance(
  matrix: CostMatrix,
  roomName: string,
  targetPos: RoomPosition,
  options: MoveToTargetOptions,
): void {
  for (const pos of getSourceContainerPositionsForRoom(roomName)) {
    if (
      options.allowSourceContainerTarget &&
      targetPos.roomName === roomName &&
      targetPos.x === pos.x &&
      targetPos.y === pos.y
    ) {
      continue;
    }
    if (matrix.get(pos.x, pos.y) < 0xfe) {
      matrix.set(pos.x, pos.y, 0xfe);
    }
  }
}

function getCachedRoomBaseCostMatrix(
  room: Room,
  roomContext: ReturnType<ReturnType<typeof getTickContextService>["getRoomContext"]>,
  options: MoveToTargetOptions,
): CostMatrix {
  const plainCost = options.plainCost ?? 1;
  const swampCost = options.swampCost ?? 5;
  const cacheKey = `${room.name}:p${plainCost}:s${swampCost}`;
  // 拓扑指纹跨 tick 复用静态矩阵：结构/工地/RCL/planner 保存时间不变即命中，
  // 指纹变化或 TTL 到期才重建。矩阵只含静态信息（terrain 自行从
  // Game.map.getRoomTerrain 读取，与引擎 fallbackMatrix 完全隔离——后者在
  // ignoreCreeps=false 时被引擎写入当 tick 的 creep 障碍，缓存它会跨 tick
  // 污染 ignoreCreeps=true 的请求），creep 等动态障碍由调用方在 clone 上
  // 叠加，PathFinder 可能修改返回值，因此命中与新建都返回 clone，缓存原件
  // 永不外露。
  const revision = getRoomTopologyRevision(room.name);
  const cached = roomBaseCostMatrixCache.get(cacheKey);
  if (cached && cached.revision === revision && Game.time - cached.builtAt <= ROOM_BASE_COST_MATRIX_CACHE_TTL) {
    return cached.matrix.clone();
  }

  pruneRoomBaseCostMatrixCache();

  const baseMatrix = buildStaticTerrainMatrix(room.name);
  for (const structure of roomContext.getStructures()) {
    if (structure.structureType === STRUCTURE_ROAD) {
      if (baseMatrix.get(structure.pos.x, structure.pos.y) < 0xfe) {
        baseMatrix.set(structure.pos.x, structure.pos.y, 1);
      }
      continue;
    }

    if (!isWalkableStructure(structure)) {
      baseMatrix.set(structure.pos.x, structure.pos.y, 0xff);
    }
  }

  for (const site of roomContext.getConstructionSites()) {
    if (!site.my) {
      continue;
    }
    if (!isWalkableConstructionSite(site)) {
      baseMatrix.set(site.pos.x, site.pos.y, 0xff);
    } else if (site.structureType === STRUCTURE_ROAD && baseMatrix.get(site.pos.x, site.pos.y) < 0xfe) {
      baseMatrix.set(site.pos.x, site.pos.y, 1);
    }
  }

  roomBaseCostMatrixCache.set(cacheKey, {
    revision,
    builtAt: Game.time,
    matrix: baseMatrix,
  });
  roomBaseCostMatrixBuildCount += 1;
  return baseMatrix.clone();
}

function followStoredRoomPath(
  creep: AnyCreep,
  movePathState: MovePathState,
  targetPos: RoomPosition,
  range: 0 | 1 | 2 | 3,
): ScreepsReturnCode {
  if (creep.pos.getRangeTo(targetPos) <= range) {
    return OK;
  }

  const nextPos = getNextStoredPathStep(creep, movePathState);
  if (!nextPos) {
    delete ensureCreepMovementState(creep).movePathState;
    return ERR_NO_PATH;
  }

  // ERR_BUSY 是暂时性阻塞（对位换位/推动失败），保留路径交由 stuckTicks
  // 累计决定何时重新寻路；仅 ERR_NO_PATH 等真正失效才立即销毁。
  return moveToAdjacentPosition(creep, nextPos);
}

function getNextStoredPathStep(creep: AnyCreep, movePathState: MovePathState): RoomPosition | null {
  const steps = movePathState.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  // 正常前进时当前位置只会落在 cursor 或 cursor+1；被推离后先在小窗口内恢复，
  // 再回退全量扫描（窗口 miss 且 off-path 时才发生）。
  const cursor = Number.isInteger(movePathState.cursor) ? (movePathState.cursor as number) : -1;
  const windowEnd = Math.min(steps.length, cursor + 3);
  for (let index = Math.max(0, cursor); index < windowEnd; index += 1) {
    const step = steps[index];
    if (creep.pos.x === step.x && creep.pos.y === step.y) {
      movePathState.cursor = index;
      const nextStep = steps[index + 1];
      return nextStep ? new RoomPosition(nextStep.x, nextStep.y, creep.pos.roomName) : null;
    }
  }

  const exactIndex = steps.findIndex((step) => creep.pos.x === step.x && creep.pos.y === step.y);
  if (exactIndex >= 0) {
    movePathState.cursor = exactIndex;
    const nextStep = steps[exactIndex + 1];
    return nextStep ? new RoomPosition(nextStep.x, nextStep.y, creep.pos.roomName) : null;
  }

  let bestIndex = -1;
  let bestRange = Infinity;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const range = creep.pos.getRangeTo(step.x, step.y);
    if (range >= bestRange) {
      continue;
    }
    bestRange = range;
    bestIndex = index;
  }

  if (bestIndex < 0) {
    return null;
  }

  movePathState.cursor = bestIndex;
  const candidate = steps[bestIndex];
  if (bestRange <= 1) {
    return new RoomPosition(candidate.x, candidate.y, creep.pos.roomName);
  }

  const nextStep = steps[bestIndex + 1];
  if (!nextStep) {
    return new RoomPosition(candidate.x, candidate.y, creep.pos.roomName);
  }

  return new RoomPosition(nextStep.x, nextStep.y, creep.pos.roomName);
}

// 静态地形矩阵：wall 置 0xff，其余保持 0（0 表示沿用引擎的 plain/swamp
// 默认成本）。terrain 是房间不可变数据，因此该矩阵可安全跨 tick 缓存。
function buildStaticTerrainMatrix(roomName: string): CostMatrix {
  const matrix = new PathFinder.CostMatrix();
  const terrain = Game.map.getRoomTerrain(roomName);
  for (let y = 0; y < 50; y += 1) {
    for (let x = 0; x < 50; x += 1) {
      if (terrain.get(x, y) & TERRAIN_MASK_WALL) {
        matrix.set(x, y, 0xff);
      }
    }
  }
  return matrix;
}

function pruneRoomBaseCostMatrixCache(): void {  if (roomBaseCostMatrixCache.size === 0) {
    return;
  }

  for (const [key, entry] of roomBaseCostMatrixCache.entries()) {
    if (Game.time - entry.builtAt > ROOM_BASE_COST_MATRIX_CACHE_TTL) {
      roomBaseCostMatrixCache.delete(key);
    }
  }

  if (roomBaseCostMatrixCache.size <= ROOM_BASE_COST_MATRIX_CACHE_MAX) {
    return;
  }

  const oldestEntries = [...roomBaseCostMatrixCache.entries()].sort((left, right) => left[1].builtAt - right[1].builtAt);
  const overflow = roomBaseCostMatrixCache.size - ROOM_BASE_COST_MATRIX_CACHE_MAX;
  for (const [key] of oldestEntries.slice(0, overflow)) {
    roomBaseCostMatrixCache.delete(key);
  }
}

export function getRoomBaseCostMatrixCacheSizeForTest(): number {
  return roomBaseCostMatrixCache.size;
}

export function getRoomBaseCostMatrixBuildCountForTest(): number {
  return roomBaseCostMatrixBuildCount;
}

export function clearRoomBaseCostMatrixCacheForTest(): void {
  roomBaseCostMatrixCache.clear();
  roomBaseCostMatrixBuildCount = 0;
}
