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
  | "stateClears"
  // 静态矩阵层（build/hit/指纹失效）：定位矩阵重建风暴的观测缺口。
  | "staticMatrixBuilds"
  | "staticMatrixCacheHits"
  | "topologyRevisionChanges"
  // 殖民持久路径层：重建次数 / 重试节流命中 / 运行时验证失效。
  | "colonizationPathRebuilds"
  | "colonizationPathRegeneratesThrottled"
  | "colonizationPathBlockInvalidations"
  // RoleLifecycle 实例缓存：验证生命周期缓存真实命中（无房间归属，仅 totals）。
  | "roleFactoryCreates"
  | "roleLifecycleCacheHits"
  | "roleLifecycleEvictions";

/** 瞬时值（非累计计数），flush 时覆盖写入 totals 旁边的 gauges。 */
type MovementGaugeName = "roleLifecycleCacheSize";

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
  staticMatrixBuilds: number;
  staticMatrixCacheHits: number;
  topologyRevisionChanges: number;
  colonizationPathRebuilds: number;
  colonizationPathRegeneratesThrottled: number;
  colonizationPathBlockInvalidations: number;
  roleFactoryCreates: number;
  roleLifecycleCacheHits: number;
  roleLifecycleEvictions: number;
}

export interface MovementAnalyticsSnapshot {
  version: 2;
  updatedAt: number;
  totals: MovementMetricBucket;
  rooms: Record<string, MovementMetricBucket>;
  roomUpdatedAt: Record<string, number>;
  gauges?: Partial<Record<MovementGaugeName, number>>;
}

type RuntimeGlobalWithMovementAnalytics = typeof global & {
  __movementAnalytics?: MovementAnalyticsSnapshot;
};

const runtimeGlobal: RuntimeGlobalWithMovementAnalytics = global;
let normalizedMovementAnalytics: MovementAnalyticsSnapshot | undefined;

// ─── 批量汇总 ─────────────────────────────────────────────────────────────────
// 记录路径只做轻量的计数器累加；pending 真正跨越多个 tick 聚合，仅在
// MOVEMENT_METRICS_FLUSH_INTERVAL 边界（同一 tick 内至多 flush 一次）或任何
// 读取（遥测/控制台/测试）时一次性合入持久快照。读取前强制 flush 保证外部
// 观察到的累计值始终完整，调试信息不丢失；快照时间戳使用最后事件 tick。
// 房间级分桶可通过 Memory.cfg.movementMetrics.roomStats === false 关闭，
// 关闭时记录路径几乎零额外开销（仅 totals 计数）。

const MOVEMENT_METRICS_FLUSH_INTERVAL = 5;

interface PendingMovementMetrics {
  /** 最后一次事件发生的 tick。 */
  tick: number;
  /** 无房间归属的计数；有房间归属的计数只进 rooms，flush 时一次调用同时落到 totals 与房间桶。 */
  noRoom: Map<MovementMetricName, number>;
  rooms: Map<string, Map<MovementMetricName, number>>;
  /** 瞬时 gauge（覆盖语义）：与计数器同批 flush。 */
  gauges: Map<MovementGaugeName, number>;
}

let pendingMovementMetrics: PendingMovementMetrics | null = null;
let lastMovementMetricsFlushTick = -1;
let movementMetricsFlushCount = 0;

function ensurePendingMovementMetrics(): PendingMovementMetrics {
  if (!pendingMovementMetrics) {
    pendingMovementMetrics = {
      tick: Game.time,
      noRoom: new Map(),
      rooms: new Map(),
      gauges: new Map(),
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
  lastMovementMetricsFlushTick = Game.time;
  if (!pending) {
    return;
  }
  movementMetricsFlushCount += 1;

  // 快照时间戳使用最后事件 tick，而非 flush 发生时的 tick。
  const eventTick = pending.tick;
  for (const [metric, count] of pending.noRoom) {
    if (count > 0) {
      recordMovementMetricIntoSnapshot(metric, undefined, count, eventTick);
    }
  }
  for (const [roomName, roomCounters] of pending.rooms) {
    for (const [metric, count] of roomCounters) {
      if (count > 0) {
        recordMovementMetricIntoSnapshot(metric, roomName, count, eventTick);
      }
    }
  }
  if (pending.gauges.size > 0) {
    const movement = ensureMovementAnalytics();
    movement.gauges = movement.gauges ?? {};
    for (const [gauge, value] of pending.gauges) {
      movement.gauges[gauge] = value;
    }
  }
}

function recordMovementMetricIntoSnapshot(
  metric: MovementMetricName,
  roomName: string | undefined,
  count: number,
  eventTick: number,
): void {
  const movement = ensureMovementAnalytics();
  movement.updatedAt = eventTick;
  movement.totals[metric] = Math.min(Number.MAX_SAFE_INTEGER, movement.totals[metric] + count);

  if (!roomName) {
    return;
  }

  const roomBucket = ensureRoomBucket(roomName);
  roomBucket[metric] = Math.min(Number.MAX_SAFE_INTEGER, roomBucket[metric] + count);
  movement.roomUpdatedAt[roomName] = eventTick;
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
    staticMatrixBuilds: 0,
    staticMatrixCacheHits: 0,
    topologyRevisionChanges: 0,
    colonizationPathRebuilds: 0,
    colonizationPathRegeneratesThrottled: 0,
    colonizationPathBlockInvalidations: 0,
    roleFactoryCreates: 0,
    roleLifecycleCacheHits: 0,
    roleLifecycleEvictions: 0,
  };
}

// 旧快照（新计数器加入前生成）缺字段时补 0，保证读取方始终拿到完整 bucket。
function ensureMultiRoomMetricShape(bucket: MovementMetricBucket): void {
  for (const key of Object.keys(createEmptyBucket()) as MovementMetricName[]) {
    if (!Number.isFinite(bucket[key])) {
      bucket[key] = 0;
    }
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
  pending.tick = Game.time;
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

  // 区间边界 tick 也只 flush 一次：pending 跨 tick 聚合，读数为空时跳过。
  if (Game.time % MOVEMENT_METRICS_FLUSH_INTERVAL === 0 && lastMovementMetricsFlushTick !== Game.time && pendingMovementMetrics) {
    flushPendingMovementMetrics();
  }
}

/** 瞬时 gauge：覆盖语义，flush 时写入 snapshot.gauges（不区分房间）。 */
export function recordMovementGauge(gauge: MovementGaugeName, value: number): void {
  if (!Number.isFinite(value)) {
    return;
  }
  const pending = ensurePendingMovementMetrics();
  pending.tick = Game.time;
  pending.gauges.set(gauge, value);
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
  lastMovementMetricsFlushTick = -1;
  movementMetricsFlushCount = 0;
}

/** 仅供测试观测 flush 次数（含显式读取触发的强制 flush）。 */
export function getMovementMetricsFlushCountForTest(): number {
  return movementMetricsFlushCount;
}
