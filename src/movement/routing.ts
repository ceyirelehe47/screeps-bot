import { measureCreepIntent, measureCreepPathing } from "@/runtime/cpuPhaseProfiler";
import { ensureCreepMovementState } from "@/movement/creepState";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";
import { getPosKey, isExitTile, parseEncodedRouteRooms } from "@/movement/common";
import { recordMovementMetric } from "@/movement/metrics";
import { moveToTarget } from "@/movement/pathing";
import { moveOffExit, moveToAdjacentPosition } from "@/movement/traffic";
import {
  TERRAIN_ONLY_ROOM_MATRIX_SOURCES,
  buildStaticRoomCostMatrix,
  collectStaticRoomMatrixSources,
} from "@/movement/staticRoomMatrix";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";
import type {
  CachedTravelPath,
  DynamicRouteCacheEntry,
  MultiRoomTravelSegment,
  MoveToRoomOptions,
  MoveToTargetOptions,
  StoredRoomPosition,
  TravelState,
} from "@/movement/types";

const DYNAMIC_ROUTE_CACHE_TTL = 25;
const DYNAMIC_ROUTE_CACHE_MAX = 200;
const MULTI_ROOM_TRAVEL_MAX_OPS = 10000;
const MULTI_ROOM_SEGMENT_MIN_REUSE_TTL = 20;
const MULTI_ROOM_SEGMENT_MAX_REUSE_TTL = 50;
const MULTI_ROOM_SEGMENT_HARD_TTL = 150;
const MULTI_ROOM_SEGMENT_MAX_STEPS = 100;
const dynamicNextRoomCache: Record<string, DynamicRouteCacheEntry> = {};
let liveRoomSafetyCacheTick = -1;
let liveRoomSafetyCache: Record<string, boolean> = {};
// 跨房旅行矩阵的静态部分（共用静态障碍层 + source containers/controller
// 区域回避）按拓扑指纹跨 tick 复用：指纹（RCL/结构/工地折叠/Deposit 折叠/
// savedAt/远采容器）不变即命中；指纹变化或 TTL 到期重建。矩阵只含静态信息，
// PathFinder 可能修改 roomCallback 返回的矩阵，因此每次返回 clone 再叠加
// ignoreCreeps=false 时的 creep/PowerCreep 动态障碍。
const TRAVEL_MATRIX_CACHE_MAX = 64;
const TRAVEL_MATRIX_CACHE_TTL = 100;
const travelMatrixCache = new Map<
  string,
  { revision: string; builtAt: number; matrix: CostMatrix }
>();
// 仅供测试观测缓存重建次数，生产路径不读取。
let travelMatrixBuildCount = 0;

export function clearRoutingCachesForTest(): void {
  for (const key of Object.keys(dynamicNextRoomCache)) {
    delete dynamicNextRoomCache[key];
  }
  liveRoomSafetyCacheTick = -1;
  liveRoomSafetyCache = {};
  travelMatrixCache.clear();
  travelMatrixBuildCount = 0;
}

export function getTravelMatrixBuildCountForTest(): number {
  return travelMatrixBuildCount;
}

export function getCurrentColonizationRoute(targetRoom: string, fallbackEncodedRoute?: string): string | undefined {
  const task = Memory.data?.colonization?.[targetRoom];
  if (!task) {
    return fallbackEncodedRoute;
  }

  if (task.scoutSafe) {
    const routeRooms = task.scoutRouteRooms;
    if (routeRooms && routeRooms.length > 0) {
      return routeRooms.join("|");
    }
  }

  return fallbackEncodedRoute;
}

export function getCurrentScoutRoute(targetRoom: string, fallbackEncodedRoute?: string): string | undefined {
  const task = Memory.data?.colonization?.[targetRoom];
  if (!task) {
    return fallbackEncodedRoute;
  }

  const routeRooms = task.scoutRouteRooms;
  if (!routeRooms || routeRooms.length === 0) {
    return fallbackEncodedRoute;
  }

  return routeRooms.join("|");
}

