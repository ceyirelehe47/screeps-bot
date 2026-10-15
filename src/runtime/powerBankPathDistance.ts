import { getCachedStaticTravelMatrix } from "@/movement/routing";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";
import { getTickContextService } from "@/runtime/runtimeServices";
import type { PowerBankTierProfile } from "@/runtime/powerBankViability";
import { hasPlanningCpuHeadroom } from "@/runtime/planningCpuBudget";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";

const CACHE_LIMIT = 64;
const CACHE_TTL = 100;
const RETRY_TICKS = 5;
const MAX_ROUTE_ROOMS = 16;
const MAX_MEASUREMENTS_PER_TICK = 1;
const MAX_SEARCHES_PER_TICK = 3;
const SEARCH_MAX_OPS = 6_000;
const ALGORITHM_REVISION = "power-bank-static-travel-v1";

export interface PowerBankTravelMeasurementInput {
  sourceSpawnPos: RoomPosition;
  bankPos: RoomPosition;
  returnTargetPos: RoomPosition;
  routeRooms: readonly string[];
  avoidRooms: readonly string[];
  profile: PowerBankTierProfile;
  haulerCarryParts: number;
}

export type PowerBankTravelMeasurementResult =
  | {
      status: "ready";
      pathDistance: number;
      combatTravelTicks: number;
      haulerOutboundTravelTicks: number;
      haulerReturnTravelTicks: number;
    }
  | { status: "pending"; reason: string; retryAt: number };

interface CacheEntry {
  expiresAt: number;
  worldKey: string;
  result: PowerBankTravelMeasurementResult;
}

interface MovementBody {
  weight: number;
  moves: number;
}

const measurements = new Map<string, CacheEntry>();
let budgetTick = -1;
let budgetGame: Game | undefined;
let measurementsThisTick = 0;
let searchesThisTick = 0;

function roomCoordinates(roomName: string): { x: number; y: number } | undefined {
  const match = /^([EW])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) return undefined;
  const x = Number(match[2]);
  const y = Number(match[4]);
  const maximum = Math.floor(Number.MAX_SAFE_INTEGER / 50) - 1;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x > maximum || y > maximum) return undefined;
  return {
    x: match[1] === "E" ? x : -x - 1,
    y: match[3] === "S" ? y : -y - 1,
  };
}

function validPosition(pos: RoomPosition): boolean {
  return Boolean(pos && typeof pos.roomName === "string" && roomCoordinates(pos.roomName) &&
    Number.isSafeInteger(pos.x) && pos.x >= 0 && pos.x <= 49 &&
    Number.isSafeInteger(pos.y) && pos.y >= 0 && pos.y <= 49);
}

function movementBody(body: readonly BodyPartConstant[]): MovementBody | undefined {
  if (!Array.isArray(body) || body.length === 0 || body.length > 50) return undefined;
  let moves = 0;
  let weight = 0;
  for (const part of body) {
    if (part === MOVE) moves += 1;
    else if (part !== CARRY) weight += 1;
  }
  return moves > 0 ? { weight, moves } : undefined;
}

function refreshBudget(): void {
  if (budgetTick !== Game.time || budgetGame !== Game) {
    budgetTick = Game.time;
    budgetGame = Game;
    measurementsThisTick = 0;
    searchesThisTick = 0;
  }
}

/** 只读本 tick 的新测量预算；不消耗配额，也不读取地图或路径缓存。 */
export function canMeasurePowerBankTravelThisTick(): boolean {
  refreshBudget();
  return measurementsThisTick < MAX_MEASUREMENTS_PER_TICK && searchesThisTick < MAX_SEARCHES_PER_TICK;
}

function pending(reason: string, retryTicks = RETRY_TICKS): PowerBankTravelMeasurementResult {
  return Object.freeze({ status: "pending", reason, retryAt: Game.time + retryTicks });
}

function remember(key: string, worldKey: string, result: PowerBankTravelMeasurementResult): PowerBankTravelMeasurementResult {
  measurements.delete(key);
  while (measurements.size >= CACHE_LIMIT) {
    const oldest = measurements.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    measurements.delete(oldest);
  }
  measurements.set(key, {
    expiresAt: result.status === "ready" ? Game.time + CACHE_TTL : result.retryAt,
    worldKey,
    result,
  });
  return result;
}

