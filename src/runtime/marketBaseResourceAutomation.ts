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
  createMarketDirectContinuousDetachedBookSnapshot,
  isExactMarketDirectContinuousSecondRead,
  issueMarketDirectContinuousInvocationBookCapability,
  MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
  planMarketDirectContinuous,
  type MarketDirectContinuousBook,
  type MarketDirectContinuousDetachedBookSnapshot,
  type MarketDirectContinuousEntryInput,
  type MarketDirectContinuousInvocationBookCapability,
  type MarketDirectContinuousLaneInput,
  type MarketDirectContinuousPlanningResult,
  type PlanMarketDirectContinuousInput,
} from "@/runtime/marketDirectContinuousPlanner";
import {
  MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
  canonicalStableHashV1,
  MARKET_DIRECT_CONTINUOUS_SCHEMA,
  marketDirectPermitAllowsNewDeal,
  validateMarketDirectContinuousPermitChain,
  type MarketDirectEntryLifecycle,
  type MarketDirectContinuousPermit,
  type MarketDirectPermitChainState,
} from "@/runtime/marketDirectContinuousPolicy";
import {
  validateContinuousLedger,
  type MarketDirectContinuousLedger,
} from "@/runtime/marketDirectContinuousLedger";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
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
  MARKET_BASE_RESOURCE_MAX_LANES,
  MARKET_BASE_RESOURCE_MAX_ROOMS,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  type MarketBaseResource,
  buildMarketBaseDynamicFloorState,
  createMarketBaseRoomAdmissionPolicy,
  createMarketBaseSharedPolicy,
  marketBaseDerivedLaneSetFingerprint,
  marketBaseEnforcedDynamicFloors,
  marketBaseRoomObservationIsAdmitted,
  reconcileMarketBaseDerivedLanes,
  reconcileMarketBaseSellerRooms,
  validateMarketBaseDerivedLaneLifecycle,
  type MarketBaseDerivedLaneLifecycle,
  type MarketBaseDynamicFloorState,
  type MarketBaseDynamicFloorSurplusLane,
  type MarketBaseRoomIncarnationRegistry,
  type MarketBaseRoomObservation,
  type MarketBaseSellerRoomState,
} from "@/runtime/marketBaseResourcePolicy";
import {
  buildMarketBaseResourceReadinessAuthorization,
  buildMarketBaseResourceReadinessAuthorizationWithRuntimeContext,
  createMarketBaseResourcePermitRuntimeContext,
  hasAcceptedMarketBaseResourceV3Successor,
  marketBaseResourcePermitAllowsNewDeal,
  marketBaseResourcePermitAllowsNewDealWithRuntimeContext,
  marketBaseResourceSellerRoomBasis,
  validateMarketBaseResourcePermitRuntimeGate,
  validateMarketBaseResourcePermitChain,
  type MarketBaseResourceLaneTombstoneDischarge,
  type MarketBaseResourcePermit,
  type MarketBaseResourcePermitChainState,
  type MarketBaseResourcePermitRuntimeContext,
  type MarketBaseResourceReadinessAuthorization,
} from "@/runtime/marketBaseResourcePermit";
import {
  advanceMarketBaseResourceWal,
  advanceMarketBaseResourceWalWithRuntimeContext,
  buildMarketBaseResourceHistoricalPermitRef,
  computeMarketBaseResourceQuota,
  createMarketBaseResourceLedgerRuntimeContext,
  hasMarketBaseResourceProcessedEvidenceKeyWithRuntimeContext,
  MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
  MARKET_BASE_RESOURCE_LANE_QUOTA_LIMIT,
  MARKET_BASE_RESOURCE_ROOM_QUOTA_LIMIT,
  inspectMarketBaseResourceCanaryGrantAvailability,
  inspectMarketBaseResourceCanaryGrantAvailabilityWithRuntimeContext,
  marketBaseResourceCurrentWalProjectionWithRuntimeContext,
  marketBaseResourceQuotaProjection,
  marketBaseResourceQuotaProjectionWithRuntimeContext,
  marketBaseResourceConfirmedCanaryFor,
  marketBaseResourceConfirmedCanaryForWithRuntimeContext,
  prepareMarketBaseResourceAttempt,
  prepareMarketBaseResourceAttemptWithRuntimeContext,
  recordMarketBaseResourceOutcome,
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

export const MARKET_BASE_RESOURCE_MAX_ACTIVE_ROOMS = 16;
export const MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES = 32;
export const MARKET_BASE_RESOURCE_MAX_ACTIVE_LANES = 112;
export const MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE = 8;
export const MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION =
  "market-base-resource-scope-lane-tombstones-v1" as const;
export const MARKET_BASE_RESOURCE_MAX_RAW_ORDERS_PER_RESOURCE = 1_000;
export const MARKET_BASE_RESOURCE_MAX_ELIGIBLE_ORDERS_PER_RESOURCE = 200;
export const MARKET_BASE_RESOURCE_MAX_DISTINCT_ORDER_ROOMS = 128;
export const MARKET_BASE_RESOURCE_MAX_TRANSACTION_COST_EVALUATIONS = 4_096;
export const MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING = 25;
// 准备 WAL 后还需 canonical root 提交、claim 与 deal；仅在剩余预算
// 足以覆盖这段写前路径时才消耗一次性 canary grant。
const MARKET_BASE_RESOURCE_PREPARE_MIN_REMAINING_CPU = 12;
export const MARKET_BASE_RESOURCE_CPU_TRACE_MAX = 100;
const MARKET_BASE_RESOURCE_SHADOW_CURSOR_V2_PREFIX =
  "mbr-shadow-cursor-v2|" as const;

export type MarketBaseResourceCpuCutPhase =
  | "outer_session"
  | "scope_core_read1"
  | "scope_core_read2"
  | "market_facts_read1"
  | "market_facts_read2"
  | "shadow_batch_read1"
  | "shadow_batch_read2"
  | "inner_apply"
  | "outer_precommit";

export type MarketBaseResourceMarketFactsDisposition =
  | "not_reached"
  | "skipped_no_consumer"
  | "read";

/**
 * 仅用于诊断同一个 outer CPU 窗口。字段不进入 permit、scope evidence、
 * pricing、protection、quota、排序或授权；有界值也绝不反向驱动 CPU gate。
 */
export interface MarketBaseResourceCpuTrace {
  observedAt: number;
  cpuAfterOuterSession: number | null;
  cpuAfterScopeCore: number | null;
  cpuAfterMarketFacts: number | null;
  cpuAfterShadowBatch: number | null;
  cpuAfterInnerApply: number | null;
  cpuCutPhase: MarketBaseResourceCpuCutPhase | null;
  marketFactsDisposition: MarketBaseResourceMarketFactsDisposition;
}

type MarketBaseResourceCpuTraceField =
  | "cpuAfterOuterSession"
  | "cpuAfterScopeCore"
  | "cpuAfterMarketFacts"
  | "cpuAfterShadowBatch"
  | "cpuAfterInnerApply";

const MARKET_BASE_RESOURCE_CPU_TRACE_FIELDS:
  readonly MarketBaseResourceCpuTraceField[] = [
    "cpuAfterOuterSession",
    "cpuAfterScopeCore",
    "cpuAfterMarketFacts",
    "cpuAfterShadowBatch",
    "cpuAfterInnerApply",
  ];

interface MarketBaseResourceCpuTraceRecorder {
  readonly startedAt: number;
  readonly trace: MarketBaseResourceCpuTrace;
  lastRawDelta: number;
}

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

function pricingRatchetPayload(input: {
  initializedAt: number;
  entries: readonly {
    resource: MarketBaseResource;
    value: number;
    marketDate: string;
  }[];
}): unknown {
  return {
    domain: "market-base-resource:pricing-ratchet-state-v1",
    schemaVersion: 1,
    initializedAt: input.initializedAt,
    bootstrapFingerprint: MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint,
    entries: input.entries,
  };
}

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

export function validateMarketBaseResourcePricingRatchetState(
  value: unknown,
  permit?: MarketBaseResourcePermit,
): value is MarketBaseResourcePricingRatchetState {
  if (!isPlainRecord(value)) return false;
  const state = value as unknown as MarketBaseResourcePricingRatchetState;
  if (
    state.schemaVersion !== 1 ||
    state.bootstrapFingerprint !==
      MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint ||
    !Number.isSafeInteger(state.initializedAt) ||
    state.initializedAt < 0 ||
    !Array.isArray(state.entries) ||
    state.entries.length !== MARKET_BASE_RESOURCE_CATALOG.length ||
    typeof state.fingerprint !== "string"
  ) {
    return false;
  }
  for (let index = 0; index < MARKET_BASE_RESOURCE_CATALOG.length; index += 1) {
    const resource = MARKET_BASE_RESOURCE_CATALOG[index];
    const entry = state.entries[index];
    const signed = permit?.ratchetHighWater.find(
      (candidate) => candidate.resource === resource,
    );
    if (
      !entry ||
      entry.resource !== resource ||
      !Number.isFinite(entry.value) ||
      entry.value <
        MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[resource].ratchetFloor ||
      (signed !== undefined && entry.value < signed.ratchetFloor) ||
      typeof entry.marketDate !== "string" ||
      entry.marketDate < MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.historyDate
    ) {
      return false;
    }
  }
  return (
    state.fingerprint ===
    canonicalStableHashV1(
      pricingRatchetPayload({
        initializedAt: state.initializedAt,
        entries: state.entries,
      }),
    )
  );
}

export interface MarketBaseResourceScopeState {
  schemaVersion: 1;
  accountIdentity: string;
  sharedPolicyFingerprint: string;
  roomRegistry: MarketBaseRoomIncarnationRegistry;
  sellerRooms: readonly MarketBaseSellerRoomState[];
  laneLifecycles: readonly MarketBaseDerivedLaneLifecycle[];
  recentLaneTombstones: ReadonlyArray<
    MarketBaseDerivedLaneLifecycle & {
      retiredAt: number;
    }
  >;
  laneTombstoneDischargeCheckpoint: MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint;
  rosterFingerprint: string;
  laneSetFingerprint: string;
  updatedAt: number;
  shadowCursor?: string;
}

export interface MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint {
  schemaVersion: 1;
  hashRevision: typeof MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION;
  dischargedCount: number;
  dischargedPrefixHead: string;
  lastPermitCheckpointCommitment: string;
  checkpointCommitment: string;
}

export interface MarketBaseResourcePlanningSnapshot {
  observedAt: number;
  complete: boolean;
  blocker?: string;
  selected?: {
    laneId?: string;
    resource: string;
    roomName: string;
    orderId: string;
    grossPrice: number;
    unitNetPrice: number;
    transactionEnergy: number;
  };
  sampledShadowLaneIds: string[];
  cpuUsed: number;
  rawOrderCount: number;
  eligibleOrderCount: number;
  distinctOrderRoomCount: number;
  transactionCostEvaluationBudget: number;
  shadowPlannerMode:
    | "none"
    | "per_lane"
    | "batch_zero_candidate"
    | "batch_candidate"
    | "batch_fallback";
  shadowPlannerInvocationCount: number;
  actualTransactionEnergyEvaluations: number;
  evaluatedShadowResourceCount: number;
  candidateIdentityOrderChecks: number;
  cpuTrace?: MarketBaseResourceCpuTrace;
  /** 本轮 shadow observation 的 incomplete blocker 频次（诊断合同）。 */
  shadowBlockers?: Record<string, number>;
}

export interface MarketBaseResourcePricingRatchetState {
  schemaVersion: 1;
  initializedAt: number;
  bootstrapFingerprint: string;
  entries: readonly {
    resource: MarketBaseResource;
    value: number;
    marketDate: string;
  }[];
  fingerprint: string;
}

export interface MarketBaseResourceTrustedFloorObservation {
  value: number;
  marketDate: string;
  updatedAt: number;
}

export type MarketBaseResourceTrustedFloorResource =
  MarketBaseResource | typeof RESOURCE_ENERGY;

export interface MarketBaseResourceHardBlocker {
  code: string;
  detectedAt: number;
  detailHash: string;
}

export interface MarketBaseResourcePermitProposal {
  schemaVersion: 3;
  kind: "v2-cutover" | "v3-successor" | "v3-policy-migration";
  proposalId: string;
  proposedAt: number;
  sourceStateFingerprint: string;
  operatorAuthorizationFingerprint: string;
  accountIdentity: string;
  executorShard: "shard1";
  rosterFingerprint: string;
  laneSetFingerprint: string;
  targetScope: MarketBaseResourceScopeState;
  targetPermitChain: MarketBaseResourcePermitChainState;
  /** 策略迁移只持久化新增 permit；accept 从现役链重建并校验完整目标链。 */
  migrationChainEncoding?: "appended-permit-only-v1";
  targetLedger: MarketBaseResourceLedger;
  targetPricingRatchet: MarketBaseResourcePricingRatchetState;
  targetTrustedFloors: Partial<
    Record<
      ResourceConstant,
      {
        value: number;
        marketDate: string;
        updatedAt: number;
      }
    >
  >;
}

export interface MarketBaseResourceV3RuntimeState {
  schemaVersion: 3;
  catalog: {
    revision: typeof MARKET_BASE_RESOURCE_CATALOG_REVISION;
    configRevision: typeof MARKET_BASE_RESOURCE_CONFIG_REVISION;
    resources: readonly string[];
  };
  scope?: MarketBaseResourceScopeState;
  permitChain?: MarketBaseResourcePermitChainState;
  ledger?: MarketBaseResourceLedger;
  quotaProjection?: {
    observedAt: number;
    cooldownNotBefore: number;
    retryNotBefore: number;
    global?: {
      cap: number;
      confirmed: number;
      unmatched: number;
    };
    resources: Record<
      string,
      { cap: number; confirmed: number; unmatched: number }
    >;
    rooms: Record<
      string,
      { cap: number; confirmed: number; unmatched: number }
    >;
    lanes: Record<
      string,
      { cap: number; confirmed: number; unmatched: number }
    >;
  };
  readinessAuthorization?:
    | MarketBaseResourceReadinessAuthorization
    | {
        schemaVersion: 3;
        validated: true;
        status: "authorized";
        revision: string;
        updatedAt: number;
        expiresAt: number;
        maxTransactionEnergy: 1_000;
        sourcePermitVersion: 2;
        rooms: readonly {
          roomName: string;
          roomInstanceId: string;
          terminalId: string;
          status: "authorized";
        }[];
      };
  lastPlanningSnapshot?: MarketBaseResourcePlanningSnapshot;
  lastLifecycleAppliedAttemptSeq?: number;
  lastWalAdvanceAt?: number;
  preflightAt?: number;
  cutoverLatched?: true;
  pricingRatchet?: MarketBaseResourcePricingRatchetState;
  /**
   * observe 模式动态地板投影（动态层，不进 permit 签名）。仅诊断与
   * 验收窗口使用；enforce 切换（一次迁移操作）前不参与 planner 合成。
   */
  dynamicFloorProjection?: MarketBaseDynamicFloorState;
  proposedPermit?: MarketBaseResourcePermitProposal;
  /**
   * Pending/WAL reconciliation contradictions are not transient planning
   * blockers.  They remain latched until an explicit operator recovery
   * workflow replaces the canonical state.
   */
  hardBlocker?: MarketBaseResourceHardBlocker;
  blocker?: string;
}

/**
 * MarketSaleRuntime 每次 full read 都重新组合这份候选。它只携带当前
 * pricing/protection 事实，不携带 permit 授权；授权必须由本模块从
 * canonical v3 state 重新验证。
 */
export interface MarketBaseResourceRuntimeCandidate {
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

export interface MarketBaseResourceOutgoingTransaction {
  transactionId: string;
  time: number;
  amount: number;
  resourceType: ResourceConstant;
  from: string;
  to: string;
  order?: {
    id: string;
    type: ORDER_BUY | ORDER_SELL;
    price: number;
  };
}

export interface MarketBaseResourceOutgoingWindow {
  observedAt: number;
  coversAttemptAt: boolean;
  oldestTime?: number;
  newestTime?: number;
  transactions: readonly MarketBaseResourceOutgoingTransaction[];
}

export interface MarketBaseResourceArbiterSnapshot {
  blocked: boolean;
  revision: string;
}

export interface MarketBaseResourceRuntimeDependencies {
  readCurrentBuyOrders: (
    resource: ResourceConstant,
  ) => readonly MarketOrderSnapshot[];
  readOwnOrders: () => readonly MarketOrderSnapshot[];
  readTerminal: typeof readLiveMarketBaseTerminal;
  readCredits: () => number | undefined;
  readAccountIdentity: () => string | undefined;
  readExecutorShard: () => string | undefined;
  readArbiterSnapshot: (
    roomNames: readonly string[],
  ) => MarketBaseResourceArbiterSnapshot;
  readOutgoingWindow: (
    attemptAt: number,
  ) => MarketBaseResourceOutgoingWindow | undefined;
  readTrustedFloors: () =>
    | Partial<
        Record<
          MarketBaseResourceTrustedFloorResource,
          MarketBaseResourceTrustedFloorObservation
        >
      >
    | undefined;
  calculateTransactionEnergy: (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ) => number;
  cpuUsed: () => number;
  /**
   * 由 outer activation anchor 提供、且必须与当前 exact ledger/permit
   * 对应的运行时锚。inner runner 不会自行从 nested Memory 重建或接受
   * stored `validated=true` 之类的自证字段。
   */
  readLedgerRuntimeAnchor: (
    state: MarketBaseResourceV3RuntimeState,
  ) => MarketBaseResourceLedgerRuntimeAnchor | undefined;
  /**
   * deal 前的 canonical WAL 持久化闸门。调用方必须把完整 V3 state 与
   * outer activation anchor 同一次替换写入 Memory；返回 false/抛错时
   * 本轮禁止 claim/deal。
   */
  commitPreparedState: (
    preparedState: MarketBaseResourceV3RuntimeState,
    ledgerRuntimeAnchor: MarketBaseResourceLedgerRuntimeAnchor,
    runtimeCapability?: MarketBaseResourceReadinessRuntimeCapability,
  ) => boolean;
  /**
   * prepared root 已落盘后的外层 exact-root CAS。inner 必须在 claim 前、
   * claim 后且唯一 deal 调用前再次验证；默认依赖没有 outer root
   * capability，因此直接调用 inner 永远不能成交。
   */
  validatePreparedCanonicalRoot: () => boolean;
  claimPrepared: typeof claimPreparedDirectMarketClaims;
  executePrepared: typeof executePreparedDirectMarketDeal;
  releasePrepared: typeof releasePreparedDirectMarketClaims;
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

declare const MARKET_BASE_RESOURCE_READINESS_RUNTIME_CAPABILITY_BRAND: unique symbol;

export interface MarketBaseResourceReadinessRuntimeCapability {
  readonly [MARKET_BASE_RESOURCE_READINESS_RUNTIME_CAPABILITY_BRAND]: true;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export interface MarketBaseResourceCanonicalReadinessRead {
  ok: boolean;
  reason?: "missing" | "invalid" | "expired";
  revision?: string;
  maxTransactionEnergy?: 1_000;
  sourcePermitVersion?: 2 | 3;
  rooms: Array<{
    roomName: string;
    roomInstanceId: string;
    terminalId: string;
  }>;
  /** 仅当前 permit/ledger 允许新成交的 V3 lane，可用于既有 carrier 搬运准备。 */
  cargoLanes?: Array<{
    roomName: string;
    resource: MarketBaseResource;
    terminalId: string;
    maxDealAmount: number;
  }>;
}

function jsonEvidence(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : JSON.parse(serialized);
  } catch {
    return { unserializable: true };
  }
}

function v2ReadinessHash(domain: string, evidence: unknown): string {
  return canonicalStableHashV1({
    domain,
    evidence: jsonEvidence(evidence),
  });
}

function validateOuterV2Activation(
  outer: Record<string, unknown>,
  tick: number,
):
  | {
      permit: MarketDirectContinuousPermit;
      permitChain: MarketDirectPermitChainState;
      ledger: MarketDirectContinuousLedger;
    }
  | undefined {
  const permit = outer.currentPermit as
    MarketDirectContinuousPermit | undefined;
  const permitChain = outer.permitChain as
    MarketDirectPermitChainState | undefined;
  const ledger = outer.ledger as MarketDirectContinuousLedger | undefined;
  if (
    outer.schemaVersion !== MARKET_DIRECT_CONTINUOUS_SCHEMA ||
    outer.capability !== MARKET_DIRECT_CONTINUOUS_CAPABILITY ||
    outer.migrationStatus !== "active" ||
    outer.migrationBlockedReason !== undefined ||
    !permit ||
    !permitChain ||
    !ledger ||
    !validateContinuousLedger(ledger, tick).ok ||
    ledger.blocker ||
    ledger.pending
  ) {
    return undefined;
  }
  const chainValidation = validateMarketDirectContinuousPermitChain(
    permitChain,
    {
      permitEpochHighWater: ledger.permitEpochHighWater,
      permitChainHeadHighWater: ledger.permitChainHeadHighWater,
    },
  );
  const tip = permitChain.permits[permitChain.permits.length - 1];
  if (
    !chainValidation.ok ||
    !tip ||
    canonicalStableHashV1(permit) !== canonicalStableHashV1(tip) ||
    permit.permitId !== permitChain.currentPermitId ||
    permit.permitHead !== permitChain.permitChainHead ||
    permit.epoch !== permitChain.currentPermitEpoch
  ) {
    return undefined;
  }
  return { permit, permitChain, ledger };
}

/**
 * ResourceControl 使用的纯 canonical reader。它从 permit/ledger/scope/grant
 * 重建授权房间，stored `validated=true` 投影只作为必须逐字匹配的缓存，绝不
 * 自身构成授权。
 */
export function deriveMarketBaseResourceCanonicalReadinessAuthorization(
  rawMarketSaleRootOrDirectAutomation: unknown,
  marketMode: unknown,
  currentTick: number,
): MarketBaseResourceCanonicalReadinessRead {
  if (marketMode !== "direct") {
    return { ok: false, reason: "missing", rooms: [] };
  }
  if (
    !Number.isSafeInteger(currentTick) ||
    currentTick < 0 ||
    !isPlainRecord(rawMarketSaleRootOrDirectAutomation)
  ) {
    return { ok: false, reason: "invalid", rooms: [] };
  }
  const directAutomationCandidate =
    rawMarketSaleRootOrDirectAutomation.directAutomation;
  const marketSaleRoot = isPlainRecord(directAutomationCandidate)
    ? rawMarketSaleRootOrDirectAutomation
    : undefined;
  const marketSaleDirectAutomation = isPlainRecord(directAutomationCandidate)
    ? directAutomationCandidate
    : undefined;
  if (marketSaleRoot) {
    const cached = readCachedMarketBaseResourceCanonicalReadiness(
      marketSaleRoot,
      marketMode,
      currentTick,
    );
    if (cached) return cached;
    const uncachedV3 = marketSaleDirectAutomation!.baseResourceV3;
    if (
      marketSaleRoot.baseResourceV3ActivationAnchor !== undefined ||
      marketSaleRoot.baseResourceV3ActivationAnchorMirror !== undefined ||
      marketSaleRoot.baseResourceV3ActivationBlocker !== undefined ||
      (isPlainRecord(uncachedV3) &&
        (uncachedV3.cutoverLatched === true ||
          (isPlainRecord(uncachedV3.readinessAuthorization) &&
            uncachedV3.readinessAuthorization.sourcePermitVersion === 3)))
    ) {
      // Live V3 只能消费本 tick opaque runtime capability；cache miss 时
      // 不退回 O(512) full validation，更不能相信 serialized projection。
      return { ok: false, reason: "invalid", rooms: [] };
    }
  }
  const rawDirectAutomation = marketSaleRoot
    ? marketSaleDirectAutomation!
    : rawMarketSaleRootOrDirectAutomation;
  const outer = validateOuterV2Activation(rawDirectAutomation, currentTick);
  if (!outer) {
    return { ok: false, reason: "invalid", rooms: [] };
  }
  const rawV3 = rawDirectAutomation.baseResourceV3;
  if (!isPlainRecord(rawV3)) {
    return { ok: false, reason: "missing", rooms: [] };
  }
  const storedAuthorization = rawV3.readinessAuthorization;
  if (!isPlainRecord(storedAuthorization)) {
    return { ok: false, reason: "missing", rooms: [] };
  }
  const storedAuthorizationRooms = storedAuthorization.rooms;
  if (
    !Array.isArray(storedAuthorizationRooms) ||
    storedAuthorizationRooms.length > MARKET_BASE_RESOURCE_MAX_ACTIVE_ROOMS ||
    storedAuthorizationRooms.some(
      (room) => !isPlainRecord(room) || Object.keys(room).length > 4,
    )
  ) {
    return { ok: false, reason: "invalid", rooms: [] };
  }

  // Frozen v2 bridge: authenticate the outer v2 permit/ledger/lifecycle and
  // deterministically reconstruct the sole X/E6N59 readiness record.
  if (storedAuthorization.sourcePermitVersion === 2) {
    const legacyEntry = MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.find(
      (entry) => entry.entryId === "base-x-e6n59-v1",
    );
    const lifecycleByEntry = rawDirectAutomation.lifecycleByEntry;
    const lifecycle =
      isPlainRecord(lifecycleByEntry) && legacyEntry
        ? (lifecycleByEntry[legacyEntry.entryId] as MarketDirectEntryLifecycle)
        : undefined;
    const rooms = Array.isArray(storedAuthorization.rooms)
      ? storedAuthorization.rooms
      : [];
    const room =
      rooms.length === 1 && isPlainRecord(rooms[0]) ? rooms[0] : undefined;
    if (
      !legacyEntry ||
      legacyEntry.resourceType !== RESOURCE_CATALYST ||
      legacyEntry.allowedRoomNames.length !== 1 ||
      legacyEntry.allowedRoomNames[0] !== "E6N59" ||
      !lifecycle ||
      !marketDirectPermitAllowsNewDeal(outer.permitChain, {
        shard: MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
        entryId: legacyEntry.entryId,
        lifecycle,
      }) ||
      !room ||
      room.roomName !== "E6N59" ||
      typeof room.terminalId !== "string" ||
      room.terminalId.length === 0 ||
      room.status !== "authorized"
    ) {
      return { ok: false, reason: "invalid", rooms: [] };
    }
    const roomInstanceId = v2ReadinessHash(
      "market-base-resource:legacy-v2-readiness-room-v1",
      {
        accountIdentity: outer.permit.accountIdentity,
        roomName: room.roomName,
        terminalId: room.terminalId,
      },
    );
    const expectedRooms = [
      {
        roomName: "E6N59",
        roomInstanceId,
        terminalId: room.terminalId,
        status: "authorized" as const,
      },
    ];
    const expected = {
      schemaVersion: 3,
      validated: true,
      status: "authorized",
      revision: v2ReadinessHash(
        "market-base-resource:readiness-authorization-v1",
        {
          permitHead: outer.permit.permitHead,
          permitId: outer.permit.permitId,
          rooms: expectedRooms,
          sourcePermitVersion: 2,
          tick: currentTick,
        },
      ),
      updatedAt: currentTick,
      expiresAt: currentTick,
      maxTransactionEnergy: 1_000,
      sourcePermitVersion: 2,
      rooms: expectedRooms,
    };
    if (
      canonicalStableHashV1(storedAuthorization) !==
      canonicalStableHashV1(expected)
    ) {
      const observedExpiry = storedAuthorization.expiresAt;
      return {
        ok: false,
        reason:
          typeof observedExpiry === "number" && observedExpiry < currentTick
            ? "expired"
            : "invalid",
        rooms: [],
      };
    }
    return {
      ok: true,
      revision: expected.revision,
      maxTransactionEnergy: 1_000,
      sourcePermitVersion: 2,
      rooms: expectedRooms.map(({ status: _status, ...basis }) => basis),
    };
  }

  const state = rawV3 as unknown as MarketBaseResourceV3RuntimeState;
  if (
    state.schemaVersion !== 3 ||
    state.catalog?.revision !== MARKET_BASE_RESOURCE_CATALOG_REVISION ||
    state.catalog?.configRevision !== MARKET_BASE_RESOURCE_CONFIG_REVISION ||
    !Array.isArray(state.catalog?.resources) ||
    state.catalog.resources.length !== MARKET_BASE_RESOURCE_CATALOG.length ||
    canonicalStableHashV1(state.catalog?.resources) !==
      canonicalStableHashV1(MARKET_BASE_RESOURCE_CATALOG) ||
    state.cutoverLatched !== true ||
    state.preflightAt !== currentTick ||
    state.blocker !== undefined ||
    state.hardBlocker !== undefined ||
    !state.scope ||
    state.scope.updatedAt !== currentTick ||
    !Array.isArray(state.scope.sellerRooms) ||
    state.scope.sellerRooms.length > MARKET_BASE_RESOURCE_MAX_ACTIVE_ROOMS ||
    !Array.isArray(state.scope.laneLifecycles) ||
    state.scope.laneLifecycles.length > MARKET_BASE_RESOURCE_MAX_ACTIVE_LANES ||
    !Array.isArray(state.scope.roomRegistry?.knownRoomNames) ||
    state.scope.roomRegistry.knownRoomNames.length >
      MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES ||
    state.scope.sellerRooms.some(
      (room) =>
        typeof room.roomName !== "string" ||
        room.roomName.length > 16 ||
        typeof room.roomInstanceId !== "string" ||
        room.roomInstanceId.length > 256 ||
        typeof room.terminalId !== "string" ||
        room.terminalId.length > 128,
    ) ||
    state.scope.laneLifecycles.some(
      (lane) => typeof lane.laneId !== "string" || lane.laneId.length > 256,
    ) ||
    !state.permitChain ||
    !state.ledger ||
    state.ledger.blocker
  ) {
    return { ok: false, reason: "invalid", rooms: [] };
  }
  const permitValidation = validateMarketBaseResourcePermitChain(
    state.permitChain,
  );
  const ledgerValidation = validateMarketBaseResourceLedger(
    state.ledger,
    currentTick,
    state.permitChain,
  );
  const anchorValidation = validateMarketBaseResourcePermitChainDominatesAnchor(
    state.permitChain,
    state.ledger.permitAnchor,
  );
  const permit = currentV3Permit(state.permitChain);
  const cutover = state.permitChain.v2EventCutoverCheckpoint;
  const wrappedOuterPermit = state.permitChain.retainedPermits.find(
    (record) =>
      record.schemaVersion === 2 &&
      record.permitId === outer.permit.permitId &&
      record.permitHead === outer.permit.permitHead,
  );
  if (
    !permitValidation.ok ||
    !ledgerValidation.ok ||
    !anchorValidation.ok ||
    !hasAcceptedMarketBaseResourceV3Successor(state.permitChain) ||
    !permit ||
    permit.accountIdentity !== state.scope.accountIdentity ||
    permit.executorShard !== "shard1" ||
    permit.sharedPolicy.fingerprint !== state.scope.sharedPolicyFingerprint ||
    !validateMarketBaseResourcePricingRatchetState(
      state.pricingRatchet,
      permit,
    ) ||
    !cutover ||
    !wrappedOuterPermit ||
    wrappedOuterPermit.schemaVersion !== 2 ||
    canonicalStableHashV1(wrappedOuterPermit.rawRecord) !==
      canonicalStableHashV1(outer.permit) ||
    cutover.v2ReceiptHeadHash !== outer.ledger.receiptHeadHash ||
    cutover.lastV2AttemptSeq !== outer.ledger.finalizedAttemptSeq
  ) {
    return { ok: false, reason: "invalid", rooms: [] };
  }
  const derived = buildMarketBaseResourceReadinessAuthorization(
    state.permitChain,
    {
      tick: currentTick,
      ttl: 1,
      roster: state.scope.sellerRooms.map(marketBaseResourceSellerRoomBasis),
      lanes: state.scope.laneLifecycles,
    },
  );
  if (
    "reason" in derived ||
    canonicalStableHashV1(storedAuthorization) !==
      canonicalStableHashV1(derived.readinessAuthorization)
  ) {
    const observedExpiry = storedAuthorization.expiresAt;
    return {
      ok: false,
      reason:
        typeof observedExpiry === "number" && observedExpiry < currentTick
          ? "expired"
          : "invalid",
      rooms: [],
    };
  }
  return {
    ok: true,
    revision: derived.readinessAuthorization.revision,
    maxTransactionEnergy: 1_000,
    sourcePermitVersion: 3,
    rooms: derived.readinessAuthorization.rooms.map(
      ({ status: _status, ...basis }) => basis,
    ),
  };
}

export function readLiveMarketBaseAccountIdentity(): string | undefined {
  const identities = new Set<string>();
  for (const room of Object.values(Game.rooms || {})) {
    if (room.controller?.my !== true) continue;
    const identity =
      room.controller.owner?.username ||
      room.terminal?.owner?.username ||
      room.storage?.owner?.username;
    if (identity) identities.add(identity);
  }
  return identities.size === 1 ? [...identities][0] : undefined;
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

const MARKET_BASE_RESOURCE_NO_SCOPE_LANE_TOMBSTONE_DISCHARGE =
  canonicalStableHashV1(
    "market-base-resource:no-scope-lane-tombstone-discharge-v1",
  );

type MarketBaseResourceScopeLaneTombstone = MarketBaseDerivedLaneLifecycle & {
  retiredAt: number;
};

type ScopeLaneTombstoneCheckpointWithoutCommitment = Omit<
  MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint,
  "checkpointCommitment"
>;

function scopeLaneTombstoneCheckpointPayload(
  checkpoint: ScopeLaneTombstoneCheckpointWithoutCommitment,
): unknown {
  return {
    domain: "market-base-resource:scope-lane-tombstone-checkpoint-v1",
    ...checkpoint,
  };
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

function validScopeLaneTombstoneCheckpoint(
  value: unknown,
): value is MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "checkpointCommitment",
    "dischargedCount",
    "dischargedPrefixHead",
    "hashRevision",
    "lastPermitCheckpointCommitment",
    "schemaVersion",
  ].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== 1 ||
    value.hashRevision !==
      MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION ||
    !Number.isSafeInteger(value.dischargedCount) ||
    (value.dischargedCount as number) < 0 ||
    typeof value.dischargedPrefixHead !== "string" ||
    !/^csh1:[0-9a-f]{32}$/.test(value.dischargedPrefixHead) ||
    typeof value.lastPermitCheckpointCommitment !== "string" ||
    !/^csh1:[0-9a-f]{32}$/.test(value.lastPermitCheckpointCommitment) ||
    typeof value.checkpointCommitment !== "string" ||
    !/^csh1:[0-9a-f]{32}$/.test(value.checkpointCommitment)
  ) {
    return false;
  }
  if (
    value.dischargedCount === 0
      ? value.dischargedPrefixHead !==
        MARKET_BASE_RESOURCE_NO_SCOPE_LANE_TOMBSTONE_DISCHARGE
      : value.dischargedPrefixHead ===
          MARKET_BASE_RESOURCE_NO_SCOPE_LANE_TOMBSTONE_DISCHARGE ||
        value.lastPermitCheckpointCommitment ===
          MARKET_BASE_RESOURCE_NO_SCOPE_LANE_TOMBSTONE_DISCHARGE
  ) {
    return false;
  }
  const withoutCommitment = {
    schemaVersion: 1 as const,
    hashRevision: MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION,
    dischargedCount: value.dischargedCount as number,
    dischargedPrefixHead: value.dischargedPrefixHead,
    lastPermitCheckpointCommitment: value.lastPermitCheckpointCommitment,
  };
  return (
    value.checkpointCommitment ===
    canonicalStableHashV1(
      scopeLaneTombstoneCheckpointPayload(withoutCommitment),
    )
  );
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

function validateScopeLaneTombstones(
  tombstones: readonly MarketBaseResourceScopeLaneTombstone[],
  tick: number,
): string | undefined {
  if (
    tombstones.some(
      (tombstone) =>
        !isPlainRecord(tombstone) ||
        tombstone.status !== "tombstoned" ||
        !Number.isSafeInteger(tombstone.retiredAt) ||
        tombstone.retiredAt < 0 ||
        tombstone.retiredAt > tick ||
        validateMarketBaseDerivedLaneLifecycle(tombstone) !== undefined,
    )
  ) {
    return "derived_lane_tombstone_invalid";
  }
  const laneIds = new Set<string>();
  for (let index = 0; index < tombstones.length; index += 1) {
    const tombstone = tombstones[index];
    if (
      laneIds.has(tombstone.laneId) ||
      (index > 0 &&
        (tombstones[index - 1].retiredAt > tombstone.retiredAt ||
          (tombstones[index - 1].retiredAt === tombstone.retiredAt &&
            tombstones[index - 1].laneId.localeCompare(tombstone.laneId) >= 0)))
    ) {
      return "derived_lane_tombstone_order_invalid";
    }
    laneIds.add(tombstone.laneId);
  }
  return undefined;
}

function compareScopeLaneTombstones(
  left: MarketBaseResourceScopeLaneTombstone,
  right: MarketBaseResourceScopeLaneTombstone,
): number {
  return (
    left.retiredAt - right.retiredAt || left.laneId.localeCompare(right.laneId)
  );
}

function currentRosterFingerprint(
  sellerRooms: readonly MarketBaseSellerRoomState[],
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:current-roster-v1",
    rooms: [...sellerRooms]
      .sort((left, right) => stableCompare(left.roomName, right.roomName))
      .map((room) => ({
        fingerprint: room.fingerprint,
        roomInstanceId: room.roomInstanceId,
        roomName: room.roomName,
      })),
  });
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

type V3LaneInput = MarketDirectContinuousLaneInput & {
  laneId: string;
  roomInstanceId: string;
  /** 保护后总库存盈余，含 storage；只用于动态价格库存分量。 */
  inventorySurplus?: number;
  lane: MarketDirectContinuousLaneInput["lane"] & {
    authorization?: "writable" | "suspended_shadow";
  };
};

type V3EntryInput = Omit<MarketDirectContinuousEntryInput, "lanes"> & {
  lanes: readonly V3LaneInput[];
};

export interface MarketBaseResourcePlanningScopeSnapshot {
  /**
   * versioned policy/permit/lifecycle reader 已经完成全部验证后才可为 true。
   * 本模块不会从不完整 raw Memory 猜测授权。
   */
  complete: boolean;
  blocker?: string;
  scopeEvidence: string;
  currentRosterFingerprint: string;
  currentLaneSetFingerprint: string;
  protectionFingerprint?: string;
  arbiterFingerprint?: string;
  outgoingWindow?: MarketBaseResourceOutgoingWindow;
  pricingRatchet?: MarketBaseResourcePricingRatchetState;
  activeRoomCount: number;
  knownRoomNameCount: number;
  activeLaneCount: number;
  entries: readonly V3EntryInput[];
  /**
   * 候选定价/能耗证据缺失的资源级隔离 lane（仅 shadow-only 资源）。
   * 这些 lane 本轮记 incomplete 观察（周期停涨、证据不清零），
   * 不进 planner；writable 资源不走隔离而是整轮 fail-closed。
   */
  isolatedCandidateLaneIds?: readonly string[];
  energyShadow: PlanMarketDirectContinuousInput["energyShadow"];
  globalQuota: PlanMarketDirectContinuousInput["globalQuota"];
  writeContext: PlanMarketDirectContinuousInput["writeContext"];
}

export interface MarketBaseResourceTerminalRead {
  roomName: string;
  terminalId: string;
  owned: boolean;
  ready: boolean;
  cooldown: number;
  resourceAmount: number;
  energy: number;
  nativeMineralType?: string;
  effectivePostDealEnergyReserve?: number;
  revision: string;
}

export interface MarketBaseResourcePlanningDependencies {
  /**
   * 每次调用必须重新读取 current roster/lane-set/permit/protection/quota。
   * 调用者不可把第一读对象或 memo 返回给第二读。
   */
  readScope: () => MarketBaseResourcePlanningScopeSnapshot;
  readCurrentBuyOrders: (
    resource: ResourceConstant,
  ) => readonly MarketOrderSnapshot[];
  readOwnOrders: () => readonly MarketOrderSnapshot[];
  readTerminal: (
    roomName: string,
    resource: ResourceConstant,
  ) => MarketBaseResourceTerminalRead | undefined;
  calculateTransactionEnergy: (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ) => number;
  cpuUsed: () => number;
  /** 仅供测试/诊断确认 Shadow 是否走了快照归一化路径。 */
  observeShadowNormalizationArtifact?: (used: boolean) => void;
}

export function readLiveMarketBaseTerminal(
  roomName: string,
  resource: ResourceConstant,
): MarketBaseResourceTerminalRead | undefined {
  const room = Game.rooms?.[roomName];
  const terminal = room?.terminal;
  if (!room || !terminal) return undefined;
  const resourceAmount = terminal.store.getUsedCapacity(resource);
  const energy = terminal.store.getUsedCapacity(RESOURCE_ENERGY);
  if (
    room.controller?.my !== true ||
    terminal.my !== true ||
    !Number.isSafeInteger(resourceAmount) ||
    !Number.isSafeInteger(energy) ||
    !Number.isSafeInteger(terminal.cooldown)
  ) {
    return undefined;
  }
  const resourceControlRoom = Memory.runtime?.resourceControl?.rooms?.[
    roomName
  ] as
    | {
        marketEnergyReadiness?: unknown;
      }
    | undefined;
  const readiness = isPlainRecord(resourceControlRoom?.marketEnergyReadiness)
    ? resourceControlRoom?.marketEnergyReadiness
    : undefined;
  const marketData = isPlainRecord(Memory.data?.marketSaleAutomation)
    ? Memory.data?.marketSaleAutomation
    : undefined;
  const canonicalAuthorization =
    deriveMarketBaseResourceCanonicalReadinessAuthorization(
      marketData,
      Memory.cfg?.marketSaleAutomation?.mode,
      Game.time,
    );
  const authorizedRoom = canonicalAuthorization.ok
    ? canonicalAuthorization.rooms.find(
        (candidate) => candidate.roomName === roomName,
      )
    : undefined;
  const contributions =
    readiness && Array.isArray(readiness.contributions)
      ? readiness.contributions
      : undefined;
  const contributionKinds = new Set([
    "ordinary_terminal_target",
    "pending_energy_send",
    "pending_internal_send_fee",
    "terminal_production_commitment",
  ]);
  const contributionIds = new Set<string>();
  const contributionTotals = {
    ordinary_terminal_target: 0,
    pending_energy_send: 0,
    pending_internal_send_fee: 0,
    terminal_production_commitment: 0,
  };
  let contributionsValid = Boolean(contributions && contributions.length <= 64);
  if (contributions && contributions.length <= 64) {
    for (const rawContribution of contributions) {
      if (
        !isPlainRecord(rawContribution) ||
        Object.keys(rawContribution).sort().join("|") !==
          ["amount", "id", "kind"].sort().join("|") ||
        typeof rawContribution.id !== "string" ||
        rawContribution.id.length === 0 ||
        rawContribution.id.length > 256 ||
        contributionIds.has(rawContribution.id) ||
        typeof rawContribution.kind !== "string" ||
        !contributionKinds.has(rawContribution.kind) ||
        !Number.isSafeInteger(rawContribution.amount) ||
        (rawContribution.amount as number) <= 0
      ) {
        contributionsValid = false;
        break;
      }
      contributionIds.add(rawContribution.id);
      const kind = rawContribution.kind as keyof typeof contributionTotals;
      const nextTotal =
        contributionTotals[kind] + (rawContribution.amount as number);
      if (!Number.isSafeInteger(nextTotal)) {
        contributionsValid = false;
        break;
      }
      contributionTotals[kind] = nextTotal;
    }
  }
  const effectivePostDealEnergyReserve =
    readiness?.effectivePostDealEnergyReserve;
  const marketTerminalEnergyTarget = readiness?.marketTerminalEnergyTarget;
  const expectedReserve = Math.max(
    25_000,
    contributionTotals.ordinary_terminal_target +
      contributionTotals.pending_energy_send +
      contributionTotals.pending_internal_send_fee +
      contributionTotals.terminal_production_commitment,
  );
  const readinessShapeValid = Boolean(
    readiness &&
    Object.keys(readiness).sort().join("|") ===
      [
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
      ]
        .sort()
        .join("|"),
  );
  const ready = Boolean(
    readiness &&
    readinessShapeValid &&
    canonicalAuthorization.ok &&
    canonicalAuthorization.revision &&
    canonicalAuthorization.maxTransactionEnergy === 1_000 &&
    authorizedRoom &&
    authorizedRoom.roomInstanceId === readiness.roomInstanceId &&
    authorizedRoom.terminalId === terminal.id &&
    readiness.schemaVersion === 3 &&
    readiness.authorized === true &&
    readiness.status === "ready" &&
    readiness.revision === `market-terminal-energy-v3:${Game.time}` &&
    readiness.authorizationRevision === canonicalAuthorization.revision &&
    readiness.terminalId === terminal.id &&
    readiness.observedAt === Game.time &&
    readiness.expiresAt === Game.time + 1 &&
    readiness.maxTransactionEnergy === 1_000 &&
    readiness.plannedFeedAmount === 0 &&
    readiness.blocker === undefined &&
    contributionsValid &&
    readiness.contributionCount === contributions!.length &&
    readiness.ordinaryTerminalEnergyTarget ===
      contributionTotals.ordinary_terminal_target &&
    readiness.unresolvedEnergySendAmount ===
      contributionTotals.pending_energy_send &&
    readiness.unresolvedInternalSendFees ===
      contributionTotals.pending_internal_send_fee &&
    readiness.terminalScopedProductionEnergyCommitments ===
      contributionTotals.terminal_production_commitment &&
    Number.isSafeInteger(effectivePostDealEnergyReserve) &&
    effectivePostDealEnergyReserve === expectedReserve &&
    Number.isSafeInteger(marketTerminalEnergyTarget) &&
    marketTerminalEnergyTarget === expectedReserve + 1_000 &&
    energy >= (marketTerminalEnergyTarget as number) &&
    readiness.desiredTerminalEnergy ===
      Math.max(energy, marketTerminalEnergyTarget as number),
  );
  return {
    roomName,
    terminalId: terminal.id,
    owned: true,
    ready,
    cooldown: terminal.cooldown,
    resourceAmount,
    energy,
    ...(ready
      ? {
          effectivePostDealEnergyReserve:
            effectivePostDealEnergyReserve as number,
        }
      : {}),
    revision: ready
      ? (readiness!.revision as string)
      : canonicalStableHashV1({
          domain: "market-base-resource:terminal-readiness-incomplete-v1",
          roomName,
          terminalId: terminal.id,
          tick: Game.time,
        }),
  };
}

export interface MarketBaseResourceShadowObservation {
  laneId: string;
  result:
    | "safe_opportunity"
    | "safe_no_opportunity"
    | "production_priority_wait"
    /** arbiter/terminal 被生产占用且本周期无安全候选：等待中的空窗。 */
    | "wait_no_opportunity"
    | "incomplete";
  blocker?: string;
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

export interface MarketBaseResourceTwoReadPlan {
  complete: boolean;
  blocker?: string;
  first?: MarketDirectContinuousPlanningResult;
  second?: MarketDirectContinuousPlanningResult;
  selected?: MarketDirectContinuousPlanningResult["selected"];
  firstScopeEvidence?: string;
  secondScopeEvidence?: string;
  firstRosterFingerprint?: string;
  secondRosterFingerprint?: string;
  firstLaneSetFingerprint?: string;
  secondLaneSetFingerprint?: string;
  firstReadEvidence?: MarketBaseResourceFullReadEvidence;
  secondReadEvidence?: MarketBaseResourceFullReadEvidence;
  firstOutgoingWindow?: MarketBaseResourceOutgoingWindow;
  secondOutgoingWindow?: MarketBaseResourceOutgoingWindow;
  secondCredits?: number;
  selectedTerminalRead?: MarketBaseResourceTerminalRead;
  nextPricingRatchet?: MarketBaseResourcePricingRatchetState;
  /** observe 模式动态地板投影的 first-read 输入（complete 路径填充）。 */
  firstBookBestPrices?: FullReadResult["bookBestPrices"];
  firstLaneSurplus?: readonly MarketBaseDynamicFloorSurplusLane[];
  sampledShadowLaneIds: string[];
  nextShadowCursor?: string;
  shadowObservations: MarketBaseResourceShadowObservation[];
  rawOrderCount: number;
  eligibleOrderCount: number;
  distinctOrderRoomCount: number;
  transactionCostEvaluationBudget: number;
  shadowPlannerMode: MarketBaseResourcePlanningSnapshot["shadowPlannerMode"];
  shadowPlannerInvocationCount: number;
  actualTransactionEnergyEvaluations: number;
  evaluatedShadowResourceCount: number;
  candidateIdentityOrderChecks: number;
  cpuUsed: number;
}

export interface MarketBaseResourceFullReadEvidence {
  bookFingerprint: string;
  protectionFingerprint: string;
  energyReadinessFingerprint: string;
  arbiterFingerprint: string;
  pricingRatchetFingerprint: string;
}

interface FullReadResult {
  complete: boolean;
  blocker?: string;
  scope: MarketBaseResourcePlanningScopeSnapshot;
  plannerInput?: PlanMarketDirectContinuousInput;
  sampledShadowLaneIds: string[];
  nextShadowCursor?: string;
  shadowObservations: MarketBaseResourceShadowObservation[];
  rawOrderCount: number;
  eligibleOrderCount: number;
  distinctOrderRoomCount: number;
  transactionCostEvaluationBudget: number;
  shadowPlannerMode: MarketBaseResourcePlanningSnapshot["shadowPlannerMode"];
  shadowPlannerInvocationCount: number;
  actualTransactionEnergyEvaluations: number;
  evaluatedShadowResourceCount: number;
  candidateIdentityOrderChecks: number;
  evidence?: MarketBaseResourceFullReadEvidence;
  terminalReads?: Record<string, MarketBaseResourceTerminalRead>;
  /**
   * observe 模式动态地板投影的订单簿输入：本轮 full read 各资源
   * eligible 买单的最优价（gross；能耗可行性由 planner 单独评估，
   * 投影按可执行名义口径近似）。
   */
  bookBestPrices: Array<{
    resource: MarketBaseResource;
    price: number;
  }>;
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function cloneOrder(order: MarketOrderSnapshot): MarketOrderSnapshot {
  return {
    id: order.id,
    type: order.type,
    resourceType: order.resourceType,
    price: order.price,
    amount: order.amount,
    ...(order.remainingAmount === undefined
      ? {}
      : { remainingAmount: order.remainingAmount }),
    ...(order.totalAmount === undefined
      ? {}
      : { totalAmount: order.totalAmount }),
    ...(order.roomName === undefined ? {} : { roomName: order.roomName }),
    ...(order.created === undefined ? {} : { created: order.created }),
  };
}

function canonicalOrder(order: MarketOrderSnapshot): string {
  return JSON.stringify({
    amount: order.amount,
    created: order.created ?? null,
    id: order.id,
    price: order.price,
    remainingAmount: order.remainingAmount ?? null,
    resourceType: order.resourceType,
    roomName: order.roomName ?? null,
    totalAmount: order.totalAmount ?? null,
    type: order.type,
  });
}

function remainingAmount(order: MarketOrderSnapshot): number {
  return order.remainingAmount === undefined
    ? order.amount
    : Math.min(order.amount, order.remainingAmount);
}

function eligibleForBudget(
  order: MarketOrderSnapshot,
  resource: string,
  minimumNotional: number,
  ownOrderIds: ReadonlySet<string>,
): boolean {
  const amount = remainingAmount(order);
  return (
    order.type === "buy" &&
    order.resourceType === resource &&
    typeof order.roomName === "string" &&
    order.roomName.length > 0 &&
    !ownOrderIds.has(order.id) &&
    Number.isFinite(order.price) &&
    order.price > 0 &&
    isPositiveSafeInteger(amount) &&
    amount >= 1_000 &&
    order.price * 1_000 >= minimumNotional
  );
}

interface MarketBaseResourceShadowCursorV2 {
  resource: MarketBaseResource;
  laneId: string;
}

interface MarketBaseResourceShadowCohort {
  resource: MarketBaseResource;
  activeLaneIds: string[];
  shadowLaneIds: string[];
  anchorLaneId: string;
}

function encodeMarketBaseResourceShadowCursor(
  cursor: MarketBaseResourceShadowCursorV2,
): string {
  return `${MARKET_BASE_RESOURCE_SHADOW_CURSOR_V2_PREFIX}${cursor.resource}|${cursor.laneId}`;
}

function parseMarketBaseResourceShadowCursor(
  cursor: string | undefined,
): MarketBaseResourceShadowCursorV2 | undefined {
  if (!cursor?.startsWith(MARKET_BASE_RESOURCE_SHADOW_CURSOR_V2_PREFIX)) {
    return undefined;
  }
  const payload = cursor.slice(
    MARKET_BASE_RESOURCE_SHADOW_CURSOR_V2_PREFIX.length,
  );
  const separator = payload.indexOf("|");
  if (separator <= 0 || separator === payload.length - 1) return undefined;
  const resource = payload.slice(0, separator);
  const laneId = payload.slice(separator + 1);
  return MARKET_BASE_RESOURCE_CATALOG.includes(
    resource as MarketBaseResource,
  )
    ? { resource: resource as MarketBaseResource, laneId }
    : undefined;
}

function marketBaseResourceShadowCohorts(
  entries: readonly V3EntryInput[],
): MarketBaseResourceShadowCohort[] {
  const cohorts: MarketBaseResourceShadowCohort[] = [];
  for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
    const activeLanes = entries
      .filter((entry) => entry.policy.resourceType === resource)
      .flatMap((entry) => entry.lanes)
      .sort((left, right) => stableCompare(left.laneId, right.laneId));
    for (
      let offset = 0;
      offset < activeLanes.length;
      offset += MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE
    ) {
      const chunk = activeLanes.slice(
        offset,
        offset + MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE,
      );
      const activeLaneIds = chunk.map((lane) => lane.laneId);
      cohorts.push({
        resource,
        activeLaneIds,
        shadowLaneIds: chunk
          .filter(
            (lane) => lane.lane.authorization === "suspended_shadow",
          )
          .map((lane) => lane.laneId),
        anchorLaneId: activeLaneIds[activeLaneIds.length - 1]!,
      });
    }
  }
  return cohorts;
}

/**
 * Suspended Shadow 统一按冻结 catalog 的 resource-major cohort 轮转。
 * cohort 边界由全部 active lane（含 writable）决定，晋级不会重排边界；
 * 每批最多 8 条且绝不跨资源补位。正式 writable universe 不经过这里。
 */
function selectedShadowLaneIds(
  entries: readonly V3EntryInput[],
  cursor: string | undefined,
): {
  selected: string[];
  nextCursor?: string;
} {
  const cohorts = marketBaseResourceShadowCohorts(entries);
  const nonEmptyCohortIndexes = cohorts
    .map((cohort, index) => ({ cohort, index }))
    .filter(({ cohort }) => cohort.shadowLaneIds.length > 0)
    .map(({ index }) => index);
  if (nonEmptyCohortIndexes.length === 0) return { selected: [] };

  const orderedActiveLanes = cohorts.flatMap((cohort, cohortIndex) =>
    cohort.activeLaneIds.map((laneId) => ({
      cohortIndex,
      laneId,
      resource: cohort.resource,
    })),
  );
  const nextNonEmptyAfter = (cohortIndex: number): number => {
    for (let offset = 1; offset <= cohorts.length; offset += 1) {
      const candidate = (cohortIndex + offset) % cohorts.length;
      if (cohorts[candidate]!.shadowLaneIds.length > 0) return candidate;
    }
    return nonEmptyCohortIndexes[0]!;
  };
  const nonEmptyAtOrAfter = (cohortIndex: number): number => {
    for (let offset = 0; offset < cohorts.length; offset += 1) {
      const candidate = (cohortIndex + offset) % cohorts.length;
      if (cohorts[candidate]!.shadowLaneIds.length > 0) return candidate;
    }
    return nonEmptyCohortIndexes[0]!;
  };

  let selectedCohortIndex = nonEmptyCohortIndexes[0]!;
  if (cursor) {
    const versioned = parseMarketBaseResourceShadowCursor(cursor);
    const exact = orderedActiveLanes.find(
      (lane) =>
        lane.laneId === (versioned?.laneId ?? cursor) &&
        (!versioned || lane.resource === versioned.resource),
    );
    if (exact) {
      // legacy cursor 可能位于新 cohort 中段；保守视该 cohort 已完成，
      // 从下一 cohort 开始，最多一轮后即可重新覆盖。
      selectedCohortIndex = nextNonEmptyAfter(exact.cohortIndex);
    } else {
      let successor:
        | (typeof orderedActiveLanes)[number]
        | undefined;
      if (versioned) {
        const resourceIndex = MARKET_BASE_RESOURCE_CATALOG.indexOf(
          versioned.resource,
        );
        successor = orderedActiveLanes.find((lane) => {
          const laneResourceIndex = MARKET_BASE_RESOURCE_CATALOG.indexOf(
            lane.resource,
          );
          return (
            laneResourceIndex > resourceIndex ||
            (laneResourceIndex === resourceIndex &&
              stableCompare(lane.laneId, versioned.laneId) > 0)
          );
        });
      } else {
        successor = [...orderedActiveLanes]
          .sort((left, right) => stableCompare(left.laneId, right.laneId))
          .find((lane) => stableCompare(lane.laneId, cursor) > 0);
      }
      selectedCohortIndex = nonEmptyAtOrAfter(
        successor?.cohortIndex ?? nonEmptyCohortIndexes[0]!,
      );
    }
  }

  const selectedCohort = cohorts[selectedCohortIndex]!;
  return {
    selected: [...selectedCohort.shadowLaneIds],
    nextCursor: encodeMarketBaseResourceShadowCursor({
      resource: selectedCohort.resource,
      laneId: selectedCohort.anchorLaneId,
    }),
  };
}

function scopeIsBounded(
  scope: MarketBaseResourcePlanningScopeSnapshot,
): boolean {
  const rooms = new Set(
    scope.entries.flatMap((entry) =>
      entry.lanes.map((lane) => lane.lane.roomName),
    ),
  );
  const laneIds = scope.entries.flatMap((entry) =>
    entry.lanes.map((lane) => lane.laneId),
  );
  const resources = scope.entries.map((entry) => entry.policy.resourceType);
  const expectedResources =
    scope.activeLaneCount === 0
      ? []
      : [...MARKET_BASE_RESOURCE_CATALOG].sort(stableCompare);
  const actualResources = [...resources].sort(stableCompare);
  return (
    scope.activeRoomCount === rooms.size &&
    scope.activeLaneCount === laneIds.length &&
    scope.activeRoomCount <= MARKET_BASE_RESOURCE_MAX_ACTIVE_ROOMS &&
    scope.knownRoomNameCount <= MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES &&
    scope.activeLaneCount <= MARKET_BASE_RESOURCE_MAX_ACTIVE_LANES &&
    actualResources.length === expectedResources.length &&
    actualResources.every(
      (resource, index) => resource === expectedResources[index],
    ) &&
    new Set(resources).size === resources.length &&
    new Set(laneIds).size === laneIds.length &&
    scope.entries.every((entry) => {
      const resource = entry.policy.resourceType as MarketBaseResource;
      const expected = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
      return (
        expected !== undefined &&
        entry.policy.entryId === expected.policyId &&
        entry.policy.revision === expected.policyRevision &&
        entry.policy.requireNativeMineral === false &&
        (entry.policy.grant === "canary" ||
          entry.policy.grant === "continuous") &&
        entry.policy.hardNetFloor === expected.hardFloor &&
        entry.policy.economicNetFloor === expected.economicFloor &&
        entry.policy.minExecutableNotional === expected.minOrderNotional &&
        entry.policy.maxRawOrders === expected.maxRawOrdersScanned &&
        entry.policy.maxEligibleOrders === expected.maxEligibleOrdersPriced &&
        entry.policy.maxTransactionEnergy === expected.maxTransactionEnergy &&
        entry.policy.terminalEnergyReserve === expected.terminalEnergyReserve &&
        entry.policy.resourceRollingCap === expected.rollingMaxAmount &&
        entry.policy.opportunityReserve ===
          expected.rollingOpportunityReserveAmount &&
        entry.policy.evaluatorVersion === 3 &&
        canonicalStableHashV1(
          [...entry.policy.allowedRooms].sort(stableCompare),
        ) ===
          canonicalStableHashV1(
            entry.lanes.map((lane) => lane.lane.roomName).sort(stableCompare),
          ) &&
        entry.lanes.every((lane) => {
          if (lane.lane.resourceType !== entry.policy.resourceType) {
            return false;
          }
          const authorization = lane.lane.authorization;
          if (
            authorization !== "writable" &&
            authorization !== "suspended_shadow"
          ) {
            return false;
          }
          if (authorization !== "writable") return true;
          return Boolean(
            lane.quota?.complete &&
            lane.quota.roomRollingCap ===
              MARKET_BASE_RESOURCE_ROOM_QUOTA_LIMIT &&
            lane.quota.laneRollingCap ===
              MARKET_BASE_RESOURCE_LANE_QUOTA_LIMIT,
          );
        })
      );
    })
  );
}

function cloneBookForRead(
  resource: string,
  raw: readonly MarketOrderSnapshot[],
  seenOrderIds: Map<string, string>,
): {
  complete: boolean;
  blocker?: string;
  orders: MarketOrderSnapshot[];
} {
  if (
    !Array.isArray(raw) ||
    raw.length > MARKET_BASE_RESOURCE_MAX_RAW_ORDERS_PER_RESOURCE
  ) {
    return {
      complete: false,
      blocker: "market_base_raw_book_limit_exceeded",
      orders: [],
    };
  }
  const local = new Map<string, MarketOrderSnapshot>();
  for (const rawOrder of raw) {
    const order = cloneOrder(rawOrder);
    if (!order.id || order.type !== "buy" || order.resourceType !== resource) {
      return {
        complete: false,
        blocker: "market_base_book_scope_invalid",
        orders: [],
      };
    }
    const canonical = canonicalOrder(order);
    const localExisting = local.get(order.id);
    if (localExisting && canonicalOrder(localExisting) !== canonical) {
      return {
        complete: false,
        blocker: "market_base_order_id_content_conflict",
        orders: [],
      };
    }
    const globalExisting = seenOrderIds.get(order.id);
    if (
      globalExisting !== undefined &&
      globalExisting !== `${resource}:${canonical}`
    ) {
      return {
        complete: false,
        blocker: "market_base_cross_resource_order_id_conflict",
        orders: [],
      };
    }
    seenOrderIds.set(order.id, `${resource}:${canonical}`);
    if (!localExisting) local.set(order.id, order);
  }
  return {
    complete: true,
    orders: [...local.values()].sort((left, right) =>
      stableCompare(left.id, right.id)
    ),
  };
}

function cpuExceeded(
  dependencies: MarketBaseResourcePlanningDependencies,
  cpuStartedAt: number,
  recorder?: MarketBaseResourceCpuTraceRecorder,
  phase?: MarketBaseResourceCpuCutPhase,
  field?: MarketBaseResourceCpuTraceField,
): boolean {
  if (recorder && phase && field) {
    return observeMarketBaseResourceCpuTrace(
      recorder,
      dependencies,
      field,
      phase,
    ).exceeded;
  }
  const used = dependencies.cpuUsed();
  const exceeded =
    !Number.isFinite(used) ||
    used < cpuStartedAt ||
    used - cpuStartedAt > MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING;
  if (exceeded && recorder && phase) recorder.trace.cpuCutPhase ??= phase;
  return exceeded;
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

function observeMarketBaseResourceCpuHighWater(
  recorder: MarketBaseResourceCpuTraceRecorder,
  dependencies: Pick<MarketBaseResourcePlanningDependencies, "cpuUsed">,
  phase: MarketBaseResourceCpuCutPhase,
): { exceeded: boolean; rawDelta?: number } {
  const current = dependencies.cpuUsed();
  const rawDelta = current - recorder.startedAt;
  const invalid =
    !Number.isFinite(current) ||
    !Number.isFinite(recorder.startedAt) ||
    current < recorder.startedAt ||
    !Number.isFinite(rawDelta) ||
    rawDelta < recorder.lastRawDelta;
  if (invalid) {
    recorder.trace.cpuCutPhase ??= phase;
    return { exceeded: true };
  }
  recorder.lastRawDelta = rawDelta;
  const exceeded =
    recorder.trace.cpuCutPhase !== null ||
    rawDelta > MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING;
  if (exceeded) recorder.trace.cpuCutPhase ??= phase;
  return { exceeded, rawDelta };
}

function cloneMarketBaseResourceCpuTrace(
  recorder: MarketBaseResourceCpuTraceRecorder,
): MarketBaseResourceCpuTrace {
  return { ...recorder.trace };
}

function observeMarketBaseResourceCpuTrace(
  recorder: MarketBaseResourceCpuTraceRecorder,
  dependencies: Pick<MarketBaseResourcePlanningDependencies, "cpuUsed">,
  field: MarketBaseResourceCpuTraceField,
  phase: MarketBaseResourceCpuCutPhase,
): { exceeded: boolean; rawDelta?: number } {
  const observed = observeMarketBaseResourceCpuHighWater(
    recorder,
    dependencies,
    phase,
  );
  if (observed.rawDelta === undefined) return observed;
  const rawDelta = observed.rawDelta;
  const fieldIndex = MARKET_BASE_RESOURCE_CPU_TRACE_FIELDS.indexOf(field);
  if (
    fieldIndex > 0 &&
    MARKET_BASE_RESOURCE_CPU_TRACE_FIELDS.slice(0, fieldIndex).some(
      (priorField) => recorder.trace[priorField] === null,
    )
  ) {
    // 任一前置里程碑未到达时只更新 raw high-water；绝不制造
    // non-null after null 的诊断空洞。
    return observed;
  }
  const bounded = Math.min(rawDelta, MARKET_BASE_RESOURCE_CPU_TRACE_MAX);
  const previous = recorder.trace[field];
  recorder.trace[field] =
    previous === null ? bounded : Math.max(previous, bounded);
  return observed;
}

function setMarketBaseResourceMarketFactsDisposition(
  recorder: MarketBaseResourceCpuTraceRecorder | undefined,
  disposition: MarketBaseResourceMarketFactsDisposition,
): void {
  if (recorder) recorder.trace.marketFactsDisposition = disposition;
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

function blockedFullRead(
  scope: MarketBaseResourcePlanningScopeSnapshot,
  blocker: string,
  partial: Partial<FullReadResult> = {},
): FullReadResult {
  return {
    complete: false,
    blocker,
    scope,
    sampledShadowLaneIds: [],
    shadowObservations: [],
    rawOrderCount: 0,
    eligibleOrderCount: 0,
    distinctOrderRoomCount: 0,
    transactionCostEvaluationBudget: 0,
    shadowPlannerMode: "none",
    shadowPlannerInvocationCount: 0,
    actualTransactionEnergyEvaluations: 0,
    evaluatedShadowResourceCount: 0,
    candidateIdentityOrderChecks: 0,
    bookBestPrices: [],
    ...partial,
  };
}

interface PreparedShadowPlanningLane {
  entry: V3EntryInput;
  sourceLane: V3LaneInput;
  plannerLane: MarketDirectContinuousLaneInput;
  book: MarketDirectContinuousBook;
  detachedBook?: MarketDirectContinuousDetachedBookSnapshot;
}

interface ShadowPlanningMetrics {
  mode: MarketBaseResourcePlanningSnapshot["shadowPlannerMode"];
  plannerInvocationCount: number;
  batchAttempted: boolean;
  candidateIdentityOrderChecks: number;
}

function shadowPlanningBindings(
  records: readonly PreparedShadowPlanningLane[],
): Array<{
  laneId: string;
  resource: string;
  roomInstanceId: string;
  roomName: string;
}> {
  return records
    .map((record) => ({
      laneId: record.sourceLane.laneId,
      resource: record.entry.policy.resourceType,
      roomInstanceId: record.sourceLane.roomInstanceId,
      roomName: record.sourceLane.lane.roomName,
    }))
    .sort((left, right) => stableCompare(left.laneId, right.laneId));
}

function hasExactShadowPlanningCoverage(
  records: readonly PreparedShadowPlanningLane[],
  sampledLaneIds: readonly string[],
): boolean {
  const bindings = shadowPlanningBindings(records);
  const expected = [...sampledLaneIds].sort(stableCompare);
  return (
    bindings.length === expected.length &&
    new Set(bindings.map((binding) => binding.laneId)).size ===
      bindings.length &&
    bindings.every(
      (binding, index) =>
        binding.laneId === expected[index] &&
        binding.resource.length > 0 &&
        binding.roomInstanceId.length > 0 &&
        binding.roomName.length > 0,
    )
  );
}

function hasExactShadowObservationCoverage(
  observations: readonly MarketBaseResourceShadowObservation[],
  sampledLaneIds: readonly string[],
): boolean {
  const observed = observations
    .map((observation) => observation.laneId)
    .sort(stableCompare);
  const expected = [...sampledLaneIds].sort(stableCompare);
  return (
    observed.length === expected.length &&
    new Set(observed).size === observed.length &&
    observed.every((laneId, index) => laneId === expected[index])
  );
}

function planSingleShadowLane(
  record: PreparedShadowPlanningLane,
  scope: MarketBaseResourcePlanningScopeSnapshot,
  dependencies: MarketBaseResourcePlanningDependencies,
  calculateTransactionEnergy: (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ) => number,
): MarketBaseResourceShadowObservation {
  const { entry, sourceLane, plannerLane, book, detachedBook } = record;
  let local: MarketDirectContinuousPlanningResult;
  try {
    const capability = detachedBook
      ? issueMarketDirectContinuousInvocationBookCapability(detachedBook)
      : undefined;
    const invocationOptions =
      capability || dependencies.observeShadowNormalizationArtifact
        ? {
            ...(capability
              ? { detachedBookCapabilities: [capability] }
              : {}),
            ...(dependencies.observeShadowNormalizationArtifact
              ? {
                  observeNormalizationArtifact:
                    dependencies.observeShadowNormalizationArtifact,
                }
              : {}),
          }
        : undefined;
    local = planMarketDirectContinuous(
      {
        entries: [
          {
            ...entry,
            policy: {
              ...entry.policy,
              allowedRooms: [plannerLane.lane.roomName],
            },
            lanes: [
              {
                ...plannerLane,
                lane: {
                  ...plannerLane.lane,
                  // 仅用于纯函数机会判断；原始 scope/grant 仍是
                  // suspended，且本模块不拥有任何写入口。
                  authorization: "writable",
                },
                // claimed 是 tick 级 arbiter 互斥事实（RC/synthesis 转运
                // 常年占用 terminal 使其恒为 true），对不落地的推演不适用；
                // 保留它会让每条 shadow 观察都撞 lane_scope_invalid、周期
                // 计数永远清零，lane 永远无法晋级（live 曾因此 56 lane
                // 全部 completeCycles=0、零成交）。真实写路径的 arbiter
                // 检查不受影响。
                terminal: {
                  ...plannerLane.terminal,
                  claimed: false,
                },
              },
            ],
            book,
            calculateTransactionEnergy: (
              amount: number,
              order: MarketOrderSnapshot,
              sellerRoomName: string,
            ) => {
              if (!order.roomName) {
                throw new Error("market base shadow order room missing");
              }
              return calculateTransactionEnergy(
                amount,
                sellerRoomName,
                order.roomName,
              );
            },
          } as MarketDirectContinuousEntryInput,
        ],
        energyShadow: { ...scope.energyShadow },
        globalQuota: { ...scope.globalQuota },
        writeContext: {
          ...scope.writeContext,
          revision: canonicalStableHashV1({
            domain: "market-base-resource:shadow-read-context-v1",
            laneId: sourceLane.laneId,
            originalRevision: scope.writeContext.revision,
            scopeEvidence: scope.scopeEvidence,
          }),
          pendingState: "none",
          arbiterState: "available",
        },
      },
      invocationOptions,
    );
  } catch {
    return {
      laneId: sourceLane.laneId,
      result: "incomplete",
      blocker: "market_base_shadow_planner_failed",
    };
  }
  if (!local.complete) {
    const detail = local.blocker?.detail;
    return {
      laneId: sourceLane.laneId,
      result: "incomplete",
      blocker: (local.blocker?.reason || "market_base_shadow_plan_incomplete") +
        (typeof detail === "string" && detail.length > 0
          ? `:${detail.slice(0, 80)}`
          : ""),
    };
  }
  return {
    laneId: sourceLane.laneId,
    result:
      scope.writeContext.pendingState !== "none" ||
      scope.writeContext.arbiterState !== "available"
        ? local.safeCandidates.length > 0
          ? "production_priority_wait"
          : "wait_no_opportunity"
        : local.safeCandidates.length > 0
          ? "safe_opportunity"
          : "safe_no_opportunity",
  };
}

/**
 * 纯 Shadow scope 允许一次纯函数 planner 同时复核证据完整的 ready
 * 子集。synthetic writable 只存在于本 helper 的局部输入；返回值仅含
 * lane qualification observation，planner 的 selected/admitted 永不外泄。
 *
 * eligible=0 继续使用 detached capability 并要求 artifact=true；候选
 * 路径刻意不传 capability，使用 planner 原 canonical finish，并要求
 * observer=false。任一映射、预算、callback 或覆盖异常都返回 undefined，
 * 由调用方按 CPU 门禁决定是否以新 capability 回退逐 lane。
 */
function tryPlanPureShadowBatch(
  records: readonly PreparedShadowPlanningLane[],
  readyLaneIds: readonly string[],
  scope: MarketBaseResourcePlanningScopeSnapshot,
  dependencies: MarketBaseResourcePlanningDependencies,
  collector: {
    eligibleOrderCount: number;
    distinctOrderRoomCount: number;
    transactionCostEvaluationBudget: number;
  },
  calculateTransactionEnergy: (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ) => number,
  metrics: ShadowPlanningMetrics,
  planningCpuExceeded: () => boolean,
): MarketBaseResourceShadowObservation[] | undefined {
  metrics.batchAttempted = true;
  if (
    planningCpuExceeded() ||
    records.length === 0 ||
    !hasExactShadowPlanningCoverage(records, readyLaneIds) ||
    records.some(
      (record) =>
        record.sourceLane.lane.authorization !== "suspended_shadow" ||
        !record.detachedBook ||
        record.detachedBook.book !== record.book,
    )
  ) {
    return undefined;
  }

  const bindings = shadowPlanningBindings(records);
  const bindingKey = (resource: string, roomName: string): string =>
    `${resource}\u0000${roomName}`;
  const recordByBinding = new Map<string, PreparedShadowPlanningLane>();
  for (const record of records) {
    const key = bindingKey(
      record.entry.policy.resourceType,
      record.sourceLane.lane.roomName,
    );
    if (recordByBinding.has(key)) return undefined;
    recordByBinding.set(key, record);
  }
  if (recordByBinding.size !== records.length) return undefined;

  const recordsByResource = new Map<string, PreparedShadowPlanningLane[]>();
  for (const record of records) {
    const resource = record.entry.policy.resourceType;
    const existing = recordsByResource.get(resource);
    if (existing) existing.push(record);
    else recordsByResource.set(resource, [record]);
  }

  const capabilities: MarketDirectContinuousInvocationBookCapability[] = [];
  const batchEntries: MarketDirectContinuousEntryInput[] = [];
  const orderByResourceAndId = new Map<
    string,
    Map<string, MarketOrderSnapshot>
  >();
  const candidatePath = collector.eligibleOrderCount > 0;
  let transactionEnergyCallbacks = 0;
  for (const resource of [...recordsByResource.keys()].sort(stableCompare)) {
    const resourceRecords = recordsByResource.get(resource)!;
    resourceRecords.sort((left, right) =>
      stableCompare(left.sourceLane.laneId, right.sourceLane.laneId),
    );
    const first = resourceRecords[0]!;
    const rooms = resourceRecords.map(
      (record) => record.sourceLane.lane.roomName,
    );
    if (
      new Set(rooms).size !== rooms.length ||
      resourceRecords.some(
        (record) =>
          record.entry !== first.entry ||
          record.book !== first.book ||
          record.detachedBook !== first.detachedBook ||
          record.entry.policy.resourceType !== resource ||
          record.sourceLane.lane.resourceType !== resource,
      )
    ) {
      return undefined;
    }
    if (candidatePath) {
      const orders = new Map<string, MarketOrderSnapshot>();
      for (const [index, order] of first.book.orders.entries()) {
        // raw book 最多 1,000 条；每 32 条复核同一 CPU 窗口，避免候选
        // 身份校验本身在进入 planner 前无界超支。
        if (index % 32 === 0 && planningCpuExceeded()) return undefined;
        metrics.candidateIdentityOrderChecks += 1;
        if (!order.id || orders.has(order.id)) return undefined;
        orders.set(order.id, order);
      }
      if (planningCpuExceeded()) return undefined;
      orderByResourceAndId.set(resource, orders);
    }
    if (!candidatePath) {
      const capability = issueMarketDirectContinuousInvocationBookCapability(
        first.detachedBook!,
      );
      if (!capability || capability.book !== first.book) return undefined;
      capabilities.push(capability);
    }
    batchEntries.push({
      ...first.entry,
      policy: {
        ...first.entry.policy,
        allowedRooms: [...rooms].sort(stableCompare),
      },
      lanes: resourceRecords.map((record) => ({
        ...record.plannerLane,
        lane: {
          ...record.plannerLane.lane,
          // 批调用中每条 lane 都必须可被 planner 评估；真实授权仍只
          // 存在于原 scope，且本结果没有任何写入消费者。
          authorization: "writable",
        },
        // 与 planSingleShadowLane 同理：claimed 是真实写路径的 tick 级
        // 互斥事实，纯函数推演按终端空闲假设评估机会。
        terminal: {
          ...record.plannerLane.terminal,
          claimed: false,
        },
      })),
      book: first.book,
      calculateTransactionEnergy: (
        amount: number,
        order: MarketOrderSnapshot,
        sellerRoomName: string,
      ) => {
        if (!candidatePath) {
          transactionEnergyCallbacks += 1;
          throw new Error("unexpected zero-candidate Shadow energy evaluation");
        }
        const record = recordByBinding.get(
          bindingKey(resource, sellerRoomName),
        );
        const expectedOrder = orderByResourceAndId
          .get(resource)
          ?.get(order.id);
        if (
          (amount !== 1 &&
            amount !== MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT) ||
          !record ||
          !order.roomName ||
          expectedOrder !== order
        ) {
          throw new Error("unexpected pure Shadow batch energy evaluation");
        }
        transactionEnergyCallbacks += 1;
        return calculateTransactionEnergy(
          amount,
          sellerRoomName,
          order.roomName,
        );
      },
    } as MarketDirectContinuousEntryInput);
  }

  const actualBindings = batchEntries
    .flatMap((entry) =>
      entry.lanes.map((lane) => {
        const identified = lane as MarketDirectContinuousLaneInput & {
          laneId?: string;
          roomInstanceId?: string;
        };
        return {
          laneId: identified.laneId || "",
          resource: entry.policy.resourceType,
          roomInstanceId: identified.roomInstanceId || "",
          roomName: lane.lane.roomName,
        };
      }),
    )
    .sort((left, right) => stableCompare(left.laneId, right.laneId));
  if (
    canonicalStableHashV1(actualBindings) !==
      canonicalStableHashV1(bindings) ||
    (!candidatePath &&
      (capabilities.length !== batchEntries.length ||
        new Set(capabilities.map((capability) => capability.book)).size !==
          capabilities.length)) ||
    (candidatePath && capabilities.length !== 0)
  ) {
    return undefined;
  }

  const artifactSignals: boolean[] = [];
  let batch: MarketDirectContinuousPlanningResult;
  try {
    if (planningCpuExceeded()) return undefined;
    metrics.plannerInvocationCount += 1;
    batch = planMarketDirectContinuous(
      {
        entries: batchEntries,
        energyShadow: { ...scope.energyShadow },
        globalQuota: { ...scope.globalQuota },
        writeContext: {
          ...scope.writeContext,
          revision: canonicalStableHashV1({
            bindings,
            currentLaneSetFingerprint: scope.currentLaneSetFingerprint,
            currentRosterFingerprint: scope.currentRosterFingerprint,
            domain: "market-base-resource:shadow-batch-read-context-v1",
            originalRevision: scope.writeContext.revision,
            scopeEvidence: scope.scopeEvidence,
          }),
          pendingState: "none",
          arbiterState: "available",
        },
      },
      {
        ...(capabilities.length > 0
          ? { detachedBookCapabilities: capabilities }
          : {}),
        observeNormalizationArtifact: (used) => {
          artifactSignals.push(used);
        },
      },
    );
    if (planningCpuExceeded()) return undefined;
  } catch {
    return undefined;
  }
  const expectedSellerRooms = new Set(
    bindings.map((binding) => binding.roomName),
  ).size;
  const expectedArtifact = !candidatePath;
  const candidateMatchesReadyBinding = (
    candidate: MarketDirectContinuousPlanningResult["safeCandidates"][number],
  ): boolean => {
    const record = recordByBinding.get(
      bindingKey(candidate.resourceType, candidate.roomName),
    );
    const expectedOrder = orderByResourceAndId
      .get(candidate.resourceType)
      ?.get(candidate.order.id);
    return Boolean(
      record &&
      candidate.entryId === record.entry.policy.entryId &&
      candidate.policyRevision === record.entry.policy.revision &&
      expectedOrder === candidate.order,
    );
  };
  const rejectionMatchesReadyBinding = (
    rejection: MarketDirectContinuousPlanningResult["rejections"][number],
  ): boolean => {
    const record = recordByBinding.get(
      bindingKey(rejection.resourceType, rejection.roomName),
    );
    return Boolean(
      record &&
      rejection.entryId === record.entry.policy.entryId &&
      (!rejection.orderId ||
        orderByResourceAndId
          .get(rejection.resourceType)
          ?.has(rejection.orderId)),
    );
  };
  if (
    !batch.complete ||
    batch.blocker !== undefined ||
    batch.isolatedShadowLanes.length !== 0 ||
    !Number.isSafeInteger(batch.budget.sellerRooms) ||
    batch.budget.sellerRooms !== expectedSellerRooms ||
    !Number.isSafeInteger(batch.budget.distinctOrderRooms) ||
    batch.budget.distinctOrderRooms < 0 ||
    batch.budget.distinctOrderRooms > collector.distinctOrderRoomCount ||
    !Number.isSafeInteger(batch.budget.transactionEnergyEvaluations) ||
    batch.budget.transactionEnergyEvaluations < 0 ||
    batch.budget.transactionEnergyEvaluations >
      collector.transactionCostEvaluationBudget ||
    transactionEnergyCallbacks !==
      batch.budget.transactionEnergyEvaluations ||
    artifactSignals.length !== 1 ||
    artifactSignals[0] !== expectedArtifact
  ) {
    return undefined;
  }
  if (!candidatePath) {
    // collector + detached one-shot capability 已证明零候选。这里保持旧的
    // validation-only 合同，不再为 candidate-only 身份检查二次扫描整本
    // order book 或构造 tuple Set。
    if (
      batch.selected !== undefined ||
      batch.safeCandidates.length !== 0 ||
      batch.admittedCandidates.length !== 0 ||
      batch.budget.transactionEnergyEvaluations !== 0 ||
      transactionEnergyCallbacks !== 0 ||
      metrics.candidateIdentityOrderChecks !== 0
    ) {
      return undefined;
    }
  } else {
    const safeTupleKeys = new Set(
      batch.safeCandidates.map((candidate) => candidate.tupleKey),
    );
    const admittedTupleKeys = new Set(
      batch.admittedCandidates.map((candidate) => candidate.tupleKey),
    );
    if (
      safeTupleKeys.size !== batch.safeCandidates.length ||
      admittedTupleKeys.size !== batch.admittedCandidates.length ||
      batch.safeCandidates.some(
        (candidate) => !candidateMatchesReadyBinding(candidate),
      ) ||
      batch.admittedCandidates.some(
        (candidate) =>
          !candidateMatchesReadyBinding(candidate) ||
          !safeTupleKeys.has(candidate.tupleKey),
      ) ||
      batch.rejections.some(
        (rejection) => !rejectionMatchesReadyBinding(rejection),
      ) ||
      (batch.selected !== undefined &&
        (!candidateMatchesReadyBinding(batch.selected) ||
          !admittedTupleKeys.has(batch.selected.tupleKey)))
    ) {
      return undefined;
    }
  }
  try {
    if (planningCpuExceeded()) return undefined;
    dependencies.observeShadowNormalizationArtifact?.(expectedArtifact);
    if (planningCpuExceeded()) return undefined;
  } catch {
    return undefined;
  }
  metrics.mode = !candidatePath
    ? "batch_zero_candidate"
    : "batch_candidate";
  const result =
    scope.writeContext.pendingState !== "none" ||
    scope.writeContext.arbiterState !== "available"
      ? batch.safeCandidates.length > 0
        ? "production_priority_wait"
        : "wait_no_opportunity"
      : undefined;
  const safeBindings = new Set(
    batch.safeCandidates.map((candidate) =>
      bindingKey(candidate.resourceType, candidate.roomName)
    ),
  );
  return bindings.map((binding) => ({
    laneId: binding.laneId,
    result:
      result ||
      (safeBindings.has(bindingKey(binding.resource, binding.roomName))
        ? "safe_opportunity"
        : "safe_no_opportunity"),
  }));
}

function collectFullRead(
  dependencies: MarketBaseResourcePlanningDependencies,
  cursor: string | undefined,
  cpuStartedAt: number,
  cpuTraceRecorder?: MarketBaseResourceCpuTraceRecorder,
  readIndex: 1 | 2 = 1,
): FullReadResult {
  const scope = dependencies.readScope();
  if (
    !scope.complete ||
    scope.blocker ||
    !scope.scopeEvidence ||
    !scope.currentRosterFingerprint ||
    !scope.currentLaneSetFingerprint
  ) {
    return blockedFullRead(
      scope,
      scope.blocker || "market_base_scope_incomplete",
    );
  }
  if (!scopeIsBounded(scope)) {
    return blockedFullRead(scope, "market_base_scope_limit_or_count_mismatch");
  }
  if (
    cpuExceeded(
      dependencies,
      cpuStartedAt,
      cpuTraceRecorder,
      readIndex === 1 ? "scope_core_read1" : "scope_core_read2",
      "cpuAfterScopeCore",
    )
  ) {
    return blockedFullRead(scope, "market_base_cpu_ceiling_exceeded");
  }

  setMarketBaseResourceMarketFactsDisposition(cpuTraceRecorder, "read");

  let ownOrders: readonly MarketOrderSnapshot[];
  try {
    ownOrders = dependencies.readOwnOrders().map(cloneOrder);
  } catch {
    return blockedFullRead(scope, "market_base_own_orders_incomplete");
  }
  const ownOrderIds = new Set(ownOrders.map((order) => order.id));
  if (
    ownOrderIds.size !== ownOrders.length ||
    ownOrders.some((order) => !order.id)
  ) {
    return blockedFullRead(scope, "market_base_own_orders_invalid");
  }
  // 有可写 lane 时优先完成其两次全量读取和交易准备。Shadow lane 仍在
  // live scope/candidate/protection 中逐项读验，但本轮暂停 cohort 采样，
  // 不消耗订单与 terminal 读取预算，也不推进 cursor 或资格周期。
  const scopeHasWritableLane = scope.entries.some((entry) =>
    entry.lanes.some((lane) => lane.lane.authorization === "writable"),
  );
  const shadow = scopeHasWritableLane
    ? { selected: [] as string[], nextCursor: cursor }
    : selectedShadowLaneIds(scope.entries, cursor);
  const sampledShadowSet = new Set(shadow.selected);
  const evaluatedShadowResourceCount = new Set(
    scope.entries
      .filter((entry) =>
        entry.lanes.some((lane) => sampledShadowSet.has(lane.laneId)),
      )
      .map((entry) => entry.policy.resourceType),
  ).size;
  const seenOrderIds = new Map<string, string>();
  const books = new Map<string, MarketDirectContinuousBook>();
  const bookBestPrices: FullReadResult["bookBestPrices"] = [];
  const detachedShadowBooks = new Map<
    string,
    MarketDirectContinuousDetachedBookSnapshot
  >();
  const shadowBookBlockers = new Map<string, string>();
  const isolatedCandidateLaneIds = new Set(
    scope.isolatedCandidateLaneIds ?? [],
  );
  const terminalEvidence: unknown[] = [];
  const terminalReads: Record<string, MarketBaseResourceTerminalRead> = {};
  let rawOrderCount = 0;
  let eligibleOrderCount = 0;
  const evaluatedDistinctOrderRooms = new Set<string>();

  // 资源级完整 book 每次 full read 只调用一次。即使只有 Shadow lane，
  // 也读取其资源 book；同资源的 writable/shadow lane 共享一个 clone。
  // 候选证据被隔离的资源（全部 lane 都会记 incomplete）不再读 book。
  const evaluatedResources = scope.entries
    .filter(
      (entry) =>
        !entry.lanes.every((lane) =>
          isolatedCandidateLaneIds.has(lane.laneId),
        ) &&
        entry.lanes.some(
          (lane) =>
            lane.lane.authorization === "writable" ||
            sampledShadowSet.has(lane.laneId),
        ),
    )
    .map((entry) => entry.policy.resourceType)
    .sort(stableCompare);
  if (new Set(evaluatedResources).size !== evaluatedResources.length) {
    return blockedFullRead(scope, "market_base_resource_policy_duplicate");
  }
  for (const resource of evaluatedResources) {
    const resourceEntry = scope.entries.find(
      (candidate) => candidate.policy.resourceType === resource,
    )!;
    const resourceHasWritableLane = resourceEntry.lanes.some(
      (lane) => lane.lane.authorization === "writable",
    );
    const sampledLaneIds = resourceEntry.lanes
      .filter((lane) => sampledShadowSet.has(lane.laneId))
      .map((lane) => lane.laneId);
    const recordShadowBookBlocker = (blocker: string): void => {
      for (const laneId of sampledLaneIds) {
        shadowBookBlockers.set(laneId, blocker);
      }
    };
    let raw: readonly MarketOrderSnapshot[];
    try {
      raw = dependencies.readCurrentBuyOrders(resource as ResourceConstant);
    } catch {
      const blocker = `market_base_book_incomplete:${resource}`;
      if (resourceHasWritableLane) {
        return blockedFullRead(scope, blocker);
      }
      recordShadowBookBlocker(blocker);
      continue;
    }
    rawOrderCount += raw.length;
    const cloned = cloneBookForRead(resource, raw, seenOrderIds);
    if (!cloned.complete) {
      const blocker = cloned.blocker || "market_base_book_incomplete";
      // orderId 跨资源冲突属于未知 shared scope，不能只隔离 Shadow。
      if (
        resourceHasWritableLane ||
        blocker === "market_base_cross_resource_order_id_conflict"
      ) {
        return blockedFullRead(scope, blocker, { rawOrderCount });
      }
      recordShadowBookBlocker(blocker);
      continue;
    }
    const eligible = cloned.orders.filter((order) =>
      eligibleForBudget(
        order,
        resource,
        resourceEntry.policy.minExecutableNotional,
        ownOrderIds,
      ),
    );
    if (
      eligible.length > MARKET_BASE_RESOURCE_MAX_ELIGIBLE_ORDERS_PER_RESOURCE
    ) {
      const blocker = `market_base_eligible_book_limit_exceeded:${resource}`;
      if (resourceHasWritableLane) {
        return blockedFullRead(scope, blocker, {
          rawOrderCount,
          eligibleOrderCount: eligibleOrderCount + eligible.length,
        });
      }
      recordShadowBookBlocker(blocker);
      continue;
    }
    eligibleOrderCount += eligible.length;
    let bestPrice = 0;
    for (const order of eligible) {
      if (
        Number.isFinite(order.price) &&
        order.price > bestPrice
      ) {
        bestPrice = order.price;
      }
    }
    if (bestPrice > 0) {
      bookBestPrices.push({ resource: resource as MarketBaseResource, price: bestPrice });
    }
    for (const order of eligible) {
      evaluatedDistinctOrderRooms.add(order.roomName!);
    }
    let book: MarketDirectContinuousBook = {
      complete: true,
      revision: canonicalStableHashV1({
        domain: "market-base-resource:book-v1",
        ownOrderIds: [...ownOrderIds].sort(stableCompare),
        orders: cloned.orders,
        resource,
      }),
      orders: cloned.orders,
      ownOrderIds: [...ownOrderIds].sort(stableCompare),
    };
    // 纯 Shadow batch 总是使用本次 full read 的冻结 detached book。
    // eligible=0 时 capability 复用 normalization artifact；有候选时仅把
    // detached book 作为不可变输入，planner 仍走原 canonical finish。
    if (
      !resourceHasWritableLane &&
      sampledLaneIds.length > 0
    ) {
      const detached = createMarketDirectContinuousDetachedBookSnapshot(book);
      if (detached) {
        detachedShadowBooks.set(resource, detached);
        book = detached.book;
      }
    }
    books.set(resource, book);
  }
  if (
    evaluatedDistinctOrderRooms.size >
    MARKET_BASE_RESOURCE_MAX_DISTINCT_ORDER_ROOMS
  ) {
    return blockedFullRead(
      scope,
      "market_base_distinct_order_room_limit_exceeded",
      {
        rawOrderCount,
        eligibleOrderCount,
        distinctOrderRoomCount: evaluatedDistinctOrderRooms.size,
      },
    );
  }

  const evaluatedSellerRoomNames = new Set(
    scope.entries.flatMap((entry) =>
      entry.lanes
        .filter(
          (lane) =>
            lane.lane.authorization === "writable" ||
            sampledShadowSet.has(lane.laneId),
        )
        .map((lane) => lane.lane.roomName),
    ),
  );
  const transactionCostEvaluationBudget =
    2 * evaluatedSellerRoomNames.size * evaluatedDistinctOrderRooms.size;
  if (
    transactionCostEvaluationBudget >
    MARKET_BASE_RESOURCE_MAX_TRANSACTION_COST_EVALUATIONS
  ) {
    return blockedFullRead(
      scope,
      "market_base_transaction_cost_evaluation_limit_exceeded",
      {
        rawOrderCount,
        eligibleOrderCount,
        distinctOrderRoomCount: evaluatedDistinctOrderRooms.size,
        transactionCostEvaluationBudget,
      },
    );
  }
  const transactionEnergyMemo = new Map<string, number>();
  let actualTransactionEnergyEvaluations = 0;
  let planningCpuCut = false;
  const planningCpuExceeded = (): boolean => {
    if (
      !cpuExceeded(
        dependencies,
        cpuStartedAt,
        cpuTraceRecorder,
        readIndex === 1 ? "shadow_batch_read1" : "shadow_batch_read2",
        "cpuAfterShadowBatch",
      )
    ) {
      return false;
    }
    planningCpuCut = true;
    return true;
  };
  const calculateBoundedTransactionEnergy = (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ): number => {
    const key = `${amount}:${fromRoomName}:${toRoomName}`;
    const cached = transactionEnergyMemo.get(key);
    if (cached !== undefined) return cached;
    if (
      transactionEnergyMemo.size >=
      MARKET_BASE_RESOURCE_MAX_TRANSACTION_COST_EVALUATIONS
    ) {
      throw new RangeError(
        "market_base_transaction_cost_evaluation_limit_exceeded",
      );
    }
    if (planningCpuExceeded()) {
      throw new RangeError("market_base_cpu_ceiling_exceeded");
    }
    actualTransactionEnergyEvaluations += 1;
    const value = dependencies.calculateTransactionEnergy(
      amount,
      fromRoomName,
      toRoomName,
    );
    if (planningCpuExceeded()) {
      throw new RangeError("market_base_cpu_ceiling_exceeded");
    }
    transactionEnergyMemo.set(key, value);
    return value;
  };

  const plannerEntries: MarketDirectContinuousEntryInput[] = [];
  const preparedShadowLanes: PreparedShadowPlanningLane[] = [];
  const shadowObservations: MarketBaseResourceShadowObservation[] = [];
  const shadowPlanningMetrics: ShadowPlanningMetrics = {
    mode: "none",
    plannerInvocationCount: 0,
    batchAttempted: false,
    candidateIdentityOrderChecks: 0,
  };
  const currentShadowPlanningTelemetry = (): Pick<
    FullReadResult,
    | "shadowPlannerMode"
    | "shadowPlannerInvocationCount"
    | "actualTransactionEnergyEvaluations"
    | "evaluatedShadowResourceCount"
    | "candidateIdentityOrderChecks"
  > => ({
    shadowPlannerMode: shadowPlanningMetrics.mode,
    shadowPlannerInvocationCount:
      shadowPlanningMetrics.plannerInvocationCount,
    actualTransactionEnergyEvaluations,
    evaluatedShadowResourceCount,
    candidateIdentityOrderChecks:
      shadowPlanningMetrics.candidateIdentityOrderChecks,
  });
  const blockedByPlanningCpu = (): FullReadResult => {
    if (cpuTraceRecorder) {
      cpuTraceRecorder.trace.cpuCutPhase ??=
        readIndex === 1 ? "shadow_batch_read1" : "shadow_batch_read2";
    }
    return blockedFullRead(scope, "market_base_cpu_ceiling_exceeded", {
      sampledShadowLaneIds: shadow.selected,
      shadowObservations,
      rawOrderCount,
      eligibleOrderCount,
      distinctOrderRoomCount: evaluatedDistinctOrderRooms.size,
      transactionCostEvaluationBudget,
      ...currentShadowPlanningTelemetry(),
    });
  };
  for (const entry of scope.entries) {
    const lanes: MarketDirectContinuousLaneInput[] = [];
    const entryPreparedShadowLanes: PreparedShadowPlanningLane[] = [];
    const sortedLanes = [...entry.lanes].sort((left, right) =>
      stableCompare(left.laneId, right.laneId),
    );
    for (const lane of sortedLanes) {
      const writable = lane.lane.authorization === "writable";
      const sampledShadow = sampledShadowSet.has(lane.laneId);
      if (!writable && !sampledShadow) continue;
      if (isolatedCandidateLaneIds.has(lane.laneId)) {
        // 资源级候选证据隔离：该 lane 记 incomplete 观察（周期停涨、
        // 证据不清零），不进 planner，不消耗读取预算。
        shadowObservations.push({
          laneId: lane.laneId,
          result: "incomplete",
          blocker: "market_base_v3_candidate_evidence_stale",
        });
        continue;
      }
      const shadowBookBlocker = sampledShadow
        ? shadowBookBlockers.get(lane.laneId)
        : undefined;
      if (shadowBookBlocker) {
        shadowObservations.push({
          laneId: lane.laneId,
          result: "incomplete",
          blocker: shadowBookBlocker,
        });
        continue;
      }
      let terminal: MarketBaseResourceTerminalRead | undefined;
      try {
        terminal = dependencies.readTerminal(
          lane.lane.roomName,
          entry.policy.resourceType as ResourceConstant,
        );
      } catch {
        terminal = undefined;
      }
      terminalEvidence.push({
        laneId: lane.laneId,
        resource: entry.policy.resourceType,
        roomName: lane.lane.roomName,
        terminal: terminal || null,
      });
      if (terminal) {
        terminalReads[
          runtimeCandidateKey(lane.lane.roomName, entry.policy.resourceType)
        ] = terminal;
      }
      const terminalComplete = Boolean(
        terminal &&
        terminal.roomName === lane.lane.roomName &&
        terminal.owned &&
        typeof terminal.ready === "boolean" &&
        terminal.terminalId &&
        terminal.revision &&
        Number.isSafeInteger(terminal.cooldown) &&
        terminal.cooldown >= 0 &&
        Number.isSafeInteger(terminal.resourceAmount) &&
        terminal.resourceAmount >= 0 &&
        Number.isSafeInteger(terminal.energy) &&
        terminal.energy >= 0,
      );
      if (
        !terminalComplete ||
        !lane.protection.complete ||
        !lane.protection.revision
      ) {
        const blocker = !terminalComplete
          ? "market_base_terminal_incomplete"
          : "market_base_protection_incomplete";
        if (writable) {
          return blockedFullRead(scope, `${blocker}:${lane.laneId}`, {
            sampledShadowLaneIds: shadow.selected,
            nextShadowCursor:
              new Set(
                shadowObservations.map((observation) => observation.laneId),
              ).size === shadow.selected.length
                ? shadow.nextCursor
                : undefined,
            shadowObservations,
            rawOrderCount,
            eligibleOrderCount,
            distinctOrderRoomCount: evaluatedDistinctOrderRooms.size,
            transactionCostEvaluationBudget,
            ...currentShadowPlanningTelemetry(),
          });
        }
        shadowObservations.push({
          laneId: lane.laneId,
          result: "incomplete",
          blocker,
        });
        continue;
      }
      lanes.push({
        ...lane,
        lane: {
          ...lane.lane,
        },
        terminal: {
          complete: true,
          revision: terminal!.revision,
          // cooldown/readiness 是已知的当前无机会，不是终端证据不完整。
          // planner 会在 V3 tuple admission 时只跳过该 lane。
          normal: true,
          ready: terminal!.ready,
          claimed: lane.terminal.claimed,
          cooldown: terminal!.cooldown,
          resourceAmount: terminal!.resourceAmount,
          energy: terminal!.energy,
          ...(terminal!.effectivePostDealEnergyReserve === undefined
            ? {}
            : {
                effectivePostDealEnergyReserve:
                  terminal!.effectivePostDealEnergyReserve,
              }),
        },
      } as MarketDirectContinuousLaneInput);
    }
    const shadowLanes = lanes.filter(
      (lane) =>
        (
          lane.lane as MarketDirectContinuousLaneInput["lane"] & {
            authorization?: string;
          }
        ).authorization === "suspended_shadow",
    );
    const book = books.get(entry.policy.resourceType);
    for (const shadowLane of shadowLanes) {
      const sourceLane = sortedLanes.find(
        (candidate) =>
          candidate.lane.roomName === shadowLane.lane.roomName &&
          sampledShadowSet.has(candidate.laneId),
      );
      if (!sourceLane || !book) {
        if (sourceLane) {
          shadowObservations.push({
            laneId: sourceLane.laneId,
            result: "incomplete",
            blocker: "market_base_shadow_book_incomplete",
          });
        }
        continue;
      }
      entryPreparedShadowLanes.push({
        entry,
        sourceLane,
        plannerLane: shadowLane,
        book,
        detachedBook: detachedShadowBooks.get(entry.policy.resourceType),
      });
    }
    if (scopeHasWritableLane) {
      // 混合 scope 保持原逐 entry 时序：若后续 writable entry fail closed，
      // 已确定的较早 Shadow lane-local reset 仍须随 blocker 返回。
      for (const record of entryPreparedShadowLanes) {
        if (planningCpuExceeded()) return blockedByPlanningCpu();
        shadowPlanningMetrics.mode = "per_lane";
        shadowPlanningMetrics.plannerInvocationCount += 1;
        shadowObservations.push(
          planSingleShadowLane(
            record,
            scope,
            dependencies,
            calculateBoundedTransactionEnergy,
          ),
        );
        if (planningCpuExceeded()) return blockedByPlanningCpu();
      }
    } else {
      preparedShadowLanes.push(...entryPreparedShadowLanes);
    }
    const writableLanes = lanes.filter(
      (lane) =>
        (
          lane.lane as MarketDirectContinuousLaneInput["lane"] & {
            authorization?: string;
          }
        ).authorization === "writable",
    );
    if (writableLanes.length === 0) continue;
    if (!book) {
      return blockedFullRead(
        scope,
        `market_base_book_incomplete:${entry.policy.resourceType}`,
        {
          sampledShadowLaneIds: shadow.selected,
          shadowObservations,
          rawOrderCount,
          eligibleOrderCount,
          distinctOrderRoomCount: evaluatedDistinctOrderRooms.size,
          transactionCostEvaluationBudget,
          ...currentShadowPlanningTelemetry(),
        },
      );
    }
    plannerEntries.push({
      ...entry,
      policy: {
        ...entry.policy,
        allowedRooms: writableLanes.map((lane) => lane.lane.roomName),
      },
      lanes: writableLanes,
      book,
      calculateTransactionEnergy: (
        amount: number,
        order: MarketOrderSnapshot,
        sellerRoomName: string,
      ) => {
        if (!order.roomName) {
          throw new Error("market base order room missing");
        }
        return calculateBoundedTransactionEnergy(
          amount,
          sellerRoomName,
          order.roomName,
        );
      },
    } as MarketDirectContinuousEntryInput);
  }

  if (
    cpuTraceRecorder &&
    observeMarketBaseResourceCpuTrace(
      cpuTraceRecorder,
      dependencies,
      "cpuAfterMarketFacts",
      readIndex === 1 ? "market_facts_read1" : "market_facts_read2",
    ).exceeded
  ) {
    return blockedByPlanningCpu();
  }

  const preObservedLaneIds = new Set(
    shadowObservations.map((observation) => observation.laneId),
  );
  const preObservedCoverageValid =
    preObservedLaneIds.size === shadowObservations.length &&
    shadowObservations.every((observation) =>
      sampledShadowSet.has(observation.laneId)
    );
  const readyLaneIds = shadow.selected.filter(
    (laneId) => !preObservedLaneIds.has(laneId),
  );
  const pureShadowBatchEligible =
    !scopeHasWritableLane &&
    preObservedCoverageValid &&
    preparedShadowLanes.length > 0 &&
    preObservedLaneIds.size + readyLaneIds.length === shadow.selected.length &&
    hasExactShadowPlanningCoverage(preparedShadowLanes, readyLaneIds);
  const batchObservations = pureShadowBatchEligible
    ? tryPlanPureShadowBatch(
        preparedShadowLanes,
        readyLaneIds,
        scope,
        dependencies,
        {
          eligibleOrderCount,
          distinctOrderRoomCount: evaluatedDistinctOrderRooms.size,
          transactionCostEvaluationBudget,
        },
        calculateBoundedTransactionEnergy,
        shadowPlanningMetrics,
        planningCpuExceeded,
      )
    : undefined;
  if (batchObservations) {
    shadowObservations.push(...batchObservations);
  } else {
    // 批路径可能已消费 capability；回退逐 lane 时必须从同一 detached
    // snapshot 重新签发，绝不复用批调用中的一次性对象。
    if (
      pureShadowBatchEligible &&
      (planningCpuCut || planningCpuExceeded())
    ) {
      // CPU cut 发生后尚未真正进入逐 lane fallback，mode 保留实际已完成
      // 的路径；batchAttempted/invocationCount 已足够表明批调用进度。
      return blockedByPlanningCpu();
    }
    if (preparedShadowLanes.length > 0) {
      shadowPlanningMetrics.mode = shadowPlanningMetrics.batchAttempted
        ? "batch_fallback"
        : "per_lane";
    }
    for (const record of preparedShadowLanes) {
      if (planningCpuExceeded()) return blockedByPlanningCpu();
      shadowPlanningMetrics.plannerInvocationCount += 1;
      shadowObservations.push(
        planSingleShadowLane(
          record,
          scope,
          dependencies,
          calculateBoundedTransactionEnergy,
        ),
      );
      if (planningCpuExceeded()) return blockedByPlanningCpu();
    }
  }
  if (planningCpuExceeded()) return blockedByPlanningCpu();
  if (!hasExactShadowObservationCoverage(shadowObservations, shadow.selected)) {
    return blockedFullRead(
      scope,
      "market_base_shadow_observation_coverage_incomplete",
      {
        sampledShadowLaneIds: shadow.selected,
        shadowObservations,
        rawOrderCount,
        eligibleOrderCount,
        distinctOrderRoomCount: evaluatedDistinctOrderRooms.size,
        transactionCostEvaluationBudget,
        ...currentShadowPlanningTelemetry(),
      },
    );
  }
  if (
    cpuTraceRecorder &&
    observeMarketBaseResourceCpuTrace(
      cpuTraceRecorder,
      dependencies,
      "cpuAfterShadowBatch",
      readIndex === 1 ? "shadow_batch_read1" : "shadow_batch_read2",
    ).exceeded
  ) {
    return blockedByPlanningCpu();
  }
  // 批路径与 fresh-capability 回退必须对同一 lane 集合给出相同的稳定
  // 投影顺序，避免 planner entry 顺序成为 lifecycle observation 的隐含输入。
  shadowObservations.sort((left, right) =>
    stableCompare(left.laneId, right.laneId),
  );
  const readActualTransactionEnergyEvaluations = (): number =>
    actualTransactionEnergyEvaluations;

  const plannerInput: PlanMarketDirectContinuousInput = {
    entries: plannerEntries,
    energyShadow: { ...scope.energyShadow },
    globalQuota: { ...scope.globalQuota },
    writeContext: {
      ...scope.writeContext,
      revision: canonicalStableHashV1({
        domain: "market-base-resource:full-read-scope-v1",
        currentLaneSetFingerprint: scope.currentLaneSetFingerprint,
        currentRosterFingerprint: scope.currentRosterFingerprint,
        originalRevision: scope.writeContext.revision,
        scopeEvidence: scope.scopeEvidence,
      }),
    },
  };
  // 无 writable lane 时本函数随即返回 Shadow qualification 结果；完整
  // 双读证据没有任何写入消费者，因此不重复深哈希整本订单和 terminal。
  const evidence: MarketBaseResourceFullReadEvidence | undefined =
    plannerEntries.length === 0
      ? undefined
      : {
          bookFingerprint: canonicalStableHashV1({
            books: [...books.entries()]
              .sort(([left], [right]) => stableCompare(left, right))
              .map(([resource, book]) => ({
                book,
                resource,
              })),
            domain: "market-base-resource:full-read-books-v1",
          }),
          protectionFingerprint:
            scope.protectionFingerprint ||
            canonicalStableHashV1({
              domain: "market-base-resource:full-read-protection-v1",
              entries: plannerEntries.map((entry) => ({
                lanes: entry.lanes.map((lane) => ({
                  protection: lane.protection,
                  roomName: lane.lane.roomName,
                })),
                resource: entry.policy.resourceType,
              })),
            }),
          energyReadinessFingerprint: canonicalStableHashV1({
            domain: "market-base-resource:full-read-energy-readiness-v1",
            energyShadow: scope.energyShadow,
            terminalEvidence,
          }),
          arbiterFingerprint:
            scope.arbiterFingerprint ||
            canonicalStableHashV1({
              domain: "market-base-resource:full-read-arbiter-v1",
              writeContext: scope.writeContext,
            }),
          pricingRatchetFingerprint: scope.pricingRatchet?.fingerprint || "",
        };
  return {
    complete: true,
    scope,
    plannerInput,
    sampledShadowLaneIds: shadow.selected,
    nextShadowCursor: shadow.nextCursor,
    shadowObservations,
    rawOrderCount,
    eligibleOrderCount,
    distinctOrderRoomCount: evaluatedDistinctOrderRooms.size,
    transactionCostEvaluationBudget,
    shadowPlannerMode: shadowPlanningMetrics.mode,
    shadowPlannerInvocationCount:
      shadowPlanningMetrics.plannerInvocationCount,
    // writable planner 在 collectFullRead 返回后才消费其 callback；getter
    // 保持同一 full-read counter 的实时值，避免 telemetry 只统计 Shadow。
    get actualTransactionEnergyEvaluations() {
      return readActualTransactionEnergyEvaluations();
    },
    evaluatedShadowResourceCount,
    candidateIdentityOrderChecks:
      shadowPlanningMetrics.candidateIdentityOrderChecks,
    ...(evidence ? { evidence } : {}),
    terminalReads,
    bookBestPrices,
  };
}

function emptyResult(
  cpuUsed: number,
  blocker: string,
  read?: FullReadResult,
): MarketBaseResourceTwoReadPlan {
  const preserveCursor =
    blocker !== "market_base_cpu_ceiling_exceeded" &&
    read?.sampledShadowLaneIds.every((laneId) =>
      read.shadowObservations.some(
        (observation) => observation.laneId === laneId,
      ),
    ) === true;
  return {
    complete: false,
    blocker,
    firstScopeEvidence: read?.scope.scopeEvidence,
    firstReadEvidence: read?.evidence,
    nextPricingRatchet: read?.scope.pricingRatchet,
    sampledShadowLaneIds: read?.sampledShadowLaneIds || [],
    nextShadowCursor: preserveCursor ? read?.nextShadowCursor : undefined,
    shadowObservations:
      blocker === "market_base_cpu_ceiling_exceeded"
        ? (read?.shadowObservations || []).filter(
            (observation) => observation.result === "incomplete",
          )
        : read?.shadowObservations || [],
    rawOrderCount: read?.rawOrderCount || 0,
    eligibleOrderCount: read?.eligibleOrderCount || 0,
    distinctOrderRoomCount: read?.distinctOrderRoomCount || 0,
    transactionCostEvaluationBudget: read?.transactionCostEvaluationBudget || 0,
    shadowPlannerMode: read?.shadowPlannerMode || "none",
    shadowPlannerInvocationCount: read?.shadowPlannerInvocationCount || 0,
    actualTransactionEnergyEvaluations:
      read?.actualTransactionEnergyEvaluations || 0,
    evaluatedShadowResourceCount:
      read?.evaluatedShadowResourceCount || 0,
    candidateIdentityOrderChecks:
      read?.candidateIdentityOrderChecks || 0,
    // observe 投影依赖 book/盈余输入持续积累。"无可成交订单"是低价市场
    // 的常态（正是动态地板要服务的场景），book 数据在完整 full read 中
    // 已提取，任何携带完整 read 的空结果都必须转交投影，否则 EMA 恰在
    // 最需要跟踪市场时断流（live 曾因此 H/L/X 冻结两天）。
    ...(read?.complete
      ? {
          firstBookBestPrices: read.bookBestPrices,
          firstLaneSurplus: laneSurplusInputsFromRead(read),
        }
      : {}),
    cpuUsed,
  };
}

function combinedTwoReadPlanningTelemetry(
  firstRead: FullReadResult,
  secondRead: FullReadResult,
): Pick<
  MarketBaseResourceTwoReadPlan,
  | "shadowPlannerMode"
  | "shadowPlannerInvocationCount"
  | "actualTransactionEnergyEvaluations"
  | "evaluatedShadowResourceCount"
  | "candidateIdentityOrderChecks"
> {
  return {
    // lifecycle observation 仍来自第一读；mode 也优先描述第一读采用的
    // Shadow 路径。计数则必须包含第二读及其 formal planner 已发生的工作。
    shadowPlannerMode:
      firstRead.shadowPlannerMode !== "none"
        ? firstRead.shadowPlannerMode
        : secondRead.shadowPlannerMode,
    shadowPlannerInvocationCount:
      firstRead.shadowPlannerInvocationCount +
      secondRead.shadowPlannerInvocationCount,
    actualTransactionEnergyEvaluations:
      firstRead.actualTransactionEnergyEvaluations +
      secondRead.actualTransactionEnergyEvaluations,
    // 这是每次 full read 中 sampled Shadow cohort 的资源宽度，不是累计
    // BUY-book API 调用数；同一 cohort 的双读不应把 1 误报成 2。
    evaluatedShadowResourceCount: Math.max(
      firstRead.evaluatedShadowResourceCount,
      secondRead.evaluatedShadowResourceCount,
    ),
    candidateIdentityOrderChecks:
      firstRead.candidateIdentityOrderChecks +
      secondRead.candidateIdentityOrderChecks,
  };
}

function observeMarketBaseResourcePlanningCpu(
  dependencies: MarketBaseResourcePlanningDependencies,
  cpuStartedAt: number,
  recorder: MarketBaseResourceCpuTraceRecorder | undefined,
  readIndex: 1 | 2,
  shadowBatchMilestoneReached = true,
): { cpuUsed: number; exceeded: boolean } {
  if (recorder) {
    const phase: MarketBaseResourceCpuCutPhase = shadowBatchMilestoneReached
      ? readIndex === 1
        ? "shadow_batch_read1"
        : "shadow_batch_read2"
      : recorder.trace.cpuAfterMarketFacts !== null
        ? readIndex === 1
          ? "shadow_batch_read1"
          : "shadow_batch_read2"
        : recorder.trace.marketFactsDisposition === "read"
          ? readIndex === 1
            ? "market_facts_read1"
            : "market_facts_read2"
          : readIndex === 1
            ? "scope_core_read1"
            : "scope_core_read2";
    // incomplete full read 只能更新 raw high-water，不能凭一次通用结束读
    // 伪造尚未到达的 shadow-batch 里程碑，否则会形成 null-hole。
    const observed = shadowBatchMilestoneReached
      ? observeMarketBaseResourceCpuTrace(
          recorder,
          dependencies,
          "cpuAfterShadowBatch",
          phase,
        )
      : observeMarketBaseResourceCpuHighWater(
          recorder,
          dependencies,
          phase,
        );
    return {
      cpuUsed: observed.rawDelta ?? recorder.lastRawDelta,
      exceeded: observed.exceeded,
    };
  }
  const current = dependencies.cpuUsed();
  const cpuUsed = current - cpuStartedAt;
  return {
    cpuUsed:
      Number.isFinite(cpuUsed) && cpuUsed >= 0
        ? cpuUsed
        : MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING,
    exceeded:
      !Number.isFinite(current) ||
      current < cpuStartedAt ||
      !Number.isFinite(cpuUsed) ||
      cpuUsed > MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING,
  };
}

/**
 * V3 纯双读内核：第一读完整扫描全部 writable lane，仅在真正准备写入时
 * 执行独立第二读。任何 scope/non-selected lane/book/terminal/quota/arbiter
 * 变化都拒绝本 tick，不会降级换次优订单。
 */
export function planMarketBaseResourceTwoRead(
  dependencies: MarketBaseResourcePlanningDependencies,
  shadowCursor?: string,
  cpuStartedAtOverride?: number,
  cpuTraceRecorder?: MarketBaseResourceCpuTraceRecorder,
): MarketBaseResourceTwoReadPlan {
  const cpuStartedAt = cpuStartedAtOverride ?? dependencies.cpuUsed();
  if (!Number.isFinite(cpuStartedAt)) {
    return emptyResult(0, "market_base_cpu_observation_invalid");
  }
  const firstRead = collectFullRead(
    dependencies,
    shadowCursor,
    cpuStartedAt,
    cpuTraceRecorder,
    1,
  );
  let cpuObservation = observeMarketBaseResourcePlanningCpu(
    dependencies,
    cpuStartedAt,
    cpuTraceRecorder,
    1,
    firstRead.complete && Boolean(firstRead.plannerInput),
  );
  let cpuDelta = cpuObservation.cpuUsed;
  if (!firstRead.complete || !firstRead.plannerInput) {
    return emptyResult(
      cpuDelta,
      firstRead.blocker || "market_base_first_read_incomplete",
      firstRead,
    );
  }
  if (cpuObservation.exceeded) {
    return emptyResult(
      cpuDelta,
      "market_base_cpu_ceiling_exceeded",
      firstRead,
    );
  }
  if (firstRead.plannerInput.entries.length === 0) {
    return {
      ...emptyResult(cpuDelta, "market_base_no_writable_lane", firstRead),
      complete: true,
    };
  }
  const first = planMarketDirectContinuous(firstRead.plannerInput);
  cpuObservation = observeMarketBaseResourcePlanningCpu(
    dependencies,
    cpuStartedAt,
    cpuTraceRecorder,
    1,
  );
  cpuDelta = cpuObservation.cpuUsed;
  if (cpuObservation.exceeded) {
    return {
      ...emptyResult(
        cpuDelta,
        "market_base_cpu_ceiling_exceeded",
        firstRead,
      ),
      first,
    };
  }
  if (!first.complete || !first.selected) {
    return {
      complete: first.complete,
      blocker: first.blocker?.reason,
      first,
      firstScopeEvidence: firstRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      nextPricingRatchet: firstRead.scope.pricingRatchet,
      sampledShadowLaneIds: firstRead.sampledShadowLaneIds,
      nextShadowCursor: firstRead.nextShadowCursor,
      shadowObservations: firstRead.shadowObservations,
      // firstRead 已完整（前面 gate 过 incomplete/CPU）；无可成交订单时
      // book/盈余输入仍需转交 observe 投影（EMA 低温市场持续跟踪）。
      firstBookBestPrices: firstRead.bookBestPrices,
      firstLaneSurplus: laneSurplusInputsFromRead(firstRead),
      rawOrderCount: firstRead.rawOrderCount,
      eligibleOrderCount: firstRead.eligibleOrderCount,
      distinctOrderRoomCount: firstRead.distinctOrderRoomCount,
      transactionCostEvaluationBudget:
        firstRead.transactionCostEvaluationBudget,
      shadowPlannerMode: firstRead.shadowPlannerMode,
      shadowPlannerInvocationCount: firstRead.shadowPlannerInvocationCount,
      actualTransactionEnergyEvaluations:
        firstRead.actualTransactionEnergyEvaluations,
      evaluatedShadowResourceCount:
        firstRead.evaluatedShadowResourceCount,
      candidateIdentityOrderChecks:
        firstRead.candidateIdentityOrderChecks,
      cpuUsed: cpuDelta,
    };
  }
  const secondRead = collectFullRead(
    dependencies,
    shadowCursor,
    cpuStartedAt,
    cpuTraceRecorder,
    2,
  );
  cpuObservation = observeMarketBaseResourcePlanningCpu(
    dependencies,
    cpuStartedAt,
    cpuTraceRecorder,
    2,
    secondRead.complete && Boolean(secondRead.plannerInput),
  );
  cpuDelta = cpuObservation.cpuUsed;
  if (cpuObservation.exceeded) {
    return {
      ...emptyResult(
        cpuDelta,
        "market_base_cpu_ceiling_exceeded",
        firstRead,
      ),
      first,
      secondScopeEvidence: secondRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      secondReadEvidence: secondRead.evidence,
      ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    };
  }
  if (!secondRead.complete || !secondRead.plannerInput) {
    return {
      ...emptyResult(
        cpuDelta,
        secondRead.blocker || "market_base_second_read_incomplete",
        firstRead,
      ),
      first,
      secondScopeEvidence: secondRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      secondReadEvidence: secondRead.evidence,
      ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    };
  }
  if (
    firstRead.scope.scopeEvidence !== secondRead.scope.scopeEvidence ||
    firstRead.scope.currentRosterFingerprint !==
      secondRead.scope.currentRosterFingerprint ||
    firstRead.scope.currentLaneSetFingerprint !==
      secondRead.scope.currentLaneSetFingerprint
  ) {
    return {
      ...emptyResult(
        cpuDelta,
        "market_base_second_read_scope_changed",
        firstRead,
      ),
      first,
      secondScopeEvidence: secondRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      secondReadEvidence: secondRead.evidence,
      ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    };
  }
  if (
    canonicalStableHashV1(firstRead.evidence) !==
      canonicalStableHashV1(secondRead.evidence) ||
    canonicalStableHashV1(firstRead.scope.outgoingWindow ?? null) !==
      canonicalStableHashV1(secondRead.scope.outgoingWindow ?? null)
  ) {
    return {
      ...emptyResult(
        cpuDelta,
        "market_base_second_read_changed",
        firstRead,
      ),
      first,
      secondScopeEvidence: secondRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      secondReadEvidence: secondRead.evidence,
      ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    };
  }
  cpuObservation = observeMarketBaseResourcePlanningCpu(
    dependencies,
    cpuStartedAt,
    cpuTraceRecorder,
    2,
  );
  cpuDelta = cpuObservation.cpuUsed;
  if (cpuObservation.exceeded) {
    return {
      ...emptyResult(
        cpuDelta,
        "market_base_cpu_ceiling_exceeded",
        firstRead,
      ),
      first,
      secondScopeEvidence: secondRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      secondReadEvidence: secondRead.evidence,
      ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    };
  }
  const second = planMarketDirectContinuous(secondRead.plannerInput);
  cpuObservation = observeMarketBaseResourcePlanningCpu(
    dependencies,
    cpuStartedAt,
    cpuTraceRecorder,
    2,
  );
  cpuDelta = cpuObservation.cpuUsed;
  if (cpuObservation.exceeded) {
    return {
      ...emptyResult(
        cpuDelta,
        "market_base_cpu_ceiling_exceeded",
        firstRead,
      ),
      first,
      second,
      secondScopeEvidence: secondRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      secondReadEvidence: secondRead.evidence,
      ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    };
  }
  if (!isExactMarketDirectContinuousSecondRead(first, second)) {
    return {
      ...emptyResult(cpuDelta, "market_base_second_read_changed", firstRead),
      first,
      second,
      secondScopeEvidence: secondRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      secondReadEvidence: secondRead.evidence,
      ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    };
  }
  if (!second.selected) {
    return {
      ...emptyResult(
        cpuDelta,
        "market_base_second_read_no_selection",
        firstRead,
      ),
      first,
      second,
      secondScopeEvidence: secondRead.scope.scopeEvidence,
      firstReadEvidence: firstRead.evidence,
      secondReadEvidence: secondRead.evidence,
      ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    };
  }
  return {
    complete: true,
    first,
    second,
    selected: second.selected,
    firstScopeEvidence: firstRead.scope.scopeEvidence,
    secondScopeEvidence: secondRead.scope.scopeEvidence,
    firstRosterFingerprint: firstRead.scope.currentRosterFingerprint,
    secondRosterFingerprint: secondRead.scope.currentRosterFingerprint,
    firstLaneSetFingerprint: firstRead.scope.currentLaneSetFingerprint,
    secondLaneSetFingerprint: secondRead.scope.currentLaneSetFingerprint,
    firstReadEvidence: firstRead.evidence,
    secondReadEvidence: secondRead.evidence,
    firstOutgoingWindow: firstRead.scope.outgoingWindow,
    secondOutgoingWindow: secondRead.scope.outgoingWindow,
    secondCredits: secondRead.scope.writeContext.credits,
    selectedTerminalRead:
      secondRead.terminalReads?.[
        runtimeCandidateKey(
          second.selected.roomName,
          second.selected.resourceType,
        )
      ],
    nextPricingRatchet: secondRead.scope.pricingRatchet,
    firstBookBestPrices: firstRead.bookBestPrices,
    firstLaneSurplus: laneSurplusInputsFromRead(firstRead),
    sampledShadowLaneIds: firstRead.sampledShadowLaneIds,
    nextShadowCursor: firstRead.nextShadowCursor,
    shadowObservations: firstRead.shadowObservations,
    rawOrderCount: firstRead.rawOrderCount,
    eligibleOrderCount: firstRead.eligibleOrderCount,
    distinctOrderRoomCount: firstRead.distinctOrderRoomCount,
    transactionCostEvaluationBudget: firstRead.transactionCostEvaluationBudget,
    ...combinedTwoReadPlanningTelemetry(firstRead, secondRead),
    cpuUsed: cpuDelta,
  };
}

const MARKET_BASE_RESOURCE_ACTOR = "marketSaleAutomation:base-resource-v3";
const MAX_OUTGOING_TRANSACTIONS = 100;

/**
 * 从 full-read 的 scope snapshot 提取每 lane 保护后总盈余（包括 storage，
 * 不受 terminal 当前装载量影响），供动态底价聚合到资源级。
 */
function laneSurplusInputsFromRead(
  read: FullReadResult,
): MarketBaseDynamicFloorSurplusLane[] {
  const inputs: MarketBaseDynamicFloorSurplusLane[] = [];
  for (const entry of read.scope.entries) {
    for (const lane of entry.lanes) {
      const sellable = lane.inventorySurplus ?? lane.protection?.sellableAmount;
      const rollingMax = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[
        entry.policy.resourceType as MarketBaseResource
      ]?.inventoryReferenceAmount;
      if (
        typeof sellable === "number" &&
        Number.isFinite(sellable) &&
        sellable >= 0 &&
        typeof rollingMax === "number" &&
        Number.isFinite(rollingMax) &&
        rollingMax > 0
      ) {
        inputs.push({
          resource: entry.policy.resourceType as MarketBaseResource,
          sellable,
          rollingMax,
        });
      }
    }
  }
  return inputs;
}

function convertLiveOrder(order: Order): MarketOrderSnapshot {  return {
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
): MarketBaseResourceOutgoingTransaction {
  return {
    transactionId: transaction.transactionId,
    time: transaction.time,
    amount: transaction.amount,
    resourceType: transaction.resourceType as ResourceConstant,
    from: transaction.from,
    to: transaction.to,
    ...(transaction.order
      ? {
          order: {
            id: transaction.order.id,
            type: transaction.order.type === ORDER_BUY ? ORDER_BUY : ORDER_SELL,
            price: transaction.order.price,
          },
        }
      : {}),
  };
}

function readLiveOutgoingWindow(
  attemptAt: number,
): MarketBaseResourceOutgoingWindow | undefined {
  const raw = Game.market?.outgoingTransactions;
  if (!Array.isArray(raw)) return undefined;
  const transactions = raw.map(convertOutgoingTransaction);
  const oldestTime =
    transactions.length > 0
      ? Math.min(...transactions.map((transaction) => transaction.time))
      : undefined;
  const newestTime =
    transactions.length > 0
      ? Math.max(...transactions.map((transaction) => transaction.time))
      : undefined;
  return {
    observedAt: Game.time,
    coversAttemptAt:
      transactions.length < MAX_OUTGOING_TRANSACTIONS ||
      (oldestTime !== undefined && oldestTime < attemptAt),
    ...(oldestTime === undefined ? {} : { oldestTime }),
    ...(newestTime === undefined ? {} : { newestTime }),
    transactions,
  };
}

function liveArbiterSnapshot(
  roomNames: readonly string[],
): MarketBaseResourceArbiterSnapshot {
  const accountClaim = getMarketAccountClaim();
  const terminalClaims = [...roomNames]
    .sort(stableCompare)
    .map((roomName) => getTerminalActionClaim(roomName))
    .filter((claim): claim is NonNullable<typeof claim> => claim !== undefined);
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
      domain: "market-base-resource:arbiter-v1",
      accountClaim: accountClaim || null,
      journal,
      productionIntent,
      terminalClaims,
      tick: Game.time,
    }),
  };
}

export const defaultMarketBaseResourceRuntimeDependencies: MarketBaseResourceRuntimeDependencies =
  {
    readCurrentBuyOrders: (resource) => {
      const orders = Game.market.getAllOrders({
        type: ORDER_BUY,
        resourceType: resource as MarketResourceConstant,
      });
      if (!Array.isArray(orders)) {
        throw new TypeError("market base resource BUY book unavailable");
      }
      return orders.map(convertLiveOrder);
    },
    readOwnOrders: () => {
      const orders = Game.market?.orders;
      if (!orders || typeof orders !== "object") {
        throw new TypeError("market base resource own orders unavailable");
      }
      return Object.values(orders).map(convertLiveOrder);
    },
    readTerminal: readLiveMarketBaseTerminal,
    readCredits: () => {
      const credits = Game.market?.credits;
      return typeof credits === "number" &&
        Number.isFinite(credits) &&
        credits >= 0
        ? credits
        : undefined;
    },
    readAccountIdentity: readLiveMarketBaseAccountIdentity,
    readExecutorShard: () => Game.shard?.name,
    readArbiterSnapshot: liveArbiterSnapshot,
    readOutgoingWindow: readLiveOutgoingWindow,
    readTrustedFloors: () => {
      const marketData = isPlainRecord(Memory.data?.marketSaleAutomation)
        ? Memory.data?.marketSaleAutomation
        : undefined;
      const raw = isPlainRecord(marketData)
        ? marketData.trustedFloors
        : undefined;
      if (!isPlainRecord(raw)) return undefined;
      const result: Partial<
        Record<
          MarketBaseResourceTrustedFloorResource,
          MarketBaseResourceTrustedFloorObservation
        >
      > = {};
      for (const resource of [
        ...MARKET_BASE_RESOURCE_CATALOG,
        RESOURCE_ENERGY,
      ] as const) {
        const entry = raw[resource];
        if (!isPlainRecord(entry)) {
          return undefined;
        }
        result[resource] = {
          value: entry.value as number,
          marketDate: entry.marketDate as string,
          updatedAt: entry.updatedAt as number,
        };
      }
      return result;
    },
    calculateTransactionEnergy: (amount, fromRoomName, toRoomName) =>
      Game.market.calcTransactionCost(amount, fromRoomName, toRoomName),
    cpuUsed: () => {
      const getUsed = Game.cpu?.getUsed;
      return typeof getUsed === "function"
        ? getUsed.call(Game.cpu)
        : Number.NaN;
    },
    // 只有 outer dispatcher 持有已验证的双份 activation anchor。直接调用
    // inner runtime 时没有该能力，必须 fail closed。
    readLedgerRuntimeAnchor: () => undefined,
    // 只有 outer dispatcher 能同时持久化 nested state 与 activation
    // anchor；直接调用 runtime 默认 fail closed。
    commitPreparedState: () => false,
    validatePreparedCanonicalRoot: () => false,
    claimPrepared: claimPreparedDirectMarketClaims,
    executePrepared: executePreparedDirectMarketDeal,
    releasePrepared: releasePreparedDirectMarketClaims,
  };

function currentV3Permit(
  chain: MarketBaseResourcePermitChainState,
): MarketBaseResourcePermit | undefined {
  const current = chain.retainedPermits[chain.retainedPermits.length - 1];
  return current?.schemaVersion === 3 ? current : undefined;
}

interface MarketBaseResourceRuntimeSession {
  ledgerContext: MarketBaseResourceLedgerRuntimeContext;
  permitContext: MarketBaseResourcePermitRuntimeContext;
  /**
   * 首次 runtime gate 实际认证的 outer permit 对象。canonical root 注册后
   * 会把该 exact object 递归冻结并写入私有 provenance；同 tick 后续 gate
   * 因而只需 identity + provenance，不再重哈 current permit/grants。
   */
  permitSource: MarketBaseResourcePermitChainState;
  ledgerRuntimeAnchor: MarketBaseResourceLedgerRuntimeAnchor;
  scopeContext?: {
    source: MarketBaseResourceScopeState;
    snapshot: MarketBaseResourceScopeState;
    commitment: string;
  };
  safetyContext: {
    schemaVersion: number;
    catalog: MarketBaseResourceV3RuntimeState["catalog"];
    cutoverLatched: boolean | undefined;
    blocker: string | undefined;
    hardBlocker: MarketBaseResourceV3RuntimeState["hardBlocker"];
    pricingRatchet: MarketBaseResourceV3RuntimeState["pricingRatchet"];
    invariantCommitment: string;
    pricingRatchetCommitment: string;
  };
}

interface MarketBaseResourceReadinessRuntimeCapabilityState {
  readonly tick: number;
  readonly state: MarketBaseResourceV3RuntimeState;
  readonly session: MarketBaseResourceRuntimeSession;
}

const marketBaseResourceReadinessRuntimeCapabilities = new WeakMap<
  object,
  MarketBaseResourceReadinessRuntimeCapabilityState
>();

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

interface MarketBaseResourceCanonicalReadinessRuntimeCache {
  readonly tick: number;
  readonly marketMode: "direct";
  readonly marketSaleRoot: Record<string, unknown>;
  readonly directAutomation: Record<string, unknown>;
  readonly state: MarketBaseResourceV3RuntimeState;
  readonly scope: MarketBaseResourceScopeState;
  readonly permitChain: MarketBaseResourcePermitChainState;
  readonly ledger: MarketBaseResourceLedger;
  readonly readinessAuthorization?: MarketBaseResourceReadinessAuthorization;
  readonly activationAnchor: Record<string, unknown>;
  readonly activationAnchorMirror: Record<string, unknown>;
  readonly activationAnchorHash: string;
  readonly trustedFloors: Record<string, unknown>;
  readonly runtimeSession: MarketBaseResourceRuntimeSession;
  readonly read: MarketBaseResourceCanonicalReadinessRead;
}

const marketBaseResourceCanonicalReadinessRuntimeCache = new WeakMap<
  object,
  MarketBaseResourceCanonicalReadinessRuntimeCache
>();

type MarketBaseResourceRuntimeSessionResult =
  | {
      ok: true;
      session: MarketBaseResourceRuntimeSession;
    }
  | {
      ok: false;
      reason: string;
    };

const marketBaseResourceRuntimeDeepFrozenValues = new WeakSet<object>();

function freezeMarketBaseResourceRuntimeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const object = value as object;
    if (marketBaseResourceRuntimeDeepFrozenValues.has(object)) {
      return value;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeMarketBaseResourceRuntimeSnapshot(nested);
    }
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
    marketBaseResourceRuntimeDeepFrozenValues.add(object);
  }
  return value;
}

function marketBaseResourceRuntimeScopeProjection(
  scope: MarketBaseResourceScopeState,
): MarketBaseResourceScopeState {
  return {
    schemaVersion: scope.schemaVersion,
    accountIdentity: scope.accountIdentity,
    sharedPolicyFingerprint: scope.sharedPolicyFingerprint,
    roomRegistry: scope.roomRegistry,
    sellerRooms: scope.sellerRooms,
    laneLifecycles: scope.laneLifecycles,
    recentLaneTombstones: scope.recentLaneTombstones,
    laneTombstoneDischargeCheckpoint: scope.laneTombstoneDischargeCheckpoint,
    rosterFingerprint: scope.rosterFingerprint,
    laneSetFingerprint: scope.laneSetFingerprint,
    updatedAt: scope.updatedAt,
    ...(scope.shadowCursor === undefined
      ? {}
      : { shadowCursor: scope.shadowCursor }),
  };
}

function createMarketBaseResourceRuntimeScopeContext(
  scope: MarketBaseResourceScopeState,
  trustExactSource = false,
): NonNullable<MarketBaseResourceRuntimeSession["scopeContext"]> {
  const projection = marketBaseResourceRuntimeScopeProjection(scope);
  const snapshot = trustExactSource
    ? freezeMarketBaseResourceRuntimeSnapshot(scope)
    : freezeMarketBaseResourceRuntimeSnapshot(
        JSON.parse(JSON.stringify(projection)) as MarketBaseResourceScopeState,
      );
  const commitment = marketBaseResourceRuntimeScopeCommitment(snapshot);
  if (marketBaseResourceRuntimeDeepFrozenValues.has(snapshot)) {
    marketBaseResourceRuntimeScopeCommitmentCache.set(snapshot, commitment);
  }
  return {
    source: scope,
    snapshot,
    commitment,
  };
}

const marketBaseResourceRuntimeScopeCommitmentCache = new WeakMap<
  object,
  string
>();

interface MarketBaseResourceExactScopeCommitmentCacheEntry {
  readonly scope: MarketBaseResourceScopeState;
  readonly commitment: string;
}

const MARKET_BASE_RESOURCE_EXACT_SCOPE_COMMITMENT_CACHE_LIMIT = 8;
const marketBaseResourceExactScopeCommitmentCache = new Map<
  string,
  readonly MarketBaseResourceExactScopeCommitmentCacheEntry[]
>();

function marketBaseResourceExactStructuralEqualUnchecked(
  left: unknown,
  right: unknown,
  activeRight: WeakSet<object>,
): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  const leftObject = left as object;
  const rightObject = right as object;
  if (activeRight.has(rightObject)) return false;
  activeRight.add(rightObject);
  try {
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (
          !marketBaseResourceExactStructuralEqualUnchecked(
            left[index],
            right[index],
            activeRight,
          )
        ) {
          return false;
        }
      }
      return true;
    }
    const leftPrototype = Object.getPrototypeOf(leftObject);
    const rightPrototype = Object.getPrototypeOf(rightObject);
    if (
      (leftPrototype !== Object.prototype && leftPrototype !== null) ||
      (rightPrototype !== Object.prototype && rightPrototype !== null)
    ) {
      return false;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length) return false;
    for (const key of leftKeys) {
      if (
        !Object.prototype.hasOwnProperty.call(rightRecord, key) ||
        !marketBaseResourceExactStructuralEqualUnchecked(
          leftRecord[key],
          rightRecord[key],
          activeRight,
        )
      ) {
        return false;
      }
    }
    return true;
  } finally {
    activeRight.delete(rightObject);
  }
}