export function moveToTargetRoom(
  creep: Creep,
  targetRoom: string,
  encodedRouteRooms?: string,
  options: MoveToRoomOptions = {},
): ScreepsReturnCode {
  recordMovementMetric("travelRequests", creep.room.name);
  const movementState = ensureCreepMovementState(creep.name);

  if (creep.room.name === targetRoom) {
    delete movementState.travelState;
    return OK;
  }

  const routeRooms = parseEncodedRouteRooms(encodedRouteRooms);
  const dangerousRooms = getDangerousRoomsForTarget(targetRoom, options.avoidRooms);
  const hasFixedRoute = routeRooms.length > 0;
  const travelState = getTravelState(creep, targetRoom);
  if (travelState.multiRoomSegment && travelState.multiRoomSegment.currentRoom !== creep.room.name) {
    invalidateMultiRoomSegment(travelState, creep.room.name);
  }
  movementState.pathingRequestedAt = Game.time;
  const currentPosKey = getPosKey(creep.pos);
  const currentOnExit = isExitTile(creep.pos);
  const repeatedExitTransition = travelState.lastWasExit && currentOnExit && travelState.lastPosKey !== currentPosKey;
  if ((travelState.lastPosKey === currentPosKey || repeatedExitTransition) && creep.fatigue === 0) {
    travelState.stuckTicks += 1;
  } else {
    travelState.stuckTicks = 0;
  }
  travelState.lastPosKey = currentPosKey;
  travelState.lastWasExit = currentOnExit;

  let nextRoom: string;
  if (hasFixedRoute) {
    const forwardPreferredRooms = getForwardPreferredRooms(creep.room.name, routeRooms, targetRoom);
    const orderedNextRoom = findOrderedRouteNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms);
    const strictNextRoom = findStrictRouteNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms);
    nextRoom =
      orderedNextRoom ??
      strictNextRoom ??
      findAdjacentAllowedRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms) ??
      creep.room.name;
    if (nextRoom === creep.room.name) {
      recordMovementMetric("travelFallbacks", creep.room.name);
      const recoveredNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, forwardPreferredRooms, dangerousRooms);
      nextRoom = recoveredNextRoom ?? creep.room.name;
      if (nextRoom === creep.room.name) {
        invalidateMultiRoomSegment(travelState, creep.room.name);
        updateTravelState(creep, travelState);
        return ERR_NO_PATH;
      }
    }

    if (nextRoom !== targetRoom && dangerousRooms.includes(nextRoom)) {
      invalidateMultiRoomSegment(travelState, creep.room.name);
      updateTravelState(creep, travelState);
      return ERR_NO_PATH;
    }
  } else {
    const dynamicNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms);
    nextRoom = dynamicNextRoom ?? creep.room.name;
    if (nextRoom === creep.room.name) {
      invalidateMultiRoomSegment(travelState, creep.room.name);
      updateTravelState(creep, travelState);
      return ERR_NO_PATH;
    }
  }

  if (travelState.stuckTicks >= 2) {
    recordMovementMetric("travelRepaths", creep.room.name);
    const preferredRooms = hasFixedRoute
      ? getForwardPreferredRooms(creep.room.name, routeRooms, targetRoom)
      : routeRooms;
    const dynamicNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, preferredRooms, dangerousRooms);
    if (dynamicNextRoom && dynamicNextRoom !== creep.room.name) {
      nextRoom = dynamicNextRoom;
    }
  }

  if (nextRoom !== targetRoom && dangerousRooms.includes(nextRoom)) {
    invalidateMultiRoomSegment(travelState, creep.room.name);
    updateTravelState(creep, travelState);
    return ERR_NO_PATH;
  }

  const moveRange = options.travelRange ?? 1;
  const moveOptions: MoveToTargetOptions = {
    swampCost: options.swampCost,
    plainCost: options.plainCost,
    reusePath: travelState.stuckTicks >= 2 ? 0 : options.reusePath ?? 5,
    maxRooms: options.maxRooms ?? Math.max(routeRooms.length + 1, 16),
    ignoreCreeps: travelState.stuckTicks >= 2 ? false : options.ignoreCreeps,
    avoidExitTiles: true,
  };

  const cachedTravelPath = getUsableCachedTravelPath(creep, targetRoom, routeRooms, dangerousRooms, hasFixedRoute);
  const segmentCachingEnabled = canCacheMultiRoomSegment(moveOptions);
  let multiRoomSegment: MultiRoomTravelSegment | null = null;

  let result: ScreepsReturnCode;
  if (nextRoom !== creep.room.name && (!hasFixedRoute || isAdjacentRoom(creep.room.name, nextRoom))) {
    const exitDirection = creep.room.findExitTo(nextRoom);
    if (typeof exitDirection === "number" && exitDirection >= 1 && exitDirection <= 8) {
      if (isOnExitDirection(creep.pos, exitDirection as DirectionConstant)) {
        multiRoomSegment = resolveMultiRoomSegmentForRequest(
          creep,
          travelState,
          segmentCachingEnabled,
          targetRoom,
          nextRoom,
          hasFixedRoute,
          routeRooms,
          dangerousRooms,
          moveRange,
          moveOptions,
        );
        if (multiRoomSegment) {
          const transition = getMultiRoomSegmentTransition(creep, multiRoomSegment, nextRoom);
          if (transition?.exitDirection === exitDirection) {
            const segmentResult = measureCreepIntent(() => creep.move(transition.moveDirection));
            if (isReusableSegmentMoveResult(segmentResult)) {
              recordMovementMetric("multiRoomSegmentHits", creep.room.name);
              renewMultiRoomSegment(multiRoomSegment);
            } else {
              invalidateMultiRoomSegment(travelState, creep.room.name);
              multiRoomSegment = null;
            }
            updateTravelState(creep, travelState);
            return segmentResult;
          }
          invalidateMultiRoomSegment(travelState, creep.room.name);
          multiRoomSegment = null;
        }
        result = measureCreepIntent(() => creep.move(exitDirection as DirectionConstant));
        updateTravelState(creep, travelState);
        return result;
      }

      if (isExitTile(creep.pos)) {
        recordMovementMetric("exitRecoveries", creep.room.name);
        result = moveOffExit(creep);
        if (result === OK || result === ERR_TIRED) {
          updateTravelState(creep, travelState);
          return result;
        }
      }

      if (cachedTravelPath && travelState.stuckTicks < 2) {
        const cachedPathResult = followCachedTravelPath(creep, travelState, cachedTravelPath);
        if (cachedPathResult === OK || cachedPathResult === ERR_TIRED) {
          invalidateMultiRoomSegment(travelState, creep.room.name);
          updateTravelState(creep, travelState);
          return cachedPathResult;
        }
      }

      multiRoomSegment = resolveMultiRoomSegmentForRequest(
        creep,
        travelState,
        segmentCachingEnabled,
        targetRoom,
        nextRoom,
        hasFixedRoute,
        routeRooms,
        dangerousRooms,
        moveRange,
        moveOptions,
      );
      if (multiRoomSegment) {
        const segmentResult = followMultiRoomSegment(creep, multiRoomSegment);
        if (isReusableSegmentMoveResult(segmentResult)) {
          recordMovementMetric("multiRoomSegmentHits", creep.room.name);
          renewMultiRoomSegment(multiRoomSegment);
          updateTravelState(creep, travelState);
          return segmentResult;
        }
        invalidateMultiRoomSegment(travelState, creep.room.name);
      }

      const multiRoomResult = moveAlongMultiRoomPath(
        creep,
        targetRoom,
        nextRoom,
        routeRooms,
        dangerousRooms,
        hasFixedRoute,
        moveRange,
        moveOptions,
        travelState,
      );
      if (multiRoomResult !== ERR_NO_PATH) {
        updateTravelState(creep, travelState);
        return multiRoomResult;
      }

      let exitPos = measureCreepPathing(() => creep.pos.findClosestByPath(exitDirection as ExitConstant));
      if (!exitPos) {
        const exitTiles = creep.room.find(exitDirection as ExitConstant);
        exitPos = creep.pos.findClosestByRange(exitTiles);
      }
      if (exitPos) {
        result = moveToTarget(creep, exitPos, 0, moveOptions);
        updateTravelState(creep, travelState);
        return result;
      }
    }
  }

  result = moveToTarget(creep, new RoomPosition(25, 25, nextRoom), moveRange, moveOptions);
  updateTravelState(creep, travelState);
  return result;
}

