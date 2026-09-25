import {
  acceptMarketBaseResourcePermit,
  acceptMarketDirectContinuousPermit,
  proposeMarketBaseResourcePermit,
  proposeMarketDirectContinuousPermit,
  resolveMarketSaleOrderDisappearance,
  runMarketSaleAutomation,
  runMarketSalePreflight,
} from "@/runtime/marketSaleAutomation";
import * as marketBaseResourceAutomationModule from "@/runtime/marketBaseResourceAutomation";
import {
  type MarketBaseResourceV3RuntimeState,
} from "@/runtime/marketBaseResourceAutomation";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_POLICIES,
} from "@/runtime/marketBaseResourcePolicy";
import {
  clearMarketActionArbiterForTest,
} from "@/runtime/marketActionArbiter";
import { createDirectAutomationState } from "@/runtime/marketSaleDirectAutomation";
import {
  LEGACY_X_V1_OUTCOME_GOLDEN,
  type MarketDirectContinuousAutomationState,
} from "@/runtime/marketDirectContinuousAutomation";

type MutableMarket = Partial<Market> & {
  orders: Record<string, Order>;
  credits: number;
  outgoingTransactions: Transaction[];
};

function installMarket(overrides: Partial<MutableMarket> = {}): MutableMarket {
  const market: MutableMarket = {
    orders: {},
    credits: 1_000_000,
    outgoingTransactions: [],
    incomingTransactions: [],
    createOrder: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    extendOrder: jest.fn(() => OK),
    changeOrderPrice: jest.fn(() => OK),
    deal: jest.fn(() => OK),
    getAllOrders: jest.fn(() => []),
    getHistory: jest.fn(() => []),
    calcTransactionCost: jest.fn(() => 0),
    ...overrides,
  };
  (Game as unknown as { market: MutableMarket }).market = market;
  return market;
}

function installRoom(
  roomName = "W1N1",
  resource: ResourceConstant = RESOURCE_KEANIUM,
): StructureTerminal {
  const amounts: Partial<Record<ResourceConstant, number>> = {
    [RESOURCE_ENERGY]: 100_000,
    [resource]: 20_000,
  };
  const terminal = {
    cooldown: 0,
    send: jest.fn(() => OK),
    store: {
      getUsedCapacity: (requested?: ResourceConstant) =>
        requested ? amounts[requested] || 0 : 120_000,
      getFreeCapacity: () => 180_000,
    },
  } as unknown as StructureTerminal;
  const room = {
    name: roomName,
    controller: { my: true },
    terminal,
    find: jest.fn(() => []),
  } as unknown as Room;
  (terminal as unknown as { room: Room }).room = room;
  Game.rooms[roomName] = room;
  return terminal;
}

function validConfig(
  mode: "off" | "shadow" | "maker" | "hybrid" | "emergencyStop",
  revision = "rev-1",
): void {
  Memory.cfg = {
    resourceControl: { market: { enabled: true } },
    factoryControl: { market: { enabled: true } },
    marketSaleAutomation: {
      mode,
      configRevision: revision,
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 1 },
      economicFloor: { [RESOURCE_KEANIUM]: 1.1 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 1_000 },
      minDealAmount: 100,
      maxDealAmount: 5_000,
      makerBatchAmount: 1_000,
      maxManagedOrders: 3,
      minFreeOrderSlots: 5,
      creditReserve: 10_000,
      rollingFeeBudget: 1_000_000,
      feeWindowTicks: 20_000,
      terminalEnergyReserve: 25_000,
      orderPolicyTtl: 20_000,
      mutationBackoffTicks: 10,
      canary: { enabled: true, allowExpansion: false },
    },
  };
}

function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    created: Game.time,
    type: ORDER_SELL,
    resourceType: RESOURCE_KEANIUM,
    roomName: "W1N1",
    price: 2,
    totalAmount: 1_000,
    remainingAmount: 1_000,
    amount: 1_000,
    active: true,
    ...overrides,
  } as Order;
}





function installManagedOrder(orderId: string): void {
  const managed = managedOrderState(orderId);
  (Memory as unknown as { data: unknown }).data = {
    marketSaleAutomation: {
      managedOrders: {
        [orderId]: managed,
      },
      pendingMutations: {},
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
      drain: { phase: "maker", zeroConfirmations: 0 },
    },
  };
}

