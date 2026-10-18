import { readMatrixLayer, clearMatrixLayer, matrixLayerSize } from "@/movement/matrixCache";
import { applySourceContainerLayer, blockRoomExits } from "@/movement/matrixLayers";
import { searchMovementPath } from "@/movement/pathSearch";
import { resolveMoveProfile } from "@/movement/moveProfile";
import { measureCreepPathing } from "@/runtime/cpuPhaseProfiler";
import { clearCreepMovementState, ensureCreepMovementState } from "@/movement/creepState";
import { recordMovementMetric } from "@/movement/metrics";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";
import { getCreepDefenseRoomName, isPositionAllowedForCreep, shouldRestrictToSafeZone } from "@/runtime/safeZoneHelpers";
import { getSafeZone, getSafeZonePlanRevision } from "@/runtime/safeZone";
import { applySafeZoneLayer } from "@/movement/safeZoneLayer";
import { getPosKey, getTargetPos, isExitTile, isStandardCreep } from "@/movement/common";
import { getMoveIntentDestination, moveOffExit, moveToAdjacentPosition } from "@/movement/traffic";
import { buildStaticRoomCostMatrix, collectStaticRoomMatrixSources } from "@/movement/staticRoomMatrix";
import { resolveTerrainCosts } from "@/movement/terrainCosts";
import type { MovePathState, MoveToTargetOptions, WorkAnchor } from "@/movement/types";

// 单次 ERR_BUSY 只累计 soft-stuck；连续多个 tick 无位置进展才重新寻路。
const PATH_STUCK_REPATH_THRESHOLD = 3;
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

