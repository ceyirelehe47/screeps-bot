import {
  buildTrustedHistoryFloor,
  roundMarketPriceUp,
  type MarketHistoryDay,
} from "@/runtime/marketSalePricing";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

/**
 * V3 基础矿物 catalog、逐资源 policy、房间准入和派生 lane 的纯数据合同。
 *
 * 本模块不读写 Game/Memory，也不改变冻结的 Continuous v2 codec/hash。
 * 调用方应先在局部值上完成校验，再原子提交返回的新状态。
 */

export const MARKET_BASE_RESOURCE_SCHEMA_VERSION = 3 as const;
export const MARKET_BASE_RESOURCE_CATALOG_REVISION = "base-mineral-v1" as const;
export const MARKET_BASE_RESOURCE_ENGINE_REVISION =
  "market-base-resource-engine-v3" as const;
export const MARKET_BASE_RESOURCE_BOOTSTRAP_REVISION =
  "floor-bootstrap-v1" as const;
export const MARKET_BASE_RESOURCE_BOOTSTRAP_HISTORY_DATE =
  "2026-07-27" as const;
export const MARKET_BASE_RESOURCE_EVIDENCE_SHA256 =
  "b290a5972cc9bab04b09351dc42c057ec2c85d1555eedead2e72b19092b7b232" as const;
export const MARKET_BASE_RESOURCE_EVIDENCE_IMPLEMENTATION_BLOB =
  "f55503b3d45352e14513e9928706251c82992ecc" as const;
export const MARKET_BASE_RESOURCE_CONFIG_REVISION =
  "market-base-resource-v3-r7" as const;
/** 冷却期间最多约 30 笔，十亿是有限整数运算中的非约束哨值。 */
export const MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT = 1_000_000_000 as const;

export const MARKET_BASE_RESOURCE_MAX_ROOMS = 16 as const;
export const MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES = 32 as const;
export const MARKET_BASE_RESOURCE_MAX_LANES = 112 as const;
export const MARKET_BASE_RESOURCE_MAX_ROOM_TOMBSTONES = 64 as const;
export const MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES = 224 as const;
export const MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE = 8 as const;
export const MARKET_BASE_RESOURCE_ROOM_TOMBSTONE_PREFIX_HASH_REVISION =
  "market-base-resource-room-tombstones-v1" as const;

export const MARKET_BASE_RESOURCE_CATALOG = deepFreeze([
  "H",
  "K",
  "L",
  "O",
  "U",
  "X",
  "Z",
] as const);

export type MarketBaseResource = (typeof MARKET_BASE_RESOURCE_CATALOG)[number];
export type MarketBaseRoomClass = "normal" | "hub";
export type MarketBaseLaneStage =
  "shadow" | "qualified" | "canary" | "review_paused" | "continuous";
export type MarketBaseLaneStatus = "suspended" | "writable" | "tombstoned";

const MARKET_BASE_RESOURCE_SET = new Set<string>(MARKET_BASE_RESOURCE_CATALOG);
const MARKET_BASE_RESOURCE_CATALOG_SORTED = deepFreeze(
  [...MARKET_BASE_RESOURCE_CATALOG].sort(),
);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return exactStringArray(actualKeys, sortedExpected);
}

function isCanonicalStableDigest(value: unknown): value is string {
  return typeof value === "string" && /^csh1:[0-9a-f]{32}$/.test(value);
}

function isRoomInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" && /^mbr-room:csh1:[0-9a-f]{32}$/.test(value)
  );
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function exactStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function isMarketBaseResource(
  value: unknown,
): value is MarketBaseResource {
  return typeof value === "string" && MARKET_BASE_RESOURCE_SET.has(value);
}

export interface MarketBaseResourcePolicy {
  readonly policyId: string;
  readonly policyRevision: string;
  readonly resource: MarketBaseResource;
  readonly resourceClass: "base-mineral";
  readonly hardFloor: number;
  readonly economicFloor: number;
  readonly laneReserve: 100000;
  readonly minOrderAmount: 1000;
  readonly minOrderNotional: number;
  readonly maxDealAmount: 1000;
  /** Signed lower bound. A durable, scoped trial must still authorize 100. */
  readonly cooldownTicks: 100 | 1000;
  readonly rollingWindowTicks: 30000;
  readonly rollingMaxAmount: number;
  /** 仅用于库存压力和生产缓冲标尺；滚动成交额度另行放开。 */
  readonly inventoryReferenceAmount: number;
  readonly rollingOpportunityReserveAmount: 1000;
  readonly maxRawOrdersScanned: 1000;
  readonly maxEligibleOrdersPriced: 200;
  readonly maxTransactionEnergy: 1000;
  readonly terminalEnergyReserve: 25000;
  /**
   * 动态价格阈值（observe/enforce 共用参数；mode=observe 时只投影不参与
   * planner 合成）。listingBuffer 保留挂单溢价合同；Direct 净价使用
   * directNetBidRatio，从可信买价 EMA 与库存压力得出可执行的净价下限。
   * maxDailyDynamicDrop 限制单日下移，surplusLow/High 把保护后盈余
   * 倍数线性映射为 inventoryFactor ∈ [0,1]。
   */
  readonly listingBuffer: number;
  /** Direct 净价相对可信买价 EMA 的最低比例；库存压力越大越接近此值。 */
  readonly directNetBidRatio: number;
  readonly maxDailyDynamicDrop: number;
  readonly surplusLow: number;
  readonly surplusHigh: number;
  readonly dynamicFloorMode: "observe" | "enforce";
  readonly fingerprint: string;
}

interface RawMarketBaseResourcePolicy extends Omit<
  MarketBaseResourcePolicy,
  "fingerprint"
> {}

const RAW_MARKET_BASE_RESOURCE_POLICIES = deepFreeze<
  readonly RawMarketBaseResourcePolicy[]
>([
  {
    policyId: "base-h-v3-r1",
    policyRevision: "base-h-v3-r4",
    resource: "H",
    resourceClass: "base-mineral",
    hardFloor: 428,
    economicFloor: 451,
    laneReserve: 100_000,
    minOrderAmount: 1_000,
    minOrderNotional: 451_000,
    maxDealAmount: 1_000,
    cooldownTicks: 1_000,
    rollingWindowTicks: 30_000,
    rollingMaxAmount: MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT,
    inventoryReferenceAmount: 8_000,
    rollingOpportunityReserveAmount: 1_000,
    maxRawOrdersScanned: 1_000,
    maxEligibleOrdersPriced: 200,
    maxTransactionEnergy: 1_000,
    terminalEnergyReserve: 25_000,
    listingBuffer: 0.03,
    directNetBidRatio: 0.85,
    maxDailyDynamicDrop: 0.15,
    surplusLow: 1,
    surplusHigh: 3,
    dynamicFloorMode: "enforce",
  },
  {
    policyId: "base-k-v3-r1",
    policyRevision: "base-k-v3-r4",
    resource: "K",
    resourceClass: "base-mineral",
    hardFloor: 33,
    economicFloor: 34,
    laneReserve: 100_000,
    minOrderAmount: 1_000,
    minOrderNotional: 34_000,
    maxDealAmount: 1_000,
    cooldownTicks: 1_000,
    rollingWindowTicks: 30_000,
    rollingMaxAmount: MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT,
    inventoryReferenceAmount: 5_000,
    rollingOpportunityReserveAmount: 1_000,
    maxRawOrdersScanned: 1_000,
    maxEligibleOrdersPriced: 200,
    maxTransactionEnergy: 1_000,
    terminalEnergyReserve: 25_000,
    listingBuffer: 0.03,
    directNetBidRatio: 0.85,
    maxDailyDynamicDrop: 0.15,
    surplusLow: 1,
    surplusHigh: 3,
    dynamicFloorMode: "enforce",
  },
  {
    policyId: "base-l-v3-r1",
    policyRevision: "base-l-v3-r5",
    resource: "L",
    resourceClass: "base-mineral",
    hardFloor: 161,
    economicFloor: 169,
    laneReserve: 100_000,
    minOrderAmount: 1_000,
    minOrderNotional: 169_000,
    maxDealAmount: 1_000,
    cooldownTicks: 100,
    rollingWindowTicks: 30_000,
    rollingMaxAmount: MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT,
    inventoryReferenceAmount: 5_000,
    rollingOpportunityReserveAmount: 1_000,
    maxRawOrdersScanned: 1_000,
    maxEligibleOrdersPriced: 200,
    maxTransactionEnergy: 1_000,
    terminalEnergyReserve: 25_000,
    listingBuffer: 0.03,
    directNetBidRatio: 0.85,
    maxDailyDynamicDrop: 0.15,
    surplusLow: 1,
    surplusHigh: 3,
    dynamicFloorMode: "enforce",
  },
  {
    policyId: "base-o-v3-r1",
    policyRevision: "base-o-v3-r4",
    resource: "O",
    resourceClass: "base-mineral",
    hardFloor: 71,
    economicFloor: 74,
    laneReserve: 100_000,
    minOrderAmount: 1_000,
    minOrderNotional: 74_000,
    maxDealAmount: 1_000,
    cooldownTicks: 1_000,
    rollingWindowTicks: 30_000,
    rollingMaxAmount: MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT,
    inventoryReferenceAmount: 5_000,
    rollingOpportunityReserveAmount: 1_000,
    maxRawOrdersScanned: 1_000,
    maxEligibleOrdersPriced: 200,
    maxTransactionEnergy: 1_000,
    terminalEnergyReserve: 25_000,
    listingBuffer: 0.03,
    directNetBidRatio: 0.85,
    maxDailyDynamicDrop: 0.15,
    surplusLow: 1,
    surplusHigh: 3,
    dynamicFloorMode: "enforce",
  },
  {
    policyId: "base-u-v3-r1",
    policyRevision: "base-u-v3-r4",
    resource: "U",
    resourceClass: "base-mineral",
    hardFloor: 31,
    economicFloor: 32,
    laneReserve: 100_000,
    minOrderAmount: 1_000,
    minOrderNotional: 32_000,
    maxDealAmount: 1_000,
    cooldownTicks: 1_000,
    rollingWindowTicks: 30_000,
    rollingMaxAmount: MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT,
    inventoryReferenceAmount: 5_000,
    rollingOpportunityReserveAmount: 1_000,
    maxRawOrdersScanned: 1_000,
    maxEligibleOrdersPriced: 200,
    maxTransactionEnergy: 1_000,
    terminalEnergyReserve: 25_000,
    listingBuffer: 0.03,
    directNetBidRatio: 0.85,
    maxDailyDynamicDrop: 0.15,
    surplusLow: 1,
    surplusHigh: 3,
    dynamicFloorMode: "enforce",
  },
  {
    policyId: "base-x-v3-r2",
    policyRevision: "base-x-v3-r6",
    resource: "X",
    resourceClass: "base-mineral",
    hardFloor: 371,
    economicFloor: 390,
    laneReserve: 100_000,
    minOrderAmount: 1_000,
    minOrderNotional: 390_000,
    maxDealAmount: 1_000,
    cooldownTicks: 100,
    rollingWindowTicks: 30_000,
    rollingMaxAmount: MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT,
    inventoryReferenceAmount: 8_000,
    rollingOpportunityReserveAmount: 1_000,
    maxRawOrdersScanned: 1_000,
    maxEligibleOrdersPriced: 200,
    maxTransactionEnergy: 1_000,
    terminalEnergyReserve: 25_000,
    listingBuffer: 0.03,
    directNetBidRatio: 0.85,
    maxDailyDynamicDrop: 0.15,
    surplusLow: 1,
    surplusHigh: 3,
    dynamicFloorMode: "enforce",
  },
  {
    policyId: "base-z-v3-r1",
    policyRevision: "base-z-v3-r4",
    resource: "Z",
    resourceClass: "base-mineral",
    hardFloor: 43,
    economicFloor: 45,
    laneReserve: 100_000,
    minOrderAmount: 1_000,
    minOrderNotional: 45_000,
    maxDealAmount: 1_000,
    cooldownTicks: 1_000,
    rollingWindowTicks: 30_000,
    rollingMaxAmount: MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT,
    inventoryReferenceAmount: 5_000,
    rollingOpportunityReserveAmount: 1_000,
    maxRawOrdersScanned: 1_000,
    maxEligibleOrdersPriced: 200,
    maxTransactionEnergy: 1_000,
    terminalEnergyReserve: 25_000,
    listingBuffer: 0.03,
    directNetBidRatio: 0.85,
    maxDailyDynamicDrop: 0.15,
    surplusLow: 1,
    surplusHigh: 3,
    dynamicFloorMode: "enforce",
  },
]);

function marketBaseResourcePolicyFingerprint(
  policy: RawMarketBaseResourcePolicy,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:resource-policy-v1",
    policy,
    schemaVersion: MARKET_BASE_RESOURCE_SCHEMA_VERSION,
  });
}

/**
 * 重算单个 resource policy 的指纹。历史 permit 内嵌的 policy 可能是
 * 旧常量版本（字段集合与当前不同），只要按其实际字段重算能对上内嵌
 * fingerprint，就视为自洽。仅依赖 recipe domain/schemaVersion 稳定。
 */
export function computeMarketBaseResourcePolicyFingerprint(
  policy: Omit<MarketBaseResourcePolicy, "fingerprint">,
): string {
  return marketBaseResourcePolicyFingerprint(policy);
}

export const MARKET_BASE_RESOURCE_POLICIES = deepFreeze<
  readonly MarketBaseResourcePolicy[]
>(
  RAW_MARKET_BASE_RESOURCE_POLICIES.map((policy) => ({
    ...policy,
    fingerprint: marketBaseResourcePolicyFingerprint(policy),
  })).sort(
    (left, right) =>
      MARKET_BASE_RESOURCE_CATALOG.indexOf(left.resource) -
      MARKET_BASE_RESOURCE_CATALOG.indexOf(right.resource),
  ),
);

export const MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE = deepFreeze<
  Record<MarketBaseResource, MarketBaseResourcePolicy>
>(
  Object.fromEntries(
    MARKET_BASE_RESOURCE_POLICIES.map((policy) => [policy.resource, policy]),
  ) as Record<MarketBaseResource, MarketBaseResourcePolicy>,
);

