import type { MarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import {
  advanceTrustedFloor,
  assessOrderBookDepth,
  buildTrustedHistoryFloor,
  computeEffectiveNetFloor,
  computeEnergyShadowPrice,
  evaluatePostActionInvariant,
  findMinimumSafePrice,
  roomBalancedMedianPrice,
  roundMarketPriceUp,
  type MarketHistoryDay,
  type MarketOrderSnapshot,
  type MilliCredits,
  type MinimumSafePriceResult,
  type OrderBookDepthAssessment,
  type TrustedHistoryResult,
} from "@/runtime/marketSalePricing";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface MarketSaleTrustedFloorCacheEntry {
  /** 已受每日最大跌幅约束的可信底价。 */
  value: number;
  /** 产生该状态的最后一个完整外部市场日。 */
  marketDate: string;
  /** 最后一次状态变化时的 Screeps tick。 */
  updatedAt: number;
}

export interface MarketSalePricingDataStore {
  trustedFloors?: Partial<
    Record<ResourceConstant, MarketSaleTrustedFloorCacheEntry>
  >;
  carriedFeeDebtMilli?: Partial<Record<ResourceConstant, MilliCredits>>;
}

export interface MarketSalePriceCandidate {
  resource: ResourceConstant;
  makerAmount?: number;
  feeDebtMilli?: MilliCredits;
}

export type MarketSalePriceCandidateInput =
  | ResourceConstant
  | MarketSalePriceCandidate;

export type MarketSalePriceRejectionReason =
  | "candidate_invalid"
  | "candidate_conflict"
  | "config_invalid"
  | "resource_not_allowlisted"
  | "hard_floor_missing_or_invalid"
  | "history_api_unavailable"
  | "history_fetch_failed"
  | "history_untrusted"
  | "history_stale"
  | "history_date_rollback"
  | "trusted_floor_cache_invalid"
  | "trusted_floor_cache_write_failed"
  | "effective_floor_invalid"
  | "order_book_api_unavailable"
  | "order_book_fetch_failed"
  | "reference_order_book_untrusted"
  | "history_ask_divergence"
  | "energy_shadow_unavailable"
  | "maker_amount_invalid"
  | "maker_volume_cap_unavailable"
  | "maker_amount_exceeds_history_volume_cap"
  | "fee_debt_invalid"
  | "maker_price_unavailable";

export interface MarketSalePriceRejection {
  reason: MarketSalePriceRejectionReason;
  detail?: string;
}

export interface MarketSalePriceSnapshot {
  resource: ResourceConstant;
  observedAt: number;
  asOfDate: string;
  trusted: boolean;
  rejectedReason?: MarketSalePriceRejectionReason;
  rejections: MarketSalePriceRejection[];
  historyDate?: string;
  historyAgeDays?: number;
  historyResult?: TrustedHistoryResult;
  historyFloor?: number;
  ratchetFloor?: number;
  effectiveNetFloor?: number;
  energyShadowPrice?: number;
  referenceSellBook?: OrderBookDepthAssessment;
  /** 通过尘埃和深度过滤后的 sell ask 稳健中位数。 */
  referenceSellAsk?: number;
  /** 历史参考价与稳健 ask 的对称相对偏离。 */
  historyAskDeviationRatio?: number;
  /** maker 报价的实时 ask 下界。 */
  makerAskFloor?: number;
  directBuyBook?: OrderBookDepthAssessment;
  ownOrdersExcluded?: number;
  /** 被历史异常过滤接受的完整日中，最小的日成交量。 */
  trustedDailyVolume?: number;
  /** 配置比例换算后的单批成交量上限。 */
  makerVolumeCap?: number;
  makerAmount?: number;
  feeDebtMilli?: MilliCredits;
  makerPrice?: number;
  makerPriceResult?: MinimumSafePriceResult;
}

export interface MarketSalePriceSnapshotCollection {
  observedAt: number;
  asOfDate: string;
  energyShadowPrice?: number;
  energyHistoryDate?: string;
  /** Direct 使用的完整能源影子价证据；Maker 不依赖该字段。 */
  energyShadowEvidence?: {
    trusted: boolean;
    observedAt: number;
    hardFloor: number;
    explicit?: number;
    historyFloor?: number;
    ratchetFloor?: number;
    effective?: number;
    rejectionReason?: string;
  };
  snapshots: Partial<Record<ResourceConstant, MarketSalePriceSnapshot>>;
}

/**
 * 只暴露定价采样所需的只读 Market 表面，避免 adapter 获得任何市场写能力。
 */
export interface MarketSalePricingReadMarket {
  getHistory?: (resource?: MarketResourceConstant) => PriceHistory[];
  getAllOrders?: (
    filter?: OrderFilter | ((order: Order) => boolean),
  ) => Order[];
  orders?: Record<string, Order>;
}

export interface CollectMarketSalePriceSnapshotsOptions {
  market?: MarketSalePricingReadMarket;
  gameTime?: number;
  utcNow?: Date;
  /** V3 activation anchor 使用不可回退高水位；日期可推进，floor 不得下降。 */
  nondecreasingTrustedFloors?: boolean;
  /**
   * enforce 动态地板（资源 → 生效地板）：命中的资源以该值整体替代
   * effectiveNetFloor 的 {history, ratchet} 分量；缺席资源保持 observe
   * 四分量语义。由 baseResourceV3 侧从 dynamicFloorProjection 构建。
   */
  dynamicFloorByResource?: Readonly<
    Partial<Record<ResourceConstant, number>>
  >;
}

interface ResolvedCandidate {
  resource: ResourceConstant;
  makerAmount: number;
  feeDebtMilli: MilliCredits;
  conflict: boolean;
}

type CachedHistoryFetch =
  | {
      ok: true;
      days: MarketHistoryDay[];
    }
  | {
      ok: false;
      reason: "history_api_unavailable" | "history_fetch_failed";
      detail?: string;
    };

type CachedOrderFetch =
  | {
      ok: true;
      orders: MarketOrderSnapshot[];
      ownOrdersExcluded: number;
    }
  | {
      ok: false;
      reason: "order_book_api_unavailable" | "order_book_fetch_failed";
      detail?: string;
    };

interface FreshHistoryResult {
  result: TrustedHistoryResult;
  historyDate: string;
  historyAgeDays: number;
  trustedDailyVolume: number;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
  );
}

