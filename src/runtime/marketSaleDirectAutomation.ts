import {
  claimPreparedDirectMarketClaims,
  executePreparedDirectMarketDeal,
  hasMarketAccountClaim,
  hasMarketActionIntentThisTick,
  hasTerminalActionClaim,
  isExplicitMarketNonOkReturnCode,
  releasePreparedDirectMarketClaims,
} from "@/runtime/marketActionArbiter";
import {
  directSafetyFingerprint,
  type ResolvedMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  createEmptyDirectPendingStore,
  isRecoverableDirectPendingStoreShape,
  isRecoverablePendingDirectDeal,
  isRecoverableDirectDealOutcome,
  markDirectSubmissionResult,
  normalizeDirectPendingStore,
  prepareDirectPending,
  reconcileDirectPendingDeals,
  resolveDirectPendingWithEvidence,
  summarizeDirectPendingExposure,
  type DirectOutgoingTransaction,
  type DirectOutgoingWindow,
  type DirectPendingReconcileDependencies,
  type DirectPendingStore,
  type DirectPhysicalSnapshot,
  type OperatorDirectPendingEvidence,
  type PendingDirectDeal,
} from "@/runtime/marketSaleDirectPending";
import {
  DIRECT_CANARY_MAX_ELIGIBLE_ORDERS,
  DIRECT_CANARY_MAX_RAW_ORDERS,
  rankDirectCurrentBuyOrders,
  type DirectPricingCandidate,
  type DirectPricingResult,
} from "@/runtime/marketSaleDirectPricing";
import {
  advanceDirectShadowQualification,
  createDirectShadowQualification,
  getDirectPlanningSnapshotStatus,
  isDirectActivationQualified,
  observeDirectLifecycleTransition,
  REQUIRED_DIRECT_SHADOW_CYCLES,
  selectDirectStructuralCanary,
  type DirectPlanningSnapshot,
  type DirectShadowQualification,
  type DirectStructuralCandidate,
} from "@/runtime/marketSaleDirectShadow";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
import { directEngineAssumptionsValid } from "@/runtime/marketSaleDirectEngineAssumptions";

export interface DirectRuntimeCandidate extends DirectStructuralCandidate {
  protectedAmount: number;
  effectiveNetFloor: number;
  directHistoryTrusted: boolean;
  effectiveEnergyShadowPrice?: number;
  energyShadowObservedAt?: number;
  energyShadowComponents?: {
    hardFloor: number;
    explicit?: number;
    historyFloor?: number;
    ratchetFloor?: number;
  };
}

export interface DirectTerminalSnapshot {
  roomName: string;
  resourceStock: number;
  energy: number;
  cooldown: number;
}

export interface DirectOpportunitySummary {
  orderId: string;
  orderRoomName: string;
  price: number;
  orderAmount: number;
  dealAmount: number;
  transactionEnergy: number;
  netCreditsMilli: number;
  worstCaseNetCreditsMilli: number;
  effectiveNetFloorMilli: number;
}

export interface DirectBuyBookSummary {
  rawOrderCount: number;
  rawOrderLimit: number;
  eligibleOrderCount: number;
  eligibleOrderLimit: number;
  eligibleDepth: number;
  eligibleDistinctRoomCount: number;
  pricedOrderCount: number;
  safeCandidateCount: number;
  rejectedOrderCount: number;
  highestGrossPrice?: number;
  selectedOrderId?: string;
  cycleRejection?: string;
  orderRejectionCounts: Record<string, number>;
}

export interface DirectAutomationPlanningSnapshot
  extends DirectPlanningSnapshot<DirectOpportunitySummary> {
  structuralCandidateCount: number;
  eligibleStructuralCandidateCount: number;
  buyBook: DirectBuyBookSummary;
  manualBuyOrderCount: number;
  manualSellOrderCount: number;
  zeroRemainingOwnOrderCount: number;
  effectiveNetFloor?: number;
  effectiveEnergyShadowPrice?: number;
  energyShadowObservedAt?: number;
  energyShadowComponents?: DirectRuntimeCandidate["energyShadowComponents"];
}

export interface DirectAutomationState extends DirectPendingStore {
  schemaVersion: 1;
  shadowQualification: DirectShadowQualification;
  lastPlanningSnapshot?: DirectAutomationPlanningSnapshot;
  migrationBlockedReason?: string;
}

export interface DirectAutomationDependencies {
  readCurrentBuyOrders: (
    resource: ResourceConstant,
  ) => MarketOrderSnapshot[];
  readOwnOrders: () => MarketOrderSnapshot[];
  getOrderById: (orderId: string) => MarketOrderSnapshot | undefined;
  readTerminal: (
    roomName: string,
    resource: ResourceConstant,
  ) => DirectTerminalSnapshot | undefined;
  readCredits: () => number | undefined;
  readOutgoingWindow: (attemptAt: number) => DirectOutgoingWindow | undefined;
  calculateTransactionEnergy: (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ) => number;
  claimPrepared: (input: {
    requestId: string;
    roomName: string;
    actor: string;
    attemptAt: number;
  }) => boolean;
  executePrepared: (input: {
    requestId: string;
    roomName: string;
    actor: string;
    attemptAt: number;
    orderId: string;
    amount: number;
  }) => unknown;
  releasePrepared: (requestId: string) => void;
  hasProductionMarketIntent: () => boolean;
  hasTerminalOrMarketClaim: (roomName: string) => boolean;
}

export interface DirectAutomationInput {
  tick: number;
  fullPlanningTick: boolean;
  config: ResolvedMarketSaleAutomationConfig;
  candidates: readonly DirectRuntimeCandidate[];
  makerExposurePresent: boolean;
}

export interface DirectAutomationResult {
  actions: string[];
  rejectedByReason: Record<string, number>;
  writes: number;
  planComplete: boolean;
  opportunity?: DirectOpportunitySummary;
}