export function marketBaseResourcePolicy(
  resource: unknown,
): MarketBaseResourcePolicy | undefined {
  return isMarketBaseResource(resource)
    ? MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource]
    : undefined;
}

export interface MarketBaseFloorBootstrapEntry {
  readonly observedFloor: number;
  readonly ratchetFloor: number;
}

export interface MarketBaseFloorBootstrap {
  readonly bootstrapRevision: typeof MARKET_BASE_RESOURCE_BOOTSTRAP_REVISION;
  readonly historyDate: typeof MARKET_BASE_RESOURCE_BOOTSTRAP_HISTORY_DATE;
  readonly evidenceSha256: typeof MARKET_BASE_RESOURCE_EVIDENCE_SHA256;
  readonly implementationBlob: typeof MARKET_BASE_RESOURCE_EVIDENCE_IMPLEMENTATION_BLOB;
  readonly resources: Readonly<
    Record<MarketBaseResource, MarketBaseFloorBootstrapEntry>
  >;
  readonly fingerprint: string;
}

const RAW_MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP = deepFreeze({
  bootstrapRevision: MARKET_BASE_RESOURCE_BOOTSTRAP_REVISION,
  historyDate: MARKET_BASE_RESOURCE_BOOTSTRAP_HISTORY_DATE,
  evidenceSha256: MARKET_BASE_RESOURCE_EVIDENCE_SHA256,
  implementationBlob: MARKET_BASE_RESOURCE_EVIDENCE_IMPLEMENTATION_BLOB,
  resources: {
    H: { observedFloor: 433.765, ratchetFloor: 433.765 },
    K: { observedFloor: 100.914, ratchetFloor: 100.914 },
    L: { observedFloor: 168.132, ratchetFloor: 168.132 },
    O: { observedFloor: 128.524, ratchetFloor: 128.524 },
    U: { observedFloor: 45.939, ratchetFloor: 45.939 },
    X: { observedFloor: 559.43, ratchetFloor: 559.43 },
    Z: { observedFloor: 41.623, ratchetFloor: 41.623 },
  },
});

export const MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP =
  deepFreeze<MarketBaseFloorBootstrap>({
    ...RAW_MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
    fingerprint: canonicalStableHashV1({
      bootstrap: RAW_MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
      domain: "market-base-resource:floor-bootstrap-v1",
      schemaVersion: MARKET_BASE_RESOURCE_SCHEMA_VERSION,
    }),
  });

export interface MarketBaseFloorBootstrapValidation {
  readonly valid: boolean;
  readonly invalidReasons: readonly string[];
}

export function validateMarketBaseFloorBootstrap(
  rawValue: unknown,
  options: {
    readonly previousFingerprint?: string;
    readonly minimumHistoryDate?: string;
  } = {},
): MarketBaseFloorBootstrapValidation {
  const reasons: string[] = [];
  if (options.previousFingerprint !== undefined) {
    addReason(reasons, "base_floor_bootstrap_duplicate");
  }
  if (!isPlainRecord(rawValue)) {
    return {
      valid: false,
      invalidReasons: deepFreeze([
        ...reasons,
        "base_floor_bootstrap_shape_invalid",
      ]),
    };
  }
  if (rawValue.bootstrapRevision !== MARKET_BASE_RESOURCE_BOOTSTRAP_REVISION) {
    addReason(reasons, "base_floor_bootstrap_revision_mismatch");
  }
  if (rawValue.historyDate !== MARKET_BASE_RESOURCE_BOOTSTRAP_HISTORY_DATE) {
    addReason(reasons, "base_floor_bootstrap_history_date_mismatch");
  }
  if (
    typeof options.minimumHistoryDate === "string" &&
    typeof rawValue.historyDate === "string" &&
    rawValue.historyDate < options.minimumHistoryDate
  ) {
    addReason(reasons, "base_floor_bootstrap_history_date_rollback");
  }
  if (rawValue.evidenceSha256 !== MARKET_BASE_RESOURCE_EVIDENCE_SHA256) {
    addReason(reasons, "base_floor_bootstrap_evidence_digest_mismatch");
  }
  if (
    rawValue.implementationBlob !==
    MARKET_BASE_RESOURCE_EVIDENCE_IMPLEMENTATION_BLOB
  ) {
    addReason(reasons, "base_floor_bootstrap_algorithm_mismatch");
  }
  const resources = isPlainRecord(rawValue.resources)
    ? rawValue.resources
    : undefined;
  if (!resources) {
    addReason(reasons, "base_floor_bootstrap_resources_invalid");
  } else {
    const keys = Object.keys(resources).sort();
    if (!exactStringArray(keys, MARKET_BASE_RESOURCE_CATALOG_SORTED)) {
      addReason(reasons, "base_floor_bootstrap_resource_set_mismatch");
    }
    for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
      const entry = resources[resource];
      const expected = MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[resource];
      if (
        !isPlainRecord(entry) ||
        entry.observedFloor !== expected.observedFloor ||
        entry.ratchetFloor !== expected.ratchetFloor
      ) {
        addReason(reasons, `base_floor_bootstrap_value_mismatch:${resource}`);
      }
    }
  }
  if (
    rawValue.fingerprint !== MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint
  ) {
    addReason(reasons, "base_floor_bootstrap_fingerprint_mismatch");
  }
  return {
    valid: reasons.length === 0,
    invalidReasons: deepFreeze(reasons.sort()),
  };
}

interface CanonicalEvidenceResource {
  readonly completeDays: readonly [string, number, number, number, number][];
  readonly acceptedDates: readonly string[];
  readonly rejectedCompleteDays: readonly {
    readonly date: string;
    readonly reason: string;
  }[];
  readonly excludedPartialDates: readonly string[];
  readonly acceptedTransactions: number;
  readonly acceptedVolume: number;
  readonly medianLogPrice: number;
  readonly madLogPrice: number;
  readonly referencePrice: number;
  readonly trusted95Floor: number;
}

export interface MarketBaseFloorEvidenceValidation {
  readonly valid: boolean;
  readonly invalidReasons: readonly string[];
  readonly rowCount: number;
}

const CANONICAL_EVIDENCE_ROOT_KEYS = [
  "algorithm",
  "completeEnd",
  "completeStart",
  "dateAnchor",
  "policy",
  "resources",
  "schema",
  "source",
] as const;

const CANONICAL_EVIDENCE_RESOURCE_KEYS = [
  "acceptedDates",
  "acceptedTransactions",
  "acceptedVolume",
  "completeDays",
  "excludedPartialDates",
  "madLogPrice",
  "medianLogPrice",
  "referencePrice",
  "rejectedCompleteDays",
  "trusted95Floor",
] as const;

const CANONICAL_EVIDENCE_ALGORITHM = deepFreeze({
  minValidDays: 7,
  minTransactionsPerDay: 100,
  minVolumePerDay: 100_000,
  logMadScale: 1.4826,
  logMadZThreshold: 3.5,
  maxSqrtVolumeWeightMultiple: 3,
  historyFloorRatio: 0.95,
  rounding: "ceil-to-0.001",
  windowRule: "exclude drifting oldest rolling-window day and current UTC day",
  implementationBlob: MARKET_BASE_RESOURCE_EVIDENCE_IMPLEMENTATION_BLOB,
});

function sameNumber(left: unknown, right: number): boolean {
  return (
    typeof left === "number" &&
    Number.isFinite(left) &&
    Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(right)) * 8
  );
}

// 2026-07-28 的 bootstrap 证据是历史事实，后续签名 policy 迁移不应
// 反过来改写该文件。新价格校准另附当期市场证据。
const JULY_BOOTSTRAP_POLICY = deepFreeze({
  H: { hard: 428, economic: 451 },
  K: { hard: 96, economic: 101 },
  L: { hard: 161, economic: 169 },
  O: { hard: 138, economic: 145 },
  U: { hard: 44, economic: 46 },
  X: { hard: 480, economic: 480 },
  Z: { hard: 43, economic: 45 },
} as const);

function evidencePolicyMatches(
  raw: Record<string, unknown>,
  resource: MarketBaseResource,
): boolean {
  const entry = raw[resource];
  const policy = JULY_BOOTSTRAP_POLICY[resource];
  const bootstrap = MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[resource];
  return Boolean(
    isPlainRecord(entry) &&
    entry.hard === policy.hard &&
    entry.economic === policy.economic &&
    entry.bootstrapRatchet === bootstrap.ratchetFloor &&
    exactStringArray(Object.keys(entry).sort(), [
      "bootstrapRatchet",
      "economic",
      "hard",
    ]),
  );
}

function parseCanonicalEvidenceResource(
  value: unknown,
  resource: MarketBaseResource,
  reasons: string[],
): CanonicalEvidenceResource | undefined {
  if (!isPlainRecord(value)) {
    addReason(reasons, `floor_evidence_resource_shape:${resource}`);
    return undefined;
  }
  if (
    !exactStringArray(
      Object.keys(value).sort(),
      CANONICAL_EVIDENCE_RESOURCE_KEYS,
    )
  ) {
    addReason(reasons, `floor_evidence_resource_keys:${resource}`);
  }
  const completeDays = value.completeDays;
  if (!Array.isArray(completeDays) || completeDays.length !== 13) {
    addReason(reasons, `floor_evidence_complete_days:${resource}`);
    return undefined;
  }
  const parsedDays: Array<[string, number, number, number, number]> = [];
  for (const rawDay of completeDays) {
    if (
      !Array.isArray(rawDay) ||
      rawDay.length !== 5 ||
      typeof rawDay[0] !== "string" ||
      !Number.isSafeInteger(rawDay[1]) ||
      !isFinitePositive(rawDay[2]) ||
      !isFinitePositive(rawDay[3]) ||
      !isFinitePositive(rawDay[4])
    ) {
      addReason(reasons, `floor_evidence_day_shape:${resource}`);
      return undefined;
    }
    parsedDays.push([rawDay[0], rawDay[1], rawDay[2], rawDay[3], rawDay[4]]);
  }
  const expectedDates = Array.from(
    { length: 13 },
    (_value, index) => `2026-07-${String(index + 15).padStart(2, "0")}`,
  );
  if (
    !exactStringArray(
      parsedDays.map((day) => day[0]),
      expectedDates,
    )
  ) {
    addReason(reasons, `floor_evidence_date_window:${resource}`);
  }
  if (
    !Array.isArray(value.acceptedDates) ||
    !value.acceptedDates.every((date) => typeof date === "string") ||
    !Array.isArray(value.rejectedCompleteDays) ||
    !Array.isArray(value.excludedPartialDates)
  ) {
    addReason(reasons, `floor_evidence_result_shape:${resource}`);
    return undefined;
  }
  return {
    completeDays: parsedDays,
    acceptedDates: value.acceptedDates as string[],
    rejectedCompleteDays:
      value.rejectedCompleteDays as CanonicalEvidenceResource["rejectedCompleteDays"],
    excludedPartialDates: value.excludedPartialDates as string[],
    acceptedTransactions: value.acceptedTransactions as number,
    acceptedVolume: value.acceptedVolume as number,
    medianLogPrice: value.medianLogPrice as number,
    madLogPrice: value.madLogPrice as number,
    referencePrice: value.referencePrice as number,
    trusted95Floor: value.trusted95Floor as number,
  };
}

export function verifyMarketBaseFloorEvidence(
  rawValue: unknown,
): MarketBaseFloorEvidenceValidation {
  const reasons: string[] = [];
  let rowCount = 0;
  if (!isPlainRecord(rawValue)) {
    return {
      valid: false,
      invalidReasons: deepFreeze(["floor_evidence_shape_invalid"]),
      rowCount,
    };
  }
  if (
    !exactStringArray(
      Object.keys(rawValue).sort(),
      CANONICAL_EVIDENCE_ROOT_KEYS,
    )
  ) {
    addReason(reasons, "floor_evidence_root_keys");
  }
  const fixedRootValues = [
    rawValue.schema === "market-base-floor-evidence-v1",
    rawValue.dateAnchor === "2026-07-28",
    rawValue.completeStart === "2026-07-15",
    rawValue.completeEnd === "2026-07-27",
    rawValue.source === "Screeps GET /api/game/market/stats shard1",
  ];
  if (!fixedRootValues.every(Boolean)) {
    addReason(reasons, "floor_evidence_identity_mismatch");
  }
  if (
    !isPlainRecord(rawValue.algorithm) ||
    canonicalStableHashV1(rawValue.algorithm) !==
      canonicalStableHashV1(CANONICAL_EVIDENCE_ALGORITHM)
  ) {
    addReason(reasons, "floor_evidence_algorithm_mismatch");
  }
  const policyRecord = isPlainRecord(rawValue.policy)
    ? rawValue.policy
    : undefined;
  if (
    !policyRecord ||
    !exactStringArray(
      Object.keys(policyRecord).sort(),
      MARKET_BASE_RESOURCE_CATALOG_SORTED,
    )
  ) {
    addReason(reasons, "floor_evidence_policy_set_mismatch");
  }
  const resourcesRecord = isPlainRecord(rawValue.resources)
    ? rawValue.resources
    : undefined;
  if (
    !resourcesRecord ||
    !exactStringArray(
      Object.keys(resourcesRecord).sort(),
      MARKET_BASE_RESOURCE_CATALOG_SORTED,
    )
  ) {
    addReason(reasons, "floor_evidence_resource_set_mismatch");
  }
  if (!policyRecord || !resourcesRecord) {
    return {
      valid: false,
      invalidReasons: deepFreeze(reasons.sort()),
      rowCount,
    };
  }

  for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
    if (!evidencePolicyMatches(policyRecord, resource)) {
      addReason(reasons, `floor_evidence_policy_mismatch:${resource}`);
    }
    const evidence = parseCanonicalEvidenceResource(
      resourcesRecord[resource],
      resource,
      reasons,
    );
    if (!evidence) continue;
    rowCount += evidence.completeDays.length;
    if (
      !exactStringArray(evidence.excludedPartialDates, [
        "2026-07-14",
        "2026-07-28",
      ])
    ) {
      addReason(reasons, `floor_evidence_partial_dates:${resource}`);
    }
    const historyDays: MarketHistoryDay[] = evidence.completeDays.map(
      ([date, transactions, volume, avgPrice, stddevPrice]) => ({
        resourceType: resource,
        date,
        transactions,
        volume,
        avgPrice,
        stddevPrice,
        complete: true,
      }),
    );
    const recomputed = buildTrustedHistoryFloor(historyDays, {
      asOfDate: "2026-07-28",
      resourceType: resource,
      minValidDays: 7,
      minTransactionsPerDay: 100,
      minVolumePerDay: 100_000,
      logMadZThreshold: 3.5,
      maxSqrtVolumeWeightMultiple: 3,
      historyFloorRatio: 0.95,
    });
    const recomputedRejected = recomputed.rejectedDays
      .filter((day) => day.reason === "log_mad_outlier")
      .map((day) => ({ date: day.date, reason: day.reason }));
    const acceptedSet = new Set(recomputed.acceptedDates);
    const acceptedRows = evidence.completeDays.filter(([date]) =>
      acceptedSet.has(date),
    );
    const acceptedTransactions = acceptedRows.reduce(
      (sum, row) => sum + row[1],
      0,
    );
    const acceptedVolume = acceptedRows.reduce((sum, row) => sum + row[2], 0);
    if (
      !recomputed.trusted ||
      recomputed.completeDayCount !== 13 ||
      !exactStringArray(recomputed.acceptedDates, evidence.acceptedDates) ||
      canonicalStableHashV1(recomputedRejected) !==
        canonicalStableHashV1(evidence.rejectedCompleteDays) ||
      acceptedTransactions !== evidence.acceptedTransactions ||
      acceptedVolume !== evidence.acceptedVolume ||
      !sameNumber(recomputed.medianLogPrice, evidence.medianLogPrice) ||
      !sameNumber(recomputed.madLogPrice, evidence.madLogPrice) ||
      !sameNumber(recomputed.referencePrice, evidence.referencePrice) ||
      recomputed.trustedFloor !== evidence.trusted95Floor ||
      evidence.trusted95Floor !==
        MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[resource].observedFloor
    ) {
      addReason(reasons, `floor_evidence_recompute_mismatch:${resource}`);
    }
  }
  if (rowCount !== 91) {
    addReason(reasons, "floor_evidence_row_count_mismatch");
  }
  return {
    valid: reasons.length === 0,
    invalidReasons: deepFreeze(reasons.sort()),
    rowCount,
  };
}

