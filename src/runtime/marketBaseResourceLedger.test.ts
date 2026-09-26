import {
  createMarketBaseSharedPolicy,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  reconcileMarketBaseDerivedLanes,
  reconcileMarketBaseSellerRooms,
  type MarketBaseDerivedLaneLifecycle,
} from "@/runtime/marketBaseResourcePolicy";
import {
  appendMarketBaseResourcePermit,
  buildMarketBaseResourceBootstrapRatchetHighWater,
  buildMarketBaseResourceLegacyV2GrantSuspension,
  buildMarketBaseResourcePermit,
  buildMarketBaseResourcePermitRuntimeAnchor,
  buildMarketBaseResourceSignedLaneGrant,
  buildMarketBaseResourceV2EventCutoverCheckpoint,
  createMarketBaseResourcePermitRuntimeContext,
  createMarketBaseResourcePermitChainState,
  validateMarketBaseResourcePermitRuntimeGate,
  wrapAuthenticatedLegacyV2PermitRecord,
  type AppendMarketBaseResourcePermitInput,
  type MarketBaseResourcePermitChainState,
} from "@/runtime/marketBaseResourcePermit";
import {
  MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
  MARKET_BASE_RESOURCE_LANE_QUOTA_LIMIT,
  MARKET_BASE_RESOURCE_ROOM_QUOTA_LIMIT,
  MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
  advanceMarketBaseResourceWal,
  buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis,
  buildMarketBaseResourceHistoricalPermitRef,
  buildMarketBaseResourceLedgerRuntimeAnchor,
  createMarketBaseResourceLedgerRuntimeContext,
  createMarketBaseResourceLedger,
  computeMarketBaseResourceQuota,
  marketBaseResourceRetainedReceiptPermitReferences,
  prepareMarketBaseResourceAttempt,
  rebindMarketBaseResourceLedgerPermitAnchor,
  recordMarketBaseResourceOutcome,
  sealMarketBaseResourceOutcome,
  validateMarketBaseResourceLedger,
  validateMarketBaseResourceLedgerRuntimeGate,
  type MarketBaseResourceLedger,
  type MarketBaseResourceLedgerOperation,
  type MarketBaseResourceLedgerCounters,
  type MarketBaseResourceLegacyV2ConfirmedCanary,
  type MarketBaseResourceQuotaReceipt,
} from "@/runtime/marketBaseResourceLedger";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  buildMarketDirectContinuousPermit,
  canonicalStableHashV1,
} from "@/runtime/marketDirectContinuousPolicy";

const ACCOUNT = "forst";
const V2_HEAD = canonicalStableHashV1("ledger-test:v2-head");
const V2_CHECKPOINT = canonicalStableHashV1("ledger-test:v2-checkpoint");
const MIGRATION_TICK = 50_000;

