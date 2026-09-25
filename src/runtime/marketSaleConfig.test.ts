import {
  directSafetyFingerprint,
  MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  resolveMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  MARKET_BASE_RESOURCE_CANONICAL_OPERATOR_AUTHORIZATION_FINGERPRINT,
  marketBaseResourceOperatorAuthorizationFingerprint,
} from "@/runtime/marketBaseResourceAutomation";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

describe("marketSaleConfig", () => {
  beforeEach(() => {
    Memory.cfg = {};
  });



  function validBaseResourceV3Raw(): Record<string, unknown> {
    return {
      mode: "direct",
      directCapability: "continuous-v3",
      configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
      sellResources: [
        RESOURCE_HYDROGEN,
        RESOURCE_OXYGEN,
        RESOURCE_UTRIUM,
        RESOURCE_LEMERGIUM,
        RESOURCE_KEANIUM,
        RESOURCE_ZYNTHIUM,
        RESOURCE_CATALYST,
      ],
      hardFloor: {
        [RESOURCE_HYDROGEN]: 428,
        [RESOURCE_OXYGEN]: 71,
        [RESOURCE_UTRIUM]: 31,
        [RESOURCE_LEMERGIUM]: 161,
        [RESOURCE_KEANIUM]: 33,
        [RESOURCE_ZYNTHIUM]: 43,
        [RESOURCE_CATALYST]: 371,
      },
      economicFloor: {
        [RESOURCE_HYDROGEN]: 451,
        [RESOURCE_OXYGEN]: 74,
        [RESOURCE_UTRIUM]: 32,
        [RESOURCE_LEMERGIUM]: 169,
        [RESOURCE_KEANIUM]: 34,
        [RESOURCE_ZYNTHIUM]: 45,
        [RESOURCE_CATALYST]: 390,
      },
      forecastBuffer: {
        [RESOURCE_HYDROGEN]: 100_000,
        [RESOURCE_OXYGEN]: 100_000,
        [RESOURCE_UTRIUM]: 100_000,
        [RESOURCE_LEMERGIUM]: 100_000,
        [RESOURCE_KEANIUM]: 100_000,
        [RESOURCE_ZYNTHIUM]: 100_000,
        [RESOURCE_CATALYST]: 100_000,
      },
      minDealAmount: 1_000,
      makerBatchAmount: 5_000,
      creditReserve: 0,
      terminalEnergyReserve: 25_000,
      maxDirectDealAmount: 1_000,
      maxDirectDealsPerCycle: 1,
      minDirectOrderAmount: 1_000,
      minDirectOrderNotional: 451_000,
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
    };
  }

  it("sellResources own every 不能篡改 exact gate 或碰撞 canonical 指纹", () => {
    const canonical = resolveMarketSaleAutomationConfig(
      validBaseResourceV3Raw(),
    );
    const config = {
      ...canonical,
      sellResources: [...canonical.sellResources],
      invalidReasons: [...canonical.invalidReasons],
    };
    const hostileEvery = jest.fn(() => {
      config.planningSnapshotMaxAgeTicks = 999_999;
      return true;
    });
    Object.defineProperty(config.sellResources, "every", {
      configurable: true,
      value: hostileEvery,
    });

    const direct = directSafetyFingerprint(config);

    expect(hostileEvery).not.toHaveBeenCalled();
    expect(config.planningSnapshotMaxAgeTicks).toBe(10);
    expect(direct).not.toBe(
      MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT,
    );
    expect(JSON.parse(direct!).mismatchReasons).toContain(
      "base_resource_v3_noncanonical_direct_input",
    );
    expect(marketBaseResourceOperatorAuthorizationFingerprint(config)).toBe(
      canonicalStableHashV1({
        domain: "market-base-resource:operator-authorization-v1",
        directSafetyFingerprint: direct,
      }),
    );
    expect(marketBaseResourceOperatorAuthorizationFingerprint(config)).not.toBe(
      MARKET_BASE_RESOURCE_CANONICAL_OPERATOR_AUTHORIZATION_FINGERPRINT,
    );
  });

  it("盘口偏离、ask 保护和历史成交量比例使用保守默认并限制危险输入", () => {
    const defaults = resolveMarketSaleAutomationConfig();
    expect(defaults.maxHistoryAskDeviationRatio).toBe(0.5);
    expect(defaults.makerAskFloorRatio).toBe(0.98);
    expect(defaults.makerHistoryVolumeRatio).toBe(0.1);
    expect(defaults.minReferenceOrderNotional).toBe(100);
    expect(defaults.minReferenceDistinctRooms).toBe(3);

    const clamped = resolveMarketSaleAutomationConfig({
      maxHistoryAskDeviationRatio: 99,
      makerAskFloorRatio: 0.1,
      makerHistoryVolumeRatio: 99,
      minReferenceOrderNotional: 0,
      minReferenceDistinctRooms: 1,
    });
    expect(clamped.maxHistoryAskDeviationRatio).toBe(2);
    expect(clamped.makerAskFloorRatio).toBe(0.9);
    expect(clamped.makerHistoryVolumeRatio).toBe(1);
    expect(clamped.minReferenceOrderNotional).toBe(0.001);
    expect(clamped.minReferenceDistinctRooms).toBe(2);

    const decimals = resolveMarketSaleAutomationConfig({
      directDiscountRatio: 0.95,
      historyFloorRatio: 0.9,
      maxHistoryAskDeviationRatio: 0.35,
      makerAskFloorRatio: 0.97,
      makerHistoryVolumeRatio: 0.2,
      minReferenceOrderNotional: 12.5,
    });
    expect(decimals.directDiscountRatio).toBe(0.95);
    expect(decimals.historyFloorRatio).toBe(0.9);
    expect(decimals.maxHistoryAskDeviationRatio).toBe(0.35);
    expect(decimals.makerAskFloorRatio).toBe(0.97);
    expect(decimals.makerHistoryVolumeRatio).toBe(0.2);
    expect(decimals.minReferenceOrderNotional).toBe(12.5);
  });
});