function marketBaseResourceExactStructuralEqual(
  left: unknown,
  right: unknown,
): boolean {
  // cache 里的 left 都来自通过语义认证并递归冻结的 canonical scope。
  // 单个 active-right WeakSet 同时拒绝候选环并完成逐字段比较，避免旧实现
  // 为每个嵌套对象创建 WeakSet 后在紧随的 hot automation 中触发 GC。
  return marketBaseResourceExactStructuralEqualUnchecked(
    left,
    right,
    new WeakSet<object>(),
  );
}

function readMarketBaseResourceExactScopeCommitmentCache(
  scope: MarketBaseResourceScopeState,
  outerCommitment: string,
): string | undefined {
  const entries = marketBaseResourceExactScopeCommitmentCache.get(
    outerCommitment,
  );
  const matched = entries?.find((entry) =>
    marketBaseResourceExactStructuralEqual(entry.scope, scope),
  );
  if (!matched) return undefined;
  // LRU 更新只移动有界 bucket，不改变认证语义。
  marketBaseResourceExactScopeCommitmentCache.delete(outerCommitment);
  marketBaseResourceExactScopeCommitmentCache.set(outerCommitment, entries!);
  return matched.commitment;
}

function rememberMarketBaseResourceExactScopeCommitment(
  scope: MarketBaseResourceScopeState,
  outerCommitment: string,
  commitment: string,
): void {
  const previous =
    marketBaseResourceExactScopeCommitmentCache.get(outerCommitment) ?? [];
  const entries = [
    { scope, commitment },
    ...previous.filter(
      (entry) =>
        !marketBaseResourceExactStructuralEqual(entry.scope, scope),
    ),
  ].slice(0, 2);
  marketBaseResourceExactScopeCommitmentCache.delete(outerCommitment);
  while (
    marketBaseResourceExactScopeCommitmentCache.size >=
    MARKET_BASE_RESOURCE_EXACT_SCOPE_COMMITMENT_CACHE_LIMIT
  ) {
    const oldest = marketBaseResourceExactScopeCommitmentCache.keys().next()
      .value as string | undefined;
    if (oldest === undefined) break;
    marketBaseResourceExactScopeCommitmentCache.delete(oldest);
  }
  marketBaseResourceExactScopeCommitmentCache.set(outerCommitment, entries);
}