function utcDateOf(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("utcNow must be a valid Date");
  }
  return date.toISOString().slice(0, 10);
}

function utcDayNumber(date: string): number {
  if (!isIsoDate(date)) {
    throw new RangeError(`invalid UTC date: ${date}`);
  }
  return Math.floor(
    Date.parse(`${date}T00:00:00.000Z`) / MILLISECONDS_PER_DAY,
  );
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addRejection(
  rejections: MarketSalePriceRejection[],
  reason: MarketSalePriceRejectionReason,
  detail?: string,
): void {
  if (
    rejections.some(
      (entry) => entry.reason === reason && entry.detail === detail,
    )
  ) {
    return;
  }
  rejections.push(detail === undefined ? { reason } : { reason, detail });
}

function convertHistoryDay(value: unknown): MarketHistoryDay {
  const raw =
    value && typeof value === "object"
      ? (value as Partial<PriceHistory>)
      : {};
  return {
    resourceType:
      typeof raw.resourceType === "string" ? raw.resourceType : undefined,
    date: typeof raw.date === "string" ? raw.date : "",
    transactions:
      typeof raw.transactions === "number" ? raw.transactions : Number.NaN,
    volume: typeof raw.volume === "number" ? raw.volume : Number.NaN,
    avgPrice:
      typeof raw.avgPrice === "number" ? raw.avgPrice : Number.NaN,
    stddevPrice:
      typeof raw.stddevPrice === "number" ? raw.stddevPrice : undefined,
  };
}

function convertOrder(value: unknown): MarketOrderSnapshot {
  const raw =
    value && typeof value === "object" ? (value as Partial<Order>) : {};
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type:
      raw.type === ORDER_BUY || raw.type === ORDER_SELL
        ? raw.type
        : ("" as "buy"),
    resourceType:
      typeof raw.resourceType === "string" ? raw.resourceType : "",
    price: typeof raw.price === "number" ? raw.price : Number.NaN,
    amount:
      typeof raw.amount === "number"
        ? raw.amount
        : typeof raw.remainingAmount === "number"
          ? raw.remainingAmount
          : Number.NaN,
    roomName:
      typeof raw.roomName === "string" ? raw.roomName : undefined,
    created: typeof raw.created === "number" ? raw.created : undefined,
  };
}

