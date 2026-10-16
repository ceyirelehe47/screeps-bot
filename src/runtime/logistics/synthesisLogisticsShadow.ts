/**
 * Synthesis-only logistics shadow matcher.
 *
 * This module deliberately has no imports and never reads Game or Memory. The
 * caller freezes all producer, room, legacy, and transaction-cost evidence
 * before invoking it. Returned decisions are diagnostic projections only;
 * they are not transfer contracts, capacity leases, claims, or execution
 * authority.
 */

export const SYNTHESIS_SHADOW_MAX_INTENTS = 32;
export const SYNTHESIS_SHADOW_DEFAULT_CANDIDATE_BUDGET = 128;
export const SYNTHESIS_SHADOW_MAX_CANDIDATE_BUDGET = 256;
export const SYNTHESIS_SHADOW_MAX_DONORS_PER_INTENT = 16;
export const SYNTHESIS_SHADOW_MAX_CANDIDATE_PAIRS_PER_EPOCH =
  SYNTHESIS_SHADOW_MAX_INTENTS * SYNTHESIS_SHADOW_MAX_DONORS_PER_INTENT;
export const SYNTHESIS_SHADOW_MAX_COMPARISON_SAMPLES = 20;
export const SYNTHESIS_SHADOW_MAX_ROOM_FACTS = 16;
export const SYNTHESIS_SHADOW_MAX_RESOURCE_FACTS_PER_ROOM = 32;
export const SYNTHESIS_SHADOW_MAX_KEY_LENGTH = 512;
export const SYNTHESIS_SHADOW_MAX_STABLE_KEY_LENGTH = 1_024;
export const SYNTHESIS_SHADOW_MAX_NAME_LENGTH = 64;
export const SYNTHESIS_SHADOW_MAX_BATCH_AMOUNT = 50_000;
export const SYNTHESIS_SHADOW_MAX_TRANSACTION_COST_EVALUATIONS_PER_CANDIDATE =
  17;
export const SYNTHESIS_SHADOW_MAX_TRANSACTION_COST_EVALUATIONS_PER_RUN =
  SYNTHESIS_SHADOW_MAX_CANDIDATE_BUDGET *
  SYNTHESIS_SHADOW_MAX_TRANSACTION_COST_EVALUATIONS_PER_CANDIDATE;
export const SYNTHESIS_SHADOW_MAX_TRANSACTION_COST_EVALUATIONS_PER_EPOCH =
  SYNTHESIS_SHADOW_MAX_CANDIDATE_PAIRS_PER_EPOCH *
  SYNTHESIS_SHADOW_MAX_TRANSACTION_COST_EVALUATIONS_PER_CANDIDATE;

export type SynthesisShadowOrigin =
  | "synthesis_room"
  | "synthesis_distributed_demand";

export type SynthesisShadowPriorityClass =
  | "deadline"
  | "capacity_emergency"
  | "survival_energy"
  | "operator"
  | "production"
  | "capacity_pressure"
  | "balance"
  | "market";

export const SYNTHESIS_SHADOW_PRIORITY_ORDER: readonly SynthesisShadowPriorityClass[] = [
  "deadline",
  "capacity_emergency",
  "survival_energy",
  "operator",
  "production",
  "capacity_pressure",
  "balance",
  "market",
];

export type SynthesisShadowCoverage =
  | "covered"
  | "partial"
  | "none"
  | "unknown";

export type SynthesisShadowCapacity =
  | "eligible"
  | "blocked"
  | "unknown";

export type SynthesisShadowPredictedStagingEligibility =
  | "eligible"
  | "blocked"
  | "unknown";

export type SynthesisShadowComparisonStatus =
  | "equal"
  | "different"
  | "unresolved";

export type SynthesisShadowDifference =
  | "source"
  | "target"
  | "amount"
  | "priority"
  | "coverage"
  | "capacity"
  | "staging"
  | "ready"
  | "cost"
  | "blocker"
  | "legacy_missing"
  | "shadow_missing";

export type SynthesisShadowUnresolvedReason =
  | "input_drift"
  | "stale_intent"
  | "candidate_budget_exhausted"
  | "legacy_observation_missing"
  | "malformed_input"
  | "input_limit_exceeded";

export type SynthesisShadowComparisonClassification =
  | "expected_policy_difference"
  | "legacy_unpaired"
  | "shadow_unpaired"
  | "unsafe_candidate"
  | "input_unavailable";

export type SynthesisShadowCandidateRejection =
  | "same_room"
  | "source_not_allowed"
  | "stale_source_fact"
  | "invalid_source_endpoint"
  | "source_protection"
  | "stale_receiver_fact"
  | "invalid_receiver_endpoint"
  | "receiver_capacity"
  | "terminal_readiness"
  | "transaction_cost_unavailable"
  | "fee_budget"
  | "staging_capacity"
  | "below_minimum_batch";

export type SynthesisShadowUnmatchedReason =
  | SynthesisShadowCandidateRejection
  | "demand_already_covered"
  | "no_donor"
  | "donor_limit_exceeded"
  | "malformed_input"
  | "stale_intent";

export type SynthesisShadowLegacySourceDisposition =
  | "selected"
  | "feasible_lower_rank"
  | "rejected"
  | "not_candidate"
  | "not_evaluated";

export interface SynthesisShadowLegacySourceCandidateTrace {
  sourceRoom: string;
  disposition: SynthesisShadowLegacySourceDisposition;
  rejection?: SynthesisShadowCandidateRejection;
}

export type SynthesisShadowReceiverTrace =
  | {
      kind: "present";
      receiverEligible: boolean;
      storageHeadroom: number;
      terminalHeadroom: number;
      resourceHeadroom: number;
    }
  | { kind: "missing" };

export type SynthesisShadowCandidateRejectionCount = readonly [
  reason: SynthesisShadowCandidateRejection,
  count: number,
];

/**
 * Bounded explanation captured while the matcher is already evaluating this
 * intent. It never performs an additional room read or transaction-cost quote.
 */
export interface SynthesisShadowCandidateTrace {
  donorCount: number;
  evaluatedCount: number;
  feasibleCount: number;
  rejectedCount: number;
  /** REJECTION_ORDER-selected cause for an unmatched candidate set. */
  selectedRejection?: SynthesisShadowCandidateRejection;
  /** Sparse positive counts in canonical REJECTION_ORDER. */
  rejectionCounts: readonly SynthesisShadowCandidateRejectionCount[];
  /** The matcher-selected source (rank 1), when a feasible route exists. */
  topSourceRoom?: string;
  /** How the legacy source ranked under the same frozen Shadow inputs. */
  legacySource?: SynthesisShadowLegacySourceCandidateTrace;
  /** Receiver residual at the start of this intent, before its route is applied. */
  receiver: SynthesisShadowReceiverTrace;
}

export interface SynthesisShadowPartialLegacySourceEvaluation {
  sourceRoom: string;
  outcome: "feasible" | "rejected";
  rejection?: SynthesisShadowCandidateRejection;
}

export interface SynthesisShadowDemandObservation {
  /** Stable producer-scoped key used to pair shadow and legacy observations. */
  comparisonKey: string;
  demandKey: string;
  origin: SynthesisShadowOrigin;
  epochRevision: string;
  epochFingerprint: string;
  revision: string;
  /** Fingerprint of this demand's exact pre-write facts and constraints. */
  inputFingerprint: string;
  targetRoom: string;
  resource: ResourceConstant;
  product?: ResourceConstant;
  desiredAmount: number;
  localAmount: number;
  healthyIncomingAmount: number;
  minimumBatchAmount: number;
  maximumBatchAmount: number;
  priorityClass: SynthesisShadowPriorityClass;
  firstObservedAt: number;
  observedAt: number;
  expiresAt: number;
  deadlineAt?: number;
  allowedSourceRooms?: readonly string[];
  fixedSourceRoom?: string;
  /**
   * Legacy 在 producer batch 内的实际规划序（追加序）。同优先级稀缺源的
   * 仲裁必须按该顺序进行，否则 Shadow 与 legacy 会把同一份库存分给不同
   * 需求，制造 legacy_unpaired / source_protection 假差异。
   */
  decisionOrder: number;
}

export interface SynthesisShadowRoomResourceFact {
  resource: ResourceConstant;
  /** P0-safe source amount after protection and existing commitments. */
  sourceAvailableAmount: number;
  /** Safe amount already present in the terminal for predicted staging. */
  sourceTerminalAmount: number;
  /** Resource-specific component of P0 receiver headroom. */
  receiverResourceHeadroom: number;
}

export interface SynthesisShadowRoomFact {
  roomName: string;
  epochRevision: string;
  epochFingerprint: string;
  revision: string;
  observedAt: number;
  expiresAt: number;
  owned: boolean;
  hasStorage: boolean;
  hasTerminal: boolean;
  terminalReachable: boolean;
  terminalReadyAt: number;
  capacityState: "normal" | "pressure" | "emergency";
  receiverEligible: boolean;
  /** Shared P0 storage headroom after healthy legacy commitments. */
  receiverStorageHeadroom: number;
  /** Shared P0 terminal headroom after healthy legacy commitments. */
  receiverTerminalHeadroom: number;
  /** Shared local terminal capacity available to predicted staging. */
  terminalStagingFreeCapacity: number;
  /** Maximum payload for the next terminal action from this source. */
  transferBatchSize: number;
  /** Shared safe Energy ownership for full Energy commitments plus action fees. */
  actionEnergyBudget: number;
  /** Safe action Energy already resident in the terminal. */
  terminalActionEnergyAmount: number;
  resources: readonly SynthesisShadowRoomResourceFact[];
}

export interface SynthesisShadowRouteFact {
  sourceRoom: string;
  targetRoom: string;
  resource: ResourceConstant;
  /** Total counterfactual commitment created by this match. */
  amount: number;
  /** Standalone shadow action, or a legacy merge's marginal next-action delta. */
  actionAmount: number;
  priorityClass: SynthesisShadowPriorityClass;
  coverage: SynthesisShadowCoverage;
  capacity: SynthesisShadowCapacity;
  predictedStagingEligibility: SynthesisShadowPredictedStagingEligibility;
  terminalReadyAt: number;
  transactionCost: number;
  /** Energy required by the executable action: action payload + its fee. */
  requiredEnergy: number;
  /** Shared source Energy ownership reserved by commitment + next-action fee. */
  energyCommitmentAmount: number;
  terminalAllocatedAmount: number;
  stagingRequiredAmount: number;
  terminalEnergyAllocatedAmount: number;
  feeStagingRequiredAmount: number;
  stableKey: string;
}

interface SynthesisShadowLegacyDecisionObservationBase {
  comparisonKey: string;
  epochRevision: string;
  epochFingerprint: string;
  inputRevision: string;
  inputFingerprint: string;
  observedAt: number;
}

export interface SynthesisShadowLegacyRouteObservation
  extends SynthesisShadowLegacyDecisionObservationBase {
  kind: "route";
  route: SynthesisShadowRouteFact;
  /** Standalone=create; merge_delta=increment over an existing legacy task. */
  actionBasis: "standalone" | "merge_delta";
  /** Existing task commitment before the observed legacy write. */
  remainingBefore: number;
  /** Frozen source action batch used to prove the marginal action delta. */
  transferBatchSize: number;
  blocker?: never;
  coverage?: never;
  capacity?: never;
  predictedStagingEligibility?: never;
}

export interface SynthesisShadowLegacyNoneObservation
  extends SynthesisShadowLegacyDecisionObservationBase {
  kind: "none";
  route?: never;
  actionBasis?: never;
  remainingBefore?: never;
  transferBatchSize?: never;
  blocker: SynthesisShadowUnmatchedReason;
  coverage: SynthesisShadowCoverage;
  capacity: SynthesisShadowCapacity;
  predictedStagingEligibility: SynthesisShadowPredictedStagingEligibility;
}

export type SynthesisShadowLegacyDecisionObservation =
  | SynthesisShadowLegacyRouteObservation
  | SynthesisShadowLegacyNoneObservation;

export interface SynthesisShadowDecision extends SynthesisShadowRouteFact {
  comparisonKey: string;
  demandKey: string;
  origin: SynthesisShadowOrigin;
  inputRevision: string;
  inputFingerprint: string;
  observedAt: number;
  candidateTrace: SynthesisShadowCandidateTrace;
}

export interface SynthesisShadowUnmatchedDemand {
  comparisonKey: string;
  demandKey: string;
  origin: SynthesisShadowOrigin;
  inputRevision: string;
  inputFingerprint: string;
  observedAt: number;
  targetRoom: string;
  resource: ResourceConstant;
  uncoveredAmount: number;
  coverage: SynthesisShadowCoverage;
  capacity: SynthesisShadowCapacity;
  predictedStagingEligibility: SynthesisShadowPredictedStagingEligibility;
  reason: SynthesisShadowUnmatchedReason;
  candidateTrace: SynthesisShadowCandidateTrace;
}

export interface SynthesisShadowComparisonSample {
  comparisonKey: string;
  demandKey: string;
  inputRevision: string;
  inputFingerprint: string;
  legacyObservedAt?: number;
  shadowObservedAt: number;
  status: SynthesisShadowComparisonStatus;
  classification?: SynthesisShadowComparisonClassification;
  differences: readonly SynthesisShadowDifference[];
  unresolvedReason?: SynthesisShadowUnresolvedReason;
  legacy?: SynthesisShadowLegacyDecisionObservation;
  shadow?: SynthesisShadowDecision | SynthesisShadowUnmatchedDemand;
}

export interface SynthesisShadowSourceResidual {
  roomName: string;
  actionEnergyBudget: number;
  terminalActionEnergyAmount: number;
  terminalStagingFreeCapacity: number;
  resources: Array<{
    resource: ResourceConstant;
    availableAmount: number;
    terminalAmount: number;
  }>;
}

export interface SynthesisShadowReceiverResidual {
  roomName: string;
  storageHeadroom: number;
  terminalHeadroom: number;
  resources: Array<{
    resource: ResourceConstant;
    headroom: number;
  }>;
}

export interface SynthesisShadowResidualProjection {
  sources: SynthesisShadowSourceResidual[];
  receivers: SynthesisShadowReceiverResidual[];
}

