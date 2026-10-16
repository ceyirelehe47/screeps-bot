import { AUTHORITY_EXECUTOR_SHARD, AUTHORITY_ROOMS } from "@/config/deployment";
import { DIRECT_ENGINE_ASSUMPTIONS } from "@/runtime/marketSaleDirectEngineAssumptions";

/**
 * Continuous Direct 的 policy、fingerprint、逐 entry lifecycle 与 permit 链。
 *
 * 本模块故意只处理可序列化的纯数据，不读 Game/Memory，也不依赖 Node crypto。
 * 调用方可以先在局部值上完成全部校验，再把返回的新状态一次性写入 Memory。
 */

export const MARKET_DIRECT_CONTINUOUS_CAPABILITY =
  "market-direct-continuous" as const;
export const MARKET_DIRECT_CONTINUOUS_SCHEMA = 2 as const;
export const MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD = AUTHORITY_EXECUTOR_SHARD;
export const MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS =
  "market-direct-continuous:v2:permit-genesis" as const;
export const MARKET_DIRECT_CONTINUOUS_HASH_REVISION =
  "canonicalStableHashV1" as const;
export const MARKET_DIRECT_CONTINUOUS_REQUIRED_SHADOW_CYCLES = 100;

type CanonicalScalar = null | boolean | number | string;
type CanonicalValue =
  | CanonicalScalar
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

// 同一个 Screeps tick 内，canonical root、permit、ledger 与 activation
// anchor 会被多个独立安全门重复摘要。只有对象本身及全部 object 后代都已
// 冻结时才缓存规范化序列；因此浅冻结包裹可变子对象不会被错误复用，hash
// revision 与最终字节序列也完全不变。
const canonicalStableFrozenSerializationCache = new WeakMap<object, string>();
const canonicalStableFrozenHashCache = new WeakMap<object, string>();

function canonicalChildSerializationIsImmutable(value: unknown): boolean {
  return (
    value === null ||
    typeof value !== "object" ||
    canonicalStableFrozenSerializationCache.has(value as object)
  );
}

function canonicalStableSerialize(
  value: unknown,
  active: unknown[] = [],
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical value contains a non-finite number");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`unsupported canonical value: ${typeof value}`);
  }
  const cached = canonicalStableFrozenSerializationCache.get(value);
  if (cached !== undefined) return cached;
  if (active.includes(value)) {
    throw new TypeError("canonical value contains a cycle");
  }

  active.push(value);
  try {
    if (Array.isArray(value)) {
      const serialized = `[${value
        .map((entry) => canonicalStableSerialize(entry, active))
        .join(",")}]`;
      if (
        Object.isFrozen(value) &&
        value.every(canonicalChildSerializationIsImmutable)
      ) {
        canonicalStableFrozenSerializationCache.set(value, serialized);
      }
      return serialized;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical value must contain only plain objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const serialized = `{${keys
      .map((key) => {
        if (record[key] === undefined) {
          throw new TypeError("canonical value contains undefined");
        }
        return `${JSON.stringify(key)}:${canonicalStableSerialize(
          record[key],
          active,
        )}`;
      })
      .join(",")}}`;
    if (
      Object.isFrozen(value) &&
      keys.every((key) =>
        canonicalChildSerializationIsImmutable(record[key]),
      )
    ) {
      canonicalStableFrozenSerializationCache.set(value, serialized);
    }
    return serialized;
  } finally {
    active.pop();
  }
}

