/**
 * 显式 planning authorization 集成测试（P1，真实链路）：
 * 外层 runLiveMarketSaleAutomation → 真实 runMarketSaleAutomation
 * （含真实 MarketTickSession / ensureDataState / V3 reconcile / drain /
 * pending 语义）。只 mock IO 采集层（collectProtection/collectPricing）与
 * config 解析——不 mock runAutomation。
 *
 * 覆盖：
 * - deferred tick 上即使 ResourceControl.updatedAt===Game.time（修复前的
 *   planningCycleCurrent 误真场景），candidate 投影不得重置/推进、
 *   planning 锚点不得刷新、data 根（permit/ledger/ratchet/readiness/
 *   qualification 所在）不得被 planning 写入；
 * - due tick 完整 planning（锚点推进、protection/pricing/candidates 组合）；
 * - exposure（pendingDirectDeals）出现立即绕过分频，pending deal 不被
 *   分频延迟（deferred tick 内照常 reconcile + 全量采集）；
 * - continuous-v3 capability 下 V3 状态子树在 deferred tick 不推进
 *  （真实 V3 reconcile；迁移 blocked 时的逐 tick 安全层写入不算 planning
 *  推进，断言只锚定 baseResourceV3 子树）。
 */
import {
  clearMarketSaleRuntimeCachesForTest,
  runLiveMarketSaleAutomation,
  type MarketSaleRuntimeDependencies,
} from "@/runtime/marketSaleRuntime";
import {
  clearMarketTickSessionForTest,
  runMarketSalePreflight,
} from "@/runtime/marketSaleAutomation";
import {
  clearMarketPerformanceCountersForTest,
  readMarketPerformanceCounters,
} from "@/runtime/marketPerformanceCounters";
import {
  flushMarketSaleDiagnostics,
  readMarketSaleDiagnosticsForTest,
  resetMarketSaleDiagnosticsForTest,
} from "@/runtime/marketSaleDiagnostics";

type TestConfig = Record<string, unknown> & { configRevision: string };

function makeValidConfig(directCapability: string): TestConfig {
  return {
    validForPlanning: true,
    invalidReasons: [],
    mode: "shadow",
    directCapability,
    shadowStrategy: "maker",
    configRevision: "market-base-resource-v3-r3",
    sellResources: ["X", "H", "Z", "K", "L", "O", "U"],
    hardFloor: {},
    economicFloor: {},
    forecastBuffer: {},
    makerBatchAmount: 1000,
    minDealAmount: 100,
    maxDealAmount: 10000,
    maxManagedOrders: 3,
    minFreeOrderSlots: 5,
    creditReserve: 0,
    rollingFeeBudget: 1_000_000,
    feeWindowTicks: 1000,
    terminalEnergyReserve: 10_000,
    energyShadowPrice: undefined,
    directDiscountRatio: 0.95,
    minHistoryDays: 7,
    minHistoryTransactions: 10,
    minHistoryVolume: 1000,
    historyFloorRatio: 0.9,
    historyMaxAgeDays: 14,
    minReferenceOrderAmount: 100,
    minReferenceOrderNotional: 1000,
    minReferenceOrderCount: 3,
    minReferenceDistinctRooms: 2,
    referenceDepthMultiplier: 1.2,
    maxHistoryAskDeviationRatio: 0.5,
    makerAskFloorRatio: 1.0,
    makerHistoryVolumeRatio: 0.5,
    orderPolicyTtl: 50,
    mutationBackoffTicks: 10,
    maxDirectDealAmount: 5000,
    maxDirectDealsPerCycle: 2,
    minDirectOrderAmount: 100,
    minDirectOrderNotional: 500,
    maxDirectRawOrdersScannedPerCycle: 50,
    maxDirectEligibleOrdersPricedPerCycle: 10,
    maxDirectTransactionEnergy: 2000,
    directCanaryMaxConfirmedDeals: 5,
    energyShadowHardFloor: 0.05,
    planningSnapshotMaxAgeTicks: 100,
  };
}

