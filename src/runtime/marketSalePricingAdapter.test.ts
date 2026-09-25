import { resolveMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import {
  collectMarketSalePriceSnapshots,
  type MarketSalePricingDataStore,
  type MarketSalePricingReadMarket,
} from "@/runtime/marketSalePricingAdapter";

const UTC_NOW = new Date("2026-07-26T12:00:00.000Z");

function config(overrides: Record<string, unknown> = {}) {
  return resolveMarketSaleAutomationConfig({
    mode: "shadow",
    configRevision: "pricing-adapter-test-v1",
    sellResources: [RESOURCE_KEANIUM],
    hardFloor: { [RESOURCE_KEANIUM]: 1 },
    economicFloor: { [RESOURCE_KEANIUM]: 0.9 },
    forecastBuffer: {
      [RESOURCE_KEANIUM]: 20_000,
      [RESOURCE_UTRIUM]: 20_000,
    },
    creditReserve: 1_000_000,
    energyShadowPrice: 0.2,
    makerBatchAmount: 1_000,
    minHistoryDays: 5,
    minHistoryTransactions: 1,
    minHistoryVolume: 1,
    historyFloorRatio: 1,
    historyMaxAgeDays: 2,
    minReferenceOrderAmount: 1_000,
    minReferenceOrderCount: 3,
    referenceDepthMultiplier: 3,
    ...overrides,
  });
}

function history(
  resource: MarketResourceConstant,
  price: number,
  dates: string[] = [
    "2026-07-20",
    "2026-07-21",
    "2026-07-22",
    "2026-07-23",
    "2026-07-24",
    "2026-07-25",
  ],
  volume = 10_000,
): PriceHistory[] {
  return dates.map((date) => ({
    resourceType: resource,
    date,
    transactions: 10,
    volume,
    avgPrice: price,
    stddevPrice: 0.01,
  }));
}

function orders(
  resource: MarketResourceConstant,
  price = 1.2,
): Order[] {
  return ["W1N1", "W2N2", "W3N3"].map(
    (roomName, index) =>
      ({
        id: `${resource}-sell-${index}`,
        created: index + 1,
        type: ORDER_SELL,
        resourceType: resource,
        roomName,
        amount: 1_000,
        remainingAmount: 1_000,
        totalAmount: 1_000,
        price,
      }) as Order,
  );
}

function readMarket(input: {
  historyPrice?: number | ((resource: MarketResourceConstant) => number);
  historyDates?: string[];
  historyVolume?: number;
  orderPrice?: number;
} = {}): {
  market: MarketSalePricingReadMarket;
  getHistory: jest.Mock<PriceHistory[], [MarketResourceConstant?]>;
  getAllOrders: jest.Mock<Order[], [OrderFilter?]>;
} {
  const getHistory = jest.fn(
    (resource: MarketResourceConstant = RESOURCE_ENERGY) => {
      const price =
        typeof input.historyPrice === "function"
          ? input.historyPrice(resource)
          : (input.historyPrice ?? 0.8);
      return history(
        resource,
        price,
        input.historyDates,
        input.historyVolume,
      );
    },
  );
  const getAllOrders = jest.fn((filter: OrderFilter = {}) =>
    orders(
      (filter.resourceType ?? RESOURCE_KEANIUM) as MarketResourceConstant,
      input.orderPrice,
    ),
  );
  return {
    market: {
      getHistory,
      getAllOrders,
      orders: {},
    },
    getHistory,
    getAllOrders,
  };
}

describe("collectMarketSalePriceSnapshots", () => {

  it("每周期对每个 unique resource 的 history 和 order book 最多读取一次", () => {
    const cfg = config({
      sellResources: [RESOURCE_KEANIUM, RESOURCE_UTRIUM],
      hardFloor: {
        [RESOURCE_KEANIUM]: 1,
        [RESOURCE_UTRIUM]: 0.8,
      },
      economicFloor: {
        [RESOURCE_KEANIUM]: 0.9,
        [RESOURCE_UTRIUM]: 0.7,
      },
    });
    const api = readMarket({
      historyPrice: (resource) =>
        resource === RESOURCE_KEANIUM ? 0.8 : 0.8,
    });

    const result = collectMarketSalePriceSnapshots(
      cfg,
      {},
      [
        RESOURCE_KEANIUM,
        { resource: RESOURCE_KEANIUM },
        RESOURCE_UTRIUM,
        { resource: RESOURCE_UTRIUM },
      ],
      { market: api.market, gameTime: 123, utcNow: UTC_NOW },
    );

    expect(api.getHistory).toHaveBeenCalledTimes(2);
    expect(api.getAllOrders).toHaveBeenCalledTimes(2);
    expect(
      api.getHistory.mock.calls.map(([resource]) => resource).sort(),
    ).toEqual([RESOURCE_KEANIUM, RESOURCE_UTRIUM].sort());
    expect(
      api.getAllOrders.mock.calls
        .map(([filter]) => filter?.resourceType)
        .sort(),
    ).toEqual([RESOURCE_KEANIUM, RESOURCE_UTRIUM].sort());
    expect(result.snapshots[RESOURCE_KEANIUM]?.trusted).toBe(true);
    expect(result.snapshots[RESOURCE_UTRIUM]?.trusted).toBe(true);
  });

  it("maker 最低安全价覆盖 hard/economic/history/ratchet 与向上取整后的 5% create fee", () => {
    const cfg = config();
    const api = readMarket({ historyPrice: 0.8 });
    api.getHistory.mockImplementation(
      (resource: MarketResourceConstant = RESOURCE_ENERGY) => [
        ...history(resource, 0.8),
        {
          resourceType: resource,
          date: "2026-07-26",
          transactions: 1_000,
          volume: 1_000_000,
          avgPrice: 0.001,
          stddevPrice: 0,
        },
      ],
    );
    const dataStore: MarketSalePricingDataStore = {};

    const result = collectMarketSalePriceSnapshots(
      cfg,
      dataStore,
      [{ resource: RESOURCE_KEANIUM, makerAmount: 1_000, feeDebtMilli: 0 }],
      { market: api.market, gameTime: 300, utcNow: UTC_NOW },
    );
    const snapshot = result.snapshots[RESOURCE_KEANIUM];

    expect(snapshot).toMatchObject({
      trusted: true,
      historyDate: "2026-07-25",
      historyFloor: 0.8,
      ratchetFloor: 0.8,
      effectiveNetFloor: 1,
      energyShadowPrice: 0.2,
      makerAmount: 1_000,
      trustedDailyVolume: 10_000,
      makerVolumeCap: 1_000,
      feeDebtMilli: 0,
      referenceSellAsk: 1.2,
      makerAskFloor: 1.176,
      makerPrice: 1.176,
      makerPriceResult: {
        safe: true,
        recommendedPrice: 1.176,
        evaluation: {
          prospectiveFeeMilli: 58_800,
          satisfiesInvariant: true,
        },
      },
    });
    expect(snapshot?.referenceSellBook?.trusted).toBe(true);

    // enforce 动态地板：options.dynamicFloorByResource 命中的资源以 df
    // 整体替代 {history, ratchet} 分量（简单加入 max 会被同源分量盖掉）；
    // 未命中资源保持 observe 四分量语义。
    const enforced = collectMarketSalePriceSnapshots(
      cfg,
      {},
      [{ resource: RESOURCE_KEANIUM, makerAmount: 1_000, feeDebtMilli: 0 }],
      {
        market: api.market,
        gameTime: 300,
        utcNow: UTC_NOW,
        dynamicFloorByResource: { [RESOURCE_KEANIUM]: 0.9 },
      },
    );
    expect(enforced.snapshots[RESOURCE_KEANIUM]).toMatchObject({
      historyFloor: 0.8,
      ratchetFloor: 0.8,
      // max(hard 1, economic, df 0.9) = 1（hard 仍兜底）；df 高于其余
      // 分量时主导。
      effectiveNetFloor: 1,
    });
    const dominant = collectMarketSalePriceSnapshots(
      cfg,
      {},
      [{ resource: RESOURCE_KEANIUM, makerAmount: 1_000, feeDebtMilli: 0 }],
      {
        market: api.market,
        gameTime: 300,
        utcNow: UTC_NOW,
        dynamicFloorByResource: { [RESOURCE_KEANIUM]: 1.4 },
      },
    );
    expect(dominant.snapshots[RESOURCE_KEANIUM]?.effectiveNetFloor).toBe(1.4);
  });

  it("历史窗口重分类旧日异常值时保留较新的缓存底价，缺失旧日仍拒绝", () => {
    const cfg = config();
    const api = readMarket();
    const recentOutlier = [
      ...history(RESOURCE_KEANIUM, 0.8).slice(0, 5),
      {
        ...history(RESOURCE_KEANIUM, 2)[5],
        avgPrice: 2,
      },
    ];
    api.getHistory.mockImplementation((resource: MarketResourceConstant = RESOURCE_ENERGY) =>
      resource === RESOURCE_KEANIUM
        ? recentOutlier
        : history(resource, 0.8),
    );
    const cached = {
      value: 1.5,
      marketDate: "2026-07-25",
      updatedAt: 200,
    };
    const dataStore: MarketSalePricingDataStore = {
      trustedFloors: { [RESOURCE_KEANIUM]: { ...cached } },
    };
    const result = collectMarketSalePriceSnapshots(
      cfg,
      dataStore,
      [{ resource: RESOURCE_KEANIUM, makerAmount: 1_000, feeDebtMilli: 0 }],
      { market: api.market, gameTime: 300, utcNow: UTC_NOW },
    );
    const snapshot = result.snapshots[RESOURCE_KEANIUM];
    expect(snapshot?.historyDate).toBe("2026-07-24");
    expect(snapshot?.ratchetFloor).toBe(1.5);
    expect(snapshot?.rejections.map((entry) => entry.reason)).not.toContain(
      "history_date_rollback",
    );
    expect(dataStore.trustedFloors?.[RESOURCE_KEANIUM]).toEqual(cached);

    api.getHistory.mockImplementation((resource: MarketResourceConstant = RESOURCE_ENERGY) =>
      history(resource, 0.8, [
        "2026-07-19", "2026-07-20", "2026-07-21",
        "2026-07-22", "2026-07-23", "2026-07-24",
      ]),
    );
    const missing = collectMarketSalePriceSnapshots(
      cfg,
      { trustedFloors: { [RESOURCE_KEANIUM]: { ...cached } } },
      [{ resource: RESOURCE_KEANIUM, makerAmount: 1_000, feeDebtMilli: 0 }],
      { market: api.market, gameTime: 301, utcNow: UTC_NOW },
    );
    expect(
      missing.snapshots[RESOURCE_KEANIUM]?.rejections.map((entry) => entry.reason),
    ).toContain("history_date_rollback");
  });
});
