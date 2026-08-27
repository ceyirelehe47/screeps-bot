type MovementMetricName =
  | "pathRequests"
  | "pathCacheHits"
  | "pathRepaths"
  | "yieldPushes"
  | "travelRequests"
  | "travelFallbacks"
  | "travelRepaths"
  | "multiRoomSearches"
  | "multiRoomSegmentHits"
  | "multiRoomSegmentInvalidations"
  | "exitRecoveries"
  | "stateClears";

export interface MovementMetricBucket {
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
}

export interface MovementAnalyticsSnapshot {
  version: 2;
  updatedAt: number;
  totals: MovementMetricBucket;
  rooms: Record<string, MovementMetricBucket>;
  roomUpdatedAt: Record<string, number>;
}

type RuntimeGlobalWithMovementAnalytics = typeof global & {
  __movementAnalytics?: MovementAnalyticsSnapshot;
};

const runtimeGlobal: RuntimeGlobalWithMovementAnalytics = global;
let normalizedMovementAnalytics: MovementAnalyticsSnapshot | undefined;

// ─── 批量汇总 ─────────────────────────────────────────────────────────────────
// 记录路径只做轻量的每 tick 计数器累加；每隔 MOVEMENT_METRICS_FLUSH_INTERVAL
// tick 或任何读取（遥测/控制台/测试）时一次性合入持久快照。读取前强制
// flush 保证外部观察到的累计值始终完整，调试信息不丢失。
// 房间级分桶可通过 Memory.cfg.movementMetrics.roomStats === false 关闭，
// 关闭时记录路径几乎零额外开销（仅 totals 计数）。

const MOVEMENT_METRICS_FLUSH_INTERVAL = 5;

interface PendingMovementMetrics {
  tick: number;
  /** 无房间归属的计数；有房间归属的计数只进 rooms，flush 时一次调用同时落到 totals 与房间桶。 */
  noRoom: Map<MovementMetricName, number>;
  rooms: Map<string, Map<MovementMetricName, number>>;
}

let pendingMovementMetrics: PendingMovementMetrics | null = null;

function ensurePendingMovementMetrics(): PendingMovementMetrics {
  if (!pendingMovementMetrics || pendingMovementMetrics.tick !== Game.time) {
    flushPendingMovementMetrics();
    pendingMovementMetrics = {
      tick: Game.time,
      noRoom: new Map(),
      rooms: new Map(),
    };
  }
  return pendingMovementMetrics;
}

function isRoomMovementStatsEnabled(): boolean {
  return (Memory.cfg as { movementMetrics?: { roomStats?: boolean } } | undefined)?.movementMetrics
    ?.roomStats !== false;
}

function bumpPendingCounter(
  map: Map<MovementMetricName, number>,
  metric: MovementMetricName,
  count: number,
): void {
  map.set(metric, (map.get(metric) || 0) + count);
}

function flushPendingMovementMetrics(): void {
  const pending = pendingMovementMetrics;
  pendingMovementMetrics = null;
  if (!pending) {
    return;
  }

  for (const [metric, count] of pending.noRoom) {
    if (count > 0) {
      recordMovementMetricIntoSnapshot(metric, undefined, count);
    }
  }
  for (const [roomName, roomCounters] of pending.rooms) {
    for (const [metric, count] of roomCounters) {
      if (count > 0) {
        recordMovementMetricIntoSnapshot(metric, roomName, count);
      }
    }
  }
}

function recordMovementMetricIntoSnapshot(
  metric: MovementMetricName,
  roomName: string | undefined,
  count: number,
): void {
  const movement = ensureMovementAnalytics();
  movement.updatedAt = Game.time;
  movement.totals[metric] = Math.min(Number.MAX_SAFE_INTEGER, movement.totals[metric] + count);

  if (!roomName) {
    return;
  }

  const roomBucket = ensureRoomBucket(roomName);
  roomBucket[metric] = Math.min(Number.MAX_SAFE_INTEGER, roomBucket[metric] + count);
  movement.roomUpdatedAt[roomName] = Game.time;
}

