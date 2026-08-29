import {
  clearMarketSaleRuntimeCachesForTest,
  composeMarketSalePlanCandidates,
  runLiveMarketSaleAutomation,
  type MarketSaleRuntimeCompositionContext,
} from "@/runtime/marketSaleRuntime";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import type { MarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import type {
  MarketProtectionEntry,
  MarketSaleProtectionLedger,
} from "@/runtime/marketSaleProtection";
import type { MarketSalePriceSnapshotCollection } from "@/runtime/marketSalePricingAdapter";

function config(): MarketSaleAutomationConfig {
  return {
    mode: "shadow",
    configRevision: "rev-1",
    sellResources: [RESOURCE_KEANIUM],
    hardFloor: { [RESOURCE_KEANIUM]: 65 },
    economicFloor: {},
    forecastBuffer: { [RESOURCE_KEANIUM]: 5_000 },
    minDealAmount: 500,
    maxDealAmount: 5_000,
    makerBatchAmount: 1_000,
    maxManagedOrders: 1,
    minFreeOrderSlots: 5,
    creditReserve: 100_000,
    rollingFeeBudget: 1_000,
    feeWindowTicks: 20_000,
    terminalEnergyReserve: 25_000,
    directDiscountRatio: 0.95,
    minHistoryDays: 5,
    minHistoryTransactions: 3,
    minHistoryVolume: 1_000,
    historyFloorRatio: 0.9,
    historyMaxAgeDays: 2,
    minReferenceOrderAmount: 1_000,
    minReferenceOrderNotional: 100,
    minReferenceOrderCount: 3,
    minReferenceDistinctRooms: 3,
    referenceDepthMultiplier: 3,
    orderPolicyTtl: 20_000,
    mutationBackoffTicks: 1_000,
    canaryEnabled: true,
    canaryAllowExpansion: false,
    validForPlanning: true,
    invalidReasons: [],
  };
}

function entry(): MarketProtectionEntry {
  return {
    roomName: "W1N1",
    resource: RESOURCE_KEANIUM,
    revision: 100,
    observedAt: 100,
    expiresAt: 100,
    totalStock: 80_000,
    terminalStock: 20_000,
    hardReserve: 5_000,
    productionDemand: 10_000,
    forecastBuffer: 5_000,
    protectedOutgoing: 0,
    carrierOrInFlight: 0,
    protectedAmount: 15_000,
    grossSurplus: 65_000,
    managedExposure: 0,
    newExposureCapacity: 65_000,
    sellableAmount: 20_000,
    fresh: true,
    blocked: false,
    blockedReasons: [],
    issues: [],
    sourceContributions: [],
  };
}

function protection(): MarketSaleProtectionLedger {
  return {
    currentTick: 100,
    revision: 100,
    observedAt: 100,
    expiresAt: 100,
    fresh: true,
    blockedEntryCount: 0,
    entries: { "W1N1:K": entry() },
  };
}

function pricing(): MarketSalePriceSnapshotCollection {
  return {
    observedAt: 100,
    asOfDate: "2026-07-25",
    snapshots: {
      [RESOURCE_KEANIUM]: {
        resource: RESOURCE_KEANIUM,
        observedAt: 100,
        asOfDate: "2026-07-25",
        trusted: true,
        rejections: [],
        historyFloor: 68,
        ratchetFloor: 69,
        historyResult: {
          trusted: true,
          latestHistoryDate: "2026-07-24",
          referencePrice: 72,
          trustedFloor: 68,
          medianLogPrice: Math.log(72),
          madLogPrice: 0.01,
          completeDayCount: 7,
          acceptedDayCount: 6,
          acceptedDates: [
            "2026-07-18",
            "2026-07-19",
            "2026-07-20",
            "2026-07-21",
            "2026-07-22",
            "2026-07-24",
          ],
          rejectedDays: [],
        },
        effectiveNetFloor: 70,
        makerPrice: 74,
        makerPriceResult: {
          safe: true,
          minimumSafePrice: 74,
          minimumSafePriceMilli: 74_000,
          recommendedPrice: 74,
          evaluation: {
            action: "create",
            candidatePrice: 74,
            candidatePriceMilli: 74_000,
            postRemainingAmount: 1_000,
            prospectiveFeeMilli: 3_700_000,
            postActionFeeDebtMilli: 3_700_000,
            grossRemainingValueMilli: 74_000_000,
            netRemainingValueMilli: 70_300_000,
            requiredNetValueMilli: 70_000_000,
            satisfiesInvariant: true,
          },
        },
        referenceSellBook: {
          trusted: true,
          eligibleOrders: [],
          rejectedOrders: [],
          eligibleAmount: 5_000,
          trustedDepth: 5_000,
          distinctOrderCount: 3,
          distinctRoomCount: 3,
        },
      },
    },
  };
}

function protectionAt(tick: number): MarketSaleProtectionLedger {
  const value = protection();
  const protectedEntry = {
    ...value.entries["W1N1:K"],
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
  };
  return {
    ...value,
    currentTick: tick,
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
    entries: { "W1N1:K": protectedEntry },
  };
}

function pricingAt(tick: number): MarketSalePriceSnapshotCollection {
  const value = pricing();
  return {
    ...value,
    observedAt: tick,
    snapshots: {
      [RESOURCE_KEANIUM]: {
        ...value.snapshots[RESOURCE_KEANIUM]!,
        observedAt: tick,
      },
    },
  };
}


function installLiveRuntimeFixture(tick: number, bucket = 9_000): void {
  Game.time = tick;
  (Game as unknown as { cpu: { bucket: number } }).cpu = { bucket };
  (Game as unknown as { market: Partial<Market> }).market = {
    orders: {},
    getHistory: jest.fn(() => []),
    getAllOrders: jest.fn(() => []),
  };
  Memory.cfg = {
    marketSaleAutomation: {
      mode: "shadow",
      configRevision: "rev-1",
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 65 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 5_000 },
      creditReserve: 100_000,
      makerBatchAmount: 1_000,
    },
  };
  Memory.data = {
    marketSaleAutomation: {
      managedOrders: {},
      pendingMutations: {},
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
    },
  };
  Memory.runtime = {
    resourceControl: {
      updatedAt: tick,
      rooms: {
        W1N1: {
          capacityState: "normal",
        },
      },
      capacityPolicy: {
        receiverTerminalMinFreeCapacity: 50_000,
      },
      lastActions: [],
      lastMarketActions: [],
    },
    marketSaleAutomation: {
      updatedAt: tick,
      requestedMode: "shadow",
      phase: "shadow",
      configRevision: "rev-1",
      shadowConfigRevision: "rev-1",
      shadowConfigSignature: "qualified",
      shadowConsecutiveCycles: 50,
      zeroConfirmations: 0,
      managedOrderCount: 0,
      pendingCreateCount: 0,
      pendingMutationCount: 0,
      exposureAmount: 0,
      rollingFeeMilli: 0,
      terminalClaims: [],
      rejectedByReason: {},
      candidates: {},
      recentActions: [],
      safetyViolationCount: 0,
    },
  } as unknown as Memory["runtime"];
}

