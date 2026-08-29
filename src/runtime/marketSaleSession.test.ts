/**
 * MarketTickSession 回归测试（提交 B）：
 * - 同 tick 内 preflight + automation 共享一次 context 构建（config/data/
 *   liveOrders 各只执行一次，而不是旧实现的两遍）；
 * - 外部替换根后 context 原地重建，不消费陈旧 data；
 * - 跨 tick session 自然失效（各 tick 独立构建）。
 * 观测手段：临时诊断计数（configResolve/ensureDataState 每 makeContext 恰一次）。
 */
import {
  clearMarketTickSessionForTest,
  runMarketSaleAutomation,
  runMarketSalePreflight,
} from "@/runtime/marketSaleAutomation";
import {
  flushMarketSaleDiagnostics,
  readMarketSaleDiagnosticsForTest,
  resetMarketSaleDiagnosticsForTest,
} from "@/runtime/marketSaleDiagnostics";

describe("marketTickSession", () => {
  beforeEach(() => {
    clearMarketTickSessionForTest();
    resetMarketSaleDiagnosticsForTest();
    Game.time = 100;
    Memory.cfg = { marketSaleDiagnostics: { enabled: true, windowTicks: 50 } };
    Memory.runtime = undefined;
    Memory.data = undefined;
    Game.market = { orders: {} } as unknown as Market;
    (Game as Game & { cpu: CPU }).cpu = {
      getUsed: () => 10,
      bucket: 9000,
      limit: 500,
      tickLimit: 500,
    } as unknown as CPU;
  });

  it("shares one context build across preflight and automation in the same tick", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    expect(runMarketSaleAutomation()).toBeDefined();
    flushMarketSaleDiagnostics();

    const diagnostics = readMarketSaleDiagnosticsForTest();
    // session 生效的直接证据：两阶段合计只构建一次 context。
    expect(diagnostics!.phases.configResolve.calls).toBe(1);
    expect(diagnostics!.phases.ensureDataState.calls).toBe(1);
    expect(diagnostics!.phases.liveOrdersSnapshot.calls).toBeLessThanOrEqual(1);
  });

  it("rebuilds the context after an external root replacement", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    Memory.data!.marketSaleAutomation = {
      ...Memory.data!.marketSaleAutomation!,
    } as NonNullable<Memory["data"]>["marketSaleAutomation"];

    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();

    // 替换后本 tick 重建了一次 context（1 初始 + 1 重建）。
    const diagnostics = readMarketSaleDiagnosticsForTest();
    expect(diagnostics!.phases.configResolve.calls).toBe(2);
  });

  it("expires across ticks", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();
    Game.time += 1;
    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();

    const diagnostics = readMarketSaleDiagnosticsForTest();
    expect(diagnostics!.samples).toBe(2);
  });
});
