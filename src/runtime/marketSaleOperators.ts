import { AUTHORITY_EXECUTOR_SHARD } from "@/config/deployment";
import {
  enforceLegacyMarketSafetyLatch,
  MARKET_DIRECT_CANARY_POLICY,
  marketBaseResourceV3ConfigMismatchReasons,
  resolveMarketSaleAutomationConfig,
  type MarketSaleAutomationConfig,
  type ResolvedMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  acceptMarketDirectContinuousPermit as acceptContinuousPermitState,
  defaultMarketDirectContinuousDependencies,
  marketDirectContinuousStatus as projectContinuousDirectStatus,
  proposeMarketDirectContinuousPermit as proposeContinuousPermitState,
  type MarketDirectContinuousAutomationState,
  type MarketDirectContinuousPermitRequest,
} from "@/runtime/marketDirectContinuousAutomation";
import {
  canonicalStableHashV1,
  validateMarketDirectContinuousPermitChain,
} from "@/runtime/marketDirectContinuousPolicy";
import {
  buildMarketBaseResourcePricingRatchetState,
  collectLiveMarketBaseRoomObservations,
  marketBaseResourceActivationAnchorSelfHash,
  marketBaseResourceOperatorAuthorizationFingerprint,
  marketBaseResourceOuterScopeCommitment,
  readLiveMarketBaseAccountIdentity,
  reconcileLiveMarketBaseResourceScope,
  reconcileMarketBaseResourcePreflight,
  readLiveMarketBaseTerminal,
  validateMarketBaseResourceReadinessRuntimeCapability,
  validateMarketBaseResourcePricingRatchetState,
  type MarketBaseResourcePermitProposal,
  type MarketBaseResourcePricingRatchetState,
  type MarketBaseResourceReadinessRuntimeCapability,
  type MarketBaseResourceScopeState,
  type MarketBaseResourceV3RuntimeState,
} from "@/runtime/marketBaseResourceAutomation";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  MARKET_BASE_RESOURCE_POLICIES,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  createMarketBaseSharedPolicy,
  isMarketBaseResource,
  marketBaseEnforcedDynamicFloors,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
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
  type MarketBaseResourceLedgerRuntimeAnchor,
  type MarketBaseResourceLedgerCounters,
  type MarketBaseResourceQuotaReceipt,
} from "@/runtime/marketBaseResourceLedger";
import { validateContinuousLedger } from "@/runtime/marketDirectContinuousLedger";
import {
  getMarketProtectionSellableAmount,
  isMarketProtectionEntryFresh,
  getMarketProtectionEntryKey,
} from "@/runtime/marketSaleProtection";
import { collectLiveMarketSaleProtectionLedger } from "@/runtime/marketSaleProtectionAdapter";
import {
  MARKET_BASE_RESOURCE_ACTIVATION_ANCHOR_REVISION,
  isPlainRecord,
  MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION,
  boundedPush,
  rememberVerifiedMarketSaleDataRoot,
  ensureDataState,
  isContinuousDirectState,
} from "@/runtime/marketSaleDataState";
import type {
  MarketBaseResourceActivationAnchor,
  MarketBaseResourceRoomIncarnationHighWater,
  MarketBaseResourceLaneLifecycleHighWater,
  MarketBaseResourcePricingHighWater,
  MarketSaleDataState,
  MarketBaseResourceTrustedFloorHighWater,
  MarketBaseResourceActivationBlocker,
  MarketBaseResourceProposedTransition,
  MarketBaseResourceContinuousReviewSnapshot,
  MarketBaseResourcePermitRequest,
  MarketBaseResourceProposedContinuousReview,
} from "@/runtime/marketSaleDataState";
export {
  MAX_FEE_EVENTS,
  MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION,
  boundedPush,
  isPlainRecord,
  isContinuousDirectState,
  marketBaseResourceCanonicalRootProvenance,
  marketDataStateDeepRecoveries,
  ensureDataState,
} from "@/runtime/marketSaleDataState";
export type {
  ExpansionGrant,
  DirectLegacyExposureDrainState,
  MarketBaseResourceActivationAnchor,
  MarketBaseResourceActivationBlocker,
  OwnedManagedOrder,
  OwnedPendingCreate,
  OwnedCanaryLock,
  MarketSaleDataState,
  MarketBaseResourcePermitRequest,
  MarketBaseResourceContinuousReviewSnapshot,
} from "@/runtime/marketSaleDataState";