export function getColonizationTravelPathKey(sourceRoom: string, targetRoom: string, routeRooms: string[], dangerousRooms: string[]): string {
  const routePart = routeRooms.join(">");
  const dangerPart = [...new Set(dangerousRooms)].sort().join(">");
  return `${sourceRoom}->${targetRoom}|r:${routePart}|d:${dangerPart}`;
}

function buildMultiRoomSegmentKey(
  currentRoom: string,
  targetRoom: string,
  nextRoom: string,
  hasFixedRoute: boolean,
  routeRooms: string[],
  dangerousRooms: string[],
  travelRange: 1 | 3,
  options: MoveToTargetOptions,
): string {
  return JSON.stringify({
    currentRoom,
    targetRoom,
    nextRoom,
    mode: hasFixedRoute ? "fixed" : "dynamic",
    routeRooms,
    dangerousRooms: [...new Set(dangerousRooms)].sort(),
    travelRange,
    plainCost: canonicalNumberKey(options.plainCost, 1),
    swampCost: canonicalNumberKey(options.swampCost, 5),
    maxRooms: canonicalNumberKey(options.maxRooms, 16),
    ignoreCreeps: options.ignoreCreeps ?? true,
    reusePath: normalizeMultiRoomSegmentReusePath(options.reusePath),
  });
}

function canCacheMultiRoomSegment(options: MoveToTargetOptions): boolean {
  return normalizeMultiRoomSegmentReusePath(options.reusePath) > 0 && (options.ignoreCreeps ?? true);
}

function canonicalNumberKey(value: number | undefined, fallback: number): number | string {
  const resolved = value ?? fallback;
  if (Number.isFinite(resolved)) {
    return resolved;
  }
  if (Number.isNaN(resolved)) {
    return "NaN";
  }
  return resolved > 0 ? "+Infinity" : "-Infinity";
}

function normalizeMultiRoomSegmentReusePath(value: number | undefined): number {
  const resolved = value ?? 5;
  if (!Number.isFinite(resolved)) {
    return 5;
  }
  return Math.min(MULTI_ROOM_SEGMENT_MAX_REUSE_TTL, Math.max(0, Math.floor(resolved)));
}

function getMultiRoomSegmentReuseTtl(options: MoveToTargetOptions): number {
  return Math.max(MULTI_ROOM_SEGMENT_MIN_REUSE_TTL, normalizeMultiRoomSegmentReusePath(options.reusePath));
}

function resolveMultiRoomSegmentForRequest(
  creep: Creep,
  travelState: TravelState,
  segmentCachingEnabled: boolean,
  targetRoom: string,
  nextRoom: string,
  hasFixedRoute: boolean,
  routeRooms: string[],
  dangerousRooms: string[],
  travelRange: 1 | 3,
  options: MoveToTargetOptions,
): MultiRoomTravelSegment | null {
  if (!travelState.multiRoomSegment) {
    return null;
  }
  if (!segmentCachingEnabled) {
    invalidateMultiRoomSegment(travelState, creep.room.name);
    return null;
  }
  const key = buildMultiRoomSegmentKey(
    creep.room.name,
    targetRoom,
    nextRoom,
    hasFixedRoute,
    routeRooms,
    dangerousRooms,
    travelRange,
    options,
  );
  return getUsableMultiRoomSegment(creep, travelState, key, targetRoom);
}

function getUsableMultiRoomSegment(
  creep: Creep,
  travelState: TravelState,
  key: string,
  targetRoom: string,
): MultiRoomTravelSegment | null {
  const segment = travelState.multiRoomSegment;
  if (!segment) {
    return null;
  }

  if (
    travelState.stuckTicks >= 2 ||
    !Number.isInteger(segment.transitionIndex) ||
    !Number.isInteger(segment.cursor) ||
    !Number.isFinite(segment.reuseTtl) ||
    !Number.isFinite(segment.expiresAt) ||
    !Number.isFinite(segment.hardExpiresAt) ||
    segment.key !== key ||
    segment.currentRoom !== creep.room.name ||
    segment.expiresAt <= Game.time ||
    segment.hardExpiresAt <= Game.time ||
    !isMultiRoomSegmentLiveSafe(segment, targetRoom)
  ) {
    invalidateMultiRoomSegment(travelState, creep.room.name);
    return null;
  }

  return segment;
}

