import { measureMarketSubPhase } from "@/runtime/marketSaleDiagnostics";
import {
  executeCancelOrder,
  executeCreateOrder,
  getTerminalActionClaims,
  hasTerminalActionClaim,
} from "@/runtime/marketActionArbiter";
import {
  enforceLegacyMarketSafetyLatch,
  MARKET_DIRECT_CANARY_POLICY,
  MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION,
  marketBaseResourceV3ConfigMismatchReasons,
  resolveMarketSaleAutomationConfig,
  type MarketSaleAutomationConfig,
  type ResolvedMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  directAutomationExposure,
  directAutomationSnapshotStatus,
  normalizeDirectAutomationState,
  resolveDirectAutomationPending,
  runDirectAutomationPlanning,
  runDirectAutomationPreflight,
  type DirectAutomationState,
  type DirectRuntimeCandidate,
} from "@/runtime/marketSaleDirectAutomation";
import {
  acceptMarketDirectContinuousPermit as acceptContinuousPermitState,
  defaultMarketDirectContinuousDependencies,
  marketDirectContinuousExposure,
  marketDirectContinuousStatus as projectContinuousDirectStatus,
  migrateLegacyDirectToContinuous,
  normalizeContinuousDirectState,
  proposeMarketDirectContinuousPermit as proposeContinuousPermitState,
  runMarketDirectContinuousPlanning,
  runMarketDirectContinuousPreflight,
  type ContinuousPendingProjection,
  type MarketDirectContinuousAutomationState,
  type MarketDirectContinuousPermitRequest,
  type MarketDirectContinuousResult,
  type MarketDirectContinuousRuntimeCandidate,
} from "@/runtime/marketDirectContinuousAutomation";
import {
  MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
  MARKET_DIRECT_CONTINUOUS_SCHEMA,
  canonicalStableHashV1,
  validateMarketDirectContinuousPermitChain,
} from "@/runtime/marketDirectContinuousPolicy";
import {
  advanceMarketBaseResourceReadinessRuntimeCapability,
  advanceMarketBaseResourceReadinessRuntimeCapabilityFromRoot,
  buildMarketBaseResourcePricingRatchetState,
  collectLiveMarketBaseRoomObservations,
  createMarketBaseResourceReadinessRuntimeCapability,
  defaultMarketBaseResourceRuntimeDependencies,
  deriveMarketBaseResourceCanonicalReadinessAuthorization,
  marketBaseResourceActivationAnchorSelfHash,
  marketBaseResourceCpuFallbackRequiresCanonicalCommit,
  marketBaseResourceOperatorAuthorizationFingerprint,
  marketBaseResourceOuterScopeCommitment,
  materializeMarketBaseResourceCpuFallback,
  observeMarketBaseResourceOuterPrecommitCpu,
  readLiveMarketBaseAccountIdentity,
  registerMarketBaseResourceCanonicalReadinessRuntimeCapability,
  reconcileLiveMarketBaseResourceScope,
  reconcileLiveMarketBaseResourceScopeWithRuntimeCapability,
  reconcileMarketBaseResourcePreflight,
  readLiveMarketBaseTerminal,
  resignMarketBaseResourceReadinessAuthorizationWithRuntimeCapability,
  runMarketBaseResourceAutomation,
  runMarketBaseResourcePreflight,
  validateMarketBaseResourceReadinessRuntimeCapability,
  validateMarketBaseResourcePricingRatchetState,
  type MarketBaseResourceAutomationResult,
  type MarketBaseResourceCpuCutPhase,
  type MarketBaseResourceCpuFallbackResult,
  type MarketBaseResourceCpuTrace,
  type MarketBaseResourceMarketFactsDisposition,
  type MarketBaseResourcePermitProposal,
  type MarketBaseResourcePricingRatchetState,
  type MarketBaseResourceReadinessRuntimeCapability,
  type MarketBaseResourceScopeState,
  type MarketBaseResourceRuntimeCandidate,
  type MarketBaseResourceV3RuntimeState,
} from "@/runtime/marketBaseResourceAutomation";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  MARKET_BASE_RESOURCE_POLICIES,
  createMarketBaseSharedPolicy,
  isMarketBaseResource,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  migrateMarketBaseDerivedLanes,
  validateMarketBaseDerivedLaneLifecycle,
  type MarketBaseDerivedLaneLifecycle,
  type MarketBaseResource,
} from "@/runtime/marketBaseResourcePolicy";
import {
  appendMarketBaseResourcePermit,
  buildMarketBaseResourceBootstrapRatchetHighWater,
  buildMarketBaseResourceLegacyV2GrantSuspension,
  buildMarketBaseResourcePermit,
  buildMarketBaseResourceSignedLaneGrant,
  buildMarketBaseResourceV2EventCutoverCheckpoint,
  createMarketBaseResourcePermitChainState,
  hasAcceptedMarketBaseResourceV3Successor,
  validateMarketBaseResourcePermitChain,
  wrapAuthenticatedLegacyV2PermitRecord,
  type MarketBaseResourcePermit,
  type MarketBaseResourceReviewedEvidence,
  type MarketBaseResourceSignedLaneGrant,
} from "@/runtime/marketBaseResourcePermit";
import {
  buildMarketBaseResourceLedgerRuntimeAnchor,
  buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis,
  buildMarketBaseResourceConfirmedCanaryProof,
  createMarketBaseResourceLedger,
  marketBaseResourceCanaryReviewFactsFor,
  marketBaseResourceQuotaProjection,
  marketBaseResourceRetainedReceiptPermitReferences,
  rebindMarketBaseResourceLedgerPermitAnchor,
  validateMarketBaseResourceLedger,
  validateMarketBaseResourceLedgerRuntimeGate,
  validateMarketBaseResourcePermitChainDominatesAnchor,
  type MarketBaseResourceLedger,
  type MarketBaseResourceLedgerRuntimeAnchor,
  type MarketBaseResourceLedgerCounters,
  type MarketBaseResourceQuotaReceipt,
} from "@/runtime/marketBaseResourceLedger";
import {
  computeContinuousQuotaBatch,
  validateContinuousLedger,
} from "@/runtime/marketDirectContinuousLedger";
import {
  isResolvedDirectPendingCompatibilityAlias,
  recoverPendingDirectDeal,
  type OperatorDirectPendingEvidence,
  type PendingDirectDeal,
} from "@/runtime/marketSaleDirectPending";
import {
  calculateProspectiveFeeMilli,
  evaluatePostActionInvariant,
  findMinimumSafePrice,
  priceToMilliUp,
  roundMarketPriceUp,
} from "@/runtime/marketSalePricing";
import {
  evaluateMarketSaleCanaryPrerequisites,
  getMarketProtectionSellableAmount,
  isMarketProtectionEntryFresh,
  getMarketProtectionEntryKey,
  type MarketProtectionEntry,
} from "@/runtime/marketSaleProtection";
import { collectLiveMarketSaleProtectionLedger } from "@/runtime/marketSaleProtectionAdapter";
import {
  advanceFeeLedgerWindow,
  applyFillFeeDebt,
  commitProspectiveFeeReservation,
  createEmptyMarketSaleFeeLedger,
  getFeeLedgerTotals,
  markExternalOrderMutationFeeGap,
  reconcileDisappearedOrderFeeDebt,
  releaseProspectiveFeeReservation,
  reserveProspectiveFee,
  resolveDisappearedOrderFeeGap,
  resolveExternalOrderMutationFeeGap,
  takeCarriedFeeDebt,
  type MarketSaleFeeLedgerState,
} from "@/runtime/marketSaleFeeLedger";
import {
  attestPendingCreateOrder,
  createPendingCreateState,
  createPendingMutation,
  hashOrderIds,
  lockCanary,
  markPendingCreateSubmitted,
  markPendingMutationSubmitted,
  reconcilePendingCreate,
  reconcilePendingMutation,
  updateDrainState,
  type CanaryLock,
  type DrainState,
  type ManagedMarketOrderState,
  type MarketOrderSnapshot,
  type OrderMutationLease,
  type PendingCreateState,
  type PendingOrderMutation,
} from "@/runtime/marketSaleLifecycle";

const MAX_MARKET_ORDERS = 300;
const MAX_RECENT_ACTIONS = 20;
const MAX_AUDIT_ENTRIES = 50;
const MAX_FEE_EVENTS = 100;
const MAX_TRANSACTION_KEYS = 200;
const MAX_MANAGED_ORDER_SUMMARIES = 20;
const REQUIRED_SHADOW_CYCLES = 100;
const MARKET_BASE_RESOURCE_ACTIVATION_ANCHOR_REVISION =
  "market-base-resource-activation-anchor-v3" as const;
const MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION =
  "market-base-resource-activation-blocker-v1" as const;

/**
 * Maker / hybrid 已退出生产合同。该闩不可由 Memory、console、测试环境或
 * mode 切换绕过：旧 managed exposure 只能继续 reconcile 后 cancel/drain，
 * 永远不得再创建新的 SELL order。
 */
export const MARKET_MAKER_HYBRID_PERMANENTLY_DISABLED = true;

export interface MarketSalePlanCandidate {
  roomName: string;
  resourceType: ResourceConstant;
  protectionEntry: MarketProtectionEntry;
  effectiveNetFloor: number;
  /** Pricing adapter history evidence; absent means no trustworthy observation. */
  historyTrusted?: boolean;
  historyCompleteDayCount?: number;
  historyAcceptedDayCount?: number;
  historyFloor?: number;
  ratchetFloor?: number;
  makerPrice?: number;
  /** Per-unit maker value after current and prospective fee debt. */
  makerNetPrice?: number;
  /** Direct 只使用历史/ratchet/底价证据，不继承 Maker SELL 深度门禁。 */
  directHistoryTrusted?: boolean;
  effectiveEnergyShadowPrice?: number;
  energyShadowObservedAt?: number;
  energyShadowComponents?: {
    hardFloor: number;
    explicit?: number;
    historyFloor?: number;
    ratchetFloor?: number;
  };
  directAdditionalRejectionReasons?: readonly string[];
  trustedPrice: boolean;
  trustedDepth: boolean;
  capacityState?: "normal" | "pressure" | "emergency";
  hasCriticalConflict?: boolean;
  isHubRoom?: boolean;
  minimumTerminalFreeCapacity?: number;
  /** Adapter-level fail-closed reasons retained for operator diagnostics. */
  additionalRejectionReasons?: readonly string[];
}

export interface MarketSaleAutomationInput {
  candidates?: readonly MarketSalePlanCandidate[];
  readMarketBaseResourceCandidates?: () => readonly MarketSalePlanCandidate[];
  /**
   * V3 live pricing 在冻结 canonical floor root 的 detached 副本上生成的
   * successor。source identity 是同 tick 私有 capability 的一部分；outer
   * 验证高水位后，才会连同 pricing ratchet 与双 activation anchor 原子提交。
   */
  marketBaseResourceTrustedFloorSuccessor?:
    MarketBaseResourceTrustedFloorSuccessorInput;
  stagingAmount?: number;
  reservationAmount?: number;
  marketDomainActivityValid?: boolean;
}

export interface MarketBaseResourceTrustedFloorSuccessorInput {
  readonly sourceTrustedFloors: object;
  readonly trustedFloors: Partial<
    Record<
      ResourceConstant,
      { value: number; marketDate: string; updatedAt: number }
    >
  >;
}

export interface MarketSaleAutomationResult {
  requestedMode: MarketSaleAutomationConfig["mode"];
  effectiveMode: MarketSaleAutomationConfig["mode"];
  phase: DrainState["phase"];
  writes: number;
  actions: string[];
  rejectedByReason: Record<string, number>;
}

interface PendingCreateEvidence {
  creditsBefore?: number;
  terminalStockBefore?: number;
  outgoingKeysBefore?: string[];
  baselineOrderFingerprints?: Record<string, string>;
  operatorResolutionCandidateIds?: string[];
}

interface ExpansionGrant {
  configRevision: string;
  grantedAt: number;
}

interface DirectLegacyExposureDrainState {
  schemaVersion: 1;
  zeroConfirmations: number;
  lastZeroConfirmationTick?: number;
  completedAt?: number;
}

interface MarketBaseResourceRoomIncarnationHighWater {
  roomName: string;
  incarnationHighWater: number;
  lastInstanceId: string;
  admitted: boolean;
}

interface MarketBaseResourceLaneLifecycleHighWater {
  laneId: string;
  stableFingerprint: string;
  stage: MarketBaseDerivedLaneLifecycle["stage"];
  status: MarketBaseDerivedLaneLifecycle["status"];
  completeCycles: number;
  lastCompleteTick?: number;
  evidenceDigest?: string;
}

interface MarketBaseResourcePricingHighWater {
  resource: MarketBaseResource;
  value: number;
  marketDate: string;
}

interface MarketBaseResourceTrustedFloorHighWater extends Omit<
  MarketBaseResourcePricingHighWater,
  "resource"
> {
  resource: MarketBaseResource | typeof RESOURCE_ENERGY;
  updatedAt: number;
}

const MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES = [
  ...MARKET_BASE_RESOURCE_CATALOG,
  RESOURCE_ENERGY,
].sort((left, right) => left.localeCompare(right)) as readonly (
  MarketBaseResource | typeof RESOURCE_ENERGY
)[];

/**
 * V3 子树之外的不可回退激活/房间实例高水位。两个副本必须逐字一致；
 * nested baseResourceV3 缺失、损坏或整体回拨时，外层副本仍强制 dispatcher
 * 留在 V3 fail-closed 路径，绝不能重新解释为尚未 cutover 的 V2。
 */
export interface MarketBaseResourceActivationAnchor {
  schemaVersion: 1;
  hashRevision: typeof MARKET_BASE_RESOURCE_ACTIVATION_ANCHOR_REVISION;
  accountIdentity: string;
  executorShard: "shard1";
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

interface MarketBaseResourceActivationBlocker {
  schemaVersion: 1;
  hashRevision: typeof MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION;
  code: string;
  detectedAt: number;
  detailHash: string;
}

type OwnedManagedOrder = Omit<ManagedMarketOrderState, "resourceType"> & {
  resourceType: ResourceConstant;
  backoffUntil?: number;
};

type OwnedPendingCreate = Omit<PendingCreateState, "tuple"> &
  PendingCreateEvidence & {
    tuple: Omit<PendingCreateState["tuple"], "resourceType"> & {
      resourceType: ResourceConstant;
    };
  };

type OwnedCanaryLock = Omit<CanaryLock, "resourceType"> & {
  resourceType: ResourceConstant;
};

interface MarketSaleDataState {
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

type MarketBaseResourceActivationAnchorPayload = Omit<
  MarketBaseResourceActivationAnchor,
  "anchorHash"
>;

function marketBaseResourceActivationAnchorHash(
  payload: MarketBaseResourceActivationAnchorPayload,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:activation-anchor-v1",
    payload,
  });
}

function marketBaseResourceRoomIncarnationHighWater(
  scope: MarketBaseResourceScopeState,
): MarketBaseResourceRoomIncarnationHighWater[] {
  return scope.roomRegistry.knownRoomNames
    .map((roomName) => {
      const room = scope.roomRegistry.rooms[roomName];
      if (!room) {
        throw new TypeError(
          `market_base_room_registry_record_missing:${roomName}`,
        );
      }
      return {
        roomName,
        incarnationHighWater: room.incarnationHighWater,
        lastInstanceId: room.lastInstanceId,
        admitted: room.admitted,
      };
    })
    .sort((left, right) => left.roomName.localeCompare(right.roomName));
}

function sameMarketBaseResourceRoomIncarnationHighWater(
  left: readonly MarketBaseResourceRoomIncarnationHighWater[],
  right: readonly MarketBaseResourceRoomIncarnationHighWater[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const prior = right[index];
      return (
        prior?.roomName === entry.roomName &&
        prior.incarnationHighWater === entry.incarnationHighWater &&
        prior.lastInstanceId === entry.lastInstanceId &&
        prior.admitted === entry.admitted
      );
    })
  );
}

function marketBaseResourceLaneLifecycleHighWater(
  scope: MarketBaseResourceScopeState,
): MarketBaseResourceLaneLifecycleHighWater[] {
  return scope.laneLifecycles
    .map((lane) => ({
      laneId: lane.laneId,
      stableFingerprint: lane.stableFingerprint,
      stage: lane.stage,
      status: lane.status,
      completeCycles: lane.shadowEvidence.completeCycles,
      ...(lane.shadowEvidence.lastCompleteTick === undefined
        ? {}
        : {
            lastCompleteTick: lane.shadowEvidence.lastCompleteTick,
          }),
      ...(lane.shadowEvidence.evidenceDigest === undefined
        ? {}
        : {
            evidenceDigest: lane.shadowEvidence.evidenceDigest,
          }),
    }))
    .sort((left, right) => left.laneId.localeCompare(right.laneId));
}

function sameMarketBaseResourceLaneLifecycleHighWater(
  left: readonly MarketBaseResourceLaneLifecycleHighWater[],
  right: readonly MarketBaseResourceLaneLifecycleHighWater[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const prior = right[index];
      return (
        prior?.laneId === entry.laneId &&
        prior.stableFingerprint === entry.stableFingerprint &&
        prior.stage === entry.stage &&
        prior.status === entry.status &&
        prior.completeCycles === entry.completeCycles &&
        prior.lastCompleteTick === entry.lastCompleteTick &&
        prior.evidenceDigest === entry.evidenceDigest
      );
    })
  );
}

function marketBaseResourceLaneLifecycleCommitment(
  scope: MarketBaseResourceScopeState,
): string {
  return marketBaseDerivedLaneLifecycleCheckpointCommitment(
    scope.laneLifecycles,
  );
}

function marketBaseResourcePricingHighWater(
  pricingRatchet: MarketBaseResourcePricingRatchetState,
): MarketBaseResourcePricingHighWater[] {
  if (pricingRatchet.entries.length !== MARKET_BASE_RESOURCE_CATALOG.length) {
    throw new TypeError("market_base_pricing_ratchet_catalog_incomplete");
  }
  return MARKET_BASE_RESOURCE_CATALOG.map((resource) => {
    const entry = pricingRatchet.entries.find(
      (candidate) => candidate.resource === resource,
    );
    if (
      !entry ||
      !Number.isFinite(entry.value) ||
      entry.value <= 0 ||
      typeof entry.marketDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.marketDate)
    ) {
      throw new TypeError(
        `market_base_pricing_ratchet_entry_invalid:${resource}`,
      );
    }
    return {
      resource,
      value: entry.value,
      marketDate: entry.marketDate,
    };
  });
}

function marketBaseResourceTrustedFloorHighWater(
  trustedFloors: MarketSaleDataState["trustedFloors"],
): MarketBaseResourceTrustedFloorHighWater[] {
  return MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES.map((resource) => {
    const entry = trustedFloors[resource];
    if (
      !entry ||
      !Number.isFinite(entry.value) ||
      entry.value <= 0 ||
      typeof entry.marketDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.marketDate) ||
      !Number.isSafeInteger(entry.updatedAt) ||
      entry.updatedAt < 0
    ) {
      throw new TypeError(
        `market_base_trusted_floor_entry_invalid:${resource}`,
      );
    }
    return {
      resource,
      value: entry.value,
      marketDate: entry.marketDate,
      updatedAt: entry.updatedAt,
    };
  });
}

function assertMarketBaseResourcePricingConsistency(
  pricing: readonly MarketBaseResourcePricingHighWater[],
  trusted: readonly MarketBaseResourceTrustedFloorHighWater[],
): void {
  if (
    pricing.length !== MARKET_BASE_RESOURCE_CATALOG.length ||
    trusted.length !== MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES.length ||
    pricing.some((entry) => {
      const floor = trusted.find(
        (candidate) => candidate.resource === entry.resource,
      );
      return (
        !floor ||
        entry.value > floor.value ||
        entry.marketDate > floor.marketDate
      );
    })
  ) {
    throw new TypeError("market_base_pricing_trusted_floor_mismatch");
  }
}

function synchronizeMarketBaseTrustedFloors(
  current: MarketSaleDataState["trustedFloors"],
  pricingRatchet: MarketBaseResourcePricingRatchetState,
  tick: number,
): MarketSaleDataState["trustedFloors"] {
  const next = cloneMarketBaseOperatorValue(current);
  for (const entry of marketBaseResourcePricingHighWater(pricingRatchet)) {
    const prior = next[entry.resource];
    const value = Math.max(prior?.value ?? 0, entry.value);
    const marketDate =
      prior?.marketDate && prior.marketDate > entry.marketDate
        ? prior.marketDate
        : entry.marketDate;
    next[entry.resource] = {
      value,
      marketDate,
      updatedAt:
        prior && prior.value === value && prior.marketDate === marketDate
          ? prior.updatedAt
          : tick,
    };
  }
  const currentKeys = Object.keys(current).sort();
  const nextKeys = Object.keys(next).sort();
  if (
    currentKeys.length === nextKeys.length &&
    currentKeys.every((key, index) => {
      if (key !== nextKeys[index]) return false;
      const previous = current[key as ResourceConstant];
      const candidate = next[key as ResourceConstant];
      return (
        previous?.value === candidate?.value &&
        previous?.marketDate === candidate?.marketDate &&
        previous?.updatedAt === candidate?.updatedAt
      );
    })
  ) {
    return current;
  }
  return next;
}

function resolveMarketBaseTrustedFloorSuccessor(
  current: MarketSaleDataState["trustedFloors"],
  proposal: MarketBaseResourceTrustedFloorSuccessorInput,
  tick: number,
):
  | { ok: true; trustedFloors: MarketSaleDataState["trustedFloors"] }
  | { ok: false; reason: string } {
  try {
    if (
      proposal.sourceTrustedFloors !== current ||
      !isPlainRecord(proposal.trustedFloors)
    ) {
      return { ok: false, reason: "source_identity_mismatch" };
    }
    const next = cloneMarketBaseOperatorValue(
      proposal.trustedFloors,
    ) as MarketSaleDataState["trustedFloors"];
    const currentKeys = Object.keys(current).sort();
    const nextKeys = Object.keys(next).sort();
    if (
      currentKeys.length !== nextKeys.length ||
      currentKeys.some((key, index) => key !== nextKeys[index])
    ) {
      return { ok: false, reason: "key_set_mismatch" };
    }
    for (const resource of MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES) {
      if (
        !isPlainRecord(current[resource]) ||
        !isPlainRecord(next[resource]) ||
        !hasExactRecordKeys(current[resource], [
          "marketDate",
          "updatedAt",
          "value",
        ]) ||
        !hasExactRecordKeys(next[resource], [
          "marketDate",
          "updatedAt",
          "value",
        ])
      ) {
        return { ok: false, reason: `entry_shape_invalid:${resource}` };
      }
    }
    const currentHighWater = marketBaseResourceTrustedFloorHighWater(current);
    const nextHighWater = marketBaseResourceTrustedFloorHighWater(next);
    let changed = false;
    for (let index = 0; index < currentHighWater.length; index += 1) {
      const previous = currentHighWater[index];
      const candidate = nextHighWater[index];
      if (
        !candidate ||
        candidate.resource !== previous.resource ||
        candidate.value < previous.value ||
        candidate.marketDate < previous.marketDate ||
        candidate.updatedAt < previous.updatedAt ||
        candidate.updatedAt > tick
      ) {
        return { ok: false, reason: "high_water_rollback" };
      }
      const entryChanged =
        candidate.value !== previous.value ||
        candidate.marketDate !== previous.marketDate ||
        candidate.updatedAt !== previous.updatedAt;
      if (entryChanged && candidate.updatedAt !== tick) {
        return { ok: false, reason: "updated_at_not_current" };
      }
      changed ||= entryChanged;
    }
    const anchoredResources = new Set<string>(
      MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES,
    );
    for (const key of currentKeys) {
      if (anchoredResources.has(key)) continue;
      if (
        canonicalStableHashV1({ value: current[key as ResourceConstant] }) !==
        canonicalStableHashV1({ value: next[key as ResourceConstant] })
      ) {
        return { ok: false, reason: `unscoped_entry_changed:${key}` };
      }
    }
    if (!changed) {
      return { ok: true, trustedFloors: current };
    }
    freezeMarketBaseOuterCanonicalValue(next);
    return { ok: true, trustedFloors: next };
  } catch {
    return { ok: false, reason: "shape_invalid" };
  }
}

function marketBaseResourceRuntimeSafetyProjection(
  state: Pick<
    MarketBaseResourceV3RuntimeState,
    "hardBlocker" | "ledger" | "permitChain" | "pricingRatchet"
  >,
  trustedFloors: MarketSaleDataState["trustedFloors"],
  validatedLedgerAnchor?: MarketBaseResourceLedgerRuntimeAnchor,
): Pick<
  MarketBaseResourceActivationAnchor,
  | "ledger"
  | "pricingRatchetInitializedAt"
  | "pricingRatchetBootstrapFingerprint"
  | "pricingRatchetCommitment"
  | "pricingRatchetHighWater"
  | "trustedFloorsCommitment"
  | "trustedFloorHighWater"
  | "hardBlocker"
  | "runtimeSafetyCommitment"
> {
  if (!state.ledger || !state.permitChain || !state.pricingRatchet) {
    throw new TypeError("market_base_runtime_safety_state_incomplete");
  }
  const ledger =
    validatedLedgerAnchor ??
    buildMarketBaseResourceLedgerRuntimeAnchor(state.ledger, state.permitChain);
  const pricingRatchetHighWater = marketBaseResourcePricingHighWater(
    state.pricingRatchet,
  );
  const trustedFloorHighWater =
    marketBaseResourceTrustedFloorHighWater(trustedFloors);
  assertMarketBaseResourcePricingConsistency(
    pricingRatchetHighWater,
    trustedFloorHighWater,
  );
  const pricingRatchetCommitment = canonicalStableHashV1({
    domain: "market-base-resource:outer-pricing-ratchet-v1",
    initializedAt: state.pricingRatchet.initializedAt,
    bootstrapFingerprint: state.pricingRatchet.bootstrapFingerprint,
    entries: pricingRatchetHighWater,
  });
  const trustedFloorsCommitment = canonicalStableHashV1({
    domain: "market-base-resource:outer-trusted-floors-v1",
    entries: trustedFloorHighWater,
  });
  const hardBlocker = state.hardBlocker
    ? {
        code: state.hardBlocker.code,
        detectedAt: state.hardBlocker.detectedAt,
        detailHash: state.hardBlocker.detailHash,
      }
    : null;
  return {
    ledger,
    pricingRatchetInitializedAt: state.pricingRatchet.initializedAt,
    pricingRatchetBootstrapFingerprint:
      state.pricingRatchet.bootstrapFingerprint,
    pricingRatchetCommitment,
    pricingRatchetHighWater,
    trustedFloorsCommitment,
    trustedFloorHighWater,
    hardBlocker,
    runtimeSafetyCommitment: canonicalStableHashV1({
      domain: "market-base-resource:outer-runtime-safety-v1",
      ledger,
      pricingRatchetCommitment,
      trustedFloorsCommitment,
      hardBlocker,
    }),
  };
}

function marketBaseResourceRuntimeSafetyDominates(
  anchor: MarketBaseResourceActivationAnchor,
  next: ReturnType<typeof marketBaseResourceRuntimeSafetyProjection>,
  state: Pick<MarketBaseResourceV3RuntimeState, "ledger">,
): boolean {
  const ledger = state.ledger;
  if (
    !ledger ||
    next.ledger.prunedThroughAttemptSeq <
      anchor.ledger.prunedThroughAttemptSeq ||
    next.ledger.nextAttemptSeq < anchor.ledger.nextAttemptSeq ||
    next.ledger.finalizedAttemptSeq < anchor.ledger.finalizedAttemptSeq ||
    next.pricingRatchetHighWater.length !==
      anchor.pricingRatchetHighWater.length ||
    next.trustedFloorHighWater.length !== anchor.trustedFloorHighWater.length ||
    next.pricingRatchetInitializedAt !== anchor.pricingRatchetInitializedAt ||
    next.pricingRatchetBootstrapFingerprint !==
      anchor.pricingRatchetBootstrapFingerprint ||
    (anchor.hardBlocker !== null &&
      canonicalStableHashV1(next.hardBlocker) !==
        canonicalStableHashV1(anchor.hardBlocker))
  ) {
    return false;
  }
  const priorLedger = anchor.ledger;
  const currentLedger = next.ledger;
  const prepareTransition =
    currentLedger.nextAttemptSeq === priorLedger.nextAttemptSeq + 1 &&
    priorLedger.pendingFrozenEvidenceHash === null &&
    currentLedger.pendingFrozenEvidenceHash !== null &&
    currentLedger.pendingAttemptSeq === priorLedger.nextAttemptSeq &&
    currentLedger.finalizedAttemptSeq === priorLedger.finalizedAttemptSeq &&
    currentLedger.receiptHeadHash === priorLedger.receiptHeadHash;
  if (
    currentLedger.nextAttemptSeq !== priorLedger.nextAttemptSeq &&
    !prepareTransition
  ) {
    return false;
  }
  if (
    priorLedger.pendingFrozenEvidenceHash !== null &&
    currentLedger.pendingFrozenEvidenceHash !== null &&
    (priorLedger.pendingFrozenEvidenceHash !==
      currentLedger.pendingFrozenEvidenceHash ||
      priorLedger.pendingAttemptSeq !== currentLedger.pendingAttemptSeq)
  ) {
    return false;
  }
  if (
    priorLedger.pendingFrozenEvidenceHash !== null &&
    currentLedger.pendingFrozenEvidenceHash === null &&
    currentLedger.finalizedAttemptSeq < (priorLedger.pendingAttemptSeq ?? 0)
  ) {
    return false;
  }
  if (currentLedger.receiptHeadHash !== priorLedger.receiptHeadHash) {
    if (currentLedger.finalizedAttemptSeq <= priorLedger.finalizedAttemptSeq) {
      return false;
    }
    const appended = ledger.receipts
      .filter((receipt) => receipt.attemptSeq > priorLedger.finalizedAttemptSeq)
      .sort((left, right) => left.attemptSeq - right.attemptSeq);
    let head = priorLedger.receiptHeadHash;
    for (const receipt of appended) {
      if (receipt.prevHash !== head) {
        return false;
      }
      head = receipt.headHash;
    }
    if (appended.length === 0 || head !== currentLedger.receiptHeadHash) {
      return false;
    }
  } else if (
    currentLedger.finalizedAttemptSeq !== priorLedger.finalizedAttemptSeq
  ) {
    return false;
  }
  const checkpointChanged =
    currentLedger.checkpointHash !== priorLedger.checkpointHash ||
    currentLedger.retiredCanaryCheckpointCommitment !==
      priorLedger.retiredCanaryCheckpointCommitment;
  const permitAnchorChanged =
    canonicalStableHashV1(currentLedger.permitRuntimeAnchor) !==
    canonicalStableHashV1(priorLedger.permitRuntimeAnchor);
  if (
    checkpointChanged &&
    !prepareTransition &&
    currentLedger.finalizedAttemptSeq === priorLedger.finalizedAttemptSeq &&
    !permitAnchorChanged
  ) {
    return false;
  }
  const pricingDominates = next.pricingRatchetHighWater.every(
    (entry, index) => {
      const prior = anchor.pricingRatchetHighWater[index];
      return (
        prior?.resource === entry.resource &&
        entry.value >= prior.value &&
        entry.marketDate >= prior.marketDate
      );
    },
  );
  const priorTrustedByResource = new Map(
    anchor.trustedFloorHighWater.map((entry) => [entry.resource, entry]),
  );
  const trustedDominates = next.trustedFloorHighWater.every((entry) => {
    const prior = priorTrustedByResource.get(entry.resource);
    return Boolean(
      prior &&
      entry.value >= prior.value &&
      entry.marketDate >= prior.marketDate &&
      entry.updatedAt >= prior.updatedAt,
    );
  });
  return pricingDominates && trustedDominates;
}

function buildMarketBaseResourceActivationAnchor(input: {
  proposal: MarketBaseResourcePermitProposal;
  scope: MarketBaseResourceScopeState;
  direct: MarketDirectContinuousAutomationState;
  acceptedAt: number;
}): MarketBaseResourceActivationAnchor {
  const firstPermit = input.proposal.targetPermitChain.retainedPermits.find(
    (record) => record.schemaVersion === 3,
  );
  const cutover = input.proposal.targetPermitChain.v2EventCutoverCheckpoint;
  if (
    input.proposal.kind !== "v2-cutover" ||
    !firstPermit ||
    firstPermit.schemaVersion !== 3 ||
    !cutover ||
    input.proposal.targetPermitChain.legacyV2GrantSuspended !== true
  ) {
    throw new TypeError("market_base_activation_anchor_cutover_invalid");
  }
  const laneLifecycleHighWater = marketBaseResourceLaneLifecycleHighWater(
    input.scope,
  );
  const runtimeSafety = marketBaseResourceRuntimeSafetyProjection(
    {
      ledger: input.proposal.targetLedger,
      permitChain: input.proposal.targetPermitChain,
      pricingRatchet: input.proposal.targetPricingRatchet,
      hardBlocker: undefined,
    },
    input.proposal.targetTrustedFloors,
  );
  const payload: MarketBaseResourceActivationAnchorPayload = {
    schemaVersion: 1,
    hashRevision: MARKET_BASE_RESOURCE_ACTIVATION_ANCHOR_REVISION,
    accountIdentity: input.proposal.accountIdentity,
    executorShard: input.proposal.executorShard,
    acceptedAt: input.acceptedAt,
    updatedAt: input.acceptedAt,
    operatorAuthorizationFingerprint:
      input.proposal.operatorAuthorizationFingerprint,
    cutoverCheckpointHash: cutover.checkpointHash,
    legacyV2QuiescenceCommitment: marketBaseLegacyV2QuiescenceCommitment(
      input.direct,
    ),
    firstV3PermitEpoch: firstPermit.epoch,
    firstV3PermitId: firstPermit.permitId,
    firstV3PermitHead: firstPermit.permitHead,
    laneTombstoneCheckpointCommitment:
      input.proposal.targetPermitChain.laneTombstoneCheckpoint
        .checkpointCommitment,
    laneTombstoneDischargeCheckpointCommitment:
      input.scope.laneTombstoneDischargeCheckpoint.checkpointCommitment,
    roomRegistryCheckpointCommitment:
      input.scope.roomRegistry.checkpointCommitment,
    scopeCommitment: marketBaseResourceOuterScopeCommitment(input.scope),
    roomIncarnationHighWater: marketBaseResourceRoomIncarnationHighWater(
      input.scope,
    ),
    laneLifecycleHighWater: laneLifecycleHighWater,
    laneLifecycleCommitment: marketBaseResourceLaneLifecycleCommitment(
      input.scope,
    ),
    ...runtimeSafety,
    activationBlocker: null,
  };
  return {
    ...payload,
    anchorHash: marketBaseResourceActivationAnchorHash(payload),
  };
}

export function advanceMarketBaseResourceActivationAnchor(
  anchor: MarketBaseResourceActivationAnchor,
  state: MarketBaseResourceV3RuntimeState,
  trustedFloors: MarketSaleDataState["trustedFloors"],
  tick: number,
  validatedLedgerAnchor?: MarketBaseResourceLedgerRuntimeAnchor,
): MarketBaseResourceActivationAnchor {
  if (!state.scope || !state.permitChain) {
    throw new TypeError("market_base_activation_advance_state_incomplete");
  }
  const scope = state.scope;
  const permitChain = state.permitChain;
  const projectedLaneLifecycleHighWater =
    marketBaseResourceLaneLifecycleHighWater(scope);
  const laneLifecycleUnchanged =
    sameMarketBaseResourceLaneLifecycleHighWater(
      projectedLaneLifecycleHighWater,
      anchor.laneLifecycleHighWater,
    );
  const laneLifecycleHighWater = laneLifecycleUnchanged
    ? anchor.laneLifecycleHighWater
    : projectedLaneLifecycleHighWater;
  const runtimeSafety = marketBaseResourceRuntimeSafetyProjection(
    state,
    trustedFloors,
    validatedLedgerAnchor,
  );
  if (!marketBaseResourceRuntimeSafetyDominates(anchor, runtimeSafety, state)) {
    throw new TypeError("market_base_runtime_safety_high_water_rollback");
  }
  const payload: MarketBaseResourceActivationAnchorPayload = {
    ...anchor,
    updatedAt: tick,
    roomRegistryCheckpointCommitment: scope.roomRegistry.checkpointCommitment,
    scopeCommitment: marketBaseResourceOuterScopeCommitment(scope),
    laneTombstoneCheckpointCommitment:
      permitChain.laneTombstoneCheckpoint.checkpointCommitment,
    laneTombstoneDischargeCheckpointCommitment:
      scope.laneTombstoneDischargeCheckpoint.checkpointCommitment,
    roomIncarnationHighWater: marketBaseResourceRoomIncarnationHighWater(scope),
    laneLifecycleHighWater,
    laneLifecycleCommitment: laneLifecycleUnchanged
      ? anchor.laneLifecycleCommitment
      : marketBaseResourceLaneLifecycleCommitment(scope),
    ...runtimeSafety,
  };
  delete (
    payload as MarketBaseResourceActivationAnchorPayload & {
      anchorHash?: string;
    }
  ).anchorHash;
  return {
    ...payload,
    anchorHash: marketBaseResourceActivationAnchorHash(payload),
  };
}

function validateMarketBaseResourceActivationAnchor(
  value: unknown,
): value is MarketBaseResourceActivationAnchor {
  if (!isPlainRecord(value)) return false;
  if (
    !hasExactRecordKeys(value, [
      "acceptedAt",
      "accountIdentity",
      "activationBlocker",
      "anchorHash",
      "cutoverCheckpointHash",
      "executorShard",
      "firstV3PermitEpoch",
      "firstV3PermitHead",
      "firstV3PermitId",
      "hardBlocker",
      "hashRevision",
      "laneLifecycleCommitment",
      "laneLifecycleHighWater",
      "laneTombstoneCheckpointCommitment",
      "laneTombstoneDischargeCheckpointCommitment",
      "ledger",
      "legacyV2QuiescenceCommitment",
      "operatorAuthorizationFingerprint",
      "pricingRatchetBootstrapFingerprint",
      "pricingRatchetCommitment",
      "pricingRatchetHighWater",
      "pricingRatchetInitializedAt",
      "roomIncarnationHighWater",
      "roomRegistryCheckpointCommitment",
      "runtimeSafetyCommitment",
      "schemaVersion",
      "scopeCommitment",
      "trustedFloorHighWater",
      "trustedFloorsCommitment",
      "updatedAt",
    ])
  ) {
    return false;
  }
  const anchor = value as unknown as MarketBaseResourceActivationAnchor;
  if (
    anchor.schemaVersion !== 1 ||
    anchor.hashRevision !== MARKET_BASE_RESOURCE_ACTIVATION_ANCHOR_REVISION ||
    typeof anchor.accountIdentity !== "string" ||
    anchor.accountIdentity.length === 0 ||
    anchor.accountIdentity.length > 128 ||
    anchor.executorShard !== "shard1" ||
    !Number.isSafeInteger(anchor.acceptedAt) ||
    anchor.acceptedAt < 0 ||
    !Number.isSafeInteger(anchor.updatedAt) ||
    anchor.updatedAt < anchor.acceptedAt ||
    typeof anchor.operatorAuthorizationFingerprint !== "string" ||
    anchor.operatorAuthorizationFingerprint.length === 0 ||
    anchor.operatorAuthorizationFingerprint.length > 256 ||
    typeof anchor.cutoverCheckpointHash !== "string" ||
    anchor.cutoverCheckpointHash.length === 0 ||
    anchor.cutoverCheckpointHash.length > 256 ||
    typeof anchor.legacyV2QuiescenceCommitment !== "string" ||
    anchor.legacyV2QuiescenceCommitment.length === 0 ||
    anchor.legacyV2QuiescenceCommitment.length > 256 ||
    !Number.isSafeInteger(anchor.firstV3PermitEpoch) ||
    anchor.firstV3PermitEpoch <= 0 ||
    typeof anchor.firstV3PermitId !== "string" ||
    anchor.firstV3PermitId.length === 0 ||
    anchor.firstV3PermitId.length > 256 ||
    typeof anchor.firstV3PermitHead !== "string" ||
    anchor.firstV3PermitHead.length === 0 ||
    anchor.firstV3PermitHead.length > 256 ||
    typeof anchor.laneTombstoneCheckpointCommitment !== "string" ||
    anchor.laneTombstoneCheckpointCommitment.length === 0 ||
    anchor.laneTombstoneCheckpointCommitment.length > 256 ||
    typeof anchor.laneTombstoneDischargeCheckpointCommitment !== "string" ||
    anchor.laneTombstoneDischargeCheckpointCommitment.length === 0 ||
    anchor.laneTombstoneDischargeCheckpointCommitment.length > 256 ||
    typeof anchor.roomRegistryCheckpointCommitment !== "string" ||
    anchor.roomRegistryCheckpointCommitment.length === 0 ||
    anchor.roomRegistryCheckpointCommitment.length > 256 ||
    typeof anchor.scopeCommitment !== "string" ||
    anchor.scopeCommitment.length === 0 ||
    anchor.scopeCommitment.length > 256 ||
    !Array.isArray(anchor.roomIncarnationHighWater) ||
    anchor.roomIncarnationHighWater.length > 32 ||
    !Array.isArray(anchor.laneLifecycleHighWater) ||
    anchor.laneLifecycleHighWater.length > 112 ||
    typeof anchor.laneLifecycleCommitment !== "string" ||
    anchor.laneLifecycleCommitment.length === 0 ||
    anchor.laneLifecycleCommitment.length > 256 ||
    !isPlainRecord(anchor.ledger) ||
    !hasExactRecordKeys(anchor.ledger as unknown as Record<string, unknown>, [
      "anchorCommitment",
      "blocker",
      "blockerCommitment",
      "canaryAttemptHighWaterCommitment",
      "checkpointHash",
      "confirmedCooldownNotBefore",
      "confirmedCanaryCommitment",
      "coverageStartTick",
      "finalizedAttemptSeq",
      "hashRevision",
      "lifetimeConfirmedCommitment",
      "nextAttemptSeq",
      "outcomeCommitment",
      "pendingAttemptSeq",
      "pendingFrozenEvidenceHash",
      "permitAnchorHash",
      "permitRuntimeAnchor",
      "processedEvidenceKeysCommitment",
      "prunedThroughAttemptSeq",
      "quotaFactCommitment",
      "receiptHeadHash",
      "retiredCanaryCheckpointCommitment",
      "retryNotBefore",
      "schemaVersion",
      "terminalSlotReservationCommitment",
      "walStateCommitment",
    ]) ||
    anchor.ledger.schemaVersion !== 3 ||
    anchor.ledger.hashRevision !==
      "market-base-resource-ledger-runtime-anchor-v1" ||
    !Number.isSafeInteger(anchor.ledger.finalizedAttemptSeq) ||
    anchor.ledger.finalizedAttemptSeq < 0 ||
    !Number.isSafeInteger(anchor.ledger.nextAttemptSeq) ||
    anchor.ledger.nextAttemptSeq <= anchor.ledger.finalizedAttemptSeq ||
    [
      anchor.ledger.anchorCommitment,
      anchor.ledger.blockerCommitment,
      anchor.ledger.receiptHeadHash,
      anchor.ledger.checkpointHash,
      anchor.ledger.permitAnchorHash,
      anchor.ledger.outcomeCommitment,
      anchor.ledger.processedEvidenceKeysCommitment,
      anchor.ledger.terminalSlotReservationCommitment,
      anchor.ledger.quotaFactCommitment,
      anchor.ledger.lifetimeConfirmedCommitment,
      anchor.ledger.confirmedCanaryCommitment,
      anchor.ledger.canaryAttemptHighWaterCommitment,
      anchor.ledger.retiredCanaryCheckpointCommitment,
      anchor.ledger.walStateCommitment,
    ].some(
      (digest) =>
        typeof digest !== "string" ||
        digest.length === 0 ||
        digest.length > 256,
    ) ||
    (anchor.ledger.pendingFrozenEvidenceHash !== null &&
      (typeof anchor.ledger.pendingFrozenEvidenceHash !== "string" ||
        anchor.ledger.pendingFrozenEvidenceHash.length === 0 ||
        anchor.ledger.pendingFrozenEvidenceHash.length > 256)) ||
    (anchor.ledger.pendingAttemptSeq !== null &&
      (!Number.isSafeInteger(anchor.ledger.pendingAttemptSeq) ||
        anchor.ledger.pendingAttemptSeq <= anchor.ledger.finalizedAttemptSeq ||
        anchor.ledger.pendingAttemptSeq >= anchor.ledger.nextAttemptSeq)) ||
    !Number.isSafeInteger(anchor.ledger.prunedThroughAttemptSeq) ||
    anchor.ledger.prunedThroughAttemptSeq < 0 ||
    !Number.isSafeInteger(anchor.ledger.coverageStartTick) ||
    anchor.ledger.coverageStartTick < 0 ||
    !Number.isSafeInteger(anchor.ledger.retryNotBefore) ||
    anchor.ledger.retryNotBefore < 0 ||
    !Number.isSafeInteger(anchor.ledger.confirmedCooldownNotBefore) ||
    anchor.ledger.confirmedCooldownNotBefore < 0 ||
    !isPlainRecord(anchor.ledger.permitRuntimeAnchor) ||
    !hasExactRecordKeys(
      anchor.ledger.permitRuntimeAnchor as unknown as Record<string, unknown>,
      [
        "anchorCommitment",
        "currentAuthorityCommitment",
        "currentPermitId",
        "currentPermitSelfHash",
        "hashRevision",
        "laneTombstoneCheckpointCommitment",
        "permitChainHeadHighWater",
        "permitEpochHighWater",
        "prefixCommitment",
        "ratchetHighWaterCommitment",
        "schemaVersion",
        "totalChainLength",
        "v2CutoverCheckpointHash",
      ],
    ) ||
    (anchor.ledger.pendingFrozenEvidenceHash === null) !==
      (anchor.ledger.pendingAttemptSeq === null) ||
    !Number.isSafeInteger(anchor.pricingRatchetInitializedAt) ||
    anchor.pricingRatchetInitializedAt < 0 ||
    typeof anchor.pricingRatchetBootstrapFingerprint !== "string" ||
    anchor.pricingRatchetBootstrapFingerprint.length === 0 ||
    anchor.pricingRatchetBootstrapFingerprint.length > 256 ||
    !Array.isArray(anchor.pricingRatchetHighWater) ||
    anchor.pricingRatchetHighWater.length !==
      MARKET_BASE_RESOURCE_CATALOG.length ||
    !Array.isArray(anchor.trustedFloorHighWater) ||
    anchor.trustedFloorHighWater.length !==
      MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES.length ||
    [
      anchor.pricingRatchetCommitment,
      anchor.trustedFloorsCommitment,
      anchor.runtimeSafetyCommitment,
    ].some(
      (digest) =>
        typeof digest !== "string" ||
        digest.length === 0 ||
        digest.length > 256,
    ) ||
    (anchor.hardBlocker !== null &&
      (!isPlainRecord(anchor.hardBlocker) ||
        !hasExactRecordKeys(
          anchor.hardBlocker as unknown as Record<string, unknown>,
          ["code", "detectedAt", "detailHash"],
        ) ||
        typeof anchor.hardBlocker.code !== "string" ||
        anchor.hardBlocker.code.length === 0 ||
        anchor.hardBlocker.code.length > 160 ||
        !Number.isSafeInteger(anchor.hardBlocker.detectedAt) ||
        anchor.hardBlocker.detectedAt < 0 ||
        typeof anchor.hardBlocker.detailHash !== "string" ||
        anchor.hardBlocker.detailHash.length === 0 ||
        anchor.hardBlocker.detailHash.length > 256)) ||
    (anchor.activationBlocker !== null &&
      !validateMarketBaseResourceActivationBlocker(anchor.activationBlocker)) ||
    typeof anchor.anchorHash !== "string" ||
    anchor.anchorHash.length === 0 ||
    anchor.anchorHash.length > 256
  ) {
    return false;
  }
  const roomNames = new Set<string>();
  for (
    let index = 0;
    index < anchor.roomIncarnationHighWater.length;
    index += 1
  ) {
    const entry = anchor.roomIncarnationHighWater[index];
    if (
      !entry ||
      typeof entry.roomName !== "string" ||
      entry.roomName.length === 0 ||
      entry.roomName.length > 64 ||
      roomNames.has(entry.roomName) ||
      (index > 0 &&
        anchor.roomIncarnationHighWater[index - 1]!.roomName.localeCompare(
          entry.roomName,
        ) >= 0) ||
      !Number.isSafeInteger(entry.incarnationHighWater) ||
      entry.incarnationHighWater <= 0 ||
      typeof entry.lastInstanceId !== "string" ||
      entry.lastInstanceId.length === 0 ||
      entry.lastInstanceId.length > 256 ||
      typeof entry.admitted !== "boolean"
    ) {
      return false;
    }
    roomNames.add(entry.roomName);
  }
  const laneIds = new Set<string>();
  for (
    let index = 0;
    index < anchor.laneLifecycleHighWater.length;
    index += 1
  ) {
    const entry = anchor.laneLifecycleHighWater[index];
    if (
      !entry ||
      typeof entry.laneId !== "string" ||
      entry.laneId.length === 0 ||
      entry.laneId.length > 256 ||
      laneIds.has(entry.laneId) ||
      (index > 0 &&
        anchor.laneLifecycleHighWater[index - 1]!.laneId.localeCompare(
          entry.laneId,
        ) >= 0) ||
      typeof entry.stableFingerprint !== "string" ||
      entry.stableFingerprint.length === 0 ||
      entry.stableFingerprint.length > 256 ||
      ![
        "shadow",
        "qualified",
        "canary",
        "review_paused",
        "continuous",
      ].includes(entry.stage) ||
      !["suspended", "writable", "tombstoned"].includes(entry.status) ||
      !Number.isSafeInteger(entry.completeCycles) ||
      entry.completeCycles < 0 ||
      (entry.lastCompleteTick !== undefined &&
        (!Number.isSafeInteger(entry.lastCompleteTick) ||
          entry.lastCompleteTick < 0)) ||
      (entry.evidenceDigest !== undefined &&
        (typeof entry.evidenceDigest !== "string" ||
          entry.evidenceDigest.length === 0 ||
          entry.evidenceDigest.length > 256))
    ) {
      return false;
    }
    laneIds.add(entry.laneId);
  }
  for (
    let index = 0;
    index < MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES.length;
    index += 1
  ) {
    const resource = MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES[index];
    const trusted = anchor.trustedFloorHighWater[index];
    if (
      !trusted ||
      trusted.resource !== resource ||
      !Number.isFinite(trusted.value) ||
      trusted.value <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(trusted.marketDate) ||
      !Number.isSafeInteger(trusted.updatedAt) ||
      trusted.updatedAt < 0
    ) {
      return false;
    }
  }
  for (let index = 0; index < MARKET_BASE_RESOURCE_CATALOG.length; index += 1) {
    const resource = MARKET_BASE_RESOURCE_CATALOG[index];
    const pricing = anchor.pricingRatchetHighWater[index];
    const trusted = anchor.trustedFloorHighWater.find(
      (entry) => entry.resource === resource,
    );
    if (
      !pricing ||
      pricing.resource !== resource ||
      !trusted ||
      !Number.isFinite(pricing.value) ||
      pricing.value <= 0 ||
      trusted.value < pricing.value ||
      !/^\d{4}-\d{2}-\d{2}$/.test(pricing.marketDate) ||
      trusted.marketDate < pricing.marketDate
    ) {
      return false;
    }
  }
  if (
    anchor.pricingRatchetCommitment !==
      canonicalStableHashV1({
        domain: "market-base-resource:outer-pricing-ratchet-v1",
        initializedAt: anchor.pricingRatchetInitializedAt,
        bootstrapFingerprint: anchor.pricingRatchetBootstrapFingerprint,
        entries: anchor.pricingRatchetHighWater,
      }) ||
    anchor.trustedFloorsCommitment !==
      canonicalStableHashV1({
        domain: "market-base-resource:outer-trusted-floors-v1",
        entries: anchor.trustedFloorHighWater,
      }) ||
    anchor.runtimeSafetyCommitment !==
      canonicalStableHashV1({
        domain: "market-base-resource:outer-runtime-safety-v1",
        ledger: anchor.ledger,
        pricingRatchetCommitment: anchor.pricingRatchetCommitment,
        trustedFloorsCommitment: anchor.trustedFloorsCommitment,
        hardBlocker: anchor.hardBlocker,
      })
  ) {
    return false;
  }
  return (
    anchor.anchorHash ===
    marketBaseResourceActivationAnchorSelfHash(
      anchor as unknown as Record<string, unknown>,
    )
  );
}

function validateMarketBaseResourceActivationAnchorMirror(
  value: unknown,
  primary: MarketBaseResourceActivationAnchor,
): value is MarketBaseResourceActivationAnchor {
  if (!isPlainRecord(value) || value.anchorHash !== primary.anchorHash) {
    return false;
  }
  // primary 已完成全部 shape/derived-commitment 校验；mirror 只需证明其
  // 完整 payload 的 self-hash 与 primary 相同。这样仍能检测任意额外、缺失
  // 或 bitflip 字段，但不再对同一 112-lane anchor 重算三组派生 commitment。
  return (
    typeof value.anchorHash === "string" &&
    value.anchorHash ===
      marketBaseResourceActivationAnchorSelfHash(value)
  );
}

function sameMarketBaseResourceActivationAnchor(
  left: MarketBaseResourceActivationAnchor,
  right: MarketBaseResourceActivationAnchor,
): boolean {
  // 两侧都必须先通过 self-hash validator；相同 anchorHash 已经承诺全部
  // payload，没必要再把两份大 anchor 各遍历一次。
  return left.anchorHash === right.anchorHash;
}

const marketBaseOuterDeepFrozenValues = new WeakSet<object>();

function freezeMarketBaseOuterCanonicalValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const object = value as object;
    if (marketBaseOuterDeepFrozenValues.has(object)) return value;
    marketBaseOuterDeepFrozenValues.add(object);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeMarketBaseOuterCanonicalValue(nested);
    }
    if (!Object.isFrozen(object)) Object.freeze(object);
  }
  return value;
}

function validateMarketBaseResourceActivationBlocker(
  value: unknown,
): value is MarketBaseResourceActivationBlocker {
  if (!isPlainRecord(value)) return false;
  const blocker = value as unknown as MarketBaseResourceActivationBlocker;
  return (
    blocker.schemaVersion === 1 &&
    blocker.hashRevision === MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION &&
    typeof blocker.code === "string" &&
    blocker.code.length > 0 &&
    blocker.code.length <= 160 &&
    Number.isSafeInteger(blocker.detectedAt) &&
    blocker.detectedAt >= 0 &&
    typeof blocker.detailHash === "string" &&
    blocker.detailHash.length > 0 &&
    blocker.detailHash.length <= 256
  );
}

function marketBaseNestedCutoverEvidence(
  state: MarketBaseResourceV3RuntimeState | undefined,
): boolean {
  return Boolean(
    state?.cutoverLatched === true ||
    state?.permitChain?.legacyV2GrantSuspended === true ||
    state?.permitChain?.v2EventCutoverCheckpoint ||
    state?.permitChain?.retainedPermits?.some(
      (record) => record.schemaVersion === 3,
    ),
  );
}

function marketBaseResourceActivationState(
  data: MarketSaleDataState,
  nested: MarketBaseResourceV3RuntimeState | undefined,
):
  | { latched: false }
  | {
      latched: true;
      anchor?: MarketBaseResourceActivationAnchor;
      blocker?: string;
    } {
  const persistent = data.baseResourceV3ActivationBlocker;
  const primary = data.baseResourceV3ActivationAnchor;
  const mirror = data.baseResourceV3ActivationAnchorMirror;
  // Memory/JSON root 在进入验证前先递归冻结，关闭 validate→use mutation
  // 窗口，并允许 canonical hash 对同一不可变 anchor 安全复用结果。
  freezeMarketBaseOuterCanonicalValue(primary);
  freezeMarketBaseOuterCanonicalValue(mirror);
  if (!primary && !mirror) {
    if (persistent !== undefined) {
      return {
        latched: true,
        blocker: validateMarketBaseResourceActivationBlocker(persistent)
          ? persistent.code
          : "market_base_activation_blocker_invalid",
      };
    }
    return marketBaseNestedCutoverEvidence(nested)
      ? {
          latched: true,
          blocker: "market_base_activation_anchor_missing_after_cutover",
        }
      : { latched: false };
  }
  if (
    !validateMarketBaseResourceActivationAnchor(primary) ||
    !validateMarketBaseResourceActivationAnchorMirror(mirror, primary)
  ) {
    return {
      latched: true,
      blocker: "market_base_activation_anchor_invalid",
    };
  }
  if (!sameMarketBaseResourceActivationAnchor(primary, mirror)) {
    return {
      latched: true,
      blocker: "market_base_activation_anchor_copy_mismatch",
    };
  }
  const anchoredBlocker = primary.activationBlocker;
  if (anchoredBlocker !== null) {
    if (!validateMarketBaseResourceActivationBlocker(persistent)) {
      return {
        latched: true,
        blocker:
          persistent === undefined
            ? "market_base_activation_blocker_missing"
            : "market_base_activation_blocker_invalid",
      };
    }
    if (
      canonicalStableHashV1(persistent) !==
      canonicalStableHashV1(anchoredBlocker)
    ) {
      return {
        latched: true,
        blocker: "market_base_activation_blocker_copy_mismatch",
      };
    }
    return {
      latched: true,
      blocker: anchoredBlocker.code,
    };
  }
  if (persistent !== undefined) {
    return {
      latched: true,
      blocker: validateMarketBaseResourceActivationBlocker(persistent)
        ? "market_base_activation_blocker_anchor_missing"
        : "market_base_activation_blocker_invalid",
    };
  }
  return {
    latched: true,
    anchor: primary,
  };
}

function persistMarketBaseResourceActivationBlocker(
  data: MarketSaleDataState,
  code: string,
  evidence: unknown,
): void {
  const primary = data.baseResourceV3ActivationAnchor;
  const mirror = data.baseResourceV3ActivationAnchorMirror;
  const validPrimary = validateMarketBaseResourceActivationAnchor(primary);
  const validMirror = validateMarketBaseResourceActivationAnchor(mirror);
  const persistent = validateMarketBaseResourceActivationBlocker(
    data.baseResourceV3ActivationBlocker,
  )
    ? data.baseResourceV3ActivationBlocker
    : undefined;
  const exactPersistentBlocker = (
    anchor: MarketBaseResourceActivationAnchor | undefined,
  ): boolean =>
    Boolean(
      anchor?.activationBlocker &&
      persistent &&
      canonicalStableHashV1(anchor.activationBlocker) ===
        canonicalStableHashV1(persistent),
    );
  let anchorSource: MarketBaseResourceActivationAnchor | undefined;
  if (
    validPrimary &&
    validMirror &&
    sameMarketBaseResourceActivationAnchor(primary, mirror)
  ) {
    anchorSource = primary;
  } else if (validPrimary && !validMirror) {
    anchorSource = primary;
  } else if (validMirror && !validPrimary) {
    anchorSource = mirror;
  } else if (validPrimary && validMirror) {
    if (exactPersistentBlocker(primary) && !exactPersistentBlocker(mirror)) {
      anchorSource = primary;
    } else if (
      exactPersistentBlocker(mirror) &&
      !exactPersistentBlocker(primary)
    ) {
      anchorSource = mirror;
    } else if (
      primary.activationBlocker !== null &&
      mirror.activationBlocker === null
    ) {
      anchorSource = primary;
    } else if (
      mirror.activationBlocker !== null &&
      primary.activationBlocker === null
    ) {
      anchorSource = mirror;
    }
  }
  const blocker =
    anchorSource?.activationBlocker !== null &&
    anchorSource?.activationBlocker !== undefined
      ? cloneMarketBaseOperatorValue(anchorSource.activationBlocker)
      : persistent
        ? cloneMarketBaseOperatorValue(persistent)
        : {
            schemaVersion: 1 as const,
            hashRevision: MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION,
            code,
            detectedAt: Game.time,
            detailHash: canonicalStableHashV1({
              domain: "market-base-resource:activation-blocker-v1",
              code,
              evidence,
            }),
          };
  data.baseResourceV3ActivationBlocker = blocker;
  if (!anchorSource) return;
  const payload: MarketBaseResourceActivationAnchorPayload = {
    ...anchorSource,
    updatedAt: Math.max(anchorSource.updatedAt, Game.time),
    activationBlocker: blocker,
  };
  delete (
    payload as MarketBaseResourceActivationAnchorPayload & {
      anchorHash?: string;
    }
  ).anchorHash;
  const latchedAnchor: MarketBaseResourceActivationAnchor = {
    ...payload,
    anchorHash: marketBaseResourceActivationAnchorHash(payload),
  };
  data.baseResourceV3ActivationAnchor = latchedAnchor;
  data.baseResourceV3ActivationAnchorMirror =
    cloneMarketBaseOperatorValue(latchedAnchor);
}

function marketBaseStableLifecycleReason(
  lane: MarketBaseDerivedLaneLifecycle,
): string | undefined {
  const reason = validateMarketBaseDerivedLaneLifecycle(lane);
  return reason
    ? `market_base_lifecycle_evidence_invalid:${lane.laneId}:${reason}`
    : undefined;
}

function marketBaseStableScopeProjection(
  scope: MarketBaseResourceScopeState | undefined,
  lifecycleLaneIds: readonly string[] = [],
): unknown {
  if (!scope) return null;
  const lifecycleLaneSet = new Set(lifecycleLaneIds);
  return {
    schemaVersion: scope.schemaVersion,
    accountIdentity: scope.accountIdentity,
    sharedPolicyFingerprint: scope.sharedPolicyFingerprint,
    rosterFingerprint: scope.rosterFingerprint,
    laneSetFingerprint: scope.laneSetFingerprint,
    roomRegistry: {
      admissionPolicyFingerprint: scope.roomRegistry.admissionPolicyFingerprint,
      knownRoomNames: scope.roomRegistry.knownRoomNames,
      rooms: scope.roomRegistry.knownRoomNames.map((roomName) => {
        const room = scope.roomRegistry.rooms[roomName];
        return room
          ? {
              roomName,
              incarnationHighWater: room.incarnationHighWater,
              lastInstanceId: room.lastInstanceId,
              admitted: room.admitted,
              current: room.current
                ? {
                    roomInstanceId: room.current.roomInstanceId,
                    incarnation: room.current.incarnation,
                    previousInstanceId: room.current.previousInstanceId,
                    fingerprint: room.current.fingerprint,
                  }
                : null,
            }
          : null;
      }),
      recentTombstones: scope.roomRegistry.recentTombstones
        .map((room) => ({
          roomName: room.roomName,
          roomInstanceId: room.roomInstanceId,
          incarnation: room.incarnation,
          previousInstanceId: room.previousInstanceId,
          fingerprint: room.fingerprint,
        }))
        .sort((left, right) =>
          left.roomInstanceId.localeCompare(right.roomInstanceId),
        ),
    },
    lanes: scope.laneLifecycles
      .map((lane) => ({
        laneId: lane.laneId,
        stableFingerprint: lane.stableFingerprint,
        roomInstanceId: lane.roomInstanceId,
        resource: lane.resource,
        ...(lifecycleLaneSet.has(lane.laneId)
          ? {
              stage: lane.stage,
              status: lane.status,
              shadowEvidence: lane.shadowEvidence,
            }
          : {}),
      }))
      .sort((left, right) => left.laneId.localeCompare(right.laneId)),
    recentLaneTombstones: scope.recentLaneTombstones
      .map(({ retiredAt: _retiredAt, ...lane }) => lane)
      .sort((left, right) => left.laneId.localeCompare(right.laneId)),
  };
}

function marketBaseStableScopeIdentityUnchanged(
  previous: MarketBaseResourceScopeState | undefined,
  next: MarketBaseResourceScopeState,
): boolean {
  if (!previous) return false;
  const sameEntries = <T>(left: readonly T[], right: readonly T[]): boolean =>
    left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
  if (
    previous.accountIdentity !== next.accountIdentity ||
    previous.sharedPolicyFingerprint !== next.sharedPolicyFingerprint ||
    previous.rosterFingerprint !== next.rosterFingerprint ||
    previous.laneSetFingerprint !== next.laneSetFingerprint ||
    !sameEntries(previous.sellerRooms, next.sellerRooms) ||
    !sameEntries(previous.laneLifecycles, next.laneLifecycles) ||
    !sameEntries(previous.recentLaneTombstones, next.recentLaneTombstones) ||
    !sameEntries(
      previous.roomRegistry.knownRoomNames,
      next.roomRegistry.knownRoomNames,
    ) ||
    !sameEntries(
      previous.roomRegistry.recentTombstones,
      next.roomRegistry.recentTombstones,
    )
  ) {
    return false;
  }
  return previous.roomRegistry.knownRoomNames.every(
    (roomName) =>
      previous.roomRegistry.rooms[roomName] ===
      next.roomRegistry.rooms[roomName],
  );
}

function validateMarketBaseScopeLifecycleEvidence(
  scope: MarketBaseResourceScopeState,
): string | undefined {
  for (const lane of scope.laneLifecycles) {
    const reason = marketBaseStableLifecycleReason(lane);
    if (reason) return reason;
  }
  return undefined;
}

function validateMarketBaseNestedActivationState(
  state: MarketBaseResourceV3RuntimeState | undefined,
  anchor: MarketBaseResourceActivationAnchor,
  trustedFloors: MarketSaleDataState["trustedFloors"],
  options: {
    allowTrustedFloorAdvance?: boolean;
    runtimeOnly?: boolean;
    runtimeCapability?: MarketBaseResourceReadinessRuntimeCapability;
  } = {},
): string | undefined {
  try {
    return validateMarketBaseNestedActivationStateUnchecked(
      state,
      anchor,
      trustedFloors,
      options,
    );
  } catch {
    return "market_base_nested_state_shape_invalid_after_cutover";
  }
}

function validateMarketBaseNestedActivationStateUnchecked(
  state: MarketBaseResourceV3RuntimeState | undefined,
  anchor: MarketBaseResourceActivationAnchor,
  trustedFloors: MarketSaleDataState["trustedFloors"],
  options: {
    allowTrustedFloorAdvance?: boolean;
    runtimeOnly?: boolean;
    runtimeCapability?: MarketBaseResourceReadinessRuntimeCapability;
  } = {},
): string | undefined {
  if (
    !state ||
    state.schemaVersion !== 3 ||
    state.cutoverLatched !== true ||
    !state.permitChain ||
    !state.ledger ||
    !state.scope
  ) {
    return "market_base_nested_state_missing_after_cutover";
  }
  if (options.runtimeOnly !== true) {
    const chainValidation = validateMarketBaseResourcePermitChain(
      state.permitChain,
    );
    const ledgerValidation = validateMarketBaseResourceLedger(
      state.ledger,
      Game.time,
      state.permitChain,
    );
    const ledgerAnchorValidation =
      validateMarketBaseResourcePermitChainDominatesAnchor(
        state.permitChain,
        state.ledger.permitAnchor,
      );
    if (
      !chainValidation.ok ||
      !ledgerValidation.ok ||
      !ledgerAnchorValidation.ok ||
      !hasAcceptedMarketBaseResourceV3Successor(state.permitChain)
    ) {
      return (
        chainValidation.reason ||
        ledgerValidation.reason ||
        ledgerAnchorValidation.reason ||
        "market_base_nested_state_invalid_after_cutover"
      );
    }
  }
  let runtimeSafety:
    ReturnType<typeof marketBaseResourceRuntimeSafetyProjection> | undefined;
  const runtimeCapabilityValid =
    validateMarketBaseResourceReadinessRuntimeCapability(
      options.runtimeCapability,
      state,
      Game.time,
      anchor.ledger,
    );
  if (!runtimeCapabilityValid) {
    const ledgerRuntimeGate = validateMarketBaseResourceLedgerRuntimeGate(
      state.ledger,
      state.permitChain,
      anchor.ledger,
      Game.time,
    );
    if (!ledgerRuntimeGate.ok) {
      return (
        ledgerRuntimeGate.reason || "market_base_ledger_runtime_anchor_rollback"
      );
    }
  }
  try {
    runtimeSafety = marketBaseResourceRuntimeSafetyProjection(
      state,
      trustedFloors,
      anchor.ledger,
    );
  } catch {
    return "market_base_runtime_safety_state_invalid";
  }
  if (
    canonicalStableHashV1(runtimeSafety.ledger) !==
    canonicalStableHashV1(anchor.ledger)
  ) {
    return "market_base_ledger_runtime_anchor_rollback";
  }
  if (
    runtimeSafety.pricingRatchetCommitment !==
      anchor.pricingRatchetCommitment ||
    canonicalStableHashV1(runtimeSafety.pricingRatchetHighWater) !==
      canonicalStableHashV1(anchor.pricingRatchetHighWater)
  ) {
    return "market_base_pricing_ratchet_anchor_rollback";
  }
  if (
    canonicalStableHashV1(runtimeSafety.hardBlocker) !==
    canonicalStableHashV1(anchor.hardBlocker)
  ) {
    return "market_base_hard_blocker_anchor_rollback";
  }
  const trustedExact =
    runtimeSafety.trustedFloorsCommitment === anchor.trustedFloorsCommitment &&
    canonicalStableHashV1(runtimeSafety.trustedFloorHighWater) ===
      canonicalStableHashV1(anchor.trustedFloorHighWater);
  const trustedAdvance =
    options.allowTrustedFloorAdvance === true &&
    runtimeSafety.trustedFloorHighWater.every((entry) => {
      const prior = anchor.trustedFloorHighWater.find(
        (candidate) => candidate.resource === entry.resource,
      );
      return (
        prior?.resource === entry.resource &&
        entry.value >= prior.value &&
        entry.marketDate >= prior.marketDate &&
        entry.updatedAt >= prior.updatedAt
      );
    });
  if (
    (!trustedExact && !trustedAdvance) ||
    (trustedExact &&
      runtimeSafety.runtimeSafetyCommitment !== anchor.runtimeSafetyCommitment)
  ) {
    return "market_base_trusted_floor_anchor_rollback";
  }
  const currentPermit = currentMarketBaseV3Permit(state);
  if (
    !currentPermit ||
    currentPermit.accountIdentity !== anchor.accountIdentity ||
    currentPermit.executorShard !== anchor.executorShard ||
    state.permitChain.legacyV2GrantSuspended !== true ||
    state.permitChain.v2EventCutoverCheckpoint?.checkpointHash !==
      anchor.cutoverCheckpointHash ||
    state.permitChain.laneTombstoneCheckpoint.checkpointCommitment !==
      anchor.laneTombstoneCheckpointCommitment ||
    state.scope.laneTombstoneDischargeCheckpoint.checkpointCommitment !==
      anchor.laneTombstoneDischargeCheckpointCommitment ||
    state.permitChain.permitEpochHighWater < anchor.firstV3PermitEpoch ||
    state.scope.accountIdentity !== anchor.accountIdentity
  ) {
    return "market_base_nested_state_anchor_mismatch";
  }
  if (
    state.scope.roomRegistry.checkpointCommitment !==
    anchor.roomRegistryCheckpointCommitment
  ) {
    return "market_base_room_registry_checkpoint_rollback";
  }
  if (
    marketBaseResourceOuterScopeCommitment(state.scope) !==
      anchor.scopeCommitment
  ) {
    return "market_base_scope_commitment_rollback";
  }
  if (
    state.permitChain.prefixCheckpoint.prunedThroughEpoch <
    anchor.firstV3PermitEpoch
  ) {
    const first = state.permitChain.retainedPermits.find(
      (record) =>
        record.schemaVersion === 3 &&
        record.epoch === anchor.firstV3PermitEpoch,
    );
    if (
      !first ||
      first.schemaVersion !== 3 ||
      first.permitId !== anchor.firstV3PermitId ||
      first.permitHead !== anchor.firstV3PermitHead
    ) {
      return "market_base_first_v3_permit_anchor_mismatch";
    }
  }
  const expectedHighWater = marketBaseResourceRoomIncarnationHighWater(
    state.scope,
  );
  if (
    !sameMarketBaseResourceRoomIncarnationHighWater(
      expectedHighWater,
      anchor.roomIncarnationHighWater,
    )
  ) {
    return "market_base_room_incarnation_high_water_rollback";
  }
  const expectedLaneHighWater = marketBaseResourceLaneLifecycleHighWater(
    state.scope,
  );
  if (
    !sameMarketBaseResourceLaneLifecycleHighWater(
      expectedLaneHighWater,
      anchor.laneLifecycleHighWater,
    )
  ) {
    return "market_base_lane_lifecycle_high_water_rollback";
  }
  if (options.runtimeOnly === true && runtimeCapabilityValid) {
    // Opaque capability 已完成当前 scope 的语义认证并逐字绑定 outer scope
    // commitment；上面的直接比较仍保留 room/lane high-water 防回拨，热/冷
    // 写门禁只省去重复 lifecycle commitment hash 与语义扫描。
    return undefined;
  }
  if (
    marketBaseResourceLaneLifecycleCommitment(state.scope) !==
    anchor.laneLifecycleCommitment
  ) {
    return "market_base_lane_lifecycle_high_water_rollback";
  }
  return validateMarketBaseScopeLifecycleEvidence(state.scope);
}

function blockedMarketBaseRuntimeState(
  existing: MarketBaseResourceV3RuntimeState | undefined,
  context: RunContext,
  blocker: string,
): MarketBaseResourceV3RuntimeState {
  const base = existing
    ? { ...existing }
    : reconcileMarketBaseResourcePreflight(undefined, {
        tick: Game.time,
        mode: context.config.mode,
        config: context.config,
      }).state;
  base.cutoverLatched = true;
  base.blocker = blocker;
  delete base.readinessAuthorization;
  return base;
}

function reconcileBaseResourceV3State(context: RunContext): {
  activeV3Successor: boolean;
  state?: MarketBaseResourceV3RuntimeState;
  ledgerRuntimeAnchor?: MarketBaseResourceLedgerRuntimeAnchor;
  readinessRuntimeCapability?: MarketBaseResourceReadinessRuntimeCapability;
} {
  const sourceDirect = context.data.directAutomation;
  if (
    hasRegisteredMarketBaseResourceCanonicalRootThisTick() &&
    !isRegisteredMarketBaseResourceCanonicalRootThisTick(context.data)
  ) {
    const existingState = isContinuousDirectState(sourceDirect)
      ? (sourceDirect.baseResourceV3 as
          MarketBaseResourceV3RuntimeState | undefined)
      : undefined;
    const blocker = "market_base_v3_same_tick_root_replaced";
    reject(context, blocker);
    return {
      activeV3Successor: true,
      state: blockedMarketBaseRuntimeState(existingState, context, blocker),
    };
  }
  if (!isContinuousDirectState(sourceDirect)) {
    return { activeV3Successor: false };
  }
  const existing = sourceDirect.baseResourceV3 as
    MarketBaseResourceV3RuntimeState | undefined;
  const canonical = marketBaseResourceCanonicalRootProvenance.get(context.data);
  if (
    canonical?.tick === Game.time &&
    context.config.mode === "direct" &&
    context.config.directCapability === "continuous-v3" &&
    marketBaseResourceV3ConfigMismatchReasons(context.config).length === 0 &&
    canonical.directAutomation === sourceDirect &&
    canonical.state === existing &&
    context.data.baseResourceV3ActivationAnchor ===
      canonical.activationAnchor &&
    context.data.baseResourceV3ActivationAnchorMirror ===
      canonical.activationAnchorMirror &&
    context.data.trustedFloors === canonical.trustedFloors &&
    context.data.baseResourceV3ActivationBlocker === undefined &&
    context.data.pendingDirectDeals === sourceDirect.pendingDirectDeals &&
    existing?.preflightAt === Game.time &&
    existing.scope?.updatedAt === Game.time &&
    existing.cutoverLatched === true &&
    existing.blocker === undefined &&
    existing.hardBlocker === undefined &&
    Object.isFrozen(sourceDirect) &&
    Object.isFrozen(existing) &&
    Object.isFrozen(canonical.activationAnchor) &&
    Object.isFrozen(canonical.activationAnchorMirror) &&
    Object.isFrozen(canonical.trustedFloors) &&
    (!existing.readinessAuthorization ||
      (existing.readinessAuthorization.updatedAt === Game.time &&
        existing.readinessAuthorization.expiresAt === Game.time + 1))
  ) {
    return {
      activeV3Successor: true,
      state: existing,
      ledgerRuntimeAnchor: canonical.ledgerRuntimeAnchor,
      readinessRuntimeCapability: canonical.runtimeCapability,
    };
  }
  const activation = marketBaseResourceActivationState(context.data, existing);
  const failClosed = (
    blocker: string,
    evidence: unknown,
  ): {
    activeV3Successor: true;
    state: MarketBaseResourceV3RuntimeState;
  } => {
    const nextDirect = {
      ...sourceDirect,
    };
    const nextData: MarketSaleDataState = {
      ...context.data,
      directAutomation: nextDirect,
    };
    persistMarketBaseResourceActivationBlocker(nextData, blocker, evidence);
    const blocked = blockedMarketBaseRuntimeState(
      nextDirect.baseResourceV3,
      context,
      nextData.baseResourceV3ActivationBlocker?.code || blocker,
    );
    nextDirect.baseResourceV3 = blocked;
    nextData.pendingDirectDeals = nextDirect.pendingDirectDeals;
    commitContextMarketSaleData(context, nextData);
    reject(context, nextData.baseResourceV3ActivationBlocker?.code || blocker);
    return {
      activeV3Successor: true,
      state: blocked,
    };
  };
  if (activation.latched && activation.blocker) {
    return failClosed(activation.blocker, {
      primary: context.data.baseResourceV3ActivationAnchor ?? null,
      mirror: context.data.baseResourceV3ActivationAnchorMirror ?? null,
      nestedCutover: marketBaseNestedCutoverEvidence(existing),
    });
  }
  if (activation.latched && activation.anchor) {
    const configRollback =
      context.config.directCapability !== "continuous-v3" ||
      marketBaseResourceV3ConfigMismatchReasons(context.config).length > 0;
    if (configRollback) {
      return failClosed("market_base_v3_config_rollback_after_cutover", {
        directCapability: context.config.directCapability,
        configRevision: context.config.configRevision,
        reasons: marketBaseResourceV3ConfigMismatchReasons(context.config),
      });
    }
    const legacyV2Blocker = validatePostCutoverLegacyV2Quiescence(
      context.data,
      sourceDirect,
      existing!,
      activation.anchor,
    );
    if (legacyV2Blocker) {
      return failClosed(legacyV2Blocker, {
        cutoverCheckpointHash: activation.anchor.cutoverCheckpointHash,
        legacyV2QuiescenceCommitment:
          activation.anchor.legacyV2QuiescenceCommitment,
      });
    }
    if (!existing) {
      return failClosed("market_base_nested_state_missing_after_cutover", null);
    }
    let working = { ...existing };
    let workingLedgerRuntimeAnchor = activation.anchor.ledger;
    const capabilityFromCanonicalRoot =
      advanceMarketBaseResourceReadinessRuntimeCapabilityFromRoot(
        context.data,
        working,
        Game.time,
      );
    let workingReadinessRuntimeCapability =
      capabilityFromCanonicalRoot ??
      createMarketBaseResourceReadinessRuntimeCapability(
        working,
        Game.time,
        activation.anchor.ledger,
        activation.anchor.scopeCommitment,
    );
    if (!workingReadinessRuntimeCapability) {
      const presentedRoomRegistryCheckpoint =
        isPlainRecord(working.scope) &&
        isPlainRecord(working.scope.roomRegistry) &&
        typeof working.scope.roomRegistry.checkpointCommitment === "string"
          ? working.scope.roomRegistry.checkpointCommitment
          : undefined;
      const capabilityBlocker =
        presentedRoomRegistryCheckpoint !== undefined &&
        presentedRoomRegistryCheckpoint !==
          activation.anchor.roomRegistryCheckpointCommitment
          ? "market_base_room_registry_checkpoint_rollback"
          : "market_base_v3_runtime_capability_open_failed";
      return failClosed(capabilityBlocker, {
        state: working,
        anchor: activation.anchor,
      });
    }
    const nestedBlocker = validateMarketBaseNestedActivationState(
      working,
      activation.anchor,
      context.data.trustedFloors,
      {
        allowTrustedFloorAdvance: true,
        runtimeOnly: true,
        runtimeCapability: workingReadinessRuntimeCapability,
      },
    );
    if (nestedBlocker) {
      return failClosed(nestedBlocker, working);
    }
    if (!capabilityFromCanonicalRoot && working.preflightAt === Game.time) {
      // 本 tick 已完成 preflight 的 root 若失去私有 canonical provenance，
      // 只能视为同 tick replacement/global-reset。即使持久字段自洽，也不
      // 能在 RC 之后重新铸权并成交；下一 tick 正常 preflight 可恢复。
      reject(context, "market_base_v3_same_tick_root_provenance_missing");
      return {
        activeV3Successor: true,
        state: working,
        ledgerRuntimeAnchor: activation.anchor.ledger,
      };
    }
    // global reset/cache miss 时即使 preflightAt 已是本 tick，也必须复走
    // frozen WAL preflight；但复用刚铸造的 opaque session，不能再扫 ring。
    if (working.preflightAt !== Game.time) {
      const preflightLedger = working.ledger;
      const preflightPermitChain = working.permitChain;
      const preflight = runMarketBaseResourcePreflight(
        working,
        Game.time,
        {
          ...defaultMarketBaseResourceRuntimeDependencies,
          readLedgerRuntimeAnchor: (preflightState) =>
            preflightState.ledger === preflightLedger &&
            preflightState.permitChain === preflightPermitChain
              ? activation.anchor!.ledger
              : undefined,
        },
        workingReadinessRuntimeCapability,
      );
      working = preflight.state;
      workingLedgerRuntimeAnchor =
        preflight.ledgerRuntimeAnchor ?? workingLedgerRuntimeAnchor;
      workingReadinessRuntimeCapability = preflight.readinessRuntimeCapability;
      mergeDirectResult(context, preflight);
      if (
        preflight.state.blocker ||
        !workingReadinessRuntimeCapability ||
        !preflight.ledgerRuntimeAnchor
      ) {
        return failClosed(
          preflight.state.blocker ||
            "market_base_v3_runtime_capability_preflight_failed",
          preflight.state,
        );
      }
    }
    const accountIdentity = readLiveMarketBaseAccountIdentity();
    if (!accountIdentity) {
      const blocked = blockedMarketBaseRuntimeState(
        existing,
        context,
        "market_base_account_identity_incomplete",
      );
      const nextData = {
        ...context.data,
        directAutomation: {
          ...sourceDirect,
          baseResourceV3: blocked,
        },
      };
      commitContextMarketSaleData(context, nextData);
      reject(context, "market_base_account_identity_incomplete");
      return {
        activeV3Successor: true,
        state: blocked,
      };
    }
    if (!workingLedgerRuntimeAnchor) {
      return failClosed("market_base_v3_runtime_anchor_missing", {
        state: working,
      });
    }
    /**
     * frozen WAL 必须先收敛：confirmed canary 会在这里把 canary 原子推进到
     * review_paused。随后才以该 working.scope 作为 live room reconcile 的
     * previous，否则拿 preflight 前的 lifecycle 比较会把合法终态误判为
     * scope rollback 并永久闭锁 activation。
     */
    const expectedScope =
      reconcileLiveMarketBaseResourceScopeWithRuntimeCapability(
        {
          tick: Game.time,
          accountIdentity,
          observations: collectLiveMarketBaseRoomObservations(accountIdentity),
          previous: working.scope,
          permitChain: working.permitChain,
          pinnedLaneIds: working.ledger?.pending
            ? [working.ledger.pending.historicalLane.laneId]
            : [],
          expectedPreviousRoomCheckpointCommitment:
            activation.anchor.roomRegistryCheckpointCommitment,
          expectedPermitLaneTombstoneCheckpointCommitment:
            activation.anchor.laneTombstoneCheckpointCommitment,
          expectedPreviousLaneTombstoneDischargeCheckpointCommitment:
            activation.anchor.laneTombstoneDischargeCheckpointCommitment,
        },
        working,
        workingReadinessRuntimeCapability,
      );
    if ("blockers" in expectedScope) {
      return failClosed(
        expectedScope.blockers[0] || "market_base_scope_reconcile_failed",
        {
          anchor: activation.anchor,
          scope: working.scope,
        },
      );
    }
    const lifecycleBlocker =
      expectedScope.stableIdentityUnchanged === true
        ? undefined
        : validateMarketBaseScopeLifecycleEvidence(expectedScope.state);
    if (lifecycleBlocker) {
      return failClosed(lifecycleBlocker, expectedScope.state);
    }
    const lifecycleLaneIds =
      working.scope?.laneLifecycles.map((lane) => lane.laneId) ?? [];
    const stableScopeUnchanged =
      (expectedScope.stableIdentityUnchanged === true ||
        marketBaseStableScopeIdentityUnchanged(
          working.scope,
          expectedScope.state,
        ) ||
        canonicalStableHashV1(
          marketBaseStableScopeProjection(working.scope, lifecycleLaneIds),
        ) ===
          canonicalStableHashV1(
            marketBaseStableScopeProjection(
              expectedScope.state,
              lifecycleLaneIds,
            ),
          )) &&
      working.scope?.roomRegistry.tombstonePrefixCheckpoint
        .checkpointCommitment ===
        expectedScope.state.roomRegistry.tombstonePrefixCheckpoint
          .checkpointCommitment &&
      working.scope?.laneTombstoneDischargeCheckpoint.checkpointCommitment ===
        expectedScope.state.laneTombstoneDischargeCheckpoint
          .checkpointCommitment;
    const runtimeAuthenticatedScopeReplacement = Boolean(
      stableScopeUnchanged || expectedScope.stableIdentityUnchanged === true,
    );
    let result: ReturnType<typeof reconcileMarketBaseResourcePreflight>;
    if (runtimeAuthenticatedScopeReplacement) {
      const stableState: MarketBaseResourceV3RuntimeState = {
        ...working,
        scope: expectedScope.state,
      };
      const readiness =
        resignMarketBaseResourceReadinessAuthorizationWithRuntimeCapability(
          workingReadinessRuntimeCapability,
          stableState,
          Game.time,
          expectedScope.stableIdentityUnchanged === true,
        );
      if ("reason" in readiness) {
        delete stableState.readinessAuthorization;
        return failClosed(readiness.reason, expectedScope.state);
      } else {
        if (readiness.readinessAuthorization) {
          stableState.readinessAuthorization = readiness.readinessAuthorization;
        } else {
          delete stableState.readinessAuthorization;
        }
        workingReadinessRuntimeCapability = readiness.capability;
      }
      result = {
        state: stableState,
        activeV3Successor: true,
        ...(working.blocker ? { blocker: working.blocker } : {}),
      };
    } else {
      result = reconcileMarketBaseResourcePreflight(working, {
        tick: Game.time,
        mode: context.config.mode,
        config: context.config,
        accountIdentity,
      });
      workingReadinessRuntimeCapability =
        advanceMarketBaseResourceReadinessRuntimeCapability(
          workingReadinessRuntimeCapability,
          result.state,
          Game.time,
        ) ??
        createMarketBaseResourceReadinessRuntimeCapability(
          result.state,
          Game.time,
          workingLedgerRuntimeAnchor,
        );
    }
    if (
      !runtimeAuthenticatedScopeReplacement &&
      (!result.state.scope ||
        canonicalStableHashV1(result.state.scope) !==
          canonicalStableHashV1(expectedScope.state))
    ) {
      return failClosed("market_base_scope_atomic_reconcile_mismatch", {
        expected: expectedScope.state,
        actual: result.state.scope ?? null,
      });
    }
    const nextTrustedFloors = synchronizeMarketBaseTrustedFloors(
      context.data.trustedFloors,
      result.state.pricingRatchet!,
      Game.time,
    );
    const canReuseActivationAnchor = Boolean(
      expectedScope.stableIdentityUnchanged === true &&
      result.state.ledger === working.ledger &&
      result.state.permitChain === working.permitChain &&
      result.state.pricingRatchet === working.pricingRatchet &&
      result.state.hardBlocker === working.hardBlocker &&
      nextTrustedFloors === context.data.trustedFloors &&
      workingLedgerRuntimeAnchor.anchorCommitment ===
        activation.anchor.ledger.anchorCommitment &&
      result.state.scope?.roomRegistry.checkpointCommitment ===
        activation.anchor.roomRegistryCheckpointCommitment &&
      (result.state.scope === undefined ||
        marketBaseResourceOuterScopeCommitment(result.state.scope) ===
          activation.anchor.scopeCommitment) &&
      result.state.scope?.laneTombstoneDischargeCheckpoint
        .checkpointCommitment ===
        activation.anchor.laneTombstoneDischargeCheckpointCommitment &&
      result.state.permitChain?.laneTombstoneCheckpoint.checkpointCommitment ===
        activation.anchor.laneTombstoneCheckpointCommitment,
    );
    const nextAnchor = canReuseActivationAnchor
      ? activation.anchor
      : advanceMarketBaseResourceActivationAnchor(
          activation.anchor,
          result.state,
          nextTrustedFloors,
          Game.time,
          workingLedgerRuntimeAnchor,
        );
    const nextDirect = {
      ...sourceDirect,
      baseResourceV3: result.state,
    };
    const nextData: MarketSaleDataState = {
      ...context.data,
      trustedFloors: nextTrustedFloors,
      directAutomation: nextDirect,
      pendingDirectDeals: nextDirect.pendingDirectDeals,
      baseResourceV3ActivationAnchor: nextAnchor,
      baseResourceV3ActivationAnchorMirror: canReuseActivationAnchor
        ? context.data.baseResourceV3ActivationAnchorMirror
        : cloneMarketBaseOperatorValue(nextAnchor),
    };
    commitContextMarketSaleData(context, nextData);
    const registered = registerMarketBaseResourceCanonicalRoot(
      nextData,
      context.config.mode,
      workingReadinessRuntimeCapability,
    );
    if (
      (!result.state.readinessAuthorization &&
        registered.reason !== "missing") ||
      (result.state.readinessAuthorization && !registered.ok)
    ) {
      reject(
        context,
        "market_base_readiness_runtime_capability_register_failed",
      );
      return {
        activeV3Successor: true,
        state: result.state,
        ledgerRuntimeAnchor: nextAnchor.ledger,
      };
    }
    if (result.blocker) {
      reject(context, result.blocker);
    }
    return {
      activeV3Successor: true,
      state: result.state,
      ledgerRuntimeAnchor: nextAnchor.ledger,
      readinessRuntimeCapability: workingReadinessRuntimeCapability,
    };
  }

  let working = existing ? { ...existing } : undefined;
  if (
    working?.schemaVersion === 3 &&
    (working.cutoverLatched === true ||
      (working.permitChain !== undefined &&
        hasAcceptedMarketBaseResourceV3Successor(working.permitChain)) ||
      working.ledger?.pending !== undefined) &&
    working.preflightAt !== Game.time
  ) {
    const preflight = runMarketBaseResourcePreflight(working, Game.time);
    working = preflight.state;
    mergeDirectResult(context, preflight);
    if (preflight.state.blocker) {
      reject(context, preflight.state.blocker);
      const nextDirect = {
        ...sourceDirect,
        baseResourceV3: preflight.state,
      };
      commitContextMarketSaleData(context, {
        ...context.data,
        directAutomation: nextDirect,
        pendingDirectDeals: nextDirect.pendingDirectDeals,
      });
      return {
        activeV3Successor:
          preflight.state.cutoverLatched === true ||
          preflight.state.permitChain !== undefined,
        state: preflight.state,
      };
    }
  }
  const result = reconcileMarketBaseResourcePreflight(working, {
    tick: Game.time,
    mode: context.config.mode,
    config: context.config,
  });
  const nextDirect = {
    ...sourceDirect,
    baseResourceV3: result.state,
  };
  commitContextMarketSaleData(context, {
    ...context.data,
    directAutomation: nextDirect,
    pendingDirectDeals: nextDirect.pendingDirectDeals,
  });
  if (result.activeV3Successor && result.blocker) {
    reject(context, result.blocker);
  }
  return {
    activeV3Successor: result.activeV3Successor,
    state: result.state,
  };
}

type MarketSaleRuntimeState = NonNullable<
  NonNullable<Memory["runtime"]>["marketSaleAutomation"]
> & {
  lastShadowCycleTick?: number;
  shadowConfigSignature?: string;
};

interface RunContext {
  config: ResolvedMarketSaleAutomationConfig;
  data: MarketSaleDataState;
  runtime: MarketSaleRuntimeState;
  liveOrders: MarketOrderSnapshot[];
  liveOrderById: Map<string, MarketOrderSnapshot>;
  actions: string[];
  rejectedByReason: Record<string, number>;
  writes: number;
  shadowPlanComplete: boolean;
  stagingAmount: number;
  reservationAmount: number;
  marketDomainActivityValid: boolean;
  marketBaseResourceCpuTrace?: MarketBaseResourceCpuTrace;
}

type OperatorResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; [key: string]: unknown };

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
  hashRevision: "market-base-resource-continuous-review-v1";
  laneId: string;
  resource: MarketBaseResource;
  sellerRoom: string;
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
    energy: number;
    effectivePostDealEnergyReserve: number;
    readinessRevision: string;
  };
  protection: {
    revision: number;
    observedAt: number;
    expiresAt: number;
    entryCommitment: string;
    sellableAmount: number;
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

interface MarketBaseResourceProposedContinuousReview {
  proposalId: string;
  snapshots: readonly MarketBaseResourceContinuousReviewSnapshot[];
}

interface MarketBaseResourceProposedTransition {
  proposalId: string;
  laneId: string;
  targetStage: NonNullable<MarketBaseResourcePermitRequest["targetStage"]>;
  transitionLaneIds: readonly string[];
}

interface BuiltMarketBaseV3SuccessorProposal {
  proposal: MarketBaseResourcePermitProposal;
  transition: Omit<MarketBaseResourceProposedTransition, "proposalId">;
  continuousReviews: readonly MarketBaseResourceContinuousReviewSnapshot[];
}

type OperatorGlobals = typeof global & {
  grantMarketSaleMutationLease?: (
    epoch: string,
    expiresAt: number,
  ) => OperatorResult;
  revokeMarketSaleMutationLease?: (reason?: string) => OperatorResult;
  attestMarketSalePendingCreate?: (orderId: string) => OperatorResult;
  resolveMarketSalePendingCreateAbsence?: (
    candidateIds: string[],
  ) => OperatorResult;
  resolveMarketSaleExternalOrderMutation?: (
    orderId: string,
    verifiedRemainingFeeDebtMilli: number,
  ) => OperatorResult;
  resolveMarketSaleOrderDisappearance?: (
    orderId: string,
    classification: "policy_cancelled" | "server_expired",
    verifiedRefundMilli?: number,
  ) => OperatorResult;
  expandMarketSaleCanary?: (configRevision: string) => OperatorResult;
  emergencyStopMarketSaleAutomation?: (reason?: string) => OperatorResult;
  marketSaleAutomationStatus?: () => unknown;
  resolveMarketSaleDirectPending?: (
    evidence: OperatorDirectPendingEvidence,
  ) => OperatorResult;
  proposeMarketDirectContinuousPermit?: (
    request: MarketDirectContinuousPermitRequest,
  ) => OperatorResult;
  acceptMarketDirectContinuousPermit?: (permitId: string) => OperatorResult;
  marketDirectContinuousStatus?: () => unknown;
  proposeMarketBaseResourcePermit?: (
    request?: MarketBaseResourcePermitRequest,
  ) => OperatorResult;
  proposeMarketBaseResourcePolicyMigration?: () => OperatorResult;
  acceptMarketBaseResourcePermit?: (proposalId: string) => OperatorResult;
  marketBaseResourceStatus?: () => unknown;
};

const operatorGlobals = global as OperatorGlobals;

function boundedPush<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export interface MarketSaleDomainActivity {
  stagingAmount: number;
  reservationAmount: number;
  valid: boolean;
}

function sumDomainActivity(value: unknown): { amount: number; valid: boolean } {
  if (value === undefined) return { amount: 0, valid: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { amount: 1, valid: false };
  }
  let amount = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (
      key.length === 0 ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      return { amount: 1, valid: false };
    }
    const candidate = (entry as { amount?: unknown }).amount;
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) <= 0 ||
      !Number.isSafeInteger(amount + (candidate as number))
    ) {
      return { amount: 1, valid: false };
    }
    amount += candidate as number;
  }
  return { amount, valid: true };
}

/**
 * market-sale 自有 staging/reservation 的 canonical live evidence。旧 bundle
 * 从未产生这两个 store，因此缺失按空迁移处理；损坏结构保守投影为非零。
 */
export function collectMarketSaleDomainActivity(
  value: unknown,
): MarketSaleDomainActivity {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as {
          marketStaging?: unknown;
          marketReservations?: unknown;
        })
      : undefined;
  const staging = sumDomainActivity(data?.marketStaging);
  const reservations = sumDomainActivity(data?.marketReservations);
  return {
    stagingAmount: staging.amount,
    reservationAmount: reservations.amount,
    valid: staging.valid && reservations.valid,
  };
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactRecordKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) {
    return false;
  }
  const expectedSet = new Set(expected);
  return keys.every((key) => expectedSet.has(key));
}

function isContinuousDirectState(
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

const marketBaseResourceCanonicalRootProvenance = new WeakMap<
  object,
  MarketBaseResourceCanonicalRootProvenance
>();
let marketBaseResourceCanonicalRootRegistryGame: Game | undefined;
let marketBaseResourceCanonicalRootRegistryTick: number | undefined;
let marketBaseResourceCanonicalRootRegistryCount = 0;
let marketBaseResourceCanonicalRootsThisTick = new WeakSet<object>();

function refreshMarketBaseResourceCanonicalRootRegistry(): void {
  if (
    marketBaseResourceCanonicalRootRegistryGame === Game &&
    marketBaseResourceCanonicalRootRegistryTick === Game.time
  ) {
    return;
  }
  marketBaseResourceCanonicalRootRegistryGame = Game;
  marketBaseResourceCanonicalRootRegistryTick = Game.time;
  marketBaseResourceCanonicalRootRegistryCount = 0;
  marketBaseResourceCanonicalRootsThisTick = new WeakSet<object>();
}

function hasRegisteredMarketBaseResourceCanonicalRootThisTick(): boolean {
  refreshMarketBaseResourceCanonicalRootRegistry();
  return marketBaseResourceCanonicalRootRegistryCount > 0;
}

function isRegisteredMarketBaseResourceCanonicalRootThisTick(
  value: unknown,
): boolean {
  refreshMarketBaseResourceCanonicalRootRegistry();
  return (
    value !== null &&
    typeof value === "object" &&
    marketBaseResourceCanonicalRootsThisTick.has(value)
  );
}

function registerMarketBaseResourceCanonicalRootThisTick(value: object): void {
  refreshMarketBaseResourceCanonicalRootRegistry();
  if (!marketBaseResourceCanonicalRootsThisTick.has(value)) {
    marketBaseResourceCanonicalRootsThisTick.add(value);
    marketBaseResourceCanonicalRootRegistryCount += 1;
  }
}

function ensureDataState(): MarketSaleDataState {
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
  data.feeLedger ||= createEmptyMarketSaleFeeLedger();
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
  // 保护账本和 carrier 仍读取兼容字段；正常返回时它与 Direct WAL
  // 使用同一对象，写入顺序同时覆盖 CPU 截断恢复。
  return committedData;
}

function ensureRuntimeState(): MarketSaleRuntimeState {
  if (!Memory.runtime) Memory.runtime = {};
  const previous = Memory.runtime.marketSaleAutomation as
    MarketSaleRuntimeState | undefined;
  if (previous) return previous;
  const runtime: MarketSaleRuntimeState = {
    updatedAt: Game.time,
    requestedMode: "off",
    phase: "off",
    shadowConsecutiveCycles: 0,
    zeroConfirmations: 0,
    managedOrderCount: 0,
    pendingCreateCount: 0,
    pendingMutationCount: 0,
    stagingAmount: 0,
    reservationAmount: 0,
    exposureAmount: 0,
    rollingFeeMilli: 0,
    terminalClaims: [],
    rejectedByReason: {},
    candidates: {},
    recentActions: [],
    safetyViolationCount: 0,
  };
  Memory.runtime.marketSaleAutomation = runtime;
  return runtime;
}

function appendAudit(
  data: MarketSaleDataState,
  entry: {
    action: string;
    orderId?: string;
    requestId?: string;
    candidateIds?: string[];
  },
): void {
  boundedPush(
    data.operatorAudit,
    { tick: Game.time, ...entry },
    MAX_AUDIT_ENTRIES,
  );
}

function readLiveOrders(): MarketOrderSnapshot[] {
  const orders = Game.market?.orders;
  if (!orders || typeof orders !== "object") return [];
  return Object.values(orders)
    .filter((order): order is Order =>
      Boolean(order && typeof order.id === "string"),
    )
    .map((order) => ({
      id: order.id,
      type: order.type,
      resourceType: order.resourceType,
      roomName: order.roomName,
      price: order.price,
      totalAmount: order.totalAmount,
      remainingAmount: order.remainingAmount,
      amount: order.amount,
      created: order.created,
      active: order.active,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function orderFingerprint(order: MarketOrderSnapshot): string {
  return [
    order.id,
    order.type,
    order.resourceType,
    order.roomName || "",
    order.price,
    order.totalAmount ?? "",
    order.created,
  ].join("|");
}

function makeContext(): RunContext {
  const config = measureMarketSubPhase("configResolve", () => resolveMarketSaleAutomationConfig());
  const data = measureMarketSubPhase("ensureDataState", () => ensureDataState());
  const domainActivity = measureMarketSubPhase("domainActivity", () =>
    collectMarketSaleDomainActivity(data),
  );
  const runtime = ensureRuntimeState();
  const liveOrders = measureMarketSubPhase("liveOrdersSnapshot", () => readLiveOrders());
  return {
    config,
    data,
    runtime,
    liveOrders,
    liveOrderById: new Map(liveOrders.map((order) => [order.id, order])),
    actions: [],
    rejectedByReason: {},
    writes: 0,
    shadowPlanComplete: false,
    stagingAmount: domainActivity.stagingAmount,
    reservationAmount: domainActivity.reservationAmount,
    marketDomainActivityValid: domainActivity.valid,
  };
}

function reject(context: RunContext, reason: string): void {
  context.rejectedByReason[reason] =
    (context.rejectedByReason[reason] || 0) + 1;
}

function usesDirectStrategy(config: MarketSaleAutomationConfig): boolean {
  return (
    config.mode === "direct" ||
    (config.mode === "shadow" && config.shadowStrategy === "direct")
  );
}

/**
 * Dispatcher 由已签收 permit 版本决定 evaluator。首个 V3 proposal 在跨 tick
 * 等待 operator accept 时，current permit 仍是 V2；因此继续使用代码冻结的
 * V2 config/readiness，而不是把尚未签收的 Memory V3 target config 误传给
 * V2 evaluator。V3 target 的完整性只由 propose/accept operator 单独校验。
 */
function frozenV2DispatchConfig(
  current: ResolvedMarketSaleAutomationConfig,
): ResolvedMarketSaleAutomationConfig {
  const hardFloor: Partial<Record<ResourceConstant, number>> = {};
  const economicFloor: Partial<Record<ResourceConstant, number>> = {};
  const forecastBuffer: Partial<Record<ResourceConstant, number>> = {};
  for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
    hardFloor[entry.resourceType] = entry.hardFloor;
    economicFloor[entry.resourceType] = entry.economicFloor;
    forecastBuffer[entry.resourceType] = entry.laneReserve;
  }
  return {
    ...current,
    directCapability: "continuous-v2",
    configRevision: MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION,
    sellResources: MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => entry.resourceType,
    ),
    hardFloor,
    economicFloor,
    forecastBuffer,
    minDealAmount: MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.plannedDealAmount,
    maxDirectDealAmount:
      MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.plannedDealAmount,
    maxDirectDealsPerCycle:
      MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.maxDealsPerCycle,
    minDirectOrderAmount:
      MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.plannedDealAmount,
    minDirectOrderNotional: Math.max(
      ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
        (entry) => entry.minOrderNotional,
      ),
    ),
    maxDirectRawOrdersScannedPerCycle: Math.max(
      ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
        (entry) => entry.maxRawOrdersScanned,
      ),
    ),
    maxDirectEligibleOrdersPricedPerCycle: Math.max(
      ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
        (entry) => entry.maxEligibleOrdersPriced,
      ),
    ),
    maxDirectTransactionEnergy: Math.min(
      ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
        (entry) => entry.maxTransactionEnergy,
      ),
    ),
    terminalEnergyReserve: Math.max(
      ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
        (entry) => entry.terminalEnergyReserve,
      ),
    ),
    energyShadowPrice: undefined,
    energyShadowHardFloor: MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
    canaryEnabled: true,
    canaryAllowExpansion: false,
    directCanaryMaxConfirmedDeals: 1,
    planningSnapshotMaxAgeTicks: 10,
    minHistoryDays: 7,
    minHistoryTransactions: 100,
    minHistoryVolume: 100_000,
    historyFloorRatio: 0.95,
    historyMaxAgeDays: 2,
    validForPlanning:
      current.mode === "direct" ||
      (current.mode === "shadow" && current.shadowStrategy === "direct"),
    invalidReasons: [],
  };
}

function mergeDirectResult(
  context: RunContext,
  result:
    | ReturnType<typeof runDirectAutomationPlanning>
    | MarketDirectContinuousResult
    | MarketBaseResourceAutomationResult,
): void {
  context.writes += result.writes;
  for (const action of result.actions) recordAction(context, action);
  for (const [reason, count] of Object.entries(result.rejectedByReason)) {
    context.rejectedByReason[reason] =
      (context.rejectedByReason[reason] || 0) + nonNegativeInteger(count);
  }
}

function isMarketBaseResourceAutomationResult(
  result:
    | ReturnType<typeof runDirectAutomationPlanning>
    | MarketDirectContinuousResult
    | MarketBaseResourceAutomationResult,
): result is MarketBaseResourceAutomationResult {
  return (
    "state" in result &&
    isPlainRecord(result.state) &&
    result.state.schemaVersion === 3 &&
    isPlainRecord(result.state.catalog)
  );
}

function marketBaseResourceCanonicalStateChanged(
  previous: MarketBaseResourceV3RuntimeState,
  next: MarketBaseResourceV3RuntimeState,
): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    // Planning snapshot 只是有界观测字段：不授予权限、不参与价格/保护/quota
    // 决策，也不进入 anchor。若它是唯一变化则不替换或重签 canonical root；
    // 当前与未来的安全字段仍由下方通用 key 比较绑定 identity。
    if (key === "lastPlanningSnapshot") continue;
    if (
      (previous as unknown as Record<string, unknown>)[key] !==
      (next as unknown as Record<string, unknown>)[key]
    ) {
      return true;
    }
  }
  return false;
}

function directCandidateRejectionReasons(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
): string[] {
  const reasons = new Set<string>();
  const entry = candidate.protectionEntry;
  const terminal = roomTerminal(candidate.roomName);
  const terminalEnergy = terminal?.store.getUsedCapacity(RESOURCE_ENERGY);
  for (const reason of candidate.directAdditionalRejectionReasons || []) {
    const normalized =
      typeof reason === "string" ? reason.trim().slice(0, 120) : "";
    if (normalized) reasons.add(normalized);
  }
  if (!isMarketProtectionEntryFresh(entry, Game.time)) {
    reasons.add("direct_protection_not_current");
  }
  if (!context.config.sellResources.includes(candidate.resourceType)) {
    reasons.add("direct_resource_not_allowed");
  }
  if (candidate.hasCriticalConflict || entry.blocked) {
    reasons.add("direct_critical_conflict");
  }
  if (candidate.capacityState === undefined) {
    reasons.add("direct_capacity_state_unknown");
  } else if (candidate.capacityState === "emergency") {
    reasons.add("direct_capacity_emergency");
  }
  if (candidate.isHubRoom === undefined) {
    reasons.add("direct_hub_state_unknown");
  } else if (candidate.isHubRoom) {
    reasons.add("direct_hub_room_blocked");
  }
  if (!terminal) {
    reasons.add("direct_terminal_missing");
  } else {
    if (!Number.isSafeInteger(terminal.cooldown) || terminal.cooldown !== 0) {
      reasons.add("direct_terminal_cooldown");
    }
    if (
      !Number.isSafeInteger(terminalEnergy) ||
      terminalEnergy! < context.config.terminalEnergyReserve
    ) {
      reasons.add("direct_terminal_energy_unsafe");
    }
  }
  if (
    !Number.isFinite(candidate.effectiveNetFloor) ||
    candidate.effectiveNetFloor <= 0
  ) {
    reasons.add("direct_effective_floor_invalid");
  }
  if (candidate.directHistoryTrusted !== true) {
    reasons.add("direct_history_untrusted");
  }
  if (
    !Number.isFinite(candidate.effectiveEnergyShadowPrice) ||
    candidate.energyShadowObservedAt === undefined ||
    !candidate.energyShadowComponents
  ) {
    reasons.add("direct_energy_shadow_untrusted");
  }
  return [...reasons].sort();
}

function toDirectRuntimeCandidates(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
): DirectRuntimeCandidate[] {
  return candidates.map((candidate) => {
    const terminal = roomTerminal(candidate.roomName);
    const terminalEnergy = terminal?.store.getUsedCapacity(RESOURCE_ENERGY);
    return {
      roomName: candidate.roomName,
      resourceType: candidate.resourceType,
      protectionRevision: candidate.protectionEntry.revision,
      observedAt: candidate.protectionEntry.observedAt,
      expiresAt: candidate.protectionEntry.expiresAt,
      sellableAmount: getMarketProtectionSellableAmount(
        candidate.protectionEntry,
        Game.time,
      ),
      terminalStock: candidate.protectionEntry.terminalStock,
      terminalCooldown: terminal?.cooldown,
      terminalEnergy:
        typeof terminalEnergy === "number" ? terminalEnergy : undefined,
      protectedAmount: candidate.protectionEntry.protectedAmount,
      effectiveNetFloor: candidate.effectiveNetFloor,
      directHistoryTrusted: candidate.directHistoryTrusted === true,
      effectiveEnergyShadowPrice: candidate.effectiveEnergyShadowPrice,
      energyShadowObservedAt: candidate.energyShadowObservedAt,
      energyShadowComponents: candidate.energyShadowComponents,
      capacityState: candidate.capacityState,
      isHubRoom: candidate.isHubRoom,
      rejectionReasons: directCandidateRejectionReasons(context, candidate),
    };
  });
}

function toContinuousRuntimeCandidates(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
  dispatchConfig: ResolvedMarketSaleAutomationConfig = context.config,
): MarketDirectContinuousRuntimeCandidate[] {
  const candidateContext =
    dispatchConfig === context.config
      ? context
      : {
          ...context,
          config: dispatchConfig,
        };
  // continuous full read 要求候选严格落在执行表 scope 内，任何表外键都会
  // 以 continuous_candidate_scope_unknown 将整轮规划 fail-closed。上游
  // compose 按 protection ledger 全量产出候选（live 为 8 房 × 7 base
  // 资源），而执行表只有少数 lane——不过滤曾让规划连续 38 万 tick 零
  // 成交。表内 lane 缺候选时 automation 侧本就不在 scope 检查处 fail
  // （由 energy shadow evidence 检查兜底），因此过滤不改变缺失维度
  // 的语义，只是把 join 后的多余候选挡在规划之外。
  const executionScope = new Set(
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.flatMap((entry) =>
      entry.allowedRoomNames.map(
        (roomName) => `${roomName}:${entry.resourceType}`,
      ),
    ),
  );
  return candidates
    .filter((candidate) =>
      executionScope.has(`${candidate.roomName}:${candidate.resourceType}`),
    )
    .map((candidate) => ({
      roomName: candidate.roomName,
      resourceType: candidate.resourceType,
      historyTrusted: candidate.directHistoryTrusted === true,
      historyFloor: candidate.historyFloor,
      ratchetFloor: candidate.ratchetFloor,
      effectiveNetFloor: candidate.effectiveNetFloor,
      effectiveEnergyShadowPrice: candidate.effectiveEnergyShadowPrice,
      energyShadowObservedAt: candidate.energyShadowObservedAt,
      energyShadowComponents: candidate.energyShadowComponents,
      capacityState: candidate.capacityState,
      isHubRoom: candidate.isHubRoom,
      rejectionReasons: directCandidateRejectionReasons(
        candidateContext,
        candidate,
      ),
    }));
}

function toMarketBaseResourceRuntimeCandidates(
  candidates: readonly MarketSalePlanCandidate[],
): MarketBaseResourceRuntimeCandidate[] {
  return candidates
    .filter((candidate) => isMarketBaseResource(candidate.resourceType))
    .map((candidate) => {
      // protection/Hub/emergency 是逐 lane 当前事实，不可复用 v2 的
      // rejection 集合把它们升级为全局 pricing blocker。这里只保留
      // resource-scoped pricing 与 adapter integration 失败。
      const rejectionReasons = (
        candidate.directAdditionalRejectionReasons || []
      )
        .filter(
          (reason) =>
            typeof reason === "string" && !reason.startsWith("protection:"),
        )
        .map((reason) => reason.trim().slice(0, 120))
        .filter(Boolean);
      return {
        roomName: candidate.roomName,
        resourceType: candidate.resourceType as MarketBaseResource,
        protectionEntry: candidate.protectionEntry,
        historyTrusted: candidate.directHistoryTrusted === true,
        historyFloor: candidate.historyFloor ?? 0,
        ratchetFloor: candidate.ratchetFloor ?? 0,
        effectiveNetFloor: candidate.effectiveNetFloor,
        effectiveEnergyShadowPrice:
          candidate.effectiveEnergyShadowPrice ?? Number.NaN,
        energyShadowObservedAt: candidate.energyShadowObservedAt ?? -1,
        energyShadowComponents: candidate.energyShadowComponents || {
          hardFloor: Number.NaN,
        },
        capacityState: candidate.capacityState || "normal",
        isHubRoom: candidate.isHubRoom === true,
        rejectionReasons: [...new Set(rejectionReasons)].sort(),
      };
    })
    .sort(
      (left, right) =>
        left.resourceType.localeCompare(right.resourceType) ||
        left.roomName.localeCompare(right.roomName),
    );
}

function makerExposurePresent(context: RunContext): boolean {
  return Boolean(
    Object.keys(context.data.managedOrders).length > 0 ||
    context.data.pendingCreate ||
    Object.keys(context.data.pendingMutations).length > 0 ||
    context.data.feeLedger?.reconcileGap ||
    Object.values(context.data.managedOrders).some(
      (managed) =>
        managed.externalMutationGap !== undefined ||
        managed.disappearanceGap !== undefined,
    ) ||
    context.stagingAmount > 0 ||
    context.reservationAmount > 0,
  );
}

/**
 * Direct/V3 不能借主动 mode 绕过旧 Maker 清退。这里只撤销 canonical
 * market-sale-owned SELL；手工订单以及 BUY 路径都不在撤单集合中。
 *
 * 返回 true 仅表示已经在两个不同 tick 看见旧 exposure 全部为零。
 */
function drainLegacyMakerExposureBeforeDirect(context: RunContext): boolean {
  const raw = context.data.directLegacyExposureDrain;
  const previous: DirectLegacyExposureDrainState =
    raw?.schemaVersion === 1 &&
    Number.isSafeInteger(raw.zeroConfirmations) &&
    raw.zeroConfirmations >= 0 &&
    raw.zeroConfirmations <= 2
      ? raw
      : {
          schemaVersion: 1,
          zeroConfirmations: 0,
        };
  const outstanding = makerExposurePresent(context);
  if (outstanding) {
    retryPreparedCancels(context);
    for (const orderId of Object.keys(context.data.managedOrders).sort()) {
      const live = context.liveOrderById.get(orderId);
      if (live?.type === ORDER_SELL) {
        requestCancel(context, orderId);
      } else if (live?.type === ORDER_BUY) {
        reject(context, "direct_legacy_buy_order_not_cancelled");
      }
    }
    context.data.directLegacyExposureDrain = {
      schemaVersion: 1,
      zeroConfirmations: 0,
    };
    context.data.drain = {
      phase:
        context.data.drain?.phase === "requested" ? "draining" : "requested",
      targetMode: "off",
      zeroConfirmations: 0,
    };
    reject(context, "direct_legacy_exposure_draining");
    return false;
  }

  if (previous.completedAt !== undefined && previous.zeroConfirmations >= 2) {
    return true;
  }
  const isNewTick = previous.lastZeroConfirmationTick !== Game.time;
  const zeroConfirmations = Math.min(
    2,
    previous.zeroConfirmations + (isNewTick ? 1 : 0),
  );
  const next: DirectLegacyExposureDrainState = {
    schemaVersion: 1,
    zeroConfirmations,
    lastZeroConfirmationTick: isNewTick
      ? Game.time
      : previous.lastZeroConfirmationTick,
    ...(zeroConfirmations >= 2 ? { completedAt: Game.time } : {}),
  };
  context.data.directLegacyExposureDrain = next;
  if (zeroConfirmations < 2) {
    context.data.drain = {
      phase: "draining",
      targetMode: "off",
      zeroConfirmations,
      lastZeroConfirmationTick: next.lastZeroConfirmationTick,
    };
    reject(context, "direct_legacy_exposure_zero_confirmation_pending");
    return false;
  }
  return true;
}

function structuralMarketSaleWriteBlocker(
  data: MarketSaleDataState,
  config: MarketSaleAutomationConfig,
): string | undefined {
  const direct = data.directAutomation;
  if (!direct) return "direct_state_missing";
  if (isContinuousDirectState(direct)) {
    const quarantineKeys = Object.keys(direct.quarantinedPendingDirectDeals);
    const inactiveMissingState =
      !usesDirectStrategy(config) &&
      direct.migrationStatus === "blocked" &&
      direct.migrationBlockedReason === "direct_state_missing" &&
      direct.ledger.blocker?.code === "direct_state_missing" &&
      direct.ledger.pending === undefined &&
      Object.keys(direct.pendingDirectDeals).length === 0 &&
      quarantineKeys.length === 1 &&
      quarantineKeys[0] === "__continuous_blocked__:direct_state_missing" &&
      Object.keys(direct.lifecycleByEntry).length === 0 &&
      direct.currentPermit === undefined &&
      direct.proposedPermit === undefined &&
      direct.lastPlanningSnapshot === undefined &&
      direct.lastLifecycleAppliedAttemptSeq === 0 &&
      direct.directDealOutcomes.length === 0 &&
      direct.processedDirectTransactionKeys.length === 0 &&
      direct.directConfirmedDealCount === 0 &&
      direct.directPausedForReview === true &&
      direct.ledger.receipts.length === 0 &&
      direct.ledger.outcomes.length === 0 &&
      direct.ledger.processedEvidenceKeys.length === 0 &&
      direct.ledger.finalizedAttemptSeq === 0 &&
      direct.ledger.nextAttemptSeq === 1;
    if (inactiveMissingState) {
      // Maker 与 Continuous Direct 的授权域彼此独立。一个从未启用过
      // Direct 的空状态不能误伤 Maker；但只要存在未知/损坏 WAL，
      // 或配置已经选择 Direct，下面仍保持全局 fail-closed。
      return undefined;
    }
    if (direct.migrationBlockedReason) {
      return direct.migrationBlockedReason;
    }
    if (direct.ledger.blocker) {
      return direct.ledger.blocker.code;
    }
    if (marketDirectContinuousExposure(direct).quarantinedCount > 0) {
      return "direct_quarantine_present";
    }
    return undefined;
  }
  const blocker = direct.migrationBlockedReason;
  if (blocker && blocker !== "direct_qualification_state_invalid") {
    return blocker;
  }
  if (Object.keys(direct.quarantinedPendingDirectDeals || {}).length > 0) {
    return "direct_quarantine_present";
  }
  return undefined;
}

function recordAction(context: RunContext, action: string): void {
  boundedPush(context.actions, action, MAX_RECENT_ACTIONS);
}

function sortedThresholdMap(
  value: Partial<Record<ResourceConstant, number>>,
): Array<[string, number]> {
  return Object.entries(value)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * operator-facing revision 是审计必需字段，但不足以证明底层 policy 始终冻结。
 * 持久化完整 planning signature，使误发生的原位配置修改即使未改 revision，
 * 也会重置 Shadow qualification。
 */
function planningConfigSignature(config: MarketSaleAutomationConfig): string {
  return JSON.stringify({
    configRevision: config.configRevision,
    sellResources: [...config.sellResources].sort(),
    hardFloor: sortedThresholdMap(config.hardFloor),
    economicFloor: sortedThresholdMap(config.economicFloor),
    forecastBuffer: sortedThresholdMap(config.forecastBuffer),
    minDealAmount: config.minDealAmount,
    maxDealAmount: config.maxDealAmount,
    makerBatchAmount: config.makerBatchAmount,
    maxManagedOrders: config.maxManagedOrders,
    minFreeOrderSlots: config.minFreeOrderSlots,
    creditReserve: config.creditReserve,
    rollingFeeBudget: config.rollingFeeBudget,
    feeWindowTicks: config.feeWindowTicks,
    terminalEnergyReserve: config.terminalEnergyReserve,
    energyShadowPrice: config.energyShadowPrice,
    directDiscountRatio: config.directDiscountRatio,
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
    orderPolicyTtl: config.orderPolicyTtl,
    mutationBackoffTicks: config.mutationBackoffTicks,
    canaryEnabled: config.canaryEnabled,
    canaryAllowExpansion: config.canaryAllowExpansion,
  });
}

function rollingFeeMilli(
  data: MarketSaleDataState,
  config: MarketSaleAutomationConfig,
): number {
  const cutoff = Game.time - config.feeWindowTicks;
  data.feeEvents = data.feeEvents
    .filter((event) => event.tick >= cutoff)
    .slice(-MAX_FEE_EVENTS);
  return data.feeEvents
    .filter(
      (event) =>
        event.kind === "create" ||
        event.kind === "extend" ||
        event.kind === "reprice",
    )
    .reduce((sum, event) => sum + nonNegativeInteger(event.amountMilli), 0);
}

function carryFeeDebt(
  data: MarketSaleDataState,
  resource: ResourceConstant,
  amountMilli: number,
  id: string,
): void {
  const amount = nonNegativeInteger(amountMilli);
  if (amount <= 0) return;
  data.carriedFeeDebtMilli[resource] =
    nonNegativeInteger(data.carriedFeeDebtMilli[resource]) + amount;
  if (!data.feeEvents.some((event) => event.id === id)) {
    boundedPush(
      data.feeEvents,
      {
        id,
        tick: Game.time,
        resource,
        amountMilli: amount,
        kind: "carry",
      },
      MAX_FEE_EVENTS,
    );
  }
}

type PendingCreateZeroDeltaEvidence = "absent" | "filled" | "insufficient";

function creditsToMilli(value: number): number | undefined {
  const milli = Math.round(value * 1_000);
  return Number.isSafeInteger(milli) && milli >= 0 ? milli : undefined;
}

/**
 * 仅凭 order-ID 零差异无法区分“未创建”与“观察前已经成交完”。必须用预写的
 * credits、terminal 与 outgoing transaction 基线把结果收敛到唯一结论。
 */
function classifyPendingCreateZeroDelta(
  pending: OwnedPendingCreate,
): PendingCreateZeroDeltaEvidence {
  if (
    typeof pending.creditsBefore !== "number" ||
    !Number.isFinite(pending.creditsBefore) ||
    typeof pending.terminalStockBefore !== "number" ||
    !Number.isSafeInteger(pending.terminalStockBefore) ||
    pending.terminalStockBefore < 0 ||
    !Array.isArray(pending.outgoingKeysBefore) ||
    !pending.tuple.roomName
  ) {
    return "insufficient";
  }
  const credits = Game.market?.credits;
  const terminal = roomTerminal(pending.tuple.roomName);
  const terminalStock = terminal?.store.getUsedCapacity(
    pending.tuple.resourceType,
  );
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    typeof terminalStock !== "number" ||
    !Number.isSafeInteger(terminalStock) ||
    terminalStock < 0
  ) {
    return "insufficient";
  }
  const creditsBeforeMilli = creditsToMilli(pending.creditsBefore);
  const creditsAfterMilli = creditsToMilli(credits);
  if (creditsBeforeMilli === undefined || creditsAfterMilli === undefined) {
    return "insufficient";
  }

  const outgoingBaseline = new Set(pending.outgoingKeysBefore);
  const newOutgoing = (Game.market?.outgoingTransactions || []).filter(
    (transaction) => !outgoingBaseline.has(transaction.transactionId),
  );
  const creditDeltaMilli = creditsAfterMilli - creditsBeforeMilli;
  if (
    newOutgoing.length === 0 &&
    terminalStock === pending.terminalStockBefore &&
    creditDeltaMilli === -pending.feeMilli
  ) {
    return "absent";
  }

  let priceMilli: number;
  try {
    priceMilli = priceToMilliUp(pending.tuple.price);
  } catch {
    return "insufficient";
  }
  const matchingOrderIds = new Set<string>();
  let filledAmount = 0;
  for (const transaction of newOutgoing) {
    const transactionOrder = transaction.order;
    let transactionPriceMilli: number | undefined;
    try {
      transactionPriceMilli = transactionOrder
        ? priceToMilliUp(transactionOrder.price)
        : undefined;
    } catch {
      return "insufficient";
    }
    if (
      !transactionOrder ||
      transactionOrder.type !== ORDER_SELL ||
      transaction.resourceType !== pending.tuple.resourceType ||
      transaction.from !== pending.tuple.roomName ||
      transactionPriceMilli !== priceMilli ||
      !Number.isSafeInteger(transaction.amount) ||
      transaction.amount <= 0 ||
      transaction.time < pending.requestedAt
    ) {
      return "insufficient";
    }
    matchingOrderIds.add(transactionOrder.id);
    filledAmount += transaction.amount;
  }
  if (
    newOutgoing.length > 0 &&
    matchingOrderIds.size === 1 &&
    filledAmount === pending.tuple.totalAmount &&
    terminalStock === pending.terminalStockBefore - pending.tuple.totalAmount &&
    creditDeltaMilli ===
      priceMilli * pending.tuple.totalAmount - pending.feeMilli
  ) {
    return "filled";
  }
  return "insufficient";
}

function transactionOrderId(transaction: Transaction): string | undefined {
  const order = transaction.order as { id?: string } | undefined;
  return typeof order?.id === "string" ? order.id : undefined;
}

function transactionKey(transaction: Transaction, orderId: string): string {
  return `${transaction.transactionId}:${orderId}`;
}

function unprocessedFillTransactions(
  data: MarketSaleDataState,
  orderId: string,
  notBeforeTick: number,
): Transaction[] {
  const processed = new Set(data.processedTransactionKeys);
  return (Game.market?.outgoingTransactions || [])
    .filter(
      (transaction) =>
        transactionOrderId(transaction) === orderId &&
        transaction.time >= notBeforeTick &&
        !processed.has(transactionKey(transaction, orderId)),
    )
    .sort(
      (left, right) =>
        left.time - right.time ||
        left.transactionId.localeCompare(right.transactionId),
    );
}

function markTransactionsProcessed(
  data: MarketSaleDataState,
  orderId: string,
  transactions: readonly Transaction[],
): void {
  for (const transaction of transactions) {
    const key = transactionKey(transaction, orderId);
    if (!data.processedTransactionKeys.includes(key)) {
      boundedPush(data.processedTransactionKeys, key, MAX_TRANSACTION_KEYS);
    }
  }
}

function allocateObservedFill(
  data: MarketSaleDataState,
  managed: ManagedMarketOrderState,
  filledAmount: number,
  transactions: readonly Transaction[],
  config: MarketSaleAutomationConfig,
): boolean {
  if (filledAmount <= 0) return true;
  const transactionAmount = transactions.reduce(
    (sum, transaction) => sum + nonNegativeInteger(transaction.amount),
    0,
  );
  if (transactionAmount !== filledAmount) return false;
  let feeDebtMilli = nonNegativeInteger(managed.feeDebtMilli);
  let preRemainingAmount = managed.lastRemainingAmount;
  try {
    for (const transaction of transactions) {
      const amount = nonNegativeInteger(transaction.amount);
      if (amount <= 0 || amount > preRemainingAmount) return false;
      const result = applyFillFeeDebt({
        ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
        gameTime: Game.time,
        transactionId: transaction.transactionId,
        orderId: managed.orderId,
        feeDebtMilli,
        filledAmount: amount,
        preRemainingAmount,
        limits: {
          feeWindowTicks: config.feeWindowTicks,
          fillReceiptWindowTicks: config.feeWindowTicks,
        },
      });
      data.feeLedger = result.ledger;
      if (
        result.reconcileGap ||
        result.duplicate ||
        !result.applied ||
        !result.allocation
      ) {
        return false;
      }
      feeDebtMilli = result.allocation.remainingFeeDebtMilli;
      preRemainingAmount = result.allocation.postRemainingAmount;
    }
  } catch {
    return false;
  }
  managed.feeDebtMilli = feeDebtMilli;
  managed.lastRemainingAmount = preRemainingAmount;
  managed.remainingExposure = preRemainingAmount;
  managed.lastFillAt = Game.time;
  markTransactionsProcessed(data, managed.orderId, transactions);
  return true;
}

function adoptPendingOrder(
  context: RunContext,
  pending: PendingCreateState,
  orderId: string,
): boolean {
  const order = context.liveOrderById.get(orderId);
  if (!order || !order.roomName) return false;
  const carried = nonNegativeInteger(
    context.data.carriedFeeDebtMilli[
      pending.tuple.resourceType as ResourceConstant
    ],
  );
  const managed: OwnedManagedOrder = {
    orderId,
    roomName: order.roomName,
    resourceType: pending.tuple.resourceType as ResourceConstant,
    price: order.price,
    originalAmount: pending.tuple.totalAmount,
    lastRemainingAmount: pending.tuple.totalAmount,
    remainingExposure: pending.tuple.totalAmount,
    feeDebtMilli: pending.feeMilli + carried,
    createdAt: pending.requestedAt,
    lastSeenAt: pending.requestedAt,
    policyCancelAtTick: pending.requestedAt + context.config.orderPolicyTtl,
    serverCreatedTick: order.created,
  };
  context.data.carriedFeeDebtMilli[
    pending.tuple.resourceType as ResourceConstant
  ] = 0;
  context.data.managedOrders[orderId] = managed;
  context.data.pendingCreate = undefined;
  appendAudit(context.data, {
    action: "pending_create_adopted",
    orderId,
    requestId: pending.requestId,
  });
  recordAction(context, `adopt:${orderId}`);
  return true;
}

function reconcilePendingCreateState(context: RunContext): void {
  const pending = context.data.pendingCreate;
  if (!pending) return;
  const lease = Memory.cfg?.marketSaleAutomation?.orderMutationLease as
    OrderMutationLease | undefined;
  const baselineChanged = Boolean(
    pending.baselineOrderFingerprints &&
    Object.entries(pending.baselineOrderFingerprints).some(
      ([orderId, fingerprint]) => {
        const live = context.liveOrderById.get(orderId);
        return !live || orderFingerprint(live) !== fingerprint;
      },
    ),
  );
  const result = reconcilePendingCreate({
    pending,
    liveOrders: context.liveOrders,
    lease: baselineChanged ? undefined : lease,
    gameTime: Game.time,
  });
  if (result.adoptedOrderId) {
    if (!adoptPendingOrder(context, pending, result.adoptedOrderId)) {
      context.data.pendingCreate = {
        ...pending,
        status: "ambiguous",
      };
      reject(context, "pending_create_adoption_failed");
    }
    return;
  }
  if (result.pending) {
    context.data.pendingCreate = {
      ...result.pending,
      creditsBefore: pending.creditsBefore,
      terminalStockBefore: pending.terminalStockBefore,
      outgoingKeysBefore: pending.outgoingKeysBefore,
      baselineOrderFingerprints: pending.baselineOrderFingerprints,
      operatorResolutionCandidateIds: pending.operatorResolutionCandidateIds,
    } as unknown as OwnedPendingCreate;
    if (result.blockedReason)
      reject(context, `pending_create:${result.blockedReason}`);
    return;
  }
  if (result.resolvedAs === "filled_or_absent") {
    const operatorResolved =
      pending.operatorResolutionCandidateIds !== undefined;
    const evidence = operatorResolved
      ? "absent"
      : classifyPendingCreateZeroDelta(pending);
    if (evidence === "insufficient") {
      context.data.pendingCreate = {
        ...pending,
        status: "ambiguous",
        zeroDeltaConfirmations: Math.max(2, pending.zeroDeltaConfirmations),
        lastZeroDeltaTick: Game.time,
        audit: [
          ...pending.audit,
          {
            tick: Game.time,
            action: "zero_delta_evidence_incomplete",
            candidateIds: [],
          },
        ].slice(-20),
      };
      reject(context, "pending_create:zero_delta_evidence_incomplete");
      appendAudit(context.data, {
        action: "pending_create_zero_delta_evidence_incomplete",
        requestId: pending.requestId,
      });
      return;
    }
    if (evidence === "absent") {
      carryFeeDebt(
        context.data,
        pending.tuple.resourceType as ResourceConstant,
        pending.feeMilli,
        `pending-create-carry:${pending.requestId}`,
      );
    }
    context.data.pendingCreate = undefined;
    appendAudit(context.data, {
      action: operatorResolved
        ? "pending_create_operator_absence_confirmed"
        : evidence === "filled"
          ? "pending_create_filled_confirmed"
          : "pending_create_absence_confirmed",
      requestId: pending.requestId,
      candidateIds: pending.operatorResolutionCandidateIds,
    });
    recordAction(context, `pending-create-resolved:${pending.requestId}`);
  }
}

function reconcilePendingMutationStates(context: RunContext): void {
  for (const [orderId, pending] of Object.entries(
    context.data.pendingMutations,
  )) {
    const live = context.liveOrderById.get(orderId);
    const result = reconcilePendingMutation({ pending, liveOrder: live });
    if (!result.confirmed) {
      if (result.pending)
        context.data.pendingMutations[orderId] = result.pending;
      if (result.reconcileGap)
        reject(context, "pending_mutation_reconcile_gap");
      continue;
    }
    const managed = context.data.managedOrders[orderId];
    if (pending.kind === "cancel") {
      if (managed) {
        if (managed.externalMutationGap) {
          managed.remainingExposure = Math.max(
            nonNegativeInteger(managed.remainingExposure),
            nonNegativeInteger(pending.conservativeExposure),
            nonNegativeInteger(
              managed.externalMutationGap.conservativeExposure,
            ),
          );
          managed.externalMutationGap.conservativeExposure =
            managed.remainingExposure;
          managed.lastSeenAt = Game.time;
          delete context.data.pendingMutations[orderId];
          recordAction(
            context,
            `external-mutation-cancel-confirmed:${orderId}`,
          );
          continue;
        }
        carryFeeDebt(
          context.data,
          managed.resourceType as ResourceConstant,
          managed.feeDebtMilli,
          `cancel-carry:${orderId}:${pending.requestedAt}`,
        );
        delete context.data.managedOrders[orderId];
      }
      delete context.data.pendingMutations[orderId];
      recordAction(context, `cancel-confirmed:${orderId}`);
      continue;
    }
    if (!managed || !live) {
      context.data.pendingMutations[orderId] = {
        ...pending,
        status: "reconcile_gap",
      };
      reject(context, "pending_mutation_managed_order_missing");
      continue;
    }
    const filled = nonNegativeInteger(result.observedFillAmount);
    const transactions = unprocessedFillTransactions(
      context.data,
      orderId,
      pending.requestedAt,
    );
    const preRemaining =
      pending.kind === "extend"
        ? pending.pre.remainingAmount +
          nonNegativeInteger(pending.requested.addAmount)
        : pending.pre.remainingAmount;
    managed.lastRemainingAmount = preRemaining;
    if (
      !allocateObservedFill(
        context.data,
        managed,
        filled,
        transactions,
        context.config,
      )
    ) {
      context.data.pendingMutations[orderId] = {
        ...pending,
        status: "reconcile_gap",
      };
      reject(context, "pending_mutation_fill_gap");
      continue;
    }
    if (pending.kind === "extend") {
      managed.originalAmount += nonNegativeInteger(pending.requested.addAmount);
    } else if (pending.requested.price !== undefined) {
      managed.price = pending.requested.price;
    }
    managed.lastRemainingAmount = live.remainingAmount;
    managed.remainingExposure = live.remainingAmount;
    managed.lastSeenAt = Game.time;
    managed.feeDebtMilli += pending.prospectiveFeeMilli;
    delete context.data.pendingMutations[orderId];
    recordAction(context, `${pending.kind}-confirmed:${orderId}`);
  }
}

function reconcileManagedOrders(context: RunContext): void {
  for (const [orderId, managed] of Object.entries(context.data.managedOrders)) {
    if (context.data.pendingMutations[orderId]) continue;
    const live = context.liveOrderById.get(orderId);
    if (managed.externalMutationGap) {
      if (live) {
        managed.remainingExposure = Math.max(
          nonNegativeInteger(managed.remainingExposure),
          nonNegativeInteger(live.remainingAmount),
          nonNegativeInteger(managed.externalMutationGap.conservativeExposure),
        );
        managed.externalMutationGap.conservativeExposure =
          managed.remainingExposure;
        requestCancel(context, orderId);
      }
      continue;
    }
    if (managed.disappearanceGap) continue;
    if (!live) {
      const transactions = unprocessedFillTransactions(
        context.data,
        orderId,
        managed.lastSeenAt,
      );
      if (
        managed.lastRemainingAmount > 0 &&
        allocateObservedFill(
          context.data,
          managed,
          managed.lastRemainingAmount,
          transactions,
          context.config,
        )
      ) {
        delete context.data.managedOrders[orderId];
        recordAction(context, `filled:${orderId}`);
      } else {
        try {
          const reconciliation = reconcileDisappearedOrderFeeDebt({
            ledger: context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
            gameTime: Game.time,
            orderId,
            resourceType: managed.resourceType,
            remainingFeeDebtMilli: nonNegativeInteger(managed.feeDebtMilli),
            reason: "unknown",
          });
          context.data.feeLedger = reconciliation.ledger;
          managed.disappearanceGap = {
            detectedAt: Game.time,
            reason:
              reconciliation.ledger.reconcileGap?.reason ===
              "server_expiry_refund_mismatch"
                ? "server_expiry_refund_mismatch"
                : "unknown_disappearance",
          };
        } catch {
          reject(context, "fee_ledger_invalid");
        }
        managed.backoffUntil = Math.max(
          managed.backoffUntil || 0,
          Game.time + context.config.mutationBackoffTicks,
        );
        reject(context, "managed_order_unknown_disappearance");
      }
      continue;
    }
    if (live.type === ORDER_BUY) {
      // market-sale 只拥有 SELL 生命周期。即使一个损坏/外部篡改的旧
      // managed 记录误指向 BUY，也只能 fail-closed 留给 operator
      // 处理，绝不能把购买路径当作 Maker exposure 自动撤销。
      context.runtime.safetyViolationCount += 1;
      reject(context, "managed_order_buy_identity_quarantined");
      continue;
    }
    let priceChanged = true;
    try {
      priceChanged =
        priceToMilliUp(live.price) !== priceToMilliUp(managed.price);
    } catch {
      priceChanged = true;
    }
    const liveTotalAmount = live.totalAmount;
    const totalAmountChanged =
      !Number.isSafeInteger(liveTotalAmount) ||
      liveTotalAmount !== managed.originalAmount;
    if (priceChanged || totalAmountChanged) {
      const conservativeExposure = Math.max(
        nonNegativeInteger(managed.remainingExposure),
        nonNegativeInteger(managed.lastRemainingAmount),
        nonNegativeInteger(live.remainingAmount),
      );
      managed.externalMutationGap = {
        detectedAt: Game.time,
        expectedPrice: managed.price,
        observedPrice: live.price,
        expectedTotalAmount: managed.originalAmount,
        observedTotalAmount: Number.isSafeInteger(liveTotalAmount)
          ? liveTotalAmount
          : undefined,
        conservativeExposure,
      };
      managed.remainingExposure = conservativeExposure;
      try {
        context.data.feeLedger = markExternalOrderMutationFeeGap({
          ledger: context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
          gameTime: Game.time,
          orderId,
        });
      } catch {
        reject(context, "fee_ledger_invalid");
      }
      context.runtime.safetyViolationCount += 1;
      reject(context, "managed_order_external_mutation");
      appendAudit(context.data, {
        action: "managed_order_external_mutation",
        orderId,
      });
      requestCancel(context, orderId);
      continue;
    }
    if (
      live.type !== ORDER_SELL ||
      live.resourceType !== managed.resourceType ||
      live.roomName !== managed.roomName ||
      live.remainingAmount > managed.lastRemainingAmount
    ) {
      context.runtime.safetyViolationCount += 1;
      reject(context, "managed_order_identity_changed");
      requestCancel(context, orderId);
      continue;
    }
    const filled = managed.lastRemainingAmount - live.remainingAmount;
    if (filled > 0) {
      const transactions = unprocessedFillTransactions(
        context.data,
        orderId,
        managed.lastSeenAt,
      );
      if (
        !allocateObservedFill(
          context.data,
          managed,
          filled,
          transactions,
          context.config,
        )
      ) {
        context.runtime.safetyViolationCount += 1;
        reject(context, "managed_order_fill_gap");
        requestCancel(context, orderId);
        continue;
      }
    }
    managed.price = live.price;
    managed.lastRemainingAmount = live.remainingAmount;
    managed.remainingExposure = live.remainingAmount;
    managed.lastSeenAt = Game.time;
    if (Game.time >= managed.policyCancelAtTick) {
      reject(context, "managed_order_policy_ttl_expired");
      requestCancel(context, orderId);
    }
  }
}

function reconcilePersistentState(context: RunContext): void {
  reconcilePendingCreateState(context);
  reconcilePendingMutationStates(context);
  reconcileManagedOrders(context);
}

function totalExposure(data: MarketSaleDataState): number {
  const managed = Object.values(data.managedOrders).reduce(
    (sum, order) => sum + nonNegativeInteger(order.remainingExposure),
    0,
  );
  const pendingCreate = nonNegativeInteger(data.pendingCreate?.exposure);
  const direct = data.directAutomation;
  const pendingDirect = direct
    ? isContinuousDirectState(direct)
      ? marketDirectContinuousExposure(direct).resourceAmount
      : directAutomationExposure(direct).resourceAmount
    : Object.values(data.pendingDirectDeals || {}).reduce(
        (sum, deal) => sum + nonNegativeInteger(deal.dealAmount),
        0,
      );
  return managed + pendingCreate + pendingDirect;
}

function effectiveMode(
  config: MarketSaleAutomationConfig,
): MarketSaleAutomationConfig["mode"] {
  if (
    (config.mode === "shadow" ||
      config.mode === "maker" ||
      config.mode === "direct" ||
      config.mode === "hybrid") &&
    !config.validForPlanning
  ) {
    return "off";
  }
  if (config.mode === "hybrid") return "off";
  return config.mode;
}

function makerModePermanentlyForbidden(
  config: MarketSaleAutomationConfig,
): boolean {
  return (
    MARKET_MAKER_HYBRID_PERMANENTLY_DISABLED &&
    (config.mode === "maker" || config.mode === "hybrid")
  );
}

function requestCancel(context: RunContext, orderId: string): boolean {
  if (context.data.pendingMutations[orderId]) return false;
  const managed = context.data.managedOrders[orderId];
  const live = context.liveOrderById.get(orderId);
  if (!managed || !live) return false;
  if ((managed.backoffUntil || 0) > Game.time) {
    reject(context, "cancel_backoff");
    return false;
  }
  let pending = createPendingMutation({
    kind: "cancel",
    order: live,
    gameTime: Game.time,
    conservativeExposure: Math.max(
      managed.remainingExposure,
      live.remainingAmount,
    ),
  });
  context.data.pendingMutations[orderId] = pending;
  const code = executeCancelOrder(orderId);
  context.writes += 1;
  if (code === OK) {
    pending = markPendingMutationSubmitted(pending);
    context.data.pendingMutations[orderId] = pending;
    recordAction(context, `cancel-submitted:${orderId}`);
    return true;
  }
  delete context.data.pendingMutations[orderId];
  managed.backoffUntil = Game.time + context.config.mutationBackoffTicks;
  reject(context, `cancel_error:${code}`);
  return false;
}

function retryPreparedCancels(context: RunContext): void {
  for (const [orderId, pending] of Object.entries(
    context.data.pendingMutations,
  )) {
    if (pending.kind !== "cancel" || pending.status !== "prepared") continue;
    if (pending.requestedAt >= Game.time) continue;
    if (!context.liveOrderById.has(orderId)) continue;
    const code = executeCancelOrder(orderId);
    context.writes += 1;
    if (code === OK) {
      context.data.pendingMutations[orderId] =
        markPendingMutationSubmitted(pending);
      recordAction(context, `cancel-resubmitted:${orderId}`);
    } else {
      reject(context, `cancel_retry_error:${code}`);
    }
  }
}

function updateDrain(
  context: RunContext,
  mode: MarketSaleAutomationConfig["mode"],
): void {
  const updated = updateDrainState({
    state: context.data.drain || { phase: "off", zeroConfirmations: 0 },
    desiredMode: mode,
    gameTime: Game.time,
    knownManagedIdsPresent: Object.keys(context.data.managedOrders).filter(
      (orderId) => context.liveOrderById.has(orderId),
    ).length,
    pendingCreateCount: context.data.pendingCreate ? 1 : 0,
    pendingMutationCount: Object.keys(context.data.pendingMutations).length,
    stagingAmount: context.stagingAmount,
    reservationAmount: context.reservationAmount,
    exposureAmount: totalExposure(context.data),
    reconcileGapCount:
      structuralMarketSaleWriteBlocker(context.data, context.config) ||
      context.data.feeLedger?.reconcileGap ||
      Object.values(context.data.managedOrders).some(
        (managed) =>
          managed.externalMutationGap !== undefined ||
          managed.disappearanceGap !== undefined,
      ) ||
      Object.values(context.data.pendingDirectDeals || {}).some(
        (pending) => pending.status === "reconcile_gap",
      )
        ? 1
        : 0,
  });
  const directDrain = context.data.directLegacyExposureDrain;
  context.data.drain =
    mode === "direct" &&
    directDrain?.completedAt !== undefined &&
    directDrain.zeroConfirmations >= 2
      ? {
          ...updated,
          zeroConfirmations: directDrain.zeroConfirmations,
          lastZeroConfirmationTick: directDrain.lastZeroConfirmationTick,
        }
      : updated;
}

function drainIfRequired(
  context: RunContext,
  mode: MarketSaleAutomationConfig["mode"],
): void {
  const passive =
    mode === "off" || mode === "shadow" || mode === "emergencyStop";
  updateDrain(context, mode);
  if (!passive || context.data.drain?.phase === "shadow") return;
  retryPreparedCancels(context);
  for (const orderId of Object.keys(context.data.managedOrders).sort()) {
    requestCancel(context, orderId);
  }
  updateDrain(context, mode);
}

function roomTerminal(roomName: string): StructureTerminal | undefined {
  const room = Game.rooms?.[roomName];
  return room?.terminal || undefined;
}

interface CandidateRejectionOptions {
  /** 只有维护这个 exact managed order 时才可回收其预留 exposure；新单与 Shadow 必须留空。 */
  excludeManagedOrderId?: string;
  minimumSellableAmount?: number;
}

function candidateRejectionReasons(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  options: CandidateRejectionOptions = {},
): string[] {
  const terminal = roomTerminal(candidate.roomName);
  const terminalEnergy = terminal?.store.getUsedCapacity(RESOURCE_ENERGY);
  const terminalFree = terminal?.store.getFreeCapacity();
  const result = evaluateMarketSaleCanaryPrerequisites(
    candidate.protectionEntry,
    {
      currentTick: Game.time,
      isHubRoom: candidate.isHubRoom,
      capacityState: candidate.capacityState,
      terminalExists: Boolean(terminal),
      terminalCooldown: terminal?.cooldown,
      terminalEnergy:
        typeof terminalEnergy === "number" ? terminalEnergy : undefined,
      terminalEnergyReserve: context.config.terminalEnergyReserve,
      terminalFreeCapacity:
        typeof terminalFree === "number" ? terminalFree : undefined,
      minimumTerminalFreeCapacity: candidate.minimumTerminalFreeCapacity ?? 0,
      resourceAllowed: context.config.sellResources.includes(
        candidate.resourceType,
      ),
      hasCriticalConflict: candidate.hasCriticalConflict,
      trustedPrice: candidate.trustedPrice,
      trustedDepth: candidate.trustedDepth,
      requireNoManagedExposure: false,
      excludeManagedOrderId: options.excludeManagedOrderId,
      minimumSellableAmount:
        options.minimumSellableAmount ?? context.config.minDealAmount,
    },
  );
  const reasons = [...result.reasons];
  if (
    !Number.isFinite(candidate.effectiveNetFloor) ||
    candidate.effectiveNetFloor <= 0
  ) {
    reasons.push("effective_floor_invalid" as never);
  }
  for (const reason of candidate.additionalRejectionReasons || []) {
    const normalized =
      typeof reason === "string" ? reason.trim().slice(0, 120) : "";
    if (normalized && !reasons.includes(normalized as never)) {
      reasons.push(normalized as never);
    }
  }
  return reasons;
}

function maintenanceCandidateOptions(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  phase: DrainState["phase"] | undefined,
): CandidateRejectionOptions | undefined {
  if (phase !== "maker" && phase !== "hybrid") return undefined;
  const matching = Object.values(context.data.managedOrders)
    .filter(
      (managed) =>
        managed.roomName === candidate.roomName &&
        managed.resourceType === candidate.resourceType,
    )
    .map((managed) => ({
      managed,
      live: context.liveOrderById.get(managed.orderId),
    }))
    .filter(
      (
        entry,
      ): entry is {
        managed: OwnedManagedOrder;
        live: MarketOrderSnapshot;
      } => entry.live !== undefined,
    );
  if (matching.length !== 1) return undefined;
  return {
    excludeManagedOrderId: matching[0].managed.orderId,
    minimumSellableAmount: matching[0].live.remainingAmount,
  };
}

function selectAndLockCanary(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
  allowNewLock: boolean,
): MarketSalePlanCandidate | undefined {
  const revision = context.config.configRevision;
  if (!context.config.canaryEnabled || !revision) return undefined;
  const sorted = [...candidates].sort(
    (left, right) =>
      left.roomName.localeCompare(right.roomName) ||
      left.resourceType.localeCompare(right.resourceType),
  );
  const current = context.data.canaryLock;
  if (current) {
    if (current.configRevision !== revision) {
      if (
        allowNewLock &&
        totalExposure(context.data) === 0 &&
        !context.data.pendingCreate &&
        Object.keys(context.data.pendingMutations).length === 0
      ) {
        context.data.canaryLock = undefined;
      } else {
        reject(context, "canary_revision_mismatch");
        return undefined;
      }
    } else {
      return sorted.find(
        (candidate) =>
          candidate.roomName === current.roomName &&
          candidate.resourceType === current.resourceType,
      );
    }
  }
  if (!allowNewLock) {
    reject(context, "canary_lock_missing");
    return undefined;
  }
  const candidate = sorted.find(
    (entry) => candidateRejectionReasons(context, entry).length === 0,
  );
  if (!candidate) return undefined;
  const lock = lockCanary(undefined, {
    roomName: candidate.roomName,
    resourceType: candidate.resourceType,
    lockedAt: Game.time,
    configRevision: revision,
  });
  if (!lock) return undefined;
  const ownedLock = lock as OwnedCanaryLock;
  context.data.canaryLock = ownedLock;
  context.runtime.canaryLock = ownedLock;
  appendAudit(context.data, {
    action: "canary_locked",
    candidateIds: [`${ownedLock.roomName}:${ownedLock.resourceType}`],
  });
  recordAction(
    context,
    `canary-lock:${ownedLock.roomName}:${ownedLock.resourceType}`,
  );
  return candidate;
}

function revalidateManagedOrdersForPlanning(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
): void {
  if (Memory.runtime?.resourceControl?.updatedAt !== Game.time) return;
  const lock = context.data.canaryLock;
  const signature = planningConfigSignature(context.config);
  const policyMatchesShadow =
    Boolean(lock) &&
    lock?.configRevision === context.config.configRevision &&
    context.runtime.shadowConfigRevision === context.config.configRevision &&
    context.runtime.shadowConfigSignature === signature;
  const lockedCandidate = lock
    ? candidates.find(
        (candidate) =>
          candidate.roomName === lock.roomName &&
          candidate.resourceType === lock.resourceType,
      )
    : undefined;

  for (const managed of Object.values(context.data.managedOrders)) {
    if (context.data.pendingMutations[managed.orderId]) continue;
    const live = context.liveOrderById.get(managed.orderId);
    if (!live) continue;
    let unsafeReason: string | undefined;
    if (
      !policyMatchesShadow ||
      !lock ||
      managed.roomName !== lock.roomName ||
      managed.resourceType !== lock.resourceType
    ) {
      unsafeReason = "managed_order_policy_changed";
    } else if (!lockedCandidate) {
      unsafeReason = "managed_order_locked_candidate_missing";
    } else if (live.remainingAmount <= 0) {
      unsafeReason = "managed_order_remaining_invalid";
    } else {
      const reasons = candidateRejectionReasons(context, lockedCandidate, {
        excludeManagedOrderId: managed.orderId,
        minimumSellableAmount: live.remainingAmount,
      });
      if (reasons.length > 0) {
        unsafeReason = "managed_order_candidate_rejected";
      } else {
        try {
          const invariant = evaluatePostActionInvariant({
            effectiveNetFloor: lockedCandidate.effectiveNetFloor,
            feeDebtMilli: nonNegativeInteger(managed.feeDebtMilli),
            action: {
              kind: "repriceDown",
              currentPrice: live.price,
              remainingAmount: live.remainingAmount,
            },
            candidatePrice: live.price,
          });
          if (!invariant.satisfiesInvariant) {
            unsafeReason = "managed_order_floor_violation";
          }
        } catch {
          unsafeReason = "managed_order_floor_unknown";
        }
      }
    }
    if (!unsafeReason) continue;
    context.runtime.safetyViolationCount += 1;
    reject(context, unsafeReason);
    requestCancel(context, managed.orderId);
  }
}

function findCurrentProtectionCandidate(
  candidates: readonly MarketSalePlanCandidate[],
  roomName: string,
  resourceType: ResourceConstant,
): MarketSalePlanCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.roomName === roomName &&
      candidate.resourceType === resourceType &&
      candidate.protectionEntry.roomName === roomName &&
      candidate.protectionEntry.resource === resourceType,
  );
}

function currentManagedFloorFailureReason(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  managed: OwnedManagedOrder,
  live: MarketOrderSnapshot | undefined,
): string | undefined {
  const hardFloor = context.config.hardFloor[managed.resourceType];
  const economicFloor = context.config.economicFloor[managed.resourceType];
  if (
    !live ||
    !Number.isFinite(live.price) ||
    live.price <= 0 ||
    !Number.isSafeInteger(live.remainingAmount) ||
    live.remainingAmount <= 0 ||
    !Number.isSafeInteger(managed.feeDebtMilli) ||
    managed.feeDebtMilli < 0 ||
    !Number.isFinite(candidate.effectiveNetFloor) ||
    candidate.effectiveNetFloor <= 0 ||
    !Number.isFinite(hardFloor) ||
    hardFloor === undefined ||
    hardFloor <= 0 ||
    (economicFloor !== undefined &&
      (!Number.isFinite(economicFloor) || economicFloor < 0))
  ) {
    return "current_tick_floor_unknown";
  }

  try {
    const invariant = evaluatePostActionInvariant({
      effectiveNetFloor: Math.max(
        candidate.effectiveNetFloor,
        hardFloor,
        economicFloor || 0,
      ),
      feeDebtMilli: managed.feeDebtMilli,
      action: {
        kind: "repriceDown",
        currentPrice: live.price,
        remainingAmount: live.remainingAmount,
      },
      candidatePrice: live.price,
    });
    return invariant.satisfiesInvariant
      ? undefined
      : "current_tick_floor_violation";
  } catch {
    return "current_tick_floor_unknown";
  }
}

/**
 * 每份被动市场 exposure 都必须有本 tick 完整 protection observation 与可证明的
 * current net floor。ResourceControl cadence/capacity-state 只对新单强制，但所有
 * live managed order 每 tick 都按当前配置与缓存价格证据重新验价。
 */
function currentProtectionFailureReason(
  context: RunContext,
  candidates: readonly MarketSalePlanCandidate[],
): string | undefined {
  const managedByTuple = new Map<string, OwnedManagedOrder[]>();
  for (const managed of Object.values(context.data.managedOrders)) {
    const tupleKey = `${managed.roomName}:${managed.resourceType}`;
    const tuple = managedByTuple.get(tupleKey) || [];
    tuple.push(managed);
    managedByTuple.set(tupleKey, tuple);

    const candidate = findCurrentProtectionCandidate(
      candidates,
      managed.roomName,
      managed.resourceType,
    );
    if (
      !candidate ||
      !isMarketProtectionEntryFresh(candidate.protectionEntry, Game.time)
    ) {
      return "current_tick_protection_missing";
    }
    const live = context.liveOrderById.get(managed.orderId);
    const floorFailure = currentManagedFloorFailureReason(
      context,
      candidate,
      managed,
      live,
    );
    if (floorFailure) return floorFailure;
    const requiredExposure = Math.max(
      nonNegativeInteger(managed.remainingExposure),
      nonNegativeInteger(live?.remainingAmount),
      nonNegativeInteger(
        context.data.pendingMutations[managed.orderId]?.conservativeExposure,
      ),
    );
    const ownContribution = candidate.protectionEntry.sourceContributions
      .filter(
        (contribution) =>
          contribution.bucket === "managedExposure" &&
          contribution.managedOrderId === managed.orderId,
      )
      .reduce((sum, contribution) => sum + contribution.amount, 0);
    if (
      requiredExposure <= 0 ||
      ownContribution < requiredExposure ||
      getMarketProtectionSellableAmount(candidate.protectionEntry, Game.time, {
        excludeManagedOrderId: managed.orderId,
      }) < requiredExposure
    ) {
      return "current_tick_protection_insufficient";
    }
  }

  const pending = context.data.pendingCreate;
  if (pending) {
    const roomName = pending.tuple.roomName;
    const resourceType = pending.tuple.resourceType as ResourceConstant;
    if (!roomName) return "current_tick_protection_missing";
    const candidate = findCurrentProtectionCandidate(
      candidates,
      roomName,
      resourceType,
    );
    if (
      !candidate ||
      !isMarketProtectionEntryFresh(candidate.protectionEntry, Game.time)
    ) {
      return "current_tick_protection_missing";
    }

    const tupleKey = `${roomName}:${resourceType}`;
    const managedExposure = (managedByTuple.get(tupleKey) || []).reduce(
      (sum, managed) =>
        sum +
        Math.max(
          nonNegativeInteger(managed.remainingExposure),
          nonNegativeInteger(
            context.data.pendingMutations[managed.orderId]
              ?.conservativeExposure,
          ),
        ),
      0,
    );
    const requiredExposure =
      managedExposure + nonNegativeInteger(pending.exposure);
    const entry = candidate.protectionEntry;
    if (
      requiredExposure <= managedExposure ||
      entry.managedExposure < requiredExposure ||
      entry.grossSurplus < requiredExposure ||
      entry.terminalStock < requiredExposure
    ) {
      return "current_tick_protection_insufficient";
    }
  }

  return undefined;
}

function hasFeeSensitiveFence(data: MarketSaleDataState): boolean {
  return Boolean(
    data.pendingCreate ||
    data.feeLedger?.reconcileGap ||
    Object.values(data.managedOrders).some(
      (managed) =>
        managed.externalMutationGap !== undefined ||
        managed.disappearanceGap !== undefined,
    ) ||
    Object.values(data.pendingMutations).some(
      (pending) =>
        pending.kind === "extend" ||
        pending.kind === "reprice" ||
        pending.status === "reconcile_gap",
    ),
  );
}

interface MakerTerminalSnapshot {
  resourceStock: number;
}

/**
 * Maker 的最终 TOCTOU 栅栏。
 *
 * ResourceControl 先于市场出售运行；成功的 terminal.send intent 不会在同 tick
 * 立即反映到 store/cooldown，因此必须先尊重 arbiter claim。没有 claim 时仍重读
 * Terminal 的资源、能量与容量，并把实时资源量叠加到本 tick 的保护账本上限。
 */
function readSafeMakerTerminalSnapshot(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  amount: number,
): MakerTerminalSnapshot | undefined {
  if (hasTerminalActionClaim(candidate.roomName)) {
    reject(context, "terminal_claimed");
    return undefined;
  }

  const terminal = roomTerminal(candidate.roomName);
  if (!terminal) {
    reject(context, "terminal_missing");
    return undefined;
  }
  if (
    typeof terminal.cooldown !== "number" ||
    !Number.isFinite(terminal.cooldown) ||
    terminal.cooldown !== 0
  ) {
    reject(context, "terminal_cooldown");
    return undefined;
  }

  const resourceStock = terminal.store.getUsedCapacity(candidate.resourceType);
  if (
    typeof resourceStock !== "number" ||
    !Number.isFinite(resourceStock) ||
    resourceStock < 0
  ) {
    reject(context, "terminal_resource_unknown");
    return undefined;
  }
  const terminalEnergy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
  if (
    typeof terminalEnergy !== "number" ||
    !Number.isFinite(terminalEnergy) ||
    terminalEnergy < 0
  ) {
    reject(context, "terminal_energy_unknown");
    return undefined;
  }
  if (terminalEnergy < context.config.terminalEnergyReserve) {
    reject(context, "terminal_energy");
    return undefined;
  }
  const terminalFree = terminal.store.getFreeCapacity();
  if (
    typeof terminalFree !== "number" ||
    !Number.isFinite(terminalFree) ||
    terminalFree < 0
  ) {
    reject(context, "terminal_capacity_unknown");
    return undefined;
  }
  if (terminalFree < (candidate.minimumTerminalFreeCapacity ?? 0)) {
    reject(context, "terminal_capacity");
    return undefined;
  }

  const protectedSellable = getMarketProtectionSellableAmount(
    candidate.protectionEntry,
    Game.time,
  );
  const currentSellable = Math.min(
    nonNegativeInteger(protectedSellable),
    Math.floor(resourceStock),
  );
  if (amount > currentSellable) {
    reject(context, "maker_amount_no_longer_sellable");
    return undefined;
  }

  return {
    resourceStock: Math.floor(resourceStock),
  };
}

function createMakerOrder(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
): boolean {
  if (MARKET_MAKER_HYBRID_PERMANENTLY_DISABLED) {
    reject(context, "market_maker_hybrid_permanently_disabled");
    return false;
  }
  if (hasFeeSensitiveFence(context.data)) {
    reject(context, "mutation_fence");
    return false;
  }
  const lock = context.data.canaryLock;
  if (
    !lock ||
    lock.roomName !== candidate.roomName ||
    lock.resourceType !== candidate.resourceType
  ) {
    reject(context, "canary_lock_missing");
    return false;
  }
  if (
    Object.values(context.data.managedOrders).some(
      (order) =>
        order.roomName === candidate.roomName &&
        order.resourceType === candidate.resourceType,
    )
  ) {
    return false;
  }
  const expansion =
    context.config.canaryAllowExpansion &&
    context.data.expansionGrant?.configRevision ===
      context.config.configRevision;
  const maximumOrders = expansion ? context.config.maxManagedOrders : 1;
  if (Object.keys(context.data.managedOrders).length >= maximumOrders) {
    reject(context, "managed_order_limit");
    return false;
  }
  if (
    context.liveOrders.length + context.config.minFreeOrderSlots >=
    MAX_MARKET_ORDERS
  ) {
    reject(context, "order_slots_reserved");
    return false;
  }
  const signature = planningConfigSignature(context.config);
  if (
    context.runtime.shadowConfigRevision !== context.config.configRevision ||
    context.runtime.shadowConfigSignature !== signature ||
    context.runtime.shadowConsecutiveCycles < REQUIRED_SHADOW_CYCLES
  ) {
    reject(context, "shadow_qualification_incomplete");
    return false;
  }
  const amount = Math.min(
    context.config.makerBatchAmount,
    nonNegativeInteger(candidate.protectionEntry.sellableAmount),
  );
  if (amount < context.config.minDealAmount) {
    reject(context, "maker_amount_too_small");
    return false;
  }
  const carried = nonNegativeInteger(
    context.data.carriedFeeDebtMilli[candidate.resourceType],
  );
  const minimum = findMinimumSafePrice({
    effectiveNetFloor: candidate.effectiveNetFloor,
    feeDebtMilli: carried,
    action: { kind: "create", amount },
  });
  if (!minimum.safe || minimum.recommendedPrice === undefined) {
    reject(context, "maker_price_unavailable");
    return false;
  }
  const price = roundMarketPriceUp(
    Math.max(minimum.recommendedPrice, candidate.makerPrice || 0),
  );
  const invariant = evaluatePostActionInvariant({
    effectiveNetFloor: candidate.effectiveNetFloor,
    feeDebtMilli: carried,
    action: { kind: "create", amount },
    candidatePrice: price,
  });
  if (!invariant.satisfiesInvariant) {
    context.runtime.safetyViolationCount += 1;
    reject(context, "maker_floor_violation");
    return false;
  }
  const feeMilli = calculateProspectiveFeeMilli(
    { kind: "create", amount },
    price,
  );
  const credits = Game.market?.credits;
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    credits < 0 ||
    context.config.creditReserve === undefined
  ) {
    reject(context, "credit_reserve");
    return false;
  }
  const creditsMilli = Math.floor(credits * 1_000);
  const creditReserveMilli = Math.ceil(context.config.creditReserve * 1_000);
  const rollingFeeBudgetMilli = Math.ceil(
    context.config.rollingFeeBudget * 1_000,
  );
  if (
    !Number.isSafeInteger(creditsMilli) ||
    !Number.isSafeInteger(creditReserveMilli) ||
    !Number.isSafeInteger(rollingFeeBudgetMilli)
  ) {
    reject(context, "fee_integer_range");
    return false;
  }
  const terminalSnapshot = readSafeMakerTerminalSnapshot(
    context,
    candidate,
    amount,
  );
  if (!terminalSnapshot) return false;

  const feeReservationId = `create:market-sale:${Game.time}:${candidate.roomName}:${candidate.resourceType}`;
  try {
    const reservation = reserveProspectiveFee({
      ledger: context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
      reservationId: feeReservationId,
      gameTime: Game.time,
      action: "create",
      prospectiveFeeMilli: feeMilli,
      creditsMilli,
      creditReserveMilli,
      rollingFeeBudgetMilli,
      limits: {
        feeWindowTicks: context.config.feeWindowTicks,
        fillReceiptWindowTicks: context.config.feeWindowTicks,
      },
      orderSlots: {
        usedOrderSlots: context.liveOrders.length,
        totalOrderSlots: MAX_MARKET_ORDERS,
        minFreeOrderSlots: context.config.minFreeOrderSlots,
        managedOrderCount: Object.keys(context.data.managedOrders).length,
        maxManagedOrders: maximumOrders,
      },
    });
    context.data.feeLedger = reservation.ledger;
    if (!reservation.allowed) {
      for (const reason of reservation.reasons) {
        reject(context, `fee_gate:${reason}`);
      }
      return false;
    }
  } catch {
    reject(context, "fee_ledger_invalid");
    return false;
  }
  const lease = Memory.cfg?.marketSaleAutomation?.orderMutationLease as
    OrderMutationLease | undefined;
  if (!lease) {
    reject(context, "mutation_lease_missing");
    return false;
  }
  const pending = createPendingCreateState({
    requestId: `market-sale:${Game.time}:${candidate.roomName}:${candidate.resourceType}`,
    gameTime: Game.time,
    liveOrders: context.liveOrders,
    lease,
    tuple: {
      type: ORDER_SELL,
      resourceType: candidate.resourceType,
      roomName: candidate.roomName,
      price,
      totalAmount: amount,
      createdNotBefore: Game.time,
      createdNotAfter: Game.time + 2,
    },
    feeMilli,
    exposure: amount,
  });
  if (!pending) {
    reject(context, "mutation_lease_invalid");
    return false;
  }
  context.data.pendingCreate = {
    ...pending,
    creditsBefore: credits,
    terminalStockBefore: terminalSnapshot.resourceStock,
    outgoingKeysBefore: (Game.market.outgoingTransactions || []).map(
      (transaction) => transaction.transactionId,
    ),
    baselineOrderFingerprints: Object.fromEntries(
      context.liveOrders.map((order) => [order.id, orderFingerprint(order)]),
    ),
  } as unknown as OwnedPendingCreate;
  const code = executeCreateOrder({
    type: ORDER_SELL,
    resourceType: candidate.resourceType,
    price,
    totalAmount: amount,
    roomName: candidate.roomName,
  });
  context.writes += 1;
  if (code !== OK) {
    try {
      context.data.feeLedger = releaseProspectiveFeeReservation({
        ledger: context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
        reservationId: feeReservationId,
        gameTime: Game.time,
        limits: {
          feeWindowTicks: context.config.feeWindowTicks,
          fillReceiptWindowTicks: context.config.feeWindowTicks,
        },
      });
    } catch {
      reject(context, "fee_reservation_release_failed");
    }
    context.data.pendingCreate = undefined;
    reject(context, `create_error:${code}`);
    appendAudit(context.data, {
      action: "pending_create_call_failed",
      requestId: pending.requestId,
    });
    return false;
  }
  try {
    context.data.feeLedger = commitProspectiveFeeReservation({
      ledger: context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
      reservationId: feeReservationId,
      gameTime: Game.time,
      limits: {
        feeWindowTicks: context.config.feeWindowTicks,
        fillReceiptWindowTicks: context.config.feeWindowTicks,
      },
    });
  } catch {
    reject(context, "fee_reservation_commit_failed");
  }
  context.data.pendingCreate = {
    ...markPendingCreateSubmitted(pending),
    creditsBefore: credits,
    terminalStockBefore: terminalSnapshot.resourceStock,
    outgoingKeysBefore: (Game.market.outgoingTransactions || []).map(
      (transaction) => transaction.transactionId,
    ),
    baselineOrderFingerprints: Object.fromEntries(
      context.liveOrders.map((order) => [order.id, orderFingerprint(order)]),
    ),
  } as unknown as OwnedPendingCreate;
  boundedPush(
    context.data.feeEvents,
    {
      id: `create:${pending.requestId}`,
      tick: Game.time,
      resource: candidate.resourceType,
      amountMilli: feeMilli,
      kind: "create",
    },
    MAX_FEE_EVENTS,
  );
  appendAudit(context.data, {
    action: "pending_create_submitted",
    requestId: pending.requestId,
  });
  recordAction(
    context,
    `create-submitted:${candidate.roomName}:${candidate.resourceType}`,
  );
  return true;
}

function projectCandidate(
  context: RunContext,
  candidate: MarketSalePlanCandidate,
  reasons: string[],
): void {
  const entry = candidate.protectionEntry;
  const key = `${candidate.roomName}:${candidate.resourceType}`;
  context.runtime.candidates[key] = {
    roomName: candidate.roomName,
    resource: candidate.resourceType,
    revision: entry.revision,
    observedAt: entry.observedAt,
    expiresAt: entry.expiresAt,
    stock: entry.totalStock,
    terminalStock: entry.terminalStock,
    protectedAmount: entry.protectedAmount,
    forecastBuffer: entry.forecastBuffer,
    outgoingProtected: entry.protectedOutgoing,
    carrierOrInFlight: entry.carrierOrInFlight,
    managedExposure: entry.managedExposure,
    sellableAmount: entry.sellableAmount,
    hardFloor: context.config.hardFloor[candidate.resourceType],
    economicFloor: context.config.economicFloor[candidate.resourceType],
    historyTrusted: candidate.historyTrusted,
    historyCompleteDayCount: candidate.historyCompleteDayCount,
    historyAcceptedDayCount: candidate.historyAcceptedDayCount,
    historyFloor: candidate.historyFloor,
    ratchetFloor: candidate.ratchetFloor,
    effectiveNetFloor: candidate.effectiveNetFloor,
    makerPrice: candidate.makerPrice,
    makerNetPrice: candidate.makerNetPrice,
    rejectedReason: reasons.length > 0 ? reasons.join(",") : undefined,
  };
  for (const reason of reasons) reject(context, `candidate:${reason}`);
}

function updateShadowCount(
  context: RunContext,
  phase: DrainState["phase"],
): void {
  const directState = context.data.directAutomation;
  if (
    isContinuousDirectState(directState) &&
    usesDirectStrategy(context.config)
  ) {
    const activeShadow = Object.values(directState.lifecycleByEntry).filter(
      (entry) => entry.stage === "shadow" || entry.stage === "qualified",
    );
    context.runtime.shadowConsecutiveCycles =
      activeShadow.length > 0
        ? Math.min(
            ...activeShadow.map((entry) => entry.consecutiveCompleteCycles),
          )
        : 0;
    context.runtime.shadowConfigRevision = context.config.configRevision;
    context.runtime.shadowConfigSignature =
      directState.currentPermit?.sharedPolicyFingerprint;
    const cycleTicks = activeShadow
      .map((entry) => entry.lastCycleTick)
      .filter((tick): tick is number => typeof tick === "number");
    context.runtime.lastShadowCycleTick =
      cycleTicks.length > 0 ? Math.max(...cycleTicks) : undefined;
    return;
  }
  if (
    usesDirectStrategy(context.config) &&
    directState &&
    !isContinuousDirectState(directState)
  ) {
    const qualification = directState.shadowQualification;
    context.runtime.shadowConsecutiveCycles = qualification.consecutiveCycles;
    context.runtime.shadowConfigRevision = qualification.configRevision;
    context.runtime.shadowConfigSignature = qualification.safetyFingerprint;
    context.runtime.lastShadowCycleTick = qualification.lastCycleTick;
    return;
  }
  const revision = context.config.configRevision;
  const signature = planningConfigSignature(context.config);
  const freshResourceControlCycle =
    Memory.runtime?.resourceControl?.updatedAt === Game.time;
  if (
    phase !== "shadow" ||
    !revision ||
    !freshResourceControlCycle ||
    !context.shadowPlanComplete
  ) {
    if (
      phase === "shadow" &&
      freshResourceControlCycle &&
      !context.shadowPlanComplete
    ) {
      context.runtime.shadowConsecutiveCycles = 0;
      context.runtime.lastShadowCycleTick = Game.time;
    }
    const preserveQualifiedEvidence =
      (phase === "maker" || phase === "hybrid") &&
      context.runtime.shadowConfigRevision === revision &&
      context.runtime.shadowConfigSignature === signature;
    if (phase !== "shadow" && !preserveQualifiedEvidence) {
      context.runtime.shadowConsecutiveCycles = 0;
      context.runtime.shadowConfigRevision = undefined;
      context.runtime.shadowConfigSignature = undefined;
      context.runtime.lastShadowCycleTick = undefined;
    }
    return;
  }
  if (
    context.runtime.shadowConfigRevision !== revision ||
    context.runtime.shadowConfigSignature !== signature
  ) {
    context.runtime.shadowConfigRevision = revision;
    context.runtime.shadowConfigSignature = signature;
    context.runtime.shadowConsecutiveCycles = 0;
    context.runtime.lastShadowCycleTick = Game.time;
    return;
  }
  if (context.runtime.lastShadowCycleTick === Game.time) return;
  context.runtime.shadowConsecutiveCycles += 1;
  context.runtime.lastShadowCycleTick = Game.time;
}

const MARKET_BASE_RESOURCE_CPU_CUT_PHASES: readonly MarketBaseResourceCpuCutPhase[] = [
  "outer_session",
  "scope_core_read1",
  "scope_core_read2",
  "market_facts_read1",
  "market_facts_read2",
  "shadow_batch_read1",
  "shadow_batch_read2",
  "inner_apply",
  "outer_precommit",
];
const MARKET_BASE_RESOURCE_MARKET_FACTS_DISPOSITIONS: readonly MarketBaseResourceMarketFactsDisposition[] = [
  "not_reached",
  "skipped_no_consumer",
  "read",
];

function boundedMarketBaseResourceCpuTrace(
  value: unknown,
): MarketBaseResourceCpuTrace | undefined {
  if (!isPlainRecord(value)) return undefined;
  const boundedCpu = (field: string): number | null | undefined => {
    const candidate = value[field];
    if (candidate === null) return null;
    return typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0 &&
      candidate <= 100
      ? candidate
      : undefined;
  };
  const cpuAfterOuterSession = boundedCpu("cpuAfterOuterSession");
  const cpuAfterScopeCore = boundedCpu("cpuAfterScopeCore");
  const cpuAfterMarketFacts = boundedCpu("cpuAfterMarketFacts");
  const cpuAfterShadowBatch = boundedCpu("cpuAfterShadowBatch");
  const cpuAfterInnerApply = boundedCpu("cpuAfterInnerApply");
  const cpuValues = [
    cpuAfterOuterSession,
    cpuAfterScopeCore,
    cpuAfterMarketFacts,
    cpuAfterShadowBatch,
    cpuAfterInnerApply,
  ];
  const observedValues = cpuValues.filter(
    (candidate): candidate is number => typeof candidate === "number",
  );
  const firstNullIndex = cpuValues.findIndex((candidate) => candidate === null);
  const cpuCutPhase = value.cpuCutPhase;
  const marketFactsDisposition = value.marketFactsDisposition;
  if (
    !Number.isSafeInteger(value.observedAt) ||
    (value.observedAt as number) < 0 ||
    (value.observedAt as number) > Game.time ||
    cpuValues.some((candidate) => candidate === undefined) ||
    (firstNullIndex >= 0 &&
      cpuValues
        .slice(firstNullIndex)
        .some((candidate) => candidate !== null)) ||
    observedValues.some(
      (candidate, index) =>
        index > 0 && candidate < observedValues[index - 1]!,
    ) ||
    (cpuCutPhase !== null &&
      !MARKET_BASE_RESOURCE_CPU_CUT_PHASES.includes(
        cpuCutPhase as MarketBaseResourceCpuCutPhase,
      )) ||
    !MARKET_BASE_RESOURCE_MARKET_FACTS_DISPOSITIONS.includes(
      marketFactsDisposition as MarketBaseResourceMarketFactsDisposition,
    )
  ) {
    return undefined;
  }
  return {
    observedAt: value.observedAt as number,
    cpuAfterOuterSession: cpuAfterOuterSession!,
    cpuAfterScopeCore: cpuAfterScopeCore!,
    cpuAfterMarketFacts: cpuAfterMarketFacts!,
    cpuAfterShadowBatch: cpuAfterShadowBatch!,
    cpuAfterInnerApply: cpuAfterInnerApply!,
    cpuCutPhase: cpuCutPhase as MarketBaseResourceCpuCutPhase | null,
    marketFactsDisposition:
      marketFactsDisposition as MarketBaseResourceMarketFactsDisposition,
  };
}

function projectContinuousDirectRuntimeStatus(
  state: MarketDirectContinuousAutomationState,
  strategyActive: boolean,
  marketBaseResourceCpuTrace?: unknown,
): unknown {
  const boundedCpuTrace = boundedMarketBaseResourceCpuTrace(
    marketBaseResourceCpuTrace,
  );
  const lifecycleByEntry: Record<string, unknown> = {};
  for (const [entryId, lifecycle] of Object.entries(
    state.lifecycleByEntry,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    lifecycleByEntry[entryId] = {
      stage: lifecycle.stage,
      consecutiveCompleteCycles: lifecycle.consecutiveCompleteCycles,
      lastCycleTick: lifecycle.lastCycleTick,
      lastShadowResult: lifecycle.lastShadowResult,
      qualifiedAt: lifecycle.qualifiedAt,
      canaryConfirmedAt: lifecycle.canaryConfirmedAt,
      canaryConfirmedCount: lifecycle.canaryConfirmedCount,
      sharedReviewRequired: lifecycle.sharedReviewRequired,
    };
  }
  const pending = state.ledger.pending;
  const quotaBatch = computeContinuousQuotaBatch(
    state.ledger,
    Game.time,
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => ({
      resource: entry.resourceType,
      resourceLimit: entry.rollingMaxAmount,
    })),
    MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.rollingMaxAmount,
  );
  const quotaByResource = new Map(
    (quotaBatch || []).map((snapshot) => [
      snapshot.resource,
      snapshot,
    ]),
  );
  const entries = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => ({
    entryId: entry.entryId,
    resourceType: entry.resourceType,
    allowedRoomNames: entry.allowedRoomNames,
    hardFloor: entry.hardFloor,
    economicFloor: entry.economicFloor,
    laneReserve: entry.laneReserve,
    rollingWindowTicks: entry.rollingWindowTicks,
    rollingMaxAmount: entry.rollingMaxAmount,
    opportunityReserveAmount: entry.rollingOpportunityReserveAmount,
    lifecycle: lifecycleByEntry[entry.entryId],
    quota: quotaByResource.get(entry.resourceType),
  }));
  return {
    strategyActive,
    schemaVersion: state.schemaVersion,
    capability: state.capability,
    migrationStatus: state.migrationStatus,
    migrationBlockedReason: state.migrationBlockedReason,
    permit: state.currentPermit
      ? {
          epoch: state.currentPermit.epoch,
          permitId: state.currentPermit.permitId,
          permitHead: state.currentPermit.permitHead,
          grants: state.currentPermit.entryGrants.map((grant) => ({
            entryId: grant.entryId,
            stage: grant.stage,
            newDealGrant: grant.newDealGrant,
          })),
        }
      : undefined,
    proposedPermitId: state.proposedPermit?.permit.permitId,
    lifecycleByEntry,
    entries,
    ledger: {
      receiptHeadHash: state.ledger.receiptHeadHash,
      finalizedAttemptSeq: state.ledger.finalizedAttemptSeq,
      nextAttemptSeq: state.ledger.nextAttemptSeq,
      coverageStartTick: state.ledger.coverageStartTick,
      permitEpochHighWater: state.ledger.permitEpochHighWater,
      permitChainHeadHighWater: state.ledger.permitChainHeadHighWater,
      lifetimeConfirmed: state.ledger.lifetimeConfirmed,
      pending: pending
        ? {
            attemptSeq: pending.attemptSeq,
            requestId: pending.evidenceKeyHint,
            entryId: pending.entryId,
            sellerRoom: pending.sellerRoom,
            resource: pending.resource,
            orderId: pending.orderId,
            attemptAt: pending.attemptAt,
            plannedAmount: pending.plannedAmount,
            plannedTransactionEnergy: pending.plannedTransactionEnergy,
          }
        : undefined,
      blocker: state.ledger.blocker,
      quarantinedCount: Object.keys(state.quarantinedPendingDirectDeals).length,
    },
    lastPlanningSnapshot: state.lastPlanningSnapshot,
    ...(boundedCpuTrace
      ? {
          baseResourceV3CpuTrace: {
            ...boundedCpuTrace,
          },
        }
      : {}),
  };
}

function projectRuntime(
  context: RunContext,
  requestedMode: MarketSaleAutomationConfig["mode"],
): void {
  const drain = context.data.drain || { phase: "off", zeroConfirmations: 0 };
  context.runtime.updatedAt = Game.time;
  context.runtime.requestedMode = requestedMode;
  context.runtime.phase = drain.phase;
  context.runtime.configRevision = context.config.configRevision;
  context.runtime.zeroConfirmations = drain.zeroConfirmations;
  context.runtime.lastZeroConfirmationTick = drain.lastZeroConfirmationTick;
  context.runtime.managedOrderCount = Object.keys(
    context.data.managedOrders,
  ).length;
  context.runtime.managedOrders = Object.values(context.data.managedOrders)
    .sort((left, right) => left.orderId.localeCompare(right.orderId))
    .slice(0, MAX_MANAGED_ORDER_SUMMARIES)
    .map((managed) => ({
      orderId: managed.orderId,
      roomName: managed.roomName,
      resourceType: managed.resourceType,
      remainingExposure: managed.remainingExposure,
      liveRemainingAmount: context.liveOrderById.get(managed.orderId)
        ?.remainingAmount,
      policyCancelAtTick: managed.policyCancelAtTick,
      backoffUntil: managed.backoffUntil,
      pendingMutationKind: context.data.pendingMutations[managed.orderId]?.kind,
    }));
  context.runtime.managedOrderSummaryTruncated =
    context.runtime.managedOrderCount > context.runtime.managedOrders.length;
  const activeBackoffs = Object.values(context.data.managedOrders)
    .map((managed) => managed.backoffUntil)
    .filter(
      (backoffUntil): backoffUntil is number =>
        typeof backoffUntil === "number" && backoffUntil > Game.time,
    );
  context.runtime.backoffSummary = {
    activeCount: activeBackoffs.length,
    nextUntil:
      activeBackoffs.length > 0 ? Math.min(...activeBackoffs) : undefined,
  };
  context.runtime.orderSlots = {
    total: MAX_MARKET_ORDERS,
    current: context.liveOrders.length,
    free: Math.max(0, MAX_MARKET_ORDERS - context.liveOrders.length),
    // An unresolved create owns one serialization slot even before its ID is
    // safely attributable. Manual order details are intentionally not exposed.
    reserved: context.data.pendingCreate ? 1 : 0,
    minFree: context.config.minFreeOrderSlots,
  };
  context.runtime.pendingCreateCount = context.data.pendingCreate ? 1 : 0;
  context.runtime.pendingMutationCount = Object.keys(
    context.data.pendingMutations,
  ).length;
  context.runtime.stagingAmount = context.stagingAmount;
  context.runtime.reservationAmount = context.reservationAmount;
  context.runtime.exposureAmount = totalExposure(context.data);
  context.runtime.rollingFeeMilli = rollingFeeMilli(
    context.data,
    context.config,
  );
  context.runtime.creditReserve = context.config.creditReserve;
  const credits = Game.market?.credits;
  let reservedFeesThisTick: number | undefined;
  try {
    reservedFeesThisTick =
      getFeeLedgerTotals(
        advanceFeeLedgerWindow(
          context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
          Game.time,
          {
            feeWindowTicks: context.config.feeWindowTicks,
            fillReceiptWindowTicks: context.config.feeWindowTicks,
          },
        ),
      ).reservedThisTickMilli / 1_000;
  } catch {
    reservedFeesThisTick = undefined;
  }
  const trustedCredits =
    typeof credits === "number" && Number.isFinite(credits) && credits >= 0
      ? credits
      : undefined;
  const reserve =
    typeof context.config.creditReserve === "number" &&
    Number.isFinite(context.config.creditReserve) &&
    context.config.creditReserve >= 0
      ? context.config.creditReserve
      : undefined;
  context.runtime.creditSummary = {
    credits: trustedCredits,
    reserve,
    reservedFeesThisTick,
    availableAfterReserve:
      trustedCredits !== undefined &&
      reserve !== undefined &&
      reservedFeesThisTick !== undefined
        ? trustedCredits - reserve - reservedFeesThisTick
        : undefined,
  };
  context.runtime.terminalClaims = getTerminalActionClaims().map(
    (claim) => `${claim.roomName}:${claim.actor}:${claim.kind}`,
  );
  context.runtime.rejectedByReason = { ...context.rejectedByReason };
  context.runtime.canaryLock = context.data.canaryLock;
  const directState = context.data.directAutomation!;
  if (isContinuousDirectState(directState)) {
    const priorDirectRuntime = isPlainRecord(context.runtime.direct)
      ? context.runtime.direct
      : undefined;
    const priorBaseResourceCpuTrace =
      priorDirectRuntime?.baseResourceV3CpuTrace;
    (
      context.runtime as unknown as {
        direct?: unknown;
      }
    ).direct = projectContinuousDirectRuntimeStatus(
      directState,
      usesDirectStrategy(context.config),
      context.marketBaseResourceCpuTrace ?? priorBaseResourceCpuTrace,
    );
  } else {
    const directSnapshotStatus = directAutomationSnapshotStatus(
      directState,
      Game.time,
    );
    const directSnapshot = directState.lastPlanningSnapshot;
    const directPendingByStatus = Object.values(
      directState.pendingDirectDeals,
    ).reduce<Record<string, number>>((summary, pending) => {
      summary[pending.status] = (summary[pending.status] || 0) + 1;
      return summary;
    }, {});
    const directExposure = directAutomationExposure(directState);
    if (directExposure.quarantinedCount > 0) {
      directPendingByStatus.quarantined = directExposure.quarantinedCount;
    }
    context.runtime.direct = {
      strategyActive: usesDirectStrategy(context.config),
      shadowConsecutiveCycles:
        directState.shadowQualification.consecutiveCycles,
      qualifiedAt: directState.shadowQualification.qualifiedAt,
      activationAuthorized:
        directState.shadowQualification.activationAuthorized,
      canary: directState.shadowQualification.canary,
      pendingCount: directExposure.pendingCount,
      pendingByStatus: directPendingByStatus,
      confirmedDealCount: directState.directConfirmedDealCount,
      pausedForReview: directState.directPausedForReview,
      migrationBlockedReason: directState.migrationBlockedReason,
      exposure: directExposure,
      snapshot:
        directSnapshot && directSnapshotStatus.age !== undefined
          ? {
              observedAt: directSnapshot.observedAt,
              age: directSnapshotStatus.age,
              maxAgeTicks: directSnapshotStatus.maxAgeTicks,
              fresh: directSnapshotStatus.fresh,
              configRevision: directSnapshot.configRevision,
              safetyFingerprint: directSnapshot.safetyFingerprint,
              canary: directSnapshot.canary,
              result: directSnapshot.result,
              structuralCandidateCount: directSnapshot.structuralCandidateCount,
              eligibleStructuralCandidateCount:
                directSnapshot.eligibleStructuralCandidateCount,
              buyBook: directSnapshot.buyBook,
              opportunity: directSnapshot.opportunity,
              manualBuyOrderCount: directSnapshot.manualBuyOrderCount,
              manualSellOrderCount: directSnapshot.manualSellOrderCount,
              zeroRemainingOwnOrderCount:
                directSnapshot.zeroRemainingOwnOrderCount,
              effectiveNetFloor: directSnapshot.effectiveNetFloor,
              effectiveEnergyShadowPrice:
                directSnapshot.effectiveEnergyShadowPrice,
              energyShadowObservedAt: directSnapshot.energyShadowObservedAt,
              energyShadowComponents: directSnapshot.energyShadowComponents,
              rejectedByReason: {
                ...directSnapshot.rejectedByReason,
              },
            }
          : undefined,
    };
  }
  for (const action of context.actions) {
    boundedPush(
      context.runtime.recentActions,
      `${Game.time}:${action}`,
      MAX_RECENT_ACTIONS,
    );
  }
  updateShadowCount(context, drain.phase);
}

function finalizeResult(
  context: RunContext,
  requestedMode: MarketSaleAutomationConfig["mode"],
  mode: MarketSaleAutomationConfig["mode"],
): MarketSaleAutomationResult {
  projectRuntime(context, requestedMode);
  return {
    requestedMode,
    effectiveMode: mode,
    phase: context.data.drain?.phase || "off",
    writes: context.writes,
    actions: [...context.actions],
    rejectedByReason: { ...context.rejectedByReason },
  };
}

function registerOperatorControls(): void {
  operatorGlobals.grantMarketSaleMutationLease = grantMarketSaleMutationLease;
  operatorGlobals.revokeMarketSaleMutationLease = revokeMarketSaleMutationLease;
  operatorGlobals.attestMarketSalePendingCreate = attestMarketSalePendingCreate;
  operatorGlobals.resolveMarketSalePendingCreateAbsence =
    resolveMarketSalePendingCreateAbsence;
  operatorGlobals.resolveMarketSaleExternalOrderMutation =
    resolveMarketSaleExternalOrderMutation;
  operatorGlobals.resolveMarketSaleOrderDisappearance =
    resolveMarketSaleOrderDisappearance;
  operatorGlobals.expandMarketSaleCanary = expandMarketSaleCanary;
  operatorGlobals.emergencyStopMarketSaleAutomation =
    emergencyStopMarketSaleAutomation;
  operatorGlobals.marketSaleAutomationStatus = marketSaleAutomationStatus;
  operatorGlobals.resolveMarketSaleDirectPending =
    resolveMarketSaleDirectPending;
  operatorGlobals.proposeMarketDirectContinuousPermit =
    proposeMarketDirectContinuousPermit;
  operatorGlobals.acceptMarketDirectContinuousPermit =
    acceptMarketDirectContinuousPermit;
  operatorGlobals.marketDirectContinuousStatus = marketDirectContinuousStatus;
  operatorGlobals.proposeMarketBaseResourcePermit =
    proposeMarketBaseResourcePermit;
  operatorGlobals.proposeMarketBaseResourcePolicyMigration =
    proposeMarketBaseResourcePolicyMigration;
  operatorGlobals.acceptMarketBaseResourcePermit =
    acceptMarketBaseResourcePermit;
  operatorGlobals.marketBaseResourceStatus = marketBaseResourceStatus;
}

export function runMarketSalePreflight(): MarketSaleAutomationResult {
  measureMarketSubPhase("latchAndControls", () => {
    enforceLegacyMarketSafetyLatch();
    registerOperatorControls();
  });
  const context = makeContext();
  if (!context.marketDomainActivityValid) {
    reject(context, "market_domain_activity_invalid");
  }
  for (const reason of context.config.invalidReasons) reject(context, reason);
  if (context.config.mode === "hybrid") {
    reject(context, "hybrid_not_implemented");
  }
  const baseResourceV3 = measureMarketSubPhase("v3Reconcile", () =>
    reconcileBaseResourceV3State(context),
  );
  const directState = context.data.directAutomation!;
  const v2DispatchConfig = frozenV2DispatchConfig(context.config);
  const inactiveMissingDirectState =
    structuralMarketSaleWriteBlocker(context.data, context.config) ===
      undefined &&
    isContinuousDirectState(directState) &&
    directState.migrationBlockedReason === "direct_state_missing";
  if (!inactiveMissingDirectState && !baseResourceV3.activeV3Successor) {
    mergeDirectResult(
      context,
      measureMarketSubPhase("directPreflight", () =>
        isContinuousDirectState(directState)
          ? runMarketDirectContinuousPreflight(directState, {
              tick: Game.time,
              config: v2DispatchConfig,
            })
          : runDirectAutomationPreflight(directState, {
              tick: Game.time,
              config: context.config,
            }),
      ),
    );
  }
  context.data.pendingDirectDeals = directState.pendingDirectDeals;
  const structuralWriteBlocker = structuralMarketSaleWriteBlocker(
    context.data,
    context.config,
  );
  if (structuralWriteBlocker) {
    if (!context.rejectedByReason[structuralWriteBlocker]) {
      reject(context, structuralWriteBlocker);
    }
    // 损坏的 intent/market-data 无法证明任何 Maker mutation 是否安全。
    // 仍投影保守 exposure/drain，但禁止 reconcile、retry 和 cancel 写入。
    updateDrain(context, "emergencyStop");
    return finalizeResult(context, context.config.mode, "emergencyStop");
  }
  measureMarketSubPhase("persistentReconcile", () => reconcilePersistentState(context));
  const makerForbidden = makerModePermanentlyForbidden(context.config);
  if (makerForbidden) {
    reject(context, "market_maker_hybrid_permanently_disabled");
  }
  const mode = makerForbidden ? "emergencyStop" : effectiveMode(context.config);
  if (mode === "direct" && !drainLegacyMakerExposureBeforeDirect(context)) {
    return finalizeResult(context, context.config.mode, mode);
  }
  drainIfRequired(context, mode);
  return finalizeResult(context, context.config.mode, mode);
}

export function runMarketSaleAutomation(
  input: MarketSaleAutomationInput = {},
): MarketSaleAutomationResult {
  measureMarketSubPhase("latchAndControls", () => {
    enforceLegacyMarketSafetyLatch();
    registerOperatorControls();
  });
  const context = makeContext();
  if (input.stagingAmount !== undefined) {
    context.stagingAmount = nonNegativeInteger(input.stagingAmount);
  }
  if (input.reservationAmount !== undefined) {
    context.reservationAmount = nonNegativeInteger(input.reservationAmount);
  }
  if (input.marketDomainActivityValid === false) {
    context.marketDomainActivityValid = false;
  }
  if (!context.marketDomainActivityValid) {
    reject(context, "market_domain_activity_invalid");
  }
  for (const reason of context.config.invalidReasons) reject(context, reason);
  if (context.config.mode === "hybrid") {
    reject(context, "hybrid_not_implemented");
  }
  const cpuGetUsed = Game.cpu?.getUsed;
  const baseResourceV3CpuStartedAt =
    typeof cpuGetUsed === "function" ? cpuGetUsed.call(Game.cpu) : Number.NaN;
  let baseResourceV3 = measureMarketSubPhase("v3Reconcile", () =>
    reconcileBaseResourceV3State(context),
  );
  const structuralWriteBlocker = structuralMarketSaleWriteBlocker(
    context.data,
    context.config,
  );
  if (structuralWriteBlocker) {
    reject(context, structuralWriteBlocker);
    updateDrain(context, "emergencyStop");
    return finalizeResult(context, context.config.mode, "emergencyStop");
  }
  measureMarketSubPhase("persistentReconcile", () => reconcilePersistentState(context));
  const candidates = input.candidates || [];
  const configuredMode = effectiveMode(context.config);
  const makerForbidden = makerModePermanentlyForbidden(context.config);
  if (makerForbidden) {
    reject(context, "market_maker_hybrid_permanently_disabled");
  }
  const protectionFailure =
    configuredMode === "maker"
      ? currentProtectionFailureReason(context, candidates)
      : undefined;
  if (protectionFailure) {
    context.runtime.safetyViolationCount += 1;
    reject(context, protectionFailure);
  }
  const continuingProtectionDrain =
    configuredMode === "maker" &&
    context.data.drain?.targetMode === "off" &&
    (context.data.drain.phase === "requested" ||
      context.data.drain.phase === "draining");
  const mode =
    makerForbidden || protectionFailure || continuingProtectionDrain
      ? "emergencyStop"
      : configuredMode;
  const planningCycleCurrent =
    Memory.runtime?.resourceControl?.updatedAt === Game.time;
  if (planningCycleCurrent && configuredMode === "maker") {
    // Preserve the more specific policy/floor rejection evidence on planning
    // ticks even when the current protection failure below also forces drain.
    revalidateManagedOrdersForPlanning(context, candidates);
  }
  if (mode === "direct" && !drainLegacyMakerExposureBeforeDirect(context)) {
    return finalizeResult(context, context.config.mode, mode);
  }
  drainIfRequired(context, mode);
  const directStrategy = usesDirectStrategy(context.config);
  const phase = context.data.drain?.phase;

  if (directStrategy) {
    if (planningCycleCurrent) {
      context.runtime.candidates = {};
      for (const candidate of candidates) {
        projectCandidate(
          context,
          candidate,
          directCandidateRejectionReasons(context, candidate),
        );
      }
    }
    const lifecyclePhaseReady =
      (context.config.mode === "shadow" && phase === "shadow") ||
      (context.config.mode === "direct" && phase === "direct");
    if (
      baseResourceV3.activeV3Successor &&
      input.marketBaseResourceTrustedFloorSuccessor
    ) {
      const adopted = adoptMarketBaseResourceTrustedFloorSuccessor(
        context,
        baseResourceV3,
        input.marketBaseResourceTrustedFloorSuccessor,
      );
      if ("reason" in adopted) {
        reject(
          context,
          `market_base_v3_pricing_successor_rejected:${adopted.reason}`,
        );
        context.shadowPlanComplete = false;
        updateDrain(context, mode);
        return finalizeResult(context, context.config.mode, mode);
      }
      baseResourceV3 = adopted.state;
    }
    const directState = context.data.directAutomation!;
    const v2DispatchConfig = frozenV2DispatchConfig(context.config);
    const v3PlanningState =
      baseResourceV3.activeV3Successor && baseResourceV3.state
        ? { ...baseResourceV3.state }
        : undefined;
    const v3PlanningReadinessRuntimeCapability = v3PlanningState
      ? advanceMarketBaseResourceReadinessRuntimeCapability(
          baseResourceV3.readinessRuntimeCapability,
          v3PlanningState,
          Game.time,
        )
      : undefined;
    const v3CanonicalRootBeforePlanning = context.data;
    const v3CanonicalStateBeforePlanning = baseResourceV3.state;
    const v3CanonicalLedgerRuntimeAnchorBeforePlanning =
      baseResourceV3.ledgerRuntimeAnchor;
    let preparedV3RootCommitted = false;
    let preparedV3CanonicalRoot: MarketSaleDataState | undefined;
    let preparedV3ReadinessRuntimeCapability:
      MarketBaseResourceReadinessRuntimeCapability | undefined;
    const unavailableV3RuntimeResult:
      MarketBaseResourceAutomationResult | undefined =
      baseResourceV3.activeV3Successor &&
      v3PlanningState &&
      !v3PlanningReadinessRuntimeCapability
        ? {
            actions: [],
            rejectedByReason: {
              market_base_readiness_runtime_capability_unavailable: 1,
            },
            writes: 0,
            planComplete: false,
            state: v3PlanningState,
          }
        : undefined;
    const directResult = baseResourceV3.activeV3Successor
      ? (unavailableV3RuntimeResult ??
        runMarketBaseResourceAutomation(
          v3PlanningState!,
          {
            tick: Game.time,
            cpuStartedAt: baseResourceV3CpuStartedAt,
            readinessRuntimeCapability: v3PlanningReadinessRuntimeCapability,
            fullPlanningTick: planningCycleCurrent && lifecyclePhaseReady,
            config: context.config,
            readCandidates: () =>
              toMarketBaseResourceRuntimeCandidates(
                input.readMarketBaseResourceCandidates
                  ? input.readMarketBaseResourceCandidates()
                  : candidates,
              ),
            makerExposurePresent: makerExposurePresent(context),
            emergencyStop:
              mode === "emergencyStop" ||
              (context.config.mode === "direct" && phase !== "direct"),
          },
          {
            ...defaultMarketBaseResourceRuntimeDependencies,
            readLedgerRuntimeAnchor: (planningState) => {
              if (
                !v3CanonicalStateBeforePlanning ||
                !v3CanonicalLedgerRuntimeAnchorBeforePlanning ||
                Memory.data?.marketSaleAutomation !==
                  (v3CanonicalRootBeforePlanning as unknown as NonNullable<
                    NonNullable<Memory["data"]>["marketSaleAutomation"]
                  >) ||
                context.data !== v3CanonicalRootBeforePlanning
              ) {
                return undefined;
              }
              if (
                planningState.ledger !==
                  v3CanonicalStateBeforePlanning.ledger ||
                planningState.permitChain !==
                  v3CanonicalStateBeforePlanning.permitChain
              ) {
                return undefined;
              }
              // reconcile 已认证双 activation anchor；这里仅做 root CAS 与
              // exact object identity 绑定，完整 ledger gate 由 inner session
              // 在同一 CPU 预算内执行一次。
              return v3CanonicalLedgerRuntimeAnchorBeforePlanning;
            },
            commitPreparedState: (
              preparedState,
              successorLedgerAnchor,
              successorRuntimeCapability,
            ) => {
              if (!v3CanonicalStateBeforePlanning) {
                return false;
              }
              const committed = commitPreparedMarketBaseResourceState(
                context,
                v3CanonicalRootBeforePlanning,
                v3CanonicalStateBeforePlanning,
                preparedState,
                successorLedgerAnchor,
                successorRuntimeCapability,
              );
              if (!committed) {
                return false;
              }
              preparedV3RootCommitted = true;
              preparedV3CanonicalRoot = committed.data;
              preparedV3ReadinessRuntimeCapability =
                committed.runtimeCapability;
              return true;
            },
            validatePreparedCanonicalRoot: () =>
              validatePreparedMarketBaseResourceCanonicalRoot(
                context,
                preparedV3CanonicalRoot,
                preparedV3ReadinessRuntimeCapability,
              ),
          },
        ))
      : isContinuousDirectState(directState)
        ? runMarketDirectContinuousPlanning(directState, {
            tick: Game.time,
            fullPlanningTick: planningCycleCurrent && lifecyclePhaseReady,
            config: v2DispatchConfig,
            candidates: toContinuousRuntimeCandidates(
              context,
              candidates,
              v2DispatchConfig,
            ),
            makerExposurePresent: makerExposurePresent(context),
            emergencyStop:
              mode === "emergencyStop" ||
              (context.config.mode === "direct" && phase !== "direct"),
          })
        : runDirectAutomationPlanning(directState, {
            tick: Game.time,
            fullPlanningTick: planningCycleCurrent && lifecyclePhaseReady,
            config: context.config,
            candidates: toDirectRuntimeCandidates(context, candidates),
            makerExposurePresent: makerExposurePresent(context),
          });
    const v3DirectResult = isMarketBaseResourceAutomationResult(directResult)
      ? directResult
      : undefined;
    // inner 返回对象只在此处读取一次。后续私有 root 注册与 fresh CPU
    // callback 都不得再从可变返回对象读取 CPU 证据，避免 TOCTOU 重开门。
    const v3DirectCpuTraceSnapshot = v3DirectResult?.cpuTrace
      ? Object.freeze({
          observedAt: v3DirectResult.cpuTrace.observedAt,
          cpuAfterOuterSession:
            v3DirectResult.cpuTrace.cpuAfterOuterSession,
          cpuAfterScopeCore: v3DirectResult.cpuTrace.cpuAfterScopeCore,
          cpuAfterMarketFacts: v3DirectResult.cpuTrace.cpuAfterMarketFacts,
          cpuAfterShadowBatch: v3DirectResult.cpuTrace.cpuAfterShadowBatch,
          cpuAfterInnerApply: v3DirectResult.cpuTrace.cpuAfterInnerApply,
          cpuCutPhase: v3DirectResult.cpuTrace.cpuCutPhase,
          marketFactsDisposition:
            v3DirectResult.cpuTrace.marketFactsDisposition,
        })
      : undefined;
    const v3DirectCpuRawHighWaterSnapshot =
      v3DirectResult?.cpuRawHighWater;
    context.shadowPlanComplete = directResult.planComplete;
    if (
      "cpuTrace" in directResult &&
      directResult.cpuTrace &&
      planningCycleCurrent &&
      lifecyclePhaseReady
    ) {
      context.marketBaseResourceCpuTrace = {
        ...directResult.cpuTrace,
      };
    }
    mergeDirectResult(context, directResult);
    if (
      preparedV3RootCommitted &&
      preparedV3CanonicalRoot &&
      v3DirectResult
    ) {
      const returnedCommitted = commitReturnedMarketBaseResourceState(
        context,
        preparedV3CanonicalRoot,
        v3DirectResult.state,
        v3DirectResult.ledgerRuntimeAnchor,
        v3DirectResult.readinessRuntimeCapability ??
          preparedV3ReadinessRuntimeCapability,
      );
      if (!returnedCommitted) {
        context.shadowPlanComplete = false;
        reject(context, "market_base_v3_returned_commit_failed");
      }
    }
    const v3ReturnedCanonicalConflict = Boolean(
      baseResourceV3.activeV3Successor &&
      !preparedV3RootCommitted &&
      (Memory.data?.marketSaleAutomation !==
        (v3CanonicalRootBeforePlanning as unknown as NonNullable<
          NonNullable<Memory["data"]>["marketSaleAutomation"]
        >) ||
        context.data !== v3CanonicalRootBeforePlanning),
    );
    if (v3ReturnedCanonicalConflict) {
      reject(context, "market_base_v3_returned_commit_conflict");
    }
    if (
      baseResourceV3.activeV3Successor &&
      !preparedV3RootCommitted &&
      isContinuousDirectState(directState) &&
      v3CanonicalStateBeforePlanning &&
      v3DirectCpuTraceSnapshot &&
      planningCycleCurrent &&
      lifecyclePhaseReady
    ) {
      if (!v3ReturnedCanonicalConflict) {
        type ReturnedRootCandidate = {
          data: MarketSaleDataState;
          state: MarketBaseResourceV3RuntimeState;
        };
        const prepareReturnedRootCandidate = (
          candidateState: MarketBaseResourceV3RuntimeState,
          ledgerRuntimeAnchor:
            | MarketBaseResourceLedgerRuntimeAnchor
            | undefined,
          runtimeCapability:
            | MarketBaseResourceReadinessRuntimeCapability
            | undefined,
        ): ReturnedRootCandidate | undefined => {
          const activation = marketBaseResourceActivationState(
            context.data,
            baseResourceV3.state,
          );
          const runtimeAuthenticated =
            ledgerRuntimeAnchor &&
            validateMarketBaseResourceReadinessRuntimeCapability(
              runtimeCapability,
              candidateState,
              Game.time,
              ledgerRuntimeAnchor,
            );
          const nextTrustedFloors = synchronizeMarketBaseTrustedFloors(
            context.data.trustedFloors,
            candidateState.pricingRatchet!,
            Game.time,
          );
          const nextAnchor =
            activation.latched &&
            activation.anchor &&
            candidateState.scope &&
            ledgerRuntimeAnchor &&
            runtimeAuthenticated
              ? advanceMarketBaseResourceActivationAnchor(
                  activation.anchor,
                  candidateState,
                  nextTrustedFloors,
                  Game.time,
                  ledgerRuntimeAnchor,
                )
              : undefined;
          if (!nextAnchor) return undefined;
          const nextDirect = {
            ...directState,
            baseResourceV3: candidateState,
          };
          const nextData: MarketSaleDataState = {
            ...context.data,
            trustedFloors: nextTrustedFloors,
            directAutomation: nextDirect,
            pendingDirectDeals: nextDirect.pendingDirectDeals,
            baseResourceV3ActivationAnchor: nextAnchor,
            baseResourceV3ActivationAnchorMirror:
              cloneMarketBaseOperatorValue(nextAnchor),
          };
          const registered = registerMarketBaseResourceCanonicalRoot(
            nextData,
            context.config.mode,
            runtimeCapability,
          );
          if (
            (!candidateState.readinessAuthorization &&
              registered.reason !== "missing") ||
            (candidateState.readinessAuthorization && !registered.ok)
          ) {
            return undefined;
          }
          return { data: nextData, state: candidateState };
        };

        const returnedStateChanged =
          marketBaseResourceCanonicalStateChanged(
            v3CanonicalStateBeforePlanning,
            v3DirectResult.state,
          );
        const returnedLedgerRuntimeAnchor =
          v3DirectResult.ledgerRuntimeAnchor;
        const returnedRuntimeCapability =
          v3DirectResult.readinessRuntimeCapability;
        const fallbackCapability = v3DirectResult.cpuFallbackCapability;
        const fallbackCommitRequired =
          marketBaseResourceCpuFallbackRequiresCanonicalCommit(
            fallbackCapability,
            v3CanonicalStateBeforePlanning,
            Game.time,
          );
        const fullRoot = returnedStateChanged
          ? prepareReturnedRootCandidate(
              v3DirectResult.state,
              returnedLedgerRuntimeAnchor,
              returnedRuntimeCapability,
            )
          : undefined;
        const fullRootPreparationFailed =
          returnedStateChanged && !fullRoot;
        if (fullRootPreparationFailed) {
          context.shadowPlanComplete = false;
          reject(context, "market_base_v3_returned_anchor_missing_or_invalid");
        }
        let fallback: MarketBaseResourceCpuFallbackResult | undefined;
        let fallbackRoot: ReturnedRootCandidate | undefined;
        if (fallbackCommitRequired) {
          const fallbackForFullRootFailure =
            fullRootPreparationFailed &&
            v3DirectCpuTraceSnapshot.cpuCutPhase === null;
          const fallbackBlocker = fallbackForFullRootFailure
            ? ("market_base_v3_returned_anchor_missing_or_invalid" as const)
            : ("market_base_cpu_ceiling_exceeded" as const);
          fallback = materializeMarketBaseResourceCpuFallback(
            fallbackCapability,
            fallbackForFullRootFailure
              ? v3DirectCpuTraceSnapshot
              : {
                  ...v3DirectCpuTraceSnapshot,
                  cpuCutPhase:
                    v3DirectCpuTraceSnapshot.cpuCutPhase ?? "outer_precommit",
                },
            fallbackBlocker,
          );
          fallbackRoot = fallback
            ? prepareReturnedRootCandidate(
                fallback.state,
                fallback.ledgerRuntimeAnchor,
                fallback.readinessRuntimeCapability,
              )
            : undefined;
          if (!fallback || !fallbackRoot) {
            context.shadowPlanComplete = false;
            reject(
              context,
              "market_base_v3_cpu_fallback_prepare_failed",
            );
          }
        }
        const cpuGetUsedBeforeCommit = Game.cpu?.getUsed;
        const cpuObservedBeforeCommit =
          typeof cpuGetUsedBeforeCommit === "function"
            ? cpuGetUsedBeforeCommit.call(Game.cpu)
            : Number.NaN;
        const outerCpu = observeMarketBaseResourceOuterPrecommitCpu(
          v3DirectCpuTraceSnapshot,
          baseResourceV3CpuStartedAt,
          cpuObservedBeforeCommit,
          // V3 inner 必须同时返回本调用栈内不可回拨的 raw high-water；
          // 缺失视为 NaN，禁止仅凭有界 trace 重新打开最终提交门。
          v3DirectCpuRawHighWaterSnapshot ?? Number.NaN,
        );
        context.marketBaseResourceCpuTrace = outerCpu.trace;
        const sourceRootStillExact =
          Memory.data?.marketSaleAutomation ===
            (v3CanonicalRootBeforePlanning as unknown as NonNullable<
              NonNullable<Memory["data"]>["marketSaleAutomation"]
            >) && context.data === v3CanonicalRootBeforePlanning;
        if (!sourceRootStillExact) {
          context.shadowPlanComplete = false;
          reject(context, "market_base_v3_returned_commit_conflict");
        } else if (outerCpu.exceeded) {
          context.shadowPlanComplete = false;
          reject(context, "market_base_cpu_ceiling_exceeded");
          if (fallbackCommitRequired && fallbackRoot) {
            if (
              !commitExactContextMarketSaleData(
                context,
                v3CanonicalRootBeforePlanning,
                fallbackRoot.data,
              )
            ) {
              context.shadowPlanComplete = false;
              reject(context, "market_base_v3_cpu_fallback_commit_failed");
            }
          }
        } else if (returnedStateChanged && fullRoot) {
          if (
            !commitExactContextMarketSaleData(
              context,
              v3CanonicalRootBeforePlanning,
              fullRoot.data,
            )
          ) {
            context.shadowPlanComplete = false;
            reject(context, "market_base_v3_returned_commit_failed");
          }
        } else if (fallbackCommitRequired && fallbackRoot) {
          // full root 注册失败不应压掉已认证的 lane-local negative reset。
          // 在 CPU 健康时也只提交独立 fallback，绝不带入 cursor/ratchet
          // 或其它未认证的 full-state 进度。
          context.shadowPlanComplete = false;
          if (
            !commitExactContextMarketSaleData(
              context,
              v3CanonicalRootBeforePlanning,
              fallbackRoot.data,
            )
          ) {
            reject(context, "market_base_v3_cpu_fallback_commit_failed");
          }
        }
      }
    }
    if (!preparedV3RootCommitted) {
      context.data.pendingDirectDeals =
        context.data.directAutomation?.pendingDirectDeals ??
        directState.pendingDirectDeals;
    }
    updateDrain(context, mode);
    return finalizeResult(context, context.config.mode, mode);
  }

  if (planningCycleCurrent) {
    context.runtime.candidates = {};
  }

  context.shadowPlanComplete = false;
  for (const candidate of candidates) {
    projectCandidate(
      context,
      candidate,
      candidateRejectionReasons(
        context,
        candidate,
        maintenanceCandidateOptions(context, candidate, phase),
      ),
    );
  }

  if (
    planningCycleCurrent &&
    (phase === "maker" || phase === "hybrid" || phase === "shadow") &&
    context.config.validForPlanning
  ) {
    const selected = selectAndLockCanary(
      context,
      candidates,
      phase === "shadow",
    );
    context.shadowPlanComplete =
      phase === "shadow" &&
      candidates.length > 0 &&
      selected !== undefined &&
      context.data.canaryLock?.roomName === selected.roomName &&
      context.data.canaryLock?.resourceType === selected.resourceType;
    if (selected) {
      const reasons = candidateRejectionReasons(
        context,
        selected,
        maintenanceCandidateOptions(context, selected, phase),
      );
      if (reasons.length > 0) {
        const hasExposure = Object.values(context.data.managedOrders).some(
          (order) =>
            order.roomName === selected.roomName &&
            order.resourceType === selected.resourceType,
        );
        if (hasExposure && phase !== "shadow") {
          for (const order of Object.values(context.data.managedOrders)) {
            if (
              order.roomName === selected.roomName &&
              order.resourceType === selected.resourceType
            ) {
              requestCancel(context, order.orderId);
            }
          }
        }
      } else if (phase === "maker" || phase === "hybrid") {
        createMakerOrder(context, selected);
      }
    } else if (candidates.length === 0) {
      reject(context, "protection_or_price_input_missing");
    }
  }

  updateDrain(context, mode);
  return finalizeResult(context, context.config.mode, mode);
}

export function resolveMarketSaleDirectPending(
  evidence: OperatorDirectPendingEvidence,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  if (isContinuousDirectState(data.directAutomation)) {
    return {
      ok: false,
      error: "legacy_direct_pending_resolver_rejects_v2",
    };
  }
  if (
    data.directAutomation?.migrationBlockedReason &&
    data.directAutomation.migrationBlockedReason !==
      "direct_qualification_state_invalid"
  ) {
    return {
      ok: false,
      error: data.directAutomation.migrationBlockedReason,
    };
  }
  if (!evidence || typeof evidence !== "object") {
    return { ok: false, error: "direct_operator_evidence_required" };
  }
  const result = resolveDirectAutomationPending(
    data.directAutomation!,
    evidence,
    Game.time,
  );
  data.pendingDirectDeals = data.directAutomation!.pendingDirectDeals;
  if (result.ok) {
    appendAudit(data, {
      action: result.duplicate
        ? "direct_pending_operator_duplicate"
        : "direct_pending_operator_resolved",
      requestId: evidence.requestId,
    });
  }
  return result;
}

function commitContinuousDirectState(
  data: MarketSaleDataState,
  state: MarketDirectContinuousAutomationState,
): void {
  commitMarketSaleDataSnapshot({
    ...data,
    pendingDirectDeals: state.pendingDirectDeals,
    directAutomation: state,
  });
}

function commitMarketSaleDataSnapshot(data: MarketSaleDataState): void {
  Memory.data!.marketSaleAutomation = data as unknown as NonNullable<
    NonNullable<Memory["data"]>["marketSaleAutomation"]
  >;
}

function commitContextMarketSaleData(
  context: RunContext,
  data: MarketSaleDataState,
): void {
  commitMarketSaleDataSnapshot(data);
  context.data = data;
}

function commitExactContextMarketSaleData(
  context: RunContext,
  expectedSource: MarketSaleDataState,
  candidate: MarketSaleDataState,
): boolean {
  const expectedStored = expectedSource as unknown as NonNullable<
    NonNullable<Memory["data"]>["marketSaleAutomation"]
  >;
  const candidateStored = candidate as unknown as NonNullable<
    NonNullable<Memory["data"]>["marketSaleAutomation"]
  >;
  if (
    context.data !== expectedSource ||
    Memory.data?.marketSaleAutomation !== expectedStored
  ) {
    return false;
  }
  try {
    Memory.data!.marketSaleAutomation = candidateStored;
  } catch {
    // 绝不以“回滚 source”覆盖 setter 安装的未知并发 root。若 assignment
    // 已精确落下 candidate 后才抛错，只同步 context 以避免同 tick 分叉，
    // 但仍返回 false 让调用方报告 commit failure。
    if (Memory.data?.marketSaleAutomation === candidateStored) {
      context.data = candidate;
    }
    return false;
  }
  if (Memory.data?.marketSaleAutomation !== candidateStored) {
    // silent reject 保留 source；substitution 则保留 concurrent root。
    // 两者都不再执行第二次写入。
    return false;
  }
  context.data = candidate;
  return true;
}

function registerMarketBaseResourceCanonicalRoot(
  data: MarketSaleDataState,
  mode: unknown,
  capability: MarketBaseResourceReadinessRuntimeCapability | undefined,
): ReturnType<
  typeof registerMarketBaseResourceCanonicalReadinessRuntimeCapability
> {
  const read = registerMarketBaseResourceCanonicalReadinessRuntimeCapability({
    marketSaleRoot: data,
    marketMode: mode,
    currentTick: Game.time,
    runtimeCapability: capability,
  });
  const direct = data.directAutomation;
  const state = isContinuousDirectState(direct)
    ? direct.baseResourceV3
    : undefined;
  const activationAnchor = data.baseResourceV3ActivationAnchor;
  const activationAnchorMirror = data.baseResourceV3ActivationAnchorMirror;
  if (
    (read.ok || read.reason === "missing") &&
    capability &&
    isContinuousDirectState(direct) &&
    state &&
    activationAnchor &&
    activationAnchorMirror
  ) {
    marketBaseResourceCanonicalRootProvenance.set(data, {
      tick: Game.time,
      directAutomation: direct,
      state,
      activationAnchor,
      activationAnchorMirror,
      trustedFloors: data.trustedFloors,
      ledgerRuntimeAnchor: activationAnchor.ledger,
      runtimeCapability: capability,
    });
    registerMarketBaseResourceCanonicalRootThisTick(data);
  }
  return read;
}

function adoptMarketBaseResourceTrustedFloorSuccessor(
  context: RunContext,
  current: ReturnType<typeof reconcileBaseResourceV3State>,
  proposal: MarketBaseResourceTrustedFloorSuccessorInput,
):
  | {
      ok: true;
      state: ReturnType<typeof reconcileBaseResourceV3State>;
    }
  | { ok: false; reason: string } {
  const sourceRoot = context.data;
  if (
    !current.activeV3Successor ||
    !current.state ||
    !current.ledgerRuntimeAnchor ||
    !current.readinessRuntimeCapability ||
    Memory.data?.marketSaleAutomation !==
      (sourceRoot as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >)
  ) {
    return { ok: false, reason: "source_root_unavailable" };
  }
  const resolved = resolveMarketBaseTrustedFloorSuccessor(
    sourceRoot.trustedFloors,
    proposal,
    Game.time,
  );
  if ("reason" in resolved) {
    return { ok: false, reason: resolved.reason };
  }
  if (resolved.trustedFloors === sourceRoot.trustedFloors) {
    return { ok: true, state: current };
  }
  const sourceState = current.state;
  const activation = marketBaseResourceActivationState(
    sourceRoot,
    sourceState,
  );
  const permit = currentMarketBaseV3Permit(sourceState);
  if (
    !activation.latched ||
    activation.blocker ||
    !activation.anchor ||
    !permit ||
    !sourceState.pricingRatchet
  ) {
    return { ok: false, reason: "activation_unavailable" };
  }
  let proposedPricingRatchet: MarketBaseResourcePricingRatchetState;
  try {
    proposedPricingRatchet = buildMarketBaseResourcePricingRatchetState({
      initializedAt: sourceState.pricingRatchet.initializedAt,
      entries: MARKET_BASE_RESOURCE_CATALOG.map((resource) => {
        const entry = resolved.trustedFloors[resource];
        if (!entry) {
          throw new TypeError(`trusted_floor_missing:${resource}`);
        }
        return {
          resource,
          value: entry.value,
          marketDate: entry.marketDate,
        };
      }),
    });
  } catch {
    return { ok: false, reason: "pricing_ratchet_invalid" };
  }
  if (!validateMarketBaseResourcePricingRatchetState(
    proposedPricingRatchet,
    permit,
  )) {
    return { ok: false, reason: "pricing_ratchet_permit_mismatch" };
  }
  const nextPricingRatchet =
    proposedPricingRatchet.fingerprint ===
    sourceState.pricingRatchet.fingerprint
      ? sourceState.pricingRatchet
      : proposedPricingRatchet;
  const nextState: MarketBaseResourceV3RuntimeState =
    nextPricingRatchet === sourceState.pricingRatchet
      ? sourceState
      : {
          ...sourceState,
          pricingRatchet: nextPricingRatchet,
        };
  const nextRuntimeCapability =
    advanceMarketBaseResourceReadinessRuntimeCapabilityFromRoot(
      sourceRoot,
      nextState,
      Game.time,
    );
  if (
    !nextRuntimeCapability ||
    !validateMarketBaseResourceReadinessRuntimeCapability(
      nextRuntimeCapability,
      nextState,
      Game.time,
      current.ledgerRuntimeAnchor,
    )
  ) {
    return { ok: false, reason: "runtime_capability_invalid" };
  }
  let nextAnchor: MarketBaseResourceActivationAnchor;
  try {
    nextAnchor = advanceMarketBaseResourceActivationAnchor(
      activation.anchor,
      nextState,
      resolved.trustedFloors,
      Game.time,
      current.ledgerRuntimeAnchor,
    );
  } catch {
    return { ok: false, reason: "activation_anchor_advance_failed" };
  }
  if (
    validateMarketBaseNestedActivationState(
      nextState,
      nextAnchor,
      resolved.trustedFloors,
      {
        runtimeOnly: true,
        runtimeCapability: nextRuntimeCapability,
      },
    )
  ) {
    return { ok: false, reason: "successor_validation_failed" };
  }
  const sourceDirect = sourceRoot.directAutomation;
  if (!isContinuousDirectState(sourceDirect)) {
    return { ok: false, reason: "direct_state_invalid" };
  }
  const nextDirect: MarketDirectContinuousAutomationState = {
    ...sourceDirect,
    baseResourceV3: nextState,
  };
  const nextData: MarketSaleDataState = {
    ...sourceRoot,
    trustedFloors: resolved.trustedFloors,
    directAutomation: nextDirect,
    pendingDirectDeals: nextDirect.pendingDirectDeals,
    baseResourceV3ActivationAnchor: nextAnchor,
    baseResourceV3ActivationAnchorMirror:
      cloneMarketBaseOperatorValue(nextAnchor),
  };
  const registered = registerMarketBaseResourceCanonicalRoot(
    nextData,
    "direct",
    nextRuntimeCapability,
  );
  if (
    (!nextState.readinessAuthorization && registered.reason !== "missing") ||
    (nextState.readinessAuthorization && !registered.ok)
  ) {
    return { ok: false, reason: "canonical_register_failed" };
  }
  const stored = nextData as unknown as NonNullable<
    NonNullable<Memory["data"]>["marketSaleAutomation"]
  >;
  try {
    if (
      Memory.data?.marketSaleAutomation !==
      (sourceRoot as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >)
    ) {
      return { ok: false, reason: "source_root_changed" };
    }
    Memory.data!.marketSaleAutomation = stored;
  } catch {
    return { ok: false, reason: "canonical_commit_failed" };
  }
  if (Memory.data?.marketSaleAutomation !== stored) {
    return { ok: false, reason: "canonical_commit_rejected" };
  }
  context.data = nextData;
  return {
    ok: true,
    state: {
      activeV3Successor: true,
      state: nextState,
      ledgerRuntimeAnchor: nextAnchor.ledger,
      readinessRuntimeCapability: nextRuntimeCapability,
    },
  };
}

/**
 * prepared WAL 落盘后到唯一 deal 调用前的 outer exact-root capability。
 * 这里仅接受本模块同 tick 私有 provenance 登记过的根；serialized clone、
 * sibling blocker 注入、双锚/可信底价/direct/state 替换或配置回拨都会失配。
 */
function validatePreparedMarketBaseResourceCanonicalRoot(
  context: RunContext,
  data: MarketSaleDataState | undefined,
  capability: MarketBaseResourceReadinessRuntimeCapability | undefined,
): boolean {
  if (!data || !capability) return false;
  if (
    Memory.data?.marketSaleAutomation !==
      (data as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >) ||
    context.data !== data ||
    data.baseResourceV3ActivationBlocker !== undefined ||
    !isRegisteredMarketBaseResourceCanonicalRootThisTick(data)
  ) {
    return false;
  }
  const direct = data.directAutomation;
  const state = isContinuousDirectState(direct)
    ? direct.baseResourceV3
    : undefined;
  const provenance = marketBaseResourceCanonicalRootProvenance.get(data);
  const liveConfig = resolveMarketSaleAutomationConfig();
  if (
    !isContinuousDirectState(direct) ||
    !state ||
    liveConfig.mode !== "direct" ||
    liveConfig.directCapability !== "continuous-v3" ||
    marketBaseResourceV3ConfigMismatchReasons(liveConfig).length > 0 ||
    data.pendingDirectDeals !== direct.pendingDirectDeals ||
    !provenance ||
    provenance.tick !== Game.time ||
    provenance.directAutomation !== direct ||
    provenance.state !== state ||
    provenance.activationAnchor !== data.baseResourceV3ActivationAnchor ||
    provenance.activationAnchorMirror !==
      data.baseResourceV3ActivationAnchorMirror ||
    provenance.trustedFloors !== data.trustedFloors ||
    provenance.runtimeCapability !== capability ||
    !Object.isFrozen(direct) ||
    !Object.isFrozen(state) ||
    !Object.isFrozen(provenance.activationAnchor) ||
    !Object.isFrozen(provenance.activationAnchorMirror) ||
    !Object.isFrozen(provenance.trustedFloors)
  ) {
    return false;
  }
  return deriveMarketBaseResourceCanonicalReadinessAuthorization(
    data,
    "direct",
    Game.time,
  ).ok;
}

/**
 * V3 deal 的 prepare WAL 必须和外层不可回退 anchor 同一次 root replacement
 * 落盘。preparedState 会在 callback 返回后继续被 runtime 修改，因此这里安装
 * 一个独立深快照，绝不能把同一对象引用挂入 Memory。
 *
 * 返回 undefined 表示在 canonical assignment 前校验/构造失败；函数一旦完成
 * assignment，之后只做不会抛错的本地引用更新。
 */
function commitPreparedMarketBaseResourceState(
  context: RunContext,
  expectedCanonicalRoot: MarketSaleDataState,
  sourceState: MarketBaseResourceV3RuntimeState,
  preparedState: MarketBaseResourceV3RuntimeState,
  successorLedgerAnchor: MarketBaseResourceLedgerRuntimeAnchor,
  successorRuntimeCapability:
    MarketBaseResourceReadinessRuntimeCapability | undefined,
):
  | {
      data: MarketSaleDataState;
      runtimeCapability: MarketBaseResourceReadinessRuntimeCapability;
    }
  | undefined {
  if (
    Memory.data?.marketSaleAutomation !==
      (expectedCanonicalRoot as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >) ||
    context.data !== expectedCanonicalRoot
  ) {
    return undefined;
  }
  const direct = expectedCanonicalRoot.directAutomation;
  if (!isContinuousDirectState(direct)) {
    return undefined;
  }
  const activation = marketBaseResourceActivationState(
    expectedCanonicalRoot,
    sourceState,
  );
  if (!activation.latched || activation.blocker || !activation.anchor) {
    return undefined;
  }
  const sourceRuntimeCapability =
    advanceMarketBaseResourceReadinessRuntimeCapabilityFromRoot(
      expectedCanonicalRoot,
      sourceState,
      Game.time,
    );
  if (!sourceRuntimeCapability) {
    return undefined;
  }
  const sourceBlocker = validateMarketBaseNestedActivationState(
    sourceState,
    activation.anchor,
    expectedCanonicalRoot.trustedFloors,
    {
      runtimeOnly: true,
      runtimeCapability: sourceRuntimeCapability,
    },
  );
  const legacyV2Blocker = validatePostCutoverLegacyV2Quiescence(
    expectedCanonicalRoot,
    direct,
    sourceState,
    activation.anchor,
  );
  if (sourceBlocker || legacyV2Blocker) {
    return undefined;
  }

  const snapshot: MarketBaseResourceV3RuntimeState = {
    ...preparedState,
  };
  const snapshotRuntimeCapability =
    advanceMarketBaseResourceReadinessRuntimeCapability(
      successorRuntimeCapability,
      snapshot,
      Game.time,
    );
  if (
    snapshot.cutoverLatched !== true ||
    !snapshot.scope ||
    !snapshot.permitChain ||
    !snapshot.ledger ||
    snapshot.permitChain.currentPermitId !==
      sourceState.permitChain?.currentPermitId ||
    snapshot.permitChain.permitChainHead !==
      sourceState.permitChain?.permitChainHead ||
    snapshot.scope.rosterFingerprint !== sourceState.scope?.rosterFingerprint ||
    snapshot.scope.laneSetFingerprint !==
      sourceState.scope?.laneSetFingerprint ||
    !snapshotRuntimeCapability ||
    !validateMarketBaseResourceReadinessRuntimeCapability(
      snapshotRuntimeCapability,
      snapshot,
      Game.time,
      successorLedgerAnchor,
    )
  ) {
    return undefined;
  }
  const lifecycleBlocker = validateMarketBaseScopeLifecycleEvidence(
    snapshot.scope,
  );
  if (
    lifecycleBlocker ||
    !validateMarketBaseResourcePricingRatchetState(
      snapshot.pricingRatchet,
      currentMarketBaseV3Permit(snapshot),
    )
  ) {
    return undefined;
  }

  const nextTrustedFloors = synchronizeMarketBaseTrustedFloors(
    expectedCanonicalRoot.trustedFloors,
    snapshot.pricingRatchet!,
    Game.time,
  );
  const nextAnchor = advanceMarketBaseResourceActivationAnchor(
    activation.anchor,
    snapshot,
    nextTrustedFloors,
    Game.time,
    successorLedgerAnchor,
  );
  if (
    validateMarketBaseNestedActivationState(
      snapshot,
      nextAnchor,
      nextTrustedFloors,
      {
        runtimeOnly: true,
        runtimeCapability: snapshotRuntimeCapability,
      },
    )
  ) {
    return undefined;
  }
  const nextDirect: MarketDirectContinuousAutomationState = {
    ...direct,
    baseResourceV3: snapshot,
  };
  const nextData: MarketSaleDataState = {
    ...expectedCanonicalRoot,
    trustedFloors: nextTrustedFloors,
    directAutomation: nextDirect,
    pendingDirectDeals: nextDirect.pendingDirectDeals,
    baseResourceV3ActivationAnchor: nextAnchor,
    baseResourceV3ActivationAnchorMirror:
      cloneMarketBaseOperatorValue(nextAnchor),
  };
  const registered = registerMarketBaseResourceCanonicalRoot(
    nextData,
    "direct",
    snapshotRuntimeCapability,
  );
  if (
    !snapshotRuntimeCapability ||
    (!snapshot.readinessAuthorization && registered.reason !== "missing") ||
    (snapshot.readinessAuthorization && !registered.ok)
  ) {
    return undefined;
  }
  const stored = nextData as unknown as NonNullable<
    NonNullable<Memory["data"]>["marketSaleAutomation"]
  >;

  // state + successor anchor 只能作为同一 canonical root replacement 落盘。
  // setter 若抛错或静默拒绝替换，尽力恢复 source root；无论如何都不能
  // 更新 context 后继续 claim/deal。
  try {
    Memory.data!.marketSaleAutomation = stored;
  } catch {
    if (
      Memory.data?.marketSaleAutomation !==
      (expectedCanonicalRoot as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >)
    ) {
      try {
        Memory.data!.marketSaleAutomation =
          expectedCanonicalRoot as unknown as NonNullable<
            NonNullable<Memory["data"]>["marketSaleAutomation"]
          >;
      } catch {
        // 外部 setter 已破坏 canonical assignment 语义；保持 fail closed。
      }
    }
    return undefined;
  }
  if (Memory.data?.marketSaleAutomation !== stored) {
    try {
      Memory.data!.marketSaleAutomation =
        expectedCanonicalRoot as unknown as NonNullable<
          NonNullable<Memory["data"]>["marketSaleAutomation"]
        >;
    } catch {
      // 同上：不更新 context，不授权 claim/deal。
    }
    return undefined;
  }
  context.data = nextData;
  return {
    data: nextData,
    runtimeCapability: snapshotRuntimeCapability,
  };
}

function marketBaseReturnedLedgerDominatesPrepared(
  prepared: MarketBaseResourceV3RuntimeState,
  returned: MarketBaseResourceV3RuntimeState,
): boolean {
  if (
    !prepared.permitChain ||
    !prepared.ledger ||
    !returned.permitChain ||
    !returned.ledger ||
    prepared.permitChain !== returned.permitChain ||
    returned.ledger.finalizedAttemptSeq < prepared.ledger.finalizedAttemptSeq
  ) {
    return false;
  }
  const pending = prepared.ledger.pending;
  if (!pending) return true;
  if (
    returned.ledger.pending &&
    returned.ledger.pending.attemptSeq === pending.attemptSeq &&
    returned.ledger.pending.frozenEvidenceHash === pending.frozenEvidenceHash &&
    returned.ledger.pending.evidenceKeyHint === pending.evidenceKeyHint
  ) {
    return true;
  }
  return (
    returned.ledger.pending === undefined &&
    returned.ledger.finalizedAttemptSeq >= pending.attemptSeq
  );
}

/**
 * inner runner 正常返回时，允许把 callback 已持久化的 pending CAS 推进到
 * 同一或更后的 ledger 终态（例如明确 non-OK 的 failed receipt）。如果
 * runner 抛出/CPU 中断，本函数不会执行，callback 的 pending 仍是恢复依据。
 */
function commitReturnedMarketBaseResourceState(
  context: RunContext,
  preparedCanonicalRoot: MarketSaleDataState,
  returnedState: MarketBaseResourceV3RuntimeState,
  returnedLedgerRuntimeAnchor:
    MarketBaseResourceLedgerRuntimeAnchor | undefined,
  returnedRuntimeCapability:
    MarketBaseResourceReadinessRuntimeCapability | undefined,
): boolean {
  if (
    Memory.data?.marketSaleAutomation !==
      (preparedCanonicalRoot as unknown as NonNullable<
        NonNullable<Memory["data"]>["marketSaleAutomation"]
      >) ||
    context.data !== preparedCanonicalRoot
  ) {
    return false;
  }
  const preparedDirect = preparedCanonicalRoot.directAutomation;
  const preparedState = isContinuousDirectState(preparedDirect)
    ? preparedDirect.baseResourceV3
    : undefined;
  if (!isContinuousDirectState(preparedDirect) || !preparedState) {
    return false;
  }
  const activation = marketBaseResourceActivationState(
    preparedCanonicalRoot,
    preparedState,
  );
  const preparedRuntimeCapability =
    advanceMarketBaseResourceReadinessRuntimeCapabilityFromRoot(
      preparedCanonicalRoot,
      preparedState,
      Game.time,
    );
  if (
    !activation.latched ||
    activation.blocker ||
    !activation.anchor ||
    !preparedRuntimeCapability ||
    validatePostCutoverLegacyV2Quiescence(
      preparedCanonicalRoot,
      preparedDirect,
      preparedState,
      activation.anchor,
    ) ||
    validateMarketBaseNestedActivationState(
      preparedState,
      activation.anchor,
      preparedCanonicalRoot.trustedFloors,
      {
        runtimeOnly: true,
        runtimeCapability: preparedRuntimeCapability,
      },
    )
  ) {
    return false;
  }
  const snapshot: MarketBaseResourceV3RuntimeState = {
    ...returnedState,
  };
  const returnedLedgerChanged =
    preparedState.ledger !== snapshot.ledger ||
    preparedState.permitChain !== snapshot.permitChain;
  const effectiveLedgerRuntimeAnchor =
    returnedLedgerRuntimeAnchor ??
    (returnedLedgerChanged ? undefined : activation.anchor.ledger);
  const snapshotRuntimeCapability =
    advanceMarketBaseResourceReadinessRuntimeCapability(
      returnedRuntimeCapability,
      snapshot,
      Game.time,
    );
  if (
    !snapshot.scope ||
    !snapshot.permitChain ||
    !snapshot.ledger ||
    !effectiveLedgerRuntimeAnchor ||
    !snapshotRuntimeCapability ||
    !validateMarketBaseResourceReadinessRuntimeCapability(
      snapshotRuntimeCapability,
      snapshot,
      Game.time,
      effectiveLedgerRuntimeAnchor,
    ) ||
    !marketBaseReturnedLedgerDominatesPrepared(preparedState, snapshot) ||
    validateMarketBaseScopeLifecycleEvidence(snapshot.scope) ||
    !validateMarketBaseResourcePricingRatchetState(
      snapshot.pricingRatchet,
      currentMarketBaseV3Permit(snapshot),
    )
  ) {
    return false;
  }
  const nextTrustedFloors = synchronizeMarketBaseTrustedFloors(
    preparedCanonicalRoot.trustedFloors,
    snapshot.pricingRatchet!,
    Game.time,
  );
  const nextAnchor = advanceMarketBaseResourceActivationAnchor(
    activation.anchor,
    snapshot,
    nextTrustedFloors,
    Game.time,
    effectiveLedgerRuntimeAnchor,
  );
  if (
    validateMarketBaseNestedActivationState(
      snapshot,
      nextAnchor,
      nextTrustedFloors,
      {
        runtimeOnly: true,
        runtimeCapability: snapshotRuntimeCapability,
      },
    )
  ) {
    return false;
  }
  const nextDirect: MarketDirectContinuousAutomationState = {
    ...preparedDirect,
    baseResourceV3: snapshot,
  };
  const nextData: MarketSaleDataState = {
    ...preparedCanonicalRoot,
    trustedFloors: nextTrustedFloors,
    directAutomation: nextDirect,
    pendingDirectDeals: nextDirect.pendingDirectDeals,
    baseResourceV3ActivationAnchor: nextAnchor,
    baseResourceV3ActivationAnchorMirror:
      cloneMarketBaseOperatorValue(nextAnchor),
  };
  const registered = registerMarketBaseResourceCanonicalRoot(
    nextData,
    "direct",
    snapshotRuntimeCapability,
  );
  if (
    !snapshotRuntimeCapability ||
    (!snapshot.readinessAuthorization && registered.reason !== "missing") ||
    (snapshot.readinessAuthorization && !registered.ok)
  ) {
    return false;
  }
  return commitExactContextMarketSaleData(
    context,
    preparedCanonicalRoot,
    nextData,
  );
}

function continuousPermitConfigBlocker(
  config: ResolvedMarketSaleAutomationConfig,
): string | undefined {
  if (!usesDirectStrategy(config)) {
    return "continuous_direct_strategy_required";
  }
  if (config.directCapability !== "continuous-v2") {
    return "continuous_direct_capability_required";
  }
  if (!config.validForPlanning || config.invalidReasons.length > 0) {
    return config.invalidReasons[0] || "continuous_direct_config_invalid";
  }
  return undefined;
}

export function proposeMarketDirectContinuousPermit(
  request: MarketDirectContinuousPermitRequest,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  if (!isContinuousDirectState(data.directAutomation)) {
    return {
      ok: false,
      error: "continuous_direct_state_required",
    };
  }
  const configBlocker = continuousPermitConfigBlocker(
    resolveMarketSaleAutomationConfig(),
  );
  if (configBlocker) {
    appendAudit(data, {
      action: `continuous_permit_proposal_rejected:${configBlocker}`,
    });
    commitContinuousDirectState(data, data.directAutomation);
    return { ok: false, error: configBlocker };
  }
  let accountIdentity: string | undefined;
  try {
    accountIdentity =
      defaultMarketDirectContinuousDependencies.readAccountIdentity();
  } catch {
    accountIdentity = undefined;
  }
  const result = proposeContinuousPermitState(
    data.directAutomation,
    Game.time,
    accountIdentity || "",
    request,
  );
  data.pendingDirectDeals = result.state.pendingDirectDeals;
  data.directAutomation = result.state;
  appendAudit(data, {
    action: result.ok
      ? "continuous_permit_proposed"
      : `continuous_permit_proposal_rejected:${String(
          result.error || "unknown",
        ).slice(0, 80)}`,
    requestId: result.permit?.permitId,
  });
  commitContinuousDirectState(data, result.state);
  return result.ok
    ? {
        ok: true,
        permit: result.permit,
        accountIdentity,
      }
    : {
        ok: false,
        error: result.error || "continuous_permit_proposal_failed",
      };
}

export function acceptMarketDirectContinuousPermit(
  permitId: string,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  if (!isContinuousDirectState(data.directAutomation)) {
    return {
      ok: false,
      error: "continuous_direct_state_required",
    };
  }
  const configBlocker = continuousPermitConfigBlocker(
    resolveMarketSaleAutomationConfig(),
  );
  if (configBlocker) {
    appendAudit(data, {
      action: `continuous_permit_accept_rejected:${configBlocker}`,
      requestId: typeof permitId === "string" ? permitId.trim() : undefined,
    });
    commitContinuousDirectState(data, data.directAutomation);
    return { ok: false, error: configBlocker };
  }
  const normalizedPermitId =
    typeof permitId === "string" ? permitId.trim() : "";
  if (!normalizedPermitId) {
    appendAudit(data, {
      action: "continuous_permit_accept_rejected:continuous_permit_id_required",
    });
    commitContinuousDirectState(data, data.directAutomation);
    return { ok: false, error: "continuous_permit_id_required" };
  }
  const result = acceptContinuousPermitState(
    data.directAutomation,
    Game.time,
    normalizedPermitId,
    Game.shard?.name || "",
  );
  data.pendingDirectDeals = result.state.pendingDirectDeals;
  data.directAutomation = result.state;
  appendAudit(data, {
    action: result.ok
      ? result.idempotent
        ? "continuous_permit_accept_idempotent"
        : "continuous_permit_accepted"
      : `continuous_permit_accept_rejected:${String(
          result.error || "unknown",
        ).slice(0, 80)}`,
    requestId: normalizedPermitId,
  });
  commitContinuousDirectState(data, result.state);
  return result.ok
    ? {
        ok: true,
        permitId: normalizedPermitId,
        idempotent: result.idempotent === true,
      }
    : {
        ok: false,
        error: result.error || "continuous_permit_accept_failed",
      };
}

export function marketDirectContinuousStatus(): unknown {
  const data = ensureDataState();
  if (!isContinuousDirectState(data.directAutomation)) {
    return {
      tick: Game.time,
      error: "continuous_direct_state_required",
    };
  }
  return projectContinuousDirectStatus(data.directAutomation, Game.time);
}

function cloneMarketBaseOperatorValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function marketBaseResourceV3ConfigBlocker(
  config: ResolvedMarketSaleAutomationConfig,
): string | undefined {
  if (!usesDirectStrategy(config)) {
    return "market_base_v3_direct_strategy_required";
  }
  const reasons = marketBaseResourceV3ConfigMismatchReasons(config);
  if (
    config.directCapability !== "continuous-v3" ||
    !config.validForPlanning ||
    config.invalidReasons.length > 0 ||
    reasons.length > 0
  ) {
    return (
      config.invalidReasons[0] || reasons[0] || "market_base_v3_config_invalid"
    );
  }
  return undefined;
}

function marketBaseOperatorExposureBlocker(
  data: MarketSaleDataState,
): string | undefined {
  const activity = collectMarketSaleDomainActivity(data);
  if (!activity.valid) {
    return "market_domain_activity_invalid";
  }
  if (
    Object.keys(data.managedOrders).length > 0 ||
    data.pendingCreate ||
    Object.keys(data.pendingMutations).length > 0 ||
    data.feeLedger?.reconcileGap ||
    activity.stagingAmount > 0 ||
    activity.reservationAmount > 0
  ) {
    return "market_base_v3_maker_exposure_present";
  }
  return undefined;
}

function marketBaseV2LedgerCheckpointHash(
  direct: MarketDirectContinuousAutomationState,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:v2-ledger-cutover-checkpoint-v1",
    ledger: direct.ledger,
  });
}

function marketBaseLegacyV2QuiescenceCommitment(
  direct: MarketDirectContinuousAutomationState,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:legacy-v2-frozen-quiescence-v1",
    authority: {
      migrationStatus: direct.migrationStatus,
      migrationBlockedReason: direct.migrationBlockedReason ?? null,
      currentPermit: direct.currentPermit
        ? {
            epoch: direct.currentPermit.epoch,
            permitId: direct.currentPermit.permitId,
            permitHead: direct.currentPermit.permitHead,
          }
        : null,
      proposedPermitPresent: direct.proposedPermit !== undefined,
      permitChain: {
        currentPermitEpoch: direct.permitChain.currentPermitEpoch,
        currentPermitId: direct.permitChain.currentPermitId,
        permitChainHead: direct.permitChain.permitChainHead,
        permitEpochHighWater: direct.permitChain.permitEpochHighWater,
        permitChainHeadHighWater: direct.permitChain.permitChainHeadHighWater,
      },
      ledger: {
        receiptHeadHash: direct.ledger.receiptHeadHash,
        finalizedAttemptSeq: direct.ledger.finalizedAttemptSeq,
        nextAttemptSeq: direct.ledger.nextAttemptSeq,
        permitEpochHighWater: direct.ledger.permitEpochHighWater,
        permitChainHeadHighWater: direct.ledger.permitChainHeadHighWater,
        prunedThroughSeq: direct.ledger.checkpoint.prunedThroughSeq,
        prunedHeadHash: direct.ledger.checkpoint.prunedHeadHash,
        pendingPresent: direct.ledger.pending !== undefined,
        blockerPresent: direct.ledger.blocker !== undefined,
      },
      pendingProjectionCount: Object.keys(direct.pendingDirectDeals).length,
      quarantinedProjectionCount: Object.keys(
        direct.quarantinedPendingDirectDeals,
      ).length,
    },
  });
}

function validatePostCutoverLegacyV2Quiescence(
  data: MarketSaleDataState,
  direct: MarketDirectContinuousAutomationState,
  state: MarketBaseResourceV3RuntimeState | undefined,
  anchor: MarketBaseResourceActivationAnchor,
): string | undefined {
  const cutover = state?.permitChain?.v2EventCutoverCheckpoint;
  if (!cutover) return undefined;
  const directKeys = Object.keys(direct as unknown as Record<string, unknown>);
  const allowedDirectKeys = new Set([
    "baseResourceV3",
    "capability",
    "currentPermit",
    "directConfirmedDealCount",
    "directDealOutcomes",
    "directPausedForReview",
    "lastLifecycleAppliedAttemptSeq",
    "lastPlanningSnapshot",
    "ledger",
    "legacyStateDigest",
    "lifecycleByEntry",
    "migrationBlockedReason",
    "migrationStatus",
    "pendingDirectDeals",
    "permitChain",
    "processedDirectTransactionKeys",
    "proposedPermit",
    "quarantinedPendingDirectDeals",
    "reviewedLegacyOutcomeDigest",
    "rollbackEvidenceMarker",
    "schemaVersion",
  ]);
  if (
    cutover.checkpointHash !== anchor.cutoverCheckpointHash ||
    directKeys.length > allowedDirectKeys.size ||
    directKeys.some((key) => !allowedDirectKeys.has(key)) ||
    !isPlainRecord(direct.pendingDirectDeals) ||
    !isPlainRecord(direct.quarantinedPendingDirectDeals) ||
    !isPlainRecord(data.pendingDirectDeals) ||
    !isPlainRecord(direct.lifecycleByEntry) ||
    !isPlainRecord(direct.ledger) ||
    !isPlainRecord(direct.ledger.checkpoint) ||
    !isPlainRecord(direct.permitChain) ||
    Object.keys(direct.lifecycleByEntry).length > 16
  ) {
    return "market_base_legacy_v2_quiescence_shape_invalid";
  }
  if (
    direct.migrationStatus !== "active" ||
    direct.migrationBlockedReason !== undefined ||
    direct.proposedPermit !== undefined ||
    direct.ledger.pending !== undefined ||
    direct.ledger.blocker !== undefined ||
    direct.ledger.finalizedAttemptSeq !== cutover.lastV2AttemptSeq ||
    direct.ledger.finalizedAttemptSeq !== cutover.lastV2OutcomeSeq ||
    direct.ledger.nextAttemptSeq !== cutover.lastV2AttemptSeq + 1 ||
    direct.ledger.receiptHeadHash !== cutover.v2ReceiptHeadHash ||
    Object.keys(direct.pendingDirectDeals).length !== 0 ||
    Object.keys(direct.quarantinedPendingDirectDeals).length !== 0 ||
    Object.keys(data.pendingDirectDeals).length !== 0 ||
    canonicalStableHashV1(data.pendingDirectDeals) !==
      canonicalStableHashV1(direct.pendingDirectDeals)
  ) {
    return "market_base_legacy_v2_not_quiescent_after_cutover";
  }
  let currentCommitment: string | undefined;
  try {
    currentCommitment = marketBaseLegacyV2QuiescenceCommitment(direct);
  } catch {
    currentCommitment = undefined;
  }
  if (
    currentCommitment === undefined ||
    currentCommitment !== anchor.legacyV2QuiescenceCommitment
  ) {
    return "market_base_legacy_v2_frozen_state_mismatch";
  }
  const exposureBlocker = marketBaseOperatorExposureBlocker(data);
  return exposureBlocker
    ? `market_base_legacy_v2_${exposureBlocker}`
    : undefined;
}

function marketBaseV2SourceStateFingerprint(
  data: MarketSaleDataState,
  direct: MarketDirectContinuousAutomationState,
): string {
  const {
    baseResourceV3: _baseResourceV3,
    lastPlanningSnapshot: _lastPlanningSnapshot,
    ...frozenDirect
  } = direct;
  return canonicalStableHashV1({
    domain: "market-base-resource:v2-cutover-source-v1",
    direct: frozenDirect,
    marketDomain: {
      managedOrders: data.managedOrders,
      marketReservations: data.marketReservations ?? null,
      marketStaging: data.marketStaging ?? null,
      pendingCreate: data.pendingCreate ?? null,
      pendingMutations: data.pendingMutations,
    },
    trustedFloors: data.trustedFloors,
  });
}

function marketBaseV3SourceStateFingerprint(
  data: MarketSaleDataState,
  direct: MarketDirectContinuousAutomationState,
  state: MarketBaseResourceV3RuntimeState,
  lifecycleLaneIds: readonly string[],
): string {
  const lifecycleLaneSet = new Set(lifecycleLaneIds);
  const lifecycleResources = new Set(
    state.scope?.laneLifecycles
      .filter((lane) => lifecycleLaneSet.has(lane.laneId))
      .map((lane) => lane.resource) ?? [],
  );
  return canonicalStableHashV1({
    domain: "market-base-resource:v3-successor-source-v1",
    state: {
      schemaVersion: state.schemaVersion,
      catalog: state.catalog,
      permitChain: state.permitChain ?? null,
      ledger: state.ledger ?? null,
      pricingRatchet: state.pricingRatchet
        ? {
            schemaVersion: state.pricingRatchet.schemaVersion,
            initializedAt: state.pricingRatchet.initializedAt,
            bootstrapFingerprint: state.pricingRatchet.bootstrapFingerprint,
            entries: state.pricingRatchet.entries.filter((entry) =>
              lifecycleResources.has(entry.resource),
            ),
          }
        : null,
      cutoverLatched: state.cutoverLatched === true,
      lastLifecycleAppliedAttemptSeq: state.lastLifecycleAppliedAttemptSeq ?? 0,
      blocker: state.blocker ?? null,
      /**
       * 排除 scope.updatedAt/registry.lastReconciledTick/checkpoint 等仅由
       * tick 推进的字段；保留 room incarnation 与 lane stage/status/
       * shadowEvidence。这样跨 tick 无事实变化的 proposal 可签收，而
       * qualification reset 或 A→B→A 必然改变 source fingerprint。
       */
      stableScope: marketBaseStableScopeProjection(
        state.scope,
        lifecycleLaneIds,
      ),
    },
    activationHighWater: data.baseResourceV3ActivationAnchor
      ? {
          accountIdentity: data.baseResourceV3ActivationAnchor.accountIdentity,
          cutoverCheckpointHash:
            data.baseResourceV3ActivationAnchor.cutoverCheckpointHash,
          firstV3PermitEpoch:
            data.baseResourceV3ActivationAnchor.firstV3PermitEpoch,
          firstV3PermitId: data.baseResourceV3ActivationAnchor.firstV3PermitId,
          laneTombstoneCheckpointCommitment:
            data.baseResourceV3ActivationAnchor
              .laneTombstoneCheckpointCommitment,
          roomIncarnationHighWater:
            data.baseResourceV3ActivationAnchor.roomIncarnationHighWater,
          laneLifecycleHighWater:
            data.baseResourceV3ActivationAnchor.laneLifecycleHighWater.filter(
              (entry) => lifecycleLaneSet.has(entry.laneId),
            ),
        }
      : null,
    outerPermitId: direct.currentPermit?.permitId ?? null,
    marketDomain: {
      managedOrders: data.managedOrders,
      marketReservations: data.marketReservations ?? null,
      marketStaging: data.marketStaging ?? null,
      pendingCreate: data.pendingCreate ?? null,
      pendingMutations: data.pendingMutations,
    },
    trustedFloors: Object.fromEntries(
      [...lifecycleResources]
        .sort()
        .map((resource) => [resource, data.trustedFloors[resource] ?? null]),
    ),
  });
}

function validateV2CutoverSource(
  data: MarketSaleDataState,
  direct: MarketDirectContinuousAutomationState,
  tick: number,
): string | undefined {
  const ledgerValidation = validateContinuousLedger(direct.ledger, tick);
  if (!ledgerValidation.ok) {
    return ledgerValidation.blockerCode || "market_base_v2_ledger_invalid";
  }
  const chainValidation = validateMarketDirectContinuousPermitChain(
    direct.permitChain,
    {
      permitEpochHighWater: direct.ledger.permitEpochHighWater,
      permitChainHeadHighWater: direct.ledger.permitChainHeadHighWater,
    },
  );
  if (!chainValidation.ok) {
    return chainValidation.reason || "market_base_v2_permit_chain_invalid";
  }
  const tip = direct.permitChain.permits[direct.permitChain.permits.length - 1];
  if (
    direct.migrationStatus !== "active" ||
    direct.migrationBlockedReason ||
    !direct.currentPermit ||
    !tip ||
    canonicalStableHashV1(direct.currentPermit) !==
      canonicalStableHashV1(tip) ||
    tip.permitId !== direct.permitChain.currentPermitId ||
    tip.permitHead !== direct.permitChain.permitChainHead ||
    direct.proposedPermit ||
    direct.ledger.pending ||
    direct.ledger.blocker ||
    direct.ledger.nextAttemptSeq !== direct.ledger.finalizedAttemptSeq + 1 ||
    Object.keys(direct.pendingDirectDeals).length > 0 ||
    Object.keys(direct.quarantinedPendingDirectDeals).length > 0
  ) {
    return "market_base_v2_cutover_not_quiescent";
  }
  if (direct.ledger.checkpoint.prunedThroughSeq !== 0) {
    return "v2_migration_room_lane_history_incomplete";
  }
  return marketBaseOperatorExposureBlocker(data);
}

function migratedMarketBaseLifetimeCounters(
  receipts: readonly MarketBaseResourceQuotaReceipt[],
): MarketBaseResourceLedgerCounters {
  const counters: {
    global: { count: number; amount: number };
    resources: Record<string, { count: number; amount: number }>;
    rooms: Record<string, { count: number; amount: number }>;
    lanes: Record<string, { count: number; amount: number }>;
  } = {
    global: { count: 0, amount: 0 },
    resources: {},
    rooms: {},
    lanes: {},
  };
  for (const receipt of receipts) {
    if (receipt.status !== "confirmed") continue;
    counters.global.count += 1;
    counters.global.amount += receipt.actualAmount;
    for (const [target, key] of [
      [counters.resources, receipt.resource],
      [counters.rooms, receipt.sellerRoom],
      [counters.lanes, `${receipt.resource}:${receipt.sellerRoom}`],
    ] as const) {
      const prior = target[key] ?? {
        count: 0,
        amount: 0,
      };
      target[key] = {
        count: prior.count + 1,
        amount: prior.amount + receipt.actualAmount,
      };
    }
  }
  return counters;
}

function migrateV2QuotaReceipts(
  direct: MarketDirectContinuousAutomationState,
): MarketBaseResourceQuotaReceipt[] {
  return direct.ledger.receipts.map((receipt) => {
    if (!isMarketBaseResource(receipt.resource)) {
      throw new TypeError(
        `v2_receipt_resource_outside_base_catalog:${receipt.resource}`,
      );
    }
    return {
      sourceVersion: 2 as const,
      attemptSeq: receipt.attemptSeq,
      evidenceKey: receipt.evidenceKey,
      status: receipt.status,
      resource: receipt.resource,
      sellerRoom: receipt.sellerRoom,
      plannedAmount: receipt.plannedAmount,
      actualAmount: receipt.actualAmount,
      resolvedAt: receipt.resolvedAt,
      retentionTick: receipt.retentionTick,
      ...(receipt.transactionTime === undefined
        ? {}
        : {
            transactionTime: receipt.transactionTime,
          }),
    };
  });
}

function buildFirstMarketBasePricingRatchet(input: {
  tick: number;
  trustedFloors: MarketSaleDataState["trustedFloors"];
}): {
  pricingRatchet: ReturnType<typeof buildMarketBaseResourcePricingRatchetState>;
  trustedFloors: MarketSaleDataState["trustedFloors"];
} {
  const next = cloneMarketBaseOperatorValue(input.trustedFloors || {});
  const entries = MARKET_BASE_RESOURCE_CATALOG.map((resource) => {
    const current = next[resource];
    if (
      current !== undefined &&
      (!Number.isFinite(current.value) ||
        current.value <= 0 ||
        typeof current.marketDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(current.marketDate) ||
        !Number.isSafeInteger(current.updatedAt) ||
        current.updatedAt < 0)
    ) {
      throw new TypeError(`market_base_v2_trusted_floor_invalid:${resource}`);
    }
    const bootstrap =
      MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[resource].ratchetFloor;
    const value = Math.max(current?.value ?? 0, bootstrap);
    const marketDate =
      current?.marketDate &&
      current.marketDate > MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.historyDate
        ? current.marketDate
        : MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.historyDate;
    next[resource] = {
      value,
      marketDate,
      updatedAt: input.tick,
    };
    return {
      resource,
      value,
      marketDate,
    };
  });
  const currentEnergy = next[RESOURCE_ENERGY];
  if (
    currentEnergy !== undefined &&
    (!Number.isFinite(currentEnergy.value) ||
      currentEnergy.value <= 0 ||
      typeof currentEnergy.marketDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(currentEnergy.marketDate) ||
      !Number.isSafeInteger(currentEnergy.updatedAt) ||
      currentEnergy.updatedAt < 0)
  ) {
    throw new TypeError("market_base_v2_trusted_floor_invalid:energy");
  }
  next[RESOURCE_ENERGY] = {
    value: Math.max(
      currentEnergy?.value ?? 0,
      MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
    ),
    marketDate:
      currentEnergy?.marketDate &&
      currentEnergy.marketDate >
        MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.historyDate
        ? currentEnergy.marketDate
        : MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.historyDate,
    updatedAt:
      currentEnergy &&
      currentEnergy.value >=
        MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor &&
      currentEnergy.marketDate >=
        MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.historyDate
        ? currentEnergy.updatedAt
        : input.tick,
  };
  return {
    pricingRatchet: buildMarketBaseResourcePricingRatchetState({
      initializedAt: input.tick,
      entries,
    }),
    trustedFloors: next,
  };
}

function inertMarketBaseProposal(
  input: Omit<MarketBaseResourcePermitProposal, "proposalId">,
): MarketBaseResourcePermitProposal {
  return {
    ...input,
    proposalId: canonicalStableHashV1({
      domain: "market-base-resource:operator-proposal-v1",
      proposal: input,
    }),
  };
}

function buildMarketBaseV2CutoverProposal(
  data: MarketSaleDataState,
  direct: MarketDirectContinuousAutomationState,
  config: ResolvedMarketSaleAutomationConfig,
  tick: number,
): MarketBaseResourcePermitProposal {
  const accountIdentity = readLiveMarketBaseAccountIdentity();
  if (!accountIdentity) {
    throw new TypeError("market_base_account_identity_incomplete");
  }
  if ((Game.shard?.name || "") !== "shard1") {
    throw new TypeError("market_base_executor_shard_mismatch");
  }
  const sourceBlocker = validateV2CutoverSource(data, direct, tick);
  if (sourceBlocker) {
    throw new TypeError(sourceBlocker);
  }
  const scopeResult = reconcileLiveMarketBaseResourceScope({
    tick,
    accountIdentity,
    observations: collectLiveMarketBaseRoomObservations(accountIdentity),
    previous: direct.baseResourceV3?.scope,
  });
  if ("blockers" in scopeResult) {
    throw new TypeError(
      scopeResult.blockers[0] || "market_base_scope_reconcile_failed",
    );
  }
  const targetScope: MarketBaseResourceScopeState = {
    ...scopeResult.state,
    laneLifecycles: scopeResult.state.laneLifecycles.map((lane) => ({
      ...lane,
      stage: "shadow" as const,
      status: "suspended" as const,
    })),
  };
  const sharedPolicy = createMarketBaseSharedPolicy(accountIdentity);
  if (sharedPolicy.fingerprint !== targetScope.sharedPolicyFingerprint) {
    throw new TypeError("market_base_scope_shared_policy_mismatch");
  }
  const wrappers = direct.permitChain.permits.map((rawRecord) =>
    wrapAuthenticatedLegacyV2PermitRecord({
      rawRecord,
      authenticated: true,
    }),
  );
  let permitChain = createMarketBaseResourcePermitChainState({
    legacyV2PermitRecords: wrappers,
  });
  const v2LedgerCheckpointHash = marketBaseV2LedgerCheckpointHash(direct);
  const cutover = buildMarketBaseResourceV2EventCutoverCheckpoint({
    lastV2AttemptSeq: direct.ledger.finalizedAttemptSeq,
    lastV2OutcomeSeq: direct.ledger.finalizedAttemptSeq,
    v2ReceiptHeadHash: direct.ledger.receiptHeadHash,
    v2LedgerCheckpointHash,
  });
  const permit = buildMarketBaseResourcePermit({
    epoch: permitChain.permitEpochHighWater + 1,
    accountIdentity,
    sharedPolicy,
    resourcePolicies: MARKET_BASE_RESOURCE_POLICIES,
    ratchetHighWater: buildMarketBaseResourceBootstrapRatchetHighWater(tick),
    signedLaneGrants: targetScope.laneLifecycles.map((lane) =>
      buildMarketBaseResourceSignedLaneGrant({
        lane,
        stage: "shadow",
        newDealGrant: "suspended",
      }),
    ),
    previousPermitId: permitChain.currentPermitId,
    previousPermitHead: permitChain.permitChainHead,
    previousLedgerHead: direct.ledger.receiptHeadHash,
    v2EventCutoverCheckpoint: cutover,
    legacyV2GrantSuspension: buildMarketBaseResourceLegacyV2GrantSuspension({
      previousPermitId: permitChain.currentPermitId,
      previousPermitHead: permitChain.permitChainHead,
      cutoverCheckpointHash: cutover.checkpointHash,
    }),
    createdAt: tick,
    operatorAuthorizationFingerprint:
      marketBaseResourceOperatorAuthorizationFingerprint(config),
  });
  const appended = appendMarketBaseResourcePermit(permitChain, permit, {
    tick,
    currentShard: "shard1",
    currentLedgerHead: direct.ledger.receiptHeadHash,
    currentV2LedgerCheckpointHash: v2LedgerCheckpointHash,
    currentV2AttemptSeqHighWater: direct.ledger.finalizedAttemptSeq,
    currentV2OutcomeSeqHighWater: direct.ledger.finalizedAttemptSeq,
    currentDerivedLanes: targetScope.laneLifecycles,
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment(
        targetScope.laneLifecycles,
      ),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
  });
  if (appended.status === "rejected" || appended.status === "conflict") {
    throw new TypeError(`market_base_first_permit_${appended.reason}`);
  }
  permitChain = appended.state;
  const legacyQuotaReceipts = migrateV2QuotaReceipts(direct);
  const lifetimeConfirmed =
    migratedMarketBaseLifetimeCounters(legacyQuotaReceipts);
  if (
    canonicalStableHashV1({
      global: lifetimeConfirmed.global,
      resources: lifetimeConfirmed.resources,
    }) !== canonicalStableHashV1(direct.ledger.lifetimeConfirmed)
  ) {
    throw new TypeError("market_base_v2_lifetime_counter_mismatch");
  }
  const migrationBasis =
    buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis({
      tick,
      cutoverCheckpoint: cutover,
      v2PrunedThroughAttemptSeq: direct.ledger.checkpoint.prunedThroughSeq,
      legacyQuotaReceipts,
      legacyV2ConfirmedCanaries: direct.ledger.confirmedCanaries,
      lifetimeConfirmed,
      retryNotBefore: direct.ledger.retryNotBefore,
      authenticated: true,
    });
  const ledger = createMarketBaseResourceLedger({
    tick,
    permitChain,
    migrationBasis,
  });
  const ledgerValidation = validateMarketBaseResourceLedger(
    ledger,
    tick,
    permitChain,
  );
  const anchorValidation = validateMarketBaseResourcePermitChainDominatesAnchor(
    permitChain,
    ledger.permitAnchor,
  );
  if (!ledgerValidation.ok || !anchorValidation.ok) {
    throw new TypeError(
      ledgerValidation.reason ||
        anchorValidation.reason ||
        "market_base_migrated_ledger_invalid",
    );
  }
  const migratedRatchet = buildFirstMarketBasePricingRatchet({
    tick,
    trustedFloors: data.trustedFloors,
  });
  return inertMarketBaseProposal({
    schemaVersion: 3,
    kind: "v2-cutover",
    proposedAt: tick,
    sourceStateFingerprint: marketBaseV2SourceStateFingerprint(data, direct),
    operatorAuthorizationFingerprint:
      marketBaseResourceOperatorAuthorizationFingerprint(config),
    accountIdentity,
    executorShard: "shard1",
    rosterFingerprint: targetScope.rosterFingerprint,
    laneSetFingerprint: targetScope.laneSetFingerprint,
    targetScope,
    targetPermitChain: permitChain,
    targetLedger: ledger,
    targetPricingRatchet: migratedRatchet.pricingRatchet,
    targetTrustedFloors: migratedRatchet.trustedFloors,
  });
}

function currentMarketBaseV3Permit(
  state: MarketBaseResourceV3RuntimeState,
): MarketBaseResourcePermit | undefined {
  const retained =
    state.permitChain?.retainedPermits[
      (state.permitChain?.retainedPermits.length ?? 0) - 1
    ];
  return retained?.schemaVersion === 3 ? retained : undefined;
}

function continuousReviewStablePayload(
  snapshot: Omit<
    MarketBaseResourceContinuousReviewSnapshot,
    "stableReviewDigest"
  >,
): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    hashRevision: snapshot.hashRevision,
    laneId: snapshot.laneId,
    resource: snapshot.resource,
    sellerRoom: snapshot.sellerRoom,
    confirmedCanary: snapshot.confirmedCanary,
    permit: snapshot.permit,
    ledger: snapshot.ledger,
    terminal: {
      terminalId: snapshot.terminal.terminalId,
      resourceAmount: snapshot.terminal.resourceAmount,
      energy: snapshot.terminal.energy,
      effectivePostDealEnergyReserve:
        snapshot.terminal.effectivePostDealEnergyReserve,
    },
    protection: {
      entryCommitment: snapshot.protection.entryCommitment,
      sellableAmount: snapshot.protection.sellableAmount,
      protectedAmount: snapshot.protection.protectedAmount,
      productionDemand: snapshot.protection.productionDemand,
      protectedOutgoing: snapshot.protection.protectedOutgoing,
      carrierOrInFlight: snapshot.protection.carrierOrInFlight,
    },
    quota: snapshot.quota,
  };
}

function sealMarketBaseContinuousReviewSnapshot(
  input: Omit<MarketBaseResourceContinuousReviewSnapshot, "stableReviewDigest">,
): MarketBaseResourceContinuousReviewSnapshot {
  return {
    ...input,
    stableReviewDigest: canonicalStableHashV1({
      domain: "market-base-resource:operator-continuous-review-v1",
      facts: continuousReviewStablePayload(input),
    }),
  };
}

function validateMarketBaseContinuousReviewSnapshot(
  value: unknown,
  tick: number,
): value is MarketBaseResourceContinuousReviewSnapshot {
  if (!isPlainRecord(value)) return false;
  const snapshot =
    value as unknown as MarketBaseResourceContinuousReviewSnapshot;
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.hashRevision !== "market-base-resource-continuous-review-v1" ||
    typeof snapshot.laneId !== "string" ||
    snapshot.laneId.length === 0 ||
    snapshot.laneId.length > 256 ||
    !isMarketBaseResource(snapshot.resource) ||
    typeof snapshot.sellerRoom !== "string" ||
    snapshot.sellerRoom.length === 0 ||
    snapshot.sellerRoom.length > 64 ||
    !Number.isSafeInteger(snapshot.observedAt) ||
    snapshot.observedAt < 0 ||
    snapshot.observedAt > tick ||
    !Number.isSafeInteger(snapshot.sourceFreshThrough) ||
    snapshot.sourceFreshThrough < tick ||
    !isPlainRecord(snapshot.confirmedCanary) ||
    !Number.isSafeInteger(snapshot.confirmedCanary.attemptSeq) ||
    snapshot.confirmedCanary.attemptSeq <= 0 ||
    !Number.isSafeInteger(snapshot.confirmedCanary.transactionTime) ||
    !Number.isSafeInteger(snapshot.confirmedCanary.actualAmount) ||
    snapshot.confirmedCanary.actualAmount <= 0 ||
    !Number.isSafeInteger(snapshot.confirmedCanary.actualTransactionEnergy) ||
    snapshot.confirmedCanary.actualTransactionEnergy < 0 ||
    !Number.isSafeInteger(snapshot.confirmedCanary.actualNetCreditsMilli) ||
    snapshot.confirmedCanary.actualNetCreditsMilli <= 0 ||
    !isPlainRecord(snapshot.permit) ||
    !isPlainRecord(snapshot.ledger) ||
    !isPlainRecord(snapshot.terminal) ||
    !isPlainRecord(snapshot.protection) ||
    !isPlainRecord(snapshot.quota) ||
    typeof snapshot.stableReviewDigest !== "string" ||
    snapshot.stableReviewDigest.length === 0 ||
    snapshot.stableReviewDigest.length > 256
  ) {
    return false;
  }
  const { stableReviewDigest: _stableReviewDigest, ...payload } = snapshot;
  return (
    snapshot.stableReviewDigest ===
    sealMarketBaseContinuousReviewSnapshot(payload).stableReviewDigest
  );
}

function buildCurrentMarketBaseContinuousReviewSnapshot(
  data: MarketSaleDataState,
  state: MarketBaseResourceV3RuntimeState,
  config: ResolvedMarketSaleAutomationConfig,
  laneId: string,
  tick: number,
): MarketBaseResourceContinuousReviewSnapshot {
  const permit = currentMarketBaseV3Permit(state);
  const ledger = state.ledger;
  const scope = state.scope;
  const lane = scope?.laneLifecycles.find(
    (candidate) => candidate.laneId === laneId,
  );
  const reviewFacts =
    ledger && state.permitChain
      ? marketBaseResourceCanaryReviewFactsFor(
          ledger,
          laneId,
          state.permitChain,
        )
      : undefined;
  const confirmation = reviewFacts?.confirmed;
  if (
    !permit ||
    !ledger ||
    !scope ||
    !lane ||
    !["review_paused", "continuous"].includes(lane.stage) ||
    (lane.stage === "review_paused" && lane.status !== "suspended") ||
    (lane.stage === "continuous" &&
      !["suspended", "writable"].includes(lane.status)) ||
    !confirmation ||
    !reviewFacts ||
    reviewFacts.laneId !== laneId ||
    reviewFacts.attempt.laneId !== laneId ||
    reviewFacts.attempt.attemptSeq !== confirmation.attemptSeq ||
    reviewFacts.attempt.permitId !== confirmation.permitId ||
    reviewFacts.attempt.permitEpoch !== confirmation.permitEpoch
  ) {
    throw new TypeError(
      "market_base_continuous_review_canary_receipt_unavailable",
    );
  }
  const policy = MARKET_BASE_RESOURCE_POLICIES.find(
    (candidate) => candidate.resource === lane.resource,
  );
  const ratchet = state.pricingRatchet?.entries.find(
    (candidate) => candidate.resource === lane.resource,
  );
  const effectiveFloor = Math.max(
    policy?.hardFloor ?? Infinity,
    policy?.economicFloor ?? Infinity,
    ratchet?.value ?? Infinity,
  );
  if (
    !policy ||
    !Number.isFinite(effectiveFloor) ||
    confirmation.actualNetCreditsMilli <
      Math.ceil(effectiveFloor * 1_000 * confirmation.actualAmount)
  ) {
    throw new TypeError("market_base_continuous_review_actual_net_below_floor");
  }
  const terminal = readLiveMarketBaseTerminal(
    lane.sellerRoomName,
    lane.resource,
  );
  if (
    !terminal ||
    !terminal.owned ||
    !terminal.ready ||
    terminal.cooldown !== 0 ||
    !Number.isSafeInteger(terminal.effectivePostDealEnergyReserve) ||
    (terminal.effectivePostDealEnergyReserve ?? -1) < 25_000 ||
    terminal.energy < (terminal.effectivePostDealEnergyReserve ?? Infinity) ||
    terminal.resourceAmount < 1_000
  ) {
    throw new TypeError("market_base_continuous_review_terminal_not_ready");
  }
  const protectionLedger = collectLiveMarketSaleProtectionLedger(
    config,
    Object.values(data.managedOrders),
    {
      candidates: [
        {
          roomName: lane.sellerRoomName,
          resource: lane.resource,
        },
      ],
      laneReserveByEntry: {
        [getMarketProtectionEntryKey(lane.sellerRoomName, lane.resource)]:
          policy.laneReserve,
      },
    },
  );
  const protection =
    protectionLedger.entries[
      getMarketProtectionEntryKey(lane.sellerRoomName, lane.resource)
    ];
  if (
    protectionLedger.globalBlocked ||
    !protection ||
    !isMarketProtectionEntryFresh(protection, tick) ||
    getMarketProtectionSellableAmount(protection, tick) < 1_000
  ) {
    throw new TypeError("market_base_continuous_review_protection_incomplete");
  }
  const quota = marketBaseResourceQuotaProjection({
    state: ledger,
    tick,
    lanes: [
      {
        resource: lane.resource,
        sellerRoom: lane.sellerRoomName,
        resourceLimit: policy.rollingMaxAmount,
      },
    ],
  })[0];
  if (!quota) {
    throw new TypeError("market_base_continuous_review_quota_unavailable");
  }
  const quotaStable = {
    global: quota.global,
    resourceQuota: quota.resourceQuota,
    room: quota.room,
    lane: quota.lane,
    lastGlobalConfirmedAt: quota.lastGlobalConfirmedAt ?? null,
    confirmedCooldownNotBefore: quota.confirmedCooldownNotBefore,
    retryNotBefore: quota.retryNotBefore,
  };
  const contributionProjection = protection.sourceContributions
    .map((entry) => ({
      dedupeKey: entry.dedupeKey,
      stableKey: entry.stableKey ?? null,
      bucket: entry.bucket,
      amount: entry.amount,
      sourceKinds: [...entry.sourceKinds].sort(),
      managedOrderId: entry.managedOrderId ?? null,
    }))
    .sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));
  return sealMarketBaseContinuousReviewSnapshot({
    schemaVersion: 1,
    hashRevision: "market-base-resource-continuous-review-v1",
    laneId,
    resource: lane.resource,
    sellerRoom: lane.sellerRoomName,
    observedAt: tick,
    sourceFreshThrough: protection.expiresAt,
    confirmedCanary: {
      attemptSeq: confirmation.attemptSeq,
      permitId: confirmation.permitId,
      receiptEventHash: confirmation.receiptEventHash,
      transactionTime: confirmation.transactionTime,
      actualAmount: confirmation.actualAmount,
      actualTransactionEnergy: confirmation.actualTransactionEnergy,
      actualNetCreditsMilli: confirmation.actualNetCreditsMilli,
    },
    permit: {
      permitId: permit.permitId,
      permitEpoch: permit.epoch,
      permitHead: permit.permitHead,
    },
    ledger: {
      receiptHeadHash: ledger.receiptHeadHash,
      checkpointHash: ledger.checkpoint.checkpointHash,
      permitAnchorHash: ledger.permitAnchor.anchorHash,
      finalizedAttemptSeq: ledger.finalizedAttemptSeq,
    },
    terminal: {
      terminalId: terminal.terminalId,
      resourceAmount: terminal.resourceAmount,
      energy: terminal.energy,
      effectivePostDealEnergyReserve: terminal.effectivePostDealEnergyReserve!,
      readinessRevision: terminal.revision,
    },
    protection: {
      revision: protection.revision,
      observedAt: protection.observedAt,
      expiresAt: protection.expiresAt,
      entryCommitment: canonicalStableHashV1({
        domain: "market-base-resource:operator-protection-review-v1",
        roomName: protection.roomName,
        resource: protection.resource,
        totalStock: protection.totalStock,
        terminalStock: protection.terminalStock,
        hardReserve: protection.hardReserve,
        localReserve: protection.localReserve ?? null,
        absoluteTarget: protection.absoluteTarget ?? null,
        consumptiveDemand: protection.consumptiveDemand ?? null,
        boostWar: protection.boostWar ?? null,
        hubCommitments: protection.hubCommitments ?? null,
        productionDemand: protection.productionDemand,
        forecastBuffer: protection.forecastBuffer,
        protectedOutgoing: protection.protectedOutgoing,
        carrierOrInFlight: protection.carrierOrInFlight,
        protectedAmount: protection.protectedAmount,
        managedExposure: protection.managedExposure,
        sellableAmount: protection.sellableAmount,
        contributions: contributionProjection,
      }),
      sellableAmount: getMarketProtectionSellableAmount(protection, tick),
      protectedAmount: protection.protectedAmount,
      productionDemand: protection.productionDemand,
      protectedOutgoing: protection.protectedOutgoing,
      carrierOrInFlight: protection.carrierOrInFlight,
    },
    quota: {
      commitment: canonicalStableHashV1({
        domain: "market-base-resource:operator-quota-review-v1",
        quota: quotaStable,
      }),
      globalRemaining: quota.global.remaining,
      resourceRemaining: quota.resourceQuota.remaining,
      roomRemaining: quota.room.remaining,
      laneRemaining: quota.lane.remaining,
      confirmedCooldownNotBefore: quota.confirmedCooldownNotBefore,
      retryNotBefore: quota.retryNotBefore,
    },
  });
}

function validateV3SuccessorSource(
  data: MarketSaleDataState,
  state: MarketBaseResourceV3RuntimeState,
  config: ResolvedMarketSaleAutomationConfig,
  tick: number,
): string | undefined {
  if (
    state.cutoverLatched !== true ||
    !state.permitChain ||
    !state.ledger ||
    !state.scope
  ) {
    return "market_base_v3_active_state_required";
  }
  const permitValidation = validateMarketBaseResourcePermitChain(
    state.permitChain,
  );
  const ledgerValidation = validateMarketBaseResourceLedger(
    state.ledger,
    tick,
    state.permitChain,
  );
  const anchorValidation = validateMarketBaseResourcePermitChainDominatesAnchor(
    state.permitChain,
    state.ledger.permitAnchor,
  );
  const permit = currentMarketBaseV3Permit(state);
  if (
    !permitValidation.ok ||
    !ledgerValidation.ok ||
    !anchorValidation.ok ||
    !permit ||
    permit.operatorAuthorizationFingerprint !==
      marketBaseResourceOperatorAuthorizationFingerprint(config) ||
    !validateMarketBaseResourcePricingRatchetState(
      state.pricingRatchet,
      permit,
    ) ||
    state.permitChain.blocker ||
    state.ledger.blocker ||
    state.ledger.pending ||
    state.blocker
  ) {
    return (
      permitValidation.reason ||
      ledgerValidation.reason ||
      anchorValidation.reason ||
      state.permitChain.blocker?.code ||
      state.ledger.blocker?.code ||
      state.blocker ||
      "market_base_v3_successor_prerequisite_failed"
    );
  }
  return marketBaseOperatorExposureBlocker(data);
}

function tombstonedMarketBaseGrant(
  grant: MarketBaseResourceSignedLaneGrant,
): MarketBaseResourceSignedLaneGrant {
  const lane: MarketBaseDerivedLaneLifecycle = {
    laneId: grant.laneId,
    resource: grant.resource,
    resourcePolicyId: grant.resourcePolicyId,
    resourcePolicyFingerprint: grant.resourcePolicyFingerprint,
    roomInstanceId: grant.roomInstanceId,
    sellerRoomName: grant.sellerRoom,
    roomFingerprint: grant.roomFingerprint,
    sharedPolicyFingerprint: grant.sharedPolicyFingerprint,
    stage: grant.stage,
    status: "tombstoned",
    shadowEvidence: {
      completeCycles: 0,
    },
    stableFingerprint: grant.laneStableFingerprint,
  };
  return buildMarketBaseResourceSignedLaneGrant({
    lane,
    status: "tombstoned",
    stage: grant.stage,
    newDealGrant: "suspended",
    lifecycleEvidenceDigest: grant.lifecycleEvidenceDigest,
    reviewDigest: grant.reviewDigest,
  });
}

function sameMarketBaseGrantExceptDealGrant(
  left: MarketBaseResourceSignedLaneGrant,
  right: MarketBaseResourceSignedLaneGrant,
): boolean {
  const {
    grantFingerprint: _leftGrantFingerprint,
    newDealGrant: _leftNewDealGrant,
    ...leftStable
  } = left;
  const {
    grantFingerprint: _rightGrantFingerprint,
    newDealGrant: _rightNewDealGrant,
    ...rightStable
  } = right;
  return (
    canonicalStableHashV1(leftStable) === canonicalStableHashV1(rightStable)
  );
}

function buildMarketBaseV3SuccessorProposal(
  data: MarketSaleDataState,
  direct: MarketDirectContinuousAutomationState,
  state: MarketBaseResourceV3RuntimeState,
  activationAnchor: MarketBaseResourceActivationAnchor,
  config: ResolvedMarketSaleAutomationConfig,
  tick: number,
  request: MarketBaseResourcePermitRequest,
): BuiltMarketBaseV3SuccessorProposal {
  const blocker = validateV3SuccessorSource(data, state, config, tick);
  if (blocker) throw new TypeError(blocker);
  const laneId =
    typeof request.laneId === "string" ? request.laneId.trim() : "";
  const targetStage = request.targetStage;
  if (
    !laneId ||
    !["canary", "continuous", "suspend"].includes(targetStage || "")
  ) {
    throw new TypeError("market_base_successor_exact_lane_transition_required");
  }
  const accountIdentity = readLiveMarketBaseAccountIdentity();
  if (
    !accountIdentity ||
    accountIdentity !== currentMarketBaseV3Permit(state)?.accountIdentity ||
    (Game.shard?.name || "") !== "shard1"
  ) {
    throw new TypeError("market_base_successor_identity_mismatch");
  }
  const scopeResult = reconcileLiveMarketBaseResourceScope({
    tick,
    accountIdentity,
    observations: collectLiveMarketBaseRoomObservations(accountIdentity),
    previous: state.scope,
    permitChain: state.permitChain,
    pinnedLaneIds: state.ledger?.pending
      ? [state.ledger.pending.historicalLane.laneId]
      : [],
    expectedPreviousRoomCheckpointCommitment:
      activationAnchor.roomRegistryCheckpointCommitment,
    expectedPermitLaneTombstoneCheckpointCommitment:
      activationAnchor.laneTombstoneCheckpointCommitment,
    expectedPreviousLaneTombstoneDischargeCheckpointCommitment:
      activationAnchor.laneTombstoneDischargeCheckpointCommitment,
  });
  if ("blockers" in scopeResult) {
    throw new TypeError(
      scopeResult.blockers[0] || "market_base_successor_scope_invalid",
    );
  }
  const currentScope = scopeResult.state;
  const lifecycleBlocker =
    validateMarketBaseScopeLifecycleEvidence(currentScope);
  if (lifecycleBlocker) {
    throw new TypeError(lifecycleBlocker);
  }
  const targetLane = currentScope.laneLifecycles.find(
    (lane) => lane.laneId === laneId,
  );
  if (!targetLane) {
    throw new TypeError("market_base_successor_lane_not_found");
  }
  const permitChain = state.permitChain!;
  const ledger = state.ledger!;
  const priorPermit = currentMarketBaseV3Permit(state)!;
  const priorByLane = new Map(
    priorPermit.signedLaneGrants.map((grant) => [grant.laneId, grant]),
  );
  const priorTargetGrant = priorByLane.get(laneId);
  const retainedV3Permits = permitChain.retainedPermits.filter(
    (record): record is MarketBaseResourcePermit => record.schemaVersion === 3,
  );
  const recoverableCanaryTransitions: Array<{
    canaryPermit: MarketBaseResourcePermit;
    preCanaryPermit: MarketBaseResourcePermit;
    canaryPermitIndex: number;
  }> = [];
  if (
    targetStage === "continuous" &&
    targetLane.stage === "continuous" &&
    targetLane.status === "suspended" &&
    priorTargetGrant?.status === "active" &&
    priorTargetGrant.stage === "continuous" &&
    priorTargetGrant.newDealGrant === "suspended"
  ) {
    for (const grant of priorPermit.signedLaneGrants) {
      if (
        grant.status !== "active" ||
        grant.stage !== "canary" ||
        grant.newDealGrant !== "suspended" ||
        grant.resource !== targetLane.resource ||
        grant.laneId === laneId
      ) {
        continue;
      }
      const reviewFacts = marketBaseResourceCanaryReviewFactsFor(
        ledger,
        grant.laneId,
        permitChain,
      );
      if (!reviewFacts) continue;
      const attemptPermitIndex = retainedV3Permits.findIndex(
        (candidate) =>
          candidate.permitId === reviewFacts.attempt.permitId &&
          candidate.epoch === reviewFacts.attempt.permitEpoch,
      );
      const attemptPermit = retainedV3Permits[attemptPermitIndex];
      const attemptCanaryGrant = attemptPermit?.signedLaneGrants.find(
        (candidate) => candidate.laneId === grant.laneId,
      );
      const attemptTarget = attemptPermit?.signedLaneGrants.find(
        (candidate) => candidate.laneId === laneId,
      );
      if (
        !attemptPermit ||
        !attemptCanaryGrant ||
        attemptCanaryGrant.status !== "active" ||
        attemptCanaryGrant.stage !== "canary" ||
        attemptCanaryGrant.newDealGrant !== "enabled" ||
        !attemptTarget ||
        attemptTarget.status !== "active" ||
        attemptTarget.stage !== "continuous" ||
        attemptTarget.newDealGrant !== "suspended"
      ) {
        continue;
      }
      // attempt 可以发生在 B canary accept 之后的无关 operator permit 下。
      // 向前只跨越 A/B 两条 grant 完全不变的 contiguous prefix，定位真正
      // 把 B enabled、A suspended 的首个 permit，再取其 predecessor。
      let canaryPermitIndex = attemptPermitIndex;
      while (canaryPermitIndex > 0) {
        const candidate = retainedV3Permits[canaryPermitIndex - 1];
        const candidateCanary = candidate.signedLaneGrants.find(
          (entry) => entry.laneId === grant.laneId,
        );
        const candidateTarget = candidate.signedLaneGrants.find(
          (entry) => entry.laneId === laneId,
        );
        if (
          !candidateCanary ||
          candidateCanary.newDealGrant !== "enabled" ||
          canonicalStableHashV1(candidateCanary) !==
            canonicalStableHashV1(attemptCanaryGrant) ||
          !candidateTarget ||
          canonicalStableHashV1(candidateTarget) !==
            canonicalStableHashV1(attemptTarget)
        ) {
          break;
        }
        canaryPermitIndex -= 1;
      }
      const canaryPermit = retainedV3Permits[canaryPermitIndex];
      const preCanaryPermit = retainedV3Permits[canaryPermitIndex - 1];
      if (!canaryPermit || !preCanaryPermit) continue;
      const canaryGrant = canaryPermit.signedLaneGrants.find(
        (candidate) => candidate.laneId === grant.laneId,
      );
      const canaryTarget = canaryPermit.signedLaneGrants.find(
        (candidate) => candidate.laneId === laneId,
      );
      const preCanaryTarget = preCanaryPermit.signedLaneGrants.find(
        (candidate) => candidate.laneId === laneId,
      );
      const currentCanaryLane = currentScope.laneLifecycles.find(
        (candidate) => candidate.laneId === grant.laneId,
      );
      if (
        !canaryGrant ||
        canaryGrant.status !== "active" ||
        canaryGrant.stage !== "canary" ||
        canaryGrant.newDealGrant !== "enabled" ||
        !sameMarketBaseGrantExceptDealGrant(canaryGrant, grant) ||
        !canaryTarget ||
        canaryTarget.status !== "active" ||
        canaryTarget.stage !== "continuous" ||
        canaryTarget.newDealGrant !== "suspended" ||
        !preCanaryTarget ||
        preCanaryTarget.status !== "active" ||
        preCanaryTarget.stage !== "continuous" ||
        preCanaryTarget.newDealGrant !== "enabled" ||
        !sameMarketBaseGrantExceptDealGrant(preCanaryTarget, canaryTarget) ||
        canonicalStableHashV1(canaryTarget) !==
          canonicalStableHashV1(priorTargetGrant) ||
        !currentCanaryLane ||
        currentCanaryLane.status !== "suspended" ||
        !["canary", "review_paused"].includes(currentCanaryLane.stage) ||
        currentCanaryLane.stableFingerprint !== grant.laneStableFingerprint
      ) {
        continue;
      }

      let canarySuspended = false;
      let suffixStable = true;
      for (const suffixPermit of retainedV3Permits.slice(
        canaryPermitIndex + 1,
      )) {
        const suffixTarget = suffixPermit.signedLaneGrants.find(
          (candidate) => candidate.laneId === laneId,
        );
        const suffixCanary = suffixPermit.signedLaneGrants.find(
          (candidate) => candidate.laneId === grant.laneId,
        );
        if (
          !suffixTarget ||
          canonicalStableHashV1(suffixTarget) !==
            canonicalStableHashV1(canaryTarget) ||
          !suffixCanary ||
          !sameMarketBaseGrantExceptDealGrant(canaryGrant, suffixCanary) ||
          suffixCanary.status !== "active" ||
          suffixCanary.stage !== "canary" ||
          (suffixCanary.newDealGrant === "enabled" && canarySuspended)
        ) {
          suffixStable = false;
          break;
        }
        if (suffixCanary.newDealGrant === "suspended") {
          canarySuspended = true;
        }
      }
      if (!suffixStable || !canarySuspended) continue;
      recoverableCanaryTransitions.push({
        canaryPermit,
        preCanaryPermit,
        canaryPermitIndex,
      });
    }
  }
  const isSuspendedContinuousRecovery =
    recoverableCanaryTransitions.length === 1;
  const recoveryTransition = recoverableCanaryTransitions[0];
  const recoverableInterruptedContinuousLaneIds = new Set(
    isSuspendedContinuousRecovery && recoveryTransition
      ? priorPermit.signedLaneGrants
          .filter((currentGrant) => {
            const canaryPermitGrant =
              recoveryTransition.canaryPermit.signedLaneGrants.find(
                (candidate) => candidate.laneId === currentGrant.laneId,
              );
            const preCanaryGrant =
              recoveryTransition.preCanaryPermit.signedLaneGrants.find(
                (candidate) => candidate.laneId === currentGrant.laneId,
              );
            const currentLane = currentScope.laneLifecycles.find(
              (candidate) => candidate.laneId === currentGrant.laneId,
            );
            return Boolean(
              currentGrant.status === "active" &&
              currentGrant.stage === "continuous" &&
              currentGrant.newDealGrant === "suspended" &&
              currentGrant.resource === targetLane.resource &&
              canaryPermitGrant &&
              canaryPermitGrant.status === "active" &&
              canaryPermitGrant.stage === "continuous" &&
              canaryPermitGrant.newDealGrant === "suspended" &&
              canonicalStableHashV1(canaryPermitGrant) ===
                canonicalStableHashV1(currentGrant) &&
              preCanaryGrant &&
              preCanaryGrant.status === "active" &&
              preCanaryGrant.stage === "continuous" &&
              preCanaryGrant.newDealGrant === "enabled" &&
              sameMarketBaseGrantExceptDealGrant(
                preCanaryGrant,
                canaryPermitGrant,
              ) &&
              retainedV3Permits
                .slice(recoveryTransition.canaryPermitIndex + 1)
                .every((suffixPermit) => {
                  const suffixGrant = suffixPermit.signedLaneGrants.find(
                    (candidate) => candidate.laneId === currentGrant.laneId,
                  );
                  return (
                    suffixGrant !== undefined &&
                    canonicalStableHashV1(suffixGrant) ===
                      canonicalStableHashV1(canaryPermitGrant)
                  );
                }) &&
              currentLane &&
              currentLane.stage === "continuous" &&
              currentLane.status === "suspended" &&
              currentLane.stableFingerprint ===
                currentGrant.laneStableFingerprint,
            );
          })
          .map((grant) => grant.laneId)
      : [],
  );
  const otherEnabledCanary = priorPermit.signedLaneGrants.find(
    (grant) =>
      grant.stage === "canary" &&
      grant.newDealGrant === "enabled" &&
      grant.laneId !== laneId,
  );
  if (otherEnabledCanary) {
    throw new TypeError("market_base_other_canary_must_resolve_first");
  }
  let confirmedProof:
    ReturnType<typeof buildMarketBaseResourceConfirmedCanaryProof> | undefined;
  let targetContinuousReview:
    MarketBaseResourceContinuousReviewSnapshot | undefined;
  if (targetStage === "canary") {
    if (targetLane.stage !== "qualified" || targetLane.status !== "suspended") {
      throw new TypeError("market_base_lane_not_shadow_qualified");
    }
  } else if (targetStage === "continuous") {
    if (
      !(
        targetLane.stage === "review_paused" &&
        targetLane.status === "suspended"
      ) &&
      !isSuspendedContinuousRecovery
    ) {
      throw new TypeError("market_base_lane_not_review_paused");
    }
    confirmedProof = buildMarketBaseResourceConfirmedCanaryProof(
      ledger,
      laneId,
      permitChain,
    );
    targetContinuousReview = buildCurrentMarketBaseContinuousReviewSnapshot(
      data,
      {
        ...state,
        scope: currentScope,
      },
      config,
      laneId,
      tick,
    );
    if (
      !validateMarketBaseContinuousReviewSnapshot(
        request.continuousReview,
        tick,
      ) ||
      request.continuousReview.laneId !== laneId ||
      request.continuousReview.stableReviewDigest !==
        targetContinuousReview.stableReviewDigest ||
      canonicalStableHashV1(
        continuousReviewStablePayload(request.continuousReview),
      ) !==
        canonicalStableHashV1(
          continuousReviewStablePayload(targetContinuousReview),
        ) ||
      typeof request.reviewedEvidenceDigest !== "string" ||
      request.reviewedEvidenceDigest.trim() !==
        targetContinuousReview.stableReviewDigest
    ) {
      throw new TypeError("market_base_continuous_review_snapshot_mismatch");
    }
  } else if (
    !priorTargetGrant ||
    priorTargetGrant.status !== "active" ||
    priorTargetGrant.newDealGrant !== "enabled" ||
    !["canary", "continuous"].includes(priorTargetGrant.stage)
  ) {
    throw new TypeError("market_base_lane_not_writable_for_suspension");
  } else if (
    priorTargetGrant.stage === "canary" &&
    !marketBaseResourceCanaryReviewFactsFor(
      ledger,
      priorTargetGrant.laneId,
      permitChain,
    )
  ) {
    throw new TypeError(
      "market_base_canary_suspension_requires_terminal_attempt",
    );
  }

  const reviewedEvidence: MarketBaseResourceReviewedEvidence[] = [];
  const continuousReviewSnapshots = new Map<
    string,
    MarketBaseResourceContinuousReviewSnapshot
  >();
  if (targetContinuousReview) {
    continuousReviewSnapshots.set(laneId, targetContinuousReview);
  }
  const confirmedProofByLane = new Map<
    string,
    ReturnType<typeof buildMarketBaseResourceConfirmedCanaryProof>
  >();
  if (confirmedProof) {
    confirmedProofByLane.set(laneId, confirmedProof);
  }
  const ensureConfirmedProof = (confirmedLaneId: string) => {
    const existing = confirmedProofByLane.get(confirmedLaneId);
    if (existing) return existing;
    const proof = buildMarketBaseResourceConfirmedCanaryProof(
      ledger,
      confirmedLaneId,
      permitChain,
    );
    confirmedProofByLane.set(confirmedLaneId, proof);
    return proof;
  };
  const addContinuousReview = (
    proof: ReturnType<typeof buildMarketBaseResourceConfirmedCanaryProof>,
    operatorReviewSnapshotDigest: string,
  ): void => {
    if (
      reviewedEvidence.some(
        (entry) =>
          entry.laneId === proof.laneId && entry.kind === "continuous_review",
      )
    ) {
      return;
    }
    reviewedEvidence.push({
      laneId: proof.laneId,
      kind: "continuous_review",
      evidenceKey: proof.evidenceKey,
      digest: operatorReviewSnapshotDigest,
      permitId: proof.permitId,
      attemptSeq: proof.attemptSeq,
      receiptEventHash: proof.receiptEventHash,
      ledgerCheckpointHash: proof.ledgerCheckpointHash,
      ledgerReceiptHeadHash: proof.ledgerReceiptHeadHash,
      ledgerPermitAnchorHash: proof.ledgerPermitAnchorHash,
      confirmedCanaryReviewDigest: proof.reviewDigest,
      operatorReviewSnapshotDigest,
    });
  };
  const activeGrants: MarketBaseResourceSignedLaneGrant[] = [];
  const targetLifecycleByLane = new Map<
    string,
    MarketBaseDerivedLaneLifecycle
  >();
  for (const lane of currentScope.laneLifecycles) {
    const old = priorByLane.get(lane.laneId);
    const identityStable =
      old?.laneStableFingerprint === lane.stableFingerprint &&
      old.roomInstanceId === lane.roomInstanceId &&
      old.roomFingerprint === lane.roomFingerprint;
    let stage = identityStable && old ? lane.stage : ("shadow" as const);
    let newDealGrant: "enabled" | "suspended" =
      identityStable &&
      old?.newDealGrant === "enabled" &&
      (stage === "canary" || stage === "continuous")
        ? "enabled"
        : "suspended";
    if (
      stage === "review_paused" ||
      stage === "qualified" ||
      stage === "shadow"
    ) {
      newDealGrant = "suspended";
    }
    if (lane.laneId === laneId) {
      if (targetStage === "canary") {
        stage = "canary";
        newDealGrant = "enabled";
      } else if (targetStage === "continuous") {
        stage = "continuous";
        newDealGrant = "enabled";
      } else {
        newDealGrant = "suspended";
      }
    }
    const suspendForTargetResourceCanary =
      targetStage === "canary" &&
      lane.laneId !== laneId &&
      lane.resource === targetLane.resource &&
      newDealGrant === "enabled";
    if (suspendForTargetResourceCanary) {
      newDealGrant = "suspended";
    }
    const resumeForTargetResourceContinuous =
      targetStage === "continuous" &&
      lane.laneId !== laneId &&
      lane.resource === targetLane.resource &&
      recoverableInterruptedContinuousLaneIds.has(lane.laneId) &&
      identityStable &&
      old?.stage === "continuous" &&
      old.newDealGrant === "suspended" &&
      lane.stage === "continuous" &&
      lane.status === "suspended";
    if (resumeForTargetResourceContinuous) {
      stage = "continuous";
      newDealGrant = "enabled";
    }
    if (
      identityStable &&
      old?.stage === "continuous" &&
      old.newDealGrant === "enabled" &&
      lane.laneId !== laneId &&
      !suspendForTargetResourceCanary
    ) {
      const proof = ensureConfirmedProof(lane.laneId);
      addContinuousReview(proof, old.reviewDigest);
      activeGrants.push(old);
      targetLifecycleByLane.set(lane.laneId, {
        ...lane,
        stage: "continuous",
        status: "writable",
      });
      continue;
    }
    const laneConfirmedProof =
      stage === "continuous" && newDealGrant === "enabled"
        ? ensureConfirmedProof(lane.laneId)
        : undefined;
    let operatorReviewSnapshotDigest: string | undefined;
    if (laneConfirmedProof) {
      let snapshot = continuousReviewSnapshots.get(lane.laneId);
      if (!snapshot && resumeForTargetResourceContinuous) {
        snapshot = buildCurrentMarketBaseContinuousReviewSnapshot(
          data,
          {
            ...state,
            scope: currentScope,
          },
          config,
          lane.laneId,
          tick,
        );
        continuousReviewSnapshots.set(lane.laneId, snapshot);
      }
      operatorReviewSnapshotDigest =
        snapshot?.stableReviewDigest ?? old?.reviewDigest;
      if (!operatorReviewSnapshotDigest) {
        throw new TypeError(
          `market_base_continuous_operator_review_missing:${lane.laneId}`,
        );
      }
      addContinuousReview(laneConfirmedProof, operatorReviewSnapshotDigest);
    }
    const lifecycle: MarketBaseDerivedLaneLifecycle = {
      ...lane,
      stage,
      status: newDealGrant === "enabled" ? "writable" : "suspended",
    };
    const preserveWritableGrantSuspension =
      identityStable &&
      old !== undefined &&
      newDealGrant === "suspended" &&
      (old.stage === "canary" || old.stage === "continuous");
    const grantStage = preserveWritableGrantSuspension ? old!.stage : stage;
    const grant = buildMarketBaseResourceSignedLaneGrant({
      lane: lifecycle,
      stage: grantStage,
      newDealGrant,
      ...(preserveWritableGrantSuspension
        ? {
            lifecycleEvidenceDigest: old!.lifecycleEvidenceDigest,
            reviewDigest: old!.reviewDigest,
          }
        : {}),
      ...(laneConfirmedProof
        ? {
            reviewDigest: operatorReviewSnapshotDigest!,
          }
        : {}),
    });
    activeGrants.push(grant);
    targetLifecycleByLane.set(lane.laneId, lifecycle);
    if (lane.laneId === laneId && targetStage === "canary") {
      reviewedEvidence.push({
        laneId,
        kind: "shadow_qualification",
        evidenceKey: canonicalStableHashV1({
          domain: "market-base-resource:shadow-qualification-review-v1",
          laneId,
          lifecycleEvidenceDigest: grant.lifecycleEvidenceDigest,
        }),
        digest: grant.lifecycleEvidenceDigest,
      });
    }
  }
  const activeIds = new Set(activeGrants.map((grant) => grant.laneId));
  const tombstones = priorPermit.signedLaneGrants
    .filter((grant) => !activeIds.has(grant.laneId))
    .map(tombstonedMarketBaseGrant);
  const signedLaneGrants = [...activeGrants, ...tombstones];
  const targetScope: MarketBaseResourceScopeState = {
    ...currentScope,
    laneLifecycles: currentScope.laneLifecycles.map((lane) =>
      targetLifecycleByLane.get(lane.laneId)!,
    ),
  };
  const permit = buildMarketBaseResourcePermit({
    epoch: permitChain.permitEpochHighWater + 1,
    accountIdentity,
    sharedPolicy: priorPermit.sharedPolicy,
    resourcePolicies: priorPermit.resourcePolicies,
    ratchetHighWater: priorPermit.ratchetHighWater,
    signedLaneGrants,
    reviewedEvidence,
    previousPermitId: permitChain.currentPermitId,
    previousPermitHead: permitChain.permitChainHead,
    previousLedgerHead: ledger.receiptHeadHash,
    createdAt: tick,
    operatorAuthorizationFingerprint:
      marketBaseResourceOperatorAuthorizationFingerprint(config),
  });
  const receiptReferences = marketBaseResourceRetainedReceiptPermitReferences(
    ledger,
    permitChain,
  );
  const appended = appendMarketBaseResourcePermit(permitChain, permit, {
    tick,
    currentShard: "shard1",
    currentLedgerHead: ledger.receiptHeadHash,
    currentLedgerCheckpointHash: ledger.checkpoint.checkpointHash,
    currentLedgerPermitAnchorHash: ledger.permitAnchor.anchorHash,
    currentDerivedLanes: targetScope.laneLifecycles,
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment(
        targetScope.laneLifecycles,
      ),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
    receiptPermitReferences: receiptReferences,
    ...(confirmedProofByLane.size > 0
      ? {
          confirmedCanaryProofs: [...confirmedProofByLane.values()],
          activeReviewPermitReferences: [...confirmedProofByLane.values()].map(
            (proof) => ({
              sourceId: proof.laneId,
              permitId: proof.permitId,
            }),
          ),
        }
      : {}),
  });
  if (appended.status === "rejected" || appended.status === "conflict") {
    throw new TypeError(`market_base_successor_${appended.reason}`);
  }
  const reboundLedger = rebindMarketBaseResourceLedgerPermitAnchor(
    ledger,
    appended.state,
  );
  const validation = validateMarketBaseResourceLedger(
    reboundLedger,
    tick,
    appended.state,
  );
  if (!validation.ok) {
    throw new TypeError(
      validation.reason || "market_base_successor_ledger_invalid",
    );
  }
  const transitionLaneIds = targetScope.laneLifecycles
    .filter((lane) => {
      const priorGrant = priorByLane.get(lane.laneId);
      const nextGrant = signedLaneGrants.find(
        (grant) => grant.laneId === lane.laneId,
      );
      const currentLane = currentScope.laneLifecycles.find(
        (candidate) => candidate.laneId === lane.laneId,
      );
      return (
        lane.laneId === laneId ||
        currentLane?.stage !== lane.stage ||
        currentLane?.status !== lane.status ||
        priorGrant?.stage !== nextGrant?.stage ||
        priorGrant?.status !== nextGrant?.status ||
        priorGrant?.newDealGrant !== nextGrant?.newDealGrant
      );
    })
    .map((lane) => lane.laneId)
    .sort((left, right) => left.localeCompare(right));
  const proposal = inertMarketBaseProposal({
    schemaVersion: 3,
    kind: "v3-successor",
    proposedAt: tick,
    sourceStateFingerprint: marketBaseV3SourceStateFingerprint(
      data,
      direct,
      state,
      transitionLaneIds,
    ),
    operatorAuthorizationFingerprint:
      marketBaseResourceOperatorAuthorizationFingerprint(config),
    accountIdentity,
    executorShard: "shard1",
    rosterFingerprint: targetScope.rosterFingerprint,
    laneSetFingerprint: targetScope.laneSetFingerprint,
    targetScope,
    targetPermitChain: appended.state,
    targetLedger: reboundLedger,
    targetPricingRatchet: state.pricingRatchet!,
    targetTrustedFloors: cloneMarketBaseOperatorValue(data.trustedFloors),
  });
  return {
    proposal,
    transition: {
      laneId,
      targetStage,
      transitionLaneIds,
    },
    continuousReviews: [...continuousReviewSnapshots.values()].sort(
      (left, right) => left.laneId.localeCompare(right.laneId),
    ),
  };
}

function validateFrozenMarketBaseProposal(
  proposal: MarketBaseResourcePermitProposal,
): boolean {
  const { proposalId: _proposalId, ...payload } = proposal;
  return (
    proposal.schemaVersion === 3 &&
    proposal.proposalId ===
      canonicalStableHashV1({
        domain: "market-base-resource:operator-proposal-v1",
        proposal: payload,
      }) &&
    validateMarketBaseResourcePermitChain(proposal.targetPermitChain).ok &&
    validateMarketBaseResourceLedger(
      proposal.targetLedger,
      proposal.proposedAt,
      proposal.targetPermitChain,
    ).ok &&
    validateMarketBaseResourcePermitChainDominatesAnchor(
      proposal.targetPermitChain,
      proposal.targetLedger.permitAnchor,
    ).ok &&
    validateMarketBaseResourcePricingRatchetState(
      proposal.targetPricingRatchet,
      proposal.targetPermitChain.retainedPermits[
        proposal.targetPermitChain.retainedPermits.length - 1
      ]?.schemaVersion === 3
        ? (proposal.targetPermitChain.retainedPermits[
            proposal.targetPermitChain.retainedPermits.length - 1
          ] as MarketBaseResourcePermit)
        : undefined,
    )
  );
}

function copyMarketSaleDataForOperator(
  source: MarketSaleDataState,
): MarketSaleDataState {
  const direct = source.directAutomation;
  return {
    ...source,
    trustedFloors: {
      ...source.trustedFloors,
    },
    operatorAudit: [...source.operatorAudit],
    ...(direct
      ? {
          directAutomation: {
            ...direct,
            ...(isContinuousDirectState(direct) && direct.baseResourceV3
              ? {
                  baseResourceV3: {
                    ...direct.baseResourceV3,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function marketBasePolicyMigrationSourceFingerprint(
  state: MarketBaseResourceV3RuntimeState,
): string | undefined {
  const permit = currentMarketBaseV3Permit(state);
  if (!state.scope || !state.permitChain || !state.ledger || !permit) {
    return undefined;
  }
  return canonicalStableHashV1({
    domain: "market-base-resource:policy-migration-source-v1",
    permitId: permit.permitId,
    permitHead: permit.permitHead,
    epoch: state.permitChain.currentPermitEpoch,
    receiptHeadHash: state.ledger.receiptHeadHash,
    laneSetFingerprint: state.scope.laneSetFingerprint,
    sharedPolicyFingerprint: state.scope.sharedPolicyFingerprint,
  });
}

function buildMarketBasePolicyMigrationAnchor(input: {
  proposal: MarketBaseResourcePermitProposal;
  scope: MarketBaseResourceScopeState;
  direct: MarketDirectContinuousAutomationState;
  acceptedAt: number;
}): MarketBaseResourceActivationAnchor {
  const firstPermit = input.proposal.targetPermitChain.retainedPermits.find(
    (record) => record.schemaVersion === 3,
  );
  const cutover = input.proposal.targetPermitChain.v2EventCutoverCheckpoint;
  if (
    input.proposal.kind !== "v3-policy-migration" ||
    !firstPermit ||
    firstPermit.schemaVersion !== 3 ||
    !cutover ||
    input.proposal.targetPermitChain.legacyV2GrantSuspended !== true
  ) {
    throw new TypeError("market_base_migration_anchor_invalid");
  }
  const payload: MarketBaseResourceActivationAnchorPayload = {
    schemaVersion: 1,
    hashRevision: MARKET_BASE_RESOURCE_ACTIVATION_ANCHOR_REVISION,
    accountIdentity: input.proposal.accountIdentity,
    executorShard: input.proposal.executorShard,
    acceptedAt: input.acceptedAt,
    updatedAt: input.acceptedAt,
    operatorAuthorizationFingerprint:
      input.proposal.operatorAuthorizationFingerprint,
    cutoverCheckpointHash: cutover.checkpointHash,
    legacyV2QuiescenceCommitment: marketBaseLegacyV2QuiescenceCommitment(
      input.direct,
    ),
    firstV3PermitEpoch: firstPermit.epoch,
    firstV3PermitId: firstPermit.permitId,
    firstV3PermitHead: firstPermit.permitHead,
    laneTombstoneCheckpointCommitment:
      input.proposal.targetPermitChain.laneTombstoneCheckpoint
        .checkpointCommitment,
    laneTombstoneDischargeCheckpointCommitment:
      input.scope.laneTombstoneDischargeCheckpoint.checkpointCommitment,
    laneLifecycleHighWater: marketBaseResourceLaneLifecycleHighWater(
      input.scope,
    ),
    scopeCommitment: marketBaseResourceOuterScopeCommitment(input.scope),
    roomRegistryCheckpointCommitment:
      input.scope.roomRegistry.checkpointCommitment,
    roomIncarnationHighWater: marketBaseResourceRoomIncarnationHighWater(
      input.scope,
    ),
    laneLifecycleCommitment: marketBaseResourceLaneLifecycleCommitment(
      input.scope,
    ),
    ...marketBaseResourceRuntimeSafetyProjection(
      {
        ledger: input.proposal.targetLedger,
        permitChain: input.proposal.targetPermitChain,
        pricingRatchet: input.proposal.targetPricingRatchet,
        hardBlocker: undefined,
      },
      input.proposal.targetTrustedFloors,
    ),
    activationBlocker: null,
  };
  return {
    ...payload,
    anchorHash: marketBaseResourceActivationAnchorHash(payload),
  };
}

/**
 * 策略常量升级迁移提案：以当前常量派生的新 sharedPolicy/resourcePolicies
 * 对全部 active grant re-sign，laneId/stage/status/shadowEvidence 原样保留。
 * 这是 permit 链唯一的常量升级路径；不经它的常量变更维持 rollback 闩锁。
 */
function buildMarketBasePolicyMigrationProposal(
  data: MarketSaleDataState,
  direct: MarketDirectContinuousAutomationState,
  state: MarketBaseResourceV3RuntimeState,
  config: ResolvedMarketSaleAutomationConfig,
  tick: number,
): MarketBaseResourcePermitProposal {
  const accountIdentity = readLiveMarketBaseAccountIdentity();
  if (
    !accountIdentity ||
    (Game.shard?.name || "") !== "shard1" ||
    !state.scope ||
    !state.permitChain ||
    !state.ledger ||
    !state.pricingRatchet
  ) {
    throw new TypeError("market_base_migration_state_incomplete");
  }
  if (
    state.ledger.pending ||
    Object.keys(direct.quarantinedPendingDirectDeals).length > 0
  ) {
    throw new TypeError("market_base_migration_wal_not_quiescent");
  }
  const configReasons = marketBaseResourceV3ConfigMismatchReasons(config);
  if (configReasons.length > 0) {
    // cfg 必须先采纳新常量（console 顺序：部署 → cfg → 迁移）。
    throw new TypeError(configReasons[0]);
  }
  const priorPermit = currentMarketBaseV3Permit(state);
  if (!priorPermit) {
    throw new TypeError("market_base_migration_permit_missing");
  }
  const sharedPolicy = createMarketBaseSharedPolicy(accountIdentity);
  if (priorPermit.sharedPolicy.fingerprint === sharedPolicy.fingerprint) {
    throw new TypeError("market_base_migration_no_policy_change");
  }
  const migration = migrateMarketBaseDerivedLanes({
    previous: state.scope.laneLifecycles,
    sharedPolicyFingerprint: sharedPolicy.fingerprint,
  });
  if (!migration.ok || !migration.lanes || !migration.laneSetFingerprint) {
    throw new TypeError(
      migration.blockers[0] || "market_base_migration_lanes_invalid",
    );
  }
  const targetScope: MarketBaseResourceScopeState = {
    ...state.scope,
    sharedPolicyFingerprint: sharedPolicy.fingerprint,
    laneLifecycles: migration.lanes,
    laneSetFingerprint: migration.laneSetFingerprint,
    updatedAt: tick,
  };
  const lifecycleBlocker = validateMarketBaseScopeLifecycleEvidence(targetScope);
  if (lifecycleBlocker) {
    throw new TypeError(lifecycleBlocker);
  }
  const laneById = new Map(migration.lanes.map((lane) => [lane.laneId, lane]));
  const priorQualificationByLane = new Map(
    priorPermit.reviewedEvidence
      .filter((entry) => entry.kind === "shadow_qualification")
      .map((entry) => [entry.laneId, entry]),
  );
  if (
    priorPermit.reviewedEvidence.some(
      (entry) => entry.kind !== "shadow_qualification",
    )
  ) {
    // canary/continuous/suspension review 绑定尚未支持跨策略迁移；出现时
    // 需先按各自协议解决（成交确认/复核），再执行迁移。
    throw new TypeError("market_base_migration_active_reviews_unsupported");
  }
  const activeGrants: MarketBaseResourceSignedLaneGrant[] = [];
  const reviewedEvidence: MarketBaseResourceReviewedEvidence[] = [];
  for (const priorGrant of priorPermit.signedLaneGrants) {
    if (priorGrant.status !== "active") {
      // tombstone grant 不 re-sign（旧指纹无法通过新 permit 的 policy
      // 匹配校验）；直接省略，由链 append 的 tombstone checkpoint 按
      // "prior tombstoned+suspended grant 不在 next"自动排放留档。
      continue;
    }
    const lane = laneById.get(priorGrant.laneId);
    if (!lane) {
      throw new TypeError(
        `market_base_migration_lane_missing:${priorGrant.laneId}`,
      );
    }
    if (
      priorGrant.stage === "canary" &&
      priorGrant.newDealGrant === "enabled"
    ) {
      // 单 canary 坑位：armed canary 必须先成交（review_paused）再迁移。
      throw new TypeError(
        `market_base_migration_canary_unresolved:${priorGrant.laneId}`,
      );
    }
    const grant = buildMarketBaseResourceSignedLaneGrant({
      lane: {
        ...lane,
        status:
          priorGrant.newDealGrant === "enabled" ? "writable" : "suspended",
      },
      stage: priorGrant.stage,
      status: "active",
      newDealGrant: priorGrant.newDealGrant,
    });
    activeGrants.push(grant);
    if (priorQualificationByLane.has(priorGrant.laneId)) {
      reviewedEvidence.push({
        laneId: priorGrant.laneId,
        kind: "shadow_qualification",
        evidenceKey: canonicalStableHashV1({
          domain: "market-base-resource:shadow-qualification-review-v1",
          laneId: priorGrant.laneId,
          lifecycleEvidenceDigest: grant.lifecycleEvidenceDigest,
        }),
        digest: grant.lifecycleEvidenceDigest,
      });
    }
  }
  const permitChain = state.permitChain;
  const ledger = state.ledger;
  const permit = buildMarketBaseResourcePermit({
    epoch: permitChain.permitEpochHighWater + 1,
    accountIdentity,
    sharedPolicy,
    resourcePolicies: MARKET_BASE_RESOURCE_POLICIES,
    ratchetHighWater: priorPermit.ratchetHighWater,
    signedLaneGrants: activeGrants,
    reviewedEvidence,
    previousPermitId: permitChain.currentPermitId,
    previousPermitHead: permitChain.permitChainHead,
    previousLedgerHead: ledger.receiptHeadHash,
    createdAt: tick,
    operatorAuthorizationFingerprint:
      marketBaseResourceOperatorAuthorizationFingerprint(config),
  });
  const receiptReferences = marketBaseResourceRetainedReceiptPermitReferences(
    ledger,
    permitChain,
  );
  const appended = appendMarketBaseResourcePermit(permitChain, permit, {
    tick,
    currentShard: "shard1",
    currentLedgerHead: ledger.receiptHeadHash,
    currentLedgerCheckpointHash: ledger.checkpoint.checkpointHash,
    currentLedgerPermitAnchorHash: ledger.permitAnchor.anchorHash,
    currentDerivedLanes: migration.lanes,
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment(migration.lanes),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
    receiptPermitReferences: receiptReferences,
  });
  if (appended.status === "rejected" || appended.status === "conflict") {
    throw new TypeError(`market_base_migration_${appended.reason}`);
  }
  const reboundLedger = rebindMarketBaseResourceLedgerPermitAnchor(
    ledger,
    appended.state,
  );
  const ledgerValidation = validateMarketBaseResourceLedger(
    reboundLedger,
    tick,
    appended.state,
  );
  if (!ledgerValidation.ok) {
    throw new TypeError(
      ledgerValidation.reason || "market_base_migration_ledger_invalid",
    );
  }
  const sourceFingerprint = marketBasePolicyMigrationSourceFingerprint(state);
  if (!sourceFingerprint) {
    throw new TypeError("market_base_migration_state_incomplete");
  }
  return inertMarketBaseProposal({
    schemaVersion: 3,
    kind: "v3-policy-migration",
    proposedAt: tick,
    sourceStateFingerprint: sourceFingerprint,
    operatorAuthorizationFingerprint:
      marketBaseResourceOperatorAuthorizationFingerprint(config),
    accountIdentity,
    executorShard: "shard1",
    rosterFingerprint: targetScope.rosterFingerprint,
    laneSetFingerprint: targetScope.laneSetFingerprint,
    targetScope,
    targetPermitChain: appended.state,
    targetLedger: reboundLedger,
    targetPricingRatchet: state.pricingRatchet,
    targetTrustedFloors: cloneMarketBaseOperatorValue(data.trustedFloors),
  });
}

/**
 * 策略常量升级迁移提案（operator 两步协议第一步）。与普通 propose 不同：
 * 允许在 rollback 闩锁态执行——部署新常量 → console 更新 cfg → 本提案 →
 * accept 即完成零损失升级（事故恢复与常态升级共用同一路径）。
 */
export function proposeMarketBaseResourcePolicyMigration(): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const sourceData = ensureDataState();
  const sourceDirect = sourceData.directAutomation;
  if (!isContinuousDirectState(sourceDirect)) {
    return { ok: false, error: "continuous_direct_state_required" };
  }
  const config = resolveMarketSaleAutomationConfig();
  const configBlocker = marketBaseResourceV3ConfigBlocker(config);
  if (configBlocker) {
    return { ok: false, error: configBlocker };
  }
  let commitAttempted = false;
  try {
    const data = copyMarketSaleDataForOperator(sourceData);
    const direct = data.directAutomation;
    if (!isContinuousDirectState(direct)) {
      throw new TypeError("continuous_direct_state_required");
    }
    const state = direct.baseResourceV3;
    if (!state) {
      throw new TypeError("market_base_migration_state_incomplete");
    }
    const proposal = buildMarketBasePolicyMigrationProposal(
      data,
      direct,
      state,
      config,
      Game.time,
    );
    const base = direct.baseResourceV3 ?? state;
    direct.baseResourceV3 = {
      ...base,
      proposedPermit: proposal,
    };
    appendAudit(data, {
      action: "market_base_permit_proposed:v3-policy-migration",
      requestId: proposal.proposalId,
    });
    data.pendingDirectDeals = direct.pendingDirectDeals;
    data.directAutomation = direct;
    commitAttempted = true;
    commitMarketSaleDataSnapshot(data);
    return {
      ok: true,
      proposalId: proposal.proposalId,
      kind: proposal.kind,
      laneCount: proposal.targetScope.laneLifecycles.length,
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : "market_base_policy_migration_proposal_failed";
    if (commitAttempted) {
      return {
        ok: false,
        error: "market_base_policy_migration_commit_failed",
      };
    }
    const rejected = copyMarketSaleDataForOperator(sourceData);
    appendAudit(rejected, {
      action: `market_base_permit_proposal_rejected:${reason.slice(0, 80)}`,
    });
    try {
      commitMarketSaleDataSnapshot(rejected);
    } catch {
      // 单次 replacement 失败时原 canonical container 保持不变。
    }
    return { ok: false, error: reason };
  }
}

export function proposeMarketBaseResourcePermit(
  request: MarketBaseResourcePermitRequest = {},
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const sourceData = ensureDataState();
  const sourceDirect = sourceData.directAutomation;
  if (!isContinuousDirectState(sourceDirect)) {
    return {
      ok: false,
      error: "continuous_direct_state_required",
    };
  }
  const config = resolveMarketSaleAutomationConfig();
  const configBlocker = marketBaseResourceV3ConfigBlocker(config);
  if (configBlocker) {
    return {
      ok: false,
      error: configBlocker,
    };
  }
  let commitAttempted = false;
  try {
    const data = copyMarketSaleDataForOperator(sourceData);
    const direct = data.directAutomation;
    if (!isContinuousDirectState(direct)) {
      throw new TypeError("continuous_direct_state_required");
    }
    const active =
      direct.baseResourceV3?.permitChain &&
      hasAcceptedMarketBaseResourceV3Successor(
        direct.baseResourceV3.permitChain,
      );
    const activation = marketBaseResourceActivationState(
      data,
      direct.baseResourceV3,
    );
    const activeAnchor = activation.latched ? activation.anchor : undefined;
    const activationBlocker = activation.latched
      ? activation.blocker
      : undefined;
    if (active && (!activation.latched || !activeAnchor || activationBlocker)) {
      throw new TypeError(
        activationBlocker
          ? activationBlocker
          : "market_base_activation_anchor_required",
      );
    }
    if (active && activeAnchor) {
      const nestedBlocker = validateMarketBaseNestedActivationState(
        direct.baseResourceV3,
        activeAnchor,
        data.trustedFloors,
      );
      if (nestedBlocker) {
        throw new TypeError(nestedBlocker);
      }
    }
    if (
      !active &&
      (request.laneId !== undefined ||
        request.targetStage !== undefined ||
        request.reviewedEvidenceDigest !== undefined ||
        request.continuousReview !== undefined)
    ) {
      throw new TypeError("market_base_first_cutover_request_must_be_empty");
    }
    const builtSuccessor = active
      ? buildMarketBaseV3SuccessorProposal(
          data,
          direct,
          direct.baseResourceV3!,
          activeAnchor
            ? activeAnchor
            : (() => {
                throw new TypeError("market_base_activation_anchor_required");
              })(),
          config,
          Game.time,
          request,
        )
      : undefined;
    const proposal =
      builtSuccessor?.proposal ??
      buildMarketBaseV2CutoverProposal(data, direct, config, Game.time);
    const base =
      direct.baseResourceV3 ??
      reconcileMarketBaseResourcePreflight(undefined, {
        tick: Game.time,
        mode: config.mode,
        config,
      }).state;
    direct.baseResourceV3 = {
      ...base,
      proposedPermit: proposal,
    };
    if (builtSuccessor) {
      data.baseResourceV3ProposedTransition = {
        proposalId: proposal.proposalId,
        ...builtSuccessor.transition,
      };
      if (builtSuccessor.continuousReviews.length > 0) {
        data.baseResourceV3ProposedContinuousReview = {
          proposalId: proposal.proposalId,
          snapshots: cloneMarketBaseOperatorValue(
            builtSuccessor.continuousReviews,
          ),
        };
      } else {
        delete data.baseResourceV3ProposedContinuousReview;
      }
    } else {
      delete data.baseResourceV3ProposedTransition;
      delete data.baseResourceV3ProposedContinuousReview;
    }
    appendAudit(data, {
      action: `market_base_permit_proposed:${proposal.kind}`,
      requestId: proposal.proposalId,
    });
    data.pendingDirectDeals = direct.pendingDirectDeals;
    data.directAutomation = direct;
    commitAttempted = true;
    commitMarketSaleDataSnapshot(data);
    return {
      ok: true,
      proposalId: proposal.proposalId,
      kind: proposal.kind,
      permitId: proposal.targetPermitChain.currentPermitId,
      proposedAt: proposal.proposedAt,
      laneCount: proposal.targetScope.laneLifecycles.length,
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : "market_base_permit_proposal_failed";
    if (commitAttempted) {
      return {
        ok: false,
        error: "market_base_permit_proposal_commit_failed",
      };
    }
    const rejected = copyMarketSaleDataForOperator(sourceData);
    appendAudit(rejected, {
      action: `market_base_permit_proposal_rejected:${reason.slice(0, 80)}`,
    });
    try {
      commitMarketSaleDataSnapshot(rejected);
    } catch {
      // 单次 replacement 失败时原 canonical container 保持不变；不得
      // 为写审计而再次触碰 proposal/permit/anchor。
    }
    return { ok: false, error: reason };
  }
}

function validateMarketBaseProposedTransition(
  data: MarketSaleDataState,
  proposal: MarketBaseResourcePermitProposal,
): MarketBaseResourceProposedTransition | undefined {
  if (proposal.kind !== "v3-successor") {
    return undefined;
  }
  const transition = data.baseResourceV3ProposedTransition;
  if (
    !transition ||
    transition.proposalId !== proposal.proposalId ||
    typeof transition.laneId !== "string" ||
    transition.laneId.length === 0 ||
    transition.laneId.length > 256 ||
    !["canary", "continuous", "suspend"].includes(transition.targetStage) ||
    !Array.isArray(transition.transitionLaneIds) ||
    transition.transitionLaneIds.length === 0 ||
    transition.transitionLaneIds.length > 112 ||
    !transition.transitionLaneIds.includes(transition.laneId)
  ) {
    return undefined;
  }
  const sorted = [...transition.transitionLaneIds].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    new Set(sorted).size !== sorted.length ||
    sorted.some(
      (laneId, index) =>
        typeof laneId !== "string" ||
        laneId.length === 0 ||
        laneId.length > 256 ||
        laneId !== transition.transitionLaneIds[index],
    )
  ) {
    return undefined;
  }
  return transition;
}

function expectedContinuousReviewLaneIds(
  currentPermit: MarketBaseResourcePermit,
  targetPermit: MarketBaseResourcePermit,
): string[] {
  const currentByLane = new Map(
    currentPermit.signedLaneGrants.map((grant) => [grant.laneId, grant]),
  );
  return targetPermit.signedLaneGrants
    .filter((grant) => {
      const prior = currentByLane.get(grant.laneId);
      return (
        grant.status === "active" &&
        grant.stage === "continuous" &&
        grant.newDealGrant === "enabled" &&
        (prior?.stage !== "continuous" ||
          prior.newDealGrant !== "enabled" ||
          prior.reviewDigest !== grant.reviewDigest)
      );
    })
    .map((grant) => grant.laneId)
    .sort((left, right) => left.localeCompare(right));
}

function validateMarketBaseProposedContinuousReviews(
  data: MarketSaleDataState,
  state: MarketBaseResourceV3RuntimeState,
  proposal: MarketBaseResourcePermitProposal,
  transition: MarketBaseResourceProposedTransition,
  config: ResolvedMarketSaleAutomationConfig,
  tick: number,
): string | undefined {
  const currentPermit = currentMarketBaseV3Permit(state);
  const targetRecord =
    proposal.targetPermitChain.retainedPermits[
      proposal.targetPermitChain.retainedPermits.length - 1
    ];
  if (!currentPermit || targetRecord?.schemaVersion !== 3) {
    return "market_base_continuous_review_permit_missing";
  }
  const expected = expectedContinuousReviewLaneIds(currentPermit, targetRecord);
  const binding = data.baseResourceV3ProposedContinuousReview;
  if (expected.length === 0) {
    return binding === undefined
      ? undefined
      : "market_base_continuous_review_unexpected";
  }
  if (
    !binding ||
    binding.proposalId !== proposal.proposalId ||
    !Array.isArray(binding.snapshots) ||
    binding.snapshots.length !== expected.length ||
    binding.snapshots.length > 112
  ) {
    return "market_base_continuous_review_binding_missing";
  }
  const snapshots = [...binding.snapshots].sort((left, right) =>
    left.laneId.localeCompare(right.laneId),
  );
  if (
    snapshots.some(
      (snapshot, index) =>
        snapshot.laneId !== expected[index] ||
        !transition.transitionLaneIds.includes(snapshot.laneId) ||
        !validateMarketBaseContinuousReviewSnapshot(
          snapshot,
          proposal.proposedAt,
        ),
    )
  ) {
    return "market_base_continuous_review_binding_invalid";
  }
  for (const snapshot of snapshots) {
    const targetGrant = targetRecord.signedLaneGrants.find(
      (grant) => grant.laneId === snapshot.laneId,
    );
    const review = targetRecord.reviewedEvidence.find(
      (entry) =>
        entry.laneId === snapshot.laneId && entry.kind === "continuous_review",
    );
    if (
      !targetGrant ||
      targetGrant.reviewDigest !== snapshot.stableReviewDigest ||
      review?.operatorReviewSnapshotDigest !== snapshot.stableReviewDigest
    ) {
      return "market_base_continuous_review_permit_binding_mismatch";
    }
    let current: MarketBaseResourceContinuousReviewSnapshot | undefined;
    try {
      current = buildCurrentMarketBaseContinuousReviewSnapshot(
        data,
        state,
        config,
        snapshot.laneId,
        tick,
      );
    } catch {
      current = undefined;
    }
    if (
      !current ||
      current.stableReviewDigest !== snapshot.stableReviewDigest ||
      canonicalStableHashV1(continuousReviewStablePayload(current)) !==
        canonicalStableHashV1(continuousReviewStablePayload(snapshot))
    ) {
      return "market_base_continuous_review_facts_changed";
    }
  }
  return undefined;
}

function mergeAcceptedMarketBaseScope(
  current: MarketBaseResourceScopeState,
  target: MarketBaseResourceScopeState,
  transitionLaneIds: readonly string[] | undefined,
  firstCutover: boolean,
): MarketBaseResourceScopeState {
  const targetByLane = new Map(
    target.laneLifecycles.map((lane) => [lane.laneId, lane]),
  );
  const transitionSet = new Set(
    firstCutover
      ? current.laneLifecycles.map((lane) => lane.laneId)
      : (transitionLaneIds ?? []),
  );
  const laneLifecycles = current.laneLifecycles.map((lane) => {
    const targetLane = targetByLane.get(lane.laneId);
    if (
      !targetLane ||
      targetLane.stableFingerprint !== lane.stableFingerprint ||
      targetLane.roomInstanceId !== lane.roomInstanceId
    ) {
      throw new TypeError(
        `market_base_proposal_lane_identity_changed:${lane.laneId}`,
      );
    }
    if (!transitionSet.has(lane.laneId)) {
      return lane;
    }
    return {
      ...lane,
      stage: targetLane.stage,
      status: targetLane.status,
      shadowEvidence: firstCutover
        ? targetLane.shadowEvidence
        : lane.shadowEvidence,
    };
  });
  if (laneLifecycles.length !== target.laneLifecycles.length) {
    throw new TypeError("market_base_proposal_lane_set_changed");
  }
  return {
    ...current,
    laneLifecycles,
  };
}

export function acceptMarketBaseResourcePermit(
  proposalId: string,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const normalizedId = typeof proposalId === "string" ? proposalId.trim() : "";
  if (!normalizedId) {
    return {
      ok: false,
      error: "market_base_proposal_id_required",
    };
  }
  const sourceData = ensureDataState();
  const sourceDirect = sourceData.directAutomation;
  if (!isContinuousDirectState(sourceDirect)) {
    return {
      ok: false,
      error: "continuous_direct_state_required",
    };
  }
  const sourceState = sourceDirect.baseResourceV3;
  const sourceProposal = sourceState?.proposedPermit;
  if (
    !sourceState ||
    !sourceProposal ||
    sourceProposal.proposalId !== normalizedId ||
    !validateFrozenMarketBaseProposal(sourceProposal)
  ) {
    return {
      ok: false,
      error: "market_base_proposal_not_found_or_invalid",
    };
  }
  const config = resolveMarketSaleAutomationConfig();
  const configBlocker = marketBaseResourceV3ConfigBlocker(config);
  if (configBlocker) {
    return {
      ok: false,
      error: configBlocker,
    };
  }
  let commitAttempted = false;
  try {
    const data = copyMarketSaleDataForOperator(sourceData);
    const direct = data.directAutomation;
    if (!isContinuousDirectState(direct)) {
      throw new TypeError("continuous_direct_state_required");
    }
    const state = direct.baseResourceV3;
    const proposal = state?.proposedPermit;
    if (
      !state ||
      !proposal ||
      proposal.proposalId !== normalizedId ||
      !validateFrozenMarketBaseProposal(proposal)
    ) {
      throw new TypeError("market_base_proposal_not_found_or_invalid");
    }
    const activation = marketBaseResourceActivationState(data, state);
    const activeAnchor = activation.latched ? activation.anchor : undefined;
    const activationBlocker = activation.latched
      ? activation.blocker
      : undefined;
    const transition = validateMarketBaseProposedTransition(data, proposal);
    if (
      proposal.kind === "v3-successor" &&
      (!transition ||
        !activeAnchor ||
        activationBlocker ||
        validateMarketBaseNestedActivationState(
          state,
          activeAnchor,
          data.trustedFloors,
        ))
    ) {
      throw new TypeError(
        activationBlocker
          ? activationBlocker
          : "market_base_successor_transition_or_anchor_invalid",
      );
    }
    if (proposal.kind === "v2-cutover" && activation.latched) {
      throw new TypeError(
        activationBlocker ||
          "market_base_v2_cutover_after_activation_forbidden",
      );
    }
    if (
      proposal.operatorAuthorizationFingerprint !==
        marketBaseResourceOperatorAuthorizationFingerprint(config) ||
      proposal.accountIdentity !== readLiveMarketBaseAccountIdentity() ||
      proposal.executorShard !== (Game.shard?.name || "")
    ) {
      throw new TypeError("market_base_proposal_authorization_changed");
    }
    if (proposal.kind === "v3-policy-migration") {
      // 迁移允许在 rollback 闩锁态执行（这正是它的恢复语义）；来源校验用
      // 迁移专属指纹，然后整体替换 scope/chain/ledger 并重铸干净 anchor。
      if (
        marketBasePolicyMigrationSourceFingerprint(state) !==
        proposal.sourceStateFingerprint
      ) {
        throw new TypeError("market_base_proposal_source_changed");
      }
      // 与 propose 对称的 WAL 静默复查：propose→accept 窗口内出现的新
      // pending/quarantine 不在 source fingerprint 覆盖内，必须在此拦截，
      // 否则整体替换会静默丢弃 WAL 记录。
      if (
        state.ledger?.pending ||
        Object.keys(direct.quarantinedPendingDirectDeals ?? {}).length > 0
      ) {
        throw new TypeError("market_base_migration_wal_not_quiescent");
      }
      // persistent activation blocker 的恢复边界：迁移只解除常量回拨类
      // 闩锁（它正是迁移的恢复语义）；其他事故闩锁必须走各自协议，
      // 不允许被一次策略迁移掩盖。
      const persistentBlocker = data.baseResourceV3ActivationBlocker;
      if (
        persistentBlocker &&
        persistentBlocker.code !==
          "market_base_v3_config_rollback_after_cutover"
      ) {
        throw new TypeError(
          `market_base_migration_blocker_unrecoverable:${persistentBlocker.code}`,
        );
      }
      const migrationNext: MarketBaseResourceV3RuntimeState = {
        ...state,
        scope: cloneMarketBaseOperatorValue(proposal.targetScope),
        permitChain: cloneMarketBaseOperatorValue(proposal.targetPermitChain),
        ledger: cloneMarketBaseOperatorValue(proposal.targetLedger),
        pricingRatchet: state.pricingRatchet!,
        cutoverLatched: true,
        lastLifecycleAppliedAttemptSeq:
          proposal.targetLedger.finalizedAttemptSeq,
      };
      delete migrationNext.proposedPermit;
      delete migrationNext.blocker;
      delete migrationNext.readinessAuthorization;
      delete migrationNext.preflightAt;
      const migrationTrustedFloors = synchronizeMarketBaseTrustedFloors(
        data.trustedFloors,
        migrationNext.pricingRatchet!,
        Game.time,
      );
      const migrationAnchor = buildMarketBasePolicyMigrationAnchor({
        proposal,
        scope: migrationNext.scope!,
        direct,
        acceptedAt: Game.time,
      });
      const migrationNestedBlocker =
        validateMarketBaseNestedActivationState(
          migrationNext,
          migrationAnchor,
          migrationTrustedFloors,
        );
      if (migrationNestedBlocker) {
        throw new TypeError(migrationNestedBlocker);
      }
      direct.baseResourceV3 = migrationNext;
      data.trustedFloors = migrationTrustedFloors;
      data.baseResourceV3ActivationAnchor = migrationAnchor;
      data.baseResourceV3ActivationAnchorMirror =
        cloneMarketBaseOperatorValue(migrationAnchor);
      // 干净 anchor 落位的同时必须清除 persistent blocker，否则下一 tick
      // activation gate 会因"anchor 无 blocker 但 persistent 存在"重新
      // 闩锁（market_base_activation_blocker_anchor_missing），且二次
      // 迁移会被 no_policy_change 拒绝——死锁只能手改 Memory。
      delete data.baseResourceV3ActivationBlocker;
      delete data.baseResourceV3ProposedTransition;
      delete data.baseResourceV3ProposedContinuousReview;
      appendAudit(data, {
        action: "market_base_permit_accepted:v3-policy-migration",
        requestId: normalizedId,
      });
      data.pendingDirectDeals = direct.pendingDirectDeals;
      data.directAutomation = direct;
      commitAttempted = true;
      commitMarketSaleDataSnapshot(data);
      return {
        ok: true,
        proposalId: normalizedId,
        kind: proposal.kind,
        permitId:
          proposal.targetPermitChain.retainedPermits[
            proposal.targetPermitChain.retainedPermits.length - 1
          ].permitId,
        permitEpoch: proposal.targetPermitChain.currentPermitEpoch,
      };
    }
    const sourceBlocker =
      proposal.kind === "v2-cutover"
        ? validateV2CutoverSource(data, direct, Game.time)
        : validateV3SuccessorSource(data, state, config, Game.time);
    if (sourceBlocker) {
      throw new TypeError(sourceBlocker);
    }
    const currentSourceFingerprint =
      proposal.kind === "v2-cutover"
        ? marketBaseV2SourceStateFingerprint(data, direct)
        : marketBaseV3SourceStateFingerprint(
            data,
            direct,
            state,
            transition?.transitionLaneIds ?? [],
          );
    if (currentSourceFingerprint !== proposal.sourceStateFingerprint) {
      throw new TypeError("market_base_proposal_source_changed");
    }
    const scopeResult = reconcileLiveMarketBaseResourceScope({
      tick: Game.time,
      accountIdentity: proposal.accountIdentity,
      observations: collectLiveMarketBaseRoomObservations(
        proposal.accountIdentity,
      ),
      previous: state.scope,
      permitChain: state.permitChain,
      pinnedLaneIds: state.ledger?.pending
        ? [state.ledger.pending.historicalLane.laneId]
        : [],
      ...(activeAnchor
        ? {
            expectedPreviousRoomCheckpointCommitment:
              activeAnchor.roomRegistryCheckpointCommitment,
            expectedPermitLaneTombstoneCheckpointCommitment:
              activeAnchor.laneTombstoneCheckpointCommitment,
            expectedPreviousLaneTombstoneDischargeCheckpointCommitment:
              activeAnchor.laneTombstoneDischargeCheckpointCommitment,
          }
        : {}),
    });
    if (
      "blockers" in scopeResult ||
      scopeResult.state.rosterFingerprint !== proposal.rosterFingerprint ||
      scopeResult.state.laneSetFingerprint !== proposal.laneSetFingerprint
    ) {
      throw new TypeError("market_base_proposal_scope_changed");
    }
    const currentScope = scopeResult.state;
    const lifecycleBlocker =
      validateMarketBaseScopeLifecycleEvidence(currentScope);
    if (lifecycleBlocker) {
      throw new TypeError(lifecycleBlocker);
    }
    if (proposal.kind === "v3-successor" && transition) {
      const reviewBlocker = validateMarketBaseProposedContinuousReviews(
        data,
        state,
        proposal,
        transition,
        config,
        Game.time,
      );
      if (reviewBlocker) {
        throw new TypeError(reviewBlocker);
      }
    }
    const acceptedScope = mergeAcceptedMarketBaseScope(
      currentScope,
      proposal.targetScope,
      transition?.transitionLaneIds,
      proposal.kind === "v2-cutover",
    );
    const nextState: MarketBaseResourceV3RuntimeState = {
      ...state,
      scope: cloneMarketBaseOperatorValue(acceptedScope),
      permitChain: cloneMarketBaseOperatorValue(proposal.targetPermitChain),
      ledger: cloneMarketBaseOperatorValue(proposal.targetLedger),
      pricingRatchet: cloneMarketBaseOperatorValue(
        proposal.kind === "v2-cutover"
          ? proposal.targetPricingRatchet
          : state.pricingRatchet!,
      ),
      cutoverLatched: true,
      lastLifecycleAppliedAttemptSeq: proposal.targetLedger.finalizedAttemptSeq,
    };
    delete nextState.proposedPermit;
    delete nextState.blocker;
    delete nextState.readinessAuthorization;
    delete nextState.preflightAt;
    const nextTrustedFloors =
      proposal.kind === "v2-cutover"
        ? cloneMarketBaseOperatorValue(proposal.targetTrustedFloors)
        : synchronizeMarketBaseTrustedFloors(
            data.trustedFloors,
            nextState.pricingRatchet!,
            Game.time,
          );
    const nextAnchor =
      proposal.kind === "v2-cutover"
        ? buildMarketBaseResourceActivationAnchor({
            proposal,
            scope: nextState.scope!,
            direct,
            acceptedAt: Game.time,
          })
        : advanceMarketBaseResourceActivationAnchor(
            activeAnchor!,
            nextState,
            nextTrustedFloors,
            Game.time,
          );
    const nestedBlocker = validateMarketBaseNestedActivationState(
      nextState,
      nextAnchor,
      nextTrustedFloors,
    );
    if (nestedBlocker) {
      throw new TypeError(nestedBlocker);
    }
    direct.baseResourceV3 = nextState;
    data.trustedFloors = nextTrustedFloors;
    data.baseResourceV3ActivationAnchor = nextAnchor;
    data.baseResourceV3ActivationAnchorMirror =
      cloneMarketBaseOperatorValue(nextAnchor);
    delete data.baseResourceV3ProposedTransition;
    delete data.baseResourceV3ProposedContinuousReview;
    appendAudit(data, {
      action: `market_base_permit_accepted:${proposal.kind}`,
      requestId: normalizedId,
    });
    data.pendingDirectDeals = direct.pendingDirectDeals;
    data.directAutomation = direct;
    commitAttempted = true;
    commitMarketSaleDataSnapshot(data);
    return {
      ok: true,
      proposalId: normalizedId,
      kind: proposal.kind,
      permitId: nextState.permitChain.currentPermitId,
      permitEpoch: nextState.permitChain.currentPermitEpoch,
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : "market_base_permit_accept_failed";
    if (commitAttempted) {
      return {
        ok: false,
        error: "market_base_permit_accept_commit_failed",
      };
    }
    const rejected = copyMarketSaleDataForOperator(sourceData);
    appendAudit(rejected, {
      action: `market_base_permit_accept_rejected:${reason.slice(0, 80)}`,
      requestId: normalizedId,
    });
    try {
      commitMarketSaleDataSnapshot(rejected);
    } catch {
      // 审计 replacement 失败时保持原 proposal/anchor canonical root。
    }
    return { ok: false, error: reason };
  }
}

const MARKET_BASE_STATUS_ROOM_LIMIT = 16;
const MARKET_BASE_STATUS_KNOWN_ROOM_LIMIT = 32;
const MARKET_BASE_STATUS_LANE_LIMIT = 16;

function boundedMarketBaseStatusRecord(
  value: Record<string, { cap: number; confirmed: number; unmatched: number }>,
  limit: number,
): {
  total: number;
  entries: Array<{
    key: string;
    cap: number;
    confirmed: number;
    unmatched: number;
  }>;
  truncated: boolean;
} {
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return {
    total: entries.length,
    entries: entries.slice(0, limit).map(([key, quota]) => ({
      key,
      cap: quota.cap,
      confirmed: quota.confirmed,
      unmatched: quota.unmatched,
    })),
    truncated: entries.length > limit,
  };
}

export function marketBaseResourceStatus(): unknown {
  const data = ensureDataState();
  const direct = data.directAutomation;
  if (!isContinuousDirectState(direct)) {
    return {
      tick: Game.time,
      error: "continuous_direct_state_required",
    };
  }
  const state = direct.baseResourceV3;
  const proposal = state?.proposedPermit;
  const permit = state ? currentMarketBaseV3Permit(state) : undefined;
  const grants = permit?.signedLaneGrants ?? [];
  const grantCounts = grants.reduce(
    (counts, grant) => {
      const key = `${grant.stage}:${grant.newDealGrant}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    },
    {} as Record<string, number>,
  );
  const continuousReviewCandidates = state?.scope
    ? state.scope.laneLifecycles
        .filter(
          (lane) =>
            lane.status === "suspended" &&
            (lane.stage === "review_paused" || lane.stage === "continuous"),
        )
        .map((lane) => {
          try {
            return {
              laneId: lane.laneId,
              snapshot: buildCurrentMarketBaseContinuousReviewSnapshot(
                data,
                state,
                resolveMarketSaleAutomationConfig(),
                lane.laneId,
                Game.time,
              ),
            };
          } catch (error) {
            return {
              laneId: lane.laneId,
              blocker:
                error instanceof Error
                  ? error.message
                  : "market_base_continuous_review_unavailable",
            };
          }
        })
    : [];
  const scope = state?.scope;
  const quota = state?.quotaProjection;
  const hubRuntime = Memory.runtime?.hub;
  const hubSnapshot = hubRuntime?.committedProtectionSnapshot;
  const currentRoster = scope
    ? [...scope.sellerRooms]
        .sort((left, right) => left.roomName.localeCompare(right.roomName))
        .slice(0, MARKET_BASE_STATUS_ROOM_LIMIT)
        .map((room) => ({
          roomName: room.roomName,
          roomInstanceId: room.roomInstanceId,
          incarnation: room.incarnation,
          roomClass: room.roomClass,
          terminalId: room.terminalId,
          status: room.status,
        }))
    : [];
  const terminalEnergyReadiness = scope
    ? [...scope.sellerRooms]
        .sort((left, right) => left.roomName.localeCompare(right.roomName))
        .slice(0, MARKET_BASE_STATUS_ROOM_LIMIT)
        .map((room) => {
          const readiness =
            Memory.runtime?.resourceControl?.rooms?.[room.roomName]
              ?.marketEnergyReadiness;
          return {
            roomName: room.roomName,
            roomInstanceId: room.roomInstanceId,
            terminalId: room.terminalId,
            observation: readiness
              ? {
                  revision: readiness.revision,
                  observedAt: readiness.observedAt,
                  expiresAt: readiness.expiresAt,
                  authorizationRevision: readiness.authorizationRevision,
                  authorized: readiness.authorized,
                  effectivePostDealEnergyReserve:
                    readiness.effectivePostDealEnergyReserve,
                  desiredTerminalEnergy: readiness.desiredTerminalEnergy,
                  plannedFeedAmount: readiness.plannedFeedAmount,
                  contributionCount: readiness.contributionCount,
                  status: readiness.status,
                  blocker: readiness.blocker,
                }
              : undefined,
          };
        })
    : [];
  return {
    tick: Game.time,
    active: Boolean(
      state?.permitChain &&
      hasAcceptedMarketBaseResourceV3Successor(state.permitChain),
    ),
    cutoverLatched: state?.cutoverLatched === true,
    blocker: state?.blocker,
    catalog: state?.catalog
      ? {
          revision: state.catalog.revision,
          configRevision: state.catalog.configRevision,
          resources: [...state.catalog.resources].slice(
            0,
            MARKET_BASE_RESOURCE_CATALOG.length,
          ),
        }
      : undefined,
    continuousReviewCandidates,
    proposal: proposal
      ? {
          proposalId: proposal.proposalId,
          kind: proposal.kind,
          proposedAt: proposal.proposedAt,
          permitId: proposal.targetPermitChain.currentPermitId,
          permitEpoch: proposal.targetPermitChain.currentPermitEpoch,
          rosterFingerprint: proposal.rosterFingerprint,
          laneSetFingerprint: proposal.laneSetFingerprint,
        }
      : undefined,
    scope: scope
      ? {
          roomCount: scope.sellerRooms.length,
          laneCount: scope.laneLifecycles.length,
          rosterFingerprint: scope.rosterFingerprint,
          laneSetFingerprint: scope.laneSetFingerprint,
          admission: {
            checkpointCommitment: scope.roomRegistry.checkpointCommitment,
            lastReconciledTick: scope.roomRegistry.lastReconciledTick,
            knownRoomCount: scope.roomRegistry.knownRoomNames.length,
            knownRoomNames: scope.roomRegistry.knownRoomNames.slice(
              0,
              MARKET_BASE_STATUS_KNOWN_ROOM_LIMIT,
            ),
            truncated:
              scope.roomRegistry.knownRoomNames.length >
              MARKET_BASE_STATUS_KNOWN_ROOM_LIMIT,
          },
          currentRoster,
          currentRosterTruncated:
            scope.sellerRooms.length > MARKET_BASE_STATUS_ROOM_LIMIT,
          lifecycleCounts: scope.laneLifecycles.reduce(
            (counts, lane) => {
              const key = `${lane.stage}:${lane.status}`;
              counts[key] = (counts[key] || 0) + 1;
              return counts;
            },
            {} as Record<string, number>,
          ),
          lifecycleSample: [...scope.laneLifecycles]
            .sort((left, right) => left.laneId.localeCompare(right.laneId))
            .slice(0, MARKET_BASE_STATUS_LANE_LIMIT)
            .map((lane) => ({
              laneId: lane.laneId,
              resource: lane.resource,
              sellerRoomName: lane.sellerRoomName,
              roomInstanceId: lane.roomInstanceId,
              stage: lane.stage,
              status: lane.status,
              completeCycles: lane.shadowEvidence.completeCycles,
              lastCompleteTick: lane.shadowEvidence.lastCompleteTick,
            })),
          lifecycleSampleTruncated:
            scope.laneLifecycles.length > MARKET_BASE_STATUS_LANE_LIMIT,
        }
      : undefined,
    permit: permit
      ? {
          permitId: permit.permitId,
          epoch: permit.epoch,
          grantCounts,
          ratchetHighWater: permit.ratchetHighWater,
        }
      : undefined,
    ledger: state?.ledger
      ? {
          finalizedAttemptSeq: state.ledger.finalizedAttemptSeq,
          nextAttemptSeq: state.ledger.nextAttemptSeq,
          receiptHeadHash: state.ledger.receiptHeadHash,
          checkpointHash: state.ledger.checkpoint.checkpointHash,
          permitAnchorHash: state.ledger.permitAnchor.anchorHash,
          retryNotBefore: state.ledger.retryNotBefore,
          pendingAttemptSeq: state.ledger.pending?.attemptSeq,
          lifetimeConfirmed: state.ledger.lifetimeConfirmed,
          legacyV2ConfirmedCanaries: state.ledger.legacyV2ConfirmedCanaries,
          confirmedCanaryLaneIds: Object.keys(
            state.ledger.confirmedCanaries,
          ).sort(),
          blocker: state.ledger.blocker,
        }
      : undefined,
    quota: quota
      ? {
          observedAt: quota.observedAt,
          cooldownNotBefore: quota.cooldownNotBefore,
          retryNotBefore: quota.retryNotBefore,
          global: quota.global,
          resources: boundedMarketBaseStatusRecord(
            quota.resources,
            MARKET_BASE_RESOURCE_CATALOG.length,
          ),
          rooms: boundedMarketBaseStatusRecord(
            quota.rooms,
            MARKET_BASE_STATUS_ROOM_LIMIT,
          ),
          lanes: boundedMarketBaseStatusRecord(
            quota.lanes,
            MARKET_BASE_STATUS_LANE_LIMIT,
          ),
        }
      : undefined,
    hubProtection: {
      attemptHighWater: hubRuntime?.protectionAttemptHighWater,
      currentAttempt: hubRuntime?.currentProtectionAttempt
        ? {
            attemptRevision:
              hubRuntime.currentProtectionAttempt.attemptRevision,
            configIncarnation:
              hubRuntime.currentProtectionAttempt.configIncarnation,
            startedAt: hubRuntime.currentProtectionAttempt.startedAt,
            finishedAt: hubRuntime.currentProtectionAttempt.finishedAt,
            status: hubRuntime.currentProtectionAttempt.status,
            valid: hubRuntime.currentProtectionAttempt.valid,
            reason: hubRuntime.currentProtectionAttempt.reason,
          }
        : undefined,
      committedMarker: hubSnapshot
        ? {
            schema: hubSnapshot.schema,
            planRevision: hubSnapshot.planRevision,
            configIncarnation: hubSnapshot.configIncarnation,
            observedAt: hubSnapshot.observedAt,
            expiresAt: hubSnapshot.expiresAt,
            status: hubSnapshot.status,
            valid: hubSnapshot.valid,
            hubRoomName: hubSnapshot.marker.hubRoomName,
            planMode: hubSnapshot.marker.planMode,
            targetCompoundCount: hubSnapshot.marker.targetCompounds.length,
            failureReason: hubSnapshot.failureReason,
          }
        : undefined,
    },
    terminalEnergyReadiness: {
      roomCount: scope?.sellerRooms.length ?? 0,
      rooms: terminalEnergyReadiness,
      truncated:
        (scope?.sellerRooms.length ?? 0) > MARKET_BASE_STATUS_ROOM_LIMIT,
    },
    cpu: {
      preflightAt: state?.preflightAt,
      planningObservedAt: state?.lastPlanningSnapshot?.observedAt,
      planningCpuUsed: state?.lastPlanningSnapshot?.cpuUsed,
      blocker: state?.lastPlanningSnapshot?.blocker ?? state?.blocker,
    },
    pricingRatchet: state?.pricingRatchet,
    lastPlanningSnapshot: state?.lastPlanningSnapshot,
  };
}

export function grantMarketSaleMutationLease(
  epoch: string,
  expiresAt: number,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const normalizedEpoch = typeof epoch === "string" ? epoch.trim() : "";
  if (!normalizedEpoch) return { ok: false, error: "epoch_required" };
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Game.time) {
    return { ok: false, error: "expires_at_must_be_future_tick" };
  }
  const data = ensureDataState();
  if (data.pendingCreate) {
    return { ok: false, error: "pending_create_exists" };
  }
  if (Object.keys(data.pendingMutations).length > 0) {
    return { ok: false, error: "pending_mutation_exists" };
  }
  if (!Memory.cfg) Memory.cfg = {};
  if (!Memory.cfg.marketSaleAutomation) {
    Memory.cfg.marketSaleAutomation = {};
  }
  const baselineIds = readLiveOrders().map((order) => order.id);
  const lease: OrderMutationLease = {
    epoch: normalizedEpoch,
    grantedAt: Game.time,
    expiresAt,
    baselineHash: hashOrderIds(baselineIds),
  };
  Memory.cfg.marketSaleAutomation.orderMutationLease = lease;
  appendAudit(data, {
    action: "mutation_lease_granted",
    candidateIds: baselineIds,
  });
  return { ok: true, lease: { ...lease }, baselineIds };
}

export function revokeMarketSaleMutationLease(
  reason = "operator_revoked",
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const lease = Memory.cfg?.marketSaleAutomation?.orderMutationLease;
  if (!lease) return { ok: false, error: "lease_missing" };
  lease.revokedAt = Game.time;
  lease.revokeReason =
    typeof reason === "string" && reason.trim()
      ? reason.trim().slice(0, 100)
      : "operator_revoked";
  appendAudit(ensureDataState(), { action: "mutation_lease_revoked" });
  return { ok: true, lease: { ...lease } };
}

export function attestMarketSalePendingCreate(orderId: string): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  const pending = data.pendingCreate;
  if (!pending) return { ok: false, error: "pending_create_missing" };
  const liveOrders = readLiveOrders();
  const result = attestPendingCreateOrder({
    pending,
    liveOrders,
    orderId,
    gameTime: Game.time,
  });
  appendAudit(data, {
    action: result.adoptedOrderId
      ? "operator_attestation_accepted"
      : "operator_attestation_rejected",
    orderId,
    requestId: pending.requestId,
    candidateIds: liveOrders
      .filter((order) => !pending.baselineOrderIds.includes(order.id))
      .map((order) => order.id),
  });
  if (!result.adoptedOrderId) {
    if (result.pending) {
      data.pendingCreate = result.pending as unknown as OwnedPendingCreate;
    }
    return { ok: false, error: result.blockedReason || "attestation_failed" };
  }
  const context = makeContext();
  context.data.pendingCreate = pending;
  if (!adoptPendingOrder(context, pending, result.adoptedOrderId)) {
    return { ok: false, error: "adoption_failed" };
  }
  return { ok: true, orderId: result.adoptedOrderId };
}

export function resolveMarketSalePendingCreateAbsence(
  candidateIds: string[],
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  const pending = data.pendingCreate;
  if (!pending) return { ok: false, error: "pending_create_missing" };
  if (
    !Array.isArray(candidateIds) ||
    candidateIds.some((id) => typeof id !== "string")
  ) {
    return { ok: false, error: "candidate_ids_invalid" };
  }
  const uniqueIds = [
    ...new Set(candidateIds.map((id) => id.trim()).filter(Boolean)),
  ].sort();
  const liveIds = new Set(readLiveOrders().map((order) => order.id));
  const stillPresent = uniqueIds.filter((id) => liveIds.has(id));
  if (stillPresent.length > 0) {
    appendAudit(data, {
      action: "operator_absence_resolution_rejected",
      requestId: pending.requestId,
      candidateIds: stillPresent,
    });
    return { ok: false, error: "candidate_still_present", stillPresent };
  }
  data.pendingCreate = {
    ...pending,
    operatorResolutionCandidateIds: uniqueIds,
    zeroDeltaConfirmations: 0,
    lastZeroDeltaTick: undefined,
    status: "ambiguous",
  };
  appendAudit(data, {
    action: "operator_absence_resolution_requested",
    requestId: pending.requestId,
    candidateIds: uniqueIds,
  });
  return { ok: true, candidateIds: uniqueIds, confirmationsRequired: 2 };
}

function extractLedgerCarriedDebt(
  data: MarketSaleDataState,
  ledger: MarketSaleFeeLedgerState,
  resourceType: ResourceConstant,
): { ledger: MarketSaleFeeLedgerState; amountMilli: number } | undefined {
  const extracted = takeCarriedFeeDebt(ledger, resourceType);
  const current = data.carriedFeeDebtMilli[resourceType] ?? 0;
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(current + extracted.feeDebtMilli)
  ) {
    return undefined;
  }
  return {
    ledger: extracted.ledger,
    amountMilli: extracted.feeDebtMilli,
  };
}

function switchToNextManagedFeeGap(data: MarketSaleDataState): void {
  if (data.feeLedger?.reconcileGap) return;
  const managed = Object.values(data.managedOrders).sort((left, right) =>
    left.orderId.localeCompare(right.orderId),
  );
  const external = managed.find(
    (candidate) => candidate.externalMutationGap !== undefined,
  );
  if (external) {
    data.feeLedger = markExternalOrderMutationFeeGap({
      ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
      gameTime: external.externalMutationGap!.detectedAt,
      orderId: external.orderId,
    });
    return;
  }
  const disappeared = managed.find(
    (candidate) => candidate.disappearanceGap !== undefined,
  );
  if (!disappeared) return;
  data.feeLedger = reconcileDisappearedOrderFeeDebt({
    ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
    gameTime: disappeared.disappearanceGap!.detectedAt,
    orderId: disappeared.orderId,
    resourceType: disappeared.resourceType,
    remainingFeeDebtMilli: nonNegativeInteger(disappeared.feeDebtMilli),
    reason: "unknown",
  }).ledger;
}

/**
 * Operator-only closeout for a managed order whose live immutable state
 * changed outside our pending-mutation protocol.  The supplied milli-credit
 * debt must conservatively include every known and externally incurred fee.
 */
export function resolveMarketSaleExternalOrderMutation(
  orderId: string,
  verifiedRemainingFeeDebtMilli: number,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const normalizedOrderId = typeof orderId === "string" ? orderId.trim() : "";
  if (!normalizedOrderId) return { ok: false, error: "order_id_required" };
  if (
    !Number.isSafeInteger(verifiedRemainingFeeDebtMilli) ||
    verifiedRemainingFeeDebtMilli < 0
  ) {
    return {
      ok: false,
      error: "verified_remaining_fee_debt_milli_invalid",
    };
  }
  const data = ensureDataState();
  const managed = data.managedOrders[normalizedOrderId];
  if (!managed?.externalMutationGap) {
    return { ok: false, error: "external_mutation_gap_missing" };
  }
  if (verifiedRemainingFeeDebtMilli < managed.feeDebtMilli) {
    return { ok: false, error: "verified_fee_debt_below_known_debt" };
  }
  if (data.pendingMutations[normalizedOrderId]) {
    return { ok: false, error: "pending_mutation_exists" };
  }
  if (readLiveOrders().some((order) => order.id === normalizedOrderId)) {
    return { ok: false, error: "managed_order_still_present" };
  }
  const ledger = data.feeLedger || createEmptyMarketSaleFeeLedger();
  let resolved:
    { ledger: MarketSaleFeeLedgerState; amountMilli: number } | undefined;
  try {
    const reconciled = resolveExternalOrderMutationFeeGap({
      ledger,
      orderId: normalizedOrderId,
      resourceType: managed.resourceType,
      verifiedRemainingFeeDebtMilli,
    });
    resolved = extractLedgerCarriedDebt(data, reconciled, managed.resourceType);
  } catch {
    return { ok: false, error: "fee_reconcile_gap_mismatch" };
  }
  if (!resolved) return { ok: false, error: "carried_fee_debt_overflow" };
  data.feeLedger = resolved.ledger;
  carryFeeDebt(
    data,
    managed.resourceType,
    resolved.amountMilli,
    `external-mutation-carry:${normalizedOrderId}:${managed.externalMutationGap.detectedAt}`,
  );
  delete data.managedOrders[normalizedOrderId];
  switchToNextManagedFeeGap(data);
  appendAudit(data, {
    action: "external_order_mutation_reconciled",
    orderId: normalizedOrderId,
  });
  return {
    ok: true,
    orderId: normalizedOrderId,
    carriedFeeDebtMilli: resolved.amountMilli,
  };
}

export function resolveMarketSaleOrderDisappearance(
  orderId: string,
  classification: "policy_cancelled" | "server_expired",
  verifiedRefundMilli?: number,
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const normalizedOrderId = typeof orderId === "string" ? orderId.trim() : "";
  if (!normalizedOrderId) return { ok: false, error: "order_id_required" };
  if (
    classification !== "policy_cancelled" &&
    classification !== "server_expired"
  ) {
    return { ok: false, error: "disappearance_classification_invalid" };
  }
  if (
    classification === "policy_cancelled" &&
    verifiedRefundMilli !== undefined
  ) {
    return { ok: false, error: "policy_cancel_does_not_refund" };
  }
  if (
    classification === "server_expired" &&
    (!Number.isSafeInteger(verifiedRefundMilli) ||
      (verifiedRefundMilli as number) < 0)
  ) {
    return { ok: false, error: "verified_refund_milli_required" };
  }
  const data = ensureDataState();
  const managed = data.managedOrders[normalizedOrderId];
  if (!managed?.disappearanceGap || managed.externalMutationGap) {
    return { ok: false, error: "disappearance_gap_missing" };
  }
  if (data.pendingMutations[normalizedOrderId]) {
    return { ok: false, error: "pending_mutation_exists" };
  }
  if (readLiveOrders().some((order) => order.id === normalizedOrderId)) {
    return { ok: false, error: "managed_order_still_present" };
  }

  let reconciliation: ReturnType<typeof resolveDisappearedOrderFeeGap>;
  try {
    reconciliation = resolveDisappearedOrderFeeGap({
      ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
      gameTime: Game.time,
      orderId: normalizedOrderId,
      resourceType: managed.resourceType,
      remainingFeeDebtMilli: nonNegativeInteger(managed.feeDebtMilli),
      reason: classification,
      verifiedRefundMilli:
        classification === "server_expired" ? verifiedRefundMilli : undefined,
    });
  } catch {
    return { ok: false, error: "fee_reconcile_gap_mismatch" };
  }
  if (!reconciliation.resolved) {
    data.feeLedger = reconciliation.ledger;
    managed.disappearanceGap.reason =
      reconciliation.ledger.reconcileGap?.reason ===
      "server_expiry_refund_mismatch"
        ? "server_expiry_refund_mismatch"
        : "unknown_disappearance";
    return { ok: false, error: "verified_refund_mismatch" };
  }
  const resolved = extractLedgerCarriedDebt(
    data,
    reconciliation.ledger,
    managed.resourceType,
  );
  if (!resolved) return { ok: false, error: "carried_fee_debt_overflow" };
  data.feeLedger = resolved.ledger;
  carryFeeDebt(
    data,
    managed.resourceType,
    resolved.amountMilli,
    `disappearance-carry:${normalizedOrderId}:${managed.disappearanceGap.detectedAt}`,
  );
  if (
    classification === "server_expired" &&
    typeof verifiedRefundMilli === "number" &&
    verifiedRefundMilli > 0
  ) {
    boundedPush(
      data.feeEvents,
      {
        id: `server-expiry-refund:${normalizedOrderId}:${Game.time}`,
        tick: Game.time,
        resource: managed.resourceType,
        amountMilli: verifiedRefundMilli,
        kind: "refund",
      },
      MAX_FEE_EVENTS,
    );
  }
  delete data.managedOrders[normalizedOrderId];
  switchToNextManagedFeeGap(data);
  appendAudit(data, {
    action: `order_disappearance_reconciled:${classification}`,
    orderId: normalizedOrderId,
  });
  return {
    ok: true,
    orderId: normalizedOrderId,
    classification,
    refundedFeeDebtMilli: reconciliation.refundedFeeDebtMilli,
    carriedFeeDebtMilli: resolved.amountMilli,
  };
}

export function expandMarketSaleCanary(configRevision: string): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const config = resolveMarketSaleAutomationConfig();
  if (!config.configRevision || configRevision !== config.configRevision) {
    return { ok: false, error: "config_revision_mismatch" };
  }
  if (!Memory.cfg?.marketSaleAutomation) {
    return { ok: false, error: "market_sale_config_missing" };
  }
  Memory.cfg.marketSaleAutomation.canary ||= {};
  Memory.cfg.marketSaleAutomation.canary.allowExpansion = true;
  const data = ensureDataState();
  data.expansionGrant = {
    configRevision,
    grantedAt: Game.time,
  };
  appendAudit(data, { action: "canary_expansion_granted" });
  return { ok: true, configRevision, grantedAt: Game.time };
}

export function emergencyStopMarketSaleAutomation(
  reason = "operator_requested",
): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  if (!Memory.cfg) Memory.cfg = {};
  Memory.cfg.marketSaleAutomation ||= {};
  Memory.cfg.marketSaleAutomation.mode = "emergencyStop";
  appendAudit(ensureDataState(), {
    action: `emergency_stop:${String(reason).slice(0, 100)}`,
  });
  return { ok: true, requestedAt: Game.time };
}

export function marketSaleAutomationStatus(): unknown {
  const data = ensureDataState();
  return {
    tick: Game.time,
    config: resolveMarketSaleAutomationConfig(),
    runtime: Memory.runtime?.marketSaleAutomation || null,
    data,
    direct: isContinuousDirectState(data.directAutomation)
      ? projectContinuousDirectStatus(data.directAutomation, Game.time)
      : data.directAutomation || null,
    legacyLatches: {
      resourceControl: Memory.cfg?.resourceControl?.market?.enabled === false,
      factoryControl: Memory.cfg?.factoryControl?.market?.enabled === false,
    },
  };
}
