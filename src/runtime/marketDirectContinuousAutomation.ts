import { AUTHORITY_ROOMS } from "@/config/deployment";
import {
  claimPreparedDirectMarketClaims,
  executePreparedDirectMarketDeal,
  getMarketAccountClaim,
  getMarketActionJournal,
  getTerminalActionClaim,
  hasMarketActionIntentThisTick,
  isExplicitMarketNonOkReturnCode,
  releasePreparedDirectMarketClaims,
} from "@/runtime/marketActionArbiter";
import {
  MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION,
  MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT,
  marketDirectContinuousConfigMismatchReasons,
  type ResolvedMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  CONTINUOUS_PERMIT_GENESIS,
  CONTINUOUS_PLANNED_AMOUNT,
  CONTINUOUS_RECEIPT_GENESIS,
  CONTINUOUS_CONFIRMED_CANARY_CHECKPOINT_GENESIS,
  LEGACY_X_PROCESSED_EVIDENCE_KEY,
  advanceContinuousWal,
  canonicalStableHashV1,
  computeContinuousQuota,
  failClosedContinuousLedger,
  migrateLegacyXSeedLedger,
  prepareContinuousAttempt,
  recordContinuousOutcome,
  validateContinuousLedger,
  type ContinuousOutcome,
  type ContinuousExecutionEvidence,
  type ContinuousPendingAttempt,
  type LegacyV1SafeStateFixture,
  type LegacyXReviewedOutcomeFixture,
  type MarketDirectContinuousLedger,
} from "@/runtime/marketDirectContinuousLedger";
import {
  MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
  isExactMarketDirectContinuousSecondRead,
  planMarketDirectContinuous,
  type MarketDirectContinuousCandidate,
  type MarketDirectContinuousEntryInput,
  type MarketDirectContinuousLaneInput,
  type MarketDirectContinuousPlanningResult,
  type PlanMarketDirectContinuousInput,
} from "@/runtime/marketDirectContinuousPlanner";
import {
  LEGACY_REVIEWED_X_CANARY_OUTCOME_IDENTITY,
  MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
  MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
  MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS,
  MARKET_DIRECT_CONTINUOUS_SCHEMA,
  appendMarketDirectContinuousPermit,
  buildMarketDirectContinuousPermit,
  createLegacyReviewedXEntryLifecycle,
  createMarketDirectEntryLifecycle,
  createMarketDirectPermitChainState,
  marketDirectContinuousEvidenceFingerprint,
  marketDirectLifecycleEvidenceDigest,
  marketDirectContinuousLegacyXOutcomeFingerprint,
  marketDirectContinuousSharedFingerprint,
  marketDirectPermitAllowsNewDeal,
  observeMarketDirectShadowCycle,
  promoteMarketDirectEntryToCanary,
  promoteMarketDirectEntryToContinuous,
  recordMarketDirectCanaryConfirmation,
  validateMarketDirectContinuousPermitChain,
  type MarketDirectContinuousPermit,
  type MarketDirectEntryLifecycle,
  type MarketDirectEntryLifecycleStage,
  type MarketDirectNewDealGrant,
  type MarketDirectPermitChainState,
  type MarketDirectPermitEntryGrant,
  type MarketDirectPermitEvidenceBinding,
} from "@/runtime/marketDirectContinuousPolicy";
import type {
  DirectAutomationState,
  DirectRuntimeCandidate,
} from "@/runtime/marketSaleDirectAutomation";
import type {
  DirectDealOutcome,
  DirectOutgoingTransaction,
} from "@/runtime/marketSaleDirectPending";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
import {
  priceToMilliDown,
} from "@/runtime/marketSalePricing";
import { listCarrierDispatchEntriesByRoom } from "@/runtime/carrierTaskBoard";
import {
  encodeCarrierDispatchStepKey,
  isCarrierDispatchStepKey,
} from "@/runtime/dispatchOwnership/ref";
import { normalizeNumber } from "@/runtime/configNormalize";
import { listProductionReservations } from "@/runtime/resourceReservation";
import { resolveRoomEnergyPolicy } from "@/runtime/roomEnergyPolicy";
import {
  getMarketProtectionEntryKey,
  getMarketProtectionSellableAmount,
  type MarketProtectionEntry,
  type MarketSaleProtectionLedger,
} from "@/runtime/marketSaleProtection";
import { collectLiveMarketSaleProtectionLedger } from "@/runtime/marketSaleProtectionAdapter";
import type { MarketBaseResourceV3RuntimeState } from "@/runtime/marketBaseResourceAutomation";

const CONTINUOUS_ACTOR =
  "marketSaleAutomation:continuous-direct";
const MAX_OUTGOING_TRANSACTIONS = 100;
const MAX_COMPATIBILITY_OUTCOMES = 50;

/**
 * 这是 2026-07-26 shard1 唯一 legacy X canary 的完整冻结 outcome。
 * 任一字段不同都不得自动 bootstrap v2。
 */
export const LEGACY_X_DIRECT_SAFETY_FINGERPRINT = JSON.stringify({
  strategy: "direct",
  engineAssumptionCommit:
    "80977824199a596d174d392fd0cf8c458c21fcbd",
  configRevision: "x-direct-2026-07-26-r1",
  sellResources: ["X"],
  hardFloor: [["X", 600]],
  economicFloor: [["X", 600]],
  forecastBuffer: [["X", 100_000]],
  minDealAmount: 1_000,
  terminalEnergyReserve: 25_000,
  energyShadowHardFloor: 20,
  minHistoryDays: 7,
  minHistoryTransactions: 100,
  minHistoryVolume: 100_000,
  historyFloorRatio: 0.95,
  historyMaxAgeDays: 2,
  maxDirectDealAmount: 1_000,
  maxDirectDealsPerCycle: 1,
  minDirectOrderAmount: 1_000,
  minDirectOrderNotional: 600_000,
  maxDirectRawOrdersScannedPerCycle: 1_000,
  maxDirectEligibleOrdersPricedPerCycle: 200,
  maxDirectTransactionEnergy: 1_000,
  directCanaryMaxConfirmedDeals: 1,
  planningSnapshotMaxAgeTicks: 10,
  canaryEnabled: true,
  canaryAllowExpansion: false,
});

export const LEGACY_X_V1_OUTCOME_GOLDEN: DirectDealOutcome = {
  requestId: "direct:72585530:E6N59:X",
  orderId: "6a65e025656d080013ccad03",
  configRevision: "x-direct-2026-07-26-r1",
  directSafetyFingerprint: LEGACY_X_DIRECT_SAFETY_FINGERPRINT,
  canaryRoomName: AUTHORITY_ROOMS.legacyXSeller,
  resource: "X" as ResourceConstant,
  orderRoomName: AUTHORITY_ROOMS.legacyXBuyer,
  observedOrderPrice: 694.963,
  observedOrderPriceMilli: 694_963,
  observedOrderAmount: 28_920,
  submittedDealAmount: 1_000,
  plannedTransactionEnergy: 394,
  effectiveEnergyShadowPrice: 32.06,
  effectiveEnergyShadowPriceMilli: 32_060,
  energyShadowComponents: {
    hardFloor: 20,
    historyFloor: 31.276,
    ratchetFloor: 32.06,
  },
  energyShadowObservedAt: 72_585_530,
  plannedNetCreditsMilli: 682_331_360,
  worstCaseActualAmount: 1,
  worstCaseNetCreditsMilli: 662_903,
  effectiveNetFloor: 600,
  effectiveNetFloorMilli: 600_000,
  protectionRevision: 72_585_530,
  attemptAt: 72_585_530,
  pendingRecoveryFingerprint: "v1:bbb1de5ce52cb2d0",
  status: "confirmed",
  resolvedAt: 72_585_531,
  transactionId: "6a65f8e1656d080013d32210",
  transactionTime: 72_585_530,
  actualOrderType: "buy",
  actualOrderPrice: 694.963,
  actualResource: "X",
  actualFrom: AUTHORITY_ROOMS.legacyXSeller,
  actualTo: AUTHORITY_ROOMS.legacyXBuyer,
  actualAmount: 1_000,
  actualTransactionEnergy: 394,
  actualNetCreditsMilli: 682_331_360,
  evidenceSource: "automatic",
  evidenceKey: LEGACY_X_PROCESSED_EVIDENCE_KEY,
};

export const LEGACY_X_V1_OUTCOME_DIGEST =
  canonicalStableHashV1(LEGACY_X_V1_OUTCOME_GOLDEN);

export const LEGACY_X_V1_REVIEW_EVIDENCE_DIGEST =
  marketDirectContinuousLegacyXOutcomeFingerprint(
    LEGACY_X_V1_OUTCOME_GOLDEN,
  );

const LEGACY_V1_SAFE_FIXTURE: LegacyV1SafeStateFixture = {
  schema: 1,
  directConfirmedDealCount: 1,
  directPausedForReview: true,
  pendingCount: 0,
  quarantinedCount: 0,
  reconcileGapCount: 0,
};

export const LEGACY_V1_SAFE_FIXTURE_DIGEST =
  canonicalStableHashV1(LEGACY_V1_SAFE_FIXTURE);

const CONTINUOUS_SHARED_POLICY_FINGERPRINT =
  marketDirectContinuousSharedFingerprint({
    directRuntimeFingerprint:
      MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT,
  });

export interface ContinuousPendingProjection {
  requestId: string;
  status: "prepared" | "submitted" | "reconcile_gap";
  roomName: string;
  canaryRoomName: string;
  resource: ResourceConstant;
  resourceType: ResourceConstant;
  amount: number;
  dealAmount: number;
  orderId: string;
  attemptAt: number;
}

export interface MarketDirectContinuousPlanningSnapshot {
  observedAt: number;
  complete: boolean;
  planningFingerprint: string;
  selected?: {
    entryId: string;
    resource: ResourceConstant;
    roomName: string;
    orderId: string;
    grossPrice: number;
    unitNetPrice: number;
    transactionEnergy: number;
  };
  blocker?: string;
  safeResourceTypes: ResourceConstant[];
  admittedResourceTypes: ResourceConstant[];
  rejectedByReason: Record<string, number>;
}

export interface MarketDirectContinuousPermitProposal {
  permit: MarketDirectContinuousPermit;
  lifecycleByEntry: Record<string, MarketDirectEntryLifecycle>;
  proposedAt: number;
}

export interface MarketDirectContinuousAutomationState {
  schemaVersion: typeof MARKET_DIRECT_CONTINUOUS_SCHEMA;
  capability: typeof MARKET_DIRECT_CONTINUOUS_CAPABILITY;
  migrationStatus: "readyForPermit" | "active" | "blocked";
  migrationBlockedReason?: string;
  rollbackEvidenceMarker: string;
  legacyStateDigest: string;
  reviewedLegacyOutcomeDigest: string;
  lifecycleByEntry: Record<string, MarketDirectEntryLifecycle>;
  permitChain: MarketDirectPermitChainState;
  currentPermit?: MarketDirectContinuousPermit;
  proposedPermit?: MarketDirectContinuousPermitProposal;
  ledger: MarketDirectContinuousLedger;
  lastPlanningSnapshot?: MarketDirectContinuousPlanningSnapshot;
  /**
   * V3 基础矿运行时使用独立子状态，不能改变外层 v2 schema 或重写既有
   * permit/WAL。这里保持 unknown，由 versioned v3 reader 独立校验。
   */
  baseResourceV3?: MarketBaseResourceV3RuntimeState;
  lastLifecycleAppliedAttemptSeq: number;
  pendingDirectDeals: Record<string, ContinuousPendingProjection>;
  quarantinedPendingDirectDeals: Record<string, unknown>;
  /** Rollback compatibility evidence retained for the 669bce3 normalizer. */
  directDealOutcomes: DirectDealOutcome[];
  processedDirectTransactionKeys: string[];
  directConfirmedDealCount: number;
  directPausedForReview: boolean;
}

export interface MarketDirectContinuousResult {
  actions: string[];
  rejectedByReason: Record<string, number>;
  writes: number;
  planComplete: boolean;
  state: MarketDirectContinuousAutomationState;
}

export interface MarketDirectContinuousPermitRequest {
  operatorAuthorizationFingerprint: string;
  entryStages?: Partial<
    Record<string, MarketDirectEntryLifecycleStage>
  >;
  newDealGrants?: Partial<
    Record<string, MarketDirectNewDealGrant>
  >;
  reviewedEvidenceDigests?: Partial<Record<string, string>>;
}

function emptyCounters() {
  return {
    global: { count: 0, amount: 0 },
    resources: {},
  };
}

function safeJsonEvidence(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? null
      : JSON.parse(serialized);
  } catch {
    return {
      unserializable: true,
      valueType:
        value === null ? "null" : typeof value,
    };
  }
}

function createBlockedLedger(
  tick: number,
  reason: string,
  evidence: unknown,
): MarketDirectContinuousLedger {
  const safeEvidence = safeJsonEvidence(evidence);
  return {
    schema: MARKET_DIRECT_CONTINUOUS_SCHEMA,
    coverageStartTick: Math.max(0, tick - 29_999),
    receiptHeadHash: CONTINUOUS_RECEIPT_GENESIS,
    finalizedAttemptSeq: 0,
    nextAttemptSeq: 1,
    receipts: [],
    outcomes: [],
    processedEvidenceKeys: [],
    checkpoint: {
      prunedThroughSeq: 0,
      prunedHeadHash: CONTINUOUS_RECEIPT_GENESIS,
      confirmed: emptyCounters(),
      confirmedCanaries: {},
      confirmedCanaryCommitment:
        CONTINUOUS_CONFIRMED_CANARY_CHECKPOINT_GENESIS,
    },
    lifetimeConfirmed: emptyCounters(),
    confirmedCanaries: {},
    retryNotBefore: 0,
    permitEpochHighWater: 0,
    permitChainHeadHighWater: CONTINUOUS_PERMIT_GENESIS,
    blocker: {
      code: reason,
      detectedAt: tick,
      detailHash: canonicalStableHashV1({
        domain: "market-direct-continuous:blocked-state-v1",
        evidence: safeEvidence,
      }),
    },
  };
}

function blockedContinuousState(
  tick: number,
  reason: string,
  evidence: unknown,
): MarketDirectContinuousAutomationState {
  const safeEvidence = safeJsonEvidence(evidence);
  return {
    schemaVersion: MARKET_DIRECT_CONTINUOUS_SCHEMA,
    capability: MARKET_DIRECT_CONTINUOUS_CAPABILITY,
    migrationStatus: "blocked",
    migrationBlockedReason: reason,
    rollbackEvidenceMarker:
      `market-direct-continuous:v2:blocked:${reason}`,
    legacyStateDigest: "",
    reviewedLegacyOutcomeDigest: "",
    lifecycleByEntry: {},
    permitChain: createMarketDirectPermitChainState(),
    ledger: createBlockedLedger(tick, reason, evidence),
    lastLifecycleAppliedAttemptSeq: 0,
    pendingDirectDeals: {},
    quarantinedPendingDirectDeals: {
      [`__continuous_blocked__:${reason}`]: safeEvidence,
    },
    directDealOutcomes: [],
    processedDirectTransactionKeys: [],
    directConfirmedDealCount: 0,
    directPausedForReview: true,
  };
}

function exactLegacyOutcome(
  raw: unknown,
): raw is DirectDealOutcome {
  try {
    return (
      canonicalStableHashV1(raw) ===
        LEGACY_X_V1_OUTCOME_DIGEST &&
      marketDirectContinuousLegacyXOutcomeFingerprint(raw) ===
        LEGACY_X_V1_REVIEW_EVIDENCE_DIGEST
    );
  } catch {
    return false;
  }
}

function legacyFixture(
  state: DirectAutomationState,
): LegacyV1SafeStateFixture | undefined {
  const pendingCount = Object.keys(
    state.pendingDirectDeals || {},
  ).length;
  const quarantinedCount = Object.keys(
    state.quarantinedPendingDirectDeals || {},
  ).length;
  const reconcileGapCount = Object.values(
    state.pendingDirectDeals || {},
  ).filter((pending) => pending.status === "reconcile_gap").length;
  if (
    state.schemaVersion !== 1 ||
    state.directConfirmedDealCount !== 1 ||
    state.directPausedForReview !== true ||
    pendingCount !== 0 ||
    quarantinedCount !== 0 ||
    reconcileGapCount !== 0
  ) {
    return undefined;
  }
  return {
    schema: 1,
    directConfirmedDealCount: 1,
    directPausedForReview: true,
    pendingCount: 0,
    quarantinedCount: 0,
    reconcileGapCount: 0,
  };
}

