import {
  flushMarketSaleDiagnostics,
  markMarketSaleDiagnosticsPlanningTick,
  measureMarketSubPhase,
} from "@/runtime/marketSaleDiagnostics";
import {
  collectMarketSaleDomainActivity,
  runMarketSaleAutomation,
  type MarketSaleAutomationResult,
  type MarketBaseResourceTrustedFloorSuccessorInput,
  type MarketSalePlanCandidate,
} from "@/runtime/marketSaleAutomation";
import {
  directSafetyFingerprint,
  resolveMarketSaleAutomationConfig,
  type MarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
} from "@/runtime/marketDirectContinuousPolicy";
import type { MarketDirectContinuousAutomationState } from "@/runtime/marketDirectContinuousAutomation";
import {
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  isMarketBaseResource,
  marketBaseEnforcedDynamicFloors,
} from "@/runtime/marketBaseResourcePolicy";
import {
  collectMarketSalePriceSnapshots,
  type CollectMarketSalePriceSnapshotsOptions,
  type MarketSalePriceSnapshotCollection,
  type MarketSalePricingDataStore,
  type MarketSalePricingReadMarket,
} from "@/runtime/marketSalePricingAdapter";
import type {
  MarketProtectionCandidate,
  MarketSaleProtectionLedger,
} from "@/runtime/marketSaleProtection";
import { collectLiveMarketSaleProtectionLedger } from "@/runtime/marketSaleProtectionAdapter";

const DEFAULT_MINIMUM_TERMINAL_FREE_CAPACITY = 50_000;
const MINIMUM_PRICING_CPU_BUCKET = 5_000;
const ORDER_BOOK_REFRESH_TICKS = 100;
const HISTORY_REFRESH_TICKS = 5_000;
const MAX_CACHED_RESOURCES = 8;

function pricingResultCacheTtl(
  config: MarketSaleAutomationConfig,
): number {
  const usesContinuousDirect =
    (config.directCapability === "continuous-v2" ||
      config.directCapability === "continuous-v3") &&
    (config.mode === "direct" ||
      (config.mode === "shadow" &&
        config.shadowStrategy === "direct"));
  if (!usesContinuousDirect) {
    return ORDER_BOOK_REFRESH_TICKS;
  }
  // Continuous 的执行证据最多允许旧 planningSnapshotMaxAgeTicks。
  // cacheStillFresh 使用严格小于，因此 +1 可让边界 tick 仍复用，
  // 下一次完整规划周期则会强制刷新。
  return Math.min(
    ORDER_BOOK_REFRESH_TICKS,
    (config.planningSnapshotMaxAgeTicks ?? 0) + 1,
  );
}

interface TimedCacheEntry<T> {
  refreshedAt: number;
  value: T;
}

interface PricingResultCache {
  signature: string;
  refreshedAt: number;
  value: MarketSalePriceSnapshotCollection;
}

let activeCacheSignature: string | undefined;
let pricingResultCache: PricingResultCache | undefined;
const historyCache = new Map<ResourceConstant, TimedCacheEntry<PriceHistory[]>>();
const orderBookCache = new Map<ResourceConstant, TimedCacheEntry<Order[]>>();

type CollectProtection = typeof collectLiveMarketSaleProtectionLedger;
type CollectPricing = typeof collectMarketSalePriceSnapshots;
type RunAutomation = typeof runMarketSaleAutomation;

export interface MarketSaleRuntimeDependencies {
  collectProtection?: CollectProtection;
  collectPricing?: CollectPricing;
  runAutomation?: RunAutomation;
}

export interface MarketSaleRuntimeCompositionContext {
  currentTick: number;
  resourceControlUpdatedAt?: number;
  capacityStateByRoom: Readonly<
    Record<string, "normal" | "pressure" | "emergency" | undefined>
  >;
  hubEnabled: boolean;
  hubRoomName?: string;
  minimumTerminalFreeCapacity: number;
  pricingEvidenceFresh?: boolean;
  pricingRejectionReason?: string;
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.filter(Boolean))].slice(0, 40);
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
}

function containerHasEntriesOrIsInvalid(value: unknown): boolean {
  if (value === undefined) return false;
  return !isPlainRecord(value) || Object.keys(value).length > 0;
}

function isResourceConstant(
  value: unknown,
): value is ResourceConstant {
  return (
    typeof value === "string" &&
    RESOURCES_ALL.includes(value as ResourceConstant)
  );
}