export interface SynthesisShadowContinuation {
  schemaVersion: 2;
  /** Bounded integrity checksum of every checkpoint field below. */
  checkpointFingerprint: string;
  inputRevision: string;
  inputFingerprint: string;
  costModelRevision: string;
  expiresAt: number;
  nextDemandIndex: number;
  nextDonorIndex: number;
  nextDemandKey?: string;
  nextSourceRoom?: string;
  partialBest?: SynthesisShadowRouteFact;
  partialRejectionCounts: Partial<
    Record<SynthesisShadowCandidateRejection, number>
  >;
  partialLegacySourceEvaluation?: SynthesisShadowPartialLegacySourceEvaluation;
  completedDecisions: SynthesisShadowDecision[];
  completedUnmatched: SynthesisShadowUnmatchedDemand[];
  residual: SynthesisShadowResidualProjection;
  rejectionCounts: Partial<Record<SynthesisShadowCandidateRejection, number>>;
  totalCandidateEvaluations: number;
  totalTransactionCostEvaluations: number;
}

export interface SynthesisShadowMatcherInput {
  now: number;
  inputRevision: string;
  inputFingerprint: string;
  /** Version/hash of the exact transaction-cost oracle used by this epoch. */
  costModelRevision: string;
  demands: readonly SynthesisShadowDemandObservation[];
  rooms: readonly SynthesisShadowRoomFact[];
  legacyDecisions?: readonly SynthesisShadowLegacyDecisionObservation[];
  continuation?: SynthesisShadowContinuation;
  candidateBudget?: number;
  /** Exact, referentially transparent, side-effect-free canonical fee oracle. */
  transactionCost: (
    amount: number,
    sourceRoom: string,
    targetRoom: string,
  ) => number;
}

export interface SynthesisShadowMetrics {
  intentCount: number;
  processedIntentCount: number;
  roomFactCount: number;
  candidateBudget: number;
  candidateEvaluations: number;
  totalCandidateEvaluations: number;
  transactionCostEvaluations: number;
  totalTransactionCostEvaluations: number;
  rejectedCandidateCount: number;
  rejectionCounts: Partial<Record<SynthesisShadowCandidateRejection, number>>;
  decisionCount: number;
  unmatchedCount: number;
  comparisonCount: number;
  equalCount: number;
  differentCount: number;
  unresolvedCount: number;
  continuationUsed: boolean;
  continuationInvalidated: boolean;
  candidateBudgetExhausted: boolean;
  inputLimitExceeded: boolean;
}

export interface SynthesisShadowMatcherResult {
  complete: boolean;
  inputRevision: string;
  inputFingerprint: string;
  decisions: readonly SynthesisShadowDecision[];
  unmatched: readonly SynthesisShadowUnmatchedDemand[];
  comparisons: readonly SynthesisShadowComparisonSample[];
  continuation?: SynthesisShadowContinuation;
  metrics: SynthesisShadowMetrics;
}

interface MutableSourceProjection {
  actionEnergyBudget: number;
  terminalActionEnergyAmount: number;
  terminalStagingFreeCapacity: number;
  resources: Map<ResourceConstant, { availableAmount: number; terminalAmount: number }>;
}

interface MutableReceiverProjection {
  storageHeadroom: number;
  terminalHeadroom: number;
  resources: Map<ResourceConstant, number>;
}

interface MutableProjection {
  sources: Map<string, MutableSourceProjection>;
  receivers: Map<string, MutableReceiverProjection>;
}

interface PreparedDemand {
  observation: SynthesisShadowDemandObservation;
  uncoveredAmount: number;
  initialCoverage: SynthesisShadowCoverage;
  malformed: boolean;
  stale: boolean;
  inputDrift: boolean;
}

interface PreparedInput {
  demands: PreparedDemand[];
  rooms: Map<string, SynthesisShadowRoomFact>;
  donorsByResource: Map<ResourceConstant, SynthesisShadowRoomFact[]>;
  malformed: boolean;
  inputDrift: boolean;
  inputLimitExceeded: boolean;
  expiresAt: number;
}

const PRIORITY_RANK: Record<SynthesisShadowPriorityClass, number> = {
  deadline: 0,
  capacity_emergency: 1,
  survival_energy: 2,
  operator: 3,
  production: 4,
  capacity_pressure: 5,
  balance: 6,
  market: 7,
};

const DIFFERENCE_ORDER: readonly SynthesisShadowDifference[] = [
  "source",
  "target",
  "amount",
  "priority",
  "coverage",
  "capacity",
  "staging",
  "ready",
  "cost",
  "blocker",
  "legacy_missing",
  "shadow_missing",
];

const REJECTION_ORDER: readonly SynthesisShadowCandidateRejection[] = [
  "stale_receiver_fact",
  "invalid_receiver_endpoint",
  "receiver_capacity",
  "stale_source_fact",
  "invalid_source_endpoint",
  "source_protection",
  "fee_budget",
  "staging_capacity",
  "terminal_readiness",
  "transaction_cost_unavailable",
  "source_not_allowed",
  "same_room",
  "below_minimum_batch",
];

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isFiniteTick(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCandidateBudget(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return SYNTHESIS_SHADOW_DEFAULT_CANDIDATE_BUDGET;
  }
  return Math.max(
    0,
    Math.min(
      SYNTHESIS_SHADOW_MAX_CANDIDATE_BUDGET,
      Math.floor(value!),
    ),
  );
}

export function getSynthesisShadowPriorityRank(
  priorityClass: SynthesisShadowPriorityClass,
): number {
  return PRIORITY_RANK[priorityClass];
}

/** First-slice producer mapping; it never parses a legacy reason string. */
export function mapSynthesisShadowPriority(
  _origin: SynthesisShadowOrigin,
  deadlineAt?: number,
): SynthesisShadowPriorityClass {
  return Number.isFinite(deadlineAt) ? "deadline" : "production";
}

function comparePreparedDemands(left: PreparedDemand, right: PreparedDemand): number {
  const a = left.observation;
  const b = right.observation;
  const priorityDiff =
    (PRIORITY_RANK[a.priorityClass] ?? Number.MAX_SAFE_INTEGER) -
    (PRIORITY_RANK[b.priorityClass] ?? Number.MAX_SAFE_INTEGER);
  if (priorityDiff !== 0) return priorityDiff;
  const leftDeadline = Number.isFinite(a.deadlineAt)
    ? a.deadlineAt!
    : Number.MAX_SAFE_INTEGER;
  const rightDeadline = Number.isFinite(b.deadlineAt)
    ? b.deadlineAt!
    : Number.MAX_SAFE_INTEGER;
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
  // 同优先级（及同 deadline）内按 legacy 规划序仲裁：decisionOrder 是 legacy
  // 在本 batch 内顺序消耗 donor 库存的真实顺序。firstObservedAt 不参与仲裁
  // ——legacy 没有该概念，曾把更老的 E1N57 需求排在实际先规划的 E5N59 之前，
  // 导致同一稀缺源被两侧分给不同接收方。
  if (a.decisionOrder !== b.decisionOrder) return a.decisionOrder - b.decisionOrder;
  const leftKey = isBoundedString(a.comparisonKey, SYNTHESIS_SHADOW_MAX_KEY_LENGTH)
    ? a.comparisonKey
    : "";
  const rightKey = isBoundedString(b.comparisonKey, SYNTHESIS_SHADOW_MAX_KEY_LENGTH)
    ? b.comparisonKey
    : "";
  return compareStableText(leftKey, rightKey);
}

function getCoverage(
  desiredAmount: number,
  localAmount: number,
  incomingAmount: number,
): SynthesisShadowCoverage {
  if (localAmount >= desiredAmount || localAmount + incomingAmount >= desiredAmount) {
    return "covered";
  }
  if (incomingAmount > 0) return "partial";
  return "none";
}

