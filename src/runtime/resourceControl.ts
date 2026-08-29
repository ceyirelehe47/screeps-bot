import {
  listCarrierDispatchEntriesByRoom,
  listCarrierTasksByRoom,
  listCarrierTasksForProducer,
  peekCarrierTasksByRoom,
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDispatchClass,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import {
  encodeCarrierDispatchStepKey,
} from "@/runtime/dispatchOwnership/ref";
import { limitActionLog } from "@/runtime/actionLog";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import {
  cancelResourceTransferTask,
  clearResourceTransferTaskBlocker,
  countsResourceTransferTaskTowardDemand,
  createAutomaticResourceTransferTask,
  DEFAULT_RECEIVER_CAPACITY_DEMAND_COVERAGE_GRACE_TICKS,
  getResourceTransferTaskDemandCoverageExpirationReason,
  getResourceTransferTaskListSorted,
  isHealthyReceiverCapacityCommitment,
  isHealthyResourceTransferTaskReservation,
  markResourceTransferTaskBlocked,
  reconcileResourceTransferTasks,
  recordResourceTransferTaskProgress,
  type ResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import {
  DEFAULT_CAPACITY_HEADROOM_POLICY,
  getReceiverSafeCapacity,
  isReceiverAdmissionEligible,
  normalizeCapacityHeadroomPolicy,
  resolveCapacityState,
  type CapacityHeadroomPolicy,
  type CapacityState,
} from "@/runtime/logistics/capacityHeadroom";
import {
  createReceiverCapacityLedger,
  type ReceiverCapacityLedger,
  type ReceiverCapacityAvailability,
} from "@/runtime/logistics/receiverCapacityLedger";
import {
  LOGISTICS_CONTROL_STORE_LIMIT,
  LOGISTICS_RUNTIME_SCHEMA_VERSION,
  SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
  mapLegacyTransferOrigin,
  readLogisticsControlStoreExact,
  resolveLogisticsControlConfig,
  type LatestLogisticsDemandV1,
  type LogisticsProducerSnapshotV1,
  type LogisticsRolloutOrigin,
  type SynthesisLogisticsObservationV1,
} from "@/runtime/logistics/logisticsControl";
import {
  SYNTHESIS_SHADOW_DEFAULT_CANDIDATE_BUDGET,
  SYNTHESIS_SHADOW_MAX_COMPARISON_SAMPLES,
  SYNTHESIS_SHADOW_MAX_ROOM_FACTS,
  runSynthesisLogisticsShadow,
  type SynthesisShadowComparisonClassification,
  type SynthesisShadowComparisonSample,
  type SynthesisShadowCandidateRejection,
  type SynthesisShadowCandidateTrace,
  type SynthesisShadowCapacity,
  type SynthesisShadowCoverage,
  type SynthesisShadowDecision,
  type SynthesisShadowDemandObservation,
  type SynthesisShadowDifference,
  type SynthesisShadowLegacyDecisionObservation,
  type SynthesisShadowMatcherResult,
  type SynthesisShadowPredictedStagingEligibility,
  type SynthesisShadowRoomFact,
  type SynthesisShadowRouteFact,
  type SynthesisShadowUnmatchedReason,
  type SynthesisShadowUnmatchedDemand,
  type SynthesisShadowUnresolvedReason,
} from "@/runtime/logistics/synthesisLogisticsShadow";
import {
  measureLogisticsShadowCpu,
  peekLogisticsShadowCpuSnapshot,
  type LogisticsShadowCpuSnapshotV2,
} from "@/runtime/logistics/logisticsShadowCpu";
import {
  getMemoryService,
  getTickContextService,
} from "@/runtime/runtimeServices";
import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";
import {
  resolveRoomEnergyPolicy,
  type RoomEnergyPolicy,
} from "@/runtime/roomEnergyPolicy";
import {
  getReservedProductionAmount,
  listProductionReservations,
} from "@/runtime/resourceReservation";
import { HUB_TARGET_COMPOUNDS } from "@/config/hub";
import {
  declareMarketActionIntent,
  executeMarketDeal,
  executeTerminalSend,
  getMarketAccountClaim,
  getMarketActionJournal,
  getTerminalActionClaims,
} from "@/runtime/marketActionArbiter";
import {
  canTerminalSendPreserveMarketSaleExposure,
  compileLiveMarketSaleTerminalExposureIndex,
  getTerminalAmountOutsideMarketSaleExposure,
  getTerminalAmountsOutsideMarketSaleExposure,
} from "@/runtime/marketSaleExposure";
import { deriveMarketBaseResourceCanonicalReadinessAuthorization } from "@/runtime/marketBaseResourceAutomation";
import { getLocalCarrierDestinationCommittedAmount } from "@/runtime/localCarrierDestinationCapacity";
import {
  getTerminalActionEnergyOwnershipBudget,
  getTerminalActionRequiredEnergy,
} from "@/runtime/terminalActionEnergyOwnership";

type ResourceControlState = "survival" | "balanced" | "export";
type ResourceCapacityState = CapacityState;
type ResourceThresholdMap = Partial<Record<ResourceConstant, number>>;

const BASE_MINERALS: ResourceConstant[] = [
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
];
const DEFAULT_MARKET_SELL_RESOURCES: ResourceConstant[] = [...BASE_MINERALS];

const HUB_INTERMEDIATES: ResourceConstant[] = [
  RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE,
  RESOURCE_GHODIUM,
  RESOURCE_UTRIUM_HYDRIDE,
  RESOURCE_UTRIUM_OXIDE,
  RESOURCE_KEANIUM_HYDRIDE,
  RESOURCE_KEANIUM_OXIDE,
  RESOURCE_LEMERGIUM_HYDRIDE,
  RESOURCE_LEMERGIUM_OXIDE,
  RESOURCE_ZYNTHIUM_HYDRIDE,
  RESOURCE_ZYNTHIUM_OXIDE,
  RESOURCE_GHODIUM_HYDRIDE,
  RESOURCE_GHODIUM_OXIDE,
  RESOURCE_UTRIUM_ACID,
  RESOURCE_UTRIUM_ALKALIDE,
  RESOURCE_KEANIUM_ACID,
  RESOURCE_KEANIUM_ALKALIDE,
  RESOURCE_LEMERGIUM_ACID,
  RESOURCE_LEMERGIUM_ALKALIDE,
  RESOURCE_ZYNTHIUM_ACID,
  RESOURCE_ZYNTHIUM_ALKALIDE,
  RESOURCE_GHODIUM_ACID,
  RESOURCE_GHODIUM_ALKALIDE,
];

interface ResourceControlRoomConfig extends RoomEnergyPolicy {
  transferBatchSize: number;
  mineralFloor: ResourceThresholdMap;
  mineralExportStart: ResourceThresholdMap;
}

interface ResourceControlMarketConfig {
  enabled: boolean;
  emergencyBuyEnabled: boolean;
  nativeMineralAutoSellThreshold: number;
  maxDealsPerRun: number;
  minDealAmount: number;
  maxDealAmount: number;
  maxDealEnergyCostRatio: number;
  minSellPrice: ResourceThresholdMap;
  maxBuyPrice: ResourceThresholdMap;
  sellResources: ResourceConstant[];
  buyResources: ResourceConstant[];
}

interface ResourceCapacityConfig extends CapacityHeadroomPolicy {
  maxPlannedAmountPerTask: number;
  maxNewTasksPerRun: number;
  automaticTaskNoProgressTtl: number;
  sourceDepletedGraceTicks: number;
  receiverCapacityDemandCoverageGraceTicks: number;
  t3ReservePerRoom: number;
}

export interface ResourceControlCapacityIndexBuildCounter {
  count: number;
}

interface SynthesisProducerBinding {
  fromRoomName: string;
  updatedAt: number;
  expiresAt: number;
}

type SynthesisBindingStore = Record<string, SynthesisProducerBinding>;

interface InternalSendBudget {
  remaining: number;
}

interface ResourceControlTaskHealth {
  pendingIncoming: number;
  pendingOutgoing: number;
  blockedIncoming: Partial<
    Record<NonNullable<ResourceTransferTask["blockedReason"]>, number>
  >;
  blockedOutgoing: Partial<
    Record<NonNullable<ResourceTransferTask["blockedReason"]>, number>
  >;
}

interface CapacityReliefRoute {
  tick: number;
  taskId: string;
  fromRoomName: string;
  toRoomName: string;
  resource: ResourceConstant;
  amount: number;
  transferCost: number;
}

type ReceiverAdmissionExclusionReason =
  | "capacity_state"
  | "storage_headroom"
  | "terminal_headroom"
  | "commitment_exhausted";

type TerminalStagingSuppressionReason =
  | "receiver_capacity"
  | "source_depleted"
  | "source_inventory"
  | "fee_budget"
  | "terminal_headroom"
  | "window_limit"
  | "invalid_endpoint";

type TerminalStickyHeadroomReason =
  | "storage_full"
  | "protected_inventory"
  | "carrier_backlog"
  | "no_offloadable_resource";

interface TerminalStagingObservation {
  admittedAmount: number;
  admittedTaskCount: number;
  admittedByResource: Partial<Record<ResourceConstant, number>>;
  suppressedCount: number;
  suppressedByReason: Partial<Record<TerminalStagingSuppressionReason, number>>;
}

interface TerminalRecoveryObservation {
  desiredTerminalFreeCapacity: number;
  terminalRecoveryGap: number;
  recoverableOffloadAmount: number;
  stickyHeadroom: boolean;
  stickyHeadroomReason?: TerminalStickyHeadroomReason;
}

interface ResourceControlTransferContext {
  tasks: ResourceTransferTask[];
  taskById: Map<string, ResourceTransferTask>;
  snapshotByRoom: Map<string, ResourceControlSnapshot>;
  receiverCapacityLedger: ReceiverCapacityLedger;
  healthyOutgoingByRoomResource: Map<string, number>;
  healthyIncomingByRoomResource: Map<string, number>;
  outgoingFeeByRoom: Map<string, number>;
  outgoingFeeByTaskId: Map<string, number>;
  healthyIncomingEnergyRooms: Set<string>;
  healthyIncomingEnergyRoomRefCount: Map<string, number>;
  reservedProductionByRoomResource: Map<string, number>;
  carrierProductionByRoomResource: Map<string, number>;
  existingTerminalOffloadCreatedAtByRoomTaskId: Map<
    string,
    Map<string, number>
  >;
  previousTerminalFreeCapacityByRoom: Map<string, number>;
  stagingObservationByRoom: Map<string, TerminalStagingObservation>;
  terminalRecoveryObservationByRoom: Map<string, TerminalRecoveryObservation>;
  taskContributionById: Map<string, ResourceControlTransferTaskContribution>;
  taskContributionIndex: ResourceControlTaskContributionIndexProbe;
  marketEnergyReadinessByRoom: Map<
    string,
    MarketTerminalEnergyReadinessObservation
  >;
}

type ResourceControlCommitmentReadContext = Pick<
  ResourceControlTransferContext,
  | "taskById"
  | "snapshotByRoom"
  | "healthyOutgoingByRoomResource"
  | "outgoingFeeByRoom"
  | "outgoingFeeByTaskId"
  | "reservedProductionByRoomResource"
  | "carrierProductionByRoomResource"
> & {
  receiverCapacityLedger: Pick<ReceiverCapacityLedger, "getAvailability">;
};

interface SynthesisShadowCaptureContext
  extends ResourceControlCommitmentReadContext {
  readonly tasks: ResourceTransferTask[];
  readonly indexBuildCount: 1;
  readonly productionReservationScanCount: 1;
  readonly invalidRecordCount: number;
}

interface ResourceControlTransferTaskContribution {
  readonly outgoingKey?: string;
  readonly outgoingAmount?: number;
  readonly incomingKey?: string;
  readonly incomingAmount?: number;
  readonly outgoingFeeRoomName?: string;
  readonly outgoingFee?: number;
  readonly incomingEnergyRoomName?: string;
}

interface ResourceControlTaskContributionIndexProbe {
  initialTaskCount: number;
  syncCount: number;
  contributionEvaluationCount: number;
  productionReservationScanCount: number;
  productionReservationRecordCount: number;
  invalidProductionReservationCount: number;
}

interface TerminalStagingBatch {
  resource: ResourceConstant;
  amount: number;
  transactionFee: number;
  dispatchClass?: CarrierTaskDispatchClass;
}

interface TerminalEnergyPlanOptions {
  stagingBatch?: TerminalStagingBatch;
  legacyBacklog?: boolean;
}

export type MarketTerminalEnergyReadinessBlocker =
  | "not_authorized"
  | "authorization_invalid"
  | "authorization_expired"
  | "terminal_changed"
  | "capacity_emergency"
  | "terminal_claimed"
  | "terminal_headroom"
  | "storage_energy_floor"
  | "production_energy_ownership"
  | "terminal_capacity"
  | "energy_offload_conflict"
  | "draft_invalid";

export interface MarketTerminalEnergyReadinessContribution {
  id: string;
  amount: number;
  kind:
    | "ordinary_terminal_target"
    | "pending_energy_send"
    | "pending_internal_send_fee"
    | "terminal_production_commitment";
}

export interface MarketTerminalEnergyReadinessObservation {
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
  contributions: MarketTerminalEnergyReadinessContribution[];
  desiredTerminalEnergy: number;
  plannedFeedAmount: number;
  status: "blocked" | "ready" | "feed_planned";
  blocker?: MarketTerminalEnergyReadinessBlocker;
}

export interface MarketTerminalEnergyAuthorizedRoom {
  roomName: string;
  roomInstanceId: string;
  terminalId: string;
}

export interface MarketTerminalEnergyReadinessAuthorizationProjection {
  schemaVersion: 3;
  validated: true;
  status: "authorized";
  revision: string;
  updatedAt: number;
  expiresAt: number;
  maxTransactionEnergy: 1_000;
  sourcePermitVersion?: 2 | 3;
  rooms: Array<
    MarketTerminalEnergyAuthorizedRoom & {
      status: "authorized";
    }
  >;
}

export interface MarketTerminalEnergyAuthorizationRead {
  ok: boolean;
  reason?: "missing" | "invalid" | "expired" | "market_mode_not_direct";
  revision?: string;
  maxTransactionEnergy?: number;
  rooms: MarketTerminalEnergyAuthorizedRoom[];
}

interface TerminalStagingAttempt {
  batch?: TerminalStagingBatch;
  suppressedReason?: TerminalStagingSuppressionReason;
}

type LogisticsShadowDimension =
  | "donor"
  | "route"
  | "priority"
  | "demandCoverage"
  | "receiverHeadroom"
  | "predictedStagingEligibility";

type LogisticsShadowComparisonReason =
  | "equal"
  | SynthesisShadowComparisonClassification
  | SynthesisShadowUnresolvedReason;

type LogisticsShadowDecisionDelta =
  | "same_route"
  | "different_route"
  | "both_no_route"
  | "legacy_only_route"
  | "shadow_only_route"
  | "input_unavailable";

type LogisticsShadowDifferenceDirection =
  | "same"
  | "shadow_more_conservative"
  | "shadow_more_permissive"
  | "policy_difference"
  | "input_unavailable";

type LogisticsShadowCausalCode =
  | "matched"
  | "route_rank"
  | "route_fact_difference"
  | "legacy_blocker"
  | "input_unavailable"
  | SynthesisShadowUnmatchedReason
  | SynthesisShadowUnresolvedReason;

interface LogisticsShadowRuntimeRouteOutcomeV2 {
  kind: "route";
  sourceRoomName: string;
  coverage: SynthesisShadowCoverage;
  capacity: SynthesisShadowCapacity;
  staging: SynthesisShadowPredictedStagingEligibility;
  amount: number;
  actionAmount: number;
  feeAmount: number;
  terminalReadyAt: number;
  requiredEnergy: number;
  energyCommitmentAmount: number;
  terminalAllocatedAmount: number;
  stagingRequiredAmount: number;
  terminalEnergyAllocatedAmount: number;
  feeStagingRequiredAmount: number;
}

interface LogisticsShadowRuntimeLegacyNoneOutcomeV2 {
  kind: "none";
  blocker: SynthesisShadowUnmatchedReason;
  coverage: SynthesisShadowCoverage;
  capacity: SynthesisShadowCapacity;
  staging: SynthesisShadowPredictedStagingEligibility;
}

interface LogisticsShadowRuntimeShadowUnmatchedOutcomeV2 {
  kind: "unmatched";
  reason: SynthesisShadowUnmatchedReason;
  coverage: SynthesisShadowCoverage;
  capacity: SynthesisShadowCapacity;
  staging: SynthesisShadowPredictedStagingEligibility;
  uncoveredAmount: number;
}

type LogisticsShadowRuntimeBlocker =
  | "mode_disabled"
  | "config_invalid"
  | "store_missing"
  | "store_invalid"
  | "input_unavailable"
  | "matcher_unavailable";

interface LogisticsShadowRuntimeComparisonSampleV2 {
  intentId: string;
  targetRoomName: string;
  resource: ResourceConstant;
  status: "equal" | "different" | "unresolved";
  reason: LogisticsShadowComparisonReason;
  producerReason?: LogisticsShadowComparisonReason;
  decisionDelta: LogisticsShadowDecisionDelta;
  direction: LogisticsShadowDifferenceDirection;
  causalCode: LogisticsShadowCausalCode;
  differingDimensions: LogisticsShadowDimension[];
  legacy?:
    | LogisticsShadowRuntimeRouteOutcomeV2
    | LogisticsShadowRuntimeLegacyNoneOutcomeV2;
  shadow?:
    | LogisticsShadowRuntimeRouteOutcomeV2
    | LogisticsShadowRuntimeShadowUnmatchedOutcomeV2;
  candidate?: SynthesisShadowCandidateTrace;
}

interface LogisticsShadowDimensionSummaryV1 {
  matched: number;
  different: number;
  unresolved: number;
}

interface ResourceControlLogisticsRuntimeV2 {
  schemaVersion: 2;
  updatedAt: number;
  expiresAt: number;
  requestedMode: "disabled" | "shadow" | "canary" | "enabled";
  effectiveAuthority: "legacy";
  available: boolean;
  complete: boolean;
  projectionTruncated: boolean;
  blocker?: LogisticsShadowRuntimeBlocker;
  inScopeByOrigin: Partial<Record<LogisticsRolloutOrigin, number>>;
  outOfScopeByOrigin: Partial<Record<LogisticsRolloutOrigin, number>>;
  intent: {
    total: number;
    active: number;
    fresh: number;
    stale: number;
    paired: number;
    inputDrift: number;
    emitted: number;
    dropped: number;
    truncated: boolean;
  };
  comparison: {
    total: number;
    matched: number;
    different: number;
    unresolved: number;
    byReason: Partial<Record<LogisticsShadowComparisonReason, number>>;
    byDecisionDelta: Partial<Record<LogisticsShadowDecisionDelta, number>>;
    byCausalCode: Partial<Record<LogisticsShadowCausalCode, number>>;
    dimensions: Record<
      LogisticsShadowDimension,
      LogisticsShadowDimensionSummaryV1
    >;
    sampled: number;
    detailsDropped: number;
    samples: LogisticsShadowRuntimeComparisonSampleV2[];
  };
  matcher: {
    indexBuilds: number;
    candidateEvaluations: number;
    transactionCostEvaluations: number;
    totalTransactionCostEvaluations: number;
    candidateBudget: number;
    budgetExhausted: boolean;
    continuationCursor?: string;
  };
  safety: {
    measurementBoundary: "observable_state_diff_v1";
    nonLegacyAuthorityRecords: number;
    activeContracts: number;
    activeLeases: number;
    activeClaims: number;
    shadowArbiterActorRecords: number;
    shadowClaimRecords: number;
    shadowJournalRecords: number;
    shadowCarrierTaskRecords: number;
    shadowReceiverReservationRecords: number;
    violations: string[];
  };
  resources: {
    dataItems: number;
    runtimeItems: number;
    dataBytes: number;
    runtimeBytes: number;
    totalBytes: number;
    withinLimit: boolean;
  };
  cpu: {
    attributionVersion: 2;
    sampleTick: number;
    measurementAvailable: boolean;
    producerUsed: number;
    consumerUsed: number;
  };
}

interface LogisticsShadowSelfExclusion {
  outgoingByRoomResource: Map<string, number>;
  incomingByRoomResource: Map<string, number>;
  incomingByRoom: Map<string, number>;
  feeByRoom: Map<string, number>;
}

interface LogisticsShadowCapturedSourceFacts {
  actionEnergyBudgetByRoom: ReadonlyMap<string, number>;
  sourceAvailableByRoomResource: ReadonlyMap<string, number>;
  terminalOutsideExposureByRoomResource: ReadonlyMap<string, number>;
}

interface LogisticsShadowInputRecord {
  intent: LatestLogisticsDemandV1;
  observation?: SynthesisLogisticsObservationV1;
  inputRevision: string;
  inputDrift: boolean;
}

const LOGISTICS_SHADOW_DIMENSIONS: readonly LogisticsShadowDimension[] = [
  "donor",
  "route",
  "priority",
  "demandCoverage",
  "receiverHeadroom",
  "predictedStagingEligibility",
];
const LOGISTICS_SHADOW_MEMORY_LIMIT_BYTES = 32_768;
const LOGISTICS_SHADOW_RUNTIME_LIMIT_BYTES = 16_384;
const LOGISTICS_SHADOW_MAX_VIOLATIONS = 20;
const LOGISTICS_SHADOW_CAUSAL_SAMPLE_LIMIT = 8;

const MAX_RECENT_CAPACITY_RELIEF_ROUTES = 20;

export interface ResourceControlSnapshot {
  roomName: string;
  state: ResourceControlState;
  capacityState: ResourceCapacityState;
  storageUsedCapacity: number;
  storageFreeCapacity: number;
  terminalUsedCapacity: number;
  terminalFreeCapacity: number;
  storageEnergy: number;
  terminalEnergy: number;
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
  transferBatchSize: number;
  terminalCooldown?: number;
  storageResourceAmounts?: Partial<Record<ResourceConstant, number>>;
  terminalResourceAmounts?: Partial<Record<ResourceConstant, number>>;
  nativeMineralType?: MineralConstant;
  canMineNative: boolean;
  mineralFloor: ResourceThresholdMap;
  mineralExportStart: ResourceThresholdMap;
  storage?: StructureStorage;
  terminal: StructureTerminal;
}

const DEFAULT_INTERVAL = 10;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 100;
const DEFAULT_TASK_MAX_PER_RUN = 5;
const MIN_TASK_MAX_PER_RUN = 1;
const MAX_TASK_MAX_PER_RUN = 5;
const RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER = "resourceControl:preload";
const RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY = 80;
const RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY = 90;
const TERMINAL_STORAGE_CAPACITY = 300_000;
// 新恢复路径为 normal 房间预留默认 20k 的可承诺接收窗口：
// 60k 日常空闲 - 40k 默认 receiver 账本安全保留。
const NORMAL_TERMINAL_TARGET_FREE_CAPACITY = 60_000;
// 关闭 terminalHeadroomRecoveryEnabled 时保留的 legacy 使用量阈值。
const TERMINAL_TOTAL_STORAGE_CAP = 250_000;
const MARKET_TERMINAL_ENERGY_SCHEMA_VERSION = 3;
const MARKET_TERMINAL_ENERGY_MAX_TRANSACTION_ENERGY = 1_000;
const MARKET_TERMINAL_ENERGY_BASE_RESERVE = 25_000;
const MARKET_TERMINAL_ENERGY_MIN_FREE_CAPACITY = 40_000;
const MARKET_TERMINAL_ENERGY_EVIDENCE_TTL = 1;
const MARKET_TERMINAL_ENERGY_AUTH_MAX_TTL = 100;
const MARKET_TERMINAL_ENERGY_MAX_AUTHORIZED_ROOMS = 16;
const MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS = 64;

/**
 * 永久关闭 ResourceControl 和旧 Hub surplus 的所有出售写路径。
 *
 * 生产缺口和生存用途的购买仍由 emergencyBuyEnabled 单独控制。现代出售只能
 * 通过经过 permit/WAL 校验的 Direct automation 进入 market arbiter。
 */
export const LEGACY_RESOURCE_CONTROL_SELLER_PERMANENTLY_DISABLED = true;
const DEFAULT_CAPACITY_CONFIG: ResourceCapacityConfig = {
  ...DEFAULT_CAPACITY_HEADROOM_POLICY,
  maxPlannedAmountPerTask: 50_000,
  maxNewTasksPerRun: 5,
  automaticTaskNoProgressTtl: 5_000,
  sourceDepletedGraceTicks: 100,
  receiverCapacityDemandCoverageGraceTicks:
    DEFAULT_RECEIVER_CAPACITY_DEMAND_COVERAGE_GRACE_TICKS,
  t3ReservePerRoom: 5_000,
};

const DEFAULT_ROOM_CONFIG: Omit<
  ResourceControlRoomConfig,
  keyof RoomEnergyPolicy
> = {
  transferBatchSize: 10_000,
  mineralFloor: {
    [RESOURCE_HYDROGEN]: 5_000,
    [RESOURCE_OXYGEN]: 5_000,
    [RESOURCE_UTRIUM]: 5_000,
    [RESOURCE_LEMERGIUM]: 5_000,
    [RESOURCE_KEANIUM]: 5_000,
    [RESOURCE_ZYNTHIUM]: 5_000,
    [RESOURCE_CATALYST]: 3_000,
  },
  mineralExportStart: {
    [RESOURCE_HYDROGEN]: 15_000,
    [RESOURCE_OXYGEN]: 15_000,
    [RESOURCE_UTRIUM]: 15_000,
    [RESOURCE_LEMERGIUM]: 15_000,
    [RESOURCE_KEANIUM]: 15_000,
    [RESOURCE_ZYNTHIUM]: 15_000,
    [RESOURCE_CATALYST]: 10_000,
  },
};

const DEFAULT_MARKET_CONFIG: ResourceControlMarketConfig = {
  enabled: false,
  emergencyBuyEnabled: true,
  nativeMineralAutoSellThreshold: 10_000,
  maxDealsPerRun: 1,
  minDealAmount: 1_000,
  maxDealAmount: 10_000,
  maxDealEnergyCostRatio: 0.35,
  minSellPrice: {},
  maxBuyPrice: {
    [RESOURCE_ENERGY]: 0.12,
  },
  sellResources: DEFAULT_MARKET_SELL_RESOURCES,
  buyResources: BASE_MINERALS,
};

function normalizeInterval(value: unknown): number {
  return normalizeNumber(value, DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL);
}

function normalizeTaskMaxPerRun(value: unknown): number {
  return normalizeNumber(
    value,
    DEFAULT_TASK_MAX_PER_RUN,
    MIN_TASK_MAX_PER_RUN,
    MAX_TASK_MAX_PER_RUN,
  );
}

function normalizeResourceThresholdMap(
  value: unknown,
  fallback: ResourceThresholdMap,
  min: number,
  max: number,
): ResourceThresholdMap {
  const map =
    value && typeof value === "object"
      ? (value as Partial<Record<ResourceConstant, unknown>>)
      : {};
  const next: ResourceThresholdMap = {};

  for (const resource of Object.keys(fallback) as ResourceConstant[]) {
    next[resource] = normalizeNumber(
      map[resource],
      fallback[resource] || 0,
      min,
      max,
    );
  }

  for (const resource of BASE_MINERALS) {
    if (next[resource] === undefined) {
      next[resource] = normalizeNumber(
        map[resource],
        fallback[resource] || 0,
        min,
        max,
      );
    }
  }

  return next;
}

function normalizeResourceList(
  value: unknown,
  fallback: ResourceConstant[],
): ResourceConstant[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value.filter(
    (item): item is ResourceConstant =>
      typeof item === "string" && item.length > 0,
  );
  return normalized.length > 0 ? normalized : [...fallback];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 从 canonical outer Direct + permit/ledger/scope/grant 重建授权；nested
 * readiness 投影必须与重建结果逐字一致，`validated=true` 本身没有权限。
 */
export function parseMarketTerminalEnergyReadinessAuthorization(
  rawDirectAutomation: unknown,
  marketMode: unknown,
  currentTick: number,
): MarketTerminalEnergyAuthorizationRead {
  if (marketMode !== "direct") {
    return { ok: false, reason: "market_mode_not_direct", rooms: [] };
  }
  if (!Number.isSafeInteger(currentTick) || currentTick < 0) {
    return { ok: false, reason: "invalid", rooms: [] };
  }
  if (rawDirectAutomation === undefined || rawDirectAutomation === null) {
    return { ok: false, reason: "missing", rooms: [] };
  }
  if (!isPlainRecord(rawDirectAutomation)) {
    return { ok: false, reason: "invalid", rooms: [] };
  }
  const canonical = deriveMarketBaseResourceCanonicalReadinessAuthorization(
    rawDirectAutomation,
    marketMode,
    currentTick,
  );
  if (!canonical.ok) {
    return {
      ok: false,
      reason:
        canonical.reason === "expired"
          ? "expired"
          : canonical.reason === "missing"
            ? "missing"
            : "invalid",
      rooms: [],
    };
  }
  return {
    ok: true,
    revision: canonical.revision,
    maxTransactionEnergy: canonical.maxTransactionEnergy,
    rooms: canonical.rooms,
  };
}

function readMarketTerminalEnergyReadinessAuthorization(): MarketTerminalEnergyAuthorizationRead {
  const marketData = isPlainRecord(Memory.data?.marketSaleAutomation)
    ? Memory.data?.marketSaleAutomation
    : undefined;
  return parseMarketTerminalEnergyReadinessAuthorization(
    marketData,
    Memory.cfg?.marketSaleAutomation?.mode,
    Game.time,
  );
}

function normalizeRoomConfig(value: unknown): ResourceControlRoomConfig {
  const config =
    value && typeof value === "object"
      ? (value as Partial<ResourceControlRoomConfig>)
      : {};
  const energyPolicy = resolveRoomEnergyPolicy(config);
  const transferBatchSize = normalizeNumber(
    config.transferBatchSize,
    DEFAULT_ROOM_CONFIG.transferBatchSize,
    100,
    50_000,
  );
  const mineralFloor = normalizeResourceThresholdMap(
    config.mineralFloor,
    DEFAULT_ROOM_CONFIG.mineralFloor,
    0,
    500_000,
  );
  const mineralExportStart = normalizeResourceThresholdMap(
    config.mineralExportStart,
    DEFAULT_ROOM_CONFIG.mineralExportStart,
    0,
    1_000_000,
  );

  for (const resource of BASE_MINERALS) {
    const floor = mineralFloor[resource] || 0;
    const exportStart = mineralExportStart[resource] || 0;
    if (exportStart < floor) {
      mineralExportStart[resource] = floor;
    }
  }

  return {
    ...energyPolicy,
    transferBatchSize,
    mineralFloor,
    mineralExportStart,
  };
}

function normalizeMarketConfig(value: unknown): ResourceControlMarketConfig {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: normalizeBoolean(raw.enabled, DEFAULT_MARKET_CONFIG.enabled),
    emergencyBuyEnabled: normalizeBoolean(
      raw.emergencyBuyEnabled,
      DEFAULT_MARKET_CONFIG.emergencyBuyEnabled,
    ),
    nativeMineralAutoSellThreshold: normalizeNumber(
      raw.nativeMineralAutoSellThreshold,
      DEFAULT_MARKET_CONFIG.nativeMineralAutoSellThreshold,
      0,
      1_000_000,
    ),
    maxDealsPerRun: normalizeNumber(
      raw.maxDealsPerRun,
      DEFAULT_MARKET_CONFIG.maxDealsPerRun,
      1,
      5,
    ),
    minDealAmount: normalizeNumber(
      raw.minDealAmount,
      DEFAULT_MARKET_CONFIG.minDealAmount,
      100,
      20_000,
    ),
    maxDealAmount: normalizeNumber(
      raw.maxDealAmount,
      DEFAULT_MARKET_CONFIG.maxDealAmount,
      500,
      50_000,
    ),
    maxDealEnergyCostRatio: Math.max(
      0,
      Math.min(
        5,
        typeof raw.maxDealEnergyCostRatio === "number"
          ? raw.maxDealEnergyCostRatio
          : DEFAULT_MARKET_CONFIG.maxDealEnergyCostRatio,
      ),
    ),
    minSellPrice: normalizeResourceThresholdMap(
      raw.minSellPrice,
      DEFAULT_MARKET_CONFIG.minSellPrice,
      0,
      1000,
    ),
    maxBuyPrice: normalizeResourceThresholdMap(
      raw.maxBuyPrice,
      DEFAULT_MARKET_CONFIG.maxBuyPrice,
      0,
      1000,
    ),
    sellResources: normalizeResourceList(
      raw.sellResources,
      DEFAULT_MARKET_CONFIG.sellResources,
    ),
    buyResources: normalizeResourceList(
      raw.buyResources,
      DEFAULT_MARKET_CONFIG.buyResources,
    ),
  };
}

export function normalizeCapacityConfig(
  value: unknown,
): ResourceCapacityConfig {
  const raw =
    value && typeof value === "object"
      ? (value as Partial<ResourceCapacityConfig>)
      : {};
  return {
    ...normalizeCapacityHeadroomPolicy(raw),
    maxPlannedAmountPerTask: normalizeNumber(
      raw.maxPlannedAmountPerTask,
      DEFAULT_CAPACITY_CONFIG.maxPlannedAmountPerTask,
      100,
      300_000,
    ),
    maxNewTasksPerRun: normalizeNumber(
      raw.maxNewTasksPerRun,
      DEFAULT_CAPACITY_CONFIG.maxNewTasksPerRun,
      1,
      5,
    ),
    automaticTaskNoProgressTtl: normalizeNumber(
      raw.automaticTaskNoProgressTtl,
      DEFAULT_CAPACITY_CONFIG.automaticTaskNoProgressTtl,
      100,
      100_000,
    ),
    sourceDepletedGraceTicks: normalizeNumber(
      raw.sourceDepletedGraceTicks,
      DEFAULT_CAPACITY_CONFIG.sourceDepletedGraceTicks,
      1,
      5_000,
    ),
    receiverCapacityDemandCoverageGraceTicks: normalizeNumber(
      raw.receiverCapacityDemandCoverageGraceTicks,
      DEFAULT_CAPACITY_CONFIG.receiverCapacityDemandCoverageGraceTicks,
      50,
      5_000,
    ),
    t3ReservePerRoom: normalizeNumber(
      raw.t3ReservePerRoom,
      DEFAULT_CAPACITY_CONFIG.t3ReservePerRoom,
      0,
      500_000,
    ),
  };
}

export function resolveRoomConfig(roomName: string): ResourceControlRoomConfig {
  const cfg = Memory.cfg?.resourceControl;
  const roomConfigRaw = cfg?.rooms ? cfg.rooms[roomName] : undefined;
  return normalizeRoomConfig(roomConfigRaw);
}

function resolveMarketConfig(): ResourceControlMarketConfig {
  const cfg = Memory.cfg?.resourceControl;
  return normalizeMarketConfig(cfg?.market);
}

function resolveCapacityConfig(): ResourceCapacityConfig {
  return normalizeCapacityConfig(
    Memory.cfg?.resourceControl?.capacityBalancing,
  );
}

function getSynthesisDemandTarget(
  roomName: string,
  resource: ResourceConstant,
): number {
  const value =
    Memory.cfg?.resourceControl?.synthesis?.rooms?.[roomName]?.demands?.[
      resource
    ];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function getActiveSynthesisMissing(
  roomName: string,
  resource: ResourceConstant,
): number {
  const value =
    Memory.runtime?.synthesisControl?.rooms?.[roomName]?.missing?.[resource];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function resolveTaskMaxPerRun(): number {
  return normalizeTaskMaxPerRun(Memory.cfg?.resourceControl?.taskMaxPerRun);
}

export function getResourceControlSampleInterval(): number {
  return normalizeInterval(Memory.cfg?.resourceControl?.sampleInterval);
}

export function isResourceControlFullPlanningTick(): boolean {
  return Game.time % getResourceControlSampleInterval() === 0;
}

function resolveState(
  storageEnergy: number,
  config: ResourceControlRoomConfig,
): ResourceControlState {
  if (storageEnergy < config.energyFloor) {
    return "survival";
  }
  if (storageEnergy >= config.energyExportStart) {
    return "export";
  }
  return "balanced";
}

export function collectResourceControlSnapshots(
  capturedResources?: readonly ResourceConstant[],
): ResourceControlSnapshot[] {
  const rooms = getTickContextService()
    .getMyRooms()
    .filter((room) => !!room.terminal);
  const capacityConfig = resolveCapacityConfig();

  return rooms.map((room) => {
    const config = resolveRoomConfig(room.name);
    const storageEnergy =
      room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    const terminalEnergy =
      room.terminal?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    const storageUsedCapacity = room.storage?.store.getUsedCapacity() || 0;
    const storageFreeCapacity = room.storage?.store.getFreeCapacity() || 0;
    const terminalUsedCapacity = room.terminal?.store.getUsedCapacity() || 0;
    const terminalFreeCapacity = room.terminal?.store.getFreeCapacity() || 0;
    const storageResourceAmounts: Partial<
      Record<ResourceConstant, number>
    > = {};
    const terminalResourceAmounts: Partial<
      Record<ResourceConstant, number>
    > = {};
    const snapshotResources = capturedResources ?? RESOURCES_ALL;
    for (const resource of snapshotResources) {
      terminalResourceAmounts[resource] =
        resource === RESOURCE_ENERGY
          ? terminalEnergy
          : room.terminal?.store.getUsedCapacity(resource) || 0;
      if (capturedResources) {
        storageResourceAmounts[resource] =
          resource === RESOURCE_ENERGY
            ? storageEnergy
            : room.storage?.store.getUsedCapacity(resource) || 0;
      }
    }
    const previousCapacityState =
      Memory.runtime?.resourceControl?.rooms?.[room.name]?.capacityState;
    const mineral = room.find(FIND_MINERALS)[0] || null;
    const extractor = room.find(FIND_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_EXTRACTOR,
    })[0] as StructureExtractor | undefined;

    return {
      roomName: room.name,
      state: resolveState(storageEnergy, config),
      capacityState: room.storage
        ? resolveCapacityState(
            storageFreeCapacity,
            terminalFreeCapacity,
            capacityConfig,
            previousCapacityState,
          )
        : "normal",
      storageUsedCapacity,
      storageFreeCapacity,
      terminalUsedCapacity,
      terminalFreeCapacity,
      storageEnergy,
      terminalEnergy,
      energyFloor: config.energyFloor,
      energyTarget: config.energyTarget,
      energyExportStart: config.energyExportStart,
      terminalEnergyReserve: config.terminalEnergyReserve,
      transferBatchSize: config.transferBatchSize,
      terminalResourceAmounts,
      ...(capturedResources
        ? {
            terminalCooldown: room.terminal?.cooldown || 0,
            storageResourceAmounts,
          }
        : {}),
      nativeMineralType: mineral?.mineralType,
      canMineNative: !!mineral && !!extractor,
      mineralFloor: config.mineralFloor,
      mineralExportStart: config.mineralExportStart,
      storage: room.storage || undefined,
      terminal: room.terminal as StructureTerminal,
    };
  });
}

function getTerminalResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const projected = snapshot.terminalResourceAmounts?.[resource];
  return typeof projected === "number"
    ? projected
    : snapshot.terminal.store.getUsedCapacity(resource);
}

function setTerminalResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
): void {
  snapshot.terminalResourceAmounts = snapshot.terminalResourceAmounts || {};
  snapshot.terminalResourceAmounts[resource] = Math.max(0, Math.floor(amount));
}

function getStorageResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const projected = snapshot.storageResourceAmounts?.[resource];
  return typeof projected === "number"
    ? projected
    : snapshot.storage?.store.getUsedCapacity(resource) || 0;
}

