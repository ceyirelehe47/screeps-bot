import { AUTHORITY_EXECUTOR_SHARD, AUTHORITY_ROOMS } from "@/config/deployment";
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
  resolveDirectAutomationPending,
  runDirectAutomationPlanning,
  runDirectAutomationPreflight,
  type DirectRuntimeCandidate,
} from "@/runtime/marketSaleDirectAutomation";
import {
  marketDirectContinuousExposure,
  marketDirectContinuousStatus as projectContinuousDirectStatus,
  runMarketDirectContinuousPlanning,
  runMarketDirectContinuousPreflight,
  type MarketDirectContinuousAutomationState,
  type MarketDirectContinuousPermitRequest,
  type MarketDirectContinuousResult,
  type MarketDirectContinuousRuntimeCandidate,
} from "@/runtime/marketDirectContinuousAutomation";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
  canonicalStableHashV1,
} from "@/runtime/marketDirectContinuousPolicy";
import {
  advanceMarketBaseResourceReadinessRuntimeCapability,
  advanceMarketBaseResourceReadinessRuntimeCapabilityFromRoot,
  buildMarketBaseResourcePricingRatchetState,
  defaultMarketBaseResourceRuntimeDependencies,
  deriveMarketBaseResourceCanonicalReadinessAuthorization,
  marketBaseResourceCpuFallbackRequiresCanonicalCommit,
  marketBaseResourceOperatorAuthorizationFingerprint,
  materializeMarketBaseResourceCpuFallback,
  observeMarketBaseResourceOuterPrecommitCpu,
  readLiveMarketBaseAccountIdentity,
  runMarketBaseResourceAutomation,
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
  MARKET_BASE_RESOURCE_POLICIES,
  createMarketBaseSharedPolicy,
  isMarketBaseResource,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  migrateMarketBaseDerivedLanes,
  type MarketBaseResource,
} from "@/runtime/marketBaseResourcePolicy";
import {
  appendMarketBaseResourcePermit,
  buildMarketBaseResourcePermit,
  buildMarketBaseResourceSignedLaneGrant,
  validateMarketBaseResourcePermitChain,
  type MarketBaseResourceReviewedEvidence,
  type MarketBaseResourceSignedLaneGrant,
} from "@/runtime/marketBaseResourcePermit";
import {
  marketBaseResourceRetainedReceiptPermitReferences,
  rebindMarketBaseResourceLedgerPermitAnchor,
  validateMarketBaseResourceLedger,
  type MarketBaseResourceLedgerRuntimeAnchor,
} from "@/runtime/marketBaseResourceLedger";
import {
  readMarketEgressTrialR2,
  heartbeatMarketEgressTrialR2 as heartbeatEgressTrialState,
  startMarketEgressTrialR2 as startEgressTrialState,
  stopMarketEgressTrialR2 as stopEgressTrialState,
} from "@/runtime/marketBaseResourceEgressTrialR2";
import { computeContinuousQuotaBatch } from "@/runtime/marketDirectContinuousLedger";
import { type OperatorDirectPendingEvidence } from "@/runtime/marketSaleDirectPending";
import {
  calculateProspectiveFeeMilli,
  evaluatePostActionInvariant,
  findMinimumSafePrice,
  roundMarketPriceUp,
} from "@/runtime/marketSalePricing";
import {
  evaluateMarketSaleCanaryPrerequisites,
  getMarketProtectionSellableAmount,
  isMarketProtectionEntryFresh,
  type MarketProtectionEntry,
} from "@/runtime/marketSaleProtection";
import {
  advanceFeeLedgerWindow,
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
  hashOrderIds,
  lockCanary,
  markPendingCreateSubmitted,
  markPendingMutationSubmitted,
  updateDrainState,
  type DrainState,
  type MarketOrderSnapshot,
  type OrderMutationLease,
} from "@/runtime/marketSaleLifecycle";
import {
  isPlainRecord,
  cloneMarketBaseOperatorValue,
  MARKET_BASE_RESOURCE_TRUSTED_FLOOR_RESOURCES,
  hasExactRecordKeys,
  marketBaseResourceTrustedFloorHighWater,
  freezeMarketBaseOuterCanonicalValue,
  validateMarketBaseNestedActivationState,
  isContinuousDirectState,
  marketBaseResourceCanonicalRootProvenance,
  marketBaseResourceActivationState,
  validateMarketBaseScopeLifecycleEvidence,
  synchronizeMarketBaseTrustedFloors,
  advanceMarketBaseResourceActivationAnchor,
  marketDataStateDeepRecoveries,
  ensureDataState,
  collectMarketSaleDomainActivity,
  usesDirectStrategy,
  boundedPush,
  MAX_FEE_EVENTS,
  appendAudit,
  proposeMarketDirectContinuousPermit,
  acceptMarketDirectContinuousPermit,
  marketDirectContinuousStatus,
  proposeMarketBaseResourcePermit,
  acceptMarketBaseResourcePermit,
  marketBaseResourceStatus,
  commitMarketSaleDataSnapshot,
  currentMarketBaseV3Permit,
  marketBasePolicyMigrationSourceFingerprint,
  inertMarketBaseProposal,
  marketBaseResourceV3ConfigBlocker,
  copyMarketSaleDataForOperator,
} from "@/runtime/marketSaleOperators";
import type {
  MarketSaleDataState,
  MarketBaseResourceActivationAnchor,
  OperatorResult,
  MarketBaseResourcePermitRequest,
  DirectLegacyExposureDrainState,
  OwnedPendingCreate,
  OwnedManagedOrder,
  OwnedCanaryLock,
} from "@/runtime/marketSaleOperators";
import {
  reject,
  reconcilePersistentState,
  recordAction,
  nonNegativeInteger,
  roomTerminal,
  requestCancel,
  orderFingerprint,
  MAX_RECENT_ACTIONS,
  adoptPendingOrder,
  carryFeeDebt,
} from "@/runtime/marketSaleReconciliation";
import type { RunContext, MarketSaleRuntimeState } from "@/runtime/marketSaleReconciliation";
import {
  reconcileBaseResourceV3State,
  mergeDirectResult,
  registerMarketBaseResourceCanonicalRoot,
  commitExactContextMarketSaleData,
  isRegisteredMarketBaseResourceCanonicalRootThisTick,
  validatePostCutoverLegacyV2Quiescence,
} from "@/runtime/marketBaseResourceActivation";