function marketBaseResourceRuntimeScopeCommitmentProjection(
  scope: MarketBaseResourceScopeState,
): unknown {
  // Inner session 是紧邻 claim/deal 的 exact replacement 门禁；这里承诺
  // 整棵 canonical scope（含完整 registry rooms/tombstones/checkpoint 与完整
  // discharge payload），不能只依赖 payload 内自报的 checkpoint digest。
  return marketBaseResourceRuntimeScopeProjection(scope);
}

export function marketBaseResourceRuntimeScopeCommitment(
  scope: MarketBaseResourceScopeState,
): string {
  if (marketBaseResourceRuntimeDeepFrozenValues.has(scope)) {
    const cached = marketBaseResourceRuntimeScopeCommitmentCache.get(scope);
    if (cached) return cached;
  }
  let outerCommitment: string | undefined;
  try {
    outerCommitment = marketBaseResourceOuterScopeCommitment(scope);
  } catch {
    outerCommitment = undefined;
  }
  if (outerCommitment !== undefined) {
    const cached = readMarketBaseResourceExactScopeCommitmentCache(
      scope,
      outerCommitment,
    );
    if (cached !== undefined) {
      if (marketBaseResourceRuntimeDeepFrozenValues.has(scope)) {
        marketBaseResourceRuntimeScopeCommitmentCache.set(scope, cached);
      }
      return cached;
    }
  }
  const commitment = canonicalStableHashV1({
    domain: "market-base-resource:runtime-scope-context-v1",
    scope: marketBaseResourceRuntimeScopeCommitmentProjection(scope),
  });
  if (marketBaseResourceRuntimeDeepFrozenValues.has(scope)) {
    marketBaseResourceRuntimeScopeCommitmentCache.set(scope, commitment);
    if (outerCommitment !== undefined) {
      rememberMarketBaseResourceExactScopeCommitment(
        scope,
        outerCommitment,
        commitment,
      );
    }
  }
  return commitment;
}