function toLegacyReviewedFixture(
  outcome: DirectDealOutcome,
): LegacyXReviewedOutcomeFixture {
  return {
    requestId: "direct:72585530:E6N59:X",
    transactionId: "6a65f8e1656d080013d32210",
    orderId: "6a65e025656d080013ccad03",
    evidenceKey: LEGACY_X_PROCESSED_EVIDENCE_KEY,
    status: "confirmed",
    resolvedAt: 72_585_531,
    attemptAt: 72_585_530,
    transactionTime: 72_585_530,
    sellerRoom: AUTHORITY_ROOMS.legacyXSeller,
    orderRoom: AUTHORITY_ROOMS.legacyXBuyer,
    resource: "X",
    observedOrderAmount: 28_920,
    actualAmount: 1_000,
    plannedTransactionEnergy: 394,
    actualTransactionEnergy: 394,
    observedOrderPriceMilli: 694_963,
    plannedNetCreditsMilli: 682_331_360,
    actualNetCreditsMilli: 682_331_360,
    worstCaseNetCreditsMilli: 662_903,
    effectiveEnergyShadowPriceMilli: 32_060,
    energyShadowComponents: {
      hardFloor: 20,
      historyFloor: 31.276,
      ratchetFloor: 32.06,
    },
    protectionRevision: 72_585_530,
    pendingRecoveryFingerprint: "v1:bbb1de5ce52cb2d0",
    directSafetyFingerprint: LEGACY_X_DIRECT_SAFETY_FINGERPRINT,
    canonicalOutcome: outcome,
  };
}

export function migrateLegacyDirectToContinuous(
  raw: DirectAutomationState,
  tick: number,
): MarketDirectContinuousAutomationState {
  if (
    raw.migrationBlockedReason ===
      "unsupported_direct_state_schema" ||
    raw.directConfirmedDealCount > 1
  ) {
    return blockedContinuousState(
      tick,
      "rollback_evidence_lost",
      raw,
    );
  }
  const fixture = legacyFixture(raw);
  const [outcome] = raw.directDealOutcomes || [];
  if (
    !fixture ||
    canonicalStableHashV1(fixture) !==
      LEGACY_V1_SAFE_FIXTURE_DIGEST ||
    raw.directDealOutcomes.length !== 1 ||
    !exactLegacyOutcome(outcome) ||
    raw.processedDirectTransactionKeys.length !== 1 ||
    raw.processedDirectTransactionKeys[0] !==
      LEGACY_X_PROCESSED_EVIDENCE_KEY
  ) {
    return blockedContinuousState(
      tick,
      "direct_migration_evidence_mismatch",
      raw,
    );
  }
  const migrated = migrateLegacyXSeedLedger({
    migrationTick: tick,
    legacyState: fixture!,
    reviewedOutcome: toLegacyReviewedFixture(outcome),
    expectedLegacyStateDigest:
      LEGACY_V1_SAFE_FIXTURE_DIGEST,
    expectedReviewedOutcomeDigest:
      LEGACY_X_V1_OUTCOME_DIGEST,
  });
  if (!migrated.ok) {
    return blockedContinuousState(
      tick,
      migrated.blockerCode ||
        "direct_migration_evidence_mismatch",
      raw,
    );
  }
  const lifecycleByEntry: Record<
    string,
    MarketDirectEntryLifecycle
  > = {};
  for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
    lifecycleByEntry[entry.entryId] =
      entry.resourceType === "X"
        ? createLegacyReviewedXEntryLifecycle(
            CONTINUOUS_SHARED_POLICY_FINGERPRINT,
            outcome,
          )
        : createMarketDirectEntryLifecycle(
            entry.entryId,
            CONTINUOUS_SHARED_POLICY_FINGERPRINT,
          );
  }
  return {
    schemaVersion: MARKET_DIRECT_CONTINUOUS_SCHEMA,
    capability: MARKET_DIRECT_CONTINUOUS_CAPABILITY,
    migrationStatus: "readyForPermit",
    rollbackEvidenceMarker:
      "market-direct-continuous:v2:migrated-from-669bce3",
    legacyStateDigest: LEGACY_V1_SAFE_FIXTURE_DIGEST,
    reviewedLegacyOutcomeDigest:
      LEGACY_X_V1_OUTCOME_DIGEST,
    lifecycleByEntry,
    permitChain: createMarketDirectPermitChainState(),
    ledger: migrated.state,
    lastLifecycleAppliedAttemptSeq: 1,
    pendingDirectDeals: {},
    quarantinedPendingDirectDeals: {},
    directDealOutcomes: [outcome],
    processedDirectTransactionKeys: [
      LEGACY_X_PROCESSED_EVIDENCE_KEY,
    ],
    directConfirmedDealCount: 1,
    directPausedForReview: true,
  };
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
}

export function normalizeContinuousDirectState(
  raw: unknown,
  tick: number,
): MarketDirectContinuousAutomationState {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== MARKET_DIRECT_CONTINUOUS_SCHEMA ||
    raw.capability !== MARKET_DIRECT_CONTINUOUS_CAPABILITY
  ) {
    return blockedContinuousState(
      tick,
      "direct_state_missing",
      raw,
    );
  }
  const state = raw as unknown as MarketDirectContinuousAutomationState;
  if (
    state.migrationStatus === "blocked" &&
    typeof state.migrationBlockedReason === "string" &&
    state.migrationBlockedReason.length > 0 &&
    state.ledger?.blocker?.code ===
      state.migrationBlockedReason &&
    state.rollbackEvidenceMarker ===
      `market-direct-continuous:v2:blocked:${state.migrationBlockedReason}` &&
    isRecord(state.pendingDirectDeals) &&
    Object.keys(state.pendingDirectDeals).length === 0 &&
    isRecord(state.quarantinedPendingDirectDeals) &&
    Object.keys(state.quarantinedPendingDirectDeals).length ===
      1 &&
    Object.prototype.hasOwnProperty.call(
      state.quarantinedPendingDirectDeals,
      `__continuous_blocked__:${state.migrationBlockedReason}`,
    ) &&
    state.ledger.blocker.detailHash ===
      canonicalStableHashV1({
        domain: "market-direct-continuous:blocked-state-v1",
        evidence:
          state.quarantinedPendingDirectDeals[
            `__continuous_blocked__:${state.migrationBlockedReason}`
          ],
      }) &&
    isRecord(state.lifecycleByEntry) &&
    Object.keys(state.lifecycleByEntry).length === 0 &&
    state.currentPermit === undefined &&
    state.proposedPermit === undefined &&
    state.lastPlanningSnapshot === undefined &&
    state.lastLifecycleAppliedAttemptSeq === 0 &&
    Array.isArray(state.directDealOutcomes) &&
    state.directDealOutcomes.length === 0 &&
    Array.isArray(state.processedDirectTransactionKeys) &&
    state.processedDirectTransactionKeys.length === 0 &&
    state.directConfirmedDealCount === 0 &&
    state.directPausedForReview === true &&
    Array.isArray(state.ledger.receipts) &&
    state.ledger.receipts.length === 0 &&
    Array.isArray(state.ledger.outcomes) &&
    state.ledger.outcomes.length === 0 &&
    Array.isArray(state.ledger.processedEvidenceKeys) &&
    state.ledger.processedEvidenceKeys.length === 0 &&
    state.ledger.finalizedAttemptSeq === 0 &&
    state.ledger.nextAttemptSeq === 1 &&
    Array.isArray(state.permitChain?.permits) &&
    state.permitChain.permits.length === 0 &&
    state.permitChain.currentPermitEpoch === 0 &&
    state.permitChain.currentPermitId === "" &&
    state.permitChain.permitChainHead ===
      MARKET_DIRECT_CONTINUOUS_PERMIT_GENESIS &&
    state.permitChain.blocker === undefined
  ) {
    return state;
  }
  if (
    !isRecord(state.ledger) ||
    !isRecord(state.permitChain) ||
    !isRecord(state.lifecycleByEntry)
  ) {
    return blockedContinuousState(
      tick,
      "direct_v2_state_invalid",
      raw,
    );
  }
  const ledgerValidation = validateContinuousLedger(
    state.ledger,
    tick,
  );
  const entryIds =
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => entry.entryId,
    );
  const lifecycleStages = new Set<
    MarketDirectEntryLifecycleStage
  >([
    "shadow",
    "qualified",
    "canary",
    "review_paused",
    "continuous",
  ]);
  const lifecycleValid =
    isRecord(state.lifecycleByEntry) &&
    Object.keys(state.lifecycleByEntry).sort().join("|") ===
      [...entryIds].sort().join("|") &&
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.every(
      (entry) => {
      const lifecycle =
        state.lifecycleByEntry[entry.entryId];
      return (
        lifecycle?.entryId === entry.entryId &&
        lifecycle.resourceFingerprint ===
          entry.resourceFingerprint &&
        lifecycle.sharedFingerprint ===
          CONTINUOUS_SHARED_POLICY_FINGERPRINT &&
        lifecycleStages.has(lifecycle.stage) &&
        Number.isSafeInteger(
          lifecycle.consecutiveCompleteCycles,
        ) &&
        lifecycle.consecutiveCompleteCycles >= 0 &&
        Number.isSafeInteger(
          lifecycle.canaryConfirmedCount,
        ) &&
        lifecycle.canaryConfirmedCount >= 0 &&
        lifecycle.canaryConfirmedCount <= 1 &&
        Array.isArray(lifecycle.evidenceHistory) &&
        lifecycle.evidenceHistory.every(
          (evidence) =>
            typeof evidence?.kind === "string" &&
            typeof evidence.digest === "string" &&
            evidence.digest.length > 0 &&
            Number.isSafeInteger(evidence.recordedAt) &&
            evidence.recordedAt >= 0,
        ) &&
        (lifecycle.stage === "canary"
          ? lifecycle.canaryConfirmedCount === 0
          : lifecycle.stage === "review_paused" ||
              lifecycle.stage === "continuous"
            ? lifecycle.canaryConfirmedCount === 1
            : true)
      );
    });
  const chainValidation =
    validateMarketDirectContinuousPermitChain(
      state.permitChain,
      {
        permitEpochHighWater:
          state.ledger?.permitEpochHighWater,
        permitChainHeadHighWater:
          state.ledger?.permitChainHeadHighWater,
      },
    );
  const permitValid =
    chainValidation.ok &&
    (state.migrationStatus === "readyForPermit"
      ? state.permitChain.currentPermitEpoch === 0 &&
        state.currentPermit === undefined
      : state.migrationStatus === "active"
        ? state.currentPermit !== undefined &&
          state.currentPermit.permitId ===
            state.permitChain.currentPermitId &&
          state.currentPermit.permitHead ===
            state.permitChain.permitChainHead &&
          state.currentPermit.epoch ===
            state.permitChain.currentPermitEpoch &&
          sanitizedHash(
            "market-direct-continuous:current-permit-v1",
            state.currentPermit,
          ) ===
            sanitizedHash(
              "market-direct-continuous:current-permit-v1",
              state.permitChain.permits[
                state.permitChain.permits.length - 1
              ],
            )
        : false);
  const compatibilityValid =
    isRecord(state.pendingDirectDeals) &&
    isRecord(state.quarantinedPendingDirectDeals) &&
    Array.isArray(state.directDealOutcomes) &&
    Array.isArray(state.processedDirectTransactionKeys) &&
    Number.isSafeInteger(state.directConfirmedDealCount) &&
    typeof state.directPausedForReview === "boolean" &&
    Number.isSafeInteger(
      state.lastLifecycleAppliedAttemptSeq,
    ) &&
    state.lastLifecycleAppliedAttemptSeq >= 1 &&
    state.lastLifecycleAppliedAttemptSeq <=
      state.ledger.finalizedAttemptSeq &&
    typeof state.rollbackEvidenceMarker === "string" &&
    state.rollbackEvidenceMarker.startsWith(
      "market-direct-continuous:v2:",
    );
  const lifecycleProjectionValid =
    ledgerValidation.ok &&
    lifecycleValid &&
    compatibilityValid &&
    Object.keys(state.ledger.confirmedCanaries).every(
      (entryId) => entryIds.includes(entryId),
    ) &&
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.every(
      (entry) => {
        const lifecycle =
          state.lifecycleByEntry[entry.entryId];
        const confirmation =
          state.ledger.confirmedCanaries[entry.entryId];
        if (!confirmation) {
          return (
            lifecycle.canaryConfirmedCount === 0 &&
            lifecycle.stage !== "review_paused" &&
            lifecycle.stage !== "continuous" &&
            !lifecycle.evidenceHistory.some(
              (evidence) =>
                evidence.kind ===
                  "legacy_reviewed_canary" ||
                evidence.kind ===
                  "canary_confirmation" ||
                evidence.kind === "continuous_review",
            )
          );
        }
        const confirmationNotYetProjected =
          confirmation.attemptSeq >
          state.lastLifecycleAppliedAttemptSeq;
        if (
          lifecycle.stage === "canary" &&
          lifecycle.canaryConfirmedCount === 0
        ) {
          return confirmationNotYetProjected;
        }
        if (
          lifecycle.canaryConfirmedCount !== 1 ||
          (lifecycle.stage !== "review_paused" &&
            lifecycle.stage !== "continuous")
        ) {
          return false;
        }
        const canaryEvidenceDigest =
          confirmation.executionPolicy ===
          "legacy_canary_seed"
            ? LEGACY_X_V1_REVIEW_EVIDENCE_DIGEST
            : confirmation.reviewedEvidenceDigest;
        const canaryEvidenceKind =
          confirmation.executionPolicy ===
          "legacy_canary_seed"
            ? "legacy_reviewed_canary"
            : "canary_confirmation";
        if (
          !lifecycle.evidenceHistory.some(
            (evidence) =>
              evidence.kind === canaryEvidenceKind &&
              evidence.digest === canaryEvidenceDigest,
          )
        ) {
          return false;
        }
        return (
          lifecycle.stage !== "continuous" ||
          lifecycle.evidenceHistory.some(
            (evidence) =>
              evidence.kind === "continuous_review" &&
              evidence.digest ===
                confirmation.reviewedEvidenceDigest,
          )
        );
      },
    );
  if (
    !ledgerValidation.ok ||
    !lifecycleValid ||
    !chainValidation.ok ||
    !permitValid ||
    !compatibilityValid ||
    !lifecycleProjectionValid
  ) {
    return blockedContinuousState(
      tick,
      ledgerValidation.blockerCode ||
        chainValidation.reason ||
        "direct_v2_state_invalid",
      raw,
    );
  }
  return state;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function qualificationDigest(
  lifecycle: MarketDirectEntryLifecycle,
): string | undefined {
  return [...lifecycle.evidenceHistory]
    .reverse()
    .find((entry) => entry.kind === "shadow_qualification")
    ?.digest;
}

function transitionLifecycleForPermit(
  lifecycle: MarketDirectEntryLifecycle,
  target: MarketDirectEntryLifecycleStage,
  tick: number,
  reviewedEvidenceDigest?: string,
  expectedReviewedEvidenceDigest?: string,
): MarketDirectEntryLifecycle {
  if (target === lifecycle.stage) return lifecycle;
  if (
    lifecycle.stage === "qualified" &&
    target === "canary"
  ) {
    const digest = qualificationDigest(lifecycle);
    if (!digest) {
      throw new Error(
        `qualification evidence missing for ${lifecycle.entryId}`,
      );
    }
    return promoteMarketDirectEntryToCanary(lifecycle, {
      tick,
      qualificationDigest: digest,
    });
  }
  if (
    lifecycle.stage === "review_paused" &&
    target === "continuous"
  ) {
    if (!expectedReviewedEvidenceDigest) {
      throw new Error(
        `confirmed canary binding missing for ${lifecycle.entryId}`,
      );
    }
    const digest =
      reviewedEvidenceDigest ||
      (lifecycle.entryId === "base-x-e6n59-v1"
        ? expectedReviewedEvidenceDigest
        : undefined);
    if (!digest) {
      throw new Error(
        `review evidence missing for ${lifecycle.entryId}`,
      );
    }
    return promoteMarketDirectEntryToContinuous(lifecycle, {
      tick,
      reviewedEvidenceDigest: digest,
      expectedReviewedEvidenceDigest,
    });
  }
  throw new Error(
    `illegal lifecycle transition ${lifecycle.entryId}:${lifecycle.stage}->${target}`,
  );
}

function reviewedEvidenceBindings(
  lifecycleByEntry: Record<string, MarketDirectEntryLifecycle>,
): MarketDirectPermitEvidenceBinding[] {
  const result: MarketDirectPermitEvidenceBinding[] = [];
  for (const lifecycle of Object.values(lifecycleByEntry)) {
    for (const evidence of lifecycle.evidenceHistory) {
      const evidenceKey =
        lifecycle.entryId === "base-x-e6n59-v1" &&
        evidence.kind === "legacy_reviewed_canary"
          ? LEGACY_X_PROCESSED_EVIDENCE_KEY
          : `${lifecycle.entryId}:${evidence.kind}:${evidence.digest}`;
      result.push({
        entryId: lifecycle.entryId,
        evidenceKey,
        kind: evidence.kind,
        digest: evidence.digest,
      });
    }
  }
  return result;
}