function avalanche32(value: number): number {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

interface CanonicalHashPrefix {
  readonly text: string;
  readonly words: readonly [number, number, number, number];
}

const CANONICAL_HASH_PREFIX_MIN_LENGTH = 2048;
const CANONICAL_HASH_PREFIX_MAX_LENGTH = 65_536;
const CANONICAL_HASH_PREFIX_LIMIT = 8;
const canonicalHashPrefixes: CanonicalHashPrefix[] = [];

function rememberCanonicalHashPrefix(prefix: CanonicalHashPrefix): void {
  canonicalHashPrefixes.unshift(prefix);
  if (canonicalHashPrefixes.length > CANONICAL_HASH_PREFIX_LIMIT) {
    canonicalHashPrefixes.pop();
  }
}

/**
 * 稳定、排序键、无 Node 依赖的 v1 canonical hash。
 *
 * 这是误配/损坏检测用的确定性 128-bit 非加密摘要，不是抵抗能同时改代码和
 * Memory 的恶意 operator 的密码学签名。算法和输出前缀属于持久合同，变更时
 * 必须提高 revision 并使旧 shared fingerprint fail-closed。
 */
export function canonicalStableHashV1(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const cached = canonicalStableFrozenHashCache.get(value as object);
    if (cached !== undefined) return cached;
  }
  const canonical = canonicalStableSerialize(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let third = 0x85ebca6b;
  let fourth = 0xc2b2ae35;
  let start = 0;
  // 当前数据仍先完整规范化；这里只复用已逐字匹配的字符串前缀所对应的
  // 四个未 avalanche 的累积器。不是对象身份/自报 digest 的权限缓存。
  // updatedAt 等尾部变化时，后续字符照原 v1 算法继续混合，输出逐位不变。
  const prefixLength = Math.min(
    CANONICAL_HASH_PREFIX_MAX_LENGTH,
    Math.floor((canonical.length - 256) / 256) * 256,
  );
  if (prefixLength >= CANONICAL_HASH_PREFIX_MIN_LENGTH) {
    for (let entryIndex = 0; entryIndex < canonicalHashPrefixes.length; entryIndex += 1) {
      const prefix = canonicalHashPrefixes[entryIndex];
      if (canonical.startsWith(prefix.text)) {
        [first, second, third, fourth] = prefix.words;
        start = prefix.text.length;
        canonicalHashPrefixes.splice(entryIndex, 1);
        canonicalHashPrefixes.unshift(prefix);
        break;
      }
    }
  }
  const prefixEnd =
    prefixLength >= CANONICAL_HASH_PREFIX_MIN_LENGTH
      ? Math.max(start, prefixLength)
      : start;
  for (let index = start; index < prefixEnd; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    third = Math.imul(third ^ code, 0xc2b2ae35);
    fourth = Math.imul(fourth ^ code, 0x27d4eb2f);
  }
  if (prefixEnd > start) {
    rememberCanonicalHashPrefix({
      text: canonical.slice(0, prefixEnd),
      words: [first, second, third, fourth],
    });
  }
  for (let index = prefixEnd; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    third = Math.imul(third ^ code, 0xc2b2ae35);
    fourth = Math.imul(fourth ^ code, 0x27d4eb2f);
  }
  const words = [first, second, third, fourth]
    .map(avalanche32)
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
  const hash = `csh1:${words}`;
  if (
    value !== null &&
    typeof value === "object" &&
    canonicalStableFrozenSerializationCache.has(value as object)
  ) {
    canonicalStableFrozenHashCache.set(value as object, hash);
  }
  return hash;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export interface MarketDirectContinuousEntryPolicy {
  readonly entryId: string;
  readonly resourceType: ResourceConstant;
  readonly allowedRoomNames: readonly string[];
  readonly requireNativeMineral: boolean;
  readonly hardFloor: number;
  readonly economicFloor: number;
  readonly laneReserve: number;
  readonly minOrderAmount: number;
  readonly minOrderNotional: number;
  readonly maxDealAmount: number;
  readonly cooldownTicks: number;
  readonly rollingWindowTicks: number;
  readonly rollingMaxAmount: number;
  readonly rollingOpportunityReserveAmount: number;
  readonly maxRawOrdersScanned: number;
  readonly maxEligibleOrdersPriced: number;
  readonly maxTransactionEnergy: number;
  readonly terminalEnergyReserve: number;
  readonly resourcePolicyRevision: string;
}

export interface CanonicalMarketDirectContinuousEntry
  extends MarketDirectContinuousEntryPolicy {
  readonly resourceFingerprint: string;
}

export interface MarketDirectContinuousGlobalPolicy {
  readonly capability: typeof MARKET_DIRECT_CONTINUOUS_CAPABILITY;
  readonly schema: typeof MARKET_DIRECT_CONTINUOUS_SCHEMA;
  readonly executorShard: typeof MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD;
  readonly canonicalHashRevision: typeof MARKET_DIRECT_CONTINUOUS_HASH_REVISION;
  readonly plannedDealAmount: 1000;
  readonly rollingWindowTicks: 30000;
  readonly rollingMaxAmount: 12000;
  readonly minConfirmedIntervalTicks: 1000;
  readonly maxDealsPerCycle: 1;
  readonly maxActivePending: 1;
  readonly requiredShadowCycles: 100;
}

export const MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY =
  deepFreeze<MarketDirectContinuousGlobalPolicy>({
    capability: MARKET_DIRECT_CONTINUOUS_CAPABILITY,
    schema: MARKET_DIRECT_CONTINUOUS_SCHEMA,
    executorShard: MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
    canonicalHashRevision: MARKET_DIRECT_CONTINUOUS_HASH_REVISION,
    plannedDealAmount: 1_000,
    rollingWindowTicks: 30_000,
    rollingMaxAmount: 12_000,
    minConfirmedIntervalTicks: 1_000,
    maxDealsPerCycle: 1,
    maxActivePending: 1,
    requiredShadowCycles: MARKET_DIRECT_CONTINUOUS_REQUIRED_SHADOW_CYCLES,
  });

const RAW_MARKET_DIRECT_CONTINUOUS_ENTRIES =
  deepFreeze<readonly MarketDirectContinuousEntryPolicy[]>([
    {
      entryId: "base-x-e6n59-v1",
      resourceType: "X" as ResourceConstant,
      allowedRoomNames: [AUTHORITY_ROOMS.legacyXSeller],
      requireNativeMineral: false,
      hardFloor: 600,
      economicFloor: 600,
      laneReserve: 100_000,
      minOrderAmount: 1_000,
      minOrderNotional: 600_000,
      maxDealAmount: 1_000,
      cooldownTicks: 1_000,
      rollingWindowTicks: 30_000,
      rollingMaxAmount: 8_000,
      rollingOpportunityReserveAmount: 1_000,
      maxRawOrdersScanned: 1_000,
      maxEligibleOrdersPriced: 200,
      maxTransactionEnergy: 1_000,
      terminalEnergyReserve: 25_000,
      resourcePolicyRevision: "base-x-e6n59-v1",
    },
    {
      entryId: "base-h-e3n59-v1",
      resourceType: "H" as ResourceConstant,
      allowedRoomNames: [AUTHORITY_ROOMS.hydrogenSource],
      requireNativeMineral: true,
      hardFloor: 428,
      economicFloor: 451,
      laneReserve: 100_000,
      minOrderAmount: 1_000,
      minOrderNotional: 451_000,
      maxDealAmount: 1_000,
      cooldownTicks: 1_000,
      rollingWindowTicks: 30_000,
      rollingMaxAmount: 8_000,
      rollingOpportunityReserveAmount: 1_000,
      maxRawOrdersScanned: 1_000,
      maxEligibleOrdersPriced: 200,
      maxTransactionEnergy: 1_000,
      terminalEnergyReserve: 25_000,
      resourcePolicyRevision: "base-h-e3n59-v1",
    },
    {
      entryId: "base-z-e7n57-v1",
      resourceType: "Z" as ResourceConstant,
      allowedRoomNames: [AUTHORITY_ROOMS.zSeller],
      requireNativeMineral: true,
      hardFloor: 43,
      economicFloor: 45,
      laneReserve: 100_000,
      minOrderAmount: 1_000,
      minOrderNotional: 45_000,
      maxDealAmount: 1_000,
      cooldownTicks: 1_000,
      rollingWindowTicks: 30_000,
      rollingMaxAmount: 5_000,
      rollingOpportunityReserveAmount: 1_000,
      maxRawOrdersScanned: 1_000,
      maxEligibleOrdersPriced: 200,
      maxTransactionEnergy: 1_000,
      terminalEnergyReserve: 25_000,
      resourcePolicyRevision: "base-z-e7n57-v1",
    },
  ]);

function resourcePolicyPayload(
  entry: MarketDirectContinuousEntryPolicy,
): CanonicalValue {
  return {
    domain: "market-direct-continuous:resource-policy-v1",
    entry: {
      allowedRoomNames: [...entry.allowedRoomNames].sort(),
      cooldownTicks: entry.cooldownTicks,
      economicFloor: entry.economicFloor,
      entryId: entry.entryId,
      hardFloor: entry.hardFloor,
      laneReserve: entry.laneReserve,
      maxDealAmount: entry.maxDealAmount,
      maxEligibleOrdersPriced: entry.maxEligibleOrdersPriced,
      maxRawOrdersScanned: entry.maxRawOrdersScanned,
      maxTransactionEnergy: entry.maxTransactionEnergy,
      minOrderAmount: entry.minOrderAmount,
      minOrderNotional: entry.minOrderNotional,
      requireNativeMineral: entry.requireNativeMineral,
      resourcePolicyRevision: entry.resourcePolicyRevision,
      resourceType: entry.resourceType,
      rollingMaxAmount: entry.rollingMaxAmount,
      rollingOpportunityReserveAmount:
        entry.rollingOpportunityReserveAmount,
      rollingWindowTicks: entry.rollingWindowTicks,
      terminalEnergyReserve: entry.terminalEnergyReserve,
    },
    hashRevision: MARKET_DIRECT_CONTINUOUS_HASH_REVISION,
  };
}

export function marketDirectContinuousResourceFingerprint(
  entry: MarketDirectContinuousEntryPolicy,
): string {
  return canonicalStableHashV1(resourcePolicyPayload(entry));
}

export const MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE =
  deepFreeze<readonly CanonicalMarketDirectContinuousEntry[]>(
    RAW_MARKET_DIRECT_CONTINUOUS_ENTRIES.map((entry) => ({
      ...entry,
      allowedRoomNames: [...entry.allowedRoomNames].sort(),
      resourceFingerprint:
        marketDirectContinuousResourceFingerprint(entry),
    })).sort((left, right) => left.entryId.localeCompare(right.entryId)),
  );

export const MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE_FINGERPRINT =
  canonicalStableHashV1({
    domain: "market-direct-continuous:execution-table-v1",
    entries: MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  });

export function marketDirectContinuousEntry(
  entryId: string,
): CanonicalMarketDirectContinuousEntry | undefined {
  return MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
    (entry) => entry.entryId === entryId,
  );
}

export interface MarketDirectContinuousSharedFingerprintInput {
  readonly directRuntimeFingerprint: string;
  readonly engineAssumptionCommit?: string;
}

export function marketDirectContinuousSharedFingerprint(
  input: MarketDirectContinuousSharedFingerprintInput,
): string {
  if (!input.directRuntimeFingerprint) {
    throw new TypeError("Direct runtime fingerprint is required");
  }
  return canonicalStableHashV1({
    canonicalExecutionTableFingerprint:
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE_FINGERPRINT,
    domain: "market-direct-continuous:shared-policy-v1",
    engineAssumptionCommit:
      input.engineAssumptionCommit ?? DIRECT_ENGINE_ASSUMPTIONS.commit,
    globalPolicy: MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
    directRuntimeFingerprint: input.directRuntimeFingerprint,
  });
}

export function marketDirectContinuousEvidenceFingerprint(
  evidence: unknown,
): string {
  return canonicalStableHashV1({
    domain: "market-direct-continuous:reviewed-evidence-v1",
    evidence: evidence as CanonicalValue,
  });
}

/**
 * 只包含 frozen v1 DirectDealOutcome 中可逐字段证明的身份/成交字段。
 *
 * 特别不包含成交后 terminal energy 等事后 live snapshot；那些字段不属于
 * DirectDealOutcome，不能混入 legacy outcome 的 canonical digest。迁移方应
 * 把经过 v1 normalizer 验证的完整 outcome 传给下面的 fingerprint 函数。
 */
export const LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY = deepFreeze({
  entryId: "base-x-e6n59-v1",
  requestId: "direct:72585530:E6N59:X",
  status: "confirmed",
  transactionId: "6a65f8e1656d080013d32210",
  orderId: "6a65e025656d080013ccad03",
  evidenceKey:
    "6a65f8e1656d080013d32210:6a65e025656d080013ccad03",
  evidenceSource: "automatic",
  canaryRoomName: AUTHORITY_ROOMS.legacyXSeller,
  resource: "X",
  orderRoomName: AUTHORITY_ROOMS.legacyXBuyer,
  observedOrderPrice: 694.963,
  observedOrderPriceMilli: 694_963,
  submittedDealAmount: 1_000,
  transactionTime: 72_585_530,
  actualOrderType: "buy",
  actualOrderPrice: 694.963,
  actualResource: "X",
  actualFrom: AUTHORITY_ROOMS.legacyXSeller,
  actualTo: AUTHORITY_ROOMS.legacyXBuyer,
  actualAmount: 1_000,
  actualTransactionEnergy: 394,
  actualNetCreditsMilli: 682_331_360,
});

export const LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY_FINGERPRINT =
  marketDirectContinuousEvidenceFingerprint(
    LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY,
  );

/**
 * 验证 frozen outcome 的关键身份后，对调用方提供的完整 v1 outcome 做摘要。
 * 这样 config、floor、planned/worst-case、recovery fingerprint、resolvedAt 等
 * 其余 outcome 字段也全部进入 digest，而不会被一个手写的字段子集漏掉。
 */
export function marketDirectContinuousLegacyXOutcomeFingerprint(
  frozenOutcome: unknown,
): string {
  if (
    !frozenOutcome ||
    typeof frozenOutcome !== "object" ||
    Array.isArray(frozenOutcome)
  ) {
    throw new TypeError("legacy X frozen outcome must be an object");
  }
  const outcome = frozenOutcome as Record<string, unknown>;
  const { entryId: _entryId, ...outcomeIdentity } =
    LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY;
  for (const [key, expected] of Object.entries(outcomeIdentity)) {
    if (outcome[key] !== expected) {
      throw new Error(`legacy X frozen outcome mismatch: ${key}`);
    }
  }
  return marketDirectContinuousEvidenceFingerprint(frozenOutcome);
}

export type MarketDirectEntryLifecycleStage =
  | "shadow"
  | "qualified"
  | "canary"
  | "review_paused"
  | "continuous";

export type MarketDirectShadowResult =
  | "safe_opportunity"
  | "safe_no_opportunity"
  | "production_priority_wait"
  | "incomplete";

export type MarketDirectLifecycleEvidenceKind =
  | "legacy_reviewed_canary"
  | "shadow_qualification"
  | "canary_confirmation"
  | "continuous_review"
  | "shared_review";

export interface MarketDirectLifecycleEvidence {
  readonly kind: MarketDirectLifecycleEvidenceKind;
  readonly digest: string;
  readonly recordedAt: number;
}

export interface MarketDirectEntryLifecycle {
  readonly entryId: string;
  readonly resourceFingerprint: string;
  readonly sharedFingerprint: string;
  readonly stage: MarketDirectEntryLifecycleStage;
  readonly consecutiveCompleteCycles: number;
  readonly lastCycleTick?: number;
  readonly lastShadowResult?: MarketDirectShadowResult;
  readonly qualifiedAt?: number;
  readonly canaryConfirmedAt?: number;
  readonly canaryConfirmedCount: number;
  readonly sharedReviewRequired: boolean;
  /** 历史只追加；fingerprint reset 不能删除既有 canary/review 证据。 */
  readonly evidenceHistory: readonly MarketDirectLifecycleEvidence[];
}

export function marketDirectLifecycleEvidenceDigest(
  lifecycle: MarketDirectEntryLifecycle,
): string {
  return marketDirectContinuousEvidenceFingerprint({
    domain: "market-direct-continuous:lifecycle-binding-v1",
    lifecycle,
  });
}

function requireSafeTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError("tick must be a non-negative safe integer");
  }
}

