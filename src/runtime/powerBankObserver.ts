import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { recordDepositDiscovery } from "@/runtime/depositDiscovery";
import { getPowerBankSearchRooms, POWER_BANK_SEARCH_RADIUS } from "@/runtime/powerBankSearch";
import { getPowerBankRoomThreat } from "@/runtime/powerBankThreat";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";

export { getPowerBankRoomThreat } from "@/runtime/powerBankThreat";

const OBSERVATION_REQUEST_TTL = 25;
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
  coveredRooms: string[];
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
  const observers: StructureObserver[] = [];
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    const roomObservers = tickContext.getRoomContext(room)?.getMyStructures().filter(
      (structure): structure is StructureObserver => structure.structureType === STRUCTURE_OBSERVER &&
        (typeof structure.isActive !== "function" || structure.isActive()),
    ) ?? [];
    observers.push(...roomObservers);
  }
  return observers.sort((left, right) => left.id.localeCompare(right.id));
}

function canObserve(observer: StructureObserver, roomName: string): boolean {
  const distance = Game.map.getRoomLinearDistance(observer.room.name, roomName);
  return Number.isFinite(distance) && distance >= 0 && distance <= POWER_BANK_SEARCH_RADIUS;
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
  for (const room of Object.values(Game.rooms)) {
    if (!isPowerBankSearchRoom(room.name)) continue;
    if (getPowerBankRoomThreat(room)) {
      const runtime = getMemoryService().ensureRuntime();
      runtime.transitDangerRooms ??= {};
      runtime.transitDangerRooms[room.name] = Game.time + TRANSIT_DANGER_TTL;
    }
    for (const bank of room.find(FIND_STRUCTURES).filter(
      (structure): structure is StructurePowerBank => structure.structureType === STRUCTURE_POWER_BANK,
    )) recordPowerBankDiscovery(bank);
    for (const deposit of room.find(FIND_DEPOSITS)) recordDepositDiscovery(deposit);
  }
}

function getCoveredRooms(
  observers: StructureObserver[],
  candidates: string[],
  reachable = canObserve,
): string[] {
  return candidates.filter((roomName) => observers.some((observer) => reachable(observer, roomName)));
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
  const candidates = getPowerBankSearchRooms();
  const observers = getActiveObservers();
  return candidates.length > 0 && observers.length > 0 && getCoveredRooms(observers, candidates).length === candidates.length;
}

