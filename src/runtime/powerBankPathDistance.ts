import { getCachedStaticTravelMatrix } from "@/movement/routing";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";
import { getTickContextService } from "@/runtime/runtimeServices";
import type { PowerBankTierProfile } from "@/runtime/powerBankViability";
import { hasPlanningCpuHeadroom } from "@/runtime/planningCpuBudget";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import { getPowerBankRoomStatus } from "@/runtime/powerBankMapFacts";
import { normalizeCpuMonitorConfig } from "@/runtime/cpuMonitor";

const CACHE_LIMIT = 64;
const CACHE_TTL = 100;
const RETRY_TICKS = 5;
const MAX_ROUTE_ROOMS = 16;
const MAX_MEASUREMENTS_PER_TICK = 1;
const MAX_SEARCHES_PER_TICK = 3;
const SEARCH_MAX_OPS = 6_000;
const ALGORITHM_REVISION = "power-bank-static-travel-v1";
const DIAGNOSTIC_ROW_LIMIT = 32;

export interface PowerBankPathDiagnosticCounts {
  requests?: number;
  readyHit?: number;
  pendingHit?: number;
  unknownMiss?: number;
  expired?: number;
  worldInvalidated?: number;
  /** 本请求导致测量 LRU 逐出；不代表本 pair 被逐出，也不归因后续 miss。 */
  evictionsCaused?: number;
  measurementStarted?: number;
  ready?: number;
  budgetWait?: number;
  invalidInput?: number;
  endpointNotVisible?: number;
  unsafeRoute?: number;
  routeObservationFailed?: number;
  pathIncomplete?: number;
  pathSearchFailed?: number;
  pendingOther?: number;
  callThrow?: number;
  searchCombat?: number;
  searchOutbound?: number;
  searchReturn?: number;
  incompleteCombat?: number;
  incompleteOutbound?: number;
  incompleteReturn?: number;
  engineIncomplete?: number;
  opsTotal?: number;
  incompleteOps?: number;
  /** 原生 incomplete 且 ops 有限、达到 SEARCH_MAX_OPS 的返回次数。 */
  maxOpsReachedCount?: number;
  malformedPath?: number;
  invalidPath?: number;
  searchBudgetWait?: number;
  searchHeadroomWait?: number;
  searchCallThrow?: number;
}

export interface PowerBankPathDiagnostics {
  version: 1;
  /** 当前模块实例首次采样时递增；采样间隔变化也开启新窗口。 */
  epoch: number;
  startedAt: number;
  updatedAt: number;
  sampleInterval: number;
  sampledTicksWithRequests: number;
  rowsDropped: number;
  totals: PowerBankPathDiagnosticCounts;
  rows: Array<{
    targetRoom: string;
    sourceRoom: string;
    firstTick: number;
    lastTick: number;
    counts: PowerBankPathDiagnosticCounts;
  }>;
}

type DiagnosticCounter = keyof PowerBankPathDiagnosticCounts;
const DIAGNOSTIC_PENDING_COUNTERS: Record<string, DiagnosticCounter> = Object.assign(Object.create(null), {
  budget: "budgetWait", invalid_input: "invalidInput", endpoint_not_visible: "endpointNotVisible",
  unsafe_route: "unsafeRoute", route_observation_failed: "routeObservationFailed",
  path_incomplete: "pathIncomplete", path_search_failed: "pathSearchFailed",
});
type SearchStage = "combat" | "outbound" | "return";
interface DiagnosticCall {
  tick: number;
  sampleInterval: number;
  targetRoom: string;
  sourceRoom: string;
  counts: PowerBankPathDiagnosticCounts;
}

let diagnosticFrame: { game: Game; tick: number; sampled: boolean; sampleInterval: number } | undefined;
let diagnosticWindow: PowerBankPathDiagnostics | undefined;

function beginDiagnostic(input: PowerBankTravelMeasurementInput): DiagnosticCall | undefined {
  try {
    if (diagnosticFrame?.game !== Game || diagnosticFrame.tick !== Game.time) {
      const config = normalizeCpuMonitorConfig(Memory.cfg?.cpuProfiler);
      diagnosticFrame = { game: Game, tick: Game.time, sampleInterval: config.sampleInterval,
        sampled: config.enabled && Game.time % config.sampleInterval === 0 };
    }
    if (!diagnosticFrame.sampled) return undefined;
    const name = (value: unknown): string => typeof value === "string" && /^[EW]\d{1,6}[NS]\d{1,6}$/.test(value) ? value : "unknown";
    return { tick: Game.time, sampleInterval: diagnosticFrame.sampleInterval,
      targetRoom: name(input?.bankPos?.roomName), sourceRoom: name(input?.sourceSpawnPos?.roomName), counts: { requests: 1 } };
  } catch {
    return undefined;
  }
}

