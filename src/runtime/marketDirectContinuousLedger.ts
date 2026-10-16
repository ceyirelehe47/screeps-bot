import { AUTHORITY_ROOMS } from "@/config/deployment";
/**
 * Continuous Direct 的纯数据 WAL 与额度账本。
 *
 * 本模块不读取 Game/Memory，也不调用 Game.market.deal。调用方负责把返回的
 * 新 state 持久化，并且必须逐次持久化 `advanceContinuousWal` 的结果；这样
 * outcome -> receipt -> processed key -> pending delete 的每个 CPU-cut 前缀
 * 都能在下一 tick 被唯一恢复。
 */

import {
  canonicalStableHashV1,
  marketDirectContinuousEvidenceFingerprint,
} from "@/runtime/marketDirectContinuousPolicy";

export { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

export const CONTINUOUS_LEDGER_SCHEMA = 2 as const;
export const CONTINUOUS_RECEIPT_GENESIS =
  "market-direct-continuous:v2:receipt-genesis";
export const CONTINUOUS_PERMIT_GENESIS =
  "market-direct-continuous:v2:permit-genesis";
export const LEGACY_X_SEED_PERMIT_ID = "legacy-v1-reviewed-seed";
export const LEGACY_X_PROCESSED_EVIDENCE_KEY =
  "6a65f8e1656d080013d32210:6a65e025656d080013ccad03";
export const CONTINUOUS_ROLLING_WINDOW_TICKS = 30_000;
export const CONTINUOUS_PLANNED_AMOUNT = 1_000;
export const CONTINUOUS_CONFIRMED_COOLDOWN_TICKS = 1_000;
export const CONTINUOUS_FAILED_RETRY_TICKS = 100;
export const CONTINUOUS_RECEIPT_RING_LIMIT = 512;
export const CONTINUOUS_OUTCOME_RING_LIMIT = 50;
export const CONTINUOUS_PROCESSED_KEY_RING_LIMIT = 512;
export const CONTINUOUS_QUOTA_BATCH_LIMIT = 32;

export function continuousConfirmedCanaryCheckpointCommitment(
  input: {
    readonly prunedThroughSeq: number;
    readonly prunedHeadHash: string;
    readonly confirmedCanaries: Record<
      string,
      ContinuousConfirmedCanary
    >;
  },
): string {
  return canonicalStableHashV1({
    domain:
      "market-direct-continuous:confirmed-canary-checkpoint-v1",
    prunedThroughSeq: input.prunedThroughSeq,
    prunedHeadHash: input.prunedHeadHash,
    confirmedCanaries: input.confirmedCanaries,
  });
}

export const CONTINUOUS_CONFIRMED_CANARY_CHECKPOINT_GENESIS =
  continuousConfirmedCanaryCheckpointCommitment({
    prunedThroughSeq: 0,
    prunedHeadHash: CONTINUOUS_RECEIPT_GENESIS,
    confirmedCanaries: {},
  });

export type ContinuousTerminalStatus =
  | "confirmed"
  | "failed"
  | "not_filled";

export type ContinuousExecutionPolicy =
  | "legacy_canary_seed"
  | "canary"
  | "continuous";

export interface ContinuousAmountCounter {
  count: number;
  amount: number;
}

export interface ContinuousCounters {
  global: ContinuousAmountCounter;
  resources: Record<string, ContinuousAmountCounter>;
}

export interface ContinuousLedgerBlocker {
  code: string;
  detectedAt: number;
  detailHash: string;
}

export interface ContinuousQuotaSnapshot {
  tick: number;
  windowStartTick: number;
  resource: string;
  resourceLimit: number;
  globalLimit: number;
  resourceConfirmedActual: number;
  resourceUnmatchedPlanned: number;
  resourceRemaining: number;
  globalConfirmedActual: number;
  globalUnmatchedPlanned: number;
  globalRemaining: number;
  lastResourceConfirmedAt?: number;
  lastGlobalConfirmedAt?: number;
  confirmedCooldownNotBefore: number;
  retryNotBefore: number;
}

export interface ContinuousQuotaBatchRequest {
  resource: string;
  resourceLimit: number;
}

/**
 * deal 前第二次完整重验得到的物理与规划证据。该对象整体进入 pending
 * frozenEvidenceHash；WAL 对账只能按冻结值继续，不能用后续 planner 结果
 * 重解释既有 attempt。
 */
export interface ContinuousExecutionEvidence {
  observedOrderPriceMilli: number;
  observedOrderAmount: number;
  effectiveEnergyShadowPriceMilli: number;
  effectiveNetFloorMilli: number;
  worstCaseNetCreditsMilli: number;
  protectionRevision: number;
  planningFingerprint: string;
  planningEvidence: string;
  terminalResourceBefore: number;
  terminalEnergyBefore: number;
  terminalCooldownBefore: number;
  creditsBefore: number;
  outgoingTransactionKeysBefore: string[];
  outgoingWindowObservedAt: number;
  outgoingWindowOldestTime?: number;
  outgoingWindowNewestTime?: number;
  outgoingWindowCoversAttemptAt: boolean;
}

export interface ContinuousPendingAttempt {
  attemptSeq: number;
  executionPolicy: Exclude<
    ContinuousExecutionPolicy,
    "legacy_canary_seed"
  >;
  permitId: string;
  permitEpoch: number;
  entryId: string;
  resourcePolicyFingerprint: string;
  sellerRoom: string;
  resource: string;
  orderId: string;
  orderRoom: string;
  attemptAt: number;
  plannedAmount: typeof CONTINUOUS_PLANNED_AMOUNT;
  plannedTransactionEnergy: number;
  plannedNetCreditsMilli: number;
  evidenceKeyHint: string;
  executionEvidence: ContinuousExecutionEvidence;
  resourceQuota: ContinuousQuotaSnapshot;
  globalOpportunityReservation: {
    safeResources: string[];
    unmetOtherResources: Record<string, number>;
    admittedGlobalTotal: number;
  };
  frozenEvidenceHash: string;
}

export interface ContinuousOutcome {
  attemptSeq: number;
  status: ContinuousTerminalStatus;
  permitId: string;
  permitEpoch: number;
  entryId: string;
  resourcePolicyFingerprint: string;
  sellerRoom: string;
  resource: string;
  orderId: string;
  orderRoom: string;
  attemptAt: number;
  plannedAmount: typeof CONTINUOUS_PLANNED_AMOUNT;
  resolvedAt: number;
  evidenceKey: string;
  reason?: string;
  transactionId?: string;
  transactionTime?: number;
  actualAmount: number;
  actualTransactionEnergy?: number;
  actualNetCreditsMilli?: number;
  pendingEvidenceHash: string;
  outcomeEventHash?: string;
}

export interface ContinuousReceipt {
  attemptSeq: number;
  executionPolicy: ContinuousExecutionPolicy;
  status: ContinuousTerminalStatus;
  permitId: string;
  permitEpoch: number;
  entryId: string;
  resourcePolicyFingerprint: string;
  sellerRoom: string;
  resource: string;
  orderId: string;
  orderRoom: string;
  attemptAt: number;
  plannedAmount: number;
  resolvedAt: number;
  retentionTick: number;
  evidenceKey: string;
  reason?: string;
  transactionId?: string;
  transactionTime?: number;
  actualAmount: number;
  actualTransactionEnergy?: number;
  actualNetCreditsMilli?: number;
  outcomeEventHash: string;
  prevHash: string;
  eventHash: string;
  headHash: string;
}

export interface ContinuousProcessedEvidenceKey {
  attemptSeq: number;
  key: string;
}

/**
 * confirmed canary 的逐 entry 单调高水位。receipt 被裁剪后该摘要仍保留，
 * 使 lifecycle/permit 单字段回拨也不能获得第二次 canary 写权限。
 */
export interface ContinuousConfirmedCanary {
  entryId: string;
  attemptSeq: number;
  executionPolicy: "legacy_canary_seed" | "canary";
  evidenceKey: string;
  receiptEventHash: string;
  reviewedEvidenceDigest: string;
}

export interface ContinuousPruneCheckpoint {
  prunedThroughSeq: number;
  prunedHeadHash: string;
  confirmed: ContinuousCounters;
  confirmedCanaries: Record<string, ContinuousConfirmedCanary>;
  confirmedCanaryCommitment: string;
}

export interface ContinuousMigrationAttestation {
  migrationTick: number;
  legacyStateDigest: string;
  reviewedOutcomeDigest: string;
  seedReceiptEventHash: string;
  seedLedgerHead: string;
  attestationHash: string;
}

export interface MarketDirectContinuousLedger {
  schema: typeof CONTINUOUS_LEDGER_SCHEMA;
  coverageStartTick: number;
  receiptHeadHash: string;
  finalizedAttemptSeq: number;
  nextAttemptSeq: number;
  receipts: ContinuousReceipt[];
  outcomes: ContinuousOutcome[];
  processedEvidenceKeys: ContinuousProcessedEvidenceKey[];
  checkpoint: ContinuousPruneCheckpoint;
  lifetimeConfirmed: ContinuousCounters;
  confirmedCanaries: Record<string, ContinuousConfirmedCanary>;
  pending?: ContinuousPendingAttempt;
  retryNotBefore: number;
  permitEpochHighWater: number;
  permitChainHeadHighWater: string;
  migrationAttestation?: ContinuousMigrationAttestation;
  blocker?: ContinuousLedgerBlocker;
}

export interface ContinuousLedgerValidation {
  ok: boolean;
  blockerCode?: string;
  detail?: string;
  prefix?:
    | "idle"
    | "active_waiting_outcome"
    | "outcome_written"
    | "receipt_written"
    | "processed_key_written";
}

export interface LegacyV1SafeStateFixture {
  schema: 1;
  directConfirmedDealCount: 1;
  directPausedForReview: true;
  pendingCount: 0;
  quarantinedCount: 0;
  reconcileGapCount: 0;
}

export interface LegacyXReviewedOutcomeFixture {
  requestId: "direct:72585530:E6N59:X";
  transactionId: "6a65f8e1656d080013d32210";
  orderId: "6a65e025656d080013ccad03";
  evidenceKey: typeof LEGACY_X_PROCESSED_EVIDENCE_KEY;
  status: "confirmed";
  resolvedAt: 72_585_531;
  attemptAt: 72_585_530;
  transactionTime: 72_585_530;
  sellerRoom: typeof AUTHORITY_ROOMS.legacyXSeller;
  orderRoom: typeof AUTHORITY_ROOMS.legacyXBuyer;
  resource: "X";
  observedOrderAmount: 28_920;
  actualAmount: 1_000;
  plannedTransactionEnergy: 394;
  actualTransactionEnergy: 394;
  observedOrderPriceMilli: 694_963;
  plannedNetCreditsMilli: 682_331_360;
  actualNetCreditsMilli: 682_331_360;
  worstCaseNetCreditsMilli: 662_903;
  effectiveEnergyShadowPriceMilli: 32_060;
  energyShadowComponents: {
    hardFloor: 20;
    historyFloor: 31.276;
    ratchetFloor: 32.06;
  };
  protectionRevision: 72_585_530;
  pendingRecoveryFingerprint: "v1:bbb1de5ce52cb2d0";
  directSafetyFingerprint: string;
  canonicalOutcome: unknown;
}

export interface LegacyXGenesisInput {
  migrationTick: number;
  legacyState: LegacyV1SafeStateFixture;
  reviewedOutcome: LegacyXReviewedOutcomeFixture;
  expectedLegacyStateDigest: string;
  expectedReviewedOutcomeDigest: string;
}

export interface ContinuousLedgerOperation {
  state: MarketDirectContinuousLedger;
  ok: boolean;
  action:
    | "migrated"
    | "prepared"
    | "outcome_written"
    | "outcome_idempotent"
    | "receipt_written"
    | "processed_key_written"
    | "pending_deleted"
    | "waiting_for_outcome"
    | "idle"
    | "pruned"
    | "blocked";
  blockerCode?: string;
}

export interface PrepareContinuousAttemptInput {
  tick: number;
  executionPolicy: "canary" | "continuous";
  permitId: string;
  permitEpoch: number;
  entryId: string;
  resourcePolicyFingerprint: string;
  sellerRoom: string;
  resource: string;
  orderId: string;
  orderRoom: string;
  plannedAmount: typeof CONTINUOUS_PLANNED_AMOUNT;
  plannedTransactionEnergy: number;
  plannedNetCreditsMilli: number;
  evidenceKeyHint: string;
  executionEvidence: ContinuousExecutionEvidence;
  resourceLimit: number;
  globalLimit: number;
  safeOpportunityResources: ContinuousSafeOpportunity[];
}

export interface ContinuousSafeOpportunity {
  resource: string;
  resourceLimit: number;
  reserveAmount?: number;
}

export interface ContinuousOpportunityAdmission {
  resource: string;
  safe: boolean;
  resourceUsed: number;
  resourcePlanned: number;
  unmetOwnReserve: number;
  unmetOtherReserves: Record<string, number>;
  admittedGlobalTotal: number;
  admitted: boolean;
  reason?: "resource_quota" | "global_quota" | "cooldown" | "retry_backoff";
}

interface CanonicalObject {
  [key: string]: CanonicalValue;
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | CanonicalObject;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown, seen: unknown[]): CanonicalValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value as null | boolean | string;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical_non_finite_number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.includes(value)) throw new Error("canonical_cycle");
    seen.push(value);
    const result = value.map((entry) => canonicalize(entry, seen));
    seen.pop();
    return result;
  }
  if (isPlainObject(value)) {
    if (seen.includes(value)) throw new Error("canonical_cycle");
    seen.push(value);
    const result: CanonicalObject = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        const entry = value[key];
        if (
          entry === undefined ||
          typeof entry === "function" ||
          typeof entry === "symbol" ||
          typeof entry === "bigint"
        ) {
          throw new Error("canonical_unsupported_value");
        }
        result[key] = canonicalize(entry, seen);
      });
    seen.pop();
    return result;
  }
  throw new Error("canonical_unsupported_value");
}