function requireDigest(digest: string, label: string): void {
  if (typeof digest !== "string" || digest.length === 0) {
    throw new TypeError(`${label} digest is required`);
  }
}

function appendLifecycleEvidence(
  history: readonly MarketDirectLifecycleEvidence[],
  evidence: MarketDirectLifecycleEvidence,
): readonly MarketDirectLifecycleEvidence[] {
  const same = history.find(
    (entry) =>
      entry.kind === evidence.kind && entry.digest === evidence.digest,
  );
  if (same) return history;
  return [...history, deepFreeze({ ...evidence })];
}

export function createMarketDirectEntryLifecycle(
  entryId: string,
  sharedFingerprint: string,
): MarketDirectEntryLifecycle {
  const entry = marketDirectContinuousEntry(entryId);
  if (!entry) throw new RangeError(`unknown Continuous entry: ${entryId}`);
  requireDigest(sharedFingerprint, "shared fingerprint");
  return {
    entryId,
    resourceFingerprint: entry.resourceFingerprint,
    sharedFingerprint,
    stage: "shadow",
    consecutiveCompleteCycles: 0,
    canaryConfirmedCount: 0,
    sharedReviewRequired: false,
    evidenceHistory: [],
  };
}

export function createLegacyReviewedXEntryLifecycle(
  sharedFingerprint: string,
  frozenOutcome: unknown,
): MarketDirectEntryLifecycle {
  const initial = createMarketDirectEntryLifecycle(
    "base-x-e6n59-v1",
    sharedFingerprint,
  );
  const outcomeDigest =
    marketDirectContinuousLegacyXOutcomeFingerprint(frozenOutcome);
  return {
    ...initial,
    stage: "review_paused",
    canaryConfirmedAt:
      LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY.transactionTime,
    canaryConfirmedCount: 1,
    evidenceHistory: [
      {
        kind: "legacy_reviewed_canary",
        digest: outcomeDigest,
        recordedAt:
          LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY.transactionTime,
      },
    ],
  };
}