/** 搜索与执行共用安全区包装，避免出口选择遗漏完整路径约束。 */
export function resolveMovementPolicy(creep: AnyCreep, options: MoveToTargetOptions): MoveToTargetOptions {
  if (!isStandardCreep(creep) || !shouldRestrictToSafeZone(creep)) return options;
  const roomName = getCreepDefenseRoomName(creep), revision = getSafeZonePlanRevision(roomName);
  if (options.safeZone?.roomName === roomName && options.safeZone.revision === revision) return options;
  const zone = getSafeZone(roomName);
  return { ...options,
    cacheKey: options.costCallback && !options.cacheKey ? undefined : `${options.cacheKey ?? "base"}|sz:${roomName}:${revision}`,
    safeZone: { roomName, revision, zone },
    canMoveStep: pos => pos.roomName === roomName && zone.has(pos.x * 50 + pos.y) && (options.canMoveStep?.(pos) ?? true) };
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
  delete movementState.lastPathFailure;
  if (movementState.travelState?.targetRoom !== options.travelTargetRoom) {
    delete movementState.travelState;
  }

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
    movementState.lastPathFailure = { at: Game.time, reason: "policyDenied" };
    return ERR_NO_PATH;
  }

  movementState.pathingRequestedAt = Game.time;
  options = resolveMovementPolicy(creep, options);

  if (sameRoomNonEdgeMoveNeedsExitRecovery(creep, targetPos)) {
    recordMovementMetric("exitRecoveries", room.name);
    const exitRecoveryCode = moveOffExit(creep, true, (_direction, pos) => options.canMoveStep?.(pos) ?? true);
    if (exitRecoveryCode === OK || exitRecoveryCode === ERR_TIRED) {
      return exitRecoveryCode;
    }
  }

  const profile = resolveMoveProfile(options);
  const completeRequired = profile.completeness === "complete";
  const reusePath = profile.reusePath;
  const terrainCosts = resolveTerrainCosts(options);
  // 卡死恢复：连续无进展达到阈值后强制绕开 creep 重新寻路（与跨房 travel 的
  // stuckTicks>=2 → ignoreCreeps:false 策略一致）。判定用"上一 tick 结束时的
  // stuckTicks + 本次无进展即达阈值"的先行式：若本次实际恢复了位置，最多多
  // 一次带 creep 避让的重寻路，语义不受影响。
  const cachedState = movementState.movePathState;
  const policyWaiting = movementState.stepPolicyWaitAt === Game.time - 1;
  const stuckNeedsRepath = !policyWaiting && !!cachedState && cachedState.stuckTicks + 1 >= PATH_STUCK_REPATH_THRESHOLD;
  const ignoreCreeps = stuckNeedsRepath ? false : options.ignoreCreeps ?? true;
  // costCallback without cacheKey disables path caching to avoid stale safe-zone paths
  const noCacheReuse = !!options.costCallback && !options.cacheKey;
  const movePathKey = `${room.name}:${targetPos.roomName}:${targetPos.x}:${targetPos.y}:r${range}:i${
    ignoreCreeps ? 1 : 0
  }:s${terrainCosts.swampCost}:p${terrainCosts.plainCost}:m${options.maxRooms ?? "d"}:e${options.avoidExitTiles ? 1 : 0}:sc${
    options.allowSourceContainerTarget ? 1 : 0
  }:pt${options.allowPortalTarget ? 1 : 0}:full${completeRequired ? 1 : 0}:c${options.cacheKey ?? ""}:layout${getRoomTopologyRevision(room.name)}`;

  {
    const currentPosKey = getPosKey(creep.pos);
    const movePathState = movementState.movePathState;
    const canReuse = reusePath > 0 && !noCacheReuse && !options.verifiedPath;
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
      if (movePathState.observedAt !== Game.time) {
        if (!policyWaiting && movePathState.lastPosKey === currentPosKey && (!isStandardCreep(creep) || creep.fatigue === 0)) {
          movePathState.stuckTicks += 1;
        } else {
          movePathState.stuckTicks = 0;
        }
        movePathState.lastPosKey = currentPosKey;
        movePathState.observedAt = Game.time;
      }

      if (movePathState.stuckTicks >= PATH_STUCK_REPATH_THRESHOLD) {
        // 位置连续多 tick 无进展：路径视为失效，落入下方重新寻路（ignoreCreeps 已被强制为 false）。
        delete movementState.movePathState;
      } else {
        const cachedMoveCode = followStoredRoomPath(creep, movePathState, targetPos, range, options);
        if (cachedMoveCode === OK || cachedMoveCode === ERR_TIRED || cachedMoveCode === ERR_BUSY) {
          recordMovementMetric("pathCacheHits", room.name);
          return cachedMoveCode;
        }

        delete movementState.movePathState;
      }
    }

    recordMovementMetric("pathRepaths", room.name);

    const result = options.verifiedPath ? undefined : measureCreepPathing(() => searchMovementPath(creep.pos, { pos: targetPos, range }, {
      ...terrainCosts, maxRooms: options.maxRooms ?? 1, maxOps: profile.maxOps,
      roomCallback: roomName => roomName === room.name
        ? buildRoomMovementMatrix(creep, room, roomName, new PathFinder.CostMatrix(), { ...options, ignoreCreeps }, targetPos)
        : false,
    }));
    const path = options.verifiedPath ?? result!.path;
    const failureReason = result?.reason === "budgetExhausted" ? "budgetExhausted" :
      options.safeZone ? "policyDenied" : ignoreCreeps ? "staticBlocked" : "dynamicBlocked";
    if (result?.incomplete && completeRequired) {
      delete movementState.movePathState;
      movementState.lastPathFailure = { at: Game.time, reason: failureReason };
      if (result.reason === "budgetExhausted") movementState.stepPolicyWaitAt = Game.time;
      return result.reason === "budgetExhausted" ? ERR_BUSY : ERR_NO_PATH;
    }

    const end = path[path.length - 1];
    if (end && !completeRequired && !options.verifiedPath &&
        Math.max(Math.abs(end.x - targetPos.x), Math.abs(end.y - targetPos.y)) > range) {
      recordMovementMetric("pathPartialPaths", room.name);
    }
    // 普通旅行保留局部进展；只有显式战斗证明或已验证路径必须完整抵达 range。
    if (!end || ((completeRequired || options.verifiedPath) &&
        Math.max(Math.abs(end.x - targetPos.x), Math.abs(end.y - targetPos.y)) > range)) {
      delete movementState.movePathState;
      movementState.lastPathFailure = { at: Game.time, reason: result?.incomplete ? failureReason : "invalidPath" };
      if (failureReason === "budgetExhausted") movementState.stepPolicyWaitAt = Game.time;
      return failureReason === "budgetExhausted" ? ERR_BUSY : ERR_NO_PATH;
    }
    if (options.verifiedPath) {
      let previous = creep.pos;
      for (const step of options.verifiedPath) {
        if (step.roomName !== room.name || Math.max(Math.abs(step.x - previous.x), Math.abs(step.y - previous.y)) !== 1) {
          delete movementState.movePathState;
          movementState.lastPathFailure = { at: Game.time, reason: "invalidPath" };
          return ERR_NO_PATH;
        }
        previous = new RoomPosition(step.x, step.y, step.roomName);
      }
    }
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
        observedAt: Game.time,
        stuckTicks: 0,
        expiresAt: noCacheReuse || reusePath === 0 ? Game.time : Game.time + (
          Math.max(Math.abs(end.x - targetPos.x), Math.abs(end.y - targetPos.y)) > range ? Math.min(profile.partialTtl, reusePath) : reusePath),
      };

      const followPathCode = followStoredRoomPath(creep, movementState.movePathState, targetPos, range, options);
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

