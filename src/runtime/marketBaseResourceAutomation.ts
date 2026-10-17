import { baseMineralOverflowNetFloor, liveBaseMineralOverflow, baseMineralOverflowCooldownNotBefore, recordBaseMineralOverflow } from "@/runtime/baseMineralOverflow";
import { AUTHORITY_EXECUTOR_SHARD } from "@/config/deployment";
import { isExplicitMarketNonOkReturnCode } from "@/runtime/marketActionArbiter";
import { type PlanMarketDirectContinuousInput } from "@/runtime/marketDirectContinuousPlanner";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import { measureMarketSubPhase } from "@/runtime/marketSaleDiagnostics";
import {
  directSafetyFingerprint,
  MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT,
  type ResolvedMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CATALOG_REVISION,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  type MarketBaseResource,
  buildMarketBaseDynamicFloorState,
  createMarketBaseRoomAdmissionPolicy,
  createMarketBaseSharedPolicy,
  marketBaseEnforcedDynamicFloors,
  marketBaseRoomObservationIsAdmitted,
  reconcileMarketBaseDerivedLanes,
  reconcileMarketBaseSellerRooms,
  type MarketBaseDerivedLaneLifecycle,
  type MarketBaseRoomObservation,
} from "@/runtime/marketBaseResourcePolicy";
import {
  buildMarketBaseResourceReadinessAuthorization,
  hasAcceptedMarketBaseResourceV3Successor,
  marketBaseResourceSellerRoomBasis,
  validateMarketBaseResourcePermitChain,
  type MarketBaseResourceLaneTombstoneDischarge,
  type MarketBaseResourcePermit,
  type MarketBaseResourcePermitChainState,
} from "@/runtime/marketBaseResourcePermit";
import {
  advanceMarketBaseResourceWalWithRuntimeContext,
  buildMarketBaseResourceHistoricalPermitRef,
  hasMarketBaseResourceProcessedEvidenceKeyWithRuntimeContext,
  MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
  marketBaseResourceCurrentWalProjectionWithRuntimeContext,
  marketBaseResourceQuotaProjection,
  marketBaseResourceQuotaProjectionWithRuntimeContext,
  marketBaseResourceConfirmedCanaryForWithRuntimeContext,
  prepareMarketBaseResourceAttemptWithRuntimeContext,
  recordMarketBaseResourceOutcomeWithRuntimeContext,
  sealMarketBaseResourceOutcome,
  validateMarketBaseResourcePermitChainDominatesAnchor,
  validateMarketBaseResourceLedger,
  type MarketBaseResourceLedger,
  type MarketBaseResourceLedgerRuntimeAnchor,
  type MarketBaseResourceLedgerRuntimeContext,
  type MarketBaseResourcePendingAttempt,
  type MarketBaseResourceQuotaSnapshot,
} from "@/runtime/marketBaseResourceLedger";
import {
  getMarketProtectionSellableAmount,
  isMarketProtectionEntryFresh,
  type MarketProtectionEntry,
} from "@/runtime/marketSaleProtection";
import { priceToMilliDown } from "@/runtime/marketSalePricing";
import {
  activeMarketEgressTrialR2,
  closeExpiredMarketEgressTrialR2,
  readMarketEgressTrialCapacityState,
  reserveMarketEgressTrialNative,
  stopMarketEgressTrialR2,
  trialCooldownNotBefore,
  trialLaneEligible,
} from "@/runtime/marketBaseResourceEgressTrialR2";
import {
  MARKET_BASE_RESOURCE_MAX_ACTIVE_LANES,
  stableCompare,
  MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE,
  MARKET_BASE_RESOURCE_CPU_TRACE_MAX,
  MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING,
  observeMarketBaseResourceCpuTrace,
  setMarketBaseResourceMarketFactsDisposition,
  runtimeCandidateKey,
  planMarketBaseResourceTwoRead,
} from "@/runtime/marketBaseResourcePlanning";
import type {
  MarketBaseResourcePricingRatchetState,
  MarketBaseResourcePlanningSnapshot,
  MarketBaseResourceOutgoingWindow,
  MarketBaseResourceCpuTrace,
  MarketBaseResourceTerminalRead,
  MarketBaseResourceShadowObservation,
  MarketBaseResourceCpuTraceRecorder,
  MarketBaseResourceOutgoingTransaction,
  MarketBaseResourcePlanningScopeSnapshot,
  V3EntryInput,
  V3LaneInput,
  MarketBaseResourceTwoReadPlan,
  MarketBaseResourceCpuTraceField,
  MarketBaseResourceCpuCutPhase,
} from "@/runtime/marketBaseResourcePlanning";
import {
  pricingRatchetPayload,
  readLiveMarketBaseAccountIdentity,
  isPlainRecord,
  currentV3Permit,
  validateMarketBaseResourcePricingRatchetState,
  scopeLaneTombstoneCheckpointPayload,
  MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION,
  MARKET_BASE_RESOURCE_NO_SCOPE_LANE_TOMBSTONE_DISCHARGE,
  validScopeLaneTombstoneCheckpoint,
  validateScopeLaneTombstones,
  currentRosterFingerprint,
  advanceMarketBaseResourceReadinessRuntimeCapabilityInternal,
  marketBaseResourceReadinessRuntimeCapabilities,
  marketBaseResourceRuntimeSnapshotMismatch,
  marketBaseResourceCanonicalReadinessRuntimeCache,
  marketBaseResourceRuntimeInvariantCommitment,
  marketBaseResourceRuntimePricingRatchetCommitment,
  readCachedMarketBaseResourceCanonicalReadiness,
  validateMarketBaseResourceRuntimeScopeConsistency,
  issueMarketBaseResourceReadinessRuntimeCapability,
  createMarketBaseResourceRuntimeScopeContext,
  marketBaseResourceRuntimeDeepFrozenValues,
  freezeMarketBaseResourceRuntimeSnapshot,
  laneAllowsRuntimeWrite,
  marketBaseResourceRuntimeScopeCommitment,
  defaultMarketBaseResourceRuntimeDependencies,
  openMarketBaseResourceRuntimeSession,
  MAX_OUTGOING_TRANSACTIONS,
} from "@/runtime/marketBaseResourceReadiness";
import type {
  MarketBaseResourceReadinessRuntimeCapability,
  MarketBaseResourceV3RuntimeState,
  MarketBaseResourceScopeState,
  MarketBaseResourceRuntimeSession,
  MarketBaseResourceHardBlocker,
  ScopeLaneTombstoneCheckpointWithoutCommitment,
  MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint,
  MarketBaseResourceScopeLaneTombstone,
  MarketBaseResourceTrustedFloorObservation,
  MarketBaseResourceRuntimeDependencies,
  MarketBaseResourceTrustedFloorResource,
  MarketBaseResourceArbiterSnapshot,
  MarketBaseResourceRuntimeSessionResult,
} from "@/runtime/marketBaseResourceReadiness";
export {
  MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION,
  validateMarketBaseResourcePricingRatchetState,
  deriveMarketBaseResourceCanonicalReadinessAuthorization,
  readLiveMarketBaseAccountIdentity,
  readLiveMarketBaseTerminal,
  defaultMarketBaseResourceRuntimeDependencies,
  marketBaseResourceRuntimeScopeCommitment,
  marketBaseResourceOuterScopeCommitment,
  validateMarketBaseResourceRuntimeScopeConsistency,
  createMarketBaseResourceReadinessRuntimeCapability,
  resignMarketBaseResourceReadinessAuthorizationWithRuntimeCapability,
  marketBaseResourceActivationAnchorSelfHash,
  registerMarketBaseResourceCanonicalReadinessRuntimeCapability,
} from "@/runtime/marketBaseResourceReadiness";
export type {
  MarketBaseResourceScopeState,
  MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint,
  MarketBaseResourceTrustedFloorObservation,
  MarketBaseResourceTrustedFloorResource,
  MarketBaseResourceHardBlocker,
  MarketBaseResourcePermitProposal,
  MarketBaseResourceV3RuntimeState,
  MarketBaseResourceArbiterSnapshot,
  MarketBaseResourceRuntimeDependencies,
  MarketBaseResourceReadinessRuntimeCapability,
  MarketBaseResourceCanonicalReadinessRead,
  MarketBaseResourceReadinessRuntimeResignResult,
} from "@/runtime/marketBaseResourceReadiness";

// 准备 WAL 后还需 canonical root 提交、claim 与 deal；仅在剩余预算
// 足以覆盖这段写前路径时才消耗一次性 canary grant。
const MARKET_BASE_RESOURCE_PREPARE_MIN_REMAINING_CPU = 12;

export function marketBaseResourceOperatorAuthorizationFingerprint(
  config: ResolvedMarketSaleAutomationConfig,
): string {
  return marketBaseResourceOperatorAuthorizationFingerprintFromDirectSafety(
    directSafetyFingerprint(config),
  );
}

function marketBaseResourceOperatorAuthorizationFingerprintFromDirectSafety(
  fingerprint: string | undefined,
): string {
  if (
    fingerprint ===
    MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT
  ) {
    return MARKET_BASE_RESOURCE_CANONICAL_OPERATOR_AUTHORIZATION_FINGERPRINT;
  }
  return canonicalStableHashV1({
    domain: "market-base-resource:operator-authorization-v1",
    directSafetyFingerprint: fingerprint,
  });
}

export const MARKET_BASE_RESOURCE_CANONICAL_OPERATOR_AUTHORIZATION_FINGERPRINT =
  canonicalStableHashV1({
    domain: "market-base-resource:operator-authorization-v1",
    directSafetyFingerprint:
      MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT,
  });

export function buildMarketBaseResourcePricingRatchetState(input: {
  initializedAt: number;
  entries: readonly {
    resource: MarketBaseResource;
    value: number;
    marketDate: string;
  }[];
}): MarketBaseResourcePricingRatchetState {
  const entries = MARKET_BASE_RESOURCE_CATALOG.map((resource) => {
    const entry = input.entries.find(
      (candidate) => candidate.resource === resource,
    );
    if (
      !entry ||
      !Number.isFinite(entry.value) ||
      entry.value <
        MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[resource].ratchetFloor ||
      typeof entry.marketDate !== "string" ||
      entry.marketDate < MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.historyDate
    ) {
      throw new TypeError(`invalid pricing ratchet entry:${resource}`);
    }
    return {
      resource,
      value: entry.value,
      marketDate: entry.marketDate,
    };
  });
  if (
    !Number.isSafeInteger(input.initializedAt) ||
    input.initializedAt < 0 ||
    input.entries.length !== entries.length
  ) {
    throw new TypeError("invalid pricing ratchet state");
  }
  const payload = pricingRatchetPayload({
    initializedAt: input.initializedAt,
    entries,
  });
  return {
    schemaVersion: 1,
    initializedAt: input.initializedAt,
    bootstrapFingerprint: MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint,
    entries,
    fingerprint: canonicalStableHashV1(payload),
  };
}

/**
 * MarketSaleRuntime 每次 full read 都重新组合这份候选。它只携带当前
 * pricing/protection 事实，不携带 permit 授权；授权必须由本模块从
 * canonical v3 state 重新验证。
 */
export interface MarketBaseResourceRuntimeCandidate {
  overflowTier?: "normal" | "overflow" | "liquidation";
  roomName: string;
  resourceType: MarketBaseResource;
  protectionEntry: MarketProtectionEntry;
  historyTrusted: boolean;
  historyFloor: number;
  ratchetFloor: number;
  effectiveNetFloor: number;
  effectiveEnergyShadowPrice: number;
  energyShadowObservedAt: number;
  energyShadowComponents: {
    hardFloor: number;
    explicit?: number;
    historyFloor?: number;
    ratchetFloor?: number;
  };
  capacityState: "normal" | "pressure" | "emergency";
  isHubRoom: boolean;
  rejectionReasons: readonly string[];
}

export interface MarketBaseResourceAutomationInput {
  tick: number;
  fullPlanningTick: boolean;
  /**
   * outer dispatcher 在开始 activation/preflight 校验前采集的 CPU 起点。
   * 提供后，25 CPU 预算覆盖整个 active V3 outer+inner tick。
   */
  cpuStartedAt?: number;
  /**
   * outer 同 tick preflight 已铸造的私有 runtime session。提供且与 state
   * exact snapshot 对应时，inner 不再重复打开 512-ring Ledger context。
   */
  readinessRuntimeCapability?: MarketBaseResourceReadinessRuntimeCapability;
  config: ResolvedMarketSaleAutomationConfig;
  readCandidates: () => readonly MarketBaseResourceRuntimeCandidate[];
  makerExposurePresent: boolean;
  emergencyStop: boolean;
}

export interface MarketBaseResourceAutomationResult {
  actions: string[];
  rejectedByReason: Record<string, number>;
  writes: number;
  planComplete: boolean;
  state: MarketBaseResourceV3RuntimeState;
  /**
   * 与返回 state.ledger 精确对应的 successor outer anchor。V3 已激活时
   * 调用方必须和 state 同一次 root replacement 提交；缺失即零写。
   */
  ledgerRuntimeAnchor?: MarketBaseResourceLedgerRuntimeAnchor;
  /**
   * 仅在本进程、本 tick 内有效的 opaque runtime capability。它由
   * Ledger/Permit runtime session 铸造，不能写入 Memory，也不能通过
   * JSON clone 伪造；outer 用它把 successor canonical root 注册给
   * ResourceControl 与 terminal reader 复用。
   */
  readinessRuntimeCapability?: MarketBaseResourceReadinessRuntimeCapability;
  /**
   * 本 tick 的非授权诊断观测。outer 可将它投影到 runtime Memory；它不是
   * canonical root 的组成部分，也不能单独替代未截断 raw CPU gate。
   */
  cpuTrace?: MarketBaseResourceCpuTrace;
  /**
   * 同一 outer 窗口内未截断、不可回拨的 CPU 高水位。它只在本次调用栈
   * 内交给 outer 最终门禁，不能持久化、不能参与任何市场授权或 canonical
   * hash；缺失或小于 trace 已记录值时 outer 必须 fail closed。
   */
  cpuRawHighWater?: number;
  /**
   * 仅纯 Shadow/no-selected 路径可返回的一次性 reset-only materializer。
   * 它不能 JSON clone、不能写入 Memory，也不能用于 prepared/WAL 路径。
   */
  cpuFallbackCapability?: MarketBaseResourceCpuFallbackCapability;
}

declare const MARKET_BASE_RESOURCE_CPU_FALLBACK_CAPABILITY_BRAND: unique symbol;

export interface MarketBaseResourceCpuFallbackCapability {
  readonly [MARKET_BASE_RESOURCE_CPU_FALLBACK_CAPABILITY_BRAND]: true;
}

export interface MarketBaseResourcePreflightResult {
  state: MarketBaseResourceV3RuntimeState;
  activeV3Successor: boolean;
  blocker?: string;
}

function boundedQuotaProjection(
  state: MarketBaseResourceLedger,
  scope: MarketBaseResourceScopeState,
  tick: number,
): MarketBaseResourceV3RuntimeState["quotaProjection"] {
  const quotas = marketBaseResourceQuotaProjection({
    state,
    tick,
    lanes: scope.laneLifecycles.map((lane) => ({
      resource: lane.resource,
      sellerRoom: lane.sellerRoomName,
      resourceLimit:
        MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[lane.resource].rollingMaxAmount,
    })),
  });
  return boundedQuotaProjectionFromFacts(state, tick, quotas);
}

function boundedRuntimeQuotaProjection(
  session: MarketBaseResourceRuntimeSession,
  scope: MarketBaseResourceScopeState,
  tick: number,
): MarketBaseResourceV3RuntimeState["quotaProjection"] {
  const quotas = marketBaseResourceQuotaProjectionWithRuntimeContext(
    session.ledgerContext,
    {
      tick,
      lanes: scope.laneLifecycles.map((lane) => ({
        resource: lane.resource,
        sellerRoom: lane.sellerRoomName,
        resourceLimit:
          MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[lane.resource]
            .rollingMaxAmount,
      })),
    },
  );
  return boundedQuotaProjectionFromFacts(
    session.ledgerContext.state,
    tick,
    quotas,
  );
}

function boundedQuotaProjectionFromFacts(
  state: MarketBaseResourceLedger,
  tick: number,
  quotas: readonly MarketBaseResourceQuotaSnapshot[],
): MarketBaseResourceV3RuntimeState["quotaProjection"] {
  const projection: NonNullable<
    MarketBaseResourceV3RuntimeState["quotaProjection"]
  > = {
    observedAt: tick,
    cooldownNotBefore: 0,
    retryNotBefore: state.retryNotBefore,
    resources: {},
    rooms: {},
    lanes: {},
  };
  for (const quota of quotas) {
    projection.global ||= {
      cap: quota.global.limit,
      confirmed: quota.global.confirmedActual,
      unmatched: quota.global.unmatchedPlanned,
    };
    projection.cooldownNotBefore = Math.max(
      projection.cooldownNotBefore,
      quota.confirmedCooldownNotBefore,
    );
    projection.retryNotBefore = Math.max(
      projection.retryNotBefore,
      quota.retryNotBefore,
    );
    projection.resources[quota.resource] ||= {
      cap: quota.resourceQuota.limit,
      confirmed: quota.resourceQuota.confirmedActual,
      unmatched: quota.resourceQuota.unmatchedPlanned,
    };
    projection.rooms[quota.sellerRoom] ||= {
      cap: quota.room.limit,
      confirmed: quota.room.confirmedActual,
      unmatched: quota.room.unmatchedPlanned,
    };
    projection.lanes[`${quota.resource}:${quota.sellerRoom}`] = {
      cap: quota.lane.limit,
      confirmed: quota.lane.confirmedActual,
      unmatched: quota.lane.unmatchedPlanned,
    };
  }
  return projection;
}

/**
 * 每 tick 在局部值完成动态准入、permit chain 与 readiness 校验，再由调用者
 * 一次 assignment 提交。任何失败都会删除旧 readiness，避免跨 tick 复用。
 */
export function reconcileMarketBaseResourcePreflight(
  raw: unknown,
  input: {
    tick: number;
    mode: string;
    accountIdentity?: string;
    config?: ResolvedMarketSaleAutomationConfig;
  },
): MarketBaseResourcePreflightResult {
  const accountIdentity =
    input.accountIdentity || readLiveMarketBaseAccountIdentity();
  const existing = isPlainRecord(raw)
    ? (raw as unknown as MarketBaseResourceV3RuntimeState)
    : undefined;
  const state: MarketBaseResourceV3RuntimeState = {
    ...(existing || {}),
    schemaVersion: 3,
    catalog: {
      revision: MARKET_BASE_RESOURCE_CATALOG_REVISION,
      configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
      resources: [...MARKET_BASE_RESOURCE_CATALOG],
    },
  };
  delete state.readinessAuthorization;
  if (state.hardBlocker) {
    state.blocker = state.hardBlocker.code;
  } else {
    delete state.blocker;
  }
  const permitChain = state.permitChain;
  const hasCutoverHighWater = Boolean(
    permitChain &&
    (permitChain.legacyV2GrantSuspended === true ||
      permitChain.v2EventCutoverCheckpoint !== undefined ||
      permitChain.retainedPermits?.some(
        (record) => record.schemaVersion === 3,
      )),
  );
  const permitValidation = permitChain
    ? validateMarketBaseResourcePermitChain(permitChain)
    : undefined;
  const activeV3Successor = Boolean(
    state.cutoverLatched === true ||
    (permitChain &&
      (hasCutoverHighWater ||
        hasAcceptedMarketBaseResourceV3Successor(permitChain))),
  );
  if (state.hardBlocker) {
    return {
      state,
      activeV3Successor: true,
      blocker: state.hardBlocker.code,
    };
  }
  if (permitChain && !permitValidation?.ok) {
    state.blocker =
      permitValidation?.reason || "market_base_permit_chain_invalid";
    return {
      state,
      // 任一 cutover/V3 高水位都是不可回退 latch；损坏证据只能零写，
      // 绝不能让调用方重新落回 legacy v2。
      activeV3Successor: true,
      blocker: state.blocker,
    };
  }
  if (
    permitChain &&
    permitValidation?.ok &&
    hasAcceptedMarketBaseResourceV3Successor(permitChain)
  ) {
    state.cutoverLatched = true;
  }
  if (!accountIdentity) {
    state.blocker = "market_base_account_identity_incomplete";
    return {
      state,
      activeV3Successor,
      blocker: state.blocker,
    };
  }
  const scopeResult = reconcileLiveMarketBaseResourceScope({
    tick: input.tick,
    accountIdentity,
    observations: collectLiveMarketBaseRoomObservations(accountIdentity),
    previous: state.scope,
    permitChain,
    pinnedLaneIds: state.ledger?.pending
      ? [state.ledger.pending.historicalLane.laneId]
      : [],
  });
  if ("blockers" in scopeResult) {
    state.blocker =
      scopeResult.blockers[0] || "market_base_scope_reconcile_failed";
    return {
      state,
      activeV3Successor,
      blocker: state.blocker,
    };
  }
  state.scope = scopeResult.state;
  if (!permitChain) {
    if (activeV3Successor) {
      state.blocker = "market_base_permit_chain_missing_after_cutover";
    }
    return {
      state,
      activeV3Successor,
      ...(state.blocker ? { blocker: state.blocker } : {}),
    };
  }
  if (!activeV3Successor) {
    return {
      state,
      activeV3Successor: false,
    };
  }
  const activePermit = currentV3Permit(permitChain);
  if (
    !input.config ||
    !activePermit ||
    activePermit.operatorAuthorizationFingerprint !==
      marketBaseResourceOperatorAuthorizationFingerprint(input.config)
  ) {
    state.blocker = "market_base_operator_authorization_mismatch";
    return {
      state,
      activeV3Successor: true,
      blocker: state.blocker,
    };
  }
  if (
    !validateMarketBaseResourcePricingRatchetState(
      state.pricingRatchet,
      activePermit,
    )
  ) {
    state.blocker = "market_base_pricing_ratchet_invalid";
    return {
      state,
      activeV3Successor: true,
      blocker: state.blocker,
    };
  }
  if (!state.ledger) {
    state.blocker = "market_base_v3_ledger_missing";
    return {
      state,
      activeV3Successor: true,
      blocker: state.blocker,
    };
  }
  const ledgerValidation = validateMarketBaseResourceLedger(
    state.ledger,
    input.tick,
    permitChain,
  );
  if (!ledgerValidation.ok) {
    state.blocker = ledgerValidation.reason || "market_base_v3_ledger_invalid";
    return {
      state,
      activeV3Successor: true,
      blocker: state.blocker,
    };
  }
  const anchorValidation = validateMarketBaseResourcePermitChainDominatesAnchor(
    permitChain,
    state.ledger.permitAnchor,
  );
  if (!anchorValidation.ok) {
    state.blocker =
      anchorValidation.reason || "market_base_v3_permit_anchor_invalid";
    return {
      state,
      activeV3Successor: true,
      blocker: state.blocker,
    };
  }
  state.quotaProjection = boundedQuotaProjection(
    state.ledger,
    state.scope,
    input.tick,
  );
  if (input.mode !== "direct") {
    return {
      state,
      activeV3Successor: true,
    };
  }
  const readiness = buildMarketBaseResourceReadinessAuthorization(permitChain, {
    tick: input.tick,
    ttl: 1,
    roster: state.scope.sellerRooms.map(marketBaseResourceSellerRoomBasis),
    lanes: state.scope.laneLifecycles,
  });
  if ("reason" in readiness) {
    // 首个 successor 按合同必须全部 shadow+suspended。没有 enabled grant
    // 因而没有 Energy readiness 是一个健康的零写状态，不应变成持久
    // runtime blocker；Shadow 仍可读取 terminal 的物理事实。
    if (readiness.reason === "readiness_no_enabled_v3_grant") {
      return {
        state,
        activeV3Successor: true,
      };
    }
    state.blocker = readiness.reason;
    return {
      state,
      activeV3Successor: true,
      blocker: state.blocker,
    };
  }
  state.readinessAuthorization = readiness.readinessAuthorization;
  return {
    state,
    activeV3Successor: true,
  };
}

