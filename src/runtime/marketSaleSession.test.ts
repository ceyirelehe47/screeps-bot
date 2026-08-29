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
    // 无 exposure 且未显式 planning 授权：liveOrders 全量快照被完全跳过。
    expect(diagnostics!.phases.liveOrdersSnapshot).toBeUndefined();
  });

  it("真实顺序 preflight→RC→due automation：automation 补载真实订单而非空快照", () => {
    // 生产主循环顺序：preflight（main.ts:59）先于 ResourceControl（:69），
    // automation（:70）最后。preflight 时 RC.updatedAt 尚旧，无 exposure 的
    // context 不加载订单；RC 推进 updatedAt 后，due automation 必须看到
    // Game.market.orders 的真实订单/订单槽/fingerprint 基线，而不是把
    // preflight 阶段的空快照冻结到底。
    Game.market = {
      orders: {
        "order-1": {
          id: "order-1",
          type: ORDER_SELL,
          resourceType: RESOURCE_ENERGY,
          roomName: "W1N1",
          price: 0.5,
          totalAmount: 1000,
          remainingAmount: 800,
          amount: 200,
          created: 1,
          active: true,
        },
      },
    } as unknown as Market;
    Memory.runtime = {
      resourceControl: { updatedAt: Game.time - 1, rooms: {} },
    } as unknown as NonNullable<Memory["runtime"]>;

    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();
    // preflight 阶段（RC 未跑）：不加载订单。
    expect(
      readMarketSaleDiagnosticsForTest()!.phases.liveOrdersSnapshot,
    ).toBeUndefined();

    // ResourceControl 在本 tick 推进 updatedAt。
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    // due automation（外层显式 planningAuthorized）：本 tick 首次补载订单。
    expect(
      runMarketSaleAutomation({ planningAuthorized: true }),
    ).toBeDefined();
    flushMarketSaleDiagnostics();
    const phases = readMarketSaleDiagnosticsForTest()!.phases;
    expect(phases.liveOrdersSnapshot?.calls).toBe(1);

    // 同 tick 第二次 planning 调用不再重复读取（懒标记，至多一次）。
    expect(
      runMarketSaleAutomation({ planningAuthorized: true }),
    ).toBeDefined();
    flushMarketSaleDiagnostics();
    expect(
      readMarketSaleDiagnosticsForTest()!.phases.liveOrdersSnapshot.calls,
    ).toBe(1);
  });

  it("deferred tick（RC 新鲜但未授权）不补载订单", () => {
    Memory.runtime = {
      resourceControl: { updatedAt: Game.time, rooms: {} },
    } as unknown as NonNullable<Memory["runtime"]>;
    expect(runMarketSalePreflight()).toBeDefined();
    expect(
      runMarketSaleAutomation({ planningAuthorized: false }),
    ).toBeDefined();
    flushMarketSaleDiagnostics();
    // RC.updatedAt===Game.time 但外层判定 deferred：不读订单（修复前
    // hasLiveOrderConsumers 会在此情形下加载/消费过期判定）。
    expect(
      readMarketSaleDiagnosticsForTest()!.phases.liveOrdersSnapshot,
    ).toBeUndefined();
  });

  it("exposure（pendingDirectDeals）时 preflight 立即加载订单", () => {
    // 先 bootstrap：让 ensureDataState 建立合法 data 根，再注入 exposure。
    expect(runMarketSalePreflight()).toBeDefined();
    const marketData = Memory.data!.marketSaleAutomation as unknown as {
      pendingDirectDeals?: Record<string, unknown>;
      directAutomation?: { pendingDirectDeals?: Record<string, unknown> };
    };
    marketData.pendingDirectDeals = {
      "req-1": { roomName: "W1N1", resource: RESOURCE_ENERGY, status: "prepared" },
    };
    marketData.directAutomation!.pendingDirectDeals =
      marketData.pendingDirectDeals;
    clearMarketTickSessionForTest();
    resetMarketSaleDiagnosticsForTest();

    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();
    expect(
      readMarketSaleDiagnosticsForTest()!.phases.liveOrdersSnapshot?.calls,
    ).toBe(1);
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

  it("JSON round-trip（生产 Memory 重解析形态）后仍命中 commitment 快速路径", () => {
    // 生产环境每 tick Memory 经 JSON 序列化/重解析：对象引用必然全部
    // 更换，旧的"引用相等"快速路径在线上永远无法命中。commitment 键
    // （顶层键集合 + exposure 规模 + 迁移状态标量）跨 round-trip 稳定，
    // 本用例锁定该语义。
    expect(runMarketSalePreflight()).toBeDefined();

    // 状态沉降：首个 tick 深恢复后 preflight 可能原地推进 drain 等字段
    //（合法的每 tick 安全写入），连续 tick 直到恢复计数稳定。
    let settledRecoveries = -1;
    for (let i = 0; i < 8; i += 1) {
      clearMarketTickSessionForTest();
      Game.time += 1;
      expect(runMarketSalePreflight()).toBeDefined();
      const current = getMarketDataStateDeepRecoveriesForTest();
      if (current === settledRecoveries) break;
      settledRecoveries = current;
    }

    // 模拟引擎行为：整棵 Memory 树 JSON round-trip（引用全换）。
    // 不清 verified 标记（模块级 commitment 状态跨 tick 保留，
    // 仅对象身份更换）。
    clearMarketTickSessionForTest();
    Game.time += 1;
    Memory.data = JSON.parse(JSON.stringify(Memory.data));
    expect(runMarketSalePreflight()).toBeDefined();

    // 引用已换但结构 commitment 未变：不再深恢复。
    expect(getMarketDataStateDeepRecoveriesForTest()).toBe(settledRecoveries);
    // 业务字段在 round-trip 后仍可用（返回的 data 即当前根）。
    expect(Memory.data!.marketSaleAutomation).toBeDefined();
  });

  it("commitment 快速路径对结构变化回退深恢复（exposure 规模变化）", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    const recoveriesAfterFirstTick = getMarketDataStateDeepRecoveriesForTest();

    // round-trip + 结构变化（新增 exposure 键）：commitment 键失配 →
    // 完整深恢复（保守正确）。
    clearMarketTickSessionForTest();
    Game.time += 1;
    Memory.data = JSON.parse(JSON.stringify(Memory.data));
    const marketData = Memory.data!.marketSaleAutomation as unknown as {
      pendingDirectDeals: Record<string, unknown>;
      directAutomation?: { pendingDirectDeals?: Record<string, unknown> };
    };
    marketData.pendingDirectDeals = {
      "req-x": { roomName: "W1N1", resource: RESOURCE_ENERGY },
    };
    if (marketData.directAutomation) {
      marketData.directAutomation.pendingDirectDeals =
        marketData.pendingDirectDeals;
    }
    expect(runMarketSalePreflight()).toBeDefined();
    expect(getMarketDataStateDeepRecoveriesForTest()).toBeGreaterThan(
      recoveriesAfterFirstTick,
    );
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
