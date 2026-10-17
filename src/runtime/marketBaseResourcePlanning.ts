import { stageMarketComparisonPlan } from "@/runtime/market/comparison";
/** 从 marketBaseResourceAutomation.ts 分离的独立职责模块；共享状态仅由此处持有。 */
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
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  type MarketBaseResource,
  type MarketBaseDynamicFloorSurplusLane,
} from "@/runtime/marketBaseResourcePolicy";
import {
  MARKET_BASE_RESOURCE_LANE_QUOTA_LIMIT,
  MARKET_BASE_RESOURCE_ROOM_QUOTA_LIMIT,
} from "@/runtime/marketBaseResourceLedger";


export const MARKET_BASE_RESOURCE_MAX_ACTIVE_ROOMS = 16;
export const MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES = 32;
export const MARKET_BASE_RESOURCE_MAX_ACTIVE_LANES = 112;
export const MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE = 8;
export const MARKET_BASE_RESOURCE_MAX_RAW_ORDERS_PER_RESOURCE = 1_000;
export const MARKET_BASE_RESOURCE_MAX_ELIGIBLE_ORDERS_PER_RESOURCE = 200;
export const MARKET_BASE_RESOURCE_MAX_DISTINCT_ORDER_ROOMS = 128;
export const MARKET_BASE_RESOURCE_MAX_TRANSACTION_COST_EVALUATIONS = 4_096;
export const MARKET_BASE_RESOURCE_PLANNING_CPU_CEILING = 25;
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

export type MarketBaseResourceCpuTraceField =
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

export interface MarketBaseResourceCpuTraceRecorder {
  readonly startedAt: number;
  readonly trace: MarketBaseResourceCpuTrace;
  lastRawDelta: number;
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

export type V3LaneInput = MarketDirectContinuousLaneInput & {
  laneId: string;
  roomInstanceId: string;
  /** 保护后总库存盈余，含 storage；只用于动态价格库存分量。 */
  inventorySurplus?: number;
  lane: MarketDirectContinuousLaneInput["lane"] & {
    authorization?: "writable" | "suspended_shadow";
  };
};

export type V3EntryInput = Omit<MarketDirectContinuousEntryInput, "lanes"> & {
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
  /** 观察者只读已经发生的成本计算，不能再次调用 production callback。 */
  transactionEnergyCosts?: ReadonlyMap<string, number>;
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

export function stableCompare(left: string, right: string): number {
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

export function observeMarketBaseResourceCpuTrace(
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

export function setMarketBaseResourceMarketFactsDisposition(
  recorder: MarketBaseResourceCpuTraceRecorder | undefined,
  disposition: MarketBaseResourceMarketFactsDisposition,
): void {
  if (recorder) recorder.trace.marketFactsDisposition = disposition;
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
  // 候选证据被隔离或所有可写 lane 保护证据不完整的资源不读 book；
  // 它们本轮不会出货，省下的 CPU 留给可执行 lane 的 WAL 准备。
  const evaluatedResources = scope.entries
    .filter(
      (entry) =>
        !entry.lanes.every((lane) =>
          isolatedCandidateLaneIds.has(lane.laneId),
        ) &&
        entry.lanes.some(
          (lane) =>
            (lane.lane.authorization === "writable" &&
              lane.protection.complete &&
              Boolean(lane.protection.revision)) ||
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
        Math.min(resourceEntry.policy.minExecutableNotional,
          ...resourceEntry.lanes.map(lane => lane.pricing?.minExecutableNotional ?? resourceEntry.policy.minExecutableNotional)),
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
          // 保护/终端证据只属于这个房间的出货资格。剔除该 lane 后
          // 其库存不会进入 planner；其他房间继续使用原有双读、WAL 和
          // 全域指纹校验。一次缺失的 H 保护快照不能饿死 X 的出货。
          continue;
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
    transactionEnergyCosts: transactionEnergyMemo,
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
  stageMarketComparisonPlan(firstRead.plannerInput, first, firstRead.transactionEnergyCosts);
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

export function runtimeCandidateKey(roomName: string, resource: string): string {
  return `${roomName}:${resource}`;
}