export type MarketBaseResourceScopeReconciliation =
  | {
      ok: true;
      changed: boolean;
      state: MarketBaseResourceScopeState;
      newLaneIds: readonly string[];
      retiredLaneIds: readonly string[];
      stableIdentityUnchanged?: boolean;
    }
  | {
      ok: false;
      blockers: readonly string[];
    };

export interface ReconcileLiveMarketBaseResourceScopeInput {
  tick: number;
  accountIdentity: string;
  observations: readonly MarketBaseRoomObservation[];
  previous?: MarketBaseResourceScopeState;
  expectedPreviousRoomCheckpointCommitment?: string;
  /**
   * 仅允许传入已经由 canonical validator 接受的 current permit chain。
   * reconciliation 会再次独立验证，并且只消费 checkpoint 中仍保留完整
   * discharge record 的 exact laneId；compressed Bloom 永不作为删除证明。
   */
  permitChain?: MarketBaseResourcePermitChainState;
  /**
   * active historical pending 等不在 current permit 中的额外 pin。
   * permitChain 存在时必须显式传入；已确认无 pending 也必须传 `[]`。
   */
  pinnedLaneIds?: readonly string[];
  /** outer activation anchor 保存的 current permit tombstone commitment。 */
  expectedPermitLaneTombstoneCheckpointCommitment?: string;
  /** outer activation anchor 保存的上一 scope discharge commitment。 */
  expectedPreviousLaneTombstoneDischargeCheckpointCommitment?: string;
}

function sealScopeLaneTombstoneCheckpoint(
  checkpoint: ScopeLaneTombstoneCheckpointWithoutCommitment,
): MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint {
  return {
    ...checkpoint,
    checkpointCommitment: canonicalStableHashV1(
      scopeLaneTombstoneCheckpointPayload(checkpoint),
    ),
  };
}

function emptyScopeLaneTombstoneCheckpoint(): MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint {
  return sealScopeLaneTombstoneCheckpoint({
    schemaVersion: 1,
    hashRevision: MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION,
    dischargedCount: 0,
    dischargedPrefixHead:
      MARKET_BASE_RESOURCE_NO_SCOPE_LANE_TOMBSTONE_DISCHARGE,
    lastPermitCheckpointCommitment:
      MARKET_BASE_RESOURCE_NO_SCOPE_LANE_TOMBSTONE_DISCHARGE,
  });
}

function laneTombstoneMatchesDischarge(
  tombstone: MarketBaseResourceScopeLaneTombstone,
  discharge: MarketBaseResourceLaneTombstoneDischarge,
): boolean {
  return (
    tombstone.laneId === discharge.laneId &&
    tombstone.resource === discharge.resource &&
    tombstone.resourcePolicyId === discharge.resourcePolicyId &&
    tombstone.resourcePolicyFingerprint ===
      discharge.resourcePolicyFingerprint &&
    tombstone.roomInstanceId === discharge.roomInstanceId &&
    tombstone.sellerRoomName === discharge.sellerRoom &&
    tombstone.roomFingerprint === discharge.roomFingerprint &&
    tombstone.sharedPolicyFingerprint === discharge.sharedPolicyFingerprint &&
    tombstone.stableFingerprint === discharge.laneStableFingerprint
  );
}

function foldScopeLaneTombstoneCheckpoint(
  checkpoint: MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint,
  tombstone: MarketBaseResourceScopeLaneTombstone,
  discharge: MarketBaseResourceLaneTombstoneDischarge,
  permitCheckpointCommitment: string,
):
  | {
      ok: true;
      checkpoint: MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint;
    }
  | { ok: false; reason: string } {
  const dischargedCount = checkpoint.dischargedCount + 1;
  if (!Number.isSafeInteger(dischargedCount)) {
    return {
      ok: false,
      reason: "derived_lane_tombstone_discharge_count_exhausted",
    };
  }
  return {
    ok: true,
    checkpoint: sealScopeLaneTombstoneCheckpoint({
      schemaVersion: 1,
      hashRevision:
        MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION,
      dischargedCount,
      dischargedPrefixHead: canonicalStableHashV1({
        domain: "market-base-resource:scope-lane-tombstone-discharge-link-v1",
        dischargedCount,
        laneId: tombstone.laneId,
        laneStableFingerprint: tombstone.stableFingerprint,
        permitCheckpointCommitment,
        permitDischargeFingerprint: discharge.dischargeFingerprint,
        previousPrefixHead: checkpoint.dischargedPrefixHead,
        retiredAt: tombstone.retiredAt,
      }),
      lastPermitCheckpointCommitment: permitCheckpointCommitment,
    }),
  };
}

function currentPermitPinnedLaneIds(
  permitChain: MarketBaseResourcePermitChainState,
): readonly string[] {
  const current =
    permitChain.retainedPermits[permitChain.retainedPermits.length - 1];
  return current?.schemaVersion === 3
    ? current.signedLaneGrants.map((grant) => grant.laneId)
    : [];
}

function compareScopeLaneTombstones(
  left: MarketBaseResourceScopeLaneTombstone,
  right: MarketBaseResourceScopeLaneTombstone,
): number {
  return (
    left.retiredAt - right.retiredAt || left.laneId.localeCompare(right.laneId)
  );
}

/**
 * 唯一的动态 roster/lane 派生接线。所有 incarnation、A→B→A、
 * admission 和 active-lane 上界均委托给冻结 policy 模块；运行时只负责
 * 把两个纯结果原子组装成可持久化 scope。
 */
function reconcileLiveMarketBaseResourceScopeCore(
  input: ReconcileLiveMarketBaseResourceScopeInput,
  permitChainRuntimeAuthenticated: boolean,
): MarketBaseResourceScopeReconciliation {
  const sharedPolicy = createMarketBaseSharedPolicy(input.accountIdentity);
  const permitChainHasV3History = Boolean(
    input.permitChain &&
    (input.permitChain.legacyV2GrantSuspended === true ||
      input.permitChain.v2EventCutoverCheckpoint !== undefined ||
      (Array.isArray(input.permitChain.retainedPermits) &&
        input.permitChain.retainedPermits.some(
          (record) => isPlainRecord(record) && record.schemaVersion === 3,
        ))),
  );
  const previousLaneTombstoneDischargeCheckpoint =
    input.previous?.laneTombstoneDischargeCheckpoint;
  const mayInitializeEmptyScopeTombstoneCheckpoint = Boolean(
    input.previous &&
    previousLaneTombstoneDischargeCheckpoint === undefined &&
    input.previous.recentLaneTombstones.length === 0 &&
    input.expectedPreviousLaneTombstoneDischargeCheckpointCommitment ===
      undefined &&
    input.expectedPermitLaneTombstoneCheckpointCommitment === undefined &&
    !permitChainHasV3History,
  );
  let laneTombstoneDischargeCheckpoint =
    previousLaneTombstoneDischargeCheckpoint ??
    emptyScopeLaneTombstoneCheckpoint();
  if (
    input.previous &&
    !mayInitializeEmptyScopeTombstoneCheckpoint &&
    !validScopeLaneTombstoneCheckpoint(previousLaneTombstoneDischargeCheckpoint)
  ) {
    return {
      ok: false,
      blockers: ["derived_lane_tombstone_scope_checkpoint_invalid"],
    };
  }
  if (
    input.expectedPreviousLaneTombstoneDischargeCheckpointCommitment !==
    undefined
  ) {
    if (!input.previous) {
      return {
        ok: false,
        blockers: ["derived_lane_tombstone_previous_scope_missing"],
      };
    }
    if (
      input.expectedPreviousLaneTombstoneDischargeCheckpointCommitment !==
      laneTombstoneDischargeCheckpoint.checkpointCommitment
    ) {
      return {
        ok: false,
        blockers: ["derived_lane_tombstone_scope_checkpoint_rollback"],
      };
    }
  }
  const previousTombstoneError = validateScopeLaneTombstones(
    input.previous?.recentLaneTombstones ?? [],
    input.tick,
  );
  if (previousTombstoneError) {
    return {
      ok: false,
      blockers: [previousTombstoneError],
    };
  }
  const admissionPolicy = createMarketBaseRoomAdmissionPolicy(
    input.accountIdentity,
  );
  const observationNames = new Set<string>();
  const observationShapesValid = input.observations.every((observation) => {
    if (
      !isPlainRecord(observation) ||
      typeof observation.roomName !== "string" ||
      observation.roomName.length === 0 ||
      typeof observation.visible !== "boolean" ||
      typeof observation.controllerMy !== "boolean" ||
      (observation.controllerOwner !== undefined &&
        (typeof observation.controllerOwner !== "string" ||
          observation.controllerOwner.length === 0)) ||
      (observation.terminalId !== undefined &&
        (typeof observation.terminalId !== "string" ||
          observation.terminalId.length === 0)) ||
      typeof observation.terminalOwned !== "boolean" ||
      (observation.roomClass !== "normal" && observation.roomClass !== "hub") ||
      observationNames.has(observation.roomName)
    ) {
      return false;
    }
    observationNames.add(observation.roomName);
    return true;
  });
  const admittedObservations = observationShapesValid
    ? input.observations
        .filter((observation) =>
          marketBaseRoomObservationIsAdmitted(observation, admissionPolicy),
        )
        .sort((left, right) => stableCompare(left.roomName, right.roomName))
    : [];
  const authenticatedStableRoomRead = Boolean(
    permitChainRuntimeAuthenticated &&
    input.previous &&
    observationShapesValid &&
    admittedObservations.length === input.previous.sellerRooms.length &&
    admittedObservations.every((observation, index) => {
      const previous = input.previous!.sellerRooms[index];
      return (
        observation.roomName === previous.roomName &&
        observation.controllerOwner === previous.controllerOwner &&
        observation.terminalId === previous.terminalId &&
        observation.roomClass === previous.roomClass &&
        previous.admissionRevision === admissionPolicy.revision &&
        previous.status === "admitted"
      );
    }) &&
    (input.expectedPreviousRoomCheckpointCommitment === undefined ||
      input.expectedPreviousRoomCheckpointCommitment ===
        input.previous.roomRegistry.checkpointCommitment),
  );
  const roomResult = authenticatedStableRoomRead
    ? {
        ok: true as const,
        changed: false,
        state: input.previous!.roomRegistry,
        sellerRooms: input.previous!.sellerRooms,
      }
    : reconcileMarketBaseSellerRooms({
        tick: input.tick,
        admissionPolicy,
        observations: input.observations,
        previous: input.previous?.roomRegistry,
        expectedPreviousCheckpointCommitment:
          input.expectedPreviousRoomCheckpointCommitment,
      });
  if ("blockers" in roomResult) {
    return {
      ok: false,
      blockers: roomResult.blockers,
    };
  }
  if (
    input.previous &&
    input.tick === input.previous.updatedAt &&
    roomResult.state === input.previous.roomRegistry &&
    input.permitChain === undefined &&
    input.pinnedLaneIds === undefined &&
    input.expectedPreviousRoomCheckpointCommitment === undefined &&
    input.expectedPermitLaneTombstoneCheckpointCommitment === undefined &&
    input.expectedPreviousLaneTombstoneDischargeCheckpointCommitment ===
      undefined
  ) {
    // outer preflight 已在本 tick 完成完整 registry/lane reconciliation；
    // planning 双读仍通过 roomResult 的同 tick observation fingerprint
    // 检查 Game.rooms/terminal/owner/hub 分类是否变化。指纹完全一致时，
    // 复用已认证且冻结的静态 lane scope，避免每次 full read 为最多
    // 112 条 lane 重算 laneId/stable fingerprint/lane-set hash。
    return {
      ok: true,
      changed: false,
      state: input.previous,
      newLaneIds: [],
      retiredLaneIds: [],
    };
  }
  const sellerRoomIdentityUnchanged = Boolean(
    permitChainRuntimeAuthenticated &&
    input.previous &&
    roomResult.sellerRooms.length === input.previous.sellerRooms.length &&
    roomResult.sellerRooms.every((room, index) => {
      const previous = input.previous!.sellerRooms[index];
      return (
        room.roomName === previous.roomName &&
        room.roomInstanceId === previous.roomInstanceId &&
        room.incarnation === previous.incarnation &&
        room.previousInstanceId === previous.previousInstanceId &&
        room.roomClass === previous.roomClass &&
        room.controllerOwner === previous.controllerOwner &&
        room.terminalId === previous.terminalId &&
        room.admissionRevision === previous.admissionRevision &&
        room.status === previous.status &&
        room.fingerprint === previous.fingerprint
      );
    }),
  );
  const laneResult = sellerRoomIdentityUnchanged
    ? {
        ok: true as const,
        blockers: [] as readonly string[],
        lanes: input.previous!.laneLifecycles,
        newLaneIds: [] as readonly string[],
        retiredLaneIds: [] as readonly string[],
        laneSetFingerprint: input.previous!.laneSetFingerprint,
      }
    : reconcileMarketBaseDerivedLanes({
        sharedPolicyFingerprint: sharedPolicy.fingerprint,
        sellerRooms: roomResult.sellerRooms,
        previous: input.previous?.laneLifecycles,
      });
  if (!laneResult.ok || !laneResult.lanes || !laneResult.laneSetFingerprint) {
    return {
      ok: false,
      blockers:
        laneResult.blockers.length > 0
          ? laneResult.blockers
          : ["derived_lane_result_incomplete"],
    };
  }
  const previousLaneById = new Map(
    (input.previous?.laneLifecycles || []).map((lane) => [lane.laneId, lane]),
  );
  const retired = (laneResult.retiredLaneIds || [])
    .map((laneId) => previousLaneById.get(laneId))
    .filter(
      (lane): lane is MarketBaseDerivedLaneLifecycle => lane !== undefined,
    )
    .map((lane) => ({
      ...lane,
      status: "tombstoned" as const,
      retiredAt: input.tick,
    }));
  const recentLaneTombstones = [
    ...(input.previous?.recentLaneTombstones || []),
    ...retired,
  ].sort(compareScopeLaneTombstones);
  const activeLaneIds = new Set(laneResult.lanes.map((lane) => lane.laneId));
  if (
    recentLaneTombstones.some((tombstone) =>
      activeLaneIds.has(tombstone.laneId),
    )
  ) {
    return {
      ok: false,
      blockers: ["derived_lane_tombstone_reintroduced"],
    };
  }
  const nextTombstoneError = validateScopeLaneTombstones(
    recentLaneTombstones,
    input.tick,
  );
  if (nextTombstoneError) {
    return {
      ok: false,
      blockers: [nextTombstoneError],
    };
  }

  let retainedLaneTombstones = recentLaneTombstones;
  if (input.permitChain) {
    const permitValidation = permitChainRuntimeAuthenticated
      ? ({ ok: true } as const)
      : validateMarketBaseResourcePermitChain(input.permitChain);
    if (!permitValidation.ok) {
      return {
        ok: false,
        blockers: [
          `derived_lane_tombstone_permit_invalid:${
            permitValidation.reason || "unknown"
          }`,
        ],
      };
    }
    const permitCheckpointCommitment =
      input.permitChain.laneTombstoneCheckpoint.checkpointCommitment;
    if (
      input.expectedPermitLaneTombstoneCheckpointCommitment !== undefined &&
      input.expectedPermitLaneTombstoneCheckpointCommitment !==
        permitCheckpointCommitment
    ) {
      return {
        ok: false,
        blockers: ["derived_lane_tombstone_permit_checkpoint_rollback"],
      };
    }
    if (input.pinnedLaneIds === undefined) {
      return {
        ok: false,
        blockers: ["derived_lane_tombstone_pin_set_missing"],
      };
    }
    const extraPinnedLaneIds = input.pinnedLaneIds;
    if (
      !Array.isArray(extraPinnedLaneIds) ||
      extraPinnedLaneIds.length >
        MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES +
          MARKET_BASE_RESOURCE_MAX_ACTIVE_LANES +
          1 ||
      new Set(extraPinnedLaneIds).size !== extraPinnedLaneIds.length ||
      extraPinnedLaneIds.some(
        (laneId) =>
          typeof laneId !== "string" ||
          !/^mbr-lane:csh1:[0-9a-f]{32}$/.test(laneId),
      )
    ) {
      return {
        ok: false,
        blockers: ["derived_lane_tombstone_pin_set_invalid"],
      };
    }
    const pinnedLaneIds = new Set([
      ...currentPermitPinnedLaneIds(input.permitChain),
      ...extraPinnedLaneIds,
    ]);
    const exactDischargeByLane = new Map(
      input.permitChain.laneTombstoneCheckpoint.dischargedTombstones.map(
        (discharge) => [discharge.laneId, discharge],
      ),
    );
    const nextRetained: MarketBaseResourceScopeLaneTombstone[] = [];
    for (const tombstone of recentLaneTombstones) {
      const discharge = exactDischargeByLane.get(tombstone.laneId);
      if (!discharge || pinnedLaneIds.has(tombstone.laneId)) {
        nextRetained.push(tombstone);
        continue;
      }
      if (!laneTombstoneMatchesDischarge(tombstone, discharge)) {
        return {
          ok: false,
          blockers: [
            `derived_lane_tombstone_discharge_mismatch:${tombstone.laneId}`,
          ],
        };
      }
      const folded = foldScopeLaneTombstoneCheckpoint(
        laneTombstoneDischargeCheckpoint,
        tombstone,
        discharge,
        permitCheckpointCommitment,
      );
      if ("reason" in folded) {
        return {
          ok: false,
          blockers: [folded.reason],
        };
      }
      laneTombstoneDischargeCheckpoint = folded.checkpoint;
    }
    retainedLaneTombstones = nextRetained;
    if (
      laneTombstoneDischargeCheckpoint.lastPermitCheckpointCommitment !==
      permitCheckpointCommitment
    ) {
      laneTombstoneDischargeCheckpoint = sealScopeLaneTombstoneCheckpoint({
        schemaVersion: 1,
        hashRevision:
          MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION,
        dischargedCount: laneTombstoneDischargeCheckpoint.dischargedCount,
        dischargedPrefixHead:
          laneTombstoneDischargeCheckpoint.dischargedPrefixHead,
        lastPermitCheckpointCommitment: permitCheckpointCommitment,
      });
    }
  } else if (
    input.expectedPermitLaneTombstoneCheckpointCommitment !== undefined
  ) {
    return {
      ok: false,
      blockers: ["derived_lane_tombstone_permit_missing"],
    };
  }
  if (
    retainedLaneTombstones.length > MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES
  ) {
    // pin/checkpoint compaction 必须在 permit 层先证明安全；本层绝不静默
    // 丢弃 tombstone 来换取继续写。
    return {
      ok: false,
      blockers: ["derived_lane_tombstone_bound_exceeded"],
    };
  }
  const rosterFingerprint = currentRosterFingerprint(roomResult.sellerRooms);
  const state: MarketBaseResourceScopeState = {
    schemaVersion: 1,
    accountIdentity: input.accountIdentity,
    sharedPolicyFingerprint: sharedPolicy.fingerprint,
    roomRegistry: roomResult.state,
    sellerRooms: roomResult.sellerRooms,
    laneLifecycles: laneResult.lanes,
    recentLaneTombstones: retainedLaneTombstones,
    laneTombstoneDischargeCheckpoint,
    rosterFingerprint,
    laneSetFingerprint: laneResult.laneSetFingerprint,
    updatedAt: input.tick,
    ...(input.previous?.shadowCursor
      ? { shadowCursor: input.previous.shadowCursor }
      : {}),
  };
  const stableIdentityUnchanged = Boolean(
    permitChainRuntimeAuthenticated &&
    sellerRoomIdentityUnchanged &&
    input.previous &&
    input.previous.roomRegistry.knownRoomNames.length ===
      state.roomRegistry.knownRoomNames.length &&
    input.previous.roomRegistry.knownRoomNames.every((roomName, index) => {
      if (roomName !== state.roomRegistry.knownRoomNames[index]) {
        return false;
      }
      const previous = input.previous!.roomRegistry.rooms[roomName];
      const current = state.roomRegistry.rooms[roomName];
      return Boolean(
        previous &&
        current &&
        previous.roomName === current.roomName &&
        previous.incarnationHighWater === current.incarnationHighWater &&
        previous.lastInstanceId === current.lastInstanceId &&
        previous.admitted === current.admitted &&
        previous.current?.roomInstanceId === current.current?.roomInstanceId &&
        previous.current?.fingerprint === current.current?.fingerprint,
      );
    }) &&
    input.previous.roomRegistry.recentTombstones.length ===
      state.roomRegistry.recentTombstones.length &&
    input.previous.roomRegistry.recentTombstones.every(
      (tombstone, index) =>
        tombstone.fingerprint ===
        state.roomRegistry.recentTombstones[index]?.fingerprint,
    ) &&
    input.previous.recentLaneTombstones.length ===
      state.recentLaneTombstones.length &&
    input.previous.recentLaneTombstones.every(
      (tombstone, index) =>
        tombstone.laneId === state.recentLaneTombstones[index]?.laneId &&
        tombstone.stableFingerprint ===
          state.recentLaneTombstones[index]?.stableFingerprint &&
        tombstone.status === state.recentLaneTombstones[index]?.status,
    ),
  );
  return {
    ok: true,
    changed:
      !input.previous ||
      roomResult.changed ||
      input.previous.rosterFingerprint !== state.rosterFingerprint ||
      input.previous.laneSetFingerprint !== state.laneSetFingerprint,
    state,
    newLaneIds: laneResult.newLaneIds || [],
    retiredLaneIds: laneResult.retiredLaneIds || [],
    ...(stableIdentityUnchanged ? { stableIdentityUnchanged: true } : {}),
  };
}

