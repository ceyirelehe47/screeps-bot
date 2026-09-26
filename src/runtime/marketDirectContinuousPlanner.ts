import {
  priceToMilliDown,
  priceToMilliUp,
  type MarketOrderSnapshot,
  type MilliCredits,
} from "@/runtime/marketSalePricing";

export const MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT = 1_000;
export const MARKET_DIRECT_CONTINUOUS_MAX_RESOURCES = 7;
export const MARKET_DIRECT_CONTINUOUS_MAX_SELLER_ROOMS = 16;
export const MARKET_DIRECT_CONTINUOUS_MAX_LANES = 112;
export const MARKET_DIRECT_CONTINUOUS_MAX_DISTINCT_ORDER_ROOMS = 128;
export const MARKET_DIRECT_CONTINUOUS_MAX_TRANSACTION_ENERGY_EVALUATIONS = 4_096;
export const MARKET_DIRECT_CONTINUOUS_ROOM_ROLLING_CAP = 5_000;
export const MARKET_DIRECT_CONTINUOUS_LANE_ROLLING_CAP = 3_000;

export type MarketDirectContinuousGrant = "canary" | "continuous";
export type MarketDirectContinuousLaneAuthorization =
  | "writable"
  | "suspended_shadow";

export interface MarketDirectContinuousPolicy {
  entryId: string;
  revision: string;
  resourceType: string;
  allowedRooms: readonly string[];
  requireNativeMineral: boolean;
  grant: MarketDirectContinuousGrant;
  hardNetFloor: number;
  economicNetFloor: number;
  historyNetFloor?: number;
  ratchetNetFloor?: number;
  minExecutableNotional: number;
  maxRawOrders: number;
  maxEligibleOrders: number;
  maxTransactionEnergy: number;
  terminalEnergyReserve: number;
  resourceRollingCap: number;
  opportunityReserve: number;
  /**
   * 旧调用方省略时按 frozen v2 evaluator 解释。v3 必须显式声明，
   * 以免新 bundle 把旧 permit 隐式扩成 Hub/emergency/non-native scope。
   */
  evaluatorVersion?: 2 | 3;
}

export interface MarketDirectContinuousLane {
  roomName: string;
  resourceType: string;
  owned: boolean;
  hub: boolean;
  capacityEmergency: boolean;
  nativeMineralType?: string;
  /**
   * 缺省为 writable，保持 v2 调用兼容。suspended Shadow 只参与有界
   * observation，不得生成候选。
   */
  authorization?: MarketDirectContinuousLaneAuthorization;
}

export interface MarketDirectContinuousProtection {
  complete: boolean;
  revision: string;
  sellableAmount: number;
}

export interface MarketDirectContinuousTerminal {
  revision: string;
  normal: boolean;
  /**
   * V3 的 current Energy-readiness 执行资格。false 表示证据完整但本 lane
   * 当前安全等待；缺失在 V3 视为结构不完整。V2 不读取本字段。
   */
  ready?: boolean;
  claimed: boolean;
  cooldown: number;
  resourceAmount: number;
  energy: number;
  /**
   * v3 生产/发送承诺形成的 current reserve；缺省仍使用 policy 的
   * frozen v2 terminalEnergyReserve。
   */
  effectivePostDealEnergyReserve?: number;
}

export interface MarketDirectContinuousBook {
  complete: boolean;
  revision: string;
  orders: readonly MarketOrderSnapshot[];
  ownOrderIds: readonly string[];
}

export interface MarketDirectContinuousResourceQuota {
  complete: boolean;
  revision: string;
  resourceType: string;
  rollingCap: number;
  confirmedAmount: number;
  unmatchedPlannedAmount: number;
  opportunityReserveSatisfied: boolean;
}

export interface MarketDirectContinuousLaneQuota {
  complete: boolean;
  revision: string;
  roomRollingCap: number;
  roomConfirmedAmount: number;
  roomUnmatchedPlannedAmount: number;
  laneRollingCap: number;
  laneConfirmedAmount: number;
  laneUnmatchedPlannedAmount: number;
}

export type MarketDirectContinuousTransactionEnergyCalculator = (
  amount: number,
  order: MarketOrderSnapshot,
  sellerRoomName: string,
) => number;

export interface MarketDirectContinuousLaneInput {
  lane: MarketDirectContinuousLane;
  protection: MarketDirectContinuousProtection;
  terminal: MarketDirectContinuousTerminal;
  /**
   * v2 adapter 保留的 lane 级盘口。v3 应使用 entry.book；存在 entry.book
   * 时本字段如同时提供，必须与资源级快照逐字段一致。
   */
  book?: MarketDirectContinuousBook;
  /**
   * v2 adapter 保留的 lane 级成本函数。v3 应使用 entry 级函数。
   */
  calculateTransactionEnergy?: MarketDirectContinuousTransactionEnergyCalculator;
  quota?: MarketDirectContinuousLaneQuota;
}

export interface MarketDirectContinuousEntryInput {
  policy: MarketDirectContinuousPolicy;
  quota: MarketDirectContinuousResourceQuota;
  lanes: readonly MarketDirectContinuousLaneInput[];
  /**
   * v3 资源级完整 BUY book；同资源全部 seller lane 共享这一份不可变快照。
   */
  book?: MarketDirectContinuousBook;
  calculateTransactionEnergy?: MarketDirectContinuousTransactionEnergyCalculator;
}

export interface MarketDirectContinuousEnergyShadow {
  complete: boolean;
  revision: string;
  price: number;
}

export interface MarketDirectContinuousGlobalQuota {
  complete: boolean;
  revision: string;
  rollingCap: number;
  confirmedAmount: number;
  unmatchedPlannedAmount: number;
}

/**
 * 这些值不参与价格计算，但属于写前必须保持不变的账户级事实。
 * 调用方可把仲裁器的完整状态编码进 revision。
 */
export interface MarketDirectContinuousWriteContext {
  complete: boolean;
  revision: string;
  credits: number;
  executorShard: string;
  permitEpoch: number;
  permitId: string;
  permitHead: string;
  pendingState: "none" | "active" | "gap" | "quarantine";
  arbiterState: "available" | "claimed" | "blocked";
}

export interface PlanMarketDirectContinuousInput {
  entries: readonly MarketDirectContinuousEntryInput[];
  energyShadow: MarketDirectContinuousEnergyShadow;
  globalQuota: MarketDirectContinuousGlobalQuota;
  writeContext: MarketDirectContinuousWriteContext;
}

/**
 * collector 从单次 full read 签发的脱离快照。快照内部只包含
 * planner 会读取的原始字段，并且全部是普通对象/真实数组/原始值。
 * 调用方不得跨 full read 或 tick 保留它。
 */
export interface MarketDirectContinuousDetachedBookSnapshot {
  readonly book: MarketDirectContinuousBook;
}

/**
 * 仅允许一次 planner 调用消费的不透明能力。真实授权函数由本模块的
 * WeakMap 身份注册表保管，所以不能靠传入一个冻结 book 自行声明为可信。
 */
export interface MarketDirectContinuousInvocationBookCapability {
  readonly book: MarketDirectContinuousBook;
}

export interface MarketDirectContinuousInvocationOptions {
  readonly detachedBookCapabilities?: readonly MarketDirectContinuousInvocationBookCapability[];
  /** 仅供确定性路径观测；抛错不得影响 planner 结果。 */
  readonly observeNormalizationArtifact?: (used: boolean) => void;
}

export type MarketDirectContinuousBlockerReason =
  | "invalid_input"
  | "write_context_incomplete"
  | "write_context_blocked"
  | "energy_shadow_incomplete"
  | "global_quota_incomplete"
  | "entry_scope_invalid"
  | "lane_scope_invalid"
  | "protection_incomplete"
  | "book_incomplete"
  | "raw_book_limit_exceeded"
  | "eligible_book_limit_exceeded"
  | "duplicate_order_id"
  | "distinct_order_room_limit_exceeded"
  | "seller_room_limit_exceeded"
  | "lane_limit_exceeded"
  | "transaction_energy_evaluation_limit_exceeded"
  | "lane_quota_incomplete"
  | "energy_pricing_failed"
  | "unsafe_arithmetic";

export interface MarketDirectContinuousBlocker {
  reason: MarketDirectContinuousBlockerReason;
  entryId?: string;
  roomName?: string;
  orderId?: string;
  detail?: string;
}

export type MarketDirectContinuousTupleRejectionReason =
  | "side_mismatch"
  | "resource_mismatch"
  | "missing_order_room"
  | "self_order"
  | "invalid_order"
  | "order_amount_below_plan"
  | "executable_notional_below_minimum"
  | "transaction_energy_exceeded"
  | "terminal_energy_reserve"
  | "planned_net_below_floor"
  | "worst_case_net_below_floor"
  | "resource_quota_exhausted"
  | "room_quota_exhausted"
  | "lane_quota_exhausted"
  | "global_quota_or_opportunity_reserve";

export interface MarketDirectContinuousTupleRejection {
  entryId: string;
  resourceType: string;
  roomName: string;
  orderId?: string;
  reason: MarketDirectContinuousTupleRejectionReason;
}