export interface MarketBaseResourceRawConfigValidation {
  readonly valid: boolean;
  readonly invalidReasons: readonly string[];
  readonly canonical?: {
    readonly sellResources: readonly MarketBaseResource[];
    readonly hardFloor: Readonly<Record<MarketBaseResource, number>>;
    readonly economicFloor: Readonly<Record<MarketBaseResource, number>>;
    readonly forecastBuffer: Readonly<Record<MarketBaseResource, number>>;
    readonly fingerprint: string;
  };
}

export interface MarketBaseResourceRawConfigParse {
  readonly valid: boolean;
  readonly invalidReasons: readonly string[];
  readonly parsed?: {
    readonly sellResources: readonly MarketBaseResource[];
    readonly hardFloor: Readonly<Record<MarketBaseResource, number>>;
    readonly economicFloor: Readonly<Record<MarketBaseResource, number>>;
    readonly forecastBuffer: Readonly<Record<MarketBaseResource, number>>;
  };
}

function validateExactThresholdMap(
  rawValue: unknown,
  field: "hardFloor" | "economicFloor" | "forecastBuffer",
  reasons: string[],
): Record<MarketBaseResource, number> | undefined {
  if (!isPlainRecord(rawValue)) {
    addReason(reasons, `base_resource_${field}_shape_invalid`);
    return undefined;
  }
  const keys = Object.keys(rawValue).sort();
  for (const key of keys) {
    if (!isMarketBaseResource(key)) {
      addReason(reasons, `base_resource_${field}_extra_key:${key}`);
    }
  }
  const parsed: Partial<Record<MarketBaseResource, number>> = {};
  for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
    if (!Object.prototype.hasOwnProperty.call(rawValue, resource)) {
      addReason(reasons, `base_resource_${field}_missing_key:${resource}`);
      continue;
    }
    const expectedPolicy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
    const expected =
      field === "hardFloor"
        ? expectedPolicy.hardFloor
        : field === "economicFloor"
          ? expectedPolicy.economicFloor
          : expectedPolicy.laneReserve;
    const value = rawValue[resource];
    if (!isFinitePositive(value)) {
      addReason(reasons, `base_resource_${field}_value_invalid:${resource}`);
    } else if (value !== expected) {
      addReason(reasons, `base_resource_${field}_value_mismatch:${resource}`);
    }
    parsed[resource] = value as number;
  }
  if (!exactStringArray(keys, MARKET_BASE_RESOURCE_CATALOG_SORTED)) {
    return undefined;
  }
  return parsed as Record<MarketBaseResource, number>;
}

/**
 * Raw V3 config 的唯一精确 parser。它完成公开 validator 的全部 shape、
 * catalog 与 threshold 检查，但刻意不物化 canonical fingerprint，供只需要
 * mismatch reasons 的 hot path 复用。
 */
export function parseMarketBaseResourceRawConfig(
  rawValue: unknown,
): MarketBaseResourceRawConfigParse {
  const reasons: string[] = [];
  if (!isPlainRecord(rawValue)) {
    return {
      valid: false,
      invalidReasons: deepFreeze(["base_resource_config_shape_invalid"]),
    };
  }
  const resources = rawValue.sellResources;
  if (!Array.isArray(resources)) {
    addReason(reasons, "base_resource_sell_resources_shape_invalid");
  } else {
    const seen = new Set<string>();
    for (const rawResource of resources) {
      if (typeof rawResource !== "string") {
        addReason(reasons, "base_resource_sell_resource_invalid_type");
        continue;
      }
      if (seen.has(rawResource)) {
        addReason(
          reasons,
          `base_resource_sell_resource_duplicate:${rawResource}`,
        );
      }
      seen.add(rawResource);
      if (!isMarketBaseResource(rawResource)) {
        addReason(
          reasons,
          `base_resource_sell_resource_forbidden:${rawResource}`,
        );
      }
    }
    for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
      if (!seen.has(resource)) {
        addReason(reasons, `base_resource_sell_resource_missing:${resource}`);
      }
    }
  }
  const hardFloor = validateExactThresholdMap(
    rawValue.hardFloor,
    "hardFloor",
    reasons,
  );
  const economicFloor = validateExactThresholdMap(
    rawValue.economicFloor,
    "economicFloor",
    reasons,
  );
  const forecastBuffer = validateExactThresholdMap(
    rawValue.forecastBuffer,
    "forecastBuffer",
    reasons,
  );
  if (reasons.length > 0 || !hardFloor || !economicFloor || !forecastBuffer) {
    return {
      valid: false,
      invalidReasons: deepFreeze(reasons.sort()),
    };
  }
  const parsed = {
    sellResources: MARKET_BASE_RESOURCE_CATALOG,
    hardFloor,
    economicFloor,
    forecastBuffer,
  };
  return {
    valid: true,
    invalidReasons: deepFreeze([]),
    parsed: deepFreeze(parsed),
  };
}

export function validateMarketBaseResourceRawConfig(
  rawValue: unknown,
): MarketBaseResourceRawConfigValidation {
  const result = parseMarketBaseResourceRawConfig(rawValue);
  if (!result.valid || !result.parsed) {
    return result;
  }
  return {
    valid: true,
    invalidReasons: result.invalidReasons,
    canonical: deepFreeze({
      ...result.parsed,
      fingerprint: canonicalStableHashV1({
        config: result.parsed,
        domain: "market-base-resource:raw-config-v1",
        revision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
      }),
    }),
  };
}

export interface MarketBaseRoomAdmissionPolicy {
  readonly revision: "owned-visible-terminal-v1";
  readonly accountIdentity: string;
  readonly controllerMyRequired: true;
  readonly visibilityRequired: true;
  readonly terminalRequired: true;
  readonly terminalOwnedRequired: true;
  readonly autoAdmit: true;
  readonly maxRooms: typeof MARKET_BASE_RESOURCE_MAX_ROOMS;
  readonly fingerprint: string;
}

const marketBaseRoomAdmissionPolicyCache = new Map<
  string,
  MarketBaseRoomAdmissionPolicy
>();

export function createMarketBaseRoomAdmissionPolicy(
  accountIdentity: string,
): MarketBaseRoomAdmissionPolicy {
  if (
    typeof accountIdentity !== "string" ||
    accountIdentity.trim() !== accountIdentity ||
    accountIdentity.length === 0
  ) {
    throw new TypeError("account identity must be a non-empty stable string");
  }
  const cached = marketBaseRoomAdmissionPolicyCache.get(accountIdentity);
  if (cached) return cached;
  const payload = {
    revision: "owned-visible-terminal-v1" as const,
    accountIdentity,
    controllerMyRequired: true as const,
    visibilityRequired: true as const,
    terminalRequired: true as const,
    terminalOwnedRequired: true as const,
    autoAdmit: true as const,
    maxRooms: MARKET_BASE_RESOURCE_MAX_ROOMS,
  };
  const policy = deepFreeze({
    ...payload,
    fingerprint: canonicalStableHashV1({
      domain: "market-base-resource:room-admission-policy-v1",
      payload,
      schemaVersion: MARKET_BASE_RESOURCE_SCHEMA_VERSION,
    }),
  });
  marketBaseRoomAdmissionPolicyCache.set(accountIdentity, policy);
  return policy;
}

export interface MarketBaseLaneDerivationPolicy {
  readonly revision: "base-mineral-room-lane-v1";
  readonly maxKnownRoomNames: typeof MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES;
  readonly maxLanes: typeof MARKET_BASE_RESOURCE_MAX_LANES;
  readonly maxRoomTombstones: typeof MARKET_BASE_RESOURCE_MAX_ROOM_TOMBSTONES;
  readonly maxLaneTombstones: typeof MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES;
  readonly maxShadowLanesPerCycle: typeof MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE;
  readonly fingerprint: string;
}

const RAW_MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY = deepFreeze({
  revision: "base-mineral-room-lane-v1" as const,
  maxKnownRoomNames: MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES,
  maxLanes: MARKET_BASE_RESOURCE_MAX_LANES,
  maxRoomTombstones: MARKET_BASE_RESOURCE_MAX_ROOM_TOMBSTONES,
  maxLaneTombstones: MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES,
  maxShadowLanesPerCycle: MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE,
});

export const MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY =
  deepFreeze<MarketBaseLaneDerivationPolicy>({
    ...RAW_MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY,
    fingerprint: canonicalStableHashV1({
      domain: "market-base-resource:lane-derivation-policy-v1",
      payload: RAW_MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY,
      schemaVersion: MARKET_BASE_RESOURCE_SCHEMA_VERSION,
    }),
  });

export interface MarketBaseSharedPolicy {
  readonly schemaVersion: typeof MARKET_BASE_RESOURCE_SCHEMA_VERSION;
  readonly engineRevision: typeof MARKET_BASE_RESOURCE_ENGINE_REVISION;
  readonly catalogRevision: typeof MARKET_BASE_RESOURCE_CATALOG_REVISION;
  readonly catalog: readonly MarketBaseResource[];
  readonly energyDisposition: "fuel_only_never_sell";
  readonly resourcePolicyFingerprints: readonly string[];
  readonly roomAdmissionPolicy: MarketBaseRoomAdmissionPolicy;
  readonly laneDerivationPolicy: MarketBaseLaneDerivationPolicy;
  readonly fingerprint: string;
}

const marketBaseSharedPolicyCache = new Map<string, MarketBaseSharedPolicy>();

export function createMarketBaseSharedPolicy(
  accountIdentity: string,
): MarketBaseSharedPolicy {
  const cached = marketBaseSharedPolicyCache.get(accountIdentity);
  if (cached) return cached;
  const payload = {
    schemaVersion: MARKET_BASE_RESOURCE_SCHEMA_VERSION,
    engineRevision: MARKET_BASE_RESOURCE_ENGINE_REVISION,
    catalogRevision: MARKET_BASE_RESOURCE_CATALOG_REVISION,
    catalog: MARKET_BASE_RESOURCE_CATALOG,
    energyDisposition: "fuel_only_never_sell" as const,
    resourcePolicyFingerprints: MARKET_BASE_RESOURCE_POLICIES.map(
      (policy) => policy.fingerprint,
    ).sort(),
    roomAdmissionPolicy: createMarketBaseRoomAdmissionPolicy(accountIdentity),
    laneDerivationPolicy: MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY,
  };
  const policy = deepFreeze({
    ...payload,
    fingerprint: canonicalStableHashV1({
      domain: "market-base-resource:shared-policy-v1",
      payload,
    }),
  });
  marketBaseSharedPolicyCache.set(accountIdentity, policy);
  return policy;
}

export interface MarketBaseRoomObservation {
  readonly roomName: string;
  readonly visible: boolean;
  readonly controllerMy: boolean;
  readonly controllerOwner?: string;
  readonly terminalId?: string;
  readonly terminalOwned: boolean;
  readonly roomClass: MarketBaseRoomClass;
}

export interface MarketBaseSellerRoomState {
  readonly roomInstanceId: string;
  readonly roomName: string;
  readonly incarnation: number;
  readonly previousInstanceId: string | null;
  readonly roomClass: MarketBaseRoomClass;
  readonly controllerOwner: string;
  readonly terminalId: string;
  readonly admissionRevision: MarketBaseRoomAdmissionPolicy["revision"];
  readonly status: "admitted";
  readonly fingerprint: string;
}

export interface MarketBaseRoomTombstone extends Omit<
  MarketBaseSellerRoomState,
  "status"
> {
  readonly status: "suspended_tombstone";
  readonly retiredAt: number;
}

export interface MarketBaseRoomIncarnationRecord {
  readonly roomName: string;
  readonly incarnationHighWater: number;
  readonly lastInstanceId: string;
  readonly admitted: boolean;
  readonly current?: MarketBaseSellerRoomState;
}