function installContinuousPricingCacheFixture(tick: number): void {
  installLiveRuntimeFixture(tick);
  Memory.cfg!.marketSaleAutomation = {
    mode: "direct",
    directCapability: "continuous-v2",
    configRevision: "market-direct-continuous-v2-r1",
    sellResources: [
      RESOURCE_CATALYST,
      RESOURCE_HYDROGEN,
      RESOURCE_ZYNTHIUM,
    ],
    hardFloor: {
      [RESOURCE_CATALYST]: 600,
      [RESOURCE_HYDROGEN]: 428,
      [RESOURCE_ZYNTHIUM]: 43,
    },
    economicFloor: {
      [RESOURCE_CATALYST]: 600,
      [RESOURCE_HYDROGEN]: 451,
      [RESOURCE_ZYNTHIUM]: 45,
    },
    forecastBuffer: {
      [RESOURCE_CATALYST]: 100_000,
      [RESOURCE_HYDROGEN]: 100_000,
      [RESOURCE_ZYNTHIUM]: 100_000,
    },
    minDealAmount: 1_000,
    makerBatchAmount: 5_000,
    creditReserve: 0,
    terminalEnergyReserve: 25_000,
    maxDirectDealAmount: 1_000,
    maxDirectDealsPerCycle: 1,
    minDirectOrderAmount: 1_000,
    minDirectOrderNotional: 600_000,
    maxDirectRawOrdersScannedPerCycle: 1_000,
    maxDirectEligibleOrdersPricedPerCycle: 200,
    maxDirectTransactionEnergy: 1_000,
    directCanaryMaxConfirmedDeals: 1,
    energyShadowHardFloor: 20,
    planningSnapshotMaxAgeTicks: 10,
    minHistoryDays: 7,
    minHistoryTransactions: 100,
    minHistoryVolume: 100_000,
    historyFloorRatio: 0.95,
    historyMaxAgeDays: 2,
    canary: {
      enabled: true,
      allowExpansion: false,
    },
  };
  Memory.runtime!.marketSaleAutomation!.phase = "direct";
}