export interface MarketDirectContinuousCandidate {
  entryId: string;
  policyRevision: string;
  resourceType: string;
  roomName: string;
  order: MarketOrderSnapshot;
  plannedAmount: typeof MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT;
  grossPriceMilli: MilliCredits;
  executableNotionalMilli: MilliCredits;
  transactionEnergy: number;
  energyShadowPriceMilli: MilliCredits;
  energyShadowCostMilli: MilliCredits;
  netCreditsMilli: MilliCredits;
  effectiveNetFloorMilli: MilliCredits;
  requiredNetCreditsMilli: MilliCredits;
  worstCaseActualAmount: 1;
  worstCaseTransactionEnergy: number;
  worstCaseNetCreditsMilli: MilliCredits;
  resourceQuotaBefore: number;
  roomQuotaBefore: number;
  laneQuotaBefore: number;
  globalQuotaBefore: number;
  reservedForOtherSafeResources: number;
  tupleKey: string;
}

export interface MarketDirectContinuousPlanningResult {
  complete: boolean;
  blocker?: MarketDirectContinuousBlocker;
  /**
   * 通过价格、保护和能量门禁，但尚未经过 resource/global quota admission。
   */
  safeCandidates: MarketDirectContinuousCandidate[];
  /**
   * 同时通过 resource quota、global quota 和其它安全资源机会保留的候选。
   */
  admittedCandidates: MarketDirectContinuousCandidate[];
  selected?: MarketDirectContinuousCandidate;
  rejections: MarketDirectContinuousTupleRejection[];
  planningFingerprint: string;
  /**
   * 精确规范化证据。fingerprint 用于日志；二次读比较同时检查本字段，避免短哈希碰撞。
   */
  planningEvidence: string;
  budget: {
    sellerRooms: number;
    distinctOrderRooms: number;
    transactionEnergyEvaluations: number;
  };
  isolatedShadowLanes: Array<{
    entryId: string;
    roomName: string;
    reason: "lane_scope_invalid" | "protection_incomplete" | "book_incomplete";
  }>;
}

interface EligibleOrder {
  order: MarketOrderSnapshot;
  remainingAmount: number;
  grossPriceMilli: MilliCredits;
  executableNotionalMilli: MilliCredits;
}

interface PreparedResource {
  entry: MarketDirectContinuousEntryInput;
  effectiveNetFloorMilli: MilliCredits;
  minExecutableNotionalMilli: MilliCredits;
  book: MarketDirectContinuousBook;
  eligibleOrders: EligibleOrder[];
  resourceCalculator?: MarketDirectContinuousTransactionEnergyCalculator;
}

interface PreparedLane {
  preparedResource: PreparedResource;
  laneInput: MarketDirectContinuousLaneInput;
}

interface EnergyObservation {
  entryId: string;
  roomName: string;
  orderId: string;
  planned: number;
  worst: number;
}

class TransactionEnergyEvaluationLimitError extends Error {}

function stableStringCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function checkedAdd(left: number, right: number): number | undefined {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function checkedMultiply(left: number, right: number): number | undefined {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function checkedSubtract(left: number, right: number): number | undefined {
  const result = left - right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function remainingOrderAmount(order: MarketOrderSnapshot): number {
  if (order.remainingAmount === undefined) return order.amount;
  if (!Number.isSafeInteger(order.remainingAmount)) return Number.NaN;
  return Math.min(order.amount, order.remainingAmount);
}

function effectiveFloor(policy: MarketDirectContinuousPolicy): number | undefined {
  const values = [
    policy.hardNetFloor,
    policy.economicNetFloor,
    policy.historyNetFloor,
    policy.ratchetNetFloor,
  ].filter((value): value is number => value !== undefined);
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return undefined;
  }
  return Math.max(...values);
}

function policyIsValid(policy: MarketDirectContinuousPolicy): boolean {
  const floor = effectiveFloor(policy);
  return (
    typeof policy.entryId === "string" &&
    policy.entryId.length > 0 &&
    typeof policy.revision === "string" &&
    policy.revision.length > 0 &&
    typeof policy.resourceType === "string" &&
    policy.resourceType.length > 0 &&
    (policy.grant === "canary" || policy.grant === "continuous") &&
    Array.isArray(policy.allowedRooms) &&
    policy.allowedRooms.length > 0 &&
    new Set(policy.allowedRooms).size === policy.allowedRooms.length &&
    policy.allowedRooms.every((roomName) =>
      typeof roomName === "string" && roomName.length > 0) &&
    floor !== undefined &&
    Number.isFinite(policy.minExecutableNotional) &&
    policy.minExecutableNotional > 0 &&
    isPositiveSafeInteger(policy.maxRawOrders) &&
    isPositiveSafeInteger(policy.maxEligibleOrders) &&
    policy.maxEligibleOrders <= policy.maxRawOrders &&
    isNonNegativeSafeInteger(policy.maxTransactionEnergy) &&
    isNonNegativeSafeInteger(policy.terminalEnergyReserve) &&
    isPositiveSafeInteger(policy.resourceRollingCap) &&
    isPositiveSafeInteger(policy.opportunityReserve) &&
    policy.opportunityReserve === MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT &&
    (policy.evaluatorVersion === undefined ||
      policy.evaluatorVersion === 2 ||
      policy.evaluatorVersion === 3)
  );
}

function quotaIsValid(
  quota: MarketDirectContinuousResourceQuota,
  policy: MarketDirectContinuousPolicy,
): boolean {
  return (
    quota.complete &&
    typeof quota.revision === "string" &&
    quota.revision.length > 0 &&
    quota.resourceType === policy.resourceType &&
    quota.rollingCap === policy.resourceRollingCap &&
    isPositiveSafeInteger(quota.rollingCap) &&
    isNonNegativeSafeInteger(quota.confirmedAmount) &&
    isNonNegativeSafeInteger(quota.unmatchedPlannedAmount)
  );
}

function globalQuotaIsValid(quota: MarketDirectContinuousGlobalQuota): boolean {
  return (
    quota.complete &&
    typeof quota.revision === "string" &&
    quota.revision.length > 0 &&
    isPositiveSafeInteger(quota.rollingCap) &&
    isNonNegativeSafeInteger(quota.confirmedAmount) &&
    isNonNegativeSafeInteger(quota.unmatchedPlannedAmount)
  );
}

function laneQuotaIsValid(quota: MarketDirectContinuousLaneQuota): boolean {
  return (
    quota.complete &&
    typeof quota.revision === "string" &&
    quota.revision.length > 0 &&
    isPositiveSafeInteger(quota.roomRollingCap) &&
    isPositiveSafeInteger(quota.laneRollingCap) &&
    isNonNegativeSafeInteger(quota.roomConfirmedAmount) &&
    isNonNegativeSafeInteger(quota.roomUnmatchedPlannedAmount) &&
    isNonNegativeSafeInteger(quota.laneConfirmedAmount) &&
    isNonNegativeSafeInteger(quota.laneUnmatchedPlannedAmount)
  );
}

function normalizeOrder(order: MarketOrderSnapshot): Record<string, unknown> {
  return {
    amount: order.amount,
    created: order.created ?? null,
    id: order.id,
    price: order.price,
    remainingAmount: order.remainingAmount ?? null,
    resourceType: order.resourceType,
    roomName: order.roomName ?? null,
    totalAmount: order.totalAmount ?? null,
    type: order.type,
  };
}

interface MarketDirectContinuousNormalizedOrderArtifact {
  readonly source: MarketOrderSnapshot;
  readonly normalized: Record<string, unknown>;
  readonly canonical: string;
  readonly sortKey: string;
}

interface MarketDirectContinuousNormalizedBookArtifact {
  readonly book: MarketDirectContinuousBook;
  readonly orders: readonly MarketOrderSnapshot[];
  readonly ownOrderIds: readonly string[];
  readonly sourceOrders: MarketOrderSnapshot[];
  readonly normalizedOrders: MarketDirectContinuousNormalizedOrderArtifact[];
  valid: boolean;
  normalizedBook?: Record<string, unknown>;
}

interface MarketDirectContinuousInvocationArtifacts {
  readonly inputEntries: readonly MarketDirectContinuousEntryInput[];
  readonly capabilities: ReadonlyMap<
    MarketDirectContinuousBook,
    MarketDirectContinuousInvocationBookCapability
  >;
  readonly books: Map<
    MarketDirectContinuousBook,
    MarketDirectContinuousNormalizedBookArtifact
  >;
  readonly canonicalFragments: Map<object, string>;
  callbackInvoked: boolean;
  invalid: boolean;
}

interface InvocationBookCapabilityRegistration {
  readonly book: MarketDirectContinuousBook;
  consumed: boolean;
}

// 这两个 WeakMap 是模块内的身份注册表，不存储订单归一化或规划证据。
// key 随单次 full-read 快照/调用能力一同被 GC，且无法从对象反射得到注册记录。
const detachedBookSnapshotIssuers = new WeakMap<
  MarketDirectContinuousDetachedBookSnapshot,
  () => MarketDirectContinuousInvocationBookCapability
>();
const invocationBookCapabilityRegistrations = new WeakMap<
  MarketDirectContinuousInvocationBookCapability,
  InvocationBookCapabilityRegistration
>();

function copyDetachedOrder(
  source: MarketOrderSnapshot,
): MarketOrderSnapshot | undefined {
  if (!source || typeof source !== "object") return undefined;
  const id = source.id;
  const type = source.type;
  const resourceType = source.resourceType;
  const price = source.price;
  const amount = source.amount;
  const remainingAmount = source.remainingAmount;
  const totalAmount = source.totalAmount;
  const roomName = source.roomName;
  const created = source.created;
  if (
    typeof id !== "string" ||
    typeof type !== "string" ||
    typeof resourceType !== "string" ||
    typeof price !== "number" ||
    typeof amount !== "number" ||
    (remainingAmount !== undefined && typeof remainingAmount !== "number") ||
    (totalAmount !== undefined && typeof totalAmount !== "number") ||
    (roomName !== undefined && typeof roomName !== "string") ||
    (created !== undefined && typeof created !== "number")
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    type,
    resourceType,
    price,
    amount,
    ...(remainingAmount === undefined ? {} : { remainingAmount }),
    ...(totalAmount === undefined ? {} : { totalAmount }),
    ...(roomName === undefined ? {} : { roomName }),
    ...(created === undefined ? {} : { created }),
  });
}

/**
 * 把 collector 的当前 book 复制为没有 getter/Proxy/嵌套可变值的冻结快照。
 * 任何读取或形状异常都只会拒绝签发，planner 仍可走原有完整归一化路径。
 */
export function createMarketDirectContinuousDetachedBookSnapshot(
  source: MarketDirectContinuousBook,
): MarketDirectContinuousDetachedBookSnapshot | undefined {
  try {
    if (!source || typeof source !== "object") return undefined;
    const complete = source.complete;
    const revision = source.revision;
    const sourceOrders = source.orders;
    const sourceOwnOrderIds = source.ownOrderIds;
    if (
      typeof complete !== "boolean" ||
      typeof revision !== "string" ||
      !Array.isArray(sourceOrders) ||
      !Array.isArray(sourceOwnOrderIds)
    ) {
      return undefined;
    }
    const orders: MarketOrderSnapshot[] = [];
    for (let index = 0; index < sourceOrders.length; index += 1) {
      const order = copyDetachedOrder(sourceOrders[index]);
      if (!order) return undefined;
      orders.push(order);
    }
    const ownOrderIds: string[] = [];
    for (let index = 0; index < sourceOwnOrderIds.length; index += 1) {
      const orderId = sourceOwnOrderIds[index];
      if (typeof orderId !== "string") return undefined;
      ownOrderIds.push(orderId);
    }
    Object.freeze(orders);
    Object.freeze(ownOrderIds);
    const book: MarketDirectContinuousBook = Object.freeze({
      complete,
      revision,
      orders,
      ownOrderIds,
    });
    const issue = (): MarketDirectContinuousInvocationBookCapability => {
      const capability: MarketDirectContinuousInvocationBookCapability =
        Object.freeze({ book });
      invocationBookCapabilityRegistrations.set(capability, {
        book,
        consumed: false,
      });
      return capability;
    };
    const snapshot: MarketDirectContinuousDetachedBookSnapshot =
      Object.freeze({ book });
    detachedBookSnapshotIssuers.set(snapshot, issue);
    return snapshot;
  } catch {
    return undefined;
  }
}

/** 从本次 full-read 快照签发一枚一次性 planner 能力。 */
export function issueMarketDirectContinuousInvocationBookCapability(
  snapshot: MarketDirectContinuousDetachedBookSnapshot,
): MarketDirectContinuousInvocationBookCapability | undefined {
  try {
    const issue = detachedBookSnapshotIssuers.get(snapshot);
    return typeof issue === "function" ? issue() : undefined;
  } catch {
    return undefined;
  }
}

function consumeInvocationBookCapability(
  capability: MarketDirectContinuousInvocationBookCapability,
  book: MarketDirectContinuousBook,
): boolean {
  try {
    const registration = invocationBookCapabilityRegistrations.get(capability);
    if (
      !registration ||
      registration.consumed ||
      registration.book !== book
    ) {
      return false;
    }
    registration.consumed = true;
    return true;
  } catch {
    return false;
  }
}

function createInvocationArtifacts(
  input: PlanMarketDirectContinuousInput,
  options: MarketDirectContinuousInvocationOptions | undefined,
): MarketDirectContinuousInvocationArtifacts | undefined {
  try {
    const capabilities = options?.detachedBookCapabilities;
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      return undefined;
    }
    const byBook = new Map<
      MarketDirectContinuousBook,
      MarketDirectContinuousInvocationBookCapability
    >();
    for (const capability of capabilities) {
      const book = capability?.book;
      if (!book || byBook.has(book)) return undefined;
      byBook.set(book, capability);
    }
    return {
      inputEntries: input.entries,
      capabilities: byBook,
      books: new Map(),
      canonicalFragments: new Map(),
      callbackInvoked: false,
      invalid: false,
    };
  } catch {
    return undefined;
  }
}