function renewMultiRoomSegment(segment: MultiRoomTravelSegment): void {
  segment.expiresAt = Math.min(segment.hardExpiresAt, Game.time + segment.reuseTtl);
}

function isMultiRoomSegmentLiveSafe(segment: MultiRoomTravelSegment, targetRoom: string): boolean {
  if (segment.transitionIndex === -1) {
    return true;
  }
  if (segment.transitionIndex <= 0 || segment.transitionIndex >= segment.positions.length) {
    return false;
  }
  const transitionOrigin = segment.positions[segment.transitionIndex - 1];
  const transitionStep = segment.positions[segment.transitionIndex];
  if (
    transitionOrigin.roomName !== segment.currentRoom ||
    transitionStep.roomName === segment.currentRoom ||
    !getValidatedRoomTransition(segment.currentRoom, transitionOrigin, transitionStep)
  ) {
    return false;
  }
  if (transitionStep.roomName === targetRoom) {
    return true;
  }
  return isLiveTransitionRoomSafe(transitionStep.roomName);
}

function invalidateMultiRoomSegment(travelState: TravelState, roomName: string): void {
  if (!travelState.multiRoomSegment) {
    return;
  }
  delete travelState.multiRoomSegment;
  recordMovementMetric("multiRoomSegmentInvalidations", roomName);
}

function getUsableCachedTravelPath(
  creep: Creep,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
  hasFixedRoute: boolean,
): CachedTravelPath | null {
  if (!hasFixedRoute || routeRooms.length === 0) {
    return null;
  }
  const task = Memory.data?.colonization?.[targetRoom];
  const cachedPath = task?.cachedTravelPath;
  if (!cachedPath || cachedPath.positions.length === 0) {
    return null;
  }
  if (cachedPath.key !== getColonizationTravelPathKey(cachedPath.sourceRoom, targetRoom, routeRooms, dangerousRooms)) {
    return null;
  }
  if (cachedPath.sourceRoom !== routeRooms[0] || cachedPath.targetRoom !== targetRoom) {
    return null;
  }
  if (cachedPath.routeRooms.join("|") !== routeRooms.join("|")) {
    return null;
  }
  if (!routeRooms.includes(creep.room.name)) {
    return null;
  }

  return cachedPath as CachedTravelPath;
}

function followCachedTravelPath(creep: Creep, travelState: TravelState, cachedPath: CachedTravelPath): ScreepsReturnCode {
  return followStoredTravelPositions(creep, travelState, cachedPath.positions);
}

function followMultiRoomSegment(creep: Creep, segment: MultiRoomTravelSegment): ScreepsReturnCode {
  const nextStep = getNextMultiRoomSegmentStep(creep.pos, segment);
  return nextStep ? followStoredTravelStep(creep, nextStep) : ERR_NO_PATH;
}

interface RoomTransition {
  exitDirection: DirectionConstant;
  moveDirection: DirectionConstant;
}

function getMultiRoomSegmentTransition(
  creep: Creep,
  segment: MultiRoomTravelSegment,
  expectedNextRoom: string,
): RoomTransition | null {
  const nextStep = getNextMultiRoomSegmentStep(creep.pos, segment);
  if (!nextStep || nextStep.roomName !== expectedNextRoom) {
    return null;
  }
  return getValidatedRoomTransition(creep.room.name, creep.pos, nextStep);
}

function followStoredTravelPositions(creep: Creep, travelState: TravelState, positions: StoredRoomPosition[]): ScreepsReturnCode {
  const nextStep = getNextCachedTravelPathStep(creep.pos, travelState, positions);
  return nextStep ? followStoredTravelStep(creep, nextStep) : ERR_NO_PATH;
}

function followStoredTravelStep(creep: Creep, nextStep: StoredRoomPosition): ScreepsReturnCode {
  if (nextStep.roomName !== creep.room.name) {
    const transition = getValidatedRoomTransition(creep.room.name, creep.pos, nextStep);
    if (!transition) {
      return ERR_NO_PATH;
    }
    return measureCreepIntent(() => creep.move(transition.moveDirection));
  }

  const nextPos = new RoomPosition(nextStep.x, nextStep.y, nextStep.roomName);
  if (creep.pos.getRangeTo(nextPos) > 1) {
    return ERR_NO_PATH;
  }

  return moveToAdjacentPosition(creep, nextPos);
}

function isReusableSegmentMoveResult(result: ScreepsReturnCode): boolean {
  return result === OK || result === ERR_TIRED || result === ERR_BUSY;
}

function getNextCachedTravelPathStep(
  pos: RoomPosition,
  travelState: TravelState,
  positions: StoredRoomPosition[],
): StoredRoomPosition | null {
  // colonization 缓存路径对象跨 creep 共享，游标存在 creep 自己的 travelState 中；
  // 正常前进只扫 cursor 窗口，未命中再回退全量扫描（推离/换房恢复）。
  const cursor = Number.isInteger(travelState.cachedPathCursor) ? (travelState.cachedPathCursor as number) : -1;
  const windowEnd = Math.min(positions.length, cursor + 3);
  for (let index = Math.max(0, cursor); index < windowEnd; index += 1) {
    const step = positions[index];
    if (step.roomName === pos.roomName && step.x === pos.x && step.y === pos.y) {
      travelState.cachedPathCursor = index;
      return positions[index + 1] ?? null;
    }
  }

  const exactIndex = positions.findIndex((step) => step.roomName === pos.roomName && step.x === pos.x && step.y === pos.y);
  if (exactIndex >= 0) {
    travelState.cachedPathCursor = exactIndex;
    return positions[exactIndex + 1] ?? null;
  }

  let bestIndex = -1;
  let bestRange = Infinity;
  for (let index = 0; index < positions.length; index += 1) {
    const step = positions[index];
    if (step.roomName !== pos.roomName) {
      continue;
    }
    const range = pos.getRangeTo(step.x, step.y);
    if (range >= bestRange) {
      continue;
    }
    bestRange = range;
    bestIndex = index;
  }

  return bestRange <= 1 && bestIndex >= 0 ? positions[bestIndex] : null;
}