function addDiagnostic(counts: PowerBankPathDiagnosticCounts, counter: DiagnosticCounter, amount = 1): void {
  counts[counter] = Math.min(Number.MAX_SAFE_INTEGER, (counts[counter] ?? 0) + amount);
}

function diagnostic(call: DiagnosticCall | undefined, counter: DiagnosticCounter, amount = 1): void {
  if (call) addDiagnostic(call.counts, counter, amount);
}

function finishDiagnostic(call: DiagnosticCall | undefined, result: PowerBankTravelMeasurementResult | undefined): void {
  if (!call) return;
  try {
    diagnostic(call, !result ? "callThrow" : result.status === "ready" ? "ready" : DIAGNOSTIC_PENDING_COUNTERS[result.reason] ?? "pendingOther");
    if (!diagnosticWindow || diagnosticWindow.sampleInterval !== call.sampleInterval) {
      const previous = Memory.analytics?.powerBankPathDiagnostics?.epoch;
      diagnosticWindow = {
        version: 1, epoch: Number.isSafeInteger(previous) && previous! >= 0 && previous! < Number.MAX_SAFE_INTEGER ? previous! + 1 : 1,
        startedAt: call.tick, updatedAt: call.tick, sampleInterval: call.sampleInterval,
        sampledTicksWithRequests: 0, rowsDropped: 0, totals: {}, rows: [],
      };
    }
    const window = diagnosticWindow;
    if (window.sampledTicksWithRequests === 0 || window.updatedAt !== call.tick) window.sampledTicksWithRequests += 1;
    window.updatedAt = call.tick;
    const index = window.rows.findIndex(row => row.targetRoom === call.targetRoom && row.sourceRoom === call.sourceRoom);
    const row = index >= 0 ? window.rows.splice(index, 1)[0] : {
      targetRoom: call.targetRoom, sourceRoom: call.sourceRoom, firstTick: call.tick, lastTick: call.tick, counts: {},
    };
    if (window.rows.length >= DIAGNOSTIC_ROW_LIMIT) { window.rows.shift(); window.rowsDropped += 1; }
    row.lastTick = call.tick;
    for (const counter of Object.keys(call.counts) as DiagnosticCounter[]) {
      addDiagnostic(window.totals, counter, call.counts[counter]);
      addDiagnostic(row.counts, counter, call.counts[counter]);
    }
    window.rows.push(row);
    Memory.analytics ??= {};
    Memory.analytics.powerBankPathDiagnostics = window;
  } catch {
    // 诊断不能替换测量结果、吞业务异常或使原本成功的准入抛错。
  }
}

function recordSearchResult(call: DiagnosticCall | undefined, stage: SearchStage, result: PathFinderPath, incomplete: boolean): void {
  if (!call) return;
  try {
    if (incomplete) {
      diagnostic(call, "engineIncomplete");
      diagnostic(call, stage === "combat" ? "incompleteCombat" : stage === "outbound" ? "incompleteOutbound" : "incompleteReturn");
    }
    const ops = result.ops;
    const finiteOps = Number.isFinite(ops) && ops >= 0;
    if (finiteOps) diagnostic(call, "opsTotal", ops);
    if (incomplete) {
      if (finiteOps) diagnostic(call, "incompleteOps", ops);
      if (Number.isFinite(ops) && ops >= SEARCH_MAX_OPS) diagnostic(call, "maxOpsReachedCount");
    }
  } catch {
    // 只读原生结果的诊断字段也不得影响业务校验。
  }
}

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

function remember(key: string, worldKey: string, result: PowerBankTravelMeasurementResult, call?: DiagnosticCall): PowerBankTravelMeasurementResult {
  measurements.delete(key);
  while (measurements.size >= CACHE_LIMIT) {
    const oldest = measurements.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    measurements.delete(oldest);
    diagnostic(call, "evictionsCaused");
  }
  measurements.set(key, {
    expiresAt: result.status === "ready" ? Game.time + CACHE_TTL : result.retryAt,
    worldKey,
    result,
  });
  return result;
}

/**
 * 只测量静态地形/结构上的完整路径，不提交移动；采样时仅附加 analytics 诊断。
 * 不可见中转房沿用 movement 的 terrain-only 矩阵；交通、编队等待及
 * pickup/transfer 的动作时间由调用者的既有 buffer 承接。
 */
export function measurePowerBankTravel(input: PowerBankTravelMeasurementInput): PowerBankTravelMeasurementResult {
  return measureSampledCpuPhase("measureTravel.total", () => {
    const call = beginDiagnostic(input);
    let result: PowerBankTravelMeasurementResult | undefined;
    try {
      result = measurePowerBankTravelImpl(input, call);
      return result;
    } finally {
      finishDiagnostic(call, result);
    }
  });
}