function beginBookArtifact(
  artifacts: MarketDirectContinuousInvocationArtifacts | undefined,
  book: MarketDirectContinuousBook,
  usesOnlyV3ResourceBook: boolean,
): MarketDirectContinuousNormalizedBookArtifact | undefined {
  if (!artifacts || !usesOnlyV3ResourceBook) return undefined;
  try {
    const capability = artifacts.capabilities.get(book);
    if (
      !capability ||
      artifacts.books.has(book) ||
      !consumeInvocationBookCapability(capability, book)
    ) {
      artifacts.invalid = true;
      return undefined;
    }
    const artifact: MarketDirectContinuousNormalizedBookArtifact = {
      book,
      orders: book.orders,
      ownOrderIds: book.ownOrderIds,
      sourceOrders: [],
      normalizedOrders: [],
      valid: true,
    };
    artifacts.books.set(book, artifact);
    return artifact;
  } catch {
    artifacts.invalid = true;
    return undefined;
  }
}

function captureOrderArtifact(
  artifacts: MarketDirectContinuousInvocationArtifacts | undefined,
  artifact: MarketDirectContinuousNormalizedBookArtifact | undefined,
  source: MarketOrderSnapshot,
  normalized: Record<string, unknown>,
  canonical: string,
): void {
  if (!artifacts || !artifact) return;
  try {
    artifact.sourceOrders.push(source);
    artifact.normalizedOrders.push({
      source,
      normalized,
      canonical,
      sortKey: `${String(normalized.id ?? "")}|${canonical}`,
    });
    artifacts.canonicalFragments.set(normalized, canonical);
  } catch {
    artifact.valid = false;
    artifacts.invalid = true;
  }
}

function finalizeBookArtifact(
  artifacts: MarketDirectContinuousInvocationArtifacts | undefined,
  artifact: MarketDirectContinuousNormalizedBookArtifact | undefined,
): void {
  if (
    !artifacts ||
    !artifact ||
    !artifact.valid ||
    artifact.sourceOrders.length !== artifact.orders.length ||
    artifact.normalizedOrders.length !== artifact.orders.length
  ) {
    return;
  }
  const sortedOrders = [...artifact.normalizedOrders].sort((left, right) =>
    stableStringCompare(left.sortKey, right.sortKey));
  const canonicalById = new Map<string, string>();
  const deduplicatedOrders: Array<Record<string, unknown>> = [];
  for (const { normalized, canonical } of sortedOrders) {
    const orderId = String(normalized.id ?? "");
    if (canonicalById.get(orderId) === canonical) continue;
    canonicalById.set(orderId, canonical);
    deduplicatedOrders.push(normalized);
  }
  const normalizedBook: Record<string, unknown> = {
    complete: artifact.book.complete,
    revision: artifact.book.revision,
    ownOrderIds: [...artifact.ownOrderIds].sort(stableStringCompare),
    orders: deduplicatedOrders,
  };
  const canonical = stableCanonicalWithFragments(
    normalizedBook,
    artifacts.canonicalFragments,
  );
  artifacts.canonicalFragments.set(normalizedBook, canonical);
  artifact.normalizedBook = normalizedBook;
}

function normalizeBook(
  book: MarketDirectContinuousBook | undefined,
): Record<string, unknown> | null {
  if (!book) return null;
  const normalizedOrders = Array.isArray(book.orders)
    ? book.orders
      .map((order) => {
        const normalized = normalizeOrder(order);
        const canonical = stableCanonical(normalized);
        return {
          normalized,
          canonical,
          sortKey: `${String(normalized.id ?? "")}|${canonical}`,
        };
      })
      .sort((left, right) =>
        stableStringCompare(left.sortKey, right.sortKey))
    : undefined;
  const canonicalById = new Map<string, string>();
  const deduplicatedOrders: Array<Record<string, unknown>> = [];
  for (const { normalized, canonical } of normalizedOrders ?? []) {
    const orderId = String(normalized.id ?? "");
    if (canonicalById.get(orderId) === canonical) continue;
    canonicalById.set(orderId, canonical);
    deduplicatedOrders.push(normalized);
  }
  return {
    complete: book.complete,
    revision: book.revision,
    ownOrderIds: Array.isArray(book.ownOrderIds)
      ? [...book.ownOrderIds].sort(stableStringCompare)
      : "<invalid>",
    orders: normalizedOrders ? deduplicatedOrders : "<invalid>",
  };
}