const DIRECT_STATE_SCHEMA_VERSION = 1;
const DIRECT_ACTOR = "marketSaleAutomation:direct";
const MAX_OUTGOING_TRANSACTIONS = 100;
const DIRECT_ENERGY_SHADOW_MAX_AGE_TICKS = 99;

function isUsablePendingRecord(
  key: string,
  value: unknown,
): value is PendingDirectDeal {
  return isRecoverablePendingDirectDeal(value, key);
}

function isNonNegativeTick(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizeQualification(
  value: unknown,
): { qualification: DirectShadowQualification; valid: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      qualification: createDirectShadowQualification(),
      valid: false,
    };
  }
  const raw = value as Partial<DirectShadowQualification>;
  const canary = raw.canary;
  const canaryValid =
    canary === undefined ||
    (typeof canary === "object" &&
      canary !== null &&
      !Array.isArray(canary) &&
      typeof canary.roomName === "string" &&
      /^[WE]\d+[NS]\d+$/.test(canary.roomName) &&
      typeof canary.resourceType === "string" &&
      RESOURCES_ALL.includes(canary.resourceType) &&
      isNonNegativeTick(canary.lockedAt) &&
      typeof canary.configRevision === "string" &&
      canary.configRevision.length > 0 &&
      typeof canary.safetyFingerprint === "string" &&
      canary.safetyFingerprint.length > 0);
  const lifecycleKeyValid =
    raw.lastLifecycleKey === undefined ||
    raw.lastLifecycleKey === "direct_shadow" ||
    raw.lastLifecycleKey === "direct" ||
    raw.lastLifecycleKey === "other";
  const qualificationThresholdReached =
    typeof raw.consecutiveCycles === "number" &&
    raw.consecutiveCycles >= REQUIRED_DIRECT_SHADOW_CYCLES;
  const scalarValid =
    isNonNegativeTick(raw.consecutiveCycles) &&
    typeof raw.activationAuthorized === "boolean" &&
    (raw.configRevision === undefined ||
      (typeof raw.configRevision === "string" &&
        raw.configRevision.length > 0)) &&
    (raw.safetyFingerprint === undefined ||
      (typeof raw.safetyFingerprint === "string" &&
        raw.safetyFingerprint.length > 0)) &&
    (raw.lastCycleTick === undefined ||
      isNonNegativeTick(raw.lastCycleTick)) &&
    (raw.qualifiedAt === undefined ||
      isNonNegativeTick(raw.qualifiedAt)) &&
    lifecycleKeyValid &&
    (raw.lastLifecycleTick === undefined ||
      isNonNegativeTick(raw.lastLifecycleTick));
  const policyFieldsConsistent =
    (!canary ||
      (raw.configRevision === canary.configRevision &&
        raw.safetyFingerprint === canary.safetyFingerprint)) &&
    (raw.consecutiveCycles === 0 ||
      Boolean(raw.configRevision && raw.safetyFingerprint && canary)) &&
    qualificationThresholdReached === (raw.qualifiedAt !== undefined) &&
    (!raw.activationAuthorized ||
      Boolean(
        qualificationThresholdReached &&
          raw.qualifiedAt !== undefined &&
          raw.configRevision &&
          raw.safetyFingerprint &&
          canary,
      ));
  if (!canaryValid || !scalarValid || !policyFieldsConsistent) {
    return {
      qualification: createDirectShadowQualification(),
      valid: false,
    };
  }
  return {
    qualification: {
      configRevision: raw.configRevision,
      safetyFingerprint: raw.safetyFingerprint,
      canary: canary
        ? {
            roomName: canary.roomName,
            resourceType: canary.resourceType,
            lockedAt: canary.lockedAt,
            configRevision: canary.configRevision,
            safetyFingerprint: canary.safetyFingerprint,
          }
        : undefined,
      consecutiveCycles: raw.consecutiveCycles ?? 0,
      lastCycleTick: raw.lastCycleTick,
      qualifiedAt: raw.qualifiedAt,
      lastLifecycleKey: raw.lastLifecycleKey,
      lastLifecycleTick: raw.lastLifecycleTick,
      activationAuthorized: raw.activationAuthorized === true,
    },
    valid: true,
  };
}

function reject(
  result: DirectAutomationResult,
  reason: string,
): void {
  result.rejectedByReason[reason] =
    (result.rejectedByReason[reason] || 0) + 1;
}

function directStrategyActive(
  config: ResolvedMarketSaleAutomationConfig,
): boolean {
  return (
    config.mode === "direct" ||
    (config.mode === "shadow" && config.shadowStrategy === "direct")
  );
}

function emptyResult(): DirectAutomationResult {
  return {
    actions: [],
    rejectedByReason: {},
    writes: 0,
    planComplete: false,
  };
}

export function createDirectAutomationState(): DirectAutomationState {
  return {
    schemaVersion: DIRECT_STATE_SCHEMA_VERSION,
    shadowQualification: createDirectShadowQualification(),
    ...createEmptyDirectPendingStore(),
  };
}