export function runPowerBankObserver(): void {
  scanVisibleSearchRooms();
  const observers = getActiveObservers();
  const state = getRuntimeState();
  const candidates = getPowerBankSearchRooms();
  const reachability = new Map<string, boolean>();
  const reachable = (observer: StructureObserver, roomName: string): boolean => {
    const key = `${observer.room.name}:${roomName}`;
    const cached = reachability.get(key);
    if (cached !== undefined) return cached;
    const result = canObserve(observer, roomName);
    reachability.set(key, result);
    return result;
  };
  state.updatedAt = Game.time;
  state.coveredRooms = getCoveredRooms(observers, candidates, reachable);
  if (!scheduled || scheduled.game !== Game || scheduled.tick !== Game.time || scheduled.state !== state) {
    scheduled = { game: Game, tick: Game.time, state, observerIds: new Set(), roomNames: new Set(), combatSlots: 0, remoteSlots: 0 };
  }
  const worldSize = worldSizeLimit();
  const requests = Object.fromEntries(REQUEST_KINDS.map((kind) => [kind, getPriorityRequests(state, kind, worldSize)])) as Record<RequestKind, string[]>;
  const assigned = scheduled.roomNames;
  const observed: string[] = [...state.lastObservedRooms];
  if (scheduled.observerIds.size === 0) observed.length = 0;
  let cursor = Number.isSafeInteger(state.patrolIndex) && state.patrolIndex >= 0 ? state.patrolIndex : 0;
  const normalizeCursor = (value: number | undefined, length: number): number =>
    Number.isSafeInteger(value) && value! >= 0 ? value! % length : 0;
  let priorityCursor = normalizeCursor(state.priorityKindCursor, REQUEST_KINDS.length);
  const patrol = (observer: StructureObserver): string | undefined => {
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const index = (cursor + offset) % candidates.length;
      const roomName = candidates[index];
      if (!assigned.has(roomName) && reachable(observer, roomName)) {
        cursor = (index + 1) % candidates.length;
        return roomName;
      }
    }
    return undefined;
  };
  const hasRequestSlot = (kind: RequestKind): boolean =>
    !((kind === "combat" && scheduled!.combatSlots >= 3) ||
      (kind === "remote" && scheduled!.remoteSlots >= 1));
  const eligible = (kind: RequestKind, observer: StructureObserver): string | undefined => {
    if (!hasRequestSlot(kind)) return undefined;
    return requests[kind].find((roomName) => !assigned.has(roomName) && reachable(observer, roomName));
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
    let choice: { roomName: string; kind: RequestKind } | undefined;
    let earliest = Infinity;
    for (let offset = 0; offset < REQUEST_KINDS.length; offset += 1) {
      const kind = REQUEST_KINDS[(priorityCursor + offset) % REQUEST_KINDS.length];
      if (!hasRequestSlot(kind)) continue;
      for (const roomName of requests[kind]) {
        if (assigned.has(roomName) || !reachable(observer, roomName) ||
          later.some((candidate) => reachable(candidate, roomName))) continue;
        const requestedAt = requestsFor(state, kind)[roomName];
        if (requestedAt < earliest) { earliest = requestedAt; choice = { roomName, kind }; }
      }
    }
    if (choice) priorityCursor = (REQUEST_KINDS.indexOf(choice.kind) + 1) % REQUEST_KINDS.length;
    return choice;
  };
  const submit = (observer: StructureObserver, roomName: string, kind?: RequestKind): void => {
    if (scheduled!.observerIds.has(observer.id)) return;
    // 即使观察失败也推进普通轮巡游标；失败的优先请求移到队尾，避免饥饿。
    assigned.add(roomName);
    scheduled!.observerIds.add(observer.id);
    if (kind === "combat") scheduled!.combatSlots += 1;
    if (kind === "remote") scheduled!.remoteSlots += 1;
    if (observer.observeRoom(roomName) === OK) {
      observed.push(roomName);
      for (const requestKind of REQUEST_KINDS) delete requestsFor(state, requestKind)[roomName];
    } else if (kind) {
      requestsFor(state, kind)[roomName] = Game.time;
    }
  };
  const available = observers.filter((observer) => !scheduled!.observerIds.has(observer.id));
  if (observers.length === 1 && available.length === 1) {
    const observer = available[0];
    const kinds = [...REQUEST_KINDS, "patrol"] as const;
    const start = normalizeCursor(state.singleObserverKindCursor, kinds.length);
    for (let offset = 0; offset < kinds.length; offset += 1) {
      const index = (start + offset) % kinds.length;
      const kind = kinds[index];
      const roomName = kind === "patrol" ? patrol(observer) : eligible(kind, observer);
      if (!roomName) continue;
      state.singleObserverKindCursor = (index + 1) % kinds.length;
      submit(observer, roomName, kind === "patrol" ? undefined : kind);
      break;
    }
  } else if (observers.length >= 2) {
    // 轮转保留普通巡逻的 Observer，避免固定保留者拥有独占覆盖范围时饿死请求。
    const patrolObserver = observers[Game.time % observers.length];
    const priorityObservers = available.filter((observer) => observer !== patrolObserver);
    for (let index = 0; index < priorityObservers.length; index += 1) {
      const observer = priorityObservers[index];
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
      const roomName = choice?.roomName ?? patrol(observer);
      if (roomName) submit(observer, roomName, choice?.kind);
    }
    if (available.includes(patrolObserver)) {
      const roomName = patrol(patrolObserver);
      if (roomName) submit(patrolObserver, roomName);
    }
  }
  state.priorityKindCursor = priorityCursor;
  state.patrolIndex = cursor;
  state.lastObservedRooms = observed;
}