export function reconcileLiveMarketBaseResourceScope(
  input: ReconcileLiveMarketBaseResourceScopeInput,
): MarketBaseResourceScopeReconciliation {
  return reconcileLiveMarketBaseResourceScopeCore(input, false);
}

// Game.rooms 视图与 hub 配置在同一 tick 内不变，观察结果按 tick 记忆化；
// accountIdentity 参与 terminalOwned 判定，一并进 key。命中返回浅拷贝，
// 隔离下游对数组的 sort/push。
let liveMarketBaseRoomObservationsCache: {
  tick: number;
  accountIdentity: string;
  value: MarketBaseRoomObservation[];
} | undefined;

export function collectLiveMarketBaseRoomObservations(
  accountIdentity: string,
): MarketBaseRoomObservation[] {
  const cached = liveMarketBaseRoomObservationsCache;
  if (
    cached &&
    cached.tick === Game.time &&
    cached.accountIdentity === accountIdentity
  ) {
    return cached.value.slice();
  }
  const hubRoomName =
    Memory.cfg?.hub?.enabled === true ? Memory.cfg.hub.hubRoomName : undefined;
  const value = Object.values(Game.rooms || {})
    .map((room): MarketBaseRoomObservation => {
      const terminal = room.terminal;
      const controllerOwner = room.controller?.owner?.username;
      const terminalOwner = terminal?.owner?.username;
      return {
        roomName: room.name,
        visible: true,
        controllerMy: room.controller?.my === true,
        ...(controllerOwner ? { controllerOwner } : {}),
        ...(terminal?.id ? { terminalId: terminal.id } : {}),
        terminalOwned: Boolean(
          terminal &&
          (terminal.my === true || terminalOwner === accountIdentity),
        ),
        roomClass: room.name === hubRoomName ? "hub" : "normal",
      };
    })
    .sort((left, right) => stableCompare(left.roomName, right.roomName));
  liveMarketBaseRoomObservationsCache = {
    tick: Game.time,
    accountIdentity,
    value,
  };
  return value.slice();
}

export function applyMarketBaseResourceShadowObservations(
  scope: MarketBaseResourceScopeState,
  tick: number,
  observations: readonly MarketBaseResourceShadowObservation[],
  nextShadowCursor: string | undefined,
): MarketBaseResourceScopeState {
  const byLaneId = new Map<string, MarketBaseResourceShadowObservation>();
  const conflictedLaneIds = new Set<string>();
  for (const observation of observations) {
    const laneId = observation.laneId;
    if (conflictedLaneIds.has(laneId)) continue;
    const previous = byLaneId.get(laneId);
    if (!previous) {
      byLaneId.set(laneId, observation);
      continue;
    }
    if (
      canonicalStableHashV1(previous) !== canonicalStableHashV1(observation)
    ) {
      // 同 tick 同 lane 只能有一份确定观测。冲突输入不能靠数组顺序
      // 选赢家，否则重入/合并顺序会虚增 qualification 证据；但冲突也
      // 只是本轮采集异常，不销毁既有周期证据——标记冲突并丢弃该
      // lane 本轮全部观察（含后续重试出现的同 tick 重复），保持 no-op。
      byLaneId.delete(laneId);
      conflictedLaneIds.add(laneId);
    }
  }
  const laneLifecycles = scope.laneLifecycles.map((lane) => {
    const observation = byLaneId.get(lane.laneId);
    if (
      !observation ||
      (lane.stage !== "shadow" && lane.stage !== "qualified") ||
      lane.status !== "suspended"
    ) {
      return lane;
    }
    if (observation.result === "incomplete") {
      // 采集噪声（terminal/protection 单轮不可用、book blocker、CPU
      // 超限降级）只中断本轮推进，不作废已积累证据；持续 incomplete
      // 的 lane 周期停涨，天然保持 fail-closed。真正的证据重置保留
      // 给 tick rollback 与 scope reconcile 的身份/配置层。
      return lane;
    }
    const previousTick = lane.shadowEvidence.lastCompleteTick;
    if (previousTick === tick) {
      // 同 tick 重入不构成新的完整周期。
      return lane;
    }
    const tickRollback = previousTick !== undefined && tick < previousTick;
    if (tickRollback) {
      return {
        ...lane,
        stage: "shadow" as const,
        shadowEvidence: {
          completeCycles: 0,
          lastCompleteTick: tick,
          evidenceDigest: canonicalStableHashV1({
            domain: "market-base-resource:shadow-tick-rollback-v1",
            laneId: lane.laneId,
            previousTick,
            stableFingerprint: lane.stableFingerprint,
            tick,
          }),
        },
      };
    }
    const completeCycles =
      lane.stage === "qualified"
        ? lane.shadowEvidence.completeCycles
        : lane.shadowEvidence.completeCycles + 1;
    const qualified = completeCycles >= 100;
    return {
      ...lane,
      stage: qualified ? ("qualified" as const) : ("shadow" as const),
      shadowEvidence: {
        completeCycles,
        lastCompleteTick: tick,
        evidenceDigest: canonicalStableHashV1({
          completeCycles,
          domain: "market-base-resource:shadow-observation-v1",
          laneId: lane.laneId,
          result: observation.result,
          stableFingerprint: lane.stableFingerprint,
          tick,
        }),
      },
    };
  });
  return {
    ...scope,
    laneLifecycles,
    updatedAt: tick,
    ...(nextShadowCursor ? { shadowCursor: nextShadowCursor } : {}),
  };
}

function createMarketBaseResourceCpuTraceRecorder(
  observedAt: number,
  startedAt: number,
  currentAtEntry: number,
): MarketBaseResourceCpuTraceRecorder {
  return {
    startedAt,
    // 入口读数本身已经属于同一个 outer 25 CPU 窗口。即使后续
    // Game.cpu.getUsed() 回拨，也不能把已观察到的高水位重新打开。
    lastRawDelta: currentAtEntry - startedAt,
    trace: {
      observedAt,
      cpuAfterOuterSession: null,
      cpuAfterScopeCore: null,
      cpuAfterMarketFacts: null,
      cpuAfterShadowBatch: null,
      cpuAfterInnerApply: null,
      cpuCutPhase: null,
      marketFactsDisposition: "not_reached",
    },
  };
}

function cloneMarketBaseResourceCpuTrace(
  recorder: MarketBaseResourceCpuTraceRecorder,
): MarketBaseResourceCpuTrace {
  return { ...recorder.trace };
}

function beginMarketBaseResourceCpuTraceRead(
  recorder: MarketBaseResourceCpuTraceRecorder | undefined,
  readIndex: 1 | 2,
): void {
  if (!recorder || readIndex !== 2) return;
  // 这五个字段描述“当前最终一读”经过的累计 CPU 里程碑。第二读开始后，
  // 第一读的 facts/batch 数值不能与第二读更晚的 scope-core 数值混排，
  // 否则 partial second read 会生成非单调 trace 并被 runtime fail-close
  // 投影整条丢弃。保留 outer/scope，清空尚未由第二读重新到达的后继阶段。
  recorder.trace.cpuAfterMarketFacts = null;
  recorder.trace.cpuAfterShadowBatch = null;
  recorder.trace.cpuAfterInnerApply = null;
  recorder.trace.marketFactsDisposition = "not_reached";
}

const MARKET_BASE_RESOURCE_ACTOR = "marketSaleAutomation:base-resource-v3";

interface MarketBaseResourceCpuFallbackRecipe {
  readonly tick: number;
  readonly baseState: MarketBaseResourceV3RuntimeState;
  readonly baseSession: MarketBaseResourceRuntimeSession;
  readonly scopeBeforePlanning: MarketBaseResourceScopeState;
  readonly ratchetBeforePlanning:
    | MarketBaseResourcePricingRatchetState
    | undefined;
  readonly sampledShadowLaneIds: readonly string[];
  readonly incompleteObservations: readonly MarketBaseResourceShadowObservation[];
  consumed: boolean;
}

const marketBaseResourceCpuFallbackCapabilities = new WeakMap<
  object,
  MarketBaseResourceCpuFallbackRecipe
>();

export interface MarketBaseResourceCpuFallbackResult {
  state: MarketBaseResourceV3RuntimeState;
  ledgerRuntimeAnchor: MarketBaseResourceLedgerRuntimeAnchor;
  readinessRuntimeCapability: MarketBaseResourceReadinessRuntimeCapability;
  /** fallback 管道携带的 incomplete 观察数（apply 层为 no-op，不再清零周期证据）。 */
  appliedResetCount: number;
}

export function advanceMarketBaseResourceReadinessRuntimeCapability(
  capability: MarketBaseResourceReadinessRuntimeCapability | undefined,
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
): MarketBaseResourceReadinessRuntimeCapability | undefined {
  return advanceMarketBaseResourceReadinessRuntimeCapabilityInternal(
    capability,
    state,
    tick,
    false,
  );
}

export function validateMarketBaseResourceReadinessRuntimeCapability(
  capability: MarketBaseResourceReadinessRuntimeCapability | undefined,
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  expectedLedgerRuntimeAnchor?: MarketBaseResourceLedgerRuntimeAnchor,
): boolean {
  if (!capability || typeof capability !== "object") return false;
  const registered = marketBaseResourceReadinessRuntimeCapabilities.get(
    capability as object,
  );
  return Boolean(
    registered &&
    registered.tick === tick &&
    registered.state === state &&
    !marketBaseResourceRuntimeSnapshotMismatch(state, registered.session) &&
    (expectedLedgerRuntimeAnchor === undefined ||
      canonicalStableHashV1(registered.session.ledgerRuntimeAnchor) ===
        canonicalStableHashV1(expectedLedgerRuntimeAnchor)),
  );
}

export function reconcileLiveMarketBaseResourceScopeWithRuntimeCapability(
  input: ReconcileLiveMarketBaseResourceScopeInput,
  state: MarketBaseResourceV3RuntimeState,
  capability: MarketBaseResourceReadinessRuntimeCapability | undefined,
): MarketBaseResourceScopeReconciliation {
  const registered =
    capability && typeof capability === "object"
      ? marketBaseResourceReadinessRuntimeCapabilities.get(capability as object)
      : undefined;
  if (
    !registered ||
    registered.tick !== input.tick ||
    registered.state !== state ||
    state.scope !== input.previous ||
    state.permitChain !== input.permitChain ||
    registered.session.permitSource !== input.permitChain ||
    marketBaseResourceRuntimeSnapshotMismatch(state, registered.session)
  ) {
    return {
      ok: false,
      blockers: ["market_base_scope_runtime_capability_invalid"],
    };
  }
  return reconcileLiveMarketBaseResourceScopeCore(input, true);
}

export function advanceMarketBaseResourceReadinessRuntimeCapabilityFromRoot(
  marketSaleRoot: unknown,
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
): MarketBaseResourceReadinessRuntimeCapability | undefined {
  if (!isPlainRecord(marketSaleRoot)) return undefined;
  const cached =
    marketBaseResourceCanonicalReadinessRuntimeCache.get(marketSaleRoot);
  if (!cached) return undefined;
  const currentSafety = cached.runtimeSession.safetyContext;
  const invariantIdentityUnchanged =
    state.schemaVersion === currentSafety.schemaVersion &&
    state.catalog === currentSafety.catalog &&
    state.cutoverLatched === currentSafety.cutoverLatched &&
    state.blocker === currentSafety.blocker &&
    state.hardBlocker === currentSafety.hardBlocker;
  const currentPricingRatchet = cached.state.pricingRatchet;
  const pricingRatchetChanged =
    state.pricingRatchet !== currentSafety.pricingRatchet;
  const pricingRatchetDominates = Boolean(
    !pricingRatchetChanged ||
      (currentPricingRatchet &&
        state.pricingRatchet &&
        state.pricingRatchet.initializedAt ===
          currentPricingRatchet.initializedAt &&
        state.pricingRatchet.bootstrapFingerprint ===
          currentPricingRatchet.bootstrapFingerprint &&
        validateMarketBaseResourcePricingRatchetState(
          state.pricingRatchet,
          currentV3Permit(cached.permitChain),
        ) &&
        state.pricingRatchet.entries.every((entry, index) => {
          const previous = currentPricingRatchet.entries[index];
          return (
            previous?.resource === entry.resource &&
            entry.value >= previous.value &&
            entry.marketDate >= previous.marketDate
          );
        })),
  );
  const successorSafetyContext =
    !pricingRatchetChanged
      ? currentSafety
      : {
          schemaVersion: state.schemaVersion,
          catalog: state.catalog,
          cutoverLatched: state.cutoverLatched,
          blocker: state.blocker,
          hardBlocker: state.hardBlocker,
          pricingRatchet: state.pricingRatchet,
          invariantCommitment:
            marketBaseResourceRuntimeInvariantCommitment(state),
          pricingRatchetCommitment:
            marketBaseResourceRuntimePricingRatchetCommitment(state),
        };
  if (
    !invariantIdentityUnchanged ||
    !pricingRatchetDominates ||
    !readCachedMarketBaseResourceCanonicalReadiness(
      marketSaleRoot,
      "direct",
      tick,
    ) ||
    cached.tick !== tick ||
    state.ledger !== cached.runtimeSession.ledgerContext.state ||
    !state.permitChain ||
    marketBaseResourceRuntimeSnapshotMismatch(state, {
      ...cached.runtimeSession,
      scopeContext: undefined,
      safetyContext: successorSafetyContext,
    })
  ) {
    return undefined;
  }
  if (
    state.scope !== cached.runtimeSession.scopeContext?.source &&
    validateMarketBaseResourceRuntimeScopeConsistency(state.scope, tick) !==
      undefined
  ) {
    return undefined;
  }
  return issueMarketBaseResourceReadinessRuntimeCapability(
    state,
    {
      ...cached.runtimeSession,
      scopeContext:
        state.scope === cached.runtimeSession.scopeContext?.source
          ? cached.runtimeSession.scopeContext
          : state.scope
            ? createMarketBaseResourceRuntimeScopeContext(state.scope, true)
            : undefined,
      safetyContext: successorSafetyContext,
    },
    tick,
  );
}

function replaceMarketBaseResourceRuntimeScope(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
  scope: MarketBaseResourceScopeState,
): void {
  state.scope = scope;
  if (
    session.scopeContext?.source === scope &&
    session.scopeContext.snapshot === scope &&
    marketBaseResourceRuntimeDeepFrozenValues.has(scope)
  ) {
    return;
  }
  session.scopeContext = createMarketBaseResourceRuntimeScopeContext(
    scope,
    true,
  );
}

function replaceMarketBaseResourceRuntimePricingRatchet(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
  pricingRatchet: MarketBaseResourcePricingRatchetState | undefined,
): void {
  state.pricingRatchet = pricingRatchet;
  if (
    session.safetyContext.pricingRatchet === pricingRatchet &&
    (pricingRatchet === undefined ||
      marketBaseResourceRuntimeDeepFrozenValues.has(pricingRatchet))
  ) {
    return;
  }
  session.safetyContext = {
    ...session.safetyContext,
    pricingRatchet,
    pricingRatchetCommitment:
      marketBaseResourceRuntimePricingRatchetCommitment(state),
  };
}

function boundedCpuFallbackIncompleteObservations(
  scope: MarketBaseResourceScopeState,
  sampledShadowLaneIds: readonly string[],
  observations: readonly MarketBaseResourceShadowObservation[],
): MarketBaseResourceShadowObservation[] | undefined {
  if (
    sampledShadowLaneIds.length >
      MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE ||
    new Set(sampledShadowLaneIds).size !== sampledShadowLaneIds.length ||
    observations.length > MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE ||
    new Set(observations.map((observation) => observation.laneId)).size !==
      observations.length
  ) {
    return undefined;
  }
  const sampled = new Set(sampledShadowLaneIds);
  const laneById = new Map(
    scope.laneLifecycles.map((lane) => [lane.laneId, lane]),
  );
  if (
    observations.some((observation) => {
      const lane = laneById.get(observation.laneId);
      return (
        observation.result !== "incomplete" ||
        !sampled.has(observation.laneId) ||
        !lane ||
        (lane.stage !== "shadow" && lane.stage !== "qualified") ||
        lane.status !== "suspended"
      );
    })
  ) {
    return undefined;
  }
  // 已经处于零周期 Shadow 的 lane 没有任何正向资格可随 fallback 携带。outer CPU
  // cut 时不为 no-op 观察强迫构造第二份 canonical root；一旦存在正向周期或
  // qualified 状态，仍通过 fallback 管道携带 incomplete（apply 层为 no-op，
  // 仅保证 canonical commit 语义与诊断可见性）。
  return observations
    .filter((observation) => {
      const lane = laneById.get(observation.laneId)!;
      return (
        lane.stage === "qualified" || lane.shadowEvidence.completeCycles > 0
      );
    })
    .map((observation) => ({
      laneId: observation.laneId,
      result: "incomplete" as const,
      ...(observation.blocker
        ? { blocker: observation.blocker.slice(0, 160) }
        : {}),
    }));
}

function isPureSuspendedShadowCpuFallbackState(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
  scope: MarketBaseResourceScopeState,
): boolean {
  const permit = currentV3Permit(session.permitContext.state);
  if (
    !permit ||
    state.readinessAuthorization !== undefined ||
    state.proposedPermit !== undefined ||
    state.ledger?.pending !== undefined ||
    state.ledger?.blocker !== undefined ||
    scope.laneLifecycles.length !== permit.signedLaneGrants.length
  ) {
    return false;
  }
  const scopeLaneIds = new Set(
    scope.laneLifecycles.map((lane) => lane.laneId),
  );
  return (
    scopeLaneIds.size === scope.laneLifecycles.length &&
    scope.laneLifecycles.every(
      (lane) =>
        (lane.stage === "shadow" || lane.stage === "qualified") &&
        lane.status === "suspended",
    ) &&
    permit.signedLaneGrants.every(
      (grant) =>
        scopeLaneIds.has(grant.laneId) &&
        grant.status === "active" &&
        (grant.stage === "shadow" || grant.stage === "qualified") &&
        grant.newDealGrant === "suspended",
    )
  );
}

function issueMarketBaseResourceCpuFallbackCapability(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
  scopeBeforePlanning: MarketBaseResourceScopeState,
  ratchetBeforePlanning: MarketBaseResourcePricingRatchetState | undefined,
  sampledShadowLaneIds: readonly string[],
  observations: readonly MarketBaseResourceShadowObservation[],
  tick: number,
): MarketBaseResourceCpuFallbackCapability | undefined {
  const incompleteObservations = boundedCpuFallbackIncompleteObservations(
    scopeBeforePlanning,
    sampledShadowLaneIds,
    observations,
  );
  const baseState: MarketBaseResourceV3RuntimeState = {
    ...state,
    scope: scopeBeforePlanning,
    pricingRatchet: ratchetBeforePlanning,
  };
  const baseSession: MarketBaseResourceRuntimeSession = {
    ...session,
    ...(session.scopeContext
      ? { scopeContext: { ...session.scopeContext } }
      : {}),
    safetyContext: { ...session.safetyContext },
  };
  if (
    !incompleteObservations ||
    session.ledgerContext.tick !== tick ||
    session.permitContext.tick !== tick ||
    baseSession.scopeContext?.snapshot !== scopeBeforePlanning ||
    marketBaseResourceRuntimeSnapshotMismatch(baseState, baseSession)
  ) {
    return undefined;
  }
  const capability = Object.freeze({});
  marketBaseResourceCpuFallbackCapabilities.set(capability, {
    tick,
    baseState,
    baseSession,
    scopeBeforePlanning,
    ratchetBeforePlanning,
    sampledShadowLaneIds: [...sampledShadowLaneIds],
    incompleteObservations,
    consumed: false,
  });
  return capability as MarketBaseResourceCpuFallbackCapability;
}

function validMarketBaseResourceCpuTrace(
  trace: MarketBaseResourceCpuTrace,
  tick: number,
  requireCut: boolean,
): boolean {
  const cpuValues = [
    trace.cpuAfterOuterSession,
    trace.cpuAfterScopeCore,
    trace.cpuAfterMarketFacts,
    trace.cpuAfterShadowBatch,
    trace.cpuAfterInnerApply,
  ];
  const values = cpuValues.filter((value): value is number => value !== null);
  const firstNullIndex = cpuValues.findIndex((value) => value === null);
  return (
    trace.observedAt === tick &&
    (firstNullIndex < 0 ||
      cpuValues.slice(firstNullIndex).every((value) => value === null)) &&
    values.every(
      (value) =>
        Number.isFinite(value) &&
        value >= 0 &&
        value <= MARKET_BASE_RESOURCE_CPU_TRACE_MAX,
    ) &&
    values.every((value, index) => index === 0 || value >= values[index - 1]!) &&
    (!requireCut || trace.cpuCutPhase !== null) &&
    (trace.cpuCutPhase === null ||
      [
        "outer_session",
        "scope_core_read1",
        "scope_core_read2",
        "market_facts_read1",
        "market_facts_read2",
        "shadow_batch_read1",
        "shadow_batch_read2",
        "inner_apply",
        "outer_precommit",
      ].includes(trace.cpuCutPhase)) &&
    (trace.marketFactsDisposition === "not_reached" ||
      trace.marketFactsDisposition === "skipped_no_consumer" ||
      trace.marketFactsDisposition === "read")
  );
}