export type MarketDirectLifecycleReset = "none" | "entry" | "shared";

export function reconcileMarketDirectEntryLifecycleFingerprints(
  state: MarketDirectEntryLifecycle,
  input: {
    readonly resourceFingerprint: string;
    readonly sharedFingerprint: string;
  },
): {
  readonly state: MarketDirectEntryLifecycle;
  readonly reset: MarketDirectLifecycleReset;
} {
  requireDigest(input.resourceFingerprint, "resource fingerprint");
  requireDigest(input.sharedFingerprint, "shared fingerprint");
  if (state.sharedFingerprint !== input.sharedFingerprint) {
    return {
      reset: "shared",
      state: {
        ...state,
        resourceFingerprint: input.resourceFingerprint,
        sharedFingerprint: input.sharedFingerprint,
        stage: "shadow",
        consecutiveCompleteCycles: 0,
        lastCycleTick: undefined,
        lastShadowResult: undefined,
        qualifiedAt: undefined,
        sharedReviewRequired: true,
      },
    };
  }
  if (state.resourceFingerprint !== input.resourceFingerprint) {
    return {
      reset: "entry",
      state: {
        ...state,
        resourceFingerprint: input.resourceFingerprint,
        stage: "shadow",
        consecutiveCompleteCycles: 0,
        lastCycleTick: undefined,
        lastShadowResult: undefined,
        qualifiedAt: undefined,
      },
    };
  }
  return { state, reset: "none" };
}

export function reconcileMarketDirectLifecycleSetSharedFingerprint(
  states: readonly MarketDirectEntryLifecycle[],
  sharedFingerprint: string,
): readonly MarketDirectEntryLifecycle[] {
  requireDigest(sharedFingerprint, "shared fingerprint");
  return states
    .map((state) => {
      const entry = marketDirectContinuousEntry(state.entryId);
      if (!entry) throw new RangeError(`unknown entry: ${state.entryId}`);
      return reconcileMarketDirectEntryLifecycleFingerprints(state, {
        resourceFingerprint: entry.resourceFingerprint,
        sharedFingerprint,
      }).state;
    })
    .sort((left, right) => left.entryId.localeCompare(right.entryId));
}

export function observeMarketDirectShadowCycle(
  current: MarketDirectEntryLifecycle,
  input: {
    readonly tick: number;
    readonly result: MarketDirectShadowResult;
    readonly resourceFingerprint: string;
    readonly sharedFingerprint: string;
  },
): MarketDirectEntryLifecycle {
  requireSafeTick(input.tick);
  const reconciled = reconcileMarketDirectEntryLifecycleFingerprints(
    current,
    input,
  ).state;
  if (reconciled.lastCycleTick === input.tick) return reconciled;
  if (
    reconciled.stage !== "shadow" &&
    reconciled.stage !== "qualified"
  ) {
    return reconciled;
  }
  if (input.result === "incomplete") {
    return {
      ...reconciled,
      stage: "shadow",
      consecutiveCompleteCycles: 0,
      lastCycleTick: input.tick,
      lastShadowResult: input.result,
      qualifiedAt: undefined,
    };
  }
  if (
    reconciled.lastCycleTick !== undefined &&
    input.tick < reconciled.lastCycleTick
  ) {
    return {
      ...reconciled,
      stage: "shadow",
      consecutiveCompleteCycles: 1,
      lastCycleTick: input.tick,
      lastShadowResult: input.result,
      qualifiedAt: undefined,
    };
  }
  if (reconciled.stage === "qualified") {
    return {
      ...reconciled,
      lastCycleTick: input.tick,
      lastShadowResult: input.result,
    };
  }

  // “连续”指连续完成的 Shadow 观测周期，而不是相邻 Game tick。
  // ResourceControl/市场规划按采样周期运行；中间没有观测的 tick 不能
  // 把完整周期清零。真正的 incomplete 会在上方显式清零；tick 回拨
  // 仍只允许从 1 重新开始。
  const consecutiveCompleteCycles =
    reconciled.consecutiveCompleteCycles + 1;
  const qualified =
    consecutiveCompleteCycles >=
    MARKET_DIRECT_CONTINUOUS_REQUIRED_SHADOW_CYCLES;
  const evidenceHistory = qualified
    ? appendLifecycleEvidence(reconciled.evidenceHistory, {
        kind: "shadow_qualification",
        digest: marketDirectContinuousEvidenceFingerprint({
          entryId: reconciled.entryId,
          resourceFingerprint: reconciled.resourceFingerprint,
          sharedFingerprint: reconciled.sharedFingerprint,
          completedAt: input.tick,
          consecutiveCompleteCycles,
        }),
        recordedAt: input.tick,
      })
    : reconciled.evidenceHistory;
  return {
    ...reconciled,
    stage: qualified ? "qualified" : "shadow",
    consecutiveCompleteCycles,
    lastCycleTick: input.tick,
    lastShadowResult: input.result,
    qualifiedAt: qualified ? input.tick : undefined,
    evidenceHistory,
  };
}