const marketBaseResourceOuterScopeCommitmentCache = new WeakMap<
  object,
  string
>();

/**
 * Activation outer 专用紧凑承诺。它只能与 outer 的 room incarnation / lane
 * lifecycle high-water 逐项门禁联合使用；inner runtime session 必须继续使用
 * marketBaseResourceRuntimeScopeCommitment 的 full exact snapshot。
 */
export function marketBaseResourceOuterScopeCommitment(
  scope: MarketBaseResourceScopeState,
): string {
  if (marketBaseResourceRuntimeDeepFrozenValues.has(scope)) {
    const cached = marketBaseResourceOuterScopeCommitmentCache.get(scope);
    if (cached) return cached;
  }
  const commitment = canonicalStableHashV1({
    domain: "market-base-resource:outer-scope-context-v1",
    scope: {
      schemaVersion: scope.schemaVersion,
      accountIdentity: scope.accountIdentity,
      sharedPolicyFingerprint: scope.sharedPolicyFingerprint,
      roomRegistryCheckpointCommitment:
        scope.roomRegistry.checkpointCommitment,
      recentLaneTombstones: scope.recentLaneTombstones,
      laneTombstoneDischargeCheckpointCommitment:
        scope.laneTombstoneDischargeCheckpoint.checkpointCommitment,
      rosterFingerprint: scope.rosterFingerprint,
      laneSetFingerprint: scope.laneSetFingerprint,
    },
  });
  if (marketBaseResourceRuntimeDeepFrozenValues.has(scope)) {
    marketBaseResourceOuterScopeCommitmentCache.set(scope, commitment);
  }
  return commitment;
}

