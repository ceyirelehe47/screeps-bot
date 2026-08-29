/**
 * 市场低开销生产计数器（提交 D/F）：
 * - global heap 普通 Record 数字，记路径分桶（fast path / exposure /
 *   planning / deep audit / session 复用 / protection memo）；
 * - 默认每 50 tick 低频快照到 Memory.runtime.marketPerf（可关），
 *   不逐 tick 写 Memory；
 * - operator global `marketPerformanceCounters()` 随时查询；
 * - global reset 后计数清零（内存计数，无跨 reset 状态）。
 */
type MarketPerformanceCounterName =
  | "marketFastPathTicks"
  | "marketPlanningDeferredTicks"
  | "marketPlanningDueTicks"
  | "marketExposureTicks"
  | "marketPlanningTicks"
  | "marketDeepAuditTicks"
  | "marketSessionReuseHits"
  | "marketSessionContextRebuilds"
  | "duplicateProtectionReadsAvoided"
  | "protectionOuterCollections"
  | "marketPerfSnapshotsCommitted";

type GlobalWithMarketCounters = typeof global & {
  __marketPerformanceCounters?: Partial<Record<MarketPerformanceCounterName, number>>;
};

const runtimeGlobal: GlobalWithMarketCounters = global;
const MARKET_PERF_SNAPSHOT_INTERVAL = 50;

export function bumpMarketPerformanceCounter(name: MarketPerformanceCounterName): void {
  let counters = runtimeGlobal.__marketPerformanceCounters;
  if (!counters) {
    counters = {};
    runtimeGlobal.__marketPerformanceCounters = counters;
  }
  counters[name] = (counters[name] || 0) + 1;
}

export function readMarketPerformanceCounters(): Readonly<
  Partial<Record<MarketPerformanceCounterName, number>>
> {
  return { ...runtimeGlobal.__marketPerformanceCounters };
}

export function clearMarketPerformanceCountersForTest(): void {
  delete runtimeGlobal.__marketPerformanceCounters;
}

/** 低频快照：由 automation 主路径每 tick 调用，内部按 interval 节流。 */
export function snapshotMarketPerformanceCounters(): void {
  if (Game.time % MARKET_PERF_SNAPSHOT_INTERVAL !== 0) {
    return;
  }
  const counters = runtimeGlobal.__marketPerformanceCounters;
  if (!counters) {
    return;
  }
  if (!Memory.runtime) Memory.runtime = {};
  const snapshot = { ...counters, committedAtTick: Game.time };
  (Memory.runtime as { marketPerf?: typeof snapshot }).marketPerf = snapshot;
  const countersWithCommit = runtimeGlobal.__marketPerformanceCounters;
  countersWithCommit.marketPerfSnapshotsCommitted =
    (countersWithCommit.marketPerfSnapshotsCommitted || 0) + 1;
}