export {
  advanceMarketBaseResourceActivationAnchor,
  marketBaseResourceActivationPendingHighWaterValid,
  collectMarketSaleDomainActivity,
  proposeMarketDirectContinuousPermit,
  acceptMarketDirectContinuousPermit,
  marketDirectContinuousStatus,
  marketBaseContinuousReviewCargoReady,
  proposeMarketBaseResourcePermit,
  acceptMarketBaseResourcePermit,
  marketBaseResourceStatus,
} from "@/runtime/marketSaleOperators";


export type {
  MarketBaseResourceActivationAnchor,
  MarketBaseResourcePermitRequest,
  MarketBaseResourceContinuousReviewSnapshot,
  MarketSaleDomainActivity,
} from "@/runtime/marketSaleOperators";




const MAX_MARKET_ORDERS = 300;
const MAX_MANAGED_ORDER_SUMMARIES = 20;
const REQUIRED_SHADOW_CYCLES = 100;

/**
 * Maker / hybrid 已退出生产合同。该闩不可由 Memory、console、测试环境或
 * mode 切换绕过：旧 managed exposure 只能继续 reconcile 后 cancel/drain，
 * 永远不得再创建新的 SELL order。
 */
export const MARKET_MAKER_HYBRID_PERMANENTLY_DISABLED = true;

export interface MarketSalePlanCandidate {
  overflowTier?: "normal" | "overflow" | "liquidation";
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
  /**
   * 外层（runLiveMarketSaleAutomation）的显式 planning 授权：本 tick 是否为
   * 市场 planning 周期（due）。内层不再从 ResourceControl.updatedAt 猜测
   * planning 周期——RC 新鲜度仍叠加为新订单 planning 的硬门，但"是否 due"
   * 只以本字段为准。未传或 false 视为 deferred tick：exposure 安全 reconcile、
   * drain、latch、pending mutation/deal 仍每 tick 运行；candidate projection、
   * V3 planning 推进（ratchet/permit/ledger/readiness/qualification）、
   * canary/shadow 下单与 shadow qualification 计数不执行。
   */
  planningAuthorized?: boolean;
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
  startMarketBaseResourceEgressTrialR2?: () => OperatorResult;
  stopMarketBaseResourceEgressTrialR2?: (reason?: string) => OperatorResult;
  heartbeatMarketBaseResourceEgressTrialR2?: () => OperatorResult;
  marketBaseResourceEgressTrialR2Status?: () => unknown;
};