function automationResult() {
  return {
    requestedMode: "shadow" as const,
    effectiveMode: "shadow" as const,
    phase: "shadow" as const,
    writes: 0,
    actions: [],
    rejectedByReason: {},
  };
}


function context(
  overrides: Partial<MarketSaleRuntimeCompositionContext> = {},
): MarketSaleRuntimeCompositionContext {
  return {
    currentTick: 100,
    resourceControlUpdatedAt: 100,
    capacityStateByRoom: { W1N1: "normal" },
    hubEnabled: true,
    hubRoomName: "W9N9",
    minimumTerminalFreeCapacity: 50_000,
    ...overrides,
  };
}

describe("market sale live composition", () => {
  beforeEach(() => {
    clearMarketSaleRuntimeCachesForTest();
    clearMarketActionArbiterForTest();
  });

  it("keeps stale ResourceControl and missing price evidence fail-closed", () => {
    const missingPricing: MarketSalePriceSnapshotCollection = {
      observedAt: 100,
      asOfDate: "2026-07-25",
      snapshots: {},
    };
    const [candidate] = composeMarketSalePlanCandidates(
      config(),
      protection(),
      missingPricing,
      context({ resourceControlUpdatedAt: 99 }),
    );

    expect(candidate.capacityState).toBeUndefined();
    expect(candidate.trustedPrice).toBe(false);
    expect(candidate.trustedDepth).toBe(false);
    expect(candidate.additionalRejectionReasons).toEqual(
      expect.arrayContaining([
        "pricing:snapshot_missing",
        "resource_control_cycle_stale",
      ]),
    );
  });

  it("Maker keeps its 100-tick pricing cache even when an inactive Continuous capability remains configured", () => {
    installContinuousPricingCacheFixture(100);
    Memory.cfg!.marketSaleAutomation!.mode = "maker";
    Memory.runtime!.marketSaleAutomation!.phase = "maker";
    const collectPricing = jest.fn(() => pricingAt(Game.time));
    const dependencies = {
      collectPricing: collectPricing as never,
      collectProtection: jest.fn(() => protectionAt(Game.time)) as never,
      runAutomation: jest.fn(() => automationResult()) as never,
    };

    runLiveMarketSaleAutomation(dependencies);
    Game.time = 199;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);
    // 市场规划分频（间隔 5 tick）：200 距上次 planning 周期（199）不足
    // 间隔，走 fast path 不触碰 pricing；204 的下一个 planning 周期才在
    // 100-tick 缓存过期后刷新。maker 缓存 TTL 语义本身不变。
    Game.time = 200;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);
    expect(collectPricing).toHaveBeenCalledTimes(1);
    Game.time = 204;
    (Memory.runtime!.resourceControl as { updatedAt: number }).updatedAt =
      Game.time;
    runLiveMarketSaleAutomation(dependencies);

    expect(collectPricing).toHaveBeenCalledTimes(2);
    expect(collectPricing.mock.results.map((result) => result.value.observedAt))
      .toEqual([100, 204]);

    // 非 planning tick 且无 exposure 待观测（quarantined-only 形态：
    // hasExposureState 为真但 exposureCandidates 为空）时跳过外层
    // protection 采集、runAutomation 收空 candidates；一旦出现
    // pendingDirectDeals 即恢复全量采集路径。
    (dependencies.collectProtection as jest.Mock).mockClear();
    Game.time = 201;
    const dataState = Memory.data!.marketSaleAutomation as unknown as {
      directAutomation?: Record<string, unknown>;
    };
    dataState.directAutomation = {
      capability: "market-direct-continuous",
      migrationStatus: "active",
      pendingDirectDeals: {},
      quarantinedPendingDirectDeals: {
        q1: { roomName: "W1N1", resource: RESOURCE_KEANIUM },
      },
      ledger: {},
    };
    runLiveMarketSaleAutomation(dependencies);
    expect(dependencies.collectProtection).not.toHaveBeenCalled();
    expect(dependencies.runAutomation).toHaveBeenLastCalledWith(
      expect.objectContaining({ candidates: [] }),
    );

    dataState.directAutomation!.pendingDirectDeals = {
      p1: { roomName: "W1N1", resource: RESOURCE_KEANIUM },
    };
    runLiveMarketSaleAutomation(dependencies);
    expect(dependencies.collectProtection).toHaveBeenCalledTimes(1);
  });
});