export function proposeMarketDirectContinuousPermit(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  accountIdentity: string,
  request: MarketDirectContinuousPermitRequest,
): {
  ok: boolean;
  state: MarketDirectContinuousAutomationState;
  permit?: MarketDirectContinuousPermit;
  error?: string;
} {
  const validation = validateContinuousLedger(state.ledger, tick);
  if (
    state.migrationStatus === "blocked" ||
    state.migrationBlockedReason ||
    state.permitChain.blocker ||
    !validation.ok ||
    !accountIdentity ||
    !request?.operatorAuthorizationFingerprint
  ) {
    return {
      ok: false,
      state,
      error:
        state.migrationBlockedReason ||
        state.permitChain.blockerReason ||
        validation.blockerCode ||
        "continuous_permit_prerequisite_failed",
    };
  }
  if (
    state.ledger.pending ||
    Object.keys(state.quarantinedPendingDirectDeals).length > 0
  ) {
    return {
      ok: false,
      state,
      error: "continuous_permit_wal_not_quiescent",
    };
  }

  try {
    const lifecycleByEntry = clone(state.lifecycleByEntry);
    const firstPermit =
      state.permitChain.currentPermitEpoch === 0;
    for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
      const current = lifecycleByEntry[entry.entryId];
      if (!current) {
        throw new Error(`lifecycle missing: ${entry.entryId}`);
      }
      const defaultTarget =
        firstPermit && entry.resourceType === "X"
          ? "continuous"
          : current.stage;
      lifecycleByEntry[entry.entryId] =
        transitionLifecycleForPermit(
          current,
          request.entryStages?.[entry.entryId] ??
            defaultTarget,
          tick,
          request.reviewedEvidenceDigests?.[entry.entryId],
          state.ledger.confirmedCanaries[entry.entryId]
            ?.reviewedEvidenceDigest,
        );
    }
    const grants: MarketDirectPermitEntryGrant[] =
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => {
        const lifecycle = lifecycleByEntry[entry.entryId];
        const writable =
          lifecycle.stage === "canary" ||
          lifecycle.stage === "continuous";
        const requestedGrant =
          request.newDealGrants?.[entry.entryId];
        const newDealGrant =
          requestedGrant ??
          (writable ? "enabled" : "suspended");
        if (!writable && newDealGrant === "enabled") {
          throw new Error(
            `non-writing lifecycle grant enabled: ${entry.entryId}`,
          );
        }
        return {
          entryId: entry.entryId,
          stage: lifecycle.stage,
          newDealGrant,
          resourceFingerprint: entry.resourceFingerprint,
          lifecycleEvidenceDigest:
            marketDirectLifecycleEvidenceDigest(lifecycle),
        };
      });
    const permit = buildMarketDirectContinuousPermit({
      epoch: state.permitChain.permitEpochHighWater + 1,
      accountIdentity,
      sharedDirectFingerprint:
        MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT,
      entryGrants: grants,
      reviewedEvidence:
        reviewedEvidenceBindings(lifecycleByEntry),
      previousPermitId: state.permitChain.currentPermitId,
      previousPermitHead: state.permitChain.permitChainHead,
      previousLedgerHead: state.ledger.receiptHeadHash,
      createdAt: tick,
      operatorAuthorizationFingerprint:
        request.operatorAuthorizationFingerprint,
    });
    const next = clone(state);
    next.proposedPermit = {
      permit,
      lifecycleByEntry,
      proposedAt: tick,
    };
    return { ok: true, state: next, permit };
  } catch (error) {
    return {
      ok: false,
      state,
      error:
        error instanceof Error
          ? error.message
          : "continuous_permit_proposal_failed",
    };
  }
}

export function acceptMarketDirectContinuousPermit(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  permitId: string,
  currentShard: string,
): {
  ok: boolean;
  idempotent?: boolean;
  state: MarketDirectContinuousAutomationState;
  error?: string;
} {
  const existing = state.permitChain.permits.find(
    (permit) => permit.permitId === permitId,
  );
  const proposal = state.proposedPermit;
  const permit =
    existing ??
    (proposal?.permit.permitId === permitId
      ? proposal.permit
      : undefined);
  if (!permit) {
    return {
      ok: false,
      state,
      error: "continuous_permit_proposal_not_found",
    };
  }
  const appended = appendMarketDirectContinuousPermit(
    state.permitChain,
    permit,
    {
      currentShard,
      currentLedgerHead: state.ledger.receiptHeadHash,
      hasPending: state.ledger.pending !== undefined,
      hasQuarantine:
        Object.keys(state.quarantinedPendingDirectDeals).length > 0,
      hasGap: Boolean(
        state.ledger.blocker || state.migrationBlockedReason,
      ),
      hasUnmatchedReservation:
        state.ledger.pending !== undefined,
      checkpoint: {
        permitEpochHighWater:
          state.ledger.permitEpochHighWater,
        permitChainHeadHighWater:
          state.ledger.permitChainHeadHighWater,
      },
    },
  );
  if (
    appended.status === "rejected" ||
    appended.status === "conflict"
  ) {
    const next = clone(state);
    next.permitChain = appended.state;
    return {
      ok: false,
      state: next,
      error: appended.reason,
    };
  }
  if (appended.status === "idempotent") {
    return {
      ok: true,
      idempotent: true,
      state,
    };
  }
  if (!proposal || proposal.permit.permitId !== permitId) {
    return {
      ok: false,
      state,
      error: "continuous_permit_proposal_not_found",
    };
  }
  const next = clone(state);
  next.permitChain = appended.state;
  next.lifecycleByEntry = proposal.lifecycleByEntry;
  next.currentPermit = proposal.permit;
  next.migrationStatus = "active";
  next.ledger.permitEpochHighWater =
    appended.state.permitEpochHighWater;
  next.ledger.permitChainHeadHighWater =
    appended.state.permitChainHeadHighWater;
  delete next.proposedPermit;
  return {
    ok: true,
    idempotent: false,
    state: next,
  };
}

export interface MarketDirectContinuousRuntimeCandidate {
  roomName: string;
  resourceType: ResourceConstant;
  historyTrusted: boolean;
  historyFloor?: number;
  ratchetFloor?: number;
  effectiveNetFloor: number;
  effectiveEnergyShadowPrice?: number;
  energyShadowObservedAt?: number;
  energyShadowComponents?: {
    hardFloor: number;
    explicit?: number;
    historyFloor?: number;
    ratchetFloor?: number;
  };
  capacityState?: "normal" | "pressure" | "emergency";
  isHubRoom?: boolean;
  rejectionReasons: readonly string[];
}

export interface MarketDirectContinuousTerminalSnapshot {
  roomName: string;
  owned: boolean;
  terminalId?: string;
  resourceAmount: number;
  energy: number;
  cooldown: number;
  nativeMineralType?: ResourceConstant;
  marketEnergyReadiness?:
    MarketDirectContinuousTerminalEnergyReadiness;
}

export interface MarketDirectContinuousTerminalEnergyContribution {
  id: string;
  amount: number;
  kind:
    | "ordinary_terminal_target"
    | "pending_energy_send"
    | "pending_internal_send_fee"
    | "terminal_production_commitment";
}

export interface MarketDirectContinuousTerminalEnergyReadiness {
  schemaVersion: 3;
  revision: string;
  observedAt: number;
  expiresAt: number;
  authorizationRevision?: string;
  roomInstanceId?: string;
  terminalId: string;
  authorized: boolean;
  effectivePostDealEnergyReserve: number;
  marketTerminalEnergyTarget: number;
  ordinaryTerminalEnergyTarget: number;
  unresolvedEnergySendAmount: number;
  unresolvedInternalSendFees: number;
  terminalScopedProductionEnergyCommitments: number;
  maxTransactionEnergy: number;
  contributionCount: number;
  contributions:
    MarketDirectContinuousTerminalEnergyContribution[];
  desiredTerminalEnergy: number;
  plannedFeedAmount: number;
  status: "blocked" | "ready" | "feed_planned";
  blocker?: string;
}

export interface MarketDirectContinuousOutgoingWindow {
  observedAt: number;
  coversAttemptAt: boolean;
  transactions: DirectOutgoingTransaction[];
  oldestTime?: number;
  newestTime?: number;
}

export interface MarketDirectContinuousDependencies {
  readCurrentBuyOrders: (
    resource: ResourceConstant,
  ) => MarketOrderSnapshot[];
  readOwnOrders: () => MarketOrderSnapshot[];
  readTerminal: (
    roomName: string,
    resource: ResourceConstant,
  ) => MarketDirectContinuousTerminalSnapshot | undefined;
  /**
   * 从 ResourceControl 的 canonical 输入源独立重建当前 Energy 承诺。
   * readiness 投影本身不能充当这份证据，否则可同时下调投影明细和总计。
   */
  readCanonicalTerminalEnergyContributions: (
    roomName: string,
  ) =>
    | readonly MarketDirectContinuousTerminalEnergyContribution[]
    | undefined;
  readProtection: (
    config: ResolvedMarketSaleAutomationConfig,
  ) => MarketSaleProtectionLedger;
  readCredits: () => number | undefined;
  readOutgoingWindow: (
    attemptAt: number,
  ) => MarketDirectContinuousOutgoingWindow | undefined;
  calculateTransactionEnergy: (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ) => number;
  readAccountIdentity: () => string | undefined;
  readExecutorShard: () => string | undefined;
  hasProductionMarketIntent: () => boolean;
  readArbiterSnapshot: (
    roomNames: readonly string[],
  ) => {
    blocked: boolean;
    revision: string;
  };
  claimPrepared: typeof claimPreparedDirectMarketClaims;
  executePrepared: typeof executePreparedDirectMarketDeal;
  releasePrepared: (requestId: string) => boolean | void;
}

export interface MarketDirectContinuousAutomationInput {
  tick: number;
  fullPlanningTick: boolean;
  config: ResolvedMarketSaleAutomationConfig;
  candidates: readonly MarketDirectContinuousRuntimeCandidate[];
  makerExposurePresent: boolean;
  emergencyStop: boolean;
}

function convertOrder(order: Order): MarketOrderSnapshot {
  return {
    id: order.id,
    type: order.type === ORDER_BUY ? "buy" : "sell",
    resourceType: order.resourceType,
    roomName: order.roomName,
    price: order.price,
    amount: order.amount,
    remainingAmount: order.remainingAmount,
    totalAmount: order.totalAmount,
    created: order.created,
  };
}

function convertOutgoingTransaction(
  transaction: Transaction,
): DirectOutgoingTransaction {
  return {
    transactionId: transaction.transactionId,
    time: transaction.time,
    amount: transaction.amount,
    resourceType: transaction.resourceType,
    from: transaction.from,
    to: transaction.to,
    order: transaction.order
      ? {
          id: transaction.order.id,
          type: transaction.order.type,
          price: transaction.order.price,
        }
      : undefined,
  };
}

function defaultOutgoingWindow(
  attemptAt: number,
): MarketDirectContinuousOutgoingWindow | undefined {
  const raw = Game.market?.outgoingTransactions;
  if (!Array.isArray(raw)) return undefined;
  const transactions = raw.map(convertOutgoingTransaction);
  const times = transactions.map((entry) => entry.time);
  const oldestTime =
    times.length > 0 ? Math.min(...times) : undefined;
  const newestTime =
    times.length > 0 ? Math.max(...times) : undefined;
  return {
    observedAt: Game.time,
    transactions,
    oldestTime,
    newestTime,
    coversAttemptAt:
      transactions.length < MAX_OUTGOING_TRANSACTIONS ||
      (oldestTime !== undefined && oldestTime < attemptAt),
  };
}

function defaultAccountIdentity(): string | undefined {
  const identities = new Set<string>();
  for (const room of Object.values(Game.rooms || {})) {
    if (!room.controller?.my) continue;
    const username =
      room.controller.owner?.username ||
      room.terminal?.owner?.username ||
      room.storage?.owner?.username;
    if (username) identities.add(username);
  }
  return identities.size === 1
    ? [...identities][0]
    : undefined;
}

function canonicalProtectionOptions(): {
  candidates: Array<{
    roomName: string;
    resource: ResourceConstant;
  }>;
  laneReserveByEntry: Record<string, number>;
} {
  const candidates: Array<{
    roomName: string;
    resource: ResourceConstant;
  }> = [];
  const laneReserveByEntry: Record<string, number> = {};
  for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
    for (const roomName of entry.allowedRoomNames) {
      candidates.push({
        roomName,
        resource: entry.resourceType,
      });
      laneReserveByEntry[
        getMarketProtectionEntryKey(
          roomName,
          entry.resourceType,
        )
      ] = entry.laneReserve;
    }
  }
  return { candidates, laneReserveByEntry };
}

const MARKET_TERMINAL_ENERGY_CONTRIBUTION_KINDS = new Set<
  MarketDirectContinuousTerminalEnergyContribution["kind"]
>([
  "ordinary_terminal_target",
  "pending_energy_send",
  "pending_internal_send_fee",
  "terminal_production_commitment",
]);
const MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS = 64;
const MARKET_TERMINAL_ENERGY_MAX_LEGACY_CONTRIBUTION_ID_LENGTH = 256;

function isValidMarketTerminalEnergyContributionId(
  id: unknown,
  kind: unknown,
): id is string {
  if (typeof id !== "string" || id.length === 0) {
    return false;
  }
  if (
    id.length <=
    MARKET_TERMINAL_ENERGY_MAX_LEGACY_CONTRIBUTION_ID_LENGTH
  ) {
    return true;
  }
  return (
    kind === "terminal_production_commitment" &&
    isCarrierDispatchStepKey(id)
  );
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

function exactRecordKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("|") ===
    [...expected].sort().join("|")
  );
}

function parseMarketTerminalEnergyContribution(
  raw: unknown,
): MarketDirectContinuousTerminalEnergyContribution | undefined {
  if (
    !isPlainRecord(raw) ||
    !exactRecordKeys(raw, ["amount", "id", "kind"]) ||
    typeof raw.kind !== "string" ||
    !MARKET_TERMINAL_ENERGY_CONTRIBUTION_KINDS.has(
      raw.kind as MarketDirectContinuousTerminalEnergyContribution["kind"],
    ) ||
    !isValidMarketTerminalEnergyContributionId(
      raw.id,
      raw.kind,
    ) ||
    !Number.isSafeInteger(raw.amount) ||
    (raw.amount as number) <= 0
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    kind:
      raw.kind as MarketDirectContinuousTerminalEnergyContribution["kind"],
    amount: raw.amount as number,
  };
}