// 当前 describe 使用的 config（jest.mock 工厂需在 import 阶段闭包可及）。
let activeConfig: TestConfig = makeValidConfig("legacy-canary");

jest.mock("@/runtime/marketSaleConfig", () => {
  const actual = jest.requireActual("@/runtime/marketSaleConfig");
  return {
    ...actual,
    resolveMarketSaleAutomationConfig: jest.fn(() => activeConfig),
  };
});

function setupHealthyShadowState(): void {
  Memory.cfg = {
    marketSaleAutomation: {
      mode: "shadow",
      configRevision: "market-base-resource-v3-r3",
    },
    marketSaleDiagnostics: { enabled: true, windowTicks: 50 },
  };
  Memory.runtime = {
    resourceControl: { updatedAt: Game.time, rooms: {} },
  } as unknown as NonNullable<Memory["runtime"]>;
  (Memory.runtime as unknown as Record<string, unknown>).marketSaleAutomation = {
    updatedAt: Game.time,
    requestedMode: "shadow",
    phase: "shadow",
    shadowConsecutiveCycles: 3,
    zeroConfirmations: 0,
    managedOrderCount: 0,
    pendingCreateCount: 0,
    pendingMutationCount: 0,
    stagingAmount: 0,
    reservationAmount: 0,
    exposureAmount: 0,
    rollingFeeMilli: 0,
    terminalClaims: [],
    rejectedByReason: {},
    candidates: {},
    recentActions: [],
    safetyViolationCount: 0,
  } as unknown as NonNullable<Memory["runtime"]>;
  Memory.data = {
    marketSaleAutomation: {
      managedOrders: {},
      pendingMutations: {},
      pendingDirectDeals: {},
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
      drain: { phase: "shadow", zeroConfirmations: 2 },
      marketStaging: {},
      marketReservations: {},
      directAutomation: {
        schemaVersion: 2,
        capability: "market-direct-continuous",
        migrationStatus: "active",
        pendingDirectDeals: {},
        quarantinedPendingDirectDeals: {},
        directDealOutcomes: [],
        processedDirectTransactionKeys: [],
        directConfirmedDealCount: 0,
        directPausedForReview: false,
      },
    },
  } as unknown as NonNullable<Memory["data"]>;
  Game.rooms = {};
  Game.market = { orders: {} } as unknown as Market;
  (Game as Game & { cpu: CPU }).cpu = {
    getUsed: () => 10,
    bucket: 9000,
    limit: 500,
    tickLimit: 500,
  } as unknown as CPU;
}

/** IO 层 mock（真实链路允许：采集层是外部 IO；runAutomation 必须真实）。 */
function makeIoDependencies(): {
  collectProtection: jest.Mock;
  dependencies: MarketSaleRuntimeDependencies;
} {
  const collectProtection = jest.fn(() => ({
    version: 1,
    currentTick: Game.time,
    revision: Game.time,
    observedAt: Game.time,
    expiresAt: Game.time,
    entries: {},
    sources: {},
    complete: true,
  }));
  const dependencies: MarketSaleRuntimeDependencies = {
    collectProtection: collectProtection as never,
    collectPricing: jest.fn(() => ({
      observedAt: Game.time,
      asOfDate: "2026-08-29",
      snapshots: {},
    })) as never,
  };
  return { collectProtection, dependencies };
}

function advanceTick(freshResourceControl = true): void {
  Game.time += 1;
  clearMarketTickSessionForTest();
  clearMarketSaleRuntimeCachesForTest();
  if (freshResourceControl) {
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
  }
}

function marketDataRoot(): Record<string, unknown> {
  return Memory.data!.marketSaleAutomation as unknown as Record<string, unknown>;
}

function marketRuntimeState(): Record<string, unknown> {
  return Memory.runtime!.marketSaleAutomation as unknown as Record<string, unknown>;
}