function isDemandMalformed(demand: SynthesisShadowDemandObservation): boolean {
  if (
    !isBoundedString(demand.comparisonKey, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.demandKey, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.epochRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.epochFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.revision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.inputFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.targetRoom, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    !isBoundedString(demand.resource, SYNTHESIS_SHADOW_MAX_NAME_LENGTH)
  ) {
    return true;
  }
  if (demand.origin !== "synthesis_room" && demand.origin !== "synthesis_distributed_demand") {
    return true;
  }
  if (
    !isPositiveSafeInteger(demand.desiredAmount) ||
    !isNonNegativeSafeInteger(demand.localAmount) ||
    !isNonNegativeSafeInteger(demand.healthyIncomingAmount) ||
    !Number.isSafeInteger(
      demand.localAmount + demand.healthyIncomingAmount,
    ) ||
    !isPositiveSafeInteger(demand.minimumBatchAmount) ||
    !isPositiveSafeInteger(demand.maximumBatchAmount) ||
    demand.maximumBatchAmount > SYNTHESIS_SHADOW_MAX_BATCH_AMOUNT ||
    demand.minimumBatchAmount > demand.maximumBatchAmount ||
    !isFiniteTick(demand.firstObservedAt) ||
    !isFiniteTick(demand.observedAt) ||
    !isFiniteTick(demand.expiresAt) ||
    demand.firstObservedAt > demand.observedAt ||
    demand.expiresAt < demand.observedAt
  ) {
    return true;
  }
  if (demand.deadlineAt !== undefined && !isFiniteTick(demand.deadlineAt)) {
    return true;
  }
  if (mapSynthesisShadowPriority(demand.origin, demand.deadlineAt) !== demand.priorityClass) {
    return true;
  }
  if (
    demand.allowedSourceRooms !== undefined &&
    !Array.isArray(demand.allowedSourceRooms)
  ) {
    return true;
  }
  const allowed = demand.allowedSourceRooms || [];
  if (allowed.length > SYNTHESIS_SHADOW_MAX_DONORS_PER_INTENT) {
    return true;
  }
  return allowed.some(
    (roomName) =>
      !isBoundedString(roomName, SYNTHESIS_SHADOW_MAX_NAME_LENGTH),
  ) ||
    (demand.fixedSourceRoom !== undefined &&
      !isBoundedString(
        demand.fixedSourceRoom,
        SYNTHESIS_SHADOW_MAX_NAME_LENGTH,
      )) ||
    (demand.product !== undefined &&
      !isBoundedString(demand.product, SYNTHESIS_SHADOW_MAX_NAME_LENGTH)) ||
    new Set(allowed).size !== allowed.length;
}

function isRoomMalformed(room: SynthesisShadowRoomFact): boolean {
  if (
    !isBoundedString(room.roomName, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    !isBoundedString(room.epochRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(room.epochFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(room.revision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    typeof room.owned !== "boolean" ||
    typeof room.hasStorage !== "boolean" ||
    typeof room.hasTerminal !== "boolean" ||
    typeof room.terminalReachable !== "boolean" ||
    typeof room.receiverEligible !== "boolean" ||
    (room.capacityState !== "normal" &&
      room.capacityState !== "pressure" &&
      room.capacityState !== "emergency") ||
    !isFiniteTick(room.observedAt) ||
    !isFiniteTick(room.expiresAt) ||
    room.expiresAt < room.observedAt ||
    !isFiniteTick(room.terminalReadyAt) ||
    !isNonNegativeSafeInteger(room.receiverStorageHeadroom) ||
    !isNonNegativeSafeInteger(room.receiverTerminalHeadroom) ||
    !isNonNegativeSafeInteger(room.terminalStagingFreeCapacity) ||
    !isPositiveSafeInteger(room.transferBatchSize) ||
    room.transferBatchSize > SYNTHESIS_SHADOW_MAX_BATCH_AMOUNT ||
    !isNonNegativeSafeInteger(room.actionEnergyBudget) ||
    !isNonNegativeSafeInteger(room.terminalActionEnergyAmount) ||
    room.terminalActionEnergyAmount > room.actionEnergyBudget ||
    !Array.isArray(room.resources) ||
    room.resources.length > SYNTHESIS_SHADOW_MAX_RESOURCE_FACTS_PER_ROOM
  ) {
    return true;
  }
  const resourceKeys = new Set<ResourceConstant>();
  for (const resource of room.resources) {
    if (
      !isBoundedString(resource.resource, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
      !isNonNegativeSafeInteger(resource.sourceAvailableAmount) ||
      !isNonNegativeSafeInteger(resource.sourceTerminalAmount) ||
      resource.sourceTerminalAmount > resource.sourceAvailableAmount ||
      !isNonNegativeSafeInteger(resource.receiverResourceHeadroom) ||
      resourceKeys.has(resource.resource)
    ) {
      return true;
    }
    resourceKeys.add(resource.resource);
  }
  return false;
}

function demandExceedsInputLimit(
  demand: SynthesisShadowDemandObservation,
): boolean {
  const allowed = Array.isArray(demand.allowedSourceRooms)
    ? demand.allowedSourceRooms
    : [];
  return !isBoundedString(demand.comparisonKey, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.demandKey, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.epochRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.epochFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.revision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.inputFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(demand.targetRoom, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    !isBoundedString(demand.resource, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    (demand.product !== undefined &&
      !isBoundedString(demand.product, SYNTHESIS_SHADOW_MAX_NAME_LENGTH)) ||
    (demand.fixedSourceRoom !== undefined &&
      !isBoundedString(
        demand.fixedSourceRoom,
        SYNTHESIS_SHADOW_MAX_NAME_LENGTH,
      )) ||
    demand.maximumBatchAmount > SYNTHESIS_SHADOW_MAX_BATCH_AMOUNT ||
    (demand.allowedSourceRooms !== undefined &&
      !Array.isArray(demand.allowedSourceRooms)) ||
    allowed.length > SYNTHESIS_SHADOW_MAX_DONORS_PER_INTENT ||
    allowed.some((roomName) =>
      !isBoundedString(roomName, SYNTHESIS_SHADOW_MAX_NAME_LENGTH)
    );
}

function roomExceedsInputLimit(room: SynthesisShadowRoomFact): boolean {
  return !isBoundedString(room.roomName, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    !isBoundedString(room.epochRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(room.epochFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(room.revision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    room.transferBatchSize > SYNTHESIS_SHADOW_MAX_BATCH_AMOUNT ||
    !Array.isArray(room.resources) ||
    room.resources.length > SYNTHESIS_SHADOW_MAX_RESOURCE_FACTS_PER_ROOM ||
    room.resources.some((resource) =>
      !isBoundedString(resource.resource, SYNTHESIS_SHADOW_MAX_NAME_LENGTH)
    );
}

function prepareInput(input: SynthesisShadowMatcherInput): PreparedInput {
  const inputLimitExceeded =
    input.demands.length > SYNTHESIS_SHADOW_MAX_INTENTS ||
    input.rooms.length > SYNTHESIS_SHADOW_MAX_ROOM_FACTS ||
    (input.legacyDecisions?.length || 0) > SYNTHESIS_SHADOW_MAX_INTENTS ||
    !isBoundedString(input.inputRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(input.inputFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(input.costModelRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    input.demands.some(demandExceedsInputLimit) ||
    input.rooms.some(roomExceedsInputLimit);
  const roomMap = new Map<string, SynthesisShadowRoomFact>();
  let malformed =
    !isFiniteTick(input.now) ||
    !isBoundedString(input.inputRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(input.inputFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    !isBoundedString(input.costModelRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
    typeof input.transactionCost !== "function";
  if (inputLimitExceeded) {
    return {
      demands: [],
      rooms: roomMap,
      donorsByResource: new Map(),
      malformed,
      inputDrift: false,
      inputLimitExceeded: true,
      expiresAt: isFiniteTick(input.now) ? input.now : 0,
    };
  }
  let inputDrift = false;
  let expiresAt = Number.MAX_SAFE_INTEGER;

  for (const room of input.rooms) {
    if (isRoomMalformed(room)) {
      malformed = true;
      continue;
    }
    if (roomMap.has(room.roomName)) {
      malformed = true;
      continue;
    }
    if (
      room.epochRevision !== input.inputRevision ||
      room.epochFingerprint !== input.inputFingerprint
    ) {
      inputDrift = true;
    }
    roomMap.set(room.roomName, room);
    expiresAt = Math.min(expiresAt, room.expiresAt);
  }

  const seenComparisonKeys = new Set<string>();
  const demands = input.demands
    .slice(0, SYNTHESIS_SHADOW_MAX_INTENTS)
    .map((observation): PreparedDemand => {
      const boundedComparisonKey = isBoundedString(
        observation.comparisonKey,
        SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
      );
      const duplicate = boundedComparisonKey &&
        seenComparisonKeys.has(observation.comparisonKey);
      if (boundedComparisonKey) {
        seenComparisonKeys.add(observation.comparisonKey);
      }
      const malformedDemand = duplicate || isDemandMalformed(observation);
      if (isFiniteTick(observation.expiresAt)) {
        expiresAt = Math.min(expiresAt, observation.expiresAt);
      }
      return {
        observation,
        uncoveredAmount: malformedDemand
          ? 0
          : Math.max(
              0,
              observation.desiredAmount -
                observation.localAmount -
                observation.healthyIncomingAmount,
            ),
        initialCoverage: malformedDemand
          ? "unknown"
          : getCoverage(
              observation.desiredAmount,
              observation.localAmount,
              observation.healthyIncomingAmount,
            ),
        malformed: malformedDemand,
        inputDrift:
          !malformedDemand &&
          (observation.epochRevision !== input.inputRevision ||
            observation.epochFingerprint !== input.inputFingerprint),
        stale:
          !malformedDemand &&
          (input.now < observation.observedAt || input.now > observation.expiresAt),
      };
    })
    .sort(comparePreparedDemands);

  inputDrift = inputDrift || demands.some((demand) => demand.inputDrift);
  const donorsByResource = new Map<
    ResourceConstant,
    SynthesisShadowRoomFact[]
  >();
  for (const room of roomMap.values()) {
    for (const resource of room.resources) {
      const donors = donorsByResource.get(resource.resource) || [];
      donors.push(room);
      donorsByResource.set(resource.resource, donors);
    }
  }
  for (const donors of donorsByResource.values()) {
    donors.sort((left, right) =>
      compareStableText(left.roomName, right.roomName)
    );
  }

  if (expiresAt === Number.MAX_SAFE_INTEGER) expiresAt = input.now;
  return {
    demands,
    rooms: roomMap,
    donorsByResource,
    malformed,
    inputDrift,
    inputLimitExceeded,
    expiresAt,
  };
}

function createProjection(rooms: Map<string, SynthesisShadowRoomFact>): MutableProjection {
  const sources = new Map<string, MutableSourceProjection>();
  const receivers = new Map<string, MutableReceiverProjection>();
  for (const room of rooms.values()) {
    const sourceResources = new Map<
      ResourceConstant,
      { availableAmount: number; terminalAmount: number }
    >();
    const receiverResources = new Map<ResourceConstant, number>();
    for (const resource of room.resources) {
      sourceResources.set(resource.resource, {
        availableAmount: resource.sourceAvailableAmount,
        terminalAmount: resource.sourceTerminalAmount,
      });
      receiverResources.set(resource.resource, resource.receiverResourceHeadroom);
    }
    sources.set(room.roomName, {
      actionEnergyBudget: room.actionEnergyBudget,
      terminalActionEnergyAmount: room.terminalActionEnergyAmount,
      terminalStagingFreeCapacity: room.terminalStagingFreeCapacity,
      resources: sourceResources,
    });
    receivers.set(room.roomName, {
      storageHeadroom: room.receiverStorageHeadroom,
      terminalHeadroom: room.receiverTerminalHeadroom,
      resources: receiverResources,
    });
  }
  return { sources, receivers };
}

function snapshotProjection(projection: MutableProjection): SynthesisShadowResidualProjection {
  return {
    sources: [...projection.sources.entries()]
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([roomName, source]) => ({
        roomName,
        actionEnergyBudget: source.actionEnergyBudget,
        terminalActionEnergyAmount: source.terminalActionEnergyAmount,
        terminalStagingFreeCapacity: source.terminalStagingFreeCapacity,
        resources: [...source.resources.entries()]
          .sort(([left], [right]) => compareStableText(left, right))
          .map(([resource, amount]) => ({ resource, ...amount })),
      })),
    receivers: [...projection.receivers.entries()]
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([roomName, receiver]) => ({
        roomName,
        storageHeadroom: receiver.storageHeadroom,
        terminalHeadroom: receiver.terminalHeadroom,
        resources: [...receiver.resources.entries()]
          .sort(([left], [right]) => compareStableText(left, right))
          .map(([resource, headroom]) => ({ resource, headroom })),
      })),
  };
}

function restoreProjection(
  residual: SynthesisShadowResidualProjection,
  rooms: Map<string, SynthesisShadowRoomFact>,
): MutableProjection | null {
  if (
    residual.sources.length !== rooms.size ||
    residual.receivers.length !== rooms.size
  ) {
    return null;
  }
  const projection: MutableProjection = {
    sources: new Map(),
    receivers: new Map(),
  };
  for (const source of residual.sources) {
    if (
      !source ||
      !isBoundedString(source.roomName, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
      !Array.isArray(source.resources)
    ) {
      return null;
    }
    const roomFact = rooms.get(source.roomName);
    if (
      projection.sources.has(source.roomName) ||
      !roomFact ||
      !isNonNegativeSafeInteger(source.actionEnergyBudget) ||
      source.actionEnergyBudget > roomFact.actionEnergyBudget ||
      !isNonNegativeSafeInteger(source.terminalActionEnergyAmount) ||
      source.terminalActionEnergyAmount > roomFact.terminalActionEnergyAmount ||
      source.terminalActionEnergyAmount > source.actionEnergyBudget ||
      !isNonNegativeSafeInteger(source.terminalStagingFreeCapacity) ||
      source.terminalStagingFreeCapacity > roomFact.terminalStagingFreeCapacity ||
      source.resources.length !== roomFact.resources.length
    ) {
      return null;
    }
    const resources = new Map<
      ResourceConstant,
      { availableAmount: number; terminalAmount: number }
    >();
    for (const resource of source.resources) {
      if (
        !resource ||
        !isBoundedString(resource.resource, SYNTHESIS_SHADOW_MAX_NAME_LENGTH)
      ) {
        return null;
      }
      const roomResource = roomFact.resources.find(
        (entry) => entry.resource === resource.resource,
      );
      if (
        !roomResource ||
        resources.has(resource.resource) ||
        !isNonNegativeSafeInteger(resource.availableAmount) ||
        resource.availableAmount > roomResource.sourceAvailableAmount ||
        !isNonNegativeSafeInteger(resource.terminalAmount) ||
        resource.terminalAmount > resource.availableAmount ||
        resource.terminalAmount > roomResource.sourceTerminalAmount
      ) {
        return null;
      }
      resources.set(resource.resource, {
        availableAmount: resource.availableAmount,
        terminalAmount: resource.terminalAmount,
      });
    }
    projection.sources.set(source.roomName, {
      actionEnergyBudget: source.actionEnergyBudget,
      terminalActionEnergyAmount: source.terminalActionEnergyAmount,
      terminalStagingFreeCapacity: source.terminalStagingFreeCapacity,
      resources,
    });
  }
  for (const receiver of residual.receivers) {
    if (
      !receiver ||
      !isBoundedString(receiver.roomName, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
      !Array.isArray(receiver.resources)
    ) {
      return null;
    }
    const roomFact = rooms.get(receiver.roomName);
    if (
      projection.receivers.has(receiver.roomName) ||
      !roomFact ||
      !isNonNegativeSafeInteger(receiver.storageHeadroom) ||
      receiver.storageHeadroom > roomFact.receiverStorageHeadroom ||
      !isNonNegativeSafeInteger(receiver.terminalHeadroom) ||
      receiver.terminalHeadroom > roomFact.receiverTerminalHeadroom ||
      receiver.resources.length !== roomFact.resources.length
    ) {
      return null;
    }
    const resources = new Map<ResourceConstant, number>();
    for (const resource of receiver.resources) {
      if (
        !resource ||
        !isBoundedString(resource.resource, SYNTHESIS_SHADOW_MAX_NAME_LENGTH)
      ) {
        return null;
      }
      const roomResource = roomFact.resources.find(
        (entry) => entry.resource === resource.resource,
      );
      if (
        !roomResource ||
        resources.has(resource.resource) ||
        !isNonNegativeSafeInteger(resource.headroom) ||
        resource.headroom > roomResource.receiverResourceHeadroom
      ) {
        return null;
      }
      resources.set(resource.resource, resource.headroom);
    }
    projection.receivers.set(receiver.roomName, {
      storageHeadroom: receiver.storageHeadroom,
      terminalHeadroom: receiver.terminalHeadroom,
      resources,
    });
  }
  return projection;
}

function incrementRejection(
  counts: Partial<Record<SynthesisShadowCandidateRejection, number>>,
  reason: SynthesisShadowCandidateRejection,
): void {
  counts[reason] = (counts[reason] || 0) + 1;
}

function cloneRejectionCounts(
  counts: Partial<Record<SynthesisShadowCandidateRejection, number>>,
): Partial<Record<SynthesisShadowCandidateRejection, number>> {
  const clone: Partial<Record<SynthesisShadowCandidateRejection, number>> = {};
  for (const reason of REJECTION_ORDER) {
    if (counts[reason] !== undefined) clone[reason] = counts[reason];
  }
  return clone;
}

function rejectionCountEntries(
  counts: Partial<Record<SynthesisShadowCandidateRejection, number>>,
): SynthesisShadowCandidateRejectionCount[] {
  const entries: SynthesisShadowCandidateRejectionCount[] = [];
  for (const reason of REJECTION_ORDER) {
    const count = counts[reason] || 0;
    if (count > 0) entries.push([reason, count]);
  }
  return entries;
}

function cloneReceiverTrace(
  receiver: SynthesisShadowReceiverTrace,
): SynthesisShadowReceiverTrace {
  return receiver.kind === "missing"
    ? { kind: "missing" }
    : {
        kind: "present",
        receiverEligible: receiver.receiverEligible,
        storageHeadroom: receiver.storageHeadroom,
        terminalHeadroom: receiver.terminalHeadroom,
        resourceHeadroom: receiver.resourceHeadroom,
      };
}

function captureReceiverTrace(
  demand: PreparedDemand,
  prepared: PreparedInput,
  projection: MutableProjection,
): SynthesisShadowReceiverTrace {
  const room = prepared.rooms.get(demand.observation.targetRoom);
  const receiver = projection.receivers.get(demand.observation.targetRoom);
  if (!room || !receiver) return { kind: "missing" };
  return {
    kind: "present",
    receiverEligible: room.receiverEligible,
    storageHeadroom: receiver.storageHeadroom,
    terminalHeadroom: receiver.terminalHeadroom,
    resourceHeadroom:
      receiver.resources.get(demand.observation.resource) || 0,
  };
}

function clonePartialLegacySourceEvaluation(
  value: SynthesisShadowPartialLegacySourceEvaluation | undefined,
): SynthesisShadowPartialLegacySourceEvaluation | undefined {
  if (!value) return undefined;
  return {
    sourceRoom: value.sourceRoom,
    outcome: value.outcome,
    ...(value.rejection ? { rejection: value.rejection } : {}),
  };
}

function buildLegacySourceTrace(
  legacy: SynthesisShadowLegacyDecisionObservation | undefined,
  donors: readonly SynthesisShadowRoomFact[],
  evaluatedCount: number,
  topSourceRoom: string | undefined,
  evaluation: SynthesisShadowPartialLegacySourceEvaluation | undefined,
): SynthesisShadowLegacySourceCandidateTrace | undefined {
  if (!legacy || legacy.kind !== "route") return undefined;
  const sourceRoom = legacy.route.sourceRoom;
  const donorIndex = donors.findIndex((donor) => donor.roomName === sourceRoom);
  if (donorIndex < 0) {
    return { sourceRoom, disposition: "not_candidate" };
  }
  if (donorIndex >= evaluatedCount || !evaluation) {
    return { sourceRoom, disposition: "not_evaluated" };
  }
  if (evaluation.outcome === "rejected") {
    return {
      sourceRoom,
      disposition: "rejected",
      ...(evaluation.rejection ? { rejection: evaluation.rejection } : {}),
    };
  }
  return {
    sourceRoom,
    disposition:
      topSourceRoom === sourceRoom ? "selected" : "feasible_lower_rank",
  };
}

function buildCandidateTrace(
  demand: PreparedDemand,
  prepared: PreparedInput,
  projection: MutableProjection,
  donors: readonly SynthesisShadowRoomFact[],
  evaluatedCount: number,
  rejectionCounts: Partial<
    Record<SynthesisShadowCandidateRejection, number>
  >,
  topRoute: SynthesisShadowRouteFact | undefined,
  legacy: SynthesisShadowLegacyDecisionObservation | undefined,
  legacySourceEvaluation:
    | SynthesisShadowPartialLegacySourceEvaluation
    | undefined,
  selectedRejection?: SynthesisShadowCandidateRejection,
): SynthesisShadowCandidateTrace {
  const canonicalRejections = rejectionCountEntries(rejectionCounts);
  const rejectedCount = canonicalRejections.reduce(
    (total, [, count]) => total + count,
    0,
  );
  const feasibleCount = Math.max(0, evaluatedCount - rejectedCount);
  const topSourceRoom = topRoute?.sourceRoom;
  const legacySource = buildLegacySourceTrace(
    legacy,
    donors,
    evaluatedCount,
    topSourceRoom,
    legacySourceEvaluation,
  );
  return {
    donorCount: donors.length,
    evaluatedCount,
    feasibleCount,
    rejectedCount,
    ...(selectedRejection ? { selectedRejection } : {}),
    rejectionCounts: canonicalRejections,
    ...(topSourceRoom ? { topSourceRoom } : {}),
    ...(legacySource ? { legacySource } : {}),
    receiver: captureReceiverTrace(demand, prepared, projection),
  };
}

function cloneCandidateTrace(
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
    ...(trace.topSourceRoom ? { topSourceRoom: trace.topSourceRoom } : {}),
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
    receiver: cloneReceiverTrace(trace.receiver),
  };
}

function isRejectionCountMap(
  value: Partial<Record<SynthesisShadowCandidateRejection, number>> | undefined,
): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    !hasOnlyOwnKeys(value, REJECTION_ORDER)
  ) {
    return false;
  }
  return REJECTION_ORDER.every((reason) => {
    const count = value[reason];
    return count === undefined || isNonNegativeSafeInteger(count);
  });
}

function projectionsEqual(
  left: SynthesisShadowResidualProjection,
  right: SynthesisShadowResidualProjection,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourcePressureRank(state: SynthesisShadowRoomFact["capacityState"]): number {
  return state === "emergency" ? 2 : state === "pressure" ? 1 : 0;
}

function compareRouteFacts(
  left: SynthesisShadowRouteFact,
  right: SynthesisShadowRouteFact,
  rooms: Map<string, SynthesisShadowRoomFact>,
): number {
  const pressureDiff =
    sourcePressureRank(rooms.get(right.sourceRoom)!.capacityState) -
    sourcePressureRank(rooms.get(left.sourceRoom)!.capacityState);
  if (pressureDiff !== 0) return pressureDiff;
  if (left.terminalReadyAt !== right.terminalReadyAt) {
    return left.terminalReadyAt - right.terminalReadyAt;
  }
  const leftRatio = left.transactionCost / Math.max(1, left.actionAmount);
  const rightRatio = right.transactionCost / Math.max(1, right.actionAmount);
  if (leftRatio !== rightRatio) return leftRatio - rightRatio;
  if (left.amount !== right.amount) return right.amount - left.amount;
  return compareStableText(left.stableKey, right.stableKey);
}

function demandAllowedSource(
  demand: SynthesisShadowDemandObservation,
  roomName: string,
): boolean {
  if (demand.fixedSourceRoom && demand.fixedSourceRoom !== roomName) return false;
  const allowed = demand.allowedSourceRooms || [];
  return allowed.length === 0 || allowed.includes(roomName);
}

function createRouteStableKey(
  sourceRoom: string,
  targetRoom: string,
  resource: ResourceConstant,
  comparisonKey: string,
): string {
  return `${sourceRoom}\u0000${targetRoom}\u0000${resource}\u0000${comparisonKey}`;
}

interface CandidateActionProjection {
  actionAmount: number;
  transactionCost: number;
  requiredEnergy: number;
  energyCommitmentAmount: number;
  terminalAllocatedAmount: number;
  stagingRequiredAmount: number;
  terminalEnergyAllocatedAmount: number;
  feeStagingRequiredAmount: number;
  feasible: boolean;
  rejection?: "fee_budget" | "staging_capacity";
}

function projectCandidateAction(
  commitmentAmount: number,
  transferBatchSize: number,
  transactionCost: number,
  resource: ResourceConstant,
  sourceResource: { availableAmount: number; terminalAmount: number },
  source: MutableSourceProjection,
): CandidateActionProjection {
  const energyPayload = resource === RESOURCE_ENERGY;
  const actionAmount = Math.min(commitmentAmount, transferBatchSize);
  const requiredEnergy = transactionCost + (energyPayload ? actionAmount : 0);
  const energyCommitmentAmount =
    transactionCost + (energyPayload ? commitmentAmount : 0);
  const terminalFeeAmount = Math.min(
    transactionCost,
    source.terminalActionEnergyAmount,
  );
  const terminalPayloadEnergy = energyPayload
    ? Math.max(0, source.terminalActionEnergyAmount - terminalFeeAmount)
    : Number.MAX_SAFE_INTEGER;
  const terminalAllocatedAmount = Math.min(
    actionAmount,
    sourceResource.terminalAmount,
    terminalPayloadEnergy,
  );
  const stagingRequiredAmount = actionAmount - terminalAllocatedAmount;
  const terminalEnergyAllocatedAmount =
    terminalFeeAmount + (energyPayload ? terminalAllocatedAmount : 0);
  const feeStagingRequiredAmount = transactionCost - terminalFeeAmount;
  const totalStagingRequired =
    stagingRequiredAmount + feeStagingRequiredAmount;

  if (
    !Number.isSafeInteger(requiredEnergy) ||
    !Number.isSafeInteger(energyCommitmentAmount) ||
    energyCommitmentAmount > source.actionEnergyBudget
  ) {
    return {
      actionAmount,
      transactionCost,
      requiredEnergy,
      energyCommitmentAmount,
      terminalAllocatedAmount,
      stagingRequiredAmount,
      terminalEnergyAllocatedAmount,
      feeStagingRequiredAmount,
      feasible: false,
      rejection: "fee_budget",
    };
  }
  if (totalStagingRequired > source.terminalStagingFreeCapacity) {
    return {
      actionAmount,
      transactionCost,
      requiredEnergy,
      energyCommitmentAmount,
      terminalAllocatedAmount,
      stagingRequiredAmount,
      terminalEnergyAllocatedAmount,
      feeStagingRequiredAmount,
      feasible: false,
      rejection: "staging_capacity",
    };
  }
  return {
    actionAmount,
    transactionCost,
    requiredEnergy,
    energyCommitmentAmount,
    terminalAllocatedAmount,
    stagingRequiredAmount,
    terminalEnergyAllocatedAmount,
    feeStagingRequiredAmount,
    feasible: true,
  };
}

function findLargestFeasibleAction(
  input: SynthesisShadowMatcherInput,
  sourceRoom: string,
  targetRoom: string,
  resource: ResourceConstant,
  transferBatchSize: number,
  minimumAmount: number,
  maximumAmount: number,
  sourceResource: { availableAmount: number; terminalAmount: number },
  source: MutableSourceProjection,
): {
  amount?: number;
  action?: CandidateActionProjection;
  rejection?: SynthesisShadowCandidateRejection;
  transactionCostEvaluations: number;
} {
  let transactionCostEvaluations = 0;
  const costByActionAmount = new Map<number, number | null>();
  const quote = (
    commitmentAmount: number,
  ): CandidateActionProjection | "transaction_cost_unavailable" => {
    const actionAmount = Math.min(commitmentAmount, transferBatchSize);
    let transactionCost = costByActionAmount.get(actionAmount);
    if (transactionCost === undefined) {
      try {
        transactionCostEvaluations += 1;
        const quoted = input.transactionCost(
          actionAmount,
          sourceRoom,
          targetRoom,
        );
        transactionCost = isNonNegativeSafeInteger(quoted) ? quoted : null;
      } catch {
        transactionCost = null;
      }
      costByActionAmount.set(actionAmount, transactionCost);
    }
    if (transactionCost === null) {
      return "transaction_cost_unavailable";
    }
    return projectCandidateAction(
      commitmentAmount,
      transferBatchSize,
      transactionCost,
      resource,
      sourceResource,
      source,
    );
  };

  const maximumAction = quote(maximumAmount);
  if (maximumAction === "transaction_cost_unavailable") {
    return {
      rejection: "transaction_cost_unavailable",
      transactionCostEvaluations,
    };
  }
  if (maximumAction.feasible) {
    return {
      amount: maximumAmount,
      action: maximumAction,
      transactionCostEvaluations,
    };
  }

  let low = minimumAmount;
  // Commitments above the action batch share the same cost/staging facts.
  // Once that action is infeasible, search only the strictly smaller actions.
  let high = resource === RESOURCE_ENERGY
    ? maximumAmount - 1
    : Math.min(maximumAmount - 1, transferBatchSize - 1);
  let bestAmount = 0;
  let bestAction: CandidateActionProjection | undefined;
  while (low <= high) {
    const amount = Math.floor((low + high) / 2);
    const action = quote(amount);
    if (action === "transaction_cost_unavailable") {
      return {
        rejection: "transaction_cost_unavailable",
        transactionCostEvaluations,
      };
    }
    if (action.feasible) {
      bestAmount = amount;
      bestAction = action;
      low = amount + 1;
    } else {
      high = amount - 1;
    }
  }
  if (bestAction) {
    return {
      amount: bestAmount,
      action: bestAction,
      transactionCostEvaluations,
    };
  }
  return {
    rejection: maximumAction.rejection || "fee_budget",
    transactionCostEvaluations,
  };
}

function evaluateCandidate(
  input: SynthesisShadowMatcherInput,
  demand: PreparedDemand,
  sourceRoom: SynthesisShadowRoomFact,
  targetRoom: SynthesisShadowRoomFact | undefined,
  projection: MutableProjection,
): {
  route?: SynthesisShadowRouteFact;
  rejection?: SynthesisShadowCandidateRejection;
  transactionCostEvaluations?: number;
} {
  const observation = demand.observation;
  if (sourceRoom.roomName === observation.targetRoom) return { rejection: "same_room" };
  if (!demandAllowedSource(observation, sourceRoom.roomName)) {
    return { rejection: "source_not_allowed" };
  }
  if (input.now < sourceRoom.observedAt || input.now > sourceRoom.expiresAt) {
    return { rejection: "stale_source_fact" };
  }
  if (
    !sourceRoom.owned ||
    !sourceRoom.hasStorage ||
    !sourceRoom.hasTerminal ||
    !sourceRoom.terminalReachable
  ) {
    return { rejection: "invalid_source_endpoint" };
  }
  if (!isFiniteTick(sourceRoom.terminalReadyAt)) {
    return { rejection: "terminal_readiness" };
  }
  if (!targetRoom || input.now < targetRoom.observedAt || input.now > targetRoom.expiresAt) {
    return { rejection: "stale_receiver_fact" };
  }
  if (
    !targetRoom.owned ||
    !targetRoom.hasStorage ||
    !targetRoom.hasTerminal ||
    !targetRoom.terminalReachable
  ) {
    return { rejection: "invalid_receiver_endpoint" };
  }
  if (!targetRoom.receiverEligible) return { rejection: "receiver_capacity" };

  const source = projection.sources.get(sourceRoom.roomName);
  const receiver = projection.receivers.get(targetRoom.roomName);
  const sourceResource = source?.resources.get(observation.resource);
  const receiverResourceHeadroom = receiver?.resources.get(observation.resource) || 0;
  if (!source || !sourceResource || sourceResource.availableAmount <= 0) {
    return { rejection: "source_protection" };
  }
  if (
    !receiver ||
    receiver.storageHeadroom <= 0 ||
    receiver.terminalHeadroom <= 0 ||
    receiverResourceHeadroom <= 0
  ) {
    return { rejection: "receiver_capacity" };
  }

  let amount = Math.min(
    demand.uncoveredAmount,
    observation.maximumBatchAmount,
    sourceResource.availableAmount,
    receiver.storageHeadroom,
    receiver.terminalHeadroom,
    receiverResourceHeadroom,
  );
  amount = Math.max(0, Math.floor(amount));
  if (amount <= 0) return { rejection: "staging_capacity" };
  if (amount < observation.minimumBatchAmount) {
    return { rejection: "below_minimum_batch" };
  }

  const feasible = findLargestFeasibleAction(
    input,
    sourceRoom.roomName,
    targetRoom.roomName,
    observation.resource,
    sourceRoom.transferBatchSize,
    observation.minimumBatchAmount,
    amount,
    sourceResource,
    source,
  );
  if (!feasible.action || feasible.amount === undefined) {
    return {
      rejection: feasible.rejection || "fee_budget",
      transactionCostEvaluations: feasible.transactionCostEvaluations,
    };
  }
  amount = feasible.amount;
  const action = feasible.action;

  return {
    route: {
      sourceRoom: sourceRoom.roomName,
      targetRoom: targetRoom.roomName,
      resource: observation.resource,
      amount,
      actionAmount: action.actionAmount,
      priorityClass: observation.priorityClass,
      coverage: amount >= demand.uncoveredAmount ? "covered" : "partial",
      capacity: "eligible",
      predictedStagingEligibility: "eligible",
      terminalReadyAt: sourceRoom.terminalReadyAt,
      transactionCost: action.transactionCost,
      requiredEnergy: action.requiredEnergy,
      energyCommitmentAmount: action.energyCommitmentAmount,
      terminalAllocatedAmount: action.terminalAllocatedAmount,
      stagingRequiredAmount: action.stagingRequiredAmount,
      terminalEnergyAllocatedAmount: action.terminalEnergyAllocatedAmount,
      feeStagingRequiredAmount: action.feeStagingRequiredAmount,
      stableKey: createRouteStableKey(
        sourceRoom.roomName,
        targetRoom.roomName,
        observation.resource,
        observation.comparisonKey,
      ),
    },
    transactionCostEvaluations: feasible.transactionCostEvaluations,
  };
}

function applyRouteToProjection(
  route: SynthesisShadowRouteFact,
  projection: MutableProjection,
): boolean {
  const source = projection.sources.get(route.sourceRoom);
  const receiver = projection.receivers.get(route.targetRoom);
  const sourceResource = source?.resources.get(route.resource);
  const receiverHeadroom = receiver?.resources.get(route.resource);
  if (
    !source ||
    !receiver ||
    !sourceResource ||
    receiverHeadroom === undefined ||
    sourceResource.availableAmount < route.amount ||
    source.terminalActionEnergyAmount < route.terminalEnergyAllocatedAmount ||
    source.terminalStagingFreeCapacity <
      route.stagingRequiredAmount + route.feeStagingRequiredAmount ||
    source.actionEnergyBudget < route.energyCommitmentAmount ||
    receiver.storageHeadroom < route.amount ||
    receiver.terminalHeadroom < route.amount ||
    receiverHeadroom < route.amount
  ) {
    return false;
  }
  const nextAvailableAmount = sourceResource.availableAmount - route.amount;
  sourceResource.availableAmount = nextAvailableAmount;
  // Terminal stock is a safe subset of total source availability. The current
  // action owns terminalAllocatedAmount; the commitment remainder may be
  // backed by storage, so only cap the residual subset to total availability.
  sourceResource.terminalAmount = Math.min(
    Math.max(
      0,
      sourceResource.terminalAmount - route.terminalAllocatedAmount,
    ),
    nextAvailableAmount,
  );
  source.terminalStagingFreeCapacity -=
    route.stagingRequiredAmount + route.feeStagingRequiredAmount;
  source.actionEnergyBudget -= route.energyCommitmentAmount;
  source.terminalActionEnergyAmount = Math.min(
    source.actionEnergyBudget,
    source.terminalActionEnergyAmount - route.terminalEnergyAllocatedAmount,
  );
  receiver.storageHeadroom -= route.amount;
  receiver.terminalHeadroom -= route.amount;
  receiver.resources.set(route.resource, receiverHeadroom - route.amount);
  return true;
}

function selectUnmatchedReason(
  counts: Partial<Record<SynthesisShadowCandidateRejection, number>>,
): SynthesisShadowUnmatchedReason {
  for (const reason of REJECTION_ORDER) {
    if ((counts[reason] || 0) > 0) return reason;
  }
  return "no_donor";
}

function makeUnmatched(
  input: SynthesisShadowMatcherInput,
  demand: PreparedDemand,
  reason: SynthesisShadowUnmatchedReason,
  candidateTrace: SynthesisShadowCandidateTrace,
): SynthesisShadowUnmatchedDemand {
  const target = demand.observation.targetRoom;
  const isCapacityBlock =
    reason === "receiver_capacity" ||
    reason === "stale_receiver_fact" ||
    reason === "invalid_receiver_endpoint";
  const isStagingBlock = reason === "staging_capacity";
  return {
    comparisonKey: demand.observation.comparisonKey,
    demandKey: demand.observation.demandKey,
    origin: demand.observation.origin,
    inputRevision: demand.observation.revision,
    inputFingerprint: demand.observation.inputFingerprint,
    observedAt: input.now,
    targetRoom: target,
    resource: demand.observation.resource,
    uncoveredAmount: demand.uncoveredAmount,
    coverage: demand.initialCoverage,
    capacity: isCapacityBlock ? "blocked" : "unknown",
    predictedStagingEligibility: isStagingBlock ? "blocked" : "unknown",
    reason,
    candidateTrace: cloneCandidateTrace(candidateTrace),
  };
}

function makeDecision(
  input: SynthesisShadowMatcherInput,
  demand: PreparedDemand,
  route: SynthesisShadowRouteFact,
  candidateTrace: SynthesisShadowCandidateTrace,
): SynthesisShadowDecision {
  return {
    ...cloneRouteFact(route),
    comparisonKey: demand.observation.comparisonKey,
    demandKey: demand.observation.demandKey,
    origin: demand.observation.origin,
    inputRevision: demand.observation.revision,
    inputFingerprint: demand.observation.inputFingerprint,
    observedAt: input.now,
    candidateTrace: cloneCandidateTrace(candidateTrace),
  };
}

function cloneRouteFact(
  route: SynthesisShadowRouteFact,
): SynthesisShadowRouteFact {
  return {
    sourceRoom: route.sourceRoom,
    targetRoom: route.targetRoom,
    resource: route.resource,
    amount: route.amount,
    actionAmount: route.actionAmount,
    priorityClass: route.priorityClass,
    coverage: route.coverage,
    capacity: route.capacity,
    predictedStagingEligibility: route.predictedStagingEligibility,
    terminalReadyAt: route.terminalReadyAt,
    transactionCost: route.transactionCost,
    requiredEnergy: route.requiredEnergy,
    energyCommitmentAmount: route.energyCommitmentAmount,
    terminalAllocatedAmount: route.terminalAllocatedAmount,
    stagingRequiredAmount: route.stagingRequiredAmount,
    terminalEnergyAllocatedAmount: route.terminalEnergyAllocatedAmount,
    feeStagingRequiredAmount: route.feeStagingRequiredAmount,
    stableKey: route.stableKey,
  };
}

function cloneDecision(
  decision: SynthesisShadowDecision,
): SynthesisShadowDecision {
  return {
    ...cloneRouteFact(decision),
    comparisonKey: decision.comparisonKey,
    demandKey: decision.demandKey,
    origin: decision.origin,
    inputRevision: decision.inputRevision,
    inputFingerprint: decision.inputFingerprint,
    observedAt: decision.observedAt,
    candidateTrace: cloneCandidateTrace(decision.candidateTrace),
  };
}

function cloneUnmatched(
  unmatched: SynthesisShadowUnmatchedDemand,
): SynthesisShadowUnmatchedDemand {
  return {
    comparisonKey: unmatched.comparisonKey,
    demandKey: unmatched.demandKey,
    origin: unmatched.origin,
    inputRevision: unmatched.inputRevision,
    inputFingerprint: unmatched.inputFingerprint,
    observedAt: unmatched.observedAt,
    targetRoom: unmatched.targetRoom,
    resource: unmatched.resource,
    uncoveredAmount: unmatched.uncoveredAmount,
    coverage: unmatched.coverage,
    capacity: unmatched.capacity,
    predictedStagingEligibility: unmatched.predictedStagingEligibility,
    reason: unmatched.reason,
    candidateTrace: cloneCandidateTrace(unmatched.candidateTrace),
  };
}

interface ContinuationValidationResult {
  projection: MutableProjection;
}

function routeFingerprintFields(route: SynthesisShadowRouteFact): unknown[] {
  return [
    route.sourceRoom,
    route.targetRoom,
    route.resource,
    route.amount,
    route.actionAmount,
    route.priorityClass,
    route.coverage,
    route.capacity,
    route.predictedStagingEligibility,
    route.terminalReadyAt,
    route.transactionCost,
    route.requiredEnergy,
    route.energyCommitmentAmount,
    route.terminalAllocatedAmount,
    route.stagingRequiredAmount,
    route.terminalEnergyAllocatedAmount,
    route.feeStagingRequiredAmount,
    route.stableKey,
  ];
}

function candidateTraceFingerprintFields(
  trace: SynthesisShadowCandidateTrace,
): unknown[] {
  return [
    trace.donorCount,
    trace.evaluatedCount,
    trace.feasibleCount,
    trace.rejectedCount,
    trace.selectedRejection || null,
    trace.rejectionCounts.map(([reason, count]) => [reason, count]),
    trace.topSourceRoom || null,
    trace.legacySource
      ? [
          trace.legacySource.sourceRoom,
          trace.legacySource.disposition,
          trace.legacySource.rejection || null,
        ]
      : null,
    trace.receiver.kind === "missing"
      ? ["missing"]
      : [
          "present",
          trace.receiver.receiverEligible,
          trace.receiver.storageHeadroom,
          trace.receiver.terminalHeadroom,
          trace.receiver.resourceHeadroom,
        ],
  ];
}

function hashBoundedCheckpoint(serialized: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${
    (right >>> 0).toString(16).padStart(8, "0")
  }`;
}

function computeContinuationFingerprint(
  continuation:
    | SynthesisShadowContinuation
    | Omit<SynthesisShadowContinuation, "checkpointFingerprint">,
): string | null {
  try {
    const serialized = JSON.stringify([
      continuation.schemaVersion,
      continuation.inputRevision,
      continuation.inputFingerprint,
      continuation.costModelRevision,
      continuation.expiresAt,
      continuation.nextDemandIndex,
      continuation.nextDonorIndex,
      continuation.nextDemandKey || null,
      continuation.nextSourceRoom || null,
      continuation.partialBest
        ? routeFingerprintFields(continuation.partialBest)
        : null,
      REJECTION_ORDER.map((reason) =>
        continuation.partialRejectionCounts[reason] || 0
      ),
      continuation.partialLegacySourceEvaluation
        ? [
            continuation.partialLegacySourceEvaluation.sourceRoom,
            continuation.partialLegacySourceEvaluation.outcome,
            continuation.partialLegacySourceEvaluation.rejection || null,
          ]
        : null,
      continuation.completedDecisions.map((decision) => [
        decision.comparisonKey,
        decision.demandKey,
        decision.origin,
        decision.inputRevision,
        decision.inputFingerprint,
        decision.observedAt,
        routeFingerprintFields(decision),
        candidateTraceFingerprintFields(decision.candidateTrace),
      ]),
      continuation.completedUnmatched.map((unmatched) => [
        unmatched.comparisonKey,
        unmatched.demandKey,
        unmatched.origin,
        unmatched.inputRevision,
        unmatched.inputFingerprint,
        unmatched.observedAt,
        unmatched.targetRoom,
        unmatched.resource,
        unmatched.uncoveredAmount,
        unmatched.coverage,
        unmatched.capacity,
        unmatched.predictedStagingEligibility,
        unmatched.reason,
        candidateTraceFingerprintFields(unmatched.candidateTrace),
      ]),
      continuation.residual.sources.map((source) => [
        source.roomName,
        source.actionEnergyBudget,
        source.terminalActionEnergyAmount,
        source.terminalStagingFreeCapacity,
        source.resources.map((resource) => [
          resource.resource,
          resource.availableAmount,
          resource.terminalAmount,
        ]),
      ]),
      continuation.residual.receivers.map((receiver) => [
        receiver.roomName,
        receiver.storageHeadroom,
        receiver.terminalHeadroom,
        receiver.resources.map((resource) => [
          resource.resource,
          resource.headroom,
        ]),
      ]),
      REJECTION_ORDER.map((reason) =>
        continuation.rejectionCounts[reason] || 0
      ),
      continuation.totalCandidateEvaluations,
      continuation.totalTransactionCostEvaluations,
    ]);
    return hashBoundedCheckpoint(serialized);
  } catch {
    return null;
  }
}

function isUnmatchedReason(value: unknown): value is SynthesisShadowUnmatchedReason {
  return value === "demand_already_covered" ||
    value === "no_donor" ||
    value === "donor_limit_exceeded" ||
    value === "malformed_input" ||
    value === "stale_intent" ||
    REJECTION_ORDER.includes(value as SynthesisShadowCandidateRejection);
}

function isCandidateRejection(
  value: unknown,
): value is SynthesisShadowCandidateRejection {
  return REJECTION_ORDER.includes(value as SynthesisShadowCandidateRejection);
}

function hasOnlyOwnKeys(
  value: object,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isPartialLegacySourceEvaluation(
  value: unknown,
): value is SynthesisShadowPartialLegacySourceEvaluation | undefined {
  if (value === undefined) return true;
  if (
    !value ||
    typeof value !== "object" ||
    !hasOnlyOwnKeys(value, ["sourceRoom", "outcome", "rejection"])
  ) {
    return false;
  }
  const evaluation = value as SynthesisShadowPartialLegacySourceEvaluation;
  if (
    !isBoundedString(evaluation.sourceRoom, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    (evaluation.outcome !== "feasible" && evaluation.outcome !== "rejected")
  ) {
    return false;
  }
  return evaluation.outcome === "rejected"
    ? isCandidateRejection(evaluation.rejection)
    : evaluation.rejection === undefined;
}

function readCandidateTraceRejectionCounts(
  trace: SynthesisShadowCandidateTrace,
): Partial<Record<SynthesisShadowCandidateRejection, number>> | null {
  if (
    !Array.isArray(trace.rejectionCounts) ||
    trace.rejectionCounts.length > REJECTION_ORDER.length
  ) {
    return null;
  }
  const counts: Partial<Record<SynthesisShadowCandidateRejection, number>> = {};
  let previousIndex = -1;
  for (const entry of trace.rejectionCounts) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [reason, count] = entry;
    const reasonIndex = REJECTION_ORDER.indexOf(reason);
    if (
      reasonIndex <= previousIndex ||
      !isPositiveSafeInteger(count)
    ) {
      return null;
    }
    counts[REJECTION_ORDER[reasonIndex]] = count;
    previousIndex = reasonIndex;
  }
  return counts;
}

function candidateTraceMatchesDemand(
  trace: SynthesisShadowCandidateTrace,
  completed: SynthesisShadowDecision | SynthesisShadowUnmatchedDemand,
  demand: PreparedDemand,
  donors: readonly SynthesisShadowRoomFact[],
  prepared: PreparedInput,
  projection: MutableProjection,
  legacy: SynthesisShadowLegacyDecisionObservation | undefined,
  skipsCandidates: boolean,
): boolean {
  if (
    !trace ||
    typeof trace !== "object" ||
    !hasOnlyOwnKeys(trace, [
      "donorCount",
      "evaluatedCount",
      "feasibleCount",
      "rejectedCount",
      "selectedRejection",
      "rejectionCounts",
      "topSourceRoom",
      "legacySource",
      "receiver",
    ]) ||
    !isNonNegativeSafeInteger(trace.donorCount) ||
    trace.donorCount !== donors.length ||
    !isNonNegativeSafeInteger(trace.evaluatedCount) ||
    trace.evaluatedCount > trace.donorCount ||
    !isNonNegativeSafeInteger(trace.feasibleCount) ||
    !isNonNegativeSafeInteger(trace.rejectedCount) ||
    trace.feasibleCount + trace.rejectedCount !== trace.evaluatedCount ||
    trace.evaluatedCount !== (skipsCandidates ? 0 : donors.length) ||
    (trace.selectedRejection !== undefined &&
      !isCandidateRejection(trace.selectedRejection)) ||
    (trace.topSourceRoom !== undefined &&
      !isBoundedString(trace.topSourceRoom, SYNTHESIS_SHADOW_MAX_NAME_LENGTH))
  ) {
    return false;
  }
  const rejectionCounts = readCandidateTraceRejectionCounts(trace);
  if (
    !rejectionCounts ||
    countRejections(rejectionCounts) !== trace.rejectedCount ||
    !trace.receiver ||
    typeof trace.receiver !== "object" ||
    !hasOnlyOwnKeys(
      trace.receiver,
      trace.receiver.kind === "missing"
        ? ["kind"]
        : [
            "kind",
            "receiverEligible",
            "storageHeadroom",
            "terminalHeadroom",
            "resourceHeadroom",
          ],
    ) ||
    JSON.stringify(trace.receiver) !==
      JSON.stringify(captureReceiverTrace(demand, prepared, projection))
  ) {
    return false;
  }

  const isDecision = "sourceRoom" in completed;
  if (isDecision) {
    if (
      trace.feasibleCount <= 0 ||
      trace.topSourceRoom !== completed.sourceRoom ||
      trace.selectedRejection !== undefined
    ) {
      return false;
    }
  } else {
    if (trace.feasibleCount !== 0 || trace.topSourceRoom !== undefined) {
      return false;
    }
    const expectedSelected = isCandidateRejection(completed.reason)
      ? completed.reason
      : undefined;
    if (trace.selectedRejection !== expectedSelected) return false;
    if (
      expectedSelected &&
      selectUnmatchedReason(rejectionCounts) !== expectedSelected
    ) {
      return false;
    }
  }

  const legacySource = trace.legacySource;
  if (!legacy || legacy.kind !== "route") {
    return legacySource === undefined;
  }
  if (
    !legacySource ||
    typeof legacySource !== "object" ||
    !hasOnlyOwnKeys(legacySource, [
      "sourceRoom",
      "disposition",
      "rejection",
    ]) ||
    legacySource.sourceRoom !== legacy.route.sourceRoom
  ) {
    return false;
  }
  const donorIndex = donors.findIndex(
    (donor) => donor.roomName === legacy.route.sourceRoom,
  );
  if (legacySource.disposition === "not_candidate") {
    return donorIndex < 0 && legacySource.rejection === undefined;
  }
  if (legacySource.disposition === "not_evaluated") {
    return donorIndex >= trace.evaluatedCount &&
      legacySource.rejection === undefined;
  }
  if (donorIndex < 0 || donorIndex >= trace.evaluatedCount) return false;
  if (legacySource.disposition === "selected") {
    return trace.topSourceRoom === legacySource.sourceRoom &&
      legacySource.rejection === undefined;
  }
  if (legacySource.disposition === "feasible_lower_rank") {
    return trace.feasibleCount >= 2 &&
      trace.topSourceRoom !== legacySource.sourceRoom &&
      legacySource.rejection === undefined;
  }
  return legacySource.disposition === "rejected" &&
    isCandidateRejection(legacySource.rejection) &&
    (rejectionCounts[legacySource.rejection] || 0) > 0;
}

function completedIdentityMatchesDemand(
  completed: SynthesisShadowDecision | SynthesisShadowUnmatchedDemand,
  demand: PreparedDemand,
): boolean {
  return isBoundedString(
    completed.comparisonKey,
    SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
  ) &&
    isBoundedString(completed.demandKey, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) &&
    isBoundedString(completed.inputRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) &&
    isBoundedString(
      completed.inputFingerprint,
      SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
    ) &&
    completed.comparisonKey === demand.observation.comparisonKey &&
    completed.demandKey === demand.observation.demandKey &&
    completed.origin === demand.observation.origin &&
    completed.inputRevision === demand.observation.revision &&
    completed.inputFingerprint === demand.observation.inputFingerprint &&
    isFiniteTick(completed.observedAt);
}

function unmatchedMatchesDemand(
  unmatched: SynthesisShadowUnmatchedDemand,
  demand: PreparedDemand,
): boolean {
  return completedIdentityMatchesDemand(unmatched, demand) &&
    isBoundedString(unmatched.targetRoom, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) &&
    isBoundedString(unmatched.resource, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) &&
    isBoundedString(unmatched.reason, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) &&
    unmatched.targetRoom === demand.observation.targetRoom &&
    unmatched.resource === demand.observation.resource &&
    unmatched.uncoveredAmount === demand.uncoveredAmount &&
    unmatched.coverage === demand.initialCoverage &&
    isCapacity(unmatched.capacity) &&
    isStagingEligibility(unmatched.predictedStagingEligibility) &&
    isUnmatchedReason(unmatched.reason);
}

function routeMatchesDemand(
  route: SynthesisShadowRouteFact,
  demand: PreparedDemand,
  donors: readonly SynthesisShadowRoomFact[],
): boolean {
  const source = donors.find((donor) => donor.roomName === route.sourceRoom);
  return !isRouteFactMalformed(route) &&
    !!source &&
    route.targetRoom === demand.observation.targetRoom &&
    route.resource === demand.observation.resource &&
    route.priorityClass === demand.observation.priorityClass &&
    route.amount <= demand.uncoveredAmount &&
    route.amount <= demand.observation.maximumBatchAmount &&
    route.amount >= demand.observation.minimumBatchAmount &&
    route.actionAmount === Math.min(route.amount, source.transferBatchSize) &&
    route.coverage ===
      (route.amount >= demand.uncoveredAmount ? "covered" : "partial") &&
    route.capacity === "eligible" &&
    route.predictedStagingEligibility === "eligible" &&
    route.terminalReadyAt === source.terminalReadyAt &&
    route.stableKey === createRouteStableKey(
      source.roomName,
      demand.observation.targetRoom,
      demand.observation.resource,
      demand.observation.comparisonKey,
    );
}

function validateContinuation(
  input: SynthesisShadowMatcherInput,
  prepared: PreparedInput,
  legacy: SynthesisShadowLegacyIndex,
  continuation: SynthesisShadowContinuation,
): ContinuationValidationResult | null {
  if (
    !Array.isArray(continuation.completedDecisions) ||
    !Array.isArray(continuation.completedUnmatched) ||
    !continuation.residual ||
    !Array.isArray(continuation.residual.sources) ||
    !Array.isArray(continuation.residual.receivers) ||
    continuation.schemaVersion !== 2 ||
    typeof continuation.checkpointFingerprint !== "string" ||
    continuation.checkpointFingerprint.length !== 16 ||
    !isBoundedString(
      continuation.inputRevision,
      SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
    ) ||
    !isBoundedString(
      continuation.inputFingerprint,
      SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
    ) ||
    !isBoundedString(
      continuation.costModelRevision,
      SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
    ) ||
    continuation.inputRevision !== input.inputRevision ||
    continuation.inputFingerprint !== input.inputFingerprint ||
    continuation.costModelRevision !== input.costModelRevision ||
    !isFiniteTick(continuation.expiresAt) ||
    input.now > continuation.expiresAt ||
    !Number.isSafeInteger(continuation.nextDemandIndex) ||
    continuation.nextDemandIndex < 0 ||
    continuation.nextDemandIndex >= prepared.demands.length ||
    !Number.isSafeInteger(continuation.nextDonorIndex) ||
    continuation.nextDonorIndex < 0 ||
    continuation.completedDecisions.length > SYNTHESIS_SHADOW_MAX_INTENTS ||
    continuation.completedUnmatched.length > SYNTHESIS_SHADOW_MAX_INTENTS ||
    !isNonNegativeSafeInteger(continuation.totalCandidateEvaluations) ||
    continuation.totalCandidateEvaluations >
      SYNTHESIS_SHADOW_MAX_CANDIDATE_PAIRS_PER_EPOCH ||
    !isNonNegativeSafeInteger(
      continuation.totalTransactionCostEvaluations,
    ) ||
    continuation.totalTransactionCostEvaluations >
      continuation.totalCandidateEvaluations *
        SYNTHESIS_SHADOW_MAX_TRANSACTION_COST_EVALUATIONS_PER_CANDIDATE ||
    !isRejectionCountMap(continuation.rejectionCounts) ||
    !isRejectionCountMap(continuation.partialRejectionCounts) ||
    !isPartialLegacySourceEvaluation(
      continuation.partialLegacySourceEvaluation,
    )
  ) {
    return null;
  }
  const nextDemand = prepared.demands[continuation.nextDemandIndex];
  if (
    !nextDemand ||
    !isBoundedString(
      continuation.nextDemandKey,
      SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
    ) ||
    !isBoundedString(
      continuation.nextSourceRoom,
      SYNTHESIS_SHADOW_MAX_NAME_LENGTH,
    ) ||
    continuation.nextDemandKey !== nextDemand.observation.comparisonKey
  ) {
    return null;
  }
  const donors = buildDonors(nextDemand, prepared);
  if (
    continuation.nextDonorIndex >= donors.length ||
    continuation.nextSourceRoom !== donors[continuation.nextDonorIndex]?.roomName ||
    continuation.completedDecisions.length +
      continuation.completedUnmatched.length !== continuation.nextDemandIndex
  ) {
    return null;
  }
  const completedByKey = new Map<
    string,
    SynthesisShadowDecision | SynthesisShadowUnmatchedDemand
  >();
  for (const completed of [
    ...continuation.completedDecisions,
    ...continuation.completedUnmatched,
  ]) {
    if (
      !isBoundedString(
        completed.comparisonKey,
        SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
      )
    ) {
      return null;
    }
    const demand = prepared.demands.find(
      (entry) => entry.observation.comparisonKey === completed.comparisonKey,
    );
    if (
      !demand ||
      completedByKey.has(completed.comparisonKey) ||
      !completedIdentityMatchesDemand(completed, demand) ||
      ("sourceRoom" in completed
        ? !routeMatchesDemand(
            completed,
            demand,
            buildDonors(demand, prepared),
          )
        : !unmatchedMatchesDemand(completed, demand))
    ) {
      return null;
    }
    completedByKey.set(completed.comparisonKey, completed);
  }
  for (let index = 0; index < continuation.nextDemandIndex; index += 1) {
    if (!completedByKey.has(prepared.demands[index].observation.comparisonKey)) {
      return null;
    }
  }
  const restored = restoreProjection(continuation.residual, prepared.rooms);
  if (!restored) return null;
  const replayed = createProjection(prepared.rooms);
  let expectedCandidateEvaluations = 0;

  for (let index = 0; index < continuation.nextDemandIndex; index += 1) {
    const demand = prepared.demands[index];
    const completed = completedByKey.get(demand.observation.comparisonKey)!;
    const demandDonors = buildDonors(demand, prepared);
    const isDecision = "sourceRoom" in completed;
    const knownNoCandidateReason = demand.malformed || demand.inputDrift
      ? "malformed_input"
      : demand.stale
        ? "stale_intent"
        : demand.uncoveredAmount <= 0
          ? "demand_already_covered"
          : demandDonors.length > SYNTHESIS_SHADOW_MAX_DONORS_PER_INTENT
            ? "donor_limit_exceeded"
            : undefined;
    if (
      knownNoCandidateReason !== undefined &&
      (isDecision ||
        (!("sourceRoom" in completed) &&
          completed.reason !== knownNoCandidateReason))
    ) {
      return null;
    }
    const skipsCandidates = knownNoCandidateReason !== undefined;
    if (!skipsCandidates) {
      if (demandDonors.length > SYNTHESIS_SHADOW_MAX_DONORS_PER_INTENT) {
        return null;
      }
      expectedCandidateEvaluations += demandDonors.length;
    }
    if (
      !candidateTraceMatchesDemand(
        completed.candidateTrace,
        completed,
        demand,
        demandDonors,
        prepared,
        replayed,
        legacy.index.get(demand.observation.comparisonKey),
        skipsCandidates,
      )
    ) {
      return null;
    }
    if ("sourceRoom" in completed && !applyRouteToProjection(completed, replayed)) {
      return null;
    }
  }

  expectedCandidateEvaluations += continuation.nextDonorIndex;
  if (
    continuation.partialBest &&
    !routeMatchesDemand(
      continuation.partialBest,
      nextDemand,
      donors.slice(0, continuation.nextDonorIndex),
    )
  ) {
    return null;
  }
  const nextLegacy = legacy.index.get(nextDemand.observation.comparisonKey);
  const nextLegacySource = nextLegacy?.kind === "route"
    ? nextLegacy.route.sourceRoom
    : undefined;
  const nextLegacyDonorIndex = nextLegacySource
    ? donors.findIndex((donor) => donor.roomName === nextLegacySource)
    : -1;
  const partialLegacySourceEvaluation =
    continuation.partialLegacySourceEvaluation;
  const partialLegacyEvaluationExpected =
    nextLegacyDonorIndex >= 0 &&
    nextLegacyDonorIndex < continuation.nextDonorIndex;
  if (
    partialLegacyEvaluationExpected !== !!partialLegacySourceEvaluation ||
    (partialLegacySourceEvaluation &&
      (partialLegacySourceEvaluation.sourceRoom !== nextLegacySource ||
        (partialLegacySourceEvaluation.outcome === "rejected" &&
          (!partialLegacySourceEvaluation.rejection ||
            (continuation.partialRejectionCounts[
              partialLegacySourceEvaluation.rejection
            ] || 0) <= 0)) ||
        (partialLegacySourceEvaluation.outcome === "feasible" &&
          !continuation.partialBest)))
  ) {
    return null;
  }
  if (
    expectedCandidateEvaluations !== continuation.totalCandidateEvaluations ||
    countRejections(continuation.partialRejectionCounts) >
      continuation.nextDonorIndex ||
    countRejections(continuation.rejectionCounts) >
      continuation.totalCandidateEvaluations ||
    !REJECTION_ORDER.every(
      (reason) =>
        (continuation.partialRejectionCounts[reason] || 0) <=
          (continuation.rejectionCounts[reason] || 0),
    ) ||
    !projectionsEqual(
      snapshotProjection(restored),
      snapshotProjection(replayed),
    ) ||
    computeContinuationFingerprint(continuation) !==
      continuation.checkpointFingerprint
  ) {
    return null;
  }
  return { projection: replayed };
}

function buildDonors(
  demand: PreparedDemand,
  prepared: PreparedInput,
): readonly SynthesisShadowRoomFact[] {
  return prepared.donorsByResource.get(demand.observation.resource) || [];
}

function isPriorityClass(value: string): value is SynthesisShadowPriorityClass {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, value);
}

function isCoverage(value: string): value is SynthesisShadowCoverage {
  return value === "covered" || value === "partial" || value === "none" || value === "unknown";
}

function isCapacity(value: string): value is SynthesisShadowCapacity {
  return value === "eligible" || value === "blocked" || value === "unknown";
}

function isStagingEligibility(
  value: string,
): value is SynthesisShadowPredictedStagingEligibility {
  return value === "eligible" || value === "blocked" || value === "unknown";
}

function isRouteFactCoreMalformed(
  route: SynthesisShadowRouteFact,
  allowZeroAction: boolean,
): boolean {
  if (
    !isBoundedString(route.sourceRoom, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    !isBoundedString(route.targetRoom, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    route.sourceRoom === route.targetRoom ||
    !isBoundedString(route.resource, SYNTHESIS_SHADOW_MAX_NAME_LENGTH) ||
    !isPositiveSafeInteger(route.amount) ||
    route.amount > SYNTHESIS_SHADOW_MAX_BATCH_AMOUNT ||
    (allowZeroAction
      ? !isNonNegativeSafeInteger(route.actionAmount)
      : !isPositiveSafeInteger(route.actionAmount)) ||
    route.actionAmount > route.amount ||
    !isPriorityClass(route.priorityClass) ||
    !isCoverage(route.coverage) ||
    !isCapacity(route.capacity) ||
    !isStagingEligibility(route.predictedStagingEligibility) ||
    !isFiniteTick(route.terminalReadyAt) ||
    !isNonNegativeSafeInteger(route.transactionCost) ||
    !isNonNegativeSafeInteger(route.requiredEnergy) ||
    !isNonNegativeSafeInteger(route.energyCommitmentAmount) ||
    !isNonNegativeSafeInteger(route.terminalAllocatedAmount) ||
    !isNonNegativeSafeInteger(route.stagingRequiredAmount) ||
    !isNonNegativeSafeInteger(route.terminalEnergyAllocatedAmount) ||
    !isNonNegativeSafeInteger(route.feeStagingRequiredAmount) ||
    route.terminalAllocatedAmount + route.stagingRequiredAmount !==
      route.actionAmount ||
    !isBoundedString(route.stableKey, SYNTHESIS_SHADOW_MAX_STABLE_KEY_LENGTH)
  ) {
    return true;
  }
  const expectedEnergy =
    route.transactionCost +
    (route.resource === RESOURCE_ENERGY ? route.actionAmount : 0);
  const expectedEnergyCommitment =
    route.transactionCost +
    (route.resource === RESOURCE_ENERGY ? route.amount : 0);
  const projectedEnergy =
    route.terminalEnergyAllocatedAmount +
    route.feeStagingRequiredAmount +
    (route.resource === RESOURCE_ENERGY ? route.stagingRequiredAmount : 0);
  return !Number.isSafeInteger(expectedEnergy) ||
    !Number.isSafeInteger(expectedEnergyCommitment) ||
    route.requiredEnergy !== expectedEnergy ||
    route.energyCommitmentAmount !== expectedEnergyCommitment ||
    projectedEnergy !== expectedEnergy;
}

/** Shadow decisions and continuation folds always represent standalone actions. */
function isRouteFactMalformed(route: SynthesisShadowRouteFact): boolean {
  return isRouteFactCoreMalformed(route, false);
}

function isLegacyRouteObservationMalformed(
  legacy: SynthesisShadowLegacyRouteObservation,
): boolean {
  const route = legacy.route;
  if (
    isRouteFactCoreMalformed(route, true) ||
    (legacy.actionBasis !== "standalone" &&
      legacy.actionBasis !== "merge_delta") ||
    !isNonNegativeSafeInteger(legacy.remainingBefore) ||
    !isPositiveSafeInteger(legacy.transferBatchSize) ||
    legacy.transferBatchSize > SYNTHESIS_SHADOW_MAX_BATCH_AMOUNT ||
    !Number.isSafeInteger(legacy.remainingBefore + route.amount) ||
    (legacy.actionBasis === "standalone" && legacy.remainingBefore !== 0) ||
    (legacy.actionBasis === "merge_delta" && legacy.remainingBefore <= 0)
  ) {
    return true;
  }
  const expectedActionAmount = legacy.actionBasis === "standalone"
    ? Math.min(route.amount, legacy.transferBatchSize)
    : Math.min(
        legacy.remainingBefore + route.amount,
        legacy.transferBatchSize,
      ) - Math.min(legacy.remainingBefore, legacy.transferBatchSize);
  if (route.actionAmount !== expectedActionAmount) return true;
  return route.actionAmount === 0 &&
    (route.transactionCost !== 0 ||
      route.requiredEnergy !== 0 ||
      route.terminalAllocatedAmount !== 0 ||
      route.stagingRequiredAmount !== 0 ||
      route.terminalEnergyAllocatedAmount !== 0 ||
      route.feeStagingRequiredAmount !== 0);
}

interface SynthesisShadowLegacyIndex {
  index: Map<string, SynthesisShadowLegacyDecisionObservation>;
  malformedKeys: Set<string>;
  globalMalformed: boolean;
}

function buildLegacyIndex(
  legacyDecisions: readonly SynthesisShadowLegacyDecisionObservation[],
): SynthesisShadowLegacyIndex {
  const index = new Map<string, SynthesisShadowLegacyDecisionObservation>();
  const malformedKeys = new Set<string>();
  let globalMalformed = legacyDecisions.length > SYNTHESIS_SHADOW_MAX_INTENTS;
  for (const legacy of legacyDecisions.slice(0, SYNTHESIS_SHADOW_MAX_INTENTS)) {
    if (!isBoundedString(legacy.comparisonKey, SYNTHESIS_SHADOW_MAX_KEY_LENGTH)) {
      globalMalformed = true;
      continue;
    }
    const duplicate = index.has(legacy.comparisonKey) ||
      malformedKeys.has(legacy.comparisonKey);
    const rawLegacy = legacy as unknown as Record<string, unknown>;
    let malformed =
      duplicate ||
      !isBoundedString(legacy.epochRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
      !isBoundedString(legacy.epochFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
      !isBoundedString(legacy.inputRevision, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
      !isBoundedString(legacy.inputFingerprint, SYNTHESIS_SHADOW_MAX_KEY_LENGTH) ||
      !isFiniteTick(legacy.observedAt) ||
      (rawLegacy.kind !== "route" && rawLegacy.kind !== "none");
    if (!malformed && legacy.kind === "route") {
      malformed =
        isLegacyRouteObservationMalformed(legacy) ||
        rawLegacy.blocker !== undefined ||
        rawLegacy.coverage !== undefined ||
        rawLegacy.capacity !== undefined ||
        rawLegacy.predictedStagingEligibility !== undefined;
    } else if (!malformed && legacy.kind === "none") {
      malformed =
        rawLegacy.route !== undefined ||
        rawLegacy.actionBasis !== undefined ||
        rawLegacy.remainingBefore !== undefined ||
        rawLegacy.transferBatchSize !== undefined ||
        !isUnmatchedReason(legacy.blocker) ||
        !isCoverage(legacy.coverage) ||
        !isCapacity(legacy.capacity) ||
        !isStagingEligibility(legacy.predictedStagingEligibility) ||
        !isBoundedString(legacy.blocker, SYNTHESIS_SHADOW_MAX_KEY_LENGTH);
    }
    if (malformed) {
      index.delete(legacy.comparisonKey);
      malformedKeys.add(legacy.comparisonKey);
      continue;
    }
    index.set(legacy.comparisonKey, legacy.kind === "route"
      ? {
          comparisonKey: legacy.comparisonKey,
          epochRevision: legacy.epochRevision,
          epochFingerprint: legacy.epochFingerprint,
          inputRevision: legacy.inputRevision,
          inputFingerprint: legacy.inputFingerprint,
          observedAt: legacy.observedAt,
          kind: "route",
          actionBasis: legacy.actionBasis,
          remainingBefore: legacy.remainingBefore,
          transferBatchSize: legacy.transferBatchSize,
          route: cloneRouteFact(legacy.route),
        }
      : {
          comparisonKey: legacy.comparisonKey,
          epochRevision: legacy.epochRevision,
          epochFingerprint: legacy.epochFingerprint,
          inputRevision: legacy.inputRevision,
          inputFingerprint: legacy.inputFingerprint,
          observedAt: legacy.observedAt,
          kind: "none",
          blocker: legacy.blocker,
          coverage: legacy.coverage,
          capacity: legacy.capacity,
          predictedStagingEligibility:
            legacy.predictedStagingEligibility,
        });
  }
  return { index, malformedKeys, globalMalformed };
}

function compareRoutes(
  legacy: SynthesisShadowRouteFact,
  shadow: SynthesisShadowRouteFact,
): SynthesisShadowDifference[] {
  const differences = new Set<SynthesisShadowDifference>();
  if (legacy.sourceRoom !== shadow.sourceRoom) differences.add("source");
  if (
    legacy.targetRoom !== shadow.targetRoom ||
    legacy.resource !== shadow.resource
  ) {
    differences.add("target");
  }
  if (
    legacy.amount !== shadow.amount ||
    legacy.actionAmount !== shadow.actionAmount
  ) {
    differences.add("amount");
  }
  if (legacy.priorityClass !== shadow.priorityClass) differences.add("priority");
  if (legacy.coverage !== shadow.coverage) differences.add("coverage");
  if (legacy.capacity !== shadow.capacity) differences.add("capacity");
  if (
    legacy.predictedStagingEligibility !== shadow.predictedStagingEligibility ||
    legacy.terminalAllocatedAmount !== shadow.terminalAllocatedAmount ||
    legacy.stagingRequiredAmount !== shadow.stagingRequiredAmount ||
    legacy.terminalEnergyAllocatedAmount !==
      shadow.terminalEnergyAllocatedAmount ||
    legacy.feeStagingRequiredAmount !== shadow.feeStagingRequiredAmount
  ) {
    differences.add("staging");
  }
  if (legacy.terminalReadyAt !== shadow.terminalReadyAt) {
    differences.add("ready");
  }
  if (
    legacy.transactionCost !== shadow.transactionCost ||
    legacy.requiredEnergy !== shadow.requiredEnergy ||
    legacy.energyCommitmentAmount !== shadow.energyCommitmentAmount
  ) {
    differences.add("cost");
  }
  return DIFFERENCE_ORDER.filter((difference) => differences.has(difference));
}

function routeHasUnknownComparisonFact(route: SynthesisShadowRouteFact): boolean {
  return route.coverage === "unknown" ||
    route.capacity === "unknown" ||
    route.predictedStagingEligibility === "unknown";
}

function classifyDifference(
  legacy: SynthesisShadowLegacyDecisionObservation,
  shadow: SynthesisShadowDecision | SynthesisShadowUnmatchedDemand,
): SynthesisShadowComparisonClassification {
  // An unmatched Shadow outcome proposes no action and therefore cannot be an
  // unsafe candidate. Its exact veto remains available in candidateTrace.
  if (!("sourceRoom" in shadow)) {
    return "expected_policy_difference";
  }
  const receiver = shadow.candidateTrace.receiver;
  const conflictsWithFrozenSafety =
    shadow.capacity !== "eligible" ||
    shadow.predictedStagingEligibility !== "eligible" ||
    receiver.kind !== "present" ||
    !receiver.receiverEligible ||
    receiver.storageHeadroom < shadow.amount ||
    receiver.terminalHeadroom < shadow.amount ||
    receiver.resourceHeadroom < shadow.amount;
  if (conflictsWithFrozenSafety) {
    return "unsafe_candidate";
  }
  if (legacy.kind === "none") return "legacy_unpaired";
  return "expected_policy_difference";
}

function buildComparisons(
  input: SynthesisShadowMatcherInput,
  prepared: PreparedInput,
  legacy: SynthesisShadowLegacyIndex,
  decisions: readonly SynthesisShadowDecision[],
  unmatched: readonly SynthesisShadowUnmatchedDemand[],
  complete: boolean,
  globalUnresolved?: SynthesisShadowUnresolvedReason,
): { samples: SynthesisShadowComparisonSample[]; total: number; equal: number; different: number; unresolved: number } {
  const decisionsByKey = new Map(decisions.map((entry) => [entry.comparisonKey, entry] as const));
  const unmatchedByKey = new Map(unmatched.map((entry) => [entry.comparisonKey, entry] as const));
  const samples: SynthesisShadowComparisonSample[] = [];
  let equal = 0;
  let different = 0;
  let unresolved = 0;

  for (const demand of prepared.demands) {
    const observation = demand.observation;
    const legacyDecision = legacy.index.get(observation.comparisonKey);
    const shadow = decisionsByKey.get(observation.comparisonKey) ||
      unmatchedByKey.get(observation.comparisonKey);
    let sample: SynthesisShadowComparisonSample;
    const base = {
      comparisonKey: observation.comparisonKey,
      demandKey: observation.demandKey,
      inputRevision: observation.revision,
      inputFingerprint: observation.inputFingerprint,
      legacyObservedAt: legacyDecision?.observedAt,
      shadowObservedAt: input.now,
      differences: [] as SynthesisShadowDifference[],
      ...(legacyDecision ? { legacy: legacyDecision } : {}),
      ...(shadow ? { shadow } : {}),
    };

    let unresolvedReason = globalUnresolved;
    if (
      !unresolvedReason &&
      (prepared.malformed ||
        demand.malformed ||
        legacy.globalMalformed ||
        legacy.malformedKeys.has(observation.comparisonKey))
    ) {
      unresolvedReason = "malformed_input";
    } else if (!unresolvedReason && prepared.inputLimitExceeded) {
      unresolvedReason = "input_limit_exceeded";
    } else if (!unresolvedReason && (prepared.inputDrift || demand.inputDrift)) {
      unresolvedReason = "input_drift";
    } else if (!unresolvedReason && demand.stale) {
      unresolvedReason = "stale_intent";
    } else if (
      !unresolvedReason &&
      legacyDecision &&
      (legacyDecision.epochRevision !== input.inputRevision ||
        legacyDecision.epochFingerprint !== input.inputFingerprint ||
        legacyDecision.inputRevision !== observation.revision ||
        legacyDecision.inputFingerprint !== observation.inputFingerprint)
    ) {
      unresolvedReason = "input_drift";
    } else if (!unresolvedReason && !legacyDecision) {
      unresolvedReason = "legacy_observation_missing";
    } else if (!unresolvedReason && (!complete || !shadow)) {
      unresolvedReason = "candidate_budget_exhausted";
    } else if (
      !unresolvedReason &&
      legacyDecision?.kind === "route" &&
      legacyDecision.route &&
      routeHasUnknownComparisonFact(legacyDecision.route)
    ) {
      unresolvedReason = "malformed_input";
    }

    if (unresolvedReason) {
      sample = {
        ...base,
        status: "unresolved",
        classification:
          unresolvedReason === "legacy_observation_missing"
            ? "legacy_unpaired"
            : "input_unavailable",
        unresolvedReason,
      };
      unresolved += 1;
    } else if (legacyDecision!.kind === "route" && "sourceRoom" in shadow!) {
      const differences = compareRoutes(legacyDecision!.route!, shadow!);
      sample = differences.length === 0
        ? { ...base, status: "equal", differences }
        : {
            ...base,
            status: "different",
            classification: classifyDifference(legacyDecision!, shadow!),
            differences,
          };
      if (differences.length === 0) equal += 1;
      else different += 1;
    } else if (legacyDecision!.kind === "none" && !("sourceRoom" in shadow!)) {
      const shadowUnmatched = shadow as SynthesisShadowUnmatchedDemand;
      const differences = new Set<SynthesisShadowDifference>();
      if (legacyDecision!.blocker !== shadowUnmatched.reason) {
        differences.add("blocker");
      }
      if (legacyDecision!.coverage !== shadowUnmatched.coverage) {
        differences.add("coverage");
      }
      if (legacyDecision!.capacity !== shadowUnmatched.capacity) {
        differences.add("capacity");
      }
      if (
        legacyDecision!.predictedStagingEligibility !==
        shadowUnmatched.predictedStagingEligibility
      ) {
        differences.add("staging");
      }
      const ordered = DIFFERENCE_ORDER.filter((difference) =>
        differences.has(difference),
      );
      if (ordered.length === 0) {
        sample = { ...base, status: "equal", differences: ordered };
        equal += 1;
      } else {
        sample = {
          ...base,
          status: "different",
          classification: classifyDifference(legacyDecision!, shadowUnmatched),
          differences: ordered,
        };
        different += 1;
      }
    } else {
      const difference: SynthesisShadowDifference =
        legacyDecision!.kind === "none" ? "legacy_missing" : "shadow_missing";
      sample = {
        ...base,
        status: "different",
        classification: classifyDifference(legacyDecision!, shadow!),
        differences: [difference],
      };
      different += 1;
    }
    // Matcher returns the full bounded set (<=32) so aggregate counts remain
    // lossless. Runtime/Monitor owns the separate 20-sample detail cap.
    samples.push(sample);
  }

  const dropped = Math.max(0, input.demands.length - prepared.demands.length);
  unresolved += dropped;
  return {
    samples,
    total: prepared.demands.length + dropped,
    equal,
    different,
    unresolved,
  };
}

function countRejections(
  counts: Partial<Record<SynthesisShadowCandidateRejection, number>>,
): number {
  return REJECTION_ORDER.reduce((total, reason) => total + (counts[reason] || 0), 0);
}

export function runSynthesisLogisticsShadow(
  input: SynthesisShadowMatcherInput,
): SynthesisShadowMatcherResult {
  const candidateBudget = normalizeCandidateBudget(input.candidateBudget);
  const prepared = prepareInput(input);
  const legacy = buildLegacyIndex(input.legacyDecisions || []);
  let projection = createProjection(prepared.rooms);
  let decisions: SynthesisShadowDecision[] = [];
  let unmatched: SynthesisShadowUnmatchedDemand[] = [];
  let rejectionCounts: Partial<Record<SynthesisShadowCandidateRejection, number>> = {};
  let totalCandidateEvaluations = 0;
  let transactionCostEvaluations = 0;
  let totalTransactionCostEvaluations = 0;
  let nextDemandIndex = 0;
  let nextDonorIndex = 0;
  let partialBest: SynthesisShadowRouteFact | undefined;
  let partialRejectionCounts: Partial<
    Record<SynthesisShadowCandidateRejection, number>
  > = {};
  let partialLegacySourceEvaluation:
    | SynthesisShadowPartialLegacySourceEvaluation
    | undefined;
  let continuationUsed = false;
  let continuationInvalidated = false;
  const globalInvalid =
    prepared.malformed || prepared.inputDrift || prepared.inputLimitExceeded;

  if (input.continuation) {
    const restored = globalInvalid
      ? null
      : validateContinuation(input, prepared, legacy, input.continuation);
    if (restored) {
      projection = restored.projection;
      decisions = input.continuation.completedDecisions.map(cloneDecision);
      unmatched = input.continuation.completedUnmatched.map(cloneUnmatched);
      rejectionCounts = cloneRejectionCounts(
        input.continuation.rejectionCounts,
      );
      totalCandidateEvaluations = input.continuation.totalCandidateEvaluations;
      totalTransactionCostEvaluations =
        input.continuation.totalTransactionCostEvaluations;
      nextDemandIndex = input.continuation.nextDemandIndex;
      nextDonorIndex = input.continuation.nextDonorIndex;
      partialBest = input.continuation.partialBest
        ? cloneRouteFact(input.continuation.partialBest)
        : undefined;
      partialRejectionCounts = cloneRejectionCounts(
        input.continuation.partialRejectionCounts,
      );
      partialLegacySourceEvaluation = clonePartialLegacySourceEvaluation(
        input.continuation.partialLegacySourceEvaluation,
      );
      continuationUsed = true;
    } else {
      continuationInvalidated = true;
    }
  }

  let candidateEvaluations = 0;
  let candidateBudgetExhausted = false;
  let donorLimitExceeded = false;
  let continuation: SynthesisShadowContinuation | undefined;

  if (!globalInvalid) {
    outer: for (
      let demandIndex = nextDemandIndex;
      demandIndex < prepared.demands.length;
      demandIndex += 1
    ) {
      const demand = prepared.demands[demandIndex];
      const donors = buildDonors(demand, prepared);
      const legacyDecision = legacy.index.get(
        demand.observation.comparisonKey,
      );
      const candidateTraceWithoutEvaluation = (
        reason?: SynthesisShadowCandidateRejection,
      ): SynthesisShadowCandidateTrace => buildCandidateTrace(
        demand,
        prepared,
        projection,
        donors,
        0,
        {},
        undefined,
        legacyDecision,
        undefined,
        reason,
      );
      if (demand.malformed) {
        unmatched.push(makeUnmatched(
          input,
          demand,
          "malformed_input",
          candidateTraceWithoutEvaluation(),
        ));
        nextDonorIndex = 0;
        partialBest = undefined;
        partialRejectionCounts = {};
        partialLegacySourceEvaluation = undefined;
        continue;
      }
      if (demand.stale) {
        unmatched.push(makeUnmatched(
          input,
          demand,
          "stale_intent",
          candidateTraceWithoutEvaluation(),
        ));
        nextDonorIndex = 0;
        partialBest = undefined;
        partialRejectionCounts = {};
        partialLegacySourceEvaluation = undefined;
        continue;
      }
      if (demand.uncoveredAmount <= 0) {
        unmatched.push(makeUnmatched(
          input,
          demand,
          "demand_already_covered",
          candidateTraceWithoutEvaluation(),
        ));
        nextDonorIndex = 0;
        partialBest = undefined;
        partialRejectionCounts = {};
        partialLegacySourceEvaluation = undefined;
        continue;
      }

      if (donors.length > SYNTHESIS_SHADOW_MAX_DONORS_PER_INTENT) {
        donorLimitExceeded = true;
        unmatched.push(makeUnmatched(
          input,
          demand,
          "donor_limit_exceeded",
          candidateTraceWithoutEvaluation(),
        ));
        nextDonorIndex = 0;
        partialBest = undefined;
        partialRejectionCounts = {};
        partialLegacySourceEvaluation = undefined;
        continue;
      }

      const localRejections: Partial<
        Record<SynthesisShadowCandidateRejection, number>
      > = demandIndex === nextDemandIndex
        ? cloneRejectionCounts(partialRejectionCounts)
        : {};
      for (
        let donorIndex = demandIndex === nextDemandIndex ? nextDonorIndex : 0;
        donorIndex < donors.length;
        donorIndex += 1
      ) {
        if (candidateEvaluations >= candidateBudget) {
          candidateBudgetExhausted = true;
          const checkpoint: Omit<
            SynthesisShadowContinuation,
            "checkpointFingerprint"
          > = {
            schemaVersion: 2,
            inputRevision: input.inputRevision,
            inputFingerprint: input.inputFingerprint,
            costModelRevision: input.costModelRevision,
            expiresAt: prepared.expiresAt,
            nextDemandIndex: demandIndex,
            nextDonorIndex: donorIndex,
            nextDemandKey: demand.observation.comparisonKey,
            nextSourceRoom: donors[donorIndex]?.roomName,
            ...(partialBest
              ? { partialBest: cloneRouteFact(partialBest) }
              : {}),
            partialRejectionCounts: cloneRejectionCounts(localRejections),
            ...(partialLegacySourceEvaluation
              ? {
                  partialLegacySourceEvaluation:
                    clonePartialLegacySourceEvaluation(
                      partialLegacySourceEvaluation,
                    )!,
                }
              : {}),
            completedDecisions: decisions.map(cloneDecision),
            completedUnmatched: unmatched.map(cloneUnmatched),
            residual: snapshotProjection(projection),
            rejectionCounts: cloneRejectionCounts(rejectionCounts),
            totalCandidateEvaluations,
            totalTransactionCostEvaluations,
          };
          const checkpointFingerprint = computeContinuationFingerprint(checkpoint);
          if (checkpointFingerprint) {
            continuation = { ...checkpoint, checkpointFingerprint };
          }
          break outer;
        }

        candidateEvaluations += 1;
        totalCandidateEvaluations += 1;
        const evaluated = evaluateCandidate(
          input,
          demand,
          donors[donorIndex],
          prepared.rooms.get(demand.observation.targetRoom),
          projection,
        );
        transactionCostEvaluations +=
          evaluated.transactionCostEvaluations || 0;
        totalTransactionCostEvaluations +=
          evaluated.transactionCostEvaluations || 0;
        if (evaluated.rejection) {
          incrementRejection(localRejections, evaluated.rejection);
          incrementRejection(rejectionCounts, evaluated.rejection);
          if (
            legacyDecision?.kind === "route" &&
            legacyDecision.route.sourceRoom === donors[donorIndex].roomName
          ) {
            partialLegacySourceEvaluation = {
              sourceRoom: donors[donorIndex].roomName,
              outcome: "rejected",
              rejection: evaluated.rejection,
            };
          }
          continue;
        }
        if (
          evaluated.route &&
          legacyDecision?.kind === "route" &&
          legacyDecision.route.sourceRoom === donors[donorIndex].roomName
        ) {
          partialLegacySourceEvaluation = {
            sourceRoom: donors[donorIndex].roomName,
            outcome: "feasible",
          };
        }
        if (
          evaluated.route &&
          (!partialBest ||
            compareRouteFacts(evaluated.route, partialBest, prepared.rooms) < 0)
        ) {
          partialBest = evaluated.route;
        }
      }

      if (candidateBudgetExhausted) break;
      if (partialBest) {
        const candidateTrace = buildCandidateTrace(
          demand,
          prepared,
          projection,
          donors,
          donors.length,
          localRejections,
          partialBest,
          legacyDecision,
          partialLegacySourceEvaluation,
        );
        if (!applyRouteToProjection(partialBest, projection)) {
          unmatched.push(makeUnmatched(
            input,
            demand,
            "malformed_input",
            candidateTrace,
          ));
        } else {
          decisions.push(makeDecision(
            input,
            demand,
            partialBest,
            candidateTrace,
          ));
        }
      } else {
        const selectedRejection = selectUnmatchedReason(localRejections);
        unmatched.push(
          makeUnmatched(
            input,
            demand,
            selectedRejection,
            buildCandidateTrace(
              demand,
              prepared,
              projection,
              donors,
              donors.length,
              localRejections,
              undefined,
              legacyDecision,
              partialLegacySourceEvaluation,
              isCandidateRejection(selectedRejection)
                ? selectedRejection
                : undefined,
            ),
          ),
        );
      }
      nextDonorIndex = 0;
      partialBest = undefined;
      partialRejectionCounts = {};
      partialLegacySourceEvaluation = undefined;
    }
  }

  const complete =
    !globalInvalid && !candidateBudgetExhausted && !donorLimitExceeded;
  const globalUnresolved = prepared.inputLimitExceeded
    ? "input_limit_exceeded" as const
    : donorLimitExceeded
      ? "input_limit_exceeded" as const
    : prepared.inputDrift
      ? "input_drift" as const
    : prepared.malformed
      ? "malformed_input" as const
      : candidateBudgetExhausted
        ? "candidate_budget_exhausted" as const
        : undefined;
  const comparisons = buildComparisons(
    input,
    prepared,
    legacy,
    complete ? decisions : [],
    complete ? unmatched : [],
    complete,
    globalUnresolved,
  );
  const metrics: SynthesisShadowMetrics = {
    intentCount: input.demands.length,
    processedIntentCount: prepared.demands.length,
    roomFactCount: input.rooms.length,
    candidateBudget,
    candidateEvaluations,
    totalCandidateEvaluations,
    transactionCostEvaluations,
    totalTransactionCostEvaluations,
    rejectedCandidateCount: countRejections(rejectionCounts),
    rejectionCounts: cloneRejectionCounts(rejectionCounts),
    decisionCount: complete ? decisions.length : 0,
    unmatchedCount: complete ? unmatched.length : 0,
    comparisonCount: comparisons.total,
    equalCount: comparisons.equal,
    differentCount: comparisons.different,
    unresolvedCount: comparisons.unresolved,
    continuationUsed,
    continuationInvalidated,
    candidateBudgetExhausted,
    inputLimitExceeded: prepared.inputLimitExceeded || donorLimitExceeded,
  };

  return {
    complete,
    inputRevision: isBoundedString(
      input.inputRevision,
      SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
    )
      ? input.inputRevision
      : "input_limit_exceeded",
    inputFingerprint: isBoundedString(
      input.inputFingerprint,
      SYNTHESIS_SHADOW_MAX_KEY_LENGTH,
    )
      ? input.inputFingerprint
      : "input_limit_exceeded",
    // Partial prefixes live only inside the continuation checkpoint.
    decisions: complete
      ? decisions.slice(0, SYNTHESIS_SHADOW_MAX_INTENTS)
      : [],
    unmatched: complete
      ? unmatched.slice(0, SYNTHESIS_SHADOW_MAX_INTENTS)
      : [],
    comparisons: comparisons.samples,
    ...(continuation ? { continuation } : {}),
    metrics,
  };
}
