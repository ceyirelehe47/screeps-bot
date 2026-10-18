import { searchPlanningPath } from "@/movement/pathSearch";
import { getCachedStaticTravelMatrix } from "@/movement/routing";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";

interface DepositPathInput {
  origin: RoomPosition;
  target: RoomPosition;
  returnTarget: RoomPosition;
  body: readonly BodyPartConstant[];
  /** 返程用于保守满载；运行时可提供当前/采集后预期 cargo。 */
  loadedAmount: number;
  routeRooms: readonly string[];
  avoidRooms: readonly string[];
}
export type DepositTravelResult = {
  status: "ready";
  pathDistance: number;
  outboundTravelTicks: number;
  returnTravelTicks: number;
  harvestPos: { x: number; y: number; roomName: string };
} | { status: "pending"; reason: string; retryAt: number };
export type DepositReturnInput = Omit<DepositPathInput, "target">;

const cache = new Map<string, { expiresAt: number; worldKey: string; result: DepositTravelResult }>();
let budgetTick = -1;
let budgetGame: Game | undefined;
let measurements = 0;
let searches = 0;

function coordinates(name: string): { x: number; y: number } | undefined {
  if (typeof name !== "string") return undefined;
  const m = /^([EW])(\d+)([NS])(\d+)$/.exec(name);
  if (!m) return undefined;
  const x = Number(m[2]); const y = Number(m[4]);
  const maximum = Math.floor(Number.MAX_SAFE_INTEGER / 50) - 1;
  if (![x, y].every((v) => Number.isSafeInteger(v) && v <= maximum)) return undefined;
  return { x: m[1] === "E" ? x : -x - 1, y: m[3] === "S" ? y : -y - 1 };
}
function validPos(pos: RoomPosition): boolean {
  return Boolean(pos && coordinates(pos.roomName) && Number.isSafeInteger(pos.x) && pos.x >= 0 && pos.x < 50 &&
    Number.isSafeInteger(pos.y) && pos.y >= 0 && pos.y < 50);
}
function range(a: RoomPosition, b: RoomPosition): number {
  const ac = coordinates(a.roomName)!; const bc = coordinates(b.roomName)!;
  return Math.max(Math.abs(ac.x * 50 + a.x - bc.x * 50 - b.x), Math.abs(ac.y * 50 + a.y - bc.y * 50 - b.y));
}
export function isDepositRoomSafe(roomName: string, avoidRooms: readonly string[] = []): boolean {
  if (avoidRooms.includes(roomName) || !coordinates(roomName)) return false;
  const status = Game.map.getRoomStatus(roomName);
  if (!status || status.status === "closed") return false;
  if ((Memory.runtime?.transitDangerRooms?.[roomName] ?? 0) > Game.time ||
    Memory.runtime?.powerBankPermanentDangerRooms?.[roomName]) return false;
  const room = Game.rooms[roomName];
  if (!room) return true; // 未见房间只有静态地形证明；已知危险仍严格拒绝。
  if (room.controller?.owner && !room.controller.my) return false;
  if (room.find(FIND_HOSTILE_CREEPS).some((creep) => creep.body.some((part) => part.hits > 0 &&
    (part.type === ATTACK || part.type === RANGED_ATTACK || part.type === HEAL)))) return false;
  return !room.find(FIND_HOSTILE_STRUCTURES).some((s) => s.structureType === STRUCTURE_TOWER);
}
function pending(reason: string, retry = 5): DepositTravelResult {
  return { status: "pending", reason, retryAt: Game.time + retry };
}
function refreshBudget(): void {
  if (budgetTick !== Game.time || budgetGame !== Game) {
    budgetTick = Game.time; budgetGame = Game; measurements = 0; searches = 0;
  }
}
export function clearDepositPathCacheForTest(): void {
  cache.clear(); budgetTick = -1; budgetGame = undefined; measurements = 0; searches = 0;
}