export function normalizeDirectAutomationState(
  value: Partial<DirectAutomationState> | undefined,
): DirectAutomationState {
  if (!value) return createDirectAutomationState();
  const pendingStoreShapeValid =
    isRecoverableDirectPendingStoreShape(value);
  const pending = normalizeDirectPendingStore(value);
  const normalizedQualification = normalizeQualification(
    value.shadowQualification,
  );
  const qualification = normalizedQualification.qualification;
  const pendingEntries = Object.entries(pending.pendingDirectDeals);
  const outcomeStateInvalid = pending.directDealOutcomes.some(
    (outcome) => !isRecoverableDirectDealOutcome(outcome),
  );
  const pendingStateInvalid =
    pendingEntries.length > 1 ||
    pendingEntries.some(
      ([key, record]) => !isUsablePendingRecord(key, record),
    );
  const retainedStructuralBlocker =
    value.migrationBlockedReason &&
    value.migrationBlockedReason !==
      "direct_qualification_state_invalid"
      ? value.migrationBlockedReason
      : undefined;
  return {
    schemaVersion: DIRECT_STATE_SCHEMA_VERSION,
    shadowQualification: qualification,
    ...pending,
    lastPlanningSnapshot: value.lastPlanningSnapshot,
    migrationBlockedReason:
      value.schemaVersion !== DIRECT_STATE_SCHEMA_VERSION
        ? "unsupported_direct_state_schema"
        : !pendingStoreShapeValid
          ? retainedStructuralBlocker ||
            "direct_pending_store_state_invalid"
        : !normalizedQualification.valid
          ? "direct_qualification_state_invalid"
        : pendingStateInvalid
          ? "direct_pending_state_invalid"
          : outcomeStateInvalid
            ? "direct_outcome_state_invalid"
            : value.migrationBlockedReason ===
                "direct_qualification_state_invalid"
              ? undefined
              : value.migrationBlockedReason,
  };
}

function toOpportunity(
  candidate: DirectPricingCandidate,
): DirectOpportunitySummary {
  return {
    orderId: candidate.order.id,
    orderRoomName: candidate.order.roomName!,
    price: candidate.order.price,
    orderAmount: candidate.order.amount,
    dealAmount: candidate.dealAmount,
    transactionEnergy: candidate.transactionEnergy,
    netCreditsMilli: candidate.netCreditsMilli,
    worstCaseNetCreditsMilli: candidate.worstCaseNetCreditsMilli,
    effectiveNetFloorMilli: candidate.effectiveNetFloorMilli,
  };
}

function summarizeBook(result: DirectPricingResult): DirectBuyBookSummary {
  return {
    rawOrderCount: result.summary.rawOrderCount,
    rawOrderLimit: DIRECT_CANARY_MAX_RAW_ORDERS,
    eligibleOrderCount: result.summary.eligibleOrderCount,
    eligibleOrderLimit: DIRECT_CANARY_MAX_ELIGIBLE_ORDERS,
    eligibleDepth: result.summary.eligibleDepth,
    eligibleDistinctRoomCount:
      result.summary.eligibleDistinctRoomCount,
    pricedOrderCount: result.summary.pricedOrderCount,
    safeCandidateCount: result.summary.safeCandidateCount,
    rejectedOrderCount: result.summary.rejectedOrderCount,
    highestGrossPrice: result.summary.highestGrossPrice,
    selectedOrderId: result.selected?.order.id,
    cycleRejection: result.cycleRejection?.reason,
    orderRejectionCounts: {
      ...result.summary.orderRejectionCounts,
    },
  };
}

function emptyBookSummary(): DirectBuyBookSummary {
  return {
    rawOrderCount: 0,
    rawOrderLimit: DIRECT_CANARY_MAX_RAW_ORDERS,
    eligibleOrderCount: 0,
    eligibleOrderLimit: DIRECT_CANARY_MAX_ELIGIBLE_ORDERS,
    eligibleDepth: 0,
    eligibleDistinctRoomCount: 0,
    pricedOrderCount: 0,
    safeCandidateCount: 0,
    rejectedOrderCount: 0,
    orderRejectionCounts: {},
  };
}

function resetIncompleteQualification(
  state: DirectAutomationState,
  tick: number,
): void {
  state.shadowQualification.consecutiveCycles = 0;
  state.shadowQualification.qualifiedAt = undefined;
  state.shadowQualification.lastCycleTick = tick;
  state.shadowQualification.activationAuthorized = false;
}

function invalidateDirectQualification(
  state: DirectAutomationState,
  tick: number,
): void {
  state.shadowQualification.configRevision = undefined;
  state.shadowQualification.safetyFingerprint = undefined;
  state.shadowQualification.canary = undefined;
  state.shadowQualification.consecutiveCycles = 0;
  state.shadowQualification.lastCycleTick = tick;
  state.shadowQualification.qualifiedAt = undefined;
  state.shadowQualification.activationAuthorized = false;
}

function projectSnapshot(
  state: DirectAutomationState,
  input: DirectAutomationInput,
  result: DirectAutomationResult,
  selected: DirectRuntimeCandidate | undefined,
  planningResult:
    | DirectAutomationPlanningSnapshot["result"],
  book: DirectBuyBookSummary,
  own: {
    manualBuyOrderCount: number;
    manualSellOrderCount: number;
    zeroRemainingOwnOrderCount: number;
  },
  opportunity?: DirectOpportunitySummary,
): void {
  const fingerprint = directSafetyFingerprint(input.config) || "";
  state.lastPlanningSnapshot = {
    observedAt: input.tick,
    configRevision: input.config.configRevision || "",
    safetyFingerprint: fingerprint,
    canary: state.shadowQualification.canary,
    result: planningResult,
    rejectedByReason: { ...result.rejectedByReason },
    opportunity,
    structuralCandidateCount: input.candidates.length,
    eligibleStructuralCandidateCount: input.candidates.filter(
      (candidate) => candidate.rejectionReasons.length === 0,
    ).length,
    buyBook: book,
    ...own,
    effectiveNetFloor: selected?.effectiveNetFloor,
    effectiveEnergyShadowPrice:
      selected?.effectiveEnergyShadowPrice,
    energyShadowObservedAt: selected?.energyShadowObservedAt,
    energyShadowComponents: selected?.energyShadowComponents,
  };
}