function createEmptyBucket(): MovementMetricBucket {
  return {
    pathRequests: 0,
    pathCacheHits: 0,
    pathRepaths: 0,
    yieldPushes: 0,
    travelRequests: 0,
    travelFallbacks: 0,
    travelRepaths: 0,
    multiRoomSearches: 0,
    multiRoomSegmentHits: 0,
    multiRoomSegmentInvalidations: 0,
    exitRecoveries: 0,
    stateClears: 0,
  };
}

function ensureMultiRoomMetricShape(bucket: MovementMetricBucket): void {
  if (!Number.isFinite(bucket.multiRoomSearches)) {
    bucket.multiRoomSearches = 0;
  }
  if (!Number.isFinite(bucket.multiRoomSegmentHits)) {
    bucket.multiRoomSegmentHits = 0;
  }
  if (!Number.isFinite(bucket.multiRoomSegmentInvalidations)) {
    bucket.multiRoomSegmentInvalidations = 0;
  }
}

function normalizeExistingMovementAnalytics(snapshot: MovementAnalyticsSnapshot): MovementAnalyticsSnapshot {
  ensureMultiRoomMetricShape(snapshot.totals);
  for (const bucket of Object.values(snapshot.rooms)) {
    ensureMultiRoomMetricShape(bucket);
  }
  if (!snapshot.roomUpdatedAt || typeof snapshot.roomUpdatedAt !== "object") {
    snapshot.roomUpdatedAt = {};
  }
  snapshot.version = 2;
  normalizedMovementAnalytics = snapshot;
  return snapshot;
}

function ensureMovementAnalytics(): MovementAnalyticsSnapshot {
  if (!runtimeGlobal.__movementAnalytics) {
    runtimeGlobal.__movementAnalytics = {
      version: 2,
      updatedAt: Game.time,
      totals: createEmptyBucket(),
      rooms: {},
      roomUpdatedAt: {},
    };
    normalizedMovementAnalytics = runtimeGlobal.__movementAnalytics;
  } else if (
    runtimeGlobal.__movementAnalytics.version !== 2 ||
    normalizedMovementAnalytics !== runtimeGlobal.__movementAnalytics
  ) {
    normalizeExistingMovementAnalytics(runtimeGlobal.__movementAnalytics);
  } else {
    ensureMultiRoomMetricShape(runtimeGlobal.__movementAnalytics.totals);
  }

  return runtimeGlobal.__movementAnalytics;
}

function ensureRoomBucket(roomName: string): MovementMetricBucket {
  const movement = ensureMovementAnalytics();
  const current = movement.rooms[roomName];
  if (current) {
    ensureMultiRoomMetricShape(current);
    return current;
  }
  const next = createEmptyBucket();
  movement.rooms[roomName] = next;
  return next;
}

export function recordMovementMetric(metric: MovementMetricName, roomName?: string, count = 1): void {
  if (!Number.isFinite(count) || count <= 0) {
    return;
  }

  const pending = ensurePendingMovementMetrics();
  if (roomName && isRoomMovementStatsEnabled()) {
    let roomCounters = pending.rooms.get(roomName);
    if (!roomCounters) {
      roomCounters = new Map();
      pending.rooms.set(roomName, roomCounters);
    }
    bumpPendingCounter(roomCounters, metric, count);
  } else {
    bumpPendingCounter(pending.noRoom, metric, count);
  }

  if (Game.time % MOVEMENT_METRICS_FLUSH_INTERVAL === 0) {
    flushPendingMovementMetrics();
  }
}

export function getMovementAnalyticsForTest(): MovementAnalyticsSnapshot {
  flushPendingMovementMetrics();
  return ensureMovementAnalytics();
}

export function getMovementAnalytics(): MovementAnalyticsSnapshot | undefined {
  flushPendingMovementMetrics();
  const snapshot = runtimeGlobal.__movementAnalytics;
  if (!snapshot) {
    return undefined;
  }
  return normalizedMovementAnalytics === snapshot ? snapshot : normalizeExistingMovementAnalytics(snapshot);
}

export function clearMovementAnalyticsForTest(): void {
  delete runtimeGlobal.__movementAnalytics;
  normalizedMovementAnalytics = undefined;
  pendingMovementMetrics = null;
}