export interface MarketBaseRoomTombstonePrefixHighWater {
  readonly roomName: string;
  readonly compressedCount: number;
  readonly incarnationHighWater: number;
  readonly firstInstanceId: string;
  readonly lastInstanceId: string;
  readonly lastRetiredAt: number;
  readonly roomPrefixHead: string;
}

export interface MarketBaseRoomTombstonePrefixCheckpoint {
  readonly schemaVersion: 1;
  readonly hashRevision: typeof MARKET_BASE_RESOURCE_ROOM_TOMBSTONE_PREFIX_HASH_REVISION;
  readonly compressedCount: number;
  readonly compressedFirstTombstoneFingerprint: string;
  readonly compressedLastTombstoneFingerprint: string;
  readonly compressedPrefixHead: string;
  readonly roomHighWater: readonly MarketBaseRoomTombstonePrefixHighWater[];
  readonly checkpointCommitment: string;
}

export interface MarketBaseRoomIncarnationRegistry {
  readonly schemaVersion: 1;
  readonly admissionPolicyFingerprint: string;
  readonly lastReconciledTick: number;
  readonly lastObservationFingerprint: string;
  readonly knownRoomNames: readonly string[];
  readonly rooms: Readonly<Record<string, MarketBaseRoomIncarnationRecord>>;
  readonly tombstonePrefixCheckpoint: MarketBaseRoomTombstonePrefixCheckpoint;
  readonly recentTombstones: readonly MarketBaseRoomTombstone[];
  readonly checkpointCommitment: string;
}

export interface ReconcileMarketBaseSellerRoomsInput {
  readonly tick: number;
  readonly admissionPolicy: MarketBaseRoomAdmissionPolicy;
  readonly observations: readonly MarketBaseRoomObservation[];
  readonly previous?: MarketBaseRoomIncarnationRegistry;
  /**
   * Permit/checkpoint 保存的上一状态 commitment。传入后可检测“registry 与
   * 自身 checkpoint 一起被回拨”的情况。
   */
  readonly expectedPreviousCheckpointCommitment?: string;
}

export type ReconcileMarketBaseSellerRoomsResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly state: MarketBaseRoomIncarnationRegistry;
      readonly sellerRooms: readonly MarketBaseSellerRoomState[];
    }
  | {
      readonly ok: false;
      readonly blockers: readonly string[];
    };

function validRoomObservationShape(
  value: unknown,
): value is MarketBaseRoomObservation {
  return Boolean(
    isPlainRecord(value) &&
    typeof value.roomName === "string" &&
    value.roomName.length > 0 &&
    typeof value.visible === "boolean" &&
    typeof value.controllerMy === "boolean" &&
    (value.controllerOwner === undefined ||
      (typeof value.controllerOwner === "string" &&
        value.controllerOwner.length > 0)) &&
    (value.terminalId === undefined ||
      (typeof value.terminalId === "string" && value.terminalId.length > 0)) &&
    typeof value.terminalOwned === "boolean" &&
    (value.roomClass === "normal" || value.roomClass === "hub"),
  );
}

export function marketBaseRoomObservationIsAdmitted(
  observation: MarketBaseRoomObservation,
  policy: MarketBaseRoomAdmissionPolicy,
): boolean {
  return Boolean(
    observation.visible &&
    observation.controllerMy &&
    observation.controllerOwner === policy.accountIdentity &&
    typeof observation.terminalId === "string" &&
    observation.terminalId.length > 0 &&
    observation.terminalOwned,
  );
}

interface MarketBaseRoomIdentityInput {
  readonly roomName: string;
  readonly incarnation: number;
  readonly previousInstanceId: string | null;
  readonly controllerOwner: string;
  readonly terminalId: string;
  readonly roomClass: MarketBaseRoomClass;
  readonly admissionRevision: string;
}

const MARKET_BASE_RESOURCE_PURE_HASH_CACHE_LIMIT = 2_048;

function memoizedMarketBaseResourcePureHash(
  cache: Map<string, string>,
  key: string,
  compute: () => string,
): string {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = compute();
  // 输入均来自有界 room/lane 身份。仍设置硬上限，避免长期 room churn
  // 把纯函数 memo 表变成无界全局内存；淘汰只影响 CPU，不影响结果。
  if (key.length <= 2_048) {
    if (cache.size >= MARKET_BASE_RESOURCE_PURE_HASH_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }
  return value;
}

const marketBaseRoomInstanceIdCache = new Map<string, string>();
const marketBaseSellerRoomFingerprintCache = new Map<string, string>();
const marketBaseLaneIdCache = new Map<string, string>();
const marketBaseLaneStableFingerprintCache = new Map<string, string>();

export function deriveMarketBaseRoomInstanceId(
  input: MarketBaseRoomIdentityInput,
): string {
  if (
    typeof input.roomName !== "string" ||
    input.roomName.length === 0 ||
    !Number.isSafeInteger(input.incarnation) ||
    input.incarnation <= 0 ||
    typeof input.controllerOwner !== "string" ||
    input.controllerOwner.length === 0 ||
    typeof input.terminalId !== "string" ||
    input.terminalId.length === 0 ||
    (input.roomClass !== "normal" && input.roomClass !== "hub") ||
    typeof input.admissionRevision !== "string" ||
    input.admissionRevision.length === 0 ||
    (input.previousInstanceId !== null &&
      (typeof input.previousInstanceId !== "string" ||
        input.previousInstanceId.length === 0))
  ) {
    throw new TypeError("invalid seller room identity");
  }
  const key = JSON.stringify([
    input.admissionRevision,
    input.controllerOwner,
    input.incarnation,
    input.previousInstanceId,
    input.roomClass,
    input.roomName,
    input.terminalId,
  ]);
  return memoizedMarketBaseResourcePureHash(
    marketBaseRoomInstanceIdCache,
    key,
    () =>
      `mbr-room:${canonicalStableHashV1({
        admissionRevision: input.admissionRevision,
        controllerOwner: input.controllerOwner,
        domain: "market-base-resource:room-instance-v1",
        incarnation: input.incarnation,
        previousInstanceId: input.previousInstanceId,
        roomClass: input.roomClass,
        roomName: input.roomName,
        terminalId: input.terminalId,
      })}`,
  );
}

function sellerRoomFingerprint(
  room: Omit<MarketBaseSellerRoomState, "fingerprint">,
): string {
  const key = JSON.stringify([
    room.roomInstanceId,
    room.roomName,
    room.incarnation,
    room.previousInstanceId,
    room.roomClass,
    room.controllerOwner,
    room.terminalId,
    room.admissionRevision,
    room.status,
  ]);
  return memoizedMarketBaseResourcePureHash(
    marketBaseSellerRoomFingerprintCache,
    key,
    () =>
      canonicalStableHashV1({
        domain: "market-base-resource:seller-room-state-v1",
        room,
      }),
  );
}

function createSellerRoomState(
  observation: MarketBaseRoomObservation,
  policy: MarketBaseRoomAdmissionPolicy,
  incarnation: number,
  previousInstanceId: string | null,
): MarketBaseSellerRoomState {
  const identity: MarketBaseRoomIdentityInput = {
    roomName: observation.roomName,
    incarnation,
    previousInstanceId,
    controllerOwner: observation.controllerOwner!,
    terminalId: observation.terminalId!,
    roomClass: observation.roomClass,
    admissionRevision: policy.revision,
  };
  const withoutFingerprint = {
    roomInstanceId: deriveMarketBaseRoomInstanceId(identity),
    roomName: identity.roomName,
    incarnation: identity.incarnation,
    previousInstanceId: identity.previousInstanceId,
    roomClass: identity.roomClass,
    controllerOwner: identity.controllerOwner,
    terminalId: identity.terminalId,
    admissionRevision: policy.revision,
    status: "admitted" as const,
  };
  return deepFreeze({
    ...withoutFingerprint,
    fingerprint: sellerRoomFingerprint(withoutFingerprint),
  });
}

function roomStateMatchesObservation(
  state: MarketBaseSellerRoomState,
  observation: MarketBaseRoomObservation,
  policy: MarketBaseRoomAdmissionPolicy,
): boolean {
  return (
    state.roomName === observation.roomName &&
    state.controllerOwner === observation.controllerOwner &&
    state.terminalId === observation.terminalId &&
    state.roomClass === observation.roomClass &&
    state.admissionRevision === policy.revision
  );
}

function roomTombstone(
  state: MarketBaseSellerRoomState,
  retiredAt: number,
): MarketBaseRoomTombstone {
  const { status: _status, ...rest } = state;
  return deepFreeze({
    ...rest,
    status: "suspended_tombstone" as const,
    retiredAt,
  });
}

const MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE = canonicalStableHashV1(
  "market-base-resource:no-compressed-room-tombstone-v1",
);

type MarketBaseRoomTombstonePrefixCheckpointWithoutCommitment = Omit<
  MarketBaseRoomTombstonePrefixCheckpoint,
  "checkpointCommitment"
>;

function roomTombstoneFingerprint(tombstone: MarketBaseRoomTombstone): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:room-tombstone-v1",
    tombstone,
  });
}

function compareRoomTombstones(
  left: MarketBaseRoomTombstone,
  right: MarketBaseRoomTombstone,
): number {
  return (
    left.retiredAt - right.retiredAt ||
    left.roomName.localeCompare(right.roomName) ||
    left.incarnation - right.incarnation ||
    left.roomInstanceId.localeCompare(right.roomInstanceId)
  );
}

function roomTombstonePrefixCheckpointPayload(
  checkpoint: MarketBaseRoomTombstonePrefixCheckpointWithoutCommitment,
): unknown {
  return {
    domain: "market-base-resource:room-tombstone-prefix-checkpoint-v1",
    ...checkpoint,
  };
}

function buildRoomTombstonePrefixCheckpoint(
  input: Omit<
    MarketBaseRoomTombstonePrefixCheckpointWithoutCommitment,
    "roomHighWater"
  > & {
    readonly roomHighWater: readonly MarketBaseRoomTombstonePrefixHighWater[];
  },
): MarketBaseRoomTombstonePrefixCheckpoint {
  const withoutCommitment = deepFreeze({
    ...input,
    roomHighWater: [...input.roomHighWater].sort((left, right) =>
      left.roomName.localeCompare(right.roomName),
    ),
  });
  return deepFreeze({
    ...withoutCommitment,
    checkpointCommitment: canonicalStableHashV1(
      roomTombstonePrefixCheckpointPayload(withoutCommitment),
    ),
  });
}

function emptyRoomTombstonePrefixCheckpoint(): MarketBaseRoomTombstonePrefixCheckpoint {
  return buildRoomTombstonePrefixCheckpoint({
    schemaVersion: 1,
    hashRevision: MARKET_BASE_RESOURCE_ROOM_TOMBSTONE_PREFIX_HASH_REVISION,
    compressedCount: 0,
    compressedFirstTombstoneFingerprint:
      MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE,
    compressedLastTombstoneFingerprint:
      MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE,
    compressedPrefixHead: MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE,
    roomHighWater: [],
  });
}