export function observeMarketBaseResourceOuterPrecommitCpu(
  source: MarketBaseResourceCpuTrace,
  startedAt: number,
  current: number,
  suppliedRawHighWater?: number,
): {
  trace: MarketBaseResourceCpuTrace;
  exceeded: boolean;
  rawDelta?: number;
} {
  const trace = { ...source };
  const priorValues = [
    trace.cpuAfterOuterSession,
    trace.cpuAfterScopeCore,
    trace.cpuAfterMarketFacts,
    trace.cpuAfterShadowBatch,
    trace.cpuAfterInnerApply,
  ].filter((value): value is number => value !== null);
  // 即使输入来自旧 bundle 或部分损坏的跨读 trace，也不能用“最后一个”
  // 较小字段放宽 CPU 回拨检查；历史最大 raw delta 才是单调高水位。
  const tracePrior = priorValues.length > 0 ? Math.max(...priorValues) : 0;
  const rawHighWaterProvided = suppliedRawHighWater !== undefined;
  const rawHighWaterInvalid =
    rawHighWaterProvided &&
    (!Number.isFinite(suppliedRawHighWater) ||
      suppliedRawHighWater! < 0 ||
      suppliedRawHighWater! < tracePrior);
  const prior = rawHighWaterProvided ? suppliedRawHighWater! : tracePrior;
  const rawDelta = current - startedAt;
  const invalid =
    rawHighWaterInvalid ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(current) ||
    current < startedAt ||
    !Number.isFinite(rawDelta) ||
    rawDelta < prior;
  // inner 一旦记录任何 first-cut（包含未超过 25 但观测回拨/无效），outer
  // 只能继续 fail closed，不能被较小的 fresh read “重新打开”。
  const exceeded =
    source.cpuCutPhase !== null ||
    invalid ||
    rawDelta > MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING;
  if (exceeded) trace.cpuCutPhase ??= "outer_precommit";
  return invalid ? { trace, exceeded: true } : { trace, exceeded, rawDelta };
}

export function marketBaseResourceCpuFallbackRequiresCanonicalCommit(
  capability: MarketBaseResourceCpuFallbackCapability | undefined,
  canonicalSource: MarketBaseResourceV3RuntimeState,
  tick: number,
): boolean {
  if (!capability || typeof capability !== "object") return false;
  const recipe = marketBaseResourceCpuFallbackCapabilities.get(
    capability as object,
  );
  if (!recipe || recipe.consumed || recipe.tick !== tick) return false;
  if (recipe.incompleteObservations.length > 0) return true;
  const keys = new Set([
    ...Object.keys(canonicalSource),
    ...Object.keys(recipe.baseState),
  ]);
  for (const key of keys) {
    if (key === "lastPlanningSnapshot") continue;
    if (
      (canonicalSource as unknown as Record<string, unknown>)[key] !==
      (recipe.baseState as unknown as Record<string, unknown>)[key]
    ) {
      return true;
    }
  }
  return false;
}

export function materializeMarketBaseResourceCpuFallback(
  capability: MarketBaseResourceCpuFallbackCapability | undefined,
  trace: MarketBaseResourceCpuTrace,
  blocker:
    | "market_base_cpu_ceiling_exceeded"
    | "market_base_v3_returned_anchor_missing_or_invalid" =
    "market_base_cpu_ceiling_exceeded",
): MarketBaseResourceCpuFallbackResult | undefined {
  if (!capability || typeof capability !== "object") return undefined;
  const recipe = marketBaseResourceCpuFallbackCapabilities.get(
    capability as object,
  );
  if (!recipe || recipe.consumed) return undefined;
  recipe.consumed = true;
  if (
    !validMarketBaseResourceCpuTrace(
      trace,
      recipe.tick,
      blocker === "market_base_cpu_ceiling_exceeded",
    ) ||
    marketBaseResourceRuntimeSnapshotMismatch(
      recipe.baseState,
      recipe.baseSession,
    )
  ) {
    return undefined;
  }
  const resetScope = applyMarketBaseResourceShadowObservations(
    recipe.scopeBeforePlanning,
    recipe.tick,
    recipe.incompleteObservations,
    undefined,
  );
  if (
    resetScope.shadowCursor !== recipe.scopeBeforePlanning.shadowCursor ||
    recipe.incompleteObservations.length >
      MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE
  ) {
    return undefined;
  }
  const previous = recipe.baseState.lastPlanningSnapshot;
  const latestCpu = [
    trace.cpuAfterOuterSession,
    trace.cpuAfterScopeCore,
    trace.cpuAfterMarketFacts,
    trace.cpuAfterShadowBatch,
    trace.cpuAfterInnerApply,
  ].reduce<number>(
    (latest, value) => (value === null ? latest : Math.max(latest, value)),
    blocker === "market_base_cpu_ceiling_exceeded"
      ? MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING
      : 0,
  );
  const fallbackSnapshot: MarketBaseResourcePlanningSnapshot = {
    ...(previous || {
      observedAt: recipe.tick,
      sampledShadowLaneIds: [],
      rawOrderCount: 0,
      eligibleOrderCount: 0,
      distinctOrderRoomCount: 0,
      transactionCostEvaluationBudget: 0,
      shadowPlannerMode: "none" as const,
      shadowPlannerInvocationCount: 0,
      actualTransactionEnergyEvaluations: 0,
      evaluatedShadowResourceCount: 0,
      candidateIdentityOrderChecks: 0,
    }),
    observedAt: recipe.tick,
    complete: false,
    blocker,
    cpuUsed: latestCpu,
    cpuTrace: { ...trace },
  };
  delete fallbackSnapshot.selected;
  const fallbackState: MarketBaseResourceV3RuntimeState = {
    ...recipe.baseState,
    scope: resetScope,
    pricingRatchet: recipe.ratchetBeforePlanning,
    lastPlanningSnapshot: fallbackSnapshot,
  };
  const fallbackSession: MarketBaseResourceRuntimeSession = {
    ...recipe.baseSession,
    scopeContext:
      resetScope === recipe.scopeBeforePlanning
        ? recipe.baseSession.scopeContext
        : createMarketBaseResourceRuntimeScopeContext(resetScope, true),
    safetyContext: { ...recipe.baseSession.safetyContext },
  };
  const readinessRuntimeCapability =
    issueMarketBaseResourceReadinessRuntimeCapability(
      fallbackState,
      fallbackSession,
      recipe.tick,
    );
  if (!readinessRuntimeCapability) return undefined;
  return {
    state: fallbackState,
    ledgerRuntimeAnchor: fallbackSession.ledgerRuntimeAnchor,
    readinessRuntimeCapability,
    appliedResetCount: recipe.incompleteObservations.length,
  };
}

function applyMarketBaseResourceRuntimeLedgerOperation(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
  operation: {
    readonly state: MarketBaseResourceLedger;
    readonly runtimeAnchor: MarketBaseResourceLedgerRuntimeAnchor;
    readonly runtimeContext: MarketBaseResourceLedgerRuntimeContext;
  },
): void {
  state.ledger = operation.state;
  session.ledgerContext = operation.runtimeContext;
  session.ledgerRuntimeAnchor = operation.runtimeAnchor;
}

function incrementReason(
  target: Record<string, number>,
  reason: string,
  count = 1,
): void {
  target[reason] = (target[reason] || 0) + count;
}

function boundedReason(reason: unknown): string | undefined {
  return typeof reason === "string" && reason.length > 0
    ? reason.slice(0, 160)
    : undefined;
}

function latchMarketBaseResourceHardBlocker(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  code: string,
  detail: unknown,
): void {
  const existing = state.hardBlocker;
  if (existing) {
    state.blocker = existing.code;
    return;
  }
  state.hardBlocker = {
    code: code.slice(0, 160),
    detectedAt: tick,
    detailHash: canonicalStableHashV1({
      code,
      detail,
      domain: "market-base-resource:hard-blocker-v1",
      tick,
    }),
  };
  state.blocker = state.hardBlocker.code;
}

function canonicalEnergyShadowComponents(
  components: MarketBaseResourceRuntimeCandidate["energyShadowComponents"],
): MarketBaseResourceRuntimeCandidate["energyShadowComponents"] {
  return {
    hardFloor: components.hardFloor,
    ...(components.explicit !== undefined
      ? { explicit: components.explicit }
      : {}),
    ...(components.historyFloor !== undefined
      ? { historyFloor: components.historyFloor }
      : {}),
    ...(components.ratchetFloor !== undefined
      ? { ratchetFloor: components.ratchetFloor }
      : {}),
  };
}

function candidateEnergyEvidence(
  candidate: MarketBaseResourceRuntimeCandidate,
  tick: number,
  maxAgeTicks: number,
  trustedEnergyFloor: MarketBaseResourceTrustedFloorObservation,
): boolean {
  const components = candidate.energyShadowComponents;
  const componentValues = [
    components?.hardFloor,
    components?.explicit,
    components?.historyFloor,
    components?.ratchetFloor,
  ].filter((value): value is number => value !== undefined);
  const expectedEffective =
    componentValues.length > 0 ? Math.max(...componentValues) : Number.NaN;
  return (
    Number.isFinite(candidate.effectiveEnergyShadowPrice) &&
    candidate.effectiveEnergyShadowPrice > 0 &&
    Number.isSafeInteger(candidate.energyShadowObservedAt) &&
    candidate.energyShadowObservedAt <= tick &&
    tick - candidate.energyShadowObservedAt <= maxAgeTicks &&
    Number.isFinite(components?.hardFloor) &&
    components.hardFloor > 0 &&
    (components.explicit === undefined ||
      (Number.isFinite(components.explicit) && components.explicit > 0)) &&
    (components.historyFloor === undefined ||
      (Number.isFinite(components.historyFloor) &&
        components.historyFloor > 0)) &&
    Number.isFinite(components.ratchetFloor) &&
    (components.ratchetFloor as number) > 0 &&
    components.ratchetFloor === trustedEnergyFloor.value &&
    candidate.energyShadowObservedAt === trustedEnergyFloor.updatedAt &&
    Number.isFinite(expectedEffective) &&
    Math.abs(candidate.effectiveEnergyShadowPrice - expectedEffective) < 1e-9
  );
}

function candidateProtectionComplete(
  candidate: MarketBaseResourceRuntimeCandidate,
  tick: number,
): boolean {
  const entry = candidate.protectionEntry;
  return (
    entry.roomName === candidate.roomName &&
    entry.resource === candidate.resourceType &&
    isMarketProtectionEntryFresh(entry, tick) &&
    !entry.blocked &&
    getMarketProtectionSellableAmount(entry, tick) === entry.sellableAmount
  );
}

function candidatePricingComplete(
  candidate: MarketBaseResourceRuntimeCandidate,
  signedRatchetHighWater: number,
  stateRatchetHighWater: number,
  trustedFloor: MarketBaseResourceTrustedFloorObservation,
  dynamicFloor?: number,
  projection?: import("@/runtime/marketBaseResourcePolicy").MarketBaseDynamicFloorState,
  tick = Game.time,
): boolean {
  const policy =
    MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[candidate.resourceType];
  // enforce 对称重算：dynamicFloor 有效时替代 {history, ratchet} 分量，
  // 与 adapter 侧 computeEffectiveNetFloor 的分支保持同一映射来源
  //（state.dynamicFloorProjection，本 tick 内不变），否则整轮
  // candidate_incomplete fail-closed。
  const normalFloor =
    dynamicFloor !== undefined && Number.isFinite(dynamicFloor)
      ? Math.max(policy.hardFloor, policy.economicFloor, dynamicFloor)
      : Math.max(
          policy.hardFloor,
          policy.economicFloor,
          candidate.historyFloor,
          trustedFloor.value,
        );
  const effectiveFloor = candidate.overflowTier === undefined ? normalFloor
    : baseMineralOverflowNetFloor(candidate.protectionEntry, tick, normalFloor, projection);
  const bootstrapRatchet =
    MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[candidate.resourceType]
      .ratchetFloor;
  return (
    (candidate.overflowTier === undefined || candidate.overflowTier === liveBaseMineralOverflow(candidate.protectionEntry, tick).tier) &&
    candidate.historyTrusted === true &&
    Number.isFinite(candidate.historyFloor) &&
    candidate.historyFloor > 0 &&
    Number.isFinite(candidate.ratchetFloor) &&
    candidate.ratchetFloor >= bootstrapRatchet &&
    candidate.ratchetFloor >= signedRatchetHighWater &&
    candidate.ratchetFloor >= stateRatchetHighWater &&
    candidate.ratchetFloor === trustedFloor.value &&
    Number.isFinite(candidate.effectiveNetFloor) &&
    Math.abs(candidate.effectiveNetFloor - effectiveFloor) < 1e-9 &&
    candidate.rejectionReasons.length === 0
  );
}

interface MarketBaseResourceStaticReadAttestation {
  readonly configSource: ResolvedMarketSaleAutomationConfig;
  readonly scopeSource: MarketBaseResourceScopeState;
  readonly scope: MarketBaseResourceScopeState;
  readonly permitChainSource: MarketBaseResourcePermitChainState;
  readonly ledgerSource: MarketBaseResourceLedger;
  readonly permit: MarketBaseResourcePermit;
  readonly currentPricingRatchet: MarketBaseResourcePricingRatchetState;
  readonly currentRatchetByResource: ReadonlyMap<
    MarketBaseResource,
    MarketBaseResourcePricingRatchetState["entries"][number]
  >;
  readonly signedRatchetByResource: ReadonlyMap<
    MarketBaseResource,
    MarketBaseResourcePermit["ratchetHighWater"][number]
  >;
  readonly accountIdentity: string;
  readonly executorShard: typeof AUTHORITY_EXECUTOR_SHARD;
  readonly mode: "direct";
  readonly planningSnapshotMaxAgeTicks: number;
}

type MarketBaseResourceStaticReadAttestationResult =
  | {
      readonly ok: true;
      readonly attestation: MarketBaseResourceStaticReadAttestation;
    }
  | { readonly ok: false; readonly reason: string };

