/** 从 marketSaleOperators.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { AUTHORITY_EXECUTOR_SHARD } from "@/config/deployment";
import { bumpMarketPerformanceCounter } from "@/runtime/marketPerformanceCounters";
import { normalizeDirectAutomationState, type DirectAutomationState } from "@/runtime/marketSaleDirectAutomation";
import {
  migrateLegacyDirectToContinuous,
  normalizeContinuousDirectState,
  type ContinuousPendingProjection,
  type MarketDirectContinuousAutomationState,
} from "@/runtime/marketDirectContinuousAutomation";
import {
  MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  MARKET_DIRECT_CONTINUOUS_SCHEMA,
} from "@/runtime/marketDirectContinuousPolicy";
import {
  type MarketBaseResourceReadinessRuntimeCapability,
  type MarketBaseResourceV3RuntimeState,
} from "@/runtime/marketBaseResourceAutomation";
import { type MarketBaseDerivedLaneLifecycle, type MarketBaseResource } from "@/runtime/marketBaseResourcePolicy";
import { type MarketBaseResourceLedgerRuntimeAnchor } from "@/runtime/marketBaseResourceLedger";
import {
  isResolvedDirectPendingCompatibilityAlias,
  recoverPendingDirectDeal,
  type PendingDirectDeal,
} from "@/runtime/marketSaleDirectPending";
import { calculateProspectiveFeeMilli } from "@/runtime/marketSalePricing";
import {
  validateFeeLedger,
  createFeeLedgerBlocked,
  resolveFeeLedgerInvalid,
  createEmptyMarketSaleFeeLedger,
  type MarketSaleFeeLedgerState,
} from "@/runtime/marketSaleFeeLedger";
import {
  hashOrderIds,
  type CanaryLock,
  type DrainState,
  type ManagedMarketOrderState,
  type PendingCreateState,
  type PendingOrderMutation,
} from "@/runtime/marketSaleLifecycle";

export const MAX_FEE_EVENTS = 100;
export const MARKET_BASE_RESOURCE_ACTIVATION_ANCHOR_REVISION =
  "market-base-resource-activation-anchor-v3" as const;
export const MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION =
  "market-base-resource-activation-blocker-v1" as const;

interface PendingCreateEvidence {
  creditsBefore?: number;
  terminalStockBefore?: number;
  outgoingKeysBefore?: string[];
  baselineOrderFingerprints?: Record<string, string>;
  operatorResolutionCandidateIds?: string[];
}

export interface ExpansionGrant {
  configRevision: string;
  grantedAt: number;
}

export interface DirectLegacyExposureDrainState {
  schemaVersion: 1;
  zeroConfirmations: number;
  lastZeroConfirmationTick?: number;
  completedAt?: number;
}

export interface MarketBaseResourceRoomIncarnationHighWater {
  roomName: string;
  incarnationHighWater: number;
  lastInstanceId: string;
  admitted: boolean;
}

export interface MarketBaseResourceLaneLifecycleHighWater {
  laneId: string;
  stableFingerprint: string;
  stage: MarketBaseDerivedLaneLifecycle["stage"];
  status: MarketBaseDerivedLaneLifecycle["status"];
  completeCycles: number;
  lastCompleteTick?: number;
  evidenceDigest?: string;
}

export interface MarketBaseResourcePricingHighWater {
  resource: MarketBaseResource;
  value: number;
  marketDate: string;
}

export interface MarketBaseResourceTrustedFloorHighWater extends Omit<
  MarketBaseResourcePricingHighWater,
  "resource"
> {
  resource: MarketBaseResource | typeof RESOURCE_ENERGY;
  updatedAt: number;
}

/**
 * V3 子树之外的不可回退激活/房间实例高水位。两个副本必须逐字一致；
 * nested baseResourceV3 缺失、损坏或整体回拨时，外层副本仍强制 dispatcher
 * 留在 V3 fail-closed 路径，绝不能重新解释为尚未 cutover 的 V2。
 */
export interface MarketBaseResourceActivationAnchor {
  schemaVersion: 1;
  hashRevision: typeof MARKET_BASE_RESOURCE_ACTIVATION_ANCHOR_REVISION;
  accountIdentity: string;
  executorShard: typeof AUTHORITY_EXECUTOR_SHARD;
  acceptedAt: number;
  updatedAt: number;
  operatorAuthorizationFingerprint: string;
  cutoverCheckpointHash: string;
  legacyV2QuiescenceCommitment: string;
  firstV3PermitEpoch: number;
  firstV3PermitId: string;
  firstV3PermitHead: string;
  laneTombstoneCheckpointCommitment: string;
  laneTombstoneDischargeCheckpointCommitment: string;
  roomRegistryCheckpointCommitment: string;
  scopeCommitment: string;
  roomIncarnationHighWater: readonly MarketBaseResourceRoomIncarnationHighWater[];
  laneLifecycleCommitment: string;
  laneLifecycleHighWater: readonly MarketBaseResourceLaneLifecycleHighWater[];
  ledger: MarketBaseResourceLedgerRuntimeAnchor;
  pricingRatchetInitializedAt: number;
  pricingRatchetBootstrapFingerprint: string;
  pricingRatchetCommitment: string;
  pricingRatchetHighWater: readonly MarketBaseResourcePricingHighWater[];
  trustedFloorsCommitment: string;
  trustedFloorHighWater: readonly MarketBaseResourceTrustedFloorHighWater[];
  hardBlocker: {
    code: string;
    detectedAt: number;
    detailHash: string;
  } | null;
  activationBlocker: MarketBaseResourceActivationBlocker | null;
  runtimeSafetyCommitment: string;
  anchorHash: string;
}