function readCurrentMarketTerminalEnergyReadiness(
  roomName: string,
): MarketDirectContinuousTerminalEnergyReadiness | undefined {
  const raw = (
    Memory.runtime?.resourceControl?.rooms?.[roomName] as
      | { marketEnergyReadiness?: unknown }
      | undefined
  )?.marketEnergyReadiness;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const status = record.status;
  const authorizationRevision =
    record.authorizationRevision;
  const roomInstanceId = record.roomInstanceId;
  const blocker = record.blocker;
  const expectedKeys = [
    "authorized",
    "contributionCount",
    "contributions",
    "desiredTerminalEnergy",
    "effectivePostDealEnergyReserve",
    "expiresAt",
    "marketTerminalEnergyTarget",
    "maxTransactionEnergy",
    "observedAt",
    "ordinaryTerminalEnergyTarget",
    "plannedFeedAmount",
    "revision",
    "schemaVersion",
    "status",
    "terminalId",
    "terminalScopedProductionEnergyCommitments",
    "unresolvedEnergySendAmount",
    "unresolvedInternalSendFees",
    ...(authorizationRevision === undefined
      ? []
      : ["authorizationRevision"]),
    ...(roomInstanceId === undefined
      ? []
      : ["roomInstanceId"]),
    ...(blocker === undefined ? [] : ["blocker"]),
  ];
  const rawContributions = record.contributions;
  if (
    !exactRecordKeys(record, expectedKeys) ||
    !Array.isArray(rawContributions) ||
    rawContributions.length >
      MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS
  ) {
    return undefined;
  }
  const contributions =
    rawContributions.map(
      parseMarketTerminalEnergyContribution,
    );
  if (
    contributions.some(
      (
        contribution,
      ): contribution is undefined =>
        contribution === undefined,
    ) ||
    new Set(
      contributions.map((contribution) => contribution!.id),
    ).size !== contributions.length
  ) {
    return undefined;
  }
  if (
    record.schemaVersion !== 3 ||
    typeof record.revision !== "string" ||
    record.revision.length === 0 ||
    !Number.isSafeInteger(record.observedAt) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (authorizationRevision !== undefined &&
      (typeof authorizationRevision !== "string" ||
        authorizationRevision.length === 0)) ||
    (roomInstanceId !== undefined &&
      (typeof roomInstanceId !== "string" ||
        roomInstanceId.length === 0)) ||
    typeof record.terminalId !== "string" ||
    record.terminalId.length === 0 ||
    typeof record.authorized !== "boolean" ||
    !Number.isSafeInteger(
      record.effectivePostDealEnergyReserve,
    ) ||
    (record.effectivePostDealEnergyReserve as number) < 0 ||
    !Number.isSafeInteger(record.marketTerminalEnergyTarget) ||
    (record.marketTerminalEnergyTarget as number) < 0 ||
    !Number.isSafeInteger(record.ordinaryTerminalEnergyTarget) ||
    (record.ordinaryTerminalEnergyTarget as number) < 0 ||
    !Number.isSafeInteger(record.unresolvedEnergySendAmount) ||
    (record.unresolvedEnergySendAmount as number) < 0 ||
    !Number.isSafeInteger(record.unresolvedInternalSendFees) ||
    (record.unresolvedInternalSendFees as number) < 0 ||
    !Number.isSafeInteger(
      record.terminalScopedProductionEnergyCommitments,
    ) ||
    (record.terminalScopedProductionEnergyCommitments as number) <
      0 ||
    !Number.isSafeInteger(record.maxTransactionEnergy) ||
    (record.maxTransactionEnergy as number) < 0 ||
    !Number.isSafeInteger(record.contributionCount) ||
    (record.contributionCount as number) < 0 ||
    !Number.isSafeInteger(record.desiredTerminalEnergy) ||
    (record.desiredTerminalEnergy as number) < 0 ||
    !Number.isSafeInteger(record.plannedFeedAmount) ||
    (record.plannedFeedAmount as number) < 0 ||
    (status !== "blocked" &&
      status !== "ready" &&
      status !== "feed_planned") ||
    (blocker !== undefined &&
      (typeof blocker !== "string" || blocker.length === 0))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 3,
    revision: record.revision,
    observedAt: record.observedAt as number,
    expiresAt: record.expiresAt as number,
    ...(authorizationRevision === undefined
      ? {}
      : {
          authorizationRevision:
            authorizationRevision as string,
        }),
    ...(roomInstanceId === undefined
      ? {}
      : { roomInstanceId: roomInstanceId as string }),
    terminalId: record.terminalId,
    authorized: record.authorized,
    effectivePostDealEnergyReserve:
      record.effectivePostDealEnergyReserve as number,
    marketTerminalEnergyTarget:
      record.marketTerminalEnergyTarget as number,
    ordinaryTerminalEnergyTarget:
      record.ordinaryTerminalEnergyTarget as number,
    unresolvedEnergySendAmount:
      record.unresolvedEnergySendAmount as number,
    unresolvedInternalSendFees:
      record.unresolvedInternalSendFees as number,
    terminalScopedProductionEnergyCommitments:
      record.terminalScopedProductionEnergyCommitments as number,
    maxTransactionEnergy:
      record.maxTransactionEnergy as number,
    contributionCount: record.contributionCount as number,
    contributions:
      contributions as MarketDirectContinuousTerminalEnergyContribution[],
    desiredTerminalEnergy:
      record.desiredTerminalEnergy as number,
    plannedFeedAmount: record.plannedFeedAmount as number,
    status,
    ...(blocker === undefined
      ? {}
      : { blocker: blocker as string }),
  };
}

function collectCanonicalLegacyV2EnergyContributions(
  roomName: string,
):
  | MarketDirectContinuousTerminalEnergyContribution[]
  | undefined {
  const byId = new Map<
    string,
    MarketDirectContinuousTerminalEnergyContribution
  >();
  const add = (
    contribution: MarketDirectContinuousTerminalEnergyContribution,
  ): boolean => {
    if (
      !isValidMarketTerminalEnergyContributionId(
        contribution.id,
        contribution.kind,
      ) ||
      !MARKET_TERMINAL_ENERGY_CONTRIBUTION_KINDS.has(
        contribution.kind,
      ) ||
      !Number.isSafeInteger(contribution.amount) ||
      contribution.amount <= 0
    ) {
      return false;
    }
    const previous = byId.get(contribution.id);
    if (previous && previous.kind !== contribution.kind) {
      return false;
    }
    byId.set(contribution.id, {
      ...contribution,
      amount: Math.max(
        previous?.amount ?? 0,
        contribution.amount,
      ),
    });
    return true;
  };

  const roomConfig =
    Memory.cfg?.resourceControl?.rooms?.[roomName];
  const ordinaryTerminalEnergyTarget =
    resolveRoomEnergyPolicy(roomConfig)
      .terminalEnergyReserve;
  if (
    ordinaryTerminalEnergyTarget > 0 &&
    !add({
      id: `ordinary-terminal-target:${roomName}`,
      amount: ordinaryTerminalEnergyTarget,
      kind: "ordinary_terminal_target",
    })
  ) {
    return undefined;
  }

  const transferBatchSize = normalizeNumber(
    roomConfig?.transferBatchSize,
    10_000,
    100,
    50_000,
  );
  const taskStore = (
    Memory.data?.resourceControl as
      | { tasks?: unknown }
      | undefined
  )?.tasks;
  if (
    taskStore !== undefined &&
    !isPlainRecord(taskStore)
  ) {
    return undefined;
  }
  const tasks = isPlainRecord(taskStore)
    ? Object.values(taskStore)
    : [];
  if (tasks.length > 1_024) {
    return undefined;
  }
  for (const rawTask of tasks) {
    if (!isPlainRecord(rawTask)) return undefined;
    if (
      rawTask.status !== "pending" ||
      rawTask.fromRoomName !== roomName
    ) {
      continue;
    }
    if (
      typeof rawTask.id !== "string" ||
      rawTask.id.length === 0 ||
      rawTask.id.length > 256 ||
      typeof rawTask.toRoomName !== "string" ||
      rawTask.toRoomName.length === 0 ||
      typeof rawTask.resource !== "string" ||
      !Number.isSafeInteger(rawTask.remainingAmount) ||
      (rawTask.remainingAmount as number) <= 0
    ) {
      return undefined;
    }
    const remainingAmount =
      rawTask.remainingAmount as number;
    if (
      rawTask.resource === RESOURCE_ENERGY &&
      !add({
        id: `resource-transfer:${rawTask.id}:energy`,
        amount: remainingAmount,
        kind: "pending_energy_send",
      })
    ) {
      return undefined;
    }
    let fee: number;
    try {
      fee = Game.market.calcTransactionCost(
        Math.min(transferBatchSize, remainingAmount),
        roomName,
        rawTask.toRoomName,
      );
    } catch {
      return undefined;
    }
    if (
      !Number.isSafeInteger(fee) ||
      fee < 0 ||
      (fee > 0 &&
        !add({
          id: `resource-transfer:${rawTask.id}:fee`,
          amount: fee,
          kind: "pending_internal_send_fee",
        }))
    ) {
      return undefined;
    }
  }

  const reservations = listProductionReservations();
  if (reservations.length > 1_024) {
    return undefined;
  }
  for (const reservation of reservations) {
    if (
      reservation.roomName !== roomName ||
      reservation.resource !== RESOURCE_ENERGY ||
      reservation.expiresAt < Game.time
    ) {
      continue;
    }
    const amount = Math.floor(reservation.amount);
    if (
      typeof reservation.holderId !== "string" ||
      reservation.holderId.length === 0 ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      !add({
        id: `production-reservation:${reservation.holderId}`,
        amount,
        kind: "terminal_production_commitment",
      })
    ) {
      return undefined;
    }
  }

  const carrierEntries = listCarrierDispatchEntriesByRoom(roomName);
  if (carrierEntries.length > 1_024) {
    return undefined;
  }
  for (const { ref: taskRef, task } of carrierEntries) {
    if (
      task.type !== "lab_supply" &&
      task.type !== "factory_supply"
    ) {
      continue;
    }
    if (
      typeof task.id !== "string" ||
      task.id.length === 0 ||
      !Array.isArray(task.steps)
    ) {
      return undefined;
    }
    if (
      taskRef.namespace !== task.producer ||
      taskRef.scope.roomName !== roomName ||
      taskRef.scope.roomName !== task.roomName ||
      taskRef.localId !== task.id
    ) {
      return undefined;
    }
    for (const step of task.steps) {
      if (
        step.resource !== RESOURCE_ENERGY ||
        step.fromKind !== "terminal"
      ) {
        continue;
      }
      const amount = Math.floor(step.amount);
      let contributionId: string;
      try {
        contributionId = encodeCarrierDispatchStepKey(taskRef, step.id);
      } catch {
        return undefined;
      }
      if (
        typeof step.id !== "string" ||
        step.id.length === 0 ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        !add({
          id: contributionId,
          amount,
          kind: "terminal_production_commitment",
        })
      ) {
        return undefined;
      }
    }
  }

  const contributions = [...byId.values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  return contributions.length <=
    MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS
    ? contributions
    : undefined;
}

export const defaultMarketDirectContinuousDependencies:
  MarketDirectContinuousDependencies = {
    readCurrentBuyOrders: (resource) => {
      const orders = Game.market.getAllOrders({
        type: ORDER_BUY,
        resourceType: resource,
      });
      if (!Array.isArray(orders)) {
        throw new TypeError("continuous BUY book unavailable");
      }
      return orders.map(convertOrder);
    },
    readOwnOrders: () => {
      const orders = Game.market?.orders;
      if (!orders || typeof orders !== "object") {
        throw new TypeError("continuous own orders unavailable");
      }
      return Object.values(orders).map(convertOrder);
    },
    readTerminal: (roomName, resource) => {
      const room = Game.rooms?.[roomName];
      const terminal = room?.terminal;
      if (!room || !terminal) return undefined;
      const resourceAmount =
        terminal.store.getUsedCapacity(resource);
      const energy =
        terminal.store.getUsedCapacity(RESOURCE_ENERGY);
      const mineral = room.find(FIND_MINERALS)[0];
      if (
        !Number.isSafeInteger(resourceAmount) ||
        !Number.isSafeInteger(energy) ||
        !Number.isSafeInteger(terminal.cooldown)
      ) {
        return undefined;
      }
      return {
        roomName,
        owned:
          room.controller?.my === true &&
          terminal.my === true,
        terminalId: terminal.id,
        resourceAmount,
        energy,
        cooldown: terminal.cooldown,
        nativeMineralType: mineral?.mineralType,
        marketEnergyReadiness:
          readCurrentMarketTerminalEnergyReadiness(
            roomName,
          ),
      };
    },
    readCanonicalTerminalEnergyContributions:
      collectCanonicalLegacyV2EnergyContributions,
    readProtection: (config) =>
      collectLiveMarketSaleProtectionLedger(
        config,
        undefined,
        canonicalProtectionOptions(),
      ),
    readCredits: () => {
      const credits = Game.market?.credits;
      return typeof credits === "number" &&
        Number.isFinite(credits) &&
        credits >= 0
        ? credits
        : undefined;
    },
    readOutgoingWindow: defaultOutgoingWindow,
    calculateTransactionEnergy: (
      amount,
      fromRoomName,
      toRoomName,
    ) =>
      Game.market.calcTransactionCost(
        amount,
        fromRoomName,
        toRoomName,
      ),
    readAccountIdentity: defaultAccountIdentity,
    readExecutorShard: () => Game.shard?.name,
    hasProductionMarketIntent: hasMarketActionIntentThisTick,
    readArbiterSnapshot: (roomNames) => {
      const accountClaim = getMarketAccountClaim();
      const terminalClaims = [...roomNames]
        .sort()
        .map((roomName) => getTerminalActionClaim(roomName))
        .filter(
          (claim): claim is NonNullable<typeof claim> =>
            claim !== undefined,
        );
      const journal = getMarketActionJournal().filter(
        (entry) => entry.tick === Game.time,
      );
      const productionIntent = hasMarketActionIntentThisTick();
      return {
        blocked:
          productionIntent ||
          accountClaim !== undefined ||
          terminalClaims.length > 0,
        revision: canonicalStableHashV1({
          domain:
            "market-direct-continuous:arbiter-snapshot-v1",
          accountClaim: accountClaim || null,
          terminalClaims,
          journal,
          productionIntent,
          tick: Game.time,
        }),
      };
    },
    claimPrepared: claimPreparedDirectMarketClaims,
    executePrepared: executePreparedDirectMarketDeal,
    releasePrepared: releasePreparedDirectMarketClaims,
  };

interface MarketBaseResourceReadinessAuthorization {
  schemaVersion: 3;
  validated: true;
  status: "authorized";
  revision: string;
  updatedAt: number;
  expiresAt: number;
  maxTransactionEnergy: 1_000;
  sourcePermitVersion: 2 | 3;
  rooms: ReadonlyArray<{
    readonly roomName: string;
    readonly roomInstanceId: string;
    readonly terminalId: string;
    readonly status: "authorized";
  }>;
}

interface MarketBaseResourceV3Container {
  permitChain?: {
    legacyV2GrantSuspended?: unknown;
  };
  readinessAuthorization?: MarketBaseResourceReadinessAuthorization;
  [key: string]: unknown;
}

function marketBaseResourceV3Container(
  state: MarketDirectContinuousAutomationState,
  create: boolean,
): MarketBaseResourceV3Container | undefined {
  const raw = state.baseResourceV3;
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw)
  ) {
    return raw as unknown as MarketBaseResourceV3Container;
  }
  if (!create) return undefined;
  const created: MarketBaseResourceV3Container = {};
  state.baseResourceV3 =
    created as unknown as MarketBaseResourceV3RuntimeState;
  return created;
}

/**
 * 首个 v3 successor 前只给 frozen v2 X/E6N59 提供 Energy readiness。
 * 该 bridge 不参与成交授权；v3 successor 一旦 suspend legacy grant，旧授权
 * 必须在同 tick 消失，不能让 ResourceControl 继续沿用。
 */
function projectLegacyV2ReadinessAuthorization(
  state: MarketDirectContinuousAutomationState,
  input: Pick<
    MarketDirectContinuousAutomationInput,
    "tick" | "config"
  >,
  dependencies: MarketDirectContinuousDependencies,
): void {
  const container = marketBaseResourceV3Container(state, true)!;
  if (
    container.permitChain?.legacyV2GrantSuspended === true
  ) {
    // V3 preflight 已负责在同 tick 原子发布或删除 v3 authorization；
    // legacy bridge 不能覆盖它。
    if (
      container.readinessAuthorization
        ?.sourcePermitVersion === 2
    ) {
      delete container.readinessAuthorization;
    }
    return;
  }
  delete container.readinessAuthorization;
  if (
    input.config.directCapability !== "continuous-v2" ||
    input.config.mode !== "direct" ||
    state.migrationStatus !== "active" ||
    state.migrationBlockedReason ||
    state.ledger.blocker ||
    state.ledger.pending
  ) {
    return;
  }
  const accountIdentity = dependencies.readAccountIdentity();
  const executorShard = dependencies.readExecutorShard();
  if (
    !accountIdentity ||
    !executorShard ||
    !currentPermitMatchesState(
      state,
      accountIdentity,
      executorShard,
    )
  ) {
    return;
  }
  const legacyEntry =
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
      (entry) => entry.entryId === "base-x-e6n59-v1",
    );
  const lifecycle = legacyEntry
    ? state.lifecycleByEntry[legacyEntry.entryId]
    : undefined;
  if (
    !legacyEntry ||
    legacyEntry.resourceType !== RESOURCE_CATALYST ||
    legacyEntry.allowedRoomNames.length !== 1 ||
    legacyEntry.allowedRoomNames[0] !== AUTHORITY_ROOMS.legacyXSeller ||
    !lifecycle ||
    !marketDirectPermitAllowsNewDeal(
      state.permitChain,
      {
        shard: executorShard,
        entryId: legacyEntry.entryId,
        lifecycle,
      },
    )
  ) {
    return;
  }
  let terminal:
    | MarketDirectContinuousTerminalSnapshot
    | undefined;
  try {
    terminal = dependencies.readTerminal(
      AUTHORITY_ROOMS.legacyXSeller,
      RESOURCE_CATALYST,
    );
  } catch {
    terminal = undefined;
  }
  if (
    !terminal ||
    terminal.roomName !== AUTHORITY_ROOMS.legacyXSeller ||
    !terminal.owned ||
    typeof terminal.terminalId !== "string" ||
    terminal.terminalId.length === 0
  ) {
    return;
  }
  const roomInstanceId = sanitizedHash(
    "market-base-resource:legacy-v2-readiness-room-v1",
    {
      accountIdentity,
      roomName: terminal.roomName,
      terminalId: terminal.terminalId,
    },
  );
  const rooms = [
    {
      roomName: terminal.roomName,
      roomInstanceId,
      terminalId: terminal.terminalId,
      status: "authorized" as const,
    },
  ];
  container.readinessAuthorization = {
    schemaVersion: 3,
    validated: true,
    status: "authorized",
    revision: sanitizedHash(
      "market-base-resource:readiness-authorization-v1",
      {
        permitHead: state.currentPermit!.permitHead,
        permitId: state.currentPermit!.permitId,
        rooms,
        sourcePermitVersion: 2,
        tick: input.tick,
      },
    ),
    updatedAt: input.tick,
    expiresAt: input.tick,
    maxTransactionEnergy: 1_000,
    sourcePermitVersion: 2,
    rooms,
  };
}

