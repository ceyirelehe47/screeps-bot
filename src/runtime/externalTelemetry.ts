import { getCpuMonitorHistory, normalizeCpuMonitorConfig } from "@/runtime/cpuMonitor";
import type {
  CpuMonitorSnapshotV2,
  CpuMonitorSummaryV2,
  CpuMonitorConfig,
  CpuMonitorRoomSummary,
} from "@/runtime/cpuMonitor";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getCreepMovementState, getMovementAnalytics } from "@/movement";
import type { MovementMetricBucket } from "@/movement/metrics";
import {
  getAssignedWorkerTaskId,
  peekWorkerTasksByRoom,
} from "@/runtime/workerTaskPool";

const DEFAULT_SAMPLE_INTERVAL = 10;
const MIN_SAMPLE_INTERVAL = 5;
const MAX_SAMPLE_INTERVAL = 100;
const DEFAULT_SEGMENT_ID = 90;
const MAX_SEGMENT_PAYLOAD_BYTES = 95_000;
const MAX_DEBUG_CREEPS = 25;
const MAX_DEBUG_ROUTE_ROOMS = 25;
const MAX_DEBUG_VISITED_ROOMS = 20;
const MAX_MOVEMENT_TELEMETRY_ROOMS = 16;

interface RoomCreepTelemetry {
  workerCount: number;
  carrierCount: number;
  harvesterCount: number;
  unassignedWorkers: number;
  carrierStuckTotal: number;
  carrierStuckCount: number;
}

interface RoomTaskTelemetry {
  buildTasks: number;
  repairTasks: number;
  upgradeTasks: number;
}

interface RoomSpawnTelemetry {
  queueDepth: number;
  spawningCount: number;
}

interface ExternalTelemetryRoomSnapshot {
  roomName: string;
  controllerLevel: number;
  controllerProgress: number;
  energyAvailable: number;
  energyCapacity: number;
  workerCount: number;
  carrierCount: number;
  harvesterCount: number;
  unassignedWorkers: number;
  avgCarrierStuckTicks: number;
  taskQueueDepth: number;
  buildTasks: number;
  repairTasks: number;
  upgradeTasks: number;
  spawnQueueDepth: number;
  spawnSpawning: number;
  productionUpdatedAt?: number;
  productionSignal?: {
    looseEnergyTrend: number;
    sourceEnergyTrend: number;
    upgradeRate: number;
    spawnBusy: number;
  };
  movement?: {
    pathRequests: number;
    pathCacheHits: number;
    pathRepaths: number;
    yieldPushes: number;
    travelRequests: number;
    travelFallbacks: number;
    travelRepaths: number;
    multiRoomSearches: number;
    multiRoomSegmentHits: number;
    multiRoomSegmentInvalidations: number;
    exitRecoveries: number;
    stateClears: number;
  };
}

interface CpuMonitorTelemetryEntry {
  tick: number;
  shard: string;
  totalUsed: number;
  startupUsed?: number;
  tickUsedAtFlush?: number;
  topLevelUsed?: number;
  bucket: number;
  limit: number;
  tickLimit: number;
  phases: Record<string, number>;
  fixedActionCounts: Record<string, number>;
  fixedActionEstimate: number;
  untracked: number;
  emaTotalUsed: number;
  rooms?: Record<string, CpuMonitorRoomSummary>;
  heap?: {
    used_heap_size: number;
    total_heap_size: number;
    heap_size_limit: number;
  } | null;
}

interface CpuMonitorTelemetrySummary {
  ticks: number;
  avgTotalUsed: number;
  maxTotalUsed: number;
  minBucket: number;
  maxBucket: number;
  avgBucket: number;
  avgUntracked: number;
  emaTotalUsed: number;
  fixedActionEstimate: number;
  topPhases: Record<string, number>;
  topRoomRoles: Array<{ room: string; role: string; avgUsed: number; count: number }>;
}

interface CpuMonitorTelemetryPayload {
  version: 2;
  latest: CpuMonitorTelemetryEntry | null;
  summary: CpuMonitorTelemetrySummary | null;
  history: CpuMonitorTelemetryEntry[];
  config: {
    sampleInterval: number;
    historyLimit: number;
    fixedActionCpuCost: number;
  };
}