export function acknowledgeMarketDirectSharedReview(
  state: MarketDirectEntryLifecycle,
  input: {
    readonly tick: number;
    readonly sharedFingerprint: string;
    readonly evidenceDigest: string;
  },
): MarketDirectEntryLifecycle {
  requireSafeTick(input.tick);
  requireDigest(input.sharedFingerprint, "shared fingerprint");
  requireDigest(input.evidenceDigest, "shared review");
  if (state.sharedFingerprint !== input.sharedFingerprint) {
    throw new Error("shared review does not match current fingerprint");
  }
  return {
    ...state,
    sharedReviewRequired: false,
    evidenceHistory: appendLifecycleEvidence(state.evidenceHistory, {
      kind: "shared_review",
      digest: input.evidenceDigest,
      recordedAt: input.tick,
    }),
  };
}

export function promoteMarketDirectEntryToCanary(
  state: MarketDirectEntryLifecycle,
  input: { readonly tick: number; readonly qualificationDigest: string },
): MarketDirectEntryLifecycle {
  requireSafeTick(input.tick);
  requireDigest(input.qualificationDigest, "qualification");
  if (state.stage !== "qualified" || state.sharedReviewRequired) {
    throw new Error("entry is not qualified for canary");
  }
  if (
    !state.evidenceHistory.some(
      (entry) =>
        entry.kind === "shadow_qualification" &&
        entry.digest === input.qualificationDigest,
    )
  ) {
    throw new Error("qualification evidence is not bound to entry");
  }
  return { ...state, stage: "canary" };
}

export function recordMarketDirectCanaryConfirmation(
  state: MarketDirectEntryLifecycle,
  input: {
    readonly tick: number;
    readonly actualAmount: number;
    readonly evidence?: unknown;
    readonly evidenceDigest?: string;
  },
): MarketDirectEntryLifecycle {
  requireSafeTick(input.tick);
  if (
    !Number.isSafeInteger(input.actualAmount) ||
    input.actualAmount <= 0
  ) {
    throw new RangeError("canary confirmation requires positive actual amount");
  }
  if (state.stage !== "canary" || state.canaryConfirmedCount !== 0) {
    throw new Error("entry cannot confirm another canary");
  }
  const evidenceDigest =
    input.evidenceDigest ??
    marketDirectContinuousEvidenceFingerprint(
      input.evidence,
    );
  requireDigest(evidenceDigest, "canary confirmation");
  return {
    ...state,
    stage: "review_paused",
    canaryConfirmedAt: input.tick,
    canaryConfirmedCount: 1,
    evidenceHistory: appendLifecycleEvidence(state.evidenceHistory, {
      kind: "canary_confirmation",
      digest: evidenceDigest,
      recordedAt: input.tick,
    }),
  };
}

export function promoteMarketDirectEntryToContinuous(
  state: MarketDirectEntryLifecycle,
  input: {
    readonly tick: number;
    readonly reviewedEvidenceDigest: string;
    readonly expectedReviewedEvidenceDigest: string;
  },
): MarketDirectEntryLifecycle {
  requireSafeTick(input.tick);
  requireDigest(input.reviewedEvidenceDigest, "reviewed evidence");
  requireDigest(
    input.expectedReviewedEvidenceDigest,
    "expected reviewed evidence",
  );
  if (state.stage !== "review_paused" || state.sharedReviewRequired) {
    throw new Error("entry is not review-paused for Continuous");
  }
  const canaryEvidence = state.evidenceHistory.some(
    (entry) =>
      entry.kind === "canary_confirmation" ||
      entry.kind === "legacy_reviewed_canary",
  );
  if (!canaryEvidence) {
    throw new Error("entry has no confirmed canary evidence");
  }
  if (
    input.reviewedEvidenceDigest !==
    input.expectedReviewedEvidenceDigest
  ) {
    throw new Error(
      "reviewed evidence does not match confirmed canary",
    );
  }
  return {
    ...state,
    stage: "continuous",
    evidenceHistory: appendLifecycleEvidence(state.evidenceHistory, {
      kind: "continuous_review",
      digest: input.reviewedEvidenceDigest,
      recordedAt: input.tick,
    }),
  };
}

export type MarketDirectNewDealGrant = "enabled" | "suspended";

export interface MarketDirectPermitEntryGrant {
  readonly entryId: string;
  readonly stage: MarketDirectEntryLifecycleStage;
  readonly newDealGrant: MarketDirectNewDealGrant;
  readonly resourceFingerprint: string;
  readonly lifecycleEvidenceDigest: string;
}

export interface MarketDirectPermitEvidenceBinding {
  readonly entryId: string;
  readonly evidenceKey: string;
  readonly kind: MarketDirectLifecycleEvidenceKind;
  readonly digest: string;
}