export interface MarketBaseResourceActivationBlocker {
  schemaVersion: 1;
  hashRevision: typeof MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION;
  code: string;
  detectedAt: number;
  detailHash: string;
}

export type OwnedManagedOrder = Omit<ManagedMarketOrderState, "resourceType"> & {
  resourceType: ResourceConstant;
  backoffUntil?: number;
};

export type OwnedPendingCreate = Omit<PendingCreateState, "tuple"> &
  PendingCreateEvidence & {
    tuple: Omit<PendingCreateState["tuple"], "resourceType"> & {
      resourceType: ResourceConstant;
    };
  };

export type OwnedCanaryLock = Omit<CanaryLock, "resourceType"> & {
  resourceType: ResourceConstant;
};

export interface MarketSaleDataState {
  managedOrders: Record<string, OwnedManagedOrder>;
  pendingCreate?: OwnedPendingCreate;
  pendingMutations: Record<string, PendingOrderMutation>;
  feeEvents: Array<{
    id: string;
    tick: number;
    resource: ResourceConstant;
    amountMilli: number;
    kind: "create" | "extend" | "reprice" | "refund" | "carry";
  }>;
  feeLedger?: MarketSaleFeeLedgerState;
  carriedFeeDebtMilli: Partial<Record<ResourceConstant, number>>;
  trustedFloors: Partial<
    Record<
      ResourceConstant,
      { value: number; marketDate: string; updatedAt: number }
    >
  >;
  processedTransactionKeys: string[];
  canaryLock?: OwnedCanaryLock;
  drain?: DrainState;
  operatorAudit: Array<{
    tick: number;
    action: string;
    orderId?: string;
    requestId?: string;
    candidateIds?: string[];
  }>;
  directAutomation?:
    DirectAutomationState | MarketDirectContinuousAutomationState;
  pendingDirectDeals?: Record<
    string,
    PendingDirectDeal | ContinuousPendingProjection
  >;
  /** Canonical stores for any market-sale-owned staged or reserved amount. */
  marketStaging?: unknown;
  marketReservations?: unknown;
  expansionGrant?: ExpansionGrant;
  /**
   * Direct 与旧 Maker 的授权域相互独立。切入 Direct 前仍须先把旧卖单、
   * mutation/create WAL、staging 与 reservation 连续两个 tick 证明归零。
   */
  directLegacyExposureDrain?: DirectLegacyExposureDrainState;
  /** 双副本都位于 baseResourceV3 子树之外，任一缺失/不一致即永久闭锁。 */
  baseResourceV3ActivationAnchor?: MarketBaseResourceActivationAnchor;
  baseResourceV3ActivationAnchorMirror?: MarketBaseResourceActivationAnchor;
  baseResourceV3ActivationBlocker?: MarketBaseResourceActivationBlocker;
  baseResourceV3ProposedContinuousReview?: MarketBaseResourceProposedContinuousReview;
  baseResourceV3ProposedTransition?: MarketBaseResourceProposedTransition;
}

export interface MarketBaseResourcePermitRequest {
  laneId?: string;
  targetStage?: "canary" | "continuous" | "suspend";
  reviewedEvidenceDigest?: string;
  /**
   * review_paused → continuous 必须显式回传完整事实快照；不能只从 status
   * 复制一个 digest。propose 与 accept 都会重新读取 current facts，并
   * 要求 stableReviewDigest 一致。
   */
  continuousReview?: MarketBaseResourceContinuousReviewSnapshot;
}