function getNextMultiRoomSegmentStep(
  pos: RoomPosition,
  segment: MultiRoomTravelSegment,
): StoredRoomPosition | null {
  const positions = segment.positions;
  const exactStart = Math.max(0, segment.cursor);
  for (let index = exactStart; index < positions.length; index += 1) {
    const step = positions[index];
    if (step.roomName === pos.roomName && step.x === pos.x && step.y === pos.y) {
      segment.cursor = Math.max(segment.cursor, index);
      return positions[index + 1] ?? null;
    }
  }

  let bestIndex = -1;
  let bestRange = Infinity;
  for (let index = Math.max(0, segment.cursor + 1); index < positions.length; index += 1) {
    const step = positions[index];
    if (step.roomName !== pos.roomName) {
      continue;
    }
    const range = pos.getRangeTo(step.x, step.y);
    if (range >= bestRange) {
      continue;
    }
    bestRange = range;
    bestIndex = index;
  }
  return bestRange <= 1 && bestIndex >= 0 ? positions[bestIndex] : null;
}

function getRoomTransition(
  pos: Pick<RoomPosition, "x" | "y">,
  nextStep: Pick<StoredRoomPosition, "x" | "y">,
): RoomTransition | null {
  if (pos.x === 49 && nextStep.x === 0 && Math.abs(nextStep.y - pos.y) <= 1) {
    return {
      exitDirection: RIGHT,
      moveDirection: nextStep.y < pos.y ? TOP_RIGHT : nextStep.y > pos.y ? BOTTOM_RIGHT : RIGHT,
    };
  }
  if (pos.x === 0 && nextStep.x === 49 && Math.abs(nextStep.y - pos.y) <= 1) {
    return {
      exitDirection: LEFT,
      moveDirection: nextStep.y < pos.y ? TOP_LEFT : nextStep.y > pos.y ? BOTTOM_LEFT : LEFT,
    };
  }
  if (pos.y === 49 && nextStep.y === 0 && Math.abs(nextStep.x - pos.x) <= 1) {
    return {
      exitDirection: BOTTOM,
      moveDirection: nextStep.x < pos.x ? BOTTOM_LEFT : nextStep.x > pos.x ? BOTTOM_RIGHT : BOTTOM,
    };
  }
  if (pos.y === 0 && nextStep.y === 49 && Math.abs(nextStep.x - pos.x) <= 1) {
    return {
      exitDirection: TOP,
      moveDirection: nextStep.x < pos.x ? TOP_LEFT : nextStep.x > pos.x ? TOP_RIGHT : TOP,
    };
  }
  return null;
}

function getValidatedRoomTransition(
  currentRoom: string,
  pos: Pick<RoomPosition, "x" | "y">,
  nextStep: StoredRoomPosition,
): RoomTransition | null {
  const transition = getRoomTransition(pos, nextStep);
  if (!transition) {
    return null;
  }
  const exits = Game.map.describeExits(currentRoom);
  return exits?.[transition.exitDirection] === nextStep.roomName ? transition : null;
}

function moveAlongMultiRoomPath(
  creep: Creep,
  targetRoom: string,
  nextRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
  hasFixedRoute: boolean,
  range: 1 | 3,
  options: MoveToTargetOptions,
  travelState: TravelState,
): ScreepsReturnCode {
  const targetPos = new RoomPosition(25, 25, targetRoom);
  recordMovementMetric("multiRoomSearches", creep.room.name);
  const search = measureCreepPathing(() =>
    PathFinder.search(
      creep.pos,
      { pos: targetPos, range },
      {
        plainCost: options.plainCost,
        swampCost: options.swampCost,
        maxOps: MULTI_ROOM_TRAVEL_MAX_OPS,
        maxRooms: options.maxRooms ?? 16,
        roomCallback: createMultiRoomTravelCallback(creep, targetRoom, routeRooms, dangerousRooms, hasFixedRoute, options),
      },
    ),
  );

  if (search.incomplete || search.path.length === 0) {
    return ERR_NO_PATH;
  }

  const nextPos = search.path[0];
  if (nextPos.roomName !== creep.room.name || creep.pos.getRangeTo(nextPos) !== 1) {
    return ERR_NO_PATH;
  }

  if (canCacheMultiRoomSegment(options)) {
    const extracted = extractCurrentRoomSegment(search.path, creep.pos, nextRoom);
    if (extracted && extracted.positions.length > 0) {
      const reuseTtl = getMultiRoomSegmentReuseTtl(options);
      const segment: MultiRoomTravelSegment = {
        key: buildMultiRoomSegmentKey(
          creep.room.name,
          targetRoom,
          nextRoom,
          hasFixedRoute,
          routeRooms,
          dangerousRooms,
          range,
          options,
        ),
        currentRoom: creep.room.name,
        positions: extracted.positions,
        transitionIndex: extracted.transitionIndex,
        cursor: -1,
        reuseTtl,
        generatedAt: Game.time,
        expiresAt: Game.time + reuseTtl,
        hardExpiresAt: Game.time + MULTI_ROOM_SEGMENT_HARD_TTL,
      };
      if (isMultiRoomSegmentLiveSafe(segment, targetRoom)) {
        travelState.multiRoomSegment = segment;
      }
    }
  }

  return moveToAdjacentPosition(creep, nextPos);
}