function ownOrderSummary(orders: readonly MarketOrderSnapshot[]): {
  manualBuyOrderCount: number;
  manualSellOrderCount: number;
  zeroRemainingOwnOrderCount: number;
} {
  let manualBuyOrderCount = 0;
  let manualSellOrderCount = 0;
  let zeroRemainingOwnOrderCount = 0;
  for (const order of orders) {
    const remaining = Number.isSafeInteger(order.remainingAmount)
      ? order.remainingAmount
      : order.amount;
    if (remaining === undefined || remaining <= 0) {
      zeroRemainingOwnOrderCount += 1;
    } else if (order.type === ORDER_BUY) {
      manualBuyOrderCount += 1;
    } else if (order.type === ORDER_SELL) {
      manualSellOrderCount += 1;
    }
  }
  return {
    manualBuyOrderCount,
    manualSellOrderCount,
    zeroRemainingOwnOrderCount,
  };
}

function rankCurrentBook(
  dependencies: DirectAutomationDependencies,
  selected: DirectRuntimeCandidate,
  terminal: DirectTerminalSnapshot,
  terminalEnergyReserve: number,
  ownOrders: readonly MarketOrderSnapshot[],
): DirectPricingResult {
  const orders = dependencies.readCurrentBuyOrders(selected.resourceType);
  return rankDirectCurrentBuyOrders({
    orders,
    resourceType: selected.resourceType,
    ownOrderIds: ownOrders.map((order) => order.id),
    sellableAmount: Math.floor(selected.sellableAmount),
    terminalStock: Math.floor(terminal.resourceStock),
    effectiveNetFloor: selected.effectiveNetFloor,
    effectiveEnergyShadowPrice:
      selected.effectiveEnergyShadowPrice!,
    maxTransactionEnergyAvailable: Math.max(
      0,
      Math.floor(terminal.energy - terminalEnergyReserve),
    ),
    calculateTransactionEnergy: (amount, order) =>
      dependencies.calculateTransactionEnergy(
        amount,
        selected.roomName,
        order.roomName!,
      ),
  });
}

function exactOpportunityUnchanged(
  first: DirectPricingCandidate | undefined,
  second: DirectPricingCandidate | undefined,
): boolean {
  if (!first) return second === undefined;
  return Boolean(
    second &&
      second.order.id === first.order.id &&
      second.order.roomName === first.order.roomName &&
      second.order.price === first.order.price &&
      second.order.amount === first.order.amount &&
      second.dealAmount === first.dealAmount &&
      second.transactionEnergy === first.transactionEnergy &&
      second.netCreditsMilli === first.netCreditsMilli &&
      second.worstCaseNetCreditsMilli ===
        first.worstCaseNetCreditsMilli,
  );
}

function terminalSafeForCandidate(
  terminal: DirectTerminalSnapshot | undefined,
  candidate: DirectRuntimeCandidate,
  terminalEnergyReserve: number,
  transactionEnergy = 0,
): boolean {
  if (!terminal) return false;
  const requiredResource =
    candidate.resourceType === RESOURCE_ENERGY
      ? 1_000 + transactionEnergy
      : 1_000;
  return Boolean(
    terminal.cooldown === 0 &&
      Number.isSafeInteger(terminal.resourceStock) &&
      terminal.resourceStock >= requiredResource &&
      Number.isSafeInteger(terminal.energy) &&
      terminal.energy >= terminalEnergyReserve + transactionEnergy,
  );
}

function physicalSnapshot(
  dependencies: DirectAutomationDependencies,
  pending: PendingDirectDeal,
): DirectPhysicalSnapshot | undefined {
  const terminal = dependencies.readTerminal(
    pending.canaryRoomName,
    pending.resource,
  );
  const credits = dependencies.readCredits();
  if (
    !terminal ||
    typeof credits !== "number" ||
    !Number.isFinite(credits)
  ) {
    return undefined;
  }
  return {
    terminalResource: terminal.resourceStock,
    terminalEnergy: terminal.energy,
    terminalCooldown: terminal.cooldown,
    credits,
  };
}

function pendingDependencies(
  dependencies: DirectAutomationDependencies,
): DirectPendingReconcileDependencies {
  return {
    calculateTransactionEnergy: dependencies.calculateTransactionEnergy,
    readPhysicalSnapshot: (pending) => {
      try {
        return physicalSnapshot(dependencies, pending);
      } catch {
        return undefined;
      }
    },
    releasePreparedClaims: (requestId) => {
      try {
        dependencies.releasePrepared(requestId);
      } catch {
        // 持久 account claim 有 attemptAt+1 TTL；释放异常不得使整 tick 崩溃。
      }
    },
  };
}

export function runDirectAutomationPreflight(
  state: DirectAutomationState,
  input: {
    tick: number;
    config: ResolvedMarketSaleAutomationConfig;
  },
  dependencies: DirectAutomationDependencies = defaultDirectAutomationDependencies,
): DirectAutomationResult {
  const result = emptyResult();
  const fingerprint = directSafetyFingerprint(input.config);
  observeDirectLifecycleTransition(state.shadowQualification, {
    tick: input.tick,
    mode: input.config.mode,
    shadowStrategy: input.config.shadowStrategy,
    configRevision: input.config.configRevision,
    safetyFingerprint: fingerprint,
  });
  if (
    !input.config.validForPlanning ||
    !input.config.configRevision ||
    !fingerprint ||
    !directEngineAssumptionsValid()
  ) {
    invalidateDirectQualification(state, input.tick);
  }

  if (
    state.migrationBlockedReason &&
    state.migrationBlockedReason !==
      "direct_qualification_state_invalid"
  ) {
    reject(result, state.migrationBlockedReason);
    return result;
  }
  if (
    state.migrationBlockedReason ===
    "direct_qualification_state_invalid"
  ) {
    // Qualification 损坏只清空未来写授权；已有 WAL 必须继续只读对账，
    // 否则资源 exposure 会永久卡死。
    reject(result, state.migrationBlockedReason);
  }
  const pendingCount = Object.keys(state.pendingDirectDeals).length;
  if (pendingCount === 0) return result;
  if (pendingCount > 1) {
    reject(result, "direct_multiple_pending_invalid");
    return result;
  }
  const firstPending = Object.values(state.pendingDirectDeals).sort((a, b) =>
    a.requestId.localeCompare(b.requestId),
  )[0];
  let window: DirectOutgoingWindow | undefined;
  try {
    window = dependencies.readOutgoingWindow(firstPending.attemptAt);
  } catch {
    window = undefined;
  }
  const reconciled = reconcileDirectPendingDeals(
    state,
    { tick: input.tick, outgoingWindow: window },
    pendingDependencies(dependencies),
  );
  result.actions.push(...reconciled.actions);
  Object.assign(result.rejectedByReason, reconciled.rejectedByReason);
  return result;
}

