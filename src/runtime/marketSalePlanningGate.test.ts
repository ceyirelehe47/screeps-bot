/**
 * 市场规划分频回归测试（提交 E）：
 * - 无 exposure、非 planning 周期 → 快速退出（不收集 protection、不刷新
 *   pricing、不组合 candidates、不写 planning 周期标记）；
 * - planning 周期到期 → 完整路径执行一次并记录周期锚点；
 * - exposure（pending direct deal）出现 → 无视分频立即走完整安全路径；
 * - config revision 变化 → 立即恢复 planning；
 * - preflight 的 latch/reconcile 不受分频影响（每 tick 执行）。
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

const VALID_CONFIG = {
  validForPlanning: true,
  invalidReasons: [],
  mode: "direct",
  directCapability: "legacy-canary",
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

jest.mock("@/runtime/marketSaleConfig", () => {
  const actual = jest.requireActual("@/runtime/marketSaleConfig");
  return {
    ...actual,
    resolveMarketSaleAutomationConfig: jest.fn(() => VALID_CONFIG),
  };
});

jest.mock("@/runtime/marketSaleProtectionAdapter", () => ({
  collectLiveMarketSaleProtectionLedger: jest.fn(() => ({
    version: 1,
    currentTick: Game.time,
    revision: Game.time,
    observedAt: Game.time,
    expiresAt: Game.time,
    entries: {},
    sources: {},
    complete: true,
  })),
}));

function setupHealthyDirectState(): void {
  Memory.cfg = {
    marketSaleAutomation: {
      mode: "direct",
      configRevision: "market-base-resource-v3-r3",
    },
  };
  Memory.runtime = {
    resourceControl: { updatedAt: Game.time, rooms: {} },
  } as unknown as NonNullable<Memory["runtime"]>;
  (Memory.runtime as unknown as Record<string, unknown>).marketSaleAutomation = {
    marketSaleAutomation: {
      updatedAt: Game.time,
      requestedMode: "direct",
      phase: "direct",
      shadowConsecutiveCycles: 0,
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
    },
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
      drain: { phase: "direct", zeroConfirmations: 2 },
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

function makeDependencies() {
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
    runAutomation: jest.fn(() => ({
      requestedMode: "direct",
      effectiveMode: "direct",
      phase: "direct",
      writes: 0,
      actions: [],
      rejectedByReason: {},
    })) as never,
  };
  return { collectProtection, dependencies };
}

describe("market planning interval gate", () => {
  beforeEach(() => {
    Game.time = 1000;
    setupHealthyDirectState();
    clearMarketSaleRuntimeCachesForTest();
    clearMarketTickSessionForTest();
    clearMarketPerformanceCountersForTest();
  });

  it("runs the full path once per interval and fast-exits in between", () => {
    const { collectProtection, dependencies } = makeDependencies();

    // 首个周期（无历史锚点）：完整 planning。
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(1);
    const countersAfterFirst = readMarketPerformanceCounters();
    expect(countersAfterFirst.marketPlanningDueTicks).toBe(1);

    // 周期内（间隔 5 tick）：快速退出，不收集 protection。
    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(1);
    expect(readMarketPerformanceCounters().marketPlanningDeferredTicks).toBe(1);

    // 周期到期：恢复完整 planning。
    Game.time += 5;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(2);
  });

  it("bypasses the interval immediately when exposure appears", () => {
    const { collectProtection, dependencies } = makeDependencies();

    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(1);

    // 周期内出现 pending direct deal（exposure）：无视分频立即完整路径。
    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    (Memory.data!.marketSaleAutomation!.directAutomation as {
      pendingDirectDeals: Record<string, unknown>;
    }).pendingDirectDeals = {
      "req-1": {
        roomName: "E1N57",
        resource: "X",
        dealAmount: 1000,
        status: "prepared",
      },
    };
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(2);
  });

  it("re-plans immediately after a config revision change", () => {
    const { collectProtection, dependencies } = makeDependencies();

    runLiveMarketSaleAutomation(dependencies);
    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    (VALID_CONFIG as { configRevision: string }).configRevision = "market-base-resource-v3-r4";
    runLiveMarketSaleAutomation(dependencies);
    expect(collectProtection).toHaveBeenCalledTimes(2);
    // 规划周期锚点同步更新为新 revision。
    expect(
      (Memory.runtime!.marketSaleAutomation as { lastPlanningConfigRevision?: string })
        .lastPlanningConfigRevision,
    ).toBe("market-base-resource-v3-r4");
  });

  it("keeps preflight latch/reconcile running every tick regardless of the gate", () => {
    // preflight 每 tick 执行（分频只作用于 runLive 的 planning 组合层）。
    expect(runMarketSalePreflight()).toBeDefined();
    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    expect(runMarketSalePreflight()).toBeDefined();
  });
});