function getStock(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  if (resource === RESOURCE_ENERGY) {
    return snapshot.storageEnergy + snapshot.terminalEnergy;
  }
  return (
    getStorageResourceAmount(snapshot, resource) +
    getTerminalResourceAmount(snapshot, resource)
  );
}

function isEnergyExportEligible(snapshot: ResourceControlSnapshot): boolean {
  return snapshot.storageEnergy >= snapshot.energyExportStart;
}

function roomResourceKey(roomName: string, resource: ResourceConstant): string {
  return `${roomName}:${resource}`;
}

function createTerminalStagingObservation(): TerminalStagingObservation {
  return {
    admittedAmount: 0,
    admittedTaskCount: 0,
    admittedByResource: {},
    suppressedCount: 0,
    suppressedByReason: {},
  };
}

function getTerminalStagingObservation(
  context: ResourceControlTransferContext,
  roomName: string,
): TerminalStagingObservation {
  const existing = context.stagingObservationByRoom.get(roomName);
  if (existing) return existing;
  const observation = createTerminalStagingObservation();
  context.stagingObservationByRoom.set(roomName, observation);
  return observation;
}

function recordTerminalStagingAdmission(
  context: ResourceControlTransferContext,
  roomName: string,
  batch: TerminalStagingBatch,
  taskBacked = true,
): void {
  const observation = getTerminalStagingObservation(context, roomName);
  observation.admittedAmount += batch.amount;
  if (taskBacked) {
    observation.admittedTaskCount += 1;
  }
  observation.admittedByResource[batch.resource] =
    (observation.admittedByResource[batch.resource] || 0) + batch.amount;
}

function recordTerminalStagingSuppression(
  context: ResourceControlTransferContext,
  roomName: string,
  reason: TerminalStagingSuppressionReason,
): void {
  const observation = getTerminalStagingObservation(context, roomName);
  observation.suppressedCount += 1;
  observation.suppressedByReason[reason] =
    (observation.suppressedByReason[reason] || 0) + 1;
}

export function createResourceControlTransferContext(
  snapshots: ResourceControlSnapshot[],
  capacityConfig: ResourceCapacityConfig,
  buildCounter: ResourceControlCapacityIndexBuildCounter,
  options: { readonlyCarrierBoard?: boolean } = {},
): ResourceControlTransferContext {
  buildCounter.count += 1;
  const tasks = getResourceTransferTaskListSorted();
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  const healthyOutgoingByRoomResource = new Map<string, number>();
  const healthyIncomingByRoomResource = new Map<string, number>();
  const outgoingFeeByRoom = new Map<string, number>();
  const outgoingFeeByTaskId = new Map<string, number>();
  const healthyIncomingEnergyRooms = new Set<string>();
  const healthyIncomingEnergyRoomRefCount = new Map<string, number>();
  const reservedProductionByRoomResource = new Map<string, number>();
  const carrierProductionByRoomResource = new Map<string, number>();
  const existingTerminalOffloadCreatedAtByRoomTaskId = new Map<
    string,
    Map<string, number>
  >();
  const previousTerminalFreeCapacityByRoom = new Map<string, number>();
  const stagingObservationByRoom = new Map<
    string,
    TerminalStagingObservation
  >();
  const terminalRecoveryObservationByRoom = new Map<
    string,
    TerminalRecoveryObservation
  >();
  const taskContributionById = new Map<
    string,
    ResourceControlTransferTaskContribution
  >();
  const taskContributionIndex: ResourceControlTaskContributionIndexProbe = {
    initialTaskCount: tasks.length,
    syncCount: 0,
    contributionEvaluationCount: 0,
    productionReservationScanCount: 1,
    productionReservationRecordCount: 0,
    invalidProductionReservationCount: 0,
  };
  const productionReservations = listProductionReservations();
  taskContributionIndex.productionReservationRecordCount =
    productionReservations.length;
  for (const reservation of productionReservations) {
    if (reservation.expiresAt < Game.time) continue;
    const key = roomResourceKey(reservation.roomName, reservation.resource);
    if (
      !Number.isSafeInteger(reservation.amount) ||
      reservation.amount <= 0
    ) {
      taskContributionIndex.invalidProductionReservationCount += 1;
    }
    const previousAmount = reservedProductionByRoomResource.has(key)
      ? reservedProductionByRoomResource.get(key)!
      : 0;
    reservedProductionByRoomResource.set(
      key,
      previousAmount + reservation.amount,
    );
  }
  const marketEnergyReadinessByRoom = new Map<
    string,
    MarketTerminalEnergyReadinessObservation
  >();
  const receiverCapacityLedger = createReceiverCapacityLedger({
    receivers: snapshots
      .filter((snapshot) => !!snapshot.storage)
      .map((snapshot) => ({
        roomName: snapshot.roomName,
        storageFreeCapacity: snapshot.storageFreeCapacity,
        terminalFreeCapacity: snapshot.terminalFreeCapacity,
        getTerminalResourceFreeCapacity: (resource: ResourceConstant) =>
          getReceiverTerminalFreeCapacity(snapshot, resource),
      })),
    tasks,
    storageSafetyReserve: capacityConfig.storagePressureFreeCapacity,
    terminalSafetyReserve: capacityConfig.terminalPressureFreeCapacity,
    isTaskEndpointValid: (task) =>
      !!snapshotByRoom.get(task.fromRoomName)?.storage &&
      !!snapshotByRoom.get(task.toRoomName)?.storage,
    isTaskHealthy: (task) =>
      isHealthyReceiverCapacityCommitment(
        task,
        capacityConfig.automaticTaskNoProgressTtl,
      ),
  });

  for (const snapshot of snapshots) {
    const previousTerminalFreeCapacity =
      Memory.runtime?.resourceControl?.rooms[snapshot.roomName]
        ?.terminalFreeCapacity;
    if (typeof previousTerminalFreeCapacity === "number") {
      previousTerminalFreeCapacityByRoom.set(
        snapshot.roomName,
        previousTerminalFreeCapacity,
      );
    }
    stagingObservationByRoom.set(
      snapshot.roomName,
      createTerminalStagingObservation(),
    );
    const carrierTasks = options.readonlyCarrierBoard
      ? peekCarrierTasksByRoom(snapshot.roomName).map((entry) => entry.task)
      : listCarrierTasksByRoom(snapshot.roomName);
    for (const task of carrierTasks) {
      if (
        task.producer === RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER &&
        task.type === "terminal_offload"
      ) {
        const offloadsByTaskId =
          existingTerminalOffloadCreatedAtByRoomTaskId.get(snapshot.roomName) ||
          new Map<string, number>();
        offloadsByTaskId.set(task.id, task.createdAt);
        existingTerminalOffloadCreatedAtByRoomTaskId.set(
          snapshot.roomName,
          offloadsByTaskId,
        );
      }
      if (task.type !== "lab_supply" && task.type !== "factory_supply")
        continue;
      for (const step of task.steps) {
        if (step.fromKind !== "storage" && step.fromKind !== "terminal")
          continue;
        const key = roomResourceKey(snapshot.roomName, step.resource);
        carrierProductionByRoomResource.set(
          key,
          (carrierProductionByRoomResource.get(key) || 0) + step.amount,
        );
      }
    }
  }

  const context: ResourceControlTransferContext = {
    tasks,
    taskById,
    snapshotByRoom,
    receiverCapacityLedger,
    healthyOutgoingByRoomResource,
    healthyIncomingByRoomResource,
    outgoingFeeByRoom,
    outgoingFeeByTaskId,
    healthyIncomingEnergyRooms,
    healthyIncomingEnergyRoomRefCount,
    reservedProductionByRoomResource,
    carrierProductionByRoomResource,
    existingTerminalOffloadCreatedAtByRoomTaskId,
    previousTerminalFreeCapacityByRoom,
    stagingObservationByRoom,
    terminalRecoveryObservationByRoom,
    taskContributionById,
    taskContributionIndex,
    marketEnergyReadinessByRoom,
  };
  for (const task of tasks) {
    const contribution = deriveResourceControlTransferTaskContribution(
      context,
      task,
    );
    context.taskContributionById.set(task.id, contribution);
    applyResourceControlTransferTaskContribution(
      context,
      task.id,
      contribution,
      1,
    );
  }
  return context;
}

/**
 * 写前 Shadow 只需要不可变 commitment/headroom 读模型，不需要 executor
 * 的 staging/recovery/market-readiness bookkeeping。这里让 task、reservation
 * 与 Carrier board 各只经过一次只读 pass；正式 ResourceControl phase 仍会
 * 在后续 production phases 之后重建完整 context，绝不复用这份写前状态执行。
 */
function isValidSynthesisShadowCaptureTask(
  value: unknown,
): value is ResourceTransferTask {
  if (!isPlainRecord(value)) return false;
  const amount = value.amount;
  const remainingAmount = value.remainingAmount;
  const status = value.status;
  const origin = value.origin;
  return (
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.fromRoomName === "string" && value.fromRoomName.length > 0 &&
    typeof value.toRoomName === "string" && value.toRoomName.length > 0 &&
    value.fromRoomName !== value.toRoomName &&
    typeof value.resource === "string" &&
    RESOURCES_ALL.includes(value.resource as ResourceConstant) &&
    Number.isSafeInteger(amount) && (amount as number) > 0 &&
    Number.isSafeInteger(remainingAmount) &&
    (remainingAmount as number) >= 0 &&
    (remainingAmount as number) <= (amount as number) &&
    (status === "pending" || status === "done" ||
      status === "cancelled" || status === "failed") &&
    (origin === "manual" || origin === "automatic") &&
    Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0 &&
    Number.isSafeInteger(value.updatedAt) && (value.updatedAt as number) >= 0 &&
    Number.isSafeInteger(value.lastProgressAt) &&
    (value.lastProgressAt as number) >= 0 &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.lastError === undefined || typeof value.lastError === "string") &&
    (value.blockedReason === undefined ||
      value.blockedReason === "receiver_capacity" ||
      value.blockedReason === "source_depleted" ||
      value.blockedReason === "insufficient_terminal_resource_or_fee") &&
    (value.blockedSince === undefined ||
      (Number.isSafeInteger(value.blockedSince) &&
        (value.blockedSince as number) >= 0))
  );
}

function createSynthesisShadowCaptureContext(
  snapshots: ResourceControlSnapshot[],
  capacityConfig: ResourceCapacityConfig,
  buildCounter: ResourceControlCapacityIndexBuildCounter,
): SynthesisShadowCaptureContext {
  buildCounter.count += 1;
  let taskReadFailed = false;
  let tasks: ResourceTransferTask[] = [];
  try {
    tasks = getResourceTransferTaskListSorted();
  } catch {
    taskReadFailed = true;
  }
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  const healthyOutgoingByRoomResource = new Map<string, number>();
  const healthyIncomingByRoomResource = new Map<string, number>();
  const healthyIncomingTotalByRoom = new Map<string, number>();
  const outgoingFeeByRoom = new Map<string, number>();
  const outgoingFeeByTaskId = new Map<string, number>();
  const reservedProductionByRoomResource = new Map<string, number>();
  const carrierProductionByRoomResource = new Map<string, number>();
  let invalidRecordCount = taskReadFailed ? 1 : 0;
  const seenTaskIds = new Set<string>();
  const validTasks: ResourceTransferTask[] = [];
  for (const task of tasks as unknown[]) {
    if (
      !isValidSynthesisShadowCaptureTask(task) ||
      seenTaskIds.has(task.id)
    ) {
      invalidRecordCount += 1;
      continue;
    }
    seenTaskIds.add(task.id);
    validTasks.push(task);
  }
  const taskById = new Map(
    validTasks.map((task) => [task.id, task] as const),
  );

  let productionReservations: ReturnType<typeof listProductionReservations> = [];
  try {
    productionReservations = listProductionReservations();
  } catch {
    invalidRecordCount += 1;
  }
  for (const reservation of productionReservations as readonly unknown[]) {
    if (
      !isPlainRecord(reservation) ||
      typeof reservation.roomName !== "string" ||
      reservation.roomName.length === 0 ||
      typeof reservation.resource !== "string" ||
      !RESOURCES_ALL.includes(reservation.resource as ResourceConstant) ||
      typeof reservation.holderId !== "string" ||
      reservation.holderId.length === 0 ||
      !Number.isSafeInteger(reservation.updatedAt) ||
      !Number.isSafeInteger(reservation.expiresAt) ||
      (reservation.updatedAt as number) < 0 ||
      (reservation.expiresAt as number) < 0 ||
      !Number.isSafeInteger(reservation.amount) ||
      (reservation.amount as number) <= 0
    ) {
      invalidRecordCount += 1;
      continue;
    }
    if ((reservation.expiresAt as number) < Game.time) continue;
    const key = roomResourceKey(
      reservation.roomName,
      reservation.resource as ResourceConstant,
    );
    reservedProductionByRoomResource.set(
      key,
      (reservedProductionByRoomResource.get(key) || 0) +
        (reservation.amount as number),
    );
  }

  for (const snapshot of snapshots) {
    let carrierEntries: readonly unknown[];
    try {
      carrierEntries = peekCarrierTasksByRoom(snapshot.roomName) as readonly unknown[];
    } catch {
      invalidRecordCount += 1;
      continue;
    }
    for (const entry of carrierEntries) {
      if (!isPlainRecord(entry)) {
        invalidRecordCount += 1;
        continue;
      }
      const task = entry.task;
      if (!isPlainRecord(task) || typeof task.type !== "string") {
        invalidRecordCount += 1;
        continue;
      }
      if (task.type !== "lab_supply" && task.type !== "factory_supply") {
        continue;
      }
      if (!Array.isArray(task.steps)) {
        invalidRecordCount += 1;
        continue;
      }
      const productionSteps: Array<{
        fromKind: "storage" | "terminal";
        resource: ResourceConstant;
        amount: number;
      }> = [];
      let taskValid = true;
      for (const step of task.steps) {
        if (!isPlainRecord(step)) {
          taskValid = false;
          break;
        }
        if (step.fromKind !== "storage" && step.fromKind !== "terminal") {
          continue;
        }
        if (
          typeof step.resource !== "string" ||
          !RESOURCES_ALL.includes(step.resource as ResourceConstant) ||
          !Number.isSafeInteger(step.amount) ||
          (step.amount as number) <= 0
        ) {
          taskValid = false;
          break;
        }
        productionSteps.push({
          fromKind: step.fromKind,
          resource: step.resource as ResourceConstant,
          amount: step.amount as number,
        });
      }
      if (!taskValid) {
        invalidRecordCount += 1;
        continue;
      }
      for (const step of productionSteps) {
        const key = roomResourceKey(snapshot.roomName, step.resource);
        carrierProductionByRoomResource.set(
          key,
          (carrierProductionByRoomResource.get(key) || 0) + step.amount,
        );
      }
    }
  }

  for (const task of validTasks) {
    if (isHealthyResourceTransferTaskReservation(task, "outgoing")) {
      const outgoingKey = roomResourceKey(task.fromRoomName, task.resource);
      adjustIndexedAmount(
        healthyOutgoingByRoomResource,
        outgoingKey,
        task.remainingAmount,
      );
      const source = snapshotByRoom.get(task.fromRoomName);
      const batchAmount = source
        ? Math.min(source.transferBatchSize, task.remainingAmount)
        : 0;
      if (batchAmount > 0) {
        let fee: number;
        try {
          fee = Game.market.calcTransactionCost(
            batchAmount,
            task.fromRoomName,
            task.toRoomName,
          );
        } catch {
          invalidRecordCount += 1;
          continue;
        }
        if (!Number.isSafeInteger(fee) || fee < 0) {
          invalidRecordCount += 1;
          continue;
        }
        if (fee > 0) {
          adjustIndexedAmount(outgoingFeeByRoom, task.fromRoomName, fee);
          outgoingFeeByTaskId.set(task.id, fee);
        }
      }
    }
    const source = snapshotByRoom.get(task.fromRoomName);
    const receiver = snapshotByRoom.get(task.toRoomName);
    if (
      !source?.storage ||
      !receiver?.storage ||
      !isHealthyReceiverCapacityCommitment(
        task,
        capacityConfig.automaticTaskNoProgressTtl,
      )
    ) {
      continue;
    }
    const amount = Math.max(0, Math.floor(task.remainingAmount));
    if (amount <= 0) continue;
    const incomingKey = roomResourceKey(task.toRoomName, task.resource);
    adjustIndexedAmount(healthyIncomingByRoomResource, incomingKey, amount);
    adjustIndexedAmount(healthyIncomingTotalByRoom, task.toRoomName, amount);
  }

  const receiverCapacityLedger: Pick<
    ReceiverCapacityLedger,
    "getAvailability"
  > = {
    getAvailability(
      roomName: string,
      resource: ResourceConstant,
    ): ReceiverCapacityAvailability {
      const snapshot = snapshotByRoom.get(roomName);
      if (!snapshot?.storage) {
        return {
          roomName,
          resource,
          storageSafeCapacity: 0,
          terminalTotalSafeCapacity: 0,
          terminalResourceFreeCapacity: 0,
          totalCommitted: 0,
          resourceCommitted: 0,
          reservationTotal: 0,
          reservationResource: 0,
          ownedReservationTotal: 0,
          ownedReservationResource: 0,
          excludedTaskAmount: 0,
          storageRemaining: 0,
          terminalTotalRemaining: 0,
          terminalResourceRemaining: 0,
          available: 0,
        };
      }
      const storageSafeCapacity = Math.max(
        0,
        Math.floor(snapshot.storageFreeCapacity) -
          capacityConfig.storagePressureFreeCapacity,
      );
      const terminalTotalSafeCapacity = Math.max(
        0,
        Math.floor(snapshot.terminalFreeCapacity) -
          capacityConfig.terminalPressureFreeCapacity,
      );
      const terminalResourceFreeCapacity = Math.max(
        0,
        Math.floor(getReceiverTerminalFreeCapacity(snapshot, resource)),
      );
      const totalCommitted =
        healthyIncomingTotalByRoom.get(roomName) || 0;
      const resourceCommitted =
        healthyIncomingByRoomResource.get(roomResourceKey(roomName, resource)) ||
        0;
      const storageRemaining = Math.max(
        0,
        storageSafeCapacity - totalCommitted,
      );
      const terminalTotalRemaining = Math.max(
        0,
        terminalTotalSafeCapacity - totalCommitted,
      );
      const terminalResourceRemaining = Math.max(
        0,
        terminalResourceFreeCapacity - resourceCommitted,
      );
      return {
        roomName,
        resource,
        storageSafeCapacity,
        terminalTotalSafeCapacity,
        terminalResourceFreeCapacity,
        totalCommitted,
        resourceCommitted,
        reservationTotal: 0,
        reservationResource: 0,
        ownedReservationTotal: 0,
        ownedReservationResource: 0,
        excludedTaskAmount: 0,
        storageRemaining,
        terminalTotalRemaining,
        terminalResourceRemaining,
        available: Math.min(
          storageRemaining,
          terminalTotalRemaining,
          terminalResourceRemaining,
        ),
      };
    },
  };

  return {
    tasks: validTasks,
    taskById,
    snapshotByRoom,
    receiverCapacityLedger,
    healthyOutgoingByRoomResource,
    outgoingFeeByRoom,
    outgoingFeeByTaskId,
    reservedProductionByRoomResource,
    carrierProductionByRoomResource,
    indexBuildCount: 1,
    productionReservationScanCount: 1,
    invalidRecordCount,
  };
}

function adjustIndexedAmount(
  index: Map<string, number>,
  key: string,
  delta: number,
): void {
  const amount = Math.max(0, (index.get(key) || 0) + delta);
  if (amount > 0) {
    index.set(key, amount);
  } else {
    index.delete(key);
  }
}

function deriveResourceControlTransferTaskContribution(
  context: ResourceControlTransferContext,
  task: ResourceTransferTask,
): ResourceControlTransferTaskContribution {
  context.taskContributionIndex.contributionEvaluationCount += 1;
  const contribution: {
    outgoingKey?: string;
    outgoingAmount?: number;
    incomingKey?: string;
    incomingAmount?: number;
    outgoingFeeRoomName?: string;
    outgoingFee?: number;
    incomingEnergyRoomName?: string;
  } = {};

  if (isHealthyResourceTransferTaskReservation(task, "outgoing")) {
    contribution.outgoingKey = roomResourceKey(
      task.fromRoomName,
      task.resource,
    );
    contribution.outgoingAmount = task.remainingAmount;
    const source = context.snapshotByRoom.get(task.fromRoomName);
    const batchAmount = source
      ? Math.min(source.transferBatchSize, task.remainingAmount)
      : 0;
    if (batchAmount > 0) {
      contribution.outgoingFeeRoomName = task.fromRoomName;
      contribution.outgoingFee = Game.market.calcTransactionCost(
        batchAmount,
        task.fromRoomName,
        task.toRoomName,
      );
    }
  }
  if (isHealthyResourceTransferTaskReservation(task, "incoming")) {
    contribution.incomingKey = roomResourceKey(task.toRoomName, task.resource);
    contribution.incomingAmount = task.remainingAmount;
    if (task.resource === RESOURCE_ENERGY) {
      contribution.incomingEnergyRoomName = task.toRoomName;
    }
  }

  return Object.freeze(contribution);
}

function applyResourceControlTransferTaskContribution(
  context: ResourceControlTransferContext,
  taskId: string,
  contribution: ResourceControlTransferTaskContribution,
  direction: 1 | -1,
): void {
  if (contribution.outgoingKey && contribution.outgoingAmount) {
    adjustIndexedAmount(
      context.healthyOutgoingByRoomResource,
      contribution.outgoingKey,
      direction * contribution.outgoingAmount,
    );
  }
  if (contribution.incomingKey && contribution.incomingAmount) {
    adjustIndexedAmount(
      context.healthyIncomingByRoomResource,
      contribution.incomingKey,
      direction * contribution.incomingAmount,
    );
  }
  if (contribution.outgoingFeeRoomName && contribution.outgoingFee) {
    adjustIndexedAmount(
      context.outgoingFeeByRoom,
      contribution.outgoingFeeRoomName,
      direction * contribution.outgoingFee,
    );
    if (direction > 0) {
      context.outgoingFeeByTaskId.set(taskId, contribution.outgoingFee);
    } else {
      context.outgoingFeeByTaskId.delete(taskId);
    }
  } else if (direction < 0) {
    context.outgoingFeeByTaskId.delete(taskId);
  }
  if (contribution.incomingEnergyRoomName) {
    adjustIndexedAmount(
      context.healthyIncomingEnergyRoomRefCount,
      contribution.incomingEnergyRoomName,
      direction,
    );
    if (
      (context.healthyIncomingEnergyRoomRefCount.get(
        contribution.incomingEnergyRoomName,
      ) || 0) > 0
    ) {
      context.healthyIncomingEnergyRooms.add(
        contribution.incomingEnergyRoomName,
      );
    } else {
      context.healthyIncomingEnergyRooms.delete(
        contribution.incomingEnergyRoomName,
      );
    }
  }
}

function syncResourceControlTransferTask(
  context: ResourceControlTransferContext,
  task: ResourceTransferTask,
): void {
  // 任务状态/数值在本 tick 内已变化：通知 Treasury 承诺索引失效重建
  // （覆盖 resourceControl 对任务字段的全部直接写入路径）。
  bumpTreasuryCommitmentRevision();
  if (!context.taskById.has(task.id)) {
    context.tasks.push(task);
  }
  const previousContribution = context.taskContributionById.get(task.id);
  if (previousContribution) {
    applyResourceControlTransferTaskContribution(
      context,
      task.id,
      previousContribution,
      -1,
    );
  }
  context.taskById.set(task.id, task);
  context.receiverCapacityLedger.syncTask(task);
  const contribution = deriveResourceControlTransferTaskContribution(
    context,
    task,
  );
  context.taskContributionById.set(task.id, contribution);
  applyResourceControlTransferTaskContribution(
    context,
    task.id,
    contribution,
    1,
  );
  context.taskContributionIndex.syncCount += 1;
}

function getOutgoingTransactionFeeReserve(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  return Math.max(
    0,
    (context.outgoingFeeByRoom.get(snapshot.roomName) || 0) -
      (excludeTaskId ? context.outgoingFeeByTaskId.get(excludeTaskId) || 0 : 0),
  );
}

function getProductionCommitmentAmount(
  roomName: string,
  resource: ResourceConstant,
  context: ResourceControlCommitmentReadContext,
): number {
  const key = roomResourceKey(roomName, resource);
  const reserved = context.reservedProductionByRoomResource.get(key);
  return (
    (reserved === undefined ? 0 : reserved) +
    (context.carrierProductionByRoomResource.get(key) || 0)
  );
}

function addMarketEnergyContribution(
  contributions: Map<string, MarketTerminalEnergyReadinessContribution>,
  contribution: MarketTerminalEnergyReadinessContribution,
): void {
  if (contribution.amount <= 0 || !Number.isSafeInteger(contribution.amount)) {
    return;
  }
  const existing = contributions.get(contribution.id);
  if (!existing) {
    contributions.set(contribution.id, contribution);
    return;
  }

  // 同 stable ID 只能算一次。重复观测取更保守的较大值，而不是相加。
  contributions.set(contribution.id, {
    ...existing,
    amount: Math.max(existing.amount, contribution.amount),
  });
}

