import { beginMarketComparisonCycle, stageMarketComparisonPlan, stageMarketComparisonProtection, flushMarketComparison } from "@/runtime/market/comparison";
import { recordCompactMarketComparison, type CompactMarketState, type MarketComparisonSample } from "@/runtime/market/state";
import { planMarketDirectContinuous } from "@/runtime/marketDirectContinuousPlanner";
import { compactOrder, legacyMarketFixture } from "../../../test/compactMarketFixture";

describe("市场同源 dryRun 对照", () => {
  beforeEach(() => {
    Memory.cfg = { market: { mode: "dryRun", minBucket: 0 } }; Memory.data = {};
    Memory.runtime = { lastDeployCommit: "test-commit" };
    Game.cpu = { getUsed: jest.fn(() => 1), limit: 100, bucket: 10000 } as any;
    Game.shard = { name: "shard1" } as any; Game.market = {} as any;
  });
  function observe(mutate?: (fixture: ReturnType<typeof legacyMarketFixture>) => void): void {
    const fixture = legacyMarketFixture(); mutate?.(fixture);
    const legacy = planMarketDirectContinuous(fixture.input);
    expect(legacy.complete).toBe(true);
    const callback = jest.fn(() => { throw new Error("不可重新调用旧成本回调"); });
    fixture.input.entries[0].calculateTransactionEnergy = callback;
    const before = JSON.stringify(fixture.input);
    const deal = jest.fn(() => { throw new Error("观察不得交易"); }); Game.market.deal = deal;
    beginMarketComparisonCycle(); stageMarketComparisonProtection(fixture.protection);
    stageMarketComparisonPlan(fixture.input, legacy, fixture.costs); flushMarketComparison();
    expect(callback).not.toHaveBeenCalled(); expect(deal).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.input)).toBe(before);
  }
  it("逐 lane 对齐；单独记录旧 admission，绝不声称写入额度等价", () => {
    observe(); const state = Memory.data.market!.comparison!;
    expect(state).toMatchObject({ comparable: 1, mismatches: 0, incomplete: 0,
      scope: "v3-writable-price-and-protection", lanes: { "E3N59:H": { samples: 1, mismatches: 0 } } });
    expect(state.latest.selected).toEqual(state.latest.legacySelected);
  });
  it("保留清仓底价，不强行抬回普通经济底价", () => {
    observe(fixture => {
      fixture.input.entries[0].book!.orders = [compactOrder("liquidation", 100)];
      fixture.input.entries[0].lanes[0].pricing = { tier: "liquidation", effectiveNetFloor: 1, minExecutableNotional: 1000 };
    });
    expect(Memory.data.market!.comparison).toMatchObject({ comparable: 1, mismatches: 0 });
    expect(Memory.data.market!.comparison!.latest.selected?.order).toBe("liquidation");
  });
  it("缺失 memo 只能计入不可对照", () => {
    const fixture = legacyMarketFixture(), result = planMarketDirectContinuous(fixture.input);
    beginMarketComparisonCycle(); stageMarketComparisonProtection(fixture.protection);
    stageMarketComparisonPlan(fixture.input, result, new Map()); flushMarketComparison();
    expect(Memory.data.market!.comparison).toMatchObject({ comparable: 0, incomplete: 1,
      latest: { complete: false, reason: "cost_evidence_missing" } });
  });
  it("等待诊断不锁死采样相位，下一 tick 的完整读取仍能捕获", () => {
    beginMarketComparisonCycle(); flushMarketComparison(); Game.time++;
    observe(); expect(Memory.data.market!.comparison).toMatchObject({ attempts: 2, comparable: 1, incomplete: 1 });
  });
  it("无完整读取和 bucket 不足分别记录，不能算成一致", () => {
    beginMarketComparisonCycle(); flushMarketComparison();
    expect(Memory.data.market!.comparison!.latest.reason).toBe("waiting_for_v3_full_read");
    Game.time += 50; Memory.cfg.market!.minBucket = 9000; Game.cpu.bucket = 8999;
    beginMarketComparisonCycle(); flushMarketComparison();
    expect(Memory.data.market!.comparison).toMatchObject({ comparable: 0, incomplete: 2, latest: { reason: "cpu_budget" } });
  });
  it("显式提高储备会形成保护差异，改变配置则重开窗口", () => {
    observe(); Game.time += 50; Memory.cfg.market!.overrides = { H: { reserve: 18000 } };
    observe(); expect(Memory.data.market!.comparison).toMatchObject({ attempts: 1, comparable: 1, mismatches: 1 });
  });
  it("关闭模式、采样间隔与未知 schema 都不写状态", () => {
    Memory.cfg.market!.mode = "off"; beginMarketComparisonCycle(); flushMarketComparison();
    expect(Memory.data.market).toBeUndefined();
    Memory.cfg.market!.mode = "dryRun"; observe(); const before = JSON.stringify(Memory.data.market);
    beginMarketComparisonCycle(); flushMarketComparison(); expect(JSON.stringify(Memory.data.market)).toBe(before);
    Memory.data.market = { v: 2 } as any; Game.time += 50;
    beginMarketComparisonCycle(); flushMarketComparison(); expect(Memory.data.market).toEqual({ v: 2 });
  });
  it("异常成本源只产生不可对照诊断", () => {
    const fixture = legacyMarketFixture(), legacy = planMarketDirectContinuous(fixture.input);
    beginMarketComparisonCycle(); stageMarketComparisonProtection(fixture.protection);
    stageMarketComparisonPlan(fixture.input, legacy, { get: () => { throw new Error("memo_failed"); } } as any);
    expect(() => flushMarketComparison()).not.toThrow();
    expect(Memory.data.market!.comparison!.latest).toMatchObject({ complete: false, reason: "memo_failed" });
  });
});

describe("市场观察状态边界", () => {
  const sample = (tick = 1): MarketComparisonSample => ({ tick, atMs: Date.UTC(2026, 9, tick), shard: "shard1",
    sourceCommit: "commit", configuration: "{}", complete: true, cpu: 1,
    lanes: [{ key: "E3N59:H", protectionEqual: true, floorEqual: true, selectionEqual: true }] });
  it("128 lane、7 天与 20 条审计有界，坏状态重建", () => {
    const state: CompactMarketState = { v: 1 };
    for (let tick = 1; tick <= 40; tick++) {
      const next = sample(tick); next.lanes = Array.from({ length: 128 }, (_, i) =>
        ({ key: `E${tick}N${i}:H`, protectionEqual: true, floorEqual: true, selectionEqual: true }));
      recordCompactMarketComparison(state, next);
    }
    expect(Object.keys(state.comparison!.lanes)).toHaveLength(128);
    expect(Object.keys(state.comparison!.days)).toHaveLength(7); expect(state.comparison!.audit).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(32000);
    state.comparison!.attempts = NaN; recordCompactMarketComparison(state, sample(41));
    expect(state.comparison!.attempts).toBe(1);
  });
  it("不完整样本不累计覆盖；旧 lane 过期，换提交重置对照", () => {
    const state: CompactMarketState = { v: 1 }; const first = sample(); first.complete = false;
    recordCompactMarketComparison(state, first); expect(state.comparison).toMatchObject({ comparable: 0, incomplete: 1, lanes: {} });
    recordCompactMarketComparison(state, sample(2)); const later = sample(30003); later.lanes[0].key = "E4N58:H";
    recordCompactMarketComparison(state, later); expect(Object.keys(state.comparison!.lanes)).toEqual(["E4N58:H"]);
    later.sourceCommit = "new"; recordCompactMarketComparison(state, later); expect(state.comparison!.attempts).toBe(1);
  });
});
