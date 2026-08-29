/**
 * Movement metrics 批量 flush 回归测试：pending 跨 tick 聚合，
 * 同一 tick 内至多 flush 一次；显式读取允许强制 flush。
 * 另覆盖显式观测模式（off / totals / rooms）与默认 totals 的语义。
 */
import {
  clearMovementAnalyticsForTest,
  getMovementAnalyticsForTest,
  getMovementMetricsFlushCountForTest,
  recordMovementMetric,
  resetMovementMetricsModeCacheForTest,
} from "@/movement/metrics";

describe("movement metrics flush cadence", () => {
  beforeEach(() => {
    clearMovementAnalyticsForTest();
    Game.time = 100;
    Memory.cfg = { movementMetrics: { mode: "rooms" } };
  });

  it("flushes at most once even with 100 records on an interval-boundary tick", () => {
    expect(Game.time % 5).toBe(0);

    for (let index = 0; index < 100; index += 1) {
      recordMovementMetric("pathRequests", "W1N1");
    }

    // 区间边界 tick 内 100 次记录只允许触发一次 flush。
    expect(getMovementMetricsFlushCountForTest()).toBe(1);
    expect(getMovementAnalyticsForTest().totals.pathRequests).toBe(100);
    // 显式读取的强制 flush 也只在本 tick 再触发一次。
    expect(getMovementMetricsFlushCountForTest()).toBe(2);
  });

  it("aggregates across ticks without flushing on every record", () => {
    Game.time = 101;
    recordMovementMetric("pathRequests", "W1N1");
    expect(getMovementMetricsFlushCountForTest()).toBe(0);

    Game.time = 102;
    recordMovementMetric("pathRequests", "W1N1");
    recordMovementMetric("pathCacheHits", "W1N1");
    expect(getMovementMetricsFlushCountForTest()).toBe(0);

    // 时间戳使用最后事件 tick。
    const snapshot = getMovementAnalyticsForTest();
    expect(snapshot.totals.pathRequests).toBe(2);
    expect(snapshot.totals.pathCacheHits).toBe(1);
    expect(snapshot.updatedAt).toBe(102);
    expect(snapshot.roomUpdatedAt["W1N1"]).toBe(102);
  });
});

describe("movement metrics explicit modes", () => {
  beforeEach(() => {
    clearMovementAnalyticsForTest();
    resetMovementMetricsModeCacheForTest();
    Game.time = 100;
  });

  it("defaults to totals-only: counters aggregate without room buckets", () => {
    Memory.cfg = undefined;

    recordMovementMetric("pathRequests", "W1N1", 3);

    const snapshot = getMovementAnalyticsForTest();
    expect(snapshot.totals.pathRequests).toBe(3);
    expect(snapshot.roomUpdatedAt["W1N1"]).toBeUndefined();
    expect(snapshot.rooms["W1N1"]).toBeUndefined();
  });

  it("honors legacy roomStats=false as totals", () => {
    Memory.cfg = { movementMetrics: { roomStats: false } };

    recordMovementMetric("pathRequests", "W1N1", 2);

    const snapshot = getMovementAnalyticsForTest();
    expect(snapshot.totals.pathRequests).toBe(2);
    expect(snapshot.roomUpdatedAt["W1N1"]).toBeUndefined();
  });

  it("off mode records nothing and skips snapshot creation", () => {
    Memory.cfg = { movementMetrics: { mode: "off" } };

    recordMovementMetric("pathRequests", "W1N1", 5);
    // 边界 tick 也不触发 flush（记录路径直接返回）。
    expect(getMovementMetricsFlushCountForTest()).toBe(0);

    recordMovementMetric("pathCacheHits", "W1N1", 1);
    const snapshot = getMovementAnalyticsForTest();
    expect(snapshot.totals.pathRequests).toBe(0);
    expect(snapshot.totals.pathCacheHits).toBe(0);
  });
});