interface ContinuousReadEntry {
  entryId: string;
  evidence: string;
  runtimeCandidate: MarketDirectContinuousRuntimeCandidate;
  terminal: MarketDirectContinuousTerminalSnapshot;
  protection: MarketProtectionEntry;
  orders: MarketOrderSnapshot[];
  plannerEntry: MarketDirectContinuousEntryInput;
}

interface ContinuousFullRead {
  complete: boolean;
  blocker?: string;
  scopeEvidence: string;
  plannerInput?: PlanMarketDirectContinuousInput;
  entries: Record<string, ContinuousReadEntry>;
  entryBlockers: Record<string, string>;
  ownOrders: MarketOrderSnapshot[];
  outgoingWindow?: MarketDirectContinuousOutgoingWindow;
  accountIdentity?: string;
  executorShard?: string;
  credits?: number;
  arbiterBlocked: boolean;
}

function sanitizedHash(
  domain: string,
  evidence: unknown,
): string {
  return canonicalStableHashV1({
    domain,
    evidence: safeJsonEvidence(evidence),
  });
}

function runtimeCandidateKey(
  roomName: string,
  resource: string,
): string {
  return `${roomName}:${resource}`;
}

function sortedOrderSnapshots(
  orders: readonly MarketOrderSnapshot[],
): MarketOrderSnapshot[] {
  return [...orders]
    .map((order) => ({ ...order }))
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        left.price - right.price ||
        left.amount - right.amount,
    );
}

function currentPermitMatchesState(
  state: MarketDirectContinuousAutomationState,
  accountIdentity: string,
  executorShard: string,
): boolean {
  const permit = state.currentPermit;
  const tip =
    state.permitChain.permits[
      state.permitChain.permits.length - 1
    ];
  const chainValidation =
    validateMarketDirectContinuousPermitChain(
      state.permitChain,
      {
        permitEpochHighWater:
          state.ledger.permitEpochHighWater,
        permitChainHeadHighWater:
          state.ledger.permitChainHeadHighWater,
      },
    );
  return Boolean(
    chainValidation.ok &&
    permit &&
      tip &&
      state.migrationStatus === "active" &&
      !state.migrationBlockedReason &&
      !state.permitChain.blocker &&
      permit.permitId === tip.permitId &&
      permit.permitHead === tip.permitHead &&
      permit.epoch === state.permitChain.currentPermitEpoch &&
      permit.permitId === state.permitChain.currentPermitId &&
      permit.permitHead === state.permitChain.permitChainHead &&
      permit.accountIdentity === accountIdentity &&
      permit.executorShard === executorShard &&
      permit.executorShard ===
        MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD &&
      permit.sharedDirectFingerprint ===
        MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT &&
      state.ledger.permitEpochHighWater ===
        state.permitChain.permitEpochHighWater &&
      state.ledger.permitChainHeadHighWater ===
        state.permitChain.permitChainHeadHighWater &&
      sanitizedHash(
        "market-direct-continuous:permit-table-compare-v1",
        permit.canonicalExecutionTable,
      ) ===
        sanitizedHash(
          "market-direct-continuous:permit-table-compare-v1",
          MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
        ),
  );
}

function completePricingCandidate(
  candidate: MarketDirectContinuousRuntimeCandidate,
  entry: (typeof MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE)[number],
): boolean {
  const expectedFloor = Math.max(
    entry.hardFloor,
    entry.economicFloor,
    candidate.historyFloor ?? 0,
    candidate.ratchetFloor ?? 0,
  );
  const staleInput = candidate.rejectionReasons.some(
    (reason) =>
      reason.includes("resource_control_cycle_stale") ||
      reason.includes("pricing_cache_stale") ||
      reason.includes("pricing_refresh_failed") ||
      reason.includes("cpu_bucket_low") ||
      reason.includes("live_adapter_failed"),
  );
  return (
    candidate.roomName === entry.allowedRoomNames[0] &&
    candidate.resourceType === entry.resourceType &&
    candidate.historyTrusted === true &&
    Number.isFinite(candidate.historyFloor) &&
    Number.isFinite(candidate.ratchetFloor) &&
    Number.isFinite(candidate.effectiveNetFloor) &&
    Math.abs(candidate.effectiveNetFloor - expectedFloor) <
      1e-9 &&
    !staleInput &&
    candidate.capacityState !== undefined &&
    candidate.isHubRoom !== undefined
  );
}

function readLegacyV2DynamicTerminalEnergyReserve(
  state: MarketDirectContinuousAutomationState,
  entry: (typeof MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE)[number],
  terminal: MarketDirectContinuousTerminalSnapshot,
  tick: number,
  accountIdentity: string,
  executorShard: string,
  dependencies: MarketDirectContinuousDependencies,
):
  | { ok: true; effectivePostDealEnergyReserve: number }
  | { ok: false; blocker: string } {
  const readiness = terminal.marketEnergyReadiness;
  if (!readiness) {
    return {
      ok: false,
      blocker:
        `continuous_energy_readiness_missing:${entry.entryId}`,
    };
  }
  if (readiness.status === "feed_planned") {
    return {
      ok: false,
      blocker:
        `continuous_energy_readiness_feed_planned:${entry.entryId}`,
    };
  }
  if (readiness.status === "blocked") {
    return {
      ok: false,
      blocker:
        `continuous_energy_readiness_blocked:${entry.entryId}`,
    };
  }
  const expectedReadinessKeys = [
    "authorizationRevision",
    "authorized",
    "contributionCount",
    "contributions",
    "desiredTerminalEnergy",
    "effectivePostDealEnergyReserve",
    "expiresAt",
    "marketTerminalEnergyTarget",
    "maxTransactionEnergy",
    "observedAt",
    "ordinaryTerminalEnergyTarget",
    "plannedFeedAmount",
    "revision",
    "roomInstanceId",
    "schemaVersion",
    "status",
    "terminalId",
    "terminalScopedProductionEnergyCommitments",
    "unresolvedEnergySendAmount",
    "unresolvedInternalSendFees",
  ];
  const expectedRoomInstanceId = sanitizedHash(
    "market-base-resource:legacy-v2-readiness-room-v1",
    {
      accountIdentity,
      roomName: terminal.roomName,
      terminalId: terminal.terminalId,
    },
  );
  const authorizationRooms = [
    {
      roomName: terminal.roomName,
      roomInstanceId: expectedRoomInstanceId,
      terminalId: terminal.terminalId,
      status: "authorized" as const,
    },
  ];
  const expectedAuthorizationRevision = state.currentPermit
    ? sanitizedHash(
        "market-base-resource:readiness-authorization-v1",
        {
          permitHead: state.currentPermit.permitHead,
          permitId: state.currentPermit.permitId,
          rooms: authorizationRooms,
          sourcePermitVersion: 2,
          tick,
        },
      )
    : undefined;
  let canonicalContributions:
    | readonly MarketDirectContinuousTerminalEnergyContribution[]
    | undefined;
  try {
    canonicalContributions =
      dependencies.readCanonicalTerminalEnergyContributions(
        terminal.roomName,
      );
  } catch {
    canonicalContributions = undefined;
  }
  const contributions = readiness.contributions;
  const contributionIds = new Set<string>();
  const contributionTotals = {
    ordinary_terminal_target: 0,
    pending_energy_send: 0,
    pending_internal_send_fee: 0,
    terminal_production_commitment: 0,
  };
  let contributionsValid =
    Array.isArray(contributions) &&
    contributions.length <=
      MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS &&
    canonicalContributions !== undefined &&
    canonicalContributions.length <=
      MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS;
  if (contributionsValid) {
    for (const contribution of contributions) {
      if (
        !isPlainRecord(contribution) ||
        !exactRecordKeys(contribution, [
          "amount",
          "id",
          "kind",
        ]) ||
        !isValidMarketTerminalEnergyContributionId(
          contribution.id,
          contribution.kind,
        ) ||
        contributionIds.has(contribution.id) ||
        !MARKET_TERMINAL_ENERGY_CONTRIBUTION_KINDS.has(
          contribution.kind,
        ) ||
        !Number.isSafeInteger(contribution.amount) ||
        contribution.amount <= 0
      ) {
        contributionsValid = false;
        break;
      }
      contributionIds.add(contribution.id);
      const nextTotal =
        contributionTotals[contribution.kind] +
        contribution.amount;
      if (!Number.isSafeInteger(nextTotal)) {
        contributionsValid = false;
        break;
      }
      contributionTotals[contribution.kind] = nextTotal;
    }
  }
  if (
    contributionsValid &&
    canonicalStableHashV1(contributions) !==
      canonicalStableHashV1(canonicalContributions)
  ) {
    contributionsValid = false;
  }
  const contributionReserve =
    contributionTotals.ordinary_terminal_target +
    contributionTotals.pending_energy_send +
    contributionTotals.pending_internal_send_fee +
    contributionTotals.terminal_production_commitment;
  const expectedReserve = Math.max(
    entry.terminalEnergyReserve,
    contributionReserve,
  );
  const expectedTarget =
    expectedReserve + entry.maxTransactionEnergy;
  const expectedDesired = Math.max(
    terminal.energy,
    expectedTarget,
  );
  if (
    !exactRecordKeys(
      readiness as unknown as Record<string, unknown>,
      expectedReadinessKeys,
    ) ||
    readiness.schemaVersion !== 3 ||
    readiness.status !== "ready" ||
    readiness.authorized !== true ||
    readiness.revision !==
      `market-terminal-energy-v3:${tick}` ||
    !expectedAuthorizationRevision ||
    readiness.authorizationRevision !==
      expectedAuthorizationRevision ||
    readiness.roomInstanceId !==
      expectedRoomInstanceId ||
    state.currentPermit?.accountIdentity !== accountIdentity ||
    state.currentPermit?.executorShard !== executorShard ||
    typeof terminal.terminalId !== "string" ||
    terminal.terminalId.length === 0 ||
    readiness.terminalId !== terminal.terminalId ||
    readiness.observedAt !== tick ||
    readiness.expiresAt !== tick + 1 ||
    terminal.owned !== true ||
    !Number.isSafeInteger(terminal.energy) ||
    terminal.energy < expectedTarget ||
    !Number.isSafeInteger(terminal.cooldown) ||
    terminal.cooldown !== 0 ||
    !contributionsValid ||
    readiness.contributionCount !==
      contributions.length ||
    readiness.ordinaryTerminalEnergyTarget !==
      contributionTotals.ordinary_terminal_target ||
    readiness.unresolvedEnergySendAmount !==
      contributionTotals.pending_energy_send ||
    readiness.unresolvedInternalSendFees !==
      contributionTotals.pending_internal_send_fee ||
    readiness.terminalScopedProductionEnergyCommitments !==
      contributionTotals.terminal_production_commitment ||
    !Number.isSafeInteger(
      readiness.effectivePostDealEnergyReserve,
    ) ||
    readiness.effectivePostDealEnergyReserve !==
      expectedReserve ||
    !Number.isSafeInteger(expectedTarget) ||
    readiness.marketTerminalEnergyTarget !== expectedTarget ||
    readiness.maxTransactionEnergy !==
      entry.maxTransactionEnergy ||
    readiness.desiredTerminalEnergy !== expectedDesired ||
    readiness.plannedFeedAmount !== 0 ||
    readiness.blocker !== undefined
  ) {
    return {
      ok: false,
      blocker:
        `continuous_energy_readiness_invalid:${entry.entryId}`,
    };
  }
  return {
    ok: true,
    effectivePostDealEnergyReserve: expectedReserve,
  };
}

function completeEnergyShadowEvidence(
  candidate: MarketDirectContinuousRuntimeCandidate,
  tick: number,
  maxAgeTicks: number,
): boolean {
  const components = candidate.energyShadowComponents;
  return (
    Number.isFinite(candidate.effectiveEnergyShadowPrice) &&
    candidate.effectiveEnergyShadowPrice! >= 0 &&
    Number.isSafeInteger(candidate.energyShadowObservedAt) &&
    candidate.energyShadowObservedAt! <= tick &&
    tick - candidate.energyShadowObservedAt! <= maxAgeTicks &&
    components !== undefined &&
    Number.isFinite(components.hardFloor) &&
    (components.explicit === undefined ||
      Number.isFinite(components.explicit)) &&
    (components.historyFloor === undefined ||
      Number.isFinite(components.historyFloor)) &&
    (components.ratchetFloor === undefined ||
      Number.isFinite(components.ratchetFloor))
  );
}

function plannerPolicyFor(
  entry: (typeof MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE)[number],
  lifecycle: MarketDirectEntryLifecycle,
  candidate: MarketDirectContinuousRuntimeCandidate,
): MarketDirectContinuousEntryInput["policy"] {
  return {
    entryId: entry.entryId,
    revision: entry.resourcePolicyRevision,
    resourceType: entry.resourceType,
    allowedRooms: entry.allowedRoomNames,
    requireNativeMineral: entry.requireNativeMineral,
    grant:
      lifecycle.stage === "canary"
        ? "canary"
        : "continuous",
    hardNetFloor: entry.hardFloor,
    economicNetFloor: entry.economicFloor,
    historyNetFloor: candidate.historyFloor,
    ratchetNetFloor: candidate.ratchetFloor,
    minExecutableNotional: entry.minOrderNotional,
    maxRawOrders: entry.maxRawOrdersScanned,
    maxEligibleOrders: entry.maxEligibleOrdersPriced,
    maxTransactionEnergy: entry.maxTransactionEnergy,
    terminalEnergyReserve: entry.terminalEnergyReserve,
    resourceRollingCap: entry.rollingMaxAmount,
    opportunityReserve:
      entry.rollingOpportunityReserveAmount,
  };
}

function continuousPendingState(
  state: MarketDirectContinuousAutomationState,
): PlanMarketDirectContinuousInput["writeContext"]["pendingState"] {
  if (
    state.ledger.blocker ||
    state.migrationBlockedReason
  ) {
    return "gap";
  }
  if (
    Object.keys(state.quarantinedPendingDirectDeals).length > 0
  ) {
    return "quarantine";
  }
  return state.ledger.pending ? "active" : "none";
}