export interface MarketDirectContinuousPermit {
  readonly capability: typeof MARKET_DIRECT_CONTINUOUS_CAPABILITY;
  readonly schema: typeof MARKET_DIRECT_CONTINUOUS_SCHEMA;
  readonly epoch: number;
  readonly permitId: string;
  readonly permitHead: string;
  readonly accountIdentity: string;
  readonly executorShard: typeof MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD;
  readonly engineAssumptionCommit: string;
  readonly sharedPolicyFingerprint: string;
  readonly sharedDirectFingerprint: string;
  readonly canonicalExecutionTable:
    readonly CanonicalMarketDirectContinuousEntry[];
  readonly entryGrants: readonly MarketDirectPermitEntryGrant[];
  readonly reviewedEvidence:
    readonly MarketDirectPermitEvidenceBinding[];
  readonly globalPolicy: MarketDirectContinuousGlobalPolicy;
  readonly previousPermitId: string;
  readonly previousPermitHead: string;
  readonly previousLedgerHead: string;
  readonly createdAt: number;
  readonly operatorAuthorizationFingerprint: string;
}

type MarketDirectPermitWithoutIdentity = Omit<
  MarketDirectContinuousPermit,
  "permitId" | "permitHead"
>;

function sortedGrants(
  grants: readonly MarketDirectPermitEntryGrant[],
): readonly MarketDirectPermitEntryGrant[] {
  return grants
    .map((grant) => ({ ...grant }))
    .sort((left, right) => left.entryId.localeCompare(right.entryId));
}

function sortedEvidence(
  evidence: readonly MarketDirectPermitEvidenceBinding[],
): readonly MarketDirectPermitEvidenceBinding[] {
  return evidence
    .map((entry) => ({ ...entry }))
    .sort(
      (left, right) =>
        left.entryId.localeCompare(right.entryId) ||
        left.evidenceKey.localeCompare(right.evidenceKey) ||
        left.kind.localeCompare(right.kind),
    );
}

function permitIdFor(payload: MarketDirectPermitWithoutIdentity): string {
  return `mdc-permit-v2:${canonicalStableHashV1({
    domain: "market-direct-continuous:permit-id-v2",
    permit: payload as unknown as CanonicalValue,
  })}`;
}

function permitHeadFor(
  previousPermitHead: string,
  permitId: string,
  payload: MarketDirectPermitWithoutIdentity,
): string {
  return canonicalStableHashV1({
    domain: "market-direct-continuous:permit-head-v2",
    permitDigest: canonicalStableHashV1(payload),
    permitId,
    previousPermitHead,
  });
}

function validateEntryGrants(
  grants: readonly MarketDirectPermitEntryGrant[],
): void {
  if (grants.length !== MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.length) {
    throw new Error("permit must retain every canonical entry grant");
  }
  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index];
    const entry = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE[index];
    if (
      !grant ||
      grant.entryId !== entry.entryId ||
      grant.resourceFingerprint !== entry.resourceFingerprint ||
      !grant.lifecycleEvidenceDigest
    ) {
      throw new Error("permit entry grant does not match canonical policy");
    }
    const canWrite =
      grant.stage === "canary" || grant.stage === "continuous";
    if (grant.newDealGrant === "enabled" && !canWrite) {
      throw new Error("non-writing lifecycle cannot have an enabled grant");
    }
  }
}

function validateEvidenceBindings(
  evidence: readonly MarketDirectPermitEvidenceBinding[],
): void {
  const seenKeys = new Map<string, string>();
  for (const binding of evidence) {
    if (
      !marketDirectContinuousEntry(binding.entryId) ||
      !binding.evidenceKey ||
      !binding.digest
    ) {
      throw new Error("invalid reviewed evidence binding");
    }
    const previous = seenKeys.get(binding.evidenceKey);
    if (previous && previous !== binding.digest) {
      throw new Error("one evidence key points to conflicting content");
    }
    seenKeys.set(binding.evidenceKey, binding.digest);
  }
}

export interface BuildMarketDirectPermitInput {
  readonly epoch: number;
  readonly accountIdentity: string;
  readonly sharedDirectFingerprint: string;
  readonly entryGrants: readonly MarketDirectPermitEntryGrant[];
  readonly reviewedEvidence:
    readonly MarketDirectPermitEvidenceBinding[];
  readonly previousPermitId: string;
  readonly previousPermitHead: string;
  readonly previousLedgerHead: string;
  readonly createdAt: number;
  readonly operatorAuthorizationFingerprint: string;
  readonly engineAssumptionCommit?: string;
}

export function buildMarketDirectContinuousPermit(
  input: BuildMarketDirectPermitInput,
): MarketDirectContinuousPermit {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
    throw new RangeError("permit epoch must be a positive safe integer");
  }
  requireSafeTick(input.createdAt);
  for (const [label, value] of [
    ["account identity", input.accountIdentity],
    ["shared Direct fingerprint", input.sharedDirectFingerprint],
    ["previous permit head", input.previousPermitHead],
    ["previous ledger head", input.previousLedgerHead],
    [
      "operator authorization fingerprint",
      input.operatorAuthorizationFingerprint,
    ],
  ] as const) {
    requireDigest(value, label);
  }

  const entryGrants = sortedGrants(input.entryGrants);
  const reviewedEvidence = sortedEvidence(input.reviewedEvidence);
  validateEntryGrants(entryGrants);
  validateEvidenceBindings(reviewedEvidence);

  const payload: MarketDirectPermitWithoutIdentity = {
    capability: MARKET_DIRECT_CONTINUOUS_CAPABILITY,
    schema: MARKET_DIRECT_CONTINUOUS_SCHEMA,
    epoch: input.epoch,
    accountIdentity: input.accountIdentity,
    executorShard: MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
    engineAssumptionCommit:
      input.engineAssumptionCommit ?? DIRECT_ENGINE_ASSUMPTIONS.commit,
    sharedPolicyFingerprint: marketDirectContinuousSharedFingerprint({
      directRuntimeFingerprint: input.sharedDirectFingerprint,
      engineAssumptionCommit:
        input.engineAssumptionCommit ?? DIRECT_ENGINE_ASSUMPTIONS.commit,
    }),
    sharedDirectFingerprint: input.sharedDirectFingerprint,
    canonicalExecutionTable: MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
    entryGrants,
    reviewedEvidence,
    globalPolicy: MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
    previousPermitId: input.previousPermitId,
    previousPermitHead: input.previousPermitHead,
    previousLedgerHead: input.previousLedgerHead,
    createdAt: input.createdAt,
    operatorAuthorizationFingerprint:
      input.operatorAuthorizationFingerprint,
  };
  const permitId = permitIdFor(payload);
  return deepFreeze({
    ...payload,
    permitId,
    permitHead: permitHeadFor(
      payload.previousPermitHead,
      permitId,
      payload,
    ),
  }) as MarketDirectContinuousPermit;
}