function collectMarketTerminalEnergyContributions(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
): {
  contributions: MarketTerminalEnergyReadinessContribution[];
  ordinaryTerminalEnergyTarget: number;
  unresolvedEnergySendAmount: number;
  unresolvedInternalSendFees: number;
  terminalScopedProductionEnergyCommitments: number;
  bounded: boolean;
} {
  const byId = new Map<string, MarketTerminalEnergyReadinessContribution>();
  let carrierIdentityComplete = true;
  addMarketEnergyContribution(byId, {
    id: `ordinary-terminal-target:${snapshot.roomName}`,
    amount: Math.max(0, Math.floor(snapshot.terminalEnergyReserve)),
    kind: "ordinary_terminal_target",
  });

  for (const task of context.tasks) {
    const contribution = context.taskContributionById.get(task.id);
    if (!contribution) continue;
    if (
      contribution.outgoingKey ===
        roomResourceKey(snapshot.roomName, RESOURCE_ENERGY) &&
      contribution.outgoingAmount
    ) {
      addMarketEnergyContribution(byId, {
        id: `resource-transfer:${task.id}:energy`,
        amount: Math.floor(contribution.outgoingAmount),
        kind: "pending_energy_send",
      });
    }
    if (
      contribution.outgoingFeeRoomName === snapshot.roomName &&
      contribution.outgoingFee
    ) {
      addMarketEnergyContribution(byId, {
        id: `resource-transfer:${task.id}:fee`,
        amount: Math.floor(contribution.outgoingFee),
        kind: "pending_internal_send_fee",
      });
    }
  }

  for (const reservation of listProductionReservations()) {
    if (
      reservation.roomName !== snapshot.roomName ||
      reservation.resource !== RESOURCE_ENERGY ||
      reservation.expiresAt < Game.time
    ) {
      continue;
    }
    addMarketEnergyContribution(byId, {
      id: `production-reservation:${reservation.holderId}`,
      amount: Math.floor(reservation.amount),
      kind: "terminal_production_commitment",
    });
  }

  for (const { ref: taskRef, task } of listCarrierDispatchEntriesByRoom(
    snapshot.roomName,
  )) {
    if (task.type !== "lab_supply" && task.type !== "factory_supply") {
      continue;
    }
    if (
      taskRef.namespace !== task.producer ||
      taskRef.scope.roomName !== snapshot.roomName ||
      taskRef.scope.roomName !== task.roomName ||
      taskRef.localId !== task.id
    ) {
      carrierIdentityComplete = false;
      continue;
    }
    for (const step of task.steps) {
      if (step.resource !== RESOURCE_ENERGY || step.fromKind !== "terminal") {
        continue;
      }
      let contributionId: string;
      try {
        contributionId = encodeCarrierDispatchStepKey(taskRef, step.id);
      } catch {
        carrierIdentityComplete = false;
        continue;
      }
      addMarketEnergyContribution(byId, {
        id: contributionId,
        amount: Math.floor(step.amount),
        kind: "terminal_production_commitment",
      });
    }
  }

  const contributions = [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const sumKind = (
    kind: MarketTerminalEnergyReadinessContribution["kind"],
  ): number =>
    contributions.reduce(
      (sum, contribution) =>
        contribution.kind === kind ? sum + contribution.amount : sum,
      0,
    );
  return {
    contributions: contributions.slice(
      0,
      MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS,
    ),
    ordinaryTerminalEnergyTarget: sumKind("ordinary_terminal_target"),
    unresolvedEnergySendAmount: sumKind("pending_energy_send"),
    unresolvedInternalSendFees: sumKind("pending_internal_send_fee"),
    terminalScopedProductionEnergyCommitments: sumKind(
      "terminal_production_commitment",
    ),
    bounded:
      carrierIdentityComplete &&
      contributions.length <= MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS,
  };
}

function createMarketTerminalEnergyReadinessObservation(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  authorization: MarketTerminalEnergyAuthorizationRead,
): MarketTerminalEnergyReadinessObservation {
  const contributions = collectMarketTerminalEnergyContributions(
    snapshot,
    context,
  );
  const productionAndTransferReserve =
    contributions.ordinaryTerminalEnergyTarget +
    contributions.unresolvedEnergySendAmount +
    contributions.unresolvedInternalSendFees +
    contributions.terminalScopedProductionEnergyCommitments;
  const effectivePostDealEnergyReserve = Math.max(
    MARKET_TERMINAL_ENERGY_BASE_RESERVE,
    productionAndTransferReserve,
  );
  const maxTransactionEnergy =
    authorization.maxTransactionEnergy ??
    MARKET_TERMINAL_ENERGY_MAX_TRANSACTION_ENERGY;
  const authorizedRoom = authorization.ok
    ? authorization.rooms.find((room) => room.roomName === snapshot.roomName)
    : undefined;
  const terminalMatches =
    !!authorizedRoom && authorizedRoom.terminalId === snapshot.terminal.id;
  const blocker: MarketTerminalEnergyReadinessBlocker | undefined =
    !authorization.ok
      ? authorization.reason === "expired"
        ? "authorization_expired"
        : authorization.reason === "missing" ||
            authorization.reason === "market_mode_not_direct"
          ? "not_authorized"
          : "authorization_invalid"
      : !authorizedRoom
        ? "not_authorized"
        : !terminalMatches
          ? "terminal_changed"
          : !contributions.bounded
            ? "draft_invalid"
            : undefined;

  return {
    schemaVersion: MARKET_TERMINAL_ENERGY_SCHEMA_VERSION,
    revision: `market-terminal-energy-v3:${Game.time}`,
    observedAt: Game.time,
    expiresAt: Game.time + MARKET_TERMINAL_ENERGY_EVIDENCE_TTL,
    ...(authorization.revision
      ? { authorizationRevision: authorization.revision }
      : {}),
    ...(authorizedRoom
      ? { roomInstanceId: authorizedRoom.roomInstanceId }
      : {}),
    terminalId: snapshot.terminal.id,
    authorized: !blocker,
    effectivePostDealEnergyReserve,
    marketTerminalEnergyTarget:
      effectivePostDealEnergyReserve + maxTransactionEnergy,
    ordinaryTerminalEnergyTarget: contributions.ordinaryTerminalEnergyTarget,
    unresolvedEnergySendAmount: contributions.unresolvedEnergySendAmount,
    unresolvedInternalSendFees: contributions.unresolvedInternalSendFees,
    terminalScopedProductionEnergyCommitments:
      contributions.terminalScopedProductionEnergyCommitments,
    maxTransactionEnergy,
    contributionCount: contributions.contributions.length,
    contributions: contributions.contributions,
    desiredTerminalEnergy: contributions.ordinaryTerminalEnergyTarget,
    plannedFeedAmount: 0,
    status: blocker ? "blocked" : "ready",
    ...(blocker ? { blocker } : {}),
  };
}

function getEnergyBalancingSurplus(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  if (!isEnergyExportEligible(snapshot)) {
    return 0;
  }
  return getProtectedEnergySurplus(snapshot, context, excludeTaskId);
}

/**
 * 已存在跨房动作的 Energy 所有权预算。
 *
 * 房间恢复水位只决定本地状态与无任务自动平衡策略，不属于库存所有权；
 * ordinary Terminal reserve、生产、其他 transfer 与市场 exposure 仍先扣除。
 */
function getTerminalActionEnergyBudget(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
  terminalEnergyOutsideMarketExposureOverride?: number,
): number {
  const terminalEnergyOutsideMarketExposure =
    terminalEnergyOutsideMarketExposureOverride ??
    getTerminalAmountOutsideMarketSaleExposure(
      snapshot.terminal,
      RESOURCE_ENERGY,
      snapshot.roomName,
    );
  const marketExposureOwnership = Math.max(
    0,
    snapshot.terminalEnergy - terminalEnergyOutsideMarketExposure,
  );
  return getTerminalActionEnergyOwnershipBudget({
    totalEnergy: getStock(snapshot, RESOURCE_ENERGY),
    ordinaryTerminalEnergyReserve: snapshot.terminalEnergyReserve,
    productionEnergyCommitment: getProductionCommitmentAmount(
      snapshot.roomName,
      RESOURCE_ENERGY,
      context,
    ),
    otherOutgoingEnergyCommitment: getHealthyOutgoingCommitment(
      snapshot.roomName,
      RESOURCE_ENERGY,
      context,
      excludeTaskId,
    ),
    otherOutgoingFeeCommitment: getOutgoingTransactionFeeReserve(
      snapshot,
      context,
      excludeTaskId,
    ),
    otherExplicitEnergyOwnership: marketExposureOwnership,
  });
}

function getProtectedEnergySurplus(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  return Math.max(
    0,
    getStock(snapshot, RESOURCE_ENERGY) -
      snapshot.energyTarget -
      getProductionCommitmentAmount(
        snapshot.roomName,
        RESOURCE_ENERGY,
        context,
      ) -
      getHealthyOutgoingCommitment(
        snapshot.roomName,
        RESOURCE_ENERGY,
        context,
        excludeTaskId,
      ) -
      getOutgoingTransactionFeeReserve(snapshot, context, excludeTaskId),
  );
}

export function getResourceControlRoomStock(
  room: Room,
  resource: ResourceConstant,
): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }

  const consumers = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_LAB ||
      structure.structureType === STRUCTURE_FACTORY ||
      structure.structureType === STRUCTURE_POWER_SPAWN,
  }) as AnyStoreStructure[];
  for (const structure of consumers) {
    total += structure.store.getUsedCapacity(resource);
  }

  return total;
}

function getEnergyAvailableForFees(snapshot: ResourceControlSnapshot): number {
  return Math.max(0, snapshot.terminalEnergy - snapshot.terminalEnergyReserve);
}

function computeLargestAffordableAmount(
  maximum: number,
  canAfford: (amount: number) => boolean,
): number {
  let low = 1;
  let high = Math.max(0, Math.floor(maximum));
  let result = 0;

  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (canAfford(candidate)) {
      result = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }

  return result;
}

function computeSendAmount(
  donor: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  targetAmount: number,
  actionEnergyBudget: number = donor.terminalEnergy,
): number {
  const availableResource =
    resource === RESOURCE_ENERGY
      ? donor.terminalEnergy
      : getTerminalResourceAmount(donor, resource);
  const maximum = Math.floor(
    Math.min(targetAmount, donor.transferBatchSize, availableResource),
  );
  return computeLargestAffordableAmount(maximum, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      donor.roomName,
      receiverRoomName,
    );
    const requiredEnergy = resource === RESOURCE_ENERGY ? amount + fee : fee;
    return (
      requiredEnergy <= donor.terminalEnergy &&
      requiredEnergy <= actionEnergyBudget
    );
  });
}

function computeTransferAmount(
  from: ResourceControlSnapshot,
  to: ResourceControlSnapshot,
  receiverNeed: number,
  receiverCapacity: number,
  context: ResourceControlTransferContext,
): number {
  if (receiverNeed <= 0 || receiverCapacity <= 0) {
    return 0;
  }
  const donorBudget = getEnergyBalancingSurplus(from, context);
  const terminalBudget = Math.max(
    0,
    from.terminalEnergy - getOutgoingTransactionFeeReserve(from, context),
  );
  const maximum = Math.floor(
    Math.min(
      from.transferBatchSize,
      receiverNeed,
      receiverCapacity,
      donorBudget,
      from.terminalEnergy,
    ),
  );
  return computeLargestAffordableAmount(maximum, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      from.roomName,
      to.roomName,
    );
    return amount + fee <= donorBudget && amount + fee <= terminalBudget;
  });
}

function applyPostSendDelta(
  donor: ResourceControlSnapshot,
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
): number {
  const transferCost = Game.market.calcTransactionCost(
    amount,
    donor.roomName,
    receiver.roomName,
  );
  const donorEnergyDelta =
    (resource === RESOURCE_ENERGY ? amount : 0) + transferCost;
  donor.terminalEnergy = Math.max(0, donor.terminalEnergy - donorEnergyDelta);
  setTerminalResourceAmount(donor, RESOURCE_ENERGY, donor.terminalEnergy);
  if (resource !== RESOURCE_ENERGY) {
    setTerminalResourceAmount(
      donor,
      resource,
      getTerminalResourceAmount(donor, resource) - amount,
    );
  }
  donor.terminalUsedCapacity = Math.max(
    0,
    donor.terminalUsedCapacity - amount - transferCost,
  );
  donor.terminalFreeCapacity = Math.max(
    0,
    donor.terminalFreeCapacity + amount + transferCost,
  );

  if (resource === RESOURCE_ENERGY) {
    receiver.terminalEnergy += amount;
    setTerminalResourceAmount(
      receiver,
      RESOURCE_ENERGY,
      receiver.terminalEnergy,
    );
  } else {
    setTerminalResourceAmount(
      receiver,
      resource,
      getTerminalResourceAmount(receiver, resource) + amount,
    );
  }
  receiver.terminalUsedCapacity += amount;
  receiver.terminalFreeCapacity = Math.max(
    0,
    receiver.terminalFreeCapacity - amount,
  );

  return transferCost;
}

function applyInternalBalancing(
  snapshots: ResourceControlSnapshot[],
  terminalBusy: Set<string>,
  sendBudget: InternalSendBudget,
  context: ResourceControlTransferContext,
  remainingEnergyNeedByRoom: Map<string, number>,
): string[] {
  const actions: string[] = [];
  const donors = snapshots
    .filter(
      (snapshot) =>
        snapshot.terminal.cooldown === 0 &&
        getEnergyBalancingSurplus(snapshot, context) > 0,
    )
    .sort(
      (left, right) =>
        getEnergyBalancingSurplus(right, context) -
        getEnergyBalancingSurplus(left, context),
    );
  const receivers = snapshots
    .filter(
      (snapshot) => (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0,
    )
    .filter(
      (snapshot) => !context.healthyIncomingEnergyRooms.has(snapshot.roomName),
    )
    .sort((left, right) => {
      const needDiff =
        (remainingEnergyNeedByRoom.get(right.roomName) || 0) -
        (remainingEnergyNeedByRoom.get(left.roomName) || 0);
      return needDiff || left.roomName.localeCompare(right.roomName);
    });

  for (const donor of donors) {
    if (sendBudget.remaining <= 0) break;
    if (terminalBusy.has(donor.roomName)) continue;

    for (const receiver of receivers) {
      if (donor.roomName === receiver.roomName) continue;
      const receiverCapacity =
        context.receiverCapacityLedger.getAvailableAmount(
          receiver.roomName,
          RESOURCE_ENERGY,
        );
      const receiverNeed =
        remainingEnergyNeedByRoom.get(receiver.roomName) || 0;
      const amount = computeTransferAmount(
        donor,
        receiver,
        receiverNeed,
        receiverCapacity,
        context,
      );
      if (amount <= 0) continue;

      const transactionCost = Game.market.calcTransactionCost(
        amount,
        donor.roomName,
        receiver.roomName,
      );
      if (
        !canTerminalSendPreserveMarketSaleExposure(
          donor.terminal,
          RESOURCE_ENERGY,
          amount,
          transactionCost,
        )
      ) {
        actions.push(
          `send-blocked:${donor.roomName}->${receiver.roomName}:market-sale-exposure`,
        );
        continue;
      }

      const code = executeTerminalSend({
        terminal: donor.terminal,
        resourceType: RESOURCE_ENERGY,
        amount,
        transactionCost,
        destinationRoomName: receiver.roomName,
        actor: "resourceControl:auto-balance",
        description: "resourceControl:auto-balance",
      });
      if (code !== OK) {
        actions.push(
          `send-failed:${donor.roomName}->${receiver.roomName}:code=${code}`,
        );
        continue;
      }
      recordFixedCpuAction("resourceControl");
      const transferCost = applyPostSendDelta(
        donor,
        receiver,
        RESOURCE_ENERGY,
        amount,
      );
      context.receiverCapacityLedger.applySend(
        receiver.roomName,
        RESOURCE_ENERGY,
        amount,
      );
      remainingEnergyNeedByRoom.set(
        receiver.roomName,
        Math.max(0, receiverNeed - amount),
      );
      actions.push(
        `send:${donor.roomName}->${receiver.roomName}:energy=${amount}:cost=${transferCost}`,
      );
      terminalBusy.add(donor.roomName);
      sendBudget.remaining -= 1;
      break;
    }
  }

  return actions;
}

function isStorageConstrained(
  snapshot: ResourceControlSnapshot | undefined,
  capacityConfig: ResourceCapacityConfig,
): boolean {
  return (
    (snapshot?.storage?.store.getFreeCapacity() ?? 0) <=
    capacityConfig.storagePressureFreeCapacity
  );
}

function getReceiverStorageFreeCapacity(
  receiver: ResourceControlSnapshot,
): number {
  const free = receiver.storage?.store.getFreeCapacity();
  return typeof free === "number" ? Math.max(0, free) : 0;
}

function getTransferTaskPriority(
  task: ResourceTransferTask,
  energyDeficitRooms: Set<string>,
  storageConstrainedRooms: Set<string>,
  capacityStateByRoom: Map<string, ResourceCapacityState>,
): number {
  if (
    task.resource === RESOURCE_ENERGY &&
    energyDeficitRooms.has(task.toRoomName)
  )
    return 0;
  const reason = task.reason;
  if (task.origin === "manual" && (!reason || reason.startsWith("manual:")))
    return 1;
  if (!reason) return 3;
  if (reason.startsWith("capacity:relief:")) {
    return capacityStateByRoom.get(task.fromRoomName) === "emergency" ? 1 : 3;
  }
  if (
    reason.startsWith("synthesis:") ||
    reason.startsWith("auto:synthesis:") ||
    reason.startsWith("powerBankBoost")
  )
    return 2;
  if (
    reason.startsWith("hub:export:") &&
    storageConstrainedRooms.has(task.fromRoomName)
  )
    return 4;
  if (reason.startsWith("hub:import:")) return 5;
  if (reason.startsWith("hub:reclaim:")) return 6;
  if (reason.startsWith("hub:export:")) return 7;
  return 3;
}

interface TransferTaskPriorityContext {
  energyDeficitRooms: Set<string>;
  storageConstrainedRooms: Set<string>;
  capacityStateByRoom: Map<string, ResourceCapacityState>;
}

function createTransferTaskPriorityContext(
  snapshots: ResourceControlSnapshot[],
  capacityConfig: ResourceCapacityConfig,
  remainingEnergyNeedByRoom: Map<string, number>,
): TransferTaskPriorityContext {
  return {
    energyDeficitRooms: new Set(
      snapshots
        .filter(
          (snapshot) =>
            (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0,
        )
        .map((snapshot) => snapshot.roomName),
    ),
    storageConstrainedRooms: new Set(
      snapshots
        .filter((snapshot) => isStorageConstrained(snapshot, capacityConfig))
        .map((snapshot) => snapshot.roomName),
    ),
    capacityStateByRoom: new Map(
      snapshots.map(
        (snapshot) => [snapshot.roomName, snapshot.capacityState] as const,
      ),
    ),
  };
}

function sortTransferTasksByPriority(
  tasks: ResourceTransferTask[],
  priorityContext: TransferTaskPriorityContext,
): ResourceTransferTask[] {
  return [...tasks].sort((a, b) => {
    const pa = getTransferTaskPriority(
      a,
      priorityContext.energyDeficitRooms,
      priorityContext.storageConstrainedRooms,
      priorityContext.capacityStateByRoom,
    );
    const pb = getTransferTaskPriority(
      b,
      priorityContext.energyDeficitRooms,
      priorityContext.storageConstrainedRooms,
      priorityContext.capacityStateByRoom,
    );
    if (pa !== pb) return pa - pb;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

function getReceiverTerminalFreeCapacity(
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const totalFree = receiver.terminal.store.getFreeCapacity();
  const resourceFree = receiver.terminal.store.getFreeCapacity(resource);
  if (typeof totalFree === "number" && typeof resourceFree === "number") {
    return Math.max(0, Math.min(totalFree, resourceFree));
  }
  if (typeof totalFree === "number") return Math.max(0, totalFree);
  return typeof resourceFree === "number" ? Math.max(0, resourceFree) : 0;
}

function getReceiverReceivableCapacity(
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
  capacityConfig: ResourceCapacityConfig,
): number {
  return getReceiverSafeCapacity(
    getReceiverStorageFreeCapacity(receiver),
    getReceiverTerminalFreeCapacity(receiver, resource),
    capacityConfig,
  );
}

function getHealthyOutgoingCommitment(
  roomName: string,
  resource: ResourceConstant,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  let total =
    context.healthyOutgoingByRoomResource.get(
      roomResourceKey(roomName, resource),
    ) || 0;
  if (excludeTaskId) {
    const excluded = context.taskById.get(excludeTaskId);
    if (
      excluded?.fromRoomName === roomName &&
      excluded.resource === resource &&
      isHealthyResourceTransferTaskReservation(excluded, "outgoing")
    ) {
      total -= excluded.remainingAmount;
    }
  }
  return Math.max(0, total);
}

function getProtectedResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  config: ResourceCapacityConfig,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  let safetyFloor = snapshot.mineralFloor[resource] || 0;
  if (HUB_TARGET_COMPOUNDS.includes(resource)) {
    safetyFloor = Math.max(safetyFloor, config.t3ReservePerRoom);
  }
  return (
    safetyFloor +
    getProductionCommitmentAmount(snapshot.roomName, resource, context)
  );
}

function getMovableResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  location: "storage" | "terminal",
  config: ResourceCapacityConfig,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  if (resource === RESOURCE_ENERGY) {
    const structureStock =
      location === "terminal"
        ? getTerminalResourceAmount(snapshot, resource)
        : getStorageResourceAmount(snapshot, resource);
    return Math.min(
      structureStock,
      getTerminalActionEnergyBudget(snapshot, context, excludeTaskId),
    );
  }
  const totalStock = getStock(snapshot, resource);
  const movableTotal = Math.max(
    0,
    totalStock -
      getProtectedResourceAmount(
        snapshot,
        resource,
        config,
        context,
        excludeTaskId,
      ) -
      getHealthyOutgoingCommitment(
        snapshot.roomName,
        resource,
        context,
        excludeTaskId,
      ),
  );
  const structureStock =
    location === "terminal"
      ? getTerminalResourceAmount(snapshot, resource)
      : getStorageResourceAmount(snapshot, resource);
  return Math.min(structureStock, movableTotal);
}

function getTotalMovableResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  config: ResourceCapacityConfig,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  if (resource === RESOURCE_ENERGY) {
    return getTerminalActionEnergyBudget(snapshot, context, excludeTaskId);
  }
  return Math.max(
    0,
    getStock(snapshot, resource) -
      getProtectedResourceAmount(
        snapshot,
        resource,
        config,
        context,
        excludeTaskId,
      ) -
      getHealthyOutgoingCommitment(
        snapshot.roomName,
        resource,
        context,
        excludeTaskId,
      ),
  );
}

function readLogisticsShadowCpuUsed(): number | undefined {
  try {
    const used = Game.cpu?.getUsed?.();
    return typeof used === "number" && Number.isFinite(used) && used >= 0
      ? used
      : undefined;
  } catch {
    return undefined;
  }
}

function logisticsShadowHash(value: string): string {
  // FNV-1a 变体：每次迭代混合两个 UTF-16 码元，迭代与 imul 次数减半。
  // 哈希值只做单次部署内的逐 epoch 比较（不跨部署持久比对），算法变更
  // 仅在部署切换时使 epoch 标识值发生一次不连续。
  let hash = 0x811c9dc5;
  const length = value.length;
  let index = 0;
  for (; index + 1 < length; index += 2) {
    hash ^= value.charCodeAt(index) | (value.charCodeAt(index + 1) << 16);
    hash = Math.imul(hash, 0x01000193);
  }
  if (index < length) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

function safeSerializedLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? utf8ByteLength(serialized)
      : LOGISTICS_SHADOW_MEMORY_LIMIT_BYTES + 1;
  } catch {
    return LOGISTICS_SHADOW_MEMORY_LIMIT_BYTES + 1;
  }
}

function isLogisticsShadowActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "resourceControl:logistics-shadow" ||
      value.startsWith("resourceControl:logistics-shadow:"))
  );
}

function getObservableRecordValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isPlainRecord(value)) return Object.values(value);
  return [];
}

function isObservableAuthorityRecordActive(value: unknown): boolean {
  if (!isPlainRecord(value)) return true;
  const status = value.status;
  return ![
    "cancelled",
    "completed",
    "done",
    "expired",
    "released",
    "revoked",
  ].includes(typeof status === "string" ? status : "");
}