function managedOrderState(
  orderId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orderId,
    roomName: "W1N1",
    resourceType: RESOURCE_KEANIUM,
    price: 2,
    originalAmount: 1_000,
    lastRemainingAmount: 1_000,
    remainingExposure: 1_000,
    feeDebtMilli: 100_000,
    createdAt: Game.time - 10,
    lastSeenAt: Game.time - 1,
    policyCancelAtTick: Game.time + 1_000,
    serverCreatedTick: Game.time - 10,
    ...overrides,
  };
}


function installContinuousDirectConfig(): void {
  Memory.cfg = {
    resourceControl: { market: { enabled: true } },
    factoryControl: { market: { enabled: true } },
    marketSaleAutomation: {
      mode: "direct",
      directCapability: "continuous-v2",
      configRevision: "market-direct-continuous-v2-r1",
      sellResources: [RESOURCE_CATALYST, RESOURCE_HYDROGEN, RESOURCE_ZYNTHIUM],
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
      canary: { enabled: true, allowExpansion: false },
    },
  };
}

function installMarketBaseV3DirectConfig(): void {
  Memory.cfg = {
    resourceControl: {
      market: { enabled: true },
    },
    factoryControl: {
      market: { enabled: true },
    },
    marketSaleAutomation: {
      mode: "direct",
      directCapability: "continuous-v3",
      configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
      sellResources: [...MARKET_BASE_RESOURCE_CATALOG],
      hardFloor: Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          policy.hardFloor,
        ]),
      ),
      economicFloor: Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          policy.economicFloor,
        ]),
      ),
      forecastBuffer: Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          policy.laneReserve,
        ]),
      ),
      minDealAmount: 1_000,
      makerBatchAmount: 5_000,
      creditReserve: 0,
      terminalEnergyReserve: 25_000,
      maxDirectDealAmount: 1_000,
      maxDirectDealsPerCycle: 1,
      minDirectOrderAmount: 1_000,
      minDirectOrderNotional: Math.max(
        ...MARKET_BASE_RESOURCE_POLICIES.map((policy) => policy.minOrderNotional),
      ),
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
    },
  };
}

function installExactReviewedLegacyDirectState(): void {
  const direct = createDirectAutomationState();
  direct.directDealOutcomes = [
    JSON.parse(JSON.stringify(LEGACY_X_V1_OUTCOME_GOLDEN)),
  ];
  direct.processedDirectTransactionKeys = [
    LEGACY_X_V1_OUTCOME_GOLDEN.evidenceKey!,
  ];
  direct.directConfirmedDealCount = 1;
  direct.directPausedForReview = true;
  Memory.data = {
    marketSaleAutomation: {
      directAutomation: direct,
      pendingDirectDeals: direct.pendingDirectDeals,
    },
  } as Memory["data"];
}

function proposeMarketBaseV3CutoverFixture(): string {
  installContinuousDirectConfig();
  installExactReviewedLegacyDirectState();
  const catalystTerminal = installRoom("E6N59", RESOURCE_CATALYST);
  for (const roomName of ["W1N1", "E6N59"]) {
    (
      Game.rooms[roomName].terminal as StructureTerminal & {
        id: Id<StructureTerminal>;
        my: boolean;
      }
    ).id = (
      roomName === "W1N1"
        ? "aaaaaaaaaaaaaaaaaaaaaaaa"
        : "bbbbbbbbbbbbbbbbbbbbbbbb"
    ) as Id<StructureTerminal>;
    (
      Game.rooms[roomName].terminal as StructureTerminal & {
        my: boolean;
      }
    ).my = true;
    (
      Game.rooms[roomName].controller as StructureController & {
        owner?: Owner;
      }
    ).owner = {
      username: "forst",
    };
    (
      Game.rooms[roomName].terminal as StructureTerminal & {
        owner?: Owner;
      }
    ).owner = {
      username: "forst",
    };
  }
  (
    catalystTerminal as StructureTerminal & {
      owner?: Owner;
    }
  ).owner = {
    username: "forst",
  };
  (
    Game as unknown as {
      shard: {
        name: string;
        type: string;
        ptr: boolean;
      };
    }
  ).shard = {
    name: "shard1",
    type: "normal",
    ptr: false,
  };
  runMarketSalePreflight();
  const v2Proposal = proposeMarketDirectContinuousPermit({
    operatorAuthorizationFingerprint: "operator:codex:v3-activation-fixture",
  }) as {
    ok: boolean;
    permit?: { permitId: string };
  };
  expect(v2Proposal.ok).toBe(true);
  expect(
    acceptMarketDirectContinuousPermit(v2Proposal.permit!.permitId),
  ).toMatchObject({ ok: true });
  Game.time += 1;
  expect(runMarketSalePreflight().phase).toBe("direct");
  installMarketBaseV3DirectConfig();
  const v3Proposal = proposeMarketBaseResourcePermit() as {
    ok: boolean;
    proposalId?: string;
  };
  expect(v3Proposal.ok).toBe(true);
  return v3Proposal.proposalId!;
}























