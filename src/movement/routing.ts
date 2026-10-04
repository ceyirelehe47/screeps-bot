import { measureCreepPathing } from "@/runtime/cpuPhaseProfiler";
import { ensureCreepMovementState } from "@/movement/creepState";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";
import { getPosKey, isExitTile, parseEncodedRouteRooms } from "@/movement/common";
import { recordMovementMetric } from "@/movement/metrics";
import { buildRoomMovementMatrix, clearRoomBaseCostMatrixCacheForTest, getRoomStaticMatrix, moveToTarget } from "@/movement/pathing";
import { getMoveIntentDestination, issueMove, moveOffExit } from "@/movement/traffic";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";
import type {
  DynamicRouteCacheEntry,
  MoveToRoomOptions,
  MoveToTargetOptions,
  TravelState,
} from "@/movement/types";

const DYNAMIC_ROUTE_CACHE_TTL = 25;
const DYNAMIC_ROUTE_CACHE_MAX = 200;
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
  clearRoomBaseCostMatrixCacheForTest();
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

/** 行军协调器与单体执行器共享房间选择；有效的有序路线不重复调用原生findRoute。 */
export function getNextTravelRoom(currentRoom: string, targetRoom: string, encodedRouteRooms?: string, avoidRooms?: string[], routePurpose: "normal" | "combat" = "normal"): string | null {
  if (currentRoom === targetRoom) return currentRoom;
  const routeRooms = parseEncodedRouteRooms(encodedRouteRooms);
  const dangerousRooms = getDangerousRoomsForTarget(targetRoom, avoidRooms, routePurpose === "combat");
  if (routeRooms.length > 0) {
    const next = findOrderedRouteNextRoom(currentRoom, targetRoom, routeRooms, dangerousRooms)
      ?? findStrictRouteNextRoom(currentRoom, targetRoom, routeRooms, dangerousRooms)
      ?? findAdjacentAllowedRoom(currentRoom, targetRoom, routeRooms, dangerousRooms);
    if (next) return next;
  }
  return findDynamicNextRoom(currentRoom, targetRoom, getForwardPreferredRooms(currentRoom, routeRooms, targetRoom), dangerousRooms, routePurpose === "combat");
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
    delete movementState.movePathState;
    return OK;
  }

  const routeRooms = parseEncodedRouteRooms(encodedRouteRooms);
  const dangerousRooms = getDangerousRoomsForTarget(targetRoom, options.avoidRooms, options.routePurpose === "combat");
  const hasFixedRoute = routeRooms.length > 0;
  if (movementState.travelState?.targetRoom !== targetRoom) delete movementState.movePathState;
  const travelState = getTravelState(creep, targetRoom);
  delete travelState.multiRoomSegment;
  movementState.pathingRequestedAt = Game.time;
  const currentPosKey = getPosKey(creep.pos);
  const currentOnExit = isExitTile(creep.pos);
  const repeatedExitTransition = travelState.lastWasExit && currentOnExit && travelState.lastPosKey !== currentPosKey;
  if ((travelState.lastPosKey === currentPosKey || repeatedExitTransition) && creep.fatigue === 0 && movementState.stepPolicyWaitAt !== Game.time - 1) {
    travelState.stuckTicks += 1;
  } else {
    // 位置恢复移动（或疲劳恢复）：stuck 与完整搜索退避一并清零。
    if (travelState.stuckTicks !== 0) {
      travelState.stuckTicks = 0;
    }
    delete travelState.fullSearchBackoffUntil;
    delete travelState.fullSearchBackoffLevel;
    delete travelState.fullSearchSignature;
  }
  travelState.lastPosKey = currentPosKey;
  travelState.lastWasExit = currentOnExit;

  let nextRoom: string;
  if (hasFixedRoute) {
    const forwardPreferredRooms = getForwardPreferredRooms(creep.room.name, routeRooms, targetRoom);
    const orderedNextRoom = findOrderedRouteNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms);
    nextRoom =
      orderedNextRoom ??
      findStrictRouteNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms) ??
      findAdjacentAllowedRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms) ??
      creep.room.name;
    if (nextRoom === creep.room.name) {
      recordMovementMetric("travelFallbacks", creep.room.name);
      const recoveredNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, forwardPreferredRooms, dangerousRooms, options.routePurpose === "combat", options.allowSourceKeeperRooms, options.routeRoomCost, options.routePolicyKey, travelState.rejectedTransitions);
      nextRoom = recoveredNextRoom ?? creep.room.name;
      if (nextRoom === creep.room.name) {
        delete travelState.exitTarget;
        updateTravelState(creep, travelState);
        return ERR_NO_PATH;
      }
    }

    if (nextRoom !== targetRoom && dangerousRooms.includes(nextRoom)) {
      delete travelState.exitTarget;
      updateTravelState(creep, travelState);
      return ERR_NO_PATH;
    }
  } else {
    const dynamicNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms, options.routePurpose === "combat", options.allowSourceKeeperRooms, options.routeRoomCost, options.routePolicyKey, travelState.rejectedTransitions);
    nextRoom = dynamicNextRoom ?? creep.room.name;
    if (nextRoom === creep.room.name) {
      delete travelState.exitTarget;
      updateTravelState(creep, travelState);
      return ERR_NO_PATH;
    }
  }

  if (travelState.stuckTicks >= 2) {
    recordMovementMetric("travelRepaths", creep.room.name);
    const preferredRooms = hasFixedRoute
      ? getForwardPreferredRooms(creep.room.name, routeRooms, targetRoom)
      : routeRooms;
    const dynamicNextRoom = findDynamicNextRoom(creep.room.name, targetRoom, preferredRooms, dangerousRooms, options.routePurpose === "combat", options.allowSourceKeeperRooms, options.routeRoomCost, options.routePolicyKey, travelState.rejectedTransitions);
    if (dynamicNextRoom && dynamicNextRoom !== creep.room.name) {
      nextRoom = dynamicNextRoom;
    }
  }

  if ((travelState.rejectedTransitions?.[`${creep.room.name}->${nextRoom}`] ?? 0) > Game.time) {
    const fallback = findDynamicNextRoom(creep.room.name, targetRoom, routeRooms, dangerousRooms, options.routePurpose === "combat",
      options.allowSourceKeeperRooms, options.routeRoomCost, options.routePolicyKey, travelState.rejectedTransitions);
    if (!fallback) { updateTravelState(creep, travelState); return ERR_NO_PATH; }
    nextRoom = fallback;
  }
  if (nextRoom !== targetRoom && dangerousRooms.includes(nextRoom)) {
    delete travelState.exitTarget;
    updateTravelState(creep, travelState);
    return ERR_NO_PATH;
  }

  // 跨房仅选择下一房与出口；房内步骤统一交给常驻 creep 的 pathing/traffic。
  const moveOptions: MoveToTargetOptions = {
    ...options,
    travelTargetRoom: targetRoom,
    maxRooms: 1,
    ignoreCreeps: travelState.stuckTicks >= 2 ? false : options.ignoreCreeps,
    reusePath: options.reusePath ?? 5,
    avoidExitTiles: true,
  };
  // 已确认的相邻房从地图出口直接取方向，避免findExitTo内部再跑findRoute。
  const exits = typeof Game.map.describeExits === "function" ? Game.map.describeExits(creep.room.name) : null;
  const directExit = Object.entries(exits ?? {}).find(([direction, room]) => room === nextRoom && [TOP, RIGHT, BOTTOM, LEFT].some((exit) => exit === Number(direction)));
  const closed = typeof Game.map.getRoomStatus === "function" && Game.map.getRoomStatus(nextRoom)?.status === "closed";
  const exitDirection = closed ? ERR_NO_PATH : directExit ? Number(directExit[0]) : creep.room.findExitTo(nextRoom);
  if (typeof exitDirection !== "number" || exitDirection < 1 || exitDirection > 8) {
    updateTravelState(creep, travelState);
    return ERR_NO_PATH;
  }
  if (isOnExitDirection(creep.pos, exitDirection as DirectionConstant)) {
    if (options.canMoveStep) {
      const destination = getMoveIntentDestination(creep.pos, exitDirection as DirectionConstant);
      if (!destination) return ERR_NO_PATH;
      if (!options.canMoveStep(new RoomPosition(destination.x, destination.y, destination.roomName))) {
        movementState.stepPolicyWaitAt = Game.time;
        updateTravelState(creep, travelState);
        return ERR_BUSY;
      }
      delete movementState.stepPolicyWaitAt;
    }
    const result = issueMove(creep, exitDirection as DirectionConstant);
    updateTravelState(creep, travelState);
    return result;
  }
  // 迁房入口0/49不可沿边等待；先用共用交通层离开错误边缘，再走房内出口路径。
  if (isExitTile(creep.pos)) {
    const result = moveOffExit(creep, true, (_direction, pos) => options.canMoveStep?.(pos) ?? true);
    updateTravelState(creep, travelState);
    return result;
  }
  const revision = getRoomTopologyRevision(creep.room.name);
  let exit = travelState.exitTarget;
  const key = JSON.stringify([creep.room.name, nextRoom, revision, moveOptions.ignoreCreeps ?? true,
    options.plainCost, options.swampCost, options.cacheKey]);
  if (!exit || exit.key !== key || exit.expiresAt <= Game.time || options.costCallback && !options.cacheKey) {
    const selectionOptions = { ...moveOptions, avoidExitTiles: false };
    const selectionMatrix = buildRoomMovementMatrix(creep, creep.room, creep.room.name, new PathFinder.CostMatrix(), selectionOptions, creep.pos);
    const exitPos = measureCreepPathing(() => creep.pos.findClosestByPath(exitDirection as ExitConstant, {
      ...selectionOptions,
      // 目标过滤与路径矩阵共享约束，禁止把危险出口当成可用目标再反复等下一步许可。
      filter: (position: RoomPosition) => selectionMatrix.get(position.x, position.y) < 255,
      costCallback: (roomName, matrix) => roomName === creep.room.name ? selectionMatrix.clone() : matrix,
    }));
    if (!exitPos || exitPos.roomName !== creep.room.name || !isOnExitDirection(exitPos, exitDirection as DirectionConstant)) {
      delete travelState.exitTarget;
      (travelState.rejectedTransitions ??= {})[`${creep.room.name}->${nextRoom}`] = Game.time + 20;
      updateTravelState(creep, travelState);
      return ERR_NO_PATH;
    }
    exit = { key, x: exitPos.x, y: exitPos.y, expiresAt: Game.time + 20 };
    travelState.exitTarget = exit;
  }
  const result = moveToTarget(creep, new RoomPosition(exit.x, exit.y, creep.room.name), 0, moveOptions);
  if (result === ERR_NO_PATH) delete travelState.exitTarget;
  updateTravelState(creep, travelState);
  return result;
}