interface ExternalTelemetrySnapshot {
  version: 2;
  tick: number;
  shard: string;
  sampleInterval: number;
  segmentId: number;
  cpu: {
    used: number;
    bucket: number;
    limit: number;
    tickLimit: number;
  };
  gcl: {
    level: number;
    progress: number;
    progressTotal: number;
  };
  totals: {
    rooms: number;
    workers: number;
    carriers: number;
    harvesters: number;
    unassignedWorkers: number;
    taskQueueDepth: number;
    spawnQueueDepth: number;
    activeSpawns: number;
    movement?: {
      pathRequests: number;
      pathCacheHits: number;
      pathRepaths: number;
      yieldPushes: number;
      travelRequests: number;
      travelFallbacks: number;
      travelRepaths: number;
      multiRoomSearches: number;
      multiRoomSegmentHits: number;
      multiRoomSegmentInvalidations: number;
      exitRecoveries: number;
      stateClears: number;
    };
  };
  movementRooms?: Record<string, MovementMetricBucket>;
  debug?: ExternalTelemetryDebugSnapshot;
  cpuMonitor?: CpuMonitorTelemetryPayload;
  rooms: ExternalTelemetryRoomSnapshot[];
  truncated?: boolean;
}

interface ExternalTelemetryDebugSnapshot {
  creeps: DebugCreepTelemetry[];
  colonization: DebugColonizationTelemetry[];
  counts: {
    creepsWithMovementState: number;
    creepsWithTravelState: number;
    stuckCreeps: number;
    colonizationTasks: number;
  };
  truncated?: boolean;
}

interface DebugCreepTelemetry {
  name: string;
  role?: string;
  roomName: string;
  x: number;
  y: number;
  ticksToLive?: number;
  configName?: string;
  targetRoom?: string;
  roleArgs?: unknown[];
  scoutVisitedRooms?: string[];
  travelState?: {
    targetRoom: string;
    stuckTicks: number;
    lastPosKey?: string;
    lastWasExit?: boolean;
  };
  movePathState?: {
    targetRoom: string;
    targetX: number;
    targetY: number;
    range: number;
    stuckTicks: number;
    expiresAt: number;
  };
  workAnchor?: {
    x: number;
    y: number;
    roomName: string;
    range: number;
  };
}

interface DebugColonizationTelemetry {
  targetRoom: string;
  sourceRoom: string;
  status: string;
  mode?: string;
  scoutSafe?: boolean;
  claimCompleted?: boolean;
  scoutedAt?: number;
  scoutRouteRooms?: string[];
  dangerousRooms?: string[];
  safeRouteRetryAt?: number;
  temporaryDangerousRoomCount?: number;
  permanentDangerousRoomCount?: number;
}


function toValidSampleInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SAMPLE_INTERVAL;
  }
  const normalized = Math.floor(value);
  return Math.max(MIN_SAMPLE_INTERVAL, Math.min(MAX_SAMPLE_INTERVAL, normalized));
}

function toValidSegmentId(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SEGMENT_ID;
  }
  const normalized = Math.floor(value);
  return Math.max(0, Math.min(99, normalized));
}

function ensureRoomCreepTelemetry(
  stats: Record<string, RoomCreepTelemetry>,
  roomName: string,
): RoomCreepTelemetry {
  const current = stats[roomName];
  if (current) {
    return current;
  }

  const next: RoomCreepTelemetry = {
    workerCount: 0,
    carrierCount: 0,
    harvesterCount: 0,
    unassignedWorkers: 0,
    carrierStuckTotal: 0,
    carrierStuckCount: 0,
  };
  stats[roomName] = next;
  return next;
}

function ensureRoomTaskTelemetry(stats: Record<string, RoomTaskTelemetry>, roomName: string): RoomTaskTelemetry {
  const current = stats[roomName];
  if (current) {
    return current;
  }

  const next: RoomTaskTelemetry = {
    buildTasks: 0,
    repairTasks: 0,
    upgradeTasks: 0,
  };
  stats[roomName] = next;
  return next;
}

function ensureRoomSpawnTelemetry(
  stats: Record<string, RoomSpawnTelemetry>,
  roomName: string,
): RoomSpawnTelemetry {
  const current = stats[roomName];
  if (current) {
    return current;
  }

  const next: RoomSpawnTelemetry = {
    queueDepth: 0,
    spawningCount: 0,
  };
  stats[roomName] = next;
  return next;
}

