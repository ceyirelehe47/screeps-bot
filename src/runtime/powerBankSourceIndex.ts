import { getCachedStaticTravelMatrix } from "@/movement/routing";
import { searchPlanningPath } from "@/movement/pathSearch";
import { POWER_BANK_MAX_ROUTE_ROOMS, POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
import { claimPowerBankTravelBudget, canMeasurePowerBankTravelThisTick } from "@/runtime/powerBankPathDistance";
import { expandPowerBankCorridor, findPowerBankCostedRoute, POWER_BANK_MAX_ALLOWED_ROOMS } from "@/runtime/powerBankRouteCost";
import { getPowerBankSearchCandidates, POWER_BANK_SEARCH_RADIUS } from "@/runtime/powerBankSearch";
import { hasPlanningCpuHeadroom } from "@/runtime/planningCpuBudget";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import { getTickContextService } from "@/runtime/runtimeServices";
import { isSpawnActive } from "@/runtime/tickContext";

/**
 * 高速房 -> 最近来源房索引。
 * 每个高速搜索房保存按 PF 实测行程升序的前 3 个己方来源房：RCL8 优先，
 * 只有一个 RCL8 都没有时才用 RCL6/7 兜底。每 tick 至多测 1 对，与准入
 * 共用测量名额且受 CPU 余量门控；已建完时为廉价 no-op。
 */
export const POWER_BANK_SOURCE_INDEX_SIZE = 3;
/** 已完成条目的刷新周期；拓扑/道路缓慢变化时逐房重测。 */
export const POWER_BANK_SOURCE_INDEX_REFRESH_TICKS = 5_000;
const INDEX_SEARCH_MAX_OPS = 10_000;
/** 目标为高速房中心 range 10：对房内 Bank 位置取平均意义上的近似。 */
const INDEX_GOAL_RANGE = 10;
const INDEX_ROOM_SCAN_PER_TICK = 8;
const MIN_SOURCE_LEVEL = 6;

export interface PowerBankSourceIndexEntry {
  room: string;
  /** 1:1 MOVE 身体的单程 tick（平原/道路 1、沼泽 5），口径同战斗行程。 */
  ticks: number;
  level: number;
}

interface IndexPair { ticks: number | null; at: number; rooms: string[] }
interface IndexRoom {
  signature?: string;
  routeRooms: string[];
  avoidedRooms: string[];
  hadUnreachable: boolean;
  pairs: Record<string, IndexPair>;
  entries: PowerBankSourceIndexEntry[];
  /** entries 来自一次完整构建；刷新期间旧 entries 继续可用。 */
  complete: boolean;
  builtAt: number;
  /** 本轮构建开始 tick；刷新时只信任此后测得的 pair。 */
  buildStartedAt: number;
}

interface IndexSource { room: string; level: number; origin: RoomPosition }

interface IndexState {
  sig: string;
  rooms: Map<string, IndexRoom>;
  cursor: number;
}

let state: IndexState | undefined;
let frame: { game: Game; tick: number; sig: string; sources: IndexSource[]; avoid: Set<string>; signatures: Map<string, string> } | undefined;

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = ((value * 33) ^ text.charCodeAt(index)) >>> 0;
  return `${text.length.toString(36)}${value.toString(36)}`;
}

