import { isDue } from "@/runtime/cadence";
import { utf8ByteLength } from "@/util/utf8";
import { resolveMarketCreditReserve, getAvailableMarketCredits } from "@/runtime/marketActionArbiter";
import { isDefenseMode } from "@/runtime/defenseMode";
import { planAuthorizedMarketCargoTargets } from "@/runtime/resourceTerminalLogistics";
import {
  listCarrierTasksForProducer,
  peekCarrierTasksByRoom,
  pruneCarrierTasksForProducer,
} from "@/runtime/carrierTaskBoard";
import { limitActionLog } from "@/runtime/actionLog";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import {
  cancelResourceTransferTask,
  patchResourceTransferTask,
  clearResourceTransferTaskBlocker,
  countsResourceTransferTaskTowardDemand,
  createAutomaticResourceTransferTask,
  getResourceTransferTaskDemandCoverageExpirationReason,
  isHealthyReceiverCapacityCommitment,
  isHealthyResourceTransferTaskReservation,
  markResourceTransferTaskBlocked,
  reconcileResourceTransferTasks,
  recordResourceTransferTaskProgress,
  type ResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import { isHubOnlyReserveCompound } from "@/config/hub";
import { runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { TREASURY_TERMINAL_LANES, treasuryLaneTaskMatches } from "@/runtime/treasuryTerminalLane";
import { getReceiverSafeCapacity, isReceiverAdmissionEligible } from "@/runtime/logistics/capacityHeadroom";
import {
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
import { getMemoryService } from "@/runtime/runtimeServices";
import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";
import {
  RESOURCE_CONTROL_BASE_MINERALS as BASE_MINERALS,
  DEFAULT_RESOURCE_CONTROL_ROOM_CONFIG as DEFAULT_ROOM_CONFIG,
  normalizeResourceThresholdMap,
} from "@/runtime/resourceControlRoomConfig";
import { HUB_TARGET_COMPOUNDS, HUB_T3_SUPPLY_FLOOR } from "@/config/hub";
import {
  executeTerminalSend,
  getMarketAccountClaim,
  getMarketActionJournal,
  getTerminalActionClaims,
} from "@/runtime/marketActionArbiter";
import { canTerminalSendPreserveMarketSaleExposure } from "@/runtime/marketSaleExposure";
import { deriveMarketBaseResourceCanonicalReadinessAuthorization } from "@/runtime/marketBaseResourceAutomation";
import { getLocalCarrierDestinationCommittedAmount } from "@/runtime/localCarrierDestinationCapacity";
import {
  isPlainRecord,
  createTerminalStagingObservation,
  applyResourceControlTransferTaskContribution,
  deriveResourceControlTransferTaskContribution,
  roomResourceKey,
  getStock,
  getProductionCommitmentAmount,
  getHealthyOutgoingCommitment,
  getOutgoingTransactionFeeReserve,
  getTerminalResourceAmount,
  resolveCapacityConfig,
  getReceiverTerminalFreeCapacity,
  getTerminalActionEnergyBudget,
  getResourceControlSampleInterval,
  createLogisticsShadowSelfExclusion,
  getTotalMovableResourceAmount,
  RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
  normalizeInterval,
  collectResourceControlSnapshots,
  createResourceControlTransferContext,
} from "@/runtime/resourceControlReadModel";
import type {
  TerminalStagingSuppressionReason,
  ResourceControlSnapshot,
  ResourceControlTransferContext,
  TerminalStagingObservation,
  MarketTerminalEnergyReadinessObservation,
  ResourceCapacityConfig,
  ResourceCapacityState,
  LogisticsShadowSelfExclusion,
  TerminalStickyHeadroomReason,
  ResourceControlState,
  ResourceControlCapacityIndexBuildCounter,
} from "@/runtime/resourceControlReadModel";
import { getNativeMineralAutoSellSurplus, applyMarketOps } from "@/runtime/resourceMarketOperations";
import type { ResourceControlMarketConfig } from "@/runtime/resourceMarketOperations";
import {
  computeLargestAffordableAmount,
  getEnergyBalancingSurplus,
  getMovableResourceAmount,
  getCapacityReliefReceivableAmount,
  getCapacityReliefLedgerAvailableAmount,
  getCapacityReliefRecoveryGap,
  computeSafeCapacityReliefAmount,
  isStorageConstrained,
  sortTransferTasksByPriority,
  inspectTaskSynthesisDemand,
  isWarBoostShipment,
  syncTerminalFeedTasks,
} from "@/runtime/resourceTerminalLogistics";
import type {
  MarketTerminalEnergyAuthorizedRoom,
  MarketTerminalEnergyAuthorizationRead,
} from "@/runtime/resourceTerminalLogistics";
export type {
  MarketTerminalEnergyAuthorizedRoom,
  MarketTerminalEnergyAuthorizationRead,
} from "@/runtime/resourceTerminalLogistics";



const DEFAULT_MARKET_SELL_RESOURCES: ResourceConstant[] = [...BASE_MINERALS];

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
const DEFAULT_TASK_MAX_PER_RUN = 5;
const MIN_TASK_MAX_PER_RUN = 1;
const MAX_TASK_MAX_PER_RUN = 5;
const MARKET_TERMINAL_ENERGY_AUTH_MAX_TTL = 100;
const MARKET_TERMINAL_ENERGY_MAX_AUTHORIZED_ROOMS = 16;

const DEFAULT_MARKET_CONFIG: ResourceControlMarketConfig = {
  enabled: false,
  emergencyBuyEnabled: true,
  creditReserve: 10_000,
  energyShadowPrice: 0.12,
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

function normalizeTaskMaxPerRun(value: unknown): number {
  return normalizeNumber(
    value,
    DEFAULT_TASK_MAX_PER_RUN,
    MIN_TASK_MAX_PER_RUN,
    MAX_TASK_MAX_PER_RUN,
  );
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
    cargoLanes: canonical.cargoLanes,
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
    creditReserve: resolveMarketCreditReserve(raw.creditReserve),
    energyShadowPrice: normalizeNumber(raw.energyShadowPrice, 0.12, 0, 1_000),
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

function resolveMarketConfig(): ResourceControlMarketConfig {
  const cfg = Memory.cfg?.resourceControl;
  return normalizeMarketConfig(cfg?.market);
}

function resolveTaskMaxPerRun(): number {
  return normalizeTaskMaxPerRun(Memory.cfg?.resourceControl?.taskMaxPerRun);
}

function setTerminalResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
): void {
  snapshot.terminalResourceAmounts = snapshot.terminalResourceAmounts || {};
  snapshot.terminalResourceAmounts[resource] = Math.max(0, Math.floor(amount));
}

function syncResourceControlTransferTask(
  context: ResourceControlTransferContext,
  task: ResourceTransferTask,
): void {
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
    from.terminalEnergy - from.terminalEnergyReserve - getOutgoingTransactionFeeReserve(from, context),
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
  quotedTransactionCost?: number,
): number {
  const transferCost = quotedTransactionCost ?? Game.market.calcTransactionCost(
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
    .filter((snapshot) => !context.tasks.some((task) => task.fromRoomName === snapshot.roomName &&
      task.resource === RESOURCE_ENERGY && task.reason === "capacity:relief:energy" &&
      Number.isSafeInteger(task.remainingAmount) && task.remainingAmount > 0 &&
      context.snapshotByRoom.has(task.toRoomName) &&
      isHealthyReceiverCapacityCommitment(task, resolveCapacityConfig().automaticTaskNoProgressTtl)))
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

function getReceiverStorageFreeCapacity(
  receiver: ResourceControlSnapshot,
): number {
  const free = receiver.storage?.store.getFreeCapacity();
  return typeof free === "number" ? Math.max(0, free) : 0;
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
        patchResourceTransferTask(result.task, { status: "cancelled", updatedAt: Game.time, lastError: "capacity_retarget_rollback" });
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

    if (task.origin === "automatic" && task.resource === RESOURCE_CATALYZED_UTRIUM_ACID &&
        task.reason?.startsWith("hub:export:") && isDefenseMode(task.fromRoomName)) continue;
    const treasuryLaneLabel = (TREASURY_TERMINAL_LANES.find((lane) =>
      task.treasurySlice?.runId === lane.runId || treasuryLaneTaskMatches(lane, task))?.name ?? "T1").toLowerCase();
    const treasuryDisposition = runTreasuryTerminalTransferTask(
      task,
      context.receiverCapacityLedger,
      sendBudget.remaining > 0 &&
        !terminalBusy.has(task.fromRoomName) && !terminalBusy.has(task.toRoomName),
      (amount, fee) => {
        const donor = byRoomName[task.fromRoomName];
        const receiver = byRoomName[task.toRoomName];
        if (donor && receiver) {
          applyPostSendDelta(donor, receiver, task.resource, amount, fee);
        } else {
          actions.push(`treasury-${treasuryLaneLabel}-local-snapshot-missing:${task.id}`);
        }
        // Reserve the accepted work in this tick's shared receiver ledger even
        // if a diagnostic snapshot disappeared after the final API checks.
        context.receiverCapacityLedger.applySend(task.toRoomName, task.resource, amount, task.id);
        terminalBusy.add(task.fromRoomName);
        sendBudget.remaining -= 1;
        recordFixedCpuAction("resourceControl");
        actions.push(`treasury-${treasuryLaneLabel}-scheduled:${task.id}:${amount}`);
      },
    );
    if (treasuryDisposition.handled) {
      actions.push(`treasury-${treasuryLaneLabel}-${treasuryDisposition.status || "held"}:${task.id}`);
      continue;
    }

    if (task.remainingAmount <= 0) {
      patchResourceTransferTask(task, { status: "done", updatedAt: Game.time, blockedReason: undefined, blockedSince: undefined, lastError: undefined });
      syncResourceControlTransferTask(context, task);
      actions.push(`task-auto-done:${task.id}:non_positive_remaining`);
      continue;
    }

    const synthesisDemand = inspectTaskSynthesisDemand(task, context);
    if (synthesisDemand.status === "held") {
      actions.push(`synthesis-task-held:${task.id}:${synthesisDemand.reason}`);
      continue;
    }
    if (synthesisDemand.status === "bounded" && synthesisDemand.amount <= 0) {
      const cancelled = cancelResourceTransferTask(task.id);
      if (typeof cancelled !== "string") {
        patchResourceTransferTask(task, { lastError: "automatic_synthesis_need_covered" });
        syncResourceControlTransferTask(context, task);
        actions.push(`synthesis-task-cancelled:${task.id}:need_covered`);
      }
      continue;
    }

    const donor = byRoomName[task.fromRoomName];
    const receiver = byRoomName[task.toRoomName];
    if (!donor || !receiver) {
      markResourceTransferTaskBlocked(task, "receiver_capacity");
      syncResourceControlTransferTask(context, task);
      actions.push(`task-blocked:${task.id}:room_not_ready`);
      continue;
    }
    if (donor.roomName === receiver.roomName) {
      patchResourceTransferTask(task, { status: "failed", updatedAt: Game.time, lastError: "same_room" });
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
      patchResourceTransferTask(task, { status: "cancelled", updatedAt: Game.time, blockedReason: undefined, blockedSince: undefined, lastError: "capacity_source_recovered" });
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

    const isHubBufferExport = taskReason.startsWith("hub:export:") &&
      task.fromRoomName === Memory.cfg?.hub?.hubRoomName &&
      HUB_TARGET_COMPOUNDS.includes(task.resource) && !isHubOnlyReserveCompound(task.resource);
    if (taskReason.startsWith("hub:export:")) {
      const exportResource = taskReason.split(":").pop()!;
      const pendingResources = hubPendingImportResources.get(task.fromRoomName);
      if (
        pendingResources &&
        pendingResources.has(exportResource) &&
        !isHubBufferExport &&
        !storageConstrainedRooms.has(task.fromRoomName)
      ) {
        continue;
      }
    }

    let requestedAmount = Math.min(
      task.remainingAmount,
      donor.transferBatchSize,
      receiverCapacity,
      synthesisDemand.status === "bounded" ? synthesisDemand.amount : Number.POSITIVE_INFINITY,
      isHubBufferExport ? Math.max(0, getStock(donor, task.resource) - HUB_T3_SUPPLY_FLOOR -
        getProductionCommitmentAmount(donor.roomName, task.resource, context) -
        getHealthyOutgoingCommitment(donor.roomName, task.resource, context, task.id)) : Number.POSITIVE_INFINITY,
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
      patchResourceTransferTask(task, { updatedAt: Game.time, lastError: `send_code_${code}` });
      if (code === ERR_INVALID_ARGS || code === ERR_INVALID_TARGET) {
        patchResourceTransferTask(task, { status: "failed" });
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
    patchResourceTransferTask(task, { remainingAmount: Math.max(0, task.remainingAmount - allocatedAmount) });
    recordResourceTransferTaskProgress(task);
    if (task.remainingAmount <= 0) {
      patchResourceTransferTask(task, { status: "done" });
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
  const fullPlanningTick = isDue("resourceControl.plan", interval);
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
  context.marketCargoTargets = planAuthorizedMarketCargoTargets(snapshots, readinessAuthorization);
  context.marketSellingResources = new Set(readinessAuthorization.ok ? readinessAuthorization.cargoLanes?.map(lane => lane.resource) : []);
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
      // Terminal 中超出手续费储备的 Energy 已在本房，可由 carrier 入库。
      // 只看 Storage 会在 Terminal 积压时仍从别房补货，造成两房往返
      // send 并连续占用卖货房间的 Terminal cooldown。
      Math.max(
        0,
        snapshot.energyTarget -
          snapshot.storageEnergy -
          Math.max(0, snapshot.terminalEnergy - snapshot.terminalEnergyReserve),
      ),
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

export type { ResourceControlCapacityIndexBuildCounter } from "@/runtime/resourceControlReadModel";
export type { MarketTerminalEnergyReadinessBlocker } from "@/runtime/resourceControlReadModel";
export type { MarketTerminalEnergyReadinessContribution } from "@/runtime/resourceControlReadModel";
export type { MarketTerminalEnergyReadinessObservation } from "@/runtime/resourceControlReadModel";
export type { ResourceControlSnapshot } from "@/runtime/resourceControlReadModel";
export { LEGACY_RESOURCE_CONTROL_SELLER_PERMANENTLY_DISABLED } from "@/runtime/resourceMarketOperations";
export { normalizeCapacityConfig } from "@/runtime/resourceControlReadModel";
export { getResourceControlSampleInterval } from "@/runtime/resourceControlReadModel";
export { isResourceControlFullPlanningTick } from "@/runtime/resourceControlReadModel";
export { collectResourceControlSnapshots } from "@/runtime/resourceControlReadModel";
export { createResourceControlTransferContext } from "@/runtime/resourceControlReadModel";
export { getResourceControlRoomStock } from "@/runtime/resourceControlReadModel";
export type { SynthesisShadowEpochCaptureFailureReason } from "@/runtime/resourceControlReadModel";
export type { SynthesisShadowEpochRoomFactBuildSuccess } from "@/runtime/resourceControlReadModel";
export type { SynthesisShadowEpochRoomFactBuildResult } from "@/runtime/resourceControlReadModel";
export type { SynthesisShadowEpochCaptureSession } from "@/runtime/resourceControlReadModel";
export type { SynthesisShadowEpochCaptureResult } from "@/runtime/resourceControlReadModel";
export { beginSynthesisShadowEpochCapture } from "@/runtime/resourceControlReadModel";
export { inspectTreasuryResourceTransferReadiness } from "@/runtime/resourceControlReadModel";
export { inspectTreasuryResourceTransferPreparation } from "@/runtime/resourceControlReadModel";
export { getResourceControlDonorAvailable } from "@/runtime/resourceControlReadModel";
export { resolveRoomConfig } from "@/runtime/resourceControlRoomConfig";