beforeEach(() => {
  Game.time = 2000;
  activeConfig = makeValidConfig("legacy-canary");
  setupHealthyShadowState();
  clearMarketSaleRuntimeCachesForTest();
  clearMarketTickSessionForTest();
  clearMarketPerformanceCountersForTest();
  resetMarketSaleDiagnosticsForTest();
});

describe("market planning authorization（真实链路集成，shadow/maker 策略）", () => {
  it("due tick：完整 planning——锚点推进、protection 采集、候选组合", () => {
    const { collectProtection, dependencies } = makeIoDependencies();
    // 生产顺序：preflight → ResourceControl → automation。
    expect(runMarketSalePreflight()).toBeDefined();
    const result = runLiveMarketSaleAutomation(dependencies);

    expect(result).toBeDefined();
    expect(collectProtection).toHaveBeenCalledTimes(1);
    expect(readMarketPerformanceCounters().marketPlanningDueTicks).toBe(1);
    expect(marketRuntimeState().lastPlanningCycleTick).toBe(Game.time);
    expect(marketRuntimeState().lastPlanningConfigRevision).toBe(
      "market-base-resource-v3-r3",
    );
  });

  it("deferred tick（RC 新鲜）：planning 推进被禁止，投影/锚点/data 根不动", () => {
    const { collectProtection, dependencies } = makeIoDependencies();
    expect(runMarketSalePreflight()).toBeDefined();
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(1);

    // deferred tick，但 ResourceControl.updatedAt 是当前 tick——修复前
    // 内层 planningCycleCurrent 误真：candidate 投影被重置为空、planning
    // 段照跑。修复后必须保持不动。
    advanceTick(true);
    expect(runMarketSalePreflight()).toBeDefined();

    // 哨兵：上一次 due tick 留下的候选投影（修复前会在本 tick 被清空）。
    const runtimeState = marketRuntimeState() as {
      candidates: Record<string, unknown>;
    };
    runtimeState.candidates = { "W1N1:X": { roomName: "W1N1", resource: "X" } };
    const dueTickAnchor = Game.time - 1;
    marketRuntimeState().lastPlanningCycleTick = dueTickAnchor;
    // qualification 时间戳锚定在 due tick（修复前 deferred+RC 新鲜会重盖）。
    marketRuntimeState().lastShadowCycleTick = dueTickAnchor;
    const shadowCyclesBefore = marketRuntimeState().shadowConsecutiveCycles;
    const dataRootBefore = JSON.stringify(marketDataRoot());

    const result = runLiveMarketSaleAutomation(dependencies);

    expect(result).toBeDefined();
    expect(readMarketPerformanceCounters().marketPlanningDeferredTicks).toBe(1);
    expect(readMarketPerformanceCounters().marketPlanningDueTicks).toBe(1);
    expect(collectProtection).toHaveBeenCalledTimes(1);
    // candidate 投影哨兵保留（未被 deferred tick 重置/推进）。
    expect(marketRuntimeState().candidates).toEqual({
      "W1N1:X": { roomName: "W1N1", resource: "X" },
    });
    // planning 周期锚点与 qualification 时间戳未刷新；计数未动。
    expect(marketRuntimeState().lastPlanningCycleTick).toBe(dueTickAnchor);
    expect(marketRuntimeState().lastShadowCycleTick).toBe(dueTickAnchor);
    expect(marketRuntimeState().shadowConsecutiveCycles).toBe(shadowCyclesBefore);
    // data 根（permit/ledger/ratchet/readiness 所在）未被 planning 写入。
    expect(JSON.stringify(marketDataRoot())).toBe(dataRootBefore);
  });

  it("exposure（pending deal）出现立即绕过分频，不被延迟", () => {
    const { collectProtection, dependencies } = makeIoDependencies();
    expect(runMarketSalePreflight()).toBeDefined();
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(1);

    // deferred tick 内出现 pendingDirectDeals：立即完整安全路径 + 全量
    // protection 采集 + liveOrders（对账需要真实订单视图）。
    advanceTick(true);
    expect(runMarketSalePreflight()).toBeDefined();
    const data = marketDataRoot() as {
      pendingDirectDeals?: Record<string, unknown>;
      directAutomation?: { pendingDirectDeals?: Record<string, unknown> };
    };
    data.pendingDirectDeals = {
      "req-1": {
        roomName: "E1N57",
        resource: "X",
        dealAmount: 1000,
        status: "prepared",
      },
    };
    data.directAutomation!.pendingDirectDeals = data.pendingDirectDeals;

    const result = runLiveMarketSaleAutomation(dependencies);

    expect(result).toBeDefined();
    // 分频被绕过：本 tick 完整采集。
    expect(collectProtection).toHaveBeenCalledTimes(2);
    // pending deal 对账链路真实运行（liveOrders 被加载）。
    flushMarketSaleDiagnostics();
    expect(
      readMarketSaleDiagnosticsForTest()!.phases.liveOrdersSnapshot?.calls,
    ).toBeGreaterThanOrEqual(1);
  });

  it("间隔到期恢复完整 planning（due tick 输出与旧语义一致）", () => {
    const { collectProtection, dependencies } = makeIoDependencies();
    expect(runMarketSalePreflight()).toBeDefined();
    runLiveMarketSaleAutomation(dependencies);

    for (let i = 0; i < 4; i += 1) {
      advanceTick(true);
      expect(runMarketSalePreflight()).toBeDefined();
      runLiveMarketSaleAutomation(dependencies);
    }
    expect(collectProtection).toHaveBeenCalledTimes(1);
    expect(readMarketPerformanceCounters().marketPlanningDeferredTicks).toBe(4);

    advanceTick(true);
    expect(runMarketSalePreflight()).toBeDefined();
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(2);
    expect(marketRuntimeState().lastPlanningCycleTick).toBe(Game.time);
  });
});