function collectCreepTelemetryByRoom(ownedRooms: Room[]): Record<string, RoomCreepTelemetry> {
  const stats: Record<string, RoomCreepTelemetry> = {};
  const tickContext = getTickContextService();

  for (const room of ownedRooms) {
    for (const creep of tickContext.getCreepsByRoom(room.name)) {
      const roomStats = ensureRoomCreepTelemetry(stats, creep.room.name);
      const role = creep.memory.role;

      if (role === "worker") {
        roomStats.workerCount += 1;
        if (!getAssignedWorkerTaskId(creep.name)) {
          roomStats.unassignedWorkers += 1;
        }
        continue;
      }

      if (role === "carrier") {
        roomStats.carrierCount += 1;
        const stuckTicks = getCreepMovementState(creep.name)?.travelState?.stuckTicks;
        if (typeof stuckTicks === "number" && Number.isFinite(stuckTicks) && stuckTicks >= 0) {
          roomStats.carrierStuckTotal += stuckTicks;
          roomStats.carrierStuckCount += 1;
        }
        continue;
      }

      if (role === "harvester") {
        roomStats.harvesterCount += 1;
      }
    }
  }

  return stats;
}

function collectTaskTelemetryByRoom(): Record<string, RoomTaskTelemetry> {
  const stats: Record<string, RoomTaskTelemetry> = {};

  for (const roomName of Object.keys(Game.rooms)) {
    const tasks = peekWorkerTasksByRoom(roomName);
    if (Object.keys(tasks).length === 0) {
      continue;
    }

    const roomStats = ensureRoomTaskTelemetry(stats, roomName);
    for (const task of Object.values(tasks)) {
      if (task.type === "build") {
        roomStats.buildTasks += 1;
        continue;
      }
      if (task.type === "repair") {
        roomStats.repairTasks += 1;
        continue;
      }
      if (task.type === "upgrade") {
        roomStats.upgradeTasks += 1;
      }
    }
  }

  return stats;
}

function collectSpawnTelemetryByRoom(ownedRooms: Room[]): Record<string, RoomSpawnTelemetry> {
  const stats: Record<string, RoomSpawnTelemetry> = {};
  const tickContext = getTickContextService();

  for (const room of ownedRooms) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      const roomStats = ensureRoomSpawnTelemetry(stats, spawn.room.name);
      roomStats.queueDepth += spawn.memory.spawnList?.length || 0;
      if (spawn.spawning) {
        roomStats.spawningCount += 1;
      }
    }
  }

  return stats;
}

function getCreepTargetRoom(creep: Creep): string | undefined {
  const args = creep.memory.roleArgs;
  if (!Array.isArray(args) || typeof args[0] !== "string") {
    return undefined;
  }

  return args[0];
}

function isInterestingDebugCreep(creep: Creep, state: ReturnType<typeof getCreepMovementState>): boolean {
  const role = creep.memory.role;
  if (state?.travelState || state?.movePathState || state?.workAnchor) {
    return true;
  }

  return (
    role === "scout" ||
    role === "claimer" ||
    role === "colonizerHarvester" ||
    role === "colonizerWorker" ||
    role === "flagScout"
  );
}

function scoreDebugCreep(creep: Creep, state: ReturnType<typeof getCreepMovementState>): number {
  const role = creep.memory.role;
  let score = 0;
  if (role === "scout" || role === "flagScout") score += 100;
  if (role === "claimer" || role === "colonizerHarvester" || role === "colonizerWorker") score += 80;
  if ((state?.travelState?.stuckTicks ?? 0) >= 2) score += 70;
  if ((state?.movePathState?.stuckTicks ?? 0) >= 2) score += 50;
  if (state?.travelState) score += 30;
  if (state?.movePathState) score += 10;
  if (state?.workAnchor) score += 5;
  return score;
}