describe("marketSaleAutomation 编排", () => {
  beforeEach(() => {
    clearMarketActionArbiterForTest();
    installMarket();
    installRoom();
    (
      Game as unknown as {
        cpu: {
          getUsed: jest.Mock<number, []>;
        };
      }
    ).cpu = {
      getUsed: jest.fn(() => 0),
    };
    Game.time = 100;
  });

  it("unknown disappearance 只能由 exact-ID operator 分类收敛，server expiry 必须核验退款", () => {
    validConfig("maker");
    const market = installMarket({
      orders: {
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");

    runMarketSalePreflight();

    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed.disappearanceGap,
    ).toMatchObject({ reason: "unknown_disappearance" });
    expect(
      (resolveMarketSaleOrderDisappearance as any)("managed", "unknown"),
    ).toMatchObject({
      ok: false,
      error: "disappearance_classification_invalid",
    });
    expect(
      resolveMarketSaleOrderDisappearance("managed", "server_expired"),
    ).toMatchObject({
      ok: false,
      error: "verified_refund_milli_required",
    });
    expect(
      resolveMarketSaleOrderDisappearance("managed", "server_expired", 40_000),
    ).toMatchObject({
      ok: true,
      refundedFeeDebtMilli: 40_000,
      carriedFeeDebtMilli: 60_000,
    });
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[RESOURCE_KEANIUM],
    ).toBe(60_000);
    expect(market.orders.manual).toBeDefined();
  });

  it("首个 V3 proposal 跨 tick pending 时始终 pin V2 dispatcher，accept 后才 cutover", () => {
    const proposalId = proposeMarketBaseV3CutoverFixture();
    const proposed = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationAnchor?: unknown;
      baseResourceV3ActivationAnchorMirror?: unknown;
      directAutomation: MarketDirectContinuousAutomationState & {
        baseResourceV3?: MarketBaseResourceV3RuntimeState;
      };
    };
    const legacyPermitId = proposed.directAutomation.currentPermit?.permitId;
    expect(legacyPermitId).toBeTruthy();
    expect(proposed.baseResourceV3ActivationAnchor).toBeUndefined();
    expect(proposed.baseResourceV3ActivationAnchorMirror).toBeUndefined();
    expect(
      proposed.directAutomation.baseResourceV3?.proposedPermit?.proposalId,
    ).toBe(proposalId);

    const pendingSpy = jest.spyOn(
      marketBaseResourceAutomationModule,
      "runMarketBaseResourceAutomation",
    );
    Game.time += 1;
    runMarketSaleAutomation({ candidates: [] });
    expect(pendingSpy).not.toHaveBeenCalled();
    pendingSpy.mockRestore();
    const stillPending = Memory.data!.marketSaleAutomation as unknown as {
      baseResourceV3ActivationAnchor?: unknown;
      directAutomation: MarketDirectContinuousAutomationState & {
        baseResourceV3?: MarketBaseResourceV3RuntimeState;
      };
    };
    expect(stillPending.directAutomation.currentPermit?.permitId).toBe(
      legacyPermitId,
    );
    expect(
      stillPending.directAutomation.baseResourceV3?.proposedPermit?.proposalId,
    ).toBe(proposalId);
    expect(stillPending.baseResourceV3ActivationAnchor).toBeUndefined();

    expect(acceptMarketBaseResourcePermit(proposalId)).toMatchObject({
      ok: true,
    });
    const activeSpy = jest.spyOn(
      marketBaseResourceAutomationModule,
      "runMarketBaseResourceAutomation",
    );
    Game.time += 1;
    runMarketSaleAutomation({ candidates: [] });
    expect(activeSpy).toHaveBeenCalledTimes(1);
    activeSpy.mockRestore();
    expect(
      (
        Memory.data!.marketSaleAutomation as unknown as {
          baseResourceV3ActivationAnchor?: {
            anchorHash: string;
          };
        }
      ).baseResourceV3ActivationAnchor?.anchorHash,
    ).toBeTruthy();
  });
});