export function buildRoomMovementMatrix(
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
    return applySafeZoneLayer(options.costCallback?.(roomName, matrix) ?? matrix, options.safeZone);
  }

  // fallbackMatrix（引擎传入的矩阵）在 ignoreCreeps=false 时已被引擎写入当
  // 前 creep/PowerCreep 障碍，绝不能作为跨 tick 缓存的输入；静态矩阵完全由
  // 自行读取的 terrain + 自然对象（Source/Mineral/Deposit/Controller）+
  // 结构/工地构成，动态 creep 障碍每 tick 在 clone 上叠加。
  const roomMatrix = getRoomStaticMatrix(creepRoom.name);

  if (options.allowPortalTarget && targetPos.roomName === roomName) {
    // Portal 按引擎默认语义在静态层置 0xff；显式以 Portal 为目标（range=0
    // 踏上传送门）时豁免目标格，0 = 恢复引擎默认地形成本。豁免只作用于
    // 返回的 clone，不污染静态缓存。
    roomMatrix.set(targetPos.x, targetPos.y, 0);
  }

  if (options.avoidExitTiles) {
    blockRoomExits(roomMatrix, targetPos.roomName === roomName ? [targetPos] : []);
  }

  applySourceContainerLayer(roomMatrix, roomName, options.allowSourceContainerTarget ? targetPos : undefined);

  if (!(options.ignoreCreeps ?? true)) applyMovementCreepObstacles(roomMatrix, creep, roomName);

  const result = options.costCallback?.(roomName, roomMatrix) ?? roomMatrix;
  const layerKey = (options.ignoreCreeps ?? true) && !options.costCallback ? JSON.stringify([
    roomName, getRoomTopologyRevision(roomName), targetPos.x, targetPos.y,
    options.allowPortalTarget, options.allowSourceContainerTarget, options.avoidExitTiles,
  ]) : undefined;
  return applySafeZoneLayer(result, options.safeZone, layerKey);
}


export function getRoomStaticMatrix(roomName: string): CostMatrix {
  const room = Game.rooms[roomName];
  if (!room) return buildStaticRoomCostMatrix(roomName, {
    structures: [], constructionSites: [], sources: [], minerals: [], deposits: [], controller: undefined,
  });
  const roomContext = getTickContextService().getRoomContext(room);
  const result = readMatrixLayer("static", roomName, getRoomTopologyRevision(roomName),
    () => buildStaticRoomCostMatrix(roomName, collectStaticRoomMatrixSources(room, roomContext)),
    ROOM_BASE_COST_MATRIX_CACHE_MAX, ROOM_BASE_COST_MATRIX_CACHE_TTL);
  if (result.built) roomBaseCostMatrixBuildCount++;
  else recordMovementMetric("staticMatrixCacheHits", roomName);
  return result.matrix;
}

/** 房内、跨房和卡路重寻路使用相同动态障碍层，不写入静态缓存。 */
export function applyMovementCreepObstacles(matrix: CostMatrix, creep: AnyCreep, roomName: string): CostMatrix {
  const room = Game.rooms[roomName];
  if (!room) return matrix;
  const context = getTickContextService().getRoomContext(room);
  const units: AnyCreep[] = [
    ...(context?.getMyCreeps() ?? room.find(FIND_MY_CREEPS)),
    ...(context?.getHostileCreeps() ?? room.find(FIND_HOSTILE_CREEPS)),
    ...(context?.getHostilePowerCreeps() ?? room.find(FIND_HOSTILE_POWER_CREEPS)),
    ...Object.values(Game.powerCreeps || {}).filter(unit => unit.ticksToLive != null && unit.room?.name === roomName),
  ];
  for (const unit of units) {
    if (unit !== creep) matrix.set(unit.pos.x, unit.pos.y, Math.max(matrix.get(unit.pos.x, unit.pos.y), 0xfe));
  }
  return matrix;
}

function followStoredRoomPath(
  creep: AnyCreep,
  movePathState: MovePathState,
  targetPos: RoomPosition,
  range: 0 | 1 | 2 | 3,
  options: MoveToTargetOptions,
): ScreepsReturnCode {
  if (creep.pos.getRangeTo(targetPos) <= range) {
    return OK;
  }

  const nextPos = getNextStoredPathStep(creep, movePathState);
  if (!nextPos) {
    delete ensureCreepMovementState(creep).movePathState;
    return ERR_NO_PATH;
  }
  if (options.canMoveStep) {
    const destination = getMoveIntentDestination(creep.pos, creep.pos.getDirectionTo(nextPos));
    if (!destination) return ERR_NO_PATH;
    if (!options.canMoveStep(new RoomPosition(destination.x, destination.y, destination.roomName))) {
      ensureCreepMovementState(creep).stepPolicyWaitAt = Game.time;
      return ERR_BUSY;
    }
    delete ensureCreepMovementState(creep).stepPolicyWaitAt;
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


export function getRoomBaseCostMatrixCacheSizeForTest(): number {
  return matrixLayerSize("static");
}

export function getRoomBaseCostMatrixBuildCountForTest(): number {
  return roomBaseCostMatrixBuildCount;
}

export function clearRoomBaseCostMatrixCacheForTest(): void {
  clearMatrixLayer("static");
  roomBaseCostMatrixBuildCount = 0;
}
