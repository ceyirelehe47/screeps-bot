import { tickPhase } from "@/runtime/cadence";
import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { recordDepositDiscovery } from "@/runtime/depositDiscovery";
import { getPowerBankSearchCandidates, POWER_BANK_SEARCH_RADIUS } from "@/runtime/powerBankSearch";
import { getPowerBankRoomStatus } from "@/runtime/powerBankMapFacts";
import { getPowerBankRoomThreat } from "@/runtime/powerBankThreat";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";

export { getPowerBankRoomThreat } from "@/runtime/powerBankThreat";

export const OBSERVATION_REQUEST_TTL = 25;
export const POWER_BANK_PATROL_INTERVAL = 500;
const OBSERVATION_REQUEST_LIMIT = 64;
const TRANSIT_DANGER_TTL = 500;
const REQUEST_KINDS = ["combat", "powerBank", "deposit", "remote"] as const;
type RequestKind = typeof REQUEST_KINDS[number];
const REQUEST_FIELDS = {
  combat: "combatRequestedRooms",
  powerBank: "requestedRooms",
  deposit: "depositRequestedRooms",
  remote: "remoteRequestedRooms",
} as const;

interface PowerBankObserverRuntime {
  patrolIndex: number;
  updatedAt: number;
  lastObservedRooms: string[];
  /** 当前来源候选中几何可观察的房间；包含可能关闭的房间，仅供诊断。 */
  coveredRooms: string[];
  /** 普通搜索每房的下一次扫描时刻；显式任务复看不受此间隔限制。 */
  patrolNextScanAt?: Record<string, number>;
  /** 房间 -> 首次请求 tick；实际 observe 统一由本模块的调度阶段发布。 */
  requestedRooms?: Record<string, number>;
  combatRequestedRooms?: Record<string, number>;
  depositRequestedRooms?: Record<string, number>;
  remoteRequestedRooms?: Record<string, number>;
  priorityKindCursor?: number;
  singleObserverKindCursor?: number;
}

let scheduled: {
  game: Game;
  tick: number;
  state: PowerBankObserverRuntime;
  observerIds: Set<string>;
  roomNames: Set<string>;
  combatSlots: number;
  remoteSlots: number;
} | undefined;

// 活跃结构与地图距离来自同一帧原生快照；请求、覆盖和调度共享一次查询。
let observerSnapshot: {
  game: Game;
  tick: number;
  context: ReturnType<typeof getTickContextService>;
  observers: StructureObserver[];
  reachability: Map<string, boolean>;
  worldSize?: number;
} | undefined;

// 只保留已与原生结果一致的纯坐标距离；不缓存活跃 Observer 或任务资格。
const observerDistances = new Map<string, number>();
const OBSERVER_DISTANCE_CACHE_LIMIT = 1024;

function coordinateDistance(from: string, to: string): number | undefined {
  const coordinates = (name: string): [number, number] | undefined => {
    const match = /^([EW])(0|[1-9]\d*)([NS])(0|[1-9]\d*)$/.exec(name);
    if (!match) return undefined;
    const x = Number(match[2]), y = Number(match[4]);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined;
    return [match[1] === "E" ? x : -x - 1, match[3] === "S" ? y : -y - 1];
  };
  const a = coordinates(from), b = coordinates(to);
  return a && b ? Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) : undefined;
}

let coverageSnapshot: {
  game: Game;
  tick: number;
  context: ReturnType<typeof getTickContextService>;
  observers: readonly StructureObserver[];
  candidates: readonly string[];
  coveredRooms: readonly string[];
} | undefined;

function getRuntimeState(): PowerBankObserverRuntime {
  const runtime = getMemoryService().ensureRuntime();
  runtime.powerBankObserver ??= {
    patrolIndex: 0,
    updatedAt: Game.time,
    lastObservedRooms: [],
    coveredRooms: [],
  };
  return runtime.powerBankObserver;
}