function projectDebugCreeps(selected: Array<{ creep: Creep; state: ReturnType<typeof getCreepMovementState> }>): DebugCreepTelemetry[] {
  return selected.map(({ creep, state }) => {
    const movePathState = state?.movePathState;
    return {
      name: creep.name,
      role: creep.memory.role,
      roomName: creep.room.name,
      x: creep.pos.x,
      y: creep.pos.y,
      ticksToLive: creep.ticksToLive,
      configName: creep.memory.configName,
      targetRoom: state?.travelState?.targetRoom || getCreepTargetRoom(creep),
      roleArgs: Array.isArray(creep.memory.roleArgs) ? creep.memory.roleArgs.slice(0, 4) : undefined,
      scoutVisitedRooms: creep.memory.scoutVisitedRooms?.slice(-MAX_DEBUG_VISITED_ROOMS),
      travelState: state?.travelState
        ? {
            targetRoom: state.travelState.targetRoom,
            stuckTicks: state.travelState.stuckTicks,
            lastPosKey: state.travelState.lastPosKey,
            lastWasExit: state.travelState.lastWasExit,
          }
        : undefined,
      movePathState: movePathState
        ? {
            targetRoom: movePathState.targetRoom,
            targetX: movePathState.targetX,
            targetY: movePathState.targetY,
            range: movePathState.range,
            stuckTicks: movePathState.stuckTicks,
            expiresAt: movePathState.expiresAt,
          }
        : undefined,
      workAnchor: state?.workAnchor,
    } satisfies DebugCreepTelemetry;
  });
}

function collectDebugColonization(): DebugColonizationTelemetry[] {
  const colonization = Memory.data?.colonization || {};
  return Object.values(colonization).map((task) => ({
    targetRoom: task.targetRoom,
    sourceRoom: task.sourceRoom,
    status: task.status,
    mode: task.mode,
    scoutSafe: task.scoutSafe,
    claimCompleted: task.claimCompleted,
    scoutedAt: task.scoutedAt,
    scoutRouteRooms: task.scoutRouteRooms?.slice(0, MAX_DEBUG_ROUTE_ROOMS),
    dangerousRooms: task.dangerousRooms?.slice(0, MAX_DEBUG_ROUTE_ROOMS),
    safeRouteRetryAt: task.safeRouteRetryAt,
    temporaryDangerousRoomCount: task.temporaryDangerousRooms ? Object.keys(task.temporaryDangerousRooms).length : undefined,
    permanentDangerousRoomCount: task.permanentDangerousRooms?.length,
  }));
}

function collectDebugTelemetry(): ExternalTelemetryDebugSnapshot {
  let creepsWithMovementState = 0;
  let creepsWithTravelState = 0;
  let stuckCreeps = 0;

  let interestingCount = 0;
  const selected: Array<{ creep: Creep; state: ReturnType<typeof getCreepMovementState>; score: number }> = [];
  for (const creep of getTickContextService().getAllCreeps()) {
    const state = getCreepMovementState(creep.name);
    if (state) {
      creepsWithMovementState += 1;
      if (state.travelState) creepsWithTravelState += 1;
      if ((state.travelState?.stuckTicks ?? 0) >= 2 || (state.movePathState?.stuckTicks ?? 0) >= 2) stuckCreeps += 1;
    }
    if (!isInterestingDebugCreep(creep, state)) continue;
    interestingCount += 1;
    const score = scoreDebugCreep(creep, state);
    const index = selected.findIndex(entry => score > entry.score || (score === entry.score && creep.name.localeCompare(entry.creep.name) < 0));
    if (index < 0) {
      if (selected.length < MAX_DEBUG_CREEPS) selected.push({ creep, state, score });
    } else {
      selected.splice(index, 0, { creep, state, score });
      if (selected.length > MAX_DEBUG_CREEPS) selected.pop();
    }
  }
  return {
    creeps: projectDebugCreeps(selected),
    colonization: collectDebugColonization(),
    counts: { creepsWithMovementState, creepsWithTravelState, stuckCreeps,
      colonizationTasks: Object.keys(Memory.data?.colonization || {}).length },
    truncated: interestingCount > MAX_DEBUG_CREEPS,
  };
}

function getOwnedRooms(): Room[] {
  return getTickContextService().getMyRooms();
}