const operatorGlobals = global as OperatorGlobals;

export function getMarketDataStateDeepRecoveriesForTest(): number {
  return marketDataStateDeepRecoveries;
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

function makeContext(): RunContext {
  const config = measureMarketSubPhase("configResolve", () => resolveMarketSaleAutomationConfig());
  const data = measureMarketSubPhase("ensureDataState", () => ensureDataState());
  const domainActivity = measureMarketSubPhase("domainActivity", () =>
    collectMarketSaleDomainActivity(data),
  );
  const runtime = ensureRuntimeState();
  const context: RunContext = {
    config,
    data,
    runtime,
    liveOrders: [],
    liveOrderById: new Map(),
    liveOrdersLoaded: false,
    actions: [],
    rejectedByReason: {},
    writes: 0,
    shadowPlanComplete: false,
    stagingAmount: domainActivity.stagingAmount,
    reservationAmount: domainActivity.reservationAmount,
    marketDomainActivityValid: domainActivity.valid,
  };
  // 存在 managed/pending/drain exposure 时 preflight 立即加载对账所需订单；
  // 否则保持未加载，由 automation 侧确认本 tick 真正 planning 后按需补载
  //（preflight 先于 ResourceControl 运行，此刻的 RC 新鲜度判定必然过期，
  // 不能作为加载依据——这是空订单快照时序缺陷的根因）。
  if (hasLiveOrderConsumers(data)) {
    ensureLiveOrdersLoaded(context);
  }
  return context;
}

/** 懒加载全量账号订单快照并建立 by-id 索引；同 tick 至多执行一次。 */
function ensureLiveOrdersLoaded(context: RunContext): void {
  if (context.liveOrdersLoaded) return;
  context.liveOrders = measureMarketSubPhase("liveOrdersSnapshot", () =>
    readLiveOrders(),
  );
  context.liveOrderById = new Map(
    context.liveOrders.map((order) => [order.id, order]),
  );
  context.liveOrdersLoaded = true;
}

// liveOrders 全量快照（复制+排序全部 Game.market.orders）只服务于
// managed/pending 对账、drain cancel 与 planning tick 的下单 slots/fingerprint
// 基线。无这些消费者时（线上常态：无 exposure 的普通 tick）preflight 跳过
// 读取；一旦出现 managed/pending（新 exposure）立即恢复全量；planning tick
// 的订单视图由 automation 侧经 ensureLiveOrdersLoaded 显式补载。
// 注意：不得在此引用 ResourceControl.updatedAt——preflight 先于 RC 运行，
// 该判定在 preflight 时刻恒为 false，会把 planning tick 冻结成空快照。
function hasLiveOrderConsumers(data: MarketSaleDataState): boolean {
  if (Object.keys(data.managedOrders).length > 0) return true;
  if (data.pendingCreate !== undefined) return true;
  if (Object.keys(data.pendingMutations).length > 0) return true;
  if (Object.keys(data.pendingDirectDeals ?? {}).length > 0) return true;
  const drainPhase = data.drain?.phase;
  if (drainPhase === "requested" || drainPhase === "draining") return true;
  return false;
}

// ─── MarketTickSession ────────────────────────────────────────────────────────
// preflight 与 post-ResourceControl automation 复用同一 tick 的共享会话：
// - context（config/data/runtime/liveOrders）在第一次市场调用时构建一次；
//   liveOrders 懒加载：有 exposure 时构建即载，否则等 automation 侧确认
//   planning 后补载（同 tick 至多读一次 Game.market.orders，见
//   ensureLiveOrdersLoaded），root 替换重建 context 时懒标记一并复位；
// - v3Reconcile / persistentReconcile 以 context.data 引用为失效键——
//   阶段之间的市场自身 commit 会替换 data 根（commit 函数同步 context.data），
//   引用变化即自动重新 reconcile；ResourceControl 不写市场 data，
//   因此两个阶段共享 context/reconcile 结果与现状语义等价；
// - RC 之后才变化的事实（capacityState、库存、domain activity）不进
//   session，由 automation 侧按现状自行读取；
// - 仅存 global heap、以 Game.time 标识、global reset 自然重建。

interface MarketTickSession {
  context: RunContext;
  /** reconcile 结果对应的 data 根引用；不匹配（根被替换）时重新执行。 */
  baseResourceV3Data?: MarketSaleDataState;
  baseResourceV3?: ReturnType<typeof reconcileBaseResourceV3State>;
  persistentReconciledData?: MarketSaleDataState;
  latchDone: boolean;
}

type GlobalWithMarketTickSession = typeof global & {
  __marketTickSession?: { tick: number; session?: MarketTickSession };
};

const marketTickSessionGlobal: GlobalWithMarketTickSession = global;

export function clearMarketTickSessionForTest(): void {
  delete marketTickSessionGlobal.__marketTickSession;
}

function ensureMarketTickSession(): MarketTickSession {
  const holder = marketTickSessionGlobal.__marketTickSession;
  if (holder?.tick === Game.time && holder.session) {
    return holder.session;
  }
  const session: MarketTickSession = {
    context: makeContext(),
    latchDone: false,
  };
  marketTickSessionGlobal.__marketTickSession = { tick: Game.time, session };
  return session;
}

/**
 * 阶段入口统一获取 session：data 引用仍指向 Memory 当前根时复用 context；
 * 被未同步 session 的链路（operator commit、外部赋值）替换时原地重建
 * context，reconcile memo 因 data 引用变化自动失效。
 */
function currentMarketTickSession(): MarketTickSession {
  const session = ensureMarketTickSession();
  if (session.context.data !== (Memory.data?.marketSaleAutomation as unknown as MarketSaleDataState | undefined)) {
    session.context = makeContext();
  }
  return session;
}

function sessionReconcileBaseResourceV3(
  session: MarketTickSession,
  context: RunContext,
): ReturnType<typeof reconcileBaseResourceV3State> {
  if (session.baseResourceV3 && session.baseResourceV3Data === context.data) {
    return session.baseResourceV3;
  }
  const result = measureMarketSubPhase("v3Reconcile", () => reconcileBaseResourceV3State(context));
  session.baseResourceV3 = result;
  session.baseResourceV3Data = context.data;
  return result;
}

function sessionReconcilePersistent(session: MarketTickSession, context: RunContext): void {
  if (session.persistentReconciledData === context.data) {
    return;
  }
  measureMarketSubPhase("persistentReconcile", () => reconcilePersistentState(context));
  session.persistentReconciledData = context.data;
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
        overflowTier: candidate.overflowTier,
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

function marketBaseCandidateProjectionReasons(
  candidate: MarketSalePlanCandidate,
): string[] {
  const reasons = new Set(
    toMarketBaseResourceRuntimeCandidates([candidate])[0]?.rejectionReasons ?? [],
  );
  const entry = candidate.protectionEntry;
  if (!isMarketProtectionEntryFresh(entry, Game.time) || entry.blocked) {
    reasons.add("direct_protection_not_current");
  } else if (
    getMarketProtectionSellableAmount(entry, Game.time, {
      requireTerminalBacking: false,
    }) < 1_000
  ) {
    reasons.add("direct_no_protected_surplus");
  } else if (getMarketProtectionSellableAmount(entry, Game.time) < 1_000) {
    reasons.add("direct_terminal_stock_shortage");
  }
  if (candidate.capacityState === undefined) {
    reasons.add("direct_capacity_state_unknown");
  }
  if (candidate.isHubRoom === undefined) {
    reasons.add("direct_hub_state_unknown");
  }
  return [...reasons].sort();
}

function makerExposurePresent(context: RunContext): boolean {
  return Boolean(
    Object.keys(context.data.managedOrders).length > 0 ||
      context.data.pendingCreate ||
      Object.keys(context.data.pendingMutations).length > 0 ||
      context.data.feeLedger?.invalid ||
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
      Object.keys(direct.pendingDirectDeals ?? {}).length === 0 &&
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
      context.data.feeLedger?.invalid ||
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
      data.feeLedger?.invalid ||
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
  // qualification 推进只看本 tick 合成 planning 判定（外层显式授权），
  // 不再从 RC.updatedAt 自行推导（deferred tick 即使 RC 新鲜也不推进）。
  const planningCycleCurrent = context.planningCycleCurrent === true;
  if (
    phase !== "shadow" ||
    !revision ||
    !planningCycleCurrent ||
    !context.shadowPlanComplete
  ) {
    if (phase === "shadow" && planningCycleCurrent && !context.shadowPlanComplete) {
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
  operatorGlobals.startMarketBaseResourceEgressTrialR2 = startMarketBaseResourceEgressTrialR2;
  operatorGlobals.stopMarketBaseResourceEgressTrialR2 = stopMarketBaseResourceEgressTrialR2;
  operatorGlobals.heartbeatMarketBaseResourceEgressTrialR2 = heartbeatMarketBaseResourceEgressTrialR2;
  operatorGlobals.marketBaseResourceEgressTrialR2Status = marketBaseResourceEgressTrialR2Status;
}

export function runMarketSalePreflight(): MarketSaleAutomationResult {
  const session = currentMarketTickSession();
  const context = session.context;
  if (!session.latchDone) {
    measureMarketSubPhase("latchAndControls", () => {
      enforceLegacyMarketSafetyLatch();
      registerOperatorControls();
    });
    session.latchDone = true;
  }
  if (!context.marketDomainActivityValid) {
    reject(context, "market_domain_activity_invalid");
  }
  for (const reason of context.config.invalidReasons) reject(context, reason);
  if (context.config.mode === "hybrid") {
    reject(context, "hybrid_not_implemented");
  }
  const baseResourceV3 = sessionReconcileBaseResourceV3(session, context);
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
  sessionReconcilePersistent(session, context);
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
  const session = currentMarketTickSession();
  const context = session.context;
  if (!session.latchDone) {
    measureMarketSubPhase("latchAndControls", () => {
      enforceLegacyMarketSafetyLatch();
      registerOperatorControls();
    });
    session.latchDone = true;
  }
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
  let baseResourceV3 = sessionReconcileBaseResourceV3(session, context);
  const structuralWriteBlocker = structuralMarketSaleWriteBlocker(
    context.data,
    context.config,
  );
  if (structuralWriteBlocker) {
    reject(context, structuralWriteBlocker);
    updateDrain(context, "emergencyStop");
    return finalizeResult(context, context.config.mode, "emergencyStop");
  }
  sessionReconcilePersistent(session, context);
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
  // planning 授权只来自外层显式输入（due 判定），内层不再从
  // ResourceControl.updatedAt 自行猜测 planning 周期；RC 新鲜度仍作为
  // 新订单 planning 的硬门叠加（v3-r3 observe 语义不变）。
  // 修复前：deferred tick 上 RC 轻（readiness）路径推进 updatedAt 会让
  // planningCycleCurrent 误真——candidate projection / shadow qualification
  // / V3 planning 在未授权 tick 意外推进。
  const resourceControlFresh =
    Memory.runtime?.resourceControl?.updatedAt === Game.time;
  const planningCycleCurrent =
    input.planningAuthorized === true && resourceControlFresh;
  context.planningCycleCurrent = planningCycleCurrent;
  if (planningCycleCurrent) {
    // 本 tick 确认进入 planning：补载全量账号订单（fee gate 订单槽与
    // pendingCreate baseline fingerprints 需要真实视图；无 exposure 的
    // preflight 阶段尚未加载）。
    ensureLiveOrdersLoaded(context);
  }
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
          baseResourceV3.activeV3Successor
            ? marketBaseCandidateProjectionReasons(candidate)
            : directCandidateRejectionReasons(context, candidate),
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
      v3DirectResult &&
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
    (Game.shard?.name || "") !== AUTHORITY_EXECUTOR_SHARD ||
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
    // 常量升级保留已签发的 canary 授权及其资格证据。策略/底价变更
    // 不会重置成交额度或确认记录；append 与 ledger rebind 必须同时
    // 验证旧链的高水位和新 grant，失败则整个提案原子拒绝。
    const grant = buildMarketBaseResourceSignedLaneGrant({
      lane: {
        ...lane,
        status:
          priorGrant.newDealGrant === "enabled" ? "writable" : "suspended",
      },
      stage: priorGrant.stage,
      status: "active",
      newDealGrant: priorGrant.newDealGrant,
      ...(["continuous", "review_paused"].includes(priorGrant.stage)
        ? { reviewDigest: priorGrant.reviewDigest }
        : {}),
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
  // permit 签收后可自动接纳新房间；这些未签名 lane 仍是 shadow。
  // 迁移须覆盖完整当前 scope，但只能为它们补 suspended grant，不能晋级或扩权。
  const existingGrantIds = new Set(activeGrants.map(grant => grant.laneId));
  for (const lane of migration.lanes) {
    if (existingGrantIds.has(lane.laneId)) continue;
    if (lane.stage !== "shadow" || lane.status !== "suspended") {
      throw new TypeError(`market_base_migration_ungranted_lane_requires_shadow:${lane.laneId}`);
    }
    activeGrants.push(buildMarketBaseResourceSignedLaneGrant({
      lane, stage: "shadow", status: "active", newDealGrant: "suspended",
    }));
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
    currentShard: AUTHORITY_EXECUTOR_SHARD,
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
    executorShard: AUTHORITY_EXECUTOR_SHARD,
    rosterFingerprint: targetScope.rosterFingerprint,
    laneSetFingerprint: targetScope.laneSetFingerprint,
    targetScope,
    targetPermitChain: {
      ...appended.state,
      retainedPermits: [permit],
    },
    migrationChainEncoding: "appended-permit-only-v1",
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

/** One frozen R2 run; accepting a policy permit does not start the trial. */
export function startMarketBaseResourceEgressTrialR2(): OperatorResult {
  enforceLegacyMarketSafetyLatch();
  const data = ensureDataState();
  const direct = data.directAutomation;
  const config = resolveMarketSaleAutomationConfig();
  const blocker = marketBaseResourceV3ConfigBlocker(config);
  if (blocker || !isContinuousDirectState(direct) || config.mode !== "direct") {
    return { ok: false, error: blocker || "continuous_direct_required" };
  }
  const state = direct.baseResourceV3;
  const permit = state ? currentMarketBaseV3Permit(state) : undefined;
  if (!state?.ledger || !state.permitChain || !state.scope || !permit ||
      state.ledger.pending || state.ledger.blocker || state.hardBlocker ||
      Object.keys(direct.quarantinedPendingDirectDeals).length > 0 ||
      Object.keys(direct.pendingDirectDeals ?? {}).length > 0 ||
      !validateMarketBaseResourceLedger(state.ledger, Game.time, state.permitChain).ok ||
      !validateMarketBaseResourcePermitChain(state.permitChain).ok) {
    return { ok: false, error: "trial_wal_or_permit_not_quiescent" };
  }
  const eligible = ([ [AUTHORITY_ROOMS.reagentSource, "X"], [AUTHORITY_ROOMS.synthesisHub, "L"] ] as const).filter(
    ([roomName, resource]) => {
      const lane = state.scope!.laneLifecycles.find((value) =>
        value.sellerRoomName === roomName && value.resource === resource &&
        value.stage === "continuous" && value.status === "writable");
      const grant = lane && permit.signedLaneGrants.find((value) =>
        value.laneId === lane.laneId && value.roomInstanceId === lane.roomInstanceId &&
        value.stage === "continuous" && value.status === "active" &&
        value.newDealGrant === "enabled");
      const policy = permit.resourcePolicies.find((value) =>
        value.resource === resource && value.cooldownTicks === 100);
      return !!grant && !!policy;
    },
  );
  if (eligible.length === 0) {
    return { ok: false, error: "trial_no_current_continuous_lane" };
  }
  const started = startEgressTrialState({
    tick: Game.time,
    permitId: permit.permitId,
    permitEpoch: permit.epoch,
    originalNotBefore: state.ledger.confirmedCooldownNotBefore,
    nextAttemptSeq: state.ledger.nextAttemptSeq,
  });
  if ("reason" in started) return { ok: false, error: started.reason };
  return { ok: true, runId: started.trial.runId, endTick: started.trial.endTick,
    originalNotBefore: started.trial.originalNotBefore, eligibleLanes: eligible };
}

export function stopMarketBaseResourceEgressTrialR2(reason = "operator_stop"): OperatorResult {
  return stopEgressTrialState(reason)
    ? { ok: true, trial: readMarketEgressTrialR2() }
    : { ok: false, error: "trial_stop_failed_or_corrupt" };
}

export function heartbeatMarketBaseResourceEgressTrialR2(): OperatorResult {
  return heartbeatEgressTrialState(Game.time)
    ? { ok: true, trial: readMarketEgressTrialR2() }
    : { ok: false, error: "trial_heartbeat_rejected_or_expired" };
}

export function marketBaseResourceEgressTrialR2Status(): unknown {
  return readMarketEgressTrialR2();
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