const MAX_AUDIT_ENTRIES = 50;

export const MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES = [
  ...MARKET_BASE_RESOURCE_CATALOG,
  RESOURCE_ENERGY,
].sort((left, right) => left.localeCompare(right)) as readonly (
  MarketBaseResource | typeof RESOURCE_ENERGY
)[];

export type MarketBaseResourceActivationAnchorPayload = Omit<
  MarketBaseResourceActivationAnchor,
  "anchorHash"
>;

export function marketBaseResourceActivationAnchorHash(
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

export function marketBaseResourceTrustedFloorHighWater(
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

export function synchronizeMarketBaseTrustedFloors(
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

export function marketBaseResourceActivationPendingHighWaterValid(
  pendingAttemptSeq: number | null,
  finalizedAttemptSeq: number,
  nextAttemptSeq: number,
): boolean {
  return pendingAttemptSeq === null || (
    Number.isSafeInteger(pendingAttemptSeq) &&
    pendingAttemptSeq >= finalizedAttemptSeq &&
    pendingAttemptSeq < nextAttemptSeq
  );
}

export function validateMarketBaseResourceActivationAnchor(
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
    anchor.executorShard !== AUTHORITY_EXECUTOR_SHARD ||
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
    // receipt_written / processed_key_written 仍保留 pending，且 receipt
    // 已把 finalizedAttemptSeq 推进到该 attempt。真正的倒退是严格小于。
    !marketBaseResourceActivationPendingHighWaterValid(
      anchor.ledger.pendingAttemptSeq,
      anchor.ledger.finalizedAttemptSeq,
      anchor.ledger.nextAttemptSeq,
    ) ||
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

export function validateMarketBaseResourceActivationAnchorMirror(
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

export function sameMarketBaseResourceActivationAnchor(
  left: MarketBaseResourceActivationAnchor,
  right: MarketBaseResourceActivationAnchor,
): boolean {
  // 两侧都必须先通过 self-hash validator；相同 anchorHash 已经承诺全部
  // payload，没必要再把两份大 anchor 各遍历一次。
  return left.anchorHash === right.anchorHash;
}

const marketBaseOuterDeepFrozenValues = new WeakSet<object>();

export function freezeMarketBaseOuterCanonicalValue<T>(value: T): T {
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

export function validateMarketBaseResourceActivationBlocker(
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

export function marketBaseNestedCutoverEvidence(
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

export function marketBaseResourceActivationState(
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

function marketBaseStableLifecycleReason(
  lane: MarketBaseDerivedLaneLifecycle,
): string | undefined {
  const reason = validateMarketBaseDerivedLaneLifecycle(lane);
  return reason
    ? `market_base_lifecycle_evidence_invalid:${lane.laneId}:${reason}`
    : undefined;
}

export function marketBaseStableScopeProjection(
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

export function validateMarketBaseScopeLifecycleEvidence(
  scope: MarketBaseResourceScopeState,
): string | undefined {
  for (const lane of scope.laneLifecycles) {
    const reason = marketBaseStableLifecycleReason(lane);
    if (reason) return reason;
  }
  return undefined;
}

export function validateMarketBaseNestedActivationState(
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

export type OperatorResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; [key: string]: unknown };

interface BuiltMarketBaseV3SuccessorProposal {
  proposal: MarketBaseResourcePermitProposal;
  transition: Omit<MarketBaseResourceProposedTransition, "proposalId">;
  continuousReviews: readonly MarketBaseResourceContinuousReviewSnapshot[];
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

export function hasExactRecordKeys(
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

export function appendAudit(
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

export function usesDirectStrategy(config: MarketSaleAutomationConfig): boolean {
  return (
    config.mode === "direct" ||
    (config.mode === "shadow" && config.shadowStrategy === "direct")
  );
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

export function commitMarketSaleDataSnapshot(data: MarketSaleDataState): void {
  Memory.data!.marketSaleAutomation = data as unknown as NonNullable<
    NonNullable<Memory["data"]>["marketSaleAutomation"]
  >;
  // commit 的输入是已验证状态的受控变换，原子落盘即验证点：标记仅供
  // 同 tick 引用短路复用，跨 tick 一律重新深恢复。
  rememberVerifiedMarketSaleDataRoot(data);
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

export function cloneMarketBaseOperatorValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function marketBaseResourceV3ConfigBlocker(
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

export function marketBaseOperatorExposureBlocker(
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
    data.feeLedger?.invalid ||
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

export function marketBaseLegacyV2QuiescenceCommitment(
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
      pendingProjectionCount: Object.keys(direct.pendingDirectDeals ?? {}).length,
      quarantinedProjectionCount: Object.keys(
        direct.quarantinedPendingDirectDeals,
      ).length,
    },
  });
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
    Object.keys(direct.pendingDirectDeals ?? {}).length > 0 ||
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

export function inertMarketBaseProposal(
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
  if ((Game.shard?.name || "") !== AUTHORITY_EXECUTOR_SHARD) {
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
    currentShard: AUTHORITY_EXECUTOR_SHARD,
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
    executorShard: AUTHORITY_EXECUTOR_SHARD,
    rosterFingerprint: targetScope.rosterFingerprint,
    laneSetFingerprint: targetScope.laneSetFingerprint,
    targetScope,
    targetPermitChain: permitChain,
    targetLedger: ledger,
    targetPricingRatchet: migratedRatchet.pricingRatchet,
    targetTrustedFloors: migratedRatchet.trustedFloors,
  });
}

export function currentMarketBaseV3Permit(
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
    effectiveNetFloor: snapshot.effectiveNetFloor,
    confirmedCanary: snapshot.confirmedCanary,
    permit: snapshot.permit,
    ledger: snapshot.ledger,
    terminal: {
      terminalId: snapshot.terminal.terminalId,
      resourceAmount: snapshot.terminal.resourceAmount,
      freeCapacity: snapshot.terminal.freeCapacity,
      storageResourceAmount: snapshot.terminal.storageResourceAmount,
      stagingShortfall: snapshot.terminal.stagingShortfall,
      energy: snapshot.terminal.energy,
      minimumReviewEnergyReserve:
        snapshot.terminal.minimumReviewEnergyReserve,
    },
    protection: {
      entryCommitment: snapshot.protection.entryCommitment,
      sellableAmount: snapshot.protection.sellableAmount,
      totalSellableAmount: snapshot.protection.totalSellableAmount,
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
    snapshot.hashRevision !== "market-base-resource-continuous-review-v2" ||
    typeof snapshot.laneId !== "string" ||
    snapshot.laneId.length === 0 ||
    snapshot.laneId.length > 256 ||
    !isMarketBaseResource(snapshot.resource) ||
    !Number.isFinite(snapshot.effectiveNetFloor) ||
    snapshot.effectiveNetFloor <= 0 ||
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
    !Number.isSafeInteger(snapshot.terminal.freeCapacity) ||
    snapshot.terminal.freeCapacity < 0 ||
    !Number.isSafeInteger(snapshot.terminal.storageResourceAmount) ||
    snapshot.terminal.storageResourceAmount < 0 ||
    !Number.isSafeInteger(snapshot.terminal.stagingShortfall) ||
    snapshot.terminal.stagingShortfall < 0 ||
    !Number.isSafeInteger(snapshot.terminal.minimumReviewEnergyReserve) ||
    snapshot.terminal.minimumReviewEnergyReserve < 25_000 ||
    !Number.isSafeInteger(snapshot.protection.totalSellableAmount) ||
    snapshot.protection.totalSellableAmount < 0 ||
    !marketBaseContinuousReviewCargoReady({
      terminalBackedSellable: snapshot.protection.sellableAmount,
      totalSellable: snapshot.protection.totalSellableAmount,
      terminalFreeCapacity: snapshot.terminal.freeCapacity,
      storageResourceAmount: snapshot.terminal.storageResourceAmount,
    }).ready ||
    snapshot.terminal.stagingShortfall !==
      marketBaseContinuousReviewCargoReady({
        terminalBackedSellable: snapshot.protection.sellableAmount,
        totalSellable: snapshot.protection.totalSellableAmount,
        terminalFreeCapacity: snapshot.terminal.freeCapacity,
        storageResourceAmount: snapshot.terminal.storageResourceAmount,
      }).stagingShortfall ||
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

export function marketBaseContinuousReviewCargoReady(input: {
  terminalBackedSellable: number;
  totalSellable: number;
  terminalFreeCapacity: number;
  storageResourceAmount: number;
}): { ready: boolean; stagingShortfall: number } {
  const required = 1_000;
  const values = Object.values(input);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { ready: false, stagingShortfall: required };
  }
  const stagingShortfall = Math.max(
    0,
    required - input.terminalBackedSellable,
  );
  return {
    ready:
      input.totalSellable >= required &&
      input.terminalFreeCapacity >= stagingShortfall &&
      input.storageResourceAmount >= stagingShortfall,
    stagingShortfall,
  };
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
  const dynamicFloor = marketBaseEnforcedDynamicFloors(
    state.dynamicFloorProjection,
  )[lane.resource];
  const effectiveFloor = Math.max(
    policy?.hardFloor ?? Infinity,
    policy?.economicFloor ?? Infinity,
    dynamicFloor ?? ratchet?.value ?? Infinity,
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
    terminal.cooldown !== 0 ||
    terminal.energy < policy.terminalEnergyReserve + policy.maxTransactionEnergy
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
  const liveRoom = Game.rooms[lane.sellerRoomName];
  const physicalTerminal = liveRoom?.terminal;
  const terminalFreeCapacity = physicalTerminal?.store.getFreeCapacity() ?? -1;
  const storageResourceAmount =
    liveRoom?.storage?.store.getUsedCapacity(lane.resource) ?? 0;
  const terminalBackedSellable = protection
    ? getMarketProtectionSellableAmount(protection, tick)
    : 0;
  const totalSellable = protection
    ? getMarketProtectionSellableAmount(protection, tick, {
        requireTerminalBacking: false,
      })
    : 0;
  const cargoReady = marketBaseContinuousReviewCargoReady({
    terminalBackedSellable,
    totalSellable,
    terminalFreeCapacity,
    storageResourceAmount,
  });
  if (
    protectionLedger.globalBlocked ||
    !protection ||
    !isMarketProtectionEntryFresh(protection, tick) ||
    physicalTerminal?.id !== terminal.terminalId ||
    !cargoReady.ready
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
    hashRevision: "market-base-resource-continuous-review-v2",
    laneId,
    resource: lane.resource,
    sellerRoom: lane.sellerRoomName,
    effectiveNetFloor: effectiveFloor,
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
      freeCapacity: terminalFreeCapacity,
      storageResourceAmount,
      stagingShortfall: cargoReady.stagingShortfall,
      energy: terminal.energy,
      // 这是复核的策略最低储备；continuous 授权后正式 deal 仍重新读取
      // ResourceControl 对生产与发送承诺的完整有效储备。
      minimumReviewEnergyReserve: policy.terminalEnergyReserve,
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
      sellableAmount: terminalBackedSellable,
      totalSellableAmount: totalSellable,
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

/**
 * 没有任何 V3 attempt 的 canary 只有在原保护账本确认整房已无一笔可售
 * 余量时才可主动暂停。这里读取 storage+terminal 的保护后总量，避免
 * terminal 暂时没备货就假装无库存；事实缺失一律不放行。
 */
function canSuspendUnattemptedMarketBaseCanaryForNoSurplus(
  data: MarketSaleDataState,
  config: ResolvedMarketSaleAutomationConfig,
  lane: MarketBaseDerivedLaneLifecycle,
  tick: number,
): boolean {
  const policy = MARKET_BASE_RESOURCE_POLICIES.find(
    (candidate) => candidate.resource === lane.resource,
  );
  if (!policy) return false;
  const key = getMarketProtectionEntryKey(lane.sellerRoomName, lane.resource);
  let protectionLedger: ReturnType<typeof collectLiveMarketSaleProtectionLedger>;
  try {
    protectionLedger = collectLiveMarketSaleProtectionLedger(
      config,
      Object.values(data.managedOrders),
      {
        candidates: [{ roomName: lane.sellerRoomName, resource: lane.resource }],
        laneReserveByEntry: { [key]: policy.laneReserve },
      },
    );
  } catch {
    return false;
  }
  const entry = protectionLedger.entries[key];
  return !protectionLedger.globalBlocked &&
    !!entry && !entry.blocked &&
    isMarketProtectionEntryFresh(entry, tick) &&
    getMarketProtectionSellableAmount(entry, tick, {
      requireTerminalBacking: false,
    }) < policy.minOrderAmount;
}

/** 买盘最高毛价也低于签名经济下界时，手续费只会让净价更低。 */
function canSuspendUnattemptedMarketBaseCanaryForNoBid(
  lane: MarketBaseDerivedLaneLifecycle,
): boolean {
  const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[lane.resource];
  if (!policy || !Game.market?.getAllOrders) return false;
  try {
    const orders = Game.market.getAllOrders({
      type: ORDER_BUY,
      resourceType: lane.resource as MarketResourceConstant,
    });
    return Array.isArray(orders) &&
      orders.length <= policy.maxRawOrdersScanned &&
      orders.every((order) =>
        order &&
        order.type === ORDER_BUY &&
        order.resourceType === lane.resource &&
        typeof order.price === "number" &&
        Number.isFinite(order.price) &&
        order.price >= 0 &&
        order.price < Math.max(policy.hardFloor, policy.economicFloor),
      );
  } catch {
    return false;
  }
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
    (targetStage !== "canary" && targetStage !== "continuous" && targetStage !== "suspend")
  ) {
    throw new TypeError("market_base_successor_exact_lane_transition_required");
  }
  const accountIdentity = readLiveMarketBaseAccountIdentity();
  if (
    !accountIdentity ||
    accountIdentity !== currentMarketBaseV3Permit(state)?.accountIdentity ||
    (Game.shard?.name || "") !== AUTHORITY_EXECUTOR_SHARD
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
  const unattemptedCanarySuspension =
    targetStage === "suspend" &&
    priorTargetGrant?.stage === "canary" &&
    priorTargetGrant.newDealGrant === "enabled" &&
    !marketBaseResourceCanaryReviewFactsFor(
      ledger,
      laneId,
      permitChain,
    );
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
  if (unattemptedCanarySuspension) {
    const beforeCanary = retainedV3Permits[retainedV3Permits.length - 2];
    const beforeTarget = beforeCanary?.signedLaneGrants.find(
      (grant) => grant.laneId === laneId,
    );
    if (
      beforeTarget?.status === "active" &&
      beforeTarget.newDealGrant === "suspended" &&
      beforeTarget.stage === "qualified"
    ) {
      for (const currentGrant of priorPermit.signedLaneGrants) {
        const beforeGrant = beforeCanary.signedLaneGrants.find(
          (grant) => grant.laneId === currentGrant.laneId,
        );
        const currentLane = currentScope.laneLifecycles.find(
          (candidate) => candidate.laneId === currentGrant.laneId,
        );
        if (
          currentGrant.laneId !== laneId &&
          currentGrant.resource === targetLane.resource &&
          currentGrant.status === "active" &&
          currentGrant.stage === "continuous" &&
          currentGrant.newDealGrant === "suspended" &&
          beforeGrant?.status === "active" &&
          beforeGrant.stage === "continuous" &&
          beforeGrant.newDealGrant === "enabled" &&
          sameMarketBaseGrantExceptDealGrant(beforeGrant, currentGrant) &&
          currentLane?.stage === "continuous" &&
          currentLane.status === "suspended" &&
          currentLane.stableFingerprint === currentGrant.laneStableFingerprint
        ) {
          recoverableInterruptedContinuousLaneIds.add(currentGrant.laneId);
        }
      }
    }
  }
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
    unattemptedCanarySuspension &&
    !canSuspendUnattemptedMarketBaseCanaryForNoSurplus(
      data,
      config,
      targetLane,
      tick,
    ) &&
    !canSuspendUnattemptedMarketBaseCanaryForNoBid(targetLane)
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
      (targetStage === "continuous" || unattemptedCanarySuspension) &&
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
    currentShard: AUTHORITY_EXECUTOR_SHARD,
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
    executorShard: AUTHORITY_EXECUTOR_SHARD,
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
  if (
    proposal.schemaVersion !== 3 ||
    proposal.proposalId !==
      canonicalStableHashV1({
        domain: "market-base-resource:operator-proposal-v1",
        proposal: payload,
      })
  ) {
    return false;
  }
  if (proposal.migrationChainEncoding === "appended-permit-only-v1") {
    const records = proposal.targetPermitChain?.retainedPermits;
    return (
      proposal.kind === "v3-policy-migration" &&
      Array.isArray(records) &&
      records.length === 1 &&
      records[0]?.schemaVersion === 3 &&
      records[0].permitId === proposal.targetPermitChain.currentPermitId &&
      records[0].epoch === proposal.targetPermitChain.currentPermitEpoch
    );
  }
  return (
    proposal.migrationChainEncoding === undefined &&
    validateMarketBaseProposalPayload(proposal)
  );
}

function validateMarketBaseProposalPayload(
  proposal: MarketBaseResourcePermitProposal,
): boolean {
  return (
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

function materializeMarketBasePolicyMigrationProposal(
  proposal: MarketBaseResourcePermitProposal,
  state: MarketBaseResourceV3RuntimeState,
): MarketBaseResourcePermitProposal | undefined {
  if (
    proposal.kind !== "v3-policy-migration" ||
    proposal.migrationChainEncoding !== "appended-permit-only-v1" ||
    !state.permitChain ||
    !state.ledger
  ) {
    return undefined;
  }
  const permit = proposal.targetPermitChain.retainedPermits[0];
  if (!permit || permit.schemaVersion !== 3) {
    return undefined;
  }
  const ledger = state.ledger;
  const chain = state.permitChain;
  const appended = appendMarketBaseResourcePermit(chain, permit, {
    tick: proposal.proposedAt,
    currentShard: AUTHORITY_EXECUTOR_SHARD,
    currentLedgerHead: ledger.receiptHeadHash,
    currentLedgerCheckpointHash: ledger.checkpoint.checkpointHash,
    currentLedgerPermitAnchorHash: ledger.permitAnchor.anchorHash,
    currentDerivedLanes: proposal.targetScope.laneLifecycles,
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment(
        proposal.targetScope.laneLifecycles,
      ),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
    receiptPermitReferences:
      marketBaseResourceRetainedReceiptPermitReferences(ledger, chain),
  });
  if (appended.status !== "appended") {
    return undefined;
  }
  const compactChain = {
    ...appended.state,
    retainedPermits: [permit],
  };
  const reboundLedger = rebindMarketBaseResourceLedgerPermitAnchor(
    ledger,
    appended.state,
  );
  if (
    canonicalStableHashV1(compactChain) !==
      canonicalStableHashV1(proposal.targetPermitChain) ||
    canonicalStableHashV1(reboundLedger) !==
      canonicalStableHashV1(proposal.targetLedger)
  ) {
    return undefined;
  }
  return {
    ...proposal,
    targetPermitChain: appended.state,
  };
}

export function copyMarketSaleDataForOperator(
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

export function marketBasePolicyMigrationSourceFingerprint(
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
      const materializedProposal = proposal.migrationChainEncoding
        ? materializeMarketBasePolicyMigrationProposal(proposal, state)
        : proposal;
      if (
        !materializedProposal ||
        !validateMarketBaseProposalPayload(materializedProposal)
      ) {
        throw new TypeError("market_base_migration_delta_invalid");
      }
      const migrationNext: MarketBaseResourceV3RuntimeState = {
        ...state,
        scope: cloneMarketBaseOperatorValue(materializedProposal.targetScope),
        permitChain: cloneMarketBaseOperatorValue(
          materializedProposal.targetPermitChain,
        ),
        ledger: cloneMarketBaseOperatorValue(materializedProposal.targetLedger),
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
        proposal: materializedProposal,
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
          materializedProposal.targetPermitChain.retainedPermits[
            materializedProposal.targetPermitChain.retainedPermits.length - 1
          ].permitId,
        permitEpoch: materializedProposal.targetPermitChain.currentPermitEpoch,
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
      if (transition.targetStage === "suspend") {
        const lane = state.scope?.laneLifecycles.find(
          (candidate) => candidate.laneId === transition.laneId,
        );
        const currentGrant = currentMarketBaseV3Permit(state)?.signedLaneGrants.find(
          (candidate) => candidate.laneId === transition.laneId,
        );
        if (
          lane &&
          currentGrant?.stage === "canary" &&
          currentGrant.newDealGrant === "enabled" &&
          !marketBaseResourceCanaryReviewFactsFor(
            state.ledger!,
            lane.laneId,
            state.permitChain!,
          ) &&
          !canSuspendUnattemptedMarketBaseCanaryForNoSurplus(
            data,
            config,
            lane,
            Game.time,
          ) &&
          !canSuspendUnattemptedMarketBaseCanaryForNoBid(lane)
        ) {
          throw new TypeError(
            "market_base_canary_suspension_requires_terminal_attempt",
          );
        }
      }
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
    const committedPermitChain = nextState.permitChain;
    if (!committedPermitChain) throw new TypeError("market_base_permit_chain_missing");
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
      permitId: committedPermitChain.currentPermitId,
      permitEpoch: committedPermitChain.currentPermitEpoch,
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