function createMarketBaseResourceStaticReadAttestation(
  state: MarketBaseResourceV3RuntimeState,
  input: MarketBaseResourceAutomationInput,
  dependencies: MarketBaseResourceRuntimeDependencies,
  session: MarketBaseResourceRuntimeSession,
): MarketBaseResourceStaticReadAttestationResult {
  try {
    const directFingerprint = directSafetyFingerprint(input.config);
    const directFingerprintPayload =
      typeof directFingerprint === "string" &&
      directFingerprint !==
        MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT
        ? (JSON.parse(directFingerprint) as unknown)
        : undefined;
    const configReasons: readonly string[] =
      directFingerprint ===
      MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT
        ? []
        : isPlainRecord(directFingerprintPayload) &&
            Array.isArray(directFingerprintPayload.mismatchReasons) &&
            directFingerprintPayload.mismatchReasons.every(
              (reason) => typeof reason === "string",
            )
          ? (directFingerprintPayload.mismatchReasons as string[])
          : ["market_base_v3_config_invalid"];
    if (!input.config.validForPlanning || configReasons.length > 0) {
      return {
        ok: false,
        reason: configReasons[0] || "market_base_v3_config_invalid",
      };
    }
    if (input.config.mode !== "direct" || !session.scopeContext) {
      return {
        ok: false,
        reason: "market_base_v3_runtime_context_mismatch",
      };
    }
    const permitChain = session.permitContext.state;
    const ledger = session.ledgerContext.state;
    if (
      permitChain.blocker ||
      ledger.blocker ||
      !permitChain.v2EventCutoverCheckpoint ||
      permitChain.legacyV2GrantSuspended !== true
    ) {
      return {
        ok: false,
        reason:
          permitChain.blocker?.code ||
          ledger.blocker?.code ||
          "market_base_v3_chain_incomplete",
      };
    }
    const accountIdentity = dependencies.readAccountIdentity();
    const executorShard = dependencies.readExecutorShard();
    const permit = currentV3Permit(permitChain);
    const currentPricingRatchet = state.pricingRatchet;
    if (
      !accountIdentity ||
      executorShard !== AUTHORITY_EXECUTOR_SHARD ||
      !permit ||
      permit.accountIdentity !== accountIdentity ||
      permit.executorShard !== executorShard ||
      permit.operatorAuthorizationFingerprint !==
        marketBaseResourceOperatorAuthorizationFingerprintFromDirectSafety(
          directFingerprint,
        ) ||
      permit.sharedPolicy.fingerprint !==
        session.scopeContext.snapshot.sharedPolicyFingerprint ||
      !validateMarketBaseResourcePricingRatchetState(
        currentPricingRatchet,
        permit,
      )
    ) {
      return { ok: false, reason: "market_base_v3_permit_identity_mismatch" };
    }
    const currentRatchetByResource = new Map(
      currentPricingRatchet.entries.map((entry) => [entry.resource, entry]),
    );
    const signedRatchetByResource = new Map(
      permit.ratchetHighWater.map((entry) => [entry.resource, entry]),
    );
    if (
      currentRatchetByResource.size !== MARKET_BASE_RESOURCE_CATALOG.length ||
      signedRatchetByResource.size !== MARKET_BASE_RESOURCE_CATALOG.length
    ) {
      return { ok: false, reason: "market_base_v3_permit_identity_mismatch" };
    }
    // Resolved config 是本次调用的 detached normalized snapshot。把 exact
    // source 递归冻结并登记私有 provenance，随后两读可用 identity 证明
    // candidate/book callback 没有原位改写 config，无需重复整棵 canonical
    // hash；任何写入尝试都会抛错并由 live read fail closed。
    const configSource = freezeMarketBaseResourceRuntimeSnapshot(input.config);
    return {
      ok: true,
      attestation: Object.freeze({
        configSource,
        scopeSource: session.scopeContext.source,
        scope: session.scopeContext.snapshot,
        permitChainSource: session.permitSource,
        ledgerSource: session.ledgerContext.state,
        permit,
        currentPricingRatchet,
        currentRatchetByResource,
        signedRatchetByResource,
        accountIdentity,
        executorShard,
        mode: input.config.mode,
        planningSnapshotMaxAgeTicks: input.config.planningSnapshotMaxAgeTicks,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        boundedReason(error instanceof Error ? error.message : error) ||
        "market_base_v3_static_read_attestation_failed",
    };
  }
}

function marketBaseResourceStaticReadAttestationMismatch(
  state: MarketBaseResourceV3RuntimeState,
  input: MarketBaseResourceAutomationInput,
  session: MarketBaseResourceRuntimeSession,
  attestation: MarketBaseResourceStaticReadAttestation,
): string | undefined {
  return input.config !== attestation.configSource ||
    !marketBaseResourceRuntimeDeepFrozenValues.has(attestation.configSource) ||
    state.scope !== attestation.scopeSource ||
    session.scopeContext?.source !== attestation.scopeSource ||
    session.scopeContext.snapshot !== attestation.scope ||
    state.permitChain !== attestation.permitChainSource ||
    session.permitSource !== attestation.permitChainSource ||
    state.ledger !== attestation.ledgerSource ||
    session.ledgerContext.state !== attestation.ledgerSource ||
    state.pricingRatchet !== attestation.currentPricingRatchet
    ? "market_base_v3_static_read_attestation_mismatch"
    : undefined;
}

function authenticatedStableMarketBaseResourceScope(
  scope: MarketBaseResourceScopeState,
  tick: number,
  accountIdentity: string,
  observations: readonly MarketBaseRoomObservation[],
): MarketBaseResourceScopeState | undefined {
  if (
    scope.updatedAt !== tick ||
    !marketBaseResourceRuntimeDeepFrozenValues.has(scope)
  ) {
    return undefined;
  }
  const admissionPolicy = createMarketBaseRoomAdmissionPolicy(accountIdentity);
  const names = new Set<string>();
  const admitted: MarketBaseRoomObservation[] = [];
  for (const observation of observations) {
    if (
      !isPlainRecord(observation) ||
      typeof observation.roomName !== "string" ||
      observation.roomName.length === 0 ||
      typeof observation.visible !== "boolean" ||
      typeof observation.controllerMy !== "boolean" ||
      (observation.controllerOwner !== undefined &&
        (typeof observation.controllerOwner !== "string" ||
          observation.controllerOwner.length === 0)) ||
      (observation.terminalId !== undefined &&
        (typeof observation.terminalId !== "string" ||
          observation.terminalId.length === 0)) ||
      typeof observation.terminalOwned !== "boolean" ||
      (observation.roomClass !== "normal" && observation.roomClass !== "hub") ||
      names.has(observation.roomName)
    ) {
      return undefined;
    }
    names.add(observation.roomName);
    if (marketBaseRoomObservationIsAdmitted(observation, admissionPolicy)) {
      admitted.push(observation);
    }
  }
  admitted.sort((left, right) => stableCompare(left.roomName, right.roomName));
  if (
    admitted.length !== scope.sellerRooms.length ||
    admitted.some((observation, index) => {
      const room = scope.sellerRooms[index];
      return (
        !room ||
        observation.roomName !== room.roomName ||
        observation.controllerOwner !== room.controllerOwner ||
        observation.terminalId !== room.terminalId ||
        observation.roomClass !== room.roomClass ||
        room.admissionRevision !== admissionPolicy.revision ||
        room.status !== "admitted"
      );
    })
  ) {
    return undefined;
  }
  return scope;
}

function sameMarketBaseQuotaLayer(
  left: MarketBaseResourceQuotaSnapshot["global"],
  right: MarketBaseResourceQuotaSnapshot["global"],
): boolean {
  return (
    left.key === right.key &&
    left.limit === right.limit &&
    left.confirmedActual === right.confirmedActual &&
    left.unmatchedPlanned === right.unmatchedPlanned &&
    left.used === right.used &&
    left.remaining === right.remaining
  );
}

function sameMarketBasePricingBasis(
  left: MarketBaseResourceRuntimeCandidate,
  right: MarketBaseResourceRuntimeCandidate,
): boolean {
  return (
    Object.is(left.historyFloor, right.historyFloor) &&
    left.historyTrusted === right.historyTrusted &&
    Object.is(left.ratchetFloor, right.ratchetFloor) &&
    Array.isArray(left.rejectionReasons) &&
    Array.isArray(right.rejectionReasons) &&
    left.rejectionReasons.length === right.rejectionReasons.length &&
    left.rejectionReasons.every(
      (reason, index) => reason === right.rejectionReasons[index],
    )
  );
}

function liveScopeForRead(
  state: MarketBaseResourceV3RuntimeState,
  input: MarketBaseResourceAutomationInput,
  dependencies: MarketBaseResourceRuntimeDependencies,
  session: MarketBaseResourceRuntimeSession,
  staticAttestationResult: MarketBaseResourceStaticReadAttestationResult,
  cpuTraceRecorder?: MarketBaseResourceCpuTraceRecorder,
  readIndex: 1 | 2 = 1,
): MarketBaseResourcePlanningScopeSnapshot {
  const incomplete = (
    blocker: string,
  ): MarketBaseResourcePlanningScopeSnapshot => ({
    complete: false,
    blocker,
    scopeEvidence: "",
    currentRosterFingerprint: "",
    currentLaneSetFingerprint: "",
    activeRoomCount: 0,
    knownRoomNameCount: 0,
    activeLaneCount: 0,
    entries: [],
    energyShadow: {
      complete: false,
      revision: "",
      price: 0,
    },
    globalQuota: {
      complete: false,
      revision: "",
      rollingCap: MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
    },
    writeContext: {
      complete: false,
      revision: "",
      credits: 0,
      executorShard: "",
      permitEpoch: 0,
      permitId: "",
      permitHead: "",
      pendingState: "gap",
      arbiterState: "blocked",
    },
  });
  beginMarketBaseResourceCpuTraceRead(cpuTraceRecorder, readIndex);
  try {
    const runtimeMismatch = marketBaseResourceRuntimeSnapshotMismatch(
      state,
      session,
    );
    if (runtimeMismatch) {
      return incomplete(runtimeMismatch);
    }
    if ("reason" in staticAttestationResult) {
      return incomplete(staticAttestationResult.reason);
    }
    const staticAttestation = staticAttestationResult.attestation;
    const staticMismatch = marketBaseResourceStaticReadAttestationMismatch(
      state,
      input,
      session,
      staticAttestation,
    );
    if (staticMismatch) {
      return incomplete(staticMismatch);
    }
    const canonicalScope = staticAttestation.scope;
    const canonicalLedger = session.ledgerContext.state;
    const accountIdentity = staticAttestation.accountIdentity;
    const executorShard = staticAttestation.executorShard;
    const permit = staticAttestation.permit;
    let trustedFloors:
      | Partial<
          Record<
            MarketBaseResourceTrustedFloorResource,
            MarketBaseResourceTrustedFloorObservation
          >
        >
      | undefined;
    try {
      trustedFloors = dependencies.readTrustedFloors();
    } catch {
      trustedFloors = undefined;
    }
    const trustedEnergyFloor = trustedFloors?.[RESOURCE_ENERGY];
    if (
      !trustedEnergyFloor ||
      !Number.isFinite(trustedEnergyFloor.value) ||
      trustedEnergyFloor.value <= 0 ||
      typeof trustedEnergyFloor.marketDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(trustedEnergyFloor.marketDate) ||
      !Number.isSafeInteger(trustedEnergyFloor.updatedAt) ||
      trustedEnergyFloor.updatedAt < 0 ||
      trustedEnergyFloor.updatedAt > input.tick
    ) {
      return incomplete("market_base_v3_energy_trusted_floor_invalid");
    }
    const currentPricingRatchet = staticAttestation.currentPricingRatchet;
    const nextPricingEntries: Array<{
      resource: MarketBaseResource;
      value: number;
      marketDate: string;
    }> = [];
    for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
      const trusted = trustedFloors?.[resource];
      const current = staticAttestation.currentRatchetByResource.get(resource);
      const signed = staticAttestation.signedRatchetByResource.get(resource);
      const changed = Boolean(
        trusted &&
        current &&
        (trusted.value !== current.value ||
          trusted.marketDate !== current.marketDate),
      );
      if (
        !trusted ||
        !current ||
        !signed ||
        !Number.isFinite(trusted.value) ||
        trusted.value <= 0 ||
        typeof trusted.marketDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(trusted.marketDate) ||
        !Number.isSafeInteger(trusted.updatedAt) ||
        trusted.updatedAt < 0 ||
        trusted.updatedAt > input.tick ||
        trusted.value < current.value ||
        trusted.value < signed.ratchetFloor ||
        trusted.marketDate < current.marketDate ||
        (changed && trusted.updatedAt !== input.tick)
      ) {
        return incomplete(
          `market_base_v3_pricing_ratchet_rollback:${resource}`,
        );
      }
      nextPricingEntries.push({
        resource,
        value: trusted.value,
        marketDate: trusted.marketDate,
      });
    }
    let nextPricingRatchet: MarketBaseResourcePricingRatchetState;
    try {
      nextPricingRatchet = buildMarketBaseResourcePricingRatchetState({
        initializedAt: currentPricingRatchet.initializedAt,
        entries: nextPricingEntries,
      });
    } catch {
      return incomplete("market_base_v3_pricing_ratchet_candidate_invalid");
    }
    const observations = collectLiveMarketBaseRoomObservations(accountIdentity);
    const stableScope = authenticatedStableMarketBaseResourceScope(
      canonicalScope,
      input.tick,
      accountIdentity,
      observations,
    );
    let scope = stableScope;
    if (!scope) {
      const reconciled = reconcileLiveMarketBaseResourceScopeCore(
        {
          tick: input.tick,
          accountIdentity,
          observations,
          previous: canonicalScope,
          // Tombstone discharge/compaction belongs to the outer preflight.
          // Planning 的两次 live read 只重建当 tick roster/lanes，不能再次
          // 消费 permit 历史或把 full-chain 校验成本带进 25 CPU 窗口。
        },
        true,
      );
      if ("blockers" in reconciled) {
        return incomplete(
          reconciled.blockers[0] || "market_base_v3_scope_incomplete",
        );
      }
      scope = reconciled.state;
    }
    if (
      cpuTraceRecorder &&
      observeMarketBaseResourceCpuTrace(
        cpuTraceRecorder,
        dependencies,
        "cpuAfterScopeCore",
        readIndex === 1 ? "scope_core_read1" : "scope_core_read2",
      ).exceeded
    ) {
      return incomplete("market_base_cpu_ceiling_exceeded");
    }
    let candidates: readonly MarketBaseResourceRuntimeCandidate[];
    // readCandidates 会读取 protection/pricing 等 live market facts；即使
    // callback 抛错，诊断也必须明确记录“已尝试读取”，不能留在
    // not_reached。
    setMarketBaseResourceMarketFactsDisposition(cpuTraceRecorder, "read");
    try {
      // Pricing evidence 的可选分量在 JS 对象中可能以显式 undefined
      // 存在；canonical hash 故意拒绝 undefined。V3 在进入任何 evidence
      // commitment 前重建精确字段集，保留“缺失”语义且不放宽 hash 合同。
      candidates = input.readCandidates().map((candidate) => ({
        ...candidate,
        energyShadowComponents: canonicalEnergyShadowComponents(
          candidate.energyShadowComponents,
        ),
      }));
    } catch {
      return incomplete("market_base_v3_candidate_read_failed");
    }
    const candidateByKey = new Map<
      string,
      MarketBaseResourceRuntimeCandidate
    >();
    for (const candidate of candidates) {
      const key = runtimeCandidateKey(
        candidate.roomName,
        candidate.resourceType,
      );
      if (candidateByKey.has(key)) {
        return incomplete("market_base_v3_candidate_duplicate");
      }
      candidateByKey.set(key, candidate);
    }
    const expectedKeys = new Set(
      scope.laneLifecycles.map((lane) =>
        runtimeCandidateKey(lane.sellerRoomName, lane.resource),
      ),
    );
    if (
      candidateByKey.size !== expectedKeys.size ||
      [...candidateByKey.keys()].some((key) => !expectedKeys.has(key))
    ) {
      return incomplete("market_base_v3_candidate_scope_mismatch");
    }
    for (const candidate of candidates) {
      const sellerRoom = scope.sellerRooms.find(
        (room) => room.roomName === candidate.roomName,
      );
      if (
        !sellerRoom ||
        candidate.isHubRoom !== (sellerRoom.roomClass === "hub")
      ) {
        return incomplete(
          `market_base_v3_room_class_mismatch:${candidate.roomName}`,
        );
      }
    }
    const credits = dependencies.readCredits();
    if (credits === undefined || !Number.isFinite(credits) || credits < 0) {
      return incomplete("market_base_v3_credits_incomplete");
    }
    const roomNames = scope.sellerRooms.map((room) => room.roomName);
    const arbiter = dependencies.readArbiterSnapshot(roomNames);
    if (!arbiter || !arbiter.revision || typeof arbiter.blocked !== "boolean") {
      return incomplete("market_base_v3_arbiter_incomplete");
    }
    const arbiterBlocked =
      arbiter.blocked ||
      input.makerExposurePresent ||
      input.emergencyStop ||
      staticAttestation.mode !== "direct";
    const outgoingWindow = dependencies.readOutgoingWindow(input.tick);
    if (
      !outgoingWindow ||
      outgoingWindow.observedAt !== input.tick ||
      !outgoingWindow.coversAttemptAt
    ) {
      return incomplete("market_base_v3_outgoing_window_incomplete");
    }
    const quotas = measureMarketSubPhase(
      "v3QuotaRead",
      () => marketBaseResourceQuotaProjectionWithRuntimeContext(
        session.ledgerContext,
        {
          tick: input.tick,
          lanes: scope.laneLifecycles.map((lane) => ({
            resource: lane.resource,
            sellerRoom: lane.sellerRoomName,
            resourceLimit:
              MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[lane.resource]
                .rollingMaxAmount,
          })),
        },
      ),
    );
    const firstQuota = quotas[0];
    if (
      firstQuota &&
      quotas.some(
        (quota) =>
          quota.confirmedCooldownNotBefore !==
            firstQuota.confirmedCooldownNotBefore ||
          quota.retryNotBefore !== firstQuota.retryNotBefore ||
          !sameMarketBaseQuotaLayer(quota.global, firstQuota.global),
      )
    ) {
      return incomplete("market_base_v3_global_quota_conflict");
    }
    for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
      const resourceQuotas = quotas.filter(
        (quota) => quota.resource === resource,
      );
      if (
        resourceQuotas.length > 1 &&
        resourceQuotas.some(
          (quota) =>
            !sameMarketBaseQuotaLayer(
              quota.resourceQuota,
              resourceQuotas[0].resourceQuota,
            ),
        )
      ) {
        return incomplete(`market_base_v3_resource_quota_conflict:${resource}`);
      }
    }
    const quotaByLane = new Map(
      quotas.map((quota) => [
        runtimeCandidateKey(quota.sellerRoom, quota.resource),
        quota,
      ]),
    );
    const trial = activeMarketEgressTrialR2({
      tick: input.tick,
      permitId: permit.permitId,
      permitEpoch: permit.epoch,
    });
    const trialOnlyDuringBaselineCooldown = trial !== null &&
      input.tick < canonicalLedger.confirmedCooldownNotBefore;
    const writableLaneIds = new Set(
      scope.laneLifecycles
        .filter((lane) => {
          if (!laneAllowsRuntimeWrite(session, executorShard, lane)) return false;
          if (!trialOnlyDuringBaselineCooldown) return true;
          const candidate = candidateByKey.get(runtimeCandidateKey(
            lane.sellerRoomName, lane.resource));
          const signedPolicy = permit.resourcePolicies.find((value) =>
            value.resource === lane.resource);
          return !!candidate && !!signedPolicy && trialLaneEligible({
            roomName: lane.sellerRoomName,
            resource: lane.resource,
            stage: lane.stage,
            capacityState: candidate.capacityState,
            policyCooldownTicks: signedPolicy.cooldownTicks,
          });
        })
        .map((lane) => lane.laneId),
    );
    const hasWritableLane = writableLaneIds.size > 0;
    const writableCandidateKeys = new Set(
      scope.laneLifecycles
        .filter((lane) => writableLaneIds.has(lane.laneId))
        .map((lane) =>
          runtimeCandidateKey(lane.sellerRoomName, lane.resource),
        ),
    );
    const protectionRevisionByKey = new Map<string, string>();
    const inventorySurplusByKey = new Map<string, number>();
    const candidateEvidence = candidates
      .map((candidate) => {
        const key = runtimeCandidateKey(
          candidate.roomName,
          candidate.resourceType,
        );
        const protectionComplete = candidateProtectionComplete(
          candidate,
          input.tick,
        );
        const inventorySurplus = protectionComplete
          ? getMarketProtectionSellableAmount(
              candidate.protectionEntry,
              input.tick,
              { requireTerminalBacking: false },
            )
          : 0;
        // 可写 lane 存在时 Shadow cohort 本轮暂停：非可写条目仍 fresh
        // 校验并承诺库存余量，但其完整保护树不参与任何成交/qualification。
        const protectionRevision =
          !hasWritableLane || writableCandidateKeys.has(key)
            ? canonicalStableHashV1({
                domain: "market-base-resource:protection-v1",
                entry: candidate.protectionEntry,
              })
            : "market-base-resource:suspended-protection-unread-v1";
        protectionRevisionByKey.set(
          key,
          protectionRevision,
        );
        inventorySurplusByKey.set(key, inventorySurplus);
        return {
          capacityState: candidate.capacityState,
          effectiveEnergyShadowPrice: candidate.effectiveEnergyShadowPrice,
          energyShadowComponents: candidate.energyShadowComponents,
          energyShadowObservedAt: candidate.energyShadowObservedAt,
          effectiveNetFloor: candidate.effectiveNetFloor,
          historyFloor: candidate.historyFloor,
          historyTrusted: candidate.historyTrusted,
          inventorySurplus,
          isHubRoom: candidate.isHubRoom,
          protectionComplete,
          protectionRevision,
          ratchetFloor: candidate.ratchetFloor,
          rejectionReasons: [...candidate.rejectionReasons],
          resourceType: candidate.resourceType,
          roomName: candidate.roomName,
        };
      })
      .sort(
        (left, right) =>
          stableCompare(left.resourceType, right.resourceType) ||
          stableCompare(left.roomName, right.roomName),
      );
    const entries: V3EntryInput[] = [];
    // enforce 动态地板映射：adapter 定价、candidate 校验与 planner policy
    // 注入共用同一来源（本 tick 内投影不变）。
    const enforcedDynamicFloors = marketBaseEnforcedDynamicFloors(
      state.dynamicFloorProjection,
    );
    let energySignature: string | undefined;
    let energyPrice = 0;
    // 候选证据缺失（如低流动性资源的 history 滑出信任窗口）只承载
    // shadow lane 时，做资源级隔离：该资源 lane 本轮记 incomplete 观察
    // （周期停涨、证据不清零），其余资源照常推进。承载 writable lane 的
    // 资源仍整轮 fail-closed——成交安全不接受降级。
    const candidateIsolatedResources = new Set<string>();
    for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
      const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
      const resourceLanes = scope.laneLifecycles.filter(
        (lane) => lane.resource === resource,
      );
      if (resourceLanes.length === 0) continue;
      const resourceCandidates = resourceLanes.map((lane) =>
        candidateByKey.get(
          runtimeCandidateKey(lane.sellerRoomName, lane.resource),
        ),
      );
      if (resourceCandidates.some((candidate) => !candidate)) {
        return incomplete(`market_base_v3_candidate_missing:${resource}`);
      }
      const signedRatchetHighWater = permit.ratchetHighWater.find(
        (entry) => entry.resource === resource,
      );
      if (!signedRatchetHighWater) {
        return incomplete(
          `market_base_v3_ratchet_high_water_missing:${resource}`,
        );
      }
      const stateRatchetHighWater = currentPricingRatchet.entries.find(
        (entry) => entry.resource === resource,
      );
      const trustedFloor = trustedFloors?.[resource];
      if (!stateRatchetHighWater || !trustedFloor) {
        return incomplete(`market_base_v3_pricing_ratchet_missing:${resource}`);
      }
      const typedResourceCandidates =
        resourceCandidates as MarketBaseResourceRuntimeCandidate[];
      if (
        typedResourceCandidates.some(
          (candidate) =>
            !sameMarketBasePricingBasis(
              candidate,
              typedResourceCandidates[0],
            ),
        )
      ) {
        return incomplete(
          `market_base_v3_resource_pricing_conflict:${resource}`,
        );
      }
      for (const candidate of typedResourceCandidates) {
        if (
          !candidatePricingComplete(
            candidate,
            signedRatchetHighWater.ratchetFloor,
            stateRatchetHighWater.value,
            trustedFloor,
            enforcedDynamicFloors[resource],
            state.dynamicFloorProjection,
            input.tick,
          ) ||
          !candidateEnergyEvidence(
            candidate,
            input.tick,
            staticAttestation.planningSnapshotMaxAgeTicks,
            trustedEnergyFloor,
          )
        ) {
          const resourceHasWritableLane = resourceLanes.some((lane) =>
            writableLaneIds.has(lane.laneId),
          );
          if (!resourceHasWritableLane) {
            candidateIsolatedResources.add(resource);
            continue;
          }
          return incomplete(
            `market_base_v3_candidate_incomplete:${runtimeCandidateKey(
              candidate.roomName,
              candidate.resourceType,
            )}`,
          );
        }
        const signature = canonicalStableHashV1({
          components: candidate.energyShadowComponents,
          domain: "market-base-resource:energy-shadow-v1",
          observedAt: candidate.energyShadowObservedAt,
          price: candidate.effectiveEnergyShadowPrice,
        });
        if (energySignature !== undefined && energySignature !== signature) {
          return incomplete("market_base_v3_energy_shadow_conflict");
        }
        energySignature = signature;
        energyPrice = candidate.effectiveEnergyShadowPrice;
      }
      const writableLane = resourceLanes.find((lane) =>
        writableLaneIds.has(lane.laneId),
      );
      const currentGrant =
        writableLane &&
        permit.signedLaneGrants.find(
          (grant) => grant.laneId === writableLane.laneId,
        );
      const quota = quotaByLane.get(
        runtimeCandidateKey(resourceLanes[0].sellerRoomName, resource),
      );
      if (!quota) {
        return incomplete(`market_base_v3_quota_missing:${resource}`);
      }
      const lanes: V3LaneInput[] = resourceLanes.map((lane) => {
        const candidate = candidateByKey.get(
          runtimeCandidateKey(lane.sellerRoomName, lane.resource),
        )!;
        const laneQuota = quotaByLane.get(
          runtimeCandidateKey(lane.sellerRoomName, lane.resource),
        );
        if (!laneQuota) {
          throw new Error(`market_base_v3_lane_quota_missing:${lane.laneId}`);
        }
        const key = runtimeCandidateKey(
          candidate.roomName,
          candidate.resourceType,
        );
        const writable = writableLaneIds.has(lane.laneId);
        const protectionComplete = candidateProtectionComplete(candidate, input.tick);
        return {
          laneId: lane.laneId,
          roomInstanceId: lane.roomInstanceId,
          pricing: {
            effectiveNetFloor: candidate.effectiveNetFloor,
            minExecutableNotional: !candidate.overflowTier || candidate.overflowTier === "normal"
              ? policy.minOrderNotional : candidate.effectiveNetFloor * policy.maxDealAmount,
            tier: candidate.overflowTier ?? "normal",
          },
          lane: {
            roomName: lane.sellerRoomName,
            resourceType: lane.resource,
            owned: true,
            hub: candidate.isHubRoom,
            capacityEmergency: candidate.capacityState === "emergency",
            authorization: writable ? "writable" : "suspended_shadow",
          },
          protection: {
            complete: protectionComplete,
            revision: protectionRevisionByKey.get(key)!,
            sellableAmount: protectionComplete &&
                (!hasWritableLane || writable)
              ? getMarketProtectionSellableAmount(
                  candidate.protectionEntry,
                  input.tick,
                )
              : 0,
          },
          inventorySurplus: inventorySurplusByKey.get(key) ?? 0,
          terminal: {
            revision: "market-base-resource:terminal-unread",
            normal: false,
            ready: false,
            claimed: arbiterBlocked,
            cooldown: 0,
            resourceAmount: 0,
            energy: 0,
          },
          quota: {
            complete: true,
            revision: !hasWritableLane || writable
              ? canonicalStableHashV1({
                  domain: "market-base-resource:lane-quota-v1",
                  quota: laneQuota,
                })
              : "market-base-resource:suspended-quota-unread-v1",
            roomRollingCap: laneQuota.room.limit,
            roomConfirmedAmount: laneQuota.room.confirmedActual,
            roomUnmatchedPlannedAmount: laneQuota.room.unmatchedPlanned,
            laneRollingCap: laneQuota.lane.limit,
            laneConfirmedAmount: laneQuota.lane.confirmedActual,
            laneUnmatchedPlannedAmount: laneQuota.lane.unmatchedPlanned,
          },
        };
      });
      entries.push({
        policy: {
          entryId: policy.policyId,
          revision: policy.policyRevision,
          resourceType: policy.resource,
          allowedRooms: resourceLanes.map((lane) => lane.sellerRoomName),
          requireNativeMineral: false,
          grant: currentGrant?.stage === "canary" ? "canary" : "continuous",
          hardNetFloor: policy.hardFloor,
          economicNetFloor: policy.economicFloor,
          // enforce：df 有效时两分量同值注入（planner 取 max 后等于
          // max(hard, economic, df)，与 adapter/candidate 校验一致）。
          historyNetFloor:
            enforcedDynamicFloors[resource] !== undefined
              ? enforcedDynamicFloors[resource]
              : (
                  resourceCandidates[0] as MarketBaseResourceRuntimeCandidate
                ).historyFloor,
          ratchetNetFloor:
            enforcedDynamicFloors[resource] !== undefined
              ? enforcedDynamicFloors[resource]
              : trustedFloor.value,
          minExecutableNotional: policy.minOrderNotional,
          maxRawOrders: policy.maxRawOrdersScanned,
          maxEligibleOrders: policy.maxEligibleOrdersPriced,
          maxTransactionEnergy: policy.maxTransactionEnergy,
          terminalEnergyReserve: policy.terminalEnergyReserve,
          resourceRollingCap: policy.rollingMaxAmount,
          opportunityReserve: policy.rollingOpportunityReserveAmount,
          evaluatorVersion: 3,
        },
        quota: {
          complete: true,
          revision: canonicalStableHashV1({
            domain: "market-base-resource:resource-quota-v1",
            quota,
          }),
          resourceType: resource,
          rollingCap: quota.resourceQuota.limit,
          confirmedAmount: quota.resourceQuota.confirmedActual,
          unmatchedPlannedAmount: quota.resourceQuota.unmatchedPlanned,
          opportunityReserveSatisfied:
            quota.resourceQuota.used >= policy.rollingOpportunityReserveAmount,
        },
        lanes,
      });
    }
    const pendingState: PlanMarketDirectContinuousInput["writeContext"]["pendingState"] =
      canonicalLedger.blocker
        ? "gap"
        : canonicalLedger.pending
          ? "active"
          : "none";
    // session 承诺完整冻结 scope、ledger 与 permit；本读证据只需绑定这些
    // 既有承诺和每次 fresh 读取的候选/arbiter/outgoing/ratchet。entry 与
    // quota 是上述冻结状态、catalog 常量及候选的确定性投影，重复深哈希
    // 整份 56-lane 派生树只会占用可写 lane 的两读 CPU 预算。
    const scopeCommitment =
      scope === session.scopeContext?.snapshot
        ? session.scopeContext.commitment
        : marketBaseResourceRuntimeScopeCommitment(scope);
    const scopeEvidence = measureMarketSubPhase(
      "v3ScopeEvidenceHash",
      () =>
        canonicalStableHashV1({
          arbiter,
          candidateEvidence,
          domain: "market-base-resource:live-scope-v3",
          emergencyStop: input.emergencyStop,
          ledgerHead: canonicalLedger.receiptHeadHash,
          makerExposurePresent: input.makerExposurePresent,
          outgoingWindow,
          permitHead: permit.permitHead,
          pricingRatchet: {
            current: currentPricingRatchet,
            next: nextPricingRatchet,
          },
          scopeCommitment,
          tick: input.tick,
        }),
    );
    return {
      complete: true,
      scopeEvidence,
      currentRosterFingerprint: scope.rosterFingerprint,
      currentLaneSetFingerprint: scope.laneSetFingerprint,
      protectionFingerprint: canonicalStableHashV1({
        domain: "market-base-resource:scope-protection-v2",
        protection: candidateEvidence.map((candidate) => ({
          protectionRevision: candidate.protectionRevision,
          resourceType: candidate.resourceType,
          roomName: candidate.roomName,
        })),
      }),
      arbiterFingerprint: arbiter.revision,
      outgoingWindow,
      pricingRatchet: nextPricingRatchet,
      activeRoomCount: scope.sellerRooms.length,
      knownRoomNameCount: scope.roomRegistry.knownRoomNames.length,
      activeLaneCount: scope.laneLifecycles.length,
      entries,
      ...(candidateIsolatedResources.size > 0
        ? {
            isolatedCandidateLaneIds: scope.laneLifecycles
              .filter((lane) => candidateIsolatedResources.has(lane.resource))
              .map((lane) => lane.laneId)
              .sort(stableCompare),
          }
        : {}),
      energyShadow: {
        complete: true,
        revision:
          energySignature ||
          canonicalStableHashV1({
            domain: "market-base-resource:empty-energy-shadow-v1",
            tick: input.tick,
          }),
        price: energyPrice,
      },
      globalQuota: {
        complete: true,
        revision: canonicalStableHashV1({
          domain: "market-base-resource:global-quota-v1",
          quota: firstQuota?.global || {
            confirmedActual: 0,
            limit: MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
            unmatchedPlanned: 0,
          },
        }),
        rollingCap:
          firstQuota?.global.limit ?? MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
        confirmedAmount: firstQuota?.global.confirmedActual ?? 0,
        unmatchedPlannedAmount: firstQuota?.global.unmatchedPlanned ?? 0,
      },
      writeContext: {
        complete: true,
        revision: canonicalStableHashV1({
          arbiterRevision: arbiter.revision,
          domain: "market-base-resource:write-context-v1",
          pendingState,
          scopeEvidence,
        }),
        credits,
        executorShard,
        permitEpoch: permit.epoch,
        permitId: permit.permitId,
        permitHead: permit.permitHead,
        pendingState,
        arbiterState: arbiterBlocked ? "blocked" : "available",
      },
    };
  } catch (error) {
    return incomplete(
      boundedReason(error instanceof Error ? error.message : error) ||
        "market_base_v3_scope_read_failed",
    );
  }
}