export interface MarketDirectPermitChainState {
  readonly currentPermitEpoch: number;
  readonly currentPermitId: string;
  readonly permitChainHead: string;
  readonly permitEpochHighWater: number;
  readonly permitChainHeadHighWater: string;
  readonly permits: readonly MarketDirectContinuousPermit[];
  readonly blocker?: "permit_conflict";
  readonly blockerReason?: string;
}

export function createMarketDirectPermitChainState():
  MarketDirectPermitChainState {
  return {
    currentPermitEpoch: 0,
    currentPermitId: "",
    permitChainHead: MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
    permitEpochHighWater: 0,
    permitChainHeadHighWater: MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
    permits: [],
  };
}

function permitPayload(
  permit: MarketDirectContinuousPermit,
): MarketDirectPermitWithoutIdentity {
  const { permitId: _permitId, permitHead: _permitHead, ...payload } =
    permit;
  return payload;
}

function permitsEqual(
  left: MarketDirectContinuousPermit,
  right: MarketDirectContinuousPermit,
): boolean {
  return (
    canonicalStableHashV1(left) === canonicalStableHashV1(right) &&
    canonicalStableSerialize(left) === canonicalStableSerialize(right)
  );
}

function validatePermitSelfIdentity(
  permit: MarketDirectContinuousPermit,
): boolean {
  const payload = permitPayload(permit);
  const expectedId = permitIdFor(payload);
  return (
    permit.permitId === expectedId &&
    permit.permitHead ===
      permitHeadFor(permit.previousPermitHead, expectedId, payload)
  );
}

function chainTipIsConsistent(
  state: MarketDirectPermitChainState,
  checkpoint?: {
    readonly permitEpochHighWater: number;
    readonly permitChainHeadHighWater: string;
  },
): boolean {
  if (
    state.currentPermitEpoch !== state.permitEpochHighWater ||
    state.permitChainHead !== state.permitChainHeadHighWater ||
    state.permits.length !== state.permitEpochHighWater
  ) {
    return false;
  }
  if (
    checkpoint &&
    (checkpoint.permitEpochHighWater !== state.permitEpochHighWater ||
      checkpoint.permitChainHeadHighWater !==
        state.permitChainHeadHighWater)
  ) {
    return false;
  }
  let previousId = "";
  let previousHead: string = MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS;
  for (let index = 0; index < state.permits.length; index += 1) {
    const permit = state.permits[index];
    if (
      permit.epoch !== index + 1 ||
      permit.previousPermitId !== previousId ||
      permit.previousPermitHead !== previousHead ||
      !validatePermitSelfIdentity(permit)
    ) {
      return false;
    }
    previousId = permit.permitId;
    previousHead = permit.permitHead;
  }
  const tip = state.permits[state.permits.length - 1];
  return tip
    ? state.currentPermitId === tip.permitId &&
        state.permitChainHead === tip.permitHead
    : state.currentPermitId === "" &&
        state.permitChainHead ===
          MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS;
}

export interface ValidateMarketDirectContinuousPermitChainResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * 对持久 permit chain 做只读完整性审计。
 *
 * 不尝试归一化、补写或解除 blocker；调用方可在规划和 telemetry 共用同一
 * fail-closed 结论。具体链校验复用签收路径的 chainTipIsConsistent，避免
 * read path 与 write path 对 epoch/head/high-water 产生两套解释。
 */
export function validateMarketDirectContinuousPermitChain(
  state: MarketDirectPermitChainState,
  checkpoint?: {
    readonly permitEpochHighWater: number;
    readonly permitChainHeadHighWater: string;
  },
): ValidateMarketDirectContinuousPermitChainResult {
  if (state.blocker === "permit_conflict") {
    return {
      ok: false,
      reason: state.blockerReason ?? "permit_conflict",
    };
  }
  if (!chainTipIsConsistent(state, checkpoint)) {
    return {
      ok: false,
      reason: checkpoint
        ? "permit_chain_or_checkpoint_mismatch"
        : "permit_chain_mismatch",
    };
  }
  return { ok: true };
}

function permitConflict(
  state: MarketDirectPermitChainState,
  reason: string,
): MarketDirectPermitChainState {
  return {
    ...state,
    blocker: "permit_conflict",
    blockerReason: state.blockerReason ?? reason,
  };
}

function stageRank(stage: MarketDirectEntryLifecycleStage): number {
  switch (stage) {
    case "shadow":
      return 0;
    case "qualified":
      return 1;
    case "canary":
      return 2;
    case "review_paused":
      return 3;
    case "continuous":
      return 4;
  }
}

function evidenceMap(
  permits: readonly MarketDirectContinuousPermit[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const permit of permits) {
    for (const evidence of permit.reviewedEvidence) {
      result.set(evidence.evidenceKey, evidence.digest);
    }
  }
  return result;
}

function validateSuccessorInheritance(
  state: MarketDirectPermitChainState,
  permit: MarketDirectContinuousPermit,
): string | undefined {
  const prior = state.permits[state.permits.length - 1];
  const oldEvidence = evidenceMap(state.permits);
  for (const binding of permit.reviewedEvidence) {
    const oldDigest = oldEvidence.get(binding.evidenceKey);
    if (oldDigest && oldDigest !== binding.digest) {
      return "reviewed_evidence_conflict";
    }
  }
  if (!prior) {
    const x = permit.entryGrants.find(
      (grant) => grant.entryId === "base-x-e6n59-v1",
    );
    const h = permit.entryGrants.find(
      (grant) => grant.entryId === "base-h-e3n59-v1",
    );
    const z = permit.entryGrants.find(
      (grant) => grant.entryId === "base-z-e7n57-v1",
    );
    const hasLegacyX = permit.reviewedEvidence.some(
      (entry) =>
        entry.entryId === "base-x-e6n59-v1" &&
        entry.kind === "legacy_reviewed_canary" &&
        entry.evidenceKey ===
          LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY.evidenceKey &&
        /^csh1:[0-9a-f]{32}$/.test(entry.digest),
    );
    if (
      !x ||
      !h ||
      !z ||
      !hasLegacyX ||
      (x.stage !== "review_paused" && x.stage !== "continuous") ||
      h.stage !== "shadow" ||
      z.stage !== "shadow"
    ) {
      return "genesis_grants_invalid";
    }
    return undefined;
  }

  const newEvidence = new Set(
    permit.reviewedEvidence.map(
      (entry) => `${entry.entryId}:${entry.kind}`,
    ),
  );
  for (const priorGrant of prior.entryGrants) {
    const next = permit.entryGrants.find(
      (grant) => grant.entryId === priorGrant.entryId,
    );
    if (!next || stageRank(next.stage) < stageRank(priorGrant.stage)) {
      return "entry_grant_history_regressed";
    }
    if (
      next.stage === "canary" &&
      priorGrant.stage !== "canary" &&
      !newEvidence.has(`${next.entryId}:shadow_qualification`)
    ) {
      return "canary_grant_missing_qualification";
    }
    if (
      next.stage === "continuous" &&
      priorGrant.stage !== "continuous" &&
      !newEvidence.has(`${next.entryId}:continuous_review`) &&
      !(
        next.entryId === "base-x-e6n59-v1" &&
        newEvidence.has(`${next.entryId}:legacy_reviewed_canary`)
      )
    ) {
      return "continuous_grant_missing_review";
    }
  }
  return undefined;
}