function countObservableNonLegacyAuthorityRecords(
  collections: readonly unknown[][],
): number {
  let count = 0;
  for (const records of collections) {
    for (const record of records) {
      if (
        isPlainRecord(record) &&
        typeof record.effectiveAuthority === "string" &&
        record.effectiveAuthority !== "legacy"
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function recordLogisticsShadowSafetyViolation(
  projection: ResourceControlLogisticsRuntimeV2,
  violation: string,
): void {
  if (
    projection.safety.violations.length < LOGISTICS_SHADOW_MAX_VIOLATIONS &&
    !projection.safety.violations.includes(violation)
  ) {
    projection.safety.violations.push(violation);
  }
}

/**
 * 只统计 Shadow 边界结束时仍可见、且可归因到 Shadow actor/authority 的记录。
 * terminal.send/deal 的瞬时调用由 A/B mock 门禁证明；这里不声称捕获失败后回滚的
 * attempt，也不为测量而创建 carrier board 或 authority store。
 */
function projectLogisticsShadowObservableRecords(
  projection: ResourceControlLogisticsRuntimeV2,
  context: ResourceControlTransferContext,
): void {
  const rawLogistics = (
    Memory.data?.resourceControl as unknown as { logistics?: unknown } | undefined
  )?.logistics;
  const authorityStore = isPlainRecord(rawLogistics)
    ? rawLogistics
    : undefined;
  const contractRecords = getObservableRecordValues(authorityStore?.contracts);
  const leaseRecords = getObservableRecordValues(authorityStore?.leases);
  const claimRecords = getObservableRecordValues(authorityStore?.claims);
  const receiverReservationRecords = getObservableRecordValues(
    authorityStore?.receiverReservations,
  );
  const authorityCollections = [
    contractRecords,
    leaseRecords,
    claimRecords,
    receiverReservationRecords,
  ];

  projection.safety.nonLegacyAuthorityRecords =
    countObservableNonLegacyAuthorityRecords(authorityCollections);
  projection.safety.activeContracts =
    contractRecords.filter(isObservableAuthorityRecordActive).length;
  projection.safety.activeLeases =
    leaseRecords.filter(isObservableAuthorityRecordActive).length;
  projection.safety.activeClaims =
    claimRecords.filter(isObservableAuthorityRecordActive).length;

  const terminalClaims = getTerminalActionClaims();
  const marketAccountClaim = getMarketAccountClaim();
  const visibleClaims = [
    ...terminalClaims,
    ...(marketAccountClaim ? [marketAccountClaim] : []),
  ];
  projection.safety.shadowClaimRecords = visibleClaims.filter((claim) =>
    isPlainRecord(claim) && isLogisticsShadowActor(claim.actor),
  ).length;

  const journal = getMarketActionJournal();
  projection.safety.shadowJournalRecords = journal.filter((entry) =>
    isLogisticsShadowActor(entry.actor),
  ).length;
  projection.safety.shadowArbiterActorRecords = new Set([
    ...visibleClaims
      .filter(isPlainRecord)
      .map((claim) => claim.actor)
      .filter(isLogisticsShadowActor),
    ...journal
      .map((entry) => entry.actor)
      .filter(isLogisticsShadowActor),
  ]).size;

  let shadowCarrierTaskRecords = 0;
  for (const roomName of [...context.snapshotByRoom.keys()]
    .sort()
    .slice(0, SYNTHESIS_SHADOW_MAX_ROOM_FACTS)) {
    for (const { task } of peekCarrierTasksByRoom(roomName)) {
      if (isLogisticsShadowActor(task.producer)) {
        shadowCarrierTaskRecords += 1;
      }
    }
  }
  projection.safety.shadowCarrierTaskRecords = shadowCarrierTaskRecords;
  projection.safety.shadowReceiverReservationRecords =
    receiverReservationRecords.filter(
      (record) =>
        isPlainRecord(record) &&
        (isLogisticsShadowActor(record.actor) ||
          isLogisticsShadowActor(record.producer)),
    ).length;

  if (
    projection.safety.nonLegacyAuthorityRecords > 0 ||
    projection.safety.activeContracts > 0 ||
    projection.safety.activeLeases > 0 ||
    projection.safety.activeClaims > 0 ||
    projection.safety.shadowArbiterActorRecords > 0 ||
    projection.safety.shadowClaimRecords > 0 ||
    projection.safety.shadowJournalRecords > 0 ||
    projection.safety.shadowCarrierTaskRecords > 0 ||
    projection.safety.shadowReceiverReservationRecords > 0
  ) {
    recordLogisticsShadowSafetyViolation(
      projection,
      "observable_shadow_authority_record",
    );
    projection.available = false;
    projection.complete = false;
    projection.blocker = "input_unavailable";
  }
}

function createLogisticsShadowDimensionSummary(): Record<
  LogisticsShadowDimension,
  LogisticsShadowDimensionSummaryV1
> {
  return {
    donor: { matched: 0, different: 0, unresolved: 0 },
    route: { matched: 0, different: 0, unresolved: 0 },
    priority: { matched: 0, different: 0, unresolved: 0 },
    demandCoverage: { matched: 0, different: 0, unresolved: 0 },
    receiverHeadroom: { matched: 0, different: 0, unresolved: 0 },
    predictedStagingEligibility: {
      matched: 0,
      different: 0,
      unresolved: 0,
    },
  };
}

function createEmptyLogisticsShadowRuntime(
  requestedMode: ResourceControlLogisticsRuntimeV2["requestedMode"],
  blocker: LogisticsShadowRuntimeBlocker,
): ResourceControlLogisticsRuntimeV2 {
  return {
    schemaVersion: LOGISTICS_RUNTIME_SCHEMA_VERSION,
    updatedAt: Game.time,
    expiresAt: Game.time + getResourceControlSampleInterval() * 2,
    requestedMode,
    effectiveAuthority: "legacy",
    available: false,
    complete: false,
    projectionTruncated: false,
    blocker,
    inScopeByOrigin: {},
    outOfScopeByOrigin: {},
    intent: {
      total: 0,
      active: 0,
      fresh: 0,
      stale: 0,
      paired: 0,
      inputDrift: 0,
      emitted: 0,
      dropped: 0,
      truncated: false,
    },
    comparison: {
      total: 0,
      matched: 0,
      different: 0,
      unresolved: 0,
      byReason: {},
      byDecisionDelta: {},
      byCausalCode: {},
      dimensions: createLogisticsShadowDimensionSummary(),
      sampled: 0,
      detailsDropped: 0,
      samples: [],
    },
    matcher: {
      indexBuilds: 0,
      candidateEvaluations: 0,
      transactionCostEvaluations: 0,
      totalTransactionCostEvaluations: 0,
      candidateBudget: SYNTHESIS_SHADOW_DEFAULT_CANDIDATE_BUDGET,
      budgetExhausted: false,
    },
    safety: {
      measurementBoundary: "observable_state_diff_v1",
      nonLegacyAuthorityRecords: 0,
      activeContracts: 0,
      activeLeases: 0,
      activeClaims: 0,
      shadowArbiterActorRecords: 0,
      shadowClaimRecords: 0,
      shadowJournalRecords: 0,
      shadowCarrierTaskRecords: 0,
      shadowReceiverReservationRecords: 0,
      violations: [],
    },
    resources: {
      dataItems: 0,
      runtimeItems: 0,
      dataBytes: 0,
      runtimeBytes: 0,
      totalBytes: 0,
      withinLimit: true,
    },
    cpu: {
      attributionVersion: 2,
      sampleTick: Game.time,
      measurementAvailable: false,
      producerUsed: 0,
      consumerUsed: 0,
    },
  };
}

function countLogisticsShadowRuntimeItems(
  projection: ResourceControlLogisticsRuntimeV2,
): number {
  const rejectionTupleCount = projection.comparison.samples.reduce(
    (total, sample) =>
      total + (sample.candidate?.rejectionCounts.length || 0),
    0,
  );
  return (
    projection.comparison.samples.length +
    rejectionTupleCount +
    projection.safety.violations.length +
    Object.keys(projection.inScopeByOrigin).length +
    Object.keys(projection.outOfScopeByOrigin).length +
    Object.keys(projection.comparison.byReason).length +
    Object.keys(projection.comparison.byDecisionDelta).length +
    Object.keys(projection.comparison.byCausalCode).length
  );
}

function stabilizeLogisticsShadowRuntimeLengths(
  projection: ResourceControlLogisticsRuntimeV2,
): void {
  projection.comparison.sampled = projection.comparison.samples.length;
  projection.comparison.detailsDropped = Math.max(
    0,
    projection.comparison.total - projection.comparison.sampled,
  );
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const previousRuntimeBytes = projection.resources.runtimeBytes;
    const previousTotalBytes = projection.resources.totalBytes;
    projection.resources.runtimeBytes = safeSerializedLength(projection);
    projection.resources.totalBytes =
      projection.resources.dataBytes + projection.resources.runtimeBytes;
    projection.resources.withinLimit =
      projection.resources.runtimeBytes <=
        LOGISTICS_SHADOW_RUNTIME_LIMIT_BYTES &&
      projection.resources.totalBytes <= LOGISTICS_SHADOW_MEMORY_LIMIT_BYTES;
    if (
      projection.resources.runtimeBytes === previousRuntimeBytes &&
      projection.resources.totalBytes === previousTotalBytes
    ) {
      break;
    }
  }
}

function applyLogisticsShadowCpuAttribution(
  projection: ResourceControlLogisticsRuntimeV2,
  snapshot: Readonly<LogisticsShadowCpuSnapshotV2> | undefined,
  selfObservationOnly = false,
): ResourceControlLogisticsRuntimeV2 {
  const valid = !!snapshot &&
    snapshot.attributionVersion === 2 &&
    snapshot.sampleTick === Game.time &&
    snapshot.measurementAvailable &&
    Number.isFinite(snapshot.producerUsed) &&
    snapshot.producerUsed >= 0 &&
    Number.isFinite(snapshot.consumerUsed) &&
    snapshot.consumerUsed >= 0;
  projection.cpu = {
    attributionVersion: 2,
    sampleTick: Game.time,
    measurementAvailable: valid,
    producerUsed: valid
      ? Math.round(snapshot!.producerUsed * 1_000) / 1_000
      : 0,
    consumerUsed: valid
      ? Math.round(snapshot!.consumerUsed * 1_000) / 1_000
      : 0,
  };
  if (!valid) {
    projection.available = false;
    projection.complete = false;
    projection.blocker = "input_unavailable";
    if (
      projection.safety.violations.length < LOGISTICS_SHADOW_MAX_VIOLATIONS &&
      !projection.safety.violations.includes("cpu_measurement_unavailable")
    ) {
      projection.safety.violations.push("cpu_measurement_unavailable");
    }
  }
  projection.resources.runtimeItems = countLogisticsShadowRuntimeItems(
    projection,
  );
  stabilizeLogisticsShadowRuntimeLengths(projection);
  if (selfObservationOnly && projection.resources.withinLimit) {
    return projection;
  }
  return projection.resources.withinLimit
    ? projection
    : finalizeLogisticsShadowRuntime(projection);
}

function finalizeLogisticsShadowRuntime(
  projection: ResourceControlLogisticsRuntimeV2,
): ResourceControlLogisticsRuntimeV2 {
  const rawLogistics = (
    Memory.data?.resourceControl as unknown as { logistics?: unknown } | undefined
  )?.logistics;
  const storeRead = readLogisticsControlStoreExact();
  const storeUsage = storeRead.ok ? storeRead.usage : undefined;
  projection.resources.dataItems = storeUsage?.itemCount ?? 0;
  projection.resources.dataBytes = storeUsage?.utf8Bytes ?? (
    rawLogistics === undefined ? 0 : safeSerializedLength(rawLogistics)
  );
  projection.resources.runtimeItems = countLogisticsShadowRuntimeItems(
    projection,
  );
  stabilizeLogisticsShadowRuntimeLengths(projection);
  let projectionTrimmed = false;
  while (
    !projection.resources.withinLimit &&
    projection.comparison.samples.length > 0
  ) {
    projection.comparison.samples.pop();
    projectionTrimmed = true;
    projection.resources.runtimeItems = countLogisticsShadowRuntimeItems(
      projection,
    );
    stabilizeLogisticsShadowRuntimeLengths(projection);
  }
  while (
    !projection.resources.withinLimit &&
    projection.safety.violations.length > 0
  ) {
    projection.safety.violations.pop();
    projectionTrimmed = true;
    projection.resources.runtimeItems = countLogisticsShadowRuntimeItems(
      projection,
    );
    stabilizeLogisticsShadowRuntimeLengths(projection);
  }
  if (projectionTrimmed) {
    projection.complete = false;
    projection.projectionTruncated = true;
    stabilizeLogisticsShadowRuntimeLengths(projection);
  }
  if (!projection.resources.withinLimit) {
    const minimal = createEmptyLogisticsShadowRuntime(
      projection.requestedMode,
      "input_unavailable",
    );
    minimal.projectionTruncated = true;
    minimal.safety.violations = ["logistics_memory_limit"];
    minimal.resources.dataItems = projection.resources.dataItems;
    minimal.resources.dataBytes = projection.resources.dataBytes;
    minimal.resources.runtimeItems = countLogisticsShadowRuntimeItems(minimal);
    minimal.cpu = projection.cpu;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      minimal.resources.runtimeBytes = safeSerializedLength(minimal);
      minimal.resources.totalBytes =
        minimal.resources.dataBytes + minimal.resources.runtimeBytes;
      minimal.resources.withinLimit =
        minimal.resources.runtimeBytes <= LOGISTICS_SHADOW_RUNTIME_LIMIT_BYTES &&
        minimal.resources.totalBytes <= LOGISTICS_SHADOW_MEMORY_LIMIT_BYTES;
    }
    return minimal;
  }
  return projection;
}

function addLogisticsOriginCount(
  target: Partial<Record<LogisticsRolloutOrigin, number>>,
  origin: LogisticsRolloutOrigin,
): void {
  target[origin] = (target[origin] || 0) + 1;
}

function mapLogisticsShadowDifferences(
  differences: readonly SynthesisShadowDifference[],
): LogisticsShadowDimension[] {
  const dimensions = new Set<LogisticsShadowDimension>();
  for (const difference of differences) {
    if (difference === "source") dimensions.add("donor");
    if (difference === "target" || difference === "amount") {
      dimensions.add("route");
    }
    if (
      difference === "ready" ||
      difference === "cost" ||
      difference === "blocker"
    ) {
      dimensions.add("route");
    }
    if (difference === "priority") dimensions.add("priority");
    if (difference === "coverage") dimensions.add("demandCoverage");
    if (difference === "capacity") dimensions.add("receiverHeadroom");
    if (difference === "staging") {
      dimensions.add("predictedStagingEligibility");
    }
    if (difference === "legacy_missing" || difference === "shadow_missing") {
      dimensions.add("donor");
      dimensions.add("route");
    }
  }
  return LOGISTICS_SHADOW_DIMENSIONS.filter((dimension) =>
    dimensions.has(dimension),
  );
}

function getLogisticsShadowComparisonReason(
  sample: SynthesisShadowComparisonSample,
): LogisticsShadowComparisonReason {
  if (sample.status === "equal") return "equal";
  if (sample.status === "unresolved") {
    return sample.unresolvedReason || "input_unavailable";
  }
  return sample.classification || "expected_policy_difference";
}

function projectLogisticsShadowRouteOutcome(
  route: SynthesisShadowRouteFact,
): LogisticsShadowRuntimeRouteOutcomeV2 {
  return {
    kind: "route",
    sourceRoomName: route.sourceRoom,
    coverage: route.coverage,
    capacity: route.capacity,
    staging: route.predictedStagingEligibility,
    amount: route.amount,
    actionAmount: route.actionAmount,
    feeAmount: route.transactionCost,
    terminalReadyAt: route.terminalReadyAt,
    requiredEnergy: route.requiredEnergy,
    energyCommitmentAmount: route.energyCommitmentAmount,
    terminalAllocatedAmount: route.terminalAllocatedAmount,
    stagingRequiredAmount: route.stagingRequiredAmount,
    terminalEnergyAllocatedAmount: route.terminalEnergyAllocatedAmount,
    feeStagingRequiredAmount: route.feeStagingRequiredAmount,
  };
}

function isSynthesisShadowRouteDecision(
  value: SynthesisShadowDecision | SynthesisShadowUnmatchedDemand,
): value is SynthesisShadowDecision {
  return "sourceRoom" in value;
}

function projectLogisticsShadowCandidateTrace(
  trace: SynthesisShadowCandidateTrace,
): SynthesisShadowCandidateTrace {
  return {
    donorCount: trace.donorCount,
    evaluatedCount: trace.evaluatedCount,
    feasibleCount: trace.feasibleCount,
    rejectedCount: trace.rejectedCount,
    ...(trace.selectedRejection
      ? { selectedRejection: trace.selectedRejection }
      : {}),
    rejectionCounts: trace.rejectionCounts.map(
      ([reason, count]) => [reason, count] as const,
    ),
    ...(trace.topSourceRoom
      ? { topSourceRoom: trace.topSourceRoom }
      : {}),
    ...(trace.legacySource
      ? {
          legacySource: {
            sourceRoom: trace.legacySource.sourceRoom,
            disposition: trace.legacySource.disposition,
            ...(trace.legacySource.rejection
              ? { rejection: trace.legacySource.rejection }
              : {}),
          },
        }
      : {}),
    receiver: trace.receiver.kind === "missing"
      ? { kind: "missing" }
      : {
          kind: "present",
          receiverEligible: trace.receiver.receiverEligible,
          storageHeadroom: trace.receiver.storageHeadroom,
          terminalHeadroom: trace.receiver.terminalHeadroom,
          resourceHeadroom: trace.receiver.resourceHeadroom,
        },
  };
}

function getLogisticsShadowDecisionDelta(
  sample: SynthesisShadowComparisonSample,
): LogisticsShadowDecisionDelta {
  const legacyRoute = sample.legacy?.kind === "route"
    ? sample.legacy.route
    : undefined;
  const shadowRoute = sample.shadow && isSynthesisShadowRouteDecision(sample.shadow)
    ? sample.shadow
    : undefined;
  const shadowUnmatched = sample.shadow && !isSynthesisShadowRouteDecision(sample.shadow)
    ? sample.shadow
    : undefined;
  if (legacyRoute && shadowRoute) {
    return legacyRoute.sourceRoom === shadowRoute.sourceRoom &&
        legacyRoute.targetRoom === shadowRoute.targetRoom &&
        legacyRoute.resource === shadowRoute.resource
      ? "same_route"
      : "different_route";
  }
  if (legacyRoute && shadowUnmatched) return "legacy_only_route";
  if (sample.legacy?.kind === "none" && shadowRoute) {
    return "shadow_only_route";
  }
  if (sample.legacy?.kind === "none" && shadowUnmatched) {
    return "both_no_route";
  }
  return "input_unavailable";
}

function getLogisticsShadowDifferenceDirection(
  sample: SynthesisShadowComparisonSample,
  decisionDelta: LogisticsShadowDecisionDelta,
): LogisticsShadowDifferenceDirection {
  if (sample.status === "unresolved" || decisionDelta === "input_unavailable") {
    return "input_unavailable";
  }
  if (sample.status === "equal") return "same";
  if (decisionDelta === "legacy_only_route") {
    return "shadow_more_conservative";
  }
  if (decisionDelta === "shadow_only_route") {
    return "shadow_more_permissive";
  }
  return "policy_difference";
}

function getLogisticsShadowCausalCode(
  sample: SynthesisShadowComparisonSample,
  decisionDelta: LogisticsShadowDecisionDelta,
): LogisticsShadowCausalCode {
  if (sample.status === "unresolved") {
    return sample.unresolvedReason || "input_unavailable";
  }
  if (sample.status === "equal") return "matched";
  if (sample.shadow && !isSynthesisShadowRouteDecision(sample.shadow)) {
    return sample.shadow.reason;
  }
  if (
    sample.legacy?.kind === "route" &&
    sample.shadow &&
    isSynthesisShadowRouteDecision(sample.shadow)
  ) {
    return decisionDelta === "different_route" ||
        sample.legacy.route.sourceRoom !== sample.shadow.sourceRoom
      ? "route_rank"
      : "route_fact_difference";
  }
  if (sample.legacy?.kind === "none") {
    return sample.legacy.blocker || "legacy_blocker";
  }
  return "route_fact_difference";
}

function projectLogisticsShadowComparisonSample(
  comparison: SynthesisShadowComparisonSample,
  intent: LatestLogisticsDemandV1,
  producerReason?: LogisticsShadowComparisonReason,
): LogisticsShadowRuntimeComparisonSampleV2 {
  const reason = getLogisticsShadowComparisonReason(comparison);
  const decisionDelta = getLogisticsShadowDecisionDelta(comparison);
  const legacy = comparison.legacy?.kind === "route"
    ? projectLogisticsShadowRouteOutcome(comparison.legacy.route)
    : comparison.legacy?.kind === "none"
      ? {
          kind: "none" as const,
          blocker: comparison.legacy.blocker,
          coverage: comparison.legacy.coverage,
          capacity: comparison.legacy.capacity,
          staging: comparison.legacy.predictedStagingEligibility,
        }
      : undefined;
  let shadow:
    | LogisticsShadowRuntimeRouteOutcomeV2
    | LogisticsShadowRuntimeShadowUnmatchedOutcomeV2
    | undefined;
  if (comparison.shadow) {
    shadow = isSynthesisShadowRouteDecision(comparison.shadow)
      ? projectLogisticsShadowRouteOutcome(comparison.shadow)
      : {
          kind: "unmatched",
          reason: comparison.shadow.reason,
          coverage: comparison.shadow.coverage,
          capacity: comparison.shadow.capacity,
          staging: comparison.shadow.predictedStagingEligibility,
          uncoveredAmount: comparison.shadow.uncoveredAmount,
        };
  }
  return {
    intentId: comparison.comparisonKey.slice(0, 256),
    targetRoomName: intent.targetRoomName,
    resource: intent.resource,
    status: comparison.status,
    reason,
    ...(producerReason ? { producerReason } : {}),
    decisionDelta,
    direction: getLogisticsShadowDifferenceDirection(
      comparison,
      decisionDelta,
    ),
    causalCode: getLogisticsShadowCausalCode(comparison, decisionDelta),
    differingDimensions: mapLogisticsShadowDifferences(
      comparison.differences,
    ),
    ...(legacy ? { legacy } : {}),
    ...(shadow ? { shadow } : {}),
    ...(comparison.shadow?.candidateTrace
      ? {
          candidate: projectLogisticsShadowCandidateTrace(
            comparison.shadow.candidateTrace,
          ),
        }
      : {}),
  };
}

function logisticsShadowSamplePriority(
  sample: LogisticsShadowRuntimeComparisonSampleV2,
): number {
  if (sample.reason === "unsafe_candidate") return 0;
  if (sample.status === "unresolved" || sample.reason === "input_unavailable") {
    return 1;
  }
  if (sample.status === "different") return 2;
  return 3;
}

function projectLogisticsShadowComparisons(
  result: SynthesisShadowMatcherResult,
  intentById: ReadonlyMap<string, LatestLogisticsDemandV1>,
  producerReasonByComparisonKey: ReadonlyMap<
    string,
    LogisticsShadowComparisonReason
  > = new Map(),
): Pick<ResourceControlLogisticsRuntimeV2, "comparison" | "matcher"> {
  const dimensions = createLogisticsShadowDimensionSummary();
  const byReason: Partial<Record<LogisticsShadowComparisonReason, number>> = {};
  const byDecisionDelta: Partial<Record<LogisticsShadowDecisionDelta, number>> = {};
  const byCausalCode: Partial<Record<LogisticsShadowCausalCode, number>> = {};
  const allSamples: LogisticsShadowRuntimeComparisonSampleV2[] = [];
  for (const comparison of result.comparisons) {
    const reason = getLogisticsShadowComparisonReason(comparison);
    byReason[reason] = (byReason[reason] || 0) + 1;
    const differingDimensions = mapLogisticsShadowDifferences(
      comparison.differences,
    );
    for (const dimension of LOGISTICS_SHADOW_DIMENSIONS) {
      const summary = dimensions[dimension];
      if (comparison.status === "unresolved") summary.unresolved += 1;
      else if (differingDimensions.includes(dimension)) summary.different += 1;
      else summary.matched += 1;
    }
    const intent = intentById.get(comparison.comparisonKey);
    if (!intent) continue;
    const sample = projectLogisticsShadowComparisonSample(
      comparison,
      intent,
      producerReasonByComparisonKey.get(comparison.comparisonKey),
    );
    byDecisionDelta[sample.decisionDelta] =
      (byDecisionDelta[sample.decisionDelta] || 0) + 1;
    byCausalCode[sample.causalCode] =
      (byCausalCode[sample.causalCode] || 0) + 1;
    allSamples.push(sample);
  }
  allSamples.sort((left, right) =>
    logisticsShadowSamplePriority(left) -
      logisticsShadowSamplePriority(right) ||
    left.intentId.localeCompare(right.intentId),
  );
  const samples = allSamples.slice(
    0,
    Math.min(
      SYNTHESIS_SHADOW_MAX_COMPARISON_SAMPLES,
      LOGISTICS_SHADOW_CAUSAL_SAMPLE_LIMIT,
    ),
  );
  return {
    comparison: {
      total: result.metrics.comparisonCount,
      matched: result.metrics.equalCount,
      different: result.metrics.differentCount,
      unresolved: result.metrics.unresolvedCount,
      byReason,
      byDecisionDelta,
      byCausalCode,
      dimensions,
      sampled: samples.length,
      detailsDropped: Math.max(0, result.metrics.comparisonCount - samples.length),
      samples,
    },
    matcher: {
      indexBuilds: 1,
      candidateEvaluations: result.metrics.candidateEvaluations,
      transactionCostEvaluations: result.metrics.transactionCostEvaluations,
      totalTransactionCostEvaluations:
        result.metrics.totalTransactionCostEvaluations,
      candidateBudget: result.metrics.candidateBudget,
      budgetExhausted: result.metrics.candidateBudgetExhausted,
      // 首片尚未持久化完整 residual/fold；不得把短 token 伪装为可恢复 cursor。
    },
  };
}

function addLogisticsShadowAmount(
  target: Map<string, number>,
  key: string,
  amount: number,
): void {
  if (amount <= 0) return;
  target.set(key, (target.get(key) || 0) + amount);
}

function createLogisticsShadowSelfExclusion(): LogisticsShadowSelfExclusion {
  return {
    outgoingByRoomResource: new Map<string, number>(),
    incomingByRoomResource: new Map<string, number>(),
    incomingByRoom: new Map<string, number>(),
    feeByRoom: new Map<string, number>(),
  };
}

function getLogisticsShadowInputRevision(
  intent: LatestLogisticsDemandV1,
): string {
  return `${intent.id}@${intent.revision}`;
}

function validateAndRecordLogisticsShadowSelfExclusion(
  record: LogisticsShadowInputRecord,
  context: ResourceControlTransferContext,
  selfExclusion: LogisticsShadowSelfExclusion,
  claimedTaskIds: Set<string>,
): boolean {
  const { intent, observation } = record;
  if (!observation) return false;
  if (
    observation.intentId !== intent.id ||
    observation.producer !== intent.producer ||
    observation.demandKey !== intent.demandKey ||
    observation.observedAt !== intent.observedAt ||
    observation.observedAt !== Game.time ||
    observation.comparableReason !== "comparable" ||
    observation.legacyPriorityRank !== 2 ||
    observation.legacyPriorityClass !== "production" ||
    intent.priorityClass !== "production" ||
    !intent.product ||
    intent.demandKey !==
      JSON.stringify([
        "synthesis_room/v1",
        intent.targetRoomName,
        intent.product,
        intent.resource,
      ]) ||
    observation.uncoveredAmount !==
      Math.max(
        0,
        intent.desiredAmount -
          observation.localAmount -
          observation.incomingAmount,
      )
  ) {
    return false;
  }

  const addedAmount = observation.legacyAddedAmount || 0;
  const feeDelta = observation.legacyFeeDelta || 0;
  const remainingBefore = observation.legacyRemainingBefore || 0;
  if (!Number.isSafeInteger(addedAmount) || addedAmount < 0) return false;
  if (!Number.isSafeInteger(feeDelta) || feeDelta < 0) return false;
  if (!Number.isSafeInteger(remainingBefore) || remainingBefore < 0) {
    return false;
  }
  if (addedAmount === 0) {
    const validNoOp =
      observation.legacyDecision === "no_op" &&
      observation.uncoveredAmount === 0;
    const validNoDonor =
      observation.legacyDecision === "no_donor" &&
      observation.uncoveredAmount > 0;
    return (
      (validNoOp || validNoDonor) &&
      feeDelta === 0 &&
      observation.legacyTaskId === undefined &&
      observation.legacySourceRoomName === undefined &&
      observation.legacyAmount === 0 &&
      remainingBefore === 0
    );
  }
  if (
    (observation.legacyDecision !== "created" &&
      observation.legacyDecision !== "merged") ||
    observation.legacyAmount !== addedAmount ||
    !observation.legacyTaskId ||
    !observation.legacySourceRoomName ||
    claimedTaskIds.has(observation.legacyTaskId)
  ) {
    return false;
  }
  const task = context.taskById.get(observation.legacyTaskId);
  const source = context.snapshotByRoom.get(observation.legacySourceRoomName);
  if (
    !task ||
    !source ||
    task.status !== "pending" ||
    task.origin !== "automatic" ||
    task.updatedAt !== Game.time ||
    task.fromRoomName !== observation.legacySourceRoomName ||
    task.toRoomName !== intent.targetRoomName ||
    task.resource !== intent.resource ||
    task.reason !==
      `synthesis:${intent.targetRoomName}:${intent.product}` ||
    (observation.legacyDecision === "created" && remainingBefore !== 0) ||
    (observation.legacyDecision === "created" &&
      task.createdAt !== Game.time) ||
    (observation.legacyDecision === "merged" && remainingBefore <= 0) ||
    task.remainingAmount !== remainingBefore + addedAmount
  ) {
    return false;
  }
  const contribution = context.taskContributionById.get(task.id);
  if (
    contribution?.outgoingAmount !== task.remainingAmount ||
    contribution.incomingAmount !== task.remainingAmount
  ) {
    return false;
  }
  const beforeBatch = Math.min(source.transferBatchSize, remainingBefore);
  const afterBatch = Math.min(source.transferBatchSize, task.remainingAmount);
  const beforeFee = beforeBatch > 0
    ? Game.market.calcTransactionCost(
        beforeBatch,
        task.fromRoomName,
        task.toRoomName,
      )
    : 0;
  const afterFee = afterBatch > 0
    ? Game.market.calcTransactionCost(
        afterBatch,
        task.fromRoomName,
        task.toRoomName,
      )
    : 0;
  const expectedFeeDelta = Math.max(0, afterFee - beforeFee);
  if (
    feeDelta !== expectedFeeDelta ||
    (context.outgoingFeeByTaskId.get(task.id) || 0) !== afterFee
  ) {
    return false;
  }

  claimedTaskIds.add(task.id);
  addLogisticsShadowAmount(
    selfExclusion.outgoingByRoomResource,
    roomResourceKey(task.fromRoomName, task.resource),
    addedAmount,
  );
  addLogisticsShadowAmount(
    selfExclusion.incomingByRoomResource,
    roomResourceKey(task.toRoomName, task.resource),
    addedAmount,
  );
  addLogisticsShadowAmount(
    selfExclusion.incomingByRoom,
    task.toRoomName,
    addedAmount,
  );
  addLogisticsShadowAmount(
    selfExclusion.feeByRoom,
    task.fromRoomName,
    feeDelta,
  );
  return true;
}

function getLogisticsShadowReceiverHeadroom(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  context: ResourceControlCommitmentReadContext,
  selfExclusion: LogisticsShadowSelfExclusion,
  localCommitmentByTargetId?: ReadonlyMap<string, number>,
): {
  storage: number;
  terminal: number;
  resource: number;
} {
  const availability = context.receiverCapacityLedger.getAvailability(
    snapshot.roomName,
    resource,
  );
  const totalDelta =
    selfExclusion.incomingByRoom.get(snapshot.roomName) || 0;
  const resourceDelta =
    selfExclusion.incomingByRoomResource.get(
      roomResourceKey(snapshot.roomName, resource),
    ) || 0;
  const storageLocalCommitment = snapshot.storage
    ? localCommitmentByTargetId?.get(snapshot.storage.id) ??
      getLocalCarrierDestinationCommittedAmount(snapshot.storage.id)
    : 0;
  const terminalLocalCommitment =
    localCommitmentByTargetId?.get(snapshot.terminal.id) ??
    getLocalCarrierDestinationCommittedAmount(snapshot.terminal.id);
  const previousTotalCommitted = Math.max(
    0,
    availability.totalCommitted - totalDelta,
  );
  const previousResourceCommitted = Math.max(
    0,
    availability.resourceCommitted - resourceDelta,
  );
  return {
    storage: Math.max(
      0,
      availability.storageSafeCapacity -
        previousTotalCommitted -
        availability.reservationTotal -
        storageLocalCommitment,
    ),
    terminal: Math.max(
      0,
      availability.terminalTotalSafeCapacity -
        previousTotalCommitted -
        availability.reservationTotal -
        terminalLocalCommitment,
    ),
    resource: Math.max(
      0,
      availability.terminalResourceFreeCapacity -
        previousResourceCommitted -
        availability.reservationResource -
        terminalLocalCommitment,
    ),
  };
}

function createLogisticsShadowRoomFacts(
  snapshots: ResourceControlSnapshot[],
  resources: readonly ResourceConstant[],
  epochRevision: string,
  epochFingerprint: string,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlCommitmentReadContext,
  selfExclusion: LogisticsShadowSelfExclusion,
  localCommitmentByTargetId?: ReadonlyMap<string, number>,
  capturedSourceFacts?: LogisticsShadowCapturedSourceFacts,
): SynthesisShadowRoomFact[] {
  const provisional = snapshots.map((snapshot): SynthesisShadowRoomFact => {
    const receiverBaseline = getLogisticsShadowReceiverHeadroom(
      snapshot,
      resources[0] || RESOURCE_ENERGY,
      context,
      selfExclusion,
      localCommitmentByTargetId,
    );
    const outgoingEnergyDelta =
      selfExclusion.outgoingByRoomResource.get(
        roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
      ) || 0;
    const actionEnergyBudget =
      (capturedSourceFacts?.actionEnergyBudgetByRoom.get(snapshot.roomName) ??
        getTerminalActionEnergyBudget(snapshot, context)) +
      outgoingEnergyDelta +
      (selfExclusion.feeByRoom.get(snapshot.roomName) || 0);
    const terminalEnergyOutsideMarketExposure =
      capturedSourceFacts?.terminalOutsideExposureByRoomResource.get(
        roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
      ) ??
      getTerminalAmountOutsideMarketSaleExposure(
        snapshot.terminal,
        RESOURCE_ENERGY,
        snapshot.roomName,
      );
    const terminalActionEnergyAmount = Math.min(
      actionEnergyBudget,
      terminalEnergyOutsideMarketExposure,
    );
    const terminalReadyAt =
      Game.time + Math.max(
        0,
        Math.floor(
          snapshot.terminalCooldown ?? snapshot.terminal.cooldown ?? 0,
        ),
      );
    const { feedCapacity } = getTerminalLogisticsCapacityPlan(
      snapshot,
      capacityConfig,
    );
    const terminalLocalCommitment =
      localCommitmentByTargetId?.get(snapshot.terminal.id) ??
      getLocalCarrierDestinationCommittedAmount(snapshot.terminal.id);
    return {
      roomName: snapshot.roomName,
      epochRevision,
      epochFingerprint,
      revision: `pending:${Game.time}`,
      observedAt: Game.time,
      expiresAt: Game.time + Math.max(30, getResourceControlSampleInterval() * 2),
      owned: true,
      hasStorage: !!snapshot.storage,
      hasTerminal: true,
      terminalReachable: true,
      terminalReadyAt,
      transferBatchSize: snapshot.transferBatchSize,
      capacityState: snapshot.capacityState,
      receiverEligible: isReceiverAdmissionEligible(
        snapshot.storageFreeCapacity,
        snapshot.terminalFreeCapacity,
        snapshot.capacityState,
        capacityConfig,
      ),
      receiverStorageHeadroom: receiverBaseline.storage,
      receiverTerminalHeadroom: receiverBaseline.terminal,
      terminalStagingFreeCapacity: Math.max(
        0,
        feedCapacity - terminalLocalCommitment,
      ),
      actionEnergyBudget,
      terminalActionEnergyAmount,
      resources: resources.map((resource) => {
        const receiver = getLogisticsShadowReceiverHeadroom(
          snapshot,
          resource,
          context,
          selfExclusion,
          localCommitmentByTargetId,
        );
        const policyAvailableAmount =
          (capturedSourceFacts?.sourceAvailableByRoomResource.get(
            roomResourceKey(snapshot.roomName, resource),
          ) ??
            getTotalMovableResourceAmount(
              snapshot,
              resource,
              capacityConfig,
              context,
            )) +
          (selfExclusion.outgoingByRoomResource.get(
            roomResourceKey(snapshot.roomName, resource),
          ) || 0) +
          (resource === RESOURCE_ENERGY
            ? selfExclusion.feeByRoom.get(snapshot.roomName) || 0
            : 0);
        const terminalOutsideMarketExposure =
          resource === RESOURCE_ENERGY
            ? terminalActionEnergyAmount
            : capturedSourceFacts?.terminalOutsideExposureByRoomResource.get(
                roomResourceKey(snapshot.roomName, resource),
              ) ??
              getTerminalAmountOutsideMarketSaleExposure(
                snapshot.terminal,
                resource,
                snapshot.roomName,
              );
        const sourceAvailableAmount = resource === RESOURCE_ENERGY
          ? policyAvailableAmount
          : Math.min(
              policyAvailableAmount,
              getStorageResourceAmount(snapshot, resource) +
                terminalOutsideMarketExposure,
            );
        return {
          resource,
          sourceAvailableAmount,
          sourceTerminalAmount: Math.min(
            sourceAvailableAmount,
            terminalOutsideMarketExposure,
          ),
          receiverResourceHeadroom: receiver.resource,
        };
      }),
    };
  });
  return provisional;
}

export type SynthesisShadowEpochCaptureFailureReason =
  | "cpu_unavailable"
  | "shadow_unavailable"
  | "not_planning_tick"
  | "no_rooms"
  | "tick_changed"
  | "already_built"
  | "invalid_resources";

export interface SynthesisShadowEpochRoomFactBuildSuccess {
  readonly ok: true;
  readonly epochRevision: string;
  readonly epochFingerprint: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly captureCpuUsed: number;
  readonly indexBuildCount: 1;
  readonly roomFacts: readonly SynthesisShadowRoomFact[];
}

export type SynthesisShadowEpochRoomFactBuildResult =
  | SynthesisShadowEpochRoomFactBuildSuccess
  | {
      readonly ok: false;
      readonly reason: SynthesisShadowEpochCaptureFailureReason;
    };

export interface SynthesisShadowEpochCaptureSession {
  readonly ok: true;
  readonly observedAt: number;
  readonly epochRevision: string;
  readonly tasks: readonly Readonly<ResourceTransferTask>[];
  buildRoomFacts(
    resources: readonly ResourceConstant[],
  ): SynthesisShadowEpochRoomFactBuildResult;
}

export type SynthesisShadowEpochCaptureResult =
  | SynthesisShadowEpochCaptureSession
  | {
      readonly ok: false;
      readonly reason: SynthesisShadowEpochCaptureFailureReason;
    };

/**
 * 原 canonicalizeSynthesisShadowEpochFacts 的等价确定性摘要：同一字段集合、
 * 同一排序规则，但直接增量混入 FNV 状态，不构建中间大字符串。分隔符 mix
 * 防止相邻字段值拼接歧义；哈希值只在单次部署内比较。
 */
function hashSynthesisShadowEpochFacts(
  resources: readonly ResourceConstant[],
  facts: readonly SynthesisShadowRoomFact[],
): string {
  let hash = 0x811c9dc5;
  const mixString = (value: string): void => {
    const length = value.length;
    let index = 0;
    for (; index + 1 < length; index += 2) {
      hash ^= value.charCodeAt(index) | (value.charCodeAt(index + 1) << 16);
      hash = Math.imul(hash, 0x01000193);
    }
    if (index < length) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  };
  const mixNumber = (value: number): void => {
    // room facts 数值全为安全整数：直接位混合避免逐数字符串化分配；
    // 非整数（不应出现）回退字符串路径保持确定性。
    if (Number.isSafeInteger(value)) {
      hash ^= value & 0xffff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= Math.floor(value / 0x10000) & 0xffff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= 0x1f;
      hash = Math.imul(hash, 0x01000193);
      return;
    }
    mixString(`${value}`);
  };
  const mixFlag = (value: boolean): void => {
    mixString(value ? "1" : "0");
  };
  mixString("synthesis-room-epoch/v2");
  mixString([...resources].sort().join(","));
  const sortedFacts = [...facts].sort((left, right) =>
    left.roomName.localeCompare(right.roomName),
  );
  for (const room of sortedFacts) {
    mixString(room.roomName);
    mixNumber(room.observedAt);
    mixNumber(room.expiresAt);
    mixFlag(room.owned);
    mixFlag(room.hasStorage);
    mixFlag(room.hasTerminal);
    mixFlag(room.terminalReachable);
    mixNumber(room.terminalReadyAt);
    mixNumber(room.transferBatchSize);
    mixString(room.capacityState);
    mixFlag(room.receiverEligible);
    mixNumber(room.receiverStorageHeadroom);
    mixNumber(room.receiverTerminalHeadroom);
    mixNumber(room.terminalStagingFreeCapacity);
    mixNumber(room.actionEnergyBudget);
    mixNumber(room.terminalActionEnergyAmount);
    const sortedResources = [...room.resources].sort((left, right) =>
      left.resource.localeCompare(right.resource),
    );
    for (const resource of sortedResources) {
      mixString(resource.resource);
      mixNumber(resource.sourceAvailableAmount);
      mixNumber(resource.sourceTerminalAmount);
      mixNumber(resource.receiverResourceHeadroom);
    }
  }
  return (hash >>> 0).toString(36);
}

/**
 * 在 Synthesis 写任何 legacy task 前冻结一次 P0 ResourceControl 索引。
 * session 只闭包持有本 tick 的数值索引；后续 build 不重新扫描 task store。
 */
export function beginSynthesisShadowEpochCapture(
  demandResources: readonly ResourceConstant[],
): SynthesisShadowEpochCaptureResult {
  const logisticsConfig = resolveLogisticsControlConfig();
  if (
    Memory.cfg?.resourceControl?.enabled === false ||
    !logisticsConfig.valid ||
    logisticsConfig.mode !== "shadow"
  ) {
    return { ok: false, reason: "shadow_unavailable" };
  }
  if (!isResourceControlFullPlanningTick()) {
    return { ok: false, reason: "not_planning_tick" };
  }
  const normalizedDemandResources = [...new Set(demandResources)].sort();
  if (
    normalizedDemandResources.length > LOGISTICS_CONTROL_STORE_LIMIT ||
    normalizedDemandResources.some((resource) =>
      !RESOURCES_ALL.includes(resource),
    )
  ) {
    return { ok: false, reason: "invalid_resources" };
  }
  const capturedResources = [
    ...new Set([...normalizedDemandResources, RESOURCE_ENERGY]),
  ].sort();
  const cpuStartedAt = readLogisticsShadowCpuUsed();
  if (cpuStartedAt === undefined) {
    return { ok: false, reason: "cpu_unavailable" };
  }
  const observedAt = Game.time;
  const snapshots = collectResourceControlSnapshots(capturedResources);
  if (snapshots.length === 0) return { ok: false, reason: "no_rooms" };
  const capacityConfig = resolveCapacityConfig();
  const buildCounter: ResourceControlCapacityIndexBuildCounter = { count: 0 };
  const context = createSynthesisShadowCaptureContext(
    snapshots,
    capacityConfig,
    buildCounter,
  );
  if (
    buildCounter.count !== 1 ||
    context.indexBuildCount !== 1 ||
    context.productionReservationScanCount !== 1 ||
    context.invalidRecordCount > 0
  ) {
    return { ok: false, reason: "invalid_resources" };
  }
  const frozenTasks = context.tasks.map((task) =>
    Object.freeze({ ...task }) as Readonly<ResourceTransferTask>,
  );
  const localCommitmentByTargetId = new Map<string, number>();
  const actionEnergyBudgetByRoom = new Map<string, number>();
  const sourceAvailableByRoomResource = new Map<string, number>();
  const terminalOutsideExposureByRoomResource = new Map<string, number>();
  const marketExposureIndex = compileLiveMarketSaleTerminalExposureIndex();
  for (const snapshot of snapshots) {
    if (snapshot.storage) {
      localCommitmentByTargetId.set(
        snapshot.storage.id,
        getLocalCarrierDestinationCommittedAmount(snapshot.storage.id),
      );
    }
    localCommitmentByTargetId.set(
      snapshot.terminal.id,
      getLocalCarrierDestinationCommittedAmount(snapshot.terminal.id),
    );
    const terminalAmountsOutsideExposure =
      getTerminalAmountsOutsideMarketSaleExposure(
        snapshot.terminal,
        capturedResources,
        marketExposureIndex,
        {
          roomName: snapshot.roomName,
          storedAmounts: snapshot.terminalResourceAmounts,
        },
      );
    for (const resource of capturedResources) {
      terminalOutsideExposureByRoomResource.set(
        roomResourceKey(snapshot.roomName, resource),
        terminalAmountsOutsideExposure.get(resource) || 0,
      );
    }
    const terminalEnergyOutsideMarketExposure =
      terminalOutsideExposureByRoomResource.get(
        roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
      ) || 0;
    const actionEnergyBudget = getTerminalActionEnergyBudget(
      snapshot,
      context,
      undefined,
      terminalEnergyOutsideMarketExposure,
    );
    actionEnergyBudgetByRoom.set(snapshot.roomName, actionEnergyBudget);
    terminalOutsideExposureByRoomResource.set(
      roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
      Math.min(actionEnergyBudget, terminalEnergyOutsideMarketExposure),
    );
    for (const resource of capturedResources) {
      sourceAvailableByRoomResource.set(
        roomResourceKey(snapshot.roomName, resource),
        resource === RESOURCE_ENERGY
          ? actionEnergyBudget
          : getTotalMovableResourceAmount(
              snapshot,
              resource,
              capacityConfig,
              context,
            ),
      );
    }
  }
  const capturedSourceFacts: LogisticsShadowCapturedSourceFacts = {
    actionEnergyBudgetByRoom,
    sourceAvailableByRoomResource,
    terminalOutsideExposureByRoomResource,
  };
  const cpuCapturedAt = readLogisticsShadowCpuUsed();
  if (cpuCapturedAt === undefined) {
    return { ok: false, reason: "cpu_unavailable" };
  }
  const beginCpuUsed = Math.max(0, cpuCapturedAt - cpuStartedAt);
  const epochRevision = `synthesis-room-epoch/v1:${observedAt}:${
    logisticsShadowHash(
      snapshots
        .map((snapshot) => snapshot.roomName)
        .sort()
        .join("|"),
    )
  }`;
  let built = false;
  return {
    ok: true,
    observedAt,
    epochRevision,
    tasks: Object.freeze(frozenTasks),
    buildRoomFacts(
      resources: readonly ResourceConstant[],
    ): SynthesisShadowEpochRoomFactBuildResult {
      if (built) return { ok: false, reason: "already_built" };
      built = true;
      if (Game.time !== observedAt) {
        return { ok: false, reason: "tick_changed" };
      }
      const normalizedResources = [...new Set(resources)].sort();
      if (
        normalizedResources.length > LOGISTICS_CONTROL_STORE_LIMIT ||
        normalizedResources.some((resource) =>
          !normalizedDemandResources.includes(resource),
        )
      ) {
        return { ok: false, reason: "invalid_resources" };
      }
      const buildCpuStartedAt = readLogisticsShadowCpuUsed();
      if (buildCpuStartedAt === undefined) {
        return { ok: false, reason: "cpu_unavailable" };
      }
      const provisional = normalizedResources.length === 0
        ? []
        : createLogisticsShadowRoomFacts(
            snapshots,
            normalizedResources,
            epochRevision,
            "pending",
            capacityConfig,
            context,
            createLogisticsShadowSelfExclusion(),
            localCommitmentByTargetId,
            capturedSourceFacts,
          );
      const epochFingerprint = `synthesis-room-epoch/v1:${
        hashSynthesisShadowEpochFacts(normalizedResources, provisional)
      }`;
      const roomFacts = provisional.map((room) => ({
        ...room,
        epochFingerprint,
        revision: `${room.roomName}@${epochRevision}`,
        resources: room.resources.map((resource) => ({ ...resource })),
      }));
      const buildCpuFinishedAt = readLogisticsShadowCpuUsed();
      if (buildCpuFinishedAt === undefined) {
        return { ok: false, reason: "cpu_unavailable" };
      }
      const captureCpuUsed = Math.max(
        0,
        Math.round(
          (beginCpuUsed + buildCpuFinishedAt - buildCpuStartedAt) * 1_000,
        ) / 1_000,
      );
      return {
        ok: true,
        epochRevision,
        epochFingerprint,
        observedAt,
        expiresAt:
          observedAt + Math.max(30, getResourceControlSampleInterval() * 2),
        captureCpuUsed,
        indexBuildCount: 1,
        roomFacts,
      };
    },
  };
}

function findSynthesisProducerSnapshot(
  snapshots: Readonly<Record<string, LogisticsProducerSnapshotV1>>,
): LogisticsProducerSnapshotV1 | undefined {
  return Object.values(snapshots).find(
    (snapshot) => snapshot.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
  );
}

function buildSynthesisShadowDemand(
  record: LogisticsShadowInputRecord,
  epochRevision: string,
  epochFingerprint: string,
  context: ResourceControlTransferContext,
): SynthesisShadowDemandObservation {
  const { intent, observation } = record;
  const target = context.snapshotByRoom.get(intent.targetRoomName);
  const minimumBatchAmount = intent.minBatch ?? 1;
  const maximumBatchAmount =
    intent.maxBatch ?? target?.transferBatchSize ?? DEFAULT_ROOM_CONFIG.transferBatchSize;
  return {
    comparisonKey: intent.id,
    demandKey: intent.demandKey,
    origin: "synthesis_room",
    epochRevision,
    epochFingerprint,
    revision: record.inputRevision,
    inputFingerprint:
      observation?.inputFingerprint || `missing:${intent.id}`,
    targetRoom: intent.targetRoomName,
    resource: intent.resource,
    ...(intent.product ? { product: intent.product } : {}),
    desiredAmount: intent.desiredAmount,
    localAmount: observation?.localAmount || 0,
    healthyIncomingAmount: observation?.incomingAmount || 0,
    minimumBatchAmount,
    maximumBatchAmount,
    priorityClass: intent.priorityClass,
    firstObservedAt: intent.firstObservedAt,
    // 缺失 observation 时排最后（与输入收集侧 decisionOrder 排序的兜底一致）。
    decisionOrder: observation?.decisionOrder ?? Number.MAX_SAFE_INTEGER,
    observedAt: intent.observedAt,
    expiresAt: intent.expiresAt,
    ...(intent.deadlineAt === undefined
      ? {}
      : { deadlineAt: intent.deadlineAt }),
    ...(intent.fixedSourceRoomNames
      ? { allowedSourceRooms: intent.fixedSourceRoomNames }
      : {}),
  };
}

function getSynthesisShadowRoomResourceFact(
  room: SynthesisShadowRoomFact,
  resource: ResourceConstant,
): SynthesisShadowRoomFact["resources"][number] | undefined {
  return room.resources.find((entry) => entry.resource === resource);
}

function buildSynthesisShadowLegacyRoute(
  record: LogisticsShadowInputRecord,
  roomFactByName: ReadonlyMap<string, SynthesisShadowRoomFact>,
): SynthesisShadowRouteFact | undefined {
  const { intent, observation } = record;
  const sourceRoomName = observation?.legacySourceRoomName;
  const amount = observation?.legacyAmount || 0;
  if (
    !sourceRoomName ||
    amount <= 0 ||
    (observation?.legacyDecision !== "created" &&
      observation?.legacyDecision !== "merged")
  ) {
    return undefined;
  }
  const source = roomFactByName.get(sourceRoomName);
  const receiver = roomFactByName.get(intent.targetRoomName);
  const sourceResource = source
    ? getSynthesisShadowRoomResourceFact(source, intent.resource)
    : undefined;
  const receiverResource = receiver
    ? getSynthesisShadowRoomResourceFact(receiver, intent.resource)
    : undefined;
  if (!source || !receiver || !sourceResource || !receiverResource) {
    return undefined;
  }
  const remainingBefore = observation.legacyRemainingBefore || 0;
  const actionAmount = Math.max(
    0,
    Math.min(remainingBefore + amount, source.transferBatchSize) -
      Math.min(remainingBefore, source.transferBatchSize),
  );
  const transactionCost = observation.legacyFeeDelta || 0;
  const requiredEnergy =
    transactionCost +
    (intent.resource === RESOURCE_ENERGY ? actionAmount : 0);
  const energyCommitmentAmount =
    transactionCost +
    (intent.resource === RESOURCE_ENERGY ? amount : 0);
  const terminalFeeAmount = Math.min(
    transactionCost,
    source.terminalActionEnergyAmount,
  );
  const terminalPayloadEnergy = intent.resource === RESOURCE_ENERGY
    ? Math.max(0, source.terminalActionEnergyAmount - terminalFeeAmount)
    : Number.MAX_SAFE_INTEGER;
  const terminalAllocatedAmount = Math.min(
    actionAmount,
    sourceResource.sourceTerminalAmount,
    terminalPayloadEnergy,
  );
  const stagingRequiredAmount = actionAmount - terminalAllocatedAmount;
  const terminalEnergyAllocatedAmount =
    terminalFeeAmount +
    (intent.resource === RESOURCE_ENERGY ? terminalAllocatedAmount : 0);
  const feeStagingRequiredAmount = transactionCost - terminalFeeAmount;
  const receiverEligible =
    receiver.receiverEligible &&
    receiver.receiverStorageHeadroom >= amount &&
    receiver.receiverTerminalHeadroom >= amount &&
    receiverResource.receiverResourceHeadroom >= amount;
  const stagingEligible =
    sourceResource.sourceAvailableAmount >= amount &&
    source.actionEnergyBudget >= energyCommitmentAmount &&
    source.terminalStagingFreeCapacity >=
      stagingRequiredAmount + feeStagingRequiredAmount;
  const coveredAmount =
    (observation?.localAmount || 0) +
    (observation?.incomingAmount || 0) +
    amount;
  return {
    sourceRoom: sourceRoomName,
    targetRoom: intent.targetRoomName,
    resource: intent.resource,
    amount,
    actionAmount,
    priorityClass: observation!.legacyPriorityClass,
    coverage: coveredAmount >= intent.desiredAmount ? "covered" : "partial",
    capacity: receiverEligible ? "eligible" : "blocked",
    predictedStagingEligibility: stagingEligible ? "eligible" : "blocked",
    terminalReadyAt: source.terminalReadyAt,
    transactionCost,
    requiredEnergy,
    energyCommitmentAmount,
    terminalAllocatedAmount,
    stagingRequiredAmount,
    terminalEnergyAllocatedAmount,
    feeStagingRequiredAmount,
    stableKey: `${sourceRoomName}\u0000${intent.targetRoomName}\u0000${intent.resource}\u0000${intent.id}`,
  };
}

function buildSynthesisShadowLegacyDecision(
  record: LogisticsShadowInputRecord,
  epochRevision: string,
  epochFingerprint: string,
  roomFactByName: ReadonlyMap<string, SynthesisShadowRoomFact>,
): SynthesisShadowLegacyDecisionObservation | undefined {
  const { intent, observation } = record;
  if (!observation) return undefined;
  const route = buildSynthesisShadowLegacyRoute(record, roomFactByName);
  const inputRevision = record.inputDrift
    ? `${record.inputRevision}:drift`
    : record.inputRevision;
  const inputFingerprint = record.inputDrift
    ? `drift:${observation.inputFingerprint}`
    : observation.inputFingerprint;
  const coveredAmount = observation.localAmount + observation.incomingAmount;
  const coverage = coveredAmount >= intent.desiredAmount
    ? "covered" as const
    : observation.incomingAmount > 0
      ? "partial" as const
      : "none" as const;
  const blocker = observation.legacyDecision === "no_op"
    ? "demand_already_covered"
    : observation.legacyDecision === "no_donor"
      ? "no_donor"
      : "malformed_input";
  const base = {
    comparisonKey: intent.id,
    epochRevision,
    epochFingerprint,
    inputRevision,
    inputFingerprint,
    observedAt: observation.observedAt,
  };
  if (route) {
    const source = roomFactByName.get(route.sourceRoom);
    if (!source) return undefined;
    return {
      ...base,
      kind: "route",
      route,
      actionBasis:
        observation.legacyDecision === "created"
          ? "standalone"
          : "merge_delta",
      remainingBefore: observation.legacyRemainingBefore || 0,
      transferBatchSize: source.transferBatchSize,
    };
  }
  return {
    ...base,
    kind: "none",
    blocker,
    coverage,
    capacity: "unknown",
    predictedStagingEligibility: "unknown",
  };
}

function cloneSynthesisShadowRoomFactMap(
  facts: readonly SynthesisShadowRoomFact[],
): Map<string, SynthesisShadowRoomFact> {
  return new Map(
    facts.map((room) => [
      room.roomName,
      {
        ...room,
        resources: room.resources.map((resource) => ({ ...resource })),
      },
    ] as const),
  );
}

function applyLegacyDecisionToShadowRoomFacts(
  record: LogisticsShadowInputRecord,
  decision: SynthesisShadowLegacyDecisionObservation | undefined,
  roomFactByName: Map<string, SynthesisShadowRoomFact>,
): void {
  const observation = record.observation;
  const addedAmount = observation?.legacyAddedAmount || 0;
  const sourceRoomName = observation?.legacySourceRoomName;
  const route = decision?.route;
  if (
    record.inputDrift ||
    !sourceRoomName ||
    addedAmount <= 0 ||
    !route
  ) {
    return;
  }
  const source = roomFactByName.get(sourceRoomName);
  const receiver = roomFactByName.get(record.intent.targetRoomName);
  if (!source || !receiver) return;
  const sourceResources = source.resources.map((resource) =>
    resource.resource === record.intent.resource
      ? {
          ...resource,
          sourceAvailableAmount: Math.max(
            0,
            resource.sourceAvailableAmount - addedAmount,
          ),
          sourceTerminalAmount: Math.min(
            Math.max(
              0,
              resource.sourceTerminalAmount - route.terminalAllocatedAmount,
            ),
            Math.max(0, resource.sourceAvailableAmount - addedAmount),
          ),
        }
      : { ...resource },
  );
  const energyOwnershipDelta =
    (record.intent.resource === RESOURCE_ENERGY ? addedAmount : 0) +
    (observation?.legacyFeeDelta || 0);
  const nextActionEnergyBudget = Math.max(
    0,
    source.actionEnergyBudget - energyOwnershipDelta,
  );
  roomFactByName.set(sourceRoomName, {
    ...source,
    actionEnergyBudget: nextActionEnergyBudget,
    terminalActionEnergyAmount: Math.min(
      Math.max(
        0,
        source.terminalActionEnergyAmount -
          route.terminalEnergyAllocatedAmount,
      ),
      nextActionEnergyBudget,
    ),
    terminalStagingFreeCapacity: Math.max(
      0,
      source.terminalStagingFreeCapacity -
        route.stagingRequiredAmount -
        route.feeStagingRequiredAmount,
    ),
    resources: sourceResources,
  });
  roomFactByName.set(record.intent.targetRoomName, {
    ...receiver,
    receiverStorageHeadroom: Math.max(
      0,
      receiver.receiverStorageHeadroom - addedAmount,
    ),
    receiverTerminalHeadroom: Math.max(
      0,
      receiver.receiverTerminalHeadroom - addedAmount,
    ),
    resources: receiver.resources.map((resource) =>
      resource.resource === record.intent.resource
        ? {
            ...resource,
            receiverResourceHeadroom: Math.max(
              0,
              resource.receiverResourceHeadroom - addedAmount,
            ),
          }
        : { ...resource },
    ),
  });
}

function buildResourceControlLogisticsShadow(
  context: ResourceControlTransferContext,
): ResourceControlLogisticsRuntimeV2 {
  const config = resolveLogisticsControlConfig();
  const disabled = createEmptyLogisticsShadowRuntime(
    config.mode,
    !config.valid ? "config_invalid" : "mode_disabled",
  );
  if (!config.valid || config.mode === "disabled") {
    return disabled;
  }
  if (config.mode !== "shadow") {
    disabled.blocker = "matcher_unavailable";
    return disabled;
  }

  const read = readLogisticsControlStoreExact();
  if (read.ok === false) {
    disabled.blocker = read.reason === "missing" ? "store_missing" : "store_invalid";
    return disabled;
  }
  const store = read.store;
  const projection = createEmptyLogisticsShadowRuntime(config.mode, "input_unavailable");
  const producerSnapshot = findSynthesisProducerSnapshot(store.producerSnapshots);
  projection.intent.total = producerSnapshot?.total || 0;
  projection.intent.emitted = producerSnapshot?.emitted || 0;
  projection.intent.dropped = producerSnapshot?.dropped || 0;
  projection.intent.truncated = producerSnapshot?.truncated || false;

  const observations = store.synthesisObservations;
  const inputs: LogisticsShadowInputRecord[] = [];
  for (const intent of Object.values(store.latestIntents)) {
    const inScope =
      intent.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER &&
      intent.origin === "synthesis_room";
    addLogisticsOriginCount(
      inScope ? projection.inScopeByOrigin : projection.outOfScopeByOrigin,
      intent.origin,
    );
    if (!inScope) continue;
    const stale = intent.expiresAt < Game.time || intent.observedAt > Game.time;
    if (stale) projection.intent.stale += 1;
    else projection.intent.fresh += 1;
    if (!intent.active) continue;
    projection.intent.active += 1;
    inputs.push({
      intent,
      observation: observations[intent.id],
      inputRevision: getLogisticsShadowInputRevision(intent),
      inputDrift: false,
    });
  }
  inputs.sort((left, right) => {
    const leftOrder = left.observation?.decisionOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.observation?.decisionOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.intent.id.localeCompare(right.intent.id);
  });

  const selfExclusion = createLogisticsShadowSelfExclusion();
  const claimedTaskIds = new Set<string>();
  for (const record of inputs) {
    const paired = validateAndRecordLogisticsShadowSelfExclusion(
      record,
      context,
      selfExclusion,
      claimedTaskIds,
    );
    record.inputDrift = !paired;
    if (paired) projection.intent.paired += 1;
    if (record.inputDrift) projection.intent.inputDrift += 1;
  }
  // Legacy reason 只用于 out-of-scope 观测标签；只有通过精确
  // task identity 校验的 typed decision 才能从该统计中排除。
  for (const task of context.tasks) {
    if (task.status !== "pending" || claimedTaskIds.has(task.id)) continue;
    addLogisticsOriginCount(
      projection.outOfScopeByOrigin,
      mapLegacyTransferOrigin(task.origin, task.reason),
    );
  }

  const epochRevision =
    producerSnapshot?.epochRevision || "missing-synthesis-room-epoch";
  const epochFingerprint =
    producerSnapshot?.epochFingerprint || "missing-synthesis-room-fingerprint";
  const matcherFacts: SynthesisShadowRoomFact[] = Object.values(
    store.roomFacts,
  ).map((fact) => ({
    roomName: fact.roomName,
    epochRevision: fact.epochRevision,
    epochFingerprint: fact.epochFingerprint,
    revision: `${fact.id}@${fact.revision}`,
    observedAt: fact.observedAt,
    expiresAt: fact.expiresAt,
    owned: fact.owned,
    hasStorage: fact.hasStorage,
    hasTerminal: fact.hasTerminal,
    terminalReachable: fact.terminalReachable,
    terminalReadyAt: fact.terminalReadyAt,
    transferBatchSize: fact.transferBatchSize,
    capacityState: fact.capacityState,
    receiverEligible: fact.receiverEligible,
    receiverStorageHeadroom: fact.receiverStorageHeadroom,
    receiverTerminalHeadroom: fact.receiverTerminalHeadroom,
    terminalStagingFreeCapacity: fact.terminalStagingFreeCapacity,
    actionEnergyBudget: fact.actionEnergyBudget,
    terminalActionEnergyAmount: fact.terminalActionEnergyAmount,
    resources: fact.resources.map((resource) => ({ ...resource })),
  }));
  const demandedResources = new Set(
    inputs.map((entry) => entry.intent.resource),
  );
  const emptyEpoch =
    inputs.length === 0 &&
    matcherFacts.length === 0 &&
    producerSnapshot?.total === 0 &&
    producerSnapshot.emitted === 0 &&
    producerSnapshot.dropped === 0 &&
    !producerSnapshot.truncated;
  const populatedEpochFactsValid =
    matcherFacts.length > 0 &&
    matcherFacts.length <= SYNTHESIS_SHADOW_MAX_ROOM_FACTS &&
    matcherFacts.length === context.snapshotByRoom.size &&
    matcherFacts.every(
      (fact) =>
        context.snapshotByRoom.has(fact.roomName) &&
        fact.epochRevision === epochRevision &&
        fact.epochFingerprint === epochFingerprint &&
        fact.observedAt === producerSnapshot?.observedAt &&
        fact.expiresAt >= Game.time &&
        [...demandedResources].every((resource) =>
          fact.resources.some((entry) => entry.resource === resource),
        ),
    );
  const factTokenValid =
    !!producerSnapshot &&
    producerSnapshot.observedAt === Game.time &&
    producerSnapshot.expiresAt >= Game.time &&
    producerSnapshot.indexBuildCount === 1 &&
    (emptyEpoch || populatedEpochFactsValid);

  const roomFactByName = cloneSynthesisShadowRoomFactMap(matcherFacts);
  const demands = inputs.map((record) =>
    buildSynthesisShadowDemand(
      record,
      epochRevision,
      epochFingerprint,
      context,
    ),
  );
  const legacyDecisions: SynthesisShadowLegacyDecisionObservation[] = [];
  for (const record of inputs) {
    const decision = buildSynthesisShadowLegacyDecision(
        record,
        epochRevision,
        epochFingerprint,
        roomFactByName,
      );
    if (decision) legacyDecisions.push(decision);
    applyLegacyDecisionToShadowRoomFacts(
      record,
      decision,
      roomFactByName,
    );
  }
  const result = runSynthesisLogisticsShadow({
    now: Game.time,
    inputRevision: epochRevision,
    inputFingerprint: epochFingerprint,
    costModelRevision: "Game.market.calcTransactionCost:v1",
    demands,
    rooms: matcherFacts,
    legacyDecisions,
    candidateBudget: SYNTHESIS_SHADOW_DEFAULT_CANDIDATE_BUDGET,
    transactionCost: (amount, sourceRoom, targetRoom) =>
      Game.market.calcTransactionCost(amount, sourceRoom, targetRoom),
  });
  const producerReasonByComparisonKey = new Map<
    string,
    LogisticsShadowComparisonReason
  >();
  for (const { intent, observation } of inputs) {
    const reason = observation?.comparableReason;
    if (
      reason === "expected_policy_difference" ||
      reason === "legacy_unpaired" ||
      reason === "shadow_unpaired" ||
      reason === "unsafe_candidate" ||
      reason === "input_unavailable"
    ) {
      producerReasonByComparisonKey.set(intent.id, reason);
    }
  }
  const compared = projectLogisticsShadowComparisons(
    result,
    new Map(inputs.map(({ intent }) => [intent.id, intent] as const)),
    producerReasonByComparisonKey,
  );
  projection.comparison = compared.comparison;
  projection.matcher = compared.matcher;
  projection.matcher.indexBuilds = producerSnapshot?.indexBuildCount || 0;
  const sampledMaterialComparisons = projection.comparison.samples.filter(
    (sample) => sample.status !== "equal",
  ).length;
  if (
    sampledMaterialComparisons !==
      projection.comparison.different + projection.comparison.unresolved
  ) {
    projection.projectionTruncated = true;
    recordLogisticsShadowSafetyViolation(
      projection,
      "shadow_causal_details_truncated",
    );
  }
  projection.available = factTokenValid;
  projectLogisticsShadowObservableRecords(projection, context);
  const inScopeIntentCount = Object.values(projection.inScopeByOrigin).reduce(
    (total, count) => total + (count || 0),
    0,
  );
  const comparisonReasonCount = Object.values(
    projection.comparison.byReason,
  ).reduce((total, count) => total + (count || 0), 0);
  const comparisonDeltaCount = Object.values(
    projection.comparison.byDecisionDelta,
  ).reduce((total, count) => total + (count || 0), 0);
  const comparisonCauseCount = Object.values(
    projection.comparison.byCausalCode,
  ).reduce((total, count) => total + (count || 0), 0);
  const dimensionCountsMatch = LOGISTICS_SHADOW_DIMENSIONS.every(
    (dimension) => {
      const summary = projection.comparison.dimensions[dimension];
      return (
        summary.matched + summary.different + summary.unresolved ===
        projection.comparison.total
      );
    },
  );
  if (
    (!projection.intent.truncated &&
      inScopeIntentCount !== projection.intent.total) ||
    projection.intent.fresh + projection.intent.stale !==
      projection.intent.emitted ||
    projection.comparison.total !== projection.intent.active ||
    comparisonReasonCount !== projection.comparison.total ||
    comparisonDeltaCount !== projection.comparison.total ||
    comparisonCauseCount !== projection.comparison.total ||
    projection.comparison.sampled !== projection.comparison.samples.length ||
    projection.comparison.sampled + projection.comparison.detailsDropped !==
      projection.comparison.total ||
    !dimensionCountsMatch
  ) {
    projection.safety.violations.push("shadow_projection_count_mismatch");
  }
  projection.complete =
    result.complete &&
    result.metrics.unresolvedCount === 0 &&
    !producerSnapshot?.truncated &&
    (producerSnapshot?.dropped || 0) === 0 &&
    !!producerSnapshot &&
    producerSnapshot.observedAt === Game.time &&
    factTokenValid &&
    projection.safety.violations.length === 0;
  if (projection.complete) delete projection.blocker;
  else projection.blocker = "input_unavailable";
  return projection;
}

function getCapacityReliefRecoveryGap(
  source: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
): number {
  if (source.terminalFreeCapacity < config.terminalReliefTargetFreeCapacity) {
    return (
      config.terminalReliefTargetFreeCapacity - source.terminalFreeCapacity
    );
  }
  return Math.max(
    0,
    config.storageReliefTargetFreeCapacity - source.storageFreeCapacity,
  );
}

function computeSafeCapacityReliefAmount(
  source: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  requestedAmount: number,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  const resourceMovable = getTotalMovableResourceAmount(
    source,
    resource,
    config,
    context,
    excludeTaskId,
  );
  const candidate = Math.floor(Math.min(requestedAmount, resourceMovable));
  if (resource !== RESOURCE_ENERGY) {
    return candidate;
  }

  const energyBudget = getTotalMovableResourceAmount(
    source,
    RESOURCE_ENERGY,
    config,
    context,
    excludeTaskId,
  );
  return computeLargestAffordableAmount(candidate, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiverRoomName,
    );
    return amount + fee <= energyBudget;
  });
}