function resolveReadMarket(
  options: CollectMarketSalePriceSnapshotsOptions,
): MarketSalePricingReadMarket | undefined {
  if (options.market) return options.market;
  if (
    typeof Game !== "undefined" &&
    Game.market &&
    typeof Game.market === "object"
  ) {
    return Game.market;
  }
  return undefined;
}

function resolveGameTime(
  options: CollectMarketSalePriceSnapshotsOptions,
): number {
  if (nonNegativeSafeInteger(options.gameTime)) return options.gameTime;
  if (
    typeof Game !== "undefined" &&
    nonNegativeSafeInteger(Game.time)
  ) {
    return Game.time;
  }
  return 0;
}

function resolveCandidates(
  config: MarketSaleAutomationConfig,
  dataStore: MarketSalePricingDataStore,
  candidates: readonly MarketSalePriceCandidateInput[],
): ResolvedCandidate[] {
  const byResource = new Map<ResourceConstant, ResolvedCandidate>();
  for (const input of candidates) {
    const candidate =
      typeof input === "string"
        ? { resource: input as ResourceConstant }
        : input;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.resource !== "string"
    ) {
      continue;
    }
    const makerAmount = candidate.makerAmount ?? config.makerBatchAmount;
    const feeDebtMilli =
      candidate.feeDebtMilli ??
      dataStore.carriedFeeDebtMilli?.[candidate.resource] ??
      0;
    const resolved: ResolvedCandidate = {
      resource: candidate.resource,
      makerAmount,
      feeDebtMilli,
      conflict: false,
    };
    const existing = byResource.get(candidate.resource);
    if (!existing) {
      byResource.set(candidate.resource, resolved);
      continue;
    }
    if (
      existing.makerAmount !== resolved.makerAmount ||
      existing.feeDebtMilli !== resolved.feeDebtMilli
    ) {
      existing.conflict = true;
    }
  }
  return [...byResource.values()];
}

function validateCachedFloor(
  entry: MarketSaleTrustedFloorCacheEntry,
): boolean {
  return (
    finitePositive(entry.value) &&
    isIsoDate(entry.marketDate) &&
    nonNegativeSafeInteger(entry.updatedAt)
  );
}

/**
 * 将只读 Screeps 市场数据转换为每资源一份可执行前检查的可信定价快照。
 *
 * 函数只会更新 `dataStore.trustedFloors`；不会调用 deal/createOrder/
 * extendOrder/changeOrderPrice/cancelOrder 等任何市场写 API。
 */
