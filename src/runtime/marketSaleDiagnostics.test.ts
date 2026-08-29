/**
 * 市场子 phase 临时诊断（提交 A）回归测试：
 * - 关闭时零开销直通（不触碰 Game.cpu）；
 * - 开启时按 tick 聚合 total/max/calls，flush 合入 Memory；
 * - 窗口到期自动关闭 enabled；
 * - planning tick 标记与 samples 计数正确。
 */
import {
  flushMarketSaleDiagnostics,
  isMarketSaleDiagnosticsEnabled,
  markMarketSaleDiagnosticsPlanningTick,
  measureMarketSubPhase,
  readMarketSaleDiagnosticsForTest,
  resetMarketSaleDiagnosticsForTest,
} from "@/runtime/marketSaleDiagnostics";

describe("marketSaleDiagnostics", () => {
  let getUsedCalls: number;

  beforeEach(() => {
    resetMarketSaleDiagnosticsForTest();
    Game.time = 100;
    Memory.cfg = undefined;
    Memory.runtime = undefined;
    getUsedCalls = 0;
    (Game as Game & { cpu: CPU }).cpu = {
      getUsed: () => {
        getUsedCalls += 1;
        return 10 + getUsedCalls * 0.01;
      },
      bucket: 9000,
      limit: 500,
      tickLimit: 500,
    } as unknown as CPU;
  });

  it("is disabled by default and passes through without touching Game.cpu", () => {
    expect(isMarketSaleDiagnosticsEnabled()).toBe(false);

    const value = measureMarketSubPhase("ensureDataState", () => 42);

    expect(value).toBe(42);
    expect(getUsedCalls).toBe(0);
    // flush 无 pending 时安全。
    flushMarketSaleDiagnostics();
    expect(readMarketSaleDiagnosticsForTest()).toBeUndefined();
  });

  it("aggregates per-tick phases into Memory on flush", () => {
    Memory.cfg = { marketSaleDiagnostics: { enabled: true, windowTicks: 50 } };
    expect(isMarketSaleDiagnosticsEnabled()).toBe(true);

    measureMarketSubPhase("ensureDataState", () => 1);
    measureMarketSubPhase("liveOrdersSnapshot", () => 2);
    measureMarketSubPhase("ensureDataState", () => 3);

    flushMarketSaleDiagnostics();

    const memory = readMarketSaleDiagnosticsForTest();
    expect(memory).toBeDefined();
    expect(memory!.samples).toBe(1);
    expect(memory!.planningTicks).toBe(0);
    expect(memory!.phases.ensureDataState.calls).toBe(2);
    expect(memory!.phases.ensureDataState.total).toBeGreaterThan(0);
    expect(memory!.phases.liveOrdersSnapshot.calls).toBe(1);
    expect(memory!.window.until).toBe(Game.time + 50);
  });

  it("marks planning ticks and counts them separately", () => {
    Memory.cfg = { marketSaleDiagnostics: { enabled: true } };
    markMarketSaleDiagnosticsPlanningTick();
    measureMarketSubPhase("protectionOuter", () => 1);
    flushMarketSaleDiagnostics();

    Game.time += 1;
    measureMarketSubPhase("protectionOuter", () => 1);
    flushMarketSaleDiagnostics();

    const memory = readMarketSaleDiagnosticsForTest();
    expect(memory!.samples).toBe(2);
    expect(memory!.planningTicks).toBe(1);
  });

  it("auto-disables after the window expires", () => {
    Memory.cfg = { marketSaleDiagnostics: { enabled: true, windowTicks: 5 } };
    expect(isMarketSaleDiagnosticsEnabled()).toBe(true);

    Game.time += 6;
    expect(isMarketSaleDiagnosticsEnabled()).toBe(false);
    // enabled 已被自动关闭，防止长期诊断税。
    expect(Memory.cfg!.marketSaleDiagnostics!.enabled).toBe(false);
    // 关闭后直通。
    const callsBefore = getUsedCalls;
    measureMarketSubPhase("anyPhase", () => 7);
    expect(getUsedCalls).toBe(callsBefore);
  });
});