function getActiveObservers(): StructureObserver[] {
  const tickContext = getTickContextService();
  if (observerSnapshot?.game === Game && observerSnapshot.tick === Game.time && observerSnapshot.context === tickContext &&
      observerSnapshot.observers.every(observer => Game.rooms[observer.room.name] === observer.room && observer.room.controller?.my)) return observerSnapshot.observers;
  if (observerSnapshot && (Game.time <= observerSnapshot.tick)) observerDistances.clear();
  const observers: StructureObserver[] = [];
  for (const room of tickContext.getMyRooms()) {
    const currentRoom = Game.rooms[room.name];
    if (!currentRoom?.controller?.my) continue;
    const roomObservers = tickContext.getRoomContext(currentRoom)?.getMyStructuresByType(STRUCTURE_OBSERVER).filter(
      (structure): structure is StructureObserver => structure.structureType === STRUCTURE_OBSERVER &&
        (typeof structure.isActive !== "function" || structure.isActive()),
    ) ?? [];
    observers.push(...roomObservers);
  }
  observers.sort((left, right) => left.id.localeCompare(right.id));
  observerSnapshot = { game: Game, tick: Game.time, context: tickContext, observers, reachability: new Map(), worldSize: worldSizeLimit() };
  return observers;
}

function canObserve(observer: StructureObserver, roomName: string): boolean {
  const key = `${observer.room.name}:${roomName}`;
  const cached = observerSnapshot?.reachability.get(key);
  if (cached !== undefined) return cached;
  const geometryKey = `${Game.shard?.name ?? "unknown"}:${observerSnapshot?.worldSize ?? "unknown"}:${key}`;
  let distance = observerDistances.get(geometryKey);
  if (distance === undefined) {
    distance = Game.map.getRoomLinearDistance(observer.room.name, roomName);
    // native 默认 continuous=false，即不环绕边界的 Chebyshev 距离。
    // 自定义地图或不一致的 mock 回到原生逐帧查询，不把未知结果持久复用。
    if (distance === coordinateDistance(observer.room.name, roomName)) {
      if (observerDistances.size >= OBSERVER_DISTANCE_CACHE_LIMIT) observerDistances.delete(observerDistances.keys().next().value!);
      observerDistances.set(geometryKey, distance);
    }
  }
  const result = Number.isFinite(distance) && distance >= 0 && distance <= POWER_BANK_SEARCH_RADIUS;
  observerSnapshot?.reachability.set(key, result);
  return result;
}