function digest(label: string): string {
  return canonicalStableHashV1(`ledger-test:${label}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function lane(): MarketBaseDerivedLaneLifecycle {
  const shared = createMarketBaseSharedPolicy(ACCOUNT);
  const rooms = reconcileMarketBaseSellerRooms({
    tick: 1_000,
    admissionPolicy: shared.roomAdmissionPolicy,
    observations: [
      {
        roomName: "E6N59",
        visible: true,
        controllerMy: true,
        controllerOwner: ACCOUNT,
        terminalId: "terminal-e6n59",
        terminalOwned: true,
        roomClass: "normal",
      },
    ],
  });
  if ("blockers" in rooms) {
    throw new Error(rooms.blockers.join(","));
  }
  const lanes = reconcileMarketBaseDerivedLanes({
    sharedPolicyFingerprint: shared.fingerprint,
    sellerRooms: rooms.sellerRooms,
  });
  const fresh = lanes.lanes?.find((candidate) => candidate.resource === "X");
  if (!lanes.ok || !fresh) {
    throw new Error(lanes.blockers?.join(",") ?? "missing X lane");
  }
  return {
    ...fresh,
    stage: "qualified",
    status: "suspended",
    shadowEvidence: {
      completeCycles: 100,
      lastCompleteTick: 1_000,
      evidenceDigest: digest("shadow:E6N59:X"),
    },
  };
}

function legacyV2Permit() {
  return buildMarketDirectContinuousPermit({
    epoch: 1,
    accountIdentity: ACCOUNT,
    sharedDirectFingerprint: digest("v2-shared-direct"),
    entryGrants: MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => ({
      entryId: entry.entryId,
      stage:
        entry.entryId === "base-x-e6n59-v1"
          ? ("continuous" as const)
          : ("shadow" as const),
      newDealGrant:
        entry.entryId === "base-x-e6n59-v1"
          ? ("enabled" as const)
          : ("suspended" as const),
      resourceFingerprint: entry.resourceFingerprint,
      lifecycleEvidenceDigest: digest(`v2-lifecycle:${entry.entryId}`),
    })),
    reviewedEvidence: [],
    previousPermitId: "",
    previousPermitHead: digest("v2-genesis"),
    previousLedgerHead: V2_HEAD,
    createdAt: 1_000,
    operatorAuthorizationFingerprint: digest("v2-operator"),
  });
}

function appendPermitOrThrow(
  chain: MarketBaseResourcePermitChainState,
  permit: ReturnType<typeof buildMarketBaseResourcePermit>,
  currentLane: MarketBaseDerivedLaneLifecycle,
  overrides: Partial<AppendMarketBaseResourcePermitInput> = {},
): MarketBaseResourcePermitChainState {
  const result = appendMarketBaseResourcePermit(chain, permit, {
    tick: permit.createdAt,
    currentShard: "shard1",
    currentLedgerHead: permit.previousLedgerHead,
    currentV2LedgerCheckpointHash: V2_CHECKPOINT,
    currentV2AttemptSeqHighWater: 6,
    currentV2OutcomeSeqHighWater: 6,
    currentDerivedLanes: [currentLane],
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment([currentLane]),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
    ...overrides,
  });
  if (result.status !== "appended") {
    throw new Error(
      `${result.status}:${
        "reason" in result ? result.reason : "unexpected-idempotent"
      }`,
    );
  }
  return result.state;
}

function permitChains(): {
  readonly first: MarketBaseResourcePermitChainState;
  readonly canary: MarketBaseResourcePermitChainState;
  readonly currentLane: MarketBaseDerivedLaneLifecycle;
} {
  const currentLane = lane();
  let chain = createMarketBaseResourcePermitChainState({
    legacyV2PermitRecords: [
      wrapAuthenticatedLegacyV2PermitRecord({
        rawRecord: legacyV2Permit(),
        authenticated: true,
      }),
    ],
  });
  const shared = createMarketBaseSharedPolicy(ACCOUNT);
  const eventCutover = buildMarketBaseResourceV2EventCutoverCheckpoint({
    lastV2AttemptSeq: 6,
    lastV2OutcomeSeq: 6,
    v2ReceiptHeadHash: V2_HEAD,
    v2LedgerCheckpointHash: V2_CHECKPOINT,
  });
  const firstPermit = buildMarketBaseResourcePermit({
    epoch: 2,
    accountIdentity: ACCOUNT,
    sharedPolicy: shared,
    ratchetHighWater: buildMarketBaseResourceBootstrapRatchetHighWater(2_000),
    signedLaneGrants: [
      buildMarketBaseResourceSignedLaneGrant({
        lane: currentLane,
        stage: "shadow",
        newDealGrant: "suspended",
      }),
    ],
    previousPermitId: chain.currentPermitId,
    previousPermitHead: chain.permitChainHead,
    previousLedgerHead: V2_HEAD,
    v2EventCutoverCheckpoint: eventCutover,
    legacyV2GrantSuspension: buildMarketBaseResourceLegacyV2GrantSuspension({
      previousPermitId: chain.currentPermitId,
      previousPermitHead: chain.permitChainHead,
      cutoverCheckpointHash: eventCutover.checkpointHash,
    }),
    createdAt: 2_000,
    operatorAuthorizationFingerprint: digest("operator:first"),
  });
  chain = appendPermitOrThrow(chain, firstPermit, currentLane);
  const first = chain;
  const canaryGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: currentLane,
    stage: "canary",
    newDealGrant: "enabled",
  });
  const canaryPermit = buildMarketBaseResourcePermit({
    epoch: 3,
    accountIdentity: ACCOUNT,
    sharedPolicy: shared,
    ratchetHighWater: firstPermit.ratchetHighWater,
    signedLaneGrants: [canaryGrant],
    reviewedEvidence: [
      {
        laneId: currentLane.laneId,
        kind: "shadow_qualification",
        evidenceKey: digest("qualification:E6N59:X"),
        digest: canaryGrant.lifecycleEvidenceDigest,
      },
    ],
    previousPermitId: chain.currentPermitId,
    previousPermitHead: chain.permitChainHead,
    previousLedgerHead: V2_HEAD,
    createdAt: 2_001,
    operatorAuthorizationFingerprint: digest("operator:canary"),
  });
  chain = appendPermitOrThrow(chain, canaryPermit, currentLane);
  return { first, canary: chain, currentLane };
}


function replacementXLaneFromOwnedTerminalIncarnation(): {
  readonly lane: MarketBaseDerivedLaneLifecycle;
  readonly incarnation: number;
  readonly rosterFingerprint: string;
  readonly laneSetFingerprint: string;
} {
  const shared = createMarketBaseSharedPolicy(ACCOUNT);
  const observation = (terminalId: string) => [
    {
      roomName: "E6N59",
      visible: true,
      controllerMy: true,
      controllerOwner: ACCOUNT,
      terminalId,
      terminalOwned: true,
      roomClass: "normal" as const,
    },
  ];
  const initial = reconcileMarketBaseSellerRooms({
    tick: 1_000,
    admissionPolicy: shared.roomAdmissionPolicy,
    observations: observation("terminal-e6n59"),
  });
  if ("blockers" in initial) {
    throw new Error(initial.blockers.join(","));
  }
  const replacement = reconcileMarketBaseSellerRooms({
    tick: 1_001,
    admissionPolicy: shared.roomAdmissionPolicy,
    observations: observation("terminal-e6n59-replacement"),
    previous: initial.state,
    expectedPreviousCheckpointCommitment: initial.state.checkpointCommitment,
  });
  if ("blockers" in replacement) {
    throw new Error(replacement.blockers.join(","));
  }
  const lanes = reconcileMarketBaseDerivedLanes({
    sharedPolicyFingerprint: shared.fingerprint,
    sellerRooms: replacement.sellerRooms,
  });
  const lane = lanes.lanes?.find((candidate) => candidate.resource === "X");
  const room = replacement.sellerRooms[0];
  if (!lanes.ok || !lane || !room || !lanes.laneSetFingerprint) {
    throw new Error(lanes.blockers?.join(",") ?? "missing replacement X lane");
  }
  return {
    lane: {
      ...lane,
      stage: "qualified",
      status: "suspended",
      shadowEvidence: {
        completeCycles: 100,
        lastCompleteTick: 1_001,
        evidenceDigest: digest("shadow:E6N59:X:replacement"),
      },
    },
    incarnation: room.incarnation,
    rosterFingerprint: replacement.state.checkpointCommitment,
    laneSetFingerprint: lanes.laneSetFingerprint,
  };
}

function retireCanaryAndAuthorizeNext(input: {
  readonly state: MarketBaseResourceLedger;
  readonly chain: MarketBaseResourcePermitChainState;
  readonly oldLane: MarketBaseDerivedLaneLifecycle;
  readonly nextLane: MarketBaseDerivedLaneLifecycle;
  readonly tick: number;
}): {
  readonly state: MarketBaseResourceLedger;
  readonly chain: MarketBaseResourcePermitChainState;
} {
  const current =
    input.chain.retainedPermits[input.chain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    throw new Error("missing current canary permit");
  }
  const oldGrant = current.signedLaneGrants.find(
    (grant) => grant.laneId === input.oldLane.laneId,
  );
  if (!oldGrant) throw new Error("missing old canary grant");
  const tombstoneGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: input.oldLane,
    status: "tombstoned",
    stage: oldGrant.stage,
    newDealGrant: "suspended",
    lifecycleEvidenceDigest: oldGrant.lifecycleEvidenceDigest,
    reviewDigest: oldGrant.reviewDigest,
  });
  const shadowGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: input.nextLane,
    stage: "shadow",
    newDealGrant: "suspended",
  });
  const tombstonePermit = buildMarketBaseResourcePermit({
    epoch: input.chain.permitEpochHighWater + 1,
    accountIdentity: ACCOUNT,
    sharedPolicy: current.sharedPolicy,
    ratchetHighWater: current.ratchetHighWater,
    signedLaneGrants: [tombstoneGrant, shadowGrant],
    previousPermitId: input.chain.currentPermitId,
    previousPermitHead: input.chain.permitChainHead,
    previousLedgerHead: input.state.receiptHeadHash,
    createdAt: input.tick,
    operatorAuthorizationFingerprint: digest(
      `operator:tombstone:${input.oldLane.laneId}`,
    ),
  });
  const tombstoned = appendPermitOrThrow(
    input.chain,
    tombstonePermit,
    input.nextLane,
    {
      currentDerivedLanes: [input.nextLane],
      currentLifecycleCheckpointCommitment:
        marketBaseDerivedLaneLifecycleCheckpointCommitment([input.nextLane]),
      receiptPermitReferences:
        marketBaseResourceRetainedReceiptPermitReferences(
          input.state,
          input.chain,
        ),
    },
  );
  const tombstonedState = rebindMarketBaseResourceLedgerPermitAnchor(
    input.state,
    tombstoned,
  );
  const canaryGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: input.nextLane,
    stage: "canary",
    newDealGrant: "enabled",
  });
  const canaryPermit = buildMarketBaseResourcePermit({
    epoch: tombstoned.permitEpochHighWater + 1,
    accountIdentity: ACCOUNT,
    sharedPolicy: current.sharedPolicy,
    ratchetHighWater: current.ratchetHighWater,
    signedLaneGrants: [canaryGrant],
    reviewedEvidence: [
      {
        laneId: input.nextLane.laneId,
        kind: "shadow_qualification",
        evidenceKey: digest(`qualification:${input.nextLane.laneId}`),
        digest: canaryGrant.lifecycleEvidenceDigest,
      },
    ],
    previousPermitId: tombstoned.currentPermitId,
    previousPermitHead: tombstoned.permitChainHead,
    previousLedgerHead: tombstonedState.receiptHeadHash,
    createdAt: input.tick + 1,
    operatorAuthorizationFingerprint: digest(
      `operator:canary:${input.nextLane.laneId}`,
    ),
  });
  const chain = appendPermitOrThrow(tombstoned, canaryPermit, input.nextLane, {
    currentLedgerCheckpointHash: tombstonedState.checkpoint.checkpointHash,
    currentLedgerPermitAnchorHash: tombstonedState.permitAnchor.anchorHash,
    receiptPermitReferences: marketBaseResourceRetainedReceiptPermitReferences(
      tombstonedState,
      tombstoned,
    ),
  });
  return {
    chain,
    state: rebindMarketBaseResourceLedgerPermitAnchor(tombstonedState, chain),
  };
}


function legacyReceipt(attemptSeq: number): MarketBaseResourceQuotaReceipt {
  const transactionTime = 49_800 + attemptSeq;
  return {
    sourceVersion: 2,
    attemptSeq,
    evidenceKey: digest(`legacy-evidence:${attemptSeq}`),
    status: "confirmed",
    resource: "X",
    sellerRoom: "E6N59",
    plannedAmount: 1_000,
    actualAmount: 1_000,
    resolvedAt: transactionTime + 1,
    retentionTick: transactionTime,
    transactionTime,
  };
}

function legacyReceipts(): readonly MarketBaseResourceQuotaReceipt[] {
  return Array.from({ length: 6 }, (_, index) => legacyReceipt(index + 1));
}

function lifetime(): MarketBaseResourceLedgerCounters {
  return {
    global: { count: 6, amount: 6_000 },
    resources: { X: { count: 6, amount: 6_000 } },
    rooms: { E6N59: { count: 6, amount: 6_000 } },
    lanes: { "X:E6N59": { count: 6, amount: 6_000 } },
  };
}


function legacyConfirmedCanaries(): Readonly<
  Record<string, MarketBaseResourceLegacyV2ConfirmedCanary>
> {
  return {
    "base-x-e6n59-v1": {
      entryId: "base-x-e6n59-v1",
      attemptSeq: 1,
      executionPolicy: "legacy_canary_seed",
      evidenceKey: digest("legacy-evidence:1"),
      receiptEventHash: digest("legacy-seed-event"),
      reviewedEvidenceDigest: digest("legacy-seed-review"),
    },
  };
}

function migrationBasis(
  chain: MarketBaseResourcePermitChainState,
  overrides: {
    readonly prunedThrough?: number;
    readonly receipts?: readonly MarketBaseResourceQuotaReceipt[];
    readonly lifetimeConfirmed?: MarketBaseResourceLedgerCounters;
  } = {},
) {
  return buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis({
    tick: MIGRATION_TICK,
    cutoverCheckpoint: chain.v2EventCutoverCheckpoint!,
    v2PrunedThroughAttemptSeq: overrides.prunedThrough ?? 0,
    legacyQuotaReceipts: overrides.receipts ?? legacyReceipts(),
    legacyV2ConfirmedCanaries: legacyConfirmedCanaries(),
    lifetimeConfirmed: overrides.lifetimeConfirmed ?? lifetime(),
    retryNotBefore: 0,
    authenticated: true,
  });
}

function ledger(
  chain: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedger {
  return createMarketBaseResourceLedger({
    tick: MIGRATION_TICK,
    permitChain: chain,
    migrationBasis: migrationBasis(chain),
  });
}

function prepareInput(
  chain: MarketBaseResourcePermitChainState,
  currentLane: MarketBaseDerivedLaneLifecycle,
  tick: number,
) {
  const current = chain.retainedPermits[chain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    throw new Error("missing current V3 permit");
  }
  const dynamicScope = {
    admissionPolicyFingerprint:
      current.sharedPolicy.roomAdmissionPolicy.fingerprint,
    rosterFingerprint: digest("roster"),
    laneSetFingerprint: digest("lane-set"),
    laneId: currentLane.laneId,
    roomInstanceId: currentLane.roomInstanceId,
  };
  const fullRead = digest(`full-read:${tick}`);
  return {
    tick,
    resourceLimit: 8_000,
    permitChain: chain,
    executionPolicy: "canary" as const,
    historicalPermit: buildMarketBaseResourceHistoricalPermitRef(current),
    historicalLane: {
      laneId: currentLane.laneId,
      roomInstanceId: currentLane.roomInstanceId,
      sellerRoom: currentLane.sellerRoomName,
      resource: currentLane.resource,
      resourcePolicyId: currentLane.resourcePolicyId,
      resourcePolicyFingerprint: currentLane.resourcePolicyFingerprint,
      roomFingerprint: currentLane.roomFingerprint,
      sharedPolicyFingerprint: currentLane.sharedPolicyFingerprint,
    },
    firstDynamicScope: dynamicScope,
    secondDynamicScope: clone(dynamicScope),
    fullReads: {
      firstReadFingerprint: fullRead,
      secondReadFingerprint: fullRead,
      bookFingerprint: digest(`book:${tick}`),
      protectionFingerprint: digest(`protection:${tick}`),
      energyReadinessFingerprint: digest(`energy:${tick}`),
      arbiterFingerprint: digest(`arbiter:${tick}`),
    },
    executionEvidence: {
      observedOrderPriceMilli: 700_000,
      observedOrderAmount: 10_000,
      effectiveEnergyShadowPriceMilli: 100,
      effectiveNetFloorMilli: 600_000,
      terminalResourceBefore: 101_000,
      terminalEnergyBefore: 30_000,
      terminalCooldownBefore: 0,
      creditsBefore: 1_000_000,
      outgoingTransactionKeysBefore: [],
      outgoingWindowObservedAt: tick,
      outgoingWindowCoversAttemptAt: true as const,
    },
    orderId: "0123456789abcdef01234567",
    orderRoom: "W9N9",
    plannedTransactionEnergy: 400,
    plannedNetCreditsMilli: 699_960_000,
    worstUnitNetCreditsMilli: 699_900,
    evidenceKeyHint: digest(`evidence-hint:${tick}`),
  };
}



function settlePreparedCanary(
  prepared: MarketBaseResourceLedgerOperation,
  chain: MarketBaseResourcePermitChainState,
  status: "failed" | "not_filled",
  tick: number,
): MarketBaseResourceLedger {
  const pending = prepared.state.pending;
  if (!pending) {
    throw new Error("missing prepared canary");
  }
  const outcome = sealMarketBaseResourceOutcome({
    schemaVersion: 3,
    hashRevision: MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
    attemptSeq: pending.attemptSeq,
    status,
    permitId: pending.historicalPermit.permitId,
    permitEpoch: pending.historicalPermit.permitEpoch,
    laneId: pending.historicalLane.laneId,
    sellerRoom: pending.historicalLane.sellerRoom,
    resource: pending.historicalLane.resource,
    orderId: pending.orderId,
    orderRoom: pending.orderRoom,
    attemptAt: pending.attemptAt,
    plannedAmount: 1_000,
    resolvedAt: tick,
    evidenceKey: digest(`${status}:${pending.attemptSeq}`),
    actualAmount: 0,
    reason: `test_${status}`,
    pendingEvidenceHash: pending.frozenEvidenceHash,
  });
  let operation = recordMarketBaseResourceOutcome(
    prepared.state,
    outcome,
    chain,
  );
  expect(operation.action).toBe("outcome_written");
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  expect(operation.action).toBe("receipt_written");
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  expect(operation.action).toBe("processed_key_written");
  operation = advanceMarketBaseResourceWal(operation.state, chain);
  expect(operation.action).toBe("pending_deleted");
  return operation.state;
}





describe("marketBaseResourceLedger", () => {

  test("滚动成交记录超过旧四层帽后仍保留确认量与全局冷却", () => {
    const receipts: MarketBaseResourceQuotaReceipt[] = Array.from({ length: 9 }, (_, index) => ({
      sourceVersion: 3,
      attemptSeq: index + 1,
      evidenceKey: digest(`unbounded:${index}`),
      status: "confirmed",
      resource: RESOURCE_CATALYST,
      sellerRoom: "E4N58",
      plannedAmount: 1_000,
      actualAmount: 1_000,
      transactionTime: (index + 1) * 1_000,
      resolvedAt: (index + 1) * 1_000 + 1,
      retentionTick: (index + 1) * 1_000,
    }));
    const quota = computeMarketBaseResourceQuota({
      tick: 10_000,
      resource: RESOURCE_CATALYST,
      sellerRoom: "E4N58",
      resourceLimit: 1_000_000_000,
      receipts,
    });
    expect([
      quota.global.limit,
      quota.resourceQuota.limit,
      quota.room.limit,
      quota.lane.limit,
    ]).toEqual([
      MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
      1_000_000_000,
      MARKET_BASE_RESOURCE_ROOM_QUOTA_LIMIT,
      MARKET_BASE_RESOURCE_LANE_QUOTA_LIMIT,
    ]);
    expect(quota.lane.confirmedActual).toBe(9_000);
    expect(quota.global.confirmedActual).toBe(9_000);
    expect(quota.confirmedCooldownNotBefore).toBe(10_000);
  });

  test("V2 迁移后的 V3 pending 冻结历史 scope，owned terminal incarnation 变化后仍按旧 WAL 收敛再授权新 lane", () => {
    const { canary, currentLane } = permitChains();
    const replacement = replacementXLaneFromOwnedTerminalIncarnation();
    expect(replacement.incarnation).toBe(2);
    expect(replacement.lane.laneId).not.toBe(currentLane.laneId);
    expect(replacement.lane.roomInstanceId).not.toBe(
      currentLane.roomInstanceId,
    );
    const tick = 80_000;
    const prepared = prepareMarketBaseResourceAttempt(
      ledger(canary),
      prepareInput(canary, currentLane, tick),
    );
    expect(prepared.action).toBe("prepared");
    const frozenScope = clone(prepared.state.pending!.dynamicScope);
    const changedScopeInput = prepareInput(canary, currentLane, tick + 1);
    const changedScope = {
      ...changedScopeInput.firstDynamicScope,
      rosterFingerprint: replacement.rosterFingerprint,
      laneSetFingerprint: replacement.laneSetFingerprint,
      laneId: replacement.lane.laneId,
      roomInstanceId: replacement.lane.roomInstanceId,
    };
    const changedFullRead = digest("changed-full-read-after-pending");
    const secondPrepare = prepareMarketBaseResourceAttempt(prepared.state, {
      ...changedScopeInput,
      firstDynamicScope: changedScope,
      secondDynamicScope: clone(changedScope),
      fullReads: {
        ...changedScopeInput.fullReads,
        firstReadFingerprint: changedFullRead,
        secondReadFingerprint: changedFullRead,
      },
    });
    expect(secondPrepare).toMatchObject({
      action: "blocked",
      blockerCode: "single_pending_already_active",
    });
    expect(prepared.state.pending!.dynamicScope).toEqual(frozenScope);
    expect(prepared.state.pending!.historicalLane).toMatchObject({
      laneId: currentLane.laneId,
      roomInstanceId: currentLane.roomInstanceId,
    });

    const settled = settlePreparedCanary(
      prepared,
      canary,
      "not_filled",
      tick + 1,
    );
    expect(settled.pending).toBeUndefined();
    expect(settled.terminalSlotReservation).toBeUndefined();
    expect(settled.legacyQuotaReceipts).toHaveLength(0);
    expect(settled.checkpoint.prunedThroughAttemptSeq).toBe(6);
    expect(settled.lifetimeConfirmed.global).toEqual({
      count: 6,
      amount: 6_000,
    });
    expect(settled.receipts[0]).toMatchObject({
      attemptSeq: 7,
      permitId: canary.currentPermitId,
    });
    expect(validateMarketBaseResourceLedger(settled, tick + 1, canary)).toEqual(
      { ok: true, prefix: "idle" },
    );
    const recovered = retireCanaryAndAuthorizeNext({
      state: settled,
      chain: canary,
      oldLane: currentLane,
      nextLane: replacement.lane,
      tick: tick + 2,
    });
    expect(
      validateMarketBaseResourceLedger(
        recovered.state,
        tick + 4,
        recovered.chain,
      ),
    ).toEqual({ ok: true, prefix: "idle" });
    const recoveredCurrent =
      recovered.chain.retainedPermits[
        recovered.chain.retainedPermits.length - 1
      ];
    expect(recoveredCurrent?.schemaVersion).toBe(3);
    expect(
      recoveredCurrent?.schemaVersion === 3
        ? recoveredCurrent.signedLaneGrants.find(
            (grant) => grant.laneId === replacement.lane.laneId,
          )
        : undefined,
    ).toMatchObject({
      stage: "canary",
      newDealGrant: "enabled",
    });
  });

  test("malformed Permit/Ledger runtime gate 与 context 全部 fail closed 而不抛错", () => {
    const { canary, currentLane } = permitChains();
    const tick = 80_000;
    const initial = ledger(canary);
    const permitAnchor =
      buildMarketBaseResourcePermitRuntimeAnchor(
        canary,
      );
    const initialAnchor =
      buildMarketBaseResourceLedgerRuntimeAnchor(
        initial,
        canary,
      );
    const malformedPermits = [
      (() => {
        const value = clone(canary);
        delete (
          value as unknown as {
            retainedPermits?: unknown;
          }
        ).retainedPermits;
        return value;
      })(),
      (() => {
        const value = clone(canary);
        (
          value as unknown as {
            retainedPermits: unknown;
          }
        ).retainedPermits = null;
        return value;
      })(),
      (() => {
        const value = clone(canary);
        delete (
          value as unknown as {
            prefixCheckpoint?: unknown;
          }
        ).prefixCheckpoint;
        return value;
      })(),
      (() => {
        const value = clone(canary);
        delete (
          value as unknown as {
            laneTombstoneCheckpoint?: unknown;
          }
        ).laneTombstoneCheckpoint;
        return value;
      })(),
      (() => {
        const value = clone(canary);
        const current =
          value.retainedPermits[
            value.retainedPermits.length - 1
          ];
        if (!current || current.schemaVersion !== 3) {
          throw new Error("missing malformed current permit");
        }
        (
          current as unknown as {
            ratchetHighWater: unknown;
          }
        ).ratchetHighWater = null;
        return value;
      })(),
    ];
    for (const malformed of malformedPermits) {
      let gate:
        | ReturnType<
            typeof validateMarketBaseResourcePermitRuntimeGate
          >
        | undefined;
      expect(() => {
        gate =
          validateMarketBaseResourcePermitRuntimeGate(
            malformed,
            permitAnchor,
          );
      }).not.toThrow();
      expect(gate?.ok).toBe(false);
      let context:
        | ReturnType<
            typeof createMarketBaseResourcePermitRuntimeContext
          >
        | undefined;
      expect(() => {
        context =
          createMarketBaseResourcePermitRuntimeContext({
            state: malformed,
            anchor: permitAnchor,
            tick,
          });
      }).not.toThrow();
      expect(context).toMatchObject({ ok: false });
    }

    const prepared =
      prepareMarketBaseResourceAttempt(
        initial,
        prepareInput(
          canary,
          currentLane,
          tick,
        ),
      ).state;
    const preparedAnchor =
      buildMarketBaseResourceLedgerRuntimeAnchor(
        prepared,
        canary,
      );
    const malformedLedgers = [
      (() => {
        const value = clone(prepared);
        delete (
          value as unknown as {
            checkpoint?: unknown;
          }
        ).checkpoint;
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        delete (
          value as unknown as {
            receipts?: unknown;
          }
        ).receipts;
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        (
          value as unknown as {
            processedEvidenceKeys: unknown;
          }
        ).processedEvidenceKeys = [
          {
            attemptSeq:
              value.pending!.attemptSeq,
          },
        ];
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        (
          value as unknown as {
            lifetimeConfirmed: unknown;
          }
        ).lifetimeConfirmed = null;
        return value;
      })(),
      (() => {
        const value = clone(prepared);
        (
          value as unknown as {
            receipts: unknown;
          }
        ).receipts = [
          {
            status: "confirmed",
          },
        ];
        return value;
      })(),
    ];
    for (const malformed of malformedLedgers) {
      let gate:
        | ReturnType<
            typeof validateMarketBaseResourceLedgerRuntimeGate
          >
        | undefined;
      expect(() => {
        gate =
          validateMarketBaseResourceLedgerRuntimeGate(
            malformed,
            canary,
            preparedAnchor,
            tick,
          );
      }).not.toThrow();
      expect(gate?.ok).toBe(false);
      let context:
        | ReturnType<
            typeof createMarketBaseResourceLedgerRuntimeContext
          >
        | undefined;
      expect(() => {
        context =
          createMarketBaseResourceLedgerRuntimeContext({
            state: malformed,
            permitChain: canary,
            anchor: preparedAnchor,
            tick,
          });
      }).not.toThrow();
      expect(context).toMatchObject({ ok: false });
    }

    // Ledger gate 必须同样吞掉 malformed Permit，而不是在嵌套 gate 抛错。
    expect(() =>
      validateMarketBaseResourceLedgerRuntimeGate(
        initial,
        malformedPermits[0],
        initialAnchor,
        tick,
      ),
    ).not.toThrow();
  });
});