function getStoredResources(store: StoreDefinition): ResourceConstant[] {
  return RESOURCES_ALL.filter(
    (resource) => store.getUsedCapacity(resource) > 0,
  );
}

function selectTerminalReliefResource(
  source: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  includeEnergy = true,
): { resource: ResourceConstant; movableAmount: number } | null {
  if (source.terminalFreeCapacity >= config.terminalReliefTargetFreeCapacity) {
    return null;
  }

  const candidates = getStoredResources(source.terminal.store)
    .map((resource) => ({
      resource,
      movableAmount: getMovableResourceAmount(
        source,
        resource,
        "terminal",
        config,
        context,
      ),
    }))
    .filter(
      (candidate) => includeEnergy || candidate.resource !== RESOURCE_ENERGY,
    )
    .filter((candidate) => candidate.movableAmount > 0)
    .sort((left, right) => {
      if (
        left.resource === RESOURCE_ENERGY &&
        right.resource !== RESOURCE_ENERGY
      )
        return 1;
      if (
        right.resource === RESOURCE_ENERGY &&
        left.resource !== RESOURCE_ENERGY
      )
        return -1;
      if (left.movableAmount !== right.movableAmount)
        return right.movableAmount - left.movableAmount;
      return left.resource.localeCompare(right.resource);
    });
  return candidates[0] || null;
}

function selectStorageReliefResource(
  source: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  includeEnergy = true,
): { resource: ResourceConstant; movableAmount: number } | null {
  if (
    !source.storage ||
    source.storageFreeCapacity >= config.storageReliefTargetFreeCapacity
  ) {
    return null;
  }

  const candidates = getStoredResources(source.storage.store)
    .map((resource) => ({
      resource,
      movableAmount: getMovableResourceAmount(
        source,
        resource,
        "storage",
        config,
        context,
      ),
    }))
    .filter(
      (candidate) => includeEnergy || candidate.resource !== RESOURCE_ENERGY,
    )
    .filter((candidate) => candidate.movableAmount > 0)
    .sort((left, right) => {
      if (left.movableAmount !== right.movableAmount)
        return right.movableAmount - left.movableAmount;
      return left.resource.localeCompare(right.resource);
    });
  return candidates[0] || null;
}

function getCapacityReliefReceivableAmount(
  receiver: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
): number {
  return getReceiverSafeCapacity(
    receiver.storageFreeCapacity,
    receiver.terminalFreeCapacity,
    config,
  );
}

function getCapacityReliefLedgerAvailableAmount(
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  return context.receiverCapacityLedger.getAvailableAmount(
    receiver.roomName,
    resource,
    excludeTaskId,
  );
}

function isCapacityReliefReceiverEligible(
  receiver: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
): boolean {
  return (
    !!receiver.storage &&
    isReceiverAdmissionEligible(
      receiver.storageFreeCapacity,
      receiver.terminalFreeCapacity,
      receiver.capacityState,
      config,
    )
  );
}

function planCapacityReliefTasks(
  snapshots: ResourceControlSnapshot[],
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
): string[] {
  if (!config.enabled) {
    return [];
  }

  const actions: string[] = [];
  let created = 0;
  const existingCapacityTaskBySource = new Map<string, ResourceTransferTask>();
  const activeOutgoingSourceRooms = new Set<string>();
  for (const task of context.tasks) {
    if (
      !existingCapacityTaskBySource.has(task.fromRoomName) &&
      task.reason?.startsWith("capacity:relief:") &&
      isHealthyResourceTransferTaskReservation(task, "outgoing")
    ) {
      existingCapacityTaskBySource.set(task.fromRoomName, task);
    }
    if (
      task.status === "pending" &&
      task.blockedReason === undefined &&
      !task.reason?.startsWith("capacity:relief:")
    ) {
      activeOutgoingSourceRooms.add(task.fromRoomName);
    }
  }

  const sources = snapshots
    .filter(
      (snapshot) => snapshot.storage && snapshot.capacityState !== "normal",
    )
    .sort((left, right) => {
      if (left.capacityState !== right.capacityState) {
        return left.capacityState === "emergency" ? -1 : 1;
      }
      return left.roomName.localeCompare(right.roomName);
    });

  for (const source of sources) {
    if (created >= config.maxNewTasksPerRun) break;
    const existing = existingCapacityTaskBySource.get(source.roomName);
    const terminalRecoveryReplacement = !!(
      existing?.origin === "automatic" &&
      source.terminalFreeCapacity < config.terminalReliefTargetFreeCapacity &&
      getMovableResourceAmount(
        source,
        existing.resource,
        "terminal",
        config,
        context,
        existing.id,
      ) <= 0
    );
    const isRetarget =
      existing?.origin === "automatic" &&
      existing.blockedReason === "receiver_capacity";
    if (existing && !isRetarget && !terminalRecoveryReplacement) continue;
    if (!existing && activeOutgoingSourceRooms.has(source.roomName)) continue;

    const selectsReplacementResource = terminalRecoveryReplacement;
    const terminalCandidate =
      existing && !selectsReplacementResource
        ? null
        : selectTerminalReliefResource(
            source,
            config,
            context,
            true,
          );
    if (existing && terminalRecoveryReplacement && !terminalCandidate) {
      const cancelled = cancelResourceTransferTask(existing.id);
      if (typeof cancelled === "string") {
        actions.push(
          `capacity-terminal-priority-failed:${source.roomName}:${existing.resource}:${cancelled}`,
        );
      } else {
        existing.lastError = "capacity_terminal_priority_replaced";
        syncResourceControlTransferTask(context, existing);
        actions.push(
          `capacity-terminal-priority-cancelled:${source.roomName}:${existing.resource}`,
        );
      }
      continue;
    }
    const location: "terminal" | "storage" = terminalCandidate
      ? "terminal"
      : "storage";
    const candidate =
      existing && !selectsReplacementResource
        ? {
            resource: existing.resource,
            movableAmount: getTotalMovableResourceAmount(
              source,
              existing.resource,
              config,
              context,
              existing.id,
            ),
          }
        : terminalCandidate ||
          (source.terminalFreeCapacity >=
          config.terminalReliefTargetFreeCapacity
            ? selectStorageReliefResource(
                source,
                config,
                context,
                true,
              )
            : null);
    if (!candidate) continue;

    const receivers = snapshots
      .filter((receiver) => receiver.roomName !== source.roomName)
      .filter(
        (receiver) =>
          !existing ||
          selectsReplacementResource ||
          receiver.roomName !== existing.toRoomName,
      )
      .filter((receiver) => isCapacityReliefReceiverEligible(receiver, config))
      .map((receiver) => {
        const excludesExisting =
          selectsReplacementResource &&
          existing?.toRoomName === receiver.roomName;
        const safeCapacity = Math.min(
          getCapacityReliefReceivableAmount(receiver, config),
          getCapacityReliefLedgerAvailableAmount(
            receiver,
            candidate.resource,
            context,
            excludesExisting ? existing?.id : undefined,
          ),
        );
        const estimatedAmount = Math.max(
          1,
          Math.floor(
            Math.min(
              source.transferBatchSize,
              candidate.movableAmount,
              safeCapacity,
              config.maxPlannedAmountPerTask,
            ),
          ),
        );
        return {
          receiver,
          safeCapacity,
          transferCost: Game.market.calcTransactionCost(
            estimatedAmount,
            source.roomName,
            receiver.roomName,
          ),
        };
      })
      .filter(
        (entry) => entry.safeCapacity > 0,
      )
      .sort((left, right) => {
        if (left.safeCapacity !== right.safeCapacity)
          return right.safeCapacity - left.safeCapacity;
        const leftStock = getStock(left.receiver, candidate.resource);
        const rightStock = getStock(right.receiver, candidate.resource);
        if (leftStock !== rightStock) return leftStock - rightStock;
        if (left.transferCost !== right.transferCost)
          return left.transferCost - right.transferCost;
        return left.receiver.roomName.localeCompare(right.receiver.roomName);
      });
    const target = receivers[0];
    if (!target) continue;

    const recoveryGap =
      existing && !terminalRecoveryReplacement
        ? Math.min(
            existing.remainingAmount,
            getCapacityReliefRecoveryGap(source, config),
          )
        : location === "terminal"
          ? Math.max(
              0,
              config.terminalReliefTargetFreeCapacity -
                source.terminalFreeCapacity,
            )
          : Math.max(
              0,
              config.storageReliefTargetFreeCapacity -
                source.storageFreeCapacity,
            );
    const requestedAmount = Math.floor(
      Math.min(
        recoveryGap,
        candidate.movableAmount,
        target.safeCapacity,
        config.maxPlannedAmountPerTask,
      ),
    );
    const amount = computeSafeCapacityReliefAmount(
      source,
      target.receiver.roomName,
      candidate.resource,
      requestedAmount,
      config,
      context,
      existing?.id,
    );
    if (amount <= 0) continue;

    const result = createAutomaticResourceTransferTask(
      source.roomName,
      target.receiver.roomName,
      candidate.resource,
      amount,
      `capacity:relief:${candidate.resource}`,
    );
    if (typeof result === "string") {
      actions.push(
        `capacity-plan-failed:${source.roomName}:${candidate.resource}:${result}`,
      );
      continue;
    }
    syncResourceControlTransferTask(context, result.task);
    if (existing) {
      const cancelled = cancelResourceTransferTask(existing.id);
      if (typeof cancelled === "string") {
        result.task.status = "cancelled";
        result.task.updatedAt = Game.time;
        result.task.lastError = "capacity_retarget_rollback";
        syncResourceControlTransferTask(context, result.task);
        actions.push(
          `capacity-retarget-failed:${source.roomName}:${candidate.resource}:${cancelled}`,
        );
        continue;
      }
      syncResourceControlTransferTask(context, existing);
      if (terminalRecoveryReplacement) {
        existing.lastError = "capacity_terminal_priority_replaced";
        actions.push(
          `capacity-terminal-priority:${source.roomName}:${existing.resource}->${candidate.resource}:${candidate.resource}=${amount}`,
        );
      } else {
        existing.lastError = "capacity_receiver_retargeted";
        actions.push(
          `capacity-retarget:${source.roomName}:${existing.toRoomName}->${target.receiver.roomName}:${candidate.resource}=${amount}`,
        );
      }
    }
    created += 1;
    actions.push(
      `capacity-plan:${source.roomName}->${target.receiver.roomName}:${candidate.resource}=${amount}`,
    );
  }

  return actions;
}