// 殖民持久路径的算法版本：路径生成语义变化（本次修复 = 生成回调改为复用
// 引擎静态障碍矩阵）时递增，Memory 中旧版本生成的 cachedTravelPath 因 key
// 前缀失配而自然失效，随后由正常生命周期重新搜索覆盖。
export const COLONIZATION_TRAVEL_PATH_VERSION = 2;
// 持久路径生成失败或被运行时验证删除后的重试间隔：路径 search 的成本
// （maxOps 20000）远高于 findSafeRoute，节流窗口取更长，防止被真实阻断
// 的任务退化为每 tick 重搜。
export const COLONIZATION_TRAVEL_PATH_RETRY_INTERVAL = 20;

export function getColonizationTravelPathKey(sourceRoom: string, targetRoom: string, routeRooms: string[], dangerousRooms: string[]): string {
  const routePart = routeRooms.join(">");
  const dangerPart = [...new Set(dangerousRooms)].sort().join(">");
  return `v${COLONIZATION_TRAVEL_PATH_VERSION}:${sourceRoom}->${targetRoom}|r:${routePart}|d:${dangerPart}`;
}

// 跨房移动（buildMultiRoomTravelMatrix）与 colonization 持久路径生成
// （createTravelPathRoomCallback）共用的静态旅行矩阵：共用静态障碍层 +
// controller 周边回避 + source container 预留，按拓扑指纹跨 tick 复用。
// 返回缓存中的原矩阵，仅供只读检查；传给 PathFinder 前必须 clone。
export function getCachedStaticTravelMatrix(roomName: string): CostMatrix {
  const revision = getRoomTopologyRevision(roomName);
  let cached = travelMatrixCache.get(roomName);
  if (!cached || cached.revision !== revision || Game.time - cached.builtAt > TRAVEL_MATRIX_CACHE_TTL) {
    const room = Game.rooms[roomName];
    // 与单房移动共用同一套静态障碍语义（terrain wall / Source / Mineral /
    // Deposit / Controller / Portal / 不可通行结构与工地 / road 成本），
    // 跨房矩阵在此基础上叠加 controller 周边回避与 source container 预留。
    const matrix = getRoomStaticMatrix(roomName);
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
  } else {
    recordMovementMetric("staticMatrixCacheHits", roomName);
  }

  return cached.matrix;
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

function getTravelState(creep: Creep, targetRoom: string): TravelState {
  const memoryState = ensureCreepMovementState(creep.name).travelState;
  if (!memoryState || memoryState.targetRoom !== targetRoom) {
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

function getDangerousRoomsForTarget(targetRoom: string, additionalAvoidRooms?: string[], combat = false): string[] {
  const dangerousRooms = combat ? undefined : Memory.data?.colonization?.[targetRoom]?.dangerousRooms;
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
  dynamicNextRoomCache[cacheKey] = { nextRoom, expiresAt: Game.time + DYNAMIC_ROUTE_CACHE_TTL, computedAt: Game.time };
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

function hasHostileCombatPresence(room: Room, allowSourceKeepers = false): boolean {
  const roomContext = getTickContextService().getRoomContext(room);
  const hasHostileCombatCreep = (roomContext?.getHostileCreeps() || []).some(
    (creep) => !(allowSourceKeepers && creep.owner?.username === "Source Keeper") && (
      creep.getActiveBodyparts(ATTACK) > 0 ||
      creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      creep.getActiveBodyparts(HEAL) > 0),
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

function isVisibleRoomDangerous(roomName: string, allowSourceKeepers = false): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    return false;
  }
  if (hasHostileCombatPresence(room, allowSourceKeepers)) {
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

function isLiveTransitionRoomSafe(roomName: string, combat = false, allowSourceKeepers = false): boolean {
  if (liveRoomSafetyCacheTick !== Game.time) {
    liveRoomSafetyCacheTick = Game.time;
    liveRoomSafetyCache = {};
  }
  const key = (combat ? "combat:" : "") + (allowSourceKeepers ? "keepers:" : "") + roomName;
  const cached = liveRoomSafetyCache[key];
  if (cached !== undefined) {
    return cached;
  }
  const room = Game.rooms[roomName];
  const combatDanger = combat && room ? room.find(FIND_HOSTILE_CREEPS).some((creep) =>
    creep.getActiveBodyparts(ATTACK) > 0 || creep.getActiveBodyparts(RANGED_ATTACK) > 0 || creep.getActiveBodyparts(HEAL) > 0)
    || room.find(FIND_HOSTILE_POWER_CREEPS).length > 0
    || room.find(FIND_HOSTILE_STRUCTURES).some((structure) => structure.structureType === STRUCTURE_TOWER && (structure as StructureTower).store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST) : false;
  const safe = Game.map.getRoomStatus(roomName).status === "normal" && !(combat ? combatDanger : isVisibleRoomDangerous(roomName, allowSourceKeepers));
  liveRoomSafetyCache[key] = safe;
  return safe;
}

function findDynamicNextRoom(
  currentRoom: string,
  targetRoom: string,
  preferredRooms: string[],
  avoidRooms: string[],
  combat = false,
  allowSourceKeepers = false,
  routeRoomCost?: (roomName: string) => number,
  routePolicyKey?: string,
  rejectedTransitions?: Record<string, number>,
): string | null {
  for (const [edge, until] of Object.entries(rejectedTransitions ?? {})) if (until <= Game.time) delete rejectedTransitions![edge];
  const blockedEdges = Object.keys(rejectedTransitions ?? {}).sort();
  const cacheKey = buildDynamicRouteCacheKey(currentRoom, targetRoom, preferredRooms, avoidRooms) + (combat ? "|combat" : "") + (allowSourceKeepers ? "|keepers" : "") + (routeRoomCost ? `|policy:${routePolicyKey ?? ""}` : "") + `|edges:${blockedEdges.join(",")}`;
  const cacheable = !routeRoomCost || !!routePolicyKey;
  const cached = cacheable ? dynamicNextRoomCache[cacheKey] : undefined;
  const cachedSafe = cached?.nextRoom
    ? routeRoomCost ? Number.isFinite(routeRoomCost(cached.nextRoom)) : cached.nextRoom === targetRoom || isLiveTransitionRoomSafe(cached.nextRoom, combat, allowSourceKeepers)
    : cached?.computedAt === Game.time;
  if (cached && cached.expiresAt > Game.time && (!(combat || allowSourceKeepers || routeRoomCost) || cachedSafe)) {
    recordMovementMetric("dynamicRouteCacheHits");
    return cached.nextRoom;
  }

  const preferredSet = new Set(preferredRooms);
  const avoidSet = new Set(avoidRooms);
  const route = measureCreepPathing(() =>
    Game.map.findRoute(currentRoom, targetRoom, {
      routeCallback: (roomName, fromRoom) => {
        if ((rejectedTransitions?.[`${fromRoom}->${roomName}`] ?? 0) > Game.time) return Infinity;
        if (roomName === currentRoom || (!routeRoomCost && roomName === targetRoom)) {
          return 1;
        }
        if (avoidSet.has(roomName)) {
          return Infinity;
        }
        if (routeRoomCost) return routeRoomCost(roomName);
        if (!isLiveTransitionRoomSafe(roomName, combat, allowSourceKeepers)) {
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
    if (cacheable) setDynamicRouteCache(cacheKey, null);
    return null;
  }
  const nextRoom = route[0].room;
  if ((rejectedTransitions?.[`${currentRoom}->${nextRoom}`] ?? 0) > Game.time) return null;
  if (cacheable) setDynamicRouteCache(cacheKey, nextRoom);
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