type FoldRoomTombstonePrefixResult =
  | {
      readonly ok: true;
      readonly checkpoint: MarketBaseRoomTombstonePrefixCheckpoint;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function foldRoomTombstonePrefix(
  checkpoint: MarketBaseRoomTombstonePrefixCheckpoint,
  tombstone: MarketBaseRoomTombstone,
): FoldRoomTombstonePrefixResult {
  const compressedCount = checkpoint.compressedCount + 1;
  if (!Number.isSafeInteger(compressedCount)) {
    return {
      ok: false,
      reason: "room_incarnation_prefix_count_exhausted",
    };
  }
  const roomHighWater = new Map(
    checkpoint.roomHighWater.map((entry) => [entry.roomName, entry]),
  );
  const previous = roomHighWater.get(tombstone.roomName);
  const expectedIncarnation = (previous?.incarnationHighWater ?? 0) + 1;
  const expectedPreviousInstanceId = previous?.lastInstanceId ?? null;
  if (
    !Number.isSafeInteger(expectedIncarnation) ||
    tombstone.incarnation !== expectedIncarnation ||
    tombstone.previousInstanceId !== expectedPreviousInstanceId ||
    (previous !== undefined && tombstone.retiredAt <= previous.lastRetiredAt)
  ) {
    return {
      ok: false,
      reason: `room_incarnation_prefix_chain_invalid:${tombstone.roomName}`,
    };
  }
  const tombstoneFingerprint = roomTombstoneFingerprint(tombstone);
  const roomCompressedCount = (previous?.compressedCount ?? 0) + 1;
  const roomPrefixHead = canonicalStableHashV1({
    domain: "market-base-resource:room-tombstone-room-prefix-link-v1",
    compressedCount: roomCompressedCount,
    incarnation: tombstone.incarnation,
    previousPrefixHead:
      previous?.roomPrefixHead ??
      MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE,
    roomInstanceId: tombstone.roomInstanceId,
    roomName: tombstone.roomName,
    tombstoneFingerprint,
  });
  roomHighWater.set(tombstone.roomName, {
    roomName: tombstone.roomName,
    compressedCount: roomCompressedCount,
    incarnationHighWater: tombstone.incarnation,
    firstInstanceId: previous?.firstInstanceId ?? tombstone.roomInstanceId,
    lastInstanceId: tombstone.roomInstanceId,
    lastRetiredAt: tombstone.retiredAt,
    roomPrefixHead,
  });
  return {
    ok: true,
    checkpoint: buildRoomTombstonePrefixCheckpoint({
      schemaVersion: 1,
      hashRevision: MARKET_BASE_RESOURCE_ROOM_TOMBSTONE_PREFIX_HASH_REVISION,
      compressedCount,
      compressedFirstTombstoneFingerprint:
        checkpoint.compressedCount === 0
          ? tombstoneFingerprint
          : checkpoint.compressedFirstTombstoneFingerprint,
      compressedLastTombstoneFingerprint: tombstoneFingerprint,
      compressedPrefixHead: canonicalStableHashV1({
        compressedCount,
        domain: "market-base-resource:room-tombstone-prefix-link-v1",
        previousPrefixHead: checkpoint.compressedPrefixHead,
        roomInstanceId: tombstone.roomInstanceId,
        roomName: tombstone.roomName,
        tombstoneFingerprint,
      }),
      roomHighWater: [...roomHighWater.values()],
    }),
  };
}

function validRoomTombstonePrefixCheckpoint(
  value: unknown,
): value is MarketBaseRoomTombstonePrefixCheckpoint {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "checkpointCommitment",
      "compressedCount",
      "compressedFirstTombstoneFingerprint",
      "compressedLastTombstoneFingerprint",
      "compressedPrefixHead",
      "hashRevision",
      "roomHighWater",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    value.hashRevision !==
      MARKET_BASE_RESOURCE_ROOM_TOMBSTONE_PREFIX_HASH_REVISION ||
    !Number.isSafeInteger(value.compressedCount) ||
    (value.compressedCount as number) < 0 ||
    !isCanonicalStableDigest(value.compressedFirstTombstoneFingerprint) ||
    !isCanonicalStableDigest(value.compressedLastTombstoneFingerprint) ||
    !isCanonicalStableDigest(value.compressedPrefixHead) ||
    !Array.isArray(value.roomHighWater) ||
    value.roomHighWater.length > MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES ||
    !isCanonicalStableDigest(value.checkpointCommitment)
  ) {
    return false;
  }
  const compressedCount = value.compressedCount as number;
  if (
    compressedCount === 0
      ? value.compressedFirstTombstoneFingerprint !==
          MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE ||
        value.compressedLastTombstoneFingerprint !==
          MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE ||
        value.compressedPrefixHead !==
          MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE ||
        value.roomHighWater.length !== 0
      : value.compressedFirstTombstoneFingerprint ===
          MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE ||
        value.compressedLastTombstoneFingerprint ===
          MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE ||
        value.compressedPrefixHead ===
          MARKET_BASE_RESOURCE_NO_COMPRESSED_ROOM_TOMBSTONE ||
        value.roomHighWater.length === 0
  ) {
    return false;
  }
  let summedCompressedCount = 0;
  let previousRoomName = "";
  for (const rawEntry of value.roomHighWater) {
    if (
      !isPlainRecord(rawEntry) ||
      !hasExactKeys(rawEntry, [
        "compressedCount",
        "firstInstanceId",
        "incarnationHighWater",
        "lastInstanceId",
        "lastRetiredAt",
        "roomName",
        "roomPrefixHead",
      ]) ||
      typeof rawEntry.roomName !== "string" ||
      rawEntry.roomName.length === 0 ||
      rawEntry.roomName <= previousRoomName ||
      !Number.isSafeInteger(rawEntry.compressedCount) ||
      (rawEntry.compressedCount as number) <= 0 ||
      !Number.isSafeInteger(rawEntry.incarnationHighWater) ||
      rawEntry.incarnationHighWater !== rawEntry.compressedCount ||
      !isRoomInstanceId(rawEntry.firstInstanceId) ||
      !isRoomInstanceId(rawEntry.lastInstanceId) ||
      !Number.isSafeInteger(rawEntry.lastRetiredAt) ||
      (rawEntry.lastRetiredAt as number) < 0 ||
      !isCanonicalStableDigest(rawEntry.roomPrefixHead)
    ) {
      return false;
    }
    summedCompressedCount += rawEntry.compressedCount as number;
    if (!Number.isSafeInteger(summedCompressedCount)) return false;
    previousRoomName = rawEntry.roomName;
  }
  if (summedCompressedCount !== compressedCount) return false;
  const withoutCommitment = {
    schemaVersion: 1 as const,
    hashRevision: value.hashRevision,
    compressedCount,
    compressedFirstTombstoneFingerprint:
      value.compressedFirstTombstoneFingerprint,
    compressedLastTombstoneFingerprint:
      value.compressedLastTombstoneFingerprint,
    compressedPrefixHead: value.compressedPrefixHead,
    roomHighWater:
      value.roomHighWater as readonly MarketBaseRoomTombstonePrefixHighWater[],
  };
  return (
    value.checkpointCommitment ===
    canonicalStableHashV1(
      roomTombstonePrefixCheckpointPayload(withoutCommitment),
    )
  );
}

function roomRegistryCheckpointPayload(
  state: Omit<MarketBaseRoomIncarnationRegistry, "checkpointCommitment">,
): unknown {
  return {
    admissionPolicyFingerprint: state.admissionPolicyFingerprint,
    domain: "market-base-resource:room-incarnation-checkpoint-v1",
    knownRoomNames: state.knownRoomNames,
    lastObservationFingerprint: state.lastObservationFingerprint,
    lastReconciledTick: state.lastReconciledTick,
    recentTombstones: state.recentTombstones,
    rooms: Object.keys(state.rooms)
      .sort()
      .map((roomName) => state.rooms[roomName]),
    schemaVersion: state.schemaVersion,
    tombstonePrefixCheckpoint: state.tombstonePrefixCheckpoint,
  };
}

export function marketBaseRoomRegistryCheckpointCommitment(
  state: Omit<MarketBaseRoomIncarnationRegistry, "checkpointCommitment">,
): string {
  return canonicalStableHashV1(roomRegistryCheckpointPayload(state));
}

function validateSellerRoomState(
  state: unknown,
  policy: MarketBaseRoomAdmissionPolicy,
): state is MarketBaseSellerRoomState {
  if (!isPlainRecord(state)) return false;
  if (
    typeof state.roomInstanceId !== "string" ||
    typeof state.roomName !== "string" ||
    !Number.isSafeInteger(state.incarnation) ||
    (state.incarnation as number) <= 0 ||
    (state.previousInstanceId !== null &&
      typeof state.previousInstanceId !== "string") ||
    (state.roomClass !== "normal" && state.roomClass !== "hub") ||
    state.controllerOwner !== policy.accountIdentity ||
    typeof state.terminalId !== "string" ||
    state.admissionRevision !== policy.revision ||
    state.status !== "admitted" ||
    typeof state.fingerprint !== "string"
  ) {
    return false;
  }
  const withoutFingerprint = {
    roomInstanceId: state.roomInstanceId,
    roomName: state.roomName,
    incarnation: state.incarnation,
    previousInstanceId: state.previousInstanceId,
    roomClass: state.roomClass,
    controllerOwner: state.controllerOwner,
    terminalId: state.terminalId,
    admissionRevision: state.admissionRevision,
    status: state.status,
  } as Omit<MarketBaseSellerRoomState, "fingerprint">;
  let expectedId: string;
  try {
    expectedId = deriveMarketBaseRoomInstanceId(withoutFingerprint);
  } catch {
    return false;
  }
  return (
    state.roomInstanceId === expectedId &&
    state.fingerprint === sellerRoomFingerprint(withoutFingerprint)
  );
}

function validateRoomIncarnationRegistry(
  state: unknown,
  policy: MarketBaseRoomAdmissionPolicy,
): string[] {
  const reasons: string[] = [];
  if (!isPlainRecord(state)) {
    return ["room_incarnation_registry_shape_invalid"];
  }
  if (
    state.schemaVersion !== 1 ||
    state.admissionPolicyFingerprint !== policy.fingerprint ||
    !Number.isSafeInteger(state.lastReconciledTick) ||
    (state.lastReconciledTick as number) < 0 ||
    typeof state.lastObservationFingerprint !== "string" ||
    !Array.isArray(state.knownRoomNames) ||
    !state.knownRoomNames.every(
      (roomName) => typeof roomName === "string" && roomName.length > 0,
    ) ||
    !isPlainRecord(state.rooms) ||
    !isPlainRecord(state.tombstonePrefixCheckpoint) ||
    !Array.isArray(state.recentTombstones) ||
    typeof state.checkpointCommitment !== "string"
  ) {
    return ["room_incarnation_registry_shape_invalid"];
  }
  const knownRoomNames = state.knownRoomNames as string[];
  if (
    !exactStringArray(knownRoomNames, sortedUnique(knownRoomNames)) ||
    knownRoomNames.length > MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES
  ) {
    addReason(reasons, "room_incarnation_known_rooms_invalid");
  }
  if (
    !exactStringArray(
      Object.keys(state.rooms).sort(),
      [...knownRoomNames].sort(),
    )
  ) {
    addReason(reasons, "room_incarnation_room_map_mismatch");
  }
  let admittedCount = 0;
  for (const roomName of knownRoomNames) {
    const record = state.rooms[roomName];
    if (
      !isPlainRecord(record) ||
      record.roomName !== roomName ||
      !Number.isSafeInteger(record.incarnationHighWater) ||
      (record.incarnationHighWater as number) <= 0 ||
      !isRoomInstanceId(record.lastInstanceId) ||
      typeof record.admitted !== "boolean"
    ) {
      addReason(reasons, `room_incarnation_record_invalid:${roomName}`);
      continue;
    }
    if (record.admitted) {
      admittedCount += 1;
      if (
        !validateSellerRoomState(record.current, policy) ||
        record.current.roomName !== roomName ||
        record.current.incarnation !== record.incarnationHighWater ||
        record.current.roomInstanceId !== record.lastInstanceId
      ) {
        addReason(reasons, `room_incarnation_current_invalid:${roomName}`);
      }
    } else if (record.current !== undefined) {
      addReason(
        reasons,
        `room_incarnation_inactive_current_present:${roomName}`,
      );
    }
  }
  if (admittedCount > MARKET_BASE_RESOURCE_MAX_ROOMS) {
    addReason(reasons, "room_incarnation_active_rooms_exceeded");
  }
  const prefixCheckpoint = validRoomTombstonePrefixCheckpoint(
    state.tombstonePrefixCheckpoint,
  )
    ? state.tombstonePrefixCheckpoint
    : undefined;
  if (!prefixCheckpoint) {
    addReason(reasons, "room_incarnation_tombstone_prefix_invalid");
  } else if (
    prefixCheckpoint.roomHighWater.some(
      (entry) => !knownRoomNames.includes(entry.roomName),
    )
  ) {
    addReason(reasons, "room_incarnation_tombstone_prefix_unknown_room");
  } else if (
    prefixCheckpoint.roomHighWater.some(
      (entry) => entry.lastRetiredAt > (state.lastReconciledTick as number),
    )
  ) {
    addReason(reasons, "room_incarnation_tombstone_prefix_future");
  }
  if (
    state.recentTombstones.length > MARKET_BASE_RESOURCE_MAX_ROOM_TOMBSTONES
  ) {
    addReason(reasons, "room_incarnation_tombstones_exceeded");
  }
  const tombstoneIds = new Set<string>();
  const validTombstonesInOrder: MarketBaseRoomTombstone[] = [];
  const tombstonesByRoom = new Map<string, MarketBaseRoomTombstone[]>();
  for (const rawTombstone of state.recentTombstones) {
    if (
      !isPlainRecord(rawTombstone) ||
      rawTombstone.status !== "suspended_tombstone" ||
      !Number.isSafeInteger(rawTombstone.retiredAt) ||
      (rawTombstone.retiredAt as number) < 0 ||
      (rawTombstone.retiredAt as number) > (state.lastReconciledTick as number)
    ) {
      addReason(reasons, "room_incarnation_tombstone_invalid");
      continue;
    }
    const { retiredAt: _retiredAt, ...tombstoneProjection } = rawTombstone;
    const sellerProjection = {
      ...tombstoneProjection,
      status: "admitted" as const,
    };
    if (
      !validateSellerRoomState(sellerProjection, policy) ||
      tombstoneIds.has(rawTombstone.roomInstanceId as string) ||
      !knownRoomNames.includes(rawTombstone.roomName as string)
    ) {
      addReason(reasons, "room_incarnation_tombstone_invalid");
      continue;
    }
    tombstoneIds.add(rawTombstone.roomInstanceId as string);
    const tombstone = rawTombstone as unknown as MarketBaseRoomTombstone;
    validTombstonesInOrder.push(tombstone);
    const roomTombstones = tombstonesByRoom.get(tombstone.roomName) ?? [];
    roomTombstones.push(tombstone);
    tombstonesByRoom.set(tombstone.roomName, roomTombstones);
  }
  if (
    validTombstonesInOrder.length === state.recentTombstones.length &&
    !exactStringArray(
      validTombstonesInOrder.map((entry) => entry.roomInstanceId),
      [...validTombstonesInOrder]
        .sort(compareRoomTombstones)
        .map((entry) => entry.roomInstanceId),
    )
  ) {
    addReason(reasons, "room_incarnation_tombstones_order_invalid");
  }
  const prefixByRoom = new Map(
    prefixCheckpoint?.roomHighWater.map((entry) => [entry.roomName, entry]) ??
      [],
  );
  for (const roomName of knownRoomNames) {
    const record = state.rooms[roomName];
    if (
      !isPlainRecord(record) ||
      !Number.isSafeInteger(record.incarnationHighWater) ||
      typeof record.admitted !== "boolean"
    ) {
      continue;
    }
    const prefix = prefixByRoom.get(roomName);
    let retiredIncarnationHighWater = prefix?.incarnationHighWater ?? 0;
    let previousInstanceId = prefix?.lastInstanceId ?? null;
    let previousRetiredAt = prefix?.lastRetiredAt ?? -1;
    const roomTombstones = [...(tombstonesByRoom.get(roomName) ?? [])].sort(
      (left, right) =>
        left.incarnation - right.incarnation ||
        left.retiredAt - right.retiredAt ||
        left.roomInstanceId.localeCompare(right.roomInstanceId),
    );
    for (const tombstone of roomTombstones) {
      if (
        tombstone.incarnation !== retiredIncarnationHighWater + 1 ||
        tombstone.previousInstanceId !== previousInstanceId ||
        tombstone.retiredAt <= previousRetiredAt
      ) {
        addReason(
          reasons,
          `room_incarnation_tombstone_chain_invalid:${roomName}`,
        );
        break;
      }
      retiredIncarnationHighWater = tombstone.incarnation;
      previousInstanceId = tombstone.roomInstanceId;
      previousRetiredAt = tombstone.retiredAt;
    }
    const expectedRetiredIncarnationHighWater =
      (record.incarnationHighWater as number) - (record.admitted ? 1 : 0);
    if (retiredIncarnationHighWater !== expectedRetiredIncarnationHighWater) {
      addReason(reasons, `room_incarnation_history_gap:${roomName}`);
      continue;
    }
    if (record.admitted) {
      if (
        !validateSellerRoomState(record.current, policy) ||
        record.current.incarnation !== retiredIncarnationHighWater + 1 ||
        record.current.previousInstanceId !== previousInstanceId
      ) {
        addReason(
          reasons,
          `room_incarnation_previous_chain_invalid:${roomName}`,
        );
      }
    } else if (record.lastInstanceId !== previousInstanceId) {
      addReason(reasons, `room_incarnation_retired_tip_invalid:${roomName}`);
    }
  }
  const withoutCommitment = {
    schemaVersion: state.schemaVersion,
    admissionPolicyFingerprint: state.admissionPolicyFingerprint,
    lastReconciledTick: state.lastReconciledTick,
    lastObservationFingerprint: state.lastObservationFingerprint,
    knownRoomNames,
    rooms: state.rooms,
    tombstonePrefixCheckpoint: state.tombstonePrefixCheckpoint,
    recentTombstones: state.recentTombstones,
  } as unknown as Omit<
    MarketBaseRoomIncarnationRegistry,
    "checkpointCommitment"
  >;
  if (
    state.checkpointCommitment !==
    marketBaseRoomRegistryCheckpointCommitment(withoutCommitment)
  ) {
    addReason(reasons, "room_incarnation_checkpoint_mismatch");
  }
  return reasons.sort();
}