function outgoingTransactionKey(
  transaction: MarketBaseResourceOutgoingTransaction,
): string | undefined {
  return transaction.order?.id
    ? `${transaction.transactionId}:${transaction.order.id}`
    : undefined;
}

function sortedOutgoingKeys(
  window: MarketBaseResourceOutgoingWindow,
): string[] {
  return window.transactions
    .map(outgoingTransactionKey)
    .filter((key): key is string => key !== undefined)
    .sort(stableCompare);
}

function pendingRequestId(pending: MarketBaseResourcePendingAttempt): string {
  return pending.evidenceKeyHint;
}

function historicalPendingPermit(
  state: MarketBaseResourceV3RuntimeState,
  pending: MarketBaseResourcePendingAttempt,
): MarketBaseResourcePermit | undefined {
  const permit = state.permitChain?.retainedPermits.find(
    (record) =>
      record.schemaVersion === 3 &&
      record.permitId === pending.historicalPermit.permitId,
  );
  if (!permit || permit.schemaVersion !== 3) {
    return undefined;
  }
  return canonicalStableHashV1(
    buildMarketBaseResourceHistoricalPermitRef(permit),
  ) === canonicalStableHashV1(pending.historicalPermit)
    ? permit
    : undefined;
}

function applyFinalizedLifecycleReceipts(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
): void {
  if (!state.ledger || !state.scope) return;
  if (
    (state.lastLifecycleAppliedAttemptSeq ?? 0) >=
    state.ledger.finalizedAttemptSeq
  ) {
    return;
  }
  // Runtime 不扫描未做 full audit 的历史 receipts。confirmed one-shot
  // 高水位由 ledger runtime anchor 单独承诺；无论 receipt 尚在 ring 或已
  // 进入 checkpoint，都从这个窄投影单调推进 lifecycle。
  const confirmedLaneIds = new Set(Object.keys(state.ledger.confirmedCanaries));
  let changed = false;
  const lanes = state.scope.laneLifecycles.map((lane) => {
    if (lane.stage !== "canary" || !confirmedLaneIds.has(lane.laneId)) {
      return lane;
    }
    const confirmed = marketBaseResourceConfirmedCanaryForWithRuntimeContext(
      session.ledgerContext,
      lane.laneId,
    );
    if (!confirmed) return lane;
    changed = true;
    return {
      ...lane,
      stage: "review_paused" as const,
      status: "suspended" as const,
    };
  });
  if (changed) {
    replaceMarketBaseResourceRuntimeScope(state, session, {
      ...state.scope,
      laneLifecycles: lanes,
    });
  }
  state.lastLifecycleAppliedAttemptSeq = Math.max(
    state.ledger.finalizedAttemptSeq,
    state.lastLifecycleAppliedAttemptSeq ?? 0,
  );
}

function updateQuotaProjection(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  session?: MarketBaseResourceRuntimeSession,
): void {
  if (state.ledger && state.scope) {
    state.quotaProjection = session
      ? boundedRuntimeQuotaProjection(session, state.scope, tick)
      : boundedQuotaProjection(state.ledger, state.scope, tick);
  }
}

function advanceWalUntilWaiting(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  actions: string[],
  dependencies: MarketBaseResourceRuntimeDependencies,
  session: MarketBaseResourceRuntimeSession,
): void {
  if (!state.ledger || state.lastWalAdvanceAt === tick) {
    return;
  }
  const requestId = state.ledger.pending
    ? pendingRequestId(state.ledger.pending)
    : undefined;
  const operation = advanceMarketBaseResourceWalWithRuntimeContext(
    session.ledgerContext,
  );
  const commitsPrefix =
    operation.ok &&
    operation.action !== "idle" &&
    operation.action !== "waiting_for_outcome";
  // 每 tick 最多提交一个真实 WAL prefix。idle/waiting 不消耗本 tick
  // 的 prefix 预算，允许晚期确定 non-OK 在同 tick记录一个终态阶段。
  if (commitsPrefix) {
    state.lastWalAdvanceAt = tick;
  }
  applyMarketBaseResourceRuntimeLedgerOperation(state, session, operation);
  if (!operation.ok || operation.action === "blocked") {
    state.blocker = operation.blockerCode || "market_base_v3_wal_blocked";
    actions.push(`market-base-v3-wal-blocked:${state.blocker}`);
    return;
  }
  if (
    operation.action === "idle" ||
    operation.action === "waiting_for_outcome"
  ) {
    return;
  }
  actions.push(`market-base-v3-wal:${operation.action}`);
  applyFinalizedLifecycleReceipts(state, session);
  if (operation.action === "pending_deleted" && requestId) {
    try {
      dependencies.releasePrepared(requestId);
    } catch {
      // 持久 claim 有 TTL；已提交 WAL 终态不能回滚。
    }
  }
}

function outcomeFromPending(
  pending: MarketBaseResourcePendingAttempt,
  input: {
    status: "confirmed" | "failed" | "not_filled";
    resolvedAt: number;
    evidenceKey: string;
    reason?: string;
    actualAmount: number;
    transactionId?: string;
    transactionTime?: number;
    actualTransactionEnergy?: number;
    actualNetCreditsMilli?: number;
  },
) {
  return sealMarketBaseResourceOutcome({
    schemaVersion: 3,
    hashRevision: "market-base-resource-outcome-hash-v1",
    attemptSeq: pending.attemptSeq,
    status: input.status,
    permitId: pending.historicalPermit.permitId,
    permitEpoch: pending.historicalPermit.permitEpoch,
    laneId: pending.historicalLane.laneId,
    sellerRoom: pending.historicalLane.sellerRoom,
    resource: pending.historicalLane.resource,
    orderId: pending.orderId,
    orderRoom: pending.orderRoom,
    attemptAt: pending.attemptAt,
    plannedAmount: pending.plannedAmount,
    resolvedAt: input.resolvedAt,
    evidenceKey: input.evidenceKey,
    actualAmount: input.actualAmount,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.transactionId === undefined
      ? {}
      : {
          transactionId: input.transactionId,
        }),
    ...(input.transactionTime === undefined
      ? {}
      : {
          transactionTime: input.transactionTime,
        }),
    ...(input.actualTransactionEnergy === undefined
      ? {}
      : {
          actualTransactionEnergy: input.actualTransactionEnergy,
        }),
    ...(input.actualNetCreditsMilli === undefined
      ? {}
      : {
          actualNetCreditsMilli: input.actualNetCreditsMilli,
        }),
    pendingEvidenceHash: pending.frozenEvidenceHash,
  });
}

function recordOutcomeAndAdvance(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  outcome: ReturnType<typeof sealMarketBaseResourceOutcome>,
  actions: string[],
  dependencies: MarketBaseResourceRuntimeDependencies,
  session: MarketBaseResourceRuntimeSession,
): boolean {
  if (!state.ledger) return false;
  const recorded = recordMarketBaseResourceOutcomeWithRuntimeContext(
    session.ledgerContext,
    outcome,
  );
  applyMarketBaseResourceRuntimeLedgerOperation(state, session, recorded);
  updateQuotaProjection(state, tick, session);
  if (!recorded.ok) {
    state.blocker = recorded.blockerCode || "market_base_v3_outcome_blocked";
    actions.push(`market-base-v3-outcome-blocked:${state.blocker}`);
    return false;
  }
  actions.push(`market-base-v3-outcome:${outcome.status}`);
  advanceWalUntilWaiting(state, tick, actions, dependencies, session);
  return !state.ledger.blocker;
}

function recordFailedPending(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  reason: string,
  actions: string[],
  dependencies: MarketBaseResourceRuntimeDependencies,
  session: MarketBaseResourceRuntimeSession,
): void {
  const pending = state.ledger?.pending;
  if (!pending) return;
  recordOutcomeAndAdvance(
    state,
    tick,
    outcomeFromPending(pending, {
      status: "failed",
      resolvedAt: tick,
      evidenceKey: canonicalStableHashV1({
        domain: "market-base-resource:failed-evidence-v1",
        pending: pending.frozenEvidenceHash,
        reason,
        tick,
      }),
      reason,
      actualAmount: 0,
    }),
    actions,
    dependencies,
    session,
  );
}

function reconcilePending(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  actions: string[],
  dependencies: MarketBaseResourceRuntimeDependencies,
  session: MarketBaseResourceRuntimeSession,
): void {
  const pending = state.ledger?.pending;
  if (!pending || !state.ledger) return;
  const walProjection =
    marketBaseResourceCurrentWalProjectionWithRuntimeContext(
      session.ledgerContext,
    );
  if (walProjection.prefix !== "waiting_outcome") {
    advanceWalUntilWaiting(state, tick, actions, dependencies, session);
    return;
  }
  if (tick < pending.attemptAt) {
    latchMarketBaseResourceHardBlocker(
      state,
      tick,
      "market_base_v3_pending_from_future",
      {
        attemptAt: pending.attemptAt,
        attemptSeq: pending.attemptSeq,
      },
    );
    return;
  }
  if (tick === pending.attemptAt) return;
  if (tick <= pending.attemptAt + 1) {
    try {
      dependencies.claimPrepared({
        requestId: pendingRequestId(pending),
        roomName: pending.historicalLane.sellerRoom,
        actor: MARKET_BASE_RESOURCE_ACTOR,
        attemptAt: pending.attemptAt,
      });
    } catch {
      // outgoing/physical evidence remains authoritative.
    }
  }
  let window: MarketBaseResourceOutgoingWindow | undefined;
  try {
    window = dependencies.readOutgoingWindow(pending.attemptAt);
  } catch {
    window = undefined;
  }
  if (!window || window.observedAt !== tick || !window.coversAttemptAt) {
    state.blocker = "market_base_v3_outgoing_window_incomplete";
    return;
  }
  const baseline = new Set(
    pending.executionEvidence.outgoingTransactionKeysBefore,
  );
  const newTransactions = window.transactions.filter((transaction) => {
    const key = outgoingTransactionKey(transaction);
    return (
      key !== undefined &&
      !baseline.has(key) &&
      transaction.time >= pending.attemptAt
    );
  });
  const matching = newTransactions.filter((transaction) => {
    let observedPrice: number | undefined;
    try {
      observedPrice = transaction.order
        ? priceToMilliDown(transaction.order.price)
        : undefined;
    } catch {
      observedPrice = undefined;
    }
    return (
      transaction.order?.id === pending.orderId &&
      transaction.order.type === ORDER_BUY &&
      observedPrice === pending.executionEvidence.observedOrderPriceMilli &&
      transaction.resourceType === pending.historicalLane.resource &&
      transaction.from === pending.historicalLane.sellerRoom &&
      transaction.to === pending.orderRoom &&
      Number.isSafeInteger(transaction.amount) &&
      transaction.amount > 0 &&
      transaction.amount <= pending.plannedAmount
    );
  });
  const sameOrderButInvalid = newTransactions.some(
    (transaction) =>
      transaction.order?.id === pending.orderId &&
      !matching.includes(transaction),
  );
  if (matching.length > 1 || sameOrderButInvalid) {
    latchMarketBaseResourceHardBlocker(
      state,
      tick,
      "market_base_v3_transaction_evidence_conflict",
      {
        attemptSeq: pending.attemptSeq,
        matchingKeys: matching.map(outgoingTransactionKey).filter(Boolean),
        newTransactionKeys: newTransactions
          .map(outgoingTransactionKey)
          .filter(Boolean),
      },
    );
    return;
  }
  if (matching.length === 1) {
    const transaction = matching[0];
    let actualEnergy = Number.NaN;
    try {
      actualEnergy = dependencies.calculateTransactionEnergy(
        transaction.amount,
        pending.historicalLane.sellerRoom,
        pending.orderRoom,
      );
    } catch {
      actualEnergy = Number.NaN;
    }
    const priceMilli = pending.executionEvidence.observedOrderPriceMilli;
    const grossMilli = priceMilli * transaction.amount;
    const energyCostMilli =
      pending.executionEvidence.effectiveEnergyShadowPriceMilli * actualEnergy;
    const actualNetCreditsMilli = grossMilli - energyCostMilli;
    const key = outgoingTransactionKey(transaction);
    if (
      !key ||
      !Number.isSafeInteger(actualEnergy) ||
      actualEnergy < 0 ||
      actualEnergy > 1_000 ||
      !Number.isSafeInteger(actualNetCreditsMilli) ||
      actualNetCreditsMilli <= 0 ||
      hasMarketBaseResourceProcessedEvidenceKeyWithRuntimeContext(
        session.ledgerContext,
        key,
      )
    ) {
      latchMarketBaseResourceHardBlocker(
        state,
        tick,
        "market_base_v3_actual_net_invalid",
        {
          actualEnergy,
          actualNetCreditsMilli,
          attemptSeq: pending.attemptSeq,
          evidenceKey: key || null,
        },
      );
      return;
    }
    recordOutcomeAndAdvance(
      state,
      tick,
      outcomeFromPending(pending, {
        status: "confirmed",
        resolvedAt: tick,
        evidenceKey: key,
        actualAmount: transaction.amount,
        transactionId: transaction.transactionId,
        transactionTime: transaction.time,
        actualTransactionEnergy: actualEnergy,
        actualNetCreditsMilli,
      }),
      actions,
      dependencies,
      session,
    );
    return;
  }
  let terminal: MarketBaseResourceTerminalRead | undefined;
  let credits: number | undefined;
  try {
    terminal = dependencies.readTerminal(
      pending.historicalLane.sellerRoom,
      pending.historicalLane.resource,
    );
    credits = dependencies.readCredits();
  } catch {
    terminal = undefined;
    credits = undefined;
  }
  const unchanged =
    terminal !== undefined &&
    terminal.resourceAmount ===
      pending.executionEvidence.terminalResourceBefore &&
    terminal.energy === pending.executionEvidence.terminalEnergyBefore &&
    terminal.cooldown === pending.executionEvidence.terminalCooldownBefore &&
    credits === pending.executionEvidence.creditsBefore;
  if (!unchanged) {
    latchMarketBaseResourceHardBlocker(
      state,
      tick,
      "market_base_v3_reconcile_gap",
      {
        attemptSeq: pending.attemptSeq,
        credits: credits ?? null,
        terminal: terminal ?? null,
      },
    );
    return;
  }
  recordOutcomeAndAdvance(
    state,
    tick,
    outcomeFromPending(pending, {
      status: "not_filled",
      resolvedAt: tick,
      evidenceKey: canonicalStableHashV1({
        domain: "market-base-resource:not-filled-evidence-v1",
        pending: pending.frozenEvidenceHash,
        tick,
      }),
      reason: "complete_window_and_physical_state_unchanged",
      actualAmount: 0,
    }),
    actions,
    dependencies,
    session,
  );
}

function summarizeShadowObservationBlockers(
  observations: readonly MarketBaseResourceShadowObservation[],
): Record<string, number> | undefined {
  let blockers: Record<string, number> | undefined;
  for (const observation of observations) {
    if (observation.result !== "incomplete") continue;
    blockers ??= {};
    const key = (observation.blocker || "unknown").slice(0, 120);
    blockers[key] = (blockers[key] || 0) + 1;
  }
  return blockers;
}

function planningSnapshotFrom(
  tick: number,
  plan: MarketBaseResourceTwoReadPlan,
  cpuTrace?: MarketBaseResourceCpuTrace,
): MarketBaseResourcePlanningSnapshot {
  const selected = plan.selected;
  return {
    observedAt: tick,
    complete: plan.complete,
    ...(plan.blocker ? { blocker: plan.blocker.slice(0, 160) } : {}),
    ...(selected
      ? {
          selected: {
            resource: selected.resourceType,
            roomName: selected.roomName,
            orderId: selected.order.id,
            grossPrice: selected.grossPriceMilli / 1_000,
            unitNetPrice:
              selected.netCreditsMilli / selected.plannedAmount / 1_000,
            transactionEnergy: selected.transactionEnergy,
          },
        }
      : {}),
    sampledShadowLaneIds: [...plan.sampledShadowLaneIds].slice(
      0,
      MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE,
    ),
    cpuUsed:
      Number.isFinite(plan.cpuUsed) && plan.cpuUsed >= 0
        ? plan.cpuUsed
        : MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING,
    rawOrderCount: plan.rawOrderCount,
    eligibleOrderCount: plan.eligibleOrderCount,
    distinctOrderRoomCount: plan.distinctOrderRoomCount,
    transactionCostEvaluationBudget: plan.transactionCostEvaluationBudget,
    shadowPlannerMode: plan.shadowPlannerMode,
    shadowPlannerInvocationCount: plan.shadowPlannerInvocationCount,
    actualTransactionEnergyEvaluations:
      plan.actualTransactionEnergyEvaluations,
    evaluatedShadowResourceCount: plan.evaluatedShadowResourceCount,
    candidateIdentityOrderChecks: plan.candidateIdentityOrderChecks,
    shadowBlockers: summarizeShadowObservationBlockers(
      plan.shadowObservations,
    ),
    ...(cpuTrace ? { cpuTrace: { ...cpuTrace } } : {}),
  };
}

function sameFullReadComponents(plan: MarketBaseResourceTwoReadPlan): boolean {
  return Boolean(
    plan.firstReadEvidence &&
    plan.secondReadEvidence &&
    canonicalStableHashV1(plan.firstReadEvidence) ===
      canonicalStableHashV1(plan.secondReadEvidence),
  );
}

function marketBaseResourceCpuExceededSince(
  dependencies: MarketBaseResourceRuntimeDependencies,
  startedAt: number,
  recorder?: MarketBaseResourceCpuTraceRecorder,
  field?: MarketBaseResourceCpuTraceField,
  phase?: MarketBaseResourceCpuCutPhase,
): boolean {
  if (recorder && field && phase) {
    return observeMarketBaseResourceCpuTrace(
      recorder,
      dependencies,
      field,
      phase,
    ).exceeded;
  }
  const current = dependencies.cpuUsed();
  return (
    !Number.isFinite(current) ||
    current < startedAt ||
    current - startedAt > MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING
  );
}

function applyDeterminedLocalShadowResets(
  scope: MarketBaseResourceScopeState,
  tick: number,
  observations: readonly MarketBaseResourceShadowObservation[],
): MarketBaseResourceScopeState {
  const resets = observations.filter(
    (observation) => observation.result === "incomplete",
  );
  return resets.length === 0
    ? scope
    : applyMarketBaseResourceShadowObservations(scope, tick, resets, undefined);
}

