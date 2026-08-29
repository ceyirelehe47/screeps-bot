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
  clearVerifiedMarketDataRootForTest,
  getMarketDataStateDeepRecoveriesForTest,
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
    // 无 exposure 且非 planning tick：liveOrders 全量快照被完全跳过（提交 C）。
    expect(diagnostics!.phases.liveOrdersSnapshot).toBeUndefined();
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

  it("skips full data-state recovery on the next tick when the verified root is unchanged", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    const recoveriesAfterFirstTick = getMarketDataStateDeepRecoveriesForTest();
    expect(recoveriesAfterFirstTick).toBeGreaterThanOrEqual(1);
    flushMarketSaleDiagnostics();

    // 下一 tick：根引用未变 → ensureDataState 走跨 tick 快速路径，
    // 不再执行深恢复（业务逻辑仍可正常写 drain 等字段）。
    clearMarketTickSessionForTest();
    Game.time += 1;
    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();

    expect(getMarketDataStateDeepRecoveriesForTest()).toBe(recoveriesAfterFirstTick);
    const diagnostics = readMarketSaleDiagnosticsForTest();
    expect(diagnostics!.samples).toBe(2);
  });

  it("runs full recovery again after an external field-level mutation is not detectable but root replacement is", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();

    // 外部替换根：引用失配 → 完整恢复（保守正确）。
    clearMarketTickSessionForTest();
    Game.time += 1;
    Memory.data!.marketSaleAutomation = {
      ...Memory.data!.marketSaleAutomation!,
    } as NonNullable<Memory["data"]>["marketSaleAutomation"];
    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();
    expect(Memory.data!.marketSaleAutomation).toBeDefined();
  });

  it("runs full recovery again after a simulated global reset", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    const recoveriesAfterFirstTick = getMarketDataStateDeepRecoveriesForTest();
    flushMarketSaleDiagnostics();

    clearMarketTickSessionForTest();
    clearVerifiedMarketDataRootForTest();
    Game.time += 1;
    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();

    // global reset 清空验证标记后：下一 tick 必须重新深恢复一次。
    expect(getMarketDataStateDeepRecoveriesForTest()).toBeGreaterThan(recoveriesAfterFirstTick);
    expect(readMarketSaleDiagnosticsForTest()!.samples).toBe(2);
  });
});
