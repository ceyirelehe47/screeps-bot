import { getCachedStaticTravelMatrix } from "@/movement/routing";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";
import { getTickContextService } from "@/runtime/runtimeServices";
import type { PowerBankTierProfile } from "@/runtime/powerBankViability";

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

function worldPosition(pos: RoomPosition): { x: number; y: number } {
  const room = roomCoordinates(pos.roomName)!;
  return { x: room.x * 50 + pos.x, y: room.y * 50 + pos.y };
}

function worldRange(left: RoomPosition, right: RoomPosition): number {
  const a = worldPosition(left);
  const b = worldPosition(right);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
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

function pending(reason: string, retryTicks = RETRY_TICKS): PowerBankTravelMeasurementResult {
  return Object.freeze({ status: "pending", reason, retryAt: Game.time + retryTicks });
}

function remember(key: string, result: PowerBankTravelMeasurementResult): PowerBankTravelMeasurementResult {
  measurements.delete(key);
  while (measurements.size >= CACHE_LIMIT) {
    const oldest = measurements.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    measurements.delete(oldest);
  }
  measurements.set(key, {
    expiresAt: result.status === "ready" ? Game.time + CACHE_TTL : result.retryAt,
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
  const attacker = movementBody(input.profile?.attacker?.body);
  const healer = movementBody(input.profile?.healer?.body);
  if (!validPosition(input.sourceSpawnPos) || !validPosition(input.bankPos) || !validPosition(input.returnTargetPos) ||
    input.returnTargetPos.roomName !== input.sourceSpawnPos.roomName || !attacker || !healer ||
    !Number.isSafeInteger(input.haulerCarryParts) || input.haulerCarryParts < 1 || input.haulerCarryParts > 25 ||
    !Array.isArray(input.routeRooms) || input.routeRooms.length === 0 || input.routeRooms.length > MAX_ROUTE_ROOMS ||
    input.routeRooms[0] !== input.sourceSpawnPos.roomName ||
    input.routeRooms[input.routeRooms.length - 1] !== input.bankPos.roomName ||
    new Set(input.routeRooms).size !== input.routeRooms.length || !Array.isArray(input.avoidRooms) ||
    input.routeRooms.some((room) => typeof room !== "string" || !roomCoordinates(room)) ||
    input.avoidRooms.some((room) => typeof room !== "string" || !roomCoordinates(room))) {
    return pending("invalid_input");
  }
  if (!Game.rooms[input.sourceSpawnPos.roomName] || !Game.rooms[input.bankPos.roomName]) {
    return pending("endpoint_not_visible");
  }
  const allowedRooms = new Set(input.routeRooms);
  const avoidedRooms = new Set(input.avoidRooms);
  const endpointRooms = new Set([input.sourceSpawnPos.roomName, input.bankPos.roomName]);
  const safeRoom = (roomName: string): boolean => {
    if (!allowedRooms.has(roomName) || (!endpointRooms.has(roomName) && avoidedRooms.has(roomName))) return false;
    const status = Game.map.getRoomStatus(roomName);
    // novice/respawn 并不等于闭房；能否跨边界继续由安全 route 与 PF 地形
    // 屏障证明，不能仅因区域标签而拒绝同区域内可达路径。
    return status != null && status.status !== "closed";
  };
  let key: string;
  try {
    if (input.routeRooms.some((room) => !safeRoom(room))) return pending("unsafe_route");
    key = JSON.stringify([
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
      input.routeRooms.map((room) => [room, Boolean(Game.rooms[room]), getRoomTopologyRevision(room)]),
    ]);
  } catch {
    return pending("route_observation_failed");
  }
  const cached = measurements.get(key);
  if (cached && Game.time < cached.expiresAt) {
    measurements.delete(key);
    measurements.set(key, cached);
    return cached.result;
  }
  measurements.delete(key);
  refreshBudget();
  if (measurementsThisTick >= MAX_MEASUREMENTS_PER_TICK || searchesThisTick >= MAX_SEARCHES_PER_TICK) {
    // 未测量的候选不能占 LRU：大量 source/spawn 在预算用尽后排队时，
    // 若把它们全部缓存，会驱逐已测 ready 并阻止完整 source 集合收敛。
    return pending("budget", 1);
  }
  measurementsThisTick += 1;

  const matrices = new Map<string, CostMatrix>();
  const roads = new Map<string, Set<string>>();
  const matrixFor = (roomName: string): CostMatrix => {
    let matrix = matrices.get(roomName);
    if (!matrix) {
      matrix = getCachedStaticTravelMatrix(roomName);
      matrices.set(roomName, matrix);
    }
    return matrix;
  };
  const roomCallback = (roomName: string): CostMatrix | false => safeRoom(roomName)
    ? matrixFor(roomName).clone()
    : false;
  const validPath = (path: readonly RoomPosition[], origin: RoomPosition, goal: RoomPosition): boolean => {
    let previous = origin;
    for (const pos of path) {
      if (!validPosition(pos) || !safeRoom(pos.roomName) || worldRange(previous, pos) !== 1 ||
        matrixFor(pos.roomName).get(pos.x, pos.y) === 0xff) return false;
      previous = pos;
    }
    // 移动跨房仍按世界坐标验证相邻步；ATTACK/pickup/transfer 的 range
    // 却只在同房间成立，不能把另一侧出口格当作已抵达目标。
    return previous.roomName === goal.roomName && worldRange(previous, goal) <= 1;
  };
  const search = (origin: RoomPosition, goal: RoomPosition, plainCost: number, swampCost: number): RoomPosition[] | undefined => {
    if (searchesThisTick >= MAX_SEARCHES_PER_TICK) return undefined;
    searchesThisTick += 1;
    const result = PathFinder.search(origin, { pos: goal, range: 1 }, {
      plainCost,
      swampCost,
      maxOps: SEARCH_MAX_OPS,
      maxRooms: input.routeRooms.length,
      roomCallback,
    });
    if (result.incomplete || !Array.isArray(result.path) || !validPath(result.path, origin, goal)) return undefined;
    return result.path;
  };
  const terrainFatigue = (pos: RoomPosition): number => {
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
    if (roomRoads.has(`${pos.x}:${pos.y}`)) return 1;
    return Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) & TERRAIN_MASK_SWAMP ? 10 : 2;
  };
  const travelTicks = (path: readonly RoomPosition[], body: MovementBody): number => path.reduce(
    (total, pos) => total + Math.max(1, Math.ceil(body.weight * terrainFatigue(pos) / (body.moves * 2))), 0,
  );
  try {
    const combat = search(input.sourceSpawnPos, input.bankPos, 2, 8);
    if (!combat) return remember(key, pending("path_incomplete"));
    const outbound = search(input.sourceSpawnPos, input.bankPos, 1, 1);
    if (!outbound) return remember(key, pending("path_incomplete"));
    const returnOrigin = outbound[outbound.length - 1] ?? input.sourceSpawnPos;
    const loadedReturn = search(returnOrigin, input.returnTargetPos, 1, 5);
    if (!loadedReturn) return remember(key, pending("path_incomplete"));
    const result: PowerBankTravelMeasurementResult = Object.freeze({
      status: "ready",
      pathDistance: outbound.length,
      combatTravelTicks: Math.max(travelTicks(combat, attacker), travelTicks(combat, healer)),
      haulerOutboundTravelTicks: outbound.length,
      haulerReturnTravelTicks: travelTicks(loadedReturn, { weight: input.haulerCarryParts, moves: input.haulerCarryParts }),
    });
    return remember(key, result);
  } catch {
    return remember(key, pending("path_search_failed"));
  }
}