export interface MarketBaseResourceContinuousReviewSnapshot {
  schemaVersion: 1;
  hashRevision: "market-base-resource-continuous-review-v2";
  laneId: string;
  resource: MarketBaseResource;
  sellerRoom: string;
  effectiveNetFloor: number;
  observedAt: number;
  sourceFreshThrough: number;
  confirmedCanary: {
    attemptSeq: number;
    permitId: string;
    receiptEventHash: string;
    transactionTime: number;
    actualAmount: number;
    actualTransactionEnergy: number;
    actualNetCreditsMilli: number;
  };
  permit: {
    permitId: string;
    permitEpoch: number;
    permitHead: string;
  };
  ledger: {
    receiptHeadHash: string;
    checkpointHash: string;
    permitAnchorHash: string;
    finalizedAttemptSeq: number;
  };
  terminal: {
    terminalId: string;
    resourceAmount: number;
    freeCapacity: number;
    storageResourceAmount: number;
    stagingShortfall: number;
    energy: number;
    minimumReviewEnergyReserve: number;
    readinessRevision: string;
  };
  protection: {
    revision: number;
    observedAt: number;
    expiresAt: number;
    entryCommitment: string;
    sellableAmount: number;
    totalSellableAmount: number;
    protectedAmount: number;
    productionDemand: number;
    protectedOutgoing: number;
    carrierOrInFlight: number;
  };
  quota: {
    commitment: string;
    globalRemaining: number;
    resourceRemaining: number;
    roomRemaining: number;
    laneRemaining: number;
    confirmedCooldownNotBefore: number;
    retryNotBefore: number;
  };
  stableReviewDigest: string;
}

export interface MarketBaseResourceProposedContinuousReview {
  proposalId: string;
  snapshots: readonly MarketBaseResourceContinuousReviewSnapshot[];
}

export interface MarketBaseResourceProposedTransition {
  proposalId: string;
  laneId: string;
  targetStage: NonNullable<MarketBaseResourcePermitRequest["targetStage"]>;
  transitionLaneIds: readonly string[];
}

export function boundedPush<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

function quarantinedDirectPendingAlias(
  value: unknown,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { __compatibility_alias__: value };
  }
  const quarantined: Record<string, unknown> = {};
  for (const [requestId, pending] of Object.entries(value)) {
    if (!recoverPendingDirectDeal(pending, requestId)) {
      quarantined[requestId] = pending;
    }
  }
  return quarantined;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isContinuousDirectState(
  value: unknown,
): value is MarketDirectContinuousAutomationState {
  return Boolean(
    isPlainRecord(value) &&
    value.schemaVersion === MARKET_DIRECT_CONTINUOUS_SCHEMA &&
    value.capability === MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  );
}

function isLegacyDirectState(value: unknown): value is DirectAutomationState {
  return Boolean(
    isPlainRecord(value) &&
    value.schemaVersion === 1 &&
    value.capability === undefined,
  );
}

function canonicalMemoryEvidence(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : JSON.parse(serialized);
  } catch {
    return {
      invalidEvidenceType: value === null ? "null" : typeof value,
    };
  }
}

function continuousStateHasCoreContainers(
  value: unknown,
): value is MarketDirectContinuousAutomationState {
  if (!isContinuousDirectState(value)) return false;
  const ledger = value.ledger as unknown;
  return Boolean(
    isPlainRecord(ledger) &&
    Array.isArray(ledger.receipts) &&
    Array.isArray(ledger.outcomes) &&
    Array.isArray(ledger.processedEvidenceKeys) &&
    isPlainRecord(ledger.checkpoint) &&
    isPlainRecord(ledger.lifetimeConfirmed) &&
    isPlainRecord(value.permitChain) &&
    isPlainRecord(value.lifecycleByEntry) &&
    isPlainRecord(value.pendingDirectDeals) &&
    isPlainRecord(value.quarantinedPendingDirectDeals),
  );
}

function normalizeContinuousForStorage(
  raw: unknown,
  tick: number,
): MarketDirectContinuousAutomationState {
  const evidence = canonicalMemoryEvidence(raw);
  let normalized: MarketDirectContinuousAutomationState;
  try {
    normalized = normalizeContinuousDirectState(
      continuousStateHasCoreContainers(evidence)
        ? evidence
        : { invalidContinuousState: evidence },
      tick,
    );
  } catch {
    normalized = normalizeContinuousDirectState(
      { invalidContinuousState: evidence },
      tick,
    );
  }
  return continuousStateHasCoreContainers(normalized)
    ? normalized
    : normalizeContinuousDirectState(
        {
          invalidContinuousNormalizerResult:
            canonicalMemoryEvidence(normalized),
        },
        tick,
      );
}