interface ExtractedMultiRoomSegment {
  positions: StoredRoomPosition[];
  transitionIndex: number;
}

function extractCurrentRoomSegment(
  path: RoomPosition[],
  origin: RoomPosition,
  expectedNextRoom: string,
): ExtractedMultiRoomSegment | null {
  const currentRoom = origin.roomName;
  const positions: StoredRoomPosition[] = [];
  let transitionIndex = -1;
  let previous: Pick<RoomPosition, "x" | "y"> = origin;
  for (const step of path) {
    if (step.roomName === currentRoom) {
      const stepRange = Math.max(Math.abs(step.x - previous.x), Math.abs(step.y - previous.y));
      if (stepRange === 0 || stepRange > 1) {
        return null;
      }
      if (positions.length >= MULTI_ROOM_SEGMENT_MAX_STEPS) {
        return null;
      }
      positions.push({ x: step.x, y: step.y, roomName: step.roomName });
      previous = step;
      continue;
    }
    if (
      step.roomName === expectedNextRoom &&
      positions.length > 0 &&
      positions.length < MULTI_ROOM_SEGMENT_MAX_STEPS &&
      getValidatedRoomTransition(currentRoom, previous, { x: step.x, y: step.y, roomName: step.roomName })
    ) {
      transitionIndex = positions.length;
      positions.push({ x: step.x, y: step.y, roomName: step.roomName });
    } else {
      return null;
    }
    break;
  }
  return { positions, transitionIndex };
}

function createMultiRoomTravelCallback(
  creep: Creep,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
  hasFixedRoute: boolean,
  options: MoveToTargetOptions,
): (roomName: string) => boolean | CostMatrix {
  const dangerousSet = new Set(dangerousRooms);
  const allowedRooms = hasFixedRoute && routeRooms.length > 0 ? new Set([...routeRooms, creep.room.name, targetRoom]) : null;

  return (roomName: string): boolean | CostMatrix => {
    if (allowedRooms && !allowedRooms.has(roomName)) {
      return false;
    }
    if (roomName !== targetRoom && dangerousSet.has(roomName)) {
      return false;
    }
    if (roomName !== creep.room.name && roomName !== targetRoom) {
      if (!isLiveTransitionRoomSafe(roomName)) {
        return false;
      }
    }

    return buildMultiRoomTravelMatrix(creep, roomName, options);
  };
}

function buildMultiRoomTravelMatrix(creep: Creep, roomName: string, options: MoveToTargetOptions): CostMatrix {
  const revision = getRoomTopologyRevision(roomName);
  let cached = travelMatrixCache.get(roomName);
  if (!cached || cached.revision !== revision || Game.time - cached.builtAt > TRAVEL_MATRIX_CACHE_TTL) {
    const room = Game.rooms[roomName];
    // 与单房移动共用同一套静态障碍语义（terrain wall / Source / Mineral /
    // Deposit / Controller / Portal / 不可通行结构与工地 / road 成本），
    // 跨房矩阵在此基础上叠加 controller 周边回避与 source container 预留。
    const matrix = room
      ? buildStaticRoomCostMatrix(roomName, collectStaticRoomMatrixSources(room, getTickContextService().getRoomContext(room)))
      : buildStaticRoomCostMatrix(roomName, TERRAIN_ONLY_ROOM_MATRIX_SOURCES);
    if (room) {
      applyControllerZoneAvoidance(matrix, room);
      applySourceContainerAvoidance(matrix, roomName);
    }
    cached = { revision, builtAt: Game.time, matrix };
    travelMatrixBuildCount += 1;
    if (travelMatrixCache.size >= TRAVEL_MATRIX_CACHE_MAX) {
      // 淘汰最旧条目而不是全清，保住其余房间的跨 tick 命中。
      let oldestKey: string | null = null;
      let oldestBuiltAt = Infinity;
      for (const [key, entry] of travelMatrixCache.entries()) {
        if (entry.builtAt < oldestBuiltAt) {
          oldestBuiltAt = entry.builtAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) {
        travelMatrixCache.delete(oldestKey);
      }
    }
    travelMatrixCache.set(roomName, cached);
  }

  const result = cached.matrix.clone();
  if (options.ignoreCreeps ?? true) {
    return result;
  }

  return applyDynamicCreepObstacles(result, creep, roomName);
}

// controller 是我方时回避其周边区域，避免远行 creep 停在 controller 附近
// 堵塞升级位（跨房矩阵特有叠加，单房移动不含）。
function applyControllerZoneAvoidance(matrix: CostMatrix, room: Room): void {
  if (!room.controller?.my) {
    return;
  }
  const cPos = room.controller.pos;
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dy = -3; dy <= 3; dy += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 3) continue;
      const x = cPos.x + dx;
      const y = cPos.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (matrix.get(x, y) < 0xfe) {
        matrix.set(x, y, 0xfe);
      }
    }
  }
}

function applySourceContainerAvoidance(matrix: CostMatrix, roomName: string): void {
  for (const pos of getSourceContainerPositionsForRoom(roomName)) {
    if (matrix.get(pos.x, pos.y) < 0xfe) {
      matrix.set(pos.x, pos.y, 0xfe);
    }
  }
}

