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

  it("下一 tick 强制完整深恢复（跨 tick 快速路径已移除）", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    const recoveriesAfterFirstTick = getMarketDataStateDeepRecoveriesForTest();
    expect(recoveriesAfterFirstTick).toBeGreaterThanOrEqual(1);
    flushMarketSaleDiagnostics();

    // 下一 tick：即使根引用未变（测试环境 Memory 不重解析），也必须
    // 重新执行完整深恢复——每 tick 一次逐条内容校验，不再有跨 tick
    // 结构键快速命中。
    clearMarketTickSessionForTest();
    Game.time += 1;
    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();

    expect(getMarketDataStateDeepRecoveriesForTest()).toBe(
      recoveriesAfterFirstTick + 1,
    );
    const diagnostics = readMarketSaleDiagnosticsForTest();
    expect(diagnostics!.samples).toBe(2);
  });

  it("JSON round-trip（生产 Memory 重解析形态）后每 tick 深恢复且内容无损", () => {
    // 生产环境每 tick Memory 经 JSON 序列化/重解析：对象引用必然全部
    // 更换。快速路径移除后，round-trip 后的每 tick 都必须走完整深恢复，
    // 且深恢复本身幂等（顶层结构不丢字段）。
    expect(runMarketSalePreflight()).toBeDefined();
    const topLevelKeys = Object.keys(
      Memory.data!.marketSaleAutomation as unknown as Record<string, unknown>,
    ).sort();

    clearMarketTickSessionForTest();
    Game.time += 1;
    Memory.data = JSON.parse(JSON.stringify(Memory.data));
    expect(runMarketSalePreflight()).toBeDefined();

    expect(getMarketDataStateDeepRecoveriesForTest()).toBeGreaterThanOrEqual(2);
    // 幂等性：深恢复不损坏业务根（顶层键集合往返保持）。
    expect(
      Object.keys(
        Memory.data!.marketSaleAutomation as unknown as Record<string, unknown>,
      ).sort(),
    ).toEqual(topLevelKeys);
    expect(Memory.data!.marketSaleAutomation).toBeDefined();
  });

  it("同 tick 引用短路保留；跨 tick 同引用也强制深恢复", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    const committedRoot = Memory.data!.marketSaleAutomation;
    const recoveriesAfterCommit = getMarketDataStateDeepRecoveriesForTest();

    // 同 tick：已验证/已 commit 的根引用原样放回 → 命中同 tick 短路，
    // 不重复深恢复（保留的仅此一条快速途径）。
    clearMarketTickSessionForTest();
    Memory.data!.marketSaleAutomation = committedRoot;
    expect(runMarketSalePreflight()).toBeDefined();
    expect(getMarketDataStateDeepRecoveriesForTest()).toBe(recoveriesAfterCommit);

    // 跨 tick：同一引用再次出现（生产永不发生，测试环境构造旧快速
    // 路径的误命中形态）→ tick 失配，强制完整深恢复。
    clearMarketTickSessionForTest();
    Game.time += 1;
    Memory.data!.marketSaleAutomation = committedRoot;
    expect(runMarketSalePreflight()).toBeDefined();
    expect(getMarketDataStateDeepRecoveriesForTest()).toBe(
      recoveriesAfterCommit + 1,
    );
  });

  it("同条目数但 managed order 内容损坏被逐条检出（quarantine）", () => {
    expect(runMarketSalePreflight()).toBeDefined();

    // 注入一条字段级损坏的 managed order（price 为负；条目数不变，
    // 旧 commitment 结构键对该形态不可见）。
    clearMarketTickSessionForTest();
    Game.time += 1;
    const marketData = Memory.data!.marketSaleAutomation as unknown as {
      managedOrders: Record<string, unknown>;
    };
    marketData.managedOrders = {
      "order-1": {
        orderId: "order-1",
        roomName: "W1N1",
        resourceType: RESOURCE_ENERGY,
        price: -0.5,
        originalAmount: 1000,
        lastRemainingAmount: 800,
        remainingExposure: 800,
        feeDebtMilli: 0,
        createdAt: 1,
        lastSeenAt: 1,
        policyCancelAtTick: 0,
        serverCreatedTick: 1,
      },
    };
    expect(runMarketSalePreflight()).toBeDefined();

    // 深恢复逐条校验检出损坏：条目被移出 managedOrders，且 direct
    // 进入受控 blocked 形态（quarantine 证据链落点随 direct 形态而变，
    // 断言锁定"检出+受控"这一稳定行为）。
    const recovered = Memory.data!.marketSaleAutomation as unknown as {
      managedOrders: Record<string, unknown>;
      directAutomation: { migrationBlockedReason?: string };
    };
    expect(Object.keys(recovered.managedOrders)).toHaveLength(0);
    expect(recovered.directAutomation.migrationBlockedReason).toBeDefined();
  });

  it("同条目数但 pending mutation / fee ledger 内容损坏被检出（fail-safe）", () => {
    expect(runMarketSalePreflight()).toBeDefined();

    clearMarketTickSessionForTest();
    Game.time += 1;
    const marketData = Memory.data!.marketSaleAutomation as unknown as {
      pendingMutations: Record<string, unknown>;
      feeLedger: unknown;
    };
    // cancel 类 mutation 的 prospectiveFeeMilli 必须精确等于重算值 0；
    // 同条目数但费用字段损坏 → 逐条检出。
    marketData.pendingMutations = {
      "order-2": {
        orderId: "order-2",
        kind: "cancel",
        requestedAt: 1,
        pre: { price: 0.5, totalAmount: 1000, remainingAmount: 800 },
        requested: {},
        prospectiveFeeMilli: 123,
        conservativeExposure: 800,
        status: "prepared",
      },
    };
    marketData.feeLedger = {
      feeEvents: [{ id: "evt-1", tick: 1, action: "create", feeMilli: -5 }],
      sameTickReservations: [],
      processedFills: [],
      carriedFeeDebtMilli: {},
    };
    expect(runMarketSalePreflight()).toBeDefined();

    const recovered = Memory.data!.marketSaleAutomation as unknown as {
      pendingMutations: Record<string, unknown>;
      feeLedger: { feeEvents: unknown[] };
    };
    expect(Object.keys(recovered.pendingMutations)).toHaveLength(0);
    // fee ledger 损坏（feeMilli 为负）→ fail-safe 重置为空窗口。
    expect(recovered.feeLedger.feeEvents).toHaveLength(0);

    // 对照：同条目数、内容完好的 fee ledger 条目经每 tick 校验后保留。
    clearMarketTickSessionForTest();
    Game.time += 1;
    const good = Memory.data!.marketSaleAutomation as unknown as {
      feeLedger: Record<string, unknown>;
    };
    good.feeLedger = {
      feeEvents: [{ id: "evt-2", tick: 1, action: "create", feeMilli: 500 }],
      sameTickReservations: [],
      processedFills: [],
      carriedFeeDebtMilli: {},
    };
    expect(runMarketSalePreflight()).toBeDefined();
    const kept = Memory.data!.marketSaleAutomation as unknown as {
      feeLedger: { feeEvents: { id: string }[] };
    };
    expect(kept.feeLedger.feeEvents.map((e) => e.id)).toEqual(["evt-2"]);
  });

  it("runs full recovery again after a simulated global reset", () => {
    expect(runMarketSalePreflight()).toBeDefined();
    const recoveriesAfterFirstTick = getMarketDataStateDeepRecoveriesForTest();
    flushMarketSaleDiagnostics();

    // global reset 后 Memory 树全新（引用全换）：无论模块级验证标记是否
    // 幸存，下一 tick 都必须重新深恢复一次。
    clearMarketTickSessionForTest();
    Game.time += 1;
    Memory.data = JSON.parse(JSON.stringify(Memory.data));
    expect(runMarketSalePreflight()).toBeDefined();
    flushMarketSaleDiagnostics();

    expect(getMarketDataStateDeepRecoveriesForTest()).toBeGreaterThan(recoveriesAfterFirstTick);
    expect(readMarketSaleDiagnosticsForTest()!.samples).toBe(2);
  });
});