function buildContinuousFullRead(
  state: MarketDirectContinuousAutomationState,
  input: MarketDirectContinuousAutomationInput,
  dependencies: MarketDirectContinuousDependencies,
  plannerEntryIds: readonly string[],
): ContinuousFullRead {
  const empty: ContinuousFullRead = {
    complete: false,
    scopeEvidence: "",
    entries: {},
    entryBlockers: {},
    ownOrders: [],
    arbiterBlocked: true,
  };
  try {
    const mismatchReasons =
      marketDirectContinuousConfigMismatchReasons(input.config);
    if (
      input.config.directCapability !== "continuous-v2" ||
      input.config.configRevision !==
        MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION ||
      !input.config.validForPlanning ||
      mismatchReasons.length > 0
    ) {
      return {
        ...empty,
        blocker:
          mismatchReasons[0] ||
          "continuous_config_not_authorized",
      };
    }
    const ledgerValidation = validateContinuousLedger(
      state.ledger,
      input.tick,
    );
    if (!ledgerValidation.ok || state.ledger.blocker) {
      return {
        ...empty,
        blocker:
          state.ledger.blocker?.code ||
          ledgerValidation.blockerCode ||
          "continuous_ledger_invalid",
      };
    }
    const accountIdentity =
      dependencies.readAccountIdentity();
    const executorShard = dependencies.readExecutorShard();
    if (
      !accountIdentity ||
      !executorShard ||
      !currentPermitMatchesState(
        state,
        accountIdentity,
        executorShard,
      )
    ) {
      return {
        ...empty,
        accountIdentity,
        executorShard,
        blocker: "continuous_permit_mismatch",
      };
    }

    const expectedKeys =
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) =>
        runtimeCandidateKey(
          entry.allowedRoomNames[0],
          entry.resourceType,
        ),
      );
    const expectedKeySet = new Set(expectedKeys);
    const candidateByKey = new Map<
      string,
      MarketDirectContinuousRuntimeCandidate
    >();
    for (const candidate of input.candidates) {
      const key = runtimeCandidateKey(
        candidate.roomName,
        candidate.resourceType,
      );
      if (candidateByKey.has(key)) {
        return {
          ...empty,
          blocker: "continuous_candidate_duplicate",
        };
      }
      if (!expectedKeySet.has(key)) {
        return {
          ...empty,
          blocker: "continuous_candidate_scope_unknown",
        };
      }
      candidateByKey.set(key, candidate);
    }
    const energyCandidates = [...candidateByKey.values()];
    if (
      energyCandidates.length === 0 ||
      energyCandidates.some(
        (candidate) =>
          !completeEnergyShadowEvidence(
            candidate,
            input.tick,
            input.config.planningSnapshotMaxAgeTicks,
          ),
      )
    ) {
      return {
        ...empty,
        blocker: "continuous_energy_shadow_incomplete",
      };
    }
    const energyEvidence = energyCandidates
      .map((candidate) => ({
        price: candidate.effectiveEnergyShadowPrice,
        observedAt: candidate.energyShadowObservedAt,
        components: candidate.energyShadowComponents,
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
    const energyHashes = energyEvidence.map((entry) =>
      sanitizedHash(
        "market-direct-continuous:energy-shadow-one-v1",
        entry,
      ),
    );
    if (new Set(energyHashes).size !== 1) {
      return {
        ...empty,
        blocker: "continuous_energy_shadow_inconsistent",
      };
    }
    const energySignature = sanitizedHash(
      "market-direct-continuous:energy-shadow-set-v1",
      energyEvidence,
    );
    const energyPrice =
      energyCandidates[0].effectiveEnergyShadowPrice!;

    const protection = dependencies.readProtection(
      input.config,
    );
    if (
      !protection ||
      protection.globalBlocked === true ||
      (protection.globalIssues?.length ?? 0) > 0 ||
      !protection.fresh ||
      protection.currentTick !== input.tick ||
      protection.observedAt !== input.tick ||
      protection.expiresAt !== input.tick
    ) {
      return {
        ...empty,
        blocker:
          protection?.globalIssues?.[0]?.code ||
          "continuous_protection_global_incomplete",
      };
    }
    const ownOrders = sortedOrderSnapshots(
      dependencies.readOwnOrders(),
    );
    const outgoingWindow =
      dependencies.readOutgoingWindow(input.tick);
    const credits = dependencies.readCredits();
    if (
      !outgoingWindow ||
      outgoingWindow.observedAt !== input.tick ||
      !outgoingWindow.coversAttemptAt ||
      typeof credits !== "number" ||
      !Number.isFinite(credits) ||
      credits < 0
    ) {
      return {
        ...empty,
        ownOrders,
        outgoingWindow,
        credits,
        blocker: "continuous_account_snapshot_incomplete",
      };
    }

    const roomNames =
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.flatMap(
        (entry) => [...entry.allowedRoomNames],
      );
    const arbiter =
      dependencies.readArbiterSnapshot(roomNames);
    const productionIntent =
      dependencies.hasProductionMarketIntent();
    const canonicalEntryIds = new Set(
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
        (entry) => entry.entryId,
      ),
    );
    const entryIds = new Set(plannerEntryIds);
    if (
      entryIds.size !== plannerEntryIds.length ||
      [...entryIds].some(
        (entryId) => !canonicalEntryIds.has(entryId),
      )
    ) {
      return {
        ...empty,
        blocker: "continuous_planner_scope_unknown",
      };
    }
    const entries: Record<string, ContinuousReadEntry> = {};
    const entryBlockers: Record<string, string> = {};
    const quotasByEntry: Record<
      string,
      NonNullable<ReturnType<typeof computeContinuousQuota>>
    > = {};
    const quotaRevisionParts: Array<{
      entryId: string;
      quota: NonNullable<
        ReturnType<typeof computeContinuousQuota>
      >;
    }> = [];
    let globalConfirmedAmount: number | undefined;
    let globalUnmatchedPlannedAmount: number | undefined;

    for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
      const quota = computeContinuousQuota(
        state.ledger,
        input.tick,
        entry.resourceType,
        entry.rollingMaxAmount,
        MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.rollingMaxAmount,
      );
      if (!quota) {
        return {
          ...empty,
          ownOrders,
          outgoingWindow,
          credits,
          blocker: `continuous_quota_incomplete:${entry.entryId}`,
        };
      }
      globalConfirmedAmount ??= quota.globalConfirmedActual;
      globalUnmatchedPlannedAmount ??=
        quota.globalUnmatchedPlanned;
      if (
        globalConfirmedAmount !==
          quota.globalConfirmedActual ||
        globalUnmatchedPlannedAmount !==
          quota.globalUnmatchedPlanned
      ) {
        return {
          ...empty,
          blocker: "continuous_global_quota_inconsistent",
        };
      }
      quotasByEntry[entry.entryId] = quota;
      quotaRevisionParts.push({
        entryId: entry.entryId,
        quota,
      });
    }

    const quotaRevision = sanitizedHash(
      "market-direct-continuous:quota-set-v1",
      quotaRevisionParts,
    );
    const pendingState = continuousPendingState(state);
    const cooldownBlocked = quotaRevisionParts.some(
      ({ quota }) =>
        input.tick < quota.confirmedCooldownNotBefore ||
        input.tick < quota.retryNotBefore,
    );
    const arbiterBlocked =
      arbiter.blocked ||
      productionIntent ||
      input.makerExposurePresent ||
      input.emergencyStop ||
      ownOrders.length > 0 ||
      cooldownBlocked;

    for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
      const roomName = entry.allowedRoomNames[0];
      const candidate = candidateByKey.get(
        runtimeCandidateKey(roomName, entry.resourceType),
      );
      if (!candidate || !completePricingCandidate(candidate, entry)) {
        entryBlockers[
          entry.entryId
        ] = `continuous_pricing_incomplete:${entry.entryId}`;
        continue;
      }
      let terminal:
        | MarketDirectContinuousTerminalSnapshot
        | undefined;
      try {
        terminal = dependencies.readTerminal(
          roomName,
          entry.resourceType,
        );
      } catch {
        terminal = undefined;
      }
      if (
        !terminal ||
        terminal.roomName !== roomName ||
        !terminal.owned
      ) {
        entryBlockers[
          entry.entryId
        ] = `continuous_lane_incomplete:${entry.entryId}`;
        continue;
      }
      let effectivePostDealEnergyReserve: number | undefined;
      if (
        entry.entryId === "base-x-e6n59-v1" &&
        entry.resourceType === RESOURCE_CATALYST &&
        roomName === AUTHORITY_ROOMS.legacyXSeller
      ) {
        const readiness =
          readLegacyV2DynamicTerminalEnergyReserve(
            state,
            entry,
            terminal,
            input.tick,
            accountIdentity,
            executorShard,
            dependencies,
          );
        if ("blocker" in readiness) {
          entryBlockers[entry.entryId] =
            readiness.blocker;
          continue;
        }
        effectivePostDealEnergyReserve =
          readiness.effectivePostDealEnergyReserve;
      }
      const protectionEntry =
        protection.entries[
          getMarketProtectionEntryKey(
            roomName,
            entry.resourceType,
          )
        ];
      if (
        !protectionEntry ||
        protectionEntry.roomName !== roomName ||
        protectionEntry.resource !== entry.resourceType ||
        protectionEntry.revision !== input.tick ||
        protectionEntry.observedAt !== input.tick ||
        protectionEntry.expiresAt !== input.tick
      ) {
        entryBlockers[
          entry.entryId
        ] = `continuous_lane_incomplete:${entry.entryId}`;
        continue;
      }
      if (protectionEntry.blocked || !protectionEntry.fresh) {
        entryBlockers[
          entry.entryId
        ] = `continuous_protection_incomplete:${entry.entryId}`;
        continue;
      }
      let orders: MarketOrderSnapshot[];
      try {
        orders = sortedOrderSnapshots(
          dependencies.readCurrentBuyOrders(
            entry.resourceType,
          ),
        );
      } catch {
        entryBlockers[
          entry.entryId
        ] = `continuous_book_incomplete:${entry.entryId}`;
        continue;
      }
      if (
        orders.length > entry.maxRawOrdersScanned ||
        new Set(orders.map((order) => order.id)).size !==
          orders.length
      ) {
        entryBlockers[
          entry.entryId
        ] = `continuous_book_invalid:${entry.entryId}`;
        continue;
      }
      const quota = quotasByEntry[entry.entryId];
      const lifecycle = state.lifecycleByEntry[entry.entryId];
      if (!lifecycle) {
        entryBlockers[
          entry.entryId
        ] = `continuous_lifecycle_incomplete:${entry.entryId}`;
        continue;
      }
      const terminalRevision = sanitizedHash(
        "market-direct-continuous:terminal-read-v1",
        terminal,
      );
      const bookRevision = sanitizedHash(
        "market-direct-continuous:book-read-v1",
        {
          orders,
          ownOrderIds: ownOrders.map((order) => order.id),
        },
      );
      const protectionRevision = sanitizedHash(
        "market-direct-continuous:protection-read-v1",
        protectionEntry,
      );
      const plannerEntry: MarketDirectContinuousEntryInput = {
        policy: plannerPolicyFor(
          entry,
          lifecycle,
          candidate,
        ),
        quota: {
          complete: true,
          revision: sanitizedHash(
            "market-direct-continuous:resource-quota-v1",
            quota,
          ),
          resourceType: entry.resourceType,
          rollingCap: entry.rollingMaxAmount,
          confirmedAmount: quota.resourceConfirmedActual,
          unmatchedPlannedAmount:
            quota.resourceUnmatchedPlanned,
          opportunityReserveSatisfied:
            quota.resourceConfirmedActual +
              quota.resourceUnmatchedPlanned >=
            entry.rollingOpportunityReserveAmount,
        },
        lanes: [
          {
            lane: {
              roomName,
              resourceType: entry.resourceType,
              owned: terminal.owned,
              hub: candidate.isHubRoom === true,
              capacityEmergency:
                candidate.capacityState === "emergency",
              nativeMineralType:
                terminal.nativeMineralType,
            },
            protection: {
              complete:
                !protectionEntry.blocked &&
                protectionEntry.fresh,
              revision: protectionRevision,
              sellableAmount:
                getMarketProtectionSellableAmount(
                  protectionEntry,
                  input.tick,
                ),
            },
            terminal: {
              revision: terminalRevision,
              normal:
                terminal.cooldown === 0 &&
                candidate.capacityState !== undefined &&
                candidate.isHubRoom !== undefined,
              claimed: arbiter.blocked,
              cooldown: terminal.cooldown,
              resourceAmount: terminal.resourceAmount,
              energy: terminal.energy,
              ...(effectivePostDealEnergyReserve === undefined
                ? {}
                : { effectivePostDealEnergyReserve }),
            },
            book: {
              complete: true,
              revision: bookRevision,
              orders,
              ownOrderIds: ownOrders.map((order) => order.id),
            },
            calculateTransactionEnergy: (
              amount,
              order,
              sellerRoomName,
            ) => {
              if (!order.roomName) {
                throw new Error(
                  "continuous order room missing",
                );
              }
              return dependencies.calculateTransactionEnergy(
                amount,
                sellerRoomName,
                order.roomName,
              );
            },
          },
        ],
      };
      const evidence = sanitizedHash(
        "market-direct-continuous:entry-read-v1",
        {
          candidate,
          entryId: entry.entryId,
          orders,
          plannerEntry,
          protection: protectionEntry,
          terminal,
        },
      );
      entries[entry.entryId] = {
        entryId: entry.entryId,
        evidence,
        runtimeCandidate: candidate,
        terminal,
        protection: protectionEntry,
        orders,
        plannerEntry,
      };
    }

    const writableBlocker =
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
        (entry) => entry.entryId,
      )
        .filter((entryId) => entryIds.has(entryId))
        .map((entryId) => entryBlockers[entryId])
        .find((blocker) => blocker !== undefined);
    if (writableBlocker) {
      return {
        ...empty,
        blocker: writableBlocker,
        entries,
        entryBlockers,
        ownOrders,
        outgoingWindow,
        accountIdentity,
        executorShard,
        credits,
        arbiterBlocked,
      };
    }
    const selectedEntries =
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.filter(
        (entry) => entryIds.has(entry.entryId),
      ).map((entry) => entries[entry.entryId].plannerEntry);
    if (selectedEntries.length !== entryIds.size) {
      return {
        ...empty,
        entries,
        entryBlockers,
        blocker: "continuous_planner_scope_unknown",
      };
    }
    const selectedReadEntries =
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.filter(
        (entry) => entryIds.has(entry.entryId),
      ).map((entry) => entries[entry.entryId]);
    const scopeEvidence = sanitizedHash(
      "market-direct-continuous:full-read-v1",
      {
        accountIdentity,
        arbiter,
        configFingerprint:
          MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT,
        credits,
        emergencyStop: input.emergencyStop,
        energySignature,
        entries: selectedReadEntries
          .map((entry) => ({
            candidate: entry.runtimeCandidate,
            evidence: entry.evidence,
            entryId: entry.entryId,
            orders: entry.orders,
            plannerEntry: entry.plannerEntry,
            protection: entry.protection,
            terminal: entry.terminal,
          })),
        executorShard,
        ledgerHead: state.ledger.receiptHeadHash,
        makerExposurePresent: input.makerExposurePresent,
        outgoingWindow,
        ownOrders,
        pendingState,
        permit: state.currentPermit,
        permitChainHead: state.permitChain.permitChainHead,
        protectionGlobal: {
          currentTick: protection.currentTick,
          expiresAt: protection.expiresAt,
          fresh: protection.fresh,
          globalBlocked: protection.globalBlocked,
          globalIssues: protection.globalIssues,
          observedAt: protection.observedAt,
          revision: protection.revision,
        },
        productionIntent,
        quotaRevision,
        tick: input.tick,
      },
    );
    const plannerInput: PlanMarketDirectContinuousInput = {
      entries: selectedEntries,
      energyShadow: {
        complete: true,
        revision: energySignature,
        price: energyPrice,
      },
      globalQuota: {
        complete: true,
        revision: quotaRevision,
        rollingCap:
          MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.rollingMaxAmount,
        confirmedAmount: globalConfirmedAmount!,
        unmatchedPlannedAmount:
          globalUnmatchedPlannedAmount!,
      },
      writeContext: {
        complete: true,
        revision: scopeEvidence,
        credits,
        executorShard,
        permitEpoch: state.currentPermit!.epoch,
        permitId: state.currentPermit!.permitId,
        permitHead: state.currentPermit!.permitHead,
        pendingState,
        arbiterState: arbiterBlocked
          ? "blocked"
          : "available",
      },
    };
    return {
      complete: true,
      scopeEvidence,
      plannerInput,
      entries,
      entryBlockers,
      ownOrders,
      outgoingWindow,
      accountIdentity,
      executorShard,
      credits,
      arbiterBlocked,
    };
  } catch (error) {
    return {
      ...empty,
      blocker:
        error instanceof Error
          ? `continuous_read_failed:${error.message}`
          : "continuous_read_failed",
    };
  }
}

function overwriteContinuousState(
  target: MarketDirectContinuousAutomationState,
  source: MarketDirectContinuousAutomationState,
): MarketDirectContinuousAutomationState {
  if (target === source) return target;
  for (const key of Object.keys(target) as Array<
    keyof MarketDirectContinuousAutomationState
  >) {
    delete (target as unknown as Record<string, unknown>)[key];
  }
  Object.assign(target, clone(source));
  return target;
}

function requestIdForPending(
  pending: ContinuousPendingAttempt,
): string {
  return pending.evidenceKeyHint;
}

function projectContinuousCompatibility(
  state: MarketDirectContinuousAutomationState,
): void {
  const pending = state.ledger.pending;
  state.pendingDirectDeals = pending
    ? {
        [requestIdForPending(pending)]: {
          requestId: requestIdForPending(pending),
          status: state.ledger.blocker
            ? "reconcile_gap"
            : getMarketActionJournal().some(
                  (entry) =>
                    entry.requestId ===
                      requestIdForPending(pending) &&
                    entry.kind === "direct_market_deal",
                )
              ? "submitted"
              : "prepared",
          roomName: pending.sellerRoom,
          canaryRoomName: pending.sellerRoom,
          resource: pending.resource as ResourceConstant,
          resourceType:
            pending.resource as ResourceConstant,
          amount: pending.plannedAmount,
          dealAmount: pending.plannedAmount,
          orderId: pending.orderId,
          attemptAt: pending.attemptAt,
        },
      }
    : {};
  state.processedDirectTransactionKeys =
    state.ledger.processedEvidenceKeys.map((entry) => entry.key);
  state.directConfirmedDealCount =
    state.ledger.lifetimeConfirmed.global.count;
  state.directPausedForReview = Object.values(
    state.lifecycleByEntry,
  ).some((entry) => entry.stage === "review_paused");
}