function readFrame(): NonNullable<typeof frame> {
  if (frame?.game === Game && frame.tick === Game.time) return frame;
  const sources: IndexSource[] = [];
  for (const room of getTickContextService().getMyRooms()) {
    const level = room.controller?.level ?? 0;
    if (level < MIN_SOURCE_LEVEL) continue;
    const spawn = getTickContextService().getSpawnsByRoom(room.name).find(isSpawnActive);
    const origin = room.storage?.pos ?? spawn?.pos;
    if (!spawn || !origin) continue;
    sources.push({ room: room.name, level, origin });
  }
  sources.sort((left, right) => left.room.localeCompare(right.room));
  // 只用长期避让（永久危险 + 已确认敌方所有权）；短期危险由准入实时处理，
  // 否则索引会随临时危险反复失效。
  const avoid = new Set([
    ...Object.keys(Memory.runtime?.powerBankPermanentDangerRooms ?? {}),
    ...Object.keys(Memory.runtime?.powerBankOwnedRoomIntel ?? {}),
  ]);
  const sig = hash(JSON.stringify(["route-scoped-v3", Game.shard?.name ?? ""]));
  frame = { game: Game, tick: Game.time, sig, sources, avoid, signatures: new Map() };
  return frame;
}

function parseMemoryRoom(encoded: unknown): IndexRoom | undefined {
  if (typeof encoded !== "string") return undefined;
  const [builtAtText, list = "", signature, dependencies] = encoded.split("|");
  const builtAt = Number(builtAtText);
  if (!Number.isSafeInteger(builtAt)) return undefined;
  const entries: PowerBankSourceIndexEntry[] = [];
  for (const item of list.split(",")) {
    const [room, ticksText, levelText] = item.split(":");
    const ticks = Number(ticksText);
    const level = Number(levelText);
    if (!room || !Number.isFinite(ticks) || !Number.isSafeInteger(level)) continue;
    entries.push({ room, ticks, level });
  }
  try {
    const saved = JSON.parse(dependencies);
    if (!Array.isArray(saved.r) || !Array.isArray(saved.a) || typeof saved.n !== "boolean" ||
        [...saved.r, ...saved.a].some(room => typeof room !== "string" || !/^[WE]\d+[NS]\d+$/.test(room))) return undefined;
    return { pairs: {}, entries, complete: true, builtAt, buildStartedAt: builtAt, signature,
      routeRooms: saved.r, avoidedRooms: saved.a, hadUnreachable: saved.n };
  } catch { return undefined; }
}

function encodeMemoryRoom(entry: IndexRoom): string {
  return `${entry.builtAt}|${entry.entries.map((item) => `${item.room}:${item.ticks}:${item.level}`).join(",")}|${entry.signature ?? ""}|${JSON.stringify({ r: entry.routeRooms, a: entry.avoidedRooms, n: entry.hadUnreachable })}`;
}

function ensureState(): IndexState {
  const current = readFrame();
  if (state?.sig === current.sig) return state;
  const runtime = Memory.runtime ??= {};
  const stored = runtime.powerBankSourceIndex;
  const rooms = new Map<string, IndexRoom>();
  if (stored && stored.sig === current.sig && stored.rooms && typeof stored.rooms === "object") {
    // global reset 后只恢复已完成条目；未完成的房间重新测量。
    for (const [roomName, encoded] of Object.entries(stored.rooms)) {
      const parsed = parseMemoryRoom(encoded);
      if (parsed) rooms.set(roomName, parsed);
    }
  } else {
    runtime.powerBankSourceIndex = { sig: current.sig, rooms: {} };
  }
  state = { sig: current.sig, rooms, cursor: 0 };
  return state;
}

function persist(roomName: string, entry: IndexRoom | undefined): void {
  const runtime = Memory.runtime ??= {};
  const stored = runtime.powerBankSourceIndex ??= { sig: state?.sig ?? "", rooms: {} };
  if (entry) stored.rooms[roomName] = encodeMemoryRoom(entry);
  else delete stored.rooms[roomName];
}