function currentSellerRooms(
  state: MarketBaseRoomIncarnationRegistry,
): readonly MarketBaseSellerRoomState[] {
  return deepFreeze(
    state.knownRoomNames
      .map((roomName) => state.rooms[roomName])
      .filter(
        (
          record,
        ): record is MarketBaseRoomIncarnationRecord & {
          current: MarketBaseSellerRoomState;
        } => record.admitted && record.current !== undefined,
      )
      .map((record) => record.current)
      .sort((left, right) => left.roomName.localeCompare(right.roomName)),
  );
}

export function reconcileMarketBaseSellerRooms(
  input: ReconcileMarketBaseSellerRoomsInput,
): ReconcileMarketBaseSellerRoomsResult {
  const blockers: string[] = [];
  if (!Number.isSafeInteger(input.tick) || input.tick < 0) {
    return {
      ok: false,
      blockers: deepFreeze(["room_observation_tick_invalid"]),
    };
  }
  const observationNames = new Set<string>();
  for (const observation of input.observations) {
    if (!validRoomObservationShape(observation)) {
      addReason(blockers, "room_observation_shape_invalid");
      continue;
    }
    if (observationNames.has(observation.roomName)) {
      addReason(blockers, `room_observation_duplicate:${observation.roomName}`);
    }
    observationNames.add(observation.roomName);
  }
  if (input.previous) {
    for (const reason of validateRoomIncarnationRegistry(
      input.previous,
      input.admissionPolicy,
    )) {
      addReason(blockers, reason);
    }
    if (
      input.expectedPreviousCheckpointCommitment !== undefined &&
      input.expectedPreviousCheckpointCommitment !==
        input.previous.checkpointCommitment
    ) {
      addReason(blockers, "room_incarnation_external_checkpoint_mismatch");
    }
    if (input.tick < input.previous.lastReconciledTick) {
      addReason(blockers, "room_incarnation_tick_rollback");
    }
  } else if (input.expectedPreviousCheckpointCommitment !== undefined) {
    addReason(blockers, "room_incarnation_previous_state_missing");
  }
  if (blockers.length > 0) {
    return { ok: false, blockers: deepFreeze(blockers.sort()) };
  }

  const admittedObservations = input.observations
    .filter((observation) =>
      marketBaseRoomObservationIsAdmitted(observation, input.admissionPolicy),
    )
    .sort((left, right) => left.roomName.localeCompare(right.roomName));
  if (admittedObservations.length > MARKET_BASE_RESOURCE_MAX_ROOMS) {
    return {
      ok: false,
      blockers: deepFreeze(["room_admission_max_rooms_exceeded"]),
    };
  }
  const observationFingerprint = canonicalStableHashV1({
    admissionPolicyFingerprint: input.admissionPolicy.fingerprint,
    domain: "market-base-resource:room-observation-v1",
    observations: admittedObservations,
  });
  if (input.previous && input.tick === input.previous.lastReconciledTick) {
    if (observationFingerprint !== input.previous.lastObservationFingerprint) {
      return {
        ok: false,
        blockers: deepFreeze(["room_observation_same_tick_conflict"]),
      };
    }
    return {
      ok: true,
      changed: false,
      state: input.previous,
      sellerRooms: currentSellerRooms(input.previous),
    };
  }

  const previousRooms = input.previous?.rooms ?? {};
  const nextRooms: Record<string, MarketBaseRoomIncarnationRecord> = {};
  const tombstones = [...(input.previous?.recentTombstones ?? [])];
  let tombstonePrefixCheckpoint =
    input.previous?.tombstonePrefixCheckpoint ??
    emptyRoomTombstonePrefixCheckpoint();
  const admittedByName = new Map(
    admittedObservations.map((observation) => [
      observation.roomName,
      observation,
    ]),
  );
  const nextKnownRoomNames = sortedUnique([
    ...(input.previous?.knownRoomNames ?? []),
    ...admittedObservations.map((observation) => observation.roomName),
  ]);
  if (nextKnownRoomNames.length > MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES) {
    return {
      ok: false,
      blockers: deepFreeze(["room_admission_known_rooms_exceeded"]),
    };
  }

  for (const roomName of nextKnownRoomNames) {
    const previous = previousRooms[roomName];
    const observation = admittedByName.get(roomName);
    if (!observation) {
      if (!previous) {
        return {
          ok: false,
          blockers: deepFreeze([
            `room_incarnation_previous_record_missing:${roomName}`,
          ]),
        };
      }
      if (previous.admitted && previous.current) {
        tombstones.push(roomTombstone(previous.current, input.tick));
      }
      nextRooms[roomName] = deepFreeze({
        roomName,
        incarnationHighWater: previous.incarnationHighWater,
        lastInstanceId: previous.lastInstanceId,
        admitted: false,
      });
      continue;
    }
    if (!previous) {
      const current = createSellerRoomState(
        observation,
        input.admissionPolicy,
        1,
        null,
      );
      nextRooms[roomName] = deepFreeze({
        roomName,
        incarnationHighWater: 1,
        lastInstanceId: current.roomInstanceId,
        admitted: true,
        current,
      });
      continue;
    }
    if (
      previous.admitted &&
      previous.current &&
      roomStateMatchesObservation(
        previous.current,
        observation,
        input.admissionPolicy,
      )
    ) {
      nextRooms[roomName] = previous;
      continue;
    }
    if (previous.admitted && previous.current) {
      tombstones.push(roomTombstone(previous.current, input.tick));
    }
    const nextIncarnation = previous.incarnationHighWater + 1;
    if (!Number.isSafeInteger(nextIncarnation)) {
      return {
        ok: false,
        blockers: deepFreeze([
          `room_incarnation_high_water_exhausted:${roomName}`,
        ]),
      };
    }
    const current = createSellerRoomState(
      observation,
      input.admissionPolicy,
      nextIncarnation,
      previous.lastInstanceId,
    );
    nextRooms[roomName] = deepFreeze({
      roomName,
      incarnationHighWater: nextIncarnation,
      lastInstanceId: current.roomInstanceId,
      admitted: true,
      current,
    });
  }
  tombstones.sort(compareRoomTombstones);
  const compressionCount =
    tombstones.length - MARKET_BASE_RESOURCE_MAX_ROOM_TOMBSTONES;
  for (let index = 0; index < Math.max(0, compressionCount); index += 1) {
    const tombstone = tombstones[index];
    const folded = foldRoomTombstonePrefix(
      tombstonePrefixCheckpoint,
      tombstone,
    );
    if ("reason" in folded) {
      return {
        ok: false,
        blockers: deepFreeze([folded.reason]),
      };
    }
    tombstonePrefixCheckpoint = folded.checkpoint;
  }
  const recentTombstones =
    compressionCount > 0 ? tombstones.slice(compressionCount) : tombstones;
  const withoutCommitment = deepFreeze({
    schemaVersion: 1 as const,
    admissionPolicyFingerprint: input.admissionPolicy.fingerprint,
    lastReconciledTick: input.tick,
    lastObservationFingerprint: observationFingerprint,
    knownRoomNames: nextKnownRoomNames,
    rooms: nextRooms,
    tombstonePrefixCheckpoint,
    recentTombstones,
  });
  const state = deepFreeze<MarketBaseRoomIncarnationRegistry>({
    ...withoutCommitment,
    checkpointCommitment:
      marketBaseRoomRegistryCheckpointCommitment(withoutCommitment),
  });
  return {
    ok: true,
    changed:
      !input.previous ||
      state.checkpointCommitment !== input.previous.checkpointCommitment,
    state,
    sellerRooms: currentSellerRooms(state),
  };
}

export interface MarketBaseShadowEvidence {
  readonly completeCycles: number;
  readonly lastCompleteTick?: number;
  readonly evidenceDigest?: string;
}

export interface MarketBaseDerivedLaneLifecycle {
  readonly laneId: string;
  readonly resource: MarketBaseResource;
  readonly resourcePolicyId: string;
  readonly resourcePolicyFingerprint: string;
  readonly roomInstanceId: string;
  readonly sellerRoomName: string;
  readonly roomFingerprint: string;
  readonly sharedPolicyFingerprint: string;
  readonly stage: MarketBaseLaneStage;
  readonly status: MarketBaseLaneStatus;
  readonly shadowEvidence: MarketBaseShadowEvidence;
  readonly stableFingerprint: string;
}

export interface MarketBaseDerivedLaneReconciliation {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly lanes?: readonly MarketBaseDerivedLaneLifecycle[];
  readonly newLaneIds?: readonly string[];
  readonly retiredLaneIds?: readonly string[];
  readonly laneSetFingerprint?: string;
}

interface MarketBaseLaneIdentityInput {
  readonly resourcePolicyId: string;
  readonly roomInstanceId: string;
}

export function deriveMarketBaseLaneId(
  input: MarketBaseLaneIdentityInput,
): string {
  if (
    typeof input.resourcePolicyId !== "string" ||
    input.resourcePolicyId.length === 0 ||
    typeof input.roomInstanceId !== "string" ||
    input.roomInstanceId.length === 0
  ) {
    throw new TypeError("invalid derived lane identity");
  }
  const key = JSON.stringify([input.resourcePolicyId, input.roomInstanceId]);
  return memoizedMarketBaseResourcePureHash(
    marketBaseLaneIdCache,
    key,
    () =>
      `mbr-lane:${canonicalStableHashV1({
        domain: "market-base-resource:derived-lane-id-v1",
        resourcePolicyId: input.resourcePolicyId,
        roomInstanceId: input.roomInstanceId,
      })}`,
  );
}

function laneStableFingerprint(
  lane: Omit<
    MarketBaseDerivedLaneLifecycle,
    "stage" | "status" | "shadowEvidence" | "stableFingerprint"
  >,
): string {
  const key = JSON.stringify([
    lane.laneId,
    lane.resource,
    lane.resourcePolicyId,
    lane.resourcePolicyFingerprint,
    lane.roomInstanceId,
    lane.sellerRoomName,
    lane.roomFingerprint,
    lane.sharedPolicyFingerprint,
  ]);
  return memoizedMarketBaseResourcePureHash(
    marketBaseLaneStableFingerprintCache,
    key,
    () =>
      canonicalStableHashV1({
        domain: "market-base-resource:derived-lane-stable-v1",
        lane,
      }),
  );
}

function createDerivedLaneLifecycle(
  policy: MarketBaseResourcePolicy,
  room: MarketBaseSellerRoomState,
  sharedPolicyFingerprint: string,
): MarketBaseDerivedLaneLifecycle {
  const stable = {
    laneId: deriveMarketBaseLaneId({
      resourcePolicyId: policy.policyId,
      roomInstanceId: room.roomInstanceId,
    }),
    resource: policy.resource,
    resourcePolicyId: policy.policyId,
    resourcePolicyFingerprint: policy.fingerprint,
    roomInstanceId: room.roomInstanceId,
    sellerRoomName: room.roomName,
    roomFingerprint: room.fingerprint,
    sharedPolicyFingerprint,
  };
  return deepFreeze({
    ...stable,
    stage: "shadow" as const,
    status: "suspended" as const,
    shadowEvidence: {
      completeCycles: 0,
    },
    stableFingerprint: laneStableFingerprint(stable),
  });
}

const MARKET_BASE_RESOURCE_CANONICAL_DIGEST_PATTERN = /^csh1:[0-9a-f]{32}$/;

/**
 * 校验持久化 DerivedLaneLifecycle 的 canonical 形状。
 *
 * 资格证据属于 lifecycle 本身，不能只靠 permit 中另一份“自洽”的 digest
 * 反向证明。尤其 qualified 及其后续阶段必须已经绑定至少 100 个完整周期，
 * 且保留合法的最后完整 tick 与 observation digest。
 */