function getHubPendingImportResources(
  tasks: ResourceTransferTask[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!isHealthyResourceTransferTaskReservation(task, "incoming")) continue;
    const reason = task.reason;
    if (
      reason &&
      (reason.startsWith("hub:import:") || reason.startsWith("hub:reclaim:"))
    ) {
      const resource = reason.split(":").pop()!;
      let set = result.get(task.toRoomName);
      if (!set) {
        set = new Set<string>();
        result.set(task.toRoomName, set);
      }
      set.add(resource);
    }
  }
  return result;
}

function isWarBoostShipment(task: ResourceTransferTask): boolean {
  const reason = task.reason || "";
  return (
    reason.startsWith("powerBankBoost:war:") || reason.startsWith("war boost ")
  );
}

function executeTransferTasks(
  snapshots: ResourceControlSnapshot[],
  terminalBusy: Set<string>,
  capacityConfig: ResourceCapacityConfig,
  sendBudget: InternalSendBudget,
  capacityReliefRoutes: CapacityReliefRoute[],
  remainingEnergyNeedByRoom: Map<string, number>,
  context: ResourceControlTransferContext,
): string[] {
  const actions: string[] = [];
  const byRoomName = snapshots.reduce(
    (result, snapshot) => {
      result[snapshot.roomName] = snapshot;
      return result;
    },
    {} as Record<string, ResourceControlSnapshot>,
  );
  const energyDeficitRooms = new Set(
    snapshots
      .filter(
        (snapshot) =>
          (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0,
      )
      .map((snapshot) => snapshot.roomName),
  );
  const storageConstrainedRooms = new Set(
    snapshots
      .filter((snapshot) => isStorageConstrained(snapshot, capacityConfig))
      .map((snapshot) => snapshot.roomName),
  );
  const capacityStateByRoom = new Map(
    snapshots.map(
      (snapshot) => [snapshot.roomName, snapshot.capacityState] as const,
    ),
  );
  const hubPendingImportResources = getHubPendingImportResources(context.tasks);
  const tasks = sortTransferTasksByPriority(context.tasks, {
    energyDeficitRooms,
    storageConstrainedRooms,
    capacityStateByRoom,
  });

  for (const task of tasks) {
    if (task.status !== "pending") {
      continue;
    }

    if (task.remainingAmount <= 0) {
      task.status = "done";
      task.updatedAt = Game.time;
      task.blockedReason = undefined;
      task.blockedSince = undefined;
      task.lastError = undefined;
      syncResourceControlTransferTask(context, task);
      actions.push(`task-auto-done:${task.id}:non_positive_remaining`);
      continue;
    }

    const donor = byRoomName[task.fromRoomName];
    const receiver = byRoomName[task.toRoomName];
    if (!donor || !receiver) {
      task.status = "failed";
      task.updatedAt = Game.time;
      task.lastError = "room_not_ready";
      syncResourceControlTransferTask(context, task);
      actions.push(`task-failed:${task.id}:room_not_ready`);
      continue;
    }
    if (donor.roomName === receiver.roomName) {
      task.status = "failed";
      task.updatedAt = Game.time;
      task.lastError = "same_room";
      syncResourceControlTransferTask(context, task);
      actions.push(`task-failed:${task.id}:same_room`);
      continue;
    }
    const taskReason = task.reason || "";
    const isCapacityRelief = taskReason.startsWith("capacity:relief:");
    const recoveryGap = isCapacityRelief
      ? getCapacityReliefRecoveryGap(donor, capacityConfig)
      : Number.POSITIVE_INFINITY;
    if (
      isCapacityRelief &&
      (donor.capacityState === "normal" || recoveryGap <= 0)
    ) {
      task.status = "cancelled";
      task.updatedAt = Game.time;
      task.blockedReason = undefined;
      task.blockedSince = undefined;
      task.lastError = "capacity_source_recovered";
      syncResourceControlTransferTask(context, task);
      actions.push(`capacity-task-cancelled:${task.id}:source_recovered`);
      continue;
    }
    if (getStock(donor, task.resource) <= 0) {
      markResourceTransferTaskBlocked(task, "source_depleted");
      syncResourceControlTransferTask(context, task);
      continue;
    }
    if (task.blockedReason === "source_depleted") {
      clearResourceTransferTaskBlocker(task);
      syncResourceControlTransferTask(context, task);
    }

    const usePhysicalTerminalHeadroom = isWarBoostShipment(task);
    const taskAvailableCapacity = usePhysicalTerminalHeadroom
      ? context.receiverCapacityLedger.getTerminalAvailableAmount(
          receiver.roomName,
          task.resource,
          task.id,
        )
      : context.receiverCapacityLedger.getAvailableAmount(
          receiver.roomName,
          task.resource,
          task.id,
        );
    const receiverCapacity = isCapacityRelief
      ? Math.min(
          taskAvailableCapacity,
          getCapacityReliefReceivableAmount(receiver, capacityConfig),
        )
      : taskAvailableCapacity;
    if (
      receiverCapacity <= 0 ||
      (isCapacityRelief && receiver.capacityState !== "normal")
    ) {
      markResourceTransferTaskBlocked(task, "receiver_capacity");
      syncResourceControlTransferTask(context, task);
      continue;
    }
    if (task.blockedReason === "receiver_capacity") {
      clearResourceTransferTaskBlocker(task);
      syncResourceControlTransferTask(context, task);
    }

    if (taskReason.startsWith("hub:export:")) {
      const exportResource = taskReason.split(":").pop()!;
      const pendingResources = hubPendingImportResources.get(task.fromRoomName);
      if (
        pendingResources &&
        pendingResources.has(exportResource) &&
        !storageConstrainedRooms.has(task.fromRoomName)
      ) {
        continue;
      }
    }

    let requestedAmount = Math.min(
      task.remainingAmount,
      donor.transferBatchSize,
      receiverCapacity,
    );
    if (isCapacityRelief) {
      requestedAmount = computeSafeCapacityReliefAmount(
        donor,
        receiver.roomName,
        task.resource,
        Math.min(requestedAmount, recoveryGap),
        capacityConfig,
        context,
        task.id,
      );
      if (requestedAmount <= 0) {
        markResourceTransferTaskBlocked(
          task,
          "insufficient_terminal_resource_or_fee",
        );
        syncResourceControlTransferTask(context, task);
        continue;
      }
    }
    const actionEnergyBudget = getTerminalActionEnergyBudget(
      donor,
      context,
      task.id,
    );
    const amount = computeSendAmount(
      donor,
      receiver.roomName,
      task.resource,
      requestedAmount,
      actionEnergyBudget,
    );
    if (amount <= 0) {
      markResourceTransferTaskBlocked(
        task,
        "insufficient_terminal_resource_or_fee",
      );
      syncResourceControlTransferTask(context, task);
      continue;
    }

    if (
      sendBudget.remaining <= 0 ||
      terminalBusy.has(donor.roomName) ||
      donor.terminal.cooldown > 0
    ) {
      if (task.blockedReason === "insufficient_terminal_resource_or_fee") {
        clearResourceTransferTaskBlocker(task);
        syncResourceControlTransferTask(context, task);
      }
      continue;
    }

    const allocatedAmount = context.receiverCapacityLedger.reserve(
      task.id,
      receiver.roomName,
      task.resource,
      amount,
      usePhysicalTerminalHeadroom
        ? { ownerTaskId: task.id, allowTerminalSafetyReserve: true }
        : { ownerTaskId: task.id },
    );
    if (allocatedAmount <= 0) {
      markResourceTransferTaskBlocked(task, "receiver_capacity");
      syncResourceControlTransferTask(context, task);
      continue;
    }

    const transactionCost = Game.market.calcTransactionCost(
      allocatedAmount,
      donor.roomName,
      receiver.roomName,
    );
    if (
      !canTerminalSendPreserveMarketSaleExposure(
        donor.terminal,
        task.resource,
        allocatedAmount,
        transactionCost,
      )
    ) {
      if (capacityConfig.terminalHeadroomRecoveryEnabled) {
        context.receiverCapacityLedger.reserve(
          task.id,
          receiver.roomName,
          task.resource,
          0,
          { ownerTaskId: task.id },
        );
      }
      markResourceTransferTaskBlocked(
        task,
        "insufficient_terminal_resource_or_fee",
      );
      syncResourceControlTransferTask(context, task);
      actions.push(`task-send-blocked:${task.id}:market-sale-exposure`);
      continue;
    }

    const code = executeTerminalSend({
      terminal: donor.terminal,
      resourceType: task.resource,
      amount: allocatedAmount,
      transactionCost,
      destinationRoomName: receiver.roomName,
      actor: `resourceControl:task:${task.id}`,
      description: `resourceControl:task:${task.id}`,
    });
    if (code !== OK) {
      if (capacityConfig.terminalHeadroomRecoveryEnabled) {
        context.receiverCapacityLedger.reserve(
          task.id,
          receiver.roomName,
          task.resource,
          0,
          { ownerTaskId: task.id },
        );
      }
      task.updatedAt = Game.time;
      task.lastError = `send_code_${code}`;
      if (code === ERR_INVALID_ARGS || code === ERR_INVALID_TARGET) {
        task.status = "failed";
        syncResourceControlTransferTask(context, task);
        actions.push(`task-failed:${task.id}:send_code_${code}`);
        continue;
      }
      actions.push(`task-send-failed:${task.id}:code=${code}`);
      continue;
    }
    recordFixedCpuAction("resourceControl");

    const transferCost = applyPostSendDelta(
      donor,
      receiver,
      task.resource,
      allocatedAmount,
    );
    context.receiverCapacityLedger.applySend(
      receiver.roomName,
      task.resource,
      allocatedAmount,
      task.id,
    );
    if (task.resource === RESOURCE_ENERGY) {
      remainingEnergyNeedByRoom.set(
        receiver.roomName,
        Math.max(
          0,
          (remainingEnergyNeedByRoom.get(receiver.roomName) || 0) -
            allocatedAmount,
        ),
      );
    }
    task.remainingAmount = Math.max(0, task.remainingAmount - allocatedAmount);
    recordResourceTransferTaskProgress(task);
    if (task.remainingAmount <= 0) {
      task.status = "done";
    }
    syncResourceControlTransferTask(context, task);

    terminalBusy.add(donor.roomName);
    sendBudget.remaining -= 1;
    actions.push(
      `task-send:${task.id}:${task.resource}=${allocatedAmount}:cost=${transferCost}`,
    );
    if (task.reason?.startsWith("capacity:relief:")) {
      capacityReliefRoutes.push({
        tick: Game.time,
        taskId: task.id,
        fromRoomName: task.fromRoomName,
        toRoomName: task.toRoomName,
        resource: task.resource,
        amount: allocatedAmount,
        transferCost,
      });
      actions.push(
        `capacity-relief-send:${task.fromRoomName}->${task.toRoomName}:${task.resource}=${allocatedAmount}:cost=${transferCost}`,
      );
    }
  }

  return actions;
}

function createTerminalFeedTask(
  room: ResourceControlSnapshot,
  resource: ResourceConstant,
  targetStock: number,
): CarrierTaskDraft | null {
  if (!room.storage || targetStock <= 0) {
    return null;
  }

  const terminalAmount = getTerminalResourceAmount(room, resource);
  const storageAmount = room.storage.store.getUsedCapacity(resource);
  const terminalFree = Math.min(
    room.terminalFreeCapacity,
    room.terminal.store.getFreeCapacity(resource),
  );
  const missing = Math.min(
    storageAmount,
    terminalFree,
    Math.max(0, targetStock - terminalAmount),
  );
  if (missing <= 0) {
    return null;
  }

  return {
    id: `resourceControl:terminal_feed:${room.roomName}:${resource}`,
    type: "terminal_feed",
    priority: RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY,
    steps: [
      {
        id: `${resource}:${room.storage.id}->${room.terminal.id}`,
        resource,
        fromKind: "storage",
        toKind: "terminal",
        fromId: room.storage.id,
        toId: room.terminal.id,
        amount: missing,
      },
    ],
  };
}

function createTerminalOffloadTask(
  room: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
  availableAmount = getTerminalResourceAmount(room, resource),
): CarrierTaskDraft | null {
  if (!room.storage || amount <= 0) {
    return null;
  }

  const storageFree = room.storage.store.getFreeCapacity(resource);
  const movable = Math.min(availableAmount, storageFree, amount);
  if (movable <= 0) {
    return null;
  }

  return {
    id: `resourceControl:terminal_offload:${room.roomName}:${resource}`,
    type: "terminal_offload",
    priority: RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY,
    steps: [
      {
        id: `${resource}:${room.terminal.id}->${room.storage.id}`,
        resource,
        fromKind: "terminal",
        toKind: "storage",
        fromId: room.terminal.id,
        toId: room.storage.id,
        amount: movable,
      },
    ],
  };
}

function getPlannedEnergySendBatch(
  room: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  if (options.stagingBatch) {
    return options.stagingBatch.resource === RESOURCE_ENERGY
      ? options.stagingBatch.amount
      : 0;
  }
  if (options.legacyBacklog) {
    const outgoingEnergy =
      context.healthyOutgoingByRoomResource.get(
        roomResourceKey(room.roomName, RESOURCE_ENERGY),
      ) || 0;
    return outgoingEnergy > 0
      ? Math.min(room.transferBatchSize, outgoingEnergy)
      : isEnergyExportEligible(room)
        ? room.transferBatchSize
        : 0;
  }
  if (!isEnergyExportEligible(room)) return 0;
  return room.transferBatchSize;
}

function getEnergySendFeeBudget(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  amount: number,
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  if (!options.legacyBacklog && options.stagingBatch) {
    return options.stagingBatch.transactionFee;
  }
  if (options.legacyBacklog) {
    const pendingFeeBudget = context.outgoingFeeByRoom.get(room.roomName) || 0;
    if (amount <= 0) return pendingFeeBudget;
    const outgoingEnergy =
      context.healthyOutgoingByRoomResource.get(
        roomResourceKey(room.roomName, RESOURCE_ENERGY),
      ) || 0;
    if (outgoingEnergy > 0 || !isEnergyExportEligible(room)) {
      return pendingFeeBudget;
    }
    const receiver = snapshots
      .filter(
        (snapshot) =>
          snapshot.roomName !== room.roomName &&
          snapshot.storageEnergy < snapshot.energyTarget,
      )
      .sort((left, right) => {
        const leftNeed = left.energyTarget - left.storageEnergy;
        const rightNeed = right.energyTarget - right.storageEnergy;
        return (
          rightNeed - leftNeed || left.roomName.localeCompare(right.roomName)
        );
      })[0];
    return receiver
      ? pendingFeeBudget +
          Game.market.calcTransactionCost(
            amount,
            room.roomName,
            receiver.roomName,
          )
      : pendingFeeBudget;
  }
  if (amount <= 0 || !isEnergyExportEligible(room)) {
    return 0;
  }
  const receiver = snapshots
    .filter(
      (snapshot) =>
        snapshot.roomName !== room.roomName &&
        snapshot.storageEnergy < snapshot.energyTarget,
    )
    .sort((left, right) => {
      const leftNeed = left.energyTarget - left.storageEnergy;
      const rightNeed = right.energyTarget - right.storageEnergy;
      return (
        rightNeed - leftNeed || left.roomName.localeCompare(right.roomName)
      );
    })[0];
  return receiver
    ? Game.market.calcTransactionCost(amount, room.roomName, receiver.roomName)
    : 0;
}

function getNativeMineralAutoSellSurplus(
  room: ResourceControlSnapshot,
  nativeMineralAutoSellThreshold: number,
): number {
  if (!room.canMineNative || !room.nativeMineralType) {
    return 0;
  }

  return Math.max(
    0,
    getStock(room, room.nativeMineralType) - nativeMineralAutoSellThreshold,
  );
}

function getNativeMineralAutoSellTerminalTarget(
  room: ResourceControlSnapshot,
  marketCfg: ResourceControlMarketConfig,
): number {
  if (!marketCfg.enabled) {
    return 0;
  }

  const surplus = getNativeMineralAutoSellSurplus(
    room,
    marketCfg.nativeMineralAutoSellThreshold,
  );
  if (surplus < marketCfg.minDealAmount) {
    return 0;
  }

  const target = Math.min(surplus, marketCfg.maxDealAmount);
  return target >= marketCfg.minDealAmount ? target : 0;
}

function getSellResourcesForRoom(
  room: ResourceControlSnapshot,
  marketCfg: ResourceControlMarketConfig,
): ResourceConstant[] {
  const sellResources = marketCfg.sellResources.filter(
    (resource) => resource !== RESOURCE_ENERGY,
  );
  const hubSellResources =
    room.roomName === Memory.cfg?.hub?.hubRoomName
      ? getHubMarketSellResources()
      : [];
  const combined = [...new Set([...hubSellResources, ...sellResources])];
  if (!room.canMineNative || !room.nativeMineralType) {
    return combined;
  }

  return [
    room.nativeMineralType,
    ...combined.filter((resource) => resource !== room.nativeMineralType),
  ];
}

function getReservedTerminalEnergyForPendingSends(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  const stagedEnergy = getPlannedEnergySendBatch(room, context, options);
  const feeBudget = getEnergySendFeeBudget(
    room,
    snapshots,
    stagedEnergy,
    context,
    options,
  );
  return stagedEnergy + feeBudget;
}

function getProtectedTerminalEnergy(
  snapshot: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  const protectedEnergy = Math.max(
    25_000,
    snapshot.terminalEnergyReserve +
      getReservedTerminalEnergyForPendingSends(
        snapshot,
        snapshots,
        context,
        options,
      ),
  );
  const existingProtectedEnergy = options.legacyBacklog
    ? protectedEnergy
    : protectedEnergy +
      getProductionCommitmentAmount(
        snapshot.roomName,
        RESOURCE_ENERGY,
        context,
      );
  const readiness = context.marketEnergyReadinessByRoom.get(snapshot.roomName);
  return readiness?.authorized
    ? Math.max(
        existingProtectedEnergy,
        readiness.effectivePostDealEnergyReserve,
      )
    : existingProtectedEnergy;
}

function createEnergyTerminalTask(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): CarrierTaskDraft | null {
  if (!room.storage) {
    return null;
  }

  const terminalEnergy = room.terminalEnergy;
  const reservedTerminalEnergy = getReservedTerminalEnergyForPendingSends(
    room,
    snapshots,
    context,
    options,
  );
  const protectedTerminalEnergy = getProtectedTerminalEnergy(
    room,
    snapshots,
    context,
    options,
  );
  const trueOffloadableTerminalEnergy = Math.max(
    0,
    terminalEnergy - protectedTerminalEnergy,
  );

  const storageDeficit = room.energyTarget - room.storageEnergy;
  if (
    storageDeficit > room.transferBatchSize &&
    trueOffloadableTerminalEnergy >= room.transferBatchSize
  ) {
    return createTerminalOffloadTask(
      room,
      RESOURCE_ENERGY,
      Math.min(room.transferBatchSize, storageDeficit),
      trueOffloadableTerminalEnergy,
    );
  }

  const stagedEnergy = getPlannedEnergySendBatch(room, context, options);
  const feeBudget = reservedTerminalEnergy - stagedEnergy;
  const desiredTerminalEnergy =
    room.terminalEnergyReserve + stagedEnergy + feeBudget;
  return createTerminalFeedTask(room, RESOURCE_ENERGY, desiredTerminalEnergy);
}

interface TerminalOverflowPlan {
  desiredUsedCapacity: number;
  storageOffloadCapacity: number;
  recoveryOffloadBudget?: number;
  energyOptions?: TerminalEnergyPlanOptions;
  getProtectedNonEnergy(resource: ResourceConstant, stored: number): number;
}

interface TerminalOverflowDiagnostics {
  storedAmount: number;
  protectedAmount: number;
}

function appendTerminalOverflowDrafts(
  snapshot: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  drafts: CarrierTaskDraft[],
  offloadedResources: Set<ResourceConstant>,
  plan: TerminalOverflowPlan,
): TerminalOverflowDiagnostics {
  const diagnostics: TerminalOverflowDiagnostics = {
    storedAmount: 0,
    protectedAmount: 0,
  };
  if (
    !snapshot.storage ||
    snapshot.terminalUsedCapacity <= plan.desiredUsedCapacity
  ) {
    return diagnostics;
  }

  let overflowTotal = snapshot.terminalUsedCapacity;
  let storageOffloadCapacity = plan.storageOffloadCapacity;
  let recoveryOffloadBudget =
    plan.recoveryOffloadBudget ?? Number.POSITIVE_INFINITY;
  const allResources = RESOURCES_ALL.filter(
    (resource) =>
      getTerminalResourceAmount(snapshot, resource) > 0 &&
      !offloadedResources.has(resource),
  );
  allResources.sort((a, b) => {
    if (a === RESOURCE_ENERGY && b !== RESOURCE_ENERGY) return 1;
    if (a !== RESOURCE_ENERGY && b === RESOURCE_ENERGY) return -1;
    return 0;
  });

  for (const resource of allResources) {
    const stored = getTerminalResourceAmount(snapshot, resource);
    if (stored <= 0) continue;
    const protectedAmount =
      resource === RESOURCE_ENERGY
        ? getProtectedTerminalEnergy(
            snapshot,
            snapshots,
            context,
            plan.energyOptions,
          )
        : plan.getProtectedNonEnergy(resource, stored);
    diagnostics.storedAmount += stored;
    diagnostics.protectedAmount += Math.min(
      stored,
      Math.max(0, protectedAmount),
    );
    const amount = Math.min(
      stored - protectedAmount,
      overflowTotal - plan.desiredUsedCapacity,
      snapshot.transferBatchSize,
      storageOffloadCapacity,
      recoveryOffloadBudget,
    );
    if (amount <= 0) continue;
    const draft = createTerminalOffloadTask(snapshot, resource, amount);
    if (!draft) continue;

    drafts.push(draft);
    offloadedResources.add(resource);
    overflowTotal -= amount;
    storageOffloadCapacity -= amount;
    recoveryOffloadBudget -= amount;
  }
  return diagnostics;
}

function recordTerminalRecoveryObservation(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  desiredTerminalUsedCapacity: number,
  storageOffloadCapacity: number,
  drafts: CarrierTaskDraft[],
  diagnostics: TerminalOverflowDiagnostics,
): void {
  const desiredTerminalFreeCapacity = Math.max(
    0,
    TERMINAL_STORAGE_CAPACITY - desiredTerminalUsedCapacity,
  );
  const terminalRecoveryGap = Math.max(
    0,
    desiredTerminalFreeCapacity - snapshot.terminalFreeCapacity,
  );
  const recoverableOffloadAmount =
    terminalRecoveryGap > 0
      ? Math.min(
          terminalRecoveryGap,
          drafts.reduce(
            (sum, draft) =>
              draft.type === "terminal_offload"
                ? sum +
                  draft.steps.reduce(
                    (stepSum, step) => stepSum + step.amount,
                    0,
                  )
                : sum,
            0,
          ),
        )
      : 0;
  let stickyHeadroom = false;
  let stickyHeadroomReason: TerminalStickyHeadroomReason | undefined;
  if (terminalRecoveryGap > 0) {
    if (storageOffloadCapacity <= 0) {
      stickyHeadroom = true;
      stickyHeadroomReason = "storage_full";
    } else if (recoverableOffloadAmount > 0) {
      const existingOffloadsByTaskId =
        context.existingTerminalOffloadCreatedAtByRoomTaskId.get(
          snapshot.roomName,
        );
      const hasMatchingExistingOffload = drafts.some((draft) => {
        if (draft.type !== "terminal_offload") return false;
        const createdAt = existingOffloadsByTaskId?.get(draft.id);
        return createdAt !== undefined && createdAt < Game.time;
      });
      const previousTerminalFreeCapacity =
        context.previousTerminalFreeCapacityByRoom.get(snapshot.roomName);
      if (
        hasMatchingExistingOffload &&
        previousTerminalFreeCapacity !== undefined &&
        snapshot.terminalFreeCapacity <= previousTerminalFreeCapacity
      ) {
        stickyHeadroom = true;
        stickyHeadroomReason = "carrier_backlog";
      }
    } else {
      stickyHeadroom = true;
      stickyHeadroomReason =
        diagnostics.storedAmount > 0 &&
        diagnostics.protectedAmount >= diagnostics.storedAmount
          ? "protected_inventory"
          : "no_offloadable_resource";
    }
  }
  context.terminalRecoveryObservationByRoom.set(snapshot.roomName, {
    desiredTerminalFreeCapacity,
    terminalRecoveryGap,
    recoverableOffloadAmount,
    stickyHeadroom,
    ...(stickyHeadroomReason ? { stickyHeadroomReason } : {}),
  });
}

function appendTerminalResourceFeedDrafts(
  snapshot: ResourceControlSnapshot,
  _marketCfg: ResourceControlMarketConfig,
  drafts: CarrierTaskDraft[],
  offloadedResources: Set<ResourceConstant>,
  desiredFeedByResource: Map<ResourceConstant, number>,
  initialFeedCapacity: number,
  limitByAdditionalCapacity = false,
  dispatchClassByResource?: ReadonlyMap<
    ResourceConstant,
    CarrierTaskDispatchClass
  >,
): void {
  // 永久闩：ResourceControl 不再为 native/Hub legacy seller 搬运待售货物。
  // desiredFeedByResource 只能来自已存在的内部 transfer staging。

  let feedCapacity = initialFeedCapacity;
  for (const [resource, target] of desiredFeedByResource.entries()) {
    if (feedCapacity <= 0) break;
    const requestedDraft = createTerminalFeedTask(
      snapshot,
      resource,
      limitByAdditionalCapacity ? target : Math.min(target, feedCapacity),
    );
    if (!requestedDraft) continue;
    const draft = limitByAdditionalCapacity
      ? limitCarrierTaskDraftAmount(requestedDraft, feedCapacity)
      : requestedDraft;
    if (!draft) continue;
    const feedAmount = draft.steps.reduce((sum, step) => sum + step.amount, 0);
    feedCapacity -= feedAmount;
    const dispatchClass = dispatchClassByResource?.get(resource);
    drafts.push(dispatchClass ? { ...draft, dispatchClass } : draft);
  }
}

function getCarrierDraftAmount(
  draft: CarrierTaskDraft,
  resource?: ResourceConstant,
): number {
  return draft.steps.reduce(
    (sum, step) =>
      resource === undefined || step.resource === resource
        ? sum + step.amount
        : sum,
    0,
  );
}

function carrierDraftSetIsValid(drafts: CarrierTaskDraft[]): boolean {
  const draftIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const draft of drafts) {
    if (!draft.id || draftIds.has(draft.id) || draft.steps.length === 0) {
      return false;
    }
    draftIds.add(draft.id);
    for (const step of draft.steps) {
      if (
        !step.id ||
        stepIds.has(step.id) ||
        !Number.isSafeInteger(step.amount) ||
        step.amount <= 0
      ) {
        return false;
      }
      stepIds.add(step.id);
    }
  }
  return true;
}

function blockMarketTerminalEnergyReadiness(
  observation: MarketTerminalEnergyReadinessObservation,
  blocker: MarketTerminalEnergyReadinessBlocker,
): void {
  observation.status = "blocked";
  observation.blocker = blocker;
  observation.plannedFeedAmount = 0;
}

/**
 * 在同一 per-room draft 集合中原位提升已有 Energy feed。返回 false 表示
 * draft 构造本身不可信，此时调用方必须保留旧 task set、不得部分 replace。
 */
function mergeMarketTerminalEnergyReadinessDraft(
  snapshot: ResourceControlSnapshot,
  drafts: CarrierTaskDraft[],
  capacityConfig: ResourceCapacityConfig,
  terminalClaimed: boolean,
  context: ResourceControlTransferContext,
): boolean {
  const observation = context.marketEnergyReadinessByRoom.get(
    snapshot.roomName,
  );
  if (!carrierDraftSetIsValid(drafts)) {
    if (observation) {
      blockMarketTerminalEnergyReadiness(observation, "draft_invalid");
    }
    return false;
  }
  if (!observation?.authorized) {
    return true;
  }

  const energyFeedId = `resourceControl:terminal_feed:${snapshot.roomName}:${RESOURCE_ENERGY}`;
  const energyOffloadId = `resourceControl:terminal_offload:${snapshot.roomName}:${RESOURCE_ENERGY}`;
  const energyFeedIndex = drafts.findIndex(
    (draft) => draft.id === energyFeedId,
  );
  const energyOffload = drafts.some((draft) => draft.id === energyOffloadId);
  const ordinaryFeedAmount =
    energyFeedIndex >= 0
      ? getCarrierDraftAmount(drafts[energyFeedIndex], RESOURCE_ENERGY)
      : 0;
  observation.desiredTerminalEnergy = Math.max(
    snapshot.terminalEnergy + ordinaryFeedAmount,
    observation.marketTerminalEnergyTarget,
  );

  if (terminalClaimed) {
    blockMarketTerminalEnergyReadiness(observation, "terminal_claimed");
    return true;
  }
  if (energyOffload) {
    blockMarketTerminalEnergyReadiness(observation, "energy_offload_conflict");
    return true;
  }

  const desiredFeedAmount = Math.max(
    0,
    observation.desiredTerminalEnergy - snapshot.terminalEnergy,
  );
  if (desiredFeedAmount <= 0) {
    observation.status = "ready";
    observation.plannedFeedAmount = 0;
    delete observation.blocker;
    return true;
  }

  // emergency lane 可以使用 terminal 已有 Energy，但不得使用 readiness egress
  // 例外从 storage 补给。
  if (snapshot.capacityState === "emergency") {
    blockMarketTerminalEnergyReadiness(observation, "capacity_emergency");
    return true;
  }
  if (!snapshot.storage) {
    blockMarketTerminalEnergyReadiness(observation, "storage_energy_floor");
    return true;
  }

  const replacement = createTerminalFeedTask(
    snapshot,
    RESOURCE_ENERGY,
    observation.desiredTerminalEnergy,
  );
  if (
    !replacement ||
    getCarrierDraftAmount(replacement, RESOURCE_ENERGY) !== desiredFeedAmount
  ) {
    blockMarketTerminalEnergyReadiness(observation, "terminal_capacity");
    return true;
  }

  const prospectiveDrafts = [...drafts];
  if (energyFeedIndex >= 0) {
    prospectiveDrafts[energyFeedIndex] = replacement;
  } else {
    prospectiveDrafts.push(replacement);
  }
  if (!carrierDraftSetIsValid(prospectiveDrafts)) {
    blockMarketTerminalEnergyReadiness(observation, "draft_invalid");
    return false;
  }

  const totalTerminalFeed = prospectiveDrafts
    .filter((draft) => draft.type === "terminal_feed")
    .reduce((sum, draft) => sum + getCarrierDraftAmount(draft), 0);
  const projectedTerminalFree =
    snapshot.terminalFreeCapacity - totalTerminalFeed;
  const minimumTerminalFree = Math.max(
    MARKET_TERMINAL_ENERGY_MIN_FREE_CAPACITY,
    capacityConfig.terminalPressureFreeCapacity,
  );
  if (projectedTerminalFree < minimumTerminalFree) {
    blockMarketTerminalEnergyReadiness(observation, "terminal_headroom");
    return true;
  }

  const totalEnergyFeed = prospectiveDrafts
    .filter((draft) => draft.type === "terminal_feed")
    .reduce(
      (sum, draft) =>
        sum + getCarrierDraftAmount(draft, RESOURCE_ENERGY),
      0,
    );
  const productionEnergyOwnership = getProductionCommitmentAmount(
    snapshot.roomName,
    RESOURCE_ENERGY,
    context,
  );
  if (
    !Number.isSafeInteger(productionEnergyOwnership) ||
    productionEnergyOwnership < 0 ||
    snapshot.storageEnergy - totalEnergyFeed <
      productionEnergyOwnership
  ) {
    blockMarketTerminalEnergyReadiness(
      observation,
      "production_energy_ownership",
    );
    return true;
  }

  drafts.splice(0, drafts.length, ...prospectiveDrafts);
  observation.status = "feed_planned";
  observation.plannedFeedAmount = desiredFeedAmount;
  delete observation.blocker;
  return true;
}