/**
 * 冷 JSON/Memory root 的有界 scope 认证。room registry 自己的 checkpoint
 * 只承诺 registry；这里再证明 sellerRooms 正是 registry 的 admitted current，
 * 并重算 room/lane identity、roster 与 lane-set，防止单边回拨 terminalId 后
 * 沿用旧 incarnation/continuous grant。热路径的 exact frozen object 不重复跑。
 */
export function validateMarketBaseResourceRuntimeScopeConsistency(
  value: unknown,
  tick: number,
): string | undefined {
  try {
    if (!isPlainRecord(value)) {
      return "market_base_runtime_scope_shape_invalid";
    }
    if (
      value.schemaVersion !== 1 ||
      typeof value.accountIdentity !== "string" ||
      value.accountIdentity.length === 0 ||
      value.accountIdentity.length > 128 ||
      typeof value.sharedPolicyFingerprint !== "string" ||
      !isPlainRecord(value.roomRegistry) ||
      !Array.isArray(value.sellerRooms) ||
      value.sellerRooms.length > MARKET_BASE_RESOURCE_MAX_ROOMS ||
      !Array.isArray(value.laneLifecycles) ||
      value.laneLifecycles.length > MARKET_BASE_RESOURCE_MAX_LANES ||
      !Array.isArray(value.recentLaneTombstones) ||
      value.recentLaneTombstones.length >
        MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES ||
      !isPlainRecord(value.laneTombstoneDischargeCheckpoint) ||
      typeof value.rosterFingerprint !== "string" ||
      typeof value.laneSetFingerprint !== "string" ||
      !Number.isSafeInteger(value.updatedAt) ||
      (value.updatedAt as number) < 0 ||
      (value.updatedAt as number) > tick ||
      (value.shadowCursor !== undefined &&
        (typeof value.shadowCursor !== "string" ||
          value.shadowCursor.length === 0 ||
          value.shadowCursor.length > 256))
    ) {
      return "market_base_runtime_scope_shape_invalid";
    }
    const scope = value as unknown as MarketBaseResourceScopeState;
    const sharedPolicy = createMarketBaseSharedPolicy(scope.accountIdentity);
    if (scope.sharedPolicyFingerprint !== sharedPolicy.fingerprint) {
      return "market_base_runtime_scope_shared_policy_mismatch";
    }
    if (
      !Number.isSafeInteger(scope.roomRegistry.lastReconciledTick) ||
      scope.roomRegistry.lastReconciledTick < 0 ||
      scope.roomRegistry.lastReconciledTick > scope.updatedAt ||
      !validScopeLaneTombstoneCheckpoint(scope.laneTombstoneDischargeCheckpoint)
    ) {
      return "market_base_runtime_scope_checkpoint_invalid";
    }
    const tombstoneError = validateScopeLaneTombstones(
      scope.recentLaneTombstones,
      scope.updatedAt,
    );
    if (tombstoneError) return tombstoneError;
    if (scope.sellerRooms.some((room) => !isPlainRecord(room))) {
      return "market_base_runtime_scope_seller_invalid";
    }
    const admissionPolicy = createMarketBaseRoomAdmissionPolicy(
      scope.accountIdentity,
    );
    const roomValidation = reconcileMarketBaseSellerRooms({
      tick: scope.roomRegistry.lastReconciledTick,
      admissionPolicy,
      observations: scope.sellerRooms.map((room) => ({
        roomName: room.roomName,
        visible: true,
        controllerMy: true,
        controllerOwner: room.controllerOwner,
        terminalId: room.terminalId,
        terminalOwned: true,
        roomClass: room.roomClass,
      })),
      previous: scope.roomRegistry,
      expectedPreviousCheckpointCommitment:
        scope.roomRegistry.checkpointCommitment,
    });
    if ("blockers" in roomValidation) {
      return (
        roomValidation.blockers[0] ||
        "market_base_runtime_scope_room_registry_invalid"
      );
    }
    const canonicalSellerRooms = [...roomValidation.sellerRooms].sort(
      (left, right) => left.roomName.localeCompare(right.roomName),
    );
    const persistedSellerRooms = [...scope.sellerRooms].sort((left, right) =>
      left.roomName.localeCompare(right.roomName),
    );
    const sameSellerRoom = (
      left: MarketBaseSellerRoomState,
      right: MarketBaseSellerRoomState,
    ): boolean =>
      left.roomInstanceId === right.roomInstanceId &&
      left.roomName === right.roomName &&
      left.incarnation === right.incarnation &&
      left.previousInstanceId === right.previousInstanceId &&
      left.roomClass === right.roomClass &&
      left.controllerOwner === right.controllerOwner &&
      left.terminalId === right.terminalId &&
      left.admissionRevision === right.admissionRevision &&
      left.status === right.status &&
      left.fingerprint === right.fingerprint;
    if (
      canonicalSellerRooms.length !== persistedSellerRooms.length ||
      canonicalSellerRooms.some(
        (room, index) => !sameSellerRoom(room, persistedSellerRooms[index]),
      ) ||
      scope.rosterFingerprint !== currentRosterFingerprint(scope.sellerRooms)
    ) {
      return "market_base_runtime_scope_seller_registry_mismatch";
    }
    const roomByInstanceId = new Map(
      canonicalSellerRooms.map((room) => [room.roomInstanceId, room]),
    );
    const laneIds = new Set<string>();
    const laneTuples = new Set<string>();
    for (const lane of scope.laneLifecycles) {
      const lifecycleError = validateMarketBaseDerivedLaneLifecycle(lane);
      if (lifecycleError) return lifecycleError;
      const room = roomByInstanceId.get(lane.roomInstanceId);
      const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[lane.resource];
      const tuple = `${lane.roomInstanceId}:${lane.resource}`;
      if (
        lane.status === "tombstoned" ||
        laneIds.has(lane.laneId) ||
        laneTuples.has(tuple) ||
        !room ||
        lane.resourcePolicyId !== policy.policyId ||
        lane.resourcePolicyFingerprint !== policy.fingerprint ||
        lane.sellerRoomName !== room.roomName ||
        lane.roomFingerprint !== room.fingerprint ||
        lane.sharedPolicyFingerprint !== scope.sharedPolicyFingerprint
      ) {
        return "market_base_runtime_scope_lane_invalid";
      }
      laneIds.add(lane.laneId);
      laneTuples.add(tuple);
    }
    if (
      scope.laneLifecycles.length !==
        canonicalSellerRooms.length * MARKET_BASE_RESOURCE_CATALOG.length ||
      scope.laneSetFingerprint !==
        marketBaseDerivedLaneSetFingerprint(scope.laneLifecycles)
    ) {
      return "market_base_runtime_scope_lane_set_mismatch";
    }
    const activeLaneIds = new Set(
      scope.laneLifecycles.map((lane) => lane.laneId),
    );
    if (
      scope.recentLaneTombstones.some((lane) => activeLaneIds.has(lane.laneId))
    ) {
      return "market_base_runtime_scope_lane_tombstone_overlap";
    }
    return undefined;
  } catch {
    return "market_base_runtime_scope_shape_invalid";
  }
}