function createBaseMarketSaleDataState(): MarketSaleDataState {
  return {
    managedOrders: {},
    pendingMutations: {},
    feeEvents: [],
    carriedFeeDebtMilli: {},
    trustedFloors: {},
    processedTransactionKeys: [],
    operatorAudit: [],
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRoomName(value: unknown): value is string {
  return isNonEmptyString(value) && /^[WE]\d+[NS]\d+$/.test(value);
}

function isResourceConstant(value: unknown): value is ResourceConstant {
  return (
    typeof value === "string" &&
    RESOURCES_ALL.includes(value as ResourceConstant)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => isNonEmptyString(entry))
  );
}

function isRecoverableManagedOrder(
  value: unknown,
  orderId: string,
): value is OwnedManagedOrder {
  if (!isPlainRecord(value)) return false;
  const externalGap = value.externalMutationGap;
  const disappearanceGap = value.disappearanceGap;
  const exposureInvariant =
    externalGap === undefined
      ? value.remainingExposure === value.lastRemainingAmount
      : isPlainRecord(externalGap) &&
        value.remainingExposure === externalGap.conservativeExposure &&
        (value.remainingExposure as number) >=
          (value.lastRemainingAmount as number);
  return Boolean(
    value.orderId === orderId &&
    isRoomName(value.roomName) &&
    isResourceConstant(value.resourceType) &&
    isPositiveFiniteNumber(value.price) &&
    isNonNegativeSafeInteger(value.originalAmount) &&
    value.originalAmount > 0 &&
    isNonNegativeSafeInteger(value.lastRemainingAmount) &&
    value.lastRemainingAmount <= value.originalAmount &&
    isNonNegativeSafeInteger(value.remainingExposure) &&
    isNonNegativeSafeInteger(value.feeDebtMilli) &&
    isNonNegativeSafeInteger(value.createdAt) &&
    isNonNegativeSafeInteger(value.lastSeenAt) &&
    (value.lastFillAt === undefined ||
      isNonNegativeSafeInteger(value.lastFillAt)) &&
    isNonNegativeSafeInteger(value.policyCancelAtTick) &&
    isNonNegativeSafeInteger(value.serverCreatedTick) &&
    (value.backoffUntil === undefined ||
      isNonNegativeSafeInteger(value.backoffUntil)) &&
    exposureInvariant &&
    !(externalGap !== undefined && disappearanceGap !== undefined) &&
    (externalGap === undefined ||
      (isPlainRecord(externalGap) &&
        isNonNegativeSafeInteger(externalGap.detectedAt) &&
        isPositiveFiniteNumber(externalGap.expectedPrice) &&
        isPositiveFiniteNumber(externalGap.observedPrice) &&
        isNonNegativeSafeInteger(externalGap.expectedTotalAmount) &&
        (externalGap.observedTotalAmount === undefined ||
          isNonNegativeSafeInteger(externalGap.observedTotalAmount)) &&
        isNonNegativeSafeInteger(externalGap.conservativeExposure))) &&
    (disappearanceGap === undefined ||
      (isPlainRecord(disappearanceGap) &&
        isNonNegativeSafeInteger(disappearanceGap.detectedAt) &&
        (disappearanceGap.reason === "unknown_disappearance" ||
          disappearanceGap.reason === "server_expiry_refund_mismatch"))),
  );
}

function isRecoverablePendingMutation(
  value: unknown,
  orderId: string,
): value is PendingOrderMutation {
  if (!isPlainRecord(value)) return false;
  const pre = value.pre;
  const requested = value.requested;
  const requestedExposure =
    isPlainRecord(pre) &&
    isNonNegativeSafeInteger(pre.remainingAmount) &&
    isPlainRecord(requested) &&
    value.kind === "extend" &&
    isNonNegativeSafeInteger(requested.addAmount)
      ? pre.remainingAmount + requested.addAmount
      : isPlainRecord(pre)
        ? pre.remainingAmount
        : undefined;
  let expectedProspectiveFeeMilli: number | undefined;
  try {
    if (value.kind === "cancel") {
      expectedProspectiveFeeMilli = 0;
    } else if (
      value.kind === "extend" &&
      isPlainRecord(pre) &&
      isPositiveFiniteNumber(pre.price) &&
      isNonNegativeSafeInteger(pre.remainingAmount) &&
      isPlainRecord(requested) &&
      isNonNegativeSafeInteger(requested.addAmount) &&
      requested.addAmount > 0
    ) {
      expectedProspectiveFeeMilli = calculateProspectiveFeeMilli({
        kind: "extend",
        currentPrice: pre.price,
        currentRemainingAmount: pre.remainingAmount,
        addAmount: requested.addAmount,
      });
    } else if (
      value.kind === "reprice" &&
      isPlainRecord(pre) &&
      isPositiveFiniteNumber(pre.price) &&
      isNonNegativeSafeInteger(pre.remainingAmount) &&
      isPlainRecord(requested) &&
      isPositiveFiniteNumber(requested.price)
    ) {
      expectedProspectiveFeeMilli =
        requested.price > pre.price
          ? calculateProspectiveFeeMilli(
              {
                kind: "repriceUp",
                currentPrice: pre.price,
                remainingAmount: pre.remainingAmount,
              },
              requested.price,
            )
          : calculateProspectiveFeeMilli(
              {
                kind: "repriceDown",
                currentPrice: pre.price,
                remainingAmount: pre.remainingAmount,
              },
              requested.price,
            );
    }
  } catch {
    expectedProspectiveFeeMilli = undefined;
  }
  return Boolean(
    value.orderId === orderId &&
    (value.kind === "cancel" ||
      value.kind === "extend" ||
      value.kind === "reprice") &&
    isNonNegativeSafeInteger(value.requestedAt) &&
    isPlainRecord(pre) &&
    isPositiveFiniteNumber(pre.price) &&
    isNonNegativeSafeInteger(pre.totalAmount) &&
    isNonNegativeSafeInteger(pre.remainingAmount) &&
    pre.remainingAmount <= pre.totalAmount &&
    (pre.active === undefined || typeof pre.active === "boolean") &&
    isPlainRecord(requested) &&
    (requested.price === undefined ||
      isPositiveFiniteNumber(requested.price)) &&
    (requested.addAmount === undefined ||
      (isNonNegativeSafeInteger(requested.addAmount) &&
        requested.addAmount > 0)) &&
    ((value.kind === "cancel" &&
      requested.price === undefined &&
      requested.addAmount === undefined) ||
      (value.kind === "extend" &&
        requested.price === undefined &&
        isNonNegativeSafeInteger(requested.addAmount) &&
        requested.addAmount > 0) ||
      (value.kind === "reprice" &&
        isPositiveFiniteNumber(requested.price) &&
        requested.addAmount === undefined)) &&
    isNonNegativeSafeInteger(value.prospectiveFeeMilli) &&
    value.prospectiveFeeMilli === expectedProspectiveFeeMilli &&
    isNonNegativeSafeInteger(value.conservativeExposure) &&
    isNonNegativeSafeInteger(requestedExposure) &&
    value.conservativeExposure >= requestedExposure &&
    (value.status === "prepared" ||
      value.status === "submitted" ||
      value.status === "reconcile_gap"),
  );
}

function isRecoverablePendingCreate(
  value: unknown,
): value is OwnedPendingCreate {
  if (!isPlainRecord(value)) return false;
  const tuple = value.tuple;
  const audit = value.audit;
  const baselineFingerprints = value.baselineOrderFingerprints;
  const baselineOrderIds = value.baselineOrderIds;
  const baselineOrderIdsCanonical =
    isStringArray(baselineOrderIds) &&
    new Set(baselineOrderIds).size === baselineOrderIds.length &&
    baselineOrderIds.every(
      (entry, index) => entry === [...baselineOrderIds].sort()[index],
    );
  const baselineFingerprintKeys = isPlainRecord(baselineFingerprints)
    ? Object.keys(baselineFingerprints).sort()
    : [];
  let expectedCreateFeeMilli: number | undefined;
  try {
    if (
      isPlainRecord(tuple) &&
      isNonNegativeSafeInteger(tuple.totalAmount) &&
      tuple.totalAmount > 0 &&
      isPositiveFiniteNumber(tuple.price)
    ) {
      expectedCreateFeeMilli = calculateProspectiveFeeMilli(
        {
          kind: "create",
          amount: tuple.totalAmount,
        },
        tuple.price,
      );
    }
  } catch {
    expectedCreateFeeMilli = undefined;
  }
  return Boolean(
    isNonEmptyString(value.requestId) &&
    isNonNegativeSafeInteger(value.requestedAt) &&
    baselineOrderIdsCanonical &&
    isNonEmptyString(value.baselineHash) &&
    value.baselineHash === hashOrderIds(baselineOrderIds) &&
    isNonEmptyString(value.leaseEpoch) &&
    isPlainRecord(tuple) &&
    tuple.type === ORDER_SELL &&
    isResourceConstant(tuple.resourceType) &&
    isRoomName(tuple.roomName) &&
    isPositiveFiniteNumber(tuple.price) &&
    isNonNegativeSafeInteger(tuple.totalAmount) &&
    tuple.totalAmount > 0 &&
    isNonNegativeSafeInteger(tuple.createdNotBefore) &&
    isNonNegativeSafeInteger(tuple.createdNotAfter) &&
    tuple.createdNotBefore === value.requestedAt &&
    tuple.createdNotAfter === value.requestedAt + 2 &&
    isNonNegativeSafeInteger(value.feeMilli) &&
    value.feeMilli === expectedCreateFeeMilli &&
    isNonNegativeSafeInteger(value.exposure) &&
    value.exposure === tuple.totalAmount &&
    isNonNegativeSafeInteger(value.zeroDeltaConfirmations) &&
    (value.lastZeroDeltaTick === undefined ||
      isNonNegativeSafeInteger(value.lastZeroDeltaTick)) &&
    ((value.zeroDeltaConfirmations === 0 &&
      value.lastZeroDeltaTick === undefined) ||
      (value.zeroDeltaConfirmations > 0 &&
        value.lastZeroDeltaTick !== undefined)) &&
    (value.status === "prepared" ||
      value.status === "submitted" ||
      value.status === "ambiguous") &&
    Array.isArray(audit) &&
    audit.every(
      (entry) =>
        isPlainRecord(entry) &&
        isNonNegativeSafeInteger(entry.tick) &&
        isNonEmptyString(entry.action) &&
        isStringArray(entry.candidateIds),
    ) &&
    typeof value.creditsBefore === "number" &&
    Number.isFinite(value.creditsBefore) &&
    value.creditsBefore >= 0 &&
    isNonNegativeSafeInteger(value.terminalStockBefore) &&
    isStringArray(value.outgoingKeysBefore) &&
    isPlainRecord(baselineFingerprints) &&
    Object.values(baselineFingerprints).every(
      (entry) => typeof entry === "string",
    ) &&
    baselineFingerprintKeys.length === baselineOrderIds.length &&
    baselineFingerprintKeys.every(
      (entry, index) => entry === baselineOrderIds[index],
    ) &&
    (value.operatorResolutionCandidateIds === undefined ||
      isStringArray(value.operatorResolutionCandidateIds)),
  );
}

function recoverMarketStateRecord<T extends object>(
  value: unknown,
  containerSentinel: string,
  entrySentinelPrefix: string,
  quarantine: Record<string, unknown>,
  isRecoverable: (entry: unknown, key: string) => entry is T,
): Record<string, T> {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    quarantine[containerSentinel] = value;
    return {};
  }
  const recovered: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || !isRecoverable(entry, key)) {
      quarantine[`${entrySentinelPrefix}:${key || "<empty>"}`] = entry;
      continue;
    }
    recovered[key] = entry as T;
  }
  return recovered;
}