/** 只使可能使用变化来源或避让房的高速条目失效。 */
function currentRoomEntry(highwayRoom: string, index: IndexState): IndexRoom | undefined {
  const signature = roomSignature(highwayRoom);
  const entry = index.rooms.get(highwayRoom);
  const avoid = readFrame().avoid;
  if (entry && entry.signature === signature) {
    const pairs = Object.values(entry.pairs);
    // 新危险只影响实测路径经过它的条目；不再按几何半径广播失效。
    const affected = [...entry.routeRooms, ...pairs.flatMap(pair => pair.rooms)].some(room => avoid.has(room));
    // 原先不可达的候选在解除避让时可以恢复；成功路径的优化交给周期刷新。
    const reopened = (entry.hadUnreachable || pairs.some(pair => pair.ticks === null)) &&
      entry.avoidedRooms.some(room => !avoid.has(room));
    if (!affected && !reopened) return entry;
  }
  if (entry) { index.rooms.delete(highwayRoom); persist(highwayRoom, undefined); }
  return undefined;
}

function roomSignature(highwayRoom: string): string {
  const current = readFrame();
  const cached = current.signatures.get(highwayRoom);
  if (cached !== undefined) return cached;
  const signature = hash(JSON.stringify([
    current.sources.filter(source => linearDistance(source.room, highwayRoom) <= POWER_BANK_SEARCH_RADIUS)
      .map(source => [source.room, source.level, source.origin.x, source.origin.y]),
  ]));
  current.signatures.set(highwayRoom, signature);
  return signature;
}

function linearDistance(from: string, to: string): number {
  return Game.map.getRoomLinearDistance(from, to);
}

/** 进入目标房 range 10 前至少要穿过 (d-1) 个整房；用于剪枝更远候选。 */
function lowerBoundTicks(distance: number): number {
  return Math.max(0, (distance - 1) * 49);
}

function computeEntries(pairs: Record<string, IndexPair>, sources: readonly IndexSource[]): PowerBankSourceIndexEntry[] {
  const measured = sources
    .map((source) => ({ source, pair: pairs[source.room] }))
    .filter((item): item is { source: IndexSource; pair: IndexPair & { ticks: number } } =>
      item.pair !== undefined && item.pair.ticks !== null)
    .map(({ source, pair }) => ({ room: source.room, ticks: pair.ticks, level: source.level }))
    .sort((left, right) => left.ticks - right.ticks || left.room.localeCompare(right.room));
  const rcl8 = measured.filter((item) => item.level >= 8);
  // RCL8 优先；一个 RCL8 条目都没有时才用 RCL6/7 兜底。
  return (rcl8.length > 0 ? rcl8 : measured).slice(0, POWER_BANK_SOURCE_INDEX_SIZE);
}

/** 本房下一个待测来源；undefined 表示所有候选已测或被剪枝。 */
function nextPair(highwayRoom: string, entry: IndexRoom, sources: readonly IndexSource[]): IndexSource | undefined {
  const candidates = sources
    .map((source) => ({ source, distance: linearDistance(source.room, highwayRoom) }))
    .filter((item) => Number.isFinite(item.distance) && item.distance <= POWER_BANK_SEARCH_RADIUS)
    .sort((left, right) => (right.source.level >= 8 ? 1 : 0) - (left.source.level >= 8 ? 1 : 0) ||
      left.distance - right.distance || left.source.room.localeCompare(right.source.room));
  const fresh = (room: string): IndexPair | undefined => {
    const pair = entry.pairs[room];
    return pair && pair.at >= entry.buildStartedAt ? pair : undefined;
  };
  const finite = (predicate: (source: IndexSource) => boolean): number[] => candidates
    .filter(({ source }) => predicate(source))
    .map(({ source }) => fresh(source.room)?.ticks)
    .filter((ticks): ticks is number => typeof ticks === "number")
    .sort((left, right) => left - right);
  const rcl8Ticks = finite((source) => source.level >= 8);
  const lowerTicks = finite((source) => source.level < 8);
  for (const { source, distance } of candidates) {
    if (fresh(source.room)) continue;
    if (source.level >= 8) {
      if (rcl8Ticks.length >= POWER_BANK_SOURCE_INDEX_SIZE &&
          lowerBoundTicks(distance) >= rcl8Ticks[POWER_BANK_SOURCE_INDEX_SIZE - 1]) continue;
    } else {
      // 已有 RCL8 条目时 RCL6/7 永不入表；否则按同样的下界剪枝。
      if (rcl8Ticks.length > 0) continue;
      if (lowerTicks.length >= POWER_BANK_SOURCE_INDEX_SIZE &&
          lowerBoundTicks(distance) >= lowerTicks[POWER_BANK_SOURCE_INDEX_SIZE - 1]) continue;
    }
    return source;
  }
  return undefined;
}