export function validateMarketBaseDerivedLaneLifecycle(
  lane: unknown,
): string | undefined {
  if (!isPlainRecord(lane)) {
    return "derived_lane_lifecycle_invalid";
  }
  if (
    typeof lane.laneId !== "string" ||
    lane.laneId.length === 0 ||
    !isMarketBaseResource(lane.resource) ||
    typeof lane.resourcePolicyId !== "string" ||
    lane.resourcePolicyId.length === 0 ||
    typeof lane.resourcePolicyFingerprint !== "string" ||
    lane.resourcePolicyFingerprint.length === 0 ||
    typeof lane.roomInstanceId !== "string" ||
    lane.roomInstanceId.length === 0 ||
    typeof lane.sellerRoomName !== "string" ||
    lane.sellerRoomName.length === 0 ||
    typeof lane.roomFingerprint !== "string" ||
    lane.roomFingerprint.length === 0 ||
    typeof lane.sharedPolicyFingerprint !== "string" ||
    lane.sharedPolicyFingerprint.length === 0 ||
    !["shadow", "qualified", "canary", "review_paused", "continuous"].includes(
      lane.stage as string,
    ) ||
    !["suspended", "writable", "tombstoned"].includes(lane.status as string) ||
    typeof lane.stableFingerprint !== "string" ||
    lane.stableFingerprint.length === 0
  ) {
    return "derived_lane_lifecycle_invalid";
  }
  if (!isPlainRecord(lane.shadowEvidence)) {
    return "derived_lane_shadow_evidence_invalid";
  }
  const evidenceKeys = Object.keys(lane.shadowEvidence);
  if (
    !evidenceKeys.includes("completeCycles") ||
    evidenceKeys.some(
      (key) =>
        !["completeCycles", "lastCompleteTick", "evidenceDigest"].includes(key),
    ) ||
    !Number.isSafeInteger(lane.shadowEvidence.completeCycles) ||
    (lane.shadowEvidence.completeCycles as number) < 0
  ) {
    return "derived_lane_shadow_evidence_invalid";
  }
  const completeCycles = lane.shadowEvidence.completeCycles as number;
  const hasLastCompleteTick =
    lane.shadowEvidence.lastCompleteTick !== undefined;
  const hasEvidenceDigest = lane.shadowEvidence.evidenceDigest !== undefined;
  if (
    hasLastCompleteTick !== hasEvidenceDigest ||
    (hasLastCompleteTick &&
      (!Number.isSafeInteger(lane.shadowEvidence.lastCompleteTick) ||
        (lane.shadowEvidence.lastCompleteTick as number) < 0 ||
        typeof lane.shadowEvidence.evidenceDigest !== "string" ||
        !MARKET_BASE_RESOURCE_CANONICAL_DIGEST_PATTERN.test(
          lane.shadowEvidence.evidenceDigest as string,
        )))
  ) {
    return "derived_lane_shadow_evidence_invalid";
  }
  if (
    lane.stage === "shadow" &&
    completeCycles > 0 &&
    (!hasLastCompleteTick || !hasEvidenceDigest)
  ) {
    return "derived_lane_shadow_evidence_incomplete";
  }
  if (lane.stage === "shadow" && completeCycles >= 100) {
    return "derived_lane_shadow_stage_stale";
  }
  if (
    lane.stage !== "shadow" &&
    (completeCycles < 100 || !hasLastCompleteTick || !hasEvidenceDigest)
  ) {
    return "derived_lane_qualification_evidence_incomplete";
  }
  if (
    (lane.status === "writable" &&
      lane.stage !== "canary" &&
      lane.stage !== "continuous") ||
    ((lane.stage === "shadow" ||
      lane.stage === "qualified" ||
      lane.stage === "review_paused") &&
      lane.status !== "suspended" &&
      lane.status !== "tombstoned")
  ) {
    return "derived_lane_stage_status_invalid";
  }
  const stable = {
    laneId: lane.laneId,
    resource: lane.resource,
    resourcePolicyId: lane.resourcePolicyId,
    resourcePolicyFingerprint: lane.resourcePolicyFingerprint,
    roomInstanceId: lane.roomInstanceId,
    sellerRoomName: lane.sellerRoomName,
    roomFingerprint: lane.roomFingerprint,
    sharedPolicyFingerprint: lane.sharedPolicyFingerprint,
  };
  if (
    lane.laneId !==
      deriveMarketBaseLaneId({
        resourcePolicyId: lane.resourcePolicyId,
        roomInstanceId: lane.roomInstanceId,
      }) ||
    lane.stableFingerprint !== laneStableFingerprint(stable)
  ) {
    return "derived_lane_stable_identity_invalid";
  }
  return undefined;
}

function validExistingLane(
  lane: unknown,
): lane is MarketBaseDerivedLaneLifecycle {
  return validateMarketBaseDerivedLaneLifecycle(lane) === undefined;
}

/**
 * 外层 activation anchor 与 permit append 共用的 lifecycle commitment。
 * 调用方必须把该 commitment 作为独立 high-water 持久化；append 再以当前
 * full derived scope 重算，防止只伪造 nested scope 与 grant digest。
 */
export function marketBaseDerivedLaneLifecycleCheckpointCommitment(
  lanes: readonly MarketBaseDerivedLaneLifecycle[],
): string {
  for (const lane of lanes) {
    const error = validateMarketBaseDerivedLaneLifecycle(lane);
    if (error) throw new TypeError(error);
  }
  return canonicalStableHashV1({
    domain: "market-base-resource:lane-lifecycle-checkpoint-v1",
    laneLifecycleHighWater: [...lanes]
      .sort((left, right) => left.laneId.localeCompare(right.laneId))
      .map((lane) => ({
        laneId: lane.laneId,
        stableFingerprint: lane.stableFingerprint,
        stage: lane.stage,
        status: lane.status,
        completeCycles: lane.shadowEvidence.completeCycles,
        lastCompleteTick: lane.shadowEvidence.lastCompleteTick ?? null,
        evidenceDigest: lane.shadowEvidence.evidenceDigest ?? null,
      })),
  });
}

export function marketBaseDerivedLaneSetFingerprint(
  lanes: readonly MarketBaseDerivedLaneLifecycle[],
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:dynamic-lane-set-v1",
    lanes: [...lanes]
      .sort((left, right) => left.laneId.localeCompare(right.laneId))
      .map((lane) => ({
        laneId: lane.laneId,
        stableFingerprint: lane.stableFingerprint,
      })),
  });
}

export function reconcileMarketBaseDerivedLanes(input: {
  readonly sharedPolicyFingerprint: string;
  readonly sellerRooms: readonly MarketBaseSellerRoomState[];
  readonly previous?: readonly MarketBaseDerivedLaneLifecycle[];
}): MarketBaseDerivedLaneReconciliation {
  const blockers: string[] = [];
  if (
    typeof input.sharedPolicyFingerprint !== "string" ||
    input.sharedPolicyFingerprint.length === 0
  ) {
    addReason(blockers, "derived_lane_shared_fingerprint_invalid");
  }
  if (input.sellerRooms.length > MARKET_BASE_RESOURCE_MAX_ROOMS) {
    addReason(blockers, "derived_lane_room_bound_exceeded");
  }
  const roomNames = new Set<string>();
  const roomIds = new Set<string>();
  for (const room of input.sellerRooms) {
    if (
      !isPlainRecord(room) ||
      typeof room.roomName !== "string" ||
      typeof room.roomInstanceId !== "string" ||
      typeof room.fingerprint !== "string" ||
      room.status !== "admitted"
    ) {
      addReason(blockers, "derived_lane_room_invalid");
      continue;
    }
    if (roomNames.has(room.roomName) || roomIds.has(room.roomInstanceId)) {
      addReason(blockers, "derived_lane_duplicate_room");
    }
    roomNames.add(room.roomName);
    roomIds.add(room.roomInstanceId);
  }
  const previousById = new Map<string, MarketBaseDerivedLaneLifecycle>();
  for (const lane of input.previous ?? []) {
    if (!validExistingLane(lane)) {
      addReason(blockers, "derived_lane_previous_invalid");
      continue;
    }
    if (previousById.has(lane.laneId)) {
      addReason(blockers, "derived_lane_previous_duplicate");
    }
    previousById.set(lane.laneId, lane);
  }
  if (blockers.length > 0) {
    return {
      ok: false,
      blockers: deepFreeze(blockers.sort()),
    };
  }

  const lanes: MarketBaseDerivedLaneLifecycle[] = [];
  const newLaneIds: string[] = [];
  for (const room of [...input.sellerRooms].sort((left, right) =>
    left.roomName.localeCompare(right.roomName),
  )) {
    for (const policy of MARKET_BASE_RESOURCE_POLICIES) {
      const fresh = createDerivedLaneLifecycle(
        policy,
        room,
        input.sharedPolicyFingerprint,
      );
      const previous = previousById.get(fresh.laneId);
      if (!previous) {
        lanes.push(fresh);
        newLaneIds.push(fresh.laneId);
        continue;
      }
      if (
        previous.stableFingerprint !== fresh.stableFingerprint ||
        previous.status === "tombstoned"
      ) {
        addReason(blockers, `derived_lane_identity_conflict:${fresh.laneId}`);
        continue;
      }
      lanes.push(previous);
    }
  }
  if (lanes.length > MARKET_BASE_RESOURCE_MAX_LANES) {
    addReason(blockers, "derived_lane_bound_exceeded");
  }
  if (blockers.length > 0) {
    return {
      ok: false,
      blockers: deepFreeze(blockers.sort()),
    };
  }
  lanes.sort((left, right) => left.laneId.localeCompare(right.laneId));
  const activeIds = new Set(lanes.map((lane) => lane.laneId));
  const retiredLaneIds = [...previousById.keys()]
    .filter((laneId) => !activeIds.has(laneId))
    .sort();
  return {
    ok: true,
    blockers: deepFreeze([]),
    lanes: deepFreeze(lanes),
    newLaneIds: deepFreeze(newLaneIds.sort()),
    retiredLaneIds: deepFreeze(retiredLaneIds),
    laneSetFingerprint: marketBaseDerivedLaneSetFingerprint(lanes),
  };
}

export interface MarketBaseLanePolicyMigrationResult {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly lanes?: readonly MarketBaseDerivedLaneLifecycle[];
  readonly laneSetFingerprint?: string;
  readonly fingerprintChanges?: number;
}

/**
 * 策略常量升级迁移：以当前策略指纹重铸每条 lane 的 stable 字段
 * （laneId 由 policyId+roomInstanceId 派生，policyId 集合不变则 laneId
 * 不变），原样携带 stage/status/shadowEvidence。它是显式 operator 迁移
 * 的一部分，不经过常规 reconcile——常规 reconcile 要求 stable 指纹逐字
 * 相等，会把任何策略升级判为 identity conflict。
 */
export function migrateMarketBaseDerivedLanes(input: {
  readonly previous: readonly MarketBaseDerivedLaneLifecycle[];
  readonly sharedPolicyFingerprint: string;
}): MarketBaseLanePolicyMigrationResult {
  const blockers: string[] = [];
  if (!Array.isArray(input.previous) || input.previous.length === 0) {
    return {
      ok: false,
      blockers: ["migration_previous_lanes_missing"],
    };
  }
  const policyById = new Map(
    MARKET_BASE_RESOURCE_POLICIES.map((policy) => [policy.policyId, policy]),
  );
  const seen = new Set<string>();
  const lanes: MarketBaseDerivedLaneLifecycle[] = [];
  let fingerprintChanges = 0;
  for (const previous of input.previous) {
    if (!validExistingLane(previous)) {
      blockers.push(`migration_previous_lane_invalid:${previous?.laneId}`);
      continue;
    }
    const policy = policyById.get(previous.resourcePolicyId);
    if (!policy || policy.resource !== previous.resource) {
      // policyId 是 lane 身份的一部分；迁移不允许改名/增删策略身份。
      blockers.push(`migration_policy_identity_unstable:${previous.laneId}`);
      continue;
    }
    if (seen.has(previous.laneId)) {
      blockers.push(`migration_previous_lane_duplicate:${previous.laneId}`);
      continue;
    }
    seen.add(previous.laneId);
    const stable = {
      laneId: deriveMarketBaseLaneId({
        resourcePolicyId: policy.policyId,
        roomInstanceId: previous.roomInstanceId,
      }),
      resource: policy.resource,
      resourcePolicyId: policy.policyId,
      resourcePolicyFingerprint: policy.fingerprint,
      roomInstanceId: previous.roomInstanceId,
      sellerRoomName: previous.sellerRoomName,
      roomFingerprint: previous.roomFingerprint,
      sharedPolicyFingerprint: input.sharedPolicyFingerprint,
    };
    if (stable.laneId !== previous.laneId) {
      blockers.push(`migration_lane_identity_drift:${previous.laneId}`);
      continue;
    }
    if (
      previous.resourcePolicyFingerprint !== policy.fingerprint ||
      previous.sharedPolicyFingerprint !== input.sharedPolicyFingerprint
    ) {
      fingerprintChanges += 1;
    }
    lanes.push(
      deepFreeze({
        ...stable,
        stage: previous.stage,
        status: previous.status,
        shadowEvidence: previous.shadowEvidence,
        stableFingerprint: laneStableFingerprint(stable),
      }),
    );
  }
  if (blockers.length > 0 || lanes.length === 0) {
    return {
      ok: false,
      blockers: deepFreeze(blockers.sort()),
    };
  }
  lanes.sort((left, right) => left.laneId.localeCompare(right.laneId));
  return {
    ok: true,
    blockers: deepFreeze([]),
    lanes: deepFreeze(lanes),
    laneSetFingerprint: marketBaseDerivedLaneSetFingerprint(lanes),
    fingerprintChanges,
  };
}

export interface MarketBaseDynamicFloorComputation {
  readonly inventoryFactor: number;
  readonly rawDynamicFloor: number;
}

/**
 * 动态地板纯计算（observe 投影与未来 enforce 共用）：
 * dynamicFloor = max(hardFloor, min(ratchetFloor,
 *   bookEma × (1 − (1 − directNetBidRatio) × inventoryFactor)))。
 * Direct 与 Maker 挂单溢价分离；最大折让只在保护后盈余充分时生效，
 * 且不击穿硬下限。日降幅钳制由调用方基于持久化
 * 的前值另行应用（clampMarketBaseDynamicFloorDailyDrop）。
 */
export function computeMarketBaseDynamicFloor(input: {
  readonly policy: MarketBaseResourcePolicy;
  readonly ratchetFloor: number;
  readonly bookEma: number | null;
  readonly surplusRatio: number | null;
}): MarketBaseDynamicFloorComputation {
  const { policy } = input;
  let inventoryFactor = 0;
  if (
    input.surplusRatio !== null &&
    Number.isFinite(input.surplusRatio) &&
    input.surplusRatio >= 0 &&
    policy.surplusHigh > policy.surplusLow
  ) {
    inventoryFactor = Math.min(
      1,
      Math.max(
        0,
        (input.surplusRatio - policy.surplusLow) /
          (policy.surplusHigh - policy.surplusLow),
      ),
    );
  }
  if (
    input.bookEma === null ||
    !Number.isFinite(input.bookEma) ||
    input.bookEma <= 0 ||
    !Number.isFinite(input.ratchetFloor) ||
    input.ratchetFloor <= 0
  ) {
    return { inventoryFactor, rawDynamicFloor: input.ratchetFloor };
  }
  const bookNetFloor =
    input.bookEma *
    (1 - (1 - policy.directNetBidRatio) * inventoryFactor);
  return {
    inventoryFactor,
    rawDynamicFloor: Math.max(
      policy.hardFloor,
      Math.min(input.ratchetFloor, bookNetFloor),
    ),
  };
}