const MAKER_ONLY_PRICING_REJECTIONS = new Set([
  "order_book_api_unavailable",
  "order_book_fetch_failed",
  "reference_order_book_untrusted",
  "history_ask_divergence",
  "maker_amount_invalid",
  "maker_volume_cap_unavailable",
  "maker_amount_exceeds_history_volume_cap",
  "maker_price_unavailable",
]);

function makerNetPrice(
  snapshot: MarketSalePriceSnapshotCollection["snapshots"][ResourceConstant],
): number | undefined {
  const evaluation = snapshot?.makerPriceResult?.evaluation;
  if (
    !evaluation ||
    !Number.isSafeInteger(evaluation.netRemainingValueMilli) ||
    !Number.isSafeInteger(evaluation.postRemainingAmount) ||
    evaluation.postRemainingAmount <= 0
  ) {
    return undefined;
  }
  const value =
    evaluation.netRemainingValueMilli /
    evaluation.postRemainingAmount /
    1_000;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Join the independently testable production-protection and pricing views.
 * Missing fields remain explicit rejection inputs; this function never
 * invents a floor, market depth, capacity state, or producer safety signal.
 */
export function composeMarketSalePlanCandidates(
  config: MarketSaleAutomationConfig,
  protection: MarketSaleProtectionLedger,
  pricing: MarketSalePriceSnapshotCollection,
  context: MarketSaleRuntimeCompositionContext,
): MarketSalePlanCandidate[] {
  const resourceControlCurrent =
    context.resourceControlUpdatedAt === context.currentTick;
  const hubStateKnown =
    !context.hubEnabled ||
    (typeof context.hubRoomName === "string" &&
      context.hubRoomName.length > 0);

  return Object.values(protection.entries)
    .map((entry): MarketSalePlanCandidate => {
      const price = pricing.snapshots[entry.resource];
      const protectionReasons = entry.issues.map(
        (issue) =>
          `protection:${issue.code}${
            issue.sourceKind ? `:${issue.sourceKind}` : ""
          }`,
      );
      const priceReasons =
        price?.rejections.map((rejection) => `pricing:${rejection.reason}`) ??
        ["pricing:snapshot_missing"];
      const directPriceReasons =
        price?.rejections
          .filter(
            (rejection) =>
              !MAKER_ONLY_PRICING_REJECTIONS.has(rejection.reason),
          )
          .map((rejection) => `pricing:${rejection.reason}`) ??
        ["pricing:snapshot_missing"];
      const integrationReasons: string[] = [];
      if (!resourceControlCurrent) {
        integrationReasons.push("resource_control_cycle_stale");
      }
      if (!hubStateKnown) {
        integrationReasons.push("hub_state_unknown");
      }
      if (context.pricingEvidenceFresh === false) {
        integrationReasons.push(
          context.pricingRejectionReason || "pricing_cache_stale",
        );
      }

      return {
        roomName: entry.roomName,
        resourceType: entry.resource,
        protectionEntry: entry,
        effectiveNetFloor: price?.effectiveNetFloor ?? 0,
        historyTrusted: price?.historyResult?.trusted,
        historyCompleteDayCount: price?.historyResult?.completeDayCount,
        historyAcceptedDayCount: price?.historyResult?.acceptedDayCount,
        historyFloor: price?.historyFloor,
        ratchetFloor: price?.ratchetFloor,
        makerPrice: price?.makerPrice,
        makerNetPrice: makerNetPrice(price),
        directHistoryTrusted:
          price?.historyResult?.trusted === true &&
          Number.isFinite(price.historyFloor) &&
          Number.isFinite(price.ratchetFloor) &&
          Number.isFinite(price.effectiveNetFloor),
        effectiveEnergyShadowPrice:
          pricing.energyShadowEvidence?.trusted === true
            ? pricing.energyShadowEvidence.effective
            : undefined,
        energyShadowObservedAt: pricing.energyShadowEvidence?.observedAt,
        energyShadowComponents: pricing.energyShadowEvidence
          ? {
              hardFloor: pricing.energyShadowEvidence.hardFloor,
              explicit: pricing.energyShadowEvidence.explicit,
              historyFloor: pricing.energyShadowEvidence.historyFloor,
              ratchetFloor: pricing.energyShadowEvidence.ratchetFloor,
            }
          : undefined,
        directAdditionalRejectionReasons: uniqueReasons([
          ...protectionReasons,
          ...directPriceReasons,
          ...integrationReasons,
          ...(pricing.energyShadowEvidence?.trusted === true
            ? []
            : [
                `pricing:${
                  pricing.energyShadowEvidence?.rejectionReason ||
                  "energy_shadow_unavailable"
                }`,
              ]),
        ]),
        trustedPrice:
          context.pricingEvidenceFresh !== false && price?.trusted === true,
        trustedDepth:
          context.pricingEvidenceFresh !== false &&
          price?.referenceSellBook?.trusted === true,
        capacityState: resourceControlCurrent
          ? context.capacityStateByRoom[entry.roomName]
          : undefined,
        hasCriticalConflict: entry.blocked,
        isHubRoom: hubStateKnown
          ? context.hubEnabled &&
            context.hubRoomName === entry.roomName
          : undefined,
        minimumTerminalFreeCapacity:
          context.minimumTerminalFreeCapacity,
        additionalRejectionReasons: uniqueReasons([
          ...protectionReasons,
          ...priceReasons,
          ...integrationReasons,
        ]),
      };
    })
    .sort(
      (left, right) =>
        left.roomName.localeCompare(right.roomName) ||
        left.resourceType.localeCompare(right.resourceType),
    );
}

function sortedThresholdEntries(
  value: Partial<Record<ResourceConstant, number>>,
): Array<[string, number]> {
  return Object.entries(value)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
}

function cacheSignature(config: MarketSaleAutomationConfig): string {
  const resources = [...config.sellResources].sort();
  return JSON.stringify({
    mode: config.mode,
    configRevision: config.configRevision,
    resources,
    hardFloor: sortedThresholdEntries(config.hardFloor),
    economicFloor: sortedThresholdEntries(config.economicFloor),
    makerBatchAmount: config.makerBatchAmount,
    energyShadowPrice: config.energyShadowPrice,
    minHistoryDays: config.minHistoryDays,
    minHistoryTransactions: config.minHistoryTransactions,
    minHistoryVolume: config.minHistoryVolume,
    historyFloorRatio: config.historyFloorRatio,
    historyMaxAgeDays: config.historyMaxAgeDays,
    minReferenceOrderAmount: config.minReferenceOrderAmount,
    minReferenceOrderNotional: config.minReferenceOrderNotional,
    minReferenceOrderCount: config.minReferenceOrderCount,
    minReferenceDistinctRooms: config.minReferenceDistinctRooms,
    referenceDepthMultiplier: config.referenceDepthMultiplier,
    maxHistoryAskDeviationRatio: config.maxHistoryAskDeviationRatio,
    makerAskFloorRatio: config.makerAskFloorRatio,
    makerHistoryVolumeRatio: config.makerHistoryVolumeRatio,
    directSafetyFingerprint: directSafetyFingerprint(config),
  });
}

function pricingResultSignature(
  config: MarketSaleAutomationConfig,
  pricingStore: MarketSalePricingDataStore,
  dynamicFloorEpoch?: string,
): string {
  const resources = [...config.sellResources].sort();
  const trustedFloors = isPlainRecord(pricingStore.trustedFloors)
    ? Object.keys(pricingStore.trustedFloors)
        .sort((left, right) => left.localeCompare(right))
        .map((resource) => {
          const entry = (
            pricingStore.trustedFloors as Record<string, unknown>
          )[resource];
          return isPlainRecord(entry)
            ? [
                resource,
                entry.value ?? null,
                entry.marketDate ?? null,
                entry.updatedAt ?? null,
              ]
            : [resource, entry ?? null];
        })
    : [["<invalid>", pricingStore.trustedFloors ?? null]];
  return JSON.stringify({
    config: cacheSignature(config),
    carriedFeeDebtMilli: resources.map((resource) => [
      resource,
      pricingStore.carriedFeeDebtMilli?.[resource] ?? 0,
    ]),
    trustedFloors,
    // enforce 生效时（存在已生效动态地板）投影每成功 planning 轮推进，
    // 缓存必须随之失效——否则 TTL 窗口内 adapter 用旧 df、
    // candidatePricingComplete 用新投影，对称校验隔轮交替 fail-closed。
    // observe 下 undefined，不参与签名（零 CPU 变化）。
    dynamicFloorEpoch,
  });
}

function detachedPricingStore(
  data: Record<string, unknown>,
): MarketSalePricingDataStore {
  const rawTrustedFloors = data.trustedFloors;
  const trustedFloors = isPlainRecord(rawTrustedFloors)
    ? Object.fromEntries(
        Object.entries(rawTrustedFloors).map(([resource, entry]) => [
          resource,
          isPlainRecord(entry) ? { ...entry } : entry,
        ]),
      )
    : rawTrustedFloors;
  return {
    trustedFloors:
      trustedFloors as MarketSalePricingDataStore["trustedFloors"],
    carriedFeeDebtMilli: isPlainRecord(data.carriedFeeDebtMilli)
      ? (data.carriedFeeDebtMilli as MarketSalePricingDataStore[
          "carriedFeeDebtMilli"
        ])
      : undefined,
  };
}

function resetPricingCaches(signature?: string): void {
  activeCacheSignature = signature;
  pricingResultCache = undefined;
  historyCache.clear();
  orderBookCache.clear();
}

function ensurePricingCacheSignature(signature: string): void {
  if (activeCacheSignature !== signature) {
    resetPricingCaches(signature);
  }
}

function cacheStillFresh(
  refreshedAt: number,
  currentTick: number,
  ttl: number,
): boolean {
  return (
    Number.isFinite(refreshedAt) &&
    refreshedAt <= currentTick &&
    currentTick - refreshedAt < ttl
  );
}

function boundedSet<T>(
  cache: Map<ResourceConstant, TimedCacheEntry<T>>,
  resource: ResourceConstant,
  entry: TimedCacheEntry<T>,
): void {
  cache.delete(resource);
  cache.set(resource, entry);
  while (cache.size > MAX_CACHED_RESOURCES) {
    const oldest = cache.keys().next().value as ResourceConstant | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function resourceFromOrderFilter(
  filter?: OrderFilter | ((order: Order) => boolean),
): ResourceConstant {
  if (
    !filter ||
    typeof filter === "function" ||
    typeof filter.resourceType !== "string"
  ) {
    throw new TypeError("market-sale order cache requires a resourceType filter");
  }
  return filter.resourceType as ResourceConstant;
}

function createCachedReadMarket(currentTick: number): MarketSalePricingReadMarket {
  return {
    orders: Game.market.orders,
    getHistory: (resource?: MarketResourceConstant): PriceHistory[] => {
      if (typeof resource !== "string") {
        throw new TypeError("market-sale history cache requires a resource");
      }
      const resourceType = resource as ResourceConstant;
      const cached = historyCache.get(resourceType);
      if (
        cached &&
        cacheStillFresh(cached.refreshedAt, currentTick, HISTORY_REFRESH_TICKS)
      ) {
        return cached.value;
      }
      const value = Game.market.getHistory(resource);
      boundedSet(historyCache, resourceType, {
        refreshedAt: currentTick,
        value,
      });
      return value;
    },
    getAllOrders: (
      filter?: OrderFilter | ((order: Order) => boolean),
    ): Order[] => {
      const resource = resourceFromOrderFilter(filter);
      const cached = orderBookCache.get(resource);
      if (
        cached &&
        cacheStillFresh(cached.refreshedAt, currentTick, ORDER_BOOK_REFRESH_TICKS)
      ) {
        return cached.value;
      }
      const value = Game.market.getAllOrders({
        resourceType: resource as MarketResourceConstant,
      });
      boundedSet(orderBookCache, resource, {
        refreshedAt: currentTick,
        value,
      });
      return value;
    },
  };
}

function collectCachedPricing(
  config: MarketSaleAutomationConfig,
  pricingStore: MarketSalePricingDataStore,
  collectPricing: CollectPricing,
): MarketSalePriceSnapshotCollection {
  ensurePricingCacheSignature(cacheSignature(config));
  const enforcedFloors = marketBaseEnforcedDynamicFloors(
    (Memory.data?.marketSaleAutomation?.directAutomation as
      | MarketDirectContinuousAutomationState
      | undefined
      | null)?.baseResourceV3?.dynamicFloorProjection,
  );
  const enforceActive = Object.keys(enforcedFloors).length > 0;
  const dynamicFloorEpoch = enforceActive
    ? `enforced:${Object.entries(enforcedFloors)
        .map(([resource, floor]) => `${resource}:${floor}`)
        .sort()
        .join("|")}`
    : undefined;
  const signature = pricingResultSignature(
    config,
    pricingStore,
    dynamicFloorEpoch,
  );
  const resultCacheTtl = pricingResultCacheTtl(config);
  if (
    pricingResultCache &&
    pricingResultCache.signature === signature &&
    cacheStillFresh(
      pricingResultCache.refreshedAt,
      Game.time,
      resultCacheTtl,
    )
  ) {
    return pricingResultCache.value;
  }

  const options: CollectMarketSalePriceSnapshotsOptions = {
    market: createCachedReadMarket(Game.time),
    gameTime: Game.time,
    nondecreasingTrustedFloors:
      config.directCapability === "continuous-v3",
    // enforce 动态地板：从 baseResourceV3 投影提取（本 tick 内不变）。
    // 签名绑定 enforced floors——投影推进即失效重算，保证 adapter 与
    // candidatePricingComplete 始终同源；observe 下为空 map，零变化。
    dynamicFloorByResource: enforcedFloors,
  };
  const value = collectPricing(
    config,
    pricingStore,
    config.sellResources.map((resource) => ({
      resource,
      makerAmount: config.makerBatchAmount,
      feeDebtMilli: pricingStore.carriedFeeDebtMilli?.[resource] ?? 0,
    })),
    options,
  );
  pricingResultCache = {
    // Adapter 可在 detached store 上推进 trusted-floor successor；缓存必须
    // 绑定推进后的 commitment，不能让旧 floor root 命中新的定价证据。
    // 与读侧同源（本 tick 的 enforcedFloors epoch），读写签名一致。
    signature: pricingResultSignature(
      config,
      pricingStore,
      dynamicFloorEpoch,
    ),
    refreshedAt: Game.time,
    value,
  };
  return value;
}

function emptyPricingCollection(): MarketSalePriceSnapshotCollection {
  return {
    observedAt: Game.time,
    asOfDate: new Date().toISOString().slice(0, 10),
    snapshots: {},
  };
}

function resetShadowQualification(reason: string): void {
  const runtime = Memory.runtime?.marketSaleAutomation as
    | (NonNullable<
        NonNullable<Memory["runtime"]>["marketSaleAutomation"]
      > & { lastShadowCycleTick?: number })
    | undefined;
  if (!runtime) return;
  runtime.shadowConsecutiveCycles = 0;
  runtime.shadowConfigRevision = undefined;
  runtime.shadowConfigSignature = undefined;
  runtime.lastShadowCycleTick = Game.time;
  runtime.rejectedByReason[reason] =
    (runtime.rejectedByReason[reason] || 0) + 1;
}

export function clearMarketSaleRuntimeCachesForTest(): void {
  resetPricingCaches();
}

function resolveCompositionContext(): MarketSaleRuntimeCompositionContext {
  const resourceControl = Memory.runtime?.resourceControl;
  const capacityStateByRoom: Record<
    string,
    "normal" | "pressure" | "emergency" | undefined
  > = {};
  for (const [roomName, state] of Object.entries(
    resourceControl?.rooms || {},
  )) {
    capacityStateByRoom[roomName] = state.capacityState;
  }
  const hub = Memory.cfg?.hub;
  return {
    currentTick: Game.time,
    resourceControlUpdatedAt: resourceControl?.updatedAt,
    capacityStateByRoom,
    hubEnabled: hub?.enabled === true,
    hubRoomName: hub?.hubRoomName,
    minimumTerminalFreeCapacity:
      resourceControl?.capacityPolicy?.receiverTerminalMinFreeCapacity ??
      DEFAULT_MINIMUM_TERMINAL_FREE_CAPACITY,
  };
}

function exposureProtectionCandidates(
  data: unknown,
): MarketProtectionCandidate[] {
  const candidates: MarketProtectionCandidate[] = [];
  const dataRecord = isPlainRecord(data) ? data : {};
  const managedOrders = isPlainRecord(dataRecord.managedOrders)
    ? dataRecord.managedOrders
    : {};
  for (const rawManaged of Object.values(managedOrders)) {
    if (!isPlainRecord(rawManaged)) continue;
    const managed = rawManaged;
    if (
      typeof managed.roomName === "string" &&
      managed.roomName.length > 0 &&
      isResourceConstant(managed.resourceType)
    ) {
      candidates.push({
        roomName: managed.roomName,
        resource: managed.resourceType,
      });
    }
  }
  const pendingCreate = isPlainRecord(dataRecord.pendingCreate)
    ? dataRecord.pendingCreate
    : undefined;
  const pendingTuple = isPlainRecord(pendingCreate?.tuple)
    ? pendingCreate.tuple
    : undefined;
  if (
    typeof pendingTuple?.roomName === "string" &&
    pendingTuple.roomName.length > 0 &&
    isResourceConstant(pendingTuple.resourceType)
  ) {
    candidates.push({
      roomName: pendingTuple.roomName,
      resource: pendingTuple.resourceType,
    });
  }
  const directAutomation = isPlainRecord(
    dataRecord.directAutomation,
  )
    ? dataRecord.directAutomation
    : undefined;
  const pendingContainers = [
    dataRecord.pendingDirectDeals,
    directAutomation?.pendingDirectDeals,
  ];
  for (const pendingContainer of pendingContainers) {
    if (!isPlainRecord(pendingContainer)) continue;
    for (const rawPending of Object.values(pendingContainer)) {
      if (!isPlainRecord(rawPending)) continue;
      const pending = rawPending;
      const roomName =
        pending.canaryRoomName || pending.roomName;
      const resource =
        pending.resource || pending.resourceType;
      if (
        typeof roomName === "string" &&
        roomName.length > 0 &&
        isResourceConstant(resource)
      ) {
        candidates.push({ roomName, resource });
      }
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.roomName}:${candidate.resource}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function continuousProtectionOptions(
  config: MarketSaleAutomationConfig,
): {
  candidates: MarketProtectionCandidate[];
  laneReserveByEntry: Record<string, number>;
} | undefined {
  if (config.directCapability === "continuous-v3") {
    const rawData = isPlainRecord(
      Memory.data?.marketSaleAutomation,
    )
      ? (Memory.data!.marketSaleAutomation as unknown as Record<
          string,
          unknown
        >)
      : undefined;
    const direct = isPlainRecord(
      rawData?.directAutomation,
    )
      ? rawData?.directAutomation
      : undefined;
    const v3 = isPlainRecord(
      direct?.baseResourceV3,
    )
      ? direct?.baseResourceV3
      : undefined;
    const scope = isPlainRecord(v3?.scope)
      ? v3?.scope
      : undefined;
    const lanes = Array.isArray(scope?.laneLifecycles)
      ? scope.laneLifecycles
      : undefined;
    if (!lanes) return undefined;
    const candidates: MarketProtectionCandidate[] = [];
    const laneReserveByEntry: Record<string, number> = {};
    const seen = new Set<string>();
    for (const rawLane of lanes) {
      if (!isPlainRecord(rawLane)) return undefined;
      const roomName = rawLane.sellerRoomName;
      const resource = rawLane.resource;
      if (
        typeof roomName !== "string" ||
        roomName.length === 0 ||
        !isMarketBaseResource(resource)
      ) {
        return undefined;
      }
      const key = `${roomName}:${resource}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      candidates.push({
        roomName,
        resource:
          resource as ResourceConstant,
      });
      laneReserveByEntry[key] =
        MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[
          resource
        ].laneReserve;
    }
    return {
      candidates: candidates.sort(
        (left, right) =>
          left.roomName.localeCompare(right.roomName) ||
          String(left.resource).localeCompare(
            String(right.resource),
          ),
      ),
      laneReserveByEntry,
    };
  }
  if (config.directCapability !== "continuous-v2") {
    return undefined;
  }
  const candidates: MarketProtectionCandidate[] = [];
  const laneReserveByEntry: Record<string, number> = {};
  for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
    for (const roomName of entry.allowedRoomNames) {
      candidates.push({
        roomName,
        resource: entry.resourceType,
      });
      laneReserveByEntry[
        `${roomName}:${entry.resourceType}`
      ] = entry.laneReserve;
    }
  }
  return { candidates, laneReserveByEntry };
}

/**
 * Production entrypoint called after ResourceControl. Expensive market reads
 * occur only on a fresh ResourceControl cycle. Existing managed/pending
 * exposure still gets a current-tick protection collection on every tick;
 * ResourceControl freshness remains a hard gate for new-order planning.
 */
export function runLiveMarketSaleAutomation(
  dependencies: MarketSaleRuntimeDependencies = {},
): MarketSaleAutomationResult {
  const collectProtection =
    dependencies.collectProtection || collectLiveMarketSaleProtectionLedger;
  const collectPricing =
    dependencies.collectPricing || collectMarketSalePriceSnapshots;
  const runAutomation = dependencies.runAutomation || runMarketSaleAutomation;
  const config = resolveMarketSaleAutomationConfig();
  const rawData =
    Memory.data?.marketSaleAutomation as unknown;
  const data = isPlainRecord(rawData)
    ? (rawData as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >)
    : undefined;
  const domainActivity = measureMarketSubPhase("domainScan", () =>
    collectMarketSaleDomainActivity(rawData),
  );
  const domainActivityInput = {
    stagingAmount: domainActivity.stagingAmount,
    reservationAmount: domainActivity.reservationAmount,
    ...(domainActivity.valid
      ? {}
      : { marketDomainActivityValid: false }),
  };
  const resourceControlCurrent =
    Memory.runtime?.resourceControl?.updatedAt === Game.time;
  const exposureCandidates =
    exposureProtectionCandidates(rawData);
  const dataRecord = isPlainRecord(rawData)
    ? rawData
    : undefined;
  const directAutomation = isPlainRecord(
    dataRecord?.directAutomation,
  )
    ? dataRecord?.directAutomation
    : undefined;
  const directLedger = isPlainRecord(
    directAutomation?.ledger,
  )
    ? directAutomation?.ledger
    : undefined;
  const directLedgerBlocker = isPlainRecord(
    directLedger?.blocker,
  )
    ? directLedger?.blocker
    : undefined;
  const directPending = isPlainRecord(
    directAutomation?.pendingDirectDeals,
  )
    ? directAutomation?.pendingDirectDeals
    : undefined;
  const directQuarantine = isPlainRecord(
    directAutomation?.quarantinedPendingDirectDeals,
  )
    ? directAutomation?.quarantinedPendingDirectDeals
    : undefined;
  const directStrategyActive =
    config.mode === "direct" ||
    (config.mode === "shadow" &&
      config.shadowStrategy === "direct");
  const inactiveMissingDirectState =
    !directStrategyActive &&
    directAutomation?.capability ===
      "market-direct-continuous" &&
    directAutomation?.migrationStatus === "blocked" &&
    directAutomation?.migrationBlockedReason ===
      "direct_state_missing" &&
    directLedgerBlocker?.code === "direct_state_missing" &&
    directLedger?.pending === undefined &&
    directPending !== undefined &&
    Object.keys(directPending).length === 0 &&
    directQuarantine !== undefined &&
    Object.keys(directQuarantine).length === 1 &&
    Object.prototype.hasOwnProperty.call(
      directQuarantine,
      "__continuous_blocked__:direct_state_missing",
    );
  const hasExposureState = Boolean(
    rawData !== undefined &&
      (!dataRecord ||
        containerHasEntriesOrIsInvalid(
          dataRecord.managedOrders,
        ) ||
        dataRecord.pendingCreate !== undefined ||
        containerHasEntriesOrIsInvalid(
          dataRecord.pendingMutations,
        ) ||
        containerHasEntriesOrIsInvalid(
          dataRecord.pendingDirectDeals,
        ) ||
        (dataRecord.directAutomation !== undefined &&
          !inactiveMissingDirectState &&
          (!directAutomation ||
            containerHasEntriesOrIsInvalid(
              directAutomation.pendingDirectDeals,
            ) ||
            containerHasEntriesOrIsInvalid(
              directAutomation.quarantinedPendingDirectDeals,
            ) ||
            directAutomation.migrationBlockedReason !==
              undefined))),
  );

  if (
    !config.validForPlanning ||
    (config.mode !== "shadow" &&
      config.mode !== "maker" &&
      config.mode !== "direct" &&
      config.mode !== "hybrid") ||
    !data ||
    (!resourceControlCurrent && !hasExposureState)
  ) {
    const result = runAutomation(domainActivityInput);
    flushMarketSaleDiagnostics();
    return result;
  }

  try {
    // Production commitments stay current even while pricing is CPU-throttled.
    // This lets stale-price candidates fail closed and cancel existing exposure.
    const canonicalContinuousProtection =
      continuousProtectionOptions(config);
    // 非 planning tick（ResourceControl 未更新）且无 exposure 待观测时，
    // 下面的 protection/candidates 没有任何消费者：v3 planner 仅在 planning
    // tick 做 full read（回调自带 fresh 采集），projectCandidate 投影与
    // maker 校验也仅 planning tick，exposure 保护走 exposureCandidates 通道
    // （此时为空）。跳过全量 ledger 扫描；一旦出现 exposure（pending deal
    // 观测等）自动回到全量路径。
    const skipOuterCollection =
      !resourceControlCurrent && exposureCandidates.length === 0;
    const protection = skipOuterCollection
      ? undefined
      : measureMarketSubPhase("protectionOuter", () =>
          collectProtection(
            config,
            isPlainRecord(data.managedOrders)
              ? data.managedOrders
              : undefined,
            resourceControlCurrent
              ? canonicalContinuousProtection
              : { candidates: exposureCandidates },
          ),
        );
    const usesMarketBaseResourceSuccessor =
      config.directCapability === "continuous-v3";
    // V3 preflight 会递归冻结 canonical trustedFloors 以关闭 TOCTOU。
    // 定价层仍需要推进 ratchet cache，因此只能在 detached store 上计算，
    // 再把 successor 交回持有 opaque provenance 的 outer 原子接纳。
    const pricingStore = usesMarketBaseResourceSuccessor
      ? detachedPricingStore(data as unknown as Record<string, unknown>)
      : (data as unknown as MarketSalePricingDataStore);
    const trustedFloorSource = usesMarketBaseResourceSuccessor
      ? (data as unknown as Record<string, unknown>).trustedFloors
      : undefined;
    ensurePricingCacheSignature(cacheSignature(config));
    const resultCacheTtl = pricingResultCacheTtl(config);
    const bucket = Game.cpu?.bucket;
    const pricingAllowed =
      resourceControlCurrent &&
      typeof bucket === "number" &&
      Number.isFinite(bucket) &&
      bucket >= MINIMUM_PRICING_CPU_BUCKET;
    const cachedPricingFresh =
      pricingResultCache !== undefined &&
      cacheStillFresh(
        pricingResultCache.refreshedAt,
        Game.time,
        resultCacheTtl,
      );
    let pricing = cachedPricingFresh
      ? pricingResultCache!.value
      : emptyPricingCollection();
    let pricingEvidenceFresh = false;
    let pricingRejectionReason = resourceControlCurrent
      ? pricingAllowed
        ? "pricing_cache_stale"
        : "cpu_bucket_low"
      : "resource_control_cycle_stale";
    if (pricingAllowed) {
      try {
        pricing = measureMarketSubPhase("pricingRefresh", () =>
          collectCachedPricing(config, pricingStore, collectPricing),
        );
        pricingEvidenceFresh =
          pricingResultCache !== undefined &&
          cacheStillFresh(
            pricingResultCache.refreshedAt,
            Game.time,
            resultCacheTtl,
          );
      } catch (error) {
        pricingRejectionReason = "pricing_refresh_failed";
        console.log(
          `[market-sale] pricing refresh failed closed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const compositionContext = {
      ...resolveCompositionContext(),
      pricingEvidenceFresh,
      pricingRejectionReason,
    };
    const candidates = protection
      ? measureMarketSubPhase("candidateComposition", () =>
          composeMarketSalePlanCandidates(
            config,
            protection,
            pricing,
            compositionContext,
          ),
        )
      : [];
    const readMarketBaseResourceCandidates =
      config.directCapability ===
      "continuous-v3"
        ? () =>
          measureMarketSubPhase("v3FreshProtectionRead", () => {
            // 每次 v3 full read 都重新采集 current production protection。
            // pricing history/energy snapshot 是本 planning tick 的已验证
            // resource-scoped 证据；BUY book 与 terminal 由 v3 planner另读。
            const freshProtection =
              collectProtection(
                config,
                isPlainRecord(
                  data.managedOrders,
                )
                  ? data.managedOrders
                  : undefined,
                canonicalContinuousProtection,
              );
            return composeMarketSalePlanCandidates(
              config,
              freshProtection,
              pricing,
              compositionContext,
            );
          })
        : undefined;
    const marketBaseResourceTrustedFloorSuccessor:
      | MarketBaseResourceTrustedFloorSuccessorInput
      | undefined =
      usesMarketBaseResourceSuccessor &&
      pricingEvidenceFresh &&
      trustedFloorSource !== null &&
      typeof trustedFloorSource === "object" &&
      isPlainRecord(pricingStore.trustedFloors)
        ? {
            sourceTrustedFloors: trustedFloorSource,
            trustedFloors: pricingStore.trustedFloors,
          }
        : undefined;
    if (resourceControlCurrent) {
      markMarketSaleDiagnosticsPlanningTick();
    }
    const result = measureMarketSubPhase("automationEnvelope", () =>
      runAutomation({
        candidates,
        ...(readMarketBaseResourceCandidates
          ? {
              readMarketBaseResourceCandidates,
            }
          : {}),
        ...(marketBaseResourceTrustedFloorSuccessor
          ? { marketBaseResourceTrustedFloorSuccessor }
          : {}),
        ...domainActivityInput,
      }),
    );
    flushMarketSaleDiagnostics();
    if (resourceControlCurrent && !pricingEvidenceFresh) {
      resetShadowQualification(pricingRejectionReason);
      result.rejectedByReason[pricingRejectionReason] =
        (result.rejectedByReason[pricingRejectionReason] || 0) + 1;
    }
    return result;
  } catch (error) {
    console.log(
      `[market-sale] live adapter failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    resetShadowQualification("live_adapter_failed");
    return runAutomation(domainActivityInput);
  }
}