function normalizeInput(
  input: PlanMarketDirectContinuousInput,
  artifacts?: MarketDirectContinuousInvocationArtifacts,
): Record<string, unknown> {
  if (!input || !Array.isArray(input.entries)) {
    return { invalidInput: true };
  }
  return {
    energyShadow: { ...input.energyShadow },
    entries: [...input.entries]
      .sort((left, right) =>
        stableStringCompare(left.policy.entryId, right.policy.entryId))
      .map((entry) => ({
        policy: {
          ...entry.policy,
          allowedRooms: [...entry.policy.allowedRooms].sort(stableStringCompare),
        },
        quota: { ...entry.quota },
        book: artifacts
          ? artifacts.books.get(entry.book!)!.normalizedBook!
          : normalizeBook(entry.book),
        lanes: [...entry.lanes]
          .sort((left, right) =>
            stableStringCompare(left.lane.roomName, right.lane.roomName))
          .map((laneInput) => ({
            lane: { ...laneInput.lane },
            protection: { ...laneInput.protection },
            terminal: { ...laneInput.terminal },
            quota: laneInput.quota ? { ...laneInput.quota } : null,
            legacyBookAdapter: normalizeBook(laneInput.book),
          })),
      })),
    globalQuota: { ...input.globalQuota },
    writeContext: { ...input.writeContext },
  };
}

function stableCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return JSON.stringify("<NaN>");
    if (value === Number.POSITIVE_INFINITY) return JSON.stringify("<Infinity>");
    if (value === Number.NEGATIVE_INFINITY) return JSON.stringify("<-Infinity>");
    if (Object.is(value, -0)) return "0";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(stableStringCompare)
      .map((key) => `${JSON.stringify(key)}:${stableCanonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(`<${typeof value}>`);
}

function stableCanonicalWithFragments(
  value: unknown,
  canonicalFragments: ReadonlyMap<object, string>,
): string {
  if (value === null || typeof value !== "object") {
    return stableCanonical(value);
  }
  const fragment = canonicalFragments.get(value);
  if (fragment !== undefined) return fragment;
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) =>
        stableCanonicalWithFragments(entry, canonicalFragments))
      .join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(stableStringCompare)
    .map((key) =>
      `${JSON.stringify(key)}:` +
      stableCanonicalWithFragments(object[key], canonicalFragments))
    .join(",")}}`;
}

function usableInvocationArtifacts(
  input: PlanMarketDirectContinuousInput,
  artifacts: MarketDirectContinuousInvocationArtifacts | undefined,
  selected: MarketDirectContinuousCandidate | undefined,
  isolatedShadowLanes:
    MarketDirectContinuousPlanningResult["isolatedShadowLanes"],
): MarketDirectContinuousInvocationArtifacts | undefined {
  try {
    if (
      !artifacts ||
      artifacts.invalid ||
      artifacts.callbackInvoked ||
      selected !== undefined ||
      isolatedShadowLanes.length > 0 ||
      input.entries !== artifacts.inputEntries ||
      artifacts.books.size !== input.entries.length
    ) {
      return undefined;
    }
    for (const entry of input.entries) {
      if (
        entry.policy.evaluatorVersion !== 3 ||
        entry.lanes.some((laneInput) => laneInput.book !== undefined) ||
        !entry.book
      ) {
        return undefined;
      }
      const artifact = artifacts.books.get(entry.book);
      if (
        !artifact ||
        artifact.book !== entry.book ||
        artifact.orders !== entry.book.orders ||
        artifact.ownOrderIds !== entry.book.ownOrderIds ||
        artifact.sourceOrders.length !== entry.book.orders.length ||
        artifact.sourceOrders.some(
          (source, index) => source !== entry.book!.orders[index],
        )
      ) {
        return undefined;
      }
    }
    // 只有所有业务分支都证明是无候选、无 callback 的安全路径后，
    // 才付出排序和 book canonical 成本。任何 artifact 异常都回退旧路径。
    for (const artifact of artifacts.books.values()) {
      finalizeBookArtifact(artifacts, artifact);
      if (!artifact.normalizedBook) return undefined;
    }
    return artifacts.invalid ? undefined : artifacts;
  } catch {
    if (artifacts) artifacts.invalid = true;
    return undefined;
  }
}

function observeNormalizationArtifact(
  options: MarketDirectContinuousInvocationOptions | undefined,
  used: boolean,
): void {
  try {
    options?.observeNormalizationArtifact?.(used);
  } catch {
    // 观测钩子不属于规划输入，绝不能改变规划结果。
  }
}

function canonicalBookEvidence(
  book: MarketDirectContinuousBook | undefined,
): string {
  return stableCanonical(normalizeBook(book));
}

function collectResourceBookReferences(
  input: PlanMarketDirectContinuousInput,
): Array<{
  book: MarketDirectContinuousBook;
  orders: readonly MarketOrderSnapshot[];
  ownOrderIds: readonly string[];
}> {
  if (!input || !Array.isArray(input.entries)) return [];
  const references: Array<{
    book: MarketDirectContinuousBook;
    orders: readonly MarketOrderSnapshot[];
    ownOrderIds: readonly string[];
  }> = [];
  const stableEntries = [...input.entries].sort((left, right) =>
    stableStringCompare(left.policy.entryId, right.policy.entryId));
  for (const entry of stableEntries) {
    const book = entry.book ?? (
      Array.isArray(entry.lanes)
        ? entry.lanes.find((laneInput) => laneInput.book !== undefined)?.book
        : undefined
    );
    if (book) {
      references.push({
        book,
        orders: book.orders,
        ownOrderIds: book.ownOrderIds,
      });
    }
  }
  return references;
}

const resultBookReferences = new WeakMap<
  MarketDirectContinuousPlanningResult,
  ReadonlyArray<{
    book: MarketDirectContinuousBook;
    orders: readonly MarketOrderSnapshot[];
    ownOrderIds: readonly string[];
  }>
>();

function shortFingerprint(evidence: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < evidence.length; index += 1) {
    hash ^= evidence.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `market-direct-continuous:plan:v1:${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")}:${evidence.length}`;
}

function candidateTupleKey(candidate: Pick<
  MarketDirectContinuousCandidate,
  "resourceType" | "roomName" | "order" | "plannedAmount"
>): string {
  return [
    candidate.resourceType,
    candidate.roomName,
    candidate.order.id,
    candidate.order.price,
    remainingOrderAmount(candidate.order),
    candidate.plannedAmount,
  ].join("|");
}

/**
 * 价格优先级只使用：单位净价、总净额、gross、resource/room/orderId。
 * 订单量、库存、容量压力和配置顺序均不参与比较。
 */
export function compareMarketDirectContinuousCandidates(
  left: MarketDirectContinuousCandidate,
  right: MarketDirectContinuousCandidate,
): number {
  const unitComparison = compareSafeIntegerRatios(
    left.netCreditsMilli,
    left.plannedAmount,
    right.netCreditsMilli,
    right.plannedAmount,
  );
  if (unitComparison !== 0) {
    return -unitComparison;
  }
  if (left.netCreditsMilli !== right.netCreditsMilli) {
    return left.netCreditsMilli > right.netCreditsMilli ? -1 : 1;
  }
  if (left.grossPriceMilli !== right.grossPriceMilli) {
    return left.grossPriceMilli > right.grossPriceMilli ? -1 : 1;
  }
  const resourceComparison = stableStringCompare(left.resourceType, right.resourceType);
  if (resourceComparison !== 0) return resourceComparison;
  const roomComparison = stableStringCompare(left.roomName, right.roomName);
  if (roomComparison !== 0) return roomComparison;
  return stableStringCompare(left.order.id, right.order.id);
}

/**
 * 以连分数比较两个非负 safe-integer 比值，避免高价订单在
 * `netCreditsMilli * plannedAmount` 交叉相乘时越过 2^53。
 * 返回值语义与普通 comparator 相同：left < right 为 -1。
 */
function compareSafeIntegerRatios(
  leftNumerator: number,
  leftDenominator: number,
  rightNumerator: number,
  rightDenominator: number,
): number {
  if (
    !Number.isSafeInteger(leftNumerator) ||
    leftNumerator < 0 ||
    !Number.isSafeInteger(rightNumerator) ||
    rightNumerator < 0 ||
    !Number.isSafeInteger(leftDenominator) ||
    leftDenominator <= 0 ||
    !Number.isSafeInteger(rightDenominator) ||
    rightDenominator <= 0
  ) {
    const leftUnit =
      leftNumerator / leftDenominator;
    const rightUnit =
      rightNumerator / rightDenominator;
    return leftUnit === rightUnit
      ? 0
      : leftUnit < rightUnit
        ? -1
        : 1;
  }
  let leftN = leftNumerator;
  let leftD = leftDenominator;
  let rightN = rightNumerator;
  let rightD = rightDenominator;
  let direction = 1;
  while (true) {
    const leftWhole = Math.floor(
      leftN / leftD,
    );
    const rightWhole = Math.floor(
      rightN / rightD,
    );
    if (leftWhole !== rightWhole) {
      return (
        (leftWhole < rightWhole ? -1 : 1) *
        direction
      );
    }
    const leftRemainder =
      leftN - leftWhole * leftD;
    const rightRemainder =
      rightN - rightWhole * rightD;
    if (
      leftRemainder === 0 ||
      rightRemainder === 0
    ) {
      if (
        leftRemainder ===
        rightRemainder
      ) {
        return 0;
      }
      return (
        (leftRemainder === 0 ? -1 : 1) *
        direction
      );
    }
    leftN = leftD;
    leftD = leftRemainder;
    rightN = rightD;
    rightD = rightRemainder;
    direction *= -1;
  }
}