export function canonicalStableStringifyV1(value: unknown): string {
  return JSON.stringify(canonicalize(value, []));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyCounter(): ContinuousAmountCounter {
  return { count: 0, amount: 0 };
}

function emptyCounters(): ContinuousCounters {
  return { global: emptyCounter(), resources: {} };
}

function resourceCounter(
  counters: ContinuousCounters,
  resource: string,
): ContinuousAmountCounter {
  return counters.resources[resource] || emptyCounter();
}

function addConfirmed(
  counters: ContinuousCounters,
  resource: string,
  amount: number,
): void {
  counters.global.count += 1;
  counters.global.amount += amount;
  const current = resourceCounter(counters, resource);
  counters.resources[resource] = {
    count: current.count + 1,
    amount: current.amount + amount,
  };
}

function counterEqual(
  left: ContinuousAmountCounter,
  right: ContinuousAmountCounter,
): boolean {
  return left.count === right.count && left.amount === right.amount;
}

function countersEqual(
  left: ContinuousCounters,
  right: ContinuousCounters,
): boolean {
  if (!counterEqual(left.global, right.global)) return false;
  const keys = Array.from(
    new Set([
      ...Object.keys(left.resources),
      ...Object.keys(right.resources),
    ]),
  ).sort();
  return keys.every((key) =>
    counterEqual(resourceCounter(left, key), resourceCounter(right, key)),
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function planningEvidenceFingerprint(evidence: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < evidence.length; index += 1) {
    hash ^= evidence.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `market-direct-continuous:plan:v1:${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")}:${evidence.length}`;
}

function executionEvidenceIsSane(
  evidence: unknown,
  attemptAt: number,
): evidence is ContinuousExecutionEvidence {
  if (!isPlainObject(evidence)) return false;
  const value = evidence as unknown as ContinuousExecutionEvidence;
  if (
    !isPositiveSafeInteger(value.observedOrderPriceMilli) ||
    !isPositiveSafeInteger(value.observedOrderAmount) ||
    value.observedOrderAmount < CONTINUOUS_PLANNED_AMOUNT ||
    !isNonNegativeSafeInteger(
      value.effectiveEnergyShadowPriceMilli,
    ) ||
    !isPositiveSafeInteger(value.effectiveNetFloorMilli) ||
    !Number.isSafeInteger(value.worstCaseNetCreditsMilli) ||
    value.worstCaseNetCreditsMilli <
      value.effectiveNetFloorMilli ||
    value.protectionRevision !== attemptAt ||
    typeof value.planningEvidence !== "string" ||
    value.planningEvidence.length === 0 ||
    value.planningFingerprint !==
      planningEvidenceFingerprint(value.planningEvidence) ||
    !isNonNegativeSafeInteger(value.terminalResourceBefore) ||
    value.terminalResourceBefore < CONTINUOUS_PLANNED_AMOUNT ||
    !isNonNegativeSafeInteger(value.terminalEnergyBefore) ||
    value.terminalCooldownBefore !== 0 ||
    !isNonNegativeFiniteNumber(value.creditsBefore) ||
    !Array.isArray(value.outgoingTransactionKeysBefore) ||
    value.outgoingWindowObservedAt !== attemptAt ||
    value.outgoingWindowCoversAttemptAt !== true
  ) {
    return false;
  }
  const transactionKeys = value.outgoingTransactionKeysBefore;
  if (
    transactionKeys.some(
      (key) => typeof key !== "string" || key.length === 0,
    ) ||
    new Set(transactionKeys).size !== transactionKeys.length
  ) {
    return false;
  }
  const oldest = value.outgoingWindowOldestTime;
  const newest = value.outgoingWindowNewestTime;
  if (
    (oldest !== undefined &&
      (!isNonNegativeSafeInteger(oldest) || oldest > attemptAt)) ||
    (newest !== undefined &&
      (!isNonNegativeSafeInteger(newest) || newest > attemptAt)) ||
    (oldest !== undefined &&
      newest !== undefined &&
      oldest > newest)
  ) {
    return false;
  }
  return true;
}

function receiptPayload(
  receipt: Omit<ContinuousReceipt, "prevHash" | "eventHash" | "headHash">,
): unknown {
  return {
    domain: "market-direct-continuous:receipt-v2",
    attemptSeq: receipt.attemptSeq,
    executionPolicy: receipt.executionPolicy,
    status: receipt.status,
    permitId: receipt.permitId,
    permitEpoch: receipt.permitEpoch,
    entryId: receipt.entryId,
    resourcePolicyFingerprint: receipt.resourcePolicyFingerprint,
    sellerRoom: receipt.sellerRoom,
    resource: receipt.resource,
    orderId: receipt.orderId,
    orderRoom: receipt.orderRoom,
    attemptAt: receipt.attemptAt,
    plannedAmount: receipt.plannedAmount,
    resolvedAt: receipt.resolvedAt,
    retentionTick: receipt.retentionTick,
    evidenceKey: receipt.evidenceKey,
    reason: receipt.reason ?? null,
    transactionId: receipt.transactionId ?? null,
    transactionTime: receipt.transactionTime ?? null,
    actualAmount: receipt.actualAmount,
    actualTransactionEnergy: receipt.actualTransactionEnergy ?? null,
    actualNetCreditsMilli: receipt.actualNetCreditsMilli ?? null,
    outcomeEventHash: receipt.outcomeEventHash,
  };
}

function receiptHeadHash(prevHash: string, eventHash: string): string {
  return canonicalStableHashV1({
    domain: "receipt-head-v2",
    prevHash,
    eventHash,
  });
}

function withReceiptHashes(
  receipt: Omit<ContinuousReceipt, "prevHash" | "eventHash" | "headHash">,
  prevHash: string,
): ContinuousReceipt {
  const eventHash = canonicalStableHashV1(receiptPayload(receipt));
  return {
    ...receipt,
    prevHash,
    eventHash,
    headHash: receiptHeadHash(prevHash, eventHash),
  };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalStableStringifyV1(left) === canonicalStableStringifyV1(right);
  } catch {
    return false;
  }
}

function outcomePayload(
  outcome: Omit<ContinuousOutcome, "outcomeEventHash">,
): unknown {
  return {
    domain: "market-direct-continuous:outcome-v2",
    attemptSeq: outcome.attemptSeq,
    status: outcome.status,
    permitId: outcome.permitId,
    permitEpoch: outcome.permitEpoch,
    entryId: outcome.entryId,
    resourcePolicyFingerprint:
      outcome.resourcePolicyFingerprint,
    sellerRoom: outcome.sellerRoom,
    resource: outcome.resource,
    orderId: outcome.orderId,
    orderRoom: outcome.orderRoom,
    attemptAt: outcome.attemptAt,
    plannedAmount: outcome.plannedAmount,
    resolvedAt: outcome.resolvedAt,
    evidenceKey: outcome.evidenceKey,
    reason: outcome.reason ?? null,
    transactionId: outcome.transactionId ?? null,
    transactionTime: outcome.transactionTime ?? null,
    actualAmount: outcome.actualAmount,
    actualTransactionEnergy:
      outcome.actualTransactionEnergy ?? null,
    actualNetCreditsMilli:
      outcome.actualNetCreditsMilli ?? null,
    pendingEvidenceHash: outcome.pendingEvidenceHash,
  };
}

function normalizedOutcome(
  outcome: ContinuousOutcome,
): ContinuousOutcome {
  const copy = clone(outcome);
  delete copy.outcomeEventHash;
  return {
    ...copy,
    outcomeEventHash: canonicalStableHashV1(
      outcomePayload(copy),
    ),
  };
}

export function sealContinuousOutcome(
  outcome: ContinuousOutcome,
): ContinuousOutcome {
  return normalizedOutcome(outcome);
}

function outcomeEventHashIsValid(
  outcome: ContinuousOutcome,
): boolean {
  return (
    typeof outcome.outcomeEventHash === "string" &&
    outcome.outcomeEventHash.length > 0 &&
    normalizedOutcome(outcome).outcomeEventHash ===
      outcome.outcomeEventHash
  );
}

function pendingFrozenPayload(
  pending: Omit<ContinuousPendingAttempt, "frozenEvidenceHash">,
): unknown {
  return {
    domain: "market-direct-continuous:pending-v2",
    ...pending,
  };
}

function matchesPending(
  pending: ContinuousPendingAttempt,
  outcome: ContinuousOutcome,
): boolean {
  return (
    outcome.attemptSeq === pending.attemptSeq &&
    outcome.permitId === pending.permitId &&
    outcome.permitEpoch === pending.permitEpoch &&
    outcome.entryId === pending.entryId &&
    outcome.resourcePolicyFingerprint ===
      pending.resourcePolicyFingerprint &&
    outcome.sellerRoom === pending.sellerRoom &&
    outcome.resource === pending.resource &&
    outcome.orderId === pending.orderId &&
    outcome.orderRoom === pending.orderRoom &&
    outcome.attemptAt === pending.attemptAt &&
    outcome.plannedAmount === pending.plannedAmount &&
    outcome.pendingEvidenceHash === pending.frozenEvidenceHash
  );
}

function outcomeIsTerminalAndSane(outcome: ContinuousOutcome): boolean {
  if (
    !isPositiveSafeInteger(outcome.attemptSeq) ||
    !isNonNegativeSafeInteger(outcome.attemptAt) ||
    !isNonNegativeSafeInteger(outcome.resolvedAt) ||
    outcome.resolvedAt < outcome.attemptAt ||
    outcome.plannedAmount !== CONTINUOUS_PLANNED_AMOUNT ||
    !outcome.evidenceKey
  ) {
    return false;
  }
  if (outcome.status === "confirmed") {
    return (
      !!outcome.transactionId &&
      isNonNegativeSafeInteger(outcome.transactionTime) &&
      outcome.transactionTime >= outcome.attemptAt &&
      outcome.transactionTime <= outcome.resolvedAt &&
      isPositiveSafeInteger(outcome.actualAmount) &&
      outcome.actualAmount <= outcome.plannedAmount &&
      isNonNegativeSafeInteger(outcome.actualTransactionEnergy) &&
      typeof outcome.actualNetCreditsMilli === "number" &&
      Number.isSafeInteger(outcome.actualNetCreditsMilli)
    );
  }
  return (
    outcome.transactionId === undefined &&
    outcome.transactionTime === undefined &&
    outcome.actualAmount === 0 &&
    outcome.actualTransactionEnergy === undefined &&
    outcome.actualNetCreditsMilli === undefined
  );
}

function receiptIsSane(receipt: ContinuousReceipt): boolean {
  if (
    !isPositiveSafeInteger(receipt.attemptSeq) ||
    !isNonNegativeSafeInteger(receipt.attemptAt) ||
    !isNonNegativeSafeInteger(receipt.resolvedAt) ||
    receipt.resolvedAt < receipt.attemptAt ||
    receipt.plannedAmount !== CONTINUOUS_PLANNED_AMOUNT ||
    !receipt.evidenceKey ||
    typeof receipt.outcomeEventHash !== "string" ||
    receipt.outcomeEventHash.length === 0
  ) {
    return false;
  }
  if (receipt.status === "confirmed") {
    return (
      !!receipt.transactionId &&
      isNonNegativeSafeInteger(receipt.transactionTime) &&
      receipt.transactionTime >= receipt.attemptAt &&
      receipt.transactionTime <= receipt.resolvedAt &&
      receipt.retentionTick === receipt.transactionTime &&
      isPositiveSafeInteger(receipt.actualAmount) &&
      receipt.actualAmount <= receipt.plannedAmount &&
      isNonNegativeSafeInteger(receipt.actualTransactionEnergy) &&
      typeof receipt.actualNetCreditsMilli === "number" &&
      Number.isSafeInteger(receipt.actualNetCreditsMilli)
    );
  }
  return (
    receipt.transactionId === undefined &&
    receipt.transactionTime === undefined &&
    receipt.retentionTick === receipt.resolvedAt &&
    receipt.actualAmount === 0 &&
    receipt.actualTransactionEnergy === undefined &&
    receipt.actualNetCreditsMilli === undefined
  );
}

function outcomeForAttempt(
  state: MarketDirectContinuousLedger,
  attemptSeq: number,
): ContinuousOutcome | undefined {
  const matches = state.outcomes.filter(
    (outcome) => outcome.attemptSeq === attemptSeq,
  );
  if (matches.length !== 1) return undefined;
  return matches[0];
}

function receiptForAttempt(
  state: MarketDirectContinuousLedger,
  attemptSeq: number,
): ContinuousReceipt | undefined {
  return state.receipts.find(
    (receipt) => receipt.attemptSeq === attemptSeq,
  );
}

function processedForAttempt(
  state: MarketDirectContinuousLedger,
  attemptSeq: number,
  evidenceKey: string,
): boolean {
  return state.processedEvidenceKeys.some(
    (entry) =>
      entry.attemptSeq === attemptSeq && entry.key === evidenceKey,
  );
}

function operationBlocked(
  state: MarketDirectContinuousLedger,
  tick: number,
  code: string,
  detail: unknown,
): ContinuousLedgerOperation {
  const next = clone(state);
  if (!next.blocker) {
    let safeDetail: unknown;
    try {
      const serialized = JSON.stringify(detail);
      safeDetail =
        serialized === undefined
          ? null
          : JSON.parse(serialized);
    } catch {
      safeDetail = {
        unserializable: true,
        valueType:
          detail === null ? "null" : typeof detail,
      };
    }
    next.blocker = {
      code,
      detectedAt: tick,
      detailHash: canonicalStableHashV1({
        domain: "market-direct-continuous:blocker-v2",
        code,
        detail: safeDetail,
      }),
    };
  }
  return {
    state: next,
    ok: false,
    action: "blocked",
    blockerCode: next.blocker.code,
  };
}

function validationFailure(
  blockerCode: string,
  detail: string,
): ContinuousLedgerValidation {
  return { ok: false, blockerCode, detail };
}

function validateCounters(
  value: ContinuousCounters,
): boolean {
  if (
    !value ||
    !isNonNegativeSafeInteger(value.global?.count) ||
    !isNonNegativeSafeInteger(value.global?.amount) ||
    !isPlainObject(value.resources)
  ) {
    return false;
  }
  return Object.keys(value.resources).every((resource) => {
    const counter = value.resources[resource];
    return (
      !!resource &&
      !!counter &&
      isNonNegativeSafeInteger(counter.count) &&
      isNonNegativeSafeInteger(counter.amount)
    );
  });
}

function confirmedCanaryFromReceipt(
  receipt: ContinuousReceipt,
): ContinuousConfirmedCanary | undefined {
  if (
    receipt.status !== "confirmed" ||
    (receipt.executionPolicy !== "canary" &&
      receipt.executionPolicy !== "legacy_canary_seed")
  ) {
    return undefined;
  }
  const unhashed = clone(receipt) as Partial<ContinuousReceipt>;
  delete unhashed.prevHash;
  delete unhashed.eventHash;
  delete unhashed.headHash;
  return {
    entryId: receipt.entryId,
    attemptSeq: receipt.attemptSeq,
    executionPolicy: receipt.executionPolicy,
    evidenceKey: receipt.evidenceKey,
    receiptEventHash: receipt.eventHash,
    reviewedEvidenceDigest:
      marketDirectContinuousEvidenceFingerprint(
        receiptPayload(
          unhashed as Omit<
            ContinuousReceipt,
            "prevHash" | "eventHash" | "headHash"
          >,
        ),
      ),
  };
}

function validateConfirmedCanaryMap(
  value: unknown,
  maxAttemptSeq?: number,
): value is Record<string, ContinuousConfirmedCanary> {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([entryId, confirmation]) => {
    if (!isPlainObject(confirmation)) return false;
    const typed =
      confirmation as unknown as ContinuousConfirmedCanary;
    return (
      entryId.length > 0 &&
      typed.entryId === entryId &&
      isPositiveSafeInteger(typed.attemptSeq) &&
      (maxAttemptSeq === undefined ||
        typed.attemptSeq <= maxAttemptSeq) &&
      typeof typed.evidenceKey === "string" &&
      typed.evidenceKey.length > 0 &&
      (typed.executionPolicy === "canary" ||
        typed.executionPolicy === "legacy_canary_seed") &&
      typeof typed.receiptEventHash === "string" &&
      typed.receiptEventHash.length > 0 &&
      typeof typed.reviewedEvidenceDigest === "string" &&
      typed.reviewedEvidenceDigest.length > 0
    );
  });
}

/**
 * 校验完整 hash chain、checkpoint、lifetime、coverage 和三种合法
 * attemptSeq 前缀。任何不合法组合都应由调用方通过
 * `failClosedContinuousLedger` 固化 blocker。
 */
export function validateContinuousLedger(
  value: unknown,
  tick?: number,
): ContinuousLedgerValidation {
  if (!isPlainObject(value)) {
    return validationFailure("direct_ledger_invalid", "not_object");
  }
  const state = value as unknown as MarketDirectContinuousLedger;
  if (
    state.schema !== CONTINUOUS_LEDGER_SCHEMA ||
    !isNonNegativeSafeInteger(state.coverageStartTick) ||
    !isNonNegativeSafeInteger(state.finalizedAttemptSeq) ||
    !isPositiveSafeInteger(state.nextAttemptSeq) ||
    !Array.isArray(state.receipts) ||
    !Array.isArray(state.outcomes) ||
    !Array.isArray(state.processedEvidenceKeys) ||
    !state.checkpoint ||
    !validateCounters(state.checkpoint.confirmed) ||
    !validateConfirmedCanaryMap(
      state.checkpoint.confirmedCanaries,
      state.checkpoint.prunedThroughSeq,
    ) ||
    typeof state.checkpoint.confirmedCanaryCommitment !==
      "string" ||
    !validateCounters(state.lifetimeConfirmed) ||
    !validateConfirmedCanaryMap(state.confirmedCanaries) ||
    !isNonNegativeSafeInteger(state.checkpoint.prunedThroughSeq) ||
    typeof state.checkpoint.prunedHeadHash !== "string" ||
    typeof state.receiptHeadHash !== "string" ||
    !isNonNegativeSafeInteger(state.retryNotBefore) ||
    !isNonNegativeSafeInteger(state.permitEpochHighWater) ||
    typeof state.permitChainHeadHighWater !== "string"
  ) {
    return validationFailure("direct_ledger_invalid", "shape");
  }
  if (
    state.checkpoint.confirmedCanaryCommitment !==
    continuousConfirmedCanaryCheckpointCommitment(
      state.checkpoint,
    )
  ) {
    return validationFailure(
      "direct_canary_checkpoint_commitment_mismatch",
      "checkpoint_canary_high_water",
    );
  }
  if (
    tick !== undefined &&
    (!isNonNegativeSafeInteger(tick) ||
      state.coverageStartTick >
        Math.max(0, tick - CONTINUOUS_ROLLING_WINDOW_TICKS + 1))
  ) {
    return validationFailure(
      "direct_ledger_coverage_gap",
      "rolling_window_not_covered",
    );
  }
  if (state.receipts.length > CONTINUOUS_RECEIPT_RING_LIMIT) {
    return validationFailure(
      "direct_receipt_ring_overflow",
      "more_than_512_receipts",
    );
  }
  if (
    state.outcomes.length > CONTINUOUS_OUTCOME_RING_LIMIT ||
    state.processedEvidenceKeys.length >
      CONTINUOUS_PROCESSED_KEY_RING_LIMIT
  ) {
    return validationFailure("direct_bounded_ring_overflow", "ring_limit");
  }

  let expectedSeq = state.checkpoint.prunedThroughSeq + 1;
  let expectedPrevHash = state.checkpoint.prunedHeadHash;
  let priorAttemptAt = -1;
  const retainedConfirmed = emptyCounters();
  const expectedConfirmedCanaries = clone(
    state.checkpoint.confirmedCanaries,
  );
  const seenEvidence = new Set<string>();
  const receiptsBySeq = new Map<number, ContinuousReceipt>();
  for (const receipt of state.receipts) {
    if (!receiptIsSane(receipt)) {
      return validationFailure("direct_receipt_invalid", "terminal_fields");
    }
    if (
      receipt.attemptSeq !== expectedSeq ||
      receipt.prevHash !== expectedPrevHash ||
      receipt.attemptAt < priorAttemptAt
    ) {
      return validationFailure("direct_receipt_chain_gap", "seq_or_prev");
    }
    const unhashed = clone(receipt) as Partial<ContinuousReceipt>;
    delete unhashed.prevHash;
    delete unhashed.eventHash;
    delete unhashed.headHash;
    const expectedEventHash = canonicalStableHashV1(
      receiptPayload(
        unhashed as Omit<
          ContinuousReceipt,
          "prevHash" | "eventHash" | "headHash"
        >,
      ),
    );
    const expectedHeadHash = receiptHeadHash(
      receipt.prevHash,
      expectedEventHash,
    );
    if (
      receipt.eventHash !== expectedEventHash ||
      receipt.headHash !== expectedHeadHash
    ) {
      return validationFailure("direct_receipt_hash_mismatch", "hash");
    }
    if (seenEvidence.has(receipt.evidenceKey)) {
      return validationFailure(
        "direct_receipt_evidence_conflict",
        "duplicate_evidence",
      );
    }
    seenEvidence.add(receipt.evidenceKey);
    receiptsBySeq.set(receipt.attemptSeq, receipt);
    const confirmedCanary =
      confirmedCanaryFromReceipt(receipt);
    if (confirmedCanary) {
      if (
        expectedConfirmedCanaries[
          confirmedCanary.entryId
        ]
      ) {
        return validationFailure(
          "direct_canary_confirmation_conflict",
          "duplicate_entry_canary",
        );
      }
      expectedConfirmedCanaries[
        confirmedCanary.entryId
      ] = confirmedCanary;
    }
    if (receipt.status === "confirmed") {
      addConfirmed(
        retainedConfirmed,
        receipt.resource,
        receipt.actualAmount,
      );
    }
    expectedSeq += 1;
    expectedPrevHash = receipt.headHash;
    priorAttemptAt = receipt.attemptAt;
  }
  const lastFinalized = expectedSeq - 1;
  if (
    lastFinalized !== state.finalizedAttemptSeq ||
    expectedPrevHash !== state.receiptHeadHash
  ) {
    return validationFailure(
      "direct_receipt_chain_tip_mismatch",
      "finalized_or_head",
    );
  }
  const expectedLifetime = clone(state.checkpoint.confirmed);
  expectedLifetime.global.count += retainedConfirmed.global.count;
  expectedLifetime.global.amount += retainedConfirmed.global.amount;
  Object.keys(retainedConfirmed.resources).forEach((resource) => {
    const checkpointCounter = resourceCounter(expectedLifetime, resource);
    const retainedCounter = retainedConfirmed.resources[resource];
    expectedLifetime.resources[resource] = {
      count: checkpointCounter.count + retainedCounter.count,
      amount: checkpointCounter.amount + retainedCounter.amount,
    };
  });
  if (!countersEqual(expectedLifetime, state.lifetimeConfirmed)) {
    return validationFailure(
      "direct_lifetime_counter_mismatch",
      "checkpoint_plus_ring",
    );
  }
  if (
    !sameCanonical(
      expectedConfirmedCanaries,
      state.confirmedCanaries,
    )
  ) {
    return validationFailure(
      "direct_canary_confirmation_mismatch",
      "checkpoint_plus_ring",
    );
  }

  const processedSeq = new Map<number, string>();
  const processedKey = new Map<string, number>();
  for (const entry of state.processedEvidenceKeys) {
    if (
      !isPositiveSafeInteger(entry?.attemptSeq) ||
      !entry.key ||
      processedSeq.has(entry.attemptSeq) ||
      processedKey.has(entry.key) ||
      entry.attemptSeq > state.finalizedAttemptSeq
    ) {
      return validationFailure(
        "direct_processed_key_conflict",
        "duplicate_or_future",
      );
    }
    processedSeq.set(entry.attemptSeq, entry.key);
    processedKey.set(entry.key, entry.attemptSeq);
    const retained = receiptsBySeq.get(entry.attemptSeq);
    if (retained && retained.evidenceKey !== entry.key) {
      return validationFailure(
        "direct_processed_key_conflict",
        "receipt_key_mismatch",
      );
    }
  }
  const outcomesBySeq = new Map<number, ContinuousOutcome>();
  for (const outcome of state.outcomes) {
    if (
      !outcomeIsTerminalAndSane(outcome) ||
      !outcomeEventHashIsValid(outcome) ||
      outcomesBySeq.has(outcome.attemptSeq)
    ) {
      return validationFailure(
        "direct_outcome_conflict",
        "invalid_or_duplicate_seq",
      );
    }
    outcomesBySeq.set(outcome.attemptSeq, outcome);
    const receipt = receiptsBySeq.get(outcome.attemptSeq);
    if (
      receipt &&
      (receipt.evidenceKey !== outcome.evidenceKey ||
        receipt.status !== outcome.status ||
        receipt.actualAmount !== outcome.actualAmount ||
        receipt.outcomeEventHash !==
          outcome.outcomeEventHash)
    ) {
      return validationFailure(
        "direct_outcome_receipt_conflict",
        "terminal_mismatch",
      );
    }
  }

  const latestReceipt =
    state.receipts[state.receipts.length - 1];
  const latestProcessed =
    !latestReceipt ||
    processedForAttempt(
      state,
      latestReceipt.attemptSeq,
      latestReceipt.evidenceKey,
    );
  if (!state.pending) {
    if (
      state.nextAttemptSeq !== state.finalizedAttemptSeq + 1 ||
      !latestProcessed
    ) {
      return validationFailure(
        "direct_attempt_sequence_gap",
        "idle_prefix",
      );
    }
    return { ok: true, prefix: "idle" };
  }

  const pending = state.pending;
  if (
    !isPositiveSafeInteger(pending.attemptSeq) ||
    pending.plannedAmount !== CONTINUOUS_PLANNED_AMOUNT ||
    !executionEvidenceIsSane(
      pending.executionEvidence,
      pending.attemptAt,
    ) ||
    pending.frozenEvidenceHash !==
      canonicalStableHashV1(
        pendingFrozenPayload(
          (() => {
            const copy = clone(pending) as Partial<ContinuousPendingAttempt>;
            delete copy.frozenEvidenceHash;
            return copy as Omit<
              ContinuousPendingAttempt,
              "frozenEvidenceHash"
            >;
          })(),
        ),
      )
  ) {
    return validationFailure(
      "direct_pending_invalid",
      "shape_or_fingerprint",
    );
  }

  const receipt = receiptsBySeq.get(pending.attemptSeq);
  const outcome = outcomesBySeq.get(pending.attemptSeq);
  if (pending.attemptSeq === state.finalizedAttemptSeq + 1) {
    if (
      state.nextAttemptSeq !== pending.attemptSeq + 1 ||
      receipt ||
      !latestProcessed
    ) {
      return validationFailure(
        "direct_attempt_sequence_gap",
        "active_prefix",
      );
    }
    if (!outcome) {
      return { ok: true, prefix: "active_waiting_outcome" };
    }
    if (!matchesPending(pending, outcome)) {
      return validationFailure(
        "direct_outcome_pending_conflict",
        "frozen_evidence",
      );
    }
    return { ok: true, prefix: "outcome_written" };
  }
  if (
    pending.attemptSeq === state.finalizedAttemptSeq &&
    state.nextAttemptSeq === state.finalizedAttemptSeq + 1 &&
    receipt &&
    outcome &&
    matchesPending(pending, outcome) &&
    receipt.outcomeEventHash === outcome.outcomeEventHash
  ) {
    return {
      ok: true,
      prefix: processedForAttempt(
        state,
        receipt.attemptSeq,
        receipt.evidenceKey,
      )
        ? "processed_key_written"
        : "receipt_written",
    };
  }
  return validationFailure(
    "direct_attempt_sequence_gap",
    "illegal_pending_prefix",
  );
}

export function failClosedContinuousLedger(
  state: MarketDirectContinuousLedger,
  tick: number,
  code: string,
  detail: unknown,
): MarketDirectContinuousLedger {
  return operationBlocked(state, tick, code, detail).state;
}

function exactLegacySeed(
  input: LegacyXGenesisInput,
): string | undefined {
  const state = input.legacyState;
  const outcome = input.reviewedOutcome;
  if (
    state.schema !== 1 ||
    state.directConfirmedDealCount !== 1 ||
    state.directPausedForReview !== true ||
    state.pendingCount !== 0 ||
    state.quarantinedCount !== 0 ||
    state.reconcileGapCount !== 0
  ) {
    return "legacy_state_not_exact";
  }
  if (
    outcome.requestId !== "direct:72585530:E6N59:X" ||
    outcome.transactionId !== "6a65f8e1656d080013d32210" ||
    outcome.orderId !== "6a65e025656d080013ccad03" ||
    outcome.evidenceKey !== LEGACY_X_PROCESSED_EVIDENCE_KEY ||
    outcome.status !== "confirmed" ||
    outcome.resolvedAt !== 72_585_531 ||
    outcome.attemptAt !== 72_585_530 ||
    outcome.transactionTime !== 72_585_530 ||
    outcome.sellerRoom !== AUTHORITY_ROOMS.legacyXSeller ||
    outcome.orderRoom !== AUTHORITY_ROOMS.legacyXBuyer ||
    outcome.resource !== "X" ||
    outcome.observedOrderAmount !== 28_920 ||
    outcome.actualAmount !== CONTINUOUS_PLANNED_AMOUNT ||
    outcome.plannedTransactionEnergy !== 394 ||
    outcome.actualTransactionEnergy !== 394 ||
    outcome.observedOrderPriceMilli !== 694_963 ||
    outcome.plannedNetCreditsMilli !== 682_331_360 ||
    outcome.actualNetCreditsMilli !== 682_331_360 ||
    outcome.worstCaseNetCreditsMilli !== 662_903 ||
    outcome.effectiveEnergyShadowPriceMilli !== 32_060 ||
    outcome.energyShadowComponents.hardFloor !== 20 ||
    outcome.energyShadowComponents.historyFloor !== 31.276 ||
    outcome.energyShadowComponents.ratchetFloor !== 32.06 ||
    outcome.protectionRevision !== 72_585_530 ||
    outcome.pendingRecoveryFingerprint !==
      "v1:bbb1de5ce52cb2d0" ||
    !outcome.directSafetyFingerprint
  ) {
    return "legacy_outcome_not_exact";
  }
  const legacyStateDigest = canonicalStableHashV1(state);
  if (legacyStateDigest !== input.expectedLegacyStateDigest) {
    return "legacy_state_digest_mismatch";
  }
  const reviewedOutcomeDigest = canonicalStableHashV1(
    outcome.canonicalOutcome,
  );
  if (
    reviewedOutcomeDigest !== input.expectedReviewedOutcomeDigest
  ) {
    return "legacy_outcome_digest_mismatch";
  }
  return undefined;
}

/**
 * 唯一允许的自动 genesis。调用方必须把完整 canonical v1 outcome 作为
 * `canonicalOutcome` 传入并提供编译时冻结的 digest，不能只凭 tx id 迁移。
 */
export function migrateLegacyXSeedLedger(
  input: LegacyXGenesisInput,
): ContinuousLedgerOperation {
  const base: MarketDirectContinuousLedger = {
    schema: CONTINUOUS_LEDGER_SCHEMA,
    coverageStartTick: Math.max(
      0,
      input.migrationTick - CONTINUOUS_ROLLING_WINDOW_TICKS + 1,
    ),
    receiptHeadHash: CONTINUOUS_RECEIPT_GENESIS,
    finalizedAttemptSeq: 0,
    nextAttemptSeq: 1,
    receipts: [],
    outcomes: [],
    processedEvidenceKeys: [],
    checkpoint: {
      prunedThroughSeq: 0,
      prunedHeadHash: CONTINUOUS_RECEIPT_GENESIS,
      confirmed: emptyCounters(),
      confirmedCanaries: {},
      confirmedCanaryCommitment:
        CONTINUOUS_CONFIRMED_CANARY_CHECKPOINT_GENESIS,
    },
    lifetimeConfirmed: emptyCounters(),
    confirmedCanaries: {},
    retryNotBefore: 0,
    permitEpochHighWater: 0,
    permitChainHeadHighWater: CONTINUOUS_PERMIT_GENESIS,
  };
  if (!isNonNegativeSafeInteger(input.migrationTick)) {
    return operationBlocked(
      base,
      0,
      "direct_migration_invalid",
      "migration_tick",
    );
  }
  let mismatch: string | undefined;
  try {
    mismatch = exactLegacySeed(input);
  } catch {
    mismatch = "legacy_canonicalization_failed";
  }
  if (mismatch) {
    return operationBlocked(
      base,
      input.migrationTick,
      "direct_migration_evidence_mismatch",
      mismatch,
    );
  }
  const outcome = input.reviewedOutcome;
  const receipt = withReceiptHashes(
    {
      attemptSeq: 1,
      executionPolicy: "legacy_canary_seed",
      status: "confirmed",
      permitId: LEGACY_X_SEED_PERMIT_ID,
      permitEpoch: 0,
      entryId: "base-x-e6n59-v1",
      resourcePolicyFingerprint:
        outcome.directSafetyFingerprint,
      sellerRoom: AUTHORITY_ROOMS.legacyXSeller,
      resource: "X",
      orderId: outcome.orderId,
      orderRoom: AUTHORITY_ROOMS.legacyXBuyer,
      attemptAt: 72_585_530,
      plannedAmount: CONTINUOUS_PLANNED_AMOUNT,
      resolvedAt: 72_585_531,
      retentionTick: 72_585_530,
      evidenceKey: LEGACY_X_PROCESSED_EVIDENCE_KEY,
      transactionId: outcome.transactionId,
      transactionTime: 72_585_530,
      actualAmount: CONTINUOUS_PLANNED_AMOUNT,
      actualTransactionEnergy: 394,
      actualNetCreditsMilli: 682_331_360,
      outcomeEventHash: canonicalStableHashV1({
        domain:
          "market-direct-continuous:legacy-seed-outcome-v1",
        reviewedOutcome: outcome.canonicalOutcome,
      }),
    },
    CONTINUOUS_RECEIPT_GENESIS,
  );
  base.receipts = [receipt];
  base.receiptHeadHash = receipt.headHash;
  base.finalizedAttemptSeq = 1;
  base.nextAttemptSeq = 2;
  base.processedEvidenceKeys = [
    { attemptSeq: 1, key: LEGACY_X_PROCESSED_EVIDENCE_KEY },
  ];
  addConfirmed(
    base.lifetimeConfirmed,
    "X",
    CONTINUOUS_PLANNED_AMOUNT,
  );
  base.confirmedCanaries[receipt.entryId] =
    confirmedCanaryFromReceipt(receipt)!;
  const legacyStateDigest = canonicalStableHashV1(
    input.legacyState,
  );
  const reviewedOutcomeDigest = canonicalStableHashV1(
    outcome.canonicalOutcome,
  );
  const attestationBase = {
    domain: "market-direct-continuous:migration-attestation-v2",
    migrationTick: input.migrationTick,
    legacyStateDigest,
    reviewedOutcomeDigest,
    seedReceiptEventHash: receipt.eventHash,
    seedLedgerHead: receipt.headHash,
    processedEvidenceKey: LEGACY_X_PROCESSED_EVIDENCE_KEY,
  };
  base.migrationAttestation = {
    migrationTick: input.migrationTick,
    legacyStateDigest,
    reviewedOutcomeDigest,
    seedReceiptEventHash: receipt.eventHash,
    seedLedgerHead: receipt.headHash,
    attestationHash: canonicalStableHashV1(attestationBase),
  };
  return { state: base, ok: true, action: "migrated" };
}

interface ContinuousRetainedQuotaAggregate {
  confirmedActual: number;
  lastConfirmedAt?: number;
}

function validContinuousQuotaBatchRequests(
  requests: readonly ContinuousQuotaBatchRequest[],
): boolean {
  if (
    !Array.isArray(requests) ||
    requests.length > CONTINUOUS_QUOTA_BATCH_LIMIT
  ) {
    return false;
  }
  const resources = new Set<string>();
  for (const request of requests) {
    if (
      !isPlainObject(request) ||
      typeof request.resource !== "string" ||
      !request.resource ||
      !isNonNegativeSafeInteger(request.resourceLimit) ||
      resources.has(request.resource)
    ) {
      return false;
    }
    resources.add(request.resource);
  }
  return true;
}

/**
 * 同一 ledger 的 bounded quota 只读投影。输入先整体校验，再对 ledger
 * 完整验真一次，并单遍聚合 rolling-window receipts；任一输入非法时不返回
 * 部分结果。该 helper 不参与 prepare/commit，也不铸造任何写 capability。
 */
export function computeContinuousQuotaBatch(
  state: MarketDirectContinuousLedger,
  tick: number,
  requests: readonly ContinuousQuotaBatchRequest[],
  globalLimit: number,
): ContinuousQuotaSnapshot[] | undefined {
  if (
    !isNonNegativeSafeInteger(tick) ||
    !isNonNegativeSafeInteger(globalLimit) ||
    !validContinuousQuotaBatchRequests(requests)
  ) {
    return undefined;
  }
  const validation = validateContinuousLedger(state, tick);
  if (!validation.ok) {
    return undefined;
  }

  const windowStartTick =
    tick - CONTINUOUS_ROLLING_WINDOW_TICKS + 1;
  const requestedResources = new Set(
    requests.map((request) => request.resource),
  );
  const byResource = new Map<
    string,
    ContinuousRetainedQuotaAggregate
  >();
  let globalConfirmedActual = 0;
  let lastGlobalConfirmedAt: number | undefined;
  for (const receipt of state.receipts) {
    const transactionTime = receipt.transactionTime;
    if (
      receipt.status !== "confirmed" ||
      transactionTime === undefined ||
      transactionTime < windowStartTick ||
      transactionTime > tick
    ) {
      continue;
    }
    globalConfirmedActual += receipt.actualAmount;
    lastGlobalConfirmedAt =
      lastGlobalConfirmedAt === undefined
        ? transactionTime
        : Math.max(lastGlobalConfirmedAt, transactionTime);
    if (!requestedResources.has(receipt.resource)) {
      continue;
    }
    const aggregate = byResource.get(receipt.resource) || {
      confirmedActual: 0,
    };
    aggregate.confirmedActual += receipt.actualAmount;
    aggregate.lastConfirmedAt =
      aggregate.lastConfirmedAt === undefined
        ? transactionTime
        : Math.max(aggregate.lastConfirmedAt, transactionTime);
    byResource.set(receipt.resource, aggregate);
  }

  const unmatchedPending =
    state.pending &&
    state.pending.attemptSeq === state.finalizedAttemptSeq + 1
      ? state.pending
      : undefined;
  const globalUnmatchedPlanned = unmatchedPending
    ? unmatchedPending.plannedAmount
    : 0;
  return requests.map((request) => {
    const aggregate = byResource.get(request.resource);
    const resourceConfirmedActual =
      aggregate?.confirmedActual ?? 0;
    const resourceUnmatchedPlanned =
      unmatchedPending?.resource === request.resource
        ? unmatchedPending.plannedAmount
        : 0;
    const lastResourceConfirmedAt = aggregate?.lastConfirmedAt;
    const confirmedCooldownNotBefore = Math.max(
      lastResourceConfirmedAt === undefined
        ? 0
        : lastResourceConfirmedAt +
            CONTINUOUS_CONFIRMED_COOLDOWN_TICKS,
      lastGlobalConfirmedAt === undefined
        ? 0
        : lastGlobalConfirmedAt +
            CONTINUOUS_CONFIRMED_COOLDOWN_TICKS,
    );
    return {
      tick,
      windowStartTick,
      resource: request.resource,
      resourceLimit: request.resourceLimit,
      globalLimit,
      resourceConfirmedActual,
      resourceUnmatchedPlanned,
      resourceRemaining:
        request.resourceLimit -
        resourceConfirmedActual -
        resourceUnmatchedPlanned,
      globalConfirmedActual,
      globalUnmatchedPlanned,
      globalRemaining:
        globalLimit -
        globalConfirmedActual -
        globalUnmatchedPlanned,
      lastResourceConfirmedAt,
      lastGlobalConfirmedAt,
      confirmedCooldownNotBefore,
      retryNotBefore: state.retryNotBefore,
    };
  });
}

/**
 * confirmed actual 与未匹配 planned reservation 分开返回。receipt 已提交但
 * pending 尚未删除时 reservation 已被 actual 原位替换，因此不再计 planned。
 */
export function computeContinuousQuota(
  state: MarketDirectContinuousLedger,
  tick: number,
  resource: string,
  resourceLimit: number,
  globalLimit: number,
): ContinuousQuotaSnapshot | undefined {
  return computeContinuousQuotaBatch(
    state,
    tick,
    [{ resource, resourceLimit }],
    globalLimit,
  )?.[0];
}

export function computeOpportunityAdmissions(
  state: MarketDirectContinuousLedger,
  tick: number,
  safeOpportunities: ContinuousSafeOpportunity[],
  globalLimit: number,
): ContinuousOpportunityAdmission[] | undefined {
  if (
    !Array.isArray(safeOpportunities) ||
    safeOpportunities.some(
      (entry) =>
        !isPlainObject(entry) ||
        typeof entry.resource !== "string" ||
        (entry.reserveAmount ?? CONTINUOUS_PLANNED_AMOUNT) !==
          CONTINUOUS_PLANNED_AMOUNT,
    )
  ) {
    return undefined;
  }
  const sorted = [...safeOpportunities].sort((left, right) =>
    left.resource.localeCompare(right.resource),
  );
  const batch = computeContinuousQuotaBatch(
    state,
    tick,
    sorted.map((opportunity) => ({
      resource: opportunity.resource,
      resourceLimit: opportunity.resourceLimit,
    })),
    globalLimit,
  );
  if (!batch) {
    return undefined;
  }
  const snapshots = new Map(
    batch.map((snapshot) => [snapshot.resource, snapshot]),
  );
  return sorted.map((opportunity) => {
    const snapshot = snapshots.get(opportunity.resource)!;
    const unmetOtherReserves: Record<string, number> = {};
    sorted.forEach((other) => {
      if (other.resource === opportunity.resource) return;
      const otherSnapshot = snapshots.get(other.resource)!;
      unmetOtherReserves[other.resource] = Math.max(
        0,
        CONTINUOUS_PLANNED_AMOUNT -
          otherSnapshot.resourceConfirmedActual -
          otherSnapshot.resourceUnmatchedPlanned,
      );
    });
    const unmetOwnReserve = Math.max(
      0,
      CONTINUOUS_PLANNED_AMOUNT -
        snapshot.resourceConfirmedActual -
        snapshot.resourceUnmatchedPlanned,
    );
    const admittedGlobalTotal =
      snapshot.globalConfirmedActual +
      snapshot.globalUnmatchedPlanned +
      CONTINUOUS_PLANNED_AMOUNT +
      Object.keys(unmetOtherReserves).reduce(
        (sum, resource) => sum + unmetOtherReserves[resource],
        0,
      );
    let reason:
      | ContinuousOpportunityAdmission["reason"]
      | undefined;
    if (
      snapshot.resourceRemaining <
      CONTINUOUS_PLANNED_AMOUNT
    ) {
      reason = "resource_quota";
    } else if (admittedGlobalTotal > globalLimit) {
      reason = "global_quota";
    } else if (
      tick < snapshot.confirmedCooldownNotBefore
    ) {
      reason = "cooldown";
    } else if (tick < snapshot.retryNotBefore) {
      reason = "retry_backoff";
    }
    return {
      resource: opportunity.resource,
      safe: true,
      resourceUsed: snapshot.resourceConfirmedActual,
      resourcePlanned: snapshot.resourceUnmatchedPlanned,
      unmetOwnReserve,
      unmetOtherReserves,
      admittedGlobalTotal,
      admitted: reason === undefined,
      reason,
    };
  });
}

export function prepareContinuousAttempt(
  state: MarketDirectContinuousLedger,
  input: PrepareContinuousAttemptInput,
): ContinuousLedgerOperation {
  const validation = validateContinuousLedger(state, input.tick);
  if (!validation.ok) {
    return operationBlocked(
      state,
      input.tick,
      validation.blockerCode || "direct_ledger_invalid",
      validation.detail || "prepare_validation",
    );
  }
  if (state.blocker) {
    return {
      state: clone(state),
      ok: false,
      action: "blocked",
      blockerCode: state.blocker.code,
    };
  }
  if (state.pending || validation.prefix !== "idle") {
    return operationBlocked(
      state,
      input.tick,
      "direct_pending_conflict",
      "second_pending",
    );
  }
  if (
    input.plannedAmount !== CONTINUOUS_PLANNED_AMOUNT ||
    !isNonNegativeSafeInteger(input.tick) ||
    !isPositiveSafeInteger(input.permitEpoch) ||
    !input.permitId ||
    !input.entryId ||
    !input.resourcePolicyFingerprint ||
    !input.sellerRoom ||
    !input.resource ||
    !input.orderId ||
    !input.orderRoom ||
    !isNonNegativeSafeInteger(input.plannedTransactionEnergy) ||
    !Number.isSafeInteger(input.plannedNetCreditsMilli) ||
    !executionEvidenceIsSane(input.executionEvidence, input.tick)
  ) {
    return operationBlocked(
      state,
      input.tick,
      "direct_pending_invalid",
      "prepare_input",
    );
  }
  if (
    input.executionPolicy === "canary" &&
    state.confirmedCanaries[input.entryId]
  ) {
    return operationBlocked(
      state,
      input.tick,
      "direct_canary_already_confirmed",
      state.confirmedCanaries[input.entryId],
    );
  }
  const quota = computeContinuousQuota(
    state,
    input.tick,
    input.resource,
    input.resourceLimit,
    input.globalLimit,
  );
  const admissions = computeOpportunityAdmissions(
    state,
    input.tick,
    input.safeOpportunityResources,
    input.globalLimit,
  );
  const admission = admissions?.find(
    (entry) => entry.resource === input.resource,
  );
  if (!quota || !admission || !admission.admitted) {
    return {
      state: clone(state),
      ok: false,
      action: "idle",
      blockerCode: admission?.reason || "direct_quota_unavailable",
    };
  }
  const withoutHash: Omit<
    ContinuousPendingAttempt,
    "frozenEvidenceHash"
  > = {
    attemptSeq: state.nextAttemptSeq,
    executionPolicy: input.executionPolicy,
    permitId: input.permitId,
    permitEpoch: input.permitEpoch,
    entryId: input.entryId,
    resourcePolicyFingerprint:
      input.resourcePolicyFingerprint,
    sellerRoom: input.sellerRoom,
    resource: input.resource,
    orderId: input.orderId,
    orderRoom: input.orderRoom,
    attemptAt: input.tick,
    plannedAmount: CONTINUOUS_PLANNED_AMOUNT,
    plannedTransactionEnergy: input.plannedTransactionEnergy,
    plannedNetCreditsMilli: input.plannedNetCreditsMilli,
    evidenceKeyHint: input.evidenceKeyHint,
    executionEvidence: clone(input.executionEvidence),
    resourceQuota: clone(quota),
    globalOpportunityReservation: {
      safeResources: [...input.safeOpportunityResources]
        .map((entry) => entry.resource)
        .sort(),
      unmetOtherResources: clone(
        admission.unmetOtherReserves,
      ),
      admittedGlobalTotal: admission.admittedGlobalTotal,
    },
  };
  const pending: ContinuousPendingAttempt = {
    ...withoutHash,
    frozenEvidenceHash: canonicalStableHashV1(
      pendingFrozenPayload(withoutHash),
    ),
  };
  const next = clone(state);
  next.pending = pending;
  next.nextAttemptSeq = pending.attemptSeq + 1;
  return { state: next, ok: true, action: "prepared" };
}

export function recordContinuousOutcome(
  state: MarketDirectContinuousLedger,
  tick: number,
  outcome: ContinuousOutcome,
): ContinuousLedgerOperation {
  const validation = validateContinuousLedger(state, tick);
  if (!validation.ok) {
    return operationBlocked(
      state,
      tick,
      validation.blockerCode || "direct_ledger_invalid",
      validation.detail || "outcome_validation",
    );
  }
  if (state.blocker) {
    return {
      state: clone(state),
      ok: false,
      action: "blocked",
      blockerCode: state.blocker.code,
    };
  }
  if (
    !state.pending ||
    !outcomeIsTerminalAndSane(outcome) ||
    (outcome.outcomeEventHash !== undefined &&
      !outcomeEventHashIsValid(outcome)) ||
    !matchesPending(state.pending, outcome)
  ) {
    return operationBlocked(
      state,
      tick,
      "direct_outcome_pending_conflict",
      outcome,
    );
  }
  const sealedOutcome = normalizedOutcome(outcome);
  const existing = state.outcomes.find(
    (entry) => entry.attemptSeq === outcome.attemptSeq,
  );
  if (existing) {
    if (sameCanonical(existing, sealedOutcome)) {
      return {
        state: clone(state),
        ok: true,
        action: "outcome_idempotent",
      };
    }
    return operationBlocked(
      state,
      tick,
      "direct_outcome_conflict",
      { existing, outcome },
    );
  }
  if (
    state.processedEvidenceKeys.some(
      (entry) => entry.key === outcome.evidenceKey,
    )
  ) {
    return operationBlocked(
      state,
      tick,
      "direct_processed_key_conflict",
      outcome.evidenceKey,
    );
  }
  const next = clone(state);
  next.outcomes.push(sealedOutcome);
  if (next.outcomes.length > CONTINUOUS_OUTCOME_RING_LIMIT) {
    next.outcomes.splice(
      0,
      next.outcomes.length - CONTINUOUS_OUTCOME_RING_LIMIT,
    );
  }
  return { state: next, ok: true, action: "outcome_written" };
}

function receiptFromPendingOutcome(
  pending: ContinuousPendingAttempt,
  outcome: ContinuousOutcome,
  prevHash: string,
): ContinuousReceipt {
  return withReceiptHashes(
    {
      attemptSeq: pending.attemptSeq,
      executionPolicy: pending.executionPolicy,
      status: outcome.status,
      permitId: pending.permitId,
      permitEpoch: pending.permitEpoch,
      entryId: pending.entryId,
      resourcePolicyFingerprint:
        pending.resourcePolicyFingerprint,
      sellerRoom: pending.sellerRoom,
      resource: pending.resource,
      orderId: pending.orderId,
      orderRoom: pending.orderRoom,
      attemptAt: pending.attemptAt,
      plannedAmount: pending.plannedAmount,
      resolvedAt: outcome.resolvedAt,
      retentionTick:
        outcome.status === "confirmed"
          ? outcome.transactionTime!
          : outcome.resolvedAt,
      evidenceKey: outcome.evidenceKey,
      reason: outcome.reason,
      transactionId: outcome.transactionId,
      transactionTime: outcome.transactionTime,
      actualAmount: outcome.actualAmount,
      actualTransactionEnergy:
        outcome.actualTransactionEnergy,
      actualNetCreditsMilli: outcome.actualNetCreditsMilli,
      outcomeEventHash: outcome.outcomeEventHash!,
    },
    prevHash,
  );
}

function absorbExpiredReceiptsForAppend(
  state: MarketDirectContinuousLedger,
  tick: number,
): boolean {
  const windowStart =
    tick - CONTINUOUS_ROLLING_WINDOW_TICKS + 1;
  while (
    state.receipts.length >= CONTINUOUS_RECEIPT_RING_LIMIT &&
    state.receipts[0].retentionTick < windowStart
  ) {
    const receipt = state.receipts.shift()!;
    state.checkpoint.prunedThroughSeq = receipt.attemptSeq;
    state.checkpoint.prunedHeadHash = receipt.headHash;
    if (receipt.status === "confirmed") {
      addConfirmed(
        state.checkpoint.confirmed,
        receipt.resource,
        receipt.actualAmount,
      );
    }
    const confirmedCanary =
      confirmedCanaryFromReceipt(receipt);
    if (confirmedCanary) {
      state.checkpoint.confirmedCanaries[
        confirmedCanary.entryId
      ] = confirmedCanary;
    }
    state.checkpoint.confirmedCanaryCommitment =
      continuousConfirmedCanaryCheckpointCommitment(
        state.checkpoint,
      );
    state.processedEvidenceKeys =
      state.processedEvidenceKeys.filter(
        (entry) => entry.attemptSeq > receipt.attemptSeq,
      );
    state.coverageStartTick = Math.max(
      state.coverageStartTick,
      windowStart,
    );
  }
  return state.receipts.length < CONTINUOUS_RECEIPT_RING_LIMIT;
}

/**
 * 只推进一个持久步骤。调用方必须保存返回 state 后再调用下一次，不能把
 * 三步折成一次 Memory assignment。
 */
export function advanceContinuousWal(
  state: MarketDirectContinuousLedger,
  tick: number,
): ContinuousLedgerOperation {
  const validation = validateContinuousLedger(state, tick);
  if (!validation.ok) {
    return operationBlocked(
      state,
      tick,
      validation.blockerCode || "direct_ledger_invalid",
      validation.detail || "wal_validation",
    );
  }
  if (state.blocker) {
    return {
      state: clone(state),
      ok: false,
      action: "blocked",
      blockerCode: state.blocker.code,
    };
  }
  if (!state.pending) {
    return { state: clone(state), ok: true, action: "idle" };
  }
  const pending = state.pending;
  const outcome = outcomeForAttempt(state, pending.attemptSeq);
  if (!outcome) {
    return {
      state: clone(state),
      ok: true,
      action: "waiting_for_outcome",
    };
  }
  const receipt = receiptForAttempt(state, pending.attemptSeq);
  if (!receipt) {
    const next = clone(state);
    if (!absorbExpiredReceiptsForAppend(next, tick)) {
      return operationBlocked(
        state,
        tick,
        "direct_receipt_ring_capacity",
        "oldest_receipt_still_in_window",
      );
    }
    const appended = receiptFromPendingOutcome(
      pending,
      outcome,
      next.receiptHeadHash,
    );
    const confirmedCanary =
      confirmedCanaryFromReceipt(appended);
    if (
      confirmedCanary &&
      next.confirmedCanaries[
        confirmedCanary.entryId
      ]
    ) {
      return operationBlocked(
        state,
        tick,
        "direct_canary_confirmation_conflict",
        {
          existing:
            next.confirmedCanaries[
              confirmedCanary.entryId
            ],
          incoming: confirmedCanary,
        },
      );
    }
    next.receipts.push(appended);
    next.receiptHeadHash = appended.headHash;
    next.finalizedAttemptSeq = appended.attemptSeq;
    if (appended.status === "confirmed") {
      addConfirmed(
        next.lifetimeConfirmed,
        appended.resource,
        appended.actualAmount,
      );
      if (confirmedCanary) {
        next.confirmedCanaries[
          confirmedCanary.entryId
        ] = confirmedCanary;
      }
    } else {
      next.retryNotBefore = Math.max(
        next.retryNotBefore,
        appended.attemptAt + CONTINUOUS_FAILED_RETRY_TICKS,
      );
    }
    return {
      state: next,
      ok: true,
      action: "receipt_written",
    };
  }
  if (
    !processedForAttempt(
      state,
      receipt.attemptSeq,
      receipt.evidenceKey,
    )
  ) {
    const next = clone(state);
    if (
      next.processedEvidenceKeys.length >=
      CONTINUOUS_PROCESSED_KEY_RING_LIMIT
    ) {
      return operationBlocked(
        state,
        tick,
        "direct_processed_key_ring_capacity",
        "prune_before_processed_key",
      );
    }
    next.processedEvidenceKeys.push({
      attemptSeq: receipt.attemptSeq,
      key: receipt.evidenceKey,
    });
    return {
      state: next,
      ok: true,
      action: "processed_key_written",
    };
  }
  const next = clone(state);
  delete next.pending;
  return {
    state: next,
    ok: true,
    action: "pending_deleted",
  };
}