function commitTerminalLogisticsDrafts(
  snapshot: ResourceControlSnapshot,
  drafts: CarrierTaskDraft[],
  actions: string[],
): void {
  replaceCarrierTasksForProducerRoom(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
    snapshot.roomName,
    drafts,
  );
  if (drafts.length > 0) {
    actions.push(
      `terminal-logistics:${snapshot.roomName}:count=${drafts.length}`,
    );
  }
}

function prepareMarketTerminalEnergyReadiness(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  authorization: MarketTerminalEnergyAuthorizationRead,
  actions: string[],
): boolean {
  const observation = createMarketTerminalEnergyReadinessObservation(
    snapshot,
    context,
    authorization,
  );
  context.marketEnergyReadinessByRoom.set(snapshot.roomName, observation);

  const productionEnergyOwnership = getProductionCommitmentAmount(
    snapshot.roomName,
    RESOURCE_ENERGY,
    context,
  );
  if (
    Number.isSafeInteger(productionEnergyOwnership) &&
    productionEnergyOwnership >= 0
  ) {
    return true;
  }

  blockMarketTerminalEnergyReadiness(
    observation,
    "production_energy_ownership",
  );
  // Clear every task owned by this producer so a previously valid feed cannot
  // remain runnable after ownership becomes untrustworthy.
  commitTerminalLogisticsDrafts(snapshot, [], actions);
  actions.push(
    `terminal-logistics-invalid-production-ownership:${snapshot.roomName}`,
  );
  return false;
}

function syncLegacyTerminalFeedTasks(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  authorization: MarketTerminalEnergyAuthorizationRead,
  terminalBusy: Set<string>,
): string[] {
  const pendingByRoom = new Map<string, Map<ResourceConstant, number>>();
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  for (const task of context.tasks) {
    if (task.status !== "pending" || task.resource === RESOURCE_ENERGY) {
      continue;
    }

    let pendingAmount = task.remainingAmount;
    if (task.reason?.startsWith("capacity:relief:")) {
      const source = snapshotByRoom.get(task.fromRoomName);
      const receiver = snapshotByRoom.get(task.toRoomName);
      if (
        !source ||
        !receiver ||
        source.capacityState === "normal" ||
        receiver.capacityState !== "normal" ||
        task.blockedReason === "receiver_capacity"
      ) {
        continue;
      }
      pendingAmount = computeSafeCapacityReliefAmount(
        source,
        task.toRoomName,
        task.resource,
        Math.min(
          task.remainingAmount,
          getCapacityReliefRecoveryGap(source, capacityConfig),
        ),
        capacityConfig,
        context,
        task.id,
      );
      if (
        source.terminalFreeCapacity <
        capacityConfig.terminalReliefTargetFreeCapacity
      ) {
        pendingAmount = Math.min(
          pendingAmount,
          getMovableResourceAmount(
            source,
            task.resource,
            "terminal",
            capacityConfig,
            context,
            task.id,
          ),
        );
      }
      if (pendingAmount <= 0) continue;
    }

    const roomPending =
      pendingByRoom.get(task.fromRoomName) ||
      new Map<ResourceConstant, number>();
    roomPending.set(
      task.resource,
      (roomPending.get(task.resource) || 0) + pendingAmount,
    );
    pendingByRoom.set(task.fromRoomName, roomPending);
  }

  const validRoomNames = new Set(
    snapshots.map((snapshot) => snapshot.roomName),
  );
  const actions: string[] = [];
  for (const snapshot of snapshots) {
    if (
      !prepareMarketTerminalEnergyReadiness(
        snapshot,
        context,
        authorization,
        actions,
      )
    ) {
      continue;
    }
    const drafts: CarrierTaskDraft[] = [];
    const offloadedResources = new Set<ResourceConstant>();
    const energyDraft = createEnergyTerminalTask(snapshot, snapshots, context, {
      legacyBacklog: true,
    });
    if (energyDraft) {
      drafts.push(energyDraft);
      if (energyDraft.type === "terminal_offload") {
        offloadedResources.add(RESOURCE_ENERGY);
      }
    }

    const roomPending = pendingByRoom.get(snapshot.roomName);
    const storageOffloadCapacity = snapshot.storage
      ? Math.max(
          0,
          snapshot.storage.store.getFreeCapacity() -
            getLocalCarrierDestinationCommittedAmount(snapshot.storage.id),
        )
      : 0;
    const overflowDiagnostics = appendTerminalOverflowDrafts(
      snapshot,
      snapshots,
      context,
      drafts,
      offloadedResources,
      {
        desiredUsedCapacity: TERMINAL_TOTAL_STORAGE_CAP,
        storageOffloadCapacity,
        energyOptions: { legacyBacklog: true },
        getProtectedNonEnergy: (resource, stored) =>
          Math.min(stored, roomPending?.get(resource) ?? 0),
      },
    );

    const offloadTotal = drafts.reduce(
      (sum, draft) =>
        draft.type === "terminal_offload"
          ? sum +
            draft.steps.reduce((stepSum, step) => stepSum + step.amount, 0)
          : sum,
      0,
    );
    const feedCapacity = Math.max(
      0,
      TERMINAL_TOTAL_STORAGE_CAP -
        (snapshot.terminalUsedCapacity - offloadTotal),
    );

    const desiredFeedByResource = new Map<ResourceConstant, number>();
    if (roomPending) {
      for (const [resource, amount] of roomPending.entries()) {
        if (offloadedResources.has(resource)) continue;
        desiredFeedByResource.set(
          resource,
          Math.min(snapshot.transferBatchSize, amount),
        );
      }
    }
    appendTerminalResourceFeedDrafts(
      snapshot,
      marketCfg,
      drafts,
      offloadedResources,
      desiredFeedByResource,
      feedCapacity,
    );
    recordTerminalRecoveryObservation(
      snapshot,
      context,
      TERMINAL_TOTAL_STORAGE_CAP,
      storageOffloadCapacity,
      drafts,
      overflowDiagnostics,
    );
    if (
      mergeMarketTerminalEnergyReadinessDraft(
        snapshot,
        drafts,
        capacityConfig,
        terminalBusy.has(snapshot.roomName),
        context,
      )
    ) {
      commitTerminalLogisticsDrafts(snapshot, drafts, actions);
    } else {
      actions.push(`terminal-logistics-invalid:${snapshot.roomName}`);
    }
  }

  pruneCarrierTasksForProducer(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
    validRoomNames,
  );
  return actions;
}

function limitCarrierTaskDraftAmount(
  draft: CarrierTaskDraft,
  maximumAmount: number,
): CarrierTaskDraft | null {
  let remaining = Math.max(0, Math.floor(maximumAmount));
  const steps = draft.steps
    .map((step) => {
      const amount = Math.min(step.amount, remaining);
      remaining -= amount;
      return { ...step, amount };
    })
    .filter((step) => step.amount > 0);
  return steps.length > 0 ? { ...draft, steps } : null;
}

function getTerminalLogisticsCapacityPlan(
  snapshot: ResourceControlSnapshot,
  capacityConfig: ResourceCapacityConfig,
): {
  recoveringTerminal: boolean;
  desiredTerminalUsedCapacity: number;
  feedCapacity: number;
} {
  const recoveringTerminal =
    capacityConfig.terminalHeadroomRecoveryEnabled &&
    snapshot.capacityState !== "normal";
  const desiredTerminalUsedCapacity = !capacityConfig.terminalHeadroomRecoveryEnabled
    ? TERMINAL_TOTAL_STORAGE_CAP
    : Math.max(
        0,
        TERMINAL_STORAGE_CAPACITY -
          (recoveringTerminal
            ? capacityConfig.terminalReliefTargetFreeCapacity
            : Math.max(
                NORMAL_TERMINAL_TARGET_FREE_CAPACITY,
                capacityConfig.receiverTerminalMinFreeCapacity,
              )),
      );
  return {
    recoveringTerminal,
    desiredTerminalUsedCapacity,
    feedCapacity: Math.min(
      snapshot.terminalFreeCapacity,
      Math.max(0, desiredTerminalUsedCapacity - snapshot.terminalUsedCapacity),
    ),
  };
}

function getRequiredTerminalStagingFeedAmount(
  source: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
  transactionFee: number,
): { energy: number; resource: number; total: number } {
  const resourceFeedAmount =
    resource === RESOURCE_ENERGY
      ? 0
      : Math.max(0, amount - getTerminalResourceAmount(source, resource));
  const desiredEnergy =
    transactionFee + (resource === RESOURCE_ENERGY ? amount : 0);
  const energyFeedAmount = Math.max(0, desiredEnergy - source.terminalEnergy);
  return {
    energy: energyFeedAmount,
    resource: resourceFeedAmount,
    total: energyFeedAmount + resourceFeedAmount,
  };
}

interface TerminalStagingAssessment {
  affordableAmount: number;
  suppressedReason?: TerminalStagingSuppressionReason;
}

function assessTransferTaskStagingBatch(
  source: ResourceControlSnapshot,
  receiver: ResourceControlSnapshot,
  task: ResourceTransferTask,
  maximumAmount: number,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
): TerminalStagingAssessment {
  if (maximumAmount <= 0) {
    return { affordableAmount: 0, suppressedReason: "source_depleted" };
  }
  const sourceSafeAmount =
    task.resource === RESOURCE_ENERGY
      ? getTerminalActionEnergyBudget(source, context, task.id)
      : getTotalMovableResourceAmount(
          source,
          task.resource,
          capacityConfig,
          context,
          task.id,
        );
  if (sourceSafeAmount <= 0) {
    return { affordableAmount: 0, suppressedReason: "source_inventory" };
  }
  const usePhysicalTerminalHeadroom = isWarBoostShipment(task);
  const receiverAllowance = usePhysicalTerminalHeadroom
    ? context.receiverCapacityLedger.getTerminalAvailableAmount(
        receiver.roomName,
        task.resource,
        task.id,
      )
    : context.receiverCapacityLedger.getAvailableAmount(
        receiver.roomName,
        task.resource,
        task.id,
      );
  if (receiverAllowance <= 0) {
    return { affordableAmount: 0, suppressedReason: "receiver_capacity" };
  }
  const maximum = Math.floor(
    Math.min(maximumAmount, sourceSafeAmount, receiverAllowance),
  );
  if (maximum <= 0) {
    return { affordableAmount: 0, suppressedReason: "source_inventory" };
  }

  if (task.resource !== RESOURCE_ENERGY) {
    const maximumTransactionFee = Game.market.calcTransactionCost(
      maximum,
      source.roomName,
      receiver.roomName,
    );
    const maximumRequiredFeed = getRequiredTerminalStagingFeedAmount(
      source,
      task.resource,
      maximum,
      maximumTransactionFee,
    );
    if (
      maximumRequiredFeed.resource === 0 &&
      maximumRequiredFeed.total > source.terminalFreeCapacity
    ) {
      return { affordableAmount: 0, suppressedReason: "terminal_headroom" };
    }
  }

  const energyBudget = getTerminalActionEnergyBudget(
    source,
    context,
    task.id,
  );
  const { feedCapacity } = getTerminalLogisticsCapacityPlan(
    source,
    capacityConfig,
  );
  const getSuppressionReason = (
    amount: number,
  ): TerminalStagingSuppressionReason | undefined => {
    const transactionFee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiver.roomName,
    );
    const spentEnergy = getTerminalActionRequiredEnergy({
      energyPayload: task.resource === RESOURCE_ENERGY,
      amount,
      transactionFee,
    });
    const requiredFeed = getRequiredTerminalStagingFeedAmount(
      source,
      task.resource,
      amount,
      transactionFee,
    );
    if (
      requiredFeed.resource >
      source.storage!.store.getUsedCapacity(task.resource)
    ) {
      return "source_inventory";
    }
    if (
      spentEnergy > energyBudget ||
      requiredFeed.energy >
        source.storage!.store.getUsedCapacity(RESOURCE_ENERGY)
    ) {
      return "fee_budget";
    }
    const actionBoundFeedCapacity =
      task.resource !== RESOURCE_ENERGY && requiredFeed.resource === 0
        ? Math.max(feedCapacity, source.terminalFreeCapacity)
        : feedCapacity;
    if (requiredFeed.total > actionBoundFeedCapacity) {
      return "terminal_headroom";
    }
    return undefined;
  };
  const canStage = (amount: number): boolean =>
    getSuppressionReason(amount) === undefined;

  const affordableAmount = computeLargestAffordableAmount(maximum, canStage);
  if (affordableAmount <= 0) {
    return {
      affordableAmount: 0,
      suppressedReason:
        getSuppressionReason(Math.min(1, maximum)) || "source_inventory",
    };
  }
  return { affordableAmount };
}

function reserveTransferTaskStagingBatch(
  source: ResourceControlSnapshot,
  receiver: ResourceControlSnapshot,
  task: ResourceTransferTask,
  maximumAmount: number,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
): TerminalStagingAttempt {
  const assessment = assessTransferTaskStagingBatch(
    source,
    receiver,
    task,
    maximumAmount,
    capacityConfig,
    context,
  );
  if (assessment.affordableAmount <= 0) {
    return { suppressedReason: assessment.suppressedReason };
  }
  const grantedAmount = context.receiverCapacityLedger.reserve(
    task.id,
    receiver.roomName,
    task.resource,
    assessment.affordableAmount,
    isWarBoostShipment(task)
      ? { ownerTaskId: task.id, allowTerminalSafetyReserve: true }
      : { ownerTaskId: task.id },
  );
  if (grantedAmount <= 0) {
    return { suppressedReason: "receiver_capacity" };
  }
  const amount = Math.min(assessment.affordableAmount, grantedAmount);
  const reservedAmount = context.receiverCapacityLedger.reserve(
    task.id,
    receiver.roomName,
    task.resource,
    amount,
    isWarBoostShipment(task)
      ? { ownerTaskId: task.id, allowTerminalSafetyReserve: true }
      : { ownerTaskId: task.id },
  );
  if (reservedAmount <= 0) {
    return { suppressedReason: "receiver_capacity" };
  }

  return {
    batch: {
      resource: task.resource,
      amount: reservedAmount,
      transactionFee: Game.market.calcTransactionCost(
        reservedAmount,
        source.roomName,
        receiver.roomName,
      ),
    },
  };
}

function reserveEnergyDeficitStagingBatch(
  source: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  planningEnergyNeedByRoom: Map<string, number>,
  context: ResourceControlTransferContext,
  capacityConfig: ResourceCapacityConfig,
): TerminalStagingBatch | undefined {
  if (
    !source.storage ||
    !isEnergyExportEligible(source) ||
    (context.healthyOutgoingByRoomResource.get(
      roomResourceKey(source.roomName, RESOURCE_ENERGY),
    ) || 0) > 0
  ) {
    return undefined;
  }

  const sourceEnergyBudget = getEnergyBalancingSurplus(source, context);
  if (sourceEnergyBudget <= 0) return undefined;
  const { feedCapacity } = getTerminalLogisticsCapacityPlan(
    source,
    capacityConfig,
  );
  if (feedCapacity <= 0) return undefined;

  const canStageBatch = (amount: number, receiverRoomName: string): boolean => {
    const transactionFee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiverRoomName,
    );
    if (amount + transactionFee > sourceEnergyBudget) return false;
    const energyDraft = createEnergyTerminalTask(source, snapshots, context, {
      stagingBatch: {
        resource: RESOURCE_ENERGY,
        amount,
        transactionFee,
      },
    });
    if (!energyDraft) return true;
    return (
      energyDraft.type === "terminal_feed" &&
      energyDraft.steps.reduce((sum, step) => sum + step.amount, 0) <=
        feedCapacity
    );
  };

  const receivers = snapshots
    .filter(
      (receiver) => receiver.roomName !== source.roomName && !!receiver.storage,
    )
    .filter(
      (receiver) => !context.healthyIncomingEnergyRooms.has(receiver.roomName),
    )
    .filter(
      (receiver) => (planningEnergyNeedByRoom.get(receiver.roomName) || 0) > 0,
    )
    .sort((left, right) => {
      const leftNeed = planningEnergyNeedByRoom.get(left.roomName) || 0;
      const rightNeed = planningEnergyNeedByRoom.get(right.roomName) || 0;
      return (
        rightNeed - leftNeed || left.roomName.localeCompare(right.roomName)
      );
    });

  for (const receiver of receivers) {
    const receiverNeed = planningEnergyNeedByRoom.get(receiver.roomName) || 0;
    const receiverCapacity = context.receiverCapacityLedger.getAvailableAmount(
      receiver.roomName,
      RESOURCE_ENERGY,
    );
    const maximum = Math.floor(
      Math.min(
        source.transferBatchSize,
        receiverNeed,
        receiverCapacity,
        sourceEnergyBudget,
      ),
    );
    const amount = computeLargestAffordableAmount(maximum, (candidate) =>
      canStageBatch(candidate, receiver.roomName),
    );
    if (amount <= 0) continue;

    const reservationId = `resourceControl:terminal-energy-staging:${source.roomName}`;
    const grantedAmount = context.receiverCapacityLedger.reserve(
      reservationId,
      receiver.roomName,
      RESOURCE_ENERGY,
      amount,
    );
    const reservedAmount = computeLargestAffordableAmount(
      Math.min(grantedAmount, receiverNeed),
      (candidate) => canStageBatch(candidate, receiver.roomName),
    );
    context.receiverCapacityLedger.reserve(
      reservationId,
      receiver.roomName,
      RESOURCE_ENERGY,
      reservedAmount,
    );
    if (reservedAmount <= 0) continue;

    const batch = {
      resource: RESOURCE_ENERGY,
      amount: reservedAmount,
      transactionFee: Game.market.calcTransactionCost(
        reservedAmount,
        source.roomName,
        receiver.roomName,
      ),
    };
    const energyDraft = createEnergyTerminalTask(source, snapshots, context, {
      stagingBatch: batch,
    });
    if (
      energyDraft?.type !== "terminal_feed" ||
      energyDraft.steps.reduce((sum, step) => sum + step.amount, 0) >
        feedCapacity
    ) {
      context.receiverCapacityLedger.reserve(
        reservationId,
        receiver.roomName,
        RESOURCE_ENERGY,
        0,
      );
      continue;
    }

    planningEnergyNeedByRoom.set(
      receiver.roomName,
      Math.max(0, receiverNeed - reservedAmount),
    );
    return batch;
  }

  return undefined;
}

function syncTerminalFeedTasks(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  remainingEnergyNeedByRoom: Map<string, number>,
  authorization: MarketTerminalEnergyAuthorizationRead,
  terminalBusy: Set<string>,
): string[] {
  if (!capacityConfig.terminalHeadroomRecoveryEnabled) {
    return syncLegacyTerminalFeedTasks(
      snapshots,
      marketCfg,
      capacityConfig,
      context,
      authorization,
      terminalBusy,
    );
  }

  const stagingBatchByRoom = new Map<string, TerminalStagingBatch>();
  const planningEnergyNeedByRoom = new Map(remainingEnergyNeedByRoom);
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  const priorityContext = createTransferTaskPriorityContext(
    snapshots,
    capacityConfig,
    remainingEnergyNeedByRoom,
  );
  for (const task of sortTransferTasksByPriority(
    context.tasks,
    priorityContext,
  )) {
    if (task.status !== "pending") continue;
    const source = snapshotByRoom.get(task.fromRoomName);
    const receiver = snapshotByRoom.get(task.toRoomName);
    if (!source?.storage || !receiver?.storage) {
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        "invalid_endpoint",
      );
      continue;
    }
    if (task.blockedReason === "receiver_capacity") {
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        "receiver_capacity",
      );
      continue;
    }
    if (task.blockedReason === "source_depleted") {
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        "source_depleted",
      );
      continue;
    }

    let pendingAmount = Math.min(
      task.remainingAmount,
      source.transferBatchSize,
    );
    if (task.reason?.startsWith("capacity:relief:")) {
      if (source.capacityState === "normal") {
        recordTerminalStagingSuppression(
          context,
          task.fromRoomName,
          "source_depleted",
        );
        continue;
      }
      if (receiver.capacityState !== "normal") {
        recordTerminalStagingSuppression(
          context,
          task.fromRoomName,
          "receiver_capacity",
        );
        continue;
      }
      pendingAmount = computeSafeCapacityReliefAmount(
        source,
        task.toRoomName,
        task.resource,
        Math.min(
          task.remainingAmount,
          source.transferBatchSize,
          getCapacityReliefRecoveryGap(source, capacityConfig),
          getCapacityReliefReceivableAmount(receiver, capacityConfig),
          getCapacityReliefLedgerAvailableAmount(
            receiver,
            task.resource,
            context,
            task.id,
          ),
        ),
        capacityConfig,
        context,
        task.id,
      );
      if (
        source.terminalFreeCapacity <
        capacityConfig.terminalReliefTargetFreeCapacity
      ) {
        pendingAmount = Math.min(
          pendingAmount,
          getMovableResourceAmount(
            source,
            task.resource,
            "terminal",
            capacityConfig,
            context,
            task.id,
          ),
        );
      }
      if (pendingAmount <= 0) {
        recordTerminalStagingSuppression(
          context,
          task.fromRoomName,
          context.receiverCapacityLedger.getAvailableAmount(
            receiver.roomName,
            task.resource,
            task.id,
          ) <= 0
            ? "receiver_capacity"
            : "source_inventory",
        );
        continue;
      }
    }

    if (stagingBatchByRoom.has(task.fromRoomName)) {
      const assessment = assessTransferTaskStagingBatch(
        source,
        receiver,
        task,
        pendingAmount,
        capacityConfig,
        context,
      );
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        assessment.suppressedReason || "window_limit",
      );
      continue;
    }

    const attempt = reserveTransferTaskStagingBatch(
      source,
      receiver,
      task,
      pendingAmount,
      capacityConfig,
      context,
    );
    if (!attempt.batch) {
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        attempt.suppressedReason || "source_inventory",
      );
      continue;
    }
    const batch = task.origin === "automatic" &&
      task.reason?.startsWith("capacity:relief:")
      ? {
          ...attempt.batch,
          dispatchClass: "capacity_relief" as const,
        }
      : attempt.batch;
    stagingBatchByRoom.set(task.fromRoomName, batch);
    recordTerminalStagingAdmission(context, task.fromRoomName, batch);
  }

  // Persisted/manual/capacity tasks already own an explicit send window. Only
  // rooms without such a batch may use speculative automatic Energy staging.
  for (const snapshot of snapshots) {
    if (stagingBatchByRoom.has(snapshot.roomName)) continue;
    const energyBatch = reserveEnergyDeficitStagingBatch(
      snapshot,
      snapshots,
      planningEnergyNeedByRoom,
      context,
      capacityConfig,
    );
    if (energyBatch) {
      stagingBatchByRoom.set(snapshot.roomName, energyBatch);
      recordTerminalStagingAdmission(
        context,
        snapshot.roomName,
        energyBatch,
        false,
      );
    }
  }

  const validRoomNames = new Set(
    snapshots.map((snapshot) => snapshot.roomName),
  );
  const actions: string[] = [];
  for (const snapshot of snapshots) {
    if (
      !prepareMarketTerminalEnergyReadiness(
        snapshot,
        context,
        authorization,
        actions,
      )
    ) {
      continue;
    }
    const drafts: CarrierTaskDraft[] = [];
    const stagingBatch = stagingBatchByRoom.get(snapshot.roomName);
    const energyDraft = createEnergyTerminalTask(snapshot, snapshots, context, {
      stagingBatch,
    });
    const {
      recoveringTerminal,
      desiredTerminalUsedCapacity,
      feedCapacity: safeFeedCapacity,
    } = getTerminalLogisticsCapacityPlan(snapshot, capacityConfig);
    const stagingFeedRequirement = stagingBatch
      ? getRequiredTerminalStagingFeedAmount(
          snapshot,
          stagingBatch.resource,
          stagingBatch.amount,
          stagingBatch.transactionFee,
        )
      : undefined;

    // Terminal overflow: offload surplus above cap to storage
    // Compute offload drafts first so we can suppress conflicting feed drafts
    const offloadedResources = new Set<ResourceConstant>();
    const effectiveStorageOffloadCapacity = snapshot.storage
      ? Math.max(
          0,
          snapshot.storage.store.getFreeCapacity() -
            capacityConfig.storageReliefTargetFreeCapacity -
            getLocalCarrierDestinationCommittedAmount(snapshot.storage.id),
        )
      : 0;
    let storageOffloadCapacity = effectiveStorageOffloadCapacity;
    if (!recoveringTerminal && energyDraft?.type === "terminal_offload") {
      const limitedEnergyOffload = limitCarrierTaskDraftAmount(
        energyDraft,
        storageOffloadCapacity,
      );
      if (limitedEnergyOffload) {
        const amount = limitedEnergyOffload.steps.reduce(
          (sum, step) => sum + step.amount,
          0,
        );
        drafts.push(limitedEnergyOffload);
        offloadedResources.add(RESOURCE_ENERGY);
        storageOffloadCapacity -= amount;
      }
    }

    const overflowDiagnostics = appendTerminalOverflowDrafts(
      snapshot,
      snapshots,
      context,
      drafts,
      offloadedResources,
      {
        desiredUsedCapacity: desiredTerminalUsedCapacity,
        storageOffloadCapacity,
        recoveryOffloadBudget: recoveringTerminal
          ? Math.min(
              snapshot.terminalUsedCapacity - desiredTerminalUsedCapacity,
              snapshot.transferBatchSize,
              storageOffloadCapacity,
            )
          : Number.POSITIVE_INFINITY,
        energyOptions: { stagingBatch },
        getProtectedNonEnergy: (resource, stored) =>
          Math.min(
            stored,
            (stagingBatch?.resource === resource ? stagingBatch.amount : 0) +
              getProductionCommitmentAmount(
                snapshot.roomName,
                resource,
                context,
              ),
          ),
      },
    );

    let feedCapacity = safeFeedCapacity;
    if (
      energyDraft?.type === "terminal_feed" &&
      !offloadedResources.has(RESOURCE_ENERGY)
    ) {
      const maximumEnergyFeed = stagingBatch?.dispatchClass === "capacity_relief" &&
        stagingFeedRequirement
        ? stagingFeedRequirement.energy
        : stagingBatch?.resource !== RESOURCE_ENERGY && stagingFeedRequirement
          ? Math.max(
              stagingFeedRequirement.energy,
              feedCapacity - stagingFeedRequirement.resource,
            )
          : feedCapacity;
      const limitedEnergyFeed = limitCarrierTaskDraftAmount(
        energyDraft,
        maximumEnergyFeed,
      );
      if (limitedEnergyFeed) {
        const amount = limitedEnergyFeed.steps.reduce(
          (sum, step) => sum + step.amount,
          0,
        );
        drafts.push(stagingBatch?.dispatchClass
          ? {
              ...limitedEnergyFeed,
              dispatchClass: stagingBatch.dispatchClass,
            }
          : limitedEnergyFeed);
        feedCapacity -= amount;
      }
    }

    const desiredFeedByResource = new Map<ResourceConstant, number>();
    if (
      stagingBatch &&
      stagingBatch.resource !== RESOURCE_ENERGY &&
      !offloadedResources.has(stagingBatch.resource)
    ) {
      desiredFeedByResource.set(
        stagingBatch.resource,
        Math.min(snapshot.transferBatchSize, stagingBatch.amount),
      );
    }

    appendTerminalResourceFeedDrafts(
      snapshot,
      marketCfg,
      drafts,
      offloadedResources,
      desiredFeedByResource,
      feedCapacity,
      true,
      stagingBatch?.dispatchClass && stagingBatch.resource !== RESOURCE_ENERGY
        ? new Map([
            [stagingBatch.resource, stagingBatch.dispatchClass],
          ])
        : undefined,
    );
    const validDraftSet = mergeMarketTerminalEnergyReadinessDraft(
      snapshot,
      drafts,
      capacityConfig,
      terminalBusy.has(snapshot.roomName) ||
        stagingBatch?.dispatchClass === "capacity_relief",
      context,
    );
    recordTerminalRecoveryObservation(
      snapshot,
      context,
      desiredTerminalUsedCapacity,
      effectiveStorageOffloadCapacity,
      drafts,
      overflowDiagnostics,
    );
    if (validDraftSet) {
      commitTerminalLogisticsDrafts(snapshot, drafts, actions);
    } else {
      actions.push(`terminal-logistics-invalid:${snapshot.roomName}`);
    }
  }

  pruneCarrierTasksForProducer(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
    validRoomNames,
  );
  return actions;
}

export function getResourceControlDonorAvailable(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const total = getStock(snapshot, resource);
  if (resource === RESOURCE_ENERGY) {
    const terminalEnergyOutsideMarketExposure =
      getTerminalAmountOutsideMarketSaleExposure(
        snapshot.terminal,
        RESOURCE_ENERGY,
        snapshot.roomName,
      );
    return getTerminalActionEnergyOwnershipBudget({
      totalEnergy: total,
      ordinaryTerminalEnergyReserve: snapshot.terminalEnergyReserve,
      productionEnergyCommitment: getReservedProductionAmount(
        snapshot.roomName,
        RESOURCE_ENERGY,
      ),
      otherOutgoingEnergyCommitment: 0,
      otherOutgoingFeeCommitment: 0,
      otherExplicitEnergyOwnership: Math.max(
        0,
        snapshot.terminalEnergy - terminalEnergyOutsideMarketExposure,
      ),
    });
  }
  const floor = snapshot.mineralFloor[resource] || 0;
  return Math.max(0, total - floor);
}

function shouldSkipMarketBuyForResource(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): boolean {
  if (resource === RESOURCE_ENERGY) {
    return false;
  }

  return snapshot.canMineNative && snapshot.nativeMineralType === resource;
}

function getMarketBuyDemandDeficit(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  context: ResourceControlTransferContext,
): number {
  if (resource === RESOURCE_ENERGY) {
    return 0;
  }

  const activeMissing = getActiveSynthesisMissing(snapshot.roomName, resource);
  if (activeMissing > 0) {
    return activeMissing;
  }

  const demandTarget = getSynthesisDemandTarget(snapshot.roomName, resource);
  if (demandTarget <= 0) {
    return 0;
  }

  const room = Game.rooms[snapshot.roomName];
  const current = room?.controller?.my
    ? getResourceControlRoomStock(room, resource)
    : getStock(snapshot, resource);
  const incoming =
    context.healthyIncomingByRoomResource.get(
      roomResourceKey(snapshot.roomName, resource),
    ) || 0;
  return Math.max(0, demandTarget - current - incoming);
}

function findBestBuyOrder(
  type: ORDER_BUY | ORDER_SELL,
  resource: ResourceConstant,
  roomName: string,
  amount: number,
  maxDealEnergyCostRatio: number,
  priceCap?: number,
  priceFloor?: number,
): Order | null {
  const orders = Game.market.getAllOrders({ type, resourceType: resource });
  let best: Order | null = null;

  for (const order of orders) {
    if (order.amount < amount || !order.roomName) {
      continue;
    }

    if (priceCap !== undefined && order.price > priceCap) {
      continue;
    }
    if (priceFloor !== undefined && order.price < priceFloor) {
      continue;
    }

    const cost = Game.market.calcTransactionCost(
      amount,
      roomName,
      order.roomName,
    );
    const ratio = amount > 0 ? cost / amount : Infinity;
    if (ratio > maxDealEnergyCostRatio) {
      continue;
    }

    if (!best) {
      best = order;
      continue;
    }

    if (type === ORDER_BUY) {
      if (order.price > best.price) {
        best = order;
      }
    } else if (order.price < best.price) {
      best = order;
    }
  }

  return best;
}

function isHubProtectedResource(
  resource: ResourceConstant,
  roomName: string,
): boolean {
  const hubCfg = Memory.cfg?.hub;
  if (!hubCfg) {
    return false;
  }

  const isHubRoom = hubCfg.hubRoomName === roomName;
  const targetCompounds = hubCfg.targetCompounds || [];

  if (!isHubRoom) {
    if (targetCompounds.includes(resource)) return true;
    if (isResourceCommittedToDistributedSynthesis(roomName, resource))
      return true;
    return false;
  }

  const surplus = Memory.runtime?.hub?.marketSellSurplus?.[resource];
  if (surplus != null && surplus > 0) {
    return false;
  }

  return (
    targetCompounds.includes(resource) ||
    HUB_INTERMEDIATES.includes(resource) ||
    BASE_MINERALS.includes(resource)
  );
}

function isResourceCommittedToDistributedSynthesis(
  roomName: string,
  resource: ResourceConstant,
): boolean {
  const assignments =
    Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments;
  if (!assignments) return false;

  const assignment = assignments.find((a) => a.roomName === roomName);
  if (!assignment) return false;

  const routeDecisions =
    Memory.runtime?.hub?.distributedSynthesis?.routeDecisions ?? [];
  for (const route of routeDecisions) {
    if (
      route.fromRoom === roomName &&
      route.resource === resource &&
      route.amount > 0
    ) {
      return true;
    }
  }

  return false;
}

function getHubMarketSellResources(): ResourceConstant[] {
  if (!Memory.cfg?.hub?.marketSellEnabled) return [];
  const surplus = Memory.runtime?.hub?.marketSellSurplus;
  if (!surplus) return [];
  return (Object.entries(surplus) as [ResourceConstant, number][])
    .filter(([, amount]) => amount > 0)
    .map(([resource]) => resource);
}