function toTelemetryEntry(
  snap: CpuMonitorSnapshotV2,
  config: CpuMonitorConfig,
): CpuMonitorTelemetryEntry {
  let fixedActionTotal = 0;
  for (const count of Object.values(snap.fixedActionCounts)) {
    fixedActionTotal += count;
  }
  const fixedActionEstimate = fixedActionTotal * config.fixedActionCpuCost;

  const heap = snap.heap
    ? {
        used_heap_size: snap.heap.used_heap_size,
        total_heap_size: snap.heap.total_heap_size,
        heap_size_limit: snap.heap.heap_size_limit,
      }
    : null;

  return {
    tick: snap.tick,
    shard: snap.shard,
    totalUsed: snap.totalUsed,
    ...(snap.startupUsed !== undefined ? { startupUsed: snap.startupUsed } : {}),
    ...(snap.tickUsedAtFlush !== undefined ? { tickUsedAtFlush: snap.tickUsedAtFlush } : {}),
    ...(snap.topLevelUsed !== undefined ? { topLevelUsed: snap.topLevelUsed } : {}),
    bucket: snap.bucket,
    limit: snap.limit,
    tickLimit: snap.tickLimit,
    phases: snap.phases,
    fixedActionCounts: snap.fixedActionCounts,
    fixedActionEstimate,
    untracked: snap.untracked,
    emaTotalUsed: snap.emaTotalUsed,
    rooms: snap.rooms,
    heap,
  };
}