// ignoreCreeps=false：在 clone 上叠加当 tick全部动态障碍——己方/敌方普通
// creep 与己方/敌方 PowerCreep。缓存中的静态矩阵绝不携带这些值，creep
// 消失后下一 tick 的 clone 自动恢复正确静态成本。
function applyDynamicCreepObstacles(matrix: CostMatrix, creep: Creep, roomName: string): CostMatrix {
  const room = Game.rooms[roomName];
  if (!room) {
    return matrix;
  }
  const roomContext = getTickContextService().getRoomContext(room);

  const myCreeps = roomContext?.getMyCreeps() ?? room.find(FIND_MY_CREEPS);
  for (const otherCreep of myCreeps) {
    if (otherCreep.name !== creep.name) {
      matrix.set(otherCreep.pos.x, otherCreep.pos.y, 0xfe);
    }
  }

  const hostileCreeps = roomContext?.getHostileCreeps() ?? room.find(FIND_HOSTILE_CREEPS);
  for (const hostileCreep of hostileCreeps) {
    matrix.set(hostileCreep.pos.x, hostileCreep.pos.y, 0xfe);
  }

  const hostilePowerCreeps = roomContext?.getHostilePowerCreeps() ?? room.find(FIND_HOSTILE_POWER_CREEPS);
  for (const hostilePowerCreep of hostilePowerCreeps) {
    matrix.set(hostilePowerCreep.pos.x, hostilePowerCreep.pos.y, 0xfe);
  }

  // Game.powerCreeps 只含己方 PowerCreep（敌方走 FIND_HOSTILE_POWER_CREEPS）。
  for (const otherPowerCreep of Object.values(Game.powerCreeps || {})) {
    if (otherPowerCreep.name === creep.name || otherPowerCreep.ticksToLive == null || otherPowerCreep.room?.name !== roomName) {
      continue;
    }
    matrix.set(otherPowerCreep.pos.x, otherPowerCreep.pos.y, 0xfe);
  }

  return matrix;
}

function getTravelState(creep: Creep, targetRoom: string): TravelState {
  const memoryState = ensureCreepMovementState(creep.name).travelState;
  if (!memoryState || memoryState.targetRoom !== targetRoom) {
    if (memoryState?.multiRoomSegment) {
      invalidateMultiRoomSegment(memoryState, creep.room.name);
    }
    return { targetRoom, stuckTicks: 0 };
  }
  return memoryState;
}

function isOnExitDirection(pos: RoomPosition, direction: DirectionConstant): boolean {
  switch (direction) {
    case TOP:
      return pos.y === 0;
    case RIGHT:
      return pos.x === 49;
    case BOTTOM:
      return pos.y === 49;
    case LEFT:
      return pos.x === 0;
    default:
      return false;
  }
}

function updateTravelState(creep: Creep, state: TravelState): void {
  ensureCreepMovementState(creep.name).travelState = state;
}

function getDangerousRoomsForTarget(targetRoom: string, additionalAvoidRooms?: string[]): string[] {
  const dangerousRooms = Memory.data?.colonization?.[targetRoom]?.dangerousRooms;
  const base = dangerousRooms && dangerousRooms.length > 0
    ? dangerousRooms.filter((roomName) => roomName !== targetRoom)
    : [];
  if (!additionalAvoidRooms || additionalAvoidRooms.length === 0) {
    return base;
  }
  const seen = new Set(base);
  for (const room of additionalAvoidRooms) {
    if (room !== targetRoom && !seen.has(room)) {
      seen.add(room);
      base.push(room);
    }
  }
  return base;
}

function buildDynamicRouteCacheKey(
  currentRoom: string,
  targetRoom: string,
  preferredRooms: string[],
  avoidRooms: string[],
): string {
  const preferredPart = preferredRooms.join(">");
  const avoidPart = [...new Set(avoidRooms)].sort().join(">");
  return `${currentRoom}->${targetRoom}|p:${preferredPart}|a:${avoidPart}`;
}

function setDynamicRouteCache(cacheKey: string, nextRoom: string | null): void {
  dynamicNextRoomCache[cacheKey] = { nextRoom, expiresAt: Game.time + DYNAMIC_ROUTE_CACHE_TTL };
  const keys = Object.keys(dynamicNextRoomCache);
  if (keys.length <= DYNAMIC_ROUTE_CACHE_MAX) {
    return;
  }
  for (const key of keys) {
    if (dynamicNextRoomCache[key].expiresAt <= Game.time) {
      delete dynamicNextRoomCache[key];
    }
  }
  const remainingKeys = Object.keys(dynamicNextRoomCache);
  if (remainingKeys.length <= DYNAMIC_ROUTE_CACHE_MAX) {
    return;
  }
  const removeCount = remainingKeys.length - DYNAMIC_ROUTE_CACHE_MAX;
  remainingKeys
    .sort((a, b) => dynamicNextRoomCache[a].expiresAt - dynamicNextRoomCache[b].expiresAt)
    .slice(0, removeCount)
    .forEach((key) => {
      delete dynamicNextRoomCache[key];
    });
}

function hasHostileCombatPresence(room: Room): boolean {
  const roomContext = getTickContextService().getRoomContext(room);
  const hasHostileCombatCreep = (roomContext?.getHostileCreeps() || []).some(
    (creep) =>
      creep.getActiveBodyparts(ATTACK) > 0 ||
      creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      creep.getActiveBodyparts(HEAL) > 0,
  );
  if (hasHostileCombatCreep) {
    return true;
  }
  if ((roomContext?.getHostilePowerCreeps() || []).length > 0) {
    return true;
  }
  return (roomContext?.getHostileStructures() || []).some(
    (structure) => structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  );
}