type PairResult = { kind: "measured"; ticks: number | null; rooms: string[] } | { kind: "retry" };

function measurePair(source: IndexSource, highwayRoom: string, avoid: ReadonlySet<string>): PairResult {
  const avoidForRoute = new Set([...avoid].filter((room) => room !== highwayRoom && room !== source.room));
  const route = measureSampledCpuPhase("sourceIndex.route", () => findPowerBankCostedRoute(source.room, highwayRoom, avoidForRoute));
  if (!route || route.length > POWER_BANK_MAX_ROUTE_ROOMS) return { kind: "measured", ticks: null, rooms: [] };
  if (!claimPowerBankTravelBudget(1)) return { kind: "retry" };
  const allowed = new Set(expandPowerBankCorridor(route, avoidForRoute));
  const result = measureSampledCpuPhase("sourceIndex.search", () => searchPlanningPath(source.origin,
    { pos: new RoomPosition(25, 25, highwayRoom), range: INDEX_GOAL_RANGE }, {
      plainCost: 1,
      swampCost: 5,
      maxOps: INDEX_SEARCH_MAX_OPS,
      maxRooms: Math.min(POWER_BANK_MAX_ALLOWED_ROOMS, allowed.size),
      roomCallback: (roomName: string) => {
        if (!allowed.has(roomName)) return false;
        const room = Game.rooms[roomName];
        if (room?.controller?.owner && !room.controller.my) return false;
        return getCachedStaticTravelMatrix(roomName);
      },
    }));
  if (result.incomplete) {
    // 全局 ops 预算不足不是不可达证据，下次重试。
    if (result.reason === "budgetExhausted" && result.globalBudgetLimited) return { kind: "retry" };
    return { kind: "measured", ticks: null, rooms: [] };
  }
  const path = Array.isArray(result.path) ? result.path : [];
  const last = path[path.length - 1];
  if (last && last.roomName !== highwayRoom) return { kind: "measured", ticks: null, rooms: [] };
  const ticks = Number.isFinite(result.cost) && result.cost > 0 ? result.cost : path.length;
  const rooms = [...new Set(path.map(position => position.roomName))].filter(room => room !== source.room && room !== highwayRoom);
  return { kind: "measured", ticks, rooms };
}

function hasDiscoveredTask(): boolean {
  return Object.values(Memory.data?.powerBankHarvest ?? {})
    .some((task) => task?.status === POWER_BANK_STATUS.DISCOVERED && (task.nextAttemptAt ?? 0) <= Game.time);
}

/** 每 tick 推进索引：至多 1 对 PF 测量；待准入任务存在时把名额让给准入。 */
export function runPowerBankSourceIndex(): void {
  measureSampledCpuPhase("pb.sourceIndex", runPowerBankSourceIndexImpl);
}