function applyFinalizedLifecycleReceipts(
  state: MarketDirectContinuousAutomationState,
  tick: number,
): string | undefined {
  const pendingReceipts = state.ledger.receipts
    .filter(
      (receipt) =>
        receipt.attemptSeq >
        state.lastLifecycleAppliedAttemptSeq,
    )
    .sort(
      (left, right) =>
        left.attemptSeq - right.attemptSeq,
    );
  for (const receipt of pendingReceipts) {
    const lifecycle =
      state.lifecycleByEntry[receipt.entryId];
    if (!lifecycle) {
      state.ledger = failClosedContinuousLedger(
        state.ledger,
        tick,
        "direct_lifecycle_receipt_entry_missing",
        receipt,
      );
      return "direct_lifecycle_receipt_entry_missing";
    }
    if (
      receipt.status === "confirmed" &&
      lifecycle.stage === "canary"
    ) {
      try {
        const confirmation =
          state.ledger.confirmedCanaries[receipt.entryId];
        if (
          !confirmation ||
          confirmation.attemptSeq !== receipt.attemptSeq ||
          confirmation.receiptEventHash !==
            receipt.eventHash
        ) {
          throw new Error(
            "confirmed canary ledger binding missing",
          );
        }
        state.lifecycleByEntry[receipt.entryId] =
          recordMarketDirectCanaryConfirmation(lifecycle, {
            tick: receipt.transactionTime ?? tick,
            actualAmount: receipt.actualAmount,
            evidenceDigest:
              confirmation.reviewedEvidenceDigest,
          });
      } catch (error) {
        state.ledger = failClosedContinuousLedger(
          state.ledger,
          tick,
          "direct_canary_lifecycle_conflict",
          {
            receipt,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
        );
        return "direct_canary_lifecycle_conflict";
      }
    }
    state.lastLifecycleAppliedAttemptSeq =
      receipt.attemptSeq;
  }
  projectContinuousCompatibility(state);
  return undefined;
}

function advanceWalUntilWaiting(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  actions: string[],
  dependencies: MarketDirectContinuousDependencies,
): void {
  const requestId = state.ledger.pending
    ? requestIdForPending(state.ledger.pending)
    : undefined;
  for (let index = 0; index < 4; index += 1) {
    const advanced = advanceContinuousWal(
      state.ledger,
      tick,
    );
    if (!advanced.ok || advanced.action === "blocked") {
      state.ledger = advanced.state;
      actions.push(
        `continuous-wal-blocked:${
          advanced.blockerCode || "unknown"
        }`,
      );
      break;
    }
    if (
      advanced.action === "idle" ||
      advanced.action === "waiting_for_outcome"
    ) {
      break;
    }
    // 每个 assignment 都是独立合法 WAL 前缀，不能折叠。
    state.ledger = advanced.state;
    actions.push(`continuous-wal:${advanced.action}`);
    const lifecycleError =
      applyFinalizedLifecycleReceipts(state, tick);
    projectContinuousCompatibility(state);
    if (lifecycleError) break;
    if (
      advanced.action === "pending_deleted" &&
      requestId
    ) {
      try {
        dependencies.releasePrepared(requestId);
      } catch {
        // claim 最晚会按 arbiter TTL 自然失效；账本终态不得回滚。
      }
      break;
    }
  }
}

function continuousOutcomeFromPending(
  pending: ContinuousPendingAttempt,
  input: {
    status: ContinuousOutcome["status"];
    resolvedAt: number;
    evidenceKey: string;
    reason?: string;
    transactionId?: string;
    transactionTime?: number;
    actualAmount: number;
    actualTransactionEnergy?: number;
    actualNetCreditsMilli?: number;
  },
): ContinuousOutcome {
  return {
    attemptSeq: pending.attemptSeq,
    status: input.status,
    permitId: pending.permitId,
    permitEpoch: pending.permitEpoch,
    entryId: pending.entryId,
    resourcePolicyFingerprint:
      pending.resourcePolicyFingerprint,
    sellerRoom: pending.sellerRoom,
    resource: pending.resource,
    orderId: pending.orderId,
    orderRoom: pending.orderRoom,
    attemptAt: pending.attemptAt,
    plannedAmount: pending.plannedAmount,
    resolvedAt: input.resolvedAt,
    evidenceKey: input.evidenceKey,
    reason: input.reason,
    transactionId: input.transactionId,
    transactionTime: input.transactionTime,
    actualAmount: input.actualAmount,
    actualTransactionEnergy:
      input.actualTransactionEnergy,
    actualNetCreditsMilli: input.actualNetCreditsMilli,
    pendingEvidenceHash: pending.frozenEvidenceHash,
  };
}

function recordOutcomeAndAdvance(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  outcome: ContinuousOutcome,
  actions: string[],
  dependencies: MarketDirectContinuousDependencies,
): boolean {
  const recorded = recordContinuousOutcome(
    state.ledger,
    tick,
    outcome,
  );
  state.ledger = recorded.state;
  projectContinuousCompatibility(state);
  if (!recorded.ok) {
    actions.push(
      `continuous-outcome-blocked:${
        recorded.blockerCode || "unknown"
      }`,
    );
    return false;
  }
  actions.push(`continuous-outcome:${outcome.status}`);
  const requestId = state.ledger.pending
    ? requestIdForPending(state.ledger.pending)
    : undefined;
  for (let index = 0; index < 4; index += 1) {
    const advanced = advanceContinuousWal(
      state.ledger,
      tick,
    );
    state.ledger = advanced.state;
    projectContinuousCompatibility(state);
    if (!advanced.ok || advanced.action === "blocked") {
      actions.push(
        `continuous-wal-blocked:${
          advanced.blockerCode || "unknown"
        }`,
      );
      return false;
    }
    if (
      advanced.action === "idle" ||
      advanced.action === "waiting_for_outcome"
    ) {
      break;
    }
    actions.push(`continuous-wal:${advanced.action}`);
    if (applyFinalizedLifecycleReceipts(state, tick)) {
      return false;
    }
    if (
      advanced.action === "pending_deleted" &&
      requestId
    ) {
      try {
        dependencies.releasePrepared(requestId);
      } catch {
        // 持久 claim 有 TTL；不允许因清理异常反向破坏已提交 receipt。
      }
      break;
    }
  }
  return true;
}

function transactionKey(
  transaction: DirectOutgoingTransaction,
): string | undefined {
  return transaction.order?.id
    ? `${transaction.transactionId}:${transaction.order.id}`
    : undefined;
}

function reconcileContinuousPending(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  dependencies: MarketDirectContinuousDependencies,
  actions: string[],
): void {
  const pending = state.ledger.pending;
  if (!pending) return;
  if (
    state.ledger.outcomes.some(
      (outcome) =>
        outcome.attemptSeq === pending.attemptSeq,
    )
  ) {
    advanceWalUntilWaiting(
      state,
      tick,
      actions,
      dependencies,
    );
    return;
  }
  if (tick < pending.attemptAt) {
    state.ledger = failClosedContinuousLedger(
      state.ledger,
      tick,
      "direct_pending_from_future",
      pending,
    );
    projectContinuousCompatibility(state);
    return;
  }
  if (tick === pending.attemptAt) return;

  if (tick <= pending.attemptAt + 1) {
    try {
      dependencies.claimPrepared({
        requestId: requestIdForPending(pending),
        roomName: pending.sellerRoom,
        actor: CONTINUOUS_ACTOR,
        attemptAt: pending.attemptAt,
      });
    } catch {
      // 对账仍以 transaction window 为权威。
    }
  }

  let window:
    | MarketDirectContinuousOutgoingWindow
    | undefined;
  try {
    window = dependencies.readOutgoingWindow(
      pending.attemptAt,
    );
  } catch {
    window = undefined;
  }
  if (
    !window ||
    window.observedAt !== tick ||
    !window.coversAttemptAt
  ) {
    state.ledger = failClosedContinuousLedger(
      state.ledger,
      tick,
      "direct_outgoing_window_incomplete",
      window,
    );
    projectContinuousCompatibility(state);
    return;
  }
  const baseline = new Set(
    pending.executionEvidence
      .outgoingTransactionKeysBefore,
  );
  const newTransactions = window.transactions.filter(
    (transaction) => {
      const key = transactionKey(transaction);
      return (
        key !== undefined &&
        !baseline.has(key) &&
        transaction.time >= pending.attemptAt
      );
    },
  );
  const matching = newTransactions.filter(
    (transaction) => {
      let priceMilli: number | undefined;
      try {
        priceMilli = transaction.order
          ? priceToMilliDown(transaction.order.price)
          : undefined;
      } catch {
        priceMilli = undefined;
      }
      return (
        transaction.order?.id === pending.orderId &&
        transaction.order.type === ORDER_BUY &&
        priceMilli ===
          pending.executionEvidence.observedOrderPriceMilli &&
        transaction.resourceType === pending.resource &&
        transaction.from === pending.sellerRoom &&
        transaction.to === pending.orderRoom &&
        Number.isSafeInteger(transaction.amount) &&
        transaction.amount > 0 &&
        transaction.amount <= pending.plannedAmount
      );
    },
  );
  const sameOrderButInvalid = newTransactions.some(
    (transaction) =>
      transaction.order?.id === pending.orderId &&
      !matching.includes(transaction),
  );
  if (matching.length > 1 || sameOrderButInvalid) {
    state.ledger = failClosedContinuousLedger(
      state.ledger,
      tick,
      "direct_transaction_evidence_conflict",
      newTransactions,
    );
    projectContinuousCompatibility(state);
    return;
  }
  if (matching.length === 1) {
    const transaction = matching[0];
    let actualEnergy: number;
    try {
      actualEnergy =
        dependencies.calculateTransactionEnergy(
          transaction.amount,
          pending.sellerRoom,
          pending.orderRoom,
        );
    } catch {
      actualEnergy = Number.NaN;
    }
    const grossMilli =
      pending.executionEvidence.observedOrderPriceMilli *
      transaction.amount;
    const energyCostMilli =
      pending.executionEvidence
        .effectiveEnergyShadowPriceMilli * actualEnergy;
    const actualNetCreditsMilli =
      grossMilli - energyCostMilli;
    const key = transactionKey(transaction)!;
    if (
      !Number.isSafeInteger(actualEnergy) ||
      actualEnergy < 0 ||
      !Number.isSafeInteger(actualNetCreditsMilli)
    ) {
      state.ledger = failClosedContinuousLedger(
        state.ledger,
        tick,
        "direct_actual_net_invalid",
        transaction,
      );
      projectContinuousCompatibility(state);
      return;
    }
    recordOutcomeAndAdvance(
      state,
      tick,
      continuousOutcomeFromPending(pending, {
        status: "confirmed",
        resolvedAt: tick,
        evidenceKey: key,
        transactionId: transaction.transactionId,
        transactionTime: transaction.time,
        actualAmount: transaction.amount,
        actualTransactionEnergy: actualEnergy,
        actualNetCreditsMilli,
      }),
      actions,
      dependencies,
    );
    return;
  }

  const terminal = dependencies.readTerminal(
    pending.sellerRoom,
    pending.resource as ResourceConstant,
  );
  const credits = dependencies.readCredits();
  const unchanged =
    terminal !== undefined &&
    terminal.resourceAmount ===
      pending.executionEvidence.terminalResourceBefore &&
    terminal.energy ===
      pending.executionEvidence.terminalEnergyBefore &&
    terminal.cooldown ===
      pending.executionEvidence.terminalCooldownBefore &&
    credits === pending.executionEvidence.creditsBefore;
  if (!unchanged) {
    state.ledger = failClosedContinuousLedger(
      state.ledger,
      tick,
      "direct_reconcile_gap",
      {
        credits,
        pending: pending.executionEvidence,
        terminal,
        window,
      },
    );
    projectContinuousCompatibility(state);
    return;
  }
  recordOutcomeAndAdvance(
    state,
    tick,
    continuousOutcomeFromPending(pending, {
      status: "not_filled",
      resolvedAt: tick,
      evidenceKey: `not-filled:${requestIdForPending(
        pending,
      )}`,
      reason: "complete_window_and_physical_state_unchanged",
      actualAmount: 0,
    }),
    actions,
    dependencies,
  );
}

export function runMarketDirectContinuousPreflight(
  state: MarketDirectContinuousAutomationState,
  input: Pick<
    MarketDirectContinuousAutomationInput,
    "tick" | "config"
  >,
  dependencies: MarketDirectContinuousDependencies =
    defaultMarketDirectContinuousDependencies,
): MarketDirectContinuousResult {
  const actions: string[] = [];
  const rejectedByReason: Record<string, number> = {};
  const normalized = normalizeContinuousDirectState(
    state,
    input.tick,
  );
  overwriteContinuousState(state, normalized);
  // 每 tick 先删除旧投影再重建；任何 permit/terminal/WAL/config 缺口都
  // 会留下空授权，ResourceControl 因而不能消费过期 readiness。
  projectLegacyV2ReadinessAuthorization(
    state,
    input,
    dependencies,
  );
  if (
    state.migrationBlockedReason ||
    state.ledger.blocker
  ) {
    const blocker =
      state.migrationBlockedReason ||
      state.ledger.blocker?.code ||
      "continuous_preflight_blocked";
    rejectedByReason[blocker] = 1;
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes: 0,
      planComplete: false,
      state,
    };
  }
  reconcileContinuousPending(
    state,
    input.tick,
    dependencies,
    actions,
  );
  advanceWalUntilWaiting(
    state,
    input.tick,
    actions,
    dependencies,
  );
  applyFinalizedLifecycleReceipts(state, input.tick);
  projectContinuousCompatibility(state);
  const projectedBlocker = readContinuousBlocker(state);
  if (projectedBlocker) {
    rejectedByReason[projectedBlocker.code] = 1;
  }
  return {
    actions,
    rejectedByReason,
    writes: 0,
    planComplete: !state.ledger.blocker,
    state,
  };
}

function incrementReason(
  target: Record<string, number>,
  reason: string,
  count = 1,
): void {
  target[reason] = (target[reason] || 0) + count;
}

function projectPlanningSnapshot(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  result: MarketDirectContinuousPlanningResult | undefined,
  blocker: string | undefined,
  rejectedByReason: Record<string, number>,
): void {
  const selected = result?.selected;
  state.lastPlanningSnapshot = {
    observedAt: tick,
    complete: result?.complete === true && !blocker,
    planningFingerprint:
      result?.planningFingerprint ||
      sanitizedHash(
        "market-direct-continuous:blocked-plan-v1",
        { blocker, tick },
      ),
    selected: selected
      ? {
          entryId: selected.entryId,
          resource:
            selected.resourceType as ResourceConstant,
          roomName: selected.roomName,
          orderId: selected.order.id,
          grossPrice: selected.grossPriceMilli / 1_000,
          unitNetPrice:
            selected.netCreditsMilli /
            selected.plannedAmount /
            1_000,
          transactionEnergy:
            selected.transactionEnergy,
        }
      : undefined,
    blocker,
    safeResourceTypes: [
      ...new Set(
        (result?.safeCandidates || []).map(
          (candidate) =>
            candidate.resourceType as ResourceConstant,
        ),
      ),
    ].sort(),
    admittedResourceTypes: [
      ...new Set(
        (result?.admittedCandidates || []).map(
          (candidate) =>
            candidate.resourceType as ResourceConstant,
        ),
      ),
    ].sort(),
    rejectedByReason: { ...rejectedByReason },
  };
}

function isExactMarketDirectShadowSecondRead(
  first: MarketDirectContinuousPlanningResult,
  second: MarketDirectContinuousPlanningResult,
): boolean {
  return (
    first.complete &&
    second.complete &&
    first.blocker === undefined &&
    second.blocker === undefined &&
    first.planningFingerprint === second.planningFingerprint &&
    first.planningEvidence === second.planningEvidence
  );
}