export function runDirectAutomationPlanning(
  state: DirectAutomationState,
  input: DirectAutomationInput,
  dependencies: DirectAutomationDependencies = defaultDirectAutomationDependencies,
): DirectAutomationResult {
  const result = emptyResult();
  const fingerprint = directSafetyFingerprint(input.config);
  observeDirectLifecycleTransition(state.shadowQualification, {
    tick: input.tick,
    mode: input.config.mode,
    shadowStrategy: input.config.shadowStrategy,
    configRevision: input.config.configRevision,
    safetyFingerprint: fingerprint,
  });

  const emptyOwn = {
    manualBuyOrderCount: 0,
    manualSellOrderCount: 0,
    zeroRemainingOwnOrderCount: 0,
  };
  const rejectIncomplete = (
    reason: string,
    selected?: DirectRuntimeCandidate,
    own = emptyOwn,
    book = emptyBookSummary(),
  ): DirectAutomationResult => {
    reject(result, reason);
    if (
      input.config.mode === "shadow" &&
      input.config.shadowStrategy === "direct"
    ) {
      resetIncompleteQualification(state, input.tick);
    } else if (input.config.mode === "direct") {
      invalidateDirectQualification(state, input.tick);
    }
    if (input.fullPlanningTick) {
      projectSnapshot(
        state,
        input,
        result,
        selected,
        "incomplete",
        book,
        own,
      );
    }
    return result;
  };

  if (
    !input.config.validForPlanning ||
    !input.config.configRevision ||
    !fingerprint ||
    !directEngineAssumptionsValid()
  ) {
    for (const reason of input.config.invalidReasons) reject(result, reason);
    invalidateDirectQualification(state, input.tick);
    if (!directEngineAssumptionsValid()) {
      reject(result, "direct_engine_assumptions_invalid");
    }
    return rejectIncomplete("direct_config_invalid");
  }
  if (!input.fullPlanningTick || !directStrategyActive(input.config)) {
    return result;
  }
  if (state.migrationBlockedReason) {
    return rejectIncomplete(state.migrationBlockedReason);
  }
  if (
    state.directPausedForReview ||
    state.directConfirmedDealCount >=
      input.config.directCanaryMaxConfirmedDeals
  ) {
    return rejectIncomplete("paused_for_review");
  }
  if (Object.keys(state.pendingDirectDeals).length > 0) {
    return rejectIncomplete("direct_pending_present");
  }
  if (input.makerExposurePresent) {
    return rejectIncomplete("maker_exposure_present");
  }

  const lockedCanary = state.shadowQualification.canary;
  const lockMatchesPolicy = Boolean(
    lockedCanary &&
      lockedCanary.configRevision === input.config.configRevision &&
      lockedCanary.safetyFingerprint === fingerprint,
  );
  let runtimeCandidate: DirectRuntimeCandidate | undefined;
  if (lockedCanary && lockMatchesPolicy) {
    runtimeCandidate = input.candidates.find(
      (candidate) =>
        candidate.roomName === lockedCanary.roomName &&
        candidate.resourceType === lockedCanary.resourceType,
    );
    if (
      !runtimeCandidate ||
      !selectDirectStructuralCanary([runtimeCandidate])
    ) {
      return rejectIncomplete(
        "direct_locked_canary_unavailable",
        runtimeCandidate,
      );
    }
  } else if (input.config.mode === "direct") {
    return rejectIncomplete("direct_locked_canary_missing");
  } else {
    if (lockedCanary) {
      state.shadowQualification.canary = undefined;
      state.shadowQualification.consecutiveCycles = 0;
      state.shadowQualification.qualifiedAt = undefined;
    }
    runtimeCandidate = selectDirectStructuralCanary(
      input.candidates,
    ) as DirectRuntimeCandidate | undefined;
    if (!runtimeCandidate) {
      return rejectIncomplete("direct_structural_canary_unavailable");
    }
  }
  if (
    runtimeCandidate.resourceType !== RESOURCE_CATALYST ||
    runtimeCandidate.protectionRevision !== input.tick ||
    runtimeCandidate.observedAt !== input.tick ||
    runtimeCandidate.expiresAt !== input.tick ||
    runtimeCandidate.sellableAmount < 1_000 ||
    runtimeCandidate.terminalCooldown !== 0 ||
    !Number.isSafeInteger(runtimeCandidate.terminalEnergy) ||
    runtimeCandidate.terminalEnergy! <
      input.config.terminalEnergyReserve ||
    runtimeCandidate.directHistoryTrusted !== true ||
    !Number.isFinite(runtimeCandidate.effectiveNetFloor) ||
    runtimeCandidate.effectiveNetFloor <= 0 ||
    !Number.isFinite(runtimeCandidate.effectiveEnergyShadowPrice) ||
    runtimeCandidate.effectiveEnergyShadowPrice! < 0 ||
    !Number.isSafeInteger(runtimeCandidate.energyShadowObservedAt) ||
    runtimeCandidate.energyShadowObservedAt! > input.tick ||
    input.tick - runtimeCandidate.energyShadowObservedAt! >
      DIRECT_ENERGY_SHADOW_MAX_AGE_TICKS ||
    !runtimeCandidate.energyShadowComponents
  ) {
    return rejectIncomplete(
      "direct_structural_evidence_incomplete",
      runtimeCandidate,
    );
  }

  let ownOrders: MarketOrderSnapshot[];
  try {
    ownOrders = dependencies.readOwnOrders();
  } catch {
    return rejectIncomplete(
      "direct_own_orders_read_failed",
      runtimeCandidate,
    );
  }
  const own = ownOrderSummary(ownOrders);
  if (own.manualSellOrderCount > 0) {
    return rejectIncomplete(
      "manual_sell_order_present",
      runtimeCandidate,
      own,
    );
  }
  if (own.manualBuyOrderCount > 0) {
    return rejectIncomplete(
      "manual_buy_order_present",
      runtimeCandidate,
      own,
    );
  }

  let terminal: DirectTerminalSnapshot | undefined;
  try {
    terminal = dependencies.readTerminal(
      runtimeCandidate.roomName,
      runtimeCandidate.resourceType,
    );
  } catch {
    return rejectIncomplete(
      "direct_terminal_read_failed",
      runtimeCandidate,
      own,
    );
  }
  if (
    !terminalSafeForCandidate(
      terminal,
      runtimeCandidate,
      input.config.terminalEnergyReserve,
    )
  ) {
    return rejectIncomplete("direct_terminal_unsafe", runtimeCandidate, own);
  }

  let first: DirectPricingResult;
  try {
    first = rankCurrentBook(
      dependencies,
      runtimeCandidate,
      terminal!,
      input.config.terminalEnergyReserve,
      ownOrders,
    );
  } catch {
    return rejectIncomplete(
      "direct_buy_book_read_failed",
      runtimeCandidate,
      own,
    );
  }
  const firstBook = summarizeBook(first);
  if (!first.safe || first.cycleRejection) {
    return rejectIncomplete(
      `direct_pricing:${first.cycleRejection?.reason || "unknown"}`,
      runtimeCandidate,
      own,
      firstBook,
    );
  }

  let second: DirectPricingResult;
  try {
    second = rankCurrentBook(
      dependencies,
      runtimeCandidate,
      terminal!,
      input.config.terminalEnergyReserve,
      ownOrders,
    );
  } catch {
    return rejectIncomplete(
      "direct_prewrite_buy_book_read_failed",
      runtimeCandidate,
      own,
      firstBook,
    );
  }
  if (
    !second.safe ||
    !exactOpportunityUnchanged(first.selected, second.selected)
  ) {
    return rejectIncomplete(
      "direct_highest_safe_order_changed",
      runtimeCandidate,
      own,
      summarizeBook(second),
    );
  }
  const opportunity = second.selected
    ? toOpportunity(second.selected)
    : undefined;
  result.opportunity = opportunity;

  if (
    input.config.mode === "direct" &&
    opportunity &&
    !isDirectActivationQualified(state.shadowQualification, {
      configRevision: input.config.configRevision,
      safetyFingerprint: fingerprint,
      canary: runtimeCandidate,
    })
  ) {
    return rejectIncomplete(
      "direct_shadow_qualification_incomplete",
      runtimeCandidate,
      own,
      summarizeBook(second),
    );
  }
  let productionMarketIntent = true;
  try {
    productionMarketIntent =
      dependencies.hasProductionMarketIntent();
  } catch {
    productionMarketIntent = true;
  }
  if (productionMarketIntent) {
    if (input.config.mode === "shadow") {
      return rejectIncomplete(
        "direct_shadow_production_market_intent",
        runtimeCandidate,
        own,
        summarizeBook(second),
      );
    }
    result.actions.push("direct:production_priority_wait");
    projectSnapshot(
      state,
      input,
      result,
      runtimeCandidate,
      "production_priority_wait",
      summarizeBook(second),
      own,
      opportunity,
    );
    return result;
  }

  let terminalOrMarketClaim = true;
  try {
    terminalOrMarketClaim =
      dependencies.hasTerminalOrMarketClaim(runtimeCandidate.roomName);
  } catch {
    terminalOrMarketClaim = true;
  }
  if (terminalOrMarketClaim) {
    if (input.config.mode === "shadow") {
      return rejectIncomplete(
        "direct_shadow_action_claim_present",
        runtimeCandidate,
        own,
        summarizeBook(second),
      );
    }
    result.actions.push("direct:production_priority_wait");
    projectSnapshot(
      state,
      input,
      result,
      runtimeCandidate,
      "production_priority_wait",
      summarizeBook(second),
      own,
      opportunity,
    );
    return result;
  }

  let finalOwnOrders: MarketOrderSnapshot[];
  try {
    finalOwnOrders = dependencies.readOwnOrders();
  } catch {
    return rejectIncomplete(
      "direct_prewrite_own_orders_read_failed",
      runtimeCandidate,
      own,
      summarizeBook(second),
    );
  }
  const finalOwn = ownOrderSummary(finalOwnOrders);
  if (
    finalOwn.manualBuyOrderCount > 0 ||
    finalOwn.manualSellOrderCount > 0
  ) {
    return rejectIncomplete(
      finalOwn.manualSellOrderCount > 0
        ? "manual_sell_order_present"
        : "manual_buy_order_present",
      runtimeCandidate,
      finalOwn,
      summarizeBook(second),
    );
  }

  if (opportunity) {
    let exactOrder: MarketOrderSnapshot | undefined;
    try {
      exactOrder = dependencies.getOrderById(opportunity.orderId);
    } catch {
      return rejectIncomplete(
        "direct_exact_order_read_failed",
        runtimeCandidate,
        finalOwn,
        summarizeBook(second),
      );
    }
    if (
      !exactOrder ||
      exactOrder.type !== ORDER_BUY ||
      exactOrder.resourceType !== runtimeCandidate.resourceType ||
      exactOrder.roomName !== opportunity.orderRoomName ||
      exactOrder.price !== opportunity.price ||
      exactOrder.amount !== opportunity.orderAmount
    ) {
      return rejectIncomplete(
        "direct_exact_order_changed",
        runtimeCandidate,
        finalOwn,
        summarizeBook(second),
      );
    }
  }

  let finalTerminal: DirectTerminalSnapshot | undefined;
  try {
    finalTerminal = dependencies.readTerminal(
      runtimeCandidate.roomName,
      runtimeCandidate.resourceType,
    );
  } catch {
    return rejectIncomplete(
      "direct_final_terminal_read_failed",
      runtimeCandidate,
      finalOwn,
      summarizeBook(second),
    );
  }
  if (
    !terminalSafeForCandidate(
      finalTerminal,
      runtimeCandidate,
      input.config.terminalEnergyReserve,
      opportunity?.transactionEnergy || 0,
    )
  ) {
    return rejectIncomplete(
      "direct_terminal_changed",
      runtimeCandidate,
      finalOwn,
      summarizeBook(second),
    );
  }

  result.planComplete = true;
  if (input.config.mode === "shadow") {
    advanceDirectShadowQualification(state.shadowQualification, {
      tick: input.tick,
      configRevision: input.config.configRevision,
      safetyFingerprint: fingerprint,
      canary: runtimeCandidate,
      complete: true,
    });
    const planningResult = opportunity
      ? "safe_opportunity"
      : "safe_no_opportunity";
    if (!opportunity) {
      result.actions.push("direct:safe_no_opportunity");
    }
    projectSnapshot(
      state,
      input,
      result,
      runtimeCandidate,
      planningResult,
      summarizeBook(second),
      finalOwn,
      opportunity,
    );
    return result;
  }

  if (!opportunity) {
    result.actions.push("direct:safe_no_opportunity");
    projectSnapshot(
      state,
      input,
      result,
      runtimeCandidate,
      "safe_no_opportunity",
      summarizeBook(second),
      finalOwn,
    );
    return result;
  }
  const rejectActiveWrite = (reason: string): DirectAutomationResult => {
    reject(result, reason);
    projectSnapshot(
      state,
      input,
      result,
      runtimeCandidate,
      "incomplete",
      summarizeBook(second),
      finalOwn,
      opportunity,
    );
    return result;
  };

  let credits: number | undefined;
  let outgoingBefore: DirectOutgoingWindow | undefined;
  try {
    credits = dependencies.readCredits();
    outgoingBefore = dependencies.readOutgoingWindow(input.tick);
  } catch {
    credits = undefined;
    outgoingBefore = undefined;
  }
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    !outgoingBefore ||
    outgoingBefore.observedAt !== input.tick ||
    !outgoingBefore.coversAttemptAt
  ) {
    return rejectActiveWrite("direct_wal_baseline_unavailable");
  }

  const requestId = `direct:${input.tick}:${runtimeCandidate.roomName}:${runtimeCandidate.resourceType}`;
  const pending = prepareDirectPending(state, {
    requestId,
    configRevision: input.config.configRevision,
    directSafetyFingerprint: fingerprint,
    canaryRoomName: runtimeCandidate.roomName,
    resource: runtimeCandidate.resourceType,
    orderId: opportunity.orderId,
    orderRoomName: opportunity.orderRoomName,
    observedOrderPrice: opportunity.price,
    observedOrderAmount: opportunity.orderAmount,
    dealAmount: opportunity.dealAmount,
    transactionEnergy: opportunity.transactionEnergy,
    effectiveEnergyShadowPrice:
      runtimeCandidate.effectiveEnergyShadowPrice!,
    energyShadowComponents: runtimeCandidate.energyShadowComponents!,
    energyShadowObservedAt: runtimeCandidate.energyShadowObservedAt!,
    netCreditsMilli: opportunity.netCreditsMilli,
    worstCaseNetCreditsMilli: opportunity.worstCaseNetCreditsMilli,
    effectiveNetFloor: runtimeCandidate.effectiveNetFloor,
    protectionRevision: runtimeCandidate.protectionRevision,
    physicalBefore: {
      terminalResource: finalTerminal!.resourceStock,
      terminalEnergy: finalTerminal!.energy,
      terminalCooldown: finalTerminal!.cooldown,
      credits,
    },
    preparedAt: input.tick,
    attemptAt: input.tick,
    outgoingWindowBefore: outgoingBefore,
  });
  if (!pending) {
    return rejectActiveWrite("direct_pending_prepare_failed");
  }

  const claimRequest = {
    requestId,
    roomName: runtimeCandidate.roomName,
    actor: DIRECT_ACTOR,
    attemptAt: input.tick,
  };
  let claimed = false;
  try {
    claimed = dependencies.claimPrepared(claimRequest);
  } catch {
    claimed = false;
  }
  if (!claimed) {
    markDirectSubmissionResult(state, requestId, {
      kind: "non_ok",
      tick: input.tick,
      resultCode: ERR_BUSY,
    });
    dependencies.releasePrepared(requestId);
    return rejectActiveWrite("direct_arbiter_claim_failed");
  }

  try {
    const code = dependencies.executePrepared({
      ...claimRequest,
      orderId: opportunity.orderId,
      amount: opportunity.dealAmount,
    });
    result.writes += 1;
    if (code === OK) {
      markDirectSubmissionResult(state, requestId, {
        kind: "ok",
        tick: input.tick,
        resultCode: OK,
      });
      result.actions.push(
        `direct-submitted:${runtimeCandidate.roomName}:${runtimeCandidate.resourceType}:${opportunity.dealAmount}:${opportunity.orderId}`,
      );
    } else if (isExplicitMarketNonOkReturnCode(code)) {
      markDirectSubmissionResult(state, requestId, {
        kind: "non_ok",
        tick: input.tick,
        resultCode: code,
      });
      dependencies.releasePrepared(requestId);
      reject(result, `direct_deal_non_ok:${code}`);
    } else {
      markDirectSubmissionResult(state, requestId, {
        kind: "unknown",
        tick: input.tick,
        resultCode:
          typeof code === "number" && Number.isSafeInteger(code)
            ? code
            : undefined,
      });
      reject(result, "direct_deal_result_unknown");
    }
  } catch {
    result.writes += 1;
    markDirectSubmissionResult(state, requestId, {
      kind: "threw",
      tick: input.tick,
    });
    reject(result, "direct_deal_threw");
  }
  projectSnapshot(
    state,
    input,
    result,
    runtimeCandidate,
    "safe_opportunity",
    summarizeBook(second),
    own,
    opportunity,
  );
  return result;
}