export function collectMarketSalePriceSnapshots(
  config: MarketSaleAutomationConfig,
  dataStore: MarketSalePricingDataStore,
  candidates: readonly MarketSalePriceCandidateInput[],
  options: CollectMarketSalePriceSnapshotsOptions = {},
): MarketSalePriceSnapshotCollection {
  const observedAt = resolveGameTime(options);
  const asOfDate = utcDateOf(options.utcNow ?? new Date());
  const market = resolveReadMarket(options);
  const historyFetches = new Map<ResourceConstant, CachedHistoryFetch>();
  const orderFetches = new Map<ResourceConstant, CachedOrderFetch>();

  const getHistoryOnce = (resource: ResourceConstant): CachedHistoryFetch => {
    const cached = historyFetches.get(resource);
    if (cached) return cached;
    if (!market || typeof market.getHistory !== "function") {
      const unavailable: CachedHistoryFetch = {
        ok: false,
        reason: "history_api_unavailable",
      };
      historyFetches.set(resource, unavailable);
      return unavailable;
    }
    try {
      const raw = market.getHistory(resource as MarketResourceConstant);
      if (!Array.isArray(raw)) {
        throw new TypeError("Game.market.getHistory did not return an array");
      }
      const fetched: CachedHistoryFetch = {
        ok: true,
        days: raw.map(convertHistoryDay),
      };
      historyFetches.set(resource, fetched);
      return fetched;
    } catch (error) {
      const failed: CachedHistoryFetch = {
        ok: false,
        reason: "history_fetch_failed",
        detail: detailOf(error),
      };
      historyFetches.set(resource, failed);
      return failed;
    }
  };

  const getOrdersOnce = (resource: ResourceConstant): CachedOrderFetch => {
    const cached = orderFetches.get(resource);
    if (cached) return cached;
    if (!market || typeof market.getAllOrders !== "function") {
      const unavailable: CachedOrderFetch = {
        ok: false,
        reason: "order_book_api_unavailable",
      };
      orderFetches.set(resource, unavailable);
      return unavailable;
    }
    try {
      const raw = market.getAllOrders({
        resourceType: resource as MarketResourceConstant,
      });
      if (!Array.isArray(raw)) {
        throw new TypeError("Game.market.getAllOrders did not return an array");
      }
      const ownOrderIds = new Set(Object.keys(market.orders ?? {}));
      const externalOrders = raw.filter(
        (order) =>
          !order ||
          typeof order !== "object" ||
          typeof order.id !== "string" ||
          !ownOrderIds.has(order.id),
      );
      const fetched: CachedOrderFetch = {
        ok: true,
        orders: externalOrders.map(convertOrder),
        ownOrdersExcluded: raw.length - externalOrders.length,
      };
      orderFetches.set(resource, fetched);
      return fetched;
    } catch (error) {
      const failed: CachedOrderFetch = {
        ok: false,
        reason: "order_book_fetch_failed",
        detail: detailOf(error),
      };
      orderFetches.set(resource, failed);
      return failed;
    }
  };

  const buildFreshHistory = (
    resource: ResourceConstant,
    historyFloorRatio: number,
  ):
    | { ok: true; value: FreshHistoryResult }
    | {
        ok: false;
        reason:
          | "history_api_unavailable"
          | "history_fetch_failed"
          | "history_untrusted"
          | "history_stale";
        detail?: string;
        result?: TrustedHistoryResult;
      } => {
    const fetched = getHistoryOnce(resource);
    if (fetched.ok === false) {
      return {
        ok: false,
        reason: fetched.reason,
        detail: fetched.detail,
      };
    }
    try {
      const result = buildTrustedHistoryFloor(fetched.days, {
        asOfDate,
        resourceType: resource,
        minValidDays: config.minHistoryDays,
        minTransactionsPerDay: config.minHistoryTransactions,
        minVolumePerDay: config.minHistoryVolume,
        historyFloorRatio,
      });
      if (
        !result.trusted ||
        !result.latestHistoryDate ||
        !finitePositive(result.trustedFloor)
      ) {
        return {
          ok: false,
          reason: "history_untrusted",
          detail: result.reason,
          result,
        };
      }
      const historyAgeDays =
        utcDayNumber(asOfDate) - utcDayNumber(result.latestHistoryDate);
      if (
        historyAgeDays <= 0 ||
        historyAgeDays > config.historyMaxAgeDays
      ) {
        return {
          ok: false,
          reason: "history_stale",
          detail: `latest=${result.latestHistoryDate},ageDays=${historyAgeDays}`,
          result,
        };
      }
      const acceptedDates = new Set(result.acceptedDates);
      const acceptedVolumes = fetched.days
        .filter(
          (day) =>
            day.resourceType === resource &&
            acceptedDates.has(day.date) &&
            finitePositive(day.volume),
        )
        .map((day) => day.volume);
      const trustedDailyVolume =
        acceptedVolumes.length === result.acceptedDayCount
          ? Math.min(...acceptedVolumes)
          : Number.NaN;
      if (!finitePositive(trustedDailyVolume)) {
        return {
          ok: false,
          reason: "history_untrusted",
          detail: "trusted daily volume unavailable",
          result,
        };
      }
      return {
        ok: true,
        value: {
          result,
          historyDate: result.latestHistoryDate,
          historyAgeDays,
          trustedDailyVolume,
        },
      };
    } catch (error) {
      return {
        ok: false,
        reason: "history_untrusted",
        detail: detailOf(error),
      };
    }
  };

  const resolvedCandidates = resolveCandidates(config, dataStore, candidates);
  const hasStaticEligibleCandidate =
    config.validForPlanning &&
    resolvedCandidates.some(
      (candidate) =>
        !candidate.conflict &&
        config.sellResources.includes(candidate.resource) &&
        finitePositive(config.hardFloor[candidate.resource]) &&
        positiveSafeInteger(candidate.makerAmount) &&
        nonNegativeSafeInteger(candidate.feeDebtMilli),
    );

  let energyShadowPrice: number | undefined;
  let energyHistoryDate: string | undefined;
  let energyFailureDetail: string | undefined;
  let energyShadowEvidence:
    | MarketSalePriceSnapshotCollection["energyShadowEvidence"]
    | undefined;
  const usesDirectStrategy =
    config.mode === "direct" ||
    (config.mode === "shadow" && config.shadowStrategy === "direct");
  if (hasStaticEligibleCandidate && usesDirectStrategy) {
    const hardFloor = config.energyShadowHardFloor ?? 20;
    const energyHistory = buildFreshHistory(RESOURCE_ENERGY, 1);
    if (
      energyHistory.ok &&
      finitePositive(energyHistory.value.result.trustedFloor)
    ) {
      energyHistoryDate = energyHistory.value.historyDate;
      const historyFloor = energyHistory.value.result.trustedFloor!;
      let ratchetFloor: number | undefined;
      const previousEntry = dataStore.trustedFloors?.[RESOURCE_ENERGY];
      if (previousEntry && !validateCachedFloor(previousEntry)) {
        energyFailureDetail = "trusted_floor_cache_invalid";
      } else {
        try {
          const advanced = advanceTrustedFloor(
            previousEntry
              ? {
                  historyDate: previousEntry.marketDate,
                  floor: previousEntry.value,
                  observedFloor: previousEntry.value,
                }
              : undefined,
            {
              historyDate: energyHistory.value.historyDate,
              floor: historyFloor,
            },
            { maxDailyDropRatio: 0.05 },
          );
          if (advanced.reason === "older_history_day") {
            energyFailureDetail = "history_date_rollback";
          } else {
            ratchetFloor =
              options.nondecreasingTrustedFloors && previousEntry
                ? Math.max(previousEntry.value, advanced.state.floor)
                : advanced.state.floor;
            if (!dataStore.trustedFloors) dataStore.trustedFloors = {};
            dataStore.trustedFloors[RESOURCE_ENERGY] = {
              value: ratchetFloor,
              marketDate: advanced.state.historyDate,
              updatedAt: observedAt,
            };
          }
        } catch (error) {
          energyFailureDetail = `trusted_floor_cache_invalid:${detailOf(error)}`;
        }
      }
      if (!energyFailureDetail && finitePositive(ratchetFloor)) {
        const shadow = computeEnergyShadowPrice({
          hardFloor,
          economicFloor: config.energyShadowPrice,
          historyFloor,
          ratchetFloor,
        });
        energyShadowPrice = shadow.valid ? shadow.price : undefined;
        if (!energyShadowPrice) {
          energyFailureDetail = shadow.reason || "component_invalid";
        }
        energyShadowEvidence = {
          trusted: shadow.valid && finitePositive(shadow.price),
          observedAt,
          hardFloor,
          explicit: config.energyShadowPrice,
          historyFloor,
          ratchetFloor,
          effective: shadow.price,
          rejectionReason: shadow.valid
            ? undefined
            : shadow.reason || "component_invalid",
        };
      }
    } else if (energyHistory.ok === false) {
      energyFailureDetail = `${energyHistory.reason}${
        energyHistory.detail ? `:${energyHistory.detail}` : ""
      }`;
    }
    if (!energyShadowEvidence) {
      energyShadowEvidence = {
        trusted: false,
        observedAt,
        hardFloor,
        explicit: config.energyShadowPrice,
        rejectionReason: energyFailureDetail || "energy_shadow_unavailable",
      };
    }
  } else if (
    hasStaticEligibleCandidate &&
    finitePositive(config.energyShadowPrice)
  ) {
    const shadow = computeEnergyShadowPrice({
      hardFloor: config.energyShadowPrice,
    });
    energyShadowPrice = shadow.valid ? shadow.price : undefined;
  } else if (hasStaticEligibleCandidate) {
    const energyHistory = buildFreshHistory(RESOURCE_ENERGY, 1);
    if (
      energyHistory.ok &&
      finitePositive(energyHistory.value.result.referencePrice)
    ) {
      const shadow = computeEnergyShadowPrice({
        hardFloor: energyHistory.value.result.referencePrice,
      });
      energyShadowPrice = shadow.valid ? shadow.price : undefined;
      energyHistoryDate = energyHistory.value.historyDate;
    } else if (energyHistory.ok === false) {
      energyFailureDetail = `${energyHistory.reason}${
        energyHistory.detail ? `:${energyHistory.detail}` : ""
      }`;
    }
  }

  const snapshots: Partial<
    Record<ResourceConstant, MarketSalePriceSnapshot>
  > = {};
  for (const candidate of resolvedCandidates) {
    const rejections: MarketSalePriceRejection[] = [];
    const snapshot: MarketSalePriceSnapshot = {
      resource: candidate.resource,
      observedAt,
      asOfDate,
      trusted: false,
      rejections,
      makerAmount: candidate.makerAmount,
      feeDebtMilli: candidate.feeDebtMilli,
    };
    snapshots[candidate.resource] = snapshot;

    if (candidate.conflict) {
      addRejection(rejections, "candidate_conflict");
    }
    if (!config.validForPlanning) {
      addRejection(
        rejections,
        "config_invalid",
        config.invalidReasons.join(",") || undefined,
      );
    }
    if (!config.sellResources.includes(candidate.resource)) {
      addRejection(rejections, "resource_not_allowlisted");
    }
    const hardFloor = config.hardFloor[candidate.resource];
    if (!finitePositive(hardFloor)) {
      addRejection(rejections, "hard_floor_missing_or_invalid");
    }
    if (!positiveSafeInteger(candidate.makerAmount)) {
      addRejection(rejections, "maker_amount_invalid");
    }
    if (!nonNegativeSafeInteger(candidate.feeDebtMilli)) {
      addRejection(rejections, "fee_debt_invalid");
    }
    if (
      rejections.some((entry) =>
        [
          "candidate_conflict",
          "config_invalid",
          "resource_not_allowlisted",
          "hard_floor_missing_or_invalid",
          "maker_amount_invalid",
          "fee_debt_invalid",
        ].includes(entry.reason),
      )
    ) {
      snapshot.rejectedReason = rejections[0]?.reason;
      continue;
    }

    if (!finitePositive(energyShadowPrice)) {
      addRejection(
        rejections,
        "energy_shadow_unavailable",
        energyFailureDetail,
      );
    } else {
      snapshot.energyShadowPrice = energyShadowPrice;
    }

    const freshHistory = buildFreshHistory(
      candidate.resource,
      config.historyFloorRatio,
    );
    if (freshHistory.ok === false) {
      addRejection(
        rejections,
        freshHistory.reason,
        freshHistory.detail,
      );
      snapshot.historyResult = freshHistory.result;
    } else {
      snapshot.historyResult = freshHistory.value.result;
      snapshot.historyDate = freshHistory.value.historyDate;
      snapshot.historyAgeDays = freshHistory.value.historyAgeDays;
      snapshot.historyFloor = freshHistory.value.result.trustedFloor;
      snapshot.trustedDailyVolume = freshHistory.value.trustedDailyVolume;
      const makerVolumeCap = Math.floor(
        freshHistory.value.trustedDailyVolume *
          (config.makerHistoryVolumeRatio ?? 0.1),
      );
      if (!positiveSafeInteger(makerVolumeCap)) {
        addRejection(rejections, "maker_volume_cap_unavailable");
      } else {
        snapshot.makerVolumeCap = makerVolumeCap;
        if (candidate.makerAmount > makerVolumeCap) {
          addRejection(
            rejections,
            "maker_amount_exceeds_history_volume_cap",
            `amount=${candidate.makerAmount},cap=${makerVolumeCap}`,
          );
        }
      }

      const previousEntry =
        dataStore.trustedFloors?.[candidate.resource];
      if (previousEntry && !validateCachedFloor(previousEntry)) {
        addRejection(rejections, "trusted_floor_cache_invalid");
      } else {
        try {
          const advanced = advanceTrustedFloor(
            previousEntry
              ? {
                  historyDate: previousEntry.marketDate,
                  floor: previousEntry.value,
                  observedFloor: previousEntry.value,
                }
              : undefined,
            {
              historyDate: freshHistory.value.historyDate,
              floor: freshHistory.value.result.trustedFloor!,
            },
            { maxDailyDropRatio: 0.05 },
          );
          const successorFloor =
            options.nondecreasingTrustedFloors && previousEntry
              ? Math.max(previousEntry.value, advanced.state.floor)
              : advanced.state.floor;
          snapshot.ratchetFloor = successorFloor;
          const successorChanged = Boolean(
            !previousEntry ||
              previousEntry.value !== successorFloor ||
              previousEntry.marketDate !== advanced.state.historyDate,
          );
          if (advanced.reason === "older_history_day") {
            // Robust history filtering can reclassify yesterday's accepted
            // day as an outlier when a new complete day enters the window.
            // Keep the newer cached floor and its date. This is safe only
            // when that exact day is still present and was rejected solely
            // by the outlier filter; missing or incomplete history remains
            // a fail-closed rollback.
            const retainedOutlierDay =
              previousEntry !== undefined &&
              freshHistory.value.result.rejectedDays.some(
                (day) =>
                  day.date === previousEntry.marketDate &&
                  day.reason === "log_mad_outlier",
              );
            if (!retainedOutlierDay) {
              addRejection(rejections, "history_date_rollback");
            }
          } else if (successorChanged) {
            try {
              if (!dataStore.trustedFloors) {
                dataStore.trustedFloors = {};
              }
              dataStore.trustedFloors[candidate.resource] = {
                value: successorFloor,
                marketDate: advanced.state.historyDate,
                updatedAt: observedAt,
              };
            } catch (error) {
              addRejection(
                rejections,
                "trusted_floor_cache_write_failed",
                detailOf(error),
              );
            }
          }
        } catch (error) {
          addRejection(
            rejections,
            "trusted_floor_cache_invalid",
            detailOf(error),
          );
        }
      }
    }

    if (
      finitePositive(snapshot.historyFloor) &&
      finitePositive(snapshot.ratchetFloor)
    ) {
      const dynamicFloor =
        options.dynamicFloorByResource !== undefined
          ? options.dynamicFloorByResource[candidate.resource]
          : undefined;
      // 非法 df 回退 observe 四分量（当前 wiring 经 map 过滤不可达，
      // 防御未来注入面）；不得静默走 max(hard, economic) 降地板。
      const effective = computeEffectiveNetFloor(
        dynamicFloor !== undefined &&
          Number.isFinite(dynamicFloor) &&
          dynamicFloor > 0
          ? {
              hardFloor: hardFloor!,
              economicFloor: config.economicFloor[candidate.resource],
              dynamicFloor,
            }
          : {
              hardFloor: hardFloor!,
              economicFloor: config.economicFloor[candidate.resource],
              historyFloor: snapshot.historyFloor,
              ratchetFloor: snapshot.ratchetFloor,
            },
      );
      if (effective.valid && finitePositive(effective.floor)) {
        snapshot.effectiveNetFloor = effective.floor;
      } else {
        addRejection(
          rejections,
          "effective_floor_invalid",
          effective.reason,
        );
      }
    }

    const fetchedOrders = getOrdersOnce(candidate.resource);
    if (fetchedOrders.ok === false) {
      addRejection(
        rejections,
        fetchedOrders.reason,
        fetchedOrders.detail,
      );
    } else {
      snapshot.ownOrdersExcluded = fetchedOrders.ownOrdersExcluded;
      const minOrderAmount = Math.max(
        1,
        Math.ceil(config.minReferenceOrderAmount),
      );
      const policy = {
        minOrderAmount,
        minOrderNotional: config.minReferenceOrderNotional,
        minCumulativeDepth: Math.max(
          1,
          Math.ceil(
            config.minReferenceOrderAmount *
              config.referenceDepthMultiplier,
          ),
        ),
        minOrderCount: Math.max(
          1,
          Math.ceil(config.minReferenceOrderCount),
        ),
        minDistinctRooms: Math.max(
          2,
          Math.ceil(config.minReferenceDistinctRooms),
        ),
        maxDepthContributionPerOrder: minOrderAmount,
        maxDepthContributionPerRoom: minOrderAmount,
      };
      try {
        snapshot.referenceSellBook = assessOrderBookDepth({
          orders: fetchedOrders.orders,
          side: "sell",
          resourceType: candidate.resource,
          policy,
        });
        snapshot.directBuyBook = assessOrderBookDepth({
          orders: fetchedOrders.orders,
          side: "buy",
          resourceType: candidate.resource,
          policy,
        });
        if (!snapshot.referenceSellBook.trusted) {
          addRejection(rejections, "reference_order_book_untrusted");
        } else {
          const referenceAsk = roomBalancedMedianPrice(
            snapshot.referenceSellBook.eligibleOrders,
            minOrderAmount,
          );
          const historyReference = snapshot.historyResult?.referencePrice;
          if (
            !finitePositive(referenceAsk) ||
            !finitePositive(historyReference)
          ) {
            addRejection(rejections, "reference_order_book_untrusted");
          } else {
            snapshot.referenceSellAsk = roundMarketPriceUp(referenceAsk);
            snapshot.historyAskDeviationRatio =
              Math.max(
                snapshot.referenceSellAsk / historyReference,
                historyReference / snapshot.referenceSellAsk,
              ) - 1;
            if (
              snapshot.historyAskDeviationRatio >
              (config.maxHistoryAskDeviationRatio ?? 0.5)
            ) {
              addRejection(
                rejections,
                "history_ask_divergence",
                `history=${historyReference},ask=${snapshot.referenceSellAsk},ratio=${snapshot.historyAskDeviationRatio}`,
              );
            } else {
              snapshot.makerAskFloor = roundMarketPriceUp(
                snapshot.referenceSellAsk *
                  (config.makerAskFloorRatio ?? 0.98),
              );
            }
          }
        }
      } catch (error) {
        addRejection(
          rejections,
          "reference_order_book_untrusted",
          detailOf(error),
        );
      }
    }

    if (
      rejections.length === 0 &&
      finitePositive(snapshot.effectiveNetFloor)
    ) {
      try {
        const maker = findMinimumSafePrice({
          effectiveNetFloor: snapshot.effectiveNetFloor,
          feeDebtMilli: candidate.feeDebtMilli,
          action: {
            kind: "create",
            amount: candidate.makerAmount,
          },
        });
        snapshot.makerPriceResult = maker;
        if (
          maker.safe &&
          finitePositive(maker.recommendedPrice) &&
          finitePositive(snapshot.makerAskFloor)
        ) {
          const makerPrice = roundMarketPriceUp(
            Math.max(maker.recommendedPrice, snapshot.makerAskFloor),
          );
          const evaluation = evaluatePostActionInvariant({
            effectiveNetFloor: snapshot.effectiveNetFloor,
            feeDebtMilli: candidate.feeDebtMilli,
            action: {
              kind: "create",
              amount: candidate.makerAmount,
            },
            candidatePrice: makerPrice,
          });
          if (!evaluation.satisfiesInvariant) {
            addRejection(rejections, "maker_price_unavailable");
          } else {
            snapshot.makerPrice = makerPrice;
            snapshot.makerPriceResult = {
              ...maker,
              recommendedPrice: makerPrice,
              evaluation,
            };
          }
        } else {
          addRejection(
            rejections,
            "maker_price_unavailable",
            maker.reason,
          );
        }
      } catch (error) {
        addRejection(
          rejections,
          "maker_price_unavailable",
          detailOf(error),
        );
      }
    }

    snapshot.trusted =
      rejections.length === 0 && finitePositive(snapshot.makerPrice);
    snapshot.rejectedReason = rejections[0]?.reason;
  }

  return {
    observedAt,
    asOfDate,
    energyShadowPrice,
    energyHistoryDate,
    energyShadowEvidence,
    snapshots,
  };
}