/** 完整路径、端点可见、连续世界坐标、同房 range1；预算独立于 PB。 */
function measure(input: DepositPathInput, returnOnly: boolean): DepositTravelResult {
  refreshBudget();
  if (!validPos(input.origin) || !validPos(input.target) || !validPos(input.returnTarget) ||
    !Array.isArray(input.body) || input.body.length < 1 || input.body.length > 50 ||
    input.body.some((p) => !Object.prototype.hasOwnProperty.call(BODYPART_COST, p)) ||
    !Number.isSafeInteger(input.loadedAmount) || input.loadedAmount < 0 || input.loadedAmount > 2_500 ||
    !Array.isArray(input.routeRooms) || input.routeRooms.length < 1 || input.routeRooms.length > 16 ||
    new Set(input.routeRooms).size !== input.routeRooms.length ||
    input.routeRooms.some((r) => !coordinates(r)) || !Array.isArray(input.avoidRooms) ||
    input.avoidRooms.some((r) => !coordinates(r)) || !input.routeRooms.includes(input.origin.roomName) ||
    !input.routeRooms.includes(input.target.roomName) || !input.routeRooms.includes(input.returnTarget.roomName) ||
    (!returnOnly && (input.routeRooms[0] !== input.origin.roomName ||
      input.routeRooms[input.routeRooms.length - 1] !== input.target.roomName))) return pending("invalid_input");
  const moves = input.body.filter((p) => p === MOVE).length;
  const carry = input.body.filter((p) => p === CARRY).length;
  const emptyWeight = input.body.filter((p) => p !== MOVE && p !== CARRY).length;
  if (moves === 0 || input.loadedAmount > carry * CARRY_CAPACITY) return pending("invalid_body");
  if (!Game.rooms[input.origin.roomName] || !Game.rooms[input.target.roomName] || !Game.rooms[input.returnTarget.roomName]) {
    return pending("endpoint_not_visible");
  }
  const key = JSON.stringify(["deposit-static-travel-v1", returnOnly,
    [input.origin.roomName, input.origin.x, input.origin.y], [input.target.roomName, input.target.x, input.target.y],
    [input.returnTarget.roomName, input.returnTarget.x, input.returnTarget.y], input.body, input.loadedAmount,
    input.routeRooms, [...input.avoidRooms].sort()]);
  let entry = cache.get(key);
  if (entry && Game.time >= entry.expiresAt) { cache.delete(key); entry = undefined; }
  if (!entry && measurements >= 1) return pending("budget", 1);
  const roomSafety = new Map<string, boolean>();
  const safe = (roomName: string): boolean => {
    const known = roomSafety.get(roomName);
    if (known !== undefined) return known;
    const result = isDepositRoomSafe(roomName, input.avoidRooms);
    roomSafety.set(roomName, result);
    return result;
  };
  let worldKey: string;
  try {
    if (!input.routeRooms.every(safe)) return pending("unsafe_route");
    worldKey = JSON.stringify(input.routeRooms.map((r) => [r, Boolean(Game.rooms[r]), getRoomTopologyRevision(r)]));
  } catch { return pending("route_observation_failed"); }
  if (entry?.worldKey === worldKey) { cache.delete(key); cache.set(key, entry); return entry.result; }
  if (measurements >= 1) return pending("budget", 1);
  measurements += 1;
  const remember = (result: DepositTravelResult): DepositTravelResult => {
    cache.delete(key);
    while (cache.size >= 64) cache.delete(cache.keys().next().value as string);
    cache.set(key, { expiresAt: result.status === "ready" ? Game.time + 100 : result.retryAt, worldKey, result });
    return result;
  };
  const matrices = new Map<string, CostMatrix>();
  const matrix = (r: string): CostMatrix => {
    let m = matrices.get(r);
    if (!m) { m = getCachedStaticTravelMatrix(r); matrices.set(r, m); }
    return m;
  };
  const allowed = new Set(input.routeRooms);
  let globalBudgetWait = false;
  const search = (origin: RoomPosition, target: RoomPosition, weight: number): RoomPosition[] | undefined => {
    if (searches >= 2) return undefined;
    searches += 1;
    const result = searchPlanningPath(origin, { pos: target, range: 1 }, {
      plainCost: Math.max(1, Math.ceil(weight * 2 / (moves * 2))),
      swampCost: Math.max(1, Math.ceil(weight * 10 / (moves * 2))), maxOps: 6_000,
      maxRooms: input.routeRooms.length,
      roomCallback: (r) => allowed.has(r) && safe(r) ? matrix(r).clone() : false,
    });
    if (result.reason === "budgetExhausted" && result.globalBudgetLimited) globalBudgetWait = true;
    if (result.incomplete || !Array.isArray(result.path)) return undefined;
    let previous = origin;
    for (const step of result.path) {
      if (!validPos(step) || !allowed.has(step.roomName) || !safe(step.roomName) ||
        range(previous, step) !== 1 || matrix(step.roomName).get(step.x, step.y) === 0xff) return undefined;
      previous = step;
    }
    return previous.roomName === target.roomName && range(previous, target) <= 1 ? result.path : undefined;
  };
  const roads = new Map<string, Set<number>>();
  const fatigue = (pos: RoomPosition): number => {
    let roomRoads = roads.get(pos.roomName);
    if (!roomRoads) {
      roomRoads = new Set((Game.rooms[pos.roomName]?.find(FIND_STRUCTURES) ?? [])
        .filter((s) => s.structureType === STRUCTURE_ROAD).map((s) => s.pos.y * 50 + s.pos.x));
      roads.set(pos.roomName, roomRoads);
    }
    if (roomRoads.has(pos.y * 50 + pos.x)) return 1;
    return Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) & TERRAIN_MASK_SWAMP ? 10 : 2;
  };
  const ticks = (path: readonly RoomPosition[], weight: number): number => path.reduce(
    (sum, p) => sum + Math.max(1, Math.ceil(weight * fatigue(p) / (moves * 2))), 0);
  try {
    const outbound = returnOnly ? [] : search(input.origin, input.target, emptyWeight);
    if (!outbound) return remember(globalBudgetWait ? pending("budget", 1) : pending("path_incomplete"));
    const harvestPos = outbound[outbound.length - 1] ?? input.origin;
    const loadedWeight = emptyWeight + Math.ceil(input.loadedAmount / CARRY_CAPACITY);
    const returned = search(harvestPos, input.returnTarget, loadedWeight);
    if (!returned) return remember(globalBudgetWait ? pending("budget", 1) : pending("path_incomplete"));
    return remember({ status: "ready", pathDistance: outbound.length,
      outboundTravelTicks: ticks(outbound, emptyWeight), returnTravelTicks: ticks(returned, loadedWeight),
      harvestPos: { x: harvestPos.x, y: harvestPos.y, roomName: harvestPos.roomName } });
  } catch { return remember(pending("path_search_failed")); }
}
export function measureDepositTravel(input: DepositPathInput): DepositTravelResult { return measure(input, false); }
export function measureDepositReturn(input: DepositReturnInput): DepositTravelResult {
  return measure({ ...input, target: input.origin }, true);
}