function observeShadowEntries(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  firstRead: ContinuousFullRead,
  secondRead: ContinuousFullRead | undefined,
  rejectedByReason: Record<string, number>,
): boolean {
  let complete = true;
  for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
    const lifecycle = state.lifecycleByEntry[entry.entryId];
    if (
      lifecycle.stage !== "shadow" &&
      lifecycle.stage !== "qualified"
    ) {
      continue;
    }
    let result:
      | "safe_opportunity"
      | "safe_no_opportunity"
      | "production_priority_wait"
      | "incomplete" = "incomplete";
    const firstEntry = firstRead.entries[entry.entryId];
    const secondEntry =
      secondRead?.entries[entry.entryId];
    const localObservation = (
      read: ContinuousFullRead,
      readEntry: ContinuousReadEntry | undefined,
    ): MarketDirectContinuousPlanningResult | undefined => {
      if (
        !read.complete ||
        !read.plannerInput ||
        !readEntry ||
        read.entryBlockers[entry.entryId]
      ) {
        return undefined;
      }
      try {
        return planMarketDirectContinuous({
          ...read.plannerInput,
          entries: [readEntry.plannerEntry],
          writeContext: {
            ...read.plannerInput.writeContext,
            arbiterState: "available",
          },
        });
      } catch {
        return undefined;
      }
    };
    const firstObservation = localObservation(
      firstRead,
      firstEntry,
    );
    const secondObservation = secondRead
      ? localObservation(secondRead, secondEntry)
      : undefined;
    const stableAcrossReads =
      !secondRead ||
      Boolean(
        firstRead.scopeEvidence === secondRead.scopeEvidence &&
          firstEntry &&
          secondEntry &&
          firstEntry.evidence === secondEntry.evidence &&
          firstObservation &&
          secondObservation &&
          isExactMarketDirectShadowSecondRead(
            firstObservation,
            secondObservation,
          ),
      );
    const observation =
      secondObservation || firstObservation;
    if (
      observation?.complete &&
      stableAcrossReads
    ) {
      if (
        firstRead.arbiterBlocked ||
        secondRead?.arbiterBlocked
      ) {
        result = "production_priority_wait";
      } else {
        result =
          observation.safeCandidates.length > 0
            ? "safe_opportunity"
            : "safe_no_opportunity";
      }
    } else {
      const blocker =
        secondRead?.entryBlockers[entry.entryId] ||
        firstRead.entryBlockers[entry.entryId] ||
        secondRead?.blocker ||
        firstRead.blocker ||
        observation?.blocker?.reason ||
        (stableAcrossReads
          ? "incomplete"
          : "second_read_changed");
      if (blocker) {
        incrementReason(
          rejectedByReason,
          `continuous_shadow:${blocker}:${entry.entryId}`,
        );
      }
    }
    if (result === "incomplete") complete = false;
    state.lifecycleByEntry[entry.entryId] =
      observeMarketDirectShadowCycle(lifecycle, {
        tick,
        result,
        resourceFingerprint: entry.resourceFingerprint,
        sharedFingerprint:
          CONTINUOUS_SHARED_POLICY_FINGERPRINT,
      });
  }
  return complete;
}

function writableContinuousEntryIds(
  state: MarketDirectContinuousAutomationState,
  shard: string,
): string[] {
  return MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.filter(
    (entry) => {
      const lifecycle =
        state.lifecycleByEntry[entry.entryId];
      return (
        lifecycle !== undefined &&
        !(
          lifecycle.stage === "canary" &&
          state.ledger.confirmedCanaries[entry.entryId]
        ) &&
        marketDirectPermitAllowsNewDeal(
          state.permitChain,
          {
            shard,
            entryId: entry.entryId,
            lifecycle,
          },
        )
      );
    },
  ).map((entry) => entry.entryId);
}

function rejectionSummary(
  result: MarketDirectContinuousPlanningResult,
  target: Record<string, number>,
): void {
  if (result.blocker) {
    incrementReason(
      target,
      `continuous_plan:${result.blocker.reason}`,
    );
  }
  for (const rejection of result.rejections) {
    incrementReason(
      target,
      `continuous_tuple:${rejection.reason}`,
    );
  }
}

function uniqueSafeOpportunities(
  result: MarketDirectContinuousPlanningResult,
): Array<{
  resource: string;
  resourceLimit: number;
  reserveAmount: number;
}> {
  const resultByResource = new Map<
    string,
    {
      resource: string;
      resourceLimit: number;
      reserveAmount: number;
    }
  >();
  for (const candidate of result.safeCandidates) {
    const entry =
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
        (item) => item.entryId === candidate.entryId,
      );
    if (
      !entry ||
      candidate.resourceQuotaBefore +
        CONTINUOUS_PLANNED_AMOUNT >
        entry.rollingMaxAmount
    ) {
      continue;
    }
    resultByResource.set(candidate.resourceType, {
      resource: candidate.resourceType,
      resourceLimit: entry.rollingMaxAmount,
      reserveAmount:
        entry.rollingOpportunityReserveAmount,
    });
  }
  return [...resultByResource.values()].sort(
    (left, right) =>
      left.resource.localeCompare(right.resource),
  );
}

function outgoingEvidenceKeys(
  window: MarketDirectContinuousOutgoingWindow,
): string[] {
  return window.transactions
    .map(transactionKey)
    .filter((key): key is string => key !== undefined)
    .sort();
}

function executionEvidenceFor(
  tick: number,
  selected: MarketDirectContinuousCandidate,
  planning: MarketDirectContinuousPlanningResult,
  read: ContinuousFullRead,
): ContinuousExecutionEvidence | undefined {
  const readEntry = read.entries[selected.entryId];
  const outgoing = read.outgoingWindow;
  if (!readEntry || !outgoing || read.credits === undefined) {
    return undefined;
  }
  return {
    observedOrderPriceMilli: selected.grossPriceMilli,
    observedOrderAmount:
      selected.order.remainingAmount ??
      selected.order.amount,
    effectiveEnergyShadowPriceMilli:
      selected.energyShadowPriceMilli,
    effectiveNetFloorMilli:
      selected.effectiveNetFloorMilli,
    worstCaseNetCreditsMilli:
      selected.worstCaseNetCreditsMilli,
    protectionRevision: tick,
    planningFingerprint:
      planning.planningFingerprint,
    planningEvidence: planning.planningEvidence,
    terminalResourceBefore:
      readEntry.terminal.resourceAmount,
    terminalEnergyBefore: readEntry.terminal.energy,
    terminalCooldownBefore:
      readEntry.terminal.cooldown,
    creditsBefore: read.credits,
    outgoingTransactionKeysBefore:
      outgoingEvidenceKeys(outgoing),
    outgoingWindowObservedAt: outgoing.observedAt,
    outgoingWindowOldestTime: outgoing.oldestTime,
    outgoingWindowNewestTime: outgoing.newestTime,
    outgoingWindowCoversAttemptAt:
      outgoing.coversAttemptAt,
  };
}

function failedOutcomeAfterPrepared(
  state: MarketDirectContinuousAutomationState,
  tick: number,
  reason: string,
  actions: string[],
  dependencies: MarketDirectContinuousDependencies,
): void {
  const pending = state.ledger.pending;
  if (!pending) return;
  recordOutcomeAndAdvance(
    state,
    tick,
    continuousOutcomeFromPending(pending, {
      status: "failed",
      resolvedAt: tick,
      evidenceKey: `failed:${requestIdForPending(
        pending,
      )}:${reason}`,
      reason,
      actualAmount: 0,
    }),
    actions,
    dependencies,
  );
}

export function runMarketDirectContinuousPlanning(
  state: MarketDirectContinuousAutomationState,
  input: MarketDirectContinuousAutomationInput,
  dependencies: MarketDirectContinuousDependencies =
    defaultMarketDirectContinuousDependencies,
): MarketDirectContinuousResult {
  const actions: string[] = [];
  const rejectedByReason: Record<string, number> = {};
  let writes = 0;
  if (
    !input.fullPlanningTick ||
    state.migrationStatus !== "active" ||
    state.migrationBlockedReason ||
    state.ledger.blocker ||
    state.ledger.pending
  ) {
    const reason = !input.fullPlanningTick
      ? "continuous_not_full_planning_tick"
      : state.migrationBlockedReason ||
        state.ledger.blocker?.code ||
        (state.ledger.pending
          ? "continuous_pending_active"
          : "continuous_not_active");
    incrementReason(rejectedByReason, reason);
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: false,
      state,
    };
  }

  const shard =
    dependencies.readExecutorShard() || "";
  const writableEntryIds =
    writableContinuousEntryIds(state, shard);
  const firstRead = buildContinuousFullRead(
    state,
    input,
    dependencies,
    writableEntryIds,
  );
  if (
    !firstRead.complete ||
    !firstRead.plannerInput
  ) {
    observeShadowEntries(
      state,
      input.tick,
      firstRead,
      undefined,
      rejectedByReason,
    );
    const blocker =
      firstRead.blocker || "continuous_first_read_incomplete";
    incrementReason(rejectedByReason, blocker);
    projectPlanningSnapshot(
      state,
      input.tick,
      undefined,
      blocker,
      rejectedByReason,
    );
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: false,
      state,
    };
  }
  if (writableEntryIds.length === 0) {
    const shadowComplete = observeShadowEntries(
      state,
      input.tick,
      firstRead,
      undefined,
      rejectedByReason,
    );
    projectPlanningSnapshot(
      state,
      input.tick,
      undefined,
      "continuous_no_writable_entry",
      rejectedByReason,
    );
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: shadowComplete,
      state,
    };
  }

  const planned = planMarketDirectContinuous(
    firstRead.plannerInput,
  );
  rejectionSummary(planned, rejectedByReason);
  projectPlanningSnapshot(
    state,
    input.tick,
    planned,
    planned.blocker?.reason,
    rejectedByReason,
  );
  if (!planned.complete || !planned.selected) {
    const shadowComplete = observeShadowEntries(
      state,
      input.tick,
      firstRead,
      undefined,
      rejectedByReason,
    );
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: planned.complete && shadowComplete,
      state,
    };
  }
  if (
    input.config.mode !== "direct" ||
    input.emergencyStop
  ) {
    const shadowComplete = observeShadowEntries(
      state,
      input.tick,
      firstRead,
      undefined,
      rejectedByReason,
    );
    incrementReason(
      rejectedByReason,
      "continuous_write_mode_blocked",
    );
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: shadowComplete,
      state,
    };
  }

  const secondRead = buildContinuousFullRead(
    state,
    input,
    dependencies,
    writableEntryIds,
  );
  const shadowComplete = observeShadowEntries(
    state,
    input.tick,
    firstRead,
    secondRead,
    rejectedByReason,
  );
  if (
    !secondRead.complete ||
    !secondRead.plannerInput ||
    secondRead.scopeEvidence !== firstRead.scopeEvidence
  ) {
    const blocker =
      secondRead.blocker ||
      "continuous_second_read_changed";
    incrementReason(rejectedByReason, blocker);
    projectPlanningSnapshot(
      state,
      input.tick,
      planned,
      blocker,
      rejectedByReason,
    );
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: false,
      state,
    };
  }
  const revalidated = planMarketDirectContinuous(
    secondRead.plannerInput,
  );
  if (
    !isExactMarketDirectContinuousSecondRead(
      planned,
      revalidated,
    )
  ) {
    incrementReason(
      rejectedByReason,
      "continuous_second_read_changed",
    );
    projectPlanningSnapshot(
      state,
      input.tick,
      revalidated,
      "continuous_second_read_changed",
      rejectedByReason,
    );
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: false,
      state,
    };
  }

  const selected = revalidated.selected!;
  const entry =
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
      (item) => item.entryId === selected.entryId,
    );
  const lifecycle =
    state.lifecycleByEntry[selected.entryId];
  const executionEvidence = executionEvidenceFor(
    input.tick,
    selected,
    revalidated,
    secondRead,
  );
  if (!entry || !lifecycle || !executionEvidence) {
    incrementReason(
      rejectedByReason,
      "continuous_execution_evidence_incomplete",
    );
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: false,
      state,
    };
  }
  const attemptSeq = state.ledger.nextAttemptSeq;
  const requestId = `continuous:${attemptSeq}:${input.tick}:${selected.entryId}`;
  const prepared = prepareContinuousAttempt(
    state.ledger,
    {
      tick: input.tick,
      executionPolicy:
        lifecycle.stage === "canary"
          ? "canary"
          : "continuous",
      permitId: state.currentPermit!.permitId,
      permitEpoch: state.currentPermit!.epoch,
      entryId: selected.entryId,
      resourcePolicyFingerprint:
        entry.resourceFingerprint,
      sellerRoom: selected.roomName,
      resource: selected.resourceType,
      orderId: selected.order.id,
      orderRoom: selected.order.roomName!,
      plannedAmount:
        MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
      plannedTransactionEnergy:
        selected.transactionEnergy,
      plannedNetCreditsMilli:
        selected.netCreditsMilli,
      evidenceKeyHint: requestId,
      executionEvidence,
      resourceLimit: entry.rollingMaxAmount,
      globalLimit:
        MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.rollingMaxAmount,
      safeOpportunityResources:
        uniqueSafeOpportunities(revalidated),
    },
  );
  state.ledger = prepared.state;
  projectContinuousCompatibility(state);
  if (!prepared.ok || !state.ledger.pending) {
    const blocker =
      prepared.blockerCode ||
      "continuous_prepare_failed";
    incrementReason(rejectedByReason, blocker);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: false,
      state,
    };
  }
  actions.push(`continuous-prepared:${requestId}`);

  let claimed = false;
  try {
    claimed = dependencies.claimPrepared({
      requestId,
      roomName: selected.roomName,
      actor: CONTINUOUS_ACTOR,
      attemptAt: input.tick,
    });
  } catch {
    claimed = false;
  }
  if (!claimed) {
    failedOutcomeAfterPrepared(
      state,
      input.tick,
      "claim_failed",
      actions,
      dependencies,
    );
    incrementReason(
      rejectedByReason,
      "continuous_claim_failed",
    );
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: false,
      state,
    };
  }

  let result: unknown;
  try {
    writes += 1;
    result = dependencies.executePrepared({
      requestId,
      roomName: selected.roomName,
      actor: CONTINUOUS_ACTOR,
      attemptAt: input.tick,
      orderId: selected.order.id,
      amount: selected.plannedAmount,
    });
  } catch {
    actions.push(`continuous-deal-unknown:${requestId}`);
    projectContinuousCompatibility(state);
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete: shadowComplete,
      state,
    };
  }
  if (isExplicitMarketNonOkReturnCode(result)) {
    failedOutcomeAfterPrepared(
      state,
      input.tick,
      `market_non_ok:${result}`,
      actions,
      dependencies,
    );
    incrementReason(
      rejectedByReason,
      `continuous_deal_error:${result}`,
    );
  } else {
    actions.push(`continuous-deal-submitted:${requestId}`);
  }
  projectContinuousCompatibility(state);
  return {
    actions,
    rejectedByReason,
    writes,
    planComplete: shadowComplete,
    state,
  };
}

export function marketDirectContinuousExposure(
  state: MarketDirectContinuousAutomationState,
): {
  resourceAmount: number;
  energyAmount: number;
  pendingCount: number;
  quarantinedCount: number;
} {
  return {
    resourceAmount:
      state.ledger.pending?.plannedAmount ?? 0,
    energyAmount:
      state.ledger.pending?.plannedTransactionEnergy ?? 0,
    pendingCount: state.ledger.pending ? 1 : 0,
    quarantinedCount:
      Object.keys(state.quarantinedPendingDirectDeals).length +
      (state.ledger.blocker ? 1 : 0),
  };
}

export function marketDirectContinuousStatus(
  state: MarketDirectContinuousAutomationState,
  tick: number,
): unknown {
  const quotas = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
    (entry) => ({
      entryId: entry.entryId,
      lifecycle:
        state.lifecycleByEntry[entry.entryId],
      quota: computeContinuousQuota(
        state.ledger,
        tick,
        entry.resourceType,
        entry.rollingMaxAmount,
        MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.rollingMaxAmount,
      ),
    }),
  );
  const entries = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
    (entry, index) => ({
      entryId: entry.entryId,
      resourceType: entry.resourceType,
      allowedRoomNames: entry.allowedRoomNames,
      requireNativeMineral:
        entry.requireNativeMineral,
      hardFloor: entry.hardFloor,
      economicFloor: entry.economicFloor,
      laneReserve: entry.laneReserve,
      rollingWindowTicks: entry.rollingWindowTicks,
      rollingMaxAmount: entry.rollingMaxAmount,
      opportunityReserveAmount:
        entry.rollingOpportunityReserveAmount,
      lifecycle:
        state.lifecycleByEntry[entry.entryId],
      quota: quotas[index].quota,
    }),
  );
  return {
    schemaVersion: state.schemaVersion,
    capability: state.capability,
    migrationStatus: state.migrationStatus,
    migrationBlockedReason:
      state.migrationBlockedReason,
    permit: state.currentPermit
      ? {
          epoch: state.currentPermit.epoch,
          permitId: state.currentPermit.permitId,
          permitHead: state.currentPermit.permitHead,
          grants: state.currentPermit.entryGrants,
        }
      : undefined,
    proposedPermit: state.proposedPermit?.permit,
    lifecycleByEntry: state.lifecycleByEntry,
    entries,
    ledger: {
      receiptHeadHash: state.ledger.receiptHeadHash,
      finalizedAttemptSeq:
        state.ledger.finalizedAttemptSeq,
      nextAttemptSeq: state.ledger.nextAttemptSeq,
      coverageStartTick:
        state.ledger.coverageStartTick,
      permitEpochHighWater:
        state.ledger.permitEpochHighWater,
      permitChainHeadHighWater:
        state.ledger.permitChainHeadHighWater,
      lifetimeConfirmed:
        state.ledger.lifetimeConfirmed,
      confirmedCanaries:
        state.ledger.confirmedCanaries,
      pending: state.ledger.pending,
      blocker: state.ledger.blocker,
      quotas,
    },
    lastPlanningSnapshot:
      state.lastPlanningSnapshot,
    baseResourceV3:
      state.baseResourceV3,
  };
}

function readContinuousBlocker(state: MarketDirectContinuousAutomationState) { return state.ledger.blocker; }