interface MarketBaseResourceCanonicalRootProvenance {
  readonly tick: number;
  readonly directAutomation: MarketDirectContinuousAutomationState;
  readonly state: MarketBaseResourceV3RuntimeState;
  readonly activationAnchor: MarketBaseResourceActivationAnchor;
  readonly activationAnchorMirror: MarketBaseResourceActivationAnchor;
  readonly trustedFloors: MarketSaleDataState["trustedFloors"];
  readonly ledgerRuntimeAnchor: MarketBaseResourceLedgerRuntimeAnchor;
  readonly runtimeCapability: MarketBaseResourceReadinessRuntimeCapability;
}

export const marketBaseResourceCanonicalRootProvenance = new WeakMap<
  object,
  MarketBaseResourceCanonicalRootProvenance
>();

// 数据根验证状态：仅支持"同 tick 引用短路"。生产 Memory 每 tick 经
// JSON 重解析（对象引用必然变化），跨 tick 永远走完整深恢复——历史上的
// commitment 结构键快速路径（顶层键集合 + exposure 规模 + 迁移标量）已
// 移除：它对"同条目数但内容损坏"不可见，属高风险快速命中。模块级变量
// 随 global reset 一并清零。
export let verifiedDataRoot: MarketSaleDataState | undefined;
export let verifiedDataRootTick = -1;
export let marketDataStateDeepRecoveries = 0;