function measurePowerBankTravelImpl(input: PowerBankTravelMeasurementInput, call?: DiagnosticCall): PowerBankTravelMeasurementResult {
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
      diagnostic(call, "expired");
      measurements.delete(key);
      cached = undefined;
    } else if (!cached) diagnostic(call, "unknownMiss");
    return cached;
  });
  if (cached?.result.status === "pending") {
    diagnostic(call, "pendingHit");
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
    const status = getPowerBankRoomStatus(roomName);
    // novice/respawn 并不等于闭房；能否跨边界继续由安全 route 与 PF 地形
    // 屏障证明，不能仅因区域标签而拒绝同区域内可达路径。
    const safe = status != null && status.status !== "closed";
    roomSafety.set(roomName, safe);
    return safe;
  };
  let worldKey: string;
  try {
    if (measureSampledCpuPhase("worldProof", () => measureSampledCpuPhase("status", () =>
      input.routeRooms.some((room) => !safeRoom(room))))) return pending("unsafe_route");
    worldKey = measureSampledCpuPhase("worldProof", () => measureSampledCpuPhase("topology", () =>
      JSON.stringify(input.routeRooms.map((room) => [room, Boolean(Game.rooms[room]), getRoomTopologyRevision(room)]))));
  } catch {
    return pending("route_observation_failed");
  }
  if (cached && cached.worldKey === worldKey) {
    diagnostic(call, "readyHit");
    measurements.delete(key);
    measurements.set(key, cached);
    return cached.result;
  }
  if (cached) diagnostic(call, "worldInvalidated");
  measurements.delete(key);
  if (!availableBudget || !hasPlanningCpuHeadroom()) {
    // 未测量的候选不能占 LRU：大量 source/spawn 在预算用尽后排队时，
    // 若把它们全部缓存，会驱逐已测 ready 并阻止完整 source 集合收敛。
    return pending("budget", 1);
  }
  measurementsThisTick += 1;
  diagnostic(call, "measurementStarted");

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
  const search = (origin: RoomPosition, goal: RoomPosition, plainCost: number, swampCost: number, stage: SearchStage): RoomPosition[] | undefined => {
    if (searchesThisTick >= MAX_SEARCHES_PER_TICK || !hasPlanningCpuHeadroom()) {
      diagnostic(call, searchesThisTick >= MAX_SEARCHES_PER_TICK ? "searchBudgetWait" : "searchHeadroomWait");
      return undefined;
    }
    searchesThisTick += 1;
    diagnostic(call, stage === "combat" ? "searchCombat" : stage === "outbound" ? "searchOutbound" : "searchReturn");
    let result: PathFinderPath;
    try {
      result = measureSampledCpuPhase("search.native", () => PathFinder.search(origin, { pos: goal, range: 1 }, {
        plainCost,
        swampCost,
        maxOps: SEARCH_MAX_OPS,
        maxRooms: input.routeRooms.length,
        roomCallback,
      }));
    } catch (error) {
      diagnostic(call, "searchCallThrow");
      throw error;
    }
    const incomplete = result.incomplete;
    recordSearchResult(call, stage, result, incomplete);
    if (incomplete) return undefined;
    if (!Array.isArray(result.path)) { diagnostic(call, "malformedPath"); return undefined; }
    if (!validPath(result.path, origin, goal)) { diagnostic(call, "invalidPath"); return undefined; }
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
    const combat = search(input.sourceSpawnPos, input.bankPos, 2, 8, "combat");
    if (!combat) return remember(key, worldKey, pending("path_incomplete"), call);
    const outbound = search(input.sourceSpawnPos, input.bankPos, 1, 1, "outbound");
    if (!outbound) return remember(key, worldKey, pending("path_incomplete"), call);
    const returnOrigin = outbound[outbound.length - 1] ?? input.sourceSpawnPos;
    const loadedReturn = search(returnOrigin, input.returnTargetPos, 1, 5, "return");
    if (!loadedReturn) return remember(key, worldKey, pending("path_incomplete"), call);
    const result: PowerBankTravelMeasurementResult = Object.freeze({
      status: "ready",
      pathDistance: outbound.length,
      combatTravelTicks: Math.max(travelTicks(combat, attacker), travelTicks(combat, healer)),
      haulerOutboundTravelTicks: outbound.length,
      haulerReturnTravelTicks: travelTicks(loadedReturn, { weight: input.haulerCarryParts, moves: input.haulerCarryParts }),
    });
    return remember(key, worldKey, result, call);
  } catch {
    return remember(key, worldKey, pending("path_search_failed"), call);
  }
}