function worldSizeLimit(): number | undefined {
  const value = typeof Game.map.getWorldSize === "function" ? Game.map.getWorldSize() : undefined;
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validRoomName(roomName: string, worldSize: number | undefined): boolean {
  const match = /^([EW])(0|[1-9]\d*)([NS])(0|[1-9]\d*)$/.exec(roomName);
  if (!match) return false;
  const horizontal = Number(match[2]), vertical = Number(match[4]);
  if (!Number.isSafeInteger(horizontal) || !Number.isSafeInteger(vertical)) return false;
  if (worldSize !== undefined) {
    const minimum = -Math.floor(worldSize / 2);
    const x = match[1] === "E" ? horizontal : -horizontal - 1;
    const y = match[3] === "S" ? vertical : -vertical - 1;
    if (x < minimum || y < minimum || x >= minimum + worldSize || y >= minimum + worldSize) return false;
  }
  return true;
}

function validRequestRoom(kind: RequestKind, roomName: string, worldSize: number | undefined): boolean {
  return validRoomName(roomName, worldSize) &&
    ((kind !== "powerBank" && kind !== "deposit") || isPowerBankSearchRoom(roomName));
}

function requestsFor(state: PowerBankObserverRuntime, kind: RequestKind): Record<string, number> {
  const field = REQUEST_FIELDS[kind];
  let requests = state[field];
  if (!requests || typeof requests !== "object" || Array.isArray(requests)) {
    requests = {};
    state[field] = requests;
  }
  return requests;
}

function trimRequests(state: PowerBankObserverRuntime, kind: RequestKind, consumeVisible: boolean, worldSize: number | undefined): void {
  const requests = requestsFor(state, kind);
  for (const [roomName, requestedAt] of Object.entries(requests)) {
    if (!validRequestRoom(kind, roomName, worldSize) || !Number.isFinite(requestedAt) ||
        requestedAt > Game.time || Game.time - requestedAt > OBSERVATION_REQUEST_TTL ||
        (consumeVisible && Game.rooms[roomName])) delete requests[roomName];
  }
}

function requestObservation(kind: RequestKind, roomName: string): boolean {
  const worldSize = worldSizeLimit();
  if (!validRequestRoom(kind, roomName, worldSize) || !getActiveObservers().some((observer) => canObserve(observer, roomName))) return false;
  const state = getRuntimeState();
  for (const requestKind of REQUEST_KINDS) trimRequests(state, requestKind, false, worldSize);
  const requests = requestsFor(state, kind);
  if (Object.prototype.hasOwnProperty.call(requests, roomName)) return true;
  const count = REQUEST_KINDS.reduce((total, requestKind) => total + Object.keys(requestsFor(state, requestKind)).length, 0);
  if (count >= OBSERVATION_REQUEST_LIMIT) return false;
  requests[roomName] = Game.time;
  return true;
}

/** Harvest 在 Observer 阶段之后请求复看；不会覆盖本 tick 已发布的观察意图。 */
export function requestPowerBankObservation(roomName: string): boolean {
  return requestObservation("powerBank", roomName);
}

export function requestCombatObservation(roomName: string): boolean {
  return requestObservation("combat", roomName);
}

export function requestDepositObservation(roomName: string): boolean {
  return requestObservation("deposit", roomName);
}

export function requestRemoteObservation(roomName: string): boolean {
  return requestObservation("remote", roomName);
}

function scanVisibleSearchRooms(): void {
  const tickContext = getTickContextService();
  for (const room of Object.values(Game.rooms)) {
    if (!isPowerBankSearchRoom(room.name)) continue;
    if (getPowerBankRoomThreat(room)) {
      const runtime = getMemoryService().ensureRuntime();
      runtime.transitDangerRooms ??= {};
      runtime.transitDangerRooms[room.name] = Game.time + TRANSIT_DANGER_TTL;
    }
    const candidate = tickContext.getRoomContext(room);
    const context = candidate?.room === room ? candidate : null;
    for (const bank of (context?.getStructuresByType(STRUCTURE_POWER_BANK) ?? room.find(FIND_STRUCTURES)).filter(
      (structure): structure is StructurePowerBank => structure.structureType === STRUCTURE_POWER_BANK,
    )) recordPowerBankDiscovery(bank);
    for (const deposit of context?.getDeposits() ?? room.find(FIND_DEPOSITS)) recordDepositDiscovery(deposit);
  }
}

function getCoveredRooms(
  observers: readonly StructureObserver[],
  candidates: readonly string[],
  reachable = canObserve,
): string[] {
  return candidates.filter((roomName) => observers.some((observer) => reachable(observer, roomName)));
}

function getCoverageSnapshot(observers: readonly StructureObserver[], candidates: readonly string[]): NonNullable<typeof coverageSnapshot> {
  const context = getTickContextService();
  if (coverageSnapshot?.game === Game && coverageSnapshot.tick === Game.time && coverageSnapshot.context === context &&
      coverageSnapshot.observers === observers && coverageSnapshot.candidates.length === candidates.length &&
      coverageSnapshot.candidates.every((name, index) => name === candidates[index])) return coverageSnapshot;
  const coveredRooms = Object.freeze(getCoveredRooms(observers, candidates));
  coverageSnapshot = { game: Game, tick: Game.time, context, observers, candidates: Object.freeze([...candidates]), coveredRooms };
  return coverageSnapshot;
}

function getPriorityRequests(state: PowerBankObserverRuntime, kind: RequestKind, worldSize: number | undefined): string[] {
  // 新类别是显式下一 tick 的 fresh 请求；当前可见不代表下一 tick 可见。
  // 旧 PB 表保留看到房间即消费请求的兼容语义。
  trimRequests(state, kind, kind === "powerBank", worldSize);
  const requests = requestsFor(state, kind);
  return Object.keys(requests).sort((left, right) => requests[left] - requests[right] || left.localeCompare(right));
}

export function hasPowerBankObserverCoverage(): boolean {
  // 集合由来源房位置独立生成，不能把 Observer 自己能看的集合当作覆盖证明。
  const candidates = getPowerBankSearchCandidates();
  const observers = getActiveObservers();
  if (candidates.length === 0 || observers.length === 0) return false;
  const covered = new Set(getCoverageSnapshot(observers, candidates).coveredRooms);
  return measureSampledCpuPhase("coverageStatus", () => {
    // 已有几何覆盖的房间无论开闭都不会形成盲区；仅盲区必须逐房核验。
    for (const roomName of candidates) {
      if (!covered.has(roomName) && isOpenRoom(roomName)) return false;
    }
    // 保留旧合同：全目录均关闭时不能自证具备完整搜索覆盖。
    for (const roomName of covered) {
      if (isOpenRoom(roomName)) return true;
    }
    return false;
  });
}

function isOpenRoom(roomName: string): boolean {
  if (typeof Game.map.getRoomStatus !== "function") return true;
  try {
    const status = getPowerBankRoomStatus(roomName);
    return status !== null && status.status !== "closed";
  } catch {
    return false;
  }
}

export function runPowerBankObserver(): void {
  measureSampledCpuPhase("pb.observer", runPowerBankObserverImpl);
}

function runPowerBankObserverImpl(): void {
  measureSampledCpuPhase("scanVisible", scanVisibleSearchRooms);
  const observers = measureSampledCpuPhase("getActiveObservers", getActiveObservers);
  const state = getRuntimeState();
  const candidates = measureSampledCpuPhase("searchRooms", getPowerBankSearchCandidates);
  const searchRooms = new Set(candidates);
  if (!state.patrolNextScanAt || typeof state.patrolNextScanAt !== "object" || Array.isArray(state.patrolNextScanAt)) {
    state.patrolNextScanAt = {};
  }
  const patrolNextScanAt = state.patrolNextScanAt;
  measureSampledCpuPhase("patrolState", () => {
    for (const [name, nextAt] of Object.entries(patrolNextScanAt)) {
      if (!searchRooms.has(name) || !Number.isFinite(nextAt) || nextAt < 0 || nextAt > Game.time + POWER_BANK_PATROL_INTERVAL) {
        delete patrolNextScanAt[name];
      }
    }
  });
  const reachable = canObserve;
  state.updatedAt = Game.time;
  state.coveredRooms = measureSampledCpuPhase("coverage", () => [...getCoverageSnapshot(observers, candidates).coveredRooms]);
  if (!scheduled || scheduled.game !== Game || scheduled.tick !== Game.time || scheduled.state !== state) {
    scheduled = { game: Game, tick: Game.time, state, observerIds: new Set(), roomNames: new Set(), combatSlots: 0, remoteSlots: 0 };
  }
  const worldSize = worldSizeLimit();
  const requests = measureSampledCpuPhase("priorityRequests", () => Object.fromEntries(
    REQUEST_KINDS.map((kind) => [kind, getPriorityRequests(state, kind, worldSize)]),
  )) as Record<RequestKind, string[]>;
  const assigned = scheduled.roomNames;
  const observed: string[] = [...state.lastObservedRooms];
  if (scheduled.observerIds.size === 0) observed.length = 0;
  let cursor = Number.isSafeInteger(state.patrolIndex) && state.patrolIndex >= 0 ? state.patrolIndex : 0;
  const normalizeCursor = (value: number | undefined, length: number): number =>
    Number.isSafeInteger(value) && value! >= 0 ? value! % length : 0;
  let priorityCursor = normalizeCursor(state.priorityKindCursor, REQUEST_KINDS.length);
  const patrol = (observer: StructureObserver): string | undefined => measureSampledCpuPhase("patrol", () => {
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const index = (cursor + offset) % candidates.length;
      const roomName = candidates[index];
      if (assigned.has(roomName) || Game.time < (patrolNextScanAt[roomName] ?? 0)) continue;
      if (!reachable(observer, roomName) || !isOpenRoom(roomName)) continue;
      // 本 tick 的真实视野已由前面的发现扫描处理，复用它并延后普通观察。
      if (Game.rooms[roomName]) {
        patrolNextScanAt[roomName] = Game.time + POWER_BANK_PATROL_INTERVAL;
        continue;
      }
      cursor = (index + 1) % candidates.length;
      return roomName;
    }
    return undefined;
  });
  const hasRequestSlot = (kind: RequestKind): boolean =>
    !((kind === "combat" && scheduled!.combatSlots >= 3) ||
      (kind === "remote" && scheduled!.remoteSlots >= 1));
  const eligible = (kind: RequestKind, observer: StructureObserver): string | undefined => {
    if (!hasRequestSlot(kind)) return undefined;
    return requests[kind].find((roomName) => !assigned.has(roomName) && reachable(observer, roomName) && isOpenRoom(roomName));
  };
  const rotateRequest = (observer: StructureObserver, kinds: readonly RequestKind[]): { roomName: string; kind: RequestKind } | undefined => {
    for (let offset = 0; offset < REQUEST_KINDS.length; offset += 1) {
      const index = (priorityCursor + offset) % REQUEST_KINDS.length;
      const kind = REQUEST_KINDS[index];
      if (!kinds.includes(kind)) continue;
      const roomName = eligible(kind, observer);
      if (roomName) {
        priorityCursor = (index + 1) % REQUEST_KINDS.length;
        return { roomName, kind };
      }
    }
    return undefined;
  };
  // 请求总量受 64 上限约束，reachability 在本次调度中复用。先保留当前
  // Observer 独占覆盖的实际房间，不能只按后续还能服务的类别数量预留。
  const uniqueRequest = (observer: StructureObserver, later: readonly StructureObserver[]): { roomName: string; kind: RequestKind } | undefined => {
    // 最后一格没有后续覆盖可丢，继续原类别预留；积压 combat 不能抢走 remote 的末格。
    if (later.length === 0) return undefined;
    const choices: { roomName: string; kind: RequestKind; requestedAt: number }[] = [];
    for (let offset = 0; offset < REQUEST_KINDS.length; offset += 1) {
      const kind = REQUEST_KINDS[(priorityCursor + offset) % REQUEST_KINDS.length];
      if (!hasRequestSlot(kind)) continue;
      for (const roomName of requests[kind]) {
        if (assigned.has(roomName) || !reachable(observer, roomName) ||
          later.some((candidate) => reachable(candidate, roomName))) continue;
        choices.push({ roomName, kind, requestedAt: requestsFor(state, kind)[roomName] });
      }
    }
    // 稳定排序保留同时间请求的原类别轮转顺序，只核验真正候选的开放状态。
    const choice = choices.sort((left, right) => left.requestedAt - right.requestedAt).find(candidate => isOpenRoom(candidate.roomName));
    if (choice) priorityCursor = (REQUEST_KINDS.indexOf(choice.kind) + 1) % REQUEST_KINDS.length;
    return choice;
  };
  const submit = (observer: StructureObserver, roomName: string, kind?: RequestKind): void => measureSampledCpuPhase("submit", () => {
    if (scheduled!.observerIds.has(observer.id) || !isOpenRoom(roomName)) return;
    // 即使观察失败也推进普通轮巡游标；失败的优先请求移到队尾，避免饥饿。
    assigned.add(roomName);
    scheduled!.observerIds.add(observer.id);
    if (kind === "combat") scheduled!.combatSlots += 1;
    if (kind === "remote") scheduled!.remoteSlots += 1;
    if (observer.observeRoom(roomName) === OK) {
      observed.push(roomName);
      if (searchRooms.has(roomName)) patrolNextScanAt[roomName] = Game.time + POWER_BANK_PATROL_INTERVAL;
      for (const requestKind of REQUEST_KINDS) delete requestsFor(state, requestKind)[roomName];
    } else if (kind) {
      requestsFor(state, kind)[roomName] = Game.time;
    }
  });
  measureSampledCpuPhase("schedule", () => {
    const available = observers.filter((observer) => !scheduled!.observerIds.has(observer.id));
    if (observers.length === 1 && available.length === 1) {
      const observer = available[0];
      const kinds = [...REQUEST_KINDS, "patrol"] as const;
      const start = normalizeCursor(state.singleObserverKindCursor, kinds.length);
      for (let offset = 0; offset < kinds.length; offset += 1) {
        const index = (start + offset) % kinds.length;
        const kind = kinds[index];
        const roomName = kind === "patrol" ? patrol(observer) : measureSampledCpuPhase("priority", () => eligible(kind, observer));
        if (!roomName) continue;
        state.singleObserverKindCursor = (index + 1) % kinds.length;
        submit(observer, roomName, kind === "patrol" ? undefined : kind);
        break;
      }
    } else if (observers.length >= 2) {
      // 轮转保留普通巡逻的 Observer，避免固定保留者拥有独占覆盖范围时饿死请求。
      const patrolObserver = observers[tickPhase(Game.time, observers.length)];
      const priorityObservers = available.filter((observer) => observer !== patrolObserver);
      for (let index = 0; index < priorityObservers.length; index += 1) {
        const observer = priorityObservers[index];
        const choice = measureSampledCpuPhase("priority", () => {
          let choice = uniqueRequest(observer, priorityObservers.slice(index + 1));
          if (!choice && observers.length >= REQUEST_KINDS.length + 1) {
            const remaining = priorityObservers.slice(index);
            const reserved = REQUEST_KINDS.filter((kind) => kind !== "combat" &&
              remaining.some((candidate) => eligible(kind, candidate) !== undefined)).length;
            const combatRoom = eligible("combat", observer);
            if (combatRoom && remaining.length > reserved) {
              choice = { roomName: combatRoom, kind: "combat" };
              priorityCursor = 1;
            } else {
              choice = rotateRequest(observer, ["powerBank", "deposit", "remote"]);
              if (!choice && combatRoom) choice = { roomName: combatRoom, kind: "combat" };
            }
          } else if (!choice) {
            choice = rotateRequest(observer, REQUEST_KINDS);
          }
          return choice;
        });
        const roomName = choice?.roomName ?? patrol(observer);
        if (roomName) submit(observer, roomName, choice?.kind);
      }
      if (available.includes(patrolObserver)) {
        const roomName = patrol(patrolObserver);
        if (roomName) submit(patrolObserver, roomName);
        else {
          // 没有到期搜索房时，空闲的巡逻名额继续服务当前任务复看。
          const choice = measureSampledCpuPhase("priority", () => rotateRequest(patrolObserver, REQUEST_KINDS));
          if (choice) submit(patrolObserver, choice.roomName, choice.kind);
        }
      }
    }
  });
  state.priorityKindCursor = priorityCursor;
  state.patrolIndex = cursor;
  state.lastObservedRooms = observed;
}