describe("market planning authorization（continuous-v3，真实 V3 reconcile）", () => {
  it("deferred tick：V3 状态子树不推进（迁移 blocked 的逐 tick 安全层写入除外）", () => {
    activeConfig = makeValidConfig("continuous-v3");
    Memory.cfg!.marketSaleAutomation!.directCapability = "continuous-v3";
    const { collectProtection, dependencies } = makeIoDependencies();

    // 首个 due tick：真实链路会做 V2→V3 迁移判定；极简 fixture 会落入
    // blocked 迁移（direct_v2_state_invalid）——这本身是生产正确语义
    // （blocked 迁移需要逐 tick 全量安全路径），因此本用例不断言分频
    // 计数，只锚定 deferred 语义下 V3 子树不推进。
    expect(runMarketSalePreflight()).toBeDefined();
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(1);

    const v3Snapshot = () => {
      const direct = marketDataRoot().directAutomation as
        | { baseResourceV3?: unknown }
        | undefined;
      return JSON.stringify(direct?.baseResourceV3 ?? null);
    };

    advanceTick(true);
    expect(runMarketSalePreflight()).toBeDefined();
    // 显式 deferred 语义下的真实 automation 调用（绕过外层 due 判定，
    // 直接验证内层授权语义：blocked 迁移下 exposure 通道使外层恒 due，
    // 此处直接以 planningAuthorized:false 调用真实内层）。
    const { runMarketSaleAutomation } =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("@/runtime/marketSaleAutomation") as typeof import("@/runtime/marketSaleAutomation");
    const v3Before = v3Snapshot();
    const candidatesBefore = JSON.stringify(marketRuntimeState().candidates);

    expect(
      runMarketSaleAutomation({ planningAuthorized: false }),
    ).toBeDefined();

    expect(v3Snapshot()).toBe(v3Before);
    expect(JSON.stringify(marketRuntimeState().candidates)).toBe(candidatesBefore);
  });
});