function buildCpuMonitorPayload(): CpuMonitorTelemetryPayload | undefined {
  const config = normalizeCpuMonitorConfig(Memory.cfg?.cpuProfiler);
  const memLatest = Memory.analytics?.cpuMonitor?.latest;
  const memSummary = Memory.analytics?.cpuMonitor?.summary;
  const globalHistory = getCpuMonitorHistory();

  if (!memLatest && globalHistory.length === 0) {
    return undefined;
  }

  const latest = memLatest ? toTelemetryEntry(memLatest, config) : null;

  const history = globalHistory.slice(-20).map((snap) => toTelemetryEntry(snap, config));

  let summary: CpuMonitorTelemetrySummary | null = null;
  const source = memSummary ?? (history.length > 0 ? computeSummaryFromHistory(history, config) : null);
  if (source) {
    const persisted = source as CpuMonitorSummaryV2;
    let fixedActionEstimate = 0;
    if (persisted.avgFixedActionCounts) {
      for (const count of Object.values(persisted.avgFixedActionCounts)) {
        fixedActionEstimate += count * config.fixedActionCpuCost;
      }
    }
    const topPhases = Object.entries(persisted.avgPhases || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce<Record<string, number>>((acc, [k, v]) => {
        acc[k] = v;
        return acc;
      }, {});

    const topRoomRoles = buildTopRoomRoles(latest?.rooms, 10);

    summary = {
      ticks: persisted.ticks,
      avgTotalUsed: persisted.avgTotalUsed,
      maxTotalUsed: persisted.maxTotalUsed,
      minBucket: persisted.minBucket,
      maxBucket: persisted.maxBucket,
      avgBucket: persisted.avgBucket,
      avgUntracked: persisted.avgUntracked,
      emaTotalUsed: persisted.emaTotalUsed,
      fixedActionEstimate,
      topPhases,
      topRoomRoles,
    };
  }

  return {
    version: 2,
    latest,
    summary,
    history,
    config: {
      sampleInterval: config.sampleInterval,
      historyLimit: config.historyLimit,
      fixedActionCpuCost: config.fixedActionCpuCost,
    },
  };
}

function computeSummaryFromHistory(
  history: CpuMonitorTelemetryEntry[],
  config: CpuMonitorConfig,
): CpuMonitorTelemetrySummary | null {
  if (history.length === 0) return null;

  let sumTotalUsed = 0;
  let maxTotalUsed = -Infinity;
  let sumBucket = 0;
  let minBucket = Infinity;
  let maxBucket = -Infinity;
  let sumUntracked = 0;
  const phaseSums: Record<string, number> = {};
  let fixedActionEstimate = 0;

  for (const entry of history) {
    sumTotalUsed += entry.totalUsed;
    if (entry.totalUsed > maxTotalUsed) maxTotalUsed = entry.totalUsed;
    sumBucket += entry.bucket;
    if (entry.bucket < minBucket) minBucket = entry.bucket;
    if (entry.bucket > maxBucket) maxBucket = entry.bucket;
    sumUntracked += entry.untracked;
    for (const [phase, used] of Object.entries(entry.phases)) {
      phaseSums[phase] = (phaseSums[phase] || 0) + used;
    }
    fixedActionEstimate += entry.fixedActionEstimate;
  }

  const ticks = history.length;
  const avgPhases: Record<string, number> = {};
  for (const [phase, sum] of Object.entries(phaseSums)) {
    avgPhases[phase] = sum / ticks;
  }

  const topPhases = Object.entries(avgPhases)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .reduce<Record<string, number>>((acc, [k, v]) => {
      acc[k] = v;
      return acc;
    }, {});

  const lastEntry = history[history.length - 1];
  const topRoomRoles = buildTopRoomRoles(lastEntry?.rooms, 10);

  return {
    ticks,
    avgTotalUsed: sumTotalUsed / ticks,
    maxTotalUsed,
    minBucket,
    maxBucket,
    avgBucket: sumBucket / ticks,
    avgUntracked: sumUntracked / ticks,
    emaTotalUsed: lastEntry?.emaTotalUsed ?? 0,
    fixedActionEstimate: fixedActionEstimate / ticks,
    topPhases,
    topRoomRoles,
  };
}

function buildTopRoomRoles(
  rooms: Record<string, CpuMonitorRoomSummary> | undefined,
  limit: number,
): Array<{ room: string; role: string; avgUsed: number; count: number }> {
  if (!rooms) return [];
  const entries: Array<{ room: string; role: string; avgUsed: number; count: number }> = [];
  for (const [roomName, roomData] of Object.entries(rooms)) {
    for (const [role, roleData] of Object.entries(roomData.roles || {})) {
      entries.push({
        room: roomName,
        role,
        avgUsed: roleData.count > 0 ? roleData.used / roleData.count : 0,
        count: roleData.count,
      });
    }
  }
  return entries.sort((a, b) => b.avgUsed - a.avgUsed).slice(0, limit);
}

function buildTelemetrySnapshot(sampleInterval: number, segmentId: number): ExternalTelemetrySnapshot {
  const ownedRooms = getOwnedRooms();
  const creepsByRoom = collectCreepTelemetryByRoom(ownedRooms);
  const tasksByRoom = collectTaskTelemetryByRoom();
  const spawnsByRoom = collectSpawnTelemetryByRoom(ownedRooms);
  const debug = collectDebugTelemetry();
  const productionRooms = Memory.analytics?.production?.rooms || {};
  const movementAnalytics = getMovementAnalytics();
  const cpuMonitor = buildCpuMonitorPayload();

  const rooms: ExternalTelemetryRoomSnapshot[] = [];
  let totalWorkers = 0;
  let totalCarriers = 0;
  let totalHarvesters = 0;
  let totalUnassignedWorkers = 0;
  let totalTaskQueueDepth = 0;
  let totalSpawnQueueDepth = 0;
  let totalActiveSpawns = 0;

  for (const room of ownedRooms) {
    const roomName = room.name;
    const creepStats =
      creepsByRoom[roomName] ||
      ({
        workerCount: 0,
        carrierCount: 0,
        harvesterCount: 0,
        unassignedWorkers: 0,
        carrierStuckTotal: 0,
        carrierStuckCount: 0,
      } satisfies RoomCreepTelemetry);
    const taskStats =
      tasksByRoom[roomName] ||
      ({
        buildTasks: 0,
        repairTasks: 0,
        upgradeTasks: 0,
      } satisfies RoomTaskTelemetry);
    const spawnStats =
      spawnsByRoom[roomName] ||
      ({
        queueDepth: 0,
        spawningCount: 0,
      } satisfies RoomSpawnTelemetry);
    const taskQueueDepth = taskStats.buildTasks + taskStats.repairTasks + taskStats.upgradeTasks;
    const avgCarrierStuckTicks =
      creepStats.carrierStuckCount > 0 ? creepStats.carrierStuckTotal / creepStats.carrierStuckCount : 0;
    const productionRoom = productionRooms[roomName];
    const movementRoom = movementAnalytics?.rooms[roomName];

    totalWorkers += creepStats.workerCount;
    totalCarriers += creepStats.carrierCount;
    totalHarvesters += creepStats.harvesterCount;
    totalUnassignedWorkers += creepStats.unassignedWorkers;
    totalTaskQueueDepth += taskQueueDepth;
    totalSpawnQueueDepth += spawnStats.queueDepth;
    totalActiveSpawns += spawnStats.spawningCount;

    rooms.push({
      roomName,
      controllerLevel: room.controller?.level || 0,
      controllerProgress: room.controller?.progress || 0,
      energyAvailable: room.energyAvailable,
      energyCapacity: room.energyCapacityAvailable,
      workerCount: creepStats.workerCount,
      carrierCount: creepStats.carrierCount,
      harvesterCount: creepStats.harvesterCount,
      unassignedWorkers: creepStats.unassignedWorkers,
      avgCarrierStuckTicks,
      taskQueueDepth,
      buildTasks: taskStats.buildTasks,
      repairTasks: taskStats.repairTasks,
      upgradeTasks: taskStats.upgradeTasks,
      spawnQueueDepth: spawnStats.queueDepth,
      spawnSpawning: spawnStats.spawningCount,
      productionUpdatedAt: productionRoom?.updatedAt,
      productionSignal: productionRoom?.signal,
      movement: movementRoom,
    });
  }

  return {
    version: 2,
    tick: Game.time,
    shard: Game.shard.name,
    sampleInterval,
    segmentId,
    cpu: {
      used: Game.cpu.getUsed(),
      bucket: Game.cpu.bucket,
      limit: Game.cpu.limit,
      tickLimit: Game.cpu.tickLimit,
    },
    gcl: {
      level: Game.gcl.level,
      progress: Game.gcl.progress,
      progressTotal: Game.gcl.progressTotal,
    },
    totals: {
      rooms: rooms.length,
      workers: totalWorkers,
      carriers: totalCarriers,
      harvesters: totalHarvesters,
      unassignedWorkers: totalUnassignedWorkers,
      taskQueueDepth: totalTaskQueueDepth,
      spawnQueueDepth: totalSpawnQueueDepth,
      activeSpawns: totalActiveSpawns,
      movement: movementAnalytics?.totals,
    },
    movementRooms: movementAnalytics
      ? selectMovementTelemetryRooms(movementAnalytics.rooms, movementAnalytics.roomUpdatedAt)
      : undefined,
    debug,
    cpuMonitor,
    rooms,
  };
}

function selectMovementTelemetryRooms(
  rooms: Record<string, MovementMetricBucket>,
  roomUpdatedAt: Record<string, number>,
): Record<string, MovementMetricBucket> | undefined {
  const selected: Array<[string, MovementMetricBucket]> = [];
  for (const entry of Object.entries(rooms)) {
    let insertAt = selected.length;
    for (let index = 0; index < selected.length; index += 1) {
      if (compareMovementRoomActivity(entry, selected[index], roomUpdatedAt) < 0) {
        insertAt = index;
        break;
      }
    }
    if (insertAt >= MAX_MOVEMENT_TELEMETRY_ROOMS && selected.length >= MAX_MOVEMENT_TELEMETRY_ROOMS) {
      continue;
    }
    selected.splice(insertAt, 0, entry);
    if (selected.length > MAX_MOVEMENT_TELEMETRY_ROOMS) {
      selected.pop();
    }
  }
  return selected.length > 0 ? Object.fromEntries(selected) : undefined;
}

function compareMovementRoomActivity(
  left: [string, MovementMetricBucket],
  right: [string, MovementMetricBucket],
  roomUpdatedAt: Record<string, number>,
): number {
  const leftUpdatedAt = Number.isFinite(roomUpdatedAt[left[0]]) ? roomUpdatedAt[left[0]] : 0;
  const rightUpdatedAt = Number.isFinite(roomUpdatedAt[right[0]]) ? roomUpdatedAt[right[0]] : 0;
  if (leftUpdatedAt !== rightUpdatedAt) {
    return leftUpdatedAt > rightUpdatedAt ? -1 : 1;
  }
  const leftSegmentActivity = left[1].multiRoomSearches + left[1].multiRoomSegmentHits + left[1].multiRoomSegmentInvalidations;
  const rightSegmentActivity = right[1].multiRoomSearches + right[1].multiRoomSegmentHits + right[1].multiRoomSegmentInvalidations;
  if (leftSegmentActivity !== rightSegmentActivity) {
    return leftSegmentActivity > rightSegmentActivity ? -1 : 1;
  }
  const leftRequests = left[1].travelRequests + left[1].pathRequests;
  const rightRequests = right[1].travelRequests + right[1].pathRequests;
  if (leftRequests !== rightRequests) {
    return leftRequests > rightRequests ? -1 : 1;
  }
  return left[0].localeCompare(right[0]);
}

function compactPhaseMap(phases: Record<string, number>, limit: number): Record<string, number> {
  const compact: Record<string, number> = {};
  const sorted = Object.entries(phases)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
  for (const [key, value] of sorted) {
    compact[key] = value;
  }

  return compact;
}

function compactCpuMonitorTelemetryEntry(
  entry: CpuMonitorTelemetryEntry,
  phaseLimit: number,
): CpuMonitorTelemetryEntry {
  return {
    ...entry,
    phases: compactPhaseMap(entry.phases, phaseLimit),
    rooms: undefined,
    heap: undefined,
  };
}

function compactCpuMonitorPayload(
  cpuMonitor: CpuMonitorTelemetryPayload | undefined,
  historyLimit: number,
): CpuMonitorTelemetryPayload | undefined {
  if (!cpuMonitor) {
    return undefined;
  }

  return {
    ...cpuMonitor,
    latest: cpuMonitor.latest ? compactCpuMonitorTelemetryEntry(cpuMonitor.latest, 8) : null,
    history: cpuMonitor.history.slice(-historyLimit).map((entry) => compactCpuMonitorTelemetryEntry(entry, 5)),
    summary: cpuMonitor.summary
      ? {
          ...cpuMonitor.summary,
          topRoomRoles: cpuMonitor.summary.topRoomRoles.slice(0, 5),
        }
      : null,
  };
}

function serializeSnapshot(snapshot: ExternalTelemetrySnapshot): string {
  const fullPayload = JSON.stringify(snapshot);
  if (fullPayload.length <= MAX_SEGMENT_PAYLOAD_BYTES) {
    return fullPayload;
  }

  const compactRooms = snapshot.rooms.slice(0, 20).map((room) => ({
    roomName: room.roomName,
    controllerLevel: room.controllerLevel,
    workerCount: room.workerCount,
    carrierCount: room.carrierCount,
    taskQueueDepth: room.taskQueueDepth,
    spawnQueueDepth: room.spawnQueueDepth,
  }));

  const compactPayload = JSON.stringify({
    ...snapshot,
    truncated: true,
    debug: snapshot.debug
      ? {
          counts: snapshot.debug.counts,
          creeps: snapshot.debug.creeps.slice(0, 10),
          colonization: snapshot.debug.colonization.slice(0, 10),
          truncated: true,
        }
      : undefined,
    cpuMonitor: compactCpuMonitorPayload(snapshot.cpuMonitor, 20),
    rooms: compactRooms,
  });

  if (compactPayload.length <= MAX_SEGMENT_PAYLOAD_BYTES) {
    return compactPayload;
  }

  return JSON.stringify({
    version: snapshot.version,
    tick: snapshot.tick,
    shard: snapshot.shard,
    sampleInterval: snapshot.sampleInterval,
    segmentId: snapshot.segmentId,
    cpu: snapshot.cpu,
    gcl: snapshot.gcl,
    totals: snapshot.totals,
    movementRooms: snapshot.movementRooms,
    debug: snapshot.debug ? { counts: snapshot.debug.counts, creeps: [], colonization: [], truncated: true } : undefined,
    cpuMonitor: compactCpuMonitorPayload(snapshot.cpuMonitor, 5),
    rooms: [],
    truncated: true,
  } satisfies ExternalTelemetrySnapshot);
}

export function runExternalTelemetryExport(): void {
  const cfg = Memory.cfg?.telemetry;
  if (!cfg?.enabled) {
    return;
  }

  const sampleInterval = toValidSampleInterval(cfg.sampleInterval);
  if (Game.time % sampleInterval !== 0) {
    return;
  }

  const segmentId = toValidSegmentId(cfg.segmentId);
  const snapshot = buildTelemetrySnapshot(sampleInterval, segmentId);
  const payload = serializeSnapshot(snapshot);

  RawMemory.setActiveSegments([segmentId]);
  RawMemory.segments[segmentId] = payload;
}