function applyMarketOps(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  terminalBusy: Set<string>,
  context: ResourceControlTransferContext,
): string[] {
  if (marketCfg.maxDealsPerRun <= 0) {
    return [];
  }

  const actions: string[] = [];
  let dealsDone = 0;

  // 永久闩与 Memory 配置无关。Emergency/production purchases 仍由
  // `emergencyBuyEnabled` 独立控制，不能因关闭旧卖家而移除生存购买。
  if (
    !LEGACY_RESOURCE_CONTROL_SELLER_PERMANENTLY_DISABLED &&
    marketCfg.enabled
  ) {
    const exportRooms = snapshots
      .filter((snapshot) => snapshot.terminal.cooldown === 0)
      .filter(
        (snapshot) =>
          snapshot.state === "export" ||
          getNativeMineralAutoSellSurplus(
            snapshot,
            marketCfg.nativeMineralAutoSellThreshold,
          ) >= marketCfg.minDealAmount,
      )
      .sort((left, right) => right.storageEnergy - left.storageEnergy);

    for (const room of exportRooms) {
      if (dealsDone >= marketCfg.maxDealsPerRun) {
        break;
      }
      if (terminalBusy.has(room.roomName)) {
        continue;
      }

      for (const resource of getSellResourcesForRoom(room, marketCfg)) {
        if (
          resource !== RESOURCE_ENERGY &&
          isHubProtectedResource(resource, room.roomName)
        ) {
          continue;
        }

        const isNativeAutoSell =
          room.canMineNative && room.nativeMineralType === resource;
        const hubSurplusAmount =
          Memory.runtime?.hub?.marketSellSurplus?.[resource];
        const isHubSurplusSell =
          room.roomName === Memory.cfg?.hub?.hubRoomName &&
          hubSurplusAmount != null &&
          hubSurplusAmount > 0;
        if (room.state !== "export" && !isNativeAutoSell && !isHubSurplusSell) {
          continue;
        }

        const total = getStock(room, resource);
        const outgoingReserved =
          resource === RESOURCE_ENERGY
            ? 0
            : context.healthyOutgoingByRoomResource.get(
                roomResourceKey(room.roomName, resource),
              ) || 0;
        const effectiveTotal = Math.max(0, total - outgoingReserved);
        const exportStart =
          resource === RESOURCE_ENERGY
            ? room.energyExportStart
            : room.mineralExportStart[resource] || 0;
        const sellThreshold = isHubSurplusSell
          ? Math.max(0, effectiveTotal - hubSurplusAmount!)
          : isNativeAutoSell
            ? Math.min(exportStart, marketCfg.nativeMineralAutoSellThreshold)
            : exportStart;
        const surplus = isHubSurplusSell
          ? hubSurplusAmount!
          : Math.max(0, effectiveTotal - sellThreshold);
        if (surplus < marketCfg.minDealAmount) {
          continue;
        }

        const terminalResource = getTerminalResourceAmount(room, resource);
        let amount = Math.min(
          surplus,
          terminalResource,
          marketCfg.maxDealAmount,
        );
        if (amount < marketCfg.minDealAmount) {
          continue;
        }

        if (resource === RESOURCE_ENERGY) {
          amount = Math.min(
            amount,
            Math.max(0, getEnergyAvailableForFees(room)),
          );
          if (amount < marketCfg.minDealAmount) {
            continue;
          }
        }

        const minSellPrice = marketCfg.minSellPrice[resource];
        const order = findBestBuyOrder(
          ORDER_BUY,
          resource,
          room.roomName,
          amount,
          marketCfg.maxDealEnergyCostRatio,
          undefined,
          minSellPrice,
        );
        if (!order || !order.roomName) {
          continue;
        }

        const cost = Game.market.calcTransactionCost(
          amount,
          room.roomName,
          order.roomName,
        );
        if (
          resource === RESOURCE_ENERGY &&
          amount + cost > getEnergyAvailableForFees(room)
        ) {
          continue;
        }
        if (
          resource !== RESOURCE_ENERGY &&
          cost > getEnergyAvailableForFees(room)
        ) {
          continue;
        }

        const code = executeMarketDeal(
          order.id,
          amount,
          room.roomName,
          "resourceControl:legacy-sell",
          {
            orderType: ORDER_BUY,
            resourceType: resource,
            orderRoomName: order.roomName,
          },
        );
        if (code !== OK) {
          actions.push(
            `market-sell-failed:${room.roomName}:${resource}:code=${code}`,
          );
          continue;
        }

        room.terminalEnergy = Math.max(
          0,
          room.terminalEnergy -
            (resource === RESOURCE_ENERGY ? amount : 0) -
            cost,
        );
        terminalBusy.add(room.roomName);
        dealsDone += 1;
        actions.push(
          `market-sell:${room.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${cost}`,
        );
        break;
      }
    }

    const hubCfg = Memory.cfg?.hub;
    if (hubCfg?.hubRoomName && dealsDone < marketCfg.maxDealsPerRun) {
      const hubSnapshot = snapshots.find(
        (s) => s.roomName === hubCfg.hubRoomName,
      );
      if (
        hubSnapshot &&
        hubSnapshot.terminal.cooldown === 0 &&
        !terminalBusy.has(hubSnapshot.roomName)
      ) {
        for (const resource of getHubMarketSellResources()) {
          if (dealsDone >= marketCfg.maxDealsPerRun) break;
          if (
            resource === RESOURCE_ENERGY ||
            resource === RESOURCE_POWER ||
            resource === RESOURCE_OPS
          )
            continue;

          const surplusAmount =
            Memory.runtime?.hub?.marketSellSurplus?.[resource];
          if (surplusAmount == null || surplusAmount < marketCfg.minDealAmount)
            continue;

          const terminalResource = getTerminalResourceAmount(
            hubSnapshot,
            resource,
          );
          const amount = Math.min(
            surplusAmount,
            terminalResource,
            marketCfg.maxDealAmount,
          );
          if (amount < marketCfg.minDealAmount) continue;

          const sellOrders = Game.market.getAllOrders({
            type: ORDER_SELL,
            resourceType: resource,
          });
          const referencePrice =
            sellOrders.length > 0
              ? Math.min(...sellOrders.map((o) => o.price))
              : 0;
          const priceFloor =
            referencePrice > 0
              ? referencePrice * 0.5
              : marketCfg.minSellPrice[resource];
          const order = findBestBuyOrder(
            ORDER_BUY,
            resource,
            hubSnapshot.roomName,
            amount,
            marketCfg.maxDealEnergyCostRatio,
            undefined,
            priceFloor,
          );
          if (!order || !order.roomName) continue;

          const actualCost = Game.market.calcTransactionCost(
            amount,
            hubSnapshot.roomName,
            order.roomName,
          );
          if (actualCost > hubSnapshot.terminalEnergy) continue;

          const code = executeMarketDeal(
            order.id,
            amount,
            hubSnapshot.roomName,
            "resourceControl:legacy-hub-sell",
            {
              orderType: ORDER_BUY,
              resourceType: resource,
              orderRoomName: order.roomName,
            },
          );
          if (code !== OK) {
            actions.push(
              `hub-surplus-sell-failed:${hubSnapshot.roomName}:${resource}:code=${code}`,
            );
            continue;
          }

          hubSnapshot.terminalEnergy = Math.max(
            0,
            hubSnapshot.terminalEnergy - actualCost,
          );
          terminalBusy.add(hubSnapshot.roomName);
          dealsDone += 1;
          actions.push(
            `hub-surplus-sell:${hubSnapshot.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${actualCost}`,
          );
        }
      }
    }
  }

  if (!marketCfg.emergencyBuyEnabled || dealsDone >= marketCfg.maxDealsPerRun) {
    return actions;
  }

  const survivalRooms = snapshots
    .filter(
      (snapshot) =>
        snapshot.state === "survival" && snapshot.terminal.cooldown === 0,
    )
    .sort((left, right) => left.storageEnergy - right.storageEnergy);

  for (const room of survivalRooms) {
    if (dealsDone >= marketCfg.maxDealsPerRun) {
      break;
    }
    if (terminalBusy.has(room.roomName)) {
      continue;
    }

    const need = Math.max(0, room.energyTarget - room.storageEnergy);
    if (need < marketCfg.minDealAmount) {
      continue;
    }

    if (shouldSkipMarketBuyForResource(room, RESOURCE_ENERGY)) {
      continue;
    }

    const terminalFree = Math.min(
      room.terminalFreeCapacity,
      room.terminal.store.getFreeCapacity(RESOURCE_ENERGY),
    );
    const amount = Math.min(need, marketCfg.maxDealAmount, terminalFree);
    if (amount < marketCfg.minDealAmount) {
      continue;
    }

    const maxBuyPrice = marketCfg.maxBuyPrice[RESOURCE_ENERGY];
    const order = findBestBuyOrder(
      ORDER_SELL,
      RESOURCE_ENERGY,
      room.roomName,
      amount,
      marketCfg.maxDealEnergyCostRatio,
      maxBuyPrice,
      undefined,
    );
    if (!order || !order.roomName) {
      continue;
    }

    const transferCost = Game.market.calcTransactionCost(
      amount,
      room.roomName,
      order.roomName,
    );
    if (transferCost > room.terminalEnergy) {
      continue;
    }

    declareMarketActionIntent(
      "resourceControl:legacy-energy-buy",
      "market_deal",
      room.roomName,
    );
    const code = executeMarketDeal(
      order.id,
      amount,
      room.roomName,
      "resourceControl:legacy-energy-buy",
      {
        orderType: ORDER_SELL,
        resourceType: RESOURCE_ENERGY,
        orderRoomName: order.roomName,
      },
    );
    if (code !== OK) {
      actions.push(`market-buy-failed:${room.roomName}:energy:code=${code}`);
      continue;
    }

    room.terminalEnergy = Math.max(
      0,
      room.terminalEnergy + amount - transferCost,
    );
    terminalBusy.add(room.roomName);
    dealsDone += 1;
    actions.push(
      `market-buy:${room.roomName}:energy=${amount}:price=${order.price.toFixed(3)}:cost=${transferCost}`,
    );
  }

  if (dealsDone >= marketCfg.maxDealsPerRun) {
    return actions;
  }

  const mineralBuyRooms = snapshots
    .filter((snapshot) => snapshot.terminal.cooldown === 0)
    .sort((left, right) => left.storageEnergy - right.storageEnergy);

  for (const room of mineralBuyRooms) {
    if (dealsDone >= marketCfg.maxDealsPerRun) {
      break;
    }
    if (terminalBusy.has(room.roomName)) {
      continue;
    }

    // Skip market buys for hub room when internalOnly is active
    const hubCfg = Memory.cfg?.hub;
    if (
      hubCfg &&
      hubCfg.enabled !== false &&
      hubCfg.hubRoomName === room.roomName &&
      hubCfg.internalOnly !== false
    ) {
      continue;
    }

    for (const resource of marketCfg.buyResources) {
      if (dealsDone >= marketCfg.maxDealsPerRun) {
        break;
      }
      if (resource === RESOURCE_ENERGY || !BASE_MINERALS.includes(resource)) {
        continue;
      }
      if (shouldSkipMarketBuyForResource(room, resource)) {
        continue;
      }

      const deficit = getMarketBuyDemandDeficit(room, resource, context);
      if (deficit < marketCfg.minDealAmount) {
        continue;
      }

      const maxBuyPrice = marketCfg.maxBuyPrice[resource];
      if (
        typeof maxBuyPrice !== "number" ||
        !Number.isFinite(maxBuyPrice) ||
        maxBuyPrice <= 0
      ) {
        continue;
      }

      const terminalFree = Math.min(
        room.terminalFreeCapacity,
        room.terminal.store.getFreeCapacity(resource),
      );
      const amount = Math.min(deficit, marketCfg.maxDealAmount, terminalFree);
      if (amount < marketCfg.minDealAmount) {
        continue;
      }

      const order = findBestBuyOrder(
        ORDER_SELL,
        resource,
        room.roomName,
        amount,
        marketCfg.maxDealEnergyCostRatio,
        maxBuyPrice,
        undefined,
      );
      if (!order || !order.roomName) {
        continue;
      }

      const transferCost = Game.market.calcTransactionCost(
        amount,
        room.roomName,
        order.roomName,
      );
      if (transferCost > room.terminalEnergy) {
        continue;
      }

      declareMarketActionIntent(
        "resourceControl:legacy-mineral-buy",
        "market_deal",
        room.roomName,
      );
      const code = executeMarketDeal(
        order.id,
        amount,
        room.roomName,
        "resourceControl:legacy-mineral-buy",
        {
          orderType: ORDER_SELL,
          resourceType: resource,
          orderRoomName: order.roomName,
        },
      );
      if (code !== OK) {
        actions.push(
          `market-buy-failed:${room.roomName}:${resource}:code=${code}`,
        );
        continue;
      }

      room.terminalEnergy = Math.max(0, room.terminalEnergy - transferCost);
      terminalBusy.add(room.roomName);
      dealsDone += 1;
      actions.push(
        `market-buy:${room.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${transferCost}`,
      );
    }
  }

  return actions;
}

function persistResourceControlState(
  snapshots: ResourceControlSnapshot[],
  actions: string[],
  marketActions: string[],
  context: ResourceControlTransferContext,
  capacityIndexBuildCount: number,
  capacityConfig: ResourceCapacityConfig,
  synthesisBindings?: SynthesisBindingStore,
  capacityReliefRoutes: CapacityReliefRoute[] = [],
  logisticsProjection?: ResourceControlLogisticsRuntimeV2,
): void {
  const runtime = getMemoryService().ensureRuntime();
  const previousResourceControl = runtime.resourceControl;
  const previousBindings = previousResourceControl?.synthesisBindings;
  const taskHealthByRoom = new Map<string, ResourceControlTaskHealth>();
  const capacityReservationByRoom = new Map<
    string,
    { committed: number; remaining: number }
  >();
  let eligibleReceiverCount = 0;
  const receiverExcludedByReason: Partial<
    Record<ReceiverAdmissionExclusionReason, number>
  > = {};
  for (const snapshot of snapshots) {
    taskHealthByRoom.set(snapshot.roomName, {
      pendingIncoming: 0,
      pendingOutgoing: 0,
      blockedIncoming: {},
      blockedOutgoing: {},
    });
    const availability = context.receiverCapacityLedger.getAvailability(
      snapshot.roomName,
      RESOURCE_ENERGY,
    );
    const committed =
      availability.totalCommitted + availability.reservationTotal;
    const remaining = Math.min(
      availability.storageRemaining,
      availability.terminalTotalRemaining,
    );
    capacityReservationByRoom.set(snapshot.roomName, { committed, remaining });
    let exclusionReason: ReceiverAdmissionExclusionReason | undefined;
    if (
      !snapshot.storage ||
      snapshot.storageFreeCapacity <
        capacityConfig.receiverStorageMinFreeCapacity
    ) {
      exclusionReason = "storage_headroom";
    } else if (
      snapshot.terminalFreeCapacity <
      capacityConfig.receiverTerminalMinFreeCapacity
    ) {
      exclusionReason = "terminal_headroom";
    } else if (snapshot.capacityState !== "normal") {
      exclusionReason = "capacity_state";
    } else if (remaining <= 0) {
      exclusionReason = "commitment_exhausted";
    }
    if (exclusionReason) {
      receiverExcludedByReason[exclusionReason] =
        (receiverExcludedByReason[exclusionReason] || 0) + 1;
    } else {
      eligibleReceiverCount += 1;
    }
  }

  const taskSummary = {
    pending: 0,
    manualPending: 0,
    automaticPending: 0,
    demandCoveringIncoming: 0,
    coverageExpiredIncoming: 0,
    coverageExpiredByReason: {} as Partial<
      Record<
        NonNullable<
          ReturnType<
            typeof getResourceTransferTaskDemandCoverageExpirationReason
          >
        >,
        number
      >
    >,
    blockedByReason: {} as Partial<
      Record<NonNullable<ResourceTransferTask["blockedReason"]>, number>
    >,
  };
  const demandCoverageOptions = {
    automaticTaskNoProgressTtl:
      capacityConfig.automaticTaskNoProgressTtl,
    sourceDepletedGraceTicks: capacityConfig.sourceDepletedGraceTicks,
    receiverCapacityDemandCoverageGraceTicks:
      capacityConfig.receiverCapacityDemandCoverageGraceTicks,
  };
  for (const task of context.tasks) {
    const expirationReason =
      getResourceTransferTaskDemandCoverageExpirationReason(
        task,
        demandCoverageOptions,
      ) ||
      (task.status === "cancelled" &&
      (
        task.lastError === "automatic_no_progress_timeout" ||
        task.lastError === "automatic_source_depleted_timeout" ||
        task.lastError ===
          "automatic_receiver_capacity_coverage_timeout"
      )
        ? task.lastError
        : null);
    if (expirationReason) {
      taskSummary.coverageExpiredIncoming += 1;
      taskSummary.coverageExpiredByReason[expirationReason] =
        (taskSummary.coverageExpiredByReason[expirationReason] || 0) + 1;
    }
    if (task.status !== "pending") continue;
    taskSummary.pending += 1;
    if (task.origin === "automatic") taskSummary.automaticPending += 1;
    else taskSummary.manualPending += 1;
    if (
      countsResourceTransferTaskTowardDemand(task, demandCoverageOptions)
    ) {
      taskSummary.demandCoveringIncoming += 1;
    }

    const outgoing = taskHealthByRoom.get(task.fromRoomName);
    const incoming = taskHealthByRoom.get(task.toRoomName);
    if (outgoing) outgoing.pendingOutgoing += 1;
    if (incoming) incoming.pendingIncoming += 1;
    if (!task.blockedReason) continue;

    taskSummary.blockedByReason[task.blockedReason] =
      (taskSummary.blockedByReason[task.blockedReason] || 0) + 1;
    if (outgoing) {
      outgoing.blockedOutgoing[task.blockedReason] =
        (outgoing.blockedOutgoing[task.blockedReason] || 0) + 1;
    }
    if (incoming) {
      incoming.blockedIncoming[task.blockedReason] =
        (incoming.blockedIncoming[task.blockedReason] || 0) + 1;
    }
  }

  const recentCapacityReliefRoutes = [
    ...(previousResourceControl?.recentCapacityReliefRoutes || []),
    ...capacityReliefRoutes,
  ].slice(-MAX_RECENT_CAPACITY_RELIEF_ROUTES);
  const suppressedStagingCount: Partial<
    Record<TerminalStagingSuppressionReason, number>
  > = {};
  for (const observation of context.stagingObservationByRoom.values()) {
    for (const [reason, count] of Object.entries(
      observation.suppressedByReason,
    )) {
      const typedReason = reason as TerminalStagingSuppressionReason;
      suppressedStagingCount[typedReason] =
        (suppressedStagingCount[typedReason] || 0) + (count || 0);
    }
  }
  const nextResourceControl = {
    updatedAt: Game.time,
    capacityIndexBuildCount,
    taskContributionIndex: { ...context.taskContributionIndex },
    capacityPolicy: {
      enabled: capacityConfig.enabled,
      terminalHeadroomRecoveryEnabled:
        capacityConfig.terminalHeadroomRecoveryEnabled,
      storagePressureFreeCapacity: capacityConfig.storagePressureFreeCapacity,
      storageReliefTargetFreeCapacity:
        capacityConfig.storageReliefTargetFreeCapacity,
      receiverStorageMinFreeCapacity:
        capacityConfig.receiverStorageMinFreeCapacity,
      terminalPressureFreeCapacity: capacityConfig.terminalPressureFreeCapacity,
      terminalReliefTargetFreeCapacity:
        capacityConfig.terminalReliefTargetFreeCapacity,
      receiverTerminalMinFreeCapacity:
        capacityConfig.receiverTerminalMinFreeCapacity,
    },
    eligibleReceiverCount,
    receiverExcludedByReason,
    suppressedStagingCount,
    rooms: snapshots.reduce(
      (result, snapshot) => {
        const minerals: Partial<Record<ResourceConstant, number>> = {};
        for (const resource of BASE_MINERALS) {
          minerals[resource] = getStock(snapshot, resource);
        }

        result[snapshot.roomName] = {
          state: snapshot.state,
          capacityState: snapshot.capacityState,
          storageUsedCapacity: snapshot.storageUsedCapacity,
          storageFreeCapacity: snapshot.storageFreeCapacity,
          terminalUsedCapacity: snapshot.terminalUsedCapacity,
          terminalFreeCapacity: snapshot.terminalFreeCapacity,
          localOffloadCapacityCommitment: snapshot.storage
            ? getLocalCarrierDestinationCommittedAmount(snapshot.storage.id)
            : 0,
          ...(context.terminalRecoveryObservationByRoom.get(
            snapshot.roomName,
          ) || {
            desiredTerminalFreeCapacity: 0,
            terminalRecoveryGap: 0,
            recoverableOffloadAmount: 0,
            stickyHeadroom: false,
          }),
          capacityReservation: capacityReservationByRoom.get(
            snapshot.roomName,
          ) || {
            committed: 0,
            remaining: 0,
          },
          staging: {
            ...(context.stagingObservationByRoom.get(snapshot.roomName) ||
              createTerminalStagingObservation()),
          },
          storageEnergy: snapshot.storageEnergy,
          terminalEnergy: snapshot.terminalEnergy,
          energyFloor: snapshot.energyFloor,
          energyTarget: snapshot.energyTarget,
          energyExportStart: snapshot.energyExportStart,
          terminalEnergyReserve: snapshot.terminalEnergyReserve,
          marketEnergyReadiness: context.marketEnergyReadinessByRoom.get(
            snapshot.roomName,
          ),
          nativeMineralType: snapshot.nativeMineralType,
          canMineNative: snapshot.canMineNative,
          minerals,
          taskHealth: taskHealthByRoom.get(snapshot.roomName)!,
        };
        return result;
      },
      {} as Record<
        string,
        {
          state: ResourceControlState;
          capacityState: ResourceCapacityState;
          storageUsedCapacity: number;
          storageFreeCapacity: number;
          terminalUsedCapacity: number;
          terminalFreeCapacity: number;
          localOffloadCapacityCommitment: number;
          desiredTerminalFreeCapacity: number;
          terminalRecoveryGap: number;
          recoverableOffloadAmount: number;
          stickyHeadroom: boolean;
          stickyHeadroomReason?: TerminalStickyHeadroomReason;
          capacityReservation: {
            committed: number;
            remaining: number;
          };
          staging: TerminalStagingObservation;
          storageEnergy: number;
          terminalEnergy: number;
          energyFloor: number;
          energyTarget: number;
          energyExportStart: number;
          terminalEnergyReserve: number;
          marketEnergyReadiness?: MarketTerminalEnergyReadinessObservation;
          nativeMineralType?: MineralConstant;
          canMineNative: boolean;
          minerals: Partial<Record<ResourceConstant, number>>;
          taskHealth: ResourceControlTaskHealth;
        }
      >,
    ),
    lastActions: limitActionLog(actions),
    lastMarketActions: limitActionLog(marketActions),
    taskSummary,
    recentCapacityReliefRoutes,
    synthesisBindings: synthesisBindings || previousBindings || {},
  };
  if (logisticsProjection) {
    Object.assign(nextResourceControl, { logistics: logisticsProjection });
  }
  runtime.resourceControl = nextResourceControl as NonNullable<
    Memory["runtime"]
  >["resourceControl"];
}

type ResourceControlRuntimeWithMarketReadiness = {
  updatedAt: number;
  marketEnergyReadinessRevokedTaskHighWater?: number;
  rooms: Record<
    string,
    {
      marketEnergyReadiness?: MarketTerminalEnergyReadinessObservation;
      [key: string]: unknown;
    }
  >;
  [key: string]: unknown;
};

function getMutableResourceControlRuntime():
  ResourceControlRuntimeWithMarketReadiness | undefined {
  return Memory.runtime?.resourceControl as unknown as
    ResourceControlRuntimeWithMarketReadiness | undefined;
}

function clearMarketTerminalEnergyReadinessProjection(): void {
  const runtime = getMutableResourceControlRuntime();
  if (!runtime) return;
  for (const room of Object.values(runtime.rooms || {})) {
    delete room.marketEnergyReadiness;
  }
}

function hasMarketTerminalEnergyReadinessProjection(): boolean {
  const runtime = getMutableResourceControlRuntime();
  return Boolean(
    runtime &&
    Object.values(runtime.rooms || {}).some(
      (room) => room.marketEnergyReadiness !== undefined,
    ),
  );
}

function getMarketTerminalEnergyPreloadTaskHighWater(): number | undefined {
  let highWater: number | undefined;
  for (const task of listCarrierTasksForProducer(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
  )) {
    if (!Number.isSafeInteger(task.updatedAt) || task.updatedAt < 0) {
      return Number.POSITIVE_INFINITY;
    }
    highWater =
      highWater === undefined
        ? task.updatedAt
        : Math.max(highWater, task.updatedAt);
  }
  return highWater;
}

function hasUnreconciledMarketTerminalEnergyPreloadTasks(): boolean {
  const taskHighWater = getMarketTerminalEnergyPreloadTaskHighWater();
  if (taskHighWater === undefined) return false;
  const reconciledHighWater =
    getMutableResourceControlRuntime()
      ?.marketEnergyReadinessRevokedTaskHighWater;
  return (
    !Number.isSafeInteger(reconciledHighWater) ||
    (reconciledHighWater as number) < taskHighWater
  );
}

function markMarketTerminalEnergyPreloadTasksRevoked(): void {
  const runtime = getMemoryService().ensureRuntime();
  const mutableRuntime = (runtime.resourceControl as unknown as
    ResourceControlRuntimeWithMarketReadiness | undefined) || {
    updatedAt: Game.time,
    rooms: {},
  };
  const taskHighWater = getMarketTerminalEnergyPreloadTaskHighWater();
  mutableRuntime.marketEnergyReadinessRevokedTaskHighWater =
    taskHighWater === undefined ? Game.time : taskHighWater;
  runtime.resourceControl = mutableRuntime as unknown as NonNullable<
    Memory["runtime"]
  >["resourceControl"];
}

function persistMarketTerminalEnergyReadinessProjection(
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
): void {
  const runtime = getMemoryService().ensureRuntime();
  const mutableRuntime = (runtime.resourceControl as unknown as
    ResourceControlRuntimeWithMarketReadiness | undefined) || {
    updatedAt: Game.time,
    rooms: {},
  };
  mutableRuntime.updatedAt = Game.time;
  const currentRooms = new Set(snapshots.map((snapshot) => snapshot.roomName));
  for (const [roomName, roomState] of Object.entries(mutableRuntime.rooms)) {
    if (!currentRooms.has(roomName)) {
      delete roomState.marketEnergyReadiness;
    }
  }
  for (const snapshot of snapshots) {
    const roomState =
      mutableRuntime.rooms[snapshot.roomName] ||
      (mutableRuntime.rooms[snapshot.roomName] = {});
    roomState.marketEnergyReadiness = context.marketEnergyReadinessByRoom.get(
      snapshot.roomName,
    );
  }
  runtime.resourceControl = mutableRuntime as unknown as NonNullable<
    Memory["runtime"]
  >["resourceControl"];
}

function persistUnavailableResourceControlLogistics(
  blocker: LogisticsShadowRuntimeBlocker,
): void {
  const config = resolveLogisticsControlConfig();
  const projection = finalizeLogisticsShadowRuntime(
    createEmptyLogisticsShadowRuntime(config.mode, blocker),
  );
  const runtime = getMemoryService().ensureRuntime();
  const mutableRuntime = (runtime.resourceControl as unknown as
    ResourceControlRuntimeWithMarketReadiness | undefined) || {
    updatedAt: Game.time,
    rooms: {},
    lastActions: [],
    lastMarketActions: [],
  };
  mutableRuntime.logistics = projection;
  runtime.resourceControl = mutableRuntime as unknown as NonNullable<
    Memory["runtime"]
  >["resourceControl"];
}

export function runResourceControl(): void {
  const cfg = Memory.cfg?.resourceControl;
  if (cfg?.enabled === false) {
    pruneCarrierTasksForProducer(
      RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
      new Set<string>(),
    );
    clearMarketTerminalEnergyReadinessProjection();
    persistUnavailableResourceControlLogistics("mode_disabled");
    return;
  }

  const interval = normalizeInterval(cfg?.sampleInterval);
  const fullPlanningTick = Game.time % interval === 0;
  const logisticsConfig = resolveLogisticsControlConfig();
  const previousLogistics = (
    Memory.runtime?.resourceControl as unknown as {
      logistics?: { requestedMode?: unknown };
    } | undefined
  )?.logistics;
  if (
    !fullPlanningTick &&
    previousLogistics?.requestedMode === "shadow" &&
    (!logisticsConfig.valid || logisticsConfig.mode !== "shadow")
  ) {
    persistUnavailableResourceControlLogistics(
      !logisticsConfig.valid
        ? "config_invalid"
        : logisticsConfig.mode === "disabled"
          ? "mode_disabled"
          : "matcher_unavailable",
    );
  }
  const readinessAuthorization =
    readMarketTerminalEnergyReadinessAuthorization();
  const shouldReconcileRevokedReadiness =
    !readinessAuthorization.ok &&
    (hasMarketTerminalEnergyReadinessProjection() ||
      hasUnreconciledMarketTerminalEnergyPreloadTasks());
  if (
    !fullPlanningTick &&
    !readinessAuthorization.ok &&
    !shouldReconcileRevokedReadiness
  ) {
    clearMarketTerminalEnergyReadinessProjection();
    return;
  }

  const capacityConfig = resolveCapacityConfig();
  if (fullPlanningTick) {
    reconcileResourceTransferTasks({
      automaticTaskNoProgressTtl: capacityConfig.automaticTaskNoProgressTtl,
      sourceDepletedGraceTicks: capacityConfig.sourceDepletedGraceTicks,
      receiverCapacityDemandCoverageGraceTicks:
        capacityConfig.receiverCapacityDemandCoverageGraceTicks,
    });
  }
  const snapshots = collectResourceControlSnapshots();
  if (snapshots.length === 0) {
    pruneCarrierTasksForProducer(
      RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
      new Set<string>(),
    );
    clearMarketTerminalEnergyReadinessProjection();
    persistUnavailableResourceControlLogistics("input_unavailable");
    return;
  }

  const marketConfig = resolveMarketConfig();
  const capacityIndexBuildCounter: ResourceControlCapacityIndexBuildCounter = {
    count: 0,
  };
  const context = createResourceControlTransferContext(
    snapshots,
    capacityConfig,
    capacityIndexBuildCounter,
  );
  const producerCpuBeforeConsumer = peekLogisticsShadowCpuSnapshot("producer");
  const nonShadowZeroCpuAttribution: LogisticsShadowCpuSnapshotV2 = {
    attributionVersion: 2,
    sampleTick: Game.time,
    measurementAvailable: true,
    producerUsed: 0,
    consumerUsed: 0,
  };
  const logisticsProjection = fullPlanningTick
    ? (() => {
        // The measured pass includes projection, byte fixed-point and trim
        // using the producer-sealed provisional attribution. Shadow must have
        // completed a real producer segment in this tick; a prior consumer-only
        // state (or no state) cannot be reinterpreted as a valid zero producer.
        const measuredProjection = measureLogisticsShadowCpu("consumer", () => {
          const projection = finalizeLogisticsShadowRuntime(
            buildResourceControlLogisticsShadow(context),
          );
          return applyLogisticsShadowCpuAttribution(
            projection,
            projection.requestedMode === "shadow"
              ? producerCpuBeforeConsumer
              : producerCpuBeforeConsumer ?? nonShadowZeroCpuAttribution,
          );
        });
        // The outer seal writes only the final consumer scalar and refreshes
        // its own byte attestation; recursively timing that write has no finite
        // fixpoint. Keep a missing Shadow producer seal unavailable here too.
        return applyLogisticsShadowCpuAttribution(
          measuredProjection,
          measuredProjection.requestedMode === "shadow"
            ? peekLogisticsShadowCpuSnapshot("producer")
            : peekLogisticsShadowCpuSnapshot(),
          true,
        );
      })()
    : undefined;

  const terminalBusy = new Set(
    getTerminalActionClaims().map((claim) => claim.roomName),
  );
  const sendBudget: InternalSendBudget = { remaining: resolveTaskMaxPerRun() };
  const capacityReliefRoutes: CapacityReliefRoute[] = [];
  const remainingEnergyNeedByRoom = new Map(
    snapshots.map((snapshot) => [
      snapshot.roomName,
      Math.max(0, snapshot.energyTarget - snapshot.storageEnergy),
    ]),
  );
  if (!fullPlanningTick) {
    syncTerminalFeedTasks(
      snapshots,
      marketConfig,
      capacityConfig,
      context,
      remainingEnergyNeedByRoom,
      readinessAuthorization,
      terminalBusy,
    );
    if (readinessAuthorization.ok) {
      persistMarketTerminalEnergyReadinessProjection(snapshots, context);
    } else {
      // 授权撤销时先用同一完整草稿回退 ordinary feed，再删除旧授权证据。
      clearMarketTerminalEnergyReadinessProjection();
      markMarketTerminalEnergyPreloadTasksRevoked();
    }
    return;
  }

  const actions = applyInternalBalancing(
    snapshots,
    terminalBusy,
    sendBudget,
    context,
    remainingEnergyNeedByRoom,
  );
  const capacityActions = planCapacityReliefTasks(
    snapshots,
    capacityConfig,
    context,
  );
  const taskActions = executeTransferTasks(
    snapshots,
    terminalBusy,
    capacityConfig,
    sendBudget,
    capacityReliefRoutes,
    remainingEnergyNeedByRoom,
    context,
  );
  const preloadActions = syncTerminalFeedTasks(
    snapshots,
    marketConfig,
    capacityConfig,
    context,
    remainingEnergyNeedByRoom,
    readinessAuthorization,
    terminalBusy,
  );
  const marketActions = applyMarketOps(
    snapshots,
    marketConfig,
    terminalBusy,
    context,
  );
  persistResourceControlState(
    snapshots,
    [...actions, ...capacityActions, ...taskActions, ...preloadActions],
    marketActions,
    context,
    capacityIndexBuildCounter.count,
    capacityConfig,
    undefined,
    capacityReliefRoutes,
    logisticsProjection,
  );
  if (!readinessAuthorization.ok) {
    markMarketTerminalEnergyPreloadTasksRevoked();
  }
}