function trustMarketBaseResourceRuntimeSessionExactSources(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
): void {
  freezeMarketBaseResourceRuntimeSnapshot(session.permitSource);
  freezeMarketBaseResourceRuntimeSnapshot(state.catalog);
  if (state.hardBlocker) {
    freezeMarketBaseResourceRuntimeSnapshot(state.hardBlocker);
  }
  if (state.pricingRatchet) {
    freezeMarketBaseResourceRuntimeSnapshot(state.pricingRatchet);
  }
  if (state.scope && session.scopeContext?.source === state.scope) {
    freezeMarketBaseResourceRuntimeSnapshot(state.scope);
    session.scopeContext = {
      ...session.scopeContext,
      snapshot: state.scope,
    };
  }
}

function marketBaseResourceRuntimeInvariantCommitment(
  state: MarketBaseResourceV3RuntimeState,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:runtime-invariants-v1",
    schemaVersion: state.schemaVersion,
    catalog: state.catalog,
    cutoverLatched: state.cutoverLatched,
    blocker: state.blocker ?? null,
    hardBlocker: state.hardBlocker ?? null,
  });
}

function marketBaseResourceRuntimePricingRatchetCommitment(
  state: MarketBaseResourceV3RuntimeState,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:runtime-pricing-ratchet-v1",
    pricingRatchet: state.pricingRatchet ?? null,
  });
}