export function ensureDataState(): MarketSaleDataState {
  if (!Memory.data) Memory.data = {};
  const rawMarketSaleAutomation = Memory.data.marketSaleAutomation as unknown;
  if (
    isPlainRecord(rawMarketSaleAutomation) &&
    marketBaseResourceCanonicalRootProvenance.get(rawMarketSaleAutomation)
      ?.tick === Game.time &&
    isPlainRecord(rawMarketSaleAutomation.directAutomation) &&
    Object.isFrozen(rawMarketSaleAutomation.directAutomation)
  ) {
    return rawMarketSaleAutomation as unknown as MarketSaleDataState;
  }
  // ── 同 tick 引用短路（跨 tick 快速路径已移除）─────────────────────────
  // 生产环境每 tick Memory 经 JSON 重解析使引用必然失配 → 跨 tick 永远
  // 走下方完整深恢复（含 managed order / pending mutation / pending
  // create / fee ledger 的逐条内容校验）。仅当同 tick 内已验证/已 commit
  // 的根对象引用再次出现（planning commit 后同 tick 直调、operator
  // 命令重入）时，才跳过重复深恢复；tick 不匹配一律强制深恢复。
  if (
    verifiedDataRoot !== undefined &&
    verifiedDataRootTick === Game.time &&
    verifiedDataRoot === rawMarketSaleAutomation
  ) {
    bumpMarketPerformanceCounter("marketDataStateFastPathHits");
    return rawMarketSaleAutomation as MarketSaleDataState;
  }
  if (rawMarketSaleAutomation === undefined) {
    Memory.data.marketSaleAutomation =
      createBaseMarketSaleDataState() as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >;
  } else if (!isPlainRecord(rawMarketSaleAutomation)) {
    const direct = normalizeDirectAutomationState(undefined);
    direct.quarantinedPendingDirectDeals[
      "__market_sale_automation_container__"
    ] = rawMarketSaleAutomation;
    direct.migrationBlockedReason = "market_sale_automation_container_invalid";
    Memory.data.marketSaleAutomation = {
      ...createBaseMarketSaleDataState(),
      pendingDirectDeals: direct.pendingDirectDeals,
      directAutomation: direct,
    } as unknown as NonNullable<
      NonNullable<Memory["data"]>["marketSaleAutomation"]
    >;
  }
  const data = Memory.data
    .marketSaleAutomation as unknown as MarketSaleDataState;
  const quarantinedMarketState: Record<string, unknown> = {};
  const recoveredManagedOrders = recoverMarketStateRecord<OwnedManagedOrder>(
    data.managedOrders as unknown,
    "__managed_orders_container__",
    "__managed_order__",
    quarantinedMarketState,
    isRecoverableManagedOrder,
  );
  const recoveredPendingMutations =
    recoverMarketStateRecord<PendingOrderMutation>(
      data.pendingMutations as unknown,
      "__pending_mutations_container__",
      "__pending_mutation__",
      quarantinedMarketState,
      isRecoverablePendingMutation,
    );
  const rawPendingMutationRecord = isPlainRecord(
    data.pendingMutations as unknown,
  )
    ? (data.pendingMutations as unknown as Record<string, unknown>)
    : {};
  for (const orderId of Object.keys(recoveredPendingMutations)) {
    if (recoveredManagedOrders[orderId]) continue;
    quarantinedMarketState[`__orphan_pending_mutation__:${orderId}`] =
      rawPendingMutationRecord[orderId] ?? recoveredPendingMutations[orderId];
    delete recoveredPendingMutations[orderId];
  }
  const rawPendingCreate = data.pendingCreate as unknown;
  let recoveredPendingCreate: OwnedPendingCreate | undefined;
  if (
    rawPendingCreate !== undefined &&
    !isRecoverablePendingCreate(rawPendingCreate)
  ) {
    quarantinedMarketState["__pending_create__"] = rawPendingCreate;
  } else {
    recoveredPendingCreate = rawPendingCreate as OwnedPendingCreate | undefined;
  }
  data.feeEvents ||= [];
  // fee ledger 内容级校验（fail-closed）：损坏的持久化账本在此检出——
  // 原始证据以有界 JSON 摘要随 ledger 自身隔离（不依赖 direct
  // quarantine 的合并行为），账本替换为空窗口 + 不可绕过 invalid
  // blocker（create/extend/reprice 与账本写入全部禁止，operator 显式
  // 修复前不恢复）。绝不静默重置为空账本（跨 tick 快速路径移除后，
  // 该校验每 tick 执行）。
  const feeLedgerValidation = validateFeeLedger(data.feeLedger);
  if (feeLedgerValidation.status === "invalid") {
    const corruptRawLedger = data.feeLedger ?? null;
    quarantinedMarketState["__fee_ledger__"] = corruptRawLedger;
    data.feeLedger = createFeeLedgerBlocked(
      feeLedgerValidation.reason,
      Game.time,
      corruptRawLedger,
    );
  } else {
    data.feeLedger =
      feeLedgerValidation.ledger ?? createEmptyMarketSaleFeeLedger();
  }
  // operator 显式修复入口：console 写 Memory.runtime.marketFeeLedgerRepair
  // = true（当 tick 生效，幂等清除）。修复只清除 blocker，隔离证据保留。
  data.operatorAudit ||= [];
  const runtimeMemory = Memory.runtime as
    | { marketFeeLedgerRepair?: boolean }
    | undefined;
  if (runtimeMemory?.marketFeeLedgerRepair) {
    delete runtimeMemory.marketFeeLedgerRepair;
    if (data.feeLedger.invalid) {
      const resolvedAt = Game.time;
      const blockedReason = data.feeLedger.invalid.reason;
      data.feeLedger = resolveFeeLedgerInvalid({ ledger: data.feeLedger });
      boundedPush(
        data.operatorAudit,
        {
          tick: resolvedAt,
          action: `fee_ledger_invalid_resolved:${blockedReason}`,
        },
        MAX_FEE_EVENTS,
      );
    }
  }
  data.carriedFeeDebtMilli ||= {};
  data.trustedFloors ||= {};
  data.processedTransactionKeys ||= [];
  data.operatorAudit ||= [];
  data.drain ||= { phase: "off", zeroConfirmations: 0 };
  if (data.marketStaging === undefined) data.marketStaging = {};
  if (data.marketReservations === undefined) {
    data.marketReservations = {};
  }
  const rawDirectAutomation = data.directAutomation as unknown;
  let normalizedDirect:
    DirectAutomationState | MarketDirectContinuousAutomationState;
  const hasPostCutoverEvidence =
    data.baseResourceV3ActivationAnchor !== undefined ||
    data.baseResourceV3ActivationAnchorMirror !== undefined ||
    data.baseResourceV3ActivationBlocker !== undefined;
  if (hasPostCutoverEvidence && isContinuousDirectState(rawDirectAutomation)) {
    // Active V3 authority 必须由紧随其后的双 activation anchor +
    // runtime gate 判定。这里保留 exact raw identity，既不让 normalizer
    // “修复”损坏证据，也避免 cold tick 先 JSON clone 两个 512-ring。
    normalizedDirect = rawDirectAutomation;
  } else if (isContinuousDirectState(rawDirectAutomation)) {
    // v2 绝不能经过 legacy normalizer，否则 schema/capability、permit/WAL
    // 会被旧版“修复”为一个看似可写的 v1 空状态。
    normalizedDirect = normalizeContinuousForStorage(
      rawDirectAutomation,
      Game.time,
    );
  } else if (isLegacyDirectState(rawDirectAutomation)) {
    // 只有 schema=1 且无 v2 capability 的 canonical 才允许先按 v1
    // 精确归一化，再由确定性 golden migration 尝试升级。任何 alias
    // 分叉先固化为 blocker，不能把兼容投影合并回 canonical WAL。
    const legacy = normalizeDirectAutomationState(rawDirectAutomation);
    const compatibilityPending = data.pendingDirectDeals as unknown;
    const compatibilityMatchesCanonical =
      compatibilityPending === undefined ||
      compatibilityPending === legacy.pendingDirectDeals ||
      JSON.stringify(compatibilityPending) ===
        JSON.stringify(legacy.pendingDirectDeals) ||
      isResolvedDirectPendingCompatibilityAlias(
        compatibilityPending,
        legacy.directDealOutcomes,
      );
    if (!compatibilityMatchesCanonical) {
      legacy.quarantinedPendingDirectDeals = {
        ...quarantinedDirectPendingAlias(compatibilityPending),
        ...legacy.quarantinedPendingDirectDeals,
      };
      legacy.migrationBlockedReason = "direct_pending_alias_mismatch";
    }
    normalizedDirect = normalizeContinuousForStorage(
      migrateLegacyDirectToContinuous(
        canonicalMemoryEvidence(legacy) as DirectAutomationState,
        Game.time,
      ),
      Game.time,
    );
  } else {
    // 新 bundle 不再把 missing/unknown Direct state 初始化成可写 v1。
    // canonical 与兼容 alias 一并进入 blocked evidence；禁止覆盖掉一个
    // 可能代表 CPU-cut 中间态的旧 pending。
    const compatibilityPending = data.pendingDirectDeals as unknown;
    const safeEmptyCompatibility =
      compatibilityPending === undefined ||
      (isPlainRecord(compatibilityPending) &&
        Object.keys(compatibilityPending).length === 0);
    normalizedDirect = normalizeContinuousForStorage(
      rawDirectAutomation === undefined && safeEmptyCompatibility
        ? undefined
        : {
            canonicalDirectState: rawDirectAutomation,
            compatibilityPending,
          },
      Game.time,
    );
  }
  // pendingDirectDeals 只是回滚/保护账本兼容投影；canonical v2 永远覆盖
  // alias，禁止把旧 alias 反向合并进 permit/WAL。
  data.pendingDirectDeals = normalizedDirect.pendingDirectDeals;
  data.directAutomation = normalizedDirect;
  let committedDirect = data.directAutomation!;
  if (Object.keys(quarantinedMarketState).length > 0) {
    const existingBlocker = committedDirect.migrationBlockedReason;
    committedDirect = {
      ...committedDirect,
      quarantinedPendingDirectDeals: {
        ...quarantinedMarketState,
        ...committedDirect.quarantinedPendingDirectDeals,
      },
      migrationBlockedReason:
        !existingBlocker ||
        existingBlocker === "direct_qualification_state_invalid"
          ? "market_sale_data_state_invalid"
          : existingBlocker,
    };
  }
  const committedData: MarketSaleDataState = {
    ...data,
    managedOrders: recoveredManagedOrders,
    pendingMutations: recoveredPendingMutations,
    pendingCreate: recoveredPendingCreate,
    pendingDirectDeals: committedDirect.pendingDirectDeals,
    directAutomation: committedDirect,
  };
  // 右值先完整构造，最后以单次 canonical container assignment 作为
  // commit marker。CPU 若在它之前中断，原始损坏记录仍在；若在它之后
  // 中断，quarantine/blocker 与 typed 清理已经不可分割地同时落盘。
  Memory.data.marketSaleAutomation = committedData as unknown as NonNullable<
    NonNullable<Memory["data"]>["marketSaleAutomation"]
  >;
  // 深恢复完成的原子 commit 即验证点：标记仅供同 tick 引用短路复用，
  // 跨 tick（Memory 重解析）一律重新深恢复。
  verifiedDataRoot = committedData;
  verifiedDataRootTick = Game.time;
  marketDataStateDeepRecoveries += 1;
  bumpMarketPerformanceCounter("marketDataStateDeepRecoveries");
  // 保护账本和 carrier 仍读取兼容字段；正常返回时它与 Direct WAL
  // 使用同一对象，写入顺序同时覆盖 CPU 截断恢复。
  return committedData;
}

/** 受控落盘后更新同 tick 快速读取标记，写权限留在状态持有方。 */
export function rememberVerifiedMarketSaleDataRoot(data: MarketSaleDataState): void {
  verifiedDataRoot = data;
  verifiedDataRootTick = Game.time;
}