function markPlanningCpuExceeded(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  startedAt: number,
  dependencies: MarketBaseResourceRuntimeDependencies,
  cpuTraceRecorder?: MarketBaseResourceCpuTraceRecorder,
  phase?: MarketBaseResourceCpuCutPhase,
): void {
  stopMarketEgressTrialR2("cpu_guard");
  const field: MarketBaseResourceCpuTraceField =
    phase === "outer_session"
      ? "cpuAfterOuterSession"
      : phase === "scope_core_read1" || phase === "scope_core_read2"
        ? "cpuAfterScopeCore"
        : phase === "market_facts_read1" || phase === "market_facts_read2"
          ? "cpuAfterMarketFacts"
          : phase === "shadow_batch_read1" ||
              phase === "shadow_batch_read2"
            ? "cpuAfterShadowBatch"
            : "cpuAfterInnerApply";
  const observed =
    cpuTraceRecorder && phase
      ? observeMarketBaseResourceCpuTrace(
          cpuTraceRecorder,
          dependencies,
          field,
          phase,
        )
      : undefined;
  const current = observed ? undefined : dependencies.cpuUsed();
  const observedDelta = cpuTraceRecorder?.lastRawDelta;
  const previous = state.lastPlanningSnapshot;
  const currentAttempt = previous?.observedAt === tick ? previous : undefined;
  state.lastPlanningSnapshot = {
    ...(currentAttempt || {
      observedAt: tick,
      sampledShadowLaneIds: [],
      rawOrderCount: 0,
      eligibleOrderCount: 0,
      distinctOrderRoomCount: 0,
      transactionCostEvaluationBudget: 0,
      evaluatedShadowResourceCount: 0,
      candidateIdentityOrderChecks: 0,
    }),
    // 线上旧 snapshot 没有这些字段；即使新 bundle 首轮在 planner 前
    // CPU cut，也必须立即升级为完整、有界的诊断合同。
    shadowPlannerMode: currentAttempt?.shadowPlannerMode ?? "none",
    shadowPlannerInvocationCount:
      currentAttempt?.shadowPlannerInvocationCount ?? 0,
    actualTransactionEnergyEvaluations:
      currentAttempt?.actualTransactionEnergyEvaluations ?? 0,
    evaluatedShadowResourceCount:
      currentAttempt?.evaluatedShadowResourceCount ?? 0,
    candidateIdentityOrderChecks:
      currentAttempt?.candidateIdentityOrderChecks ?? 0,
    observedAt: tick,
    complete: false,
    blocker: "market_base_cpu_ceiling_exceeded",
    cpuUsed:
      observedDelta !== undefined
        ? observedDelta
        : Number.isFinite(current) && current! >= startedAt
          ? current! - startedAt
        : MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING,
    ...(cpuTraceRecorder
      ? { cpuTrace: cloneMarketBaseResourceCpuTrace(cpuTraceRecorder) }
      : {}),
  };
}

/**
 * v3 唯一 live planning/execute 入口。prepare 先原子写入 canonical
 * ledger，再获取 account+terminal claim，最后才允许调用唯一 deal
 * arbiter。OK/throw/未知保留 pending；确定 non-OK 记录 failed。
 */
export function runMarketBaseResourceAutomation(
  state: MarketBaseResourceV3RuntimeState,
  input: MarketBaseResourceAutomationInput,
  dependencies: MarketBaseResourceRuntimeDependencies = defaultMarketBaseResourceRuntimeDependencies,
): MarketBaseResourceAutomationResult {
  closeExpiredMarketEgressTrialR2(input.tick);
  const actions: string[] = [];
  const rejectedByReason: Record<string, number> = {};
  let writes = 0;
  let runtimeSession: MarketBaseResourceRuntimeSession | undefined;
  let cpuTraceRecorder: MarketBaseResourceCpuTraceRecorder | undefined;
  let cpuFallbackCapability:
    | MarketBaseResourceCpuFallbackCapability
    | undefined;
  const rejectOnce = (reason: string): void => {
    incrementReason(rejectedByReason, reason);
  };
  const finish = (
    planComplete: boolean,
  ): MarketBaseResourceAutomationResult => {
    const anchoredSession =
      runtimeSession &&
      state.ledger === runtimeSession.ledgerContext.state &&
      state.permitChain &&
      !marketBaseResourceRuntimeSnapshotMismatch(state, runtimeSession)
        ? runtimeSession
        : undefined;
    return {
      actions,
      rejectedByReason,
      writes,
      planComplete,
      state,
      ...(cpuTraceRecorder
        ? {
            cpuTrace: cloneMarketBaseResourceCpuTrace(cpuTraceRecorder),
            cpuRawHighWater: cpuTraceRecorder.lastRawDelta,
          }
        : {}),
      ...(cpuFallbackCapability ? { cpuFallbackCapability } : {}),
      ...(anchoredSession
        ? {
            ledgerRuntimeAnchor: anchoredSession.ledgerRuntimeAnchor,
            readinessRuntimeCapability:
              issueMarketBaseResourceReadinessRuntimeCapability(
                state,
                anchoredSession,
                input.tick,
              ),
          }
        : {}),
    };
  };
  // 同一个 25 CPU 窗口覆盖 preflight、outer anchor reader、ledger/permit
  // runtime context 铸造、双读 planning、canonical commit 与 claim。
  const cpuObservedAtEntry = dependencies.cpuUsed();
  const planningCpuStartedAt = input.cpuStartedAt ?? cpuObservedAtEntry;
  if (
    !Number.isFinite(cpuObservedAtEntry) ||
    !Number.isFinite(planningCpuStartedAt) ||
    planningCpuStartedAt > cpuObservedAtEntry
  ) {
    rejectOnce("market_base_cpu_observation_invalid");
    return finish(false);
  }
  cpuTraceRecorder = createMarketBaseResourceCpuTraceRecorder(
    input.tick,
    planningCpuStartedAt,
    cpuObservedAtEntry,
  );
  if (
    cpuTraceRecorder.lastRawDelta >
    MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING
  ) {
    cpuTraceRecorder.trace.cpuCutPhase = "outer_session";
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "outer_session",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    return finish(false);
  }
  let preflightRuntimeAnchor: MarketBaseResourceLedgerRuntimeAnchor | undefined;
  if (state.preflightAt !== input.tick) {
    const preflight = runMarketBaseResourcePreflight(
      state,
      input.tick,
      dependencies,
    );
    state.preflightAt = input.tick;
    preflightRuntimeAnchor = preflight.ledgerRuntimeAnchor;
    actions.push(...preflight.actions);
    for (const [reason, count] of Object.entries(preflight.rejectedByReason)) {
      incrementReason(rejectedByReason, reason, count);
    }
  }
  if (
    state.cutoverLatched !== true &&
    state.permitChain &&
    currentV3Permit(state.permitChain) &&
    state.permitChain.v2EventCutoverCheckpoint &&
    state.permitChain.legacyV2GrantSuspended === true
  ) {
    state.cutoverLatched = true;
  }

  const suppliedRuntimeCapability =
    input.readinessRuntimeCapability &&
    typeof input.readinessRuntimeCapability === "object"
      ? marketBaseResourceReadinessRuntimeCapabilities.get(
          input.readinessRuntimeCapability as object,
        )
      : undefined;
  const suppliedRuntimeSession =
    suppliedRuntimeCapability?.tick === input.tick &&
    suppliedRuntimeCapability.state === state &&
    !marketBaseResourceRuntimeSnapshotMismatch(
      state,
      suppliedRuntimeCapability.session,
    )
      ? suppliedRuntimeCapability.session
      : undefined;
  const runtimeSessionResult = suppliedRuntimeSession
    ? ({ ok: true, session: suppliedRuntimeSession } as const)
    : state.permitChain && state.ledger
      ? openMarketBaseResourceRuntimeSession(
          state,
          input.tick,
          dependencies,
          preflightRuntimeAnchor,
        )
      : undefined;
  if (runtimeSessionResult && "reason" in runtimeSessionResult) {
    state.blocker = runtimeSessionResult.reason;
    rejectOnce(runtimeSessionResult.reason);
    return finish(false);
  }
  runtimeSession = runtimeSessionResult?.ok
    ? runtimeSessionResult.session
    : undefined;

  if (
    observeMarketBaseResourceCpuTrace(
      cpuTraceRecorder,
      dependencies,
      "cpuAfterOuterSession",
      "outer_session",
    ).exceeded
  ) {
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "outer_session",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    return finish(false);
  }

  if (
    !input.fullPlanningTick ||
    input.config.mode !== "direct" ||
    input.emergencyStop ||
    input.makerExposurePresent ||
    state.blocker ||
    state.ledger?.blocker ||
    state.ledger?.pending ||
    !state.scope ||
    !state.permitChain ||
    !state.ledger ||
    !runtimeSession ||
    !state.cutoverLatched
  ) {
    const reason = !input.fullPlanningTick
      ? "market_base_v3_not_full_planning_tick"
      : input.config.mode !== "direct"
        ? "market_base_v3_not_direct"
        : input.emergencyStop
          ? "market_base_v3_emergency_stop"
          : input.makerExposurePresent
            ? "market_base_v3_maker_exposure"
            : state.blocker ||
              state.ledger?.blocker?.code ||
              (state.ledger?.pending
                ? "market_base_v3_pending_active"
                : !state.cutoverLatched
                  ? "market_base_v3_cutover_not_latched"
                  : "market_base_v3_state_incomplete");
    rejectOnce(reason);
    return finish(false);
  }

  if (
    marketBaseResourceCpuExceededSince(
      dependencies,
      planningCpuStartedAt,
      cpuTraceRecorder,
      "cpuAfterOuterSession",
      "outer_session",
    )
  ) {
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "outer_session",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    return finish(false);
  }
  const scopeBeforePlanning = runtimeSession.scopeContext!.snapshot;
  const ratchetBeforePlanning = state.pricingRatchet;
  const rollbackPlanningState = (
    preserveLocalResets: readonly MarketBaseResourceShadowObservation[],
  ): void => {
    replaceMarketBaseResourceRuntimeScope(
      state,
      runtimeSession,
      applyDeterminedLocalShadowResets(
        scopeBeforePlanning,
        input.tick,
        preserveLocalResets,
      ),
    );
    replaceMarketBaseResourceRuntimePricingRatchet(
      state,
      runtimeSession,
      ratchetBeforePlanning,
    );
  };
  let lastObservedCandidates: readonly MarketBaseResourceRuntimeCandidate[] = [];
  const observedInput = { ...input, readCandidates: () => {
    lastObservedCandidates = input.readCandidates();
    return lastObservedCandidates;
  } };
  let liveScopeReadCount = 0;
  let staticReadAttestationResult:
    | MarketBaseResourceStaticReadAttestationResult
    | undefined;
  const plan = planMarketBaseResourceTwoRead(
    {
      readScope: () => {
        liveScopeReadCount += 1;
        staticReadAttestationResult ??=
          createMarketBaseResourceStaticReadAttestation(
            state,
            input,
            dependencies,
            runtimeSession,
          );
        const attestation = staticReadAttestationResult;
        return measureMarketSubPhase("v3LiveScopeRead", () => liveScopeForRead(
          state,
          observedInput,
          dependencies,
          runtimeSession,
          attestation,
          cpuTraceRecorder,
          liveScopeReadCount >= 2 ? 2 : 1,
        ));
      },
      readCurrentBuyOrders: dependencies.readCurrentBuyOrders,
      readOwnOrders: dependencies.readOwnOrders,
      readTerminal: dependencies.readTerminal,
      calculateTransactionEnergy: dependencies.calculateTransactionEnergy,
      cpuUsed: dependencies.cpuUsed,
    },
    scopeBeforePlanning.shadowCursor,
    planningCpuStartedAt,
    cpuTraceRecorder,
  );
  state.lastPlanningSnapshot = planningSnapshotFrom(
    input.tick,
    plan,
    cloneMarketBaseResourceCpuTrace(cpuTraceRecorder),
  );

  const runtimeMismatchAfterPlan = marketBaseResourceRuntimeSnapshotMismatch(
    state,
    runtimeSession,
  );
  if (runtimeMismatchAfterPlan) {
    rollbackPlanningState([]);
    state.blocker = runtimeMismatchAfterPlan;
    rejectOnce(runtimeMismatchAfterPlan);
    return finish(false);
  }
  const afterPlanCpuPhase: MarketBaseResourceCpuCutPhase =
    plan.secondScopeEvidence !== undefined ||
    plan.secondReadEvidence !== undefined
      ? "shadow_batch_read2"
      : "shadow_batch_read1";
  const cpuExceededAfterPlan = marketBaseResourceCpuExceededSince(
    dependencies,
    planningCpuStartedAt,
    cpuTraceRecorder,
    "cpuAfterShadowBatch",
    afterPlanCpuPhase,
  );
  const pureShadowFallbackEligible =
    !plan.selected &&
    isPureSuspendedShadowCpuFallbackState(
      state,
      runtimeSession,
      scopeBeforePlanning,
    );
  if (pureShadowFallbackEligible) {
    // capability 必须在 incomplete/CPU early return 之前铸造。否则 99-cycle
    // 或 qualified lane 已确定的 incomplete 观察会随 outer 全 root 一同
    // 被 CPU gate 丢弃，fallback 管道无法为其保留 canonical commit 义务。
    cpuFallbackCapability = issueMarketBaseResourceCpuFallbackCapability(
      state,
      runtimeSession,
      scopeBeforePlanning,
      ratchetBeforePlanning,
      plan.sampledShadowLaneIds,
      plan.shadowObservations.filter(
        (observation) => observation.result === "incomplete",
      ),
      input.tick,
    );
    if (!cpuFallbackCapability) {
      rollbackPlanningState(plan.shadowObservations);
      if (cpuExceededAfterPlan) {
        markPlanningCpuExceeded(
          state,
          input.tick,
          planningCpuStartedAt,
          dependencies,
          cpuTraceRecorder,
          plan.secondScopeEvidence !== undefined ||
          plan.secondReadEvidence !== undefined
            ? "shadow_batch_read2"
            : "shadow_batch_read1",
        );
      } else {
        state.lastPlanningSnapshot = {
          ...state.lastPlanningSnapshot!,
          observedAt: input.tick,
          complete: false,
          blocker: "market_base_cpu_fallback_capability_unavailable",
          cpuTrace: cloneMarketBaseResourceCpuTrace(cpuTraceRecorder),
        };
        delete state.lastPlanningSnapshot.selected;
      }
      rejectOnce("market_base_cpu_fallback_capability_unavailable");
      return finish(false);
    }
  }
  if (!plan.complete || cpuExceededAfterPlan) {
    // 已确定的 lane-local incomplete 仍随 rollback 进入 apply（no-op：
    // 只中断本轮推进，不作废旧周期证据）；shared/second-read/CPU
    // blocker 不能吞掉这批观察的 canonical 通道。完整观测和 cursor
    // 保持零推进。
    rollbackPlanningState(plan.shadowObservations);
    if (cpuExceededAfterPlan) {
      markPlanningCpuExceeded(
        state,
        input.tick,
        planningCpuStartedAt,
        dependencies,
        cpuTraceRecorder,
        plan.secondScopeEvidence !== undefined ||
        plan.secondReadEvidence !== undefined
          ? "shadow_batch_read2"
          : "shadow_batch_read1",
      );
    }
    const reason =
      (cpuExceededAfterPlan
        ? "market_base_cpu_ceiling_exceeded"
        : plan.blocker) || "market_base_v3_plan_incomplete";
    rejectOnce(reason);
    return finish(false);
  }
  const nextScope =
    scopeBeforePlanning.updatedAt === input.tick &&
    plan.sampledShadowLaneIds.length === 0 &&
    plan.shadowObservations.length === 0 &&
    plan.nextShadowCursor === scopeBeforePlanning.shadowCursor
      ? scopeBeforePlanning
      : applyMarketBaseResourceShadowObservations(
          scopeBeforePlanning,
          input.tick,
          plan.shadowObservations,
          plan.nextShadowCursor,
        );
  const nextRatchet = plan.nextPricingRatchet;
  if (
    !nextRatchet ||
    !validateMarketBaseResourcePricingRatchetState(
      nextRatchet,
      currentV3Permit(runtimeSession.permitContext.state),
    )
  ) {
    rollbackPlanningState(plan.shadowObservations);
    rejectOnce("market_base_v3_pricing_ratchet_candidate_invalid");
    return finish(false);
  }
  if (
    marketBaseResourceCpuExceededSince(
      dependencies,
      planningCpuStartedAt,
      cpuTraceRecorder,
      "cpuAfterInnerApply",
      "inner_apply",
    )
  ) {
    rollbackPlanningState(plan.shadowObservations);
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "inner_apply",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    return finish(false);
  }
  replaceMarketBaseResourceRuntimeScope(state, runtimeSession, nextScope);
  replaceMarketBaseResourceRuntimePricingRatchet(
    state,
    runtimeSession,
    nextRatchet,
  );
  // observe 模式动态地板投影：随成功 planning 周期推进（含纯 shadow
  // 轮），EMA/日锚持续积累；任何 CPU/回滚路径都不会执行到这里，投影
  // 不会超前于 canonical 提交。
  state.dynamicFloorProjection = buildMarketBaseDynamicFloorState({
    previous: state.dynamicFloorProjection,
    tick: input.tick,
    marketDate: nextRatchet.entries.reduce(
      (latest, entry) => (entry.marketDate > latest ? entry.marketDate : latest),
      "",
    ),
    bookBestPrices: plan.firstBookBestPrices ?? [],
    laneSurplus: plan.firstLaneSurplus ?? [],
    ratchetFloorByResource: Object.fromEntries(
      nextRatchet.entries.map((entry) => [entry.resource, entry.value]),
    ),
  });
  if (
    observeMarketBaseResourceCpuTrace(
      cpuTraceRecorder,
      dependencies,
      "cpuAfterInnerApply",
      "inner_apply",
    ).exceeded
  ) {
    const trace = cloneMarketBaseResourceCpuTrace(cpuTraceRecorder);
    // outer 还必须把完整候选 root 私下注册后再做一次 fresh CPU read。
    // 因此这里不能提前消费一次性 fallback capability；先把 working state
    // 回滚到只含已确定 incomplete reset 的安全形态，并让 outer 在最终
    // gate 前物化独立的 reset-only state/session/capability。
    rollbackPlanningState(plan.shadowObservations);
    state.lastPlanningSnapshot = {
      ...state.lastPlanningSnapshot!,
      observedAt: input.tick,
      complete: false,
      blocker: "market_base_cpu_ceiling_exceeded",
      cpuUsed: Math.max(
        MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING,
        cpuTraceRecorder.lastRawDelta,
      ),
      cpuTrace: trace,
    };
    delete state.lastPlanningSnapshot.selected;
    rejectOnce("market_base_cpu_ceiling_exceeded");
    return finish(false);
  }
  state.lastPlanningSnapshot = {
    ...state.lastPlanningSnapshot!,
    cpuUsed: cpuTraceRecorder.lastRawDelta,
    cpuTrace: cloneMarketBaseResourceCpuTrace(cpuTraceRecorder),
  };
  if (plan.first?.complete && !plan.first.blocker) {
    const observed = lastObservedCandidates;
    const attempts: Record<string, "no_bid" | "bid" | "waiting"> = {};
    for (const candidate of observed) {
      const key = `${candidate.roomName}:${candidate.resourceType}`;
      const lane = runtimeSession.scopeContext?.snapshot.laneLifecycles.find(value => value.sellerRoomName === candidate.roomName && value.resource === candidate.resourceType);
      const terminal = Game.rooms?.[candidate.roomName]?.terminal;
      if (!lane || lane.stage !== "continuous" || !laneAllowsRuntimeWrite(runtimeSession, AUTHORITY_EXECUTOR_SHARD, lane) ||
        !terminal || terminal.cooldown > 0 || (terminal.store[candidate.resourceType] ?? 0) < 1_000 ||
        (terminal.store[RESOURCE_ENERGY] ?? 0) < 26_000) { attempts[key] = "waiting"; continue; }
      const bid = plan.first.safeCandidates.some(value => value.roomName === candidate.roomName && value.resourceType === candidate.resourceType);
      const priceRejection = plan.first.rejections.some(value => value.roomName === candidate.roomName && value.resourceType === candidate.resourceType &&
        ["planned_net_below_floor", "worst_case_net_below_floor", "executable_notional_below_minimum"].includes(value.reason));
      attempts[key] = bid ? "bid" : priceRejection || plan.rawOrderCount === 0 ? "no_bid" : "waiting";
    }
    recordBaseMineralOverflow(observed.map(value => value.protectionEntry), input.tick, attempts,
      Object.fromEntries(observed.filter(value => value.overflowTier !== undefined).map(value => [`${value.roomName}:${value.resourceType}`, value.effectiveNetFloor])));
  }
  const selected = plan.selected;
  if (!selected) {
    return finish(true);
  }

  const permit = currentV3Permit(runtimeSession.permitContext.state);
  const executionScope = runtimeSession.scopeContext!.snapshot;
  const lane = executionScope.laneLifecycles.find(
    (candidate) =>
      candidate.sellerRoomName === selected.roomName &&
      candidate.resource === selected.resourceType,
  );
  const room = lane
    ? executionScope.sellerRooms.find(
        (candidate) => candidate.roomInstanceId === lane.roomInstanceId,
      )
    : undefined;
  const grant = lane
    ? permit?.signedLaneGrants.find(
        (candidate) => candidate.laneId === lane.laneId,
      )
    : undefined;
  const executionPolicy =
    grant?.stage === "canary"
      ? ("canary" as const)
      : grant?.stage === "continuous"
        ? ("continuous" as const)
        : undefined;
  const policy =
    MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[
      selected.resourceType as MarketBaseResource
    ];
  const trial = permit ? activeMarketEgressTrialR2({
    tick: input.tick,
    permitId: permit.permitId,
    permitEpoch: permit.epoch,
  }) : null;
  const signedPolicy = permit?.resourcePolicies.find((value) =>
    value.resource === selected.resourceType);
  const capacityState = readMarketEgressTrialCapacityState(
    selected.roomName, input.tick);
  const accelerated = !!trial && !!grant && !!signedPolicy &&
    capacityState !== null && trialLaneEligible({
      roomName: selected.roomName,
      resource: selected.resourceType,
      stage: grant.stage,
      capacityState,
      policyCooldownTicks: signedPolicy.cooldownTicks,
    });
  const trialNotBefore = accelerated && trial && state.ledger
    ? trialCooldownNotBefore(trial, state.ledger.confirmedCooldownNotBefore)
    : undefined;
  const outgoing = plan.secondOutgoingWindow;
  const terminal = plan.selectedTerminalRead;
  const outgoingKeys = outgoing ? sortedOutgoingKeys(outgoing) : [];
  const firstReadFingerprint = plan.first?.planningFingerprint;
  const secondReadFingerprint = plan.second?.planningFingerprint;
  const evidence = plan.secondReadEvidence;
  const observedOrderAmount =
    selected.order.remainingAmount ?? selected.order.amount;
  let executionShard = "";
  try {
    executionShard = dependencies.readExecutorShard() || "";
  } catch {
    executionShard = "";
  }
  const evidenceComplete = Boolean(
    permit &&
    lane &&
    room &&
    grant &&
    executionPolicy &&
    policy &&
    selected.order.roomName &&
    laneAllowsRuntimeWrite(runtimeSession, executionShard, lane) &&
    grant.stage === lane.stage &&
    lane.status === "writable" &&
    (grant.stage === "canary" || grant.stage === "continuous") &&
    firstReadFingerprint &&
    secondReadFingerprint &&
    firstReadFingerprint === secondReadFingerprint &&
    plan.firstRosterFingerprint &&
    plan.secondRosterFingerprint &&
    plan.firstRosterFingerprint === plan.secondRosterFingerprint &&
    plan.firstLaneSetFingerprint &&
    plan.secondLaneSetFingerprint &&
    plan.firstLaneSetFingerprint === plan.secondLaneSetFingerprint &&
    sameFullReadComponents(plan) &&
    evidence &&
    outgoing &&
    outgoing.observedAt === input.tick &&
    outgoing.coversAttemptAt &&
    new Set(outgoingKeys).size === outgoingKeys.length &&
    outgoingKeys.length <= MAX_OUTGOING_TRANSACTIONS &&
    terminal &&
    terminal.roomName === selected.roomName &&
    terminal.cooldown === 0 &&
    plan.secondCredits !== undefined &&
    Number.isSafeInteger(observedOrderAmount) &&
    observedOrderAmount >= selected.plannedAmount,
  );
  const runtimeMismatchBeforePrepare =
    marketBaseResourceRuntimeSnapshotMismatch(state, runtimeSession);
  if (runtimeMismatchBeforePrepare) {
    state.blocker = runtimeMismatchBeforePrepare;
    rejectOnce(runtimeMismatchBeforePrepare);
    return finish(false);
  }
  if (
    !evidenceComplete ||
    !permit ||
    !lane ||
    !room ||
    !grant ||
    !executionPolicy ||
    !policy ||
    !outgoing ||
    !terminal ||
    !evidence ||
    !firstReadFingerprint ||
    !secondReadFingerprint ||
    !plan.firstRosterFingerprint ||
    !plan.secondRosterFingerprint ||
    !plan.firstLaneSetFingerprint ||
    !plan.secondLaneSetFingerprint ||
    !selected.order.roomName ||
    plan.secondCredits === undefined
  ) {
    rejectOnce("market_base_v3_execution_evidence_incomplete");
    return finish(false);
  }
  if (
    marketBaseResourceCpuExceededSince(
      dependencies,
      planningCpuStartedAt,
      cpuTraceRecorder,
      "cpuAfterInnerApply",
      "inner_apply",
    )
  ) {
    rollbackPlanningState(plan.shadowObservations);
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "inner_apply",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    return finish(false);
  }
  const runtimeMismatchAtWriteGate = marketBaseResourceRuntimeSnapshotMismatch(
    state,
    runtimeSession,
  );
  if (runtimeMismatchAtWriteGate) {
    state.blocker = runtimeMismatchAtWriteGate;
    rejectOnce(runtimeMismatchAtWriteGate);
    return finish(false);
  }
  const prepareCpu = observeMarketBaseResourceCpuTrace(
    cpuTraceRecorder,
    dependencies,
    "cpuAfterInnerApply",
    "inner_apply",
  );
  if (prepareCpu.exceeded || prepareCpu.rawDelta === undefined) {
    rollbackPlanningState(plan.shadowObservations);
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "inner_apply",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    return finish(false);
  }
  if (
    prepareCpu.rawDelta >
    MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING -
      MARKET_BASE_RESOURCE_PREPARE_MIN_REMAINING_CPU
  ) {
    rejectOnce("market_base_v3_prepare_cpu_headroom_insufficient");
    actions.push("market-base-v3-prepare-deferred-cpu-headroom");
    return finish(true);
  }

  const requestId = canonicalStableHashV1({
    attemptSeq: runtimeSession.ledgerContext.state.nextAttemptSeq,
    domain: "market-base-resource:request-v1",
    laneId: lane.laneId,
    orderId: selected.order.id,
    tick: input.tick,
  });
  const ledgerBeforePrepare = state.ledger;
  const quotaProjectionBeforePrepare = state.quotaProjection;
  const runtimeAnchorBeforePrepare = runtimeSession.ledgerRuntimeAnchor;
  const runtimeContextBeforePrepare = runtimeSession.ledgerContext;
  const prepared = prepareMarketBaseResourceAttemptWithRuntimeContext(
    runtimeSession.ledgerContext,
    {
      tick: input.tick,
      resourceLimit: policy.rollingMaxAmount,
      permitChain: runtimeSession.ledgerContext.permitChain,
      executionPolicy: executionPolicy,
      historicalPermit: buildMarketBaseResourceHistoricalPermitRef(permit),
      historicalLane: {
        laneId: lane.laneId,
        roomInstanceId: lane.roomInstanceId,
        sellerRoom: lane.sellerRoomName,
        resource: lane.resource,
        resourcePolicyId: policy.policyId,
        resourcePolicyFingerprint: policy.fingerprint,
        roomFingerprint: room.fingerprint,
        sharedPolicyFingerprint: executionScope.sharedPolicyFingerprint,
      },
      firstDynamicScope: {
        admissionPolicyFingerprint:
          permit.sharedPolicy.roomAdmissionPolicy.fingerprint,
        rosterFingerprint: plan.firstRosterFingerprint,
        laneSetFingerprint: plan.firstLaneSetFingerprint,
        laneId: lane.laneId,
        roomInstanceId: lane.roomInstanceId,
      },
      secondDynamicScope: {
        admissionPolicyFingerprint:
          permit.sharedPolicy.roomAdmissionPolicy.fingerprint,
        rosterFingerprint: plan.secondRosterFingerprint,
        laneSetFingerprint: plan.secondLaneSetFingerprint,
        laneId: lane.laneId,
        roomInstanceId: lane.roomInstanceId,
      },
      fullReads: {
        firstReadFingerprint,
        secondReadFingerprint,
        bookFingerprint: evidence.bookFingerprint,
        protectionFingerprint: evidence.protectionFingerprint,
        energyReadinessFingerprint: evidence.energyReadinessFingerprint,
        arbiterFingerprint: evidence.arbiterFingerprint,
      },
      executionEvidence: {
        observedOrderPriceMilli: selected.grossPriceMilli,
        observedOrderAmount,
        effectiveEnergyShadowPriceMilli: selected.energyShadowPriceMilli,
        effectiveNetFloorMilli: selected.effectiveNetFloorMilli,
        terminalResourceBefore: terminal.resourceAmount,
        terminalEnergyBefore: terminal.energy,
        terminalCooldownBefore: terminal.cooldown,
        creditsBefore: plan.secondCredits,
        outgoingTransactionKeysBefore: outgoingKeys,
        outgoingWindowObservedAt: outgoing.observedAt,
        ...(outgoing.oldestTime === undefined
          ? {}
          : {
              outgoingWindowOldestTime: outgoing.oldestTime,
            }),
        ...(outgoing.newestTime === undefined
          ? {}
          : {
              outgoingWindowNewestTime: outgoing.newestTime,
            }),
        outgoingWindowCoversAttemptAt: true,
      },
      orderId: selected.order.id,
      orderRoom: selected.order.roomName,
      plannedTransactionEnergy: selected.transactionEnergy,
      plannedNetCreditsMilli: selected.netCreditsMilli,
      worstUnitNetCreditsMilli: selected.worstCaseNetCreditsMilli,
      evidenceKeyHint: requestId,
      ...(selected.overflowTier && selected.overflowTier !== "normal" && grant?.stage === "continuous" && state.ledger
        ? { overflowCooldownNotBefore: baseMineralOverflowCooldownNotBefore(state.ledger.confirmedCooldownNotBefore,
              state.ledger.checkpoint.confirmedCooldownNotBeforeHighWater, selected.overflowTier),
            overflowTier: selected.overflowTier }
        : {}),
      ...(trialNotBefore !== undefined && permit
        ? { trialCooldownNotBefore: trialNotBefore, trialPermitId: permit.permitId }
        : {}),
    },
  );
  applyMarketBaseResourceRuntimeLedgerOperation(
    state,
    runtimeSession,
    prepared,
  );
  updateQuotaProjection(state, input.tick, runtimeSession);
  if (!prepared.ok || prepared.action !== "prepared" || !state.ledger.pending) {
    const reason = prepared.blockerCode || "market_base_v3_prepare_failed";
    state.blocker =
      prepared.action === "blocked" && state.ledger.blocker
        ? reason
        : state.blocker;
    rejectOnce(reason);
    actions.push(`market-base-v3-prepare-blocked:${reason}`);
    return finish(false);
  }
  actions.push(`market-base-v3-prepared:${requestId}`);

  if (
    marketBaseResourceCpuExceededSince(
      dependencies,
      planningCpuStartedAt,
      cpuTraceRecorder,
      "cpuAfterInnerApply",
      "inner_apply",
    )
  ) {
    state.ledger = ledgerBeforePrepare;
    runtimeSession.ledgerRuntimeAnchor = runtimeAnchorBeforePrepare;
    runtimeSession.ledgerContext = runtimeContextBeforePrepare;
    state.quotaProjection = quotaProjectionBeforePrepare;
    rollbackPlanningState(plan.shadowObservations);
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "inner_apply",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    actions.push(`market-base-v3-prepare-rolled-back-cpu:${requestId}`);
    return finish(false);
  }
  const runtimeMismatchBeforeCommit = marketBaseResourceRuntimeSnapshotMismatch(
    state,
    runtimeSession,
  );
  if (runtimeMismatchBeforeCommit) {
    state.ledger = ledgerBeforePrepare;
    runtimeSession.ledgerRuntimeAnchor = runtimeAnchorBeforePrepare;
    runtimeSession.ledgerContext = runtimeContextBeforePrepare;
    state.quotaProjection = quotaProjectionBeforePrepare;
    rollbackPlanningState(plan.shadowObservations);
    state.blocker = runtimeMismatchBeforeCommit;
    rejectOnce(runtimeMismatchBeforeCommit);
    actions.push(
      `market-base-v3-prepare-rolled-back-runtime-mismatch:${requestId}`,
    );
    return finish(false);
  }

  let preparedStateCommitted = false;
  try {
    preparedStateCommitted =
      dependencies.commitPreparedState(
        state,
        runtimeSession.ledgerRuntimeAnchor,
        issueMarketBaseResourceReadinessRuntimeCapability(
          state,
          runtimeSession,
          input.tick,
        ),
      ) === true;
  } catch {
    preparedStateCommitted = false;
  }
  if (!preparedStateCommitted) {
    state.ledger = ledgerBeforePrepare;
    runtimeSession.ledgerRuntimeAnchor = runtimeAnchorBeforePrepare;
    runtimeSession.ledgerContext = runtimeContextBeforePrepare;
    state.quotaProjection = quotaProjectionBeforePrepare;
    rollbackPlanningState(plan.shadowObservations);
    rejectOnce("market_base_v3_prepared_commit_failed");
    actions.push(`market-base-v3-prepared-commit-failed:${requestId}`);
    return finish(false);
  }
  actions.push(`market-base-v3-prepared-committed:${requestId}`);

  if (!dependencies.validatePreparedCanonicalRoot()) {
    rejectOnce("market_base_v3_prepared_root_cas_failed");
    actions.push(`market-base-v3-committed-root-cas-failed:${requestId}`);
    return finish(false);
  }

  const runtimeMismatchAfterCommit = marketBaseResourceRuntimeSnapshotMismatch(
    state,
    runtimeSession,
  );
  if (runtimeMismatchAfterCommit) {
    state.blocker = runtimeMismatchAfterCommit;
    rejectOnce(runtimeMismatchAfterCommit);
    actions.push(
      `market-base-v3-committed-pending-runtime-mismatch:${requestId}`,
    );
    return finish(false);
  }

  // commit 本身也计入同一个 25 CPU 窗口。此后 pending 已成为 canonical
  // WAL，任何停止都只能保守保留，交由下一 tick frozen preflight 收敛。
  if (
    marketBaseResourceCpuExceededSince(
      dependencies,
      planningCpuStartedAt,
      cpuTraceRecorder,
      "cpuAfterInnerApply",
      "inner_apply",
    )
  ) {
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "inner_apply",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    actions.push(`market-base-v3-committed-pending-cpu:${requestId}`);
    return finish(false);
  }
  const runtimeMismatchBeforeClaim = marketBaseResourceRuntimeSnapshotMismatch(
    state,
    runtimeSession,
  );
  if (runtimeMismatchBeforeClaim) {
    state.blocker = runtimeMismatchBeforeClaim;
    rejectOnce(runtimeMismatchBeforeClaim);
    actions.push(
      `market-base-v3-committed-pending-runtime-mismatch:${requestId}`,
    );
    return finish(false);
  }

  let claimed = false;
  try {
    claimed = dependencies.claimPrepared({
      requestId,
      roomName: selected.roomName,
      actor: MARKET_BASE_RESOURCE_ACTOR,
      attemptAt: input.tick,
    });
  } catch {
    claimed = false;
  }
  if (!claimed) {
    rejectOnce("market_base_v3_claim_failed");
    actions.push(`market-base-v3-claim-failed:${requestId}`);
    // 尚未调用 deal，下一 tick以完整 outgoing+物理不变证据确定
    // not_filled；本 tick保留 frozen pending，避免猜测式清除。
    return finish(false);
  }

  if (!dependencies.validatePreparedCanonicalRoot()) {
    try {
      dependencies.releasePrepared(requestId);
    } catch {
      // Claim 有 bounded TTL；outer canonical root 不再 exact 时零 deal。
    }
    rejectOnce("market_base_v3_prepared_root_cas_failed");
    actions.push(`market-base-v3-claim-released-root-cas-failed:${requestId}`);
    return finish(false);
  }

  const runtimeMismatchAfterClaim = marketBaseResourceRuntimeSnapshotMismatch(
    state,
    runtimeSession,
  );
  if (runtimeMismatchAfterClaim) {
    try {
      dependencies.releasePrepared(requestId);
    } catch {
      // Claim 有 bounded TTL；无论 release 是否成功，runtime mismatch
      // 都禁止进入 deal。
    }
    state.blocker = runtimeMismatchAfterClaim;
    rejectOnce(runtimeMismatchAfterClaim);
    actions.push(`market-base-v3-claim-released-runtime-mismatch:${requestId}`);
    return finish(false);
  }

  if (
    marketBaseResourceCpuExceededSince(
      dependencies,
      planningCpuStartedAt,
      cpuTraceRecorder,
      "cpuAfterInnerApply",
      "inner_apply",
    )
  ) {
    try {
      dependencies.releasePrepared(requestId);
    } catch {
      // A failed release is still safer than calling deal after the CPU gate;
      // the arbiter claim has a bounded TTL and no market write occurred.
    }
    markPlanningCpuExceeded(
      state,
      input.tick,
      planningCpuStartedAt,
      dependencies,
      cpuTraceRecorder,
      "inner_apply",
    );
    rejectOnce("market_base_cpu_ceiling_exceeded");
    actions.push(`market-base-v3-claim-released-pending-cpu:${requestId}`);
    return finish(false);
  }
  const runtimeMismatchBeforeDeal = marketBaseResourceRuntimeSnapshotMismatch(
    state,
    runtimeSession,
  );
  if (runtimeMismatchBeforeDeal) {
    try {
      dependencies.releasePrepared(requestId);
    } catch {
      // Claim 有 bounded TTL；runtime mismatch 始终禁止进入 deal。
    }
    state.blocker = runtimeMismatchBeforeDeal;
    rejectOnce(runtimeMismatchBeforeDeal);
    actions.push(`market-base-v3-claim-released-runtime-mismatch:${requestId}`);
    return finish(false);
  }

  let result: unknown;
  if (accelerated && permit && state.ledger?.pending) {
    const pending = state.ledger.pending;
    let reserved = false;
    try {
      reserved = reserveMarketEgressTrialNative({
        tick: input.tick,
        permitId: permit.permitId,
        permitEpoch: permit.epoch,
        attemptSeq: pending.attemptSeq,
        pendingEvidenceHash: pending.frozenEvidenceHash,
        roomName: selected.roomName,
        resource: selected.resourceType,
        stage: grant!.stage,
        capacityState: capacityState!,
        policyCooldownTicks: signedPolicy!.cooldownTicks,
        amount: selected.plannedAmount,
        baselineNotBefore: state.ledger.confirmedCooldownNotBefore,
      });
    } catch {
      reserved = false;
    }
    if (!reserved) {
      try { dependencies.releasePrepared(requestId); } catch { /* bounded claim TTL */ }
      stopMarketEgressTrialR2("reservation_failed");
      rejectOnce("market_egress_r2_reservation_failed");
      return finish(false);
    }
    if (marketBaseResourceCpuExceededSince(
      dependencies,
      planningCpuStartedAt,
      cpuTraceRecorder,
      "cpuAfterInnerApply",
      "inner_apply",
    )) {
      try { dependencies.releasePrepared(requestId); } catch { /* bounded claim TTL */ }
      markPlanningCpuExceeded(
        state, input.tick, planningCpuStartedAt, dependencies,
        cpuTraceRecorder, "inner_apply",
      );
      rejectOnce("market_base_cpu_ceiling_exceeded");
      return finish(false);
    }
  }
  try {
    writes += 1;
    result = dependencies.executePrepared({
      requestId,
      roomName: selected.roomName,
      actor: MARKET_BASE_RESOURCE_ACTOR,
      attemptAt: input.tick,
      orderId: selected.order.id,
      amount: selected.plannedAmount,
    });
  } catch {
    actions.push(`market-base-v3-deal-unknown:${requestId}`);
    return finish(true);
  }
  if (isExplicitMarketNonOkReturnCode(result)) {
    const reason = `market_non_ok:${result}`;
    recordFailedPending(
      state,
      input.tick,
      reason,
      actions,
      dependencies,
      runtimeSession,
    );
    rejectOnce(`market_base_v3_deal_error:${result}`);
  } else {
    actions.push(`market-base-v3-deal-submitted:${requestId}`);
  }
  return finish(true);
}