function marketBaseResourceRuntimeSnapshotMismatch(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
): string | undefined {
  const trustedInvariantIdentity =
    state.schemaVersion === session.safetyContext.schemaVersion &&
    state.catalog === session.safetyContext.catalog &&
    state.cutoverLatched === session.safetyContext.cutoverLatched &&
    state.blocker === session.safetyContext.blocker &&
    state.hardBlocker === session.safetyContext.hardBlocker &&
    marketBaseResourceRuntimeDeepFrozenValues.has(state.catalog) &&
    (state.hardBlocker === undefined ||
      marketBaseResourceRuntimeDeepFrozenValues.has(state.hardBlocker));
  if (
    !trustedInvariantIdentity &&
    marketBaseResourceRuntimeInvariantCommitment(state) !==
      session.safetyContext.invariantCommitment
  ) {
    return "market_base_v3_runtime_invariant_snapshot_mismatch";
  }
  const trustedPricingRatchetIdentity =
    state.pricingRatchet === session.safetyContext.pricingRatchet &&
    (state.pricingRatchet === undefined ||
      marketBaseResourceRuntimeDeepFrozenValues.has(state.pricingRatchet));
  if (
    !trustedPricingRatchetIdentity &&
    marketBaseResourceRuntimePricingRatchetCommitment(state) !==
      session.safetyContext.pricingRatchetCommitment
  ) {
    return "market_base_v3_runtime_pricing_ratchet_snapshot_mismatch";
  }
  if (
    session.scopeContext &&
    (!state.scope ||
      ((state.scope !== session.scopeContext.source ||
        !marketBaseResourceRuntimeDeepFrozenValues.has(state.scope)) &&
        marketBaseResourceRuntimeScopeCommitment(state.scope) !==
          session.scopeContext.commitment))
  ) {
    return "market_base_v3_runtime_scope_snapshot_mismatch";
  }
  if (
    !state.permitChain ||
    ((state.permitChain !== session.permitSource ||
      !marketBaseResourceRuntimeDeepFrozenValues.has(state.permitChain)) &&
      !validateMarketBaseResourcePermitRuntimeGate(
        state.permitChain,
        session.permitContext.anchor,
      ).ok)
  ) {
    return "market_base_v3_runtime_permit_snapshot_mismatch";
  }
  if (!state.ledger || state.ledger !== session.ledgerContext.state) {
    return "market_base_v3_runtime_ledger_snapshot_mismatch";
  }
  return undefined;
}

function issueMarketBaseResourceReadinessRuntimeCapability(
  state: MarketBaseResourceV3RuntimeState,
  session: MarketBaseResourceRuntimeSession,
  tick: number,
): MarketBaseResourceReadinessRuntimeCapability | undefined {
  if (
    !Number.isSafeInteger(tick) ||
    tick < 0 ||
    session.ledgerContext.tick !== tick ||
    session.permitContext.tick !== tick ||
    marketBaseResourceRuntimeSnapshotMismatch(state, session)
  ) {
    return undefined;
  }
  const capability = Object.freeze({});
  marketBaseResourceReadinessRuntimeCapabilities.set(capability, {
    tick,
    state,
    session,
  });
  return capability as MarketBaseResourceReadinessRuntimeCapability;
}

/**
 * outer 在只替换 scope/readiness/canonical root、但 Ledger/Permit 未变化时，
 * 用原 opaque session 铸造 successor capability。JSON/Memory 对象本身
 * 无法调用成功，因为 capability 必须存在于模块私有 WeakMap。
 */