function runPowerBankSourceIndexImpl(): void {
  if (typeof Game.map?.findRoute !== "function" || typeof Game.map.getRoomLinearDistance !== "function") return;
  const current = readFrame();
  if (current.sources.length === 0) return;
  const index = ensureState();
  const highwayRooms = getPowerBankSearchCandidates();
  const wanted = new Set(highwayRooms);
  for (const roomName of [...index.rooms.keys()]) {
    if (!wanted.has(roomName)) {
      index.rooms.delete(roomName);
      persist(roomName, undefined);
    }
  }
  if (highwayRooms.length === 0 || hasDiscoveredTask()) return;
  if (!canMeasurePowerBankTravelThisTick() || !hasPlanningCpuHeadroom()) return;

  const scan = Math.min(highwayRooms.length, INDEX_ROOM_SCAN_PER_TICK);
  for (let offset = 0; offset < scan; offset += 1) {
    const position = (index.cursor + offset) % highwayRooms.length;
    const highwayRoom = highwayRooms[position];
    let entry = currentRoomEntry(highwayRoom, index);
    if (entry?.complete && Game.time - entry.builtAt < POWER_BANK_SOURCE_INDEX_REFRESH_TICKS &&
        entry.buildStartedAt <= entry.builtAt) continue;
    if (!entry) {
      entry = { pairs: {}, entries: [], complete: false, builtAt: -1, buildStartedAt: Game.time, signature: roomSignature(highwayRoom),
        routeRooms: [], avoidedRooms: [...current.avoid].filter(room => linearDistance(room, highwayRoom) <= POWER_BANK_MAX_ROUTE_ROOMS), hadUnreachable: false };
      index.rooms.set(highwayRoom, entry);
    } else if (entry.complete && entry.buildStartedAt <= entry.builtAt) {
      // 过期刷新：旧 entries 继续服务准入，直到新一轮完整构建覆盖。
      entry.buildStartedAt = Game.time;
      entry.pairs = {};
      entry.avoidedRooms = [...current.avoid].filter(room => linearDistance(room, highwayRoom) <= POWER_BANK_MAX_ROUTE_ROOMS);
    }
    const source = nextPair(highwayRoom, entry, current.sources);
    if (!source) {
      entry.entries = computeEntries(
        Object.fromEntries(Object.entries(entry.pairs).filter(([, pair]) => pair.at >= entry!.buildStartedAt)),
        current.sources);
      entry.complete = true;
      entry.builtAt = Game.time;
      entry.routeRooms = [...new Set(Object.values(entry.pairs).flatMap(pair => pair.rooms))];
      entry.hadUnreachable = Object.values(entry.pairs).some(pair => pair.ticks === null);
      entry.pairs = {};
      persist(highwayRoom, entry);
      continue;
    }
    const result = measurePair(source, highwayRoom, current.avoid);
    index.cursor = position;
    if (result.kind === "measured") entry.pairs[source.room] = { ticks: result.ticks, at: Game.time, rooms: result.rooms };
    return;
  }
  index.cursor = (index.cursor + scan) % highwayRooms.length;
}

/** 已完成的索引条目（按行程升序）；未建完或失效时返回 undefined，调用方回退全量评估。 */
export function getPowerBankSourceIndexEntry(highwayRoom: string): readonly PowerBankSourceIndexEntry[] | undefined {
  if (typeof Game.map?.getRoomLinearDistance !== "function") return undefined;
  const current = readFrame();
  if (current.sources.length === 0) return undefined;
  const entry = currentRoomEntry(highwayRoom, ensureState());
  return entry?.complete && entry.entries.length > 0 ? entry.entries : undefined;
}

/** 某来源到高速房的索引行程（已完成条目或本轮已测 pair）；未知为 undefined。 */
export function getPowerBankSourceIndexTicks(highwayRoom: string, sourceRoom: string): number | undefined {
  if (typeof Game.map?.getRoomLinearDistance !== "function") return undefined;
  if (readFrame().sources.length === 0) return undefined;
  const entry = currentRoomEntry(highwayRoom, ensureState());
  if (!entry) return undefined;
  const listed = entry.entries.find((item) => item.room === sourceRoom);
  if (listed && entry.complete) return listed.ticks;
  const pair = entry.pairs[sourceRoom];
  return pair && pair.ticks !== null ? pair.ticks : undefined;
}

export function resetPowerBankSourceIndexForTest(): void {
  state = undefined;
  frame = undefined;
}