function finishResult(
  input: PlanMarketDirectContinuousInput,
  partial: Omit<
    MarketDirectContinuousPlanningResult,
    | "planningFingerprint"
    | "planningEvidence"
    | "budget"
    | "isolatedShadowLanes"
  >,
  energyObservations: readonly EnergyObservation[] = [],
  budget: MarketDirectContinuousPlanningResult["budget"] = {
    sellerRooms: 0,
    distinctOrderRooms: 0,
    transactionEnergyEvaluations: 0,
  },
  isolatedShadowLanes:
    MarketDirectContinuousPlanningResult["isolatedShadowLanes"] = [],
  normalizationArtifacts?: MarketDirectContinuousInvocationArtifacts,
): MarketDirectContinuousPlanningResult {
  const evidenceInput = {
    input: normalizeInput(input, normalizationArtifacts),
    observation: {
      blocker: partial.blocker ?? null,
      energy: [...energyObservations].sort((left, right) =>
        stableStringCompare(
          `${left.entryId}|${left.roomName}|${left.orderId}`,
          `${right.entryId}|${right.roomName}|${right.orderId}`,
        )),
      rejections: [...partial.rejections].sort((left, right) =>
        stableStringCompare(
          `${left.entryId}|${left.roomName}|${left.orderId ?? ""}|${left.reason}`,
          `${right.entryId}|${right.roomName}|${right.orderId ?? ""}|${right.reason}`,
        )),
      safeTupleKeys: partial.safeCandidates.map((candidate) => candidate.tupleKey),
      admittedTupleKeys: partial.admittedCandidates.map((candidate) =>
        candidate.tupleKey),
      selectedTupleKey: partial.selected?.tupleKey ?? null,
      budget,
      isolatedShadowLanes: [...isolatedShadowLanes].sort((left, right) =>
        stableStringCompare(
          `${left.entryId}|${left.roomName}|${left.reason}`,
          `${right.entryId}|${right.roomName}|${right.reason}`,
        )),
    },
  };
  const evidence = normalizationArtifacts
    ? stableCanonicalWithFragments(
        evidenceInput,
        normalizationArtifacts.canonicalFragments,
      )
    : stableCanonical(evidenceInput);
  const result: MarketDirectContinuousPlanningResult = {
    ...partial,
    planningFingerprint: shortFingerprint(evidence),
    planningEvidence: evidence,
    budget,
    isolatedShadowLanes,
  };
  resultBookReferences.set(result, collectResourceBookReferences(input));
  return result;
}

function blockedResult(
  input: PlanMarketDirectContinuousInput,
  blocker: MarketDirectContinuousBlocker,
  rejections: MarketDirectContinuousTupleRejection[] = [],
  energyObservations: readonly EnergyObservation[] = [],
  budget?: MarketDirectContinuousPlanningResult["budget"],
  isolatedShadowLanes?:
    MarketDirectContinuousPlanningResult["isolatedShadowLanes"],
): MarketDirectContinuousPlanningResult {
  return finishResult(input, {
    complete: false,
    blocker,
    safeCandidates: [],
    admittedCandidates: [],
    rejections,
  }, energyObservations, budget, isolatedShadowLanes);
}

/**
 * 对所有 permit 参与 entry/lane 的完整 BUY book 做一次纯函数规划。
 * 本模块不拥有、也不调用真实市场写入口。
 */