export interface AppendMarketDirectPermitInput {
  readonly currentShard: string;
  readonly currentLedgerHead: string;
  readonly hasPending: boolean;
  readonly hasQuarantine: boolean;
  readonly hasGap: boolean;
  readonly hasUnmatchedReservation: boolean;
  readonly checkpoint?: {
    readonly permitEpochHighWater: number;
    readonly permitChainHeadHighWater: string;
  };
}

export type AppendMarketDirectPermitResult =
  | {
      readonly status: "appended" | "idempotent";
      readonly state: MarketDirectPermitChainState;
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly state: MarketDirectPermitChainState;
    }
  | {
      readonly status: "conflict";
      readonly reason: string;
      readonly state: MarketDirectPermitChainState;
    };

export function appendMarketDirectContinuousPermit(
  state: MarketDirectPermitChainState,
  permit: MarketDirectContinuousPermit,
  input: AppendMarketDirectPermitInput,
): AppendMarketDirectPermitResult {
  if (state.blocker === "permit_conflict") {
    return {
      status: "conflict",
      reason: state.blockerReason ?? "permit_conflict",
      state,
    };
  }
  if (!chainTipIsConsistent(state, input.checkpoint)) {
    const conflicted = permitConflict(state, "permit_tip_mismatch");
    return {
      status: "conflict",
      reason: "permit_tip_mismatch",
      state: conflicted,
    };
  }
  if (
    permit.executorShard !== MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD ||
    input.currentShard !== permit.executorShard
  ) {
    const conflicted = permitConflict(state, "executor_shard_mismatch");
    return {
      status: "conflict",
      reason: "executor_shard_mismatch",
      state: conflicted,
    };
  }
  if (!validatePermitSelfIdentity(permit)) {
    const conflicted = permitConflict(state, "permit_self_hash_mismatch");
    return {
      status: "conflict",
      reason: "permit_self_hash_mismatch",
      state: conflicted,
    };
  }

  const existingById = state.permits.find(
    (candidate) => candidate.permitId === permit.permitId,
  );
  if (existingById) {
    if (permitsEqual(existingById, permit)) {
      return { status: "idempotent", state };
    }
    const conflicted = permitConflict(state, "permit_id_content_conflict");
    return {
      status: "conflict",
      reason: "permit_id_content_conflict",
      state: conflicted,
    };
  }
  const existingAtEpoch = state.permits.find(
    (candidate) => candidate.epoch === permit.epoch,
  );
  if (existingAtEpoch) {
    const conflicted = permitConflict(state, "permit_epoch_conflict");
    return {
      status: "conflict",
      reason: "permit_epoch_conflict",
      state: conflicted,
    };
  }
  if (
    input.hasPending ||
    input.hasQuarantine ||
    input.hasGap ||
    input.hasUnmatchedReservation
  ) {
    return {
      status: "rejected",
      reason: "permit_wal_not_quiescent",
      state,
    };
  }
  if (
    permit.epoch !== state.permitEpochHighWater + 1 ||
    permit.previousPermitId !== state.currentPermitId ||
    permit.previousPermitHead !== state.permitChainHead ||
    permit.previousLedgerHead !== input.currentLedgerHead
  ) {
    const conflicted = permitConflict(state, "permit_predecessor_mismatch");
    return {
      status: "conflict",
      reason: "permit_predecessor_mismatch",
      state: conflicted,
    };
  }
  const inheritanceError = validateSuccessorInheritance(state, permit);
  if (inheritanceError) {
    const conflicted = permitConflict(state, inheritanceError);
    return {
      status: "conflict",
      reason: inheritanceError,
      state: conflicted,
    };
  }

  const next: MarketDirectPermitChainState = {
    currentPermitEpoch: permit.epoch,
    currentPermitId: permit.permitId,
    permitChainHead: permit.permitHead,
    permitEpochHighWater: permit.epoch,
    permitChainHeadHighWater: permit.permitHead,
    permits: [...state.permits, permit],
  };
  return { status: "appended", state: next };
}

export function marketDirectPermitAllowsNewDeal(
  state: MarketDirectPermitChainState,
  input: {
    readonly shard: string;
    readonly entryId: string;
    readonly lifecycle: MarketDirectEntryLifecycle;
  },
): boolean {
  if (
    state.blocker ||
    input.shard !== MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD ||
    !chainTipIsConsistent(state)
  ) {
    return false;
  }
  const permit = state.permits[state.permits.length - 1];
  const grant = permit?.entryGrants.find(
    (entry) => entry.entryId === input.entryId,
  );
  return Boolean(
    permit &&
      grant &&
      grant.newDealGrant === "enabled" &&
      grant.stage === input.lifecycle.stage &&
      grant.resourceFingerprint === input.lifecycle.resourceFingerprint &&
      grant.lifecycleEvidenceDigest ===
        marketDirectLifecycleEvidenceDigest(
          input.lifecycle,
        ) &&
      permit.sharedPolicyFingerprint ===
        marketDirectContinuousSharedFingerprint({
          directRuntimeFingerprint: permit.sharedDirectFingerprint,
          engineAssumptionCommit: permit.engineAssumptionCommit,
        }) &&
      input.lifecycle.sharedFingerprint ===
        permit.sharedPolicyFingerprint &&
      !input.lifecycle.sharedReviewRequired &&
      (grant.stage === "canary" || grant.stage === "continuous"),
  );
}