/**
 * 只测量静态地形/结构上的完整路径，不提交移动或改写 Memory。
 * 不可见中转房沿用 movement 的 terrain-only 矩阵；交通、编队等待及
 * pickup/transfer 的动作时间由调用者的既有 buffer 承接。
 */
export function measurePowerBankTravel(input: PowerBankTravelMeasurementInput): PowerBankTravelMeasurementResult {
  return measureSampledCpuPhase("measureTravel.total", () => measurePowerBankTravelImpl(input));
}

function measurePowerBankTravelImpl(input: PowerBankTravelMeasurementInput): PowerBankTravelMeasurementResult {
  const attacker = movementBody(input.profile?.attacker?.body);
  const healer = movementBody(input.profile?.healer?.body);
  if (measureSampledCpuPhase("inputValidation", () => !validPosition(input.sourceSpawnPos) || !validPosition(input.bankPos) || !validPosition(input.returnTargetPos) ||
    input.returnTargetPos.roomName !== input.sourceSpawnPos.roomName || !attacker || !healer ||
    !Number.isSafeInteger(input.haulerCarryParts) || input.haulerCarryParts < 1 || input.haulerCarryParts > 25 ||
    !Array.isArray(input.routeRooms) || input.routeRooms.length === 0 || input.routeRooms.length > MAX_ROUTE_ROOMS ||
    input.routeRooms[0] !== input.sourceSpawnPos.roomName ||
    input.routeRooms[input.routeRooms.length - 1] !== input.bankPos.roomName ||
    new Set(input.routeRooms).size !== input.routeRooms.length || !Array.isArray(input.avoidRooms) ||
    input.routeRooms.some((room) => typeof room !== "string" || !roomCoordinates(room)) ||
    input.avoidRooms.some((room) => typeof room !== "string" || !roomCoordinates(room)))) {
    return pending("invalid_input");
  }
  if (!Game.rooms[input.sourceSpawnPos.roomName] || !Game.rooms[input.bankPos.roomName]) {
    return pending("endpoint_not_visible");
  }
  const allowedRooms = new Set(input.routeRooms);
  const avoidedRooms = new Set(input.avoidRooms);
  const endpointRooms = new Set([input.sourceSpawnPos.roomName, input.bankPos.roomName]);
  if (input.routeRooms.some((room) => !endpointRooms.has(room) && avoidedRooms.has(room))) {
    return pending("unsafe_route");
  }
  let key: string;
  try {
    key = measureSampledCpuPhase("inputKey", () => JSON.stringify([
      ALGORITHM_REVISION,
      [input.sourceSpawnPos.roomName, input.sourceSpawnPos.x, input.sourceSpawnPos.y],
      [input.bankPos.roomName, input.bankPos.x, input.bankPos.y],
      [input.returnTargetPos.roomName, input.returnTargetPos.x, input.returnTargetPos.y],
      input.routeRooms,
      [...avoidedRooms].sort(),
      input.profile.tier,
      input.profile.attacker.body,
      input.profile.healer.body,
      input.haulerCarryParts,
    ]));
  } catch {
    return pending("route_observation_failed");
  }
  let cached = measureSampledCpuPhase("cacheLookup", () => {
    let cached = measurements.get(key);
    if (cached && Game.time >= cached.expiresAt) {
      measurements.delete(key);
      cached = undefined;
    }
    return cached;
  });
  if (cached?.result.status === "pending") {
    // 退避只表示尚无完整路径证据，不授权投入；中转房失去视野不应让
    // 同一失败输入反复抢走唯一测量名额。输入、端点和 avoid 门已校验。
    measurements.delete(key);
    measurements.set(key, cached);
    return cached.result;
  }
  const availableBudget = canMeasurePowerBankTravelThisTick();
  // 无既有证据且配额已用完时，不扫描其它候选的状态或拓扑。已知 ready 仍
  // 需要当次状态和几何校验；预算耗尽不能让 stale ready 绕过这些门。
  if (!cached && !availableBudget) return pending("budget", 1);

  const roomSafety = new Map<string, boolean>();
  const safeRoom = (roomName: string): boolean => {
    const room = Game.rooms[roomName];
    if (room?.controller?.owner && !room.controller.my) return false;
    if (!allowedRooms.has(roomName) || (!endpointRooms.has(roomName) && avoidedRooms.has(roomName))) return false;
    const cachedSafety = roomSafety.get(roomName);
    if (cachedSafety !== undefined) return cachedSafety;
    const status = Game.map.getRoomStatus(roomName);
    // novice/respawn 并不等于闭房；能否跨边界继续由安全 route 与 PF 地形
    // 屏障证明，不能仅因区域标签而拒绝同区域内可达路径。
    const safe = status != null && status.status !== "closed";
    roomSafety.set(roomName, safe);
    return safe;
  };
  let worldKey: string;
  try {
    if (measureSampledCpuPhase("worldProof", () => input.routeRooms.some((room) => !safeRoom(room)))) return pending("unsafe_route");
    worldKey = measureSampledCpuPhase("worldProof", () => JSON.stringify(input.routeRooms.map((room) => [room, Boolean(Game.rooms[room]), getRoomTopologyRevision(room)])));
  } catch {
    return pending("route_observation_failed");
  }
  if (cached && cached.worldKey === worldKey) {
    measurements.delete(key);
    measurements.set(key, cached);
    return cached.result;
  }
  measurements.delete(key);
  if (!availableBudget || !hasPlanningCpuHeadroom()) {
    // 未测量的候选不能占 LRU：大量 source/spawn 在预算用尽后排队时，
    // 若把它们全部缓存，会驱逐已测 ready 并阻止完整 source 集合收敛。
    return pending("budget", 1);
  }
  measurementsThisTick += 1;

  // 房名到世界坐标是纯几何转换；同一次测量的三段路径共用已验证的
  // route 输入，逐格只校验本地坐标和相邻步，不反复解析相同房名。
  const routeCoordinates = new Map(input.routeRooms.map(room => [room, roomCoordinates(room)!]));
  const matrices = new Map<string, CostMatrix>();
  const roads = new Map<string, Set<string>>();
  const terrains = new Map<string, RoomTerrain>();
  const fatigueByRoom = new Map<string, Map<number, number>>();
  const matrixFor = (roomName: string): CostMatrix => {
    let matrix = matrices.get(roomName);
    if (!matrix) {
      matrix = getCachedStaticTravelMatrix(roomName);
      matrices.set(roomName, matrix);
    }
    return matrix;
  };
  const roomCallback = (roomName: string): CostMatrix | false => measureSampledCpuPhase("search.roomCallback", () => safeRoom(roomName)
    ? matrixFor(roomName).clone()
    : false);
  const validPath = (path: readonly RoomPosition[], origin: RoomPosition, goal: RoomPosition): boolean => measureSampledCpuPhase("path.validate", () => {
    const sourceRoom = routeCoordinates.get(origin.roomName)!;
    let previousX = sourceRoom.x * 50 + origin.x;
    let previousY = sourceRoom.y * 50 + origin.y;
    let previousRoomName = origin.roomName;
    for (const pos of path) {
      if (!pos || typeof pos.roomName !== "string" || !Number.isSafeInteger(pos.x) || pos.x < 0 || pos.x > 49 ||
        !Number.isSafeInteger(pos.y) || pos.y < 0 || pos.y > 49 || !safeRoom(pos.roomName)) return false;
      const coordinates = routeCoordinates.get(pos.roomName);
      if (!coordinates) return false;
      const x = coordinates.x * 50 + pos.x;
      const y = coordinates.y * 50 + pos.y;
      if (Math.max(Math.abs(previousX - x), Math.abs(previousY - y)) !== 1 ||
        matrixFor(pos.roomName).get(pos.x, pos.y) === 0xff) return false;
      previousX = x;
      previousY = y;
      previousRoomName = pos.roomName;
    }
    // 移动跨房仍按世界坐标验证相邻步；ATTACK/pickup/transfer 的 range
    // 却只在同房间成立，不能把另一侧出口格当作已抵达目标。
    const goalRoom = routeCoordinates.get(goal.roomName)!;
    return previousRoomName === goal.roomName && Math.max(
      Math.abs(previousX - (goalRoom.x * 50 + goal.x)),
      Math.abs(previousY - (goalRoom.y * 50 + goal.y)),
    ) <= 1;
  });
  const search = (origin: RoomPosition, goal: RoomPosition, plainCost: number, swampCost: number): RoomPosition[] | undefined => {
    if (searchesThisTick >= MAX_SEARCHES_PER_TICK || !hasPlanningCpuHeadroom()) return undefined;
    searchesThisTick += 1;
    const result = measureSampledCpuPhase("search.native", () => PathFinder.search(origin, { pos: goal, range: 1 }, {
      plainCost,
      swampCost,
      maxOps: SEARCH_MAX_OPS,
      maxRooms: input.routeRooms.length,
      roomCallback,
    }));
    if (result.incomplete || !Array.isArray(result.path) || !validPath(result.path, origin, goal)) return undefined;
    return result.path;
  };
  const terrainFatigue = (pos: RoomPosition): number => {
    let fatigue = fatigueByRoom.get(pos.roomName);
    if (!fatigue) {
      fatigue = new Map();
      fatigueByRoom.set(pos.roomName, fatigue);
    }
    const cellIndex = pos.y * 50 + pos.x;
    const cachedFatigue = fatigue.get(cellIndex);
    if (cachedFatigue !== undefined) return cachedFatigue;
    let roomRoads = roads.get(pos.roomName);
    if (!roomRoads) {
      const room = Game.rooms[pos.roomName];
      const structures = room
        ? getTickContextService().getRoomContext(room)?.getStructures() ?? room.find(FIND_STRUCTURES)
        : [];
      roomRoads = new Set(structures.filter((structure) => structure.structureType === STRUCTURE_ROAD)
        .map((structure) => `${structure.pos.x}:${structure.pos.y}`));
      roads.set(pos.roomName, roomRoads);
    }
    let value = 1;
    if (!roomRoads.has(`${pos.x}:${pos.y}`)) {
      let terrain = terrains.get(pos.roomName);
      if (!terrain) {
        terrain = Game.map.getRoomTerrain(pos.roomName);
        terrains.set(pos.roomName, terrain);
      }
      value = terrain.get(pos.x, pos.y) & TERRAIN_MASK_SWAMP ? 10 : 2;
    }
    fatigue.set(cellIndex, value);
    return value;
  };
  const travelTicks = (path: readonly RoomPosition[], body: MovementBody): number => measureSampledCpuPhase("travelEstimation", () => path.reduce(
    (total, pos) => total + Math.max(1, Math.ceil(body.weight * terrainFatigue(pos) / (body.moves * 2))), 0,
  ));
  try {
    const combat = search(input.sourceSpawnPos, input.bankPos, 2, 8);
    if (!combat) return remember(key, worldKey, pending("path_incomplete"));
    const outbound = search(input.sourceSpawnPos, input.bankPos, 1, 1);
    if (!outbound) return remember(key, worldKey, pending("path_incomplete"));
    const returnOrigin = outbound[outbound.length - 1] ?? input.sourceSpawnPos;
    const loadedReturn = search(returnOrigin, input.returnTargetPos, 1, 5);
    if (!loadedReturn) return remember(key, worldKey, pending("path_incomplete"));
    const result: PowerBankTravelMeasurementResult = Object.freeze({
      status: "ready",
      pathDistance: outbound.length,
      combatTravelTicks: Math.max(travelTicks(combat, attacker), travelTicks(combat, healer)),
      haulerOutboundTravelTicks: outbound.length,
      haulerReturnTravelTicks: travelTicks(loadedReturn, { weight: input.haulerCarryParts, moves: input.haulerCarryParts }),
    });
    return remember(key, worldKey, result);
  } catch {
    return remember(key, worldKey, pending("path_search_failed"));
  }
}
