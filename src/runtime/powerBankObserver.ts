import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { getPowerBankSearchRooms, POWER_BANK_SEARCH_RADIUS } from "@/runtime/powerBankSearch";
import { getPowerBankRoomThreat } from "@/runtime/powerBankThreat";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";

export { getPowerBankRoomThreat } from "@/runtime/powerBankThreat";

const OBSERVATION_REQUEST_TTL = 25;
const OBSERVATION_REQUEST_LIMIT = 64;
const TRANSIT_DANGER_TTL = 500;

interface PowerBankObserverRuntime {
  patrolIndex: number;
  updatedAt: number;
  lastObservedRooms: string[];
  coveredRooms: string[];
  /** 房间 -> 首次请求 tick；实际 observe 统一由本模块的调度阶段发布。 */
  requestedRooms?: Record<string, number>;
}

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
  return Game.map.getRoomLinearDistance(observer.room.name, roomName) <= POWER_BANK_SEARCH_RADIUS;
}

/** Harvest 在 Observer 阶段之后请求复看；不会覆盖本 tick 已发布的观察意图。 */
export function requestPowerBankObservation(roomName: string): boolean {
  if (!isPowerBankSearchRoom(roomName) || !getActiveObservers().some((observer) => canObserve(observer, roomName))) return false;
  const state = getRuntimeState();
  if (!state.requestedRooms || typeof state.requestedRooms !== "object" || Array.isArray(state.requestedRooms)) state.requestedRooms = {};
  const requests = state.requestedRooms;
  if (Object.prototype.hasOwnProperty.call(requests, roomName)) return true;
  if (Object.keys(requests).length >= OBSERVATION_REQUEST_LIMIT) return false;
  requests[roomName] = Game.time;
  return true;
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
  }
}

function getCoveredRooms(observers: StructureObserver[], candidates: string[]): string[] {
  return candidates.filter((roomName) => observers.some((observer) => canObserve(observer, roomName)));
}

function getPriorityRequests(state: PowerBankObserverRuntime): string[] {
  if (state.requestedRooms && (typeof state.requestedRooms !== "object" || Array.isArray(state.requestedRooms))) state.requestedRooms = {};
  const requests = state.requestedRooms ?? {};
  for (const [roomName, requestedAt] of Object.entries(requests)) {
    if (!isPowerBankSearchRoom(roomName) || !Number.isFinite(requestedAt) ||
        requestedAt > Game.time || Game.time - requestedAt > OBSERVATION_REQUEST_TTL || Game.rooms[roomName]) {
      delete requests[roomName];
    }
  }
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
  state.updatedAt = Game.time;
  state.coveredRooms = getCoveredRooms(observers, candidates);
  const requests = getPriorityRequests(state);
  const assigned = new Set<string>();
  const observed: string[] = [];
  let cursor = Number.isSafeInteger(state.patrolIndex) && state.patrolIndex >= 0 ? state.patrolIndex : 0;
  for (const observer of observers) {
    const priority = requests.find((roomName) => !assigned.has(roomName) && canObserve(observer, roomName));
    let roomName = priority;
    if (!roomName) {
      for (let offset = 0; offset < candidates.length; offset += 1) {
        const index = (cursor + offset) % candidates.length;
        const candidate = candidates[index];
        if (!assigned.has(candidate) && canObserve(observer, candidate)) {
          roomName = candidate;
          cursor = (index + 1) % candidates.length;
          break;
        }
      }
    }
    if (!roomName) continue;
    // 即使观察失败也推进普通轮巡游标；失败的优先请求移到队尾，避免饥饿。
    assigned.add(roomName);
    if (observer.observeRoom(roomName) === OK) {
      observed.push(roomName);
      if (state.requestedRooms) delete state.requestedRooms[roomName];
    } else if (priority && state.requestedRooms) {
      state.requestedRooms[roomName] = Game.time;
    }
  }
  state.patrolIndex = cursor;
  state.lastObservedRooms = observed;
}