function isVisibleRoomDangerous(roomName: string): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    return false;
  }
  if (hasHostileCombatPresence(room)) {
    return true;
  }
  if (room.controller?.owner && !room.controller.my) {
    return true;
  }
  if (room.controller?.reservation && !room.controller.my) {
    const myUser = Object.values(Game.spawns)[0]?.owner.username || Object.values(Game.creeps)[0]?.owner.username;
    if (!myUser || room.controller.reservation.username !== myUser) {
      return true;
    }
  }
  return false;
}

function isLiveTransitionRoomSafe(roomName: string): boolean {
  if (liveRoomSafetyCacheTick !== Game.time) {
    liveRoomSafetyCacheTick = Game.time;
    liveRoomSafetyCache = {};
  }
  const cached = liveRoomSafetyCache[roomName];
  if (cached !== undefined) {
    return cached;
  }
  const safe = Game.map.getRoomStatus(roomName).status === "normal" && !isVisibleRoomDangerous(roomName);
  liveRoomSafetyCache[roomName] = safe;
  return safe;
}

function findDynamicNextRoom(
  currentRoom: string,
  targetRoom: string,
  preferredRooms: string[],
  avoidRooms: string[],
): string | null {
  const cacheKey = buildDynamicRouteCacheKey(currentRoom, targetRoom, preferredRooms, avoidRooms);
  const cached = dynamicNextRoomCache[cacheKey];
  if (cached && cached.expiresAt > Game.time) {
    return cached.nextRoom;
  }

  const preferredSet = new Set(preferredRooms);
  const avoidSet = new Set(avoidRooms);
  const route = measureCreepPathing(() =>
    Game.map.findRoute(currentRoom, targetRoom, {
      routeCallback: (roomName) => {
        if (roomName === currentRoom || roomName === targetRoom) {
          return 1;
        }
        if (avoidSet.has(roomName)) {
          return Infinity;
        }
        if (!isLiveTransitionRoomSafe(roomName)) {
          return Infinity;
        }
        if (preferredSet.has(roomName)) {
          return 1;
        }
        return 3;
      },
    }),
  );

  if (route === ERR_NO_PATH || route.length === 0) {
    setDynamicRouteCache(cacheKey, null);
    return null;
  }
  const nextRoom = route[0].room;
  setDynamicRouteCache(cacheKey, nextRoom);
  return nextRoom;
}

function findStrictRouteNextRoom(
  currentRoom: string,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
): string | null {
  if (routeRooms.length === 0) {
    return null;
  }
  const allowedRooms = new Set(routeRooms);
  const dangerousSet = new Set(dangerousRooms);
  allowedRooms.add(currentRoom);
  allowedRooms.add(targetRoom);
  const route = Game.map.findRoute(currentRoom, targetRoom, {
    routeCallback: (roomName) => {
      if (!allowedRooms.has(roomName)) {
        return Infinity;
      }
      if (roomName !== currentRoom && roomName !== targetRoom && dangerousSet.has(roomName)) {
        return Infinity;
      }
      return 1;
    },
  });
  if (route === ERR_NO_PATH || route.length === 0) {
    return null;
  }
  return route[0].room;
}

function findOrderedRouteNextRoom(
  currentRoom: string,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
): string | null {
  if (routeRooms.length === 0) {
    return null;
  }
  const currentIndex = routeRooms.lastIndexOf(currentRoom);
  if (currentIndex < 0) {
    return null;
  }
  const nextIndex = currentIndex + 1;
  if (nextIndex >= routeRooms.length) {
    return null;
  }
  const nextRoom = routeRooms[nextIndex];
  if (!isAdjacentRoom(currentRoom, nextRoom)) {
    return null;
  }
  if (nextRoom !== targetRoom && dangerousRooms.includes(nextRoom)) {
    return null;
  }
  return nextRoom;
}

function getForwardPreferredRooms(currentRoom: string, routeRooms: string[], targetRoom: string): string[] {
  if (routeRooms.length === 0) {
    return [targetRoom];
  }
  const currentIndex = routeRooms.lastIndexOf(currentRoom);
  if (currentIndex < 0) {
    return routeRooms;
  }
  const forward = routeRooms.slice(currentIndex + 1);
  return forward.length === 0 ? [targetRoom] : forward;
}

function isAdjacentRoom(fromRoom: string, toRoom: string): boolean {
  const exits = Game.map.describeExits(fromRoom);
  if (!exits) {
    return false;
  }
  return Object.values(exits).some((roomName) => roomName === toRoom);
}

function findAdjacentAllowedRoom(
  currentRoom: string,
  targetRoom: string,
  routeRooms: string[],
  dangerousRooms: string[],
): string | null {
  const exits = Game.map.describeExits(currentRoom);
  if (!exits) {
    return null;
  }
  const allowed = new Set(routeRooms);
  const dangerousSet = new Set(dangerousRooms);
  const currentIndex = routeRooms.lastIndexOf(currentRoom);
  allowed.add(targetRoom);

  const candidates = Object.values(exits).filter(
    (roomName): roomName is string => {
      if (!roomName || !allowed.has(roomName)) {
        return false;
      }
      if (roomName !== targetRoom && dangerousSet.has(roomName)) {
        return false;
      }
      if (currentIndex >= 0 && roomName !== targetRoom) {
        const candidateIndex = routeRooms.lastIndexOf(roomName);
        if (candidateIndex >= 0 && candidateIndex <= currentIndex) {
          return false;
        }
      }
      return true;
    },
  );

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => Game.map.getRoomLinearDistance(a, targetRoom) - Game.map.getRoomLinearDistance(b, targetRoom));
  return candidates[0];
}