/** dynamicFloor 单日最大下移钳制；daysAdvanced 聚合多日时按指数叠加。 */
export function clampMarketBaseDynamicFloorDailyDrop(input: {
  readonly target: number;
  readonly previous: number;
  readonly maxDailyDynamicDrop: number;
  readonly daysAdvanced: number;
}): number {
  if (
    !Number.isFinite(input.target) ||
    !Number.isFinite(input.previous) ||
    input.previous <= 0 ||
    !Number.isFinite(input.maxDailyDynamicDrop) ||
    input.maxDailyDynamicDrop < 0 ||
    input.maxDailyDynamicDrop >= 1 ||
    !Number.isSafeInteger(input.daysAdvanced) ||
    input.daysAdvanced < 0
  ) {
    return input.target;
  }
  const floor =
    input.previous * Math.pow(1 - input.maxDailyDynamicDrop, input.daysAdvanced);
  return Math.max(input.target, floor);
}

/**
 * 订单簿 EMA 时间常数（tick）。Screeps tick ≈ 3s，6h ≈ 7200 ticks；
 * α 按 tick 间隔自适应折算（1 − e^(−Δt/τ)），跳 tick/休眠后不突刺。
 */
export const MARKET_BASE_BOOK_EMA_TICK_TIME_CONSTANT = 7_200;

/**
 * EMA 观测最大年龄（tick）：超过后该资源的 dynamicFloor 降级为 null
 * （回退 ratchet 语义），防止陈旧 book 观测长期支配定价。
 */
export const MARKET_BASE_BOOK_EMA_MAX_AGE_TICKS =
  MARKET_BASE_BOOK_EMA_TICK_TIME_CONSTANT * 2;

/** 旧 observe 上浮报价的日锚不得成为 Direct 净价模型的执行地板。 */
export const MARKET_BASE_DYNAMIC_FLOOR_MODEL_REVISION =
  "direct-net-v2" as const;

function marketBaseIsoDayNumber(date: string): number {
  return (
    Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) /
    86_400_000
  );
}

export function updateMarketBaseBookEma(input: {
  readonly previousEma: number | null;
  readonly previousObservedAt: number;
  readonly observedPrice: number;
  readonly tick: number;
  readonly timeConstantTicks?: number;
}): { ema: number; observedAt: number } {
  const timeConstant =
    input.timeConstantTicks ?? MARKET_BASE_BOOK_EMA_TICK_TIME_CONSTANT;
  if (
    !Number.isFinite(input.observedPrice) ||
    input.observedPrice <= 0 ||
    !Number.isSafeInteger(input.tick) ||
    input.tick < 0 ||
    !Number.isFinite(timeConstant) ||
    timeConstant <= 0
  ) {
    return {
      ema: input.previousEma,
      observedAt: input.previousObservedAt,
    };
  }
  if (
    input.previousEma === null ||
    !Number.isFinite(input.previousEma) ||
    input.previousEma <= 0 ||
    !Number.isSafeInteger(input.previousObservedAt) ||
    input.previousObservedAt < 0 ||
    input.previousObservedAt > input.tick
  ) {
    // 首个有效观测直接作为 seed，不做指数拉扯。
    return { ema: input.observedPrice, observedAt: input.tick };
  }
  const elapsed = Math.max(0, input.tick - input.previousObservedAt);
  const alpha = elapsed === 0 ? 0 : 1 - Math.exp(-elapsed / timeConstant);
  return {
    ema: alpha * input.observedPrice + (1 - alpha) * input.previousEma,
    observedAt: input.tick,
  };
}

export interface MarketBaseDynamicFloorEntryState {
  readonly resource: MarketBaseResource;
  /** 订单簿最优可执行买价 EMA；无观测历史时为 null。 */
  readonly bookEma: number | null;
  /** 最近一次订单簿观测 tick（无观测为 0）。 */
  readonly bookObservedAt: number;
  /** 最近一次原始最优买价（诊断对照 EMA 滞后用）。 */
  readonly lastObservedPrice: number | null;
  /** observe 投影的 dynamicFloor（含日限幅）；EMA 未建立时为 null。 */
  readonly dynamicFloor: number | null;
  readonly inventoryFactor: number;
  /** 聚合到资源级的最大 lane 盈余比（sellable/rollingMax）。 */
  readonly surplusRatio: number | null;
  /** 当日 dynamicFloor 锚点（日降幅限幅的基准值）。 */
  readonly dailyAnchor: number;
  readonly anchorDate: string;
}

export interface MarketBaseDynamicFloorState {
  readonly schemaVersion: 1;
  readonly modelRevision: typeof MARKET_BASE_DYNAMIC_FLOOR_MODEL_REVISION;
  readonly updatedAt: number;
  readonly entries: readonly MarketBaseDynamicFloorEntryState[];
}

/**
 * enforce 提取：从动态地板投影构建"资源 → 生效地板"映射。仅纳入
 * policy.dynamicFloorMode==="enforce" 且投影 dynamicFloor 为有效正数的
 * 资源；其余资源缺席（消费方回退 observe 四分量语义）。所有消费点
 *（adapter 定价、candidatePricingComplete 重算、planner policy 注入）
 * 必须共用同一映射，保证同一 tick 内 candidate.effectiveNetFloor 的
 * 生成与校验一致（投影在本 tick 内不变）。
 */
export function marketBaseEnforcedDynamicFloors(
  projection: MarketBaseDynamicFloorState | undefined,
): Partial<Record<MarketBaseResource, number>> {
  const enforced: Partial<Record<MarketBaseResource, number>> = {};
  if (
    !projection ||
    projection.modelRevision !== MARKET_BASE_DYNAMIC_FLOOR_MODEL_REVISION
  ) return enforced;
  for (const entry of projection.entries) {
    if (
      MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[entry.resource]
        ?.dynamicFloorMode !== "enforce"
    ) {
      continue;
    }
    const floor = entry.dynamicFloor;
    if (floor !== null && Number.isFinite(floor) && floor > 0) {
      // milli 归一（向上取整到毫）：adapter 的 effectiveNetFloor 经过
      // priceToMilliUp/milliToCredits，candidatePricingComplete 以
      // <1e-9 容差对称重算——未归一的 df（EMA 任意精度浮点）会在
      // enforce 下每轮 candidate_incomplete fail-closed。
      enforced[entry.resource] = roundMarketPriceUp(floor);
    }
  }
  return enforced;
}

export interface MarketBaseDynamicFloorBookInput {
  readonly resource: MarketBaseResource;
  readonly price: number;
}

export interface MarketBaseDynamicFloorSurplusLane {
  readonly resource: MarketBaseResource;
  readonly sellable: number;
  readonly rollingMax: number;
}

/**
 * observe 模式的动态地板投影（动态层，不进 permit 签名）。每 full
 * planning tick 由调用方喂入：本 tick 订单簿最优可执行买价、各 lane
 * 保护后可售量、当前 ratchet 地板。输出只写入 runtime 投影供
 * monitor/验收窗口对账；enforce 切换前不参与 planner 合成。
 */
export function buildMarketBaseDynamicFloorState(input: {
  readonly previous: MarketBaseDynamicFloorState | undefined;
  readonly tick: number;
  readonly marketDate: string;
  readonly bookBestPrices: readonly MarketBaseDynamicFloorBookInput[];
  readonly laneSurplus: readonly MarketBaseDynamicFloorSurplusLane[];
  readonly ratchetFloorByResource: Readonly<
    Record<string, number | undefined>
  >;
}): MarketBaseDynamicFloorState {
  // 持久化的旧 observe 投影可以留作历史，但不能把旧 listingBuffer
  // 锚点移植到新 Direct 净价模型。新模型仅从本次可信 book/保护后
  // 盈余首次立锚；之后仍执行同一模型内的日降幅限制。
  const previousState =
    input.previous?.modelRevision === MARKET_BASE_DYNAMIC_FLOOR_MODEL_REVISION
      ? input.previous
      : undefined;
  const previousByResource = new Map(
    (previousState?.entries ?? []).map((entry) => [entry.resource, entry]),
  );
  const priceByResource = new Map(
    input.bookBestPrices.map((entry) => [entry.resource, entry.price]),
  );
  const surplusByResource = new Map<MarketBaseResource, number>();
  for (const lane of input.laneSurplus) {
    if (
      !Number.isFinite(lane.sellable) ||
      lane.sellable < 0 ||
      !Number.isFinite(lane.rollingMax) ||
      lane.rollingMax <= 0
    ) {
      continue;
    }
    const ratio = lane.sellable / lane.rollingMax;
    const prior = surplusByResource.get(lane.resource);
    if (prior === undefined || ratio > prior) {
      surplusByResource.set(lane.resource, ratio);
    }
  }
  const entries = MARKET_BASE_RESOURCE_CATALOG.map((resource) => {
    const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
    const previous = previousByResource.get(resource);
    const observedPrice = priceByResource.get(resource);
    const ratchetFloor = input.ratchetFloorByResource[resource];
    const emaUpdate =
      observedPrice !== undefined
        ? updateMarketBaseBookEma({
            previousEma: previous?.bookEma ?? null,
            previousObservedAt: previous?.bookObservedAt ?? 0,
            observedPrice,
            tick: input.tick,
          })
        : {
            ema: previous?.bookEma ?? null,
            observedAt: previous?.bookObservedAt ?? 0,
          };
    const surplusRatio = surplusByResource.get(resource) ?? null;
    const ratchet =
      Number.isFinite(ratchetFloor) && (ratchetFloor as number) > 0
        ? (ratchetFloor as number)
        : null;
    const bookEma =
      emaUpdate.ema !== null &&
      Number.isFinite(emaUpdate.ema) &&
      emaUpdate.ema > 0
        ? emaUpdate.ema
        : null;
    // EMA 观测年龄门槛：停滞超过两个时间常数的 EMA 不再参与 df 合成
    //（df=null 回退 ratchet 语义）。EMA 状态本身保留，恢复观测后按
    // 间隔自适应 α 平滑续算。无此门槛时陈旧 EMA 会被永久采用，且长停
    // 滞后恢复瞬间 α≈1 直接跳向新观测。
    const latestObservedAt =
      observedPrice !== undefined ? input.tick : emaUpdate.observedAt;
    const emaStale =
      bookEma !== null &&
      (!Number.isSafeInteger(latestObservedAt) ||
        input.tick - latestObservedAt > MARKET_BASE_BOOK_EMA_MAX_AGE_TICKS);
    // 库存已远超保护量时，可信的当轮可执行买价下跌应立即反映到
    // Direct 底价；EMA 继续平滑上行和一般库存。日跌幅、硬/经济底价
    // 仍对下行设限，不能由不可执行小单或瞬时低价直接击穿。
    const pricingBookReference =
      bookEma !== null &&
      observedPrice !== undefined &&
      surplusRatio !== null &&
      surplusRatio >= policy.surplusHigh
        ? Math.min(bookEma, observedPrice)
        : bookEma;
    const computation =
      !emaStale && ratchet !== null && pricingBookReference !== null
        ? computeMarketBaseDynamicFloor({
            policy,
            ratchetFloor: ratchet,
            bookEma: pricingBookReference,
            surplusRatio,
          })
        : null;
    let dynamicFloor: number | null = null;
    if (computation && bookEma !== null) {
      const sameDay =
        previous !== undefined && previous.anchorDate === input.marketDate;
      const previousAnchor = previous?.dailyAnchor ?? 0;
      if (!Number.isFinite(previousAnchor) || previousAnchor <= 0) {
        // 首次建立投影：当日首个投影值直接立锚，无限幅历史可比。
        dynamicFloor = computation.rawDynamicFloor;
      } else {
        // 同日始终沿用当日首次锚作为单日跌幅基准，不按观测次数叠降；
        // 跨日限幅基准是前日锚，限幅后的投影成为新日锚。
        // 观测中断数日时按日序差叠加限幅（允许 N 日累积降幅），否则一次
        // 跨多日的恢复会跌穿本应逐日约束的下界。
        const dayGap = previous
          ? marketBaseIsoDayNumber(input.marketDate) -
            marketBaseIsoDayNumber(previous.anchorDate)
          : 1;
        dynamicFloor = clampMarketBaseDynamicFloorDailyDrop({
          target: computation.rawDynamicFloor,
          previous: previousAnchor,
          maxDailyDynamicDrop: policy.maxDailyDynamicDrop,
          daysAdvanced: sameDay
            ? 1
            : Number.isSafeInteger(dayGap) && dayGap >= 1
              ? dayGap
              : 1,
        });
      }
      const anchor = sameDay ? previousAnchor : (dynamicFloor as number);
      return {
        resource,
        bookEma,
        bookObservedAt: emaUpdate.observedAt,
        lastObservedPrice: observedPrice ?? previous?.lastObservedPrice ?? null,
        dynamicFloor,
        inventoryFactor: computation.inventoryFactor,
        surplusRatio,
        dailyAnchor: anchor,
        anchorDate: input.marketDate,
      };
    }
    return {
      resource,
      bookEma,
      bookObservedAt: emaUpdate.observedAt,
      lastObservedPrice: observedPrice ?? previous?.lastObservedPrice ?? null,
      dynamicFloor,
      inventoryFactor: 0,
      surplusRatio,
      dailyAnchor: previous?.dailyAnchor ?? 0,
      anchorDate: previous?.anchorDate ?? "",
    };
  });
  return {
    schemaVersion: 1,
    modelRevision: MARKET_BASE_DYNAMIC_FLOOR_MODEL_REVISION,
    updatedAt: input.tick,
    entries,
  };
}