function advanceMarketBaseResourceReadinessRuntimeCapabilityInternal(
  capability: MarketBaseResourceReadinessRuntimeCapability | undefined,
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  authenticatedStableScopeReplacement: boolean,
): MarketBaseResourceReadinessRuntimeCapability | undefined {
  if (!capability || typeof capability !== "object") return undefined;
  const current = marketBaseResourceReadinessRuntimeCapabilities.get(
    capability as object,
  );
  const scopeAlreadyTrusted = Boolean(
    current &&
    state.scope === current.session.scopeContext?.source &&
    marketBaseResourceRuntimeDeepFrozenValues.has(state.scope),
  );
  if (
    !current ||
    current.tick !== tick ||
    current.session.ledgerContext.tick !== tick ||
    current.session.permitContext.tick !== tick ||
    state.ledger !== current.session.ledgerContext.state ||
    !state.permitChain ||
    !state.scope ||
    marketBaseResourceRuntimeSnapshotMismatch(state, {
      ...current.session,
      scopeContext: undefined,
    }) ||
    (!scopeAlreadyTrusted &&
      !authenticatedStableScopeReplacement &&
      validateMarketBaseResourceRuntimeScopeConsistency(state.scope, tick) !==
        undefined)
  ) {
    return undefined;
  }
  const successorSession: MarketBaseResourceRuntimeSession = {
    ...current.session,
    scopeContext:
      state.scope === current.session.scopeContext?.source &&
      marketBaseResourceRuntimeDeepFrozenValues.has(state.scope)
        ? current.session.scopeContext
        : createMarketBaseResourceRuntimeScopeContext(state.scope, true),
  };
  return issueMarketBaseResourceReadinessRuntimeCapability(
    state,
    successorSession,
    tick,
  );
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

export function createMarketBaseResourceReadinessRuntimeCapability(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  ledgerRuntimeAnchor: MarketBaseResourceLedgerRuntimeAnchor,
  authenticatedExactScopeCommitment?: string,
): MarketBaseResourceReadinessRuntimeCapability | undefined {
  const opened = openMarketBaseResourceRuntimeSession(
    state,
    tick,
    defaultMarketBaseResourceRuntimeDependencies,
    ledgerRuntimeAnchor,
    authenticatedExactScopeCommitment,
  );
  if (opened.ok) {
    trustMarketBaseResourceRuntimeSessionExactSources(state, opened.session);
  }
  return opened.ok
    ? issueMarketBaseResourceReadinessRuntimeCapability(
        state,
        opened.session,
        tick,
      )
    : undefined;
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

export type MarketBaseResourceReadinessRuntimeResignResult =
  | {
      readonly ok: true;
      readonly capability: MarketBaseResourceReadinessRuntimeCapability;
      readonly readinessAuthorization?: MarketBaseResourceReadinessAuthorization;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export function resignMarketBaseResourceReadinessAuthorizationWithRuntimeCapability(
  capability: MarketBaseResourceReadinessRuntimeCapability | undefined,
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  authenticatedStableScopeReplacement = false,
): MarketBaseResourceReadinessRuntimeResignResult {
  const successor = advanceMarketBaseResourceReadinessRuntimeCapabilityInternal(
    capability,
    state,
    tick,
    authenticatedStableScopeReplacement,
  );
  if (!successor) {
    return {
      ok: false,
      reason: "market_base_readiness_runtime_capability_invalid",
    };
  }
  const registered = marketBaseResourceReadinessRuntimeCapabilities.get(
    successor as object,
  );
  if (!registered || !state.scope) {
    return {
      ok: false,
      reason: "market_base_readiness_runtime_capability_invalid",
    };
  }
  const readiness =
    buildMarketBaseResourceReadinessAuthorizationWithRuntimeContext(
      registered.session.permitContext,
      {
        tick,
        ttl: 1,
        roster: state.scope.sellerRooms.map(marketBaseResourceSellerRoomBasis),
        lanes: state.scope.laneLifecycles,
      },
    );
  if ("reason" in readiness) {
    return readiness.reason === "readiness_no_enabled_v3_grant"
      ? {
          ok: true,
          capability: successor,
        }
      : { ok: false, reason: readiness.reason };
  }
  return {
    ok: true,
    capability: successor,
    readinessAuthorization: readiness.readinessAuthorization,
  };
}

function readCachedMarketBaseResourceCanonicalReadiness(
  marketSaleRoot: Record<string, unknown>,
  marketMode: unknown,
  tick: number,
): MarketBaseResourceCanonicalReadinessRead | undefined {
  const cached =
    marketBaseResourceCanonicalReadinessRuntimeCache.get(marketSaleRoot);
  if (
    !cached ||
    marketMode !== cached.marketMode ||
    tick !== cached.tick ||
    marketSaleRoot.directAutomation !== cached.directAutomation ||
    marketSaleRoot.baseResourceV3ActivationAnchor !== cached.activationAnchor ||
    marketSaleRoot.baseResourceV3ActivationAnchorMirror !==
      cached.activationAnchorMirror ||
    marketSaleRoot.baseResourceV3ActivationBlocker !== undefined ||
    marketSaleRoot.trustedFloors !== cached.trustedFloors ||
    cached.activationAnchor.anchorHash !== cached.activationAnchorHash ||
    cached.activationAnchorMirror.anchorHash !== cached.activationAnchorHash ||
    cached.activationAnchor.activationBlocker !== null ||
    cached.activationAnchorMirror.activationBlocker !== null ||
    cached.directAutomation.baseResourceV3 !== cached.state ||
    cached.state.schemaVersion !== 3 ||
    cached.state.cutoverLatched !== true ||
    cached.state.preflightAt !== tick ||
    cached.state.blocker !== undefined ||
    cached.state.hardBlocker !== undefined ||
    cached.state.scope !== cached.scope ||
    cached.state.permitChain !== cached.permitChain ||
    cached.state.ledger !== cached.ledger ||
    cached.state.readinessAuthorization !== cached.readinessAuthorization ||
    cached.scope.updatedAt !== tick ||
    (cached.readinessAuthorization !== undefined &&
      (cached.readinessAuthorization.updatedAt !== tick ||
        cached.readinessAuthorization.expiresAt !== tick + 1)) ||
    !Object.isFrozen(cached.directAutomation) ||
    !Object.isFrozen(cached.scope) ||
    !Object.isFrozen(cached.permitChain) ||
    !Object.isFrozen(cached.ledger) ||
    (cached.readinessAuthorization !== undefined &&
      !Object.isFrozen(cached.readinessAuthorization)) ||
    !Object.isFrozen(cached.activationAnchor) ||
    !Object.isFrozen(cached.activationAnchorMirror) ||
    !Object.isFrozen(cached.trustedFloors)
  ) {
    return undefined;
  }
  return cached.read;
}

const marketBaseResourceActivationAnchorSelfHashCache = new WeakMap<
  object,
  string
>();

export function marketBaseResourceActivationAnchorSelfHash(
  anchor: Record<string, unknown>,
): string {
  freezeMarketBaseResourceRuntimeSnapshot(anchor);
  const cached = marketBaseResourceActivationAnchorSelfHashCache.get(anchor);
  if (cached !== undefined) return cached;
  const { anchorHash: _anchorHash, ...payload } = anchor;
  const hash = canonicalStableHashV1({
    domain: "market-base-resource:activation-anchor-v1",
    payload,
  });
  marketBaseResourceActivationAnchorSelfHashCache.set(anchor, hash);
  return hash;
}

function marketBaseResourceRuntimeSafetyMatchesActivationAnchor(
  state: MarketBaseResourceV3RuntimeState,
  trustedFloors: Record<string, unknown>,
  activationAnchor: Record<string, unknown>,
  ledgerRuntimeAnchor: MarketBaseResourceLedgerRuntimeAnchor,
): boolean {
  if (!state.pricingRatchet) return false;
  const pricingRatchetHighWater = MARKET_BASE_RESOURCE_CATALOG.map(
    (resource) => {
      const entry = state.pricingRatchet!.entries.find(
        (candidate) => candidate.resource === resource,
      );
      if (
        !entry ||
        !Number.isFinite(entry.value) ||
        entry.value <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.marketDate)
      ) {
        throw new TypeError("market_base_pricing_ratchet_invalid");
      }
      return {
        resource,
        value: entry.value,
        marketDate: entry.marketDate,
      };
    },
  );
  const trustedFloorHighWater = [
    ...MARKET_BASE_RESOURCE_CATALOG,
    RESOURCE_ENERGY,
  ]
    .sort((left, right) => left.localeCompare(right))
    .map((resource) => {
      const entry = trustedFloors[resource];
      if (
        !isPlainRecord(entry) ||
        !Number.isFinite(entry.value) ||
        (entry.value as number) <= 0 ||
        typeof entry.marketDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.marketDate) ||
        !Number.isSafeInteger(entry.updatedAt) ||
        (entry.updatedAt as number) < 0
      ) {
        throw new TypeError("market_base_trusted_floor_invalid");
      }
      return {
        resource,
        value: entry.value as number,
        marketDate: entry.marketDate,
        updatedAt: entry.updatedAt as number,
      };
    });
  if (
    pricingRatchetHighWater.some((pricing) => {
      const trusted = trustedFloorHighWater.find(
        (candidate) => candidate.resource === pricing.resource,
      );
      return (
        !trusted ||
        trusted.value < pricing.value ||
        trusted.marketDate < pricing.marketDate
      );
    })
  ) {
    return false;
  }
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
  return (
    activationAnchor.pricingRatchetInitializedAt ===
      state.pricingRatchet.initializedAt &&
    activationAnchor.pricingRatchetBootstrapFingerprint ===
      state.pricingRatchet.bootstrapFingerprint &&
    activationAnchor.pricingRatchetCommitment === pricingRatchetCommitment &&
    canonicalStableHashV1(activationAnchor.pricingRatchetHighWater) ===
      canonicalStableHashV1(pricingRatchetHighWater) &&
    activationAnchor.trustedFloorsCommitment === trustedFloorsCommitment &&
    canonicalStableHashV1(activationAnchor.trustedFloorHighWater) ===
      canonicalStableHashV1(trustedFloorHighWater) &&
    canonicalStableHashV1(activationAnchor.hardBlocker) ===
      canonicalStableHashV1(hardBlocker) &&
    activationAnchor.runtimeSafetyCommitment ===
      canonicalStableHashV1({
        domain: "market-base-resource:outer-runtime-safety-v1",
        ledger: ledgerRuntimeAnchor,
        pricingRatchetCommitment,
        trustedFloorsCommitment,
        hardBlocker,
      })
  );
}

function marketBaseResourceLegacyV2QuiescenceCommitment(
  directAutomation: Record<string, unknown>,
): string | undefined {
  try {
    const currentPermit = directAutomation.currentPermit;
    const permitChain = directAutomation.permitChain;
    const ledger = directAutomation.ledger;
    const pendingDirectDeals = directAutomation.pendingDirectDeals;
    const quarantinedPendingDirectDeals =
      directAutomation.quarantinedPendingDirectDeals;
    if (
      directAutomation.schemaVersion !== MARKET_DIRECT_CONTINUOUS_SCHEMA ||
      directAutomation.capability !== MARKET_DIRECT_CONTINUOUS_CAPABILITY ||
      directAutomation.migrationStatus !== "active" ||
      directAutomation.migrationBlockedReason !== undefined ||
      directAutomation.proposedPermit !== undefined ||
      !isPlainRecord(currentPermit) ||
      !isPlainRecord(permitChain) ||
      !isPlainRecord(ledger) ||
      !isPlainRecord(ledger.checkpoint) ||
      !isPlainRecord(pendingDirectDeals) ||
      !isPlainRecord(quarantinedPendingDirectDeals) ||
      ledger.pending !== undefined ||
      ledger.blocker !== undefined ||
      Object.keys(pendingDirectDeals).length !== 0 ||
      Object.keys(quarantinedPendingDirectDeals).length !== 0
    ) {
      return undefined;
    }
    return canonicalStableHashV1({
      domain: "market-base-resource:legacy-v2-frozen-quiescence-v1",
      authority: {
        migrationStatus: directAutomation.migrationStatus,
        migrationBlockedReason: directAutomation.migrationBlockedReason ?? null,
        currentPermit: {
          epoch: currentPermit.epoch,
          permitId: currentPermit.permitId,
          permitHead: currentPermit.permitHead,
        },
        proposedPermitPresent: false,
        permitChain: {
          currentPermitEpoch: permitChain.currentPermitEpoch,
          currentPermitId: permitChain.currentPermitId,
          permitChainHead: permitChain.permitChainHead,
          permitEpochHighWater: permitChain.permitEpochHighWater,
          permitChainHeadHighWater: permitChain.permitChainHeadHighWater,
        },
        ledger: {
          receiptHeadHash: ledger.receiptHeadHash,
          finalizedAttemptSeq: ledger.finalizedAttemptSeq,
          nextAttemptSeq: ledger.nextAttemptSeq,
          permitEpochHighWater: ledger.permitEpochHighWater,
          permitChainHeadHighWater: ledger.permitChainHeadHighWater,
          prunedThroughSeq: ledger.checkpoint.prunedThroughSeq,
          prunedHeadHash: ledger.checkpoint.prunedHeadHash,
          pendingPresent: false,
          blockerPresent: false,
        },
        pendingProjectionCount: 0,
        quarantinedProjectionCount: 0,
      },
    });
  } catch {
    return undefined;
  }
}

/**
 * 把 outer 已认证并完成 canonical assignment 的 successor root 注册为
 * 本 tick 的 readiness read capability。这个入口只接受由本模块私有
 * WeakMap 铸造的 runtime capability；Memory 字段或 JSON clone 无法命中。
 */
export function registerMarketBaseResourceCanonicalReadinessRuntimeCapability(input: {
  readonly marketSaleRoot: unknown;
  readonly marketMode: unknown;
  readonly currentTick: number;
  readonly runtimeCapability:
    MarketBaseResourceReadinessRuntimeCapability | undefined;
}): MarketBaseResourceCanonicalReadinessRead {
  const invalid = (): MarketBaseResourceCanonicalReadinessRead => ({
    ok: false,
    reason: "invalid",
    rooms: [],
  });
  try {
    if (
      input.marketMode !== "direct" ||
      !Number.isSafeInteger(input.currentTick) ||
      input.currentTick < 0 ||
      !isPlainRecord(input.marketSaleRoot) ||
      !input.runtimeCapability ||
      typeof input.runtimeCapability !== "object"
    ) {
      return invalid();
    }
    const capability = marketBaseResourceReadinessRuntimeCapabilities.get(
      input.runtimeCapability as object,
    );
    const marketSaleRoot = input.marketSaleRoot;
    const directAutomation = marketSaleRoot.directAutomation;
    const activationAnchor = marketSaleRoot.baseResourceV3ActivationAnchor;
    const activationAnchorMirror =
      marketSaleRoot.baseResourceV3ActivationAnchorMirror;
    const trustedFloors = marketSaleRoot.trustedFloors;
    // capability 已在本模块内递归冻结 ledger / permit / scope 等大对象。
    // 在校验其余 outer 输入前沿用同一份私有冻结缓存，可关闭 TOCTOU，
    // 也避免调用方再用另一套 WeakSet 重扫完整 receipt ring。
    freezeMarketBaseResourceRuntimeSnapshot(directAutomation);
    freezeMarketBaseResourceRuntimeSnapshot(activationAnchor);
    freezeMarketBaseResourceRuntimeSnapshot(activationAnchorMirror);
    freezeMarketBaseResourceRuntimeSnapshot(trustedFloors);
    if (
      !capability ||
      capability.tick !== input.currentTick ||
      !isPlainRecord(directAutomation) ||
      !isPlainRecord(activationAnchor) ||
      !isPlainRecord(activationAnchorMirror) ||
      !isPlainRecord(trustedFloors) ||
      directAutomation.baseResourceV3 !== capability.state ||
      capability.state.preflightAt !== input.currentTick ||
      capability.state.cutoverLatched !== true ||
      capability.state.blocker !== undefined ||
      capability.state.hardBlocker !== undefined ||
      !capability.state.scope ||
      capability.state.scope.updatedAt !== input.currentTick ||
      !capability.state.permitChain ||
      !capability.state.ledger ||
      marketBaseResourceRuntimeSnapshotMismatch(
        capability.state,
        capability.session,
      )
    ) {
      return invalid();
    }
    const activationAnchorHash = activationAnchor.anchorHash;
    const outerPermit = directAutomation.currentPermit;
    const outerLedger = directAutomation.ledger;
    const outerQuiescenceCommitment =
      marketBaseResourceLegacyV2QuiescenceCommitment(directAutomation);
    if (
      typeof activationAnchorHash !== "string" ||
      activationAnchorHash.length === 0 ||
      activationAnchorMirror.anchorHash !== activationAnchorHash ||
      activationAnchor.activationBlocker !== null ||
      activationAnchorMirror.activationBlocker !== null ||
      !isPlainRecord(outerPermit) ||
      !isPlainRecord(outerLedger) ||
      outerQuiescenceCommitment === undefined ||
      activationAnchor.legacyV2QuiescenceCommitment !==
        outerQuiescenceCommitment ||
      marketBaseResourceActivationAnchorSelfHash(activationAnchor) !==
        activationAnchorHash ||
      marketBaseResourceActivationAnchorSelfHash(activationAnchorMirror) !==
        activationAnchorHash ||
      canonicalStableHashV1(activationAnchor.ledger) !==
        canonicalStableHashV1(capability.session.ledgerRuntimeAnchor) ||
      !marketBaseResourceRuntimeSafetyMatchesActivationAnchor(
        capability.state,
        trustedFloors,
        activationAnchor,
        capability.session.ledgerRuntimeAnchor,
      ) ||
      activationAnchor.accountIdentity !==
        capability.state.scope.accountIdentity ||
      activationAnchor.executorShard !== "shard1" ||
      activationAnchor.cutoverCheckpointHash !==
        capability.state.permitChain.v2EventCutoverCheckpoint?.checkpointHash ||
      activationAnchor.laneTombstoneCheckpointCommitment !==
        capability.state.permitChain.laneTombstoneCheckpoint
          .checkpointCommitment ||
      activationAnchor.laneTombstoneDischargeCheckpointCommitment !==
        capability.state.scope.laneTombstoneDischargeCheckpoint
          .checkpointCommitment ||
      activationAnchor.roomRegistryCheckpointCommitment !==
        capability.state.scope.roomRegistry.checkpointCommitment ||
      activationAnchor.scopeCommitment !==
        marketBaseResourceOuterScopeCommitment(capability.state.scope)
    ) {
      return invalid();
    }
    const currentPermit = currentV3Permit(
      capability.session.permitContext.state,
    );
    const cutover = capability.state.permitChain.v2EventCutoverCheckpoint;
    const wrappedOuterPermit =
      capability.state.permitChain.retainedPermits.find(
        (record) =>
          record.schemaVersion === 2 &&
          record.permitId === outerPermit.permitId &&
          record.permitHead === outerPermit.permitHead,
      );
    if (
      !currentPermit ||
      !cutover ||
      !wrappedOuterPermit ||
      wrappedOuterPermit.schemaVersion !== 2 ||
      canonicalStableHashV1(wrappedOuterPermit.rawRecord) !==
        canonicalStableHashV1(outerPermit) ||
      cutover.v2ReceiptHeadHash !== outerLedger.receiptHeadHash ||
      cutover.lastV2AttemptSeq !== outerLedger.finalizedAttemptSeq ||
      cutover.lastV2OutcomeSeq !== outerLedger.finalizedAttemptSeq ||
      outerLedger.nextAttemptSeq !== cutover.lastV2AttemptSeq + 1
    ) {
      return invalid();
    }
    const derived =
      buildMarketBaseResourceReadinessAuthorizationWithRuntimeContext(
        capability.session.permitContext,
        {
          tick: input.currentTick,
          ttl: 1,
          roster: capability.state.scope.sellerRooms.map(
            marketBaseResourceSellerRoomBasis,
          ),
          lanes: capability.state.scope.laneLifecycles,
        },
      );
    let read: MarketBaseResourceCanonicalReadinessRead;
    if ("reason" in derived) {
      if (
        derived.reason !== "readiness_no_enabled_v3_grant" ||
        capability.state.readinessAuthorization !== undefined
      ) {
        return invalid();
      }
      read = freezeMarketBaseResourceRuntimeSnapshot({
        ok: false,
        reason: "missing" as const,
        rooms: [],
      });
    } else {
      if (
        !capability.state.readinessAuthorization ||
        canonicalStableHashV1(capability.state.readinessAuthorization) !==
          canonicalStableHashV1(derived.readinessAuthorization)
      ) {
        return invalid();
      }
      read = freezeMarketBaseResourceRuntimeSnapshot({
        ok: true,
        revision: derived.readinessAuthorization.revision,
        maxTransactionEnergy: 1_000 as const,
        sourcePermitVersion: 3 as const,
        rooms: derived.readinessAuthorization.rooms.map(
          ({ status: _status, ...basis }) => basis,
        ),
        cargoLanes: capability.state.scope.laneLifecycles
          .filter((lane) =>
            laneAllowsRuntimeWrite(capability.session, "shard1", lane),
          )
          .map((lane) => ({
            roomName: lane.sellerRoomName,
            resource: lane.resource,
            terminalId: capability.state.scope!.sellerRooms.find(
              (room) => room.roomName === lane.sellerRoomName,
            )?.terminalId ?? "",
            maxDealAmount:
              MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[lane.resource]
                .maxDealAmount,
          }))
          .filter((lane) =>
            derived.readinessAuthorization.rooms.some(
              (room) =>
                room.roomName === lane.roomName &&
                room.terminalId === lane.terminalId,
            ),
          ),
      });
    }

    // 注册成功后关闭同 tick 内的原位 mutation 窗口；合法更新均通过
    // successor root replacement，因此不会依赖修改这些旧对象。
    // Ledger context 的私有 provenance 已证明该 exact state 递归冻结；
    // 直接登记可避免 successor root 再遍历 512-ring。
    marketBaseResourceRuntimeDeepFrozenValues.add(capability.state.ledger);
    trustMarketBaseResourceRuntimeSessionExactSources(
      capability.state,
      capability.session,
    );
    if (
      capability.state.readinessAuthorization &&
      Object.isFrozen(capability.state.readinessAuthorization)
    ) {
      marketBaseResourceRuntimeDeepFrozenValues.add(
        capability.state.readinessAuthorization,
      );
    }
    marketBaseResourceCanonicalReadinessRuntimeCache.set(marketSaleRoot, {
      tick: input.currentTick,
      marketMode: "direct",
      marketSaleRoot,
      directAutomation,
      state: capability.state,
      scope: capability.state.scope,
      permitChain: capability.state.permitChain,
      ledger: capability.state.ledger,
      readinessAuthorization: capability.state.readinessAuthorization,
      activationAnchor,
      activationAnchorMirror,
      activationAnchorHash,
      trustedFloors,
      runtimeSession: capability.session,
      read,
    });
    return read;
  } catch {
    return invalid();
  }
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

function openMarketBaseResourceRuntimeSession(
  state: MarketBaseResourceV3RuntimeState,
  tick: number,
  dependencies: MarketBaseResourceRuntimeDependencies,
  runtimeAnchor?: MarketBaseResourceLedgerRuntimeAnchor,
  expectedOuterScopeCommitment?: string,
): MarketBaseResourceRuntimeSessionResult {
  if (!state.ledger || !state.permitChain) {
    return {
      ok: false,
      reason: "market_base_v3_runtime_state_incomplete",
    };
  }
  if (state.scope) {
    const scopeError = validateMarketBaseResourceRuntimeScopeConsistency(
      state.scope,
      tick,
    );
    if (scopeError) {
      return { ok: false, reason: scopeError };
    }
    const scopeCommitment = marketBaseResourceOuterScopeCommitment(
      state.scope,
    );
    if (
      expectedOuterScopeCommitment !== undefined &&
      expectedOuterScopeCommitment !== scopeCommitment
    ) {
      return {
        ok: false,
        reason: "market_base_v3_runtime_scope_commitment_mismatch",
      };
    }
  } else if (expectedOuterScopeCommitment !== undefined) {
    return {
      ok: false,
      reason: "market_base_v3_runtime_scope_missing",
    };
  }
  let anchor = runtimeAnchor;
  if (!anchor) {
    try {
      anchor = dependencies.readLedgerRuntimeAnchor(state);
    } catch {
      anchor = undefined;
    }
  }
  if (!anchor) {
    return {
      ok: false,
      reason: "market_base_v3_runtime_anchor_missing",
    };
  }
  const ledgerContext = createMarketBaseResourceLedgerRuntimeContext({
    state: state.ledger,
    permitChain: state.permitChain,
    anchor,
    tick,
  });
  if ("reason" in ledgerContext) {
    return {
      ok: false,
      reason:
        ledgerContext.reason || "market_base_v3_ledger_runtime_gate_failed",
    };
  }
  const permitContext = createMarketBaseResourcePermitRuntimeContext({
    state: ledgerContext.context.permitChain,
    anchor: ledgerContext.context.anchor.permitRuntimeAnchor,
    tick,
  });
  if ("reason" in permitContext) {
    return {
      ok: false,
      reason:
        permitContext.reason || "market_base_v3_permit_runtime_gate_failed",
    };
  }
  const scopeContext = state.scope
    ? createMarketBaseResourceRuntimeScopeContext(
        state.scope,
        expectedOuterScopeCommitment !== undefined,
      )
    : undefined;
  const invariantCommitment = marketBaseResourceRuntimeInvariantCommitment(
    state,
  );
  const pricingRatchetCommitment =
    marketBaseResourceRuntimePricingRatchetCommitment(state);
  return {
    ok: true,
    session: {
      ledgerContext: ledgerContext.context,
      permitContext: permitContext.context,
      permitSource: state.permitChain,
      ledgerRuntimeAnchor: ledgerContext.context.anchor,
      ...(scopeContext ? { scopeContext } : {}),
      safetyContext: {
        schemaVersion: state.schemaVersion,
        catalog: state.catalog,
        cutoverLatched: state.cutoverLatched,
        blocker: state.blocker,
        hardBlocker: state.hardBlocker,
        pricingRatchet: state.pricingRatchet,
        invariantCommitment,
        pricingRatchetCommitment,
      },
    },
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

function laneAllowsRuntimeWrite(
  session: MarketBaseResourceRuntimeSession,
  shard: string,
  lane: MarketBaseDerivedLaneLifecycle,
): boolean {
  if (
    !marketBaseResourcePermitAllowsNewDealWithRuntimeContext(
      session.permitContext,
      { shard, lane },
    )
  ) {
    return false;
  }
  const permit = currentV3Permit(session.permitContext.state);
  const grant = permit?.signedLaneGrants.find(
    (candidate) => candidate.laneId === lane.laneId,
  );
  if (grant?.stage !== "canary") {
    return true;
  }
  const availability =
    inspectMarketBaseResourceCanaryGrantAvailabilityWithRuntimeContext(
      session.ledgerContext,
      lane.laneId,
    );
  return availability.ok && availability.available;
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

function runtimeCandidateKey(roomName: string, resource: string): string {
  return `${roomName}:${resource}`;
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
): boolean {
  const policy =
    MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[candidate.resourceType];
  // enforce 对称重算：dynamicFloor 有效时替代 {history, ratchet} 分量，
  // 与 adapter 侧 computeEffectiveNetFloor 的分支保持同一映射来源
  //（state.dynamicFloorProjection，本 tick 内不变），否则整轮
  // candidate_incomplete fail-closed。
  const effectiveFloor =
    dynamicFloor !== undefined && Number.isFinite(dynamicFloor)
      ? Math.max(policy.hardFloor, policy.economicFloor, dynamicFloor)
      : Math.max(
          policy.hardFloor,
          policy.economicFloor,
          candidate.historyFloor,
          trustedFloor.value,
        );
  const bootstrapRatchet =
    MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[candidate.resourceType]
      .ratchetFloor;
  return (
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
  readonly executorShard: "shard1";
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
      executorShard !== "shard1" ||
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
    Object.is(left.effectiveNetFloor, right.effectiveNetFloor) &&
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
    const writableLaneIds = new Set(
      scope.laneLifecycles
        .filter((lane) => laneAllowsRuntimeWrite(session, executorShard, lane))
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
        return measureMarketSubPhase("v3LiveScopeRead", () => liveScopeForRead(
          state,
          input,
          dependencies,
          runtimeSession,
          staticReadAttestationResult,
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