export function planMarketDirectContinuous(
  input: PlanMarketDirectContinuousInput,
  options?: MarketDirectContinuousInvocationOptions,
): MarketDirectContinuousPlanningResult {
  if (
    !input ||
    !Array.isArray(input.entries) ||
    input.entries.length === 0
  ) {
    return blockedResult(input, { reason: "invalid_input" });
  }
  if (
    !input.writeContext?.complete ||
    typeof input.writeContext.revision !== "string" ||
    input.writeContext.revision.length === 0 ||
    !Number.isFinite(input.writeContext.credits) ||
    input.writeContext.credits < 0 ||
    !isPositiveSafeInteger(input.writeContext.permitEpoch) ||
    typeof input.writeContext.permitId !== "string" ||
    input.writeContext.permitId.length === 0 ||
    typeof input.writeContext.permitHead !== "string" ||
    input.writeContext.permitHead.length === 0 ||
    input.writeContext.executorShard !== "shard1"
  ) {
    return blockedResult(input, { reason: "write_context_incomplete" });
  }
  if (
    input.writeContext.pendingState !== "none" ||
    input.writeContext.arbiterState !== "available"
  ) {
    return blockedResult(input, { reason: "write_context_blocked" });
  }
  if (
    !input.energyShadow?.complete ||
    typeof input.energyShadow.revision !== "string" ||
    input.energyShadow.revision.length === 0 ||
    !Number.isFinite(input.energyShadow.price) ||
    input.energyShadow.price < 0
  ) {
    return blockedResult(input, { reason: "energy_shadow_incomplete" });
  }
  if (!globalQuotaIsValid(input.globalQuota)) {
    return blockedResult(input, { reason: "global_quota_incomplete" });
  }

  let energyShadowPriceMilli: MilliCredits;
  try {
    energyShadowPriceMilli = input.energyShadow.price === 0
      ? 0
      : priceToMilliUp(input.energyShadow.price);
  } catch (error) {
    return blockedResult(input, {
      reason: "unsafe_arithmetic",
      detail: error instanceof Error ? error.message : "energy shadow conversion failed",
    });
  }

  const entryIds = new Set<string>();
  const resourceTypes = new Set<string>();
  const laneKeys = new Set<string>();
  const sellerRooms = new Set<string>();
  const globalOrderIds = new Map<
    string,
    { resourceType: string; canonical: string }
  >();
  const distinctOrderRooms = new Set<string>();
  const preparedLanes: PreparedLane[] = [];
  const rejections: MarketDirectContinuousTupleRejection[] = [];
  const isolatedShadowLanes:
    MarketDirectContinuousPlanningResult["isolatedShadowLanes"] = [];
  let budget: MarketDirectContinuousPlanningResult["budget"] = {
    sellerRooms: 0,
    distinctOrderRooms: 0,
    transactionEnergyEvaluations: 0,
  };
  const normalizationArtifacts = options === undefined
    ? undefined
    : createInvocationArtifacts(input, options);

  if (input.entries.length > MARKET_DIRECT_CONTINUOUS_MAX_RESOURCES) {
    return blockedResult(input, {
      reason: "entry_scope_invalid",
      detail:
        `${input.entries.length}>${MARKET_DIRECT_CONTINUOUS_MAX_RESOURCES}`,
    });
  }

  // 第一阶段只验证完整 scope。任何交易能量计算都必须晚于全 book、
  // distinct orderRoom 和 evaluation hard budget 的整体核验。
  const scopeEntries = [...input.entries].sort((left, right) =>
    stableStringCompare(left.policy.entryId, right.policy.entryId));
  for (const entry of scopeEntries) {
    const { policy, quota } = entry;
    if (
      !policyIsValid(policy) ||
      entryIds.has(policy.entryId) ||
      resourceTypes.has(policy.resourceType) ||
      !quotaIsValid(quota, policy) ||
      !Array.isArray(entry.lanes) ||
      entry.lanes.length === 0 ||
      entry.lanes.length !== policy.allowedRooms.length ||
      new Set(entry.lanes.map((laneInput) => laneInput.lane.roomName)).size !==
        policy.allowedRooms.length ||
      policy.allowedRooms.some((roomName) =>
        !entry.lanes.some((laneInput) => laneInput.lane.roomName === roomName))
    ) {
      return blockedResult(input, {
        reason: "entry_scope_invalid",
        entryId: policy?.entryId,
      });
    }
    entryIds.add(policy.entryId);
    resourceTypes.add(policy.resourceType);

    let effectiveNetFloorMilli: MilliCredits;
    let minExecutableNotionalMilli: MilliCredits;
    try {
      effectiveNetFloorMilli = priceToMilliUp(effectiveFloor(policy)!);
      minExecutableNotionalMilli = priceToMilliUp(policy.minExecutableNotional);
    } catch (error) {
      return blockedResult(input, {
        reason: "unsafe_arithmetic",
        entryId: policy.entryId,
        detail: error instanceof Error ? error.message : "policy conversion failed",
      });
    }

    const writableLanes: MarketDirectContinuousLaneInput[] = [];
    const structurallyValidShadowLanes: MarketDirectContinuousLaneInput[] = [];
    const stableLanes = [...entry.lanes].sort((left, right) =>
      stableStringCompare(left.lane.roomName, right.lane.roomName));
    for (const laneInput of stableLanes) {
      const { lane, protection, terminal } = laneInput;
      const laneKey = `${policy.resourceType}|${lane.roomName}`;
      const authorization = lane.authorization ?? "writable";
      const v2Scope = (policy.evaluatorVersion ?? 2) === 2;
      if (
        laneKeys.has(laneKey) ||
        lane.resourceType !== policy.resourceType ||
        !policy.allowedRooms.includes(lane.roomName) ||
        !lane.owned ||
        (authorization !== "writable" &&
          authorization !== "suspended_shadow") ||
        (v2Scope && lane.hub) ||
        (v2Scope && lane.capacityEmergency) ||
        (v2Scope && policy.requireNativeMineral &&
          lane.nativeMineralType !== policy.resourceType) ||
        typeof lane.roomName !== "string" ||
        lane.roomName.length === 0
      ) {
        return blockedResult(input, {
          reason: "lane_scope_invalid",
          entryId: policy.entryId,
          roomName: lane?.roomName,
        });
      }
      laneKeys.add(laneKey);
      sellerRooms.add(lane.roomName);

      const terminalComplete = (
        typeof laneInput.calculateTransactionEnergy === "function" ||
        typeof entry.calculateTransactionEnergy === "function"
      ) &&
        terminal.normal &&
        (v2Scope || typeof terminal.ready === "boolean") &&
        !terminal.claimed &&
        isNonNegativeSafeInteger(terminal.cooldown) &&
        (!v2Scope || terminal.cooldown === 0) &&
        isNonNegativeSafeInteger(terminal.resourceAmount) &&
        isNonNegativeSafeInteger(terminal.energy) &&
        (
          terminal.effectivePostDealEnergyReserve === undefined ||
          isNonNegativeSafeInteger(terminal.effectivePostDealEnergyReserve)
        ) &&
        typeof terminal.revision === "string" &&
        terminal.revision.length > 0;
      if (!terminalComplete) {
        if (authorization === "suspended_shadow") {
          isolatedShadowLanes.push({
            entryId: policy.entryId,
            roomName: lane.roomName,
            reason: "lane_scope_invalid",
          });
          continue;
        }
        return blockedResult(input, {
          reason: "lane_scope_invalid",
          entryId: policy.entryId,
          roomName: lane?.roomName,
        });
      }
      if (
        !protection.complete ||
        typeof protection.revision !== "string" ||
        protection.revision.length === 0 ||
        !isNonNegativeSafeInteger(protection.sellableAmount)
      ) {
        if (authorization === "suspended_shadow") {
          isolatedShadowLanes.push({
            entryId: policy.entryId,
            roomName: lane.roomName,
            reason: "protection_incomplete",
          });
          continue;
        }
        return blockedResult(input, {
          reason: "protection_incomplete",
          entryId: policy.entryId,
          roomName: lane.roomName,
        });
      }
      if (
        authorization === "writable" &&
        policy.evaluatorVersion === 3 &&
        (!laneInput.quota || !laneQuotaIsValid(laneInput.quota))
      ) {
        return blockedResult(input, {
          reason: "lane_quota_incomplete",
          entryId: policy.entryId,
          roomName: lane.roomName,
        });
      }
      if (authorization === "writable") {
        writableLanes.push(laneInput);
      } else {
        structurallyValidShadowLanes.push(laneInput);
      }
    }

    if (laneKeys.size > MARKET_DIRECT_CONTINUOUS_MAX_LANES) {
      return blockedResult(input, {
        reason: "lane_limit_exceeded",
        detail: `${laneKeys.size}>${MARKET_DIRECT_CONTINUOUS_MAX_LANES}`,
      });
    }
    if (sellerRooms.size > MARKET_DIRECT_CONTINUOUS_MAX_SELLER_ROOMS) {
      return blockedResult(input, {
        reason: "seller_room_limit_exceeded",
        detail:
          `${sellerRooms.size}>${MARKET_DIRECT_CONTINUOUS_MAX_SELLER_ROOMS}`,
      });
    }

    const book = policy.evaluatorVersion === 3
      ? entry.book
      : entry.book ?? entry.lanes[0]?.book;
    const usesOnlyV3ResourceBook =
      policy.evaluatorVersion === 3 &&
      entry.lanes.every((laneInput) => laneInput.book === undefined);
    let adapterBookConflict = !book;
    if (!usesOnlyV3ResourceBook) {
      const bookEvidence = canonicalBookEvidence(book);
      adapterBookConflict ||= entry.lanes.some((laneInput) =>
        laneInput.book !== undefined &&
        canonicalBookEvidence(laneInput.book) !== bookEvidence);
    }
    const bookComplete = !adapterBookConflict &&
      book.complete &&
      typeof book.revision === "string" &&
      book.revision.length > 0 &&
      Array.isArray(book.orders) &&
      Array.isArray(book.ownOrderIds) &&
      book.ownOrderIds.every((orderId) =>
        typeof orderId === "string" && orderId.length > 0);
    if (!bookComplete) {
      if (writableLanes.length > 0) {
        return blockedResult(input, {
          reason: "book_incomplete",
          entryId: policy.entryId,
          detail: adapterBookConflict
            ? "resource_book_not_shared"
            : "resource_book_invalid",
        });
      }
      for (const laneInput of structurallyValidShadowLanes) {
        isolatedShadowLanes.push({
          entryId: policy.entryId,
          roomName: laneInput.lane.roomName,
          reason: "book_incomplete",
        });
      }
      continue;
    }
    if (book.orders.length > policy.maxRawOrders) {
      if (writableLanes.length > 0) {
        return blockedResult(input, {
          reason: "raw_book_limit_exceeded",
          entryId: policy.entryId,
          detail: `${book.orders.length}>${policy.maxRawOrders}`,
        });
      }
      for (const laneInput of structurallyValidShadowLanes) {
        isolatedShadowLanes.push({
          entryId: policy.entryId,
          roomName: laneInput.lane.roomName,
          reason: "book_incomplete",
        });
      }
      continue;
    }

    const bookArtifact = normalizationArtifacts
      ? beginBookArtifact(
          normalizationArtifacts,
          book,
          usesOnlyV3ResourceBook,
        )
      : undefined;
    const seenOrderIds = new Map<string, string>();
    const ownOrderIds = new Set(book.ownOrderIds);
    const eligibleOrders: EligibleOrder[] = [];
    const resourceOrderRooms = new Set<string>();
    let shadowBookIncomplete = false;
    for (const order of book.orders) {
      const orderId = typeof order?.id === "string" && order.id.length > 0
        ? order.id
        : undefined;
      if (!orderId) {
        if (writableLanes.length > 0) {
          return blockedResult(input, {
            reason: "book_incomplete",
            entryId: policy.entryId,
            detail: "order_id_missing",
          }, rejections);
        }
        shadowBookIncomplete = true;
        continue;
      }
      const normalizedOrder = normalizeOrder(order);
      const orderCanonical = stableCanonical(normalizedOrder);
      if (bookArtifact) {
        captureOrderArtifact(
          normalizationArtifacts,
          bookArtifact,
          order,
          normalizedOrder,
          orderCanonical,
        );
      }
      const seenCanonical = seenOrderIds.get(orderId);
      if (seenCanonical !== undefined) {
        if (seenCanonical === orderCanonical) {
          continue;
        }
        if (writableLanes.length > 0) {
          return blockedResult(input, {
            reason: "duplicate_order_id",
            entryId: policy.entryId,
            orderId,
            detail: "same_resource_order_id_conflict",
          }, rejections);
        }
        shadowBookIncomplete = true;
        continue;
      }
      seenOrderIds.set(orderId, orderCanonical);

      if (
        order.type !== "buy" ||
        order.resourceType !== policy.resourceType ||
        typeof order.roomName !== "string" ||
        order.roomName.length === 0 ||
        !Number.isFinite(order.price) ||
        order.price <= 0 ||
        !isPositiveSafeInteger(order.amount) ||
        (order.remainingAmount !== undefined &&
          !isPositiveSafeInteger(order.remainingAmount))
      ) {
        if (writableLanes.length > 0) {
          return blockedResult(input, {
            reason: "book_incomplete",
            entryId: policy.entryId,
            orderId,
            detail: "order_shape_or_scope_invalid",
          }, rejections);
        }
        shadowBookIncomplete = true;
        continue;
      }
      if (ownOrderIds.has(orderId)) {
        for (const laneInput of writableLanes) {
          rejections.push({
            entryId: policy.entryId,
            resourceType: policy.resourceType,
            roomName: laneInput.lane.roomName,
            orderId,
            reason: "self_order",
          });
        }
        continue;
      }

      const remainingAmount = remainingOrderAmount(order);
      if (remainingAmount < MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT) {
        for (const laneInput of writableLanes) {
          rejections.push({
            entryId: policy.entryId,
            resourceType: policy.resourceType,
            roomName: laneInput.lane.roomName,
            orderId,
            reason: "order_amount_below_plan",
          });
        }
        continue;
      }

      let grossPriceMilli: MilliCredits;
      try {
        grossPriceMilli = priceToMilliDown(order.price);
      } catch (error) {
        if (writableLanes.length === 0) {
          shadowBookIncomplete = true;
          continue;
        }
        return blockedResult(input, {
          reason: "unsafe_arithmetic",
          entryId: policy.entryId,
          orderId,
          detail:
            error instanceof Error
              ? error.message
              : "order price conversion failed",
        }, rejections);
      }
      const executableNotionalMilli = checkedMultiply(
        grossPriceMilli,
        MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
      );
      if (executableNotionalMilli === undefined) {
        if (writableLanes.length === 0) {
          shadowBookIncomplete = true;
          continue;
        }
        return blockedResult(input, {
          reason: "unsafe_arithmetic",
          entryId: policy.entryId,
          orderId,
          detail: "executable notional overflow",
        }, rejections);
      }
      if (executableNotionalMilli < minExecutableNotionalMilli) {
        for (const laneInput of writableLanes) {
          rejections.push({
            entryId: policy.entryId,
            resourceType: policy.resourceType,
            roomName: laneInput.lane.roomName,
            orderId,
            reason: "executable_notional_below_minimum",
          });
        }
        continue;
      }
      eligibleOrders.push({
        order,
        remainingAmount,
        grossPriceMilli,
        executableNotionalMilli,
      });
      resourceOrderRooms.add(order.roomName);
    }
    if (shadowBookIncomplete) {
      for (const laneInput of structurallyValidShadowLanes) {
        isolatedShadowLanes.push({
          entryId: policy.entryId,
          roomName: laneInput.lane.roomName,
          reason: "book_incomplete",
        });
      }
      continue;
    }
    if (eligibleOrders.length > policy.maxEligibleOrders) {
      if (writableLanes.length > 0) {
        return blockedResult(input, {
          reason: "eligible_book_limit_exceeded",
          entryId: policy.entryId,
          detail: `${eligibleOrders.length}>${policy.maxEligibleOrders}`,
        }, rejections);
      }
      for (const laneInput of structurallyValidShadowLanes) {
        isolatedShadowLanes.push({
          entryId: policy.entryId,
          roomName: laneInput.lane.roomName,
          reason: "book_incomplete",
        });
      }
      continue;
    }
    for (const [orderId, canonical] of seenOrderIds) {
      const globalOrder = globalOrderIds.get(orderId);
      if (globalOrder) {
        return blockedResult(input, {
          reason: "duplicate_order_id",
          entryId: policy.entryId,
          orderId,
          detail:
            `cross_resource:${globalOrder.resourceType}:${policy.resourceType}`,
        }, rejections);
      }
      globalOrderIds.set(orderId, {
        resourceType: policy.resourceType,
        canonical,
      });
    }
    for (const orderRoom of resourceOrderRooms) {
      distinctOrderRooms.add(orderRoom);
    }
    const preparedResource: PreparedResource = {
      entry,
      effectiveNetFloorMilli,
      minExecutableNotionalMilli,
      book,
      eligibleOrders,
      resourceCalculator: entry.calculateTransactionEnergy,
    };
    for (const laneInput of writableLanes) {
      preparedLanes.push({
        preparedResource,
        laneInput,
      });
    }
  }

  budget = {
    sellerRooms: sellerRooms.size,
    distinctOrderRooms: distinctOrderRooms.size,
    transactionEnergyEvaluations: 0,
  };
  if (
    distinctOrderRooms.size >
    MARKET_DIRECT_CONTINUOUS_MAX_DISTINCT_ORDER_ROOMS
  ) {
    return blockedResult(input, {
      reason: "distinct_order_room_limit_exceeded",
      detail:
        `${distinctOrderRooms.size}>` +
        `${MARKET_DIRECT_CONTINUOUS_MAX_DISTINCT_ORDER_ROOMS}`,
    }, rejections, [], budget, isolatedShadowLanes);
  }
  const maximumEvaluations = checkedMultiply(
    2,
    checkedMultiply(sellerRooms.size, distinctOrderRooms.size) ??
      Number.MAX_SAFE_INTEGER,
  );
  if (
    maximumEvaluations === undefined ||
    maximumEvaluations >
      MARKET_DIRECT_CONTINUOUS_MAX_TRANSACTION_ENERGY_EVALUATIONS
  ) {
    return blockedResult(input, {
      reason: "transaction_energy_evaluation_limit_exceeded",
      detail:
        `${maximumEvaluations ?? "overflow"}>` +
        `${MARKET_DIRECT_CONTINUOUS_MAX_TRANSACTION_ENERGY_EVALUATIONS}`,
    }, rejections, [], budget, isolatedShadowLanes);
  }

  const safeCandidates: MarketDirectContinuousCandidate[] = [];
  const energyObservations: EnergyObservation[] = [];
  const transactionEnergyMemo = new Map<string, number>();
  for (const prepared of preparedLanes) {
    const { preparedResource, laneInput } = prepared;
    const { entry, effectiveNetFloorMilli } = preparedResource;
    const { policy, quota } = entry;
    const { lane, protection, terminal } = laneInput;
    if (
      policy.evaluatorVersion === 3 &&
      (terminal.cooldown !== 0 ||
        terminal.ready !== true)
    ) {
      continue;
    }
    if (
      protection.sellableAmount < MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT ||
      terminal.resourceAmount < MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT
    ) {
      continue;
    }

    for (const eligible of preparedResource.eligibleOrders) {
      let transactionEnergy: number;
      let worstCaseTransactionEnergy: number;
      try {
        const calculator = preparedResource.resourceCalculator ??
          laneInput.calculateTransactionEnergy;
        if (!calculator || !eligible.order.roomName) {
          throw new Error("transaction energy calculator unavailable");
        }
        const readTransactionEnergy = (amount: number): number => {
          const memoKey =
            `${amount}|${lane.roomName}|${eligible.order.roomName}`;
          const memoized = transactionEnergyMemo.get(memoKey);
          if (memoized !== undefined) return memoized;
          if (
            transactionEnergyMemo.size >=
            MARKET_DIRECT_CONTINUOUS_MAX_TRANSACTION_ENERGY_EVALUATIONS
          ) {
            throw new TransactionEnergyEvaluationLimitError(
              "transaction energy evaluation hard limit exceeded",
            );
          }
          if (normalizationArtifacts) {
            normalizationArtifacts.callbackInvoked = true;
          }
          const observed = calculator(amount, eligible.order, lane.roomName);
          transactionEnergyMemo.set(memoKey, observed);
          return observed;
        };
        transactionEnergy = readTransactionEnergy(
          MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
        );
        worstCaseTransactionEnergy = readTransactionEnergy(1);
      } catch (error) {
        budget = {
          ...budget,
          transactionEnergyEvaluations: transactionEnergyMemo.size,
        };
        return blockedResult(input, {
          reason: error instanceof TransactionEnergyEvaluationLimitError
            ? "transaction_energy_evaluation_limit_exceeded"
            : "energy_pricing_failed",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: error instanceof Error ? error.message : "energy pricing threw",
        }, rejections, energyObservations, budget, isolatedShadowLanes);
      }
      if (
        !isNonNegativeSafeInteger(transactionEnergy) ||
        !isNonNegativeSafeInteger(worstCaseTransactionEnergy)
      ) {
        return blockedResult(input, {
          reason: "energy_pricing_failed",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: "transaction energy must be a non-negative safe integer",
        }, rejections, energyObservations, {
          ...budget,
          transactionEnergyEvaluations: transactionEnergyMemo.size,
        }, isolatedShadowLanes);
      }
      energyObservations.push({
        entryId: policy.entryId,
        roomName: lane.roomName,
        orderId: eligible.order.id,
        planned: transactionEnergy,
        worst: worstCaseTransactionEnergy,
      });

      let rejectionReason: MarketDirectContinuousTupleRejectionReason | undefined;
      const effectivePostDealEnergyReserve = Math.max(
        policy.terminalEnergyReserve,
        terminal.effectivePostDealEnergyReserve ??
          policy.terminalEnergyReserve,
      );
      if (
        transactionEnergy > policy.maxTransactionEnergy ||
        worstCaseTransactionEnergy > policy.maxTransactionEnergy
      ) {
        rejectionReason = "transaction_energy_exceeded";
      } else if (
        terminal.energy < transactionEnergy ||
        terminal.energy - transactionEnergy <
          effectivePostDealEnergyReserve ||
        terminal.energy < worstCaseTransactionEnergy ||
        terminal.energy - worstCaseTransactionEnergy <
          effectivePostDealEnergyReserve
      ) {
        rejectionReason = "terminal_energy_reserve";
      }

      const energyShadowCostMilli = checkedMultiply(
        transactionEnergy,
        energyShadowPriceMilli,
      );
      const worstCaseEnergyCostMilli = checkedMultiply(
        worstCaseTransactionEnergy,
        energyShadowPriceMilli,
      );
      const requiredNetCreditsMilli = checkedMultiply(
        effectiveNetFloorMilli,
        MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
      );
      if (
        energyShadowCostMilli === undefined ||
        worstCaseEnergyCostMilli === undefined ||
        requiredNetCreditsMilli === undefined
      ) {
        return blockedResult(input, {
          reason: "unsafe_arithmetic",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: "energy/floor multiplication overflow",
        }, rejections, energyObservations, {
          ...budget,
          transactionEnergyEvaluations: transactionEnergyMemo.size,
        }, isolatedShadowLanes);
      }
      const netCreditsMilli = checkedSubtract(
        eligible.executableNotionalMilli,
        energyShadowCostMilli,
      );
      const worstCaseNetCreditsMilli = checkedSubtract(
        eligible.grossPriceMilli,
        worstCaseEnergyCostMilli,
      );
      if (
        netCreditsMilli === undefined ||
        worstCaseNetCreditsMilli === undefined
      ) {
        return blockedResult(input, {
          reason: "unsafe_arithmetic",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: "net credits subtraction overflow",
        }, rejections, energyObservations, {
          ...budget,
          transactionEnergyEvaluations: transactionEnergyMemo.size,
        }, isolatedShadowLanes);
      }
      if (!rejectionReason && netCreditsMilli < requiredNetCreditsMilli) {
        rejectionReason = "planned_net_below_floor";
      }
      if (!rejectionReason && worstCaseNetCreditsMilli < effectiveNetFloorMilli) {
        rejectionReason = "worst_case_net_below_floor";
      }
      if (rejectionReason) {
        rejections.push({
          entryId: policy.entryId,
          resourceType: policy.resourceType,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          reason: rejectionReason,
        });
        continue;
      }

      const resourceQuotaBefore = checkedAdd(
        quota.confirmedAmount,
        quota.unmatchedPlannedAmount,
      );
      const globalQuotaBefore = checkedAdd(
        input.globalQuota.confirmedAmount,
        input.globalQuota.unmatchedPlannedAmount,
      );
      const roomQuotaBefore = laneInput.quota
        ? checkedAdd(
          laneInput.quota.roomConfirmedAmount,
          laneInput.quota.roomUnmatchedPlannedAmount,
        )
        : 0;
      const laneQuotaBefore = laneInput.quota
        ? checkedAdd(
          laneInput.quota.laneConfirmedAmount,
          laneInput.quota.laneUnmatchedPlannedAmount,
        )
        : 0;
      if (
        resourceQuotaBefore === undefined ||
        globalQuotaBefore === undefined ||
        roomQuotaBefore === undefined ||
        laneQuotaBefore === undefined
      ) {
        return blockedResult(input, {
          reason: "unsafe_arithmetic",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: "quota addition overflow",
        }, rejections, energyObservations, {
          ...budget,
          transactionEnergyEvaluations: transactionEnergyMemo.size,
        }, isolatedShadowLanes);
      }
      const candidate: MarketDirectContinuousCandidate = {
        entryId: policy.entryId,
        policyRevision: policy.revision,
        resourceType: policy.resourceType,
        roomName: lane.roomName,
        order: eligible.order,
        plannedAmount: MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
        grossPriceMilli: eligible.grossPriceMilli,
        executableNotionalMilli: eligible.executableNotionalMilli,
        transactionEnergy,
        energyShadowPriceMilli,
        energyShadowCostMilli,
        netCreditsMilli,
        effectiveNetFloorMilli,
        requiredNetCreditsMilli,
        worstCaseActualAmount: 1,
        worstCaseTransactionEnergy,
        worstCaseNetCreditsMilli,
        resourceQuotaBefore,
        roomQuotaBefore,
        laneQuotaBefore,
        globalQuotaBefore,
        reservedForOtherSafeResources: 0,
        tupleKey: "",
      };
      candidate.tupleKey = candidateTupleKey(candidate);
      safeCandidates.push(candidate);
    }
  }
  budget = {
    ...budget,
    transactionEnergyEvaluations: transactionEnergyMemo.size,
  };
  safeCandidates.sort(compareMarketDirectContinuousCandidates);

  const quotaByResource = new Map(
    input.entries.map((entry) => [entry.policy.resourceType, entry] as const),
  );
  const laneInputByKey = new Map<
    string,
    MarketDirectContinuousLaneInput
  >();
  for (const entry of input.entries) {
    for (const laneInput of entry.lanes) {
      laneInputByKey.set(
        `${entry.policy.resourceType}|${laneInput.lane.roomName}`,
        laneInput,
      );
    }
  }
  const safeResourceTypes = new Set(
    safeCandidates
      .filter((candidate) => {
        const entry = quotaByResource.get(candidate.resourceType)!;
        if (
          candidate.resourceQuotaBefore +
            MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT >
          entry.quota.rollingCap
        ) {
          return false;
        }
        if (entry.policy.evaluatorVersion !== 3) return true;
        const laneInput = laneInputByKey.get(
          `${candidate.resourceType}|${candidate.roomName}`,
        );
        return Boolean(
          laneInput?.quota &&
          candidate.roomQuotaBefore +
            MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT <=
            laneInput.quota.roomRollingCap &&
          candidate.laneQuotaBefore +
            MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT <=
            laneInput.quota.laneRollingCap,
        );
      })
      .map((candidate) => candidate.resourceType),
  );

  const admittedCandidates: MarketDirectContinuousCandidate[] = [];
  for (const candidate of safeCandidates) {
    const entry = quotaByResource.get(candidate.resourceType)!;
    if (
      candidate.resourceQuotaBefore +
        MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT >
      entry.quota.rollingCap
    ) {
      rejections.push({
        entryId: candidate.entryId,
        resourceType: candidate.resourceType,
        roomName: candidate.roomName,
        orderId: candidate.order.id,
        reason: "resource_quota_exhausted",
      });
      continue;
    }
    const laneInput = laneInputByKey.get(
      `${candidate.resourceType}|${candidate.roomName}`,
    );
    if (entry.policy.evaluatorVersion === 3) {
      if (!laneInput?.quota || !laneQuotaIsValid(laneInput.quota)) {
        return blockedResult(input, {
          reason: "lane_quota_incomplete",
          entryId: candidate.entryId,
          roomName: candidate.roomName,
        }, rejections, energyObservations, budget, isolatedShadowLanes);
      }
      if (
        candidate.roomQuotaBefore +
          MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT >
        laneInput.quota.roomRollingCap
      ) {
        rejections.push({
          entryId: candidate.entryId,
          resourceType: candidate.resourceType,
          roomName: candidate.roomName,
          orderId: candidate.order.id,
          reason: "room_quota_exhausted",
        });
        continue;
      }
      if (
        candidate.laneQuotaBefore +
          MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT >
        laneInput.quota.laneRollingCap
      ) {
        rejections.push({
          entryId: candidate.entryId,
          resourceType: candidate.resourceType,
          roomName: candidate.roomName,
          orderId: candidate.order.id,
          reason: "lane_quota_exhausted",
        });
        continue;
      }
    }

    let reservedForOtherSafeResources = 0;
    for (const resourceType of safeResourceTypes) {
      if (resourceType === candidate.resourceType) continue;
      const other = quotaByResource.get(resourceType)!;
      if (!other.quota.opportunityReserveSatisfied) {
        const nextReserve = checkedAdd(
          reservedForOtherSafeResources,
          other.policy.opportunityReserve,
        );
        if (nextReserve === undefined) {
          return blockedResult(input, {
            reason: "unsafe_arithmetic",
            entryId: candidate.entryId,
            detail: "opportunity reserve overflow",
          }, rejections, energyObservations, budget, isolatedShadowLanes);
        }
        reservedForOtherSafeResources = nextReserve;
      }
    }
    const afterPlan = checkedAdd(
      candidate.globalQuotaBefore,
      MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
    );
    const afterReserves = afterPlan === undefined
      ? undefined
      : checkedAdd(afterPlan, reservedForOtherSafeResources);
    if (
      afterReserves === undefined ||
      afterReserves > input.globalQuota.rollingCap
    ) {
      rejections.push({
        entryId: candidate.entryId,
        resourceType: candidate.resourceType,
        roomName: candidate.roomName,
        orderId: candidate.order.id,
        reason: "global_quota_or_opportunity_reserve",
      });
      continue;
    }
    admittedCandidates.push({
      ...candidate,
      reservedForOtherSafeResources,
    });
  }
  admittedCandidates.sort(compareMarketDirectContinuousCandidates);
  const selected = admittedCandidates[0];
  const usableArtifacts = normalizationArtifacts
    ? usableInvocationArtifacts(
        input,
        normalizationArtifacts,
        selected,
        isolatedShadowLanes,
      )
    : undefined;
  const partial = {
    complete: true as const,
    safeCandidates,
    admittedCandidates,
    selected,
    rejections,
  };
  if (!normalizationArtifacts) {
    const result = finishResult(
      input,
      partial,
      energyObservations,
      budget,
      isolatedShadowLanes,
    );
    if (options !== undefined) {
      observeNormalizationArtifact(options, false);
    }
    return result;
  }
  if (usableArtifacts) {
    try {
      const result = finishResult(
        input,
        partial,
        energyObservations,
        budget,
        isolatedShadowLanes,
        usableArtifacts,
      );
      observeNormalizationArtifact(options, true);
      return result;
    } catch {
      // artifact 是可选性能路径；任何异常都必须使用原有归一化重建证据。
    }
  }
  const result = finishResult(
    input,
    partial,
    energyObservations,
    budget,
    isolatedShadowLanes,
  );
  observeNormalizationArtifact(options, false);
  return result;
}