export function directAutomationSnapshotStatus(
  state: DirectAutomationState,
  tick: number,
): ReturnType<
  typeof getDirectPlanningSnapshotStatus<DirectOpportunitySummary>
> {
  return getDirectPlanningSnapshotStatus(
    state.lastPlanningSnapshot,
    tick,
    10,
  );
}

export function resolveDirectAutomationPending(
  state: DirectAutomationState,
  evidence: OperatorDirectPendingEvidence,
  tick: number,
  dependencies: DirectAutomationDependencies = defaultDirectAutomationDependencies,
): ReturnType<typeof resolveDirectPendingWithEvidence> {
  return resolveDirectPendingWithEvidence(
    state,
    evidence,
    tick,
    pendingDependencies(dependencies),
  );
}

export function directAutomationExposure(
  state: DirectAutomationState,
): ReturnType<typeof summarizeDirectPendingExposure> {
  return summarizeDirectPendingExposure(state);
}

function convertOrder(order: Order): MarketOrderSnapshot {
  if (
    !order ||
    typeof order !== "object" ||
    typeof order.id !== "string" ||
    order.id.length === 0 ||
    (order.type !== ORDER_BUY && order.type !== ORDER_SELL) ||
    typeof order.resourceType !== "string" ||
    !RESOURCES_ALL.includes(order.resourceType as ResourceConstant) ||
    !Number.isFinite(order.price) ||
    order.price <= 0 ||
    !Number.isSafeInteger(order.amount) ||
    order.amount < 0 ||
    (order.remainingAmount !== undefined &&
      (!Number.isSafeInteger(order.remainingAmount) ||
        order.remainingAmount < 0)) ||
    (order.roomName !== undefined &&
      (typeof order.roomName !== "string" ||
        !/^[WE]\d+[NS]\d+$/.test(order.roomName)))
  ) {
    throw new TypeError("invalid market order snapshot");
  }
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

function convertTransaction(
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
): DirectOutgoingWindow | undefined {
  const transactions = Game.market?.outgoingTransactions;
  if (!Array.isArray(transactions)) return undefined;
  const converted = transactions.map(convertTransaction);
  const times = converted.map((transaction) => transaction.time);
  const oldestTime = times.length > 0 ? Math.min(...times) : undefined;
  const newestTime = times.length > 0 ? Math.max(...times) : undefined;
  return {
    transactions: converted,
    observedAt: Game.time,
    oldestTime,
    newestTime,
    coversAttemptAt:
      converted.length < MAX_OUTGOING_TRANSACTIONS ||
      (oldestTime !== undefined && oldestTime < attemptAt),
  };
}

export const defaultDirectAutomationDependencies: DirectAutomationDependencies = {
  readCurrentBuyOrders: (resource) => {
    const orders = Game.market.getAllOrders({
      type: ORDER_BUY,
      resourceType: resource,
    });
    if (!Array.isArray(orders)) {
      throw new TypeError("current BUY book is not an array");
    }
    return orders.map(convertOrder);
  },
  readOwnOrders: () => {
    const orders = Game.market?.orders;
    if (!orders || typeof orders !== "object" || Array.isArray(orders)) {
      throw new TypeError("own market orders are unavailable");
    }
    return Object.values(orders).map(convertOrder);
  },
  getOrderById: (orderId) => {
    if (typeof Game.market.getOrderById !== "function") return undefined;
    const order = Game.market.getOrderById(orderId);
    return order ? convertOrder(order) : undefined;
  },
  readTerminal: (roomName, resource) => {
    const terminal = Game.rooms?.[roomName]?.terminal;
    if (!terminal) return undefined;
    const resourceStock = terminal.store.getUsedCapacity(resource);
    const energy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
    if (
      !Number.isSafeInteger(resourceStock) ||
      !Number.isSafeInteger(energy) ||
      !Number.isSafeInteger(terminal.cooldown)
    ) {
      return undefined;
    }
    return {
      roomName,
      resourceStock,
      energy,
      cooldown: terminal.cooldown,
    };
  },
  readCredits: () =>
    typeof Game.market?.credits === "number" &&
    Number.isFinite(Game.market.credits)
      ? Game.market.credits
      : undefined,
  readOutgoingWindow: defaultOutgoingWindow,
  calculateTransactionEnergy: (amount, fromRoomName, toRoomName) =>
    Game.market.calcTransactionCost(
      amount,
      fromRoomName,
      toRoomName,
    ),
  claimPrepared: claimPreparedDirectMarketClaims,
  executePrepared: executePreparedDirectMarketDeal,
  releasePrepared: (requestId) => {
    releasePreparedDirectMarketClaims(requestId);
  },
  hasProductionMarketIntent: hasMarketActionIntentThisTick,
  hasTerminalOrMarketClaim: (roomName) =>
    hasTerminalActionClaim(roomName) || hasMarketAccountClaim(),
};
