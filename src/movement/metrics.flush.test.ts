/**
 * Movement metrics 批量 flush 回归测试：pending 跨 tick 聚合，
 * 同一 tick 内至多 flush 一次；显式读取允许强制 flush。
 */
import {
  clearMovementAnalyticsForTest,
  getMovementAnalyticsForTest,
  getMovementMetricsFlushCountForTest,
  recordMovementMetric,
} from "@/movement/metrics";

describe("movement metrics flush cadence", () => {
  beforeEach(() => {
    clearMovementAnalyticsForTest();
    Game.time = 100;
    Memory.cfg = undefined;
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