/**
 * 写前第二次完整规划必须和第一次逐字段一致，且仍选择完全相同的最佳 tuple。
 * 任一输入、book/order remaining、定价、保护、terminal、quota、permit 或仲裁字段变化均 false。
 */
export function isExactMarketDirectContinuousSecondRead(
  planned: MarketDirectContinuousPlanningResult,
  secondRead: MarketDirectContinuousPlanningResult,
): boolean {
  const plannedBooks = resultBookReferences.get(planned);
  const secondReadBooks = resultBookReferences.get(secondRead);
  const independentBookSnapshots = (
    plannedBooks !== undefined &&
    secondReadBooks !== undefined &&
    plannedBooks.length === secondReadBooks.length &&
    plannedBooks.every((reference, index) => {
      const secondReference = secondReadBooks[index];
      if (
        reference.book === secondReference.book ||
        reference.orders === secondReference.orders ||
        reference.ownOrderIds === secondReference.ownOrderIds
      ) {
        return false;
      }
      const secondOrderObjects = new Set(secondReference.orders);
      return reference.orders.every((order) =>
        !secondOrderObjects.has(order));
    })
  );
  return (
    independentBookSnapshots &&
    planned.complete &&
    secondRead.complete &&
    planned.blocker === undefined &&
    secondRead.blocker === undefined &&
    planned.selected !== undefined &&
    secondRead.selected !== undefined &&
    planned.selected.tupleKey === secondRead.selected.tupleKey &&
    planned.planningFingerprint === secondRead.planningFingerprint &&
    planned.planningEvidence === secondRead.planningEvidence
  );
}
