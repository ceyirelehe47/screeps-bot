/** 从 marketSaleAutomation.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { marketBaseResourceV3ConfigMismatchReasons } from "@/runtime/marketSaleConfig";
import { runDirectAutomationPlanning } from "@/runtime/marketSaleDirectAutomation";
import {
  type MarketDirectContinuousAutomationState,
  type MarketDirectContinuousResult,
} from "@/runtime/marketDirectContinuousAutomation";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import {
  advanceMarketBaseResourceReadinessRuntimeCapability,
  advanceMarketBaseResourceReadinessRuntimeCapabilityFromRoot,
  collectLiveMarketBaseRoomObservations,
  createMarketBaseResourceReadinessRuntimeCapability,
  defaultMarketBaseResourceRuntimeDependencies,
  marketBaseResourceOuterScopeCommitment,
  readLiveMarketBaseAccountIdentity,
  registerMarketBaseResourceCanonicalReadinessRuntimeCapability,
  reconcileLiveMarketBaseResourceScopeWithRuntimeCapability,
  reconcileMarketBaseResourcePreflight,
  resignMarketBaseResourceReadinessAuthorizationWithRuntimeCapability,
  runMarketBaseResourcePreflight,
  type MarketBaseResourceAutomationResult,
  type MarketBaseResourceReadinessRuntimeCapability,
  type MarketBaseResourceScopeState,
  type MarketBaseResourceV3RuntimeState,
} from "@/runtime/marketBaseResourceAutomation";
import { hasAcceptedMarketBaseResourceV3Successor } from "@/runtime/marketBaseResourcePermit";
import {
  validateMarketBaseResourceLedger,
  validateMarketBaseResourceLedgerRuntimeGate,
  type MarketBaseResourceLedgerRuntimeAnchor,
} from "@/runtime/marketBaseResourceLedger";
import {
  isPlainRecord,
  cloneMarketBaseOperatorValue,
  freezeMarketBaseOuterCanonicalValue,
  validateMarketBaseResourceActivationAnchor,
  validateMarketBaseResourceActivationBlocker,
  sameMarketBaseResourceActivationAnchor,
  MARKET_BASE_RESOURCE_ACTIVATION_BLOCKER_REVISION,
  marketBaseResourceActivationAnchorHash,
  validateMarketBaseResourceActivationAnchorMirror,
  validateMarketBaseNestedActivationState,
  isContinuousDirectState,
  marketBaseResourceCanonicalRootProvenance,
  marketBaseResourceActivationState,
  marketBaseNestedCutoverEvidence,
  validateMarketBaseScopeLifecycleEvidence,
  marketBaseStableScopeProjection,
  synchronizeMarketBaseTrustedFloors,
  advanceMarketBaseResourceActivationAnchor,
  commitMarketSaleDataSnapshot,
  marketBaseLegacyV2QuiescenceCommitment,
  marketBaseOperatorExposureBlocker,
} from "@/runtime/marketSaleOperators";
import type {
  MarketSaleDataState,
  MarketBaseResourceActivationAnchor,
  MarketBaseResourceActivationAnchorPayload,
} from "@/runtime/marketSaleOperators";
import { reject, recordAction, nonNegativeInteger } from "@/runtime/marketSaleReconciliation";
import type { RunContext } from "@/runtime/marketSaleReconciliation";


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

function recoverReceiptWrittenActivationValidationLatch(
  data: MarketSaleDataState,
  existing: MarketBaseResourceV3RuntimeState | undefined,
): MarketBaseResourceV3RuntimeState | undefined {
  const blocker = data.baseResourceV3ActivationBlocker;
  const primary = data.baseResourceV3ActivationAnchor;
  const mirror = data.baseResourceV3ActivationAnchorMirror;
  const ledger = existing?.ledger;
  const permitChain = existing?.permitChain;
  const pending = ledger?.pending;
  const receipt = ledger?.receipts[ledger.receipts.length - 1];
  if (
    !validateMarketBaseResourceActivationBlocker(blocker) ||
    blocker.code !== "market_base_activation_anchor_invalid" ||
    !existing ||
    existing.blocker !== blocker.code ||
    existing.hardBlocker !== undefined ||
    !ledger ||
    !permitChain ||
    !pending ||
    !receipt ||
    ledger.finalizedAttemptSeq !== pending.attemptSeq ||
    receipt.attemptSeq !== pending.attemptSeq ||
    receipt.status !== "not_filled" ||
    receipt.actualAmount !== 0 ||
    receipt.reason !== "complete_window_and_physical_state_unchanged" ||
    ledger.processedEvidenceKeys.some(
      (entry) => entry.attemptSeq === pending.attemptSeq,
    )
  ) {
    return undefined;
  }
  freezeMarketBaseOuterCanonicalValue(primary);
  freezeMarketBaseOuterCanonicalValue(mirror);
  if (
    !validateMarketBaseResourceActivationAnchor(primary) ||
    !validateMarketBaseResourceActivationAnchorMirror(mirror, primary) ||
    primary.activationBlocker !== null ||
    primary.updatedAt >= blocker.detectedAt ||
    primary.ledger.pendingAttemptSeq !== pending.attemptSeq ||
    primary.ledger.finalizedAttemptSeq !== pending.attemptSeq ||
    primary.ledger.pendingFrozenEvidenceHash !== pending.frozenEvidenceHash ||
    primary.ledger.receiptHeadHash !== ledger.receiptHeadHash ||
    !validateMarketBaseResourceLedger(
      ledger,
      Game.time,
      permitChain,
    ).ok ||
    !validateMarketBaseResourceLedgerRuntimeGate(
      ledger,
      permitChain,
      primary.ledger,
      Game.time,
    ).ok
  ) {
    return undefined;
  }
  const recovered = { ...existing };
  delete recovered.blocker;
  return validateMarketBaseNestedActivationState(
    recovered,
    primary,
    data.trustedFloors,
    { allowTrustedFloorAdvance: true },
  ) === undefined
    ? recovered
    : undefined;
}

export function reconcileBaseResourceV3State(context: RunContext): {
  activeV3Successor: boolean;
  state?: MarketBaseResourceV3RuntimeState;
  ledgerRuntimeAnchor?: MarketBaseResourceLedgerRuntimeAnchor;
  readinessRuntimeCapability?: MarketBaseResourceReadinessRuntimeCapability;
} {
  let sourceDirect = context.data.directAutomation;
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
  let existing = sourceDirect.baseResourceV3 as
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
  const recovered = recoverReceiptWrittenActivationValidationLatch(
    context.data,
    existing,
  );
  if (recovered) {
    const source = context.data;
    const nextDirect = { ...sourceDirect, baseResourceV3: recovered };
    const nextData: MarketSaleDataState = {
      ...source,
      directAutomation: nextDirect,
    };
    delete nextData.baseResourceV3ActivationBlocker;
    if (!commitExactContextMarketSaleData(context, source, nextData)) {
      reject(context, "market_base_activation_recovery_cas_failed");
      return {
        activeV3Successor: true,
        state: blockedMarketBaseRuntimeState(
          existing,
          context,
          "market_base_activation_recovery_cas_failed",
        ),
      };
    }
    sourceDirect = nextDirect;
    existing = recovered;
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

export function isRegisteredMarketBaseResourceCanonicalRootThisTick(
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

export function mergeDirectResult(
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

function commitContextMarketSaleData(
  context: RunContext,
  data: MarketSaleDataState,
): void {
  commitMarketSaleDataSnapshot(data);
  context.data = data;
}

export function commitExactContextMarketSaleData(
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

export function registerMarketBaseResourceCanonicalRoot(
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

export function validatePostCutoverLegacyV2Quiescence(
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
    Object.keys(direct.pendingDirectDeals ?? {}).length !== 0 ||
    Object.keys(direct.quarantinedPendingDirectDeals).length !== 0 ||
    Object.keys(data.pendingDirectDeals ?? {}).length !== 0 ||
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