/**
 * 早期 preflight 只按 frozen pending 证据收敛 WAL，不读取 current roster
 * 来重解释历史 exposure。
 */
export function runMarketBaseResourcePreflight(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  dependencies: MarketBaseResourceRuntimeDependencies = defaultMarketBaseResourceRuntimeDependencies,
  readinessRuntimeCapability?: MarketBaseResourceReadinessRuntimeCapability,
): MarketBaseResourceAutomationResult {
  const actions: string[] = [];
  const rejectedByReason: Record<string, number> = {};
  state.preflightAt = tick;
  if (state.hardBlocker) {
    state.blocker = state.hardBlocker.code;
    incrementReason(rejectedByReason, state.hardBlocker.code);
    return {
      actions,
      rejectedByReason,
      writes: 0,
      planComplete: false,
      state,
    };
  }
  delete state.blocker;
  let runtimeSession: MarketBaseResourceRuntimeSession | undefined;
  if (state.permitChain && state.ledger) {
    const supplied =
      readinessRuntimeCapability &&
      typeof readinessRuntimeCapability === "object"
        ? marketBaseResourceReadinessRuntimeCapabilities.get(
            readinessRuntimeCapability as object,
          )
        : undefined;
    const opened =
      supplied?.tick === tick &&
      supplied.state === state &&
      !marketBaseResourceRuntimeSnapshotMismatch(state, supplied.session)
        ? ({ ok: true, session: supplied.session } as const)
        : openMarketBaseResourceRuntimeSession(state, tick, dependencies);
    if ("reason" in opened) {
      state.blocker = opened.reason;
    } else {
      runtimeSession = opened.session;
      const ledgerBeforePreflight = state.ledger;
      reconcilePending(state, tick, actions, dependencies, runtimeSession);
      advanceWalUntilWaiting(
        state,
        tick,
        actions,
        dependencies,
        runtimeSession,
      );
      if (!state.ledger?.blocker) {
        applyFinalizedLifecycleReceipts(state, runtimeSession);
        if (state.ledger !== ledgerBeforePreflight) {
          updateQuotaProjection(state, tick, runtimeSession);
        }
      }
    }
  } else if (state.permitChain || state.ledger) {
    state.blocker = "market_base_v3_preflight_invalid";
  }
  if (state.blocker) {
    incrementReason(rejectedByReason, state.blocker);
  }
  return {
    actions,
    rejectedByReason,
    writes: 0,
    planComplete: !state.blocker,
    state,
    ...(runtimeSession
      ? {
          ledgerRuntimeAnchor: runtimeSession.ledgerRuntimeAnchor,
          readinessRuntimeCapability:
            issueMarketBaseResourceReadinessRuntimeCapability(
              state,
              runtimeSession,
              tick,
            ),
        }
      : {}),
  };
}

export { MARKET_BASE_RESOURCE_MAX_ACTIVE_ROOMS } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_MAX_ACTIVE_LANES } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_MAX_RAW_ORDERS_PER_RESOURCE } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_MAX_ELIGIBLE_ORDERS_PER_RESOURCE } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_MAX_DISTINCT_ORDER_ROOMS } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_MAX_TRANSACTION_COST_EVALUATIONS } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING } from "@/runtime/marketBaseResourcePlanning";
export { MARKET_BASE_RESOURCE_CPU_TRACE_MAX } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceCpuCutPhase } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceMarketFactsDisposition } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceCpuTrace } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourcePlanningSnapshot } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourcePricingRatchetState } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceOutgoingTransaction } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceOutgoingWindow } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourcePlanningScopeSnapshot } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceTerminalRead } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourcePlanningDependencies } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceShadowObservation } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceTwoReadPlan } from "@/runtime/marketBaseResourcePlanning";
export type { MarketBaseResourceFullReadEvidence } from "@/runtime/marketBaseResourcePlanning";
export { planMarketBaseResourceTwoRead } from "@/runtime/marketBaseResourcePlanning";
