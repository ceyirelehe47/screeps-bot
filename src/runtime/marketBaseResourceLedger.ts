/**
 * 基础矿物 Direct V3 的纯数据 WAL、receipt chain 与四层额度。
 *
 * V2 raw record 永远保留在 legacy envelope 的 `rawRecord` 内；version
 * dispatcher 不会规范化、补 discriminator 或改变传给 frozen V2 validator
 * 的对象引用。
 */

import {
  MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT,
  isMarketBaseResource,
  type MarketBaseResource,
} from "@/runtime/marketBaseResourcePolicy";
import {
  MARKET_BASE_RESOURCE_PERMIT_SUFFIX_LIMIT,
  MARKET_BASE_RESOURCE_PLANNED_AMOUNT,
  marketBaseResourcePermitBindingFor,
  buildMarketBaseResourcePermitRuntimeAnchor,
  sealMarketBaseResourceValidatedConfirmedCanaryProof,
  hasAcceptedMarketBaseResourceV3Successor,
  isMarketBaseResourcePermitDeepFrozen,
  validateMarketBaseResourceRatchetHighWater,
  validateMarketBaseResourcePermitChain,
  validateMarketBaseResourcePermitRuntimeGate,
  type MarketBaseResourcePermit,
  type MarketBaseResourcePermitBinding,
  type MarketBaseResourcePermitChainState,
  type MarketBaseResourcePermitReference,
  type MarketBaseResourcePermitRuntimeAnchor,
  type MarketBaseResourceRatchetHighWater,
  type MarketBaseResourceValidatedConfirmedCanaryProof,
  type MarketBaseResourceV2EventCutoverCheckpoint,
  validateMarketBaseResourceV2EventCutoverCheckpoint,
} from "@/runtime/marketBaseResourcePermit";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

export const MARKET_BASE_RESOURCE_LEDGER_SCHEMA_VERSION = 3 as const;
export const MARKET_BASE_RESOURCE_LEDGER_HASH_REVISION =
  "market-base-resource-ledger-hash-v1" as const;
export const MARKET_BASE_RESOURCE_PENDING_HASH_REVISION =
  "market-base-resource-pending-hash-v1" as const;
export const MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION =
  "market-base-resource-outcome-hash-v1" as const;
export const MARKET_BASE_RESOURCE_RECEIPT_HASH_REVISION =
  "market-base-resource-receipt-hash-v1" as const;
export const MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT = 512 as const;
export const MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT = 50 as const;
export const MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT = 512 as const;
export const MARKET_BASE_RESOURCE_OUTGOING_TRANSACTION_KEY_LIMIT = 100 as const;
export const MARKET_BASE_RESOURCE_RETIRED_CANARY_RING_LIMIT = 512 as const;
export const MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS = 30_000 as const;
export const MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT = MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT;
export const MARKET_BASE_RESOURCE_ROOM_QUOTA_LIMIT = MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT;
export const MARKET_BASE_RESOURCE_LANE_QUOTA_LIMIT = MARKET_BASE_RESOURCE_UNBOUNDED_QUOTA_LIMIT;
export const MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS = 1_000 as const;
export const MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS = 100 as const;

const DIGEST_PATTERN = /^(?:csh1:[0-9a-f]{32}|[a-z0-9][a-z0-9:._+-]{7,255})$/;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const ledgerDeepFrozenValues = new WeakSet<object>();
export type MarketBaseResourceLedgerRuntimeTestEvent =
  | "full_validator"
  | "runtime_gate";
let marketBaseResourceLedgerRuntimeTestProbe:
  | ((event: MarketBaseResourceLedgerRuntimeTestEvent) => void)
  | undefined;

/** 仅供复杂度回归测试观测 full audit/runtime gate 次数。 */
export function setMarketBaseResourceLedgerRuntimeTestProbe(
  probe:
    | ((event: MarketBaseResourceLedgerRuntimeTestEvent) => void)
    | undefined,
): void {
  marketBaseResourceLedgerRuntimeTestProbe = probe;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value && typeof value === "object" && !seen.has(value)) {
    if (ledgerDeepFrozenValues.has(value)) return value;
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested, seen);
    }
    if (!Object.isFrozen(value)) Object.freeze(value);
    ledgerDeepFrozenValues.add(value);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSignedSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isBoundedString(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

export type MarketBaseResourceEventKind = "pending" | "outcome" | "receipt";

export interface MarketBaseResourceEventVersionContext {
  readonly kind: MarketBaseResourceEventKind;
  readonly outerLedgerSchema: 2 | 3;
  readonly outerAttemptSeqHighWater: number;
  readonly outerOutcomeSeqHighWater: number;
  readonly cutover?: MarketBaseResourceV2EventCutoverCheckpoint;
}

export type MarketBaseResourceEventVersionClassification =
  | {
      readonly ok: true;
      readonly version: "legacy-v2-implicit";
      readonly rawRecord: unknown;
    }
  | {
      readonly ok: true;
      readonly version: "v3-explicit";
      readonly rawRecord: unknown;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

const V2_PENDING_REQUIRED_KEYS = [
  "attemptSeq",
  "executionPolicy",
  "permitId",
  "permitEpoch",
  "entryId",
  "resourcePolicyFingerprint",
  "sellerRoom",
  "resource",
  "orderId",
  "orderRoom",
  "attemptAt",
  "plannedAmount",
  "plannedTransactionEnergy",
  "plannedNetCreditsMilli",
  "evidenceKeyHint",
  "executionEvidence",
  "resourceQuota",
  "globalOpportunityReservation",
  "frozenEvidenceHash",
] as const;

const V2_OUTCOME_REQUIRED_KEYS = [
  "attemptSeq",
  "status",
  "permitId",
  "permitEpoch",
  "entryId",
  "resourcePolicyFingerprint",
  "sellerRoom",
  "resource",
  "orderId",
  "orderRoom",
  "attemptAt",
  "plannedAmount",
  "resolvedAt",
  "evidenceKey",
  "actualAmount",
  "pendingEvidenceHash",
] as const;

const V2_OUTCOME_OPTIONAL_KEYS = [
  "reason",
  "transactionId",
  "transactionTime",
  "actualTransactionEnergy",
  "actualNetCreditsMilli",
  "outcomeEventHash",
] as const;

const V2_RECEIPT_REQUIRED_KEYS = [
  "attemptSeq",
  "executionPolicy",
  "status",
  "permitId",
  "permitEpoch",
  "entryId",
  "resourcePolicyFingerprint",
  "sellerRoom",
  "resource",
  "orderId",
  "orderRoom",
  "attemptAt",
  "plannedAmount",
  "resolvedAt",
  "retentionTick",
  "evidenceKey",
  "actualAmount",
  "outcomeEventHash",
  "prevHash",
  "eventHash",
  "headHash",
] as const;

const V2_RECEIPT_OPTIONAL_KEYS = [
  "reason",
  "transactionId",
  "transactionTime",
  "actualTransactionEnergy",
  "actualNetCreditsMilli",
] as const;

function exactLegacyV2FieldSet(
  raw: Record<string, unknown>,
  kind: MarketBaseResourceEventKind,
): boolean {
  switch (kind) {
    case "pending":
      return exactKeys(raw, V2_PENDING_REQUIRED_KEYS);
    case "outcome":
      return exactKeys(raw, V2_OUTCOME_REQUIRED_KEYS, V2_OUTCOME_OPTIONAL_KEYS);
    case "receipt":
      return exactKeys(raw, V2_RECEIPT_REQUIRED_KEYS, V2_RECEIPT_OPTIONAL_KEYS);
  }
}

/**
 * 只做版本与 frozen 字段集合分派。legacy validator callback 必须接收这里
 * 返回的同一 rawRecord 引用，以原始 V2 payload/domain 做 hash 验证。
 */
export function classifyMarketBaseResourceEventVersion(
  raw: unknown,
  context: MarketBaseResourceEventVersionContext,
): MarketBaseResourceEventVersionClassification {
  if (
    !isPlainRecord(raw) ||
    !isSafeInteger(context.outerAttemptSeqHighWater) ||
    !isSafeInteger(context.outerOutcomeSeqHighWater)
  ) {
    return { ok: false, reason: "event_or_outer_high_water_invalid" };
  }
  const hasSchema = Object.prototype.hasOwnProperty.call(raw, "schemaVersion");
  const hasHashRevision = Object.prototype.hasOwnProperty.call(
    raw,
    "hashRevision",
  );
  if (hasSchema || hasHashRevision) {
    if (raw.schemaVersion !== 3 || typeof raw.hashRevision !== "string") {
      return { ok: false, reason: "event_explicit_version_invalid" };
    }
    const expectedRevision =
      context.kind === "pending"
        ? MARKET_BASE_RESOURCE_PENDING_HASH_REVISION
        : context.kind === "outcome"
          ? MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION
          : MARKET_BASE_RESOURCE_RECEIPT_HASH_REVISION;
    return raw.hashRevision === expectedRevision
      ? { ok: true, version: "v3-explicit", rawRecord: raw }
      : { ok: false, reason: "event_hash_revision_invalid" };
  }
  if (!exactLegacyV2FieldSet(raw, context.kind)) {
    return { ok: false, reason: "legacy_v2_field_set_invalid" };
  }
  const attemptSeq = raw.attemptSeq;
  if (!isPositiveSafeInteger(attemptSeq)) {
    return { ok: false, reason: "legacy_v2_seq_invalid" };
  }
  const outerCutoff =
    context.kind === "pending"
      ? context.outerAttemptSeqHighWater
      : context.outerOutcomeSeqHighWater;
  if (context.outerLedgerSchema === 2) {
    return attemptSeq <= outerCutoff
      ? { ok: true, version: "legacy-v2-implicit", rawRecord: raw }
      : { ok: false, reason: "legacy_v2_seq_above_outer_high_water" };
  }
  if (
    !context.cutover ||
    !validateMarketBaseResourceV2EventCutoverCheckpoint(context.cutover)
  ) {
    return { ok: false, reason: "legacy_v2_cutover_missing" };
  }
  const authenticatedCutoff =
    context.kind === "pending"
      ? context.cutover.lastV2AttemptSeq
      : context.cutover.lastV2OutcomeSeq;
  return attemptSeq <= authenticatedCutoff
    ? { ok: true, version: "legacy-v2-implicit", rawRecord: raw }
    : { ok: false, reason: "legacy_v2_seq_above_cutover" };
}

export function validateMarketBaseResourceMixedVersionEvent(
  raw: unknown,
  context: MarketBaseResourceEventVersionContext,
  validateLegacyV2Raw: (rawRecord: unknown) => boolean,
): MarketBaseResourceEventVersionClassification {
  const classification = classifyMarketBaseResourceEventVersion(raw, context);
  if (
    classification.ok &&
    classification.version === "legacy-v2-implicit" &&
    !validateLegacyV2Raw(classification.rawRecord)
  ) {
    return { ok: false, reason: "legacy_v2_frozen_codec_rejected" };
  }
  if (classification.ok && classification.version === "v3-explicit") {
    const valid =
      context.kind === "pending"
        ? validPending(classification.rawRecord)
        : context.kind === "outcome"
          ? validOutcome(classification.rawRecord)
          : validReceipt(classification.rawRecord);
    if (!valid) {
      return { ok: false, reason: "v3_explicit_codec_rejected" };
    }
  }
  return classification;
}

export type MarketBaseResourceTerminalStatus =
  "confirmed" | "failed" | "not_filled";

export interface MarketBaseResourceQuotaReceipt {
  readonly sourceVersion: 2 | 3;
  readonly attemptSeq: number;
  readonly evidenceKey: string;
  readonly status: MarketBaseResourceTerminalStatus;
  readonly resource: string;
  readonly sellerRoom: string;
  readonly plannedAmount: number;
  readonly actualAmount: number;
  readonly resolvedAt: number;
  readonly retentionTick: number;
  readonly transactionTime?: number;
}

export interface MarketBaseResourceQuotaLayer {
  readonly key: string;
  readonly limit: number;
  readonly confirmedActual: number;
  readonly unmatchedPlanned: number;
  readonly used: number;
  readonly remaining: number;
}

export interface MarketBaseResourceQuotaSnapshot {
  readonly tick: number;
  readonly windowStartTick: number;
  readonly resource: string;
  readonly sellerRoom: string;
  readonly global: MarketBaseResourceQuotaLayer;
  readonly resourceQuota: MarketBaseResourceQuotaLayer;
  readonly room: MarketBaseResourceQuotaLayer;
  readonly lane: MarketBaseResourceQuotaLayer;
  readonly lastGlobalConfirmedAt?: number;
  readonly confirmedCooldownNotBefore: number;
  readonly retryNotBefore: number;
}

export interface MarketBaseResourceQuotaPendingReservation {
  readonly resource: string;
  readonly sellerRoom: string;
  readonly plannedAmount: typeof MARKET_BASE_RESOURCE_PLANNED_AMOUNT;
}

function validQuotaReceipt(receipt: MarketBaseResourceQuotaReceipt): boolean {
  if (
    ![2, 3].includes(receipt.sourceVersion) ||
    !isPositiveSafeInteger(receipt.attemptSeq) ||
    !isDigest(receipt.evidenceKey) ||
    !["confirmed", "failed", "not_filled"].includes(receipt.status) ||
    !isMarketBaseResource(receipt.resource) ||
    !isBoundedString(receipt.sellerRoom, 64) ||
    receipt.plannedAmount !== MARKET_BASE_RESOURCE_PLANNED_AMOUNT ||
    !isSafeInteger(receipt.actualAmount) ||
    receipt.actualAmount > receipt.plannedAmount ||
    !isSafeInteger(receipt.resolvedAt) ||
    !isSafeInteger(receipt.retentionTick)
  ) {
    return false;
  }
  if (receipt.status === "confirmed") {
    return (
      isPositiveSafeInteger(receipt.actualAmount) &&
      isSafeInteger(receipt.transactionTime) &&
      receipt.transactionTime <= receipt.resolvedAt &&
      receipt.retentionTick === receipt.transactionTime
    );
  }
  return (
    receipt.actualAmount === 0 &&
    receipt.transactionTime === undefined &&
    receipt.retentionTick === receipt.resolvedAt
  );
}

function quotaLayer(
  key: string,
  limit: number,
  confirmedActual: number,
  unmatchedPlanned: number,
): MarketBaseResourceQuotaLayer {
  const used = confirmedActual + unmatchedPlanned;
  return {
    key,
    limit,
    confirmedActual,
    unmatchedPlanned,
    used,
    remaining: Math.max(0, limit - used),
  };
}

export function computeMarketBaseResourceQuota(input: {
  readonly tick: number;
  readonly resource: string;
  readonly sellerRoom: string;
  readonly resourceLimit: number;
  readonly receipts: readonly MarketBaseResourceQuotaReceipt[];
  readonly pending?: MarketBaseResourceQuotaPendingReservation;
  readonly retryNotBefore?: number;
  readonly globalLimit?: number;
  readonly roomLimit?: number;
  readonly laneLimit?: number;
}): MarketBaseResourceQuotaSnapshot {
  if (
    !isSafeInteger(input.tick) ||
    !isMarketBaseResource(input.resource) ||
    !isPositiveSafeInteger(input.resourceLimit) ||
    !isBoundedString(input.sellerRoom, 64) ||
    (input.globalLimit !== undefined &&
      !isPositiveSafeInteger(input.globalLimit)) ||
    (input.roomLimit !== undefined &&
      !isPositiveSafeInteger(input.roomLimit)) ||
    (input.laneLimit !== undefined &&
      !isPositiveSafeInteger(input.laneLimit)) ||
    (input.retryNotBefore !== undefined &&
      !isSafeInteger(input.retryNotBefore)) ||
    input.receipts.some((receipt) => !validQuotaReceipt(receipt)) ||
    (input.pending !== undefined &&
      (!isMarketBaseResource(input.pending.resource) ||
        !isBoundedString(input.pending.sellerRoom, 64) ||
        input.pending.plannedAmount !== MARKET_BASE_RESOURCE_PLANNED_AMOUNT))
  ) {
    throw new TypeError("invalid quota input");
  }
  const windowStartTick =
    input.tick - (MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS - 1);
  let globalConfirmed = 0;
  let resourceConfirmed = 0;
  let roomConfirmed = 0;
  let laneConfirmed = 0;
  let lastGlobalConfirmedAt: number | undefined;
  const seenAttempts = new Set<number>();
  const seenEvidenceKeys = new Set<string>();
  for (const receipt of input.receipts) {
    if (
      seenAttempts.has(receipt.attemptSeq) ||
      seenEvidenceKeys.has(receipt.evidenceKey)
    ) {
      throw new TypeError("duplicate quota receipt");
    }
    seenAttempts.add(receipt.attemptSeq);
    seenEvidenceKeys.add(receipt.evidenceKey);
    if (
      receipt.status !== "confirmed" ||
      !isSafeInteger(receipt.transactionTime) ||
      receipt.transactionTime < windowStartTick ||
      receipt.transactionTime > input.tick ||
      !isSafeInteger(receipt.actualAmount)
    ) {
      continue;
    }
    globalConfirmed += receipt.actualAmount;
    if (receipt.resource === input.resource) {
      resourceConfirmed += receipt.actualAmount;
    }
    if (receipt.sellerRoom === input.sellerRoom) {
      roomConfirmed += receipt.actualAmount;
    }
    if (
      receipt.resource === input.resource &&
      receipt.sellerRoom === input.sellerRoom
    ) {
      laneConfirmed += receipt.actualAmount;
    }
    lastGlobalConfirmedAt = Math.max(
      lastGlobalConfirmedAt ?? 0,
      receipt.transactionTime,
    );
  }
  const pendingAmount =
    input.pending?.plannedAmount === MARKET_BASE_RESOURCE_PLANNED_AMOUNT
      ? input.pending.plannedAmount
      : 0;
  const pendingResource =
    pendingAmount > 0 && input.pending?.resource === input.resource
      ? pendingAmount
      : 0;
  const pendingRoom =
    pendingAmount > 0 && input.pending?.sellerRoom === input.sellerRoom
      ? pendingAmount
      : 0;
  const pendingLane =
    pendingResource > 0 && input.pending?.sellerRoom === input.sellerRoom
      ? pendingAmount
      : 0;
  return deepFreeze({
    tick: input.tick,
    windowStartTick,
    resource: input.resource,
    sellerRoom: input.sellerRoom,
    global: quotaLayer(
      "global",
      input.globalLimit ?? MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
      globalConfirmed,
      pendingAmount,
    ),
    resourceQuota: quotaLayer(
      input.resource,
      input.resourceLimit,
      resourceConfirmed,
      pendingResource,
    ),
    room: quotaLayer(
      input.sellerRoom,
      input.roomLimit ?? MARKET_BASE_RESOURCE_ROOM_QUOTA_LIMIT,
      roomConfirmed,
      pendingRoom,
    ),
    lane: quotaLayer(
      `${input.resource}:${input.sellerRoom}`,
      input.laneLimit ?? MARKET_BASE_RESOURCE_LANE_QUOTA_LIMIT,
      laneConfirmed,
      pendingLane,
    ),
    ...(lastGlobalConfirmedAt !== undefined ? { lastGlobalConfirmedAt } : {}),
    confirmedCooldownNotBefore:
      lastGlobalConfirmedAt === undefined
        ? 0
        : lastGlobalConfirmedAt + MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
    retryNotBefore: input.retryNotBefore ?? 0,
  }) as MarketBaseResourceQuotaSnapshot;
}

export interface MarketBaseResourceHistoricalPermitRef {
  readonly permitId: string;
  readonly permitEpoch: number;
  readonly permitSelfHash: string;
  readonly permitHead: string;
  readonly prefixBindingHash: string;
}

function historicalPermitBindingHash(
  binding: MarketBaseResourcePermitBinding,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:historical-permit-binding-v1",
    binding,
  });
}

/**
 * prepare 调用方只能从已经通过 permit codec 的完整 retained record 构造
 * historical ref。active pending 会继续 pin 该 full record，不能依赖被裁剪
 * binding 恢复。
 */
export function buildMarketBaseResourceHistoricalPermitRef(
  permit: MarketBaseResourcePermit,
): MarketBaseResourceHistoricalPermitRef {
  const binding = marketBaseResourcePermitBindingFor(permit);
  return deepFreeze({
    permitId: permit.permitId,
    permitEpoch: permit.epoch,
    permitSelfHash: permit.selfHash,
    permitHead: permit.permitHead,
    prefixBindingHash: historicalPermitBindingHash(binding),
  }) as MarketBaseResourceHistoricalPermitRef;
}

export interface MarketBaseResourceHistoricalLaneRef {
  readonly laneId: string;
  readonly roomInstanceId: string;
  readonly sellerRoom: string;
  readonly resource: MarketBaseResource;
  readonly resourcePolicyId: string;
  readonly resourcePolicyFingerprint: string;
  readonly roomFingerprint: string;
  readonly sharedPolicyFingerprint: string;
}

export interface MarketBaseResourceFrozenDynamicScope {
  readonly admissionPolicyFingerprint: string;
  readonly rosterFingerprint: string;
  readonly laneSetFingerprint: string;
}

export interface MarketBaseResourceDynamicScopeRead extends MarketBaseResourceFrozenDynamicScope {
  readonly laneId: string;
  readonly roomInstanceId: string;
}

export interface MarketBaseResourceFrozenFullReads {
  readonly firstReadFingerprint: string;
  readonly secondReadFingerprint: string;
  readonly bookFingerprint: string;
  readonly protectionFingerprint: string;
  readonly energyReadinessFingerprint: string;
  readonly arbiterFingerprint: string;
}

/**
 * deal 前第二次 full read 的物理对账基线。下一 tick 只能用这份已进入
 * pending hash 的证据识别唯一 outgoing transaction，不能用新 planner
 * 结果重解释既有 exposure。
 */
export interface MarketBaseResourceExecutionEvidence {
  readonly observedOrderPriceMilli: number;
  readonly observedOrderAmount: number;
  readonly effectiveEnergyShadowPriceMilli: number;
  readonly effectiveNetFloorMilli: number;
  readonly terminalResourceBefore: number;
  readonly terminalEnergyBefore: number;
  readonly terminalCooldownBefore: number;
  readonly creditsBefore: number;
  readonly outgoingTransactionKeysBefore: readonly string[];
  readonly outgoingWindowObservedAt: number;
  readonly outgoingWindowOldestTime?: number;
  readonly outgoingWindowNewestTime?: number;
  readonly outgoingWindowCoversAttemptAt: true;
}

export interface MarketBaseResourcePendingAttempt {
  readonly schemaVersion: 3;
  readonly hashRevision: typeof MARKET_BASE_RESOURCE_PENDING_HASH_REVISION;
  readonly attemptSeq: number;
  readonly executionPolicy: "canary" | "continuous";
  readonly historicalPermit: MarketBaseResourceHistoricalPermitRef;
  readonly historicalLane: MarketBaseResourceHistoricalLaneRef;
  readonly dynamicScope: MarketBaseResourceFrozenDynamicScope;
  readonly fullReads: MarketBaseResourceFrozenFullReads;
  readonly executionEvidence: MarketBaseResourceExecutionEvidence;
  readonly orderId: string;
  readonly orderRoom: string;
  readonly attemptAt: number;
  readonly plannedAmount: typeof MARKET_BASE_RESOURCE_PLANNED_AMOUNT;
  readonly plannedTransactionEnergy: number;
  readonly plannedNetCreditsMilli: number;
  readonly worstUnitNetCreditsMilli: number;
  readonly quota: MarketBaseResourceQuotaSnapshot;
  readonly evidenceKeyHint: string;
  readonly frozenEvidenceHash: string;
}

type PendingWithoutHash = Omit<
  MarketBaseResourcePendingAttempt,
  "frozenEvidenceHash"
>;

function pendingHash(payload: PendingWithoutHash): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:pending-v1",
    payload,
  });
}

export interface PrepareMarketBaseResourceAttemptInput extends Omit<
  MarketBaseResourcePendingAttempt,
  | "schemaVersion"
  | "hashRevision"
  | "attemptSeq"
  | "attemptAt"
  | "plannedAmount"
  | "quota"
  | "dynamicScope"
  | "frozenEvidenceHash"
> {
  readonly tick: number;
  readonly resourceLimit: number;
  readonly permitChain: MarketBaseResourcePermitChainState;
  readonly firstDynamicScope: MarketBaseResourceDynamicScopeRead;
  readonly secondDynamicScope: MarketBaseResourceDynamicScopeRead;
  /** Scoped one-run trial gate; the persisted quota snapshot stays at 1,000. */
  readonly trialCooldownNotBefore?: number;
  readonly trialPermitId?: string;
}

export interface MarketBaseResourceOutcome {
  readonly schemaVersion: 3;
  readonly hashRevision: typeof MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION;
  readonly attemptSeq: number;
  readonly status: MarketBaseResourceTerminalStatus;
  readonly permitId: string;
  readonly permitEpoch: number;
  readonly laneId: string;
  readonly sellerRoom: string;
  readonly resource: MarketBaseResource;
  readonly orderId: string;
  readonly orderRoom: string;
  readonly attemptAt: number;
  readonly plannedAmount: typeof MARKET_BASE_RESOURCE_PLANNED_AMOUNT;
  readonly resolvedAt: number;
  readonly evidenceKey: string;
  readonly actualAmount: number;
  readonly reason?: string;
  readonly transactionId?: string;
  readonly transactionTime?: number;
  readonly actualTransactionEnergy?: number;
  readonly actualNetCreditsMilli?: number;
  readonly pendingEvidenceHash: string;
  readonly outcomeEventHash: string;
}

type OutcomeWithoutHash = Omit<MarketBaseResourceOutcome, "outcomeEventHash">;

function outcomeHash(payload: OutcomeWithoutHash): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:outcome-v1",
    payload,
  });
}

export function sealMarketBaseResourceOutcome(
  outcome: OutcomeWithoutHash,
): MarketBaseResourceOutcome {
  return deepFreeze({
    ...clone(outcome),
    outcomeEventHash: outcomeHash(outcome),
  }) as MarketBaseResourceOutcome;
}

export interface MarketBaseResourceReceipt {
  readonly schemaVersion: 3;
  readonly hashRevision: typeof MARKET_BASE_RESOURCE_RECEIPT_HASH_REVISION;
  readonly attemptSeq: number;
  readonly executionPolicy: "canary" | "continuous";
  readonly status: MarketBaseResourceTerminalStatus;
  readonly permitId: string;
  readonly permitEpoch: number;
  readonly laneId: string;
  readonly sellerRoom: string;
  readonly resource: MarketBaseResource;
  readonly orderId: string;
  readonly orderRoom: string;
  readonly attemptAt: number;
  readonly plannedAmount: typeof MARKET_BASE_RESOURCE_PLANNED_AMOUNT;
  readonly resolvedAt: number;
  readonly retentionTick: number;
  readonly evidenceKey: string;
  readonly actualAmount: number;
  readonly reason?: string;
  readonly transactionId?: string;
  readonly transactionTime?: number;
  readonly actualTransactionEnergy?: number;
  readonly actualNetCreditsMilli?: number;
  readonly pendingEvidenceHash: string;
  readonly outcomeEventHash: string;
  readonly prevHash: string;
  readonly eventHash: string;
  readonly headHash: string;
}

type ReceiptWithoutHashes = Omit<
  MarketBaseResourceReceipt,
  "prevHash" | "eventHash" | "headHash"
>;

function sealReceipt(
  receipt: ReceiptWithoutHashes,
  prevHash: string,
): MarketBaseResourceReceipt {
  const eventHash = canonicalStableHashV1({
    domain: "market-base-resource:receipt-v1",
    receipt,
  });
  const headHash = canonicalStableHashV1({
    domain: "market-base-resource:receipt-head-v1",
    eventHash,
    prevHash,
  });
  return {
    ...receipt,
    prevHash,
    eventHash,
    headHash,
  };
}

function validReceipt(value: unknown): value is MarketBaseResourceReceipt {
  if (
    !isPlainRecord(value) ||
    !exactKeys(
      value,
      [
        "actualAmount",
        "attemptAt",
        "attemptSeq",
        "eventHash",
        "evidenceKey",
        "executionPolicy",
        "hashRevision",
        "headHash",
        "laneId",
        "orderId",
        "orderRoom",
        "outcomeEventHash",
        "pendingEvidenceHash",
        "permitEpoch",
        "permitId",
        "plannedAmount",
        "prevHash",
        "resolvedAt",
        "resource",
        "retentionTick",
        "schemaVersion",
        "sellerRoom",
        "status",
      ],
      [
        "actualNetCreditsMilli",
        "actualTransactionEnergy",
        "reason",
        "transactionId",
        "transactionTime",
      ],
    )
  ) {
    return false;
  }
  const receipt = value as unknown as MarketBaseResourceReceipt;
  if (
    receipt.schemaVersion !== 3 ||
    receipt.hashRevision !== MARKET_BASE_RESOURCE_RECEIPT_HASH_REVISION ||
    !isPositiveSafeInteger(receipt.attemptSeq) ||
    !["canary", "continuous"].includes(receipt.executionPolicy) ||
    !["confirmed", "failed", "not_filled"].includes(receipt.status) ||
    !isDigest(receipt.permitId) ||
    !isPositiveSafeInteger(receipt.permitEpoch) ||
    !isDigest(receipt.laneId) ||
    !isBoundedString(receipt.sellerRoom, 64) ||
    !isMarketBaseResource(receipt.resource) ||
    !isBoundedString(receipt.orderId, 128) ||
    !isBoundedString(receipt.orderRoom, 64) ||
    receipt.plannedAmount !== MARKET_BASE_RESOURCE_PLANNED_AMOUNT ||
    !isSafeInteger(receipt.attemptAt) ||
    !isSafeInteger(receipt.resolvedAt) ||
    receipt.resolvedAt < receipt.attemptAt ||
    !isSafeInteger(receipt.retentionTick) ||
    !isDigest(receipt.evidenceKey) ||
    !isSafeInteger(receipt.actualAmount) ||
    receipt.actualAmount > receipt.plannedAmount ||
    !isDigest(receipt.pendingEvidenceHash) ||
    !isDigest(receipt.outcomeEventHash) ||
    !isDigest(receipt.prevHash) ||
    !isDigest(receipt.eventHash) ||
    !isDigest(receipt.headHash) ||
    (receipt.reason !== undefined && !isBoundedString(receipt.reason, 256))
  ) {
    return false;
  }
  if (receipt.status === "confirmed") {
    if (
      !isPositiveSafeInteger(receipt.actualAmount) ||
      !isSafeInteger(receipt.transactionTime) ||
      receipt.transactionTime < receipt.attemptAt ||
      receipt.transactionTime > receipt.resolvedAt ||
      receipt.retentionTick !== receipt.transactionTime ||
      !isBoundedString(receipt.transactionId, 128) ||
      !isSafeInteger(receipt.actualTransactionEnergy) ||
      receipt.actualTransactionEnergy > 1_000 ||
      !isPositiveSafeInteger(receipt.actualNetCreditsMilli)
    ) {
      return false;
    }
  } else if (
    receipt.actualAmount !== 0 ||
    receipt.transactionTime !== undefined ||
    receipt.transactionId !== undefined ||
    receipt.actualTransactionEnergy !== undefined ||
    receipt.actualNetCreditsMilli !== undefined ||
    receipt.retentionTick !== receipt.resolvedAt
  ) {
    return false;
  }
  const {
    prevHash: _prevHash,
    eventHash: _eventHash,
    headHash: _headHash,
    ...payload
  } = receipt;
  const expected = sealReceipt(payload, receipt.prevHash);
  return (
    receipt.eventHash === expected.eventHash &&
    receipt.headHash === expected.headHash
  );
}

function confirmedCanaryFromReceipt(
  receipt: MarketBaseResourceReceipt,
): MarketBaseResourceConfirmedCanary | undefined {
  if (receipt.executionPolicy !== "canary" || receipt.status !== "confirmed") {
    return undefined;
  }
  const confirmation = {
    laneId: receipt.laneId,
    attemptSeq: receipt.attemptSeq,
    permitId: receipt.permitId,
    permitEpoch: receipt.permitEpoch,
    evidenceKey: receipt.evidenceKey,
    receiptEventHash: receipt.eventHash,
    confirmedAt: receipt.transactionTime!,
    transactionTime: receipt.transactionTime!,
    actualAmount: receipt.actualAmount,
    actualTransactionEnergy: receipt.actualTransactionEnergy!,
    actualNetCreditsMilli: receipt.actualNetCreditsMilli!,
  };
  return {
    ...confirmation,
    reviewDigest: canonicalStableHashV1({
      domain: "market-base-resource:confirmed-canary-review-v1",
      confirmation,
    }),
  };
}

function validConfirmedCanary(
  value: unknown,
  laneId: string,
  maxAttemptSeq: number,
): value is MarketBaseResourceConfirmedCanary {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "actualAmount",
      "actualNetCreditsMilli",
      "actualTransactionEnergy",
      "attemptSeq",
      "confirmedAt",
      "evidenceKey",
      "laneId",
      "permitEpoch",
      "permitId",
      "receiptEventHash",
      "reviewDigest",
      "transactionTime",
    ]) ||
    value.laneId !== laneId ||
    !isDigest(value.laneId) ||
    !isPositiveSafeInteger(value.attemptSeq) ||
    value.attemptSeq > maxAttemptSeq ||
    !isDigest(value.permitId) ||
    !isPositiveSafeInteger(value.permitEpoch) ||
    !isDigest(value.evidenceKey) ||
    !isDigest(value.receiptEventHash) ||
    !isSafeInteger(value.confirmedAt) ||
    !isSafeInteger(value.transactionTime) ||
    value.transactionTime !== value.confirmedAt ||
    !isPositiveSafeInteger(value.actualAmount) ||
    value.actualAmount > MARKET_BASE_RESOURCE_PLANNED_AMOUNT ||
    !isSafeInteger(value.actualTransactionEnergy) ||
    value.actualTransactionEnergy > 1_000 ||
    !isPositiveSafeInteger(value.actualNetCreditsMilli) ||
    !isDigest(value.reviewDigest)
  ) {
    return false;
  }
  const { reviewDigest: _reviewDigest, ...confirmation } =
    value as unknown as MarketBaseResourceConfirmedCanary;
  return (
    value.reviewDigest ===
    canonicalStableHashV1({
      domain: "market-base-resource:confirmed-canary-review-v1",
      confirmation,
    })
  );
}

function validConfirmedCanaryMap(
  value: unknown,
  maxAttemptSeq: number,
): value is Readonly<Record<string, MarketBaseResourceConfirmedCanary>> {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length <= 112 &&
    Object.entries(value).every(([laneId, confirmation]) =>
      validConfirmedCanary(confirmation, laneId, maxAttemptSeq),
    )
  );
}

function confirmedCanaryCommitment(
  confirmations: Readonly<Record<string, MarketBaseResourceConfirmedCanary>>,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:confirmed-canary-map-v1",
    confirmations,
  });
}

export interface MarketBaseResourceLedgerCounters {
  readonly global: { readonly count: number; readonly amount: number };
  readonly resources: Readonly<
    Record<string, { readonly count: number; readonly amount: number }>
  >;
  readonly rooms: Readonly<
    Record<string, { readonly count: number; readonly amount: number }>
  >;
  readonly lanes: Readonly<
    Record<string, { readonly count: number; readonly amount: number }>
  >;
}

export interface MarketBaseResourceConfirmedCanary {
  readonly laneId: string;
  readonly attemptSeq: number;
  readonly permitId: string;
  readonly permitEpoch: number;
  readonly evidenceKey: string;
  readonly receiptEventHash: string;
  readonly confirmedAt: number;
  readonly transactionTime: number;
  readonly actualAmount: number;
  readonly actualTransactionEnergy: number;
  readonly actualNetCreditsMilli: number;
  readonly reviewDigest: string;
}

/**
 * 一条 lane 只保留最近一次 Canary prepare 的单调高水位。permitId 本身
 * 已经绑定 exact SignedLaneGrant；把 laneId、permit epoch/id 与首次
 * pending hash 一起封存，可以在 receipt 被裁剪后继续证明该 successor
 * 的 one-shot 已被消费。
 */
export interface MarketBaseResourceCanaryAttemptHighWater {
  readonly laneId: string;
  readonly permitId: string;
  readonly permitEpoch: number;
  readonly attemptSeq: number;
  readonly attemptAt: number;
  readonly pendingEvidenceHash: string;
  readonly grantKey: string;
  readonly attemptHash: string;
}

type CanaryAttemptWithoutDerivedHashes = Omit<
  MarketBaseResourceCanaryAttemptHighWater,
  "grantKey" | "attemptHash"
>;

function canaryAttemptGrantKey(
  value: Pick<
    MarketBaseResourceCanaryAttemptHighWater,
    "laneId" | "permitId" | "permitEpoch"
  >,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:canary-attempt-grant-v1",
    laneId: value.laneId,
    permitEpoch: value.permitEpoch,
    permitId: value.permitId,
  });
}

function sealCanaryAttemptHighWater(
  value: CanaryAttemptWithoutDerivedHashes,
): MarketBaseResourceCanaryAttemptHighWater {
  const grantKey = canaryAttemptGrantKey(value);
  const attemptHash = canonicalStableHashV1({
    domain: "market-base-resource:canary-attempt-high-water-v1",
    value: {
      ...value,
      grantKey,
    },
  });
  return {
    ...value,
    grantKey,
    attemptHash,
  };
}

function validCanaryAttemptHighWater(
  value: unknown,
  laneId: string,
  maxAttemptSeq: number,
): value is MarketBaseResourceCanaryAttemptHighWater {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "attemptAt",
      "attemptHash",
      "attemptSeq",
      "grantKey",
      "laneId",
      "pendingEvidenceHash",
      "permitEpoch",
      "permitId",
    ]) ||
    value.laneId !== laneId ||
    !isDigest(value.laneId) ||
    !isDigest(value.permitId) ||
    !isPositiveSafeInteger(value.permitEpoch) ||
    !isPositiveSafeInteger(value.attemptSeq) ||
    value.attemptSeq > maxAttemptSeq ||
    !isSafeInteger(value.attemptAt) ||
    !isDigest(value.pendingEvidenceHash) ||
    !isDigest(value.grantKey) ||
    !isDigest(value.attemptHash)
  ) {
    return false;
  }
  const {
    grantKey: _grantKey,
    attemptHash: _attemptHash,
    ...payload
  } = value as unknown as MarketBaseResourceCanaryAttemptHighWater;
  const sealed = sealCanaryAttemptHighWater(payload);
  return (
    value.grantKey === sealed.grantKey &&
    value.attemptHash === sealed.attemptHash
  );
}

function validCanaryAttemptHighWaterMap(
  value: unknown,
  maxAttemptSeq: number,
): value is Readonly<Record<string, MarketBaseResourceCanaryAttemptHighWater>> {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length <= 112 &&
    Object.entries(value).every(([laneId, attempt]) =>
      validCanaryAttemptHighWater(attempt, laneId, maxAttemptSeq),
    )
  );
}

function canaryAttemptHighWaterCommitment(
  attempts: Readonly<Record<string, MarketBaseResourceCanaryAttemptHighWater>>,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:canary-attempt-high-water-map-v1",
    attempts,
  });
}

const MARKET_BASE_RESOURCE_NO_RETIRED_CANARY_PREFIX = canonicalStableHashV1(
  "market-base-resource:no-retired-canary-prefix-v1",
);
const MARKET_BASE_RESOURCE_RETIRED_CANARY_FILTER_BITS = 8_192;
const MARKET_BASE_RESOURCE_RETIRED_CANARY_FILTER_HEX_LENGTH =
  MARKET_BASE_RESOURCE_RETIRED_CANARY_FILTER_BITS / 4;
const MARKET_BASE_RESOURCE_EMPTY_RETIRED_CANARY_FILTER = "0".repeat(
  MARKET_BASE_RESOURCE_RETIRED_CANARY_FILTER_HEX_LENGTH,
);

function retiredCanaryFilterIndexes(laneId: string): readonly number[] {
  const hash = canonicalStableHashV1({
    domain: "market-base-resource:retired-canary-filter-v1",
    laneId,
  }).slice("csh1:".length);
  return [0, 8, 16, 24].map(
    (offset) =>
      Number.parseInt(hash.slice(offset, offset + 8), 16) %
      MARKET_BASE_RESOURCE_RETIRED_CANARY_FILTER_BITS,
  );
}

function updateRetiredCanaryFilter(filter: string, laneId: string): string {
  const nibbles = filter.split("");
  for (const bitIndex of retiredCanaryFilterIndexes(laneId)) {
    const nibbleIndex = Math.floor(bitIndex / 4);
    nibbles[nibbleIndex] = (
      Number.parseInt(nibbles[nibbleIndex], 16) |
      (1 << (bitIndex % 4))
    ).toString(16);
  }
  return nibbles.join("");
}

export interface MarketBaseResourceRetiredCanaryRecord {
  readonly laneId: string;
  readonly absorbedAtPermitEpoch: number;
  readonly tombstoneDischargeFingerprint: string;
  readonly tombstoneCheckpointCommitment: string;
  readonly attempt: MarketBaseResourceCanaryAttemptHighWater | null;
  readonly confirmed: MarketBaseResourceConfirmedCanary | null;
  readonly recordHash: string;
}

export interface MarketBaseResourceRetiredCanaryCheckpoint {
  readonly compressedCount: number;
  readonly compressedPrefixHead: string;
  readonly compressedRetiredLaneFilter: string;
  readonly laneTombstoneCheckpointCommitment: string;
  readonly retiredCanaries: readonly MarketBaseResourceRetiredCanaryRecord[];
  readonly commitment: string;
}

type RetiredCanaryRecordWithoutHash = Omit<
  MarketBaseResourceRetiredCanaryRecord,
  "recordHash"
>;

function retiredCanaryRecordHash(
  value: RetiredCanaryRecordWithoutHash,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:retired-canary-record-v1",
    value,
  });
}

function sealRetiredCanaryRecord(
  value: RetiredCanaryRecordWithoutHash,
): MarketBaseResourceRetiredCanaryRecord {
  return {
    ...clone(value),
    recordHash: retiredCanaryRecordHash(value),
  };
}

function retiredCanaryCheckpointCommitment(
  checkpoint: Omit<MarketBaseResourceRetiredCanaryCheckpoint, "commitment">,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:retired-canary-checkpoint-v1",
    checkpoint,
  });
}

function sealRetiredCanaryCheckpoint(
  checkpoint: Omit<MarketBaseResourceRetiredCanaryCheckpoint, "commitment">,
): MarketBaseResourceRetiredCanaryCheckpoint {
  return {
    ...clone(checkpoint),
    commitment: retiredCanaryCheckpointCommitment(checkpoint),
  };
}

function emptyRetiredCanaryCheckpoint(
  laneTombstoneCheckpointCommitment: string,
): MarketBaseResourceRetiredCanaryCheckpoint {
  return sealRetiredCanaryCheckpoint({
    compressedCount: 0,
    compressedPrefixHead: MARKET_BASE_RESOURCE_NO_RETIRED_CANARY_PREFIX,
    compressedRetiredLaneFilter:
      MARKET_BASE_RESOURCE_EMPTY_RETIRED_CANARY_FILTER,
    laneTombstoneCheckpointCommitment,
    retiredCanaries: [],
  });
}

function validRetiredCanaryRecord(
  value: unknown,
  maxAttemptSeq: number,
): value is MarketBaseResourceRetiredCanaryRecord {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "absorbedAtPermitEpoch",
      "attempt",
      "confirmed",
      "laneId",
      "recordHash",
      "tombstoneCheckpointCommitment",
      "tombstoneDischargeFingerprint",
    ]) ||
    !isDigest(value.laneId) ||
    !isPositiveSafeInteger(value.absorbedAtPermitEpoch) ||
    !isDigest(value.tombstoneDischargeFingerprint) ||
    !isDigest(value.tombstoneCheckpointCommitment) ||
    !isDigest(value.recordHash) ||
    (value.attempt !== null &&
      !validCanaryAttemptHighWater(
        value.attempt,
        value.laneId,
        maxAttemptSeq,
      )) ||
    (value.confirmed !== null &&
      !validConfirmedCanary(value.confirmed, value.laneId, maxAttemptSeq)) ||
    (value.confirmed !== null && value.attempt === null) ||
    (value.confirmed !== null &&
      value.attempt !== null &&
      (value.confirmed as MarketBaseResourceConfirmedCanary).attemptSeq !==
        (value.attempt as MarketBaseResourceCanaryAttemptHighWater).attemptSeq)
  ) {
    return false;
  }
  const { recordHash: _recordHash, ...payload } =
    value as unknown as MarketBaseResourceRetiredCanaryRecord;
  return value.recordHash === retiredCanaryRecordHash(payload);
}

function validRetiredCanaryCheckpoint(
  value: unknown,
  maxAttemptSeq: number,
): value is MarketBaseResourceRetiredCanaryCheckpoint {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "commitment",
      "compressedCount",
      "compressedPrefixHead",
      "compressedRetiredLaneFilter",
      "laneTombstoneCheckpointCommitment",
      "retiredCanaries",
    ]) ||
    !isSafeInteger(value.compressedCount) ||
    !isDigest(value.compressedPrefixHead) ||
    typeof value.compressedRetiredLaneFilter !== "string" ||
    value.compressedRetiredLaneFilter.length !==
      MARKET_BASE_RESOURCE_RETIRED_CANARY_FILTER_HEX_LENGTH ||
    !/^[0-9a-f]+$/.test(value.compressedRetiredLaneFilter) ||
    !isDigest(value.laneTombstoneCheckpointCommitment) ||
    !Array.isArray(value.retiredCanaries) ||
    value.retiredCanaries.length >
      MARKET_BASE_RESOURCE_RETIRED_CANARY_RING_LIMIT ||
    !isDigest(value.commitment) ||
    (value.compressedCount === 0
      ? value.compressedPrefixHead !==
          MARKET_BASE_RESOURCE_NO_RETIRED_CANARY_PREFIX ||
        value.compressedRetiredLaneFilter !==
          MARKET_BASE_RESOURCE_EMPTY_RETIRED_CANARY_FILTER
      : value.compressedPrefixHead ===
        MARKET_BASE_RESOURCE_NO_RETIRED_CANARY_PREFIX)
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const record of value.retiredCanaries) {
    if (
      !validRetiredCanaryRecord(record, maxAttemptSeq) ||
      seen.has(record.laneId)
    ) {
      return false;
    }
    seen.add(record.laneId);
  }
  const { commitment: _commitment, ...payload } =
    value as unknown as MarketBaseResourceRetiredCanaryCheckpoint;
  return value.commitment === retiredCanaryCheckpointCommitment(payload);
}

function foldRetiredCanaryPrefix(
  checkpoint: MarketBaseResourceRetiredCanaryCheckpoint,
  record: MarketBaseResourceRetiredCanaryRecord,
): Pick<
  MarketBaseResourceRetiredCanaryCheckpoint,
  "compressedCount" | "compressedPrefixHead" | "compressedRetiredLaneFilter"
> {
  const compressedCount = checkpoint.compressedCount + 1;
  return {
    compressedCount,
    compressedPrefixHead: canonicalStableHashV1({
      domain: "market-base-resource:retired-canary-prefix-link-v1",
      compressedCount,
      previousPrefixHead: checkpoint.compressedPrefixHead,
      recordHash: record.recordHash,
    }),
    compressedRetiredLaneFilter: updateRetiredCanaryFilter(
      checkpoint.compressedRetiredLaneFilter,
      record.laneId,
    ),
  };
}

type ApplyCanaryAttemptHighWaterResult =
  | {
      readonly ok: true;
      readonly attempts: Readonly<
        Record<string, MarketBaseResourceCanaryAttemptHighWater>
      >;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "canary_grant_already_attempted"
        | "canary_attempt_high_water_conflict"
        | "canary_attempt_permit_rollback";
    };

function applyCanaryAttemptHighWater(
  attempts: Readonly<Record<string, MarketBaseResourceCanaryAttemptHighWater>>,
  next: MarketBaseResourceCanaryAttemptHighWater,
): ApplyCanaryAttemptHighWaterResult {
  const prior = attempts[next.laneId];
  if (!prior) {
    return {
      ok: true,
      attempts: {
        ...attempts,
        [next.laneId]: next,
      },
    };
  }
  if (sameCanonical(prior, next)) {
    return { ok: true, attempts };
  }
  // Canary 是 laneId lifetime one-shot。successor permit 只能复核或收窄
  // 同一 lane，不能通过提高 epoch/更换 permitId 重新发放一次写机会。
  return { ok: false, reason: "canary_grant_already_attempted" };
}

function canaryAttemptFromPending(
  pending: MarketBaseResourcePendingAttempt,
): MarketBaseResourceCanaryAttemptHighWater | undefined {
  return pending.executionPolicy === "canary"
    ? sealCanaryAttemptHighWater({
        laneId: pending.historicalLane.laneId,
        permitId: pending.historicalPermit.permitId,
        permitEpoch: pending.historicalPermit.permitEpoch,
        attemptSeq: pending.attemptSeq,
        attemptAt: pending.attemptAt,
        pendingEvidenceHash: pending.frozenEvidenceHash,
      })
    : undefined;
}

function canaryAttemptFromReceipt(
  receipt: MarketBaseResourceReceipt,
): MarketBaseResourceCanaryAttemptHighWater | undefined {
  return receipt.executionPolicy === "canary"
    ? sealCanaryAttemptHighWater({
        laneId: receipt.laneId,
        permitId: receipt.permitId,
        permitEpoch: receipt.permitEpoch,
        attemptSeq: receipt.attemptSeq,
        attemptAt: receipt.attemptAt,
        pendingEvidenceHash: receipt.pendingEvidenceHash,
      })
    : undefined;
}

export interface MarketBaseResourceLegacyV2ConfirmedCanary {
  readonly entryId: string;
  readonly attemptSeq: number;
  readonly executionPolicy: "legacy_canary_seed" | "canary";
  readonly evidenceKey: string;
  readonly receiptEventHash: string;
  readonly reviewedEvidenceDigest: string;
}

function validLegacyV2ConfirmedCanaryMap(
  value: unknown,
  maxAttemptSeq: number,
): value is Readonly<
  Record<string, MarketBaseResourceLegacyV2ConfirmedCanary>
> {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length <= 16 &&
    Object.entries(value).every(([entryId, confirmation]) => {
      if (
        !isPlainRecord(confirmation) ||
        !exactKeys(confirmation, [
          "attemptSeq",
          "entryId",
          "evidenceKey",
          "executionPolicy",
          "receiptEventHash",
          "reviewedEvidenceDigest",
        ])
      ) {
        return false;
      }
      return (
        confirmation.entryId === entryId &&
        isBoundedString(entryId, 128) &&
        isPositiveSafeInteger(confirmation.attemptSeq) &&
        confirmation.attemptSeq <= maxAttemptSeq &&
        (confirmation.executionPolicy === "legacy_canary_seed" ||
          confirmation.executionPolicy === "canary") &&
        isDigest(confirmation.evidenceKey) &&
        isDigest(confirmation.receiptEventHash) &&
        isDigest(confirmation.reviewedEvidenceDigest)
      );
    })
  );
}

function legacyV2ConfirmedCanaryCommitment(
  confirmedCanaries: Readonly<
    Record<string, MarketBaseResourceLegacyV2ConfirmedCanary>
  >,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:legacy-v2-confirmed-canary-high-water-v1",
    confirmedCanaries,
  });
}

export interface MarketBaseResourcePermitChainAnchor {
  readonly permitEpochHighWater: number;
  readonly currentPermitId: string;
  readonly permitChainHeadHighWater: string;
  readonly totalChainLength: number;
  readonly prefixCommitment: string;
  readonly laneTombstoneCheckpointCommitment: string;
  readonly v2CutoverCheckpointHash: string;
  readonly ratchetHighWater: readonly MarketBaseResourceRatchetHighWater[];
  readonly ratchetHighWaterCommitment: string;
  readonly anchorHash: string;
}

function permitChainAnchorPayload(
  anchor: Omit<MarketBaseResourcePermitChainAnchor, "anchorHash">,
): unknown {
  return {
    domain: "market-base-resource:permit-chain-anchor-v1",
    anchor,
  };
}

export function buildMarketBaseResourcePermitChainAnchor(
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourcePermitChainAnchor {
  const validation = validateMarketBaseResourcePermitChain(permitChain);
  const current =
    permitChain.retainedPermits[permitChain.retainedPermits.length - 1];
  if (
    !validation.ok ||
    !hasAcceptedMarketBaseResourceV3Successor(permitChain) ||
    !current ||
    current.schemaVersion !== 3 ||
    !permitChain.v2EventCutoverCheckpoint
  ) {
    throw new TypeError("invalid permit chain anchor basis");
  }
  const payload = {
    permitEpochHighWater: permitChain.permitEpochHighWater,
    currentPermitId: permitChain.currentPermitId,
    permitChainHeadHighWater: permitChain.permitChainHeadHighWater,
    totalChainLength: permitChain.totalChainLength,
    prefixCommitment: permitChain.prefixCheckpoint.prefixCommitment,
    laneTombstoneCheckpointCommitment:
      permitChain.laneTombstoneCheckpoint.checkpointCommitment,
    v2CutoverCheckpointHash:
      permitChain.v2EventCutoverCheckpoint.checkpointHash,
    ratchetHighWater: clone(current.ratchetHighWater),
    ratchetHighWaterCommitment: canonicalStableHashV1({
      domain: "market-base-resource:ratchet-high-water-map-v1",
      entries: current.ratchetHighWater,
    }),
  };
  return deepFreeze({
    ...payload,
    anchorHash: canonicalStableHashV1(permitChainAnchorPayload(payload)),
  }) as MarketBaseResourcePermitChainAnchor;
}

function validPermitChainAnchor(
  value: unknown,
): value is MarketBaseResourcePermitChainAnchor {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "anchorHash",
      "currentPermitId",
      "permitChainHeadHighWater",
      "permitEpochHighWater",
      "prefixCommitment",
      "laneTombstoneCheckpointCommitment",
      "ratchetHighWater",
      "ratchetHighWaterCommitment",
      "totalChainLength",
      "v2CutoverCheckpointHash",
    ]) ||
    !isPositiveSafeInteger(value.permitEpochHighWater) ||
    value.totalChainLength !== value.permitEpochHighWater ||
    !isDigest(value.currentPermitId) ||
    !isDigest(value.permitChainHeadHighWater) ||
    !isDigest(value.prefixCommitment) ||
    !isDigest(value.laneTombstoneCheckpointCommitment) ||
    !isDigest(value.v2CutoverCheckpointHash) ||
    !Array.isArray(value.ratchetHighWater) ||
    !validateMarketBaseResourceRatchetHighWater(
      value.ratchetHighWater as readonly MarketBaseResourceRatchetHighWater[],
    ) ||
    !isDigest(value.ratchetHighWaterCommitment) ||
    !isDigest(value.anchorHash)
  ) {
    return false;
  }
  const { anchorHash: _anchorHash, ...payload } =
    value as unknown as MarketBaseResourcePermitChainAnchor;
  return (
    value.ratchetHighWaterCommitment ===
      canonicalStableHashV1({
        domain: "market-base-resource:ratchet-high-water-map-v1",
        entries: value.ratchetHighWater,
      }) &&
    value.anchorHash ===
      canonicalStableHashV1(permitChainAnchorPayload(payload))
  );
}

export interface MarketBaseResourcePermitAnchorValidation {
  readonly ok: boolean;
  readonly reason?: string;
}

function ratchetHighWaterDominates(
  current: readonly MarketBaseResourceRatchetHighWater[],
  anchored: readonly MarketBaseResourceRatchetHighWater[],
): boolean {
  if (
    !validateMarketBaseResourceRatchetHighWater(current) ||
    !validateMarketBaseResourceRatchetHighWater(anchored) ||
    current.length !== anchored.length
  ) {
    return false;
  }
  return current.every((entry, index) => {
    const prior = anchored[index];
    return (
      entry.resource === prior.resource &&
      entry.ratchetFloor >= prior.ratchetFloor &&
      entry.observedAt >= prior.observedAt &&
      (entry.ratchetFloor > prior.ratchetFloor || sameCanonical(entry, prior))
    );
  });
}

/**
 * 当前 permit chain 可以在 WAL 空闲时继续晋级，但绝不能落后于账本已经
 * 持久化的许可锚点。尚未被 prefix 吸收的锚定 epoch 必须保留完全相同的
 * permit id/head；一旦被吸收，则 prefix 的 pruned high-water 必须严格越过
 * 它。ratchet 高水位始终只能保持或提高。
 */
export function validateMarketBaseResourcePermitChainDominatesAnchor(
  permitChain: MarketBaseResourcePermitChainState,
  anchor: MarketBaseResourcePermitChainAnchor,
): MarketBaseResourcePermitAnchorValidation {
  const chainValidation = validateMarketBaseResourcePermitChain(permitChain);
  if (!chainValidation.ok) {
    return {
      ok: false,
      reason: chainValidation.reason ?? "ledger_permit_chain_invalid",
    };
  }
  if (!validPermitChainAnchor(anchor)) {
    return { ok: false, reason: "ledger_permit_anchor_invalid" };
  }
  if (
    permitChain.permitEpochHighWater < anchor.permitEpochHighWater ||
    permitChain.totalChainLength < anchor.totalChainLength ||
    permitChain.v2EventCutoverCheckpoint?.checkpointHash !==
      anchor.v2CutoverCheckpointHash
  ) {
    return { ok: false, reason: "ledger_permit_anchor_rollback" };
  }
  if (
    permitChain.permitEpochHighWater === anchor.permitEpochHighWater &&
    permitChain.laneTombstoneCheckpoint.checkpointCommitment !==
      anchor.laneTombstoneCheckpointCommitment
  ) {
    return {
      ok: false,
      reason: "ledger_permit_tombstone_anchor_mismatch",
    };
  }

  const anchoredPrunedThrough = Math.max(
    0,
    anchor.totalChainLength - MARKET_BASE_RESOURCE_PERMIT_SUFFIX_LIMIT,
  );
  if (
    permitChain.prefixCheckpoint.prunedThroughEpoch < anchoredPrunedThrough ||
    (permitChain.prefixCheckpoint.prunedThroughEpoch ===
      anchoredPrunedThrough &&
      permitChain.prefixCheckpoint.prefixCommitment !== anchor.prefixCommitment)
  ) {
    return {
      ok: false,
      reason: "ledger_permit_prefix_anchor_rollback",
    };
  }

  const anchoredRecord = permitChain.retainedPermits.find(
    (record) => record.epoch === anchor.permitEpochHighWater,
  );
  if (anchoredRecord) {
    if (
      anchoredRecord.schemaVersion !== 3 ||
      anchoredRecord.permitId !== anchor.currentPermitId ||
      anchoredRecord.permitHead !== anchor.permitChainHeadHighWater ||
      !sameCanonical(anchoredRecord.ratchetHighWater, anchor.ratchetHighWater)
    ) {
      return {
        ok: false,
        reason: "ledger_permit_ancestor_mismatch",
      };
    }
  } else if (
    permitChain.prefixCheckpoint.prunedThroughEpoch ===
    anchor.permitEpochHighWater
  ) {
    if (
      permitChain.prefixCheckpoint.lastPrunedPermitId !==
        anchor.currentPermitId ||
      permitChain.prefixCheckpoint.lastPrunedPermitHead !==
        anchor.permitChainHeadHighWater ||
      !sameCanonical(
        permitChain.prefixCheckpoint.ratchetHighWater,
        anchor.ratchetHighWater,
      )
    ) {
      return {
        ok: false,
        reason: "ledger_permit_ancestor_mismatch",
      };
    }
  } else if (
    permitChain.prefixCheckpoint.prunedThroughEpoch <
    anchor.permitEpochHighWater
  ) {
    return {
      ok: false,
      reason: "ledger_permit_ancestor_missing",
    };
  } else {
    return {
      ok: false,
      reason: "ledger_permit_anchor_compacted_without_rebind",
    };
  }

  const current =
    permitChain.retainedPermits[permitChain.retainedPermits.length - 1];
  if (
    !current ||
    current.schemaVersion !== 3 ||
    !ratchetHighWaterDominates(
      current.ratchetHighWater,
      anchor.ratchetHighWater,
    )
  ) {
    return {
      ok: false,
      reason: "ledger_permit_ratchet_anchor_rollback",
    };
  }
  if (
    permitChain.permitEpochHighWater === anchor.permitEpochHighWater &&
    (permitChain.currentPermitId !== anchor.currentPermitId ||
      permitChain.permitChainHeadHighWater !== anchor.permitChainHeadHighWater)
  ) {
    return {
      ok: false,
      reason: "ledger_permit_tip_anchor_mismatch",
    };
  }
  return { ok: true };
}

export interface MarketBaseResourceLedgerCheckpoint {
  readonly prunedThroughAttemptSeq: number;
  readonly prunedReceiptHeadHash: string;
  readonly coverageStartTick: number;
  readonly retryNotBeforeHighWater: number;
  readonly confirmedCooldownNotBeforeHighWater: number;
  readonly legacyQuotaReceiptCommitment: string;
  readonly canaryAttemptHighWater: Readonly<
    Record<string, MarketBaseResourceCanaryAttemptHighWater>
  >;
  readonly canaryAttemptHighWaterCommitment: string;
  readonly confirmedCanaries: Readonly<
    Record<string, MarketBaseResourceConfirmedCanary>
  >;
  readonly confirmedCanaryCommitment: string;
  readonly retiredCanaryCheckpoint: MarketBaseResourceRetiredCanaryCheckpoint;
  readonly legacyV2ConfirmedCanaries: Readonly<
    Record<string, MarketBaseResourceLegacyV2ConfirmedCanary>
  >;
  readonly legacyV2ConfirmedCanaryCommitment: string;
  readonly lifetimeConfirmed: MarketBaseResourceLedgerCounters;
  readonly permitAnchor: MarketBaseResourcePermitChainAnchor;
  readonly checkpointHash: string;
}

export interface MarketBaseResourceTerminalSlotReservation {
  readonly attemptSeq: number;
  readonly outcomeSlotReserved: true;
  readonly receiptSlotReserved: true;
}

export interface MarketBaseResourceLedgerBlocker {
  readonly code: string;
  readonly detectedAt: number;
  readonly detailHash: string;
}

export interface MarketBaseResourceLedger {
  readonly schemaVersion: 3;
  readonly hashRevision: typeof MARKET_BASE_RESOURCE_LEDGER_HASH_REVISION;
  readonly coverageStartTick: number;
  readonly receiptHeadHash: string;
  readonly finalizedAttemptSeq: number;
  readonly nextAttemptSeq: number;
  readonly receipts: readonly MarketBaseResourceReceipt[];
  readonly legacyQuotaReceipts: readonly MarketBaseResourceQuotaReceipt[];
  readonly outcomes: readonly MarketBaseResourceOutcome[];
  readonly processedEvidenceKeys: readonly {
    readonly attemptSeq: number;
    readonly key: string;
  }[];
  readonly checkpoint: MarketBaseResourceLedgerCheckpoint;
  readonly permitAnchor: MarketBaseResourcePermitChainAnchor;
  readonly lifetimeConfirmed: MarketBaseResourceLedgerCounters;
  readonly legacyV2ConfirmedCanaries: Readonly<
    Record<string, MarketBaseResourceLegacyV2ConfirmedCanary>
  >;
  readonly canaryAttemptHighWater: Readonly<
    Record<string, MarketBaseResourceCanaryAttemptHighWater>
  >;
  readonly confirmedCanaries: Readonly<
    Record<string, MarketBaseResourceConfirmedCanary>
  >;
  readonly pending?: MarketBaseResourcePendingAttempt;
  readonly terminalSlotReservation?: MarketBaseResourceTerminalSlotReservation;
  readonly retryNotBefore: number;
  readonly confirmedCooldownNotBefore: number;
  readonly blocker?: MarketBaseResourceLedgerBlocker;
}

function emptyCounters(): MarketBaseResourceLedgerCounters {
  return {
    global: { count: 0, amount: 0 },
    resources: {},
    rooms: {},
    lanes: {},
  };
}

function validCounterBucket(
  value: unknown,
): value is { readonly count: number; readonly amount: number } {
  return (
    isPlainRecord(value) &&
    exactKeys(value, ["amount", "count"]) &&
    isSafeInteger(value.count) &&
    isSafeInteger(value.amount)
  );
}

function validCounterMap(
  value: unknown,
  maxKeys: number,
): value is Readonly<
  Record<string, { readonly count: number; readonly amount: number }>
> {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length <= maxKeys &&
    Object.entries(value).every(
      ([key, counter]) =>
        isBoundedString(key, 128) && validCounterBucket(counter),
    )
  );
}

function validCounters(
  value: unknown,
): value is MarketBaseResourceLedgerCounters {
  return (
    isPlainRecord(value) &&
    exactKeys(value, ["global", "lanes", "resources", "rooms"]) &&
    validCounterBucket(value.global) &&
    validCounterMap(value.resources, 7) &&
    validCounterMap(value.rooms, 32) &&
    validCounterMap(value.lanes, 224)
  );
}

function addCounters(
  base: MarketBaseResourceLedgerCounters,
  delta: MarketBaseResourceLedgerCounters,
): MarketBaseResourceLedgerCounters {
  let result = clone(base);
  const addMap = (
    target: keyof Pick<
      MarketBaseResourceLedgerCounters,
      "resources" | "rooms" | "lanes"
    >,
  ): void => {
    const nextMap = {
      ...result[target],
    } as Record<string, { count: number; amount: number }>;
    for (const [key, counter] of Object.entries(delta[target])) {
      const prior = nextMap[key] ?? { count: 0, amount: 0 };
      nextMap[key] = {
        count: prior.count + counter.count,
        amount: prior.amount + counter.amount,
      };
    }
    result = {
      ...result,
      [target]: nextMap,
    };
  };
  addMap("resources");
  addMap("rooms");
  addMap("lanes");
  return {
    ...result,
    global: {
      count: base.global.count + delta.global.count,
      amount: base.global.amount + delta.global.amount,
    },
  };
}

function checkpointHash(
  checkpoint: Omit<MarketBaseResourceLedgerCheckpoint, "checkpointHash">,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:ledger-checkpoint-v1",
    checkpoint,
  });
}

function legacyQuotaReceiptCommitment(
  receipts: readonly MarketBaseResourceQuotaReceipt[],
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:legacy-quota-receipts-v1",
    receipts,
  });
}

export interface MarketBaseResourceAuthenticatedV2LedgerMigrationBasis {
  readonly schemaVersion: 3;
  readonly hashRevision: "market-base-resource-v2-ledger-migration-v1";
  readonly authenticated: true;
  readonly cutoverCheckpoint: MarketBaseResourceV2EventCutoverCheckpoint;
  readonly quotaCoverageStartTick: number;
  readonly quotaCoverageCompleteThroughAttemptSeq: number;
  readonly v2PrunedThroughAttemptSeq: 0;
  readonly legacyQuotaReceipts: readonly MarketBaseResourceQuotaReceipt[];
  readonly legacyV2ConfirmedCanaries: Readonly<
    Record<string, MarketBaseResourceLegacyV2ConfirmedCanary>
  >;
  readonly legacyV2ConfirmedCanaryCommitment: string;
  readonly lifetimeConfirmed: MarketBaseResourceLedgerCounters;
  readonly confirmedCooldownNotBefore: number;
  readonly retryNotBefore: number;
  readonly migrationCommitment: string;
}

type V2MigrationBasisWithoutCommitment = Omit<
  MarketBaseResourceAuthenticatedV2LedgerMigrationBasis,
  "migrationCommitment"
>;

function v2MigrationBasisCommitment(
  basis: V2MigrationBasisWithoutCommitment,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:v2-ledger-migration-v1",
    basis,
  });
}

function validateV2MigrationBasis(
  value: unknown,
  tick: number,
): value is MarketBaseResourceAuthenticatedV2LedgerMigrationBasis {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "authenticated",
      "confirmedCooldownNotBefore",
      "cutoverCheckpoint",
      "hashRevision",
      "legacyQuotaReceipts",
      "legacyV2ConfirmedCanaries",
      "legacyV2ConfirmedCanaryCommitment",
      "lifetimeConfirmed",
      "migrationCommitment",
      "quotaCoverageCompleteThroughAttemptSeq",
      "quotaCoverageStartTick",
      "retryNotBefore",
      "schemaVersion",
      "v2PrunedThroughAttemptSeq",
    ])
  ) {
    return false;
  }
  const basis =
    value as unknown as MarketBaseResourceAuthenticatedV2LedgerMigrationBasis;
  if (
    basis.schemaVersion !== 3 ||
    basis.hashRevision !== "market-base-resource-v2-ledger-migration-v1" ||
    basis.authenticated !== true ||
    !validateMarketBaseResourceV2EventCutoverCheckpoint(
      basis.cutoverCheckpoint,
    ) ||
    basis.cutoverCheckpoint.lastV2AttemptSeq !==
      basis.cutoverCheckpoint.lastV2OutcomeSeq ||
    !isSafeInteger(basis.quotaCoverageStartTick) ||
    basis.quotaCoverageStartTick !==
      Math.max(0, tick - (MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS - 1)) ||
    basis.quotaCoverageCompleteThroughAttemptSeq !==
      basis.cutoverCheckpoint.lastV2OutcomeSeq ||
    basis.v2PrunedThroughAttemptSeq !== 0 ||
    !Array.isArray(basis.legacyQuotaReceipts) ||
    basis.legacyQuotaReceipts.length >
      MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT ||
    !validCounters(basis.lifetimeConfirmed) ||
    !validLegacyV2ConfirmedCanaryMap(
      basis.legacyV2ConfirmedCanaries,
      basis.cutoverCheckpoint.lastV2OutcomeSeq,
    ) ||
    !isDigest(basis.legacyV2ConfirmedCanaryCommitment) ||
    basis.legacyV2ConfirmedCanaryCommitment !==
      legacyV2ConfirmedCanaryCommitment(basis.legacyV2ConfirmedCanaries) ||
    !isSafeInteger(basis.confirmedCooldownNotBefore) ||
    !isSafeInteger(basis.retryNotBefore) ||
    !isDigest(basis.migrationCommitment)
  ) {
    return false;
  }
  if (
    basis.legacyQuotaReceipts.length !==
      basis.cutoverCheckpoint.lastV2OutcomeSeq ||
    basis.legacyQuotaReceipts.some(
      (receipt, index) => receipt.attemptSeq !== index + 1,
    )
  ) {
    return false;
  }
  const attempts = new Set<number>();
  const evidence = new Set<string>();
  if (
    basis.legacyQuotaReceipts.some(
      (receipt) =>
        receipt.sourceVersion !== 2 ||
        !validQuotaReceipt(receipt) ||
        receipt.attemptSeq > basis.quotaCoverageCompleteThroughAttemptSeq ||
        attempts.has(receipt.attemptSeq) ||
        evidence.has(receipt.evidenceKey) ||
        (attempts.add(receipt.attemptSeq), false) ||
        (evidence.add(receipt.evidenceKey), false),
    )
  ) {
    return false;
  }
  const derivedConfirmedCooldownNotBefore = basis.legacyQuotaReceipts.reduce(
    (highWater, receipt) =>
      receipt.status === "confirmed" && receipt.transactionTime !== undefined
        ? Math.max(
            highWater,
            receipt.transactionTime +
              MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
          )
        : highWater,
    0,
  );
  const derivedRetryNotBefore = basis.legacyQuotaReceipts.reduce(
    (highWater, receipt) =>
      receipt.status === "confirmed"
        ? highWater
        : Math.max(
            highWater,
            receipt.resolvedAt + MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS,
          ),
    0,
  );
  if (
    basis.confirmedCooldownNotBefore !== derivedConfirmedCooldownNotBefore ||
    basis.retryNotBefore < derivedRetryNotBefore
  ) {
    return false;
  }
  const recomputedLifetime = basis.legacyQuotaReceipts.reduce(
    (counters, receipt) =>
      receipt.status === "confirmed"
        ? addCounter(
            counters,
            receipt.resource,
            receipt.sellerRoom,
            receipt.actualAmount,
          )
        : counters,
    emptyCounters(),
  );
  if (
    !sameCanonical(recomputedLifetime, basis.lifetimeConfirmed) ||
    Object.values(basis.legacyV2ConfirmedCanaries).some(
      (confirmation) =>
        basis.legacyQuotaReceipts[confirmation.attemptSeq - 1]?.status !==
        "confirmed",
    )
  ) {
    return false;
  }
  const { migrationCommitment: _commitment, ...payload } = basis;
  return basis.migrationCommitment === v2MigrationBasisCommitment(payload);
}

export function buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis(input: {
  readonly tick: number;
  readonly cutoverCheckpoint: MarketBaseResourceV2EventCutoverCheckpoint;
  readonly v2PrunedThroughAttemptSeq: number;
  readonly legacyQuotaReceipts: readonly MarketBaseResourceQuotaReceipt[];
  readonly legacyV2ConfirmedCanaries: Readonly<
    Record<string, MarketBaseResourceLegacyV2ConfirmedCanary>
  >;
  readonly lifetimeConfirmed: MarketBaseResourceLedgerCounters;
  readonly retryNotBefore: number;
  readonly authenticated: true;
}): MarketBaseResourceAuthenticatedV2LedgerMigrationBasis {
  if (input.v2PrunedThroughAttemptSeq !== 0) {
    throw new TypeError("v2_migration_room_lane_history_incomplete");
  }
  const payload: V2MigrationBasisWithoutCommitment = {
    schemaVersion: 3,
    hashRevision: "market-base-resource-v2-ledger-migration-v1",
    authenticated: input.authenticated,
    cutoverCheckpoint: clone(input.cutoverCheckpoint),
    quotaCoverageStartTick: Math.max(
      0,
      input.tick - (MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS - 1),
    ),
    quotaCoverageCompleteThroughAttemptSeq:
      input.cutoverCheckpoint.lastV2OutcomeSeq,
    v2PrunedThroughAttemptSeq: 0,
    legacyQuotaReceipts: clone(input.legacyQuotaReceipts),
    legacyV2ConfirmedCanaries: clone(input.legacyV2ConfirmedCanaries),
    legacyV2ConfirmedCanaryCommitment: legacyV2ConfirmedCanaryCommitment(
      input.legacyV2ConfirmedCanaries,
    ),
    lifetimeConfirmed: clone(input.lifetimeConfirmed),
    confirmedCooldownNotBefore: input.legacyQuotaReceipts.reduce(
      (highWater, receipt) =>
        receipt.status === "confirmed" && receipt.transactionTime !== undefined
          ? Math.max(
              highWater,
              receipt.transactionTime +
                MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
            )
          : highWater,
      0,
    ),
    retryNotBefore: input.retryNotBefore,
  };
  const basis = {
    ...payload,
    migrationCommitment: v2MigrationBasisCommitment(payload),
  };
  if (!validateV2MigrationBasis(basis, input.tick)) {
    throw new TypeError("invalid authenticated v2 ledger migration basis");
  }
  return deepFreeze(
    basis,
  ) as MarketBaseResourceAuthenticatedV2LedgerMigrationBasis;
}

export function createMarketBaseResourceLedger(input: {
  readonly tick: number;
  readonly permitChain: MarketBaseResourcePermitChainState;
  readonly migrationBasis: MarketBaseResourceAuthenticatedV2LedgerMigrationBasis;
}): MarketBaseResourceLedger {
  const basis = input.migrationBasis;
  if (!validateV2MigrationBasis(basis, input.tick)) {
    throw new TypeError("invalid authenticated v2 ledger migration basis");
  }
  const permitAnchor = buildMarketBaseResourcePermitChainAnchor(
    input.permitChain,
  );
  const current =
    input.permitChain.retainedPermits[
      input.permitChain.retainedPermits.length - 1
    ];
  if (
    !current ||
    current.schemaVersion !== 3 ||
    current.previousLedgerHead !== basis.cutoverCheckpoint.v2ReceiptHeadHash ||
    input.permitChain.v2EventCutoverCheckpoint?.checkpointHash !==
      basis.cutoverCheckpoint.checkpointHash
  ) {
    throw new TypeError("permit/ledger cutover binding mismatch");
  }
  const finalizedAttemptSeq = basis.cutoverCheckpoint.lastV2OutcomeSeq;
  const nextAttemptSeq = basis.cutoverCheckpoint.lastV2AttemptSeq + 1;
  const lifetimeConfirmed = clone(basis.lifetimeConfirmed);
  const legacyQuotaReceipts = clone(basis.legacyQuotaReceipts);
  const legacyV2ConfirmedCanaries = clone(basis.legacyV2ConfirmedCanaries);
  const coverageStartTick = basis.quotaCoverageStartTick;
  const retryNotBefore = basis.retryNotBefore;
  const confirmedCanaries: Readonly<
    Record<string, MarketBaseResourceConfirmedCanary>
  > = {};
  const canaryAttemptHighWater: Readonly<
    Record<string, MarketBaseResourceCanaryAttemptHighWater>
  > = {};
  const retiredCanaryCheckpoint = emptyRetiredCanaryCheckpoint(
    permitAnchor.laneTombstoneCheckpointCommitment,
  );
  if (
    !isSafeInteger(input.tick) ||
    !isDigest(basis.cutoverCheckpoint.v2ReceiptHeadHash) ||
    !isPositiveSafeInteger(nextAttemptSeq) ||
    !isSafeInteger(finalizedAttemptSeq) ||
    nextAttemptSeq !== finalizedAttemptSeq + 1 ||
    !isSafeInteger(retryNotBefore) ||
    !validCounters(lifetimeConfirmed) ||
    legacyQuotaReceipts.length > MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT ||
    !validateV2MigrationBasis(basis, input.tick)
  ) {
    throw new TypeError("invalid v3 ledger migration basis");
  }
  const checkpointWithoutHash = {
    prunedThroughAttemptSeq: finalizedAttemptSeq,
    prunedReceiptHeadHash: basis.cutoverCheckpoint.v2ReceiptHeadHash,
    coverageStartTick,
    retryNotBeforeHighWater: retryNotBefore,
    confirmedCooldownNotBeforeHighWater: basis.confirmedCooldownNotBefore,
    legacyQuotaReceiptCommitment:
      legacyQuotaReceiptCommitment(legacyQuotaReceipts),
    canaryAttemptHighWater,
    canaryAttemptHighWaterCommitment: canaryAttemptHighWaterCommitment(
      canaryAttemptHighWater,
    ),
    confirmedCanaries,
    confirmedCanaryCommitment: confirmedCanaryCommitment(confirmedCanaries),
    retiredCanaryCheckpoint,
    legacyV2ConfirmedCanaries,
    legacyV2ConfirmedCanaryCommitment: legacyV2ConfirmedCanaryCommitment(
      legacyV2ConfirmedCanaries,
    ),
    lifetimeConfirmed,
    permitAnchor,
  };
  return deepFreeze({
    schemaVersion: 3 as const,
    hashRevision: MARKET_BASE_RESOURCE_LEDGER_HASH_REVISION,
    coverageStartTick,
    receiptHeadHash: basis.cutoverCheckpoint.v2ReceiptHeadHash,
    finalizedAttemptSeq,
    nextAttemptSeq,
    receipts: [],
    legacyQuotaReceipts,
    outcomes: [],
    processedEvidenceKeys: [],
    checkpoint: {
      ...checkpointWithoutHash,
      checkpointHash: checkpointHash(checkpointWithoutHash),
    },
    permitAnchor,
    lifetimeConfirmed,
    legacyV2ConfirmedCanaries,
    canaryAttemptHighWater,
    confirmedCanaries,
    retryNotBefore,
    confirmedCooldownNotBefore: basis.confirmedCooldownNotBefore,
  }) as MarketBaseResourceLedger;
}

function compactRetiredCanariesForPermitRebind(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedger {
  const checkpointAttemptMap = clone(
    state.checkpoint.canaryAttemptHighWater,
  ) as Record<string, MarketBaseResourceCanaryAttemptHighWater>;
  const checkpointConfirmedMap = clone(
    state.checkpoint.confirmedCanaries,
  ) as Record<string, MarketBaseResourceConfirmedCanary>;
  const attemptMap = clone(state.canaryAttemptHighWater) as Record<
    string,
    MarketBaseResourceCanaryAttemptHighWater
  >;
  const confirmedMap = clone(state.confirmedCanaries) as Record<
    string,
    MarketBaseResourceConfirmedCanary
  >;
  let retired = clone(state.checkpoint.retiredCanaryCheckpoint);
  let records = [...retired.retiredCanaries];
  const recordByLane = new Map(
    records.map((record) => [record.laneId, record] as const),
  );
  const retainedCanaryLaneIds = new Set(
    state.receipts
      .filter((receipt) => receipt.executionPolicy === "canary")
      .map((receipt) => receipt.laneId),
  );
  if (state.pending?.executionPolicy === "canary") {
    retainedCanaryLaneIds.add(state.pending.historicalLane.laneId);
  }

  const foldOldestEligible = (): boolean => {
    const index = records.findIndex(
      (record) =>
        record.confirmed === null && !retainedCanaryLaneIds.has(record.laneId),
    );
    if (index < 0) return false;
    const record = records[index];
    const folded = foldRetiredCanaryPrefix(retired, record);
    retired = {
      ...retired,
      ...folded,
      retiredCanaries: records,
    };
    records = [...records.slice(0, index), ...records.slice(index + 1)];
    recordByLane.delete(record.laneId);
    return true;
  };

  const tombstones = new Map(
    permitChain.laneTombstoneCheckpoint.dischargedTombstones.map(
      (entry) => [entry.laneId, entry] as const,
    ),
  );
  const candidateLaneIds = new Set([
    ...Object.keys(attemptMap),
    ...Object.keys(confirmedMap),
  ]);
  for (const laneId of [...candidateLaneIds].sort()) {
    const tombstone = tombstones.get(laneId);
    if (!tombstone) continue;
    if (state.pending?.historicalLane.laneId === laneId) {
      throw new TypeError("cannot retire active pending canary");
    }
    const attempt = attemptMap[laneId] ?? null;
    const confirmed = confirmedMap[laneId] ?? null;
    // compressedRetiredLaneFilter 仅是 committed telemetry，Bloom
    // mayContain 有假阳性，绝不能据此拒绝新 lane 或删除事实。是否可退休只
    // 由 permit exact dischargedTombstones 与当前 exact facts 联合决定。
    const existing = recordByLane.get(laneId);
    const nextRecord = sealRetiredCanaryRecord({
      laneId,
      absorbedAtPermitEpoch: permitChain.permitEpochHighWater,
      tombstoneDischargeFingerprint: tombstone.dischargeFingerprint,
      tombstoneCheckpointCommitment:
        permitChain.laneTombstoneCheckpoint.checkpointCommitment,
      attempt,
      confirmed,
    });
    if (existing) {
      if (
        (attempt !== null && !sameCanonical(existing.attempt, attempt)) ||
        (confirmed !== null && !sameCanonical(existing.confirmed, confirmed))
      ) {
        throw new TypeError("retired canary fact conflict");
      }
    } else {
      while (records.length >= MARKET_BASE_RESOURCE_RETIRED_CANARY_RING_LIMIT) {
        if (!foldOldestEligible()) {
          throw new TypeError("retired canary checkpoint ring full");
        }
      }
      records.push(nextRecord);
      recordByLane.set(laneId, nextRecord);
    }
    delete attemptMap[laneId];
    delete confirmedMap[laneId];
    delete checkpointAttemptMap[laneId];
    delete checkpointConfirmedMap[laneId];
  }

  // 没有 confirmed 事实的退休 lane 已由 permit tombstone exact discharge
  // 和 retired prefix/filter 双重认证；receipt/pending pin 消失后即可折叠，
  // one-shot 不会复活。confirmed facts 永久留在 exact ring；若 512 格全部
  // 都是 confirmed，则 fail closed，不能为容量静默牺牲独立复审证据。
  const factsToRetain: MarketBaseResourceRetiredCanaryRecord[] = [];
  for (const record of records) {
    if (
      record.confirmed === null &&
      !retainedCanaryLaneIds.has(record.laneId)
    ) {
      const folded = foldRetiredCanaryPrefix(retired, record);
      retired = {
        ...retired,
        ...folded,
      };
      recordByLane.delete(record.laneId);
    } else {
      factsToRetain.push(record);
    }
  }
  records = factsToRetain;

  retired = sealRetiredCanaryCheckpoint({
    compressedCount: retired.compressedCount,
    compressedPrefixHead: retired.compressedPrefixHead,
    compressedRetiredLaneFilter: retired.compressedRetiredLaneFilter,
    laneTombstoneCheckpointCommitment:
      permitChain.laneTombstoneCheckpoint.checkpointCommitment,
    retiredCanaries: records,
  });
  const { checkpointHash: _checkpointHash, ...checkpointPayload } =
    state.checkpoint;
  const nextCheckpointPayload = {
    ...clone(checkpointPayload),
    canaryAttemptHighWater: checkpointAttemptMap,
    canaryAttemptHighWaterCommitment:
      canaryAttemptHighWaterCommitment(checkpointAttemptMap),
    confirmedCanaries: checkpointConfirmedMap,
    confirmedCanaryCommitment: confirmedCanaryCommitment(
      checkpointConfirmedMap,
    ),
    retiredCanaryCheckpoint: retired,
  };
  return {
    ...clone(state),
    canaryAttemptHighWater: attemptMap,
    confirmedCanaries: confirmedMap,
    checkpoint: {
      ...nextCheckpointPayload,
      checkpointHash: checkpointHash(nextCheckpointPayload),
    },
  };
}

/**
 * permit successor 已原子签收且 WAL 空闲后，把 ledger 的 permit anchor
 * 前移到当前链 tip。调用方必须把更新后的 permit chain 与返回 ledger 放在
 * 同一个 runtime-state 提交中；这样旧 anchor 在进入 64-epoch prefix 前
 * 已被新锚点替代，不能用“prefix 数字更大”冒充祖先证明。
 */
export function rebindMarketBaseResourceLedgerPermitAnchor(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedger {
  const validation = validateMarketBaseResourceLedger(
    state,
    undefined,
    permitChain,
  );
  if (!validation.ok || state.pending) {
    throw new TypeError(
      validation.reason ?? "permit_anchor_rebind_requires_idle_wal",
    );
  }
  const compacted = compactRetiredCanariesForPermitRebind(state, permitChain);
  const permitAnchor = buildMarketBaseResourcePermitChainAnchor(permitChain);
  const { checkpointHash: _checkpointHash, ...checkpointPayload } =
    compacted.checkpoint;
  const nextCheckpointPayload = {
    ...clone(checkpointPayload),
    permitAnchor,
  };
  const next = {
    ...clone(compacted),
    permitAnchor,
    checkpoint: {
      ...nextCheckpointPayload,
      checkpointHash: checkpointHash(nextCheckpointPayload),
    },
  };
  const nextValidation = validateMarketBaseResourceLedger(
    next,
    undefined,
    permitChain,
  );
  if (!nextValidation.ok) {
    throw new TypeError(
      nextValidation.reason ?? "permit_anchor_rebind_invalid",
    );
  }
  return deepFreeze(next) as MarketBaseResourceLedger;
}

function allQuotaReceipts(
  state: MarketBaseResourceLedger,
): MarketBaseResourceQuotaReceipt[] {
  return [
    ...state.legacyQuotaReceipts,
    ...state.receipts.map(quotaReceiptFromV3),
  ];
}

function quotaReceiptFromV3(
  receipt: MarketBaseResourceReceipt,
): MarketBaseResourceQuotaReceipt {
  return {
    sourceVersion: 3,
    attemptSeq: receipt.attemptSeq,
    evidenceKey: receipt.evidenceKey,
    status: receipt.status,
    resource: receipt.resource,
    sellerRoom: receipt.sellerRoom,
    plannedAmount: receipt.plannedAmount,
    actualAmount: receipt.actualAmount,
    resolvedAt: receipt.resolvedAt,
    retentionTick: receipt.retentionTick,
    ...(receipt.transactionTime !== undefined
      ? { transactionTime: receipt.transactionTime }
      : {}),
  };
}

function confirmedQuotaReceipts(
  state: MarketBaseResourceLedger,
): MarketBaseResourceQuotaReceipt[] {
  const confirmed: MarketBaseResourceQuotaReceipt[] = [];
  for (const receipt of state.legacyQuotaReceipts) {
    if (receipt.status === "confirmed") confirmed.push(receipt);
  }
  for (const receipt of state.receipts) {
    if (receipt.status === "confirmed") {
      confirmed.push(quotaReceiptFromV3(receipt));
    }
  }
  return confirmed;
}

function validQuotaSnapshot(
  snapshot: MarketBaseResourceQuotaSnapshot,
): boolean {
  const validLayer = (
    layer: MarketBaseResourceQuotaLayer,
    expectedKey: string,
  ): boolean =>
    isPlainRecord(layer) &&
    exactKeys(layer, [
      "confirmedActual",
      "key",
      "limit",
      "remaining",
      "unmatchedPlanned",
      "used",
    ]) &&
    layer.key === expectedKey &&
    isPositiveSafeInteger(layer.limit) &&
    isSafeInteger(layer.confirmedActual) &&
    isSafeInteger(layer.unmatchedPlanned) &&
    layer.unmatchedPlanned <= MARKET_BASE_RESOURCE_PLANNED_AMOUNT &&
    layer.used === layer.confirmedActual + layer.unmatchedPlanned &&
    layer.remaining === Math.max(0, layer.limit - layer.used);
  const expectedCooldown =
    snapshot.lastGlobalConfirmedAt === undefined
      ? 0
      : snapshot.lastGlobalConfirmedAt +
        MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS;
  return (
    isSafeInteger(snapshot.tick) &&
    isSignedSafeInteger(snapshot.windowStartTick) &&
    snapshot.windowStartTick ===
      snapshot.tick - (MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS - 1) &&
    isMarketBaseResource(snapshot.resource) &&
    isBoundedString(snapshot.sellerRoom, 64) &&
    (snapshot.lastGlobalConfirmedAt === undefined ||
      (isSafeInteger(snapshot.lastGlobalConfirmedAt) &&
        snapshot.lastGlobalConfirmedAt <= snapshot.tick)) &&
    isSafeInteger(snapshot.confirmedCooldownNotBefore) &&
    snapshot.confirmedCooldownNotBefore === expectedCooldown &&
    isSafeInteger(snapshot.retryNotBefore) &&
    validLayer(snapshot.global, "global") &&
    validLayer(snapshot.resourceQuota, snapshot.resource) &&
    validLayer(snapshot.room, snapshot.sellerRoom) &&
    validLayer(snapshot.lane, `${snapshot.resource}:${snapshot.sellerRoom}`)
  );
}

function validExecutionEvidence(
  value: unknown,
  attemptAt: number,
  worstUnitNetCreditsMilli: number,
): value is MarketBaseResourceExecutionEvidence {
  if (
    !isPlainRecord(value) ||
    !exactKeys(
      value,
      [
        "creditsBefore",
        "effectiveEnergyShadowPriceMilli",
        "effectiveNetFloorMilli",
        "observedOrderAmount",
        "observedOrderPriceMilli",
        "outgoingTransactionKeysBefore",
        "outgoingWindowCoversAttemptAt",
        "outgoingWindowObservedAt",
        "terminalCooldownBefore",
        "terminalEnergyBefore",
        "terminalResourceBefore",
      ],
      ["outgoingWindowNewestTime", "outgoingWindowOldestTime"],
    ) ||
    !isPositiveSafeInteger(value.observedOrderPriceMilli) ||
    !isPositiveSafeInteger(value.observedOrderAmount) ||
    value.observedOrderAmount < MARKET_BASE_RESOURCE_PLANNED_AMOUNT ||
    !isSafeInteger(value.effectiveEnergyShadowPriceMilli) ||
    !isPositiveSafeInteger(value.effectiveNetFloorMilli) ||
    worstUnitNetCreditsMilli < value.effectiveNetFloorMilli ||
    !isSafeInteger(value.terminalResourceBefore) ||
    value.terminalResourceBefore < MARKET_BASE_RESOURCE_PLANNED_AMOUNT ||
    !isSafeInteger(value.terminalEnergyBefore) ||
    value.terminalCooldownBefore !== 0 ||
    typeof value.creditsBefore !== "number" ||
    !Number.isFinite(value.creditsBefore) ||
    value.creditsBefore < 0 ||
    !Array.isArray(value.outgoingTransactionKeysBefore) ||
    value.outgoingTransactionKeysBefore.length >
      MARKET_BASE_RESOURCE_OUTGOING_TRANSACTION_KEY_LIMIT ||
    value.outgoingTransactionKeysBefore.some(
      (key) => !isBoundedString(key, 256),
    ) ||
    new Set(value.outgoingTransactionKeysBefore).size !==
      value.outgoingTransactionKeysBefore.length ||
    value.outgoingWindowObservedAt !== attemptAt ||
    value.outgoingWindowCoversAttemptAt !== true
  ) {
    return false;
  }
  const oldest = value.outgoingWindowOldestTime;
  const newest = value.outgoingWindowNewestTime;
  return (
    (oldest === undefined || (isSafeInteger(oldest) && oldest <= attemptAt)) &&
    (newest === undefined || (isSafeInteger(newest) && newest <= attemptAt)) &&
    (oldest === undefined || newest === undefined || oldest <= newest)
  );
}

function validPending(
  value: unknown,
): value is MarketBaseResourcePendingAttempt {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "attemptAt",
      "attemptSeq",
      "dynamicScope",
      "evidenceKeyHint",
      "executionEvidence",
      "executionPolicy",
      "frozenEvidenceHash",
      "fullReads",
      "hashRevision",
      "historicalLane",
      "historicalPermit",
      "orderId",
      "orderRoom",
      "plannedAmount",
      "plannedNetCreditsMilli",
      "plannedTransactionEnergy",
      "quota",
      "schemaVersion",
      "worstUnitNetCreditsMilli",
    ]) ||
    !isPlainRecord(value.historicalPermit) ||
    !exactKeys(value.historicalPermit, [
      "permitEpoch",
      "permitHead",
      "permitId",
      "permitSelfHash",
      "prefixBindingHash",
    ]) ||
    !isPlainRecord(value.historicalLane) ||
    !exactKeys(value.historicalLane, [
      "laneId",
      "resource",
      "resourcePolicyFingerprint",
      "resourcePolicyId",
      "roomFingerprint",
      "roomInstanceId",
      "sellerRoom",
      "sharedPolicyFingerprint",
    ]) ||
    !isPlainRecord(value.dynamicScope) ||
    !exactKeys(value.dynamicScope, [
      "admissionPolicyFingerprint",
      "laneSetFingerprint",
      "rosterFingerprint",
    ]) ||
    !isPlainRecord(value.fullReads) ||
    !exactKeys(value.fullReads, [
      "arbiterFingerprint",
      "bookFingerprint",
      "energyReadinessFingerprint",
      "firstReadFingerprint",
      "protectionFingerprint",
      "secondReadFingerprint",
    ])
  ) {
    return false;
  }
  const pending = value as unknown as MarketBaseResourcePendingAttempt;
  if (
    pending.schemaVersion !== 3 ||
    pending.hashRevision !== MARKET_BASE_RESOURCE_PENDING_HASH_REVISION ||
    !isPositiveSafeInteger(pending.attemptSeq) ||
    !["canary", "continuous"].includes(pending.executionPolicy) ||
    pending.plannedAmount !== MARKET_BASE_RESOURCE_PLANNED_AMOUNT ||
    !isSafeInteger(pending.attemptAt) ||
    !isSafeInteger(pending.plannedTransactionEnergy) ||
    pending.plannedTransactionEnergy > 1_000 ||
    !isPositiveSafeInteger(pending.plannedNetCreditsMilli) ||
    !isPositiveSafeInteger(pending.worstUnitNetCreditsMilli) ||
    !isBoundedString(pending.orderId, 128) ||
    !isBoundedString(pending.orderRoom, 64) ||
    !isPositiveSafeInteger(pending.historicalPermit.permitEpoch) ||
    !isDigest(pending.historicalPermit.permitId) ||
    !isDigest(pending.historicalPermit.permitSelfHash) ||
    !isDigest(pending.historicalPermit.permitHead) ||
    !isDigest(pending.historicalPermit.prefixBindingHash) ||
    !isDigest(pending.historicalLane.laneId) ||
    !isDigest(pending.historicalLane.roomInstanceId) ||
    !isBoundedString(pending.historicalLane.resourcePolicyId, 128) ||
    !isDigest(pending.historicalLane.resourcePolicyFingerprint) ||
    !isBoundedString(pending.historicalLane.sellerRoom, 64) ||
    !isMarketBaseResource(pending.historicalLane.resource) ||
    !isDigest(pending.historicalLane.roomFingerprint) ||
    !isDigest(pending.historicalLane.sharedPolicyFingerprint) ||
    !isDigest(pending.dynamicScope.admissionPolicyFingerprint) ||
    !isDigest(pending.dynamicScope.rosterFingerprint) ||
    !isDigest(pending.dynamicScope.laneSetFingerprint) ||
    !isDigest(pending.fullReads.firstReadFingerprint) ||
    !isDigest(pending.fullReads.secondReadFingerprint) ||
    !isDigest(pending.fullReads.bookFingerprint) ||
    !isDigest(pending.fullReads.protectionFingerprint) ||
    !isDigest(pending.fullReads.energyReadinessFingerprint) ||
    !isDigest(pending.fullReads.arbiterFingerprint) ||
    pending.fullReads.firstReadFingerprint !==
      pending.fullReads.secondReadFingerprint ||
    !validExecutionEvidence(
      pending.executionEvidence,
      pending.attemptAt,
      pending.worstUnitNetCreditsMilli,
    ) ||
    !isDigest(pending.evidenceKeyHint) ||
    !isDigest(pending.frozenEvidenceHash) ||
    !validQuotaSnapshot(pending.quota) ||
    pending.quota.tick !== pending.attemptAt ||
    pending.quota.resource !== pending.historicalLane.resource ||
    pending.quota.sellerRoom !== pending.historicalLane.sellerRoom
  ) {
    return false;
  }
  const { frozenEvidenceHash: _hash, ...payload } = pending;
  return pending.frozenEvidenceHash === pendingHash(payload);
}

function validOutcome(value: unknown): value is MarketBaseResourceOutcome {
  if (
    !isPlainRecord(value) ||
    !exactKeys(
      value,
      [
        "actualAmount",
        "attemptAt",
        "attemptSeq",
        "evidenceKey",
        "hashRevision",
        "laneId",
        "orderId",
        "orderRoom",
        "outcomeEventHash",
        "pendingEvidenceHash",
        "permitEpoch",
        "permitId",
        "plannedAmount",
        "resolvedAt",
        "resource",
        "schemaVersion",
        "sellerRoom",
        "status",
      ],
      [
        "actualNetCreditsMilli",
        "actualTransactionEnergy",
        "reason",
        "transactionId",
        "transactionTime",
      ],
    )
  ) {
    return false;
  }
  const outcome = value as unknown as MarketBaseResourceOutcome;
  if (
    outcome.schemaVersion !== 3 ||
    outcome.hashRevision !== MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION ||
    !isPositiveSafeInteger(outcome.attemptSeq) ||
    !["confirmed", "failed", "not_filled"].includes(outcome.status) ||
    !isDigest(outcome.permitId) ||
    !isPositiveSafeInteger(outcome.permitEpoch) ||
    !isDigest(outcome.laneId) ||
    !isBoundedString(outcome.sellerRoom, 64) ||
    !isMarketBaseResource(outcome.resource) ||
    !isBoundedString(outcome.orderId, 128) ||
    !isBoundedString(outcome.orderRoom, 64) ||
    outcome.plannedAmount !== MARKET_BASE_RESOURCE_PLANNED_AMOUNT ||
    !isSafeInteger(outcome.attemptAt) ||
    !isSafeInteger(outcome.resolvedAt) ||
    outcome.resolvedAt < outcome.attemptAt ||
    !isDigest(outcome.evidenceKey) ||
    !isSafeInteger(outcome.actualAmount) ||
    outcome.actualAmount > outcome.plannedAmount ||
    !isDigest(outcome.pendingEvidenceHash) ||
    !isDigest(outcome.outcomeEventHash) ||
    (outcome.reason !== undefined && !isBoundedString(outcome.reason, 256))
  ) {
    return false;
  }
  if (
    outcome.status === "confirmed"
      ? !isPositiveSafeInteger(outcome.actualAmount) ||
        !isSafeInteger(outcome.transactionTime) ||
        outcome.transactionTime < outcome.attemptAt ||
        outcome.transactionTime > outcome.resolvedAt ||
        !isBoundedString(outcome.transactionId, 128) ||
        !isSafeInteger(outcome.actualTransactionEnergy) ||
        outcome.actualTransactionEnergy > 1_000 ||
        !isPositiveSafeInteger(outcome.actualNetCreditsMilli)
      : outcome.actualAmount !== 0 ||
        outcome.transactionTime !== undefined ||
        outcome.transactionId !== undefined ||
        outcome.actualTransactionEnergy !== undefined ||
        outcome.actualNetCreditsMilli !== undefined
  ) {
    return false;
  }
  const { outcomeEventHash: _hash, ...payload } = outcome;
  return outcome.outcomeEventHash === outcomeHash(payload);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalStableHashV1(left) === canonicalStableHashV1(right);
}

export interface MarketBaseResourceLedgerValidation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly prefix?:
    | "idle"
    | "waiting_outcome"
    | "outcome_written"
    | "receipt_written"
    | "processed_key_written";
}

function outcomeMatchesReceipt(
  outcome: MarketBaseResourceOutcome,
  receipt: MarketBaseResourceReceipt,
): boolean {
  return (
    outcome.attemptSeq === receipt.attemptSeq &&
    outcome.status === receipt.status &&
    outcome.permitId === receipt.permitId &&
    outcome.permitEpoch === receipt.permitEpoch &&
    outcome.laneId === receipt.laneId &&
    outcome.sellerRoom === receipt.sellerRoom &&
    outcome.resource === receipt.resource &&
    outcome.orderId === receipt.orderId &&
    outcome.orderRoom === receipt.orderRoom &&
    outcome.attemptAt === receipt.attemptAt &&
    outcome.plannedAmount === receipt.plannedAmount &&
    outcome.resolvedAt === receipt.resolvedAt &&
    outcome.evidenceKey === receipt.evidenceKey &&
    outcome.actualAmount === receipt.actualAmount &&
    outcome.reason === receipt.reason &&
    outcome.transactionId === receipt.transactionId &&
    outcome.transactionTime === receipt.transactionTime &&
    outcome.actualTransactionEnergy === receipt.actualTransactionEnergy &&
    outcome.actualNetCreditsMilli === receipt.actualNetCreditsMilli &&
    outcome.pendingEvidenceHash === receipt.pendingEvidenceHash &&
    outcome.outcomeEventHash === receipt.outcomeEventHash
  );
}

function pendingMatchesOutcome(
  pending: MarketBaseResourcePendingAttempt,
  outcome: MarketBaseResourceOutcome,
): boolean {
  return (
    outcome.attemptSeq === pending.attemptSeq &&
    outcome.permitId === pending.historicalPermit.permitId &&
    outcome.permitEpoch === pending.historicalPermit.permitEpoch &&
    outcome.laneId === pending.historicalLane.laneId &&
    outcome.sellerRoom === pending.historicalLane.sellerRoom &&
    outcome.resource === pending.historicalLane.resource &&
    outcome.orderId === pending.orderId &&
    outcome.orderRoom === pending.orderRoom &&
    outcome.attemptAt === pending.attemptAt &&
    outcome.plannedAmount === pending.plannedAmount &&
    outcome.pendingEvidenceHash === pending.frozenEvidenceHash
  );
}

function validateMarketBaseResourceLedgerUncached(
  value: unknown,
  tick?: number,
  permitChain?: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedgerValidation {
  marketBaseResourceLedgerRuntimeTestProbe?.("full_validator");
  if (
    !isPlainRecord(value) ||
    !exactKeys(
      value,
      [
        "canaryAttemptHighWater",
        "checkpoint",
        "confirmedCanaries",
        "confirmedCooldownNotBefore",
        "coverageStartTick",
        "finalizedAttemptSeq",
        "hashRevision",
        "legacyQuotaReceipts",
        "legacyV2ConfirmedCanaries",
        "lifetimeConfirmed",
        "nextAttemptSeq",
        "outcomes",
        "permitAnchor",
        "processedEvidenceKeys",
        "receiptHeadHash",
        "receipts",
        "retryNotBefore",
        "schemaVersion",
      ],
      ["blocker", "pending", "terminalSlotReservation"],
    )
  ) {
    return { ok: false, reason: "ledger_shape_invalid" };
  }
  const state = value as unknown as MarketBaseResourceLedger;
  if (
    state.schemaVersion !== 3 ||
    state.hashRevision !== MARKET_BASE_RESOURCE_LEDGER_HASH_REVISION ||
    !isSafeInteger(state.coverageStartTick) ||
    (tick !== undefined &&
      (!isSafeInteger(tick) ||
        state.coverageStartTick >
          Math.max(
            0,
            tick - (MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS - 1),
          ))) ||
    !isDigest(state.receiptHeadHash) ||
    !isSafeInteger(state.finalizedAttemptSeq) ||
    !isPositiveSafeInteger(state.nextAttemptSeq) ||
    !Array.isArray(state.receipts) ||
    !Array.isArray(state.legacyQuotaReceipts) ||
    !Array.isArray(state.outcomes) ||
    !Array.isArray(state.processedEvidenceKeys) ||
    state.receipts.length > MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT ||
    state.legacyQuotaReceipts.length + state.receipts.length >
      MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT ||
    state.outcomes.length > MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT ||
    state.processedEvidenceKeys.length >
      MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT ||
    !isSafeInteger(state.retryNotBefore) ||
    !isSafeInteger(state.confirmedCooldownNotBefore) ||
    !validCounters(state.lifetimeConfirmed) ||
    !validLegacyV2ConfirmedCanaryMap(
      state.legacyV2ConfirmedCanaries,
      state.finalizedAttemptSeq,
    ) ||
    !validCanaryAttemptHighWaterMap(
      state.canaryAttemptHighWater,
      state.nextAttemptSeq - 1,
    ) ||
    !validConfirmedCanaryMap(
      state.confirmedCanaries,
      state.finalizedAttemptSeq,
    ) ||
    !validPermitChainAnchor(state.permitAnchor) ||
    !isPlainRecord(state.checkpoint) ||
    !exactKeys(state.checkpoint, [
      "canaryAttemptHighWater",
      "canaryAttemptHighWaterCommitment",
      "checkpointHash",
      "confirmedCanaries",
      "confirmedCanaryCommitment",
      "confirmedCooldownNotBeforeHighWater",
      "coverageStartTick",
      "legacyQuotaReceiptCommitment",
      "legacyV2ConfirmedCanaries",
      "legacyV2ConfirmedCanaryCommitment",
      "lifetimeConfirmed",
      "permitAnchor",
      "prunedReceiptHeadHash",
      "prunedThroughAttemptSeq",
      "retryNotBeforeHighWater",
      "retiredCanaryCheckpoint",
    ]) ||
    !isSafeInteger(state.checkpoint.prunedThroughAttemptSeq) ||
    !isDigest(state.checkpoint.prunedReceiptHeadHash) ||
    !isSafeInteger(state.checkpoint.coverageStartTick) ||
    state.checkpoint.coverageStartTick !== state.coverageStartTick ||
    !isSafeInteger(state.checkpoint.retryNotBeforeHighWater) ||
    state.retryNotBefore < state.checkpoint.retryNotBeforeHighWater ||
    !isSafeInteger(state.checkpoint.confirmedCooldownNotBeforeHighWater) ||
    state.confirmedCooldownNotBefore <
      state.checkpoint.confirmedCooldownNotBeforeHighWater ||
    !isDigest(state.checkpoint.legacyQuotaReceiptCommitment) ||
    !validCanaryAttemptHighWaterMap(
      state.checkpoint.canaryAttemptHighWater,
      state.checkpoint.prunedThroughAttemptSeq,
    ) ||
    !isDigest(state.checkpoint.canaryAttemptHighWaterCommitment) ||
    !validLegacyV2ConfirmedCanaryMap(
      state.checkpoint.legacyV2ConfirmedCanaries,
      state.checkpoint.prunedThroughAttemptSeq,
    ) ||
    !isDigest(state.checkpoint.legacyV2ConfirmedCanaryCommitment) ||
    !sameCanonical(
      state.checkpoint.legacyV2ConfirmedCanaries,
      state.legacyV2ConfirmedCanaries,
    ) ||
    !validConfirmedCanaryMap(
      state.checkpoint.confirmedCanaries,
      state.checkpoint.prunedThroughAttemptSeq,
    ) ||
    !isDigest(state.checkpoint.confirmedCanaryCommitment) ||
    !validRetiredCanaryCheckpoint(
      state.checkpoint.retiredCanaryCheckpoint,
      state.finalizedAttemptSeq,
    ) ||
    state.checkpoint.retiredCanaryCheckpoint
      .laneTombstoneCheckpointCommitment !==
      state.permitAnchor.laneTombstoneCheckpointCommitment ||
    !validCounters(state.checkpoint.lifetimeConfirmed) ||
    !validPermitChainAnchor(state.checkpoint.permitAnchor) ||
    !sameCanonical(state.checkpoint.permitAnchor, state.permitAnchor) ||
    !isDigest(state.checkpoint.checkpointHash)
  ) {
    return { ok: false, reason: "ledger_shape_invalid" };
  }
  const { checkpointHash: _checkpointHash, ...checkpointPayload } =
    state.checkpoint;
  if (
    state.checkpoint.checkpointHash !== checkpointHash(checkpointPayload) ||
    state.checkpoint.legacyQuotaReceiptCommitment !==
      legacyQuotaReceiptCommitment(state.legacyQuotaReceipts) ||
    state.checkpoint.canaryAttemptHighWaterCommitment !==
      canaryAttemptHighWaterCommitment(
        state.checkpoint.canaryAttemptHighWater,
      ) ||
    state.checkpoint.legacyV2ConfirmedCanaryCommitment !==
      legacyV2ConfirmedCanaryCommitment(
        state.checkpoint.legacyV2ConfirmedCanaries,
      ) ||
    state.checkpoint.confirmedCanaryCommitment !==
      confirmedCanaryCommitment(state.checkpoint.confirmedCanaries) ||
    Object.keys(state.canaryAttemptHighWater).some((laneId) =>
      state.checkpoint.retiredCanaryCheckpoint.retiredCanaries.some(
        (record) => record.laneId === laneId,
      ),
    ) ||
    Object.keys(state.confirmedCanaries).some((laneId) =>
      state.checkpoint.retiredCanaryCheckpoint.retiredCanaries.some(
        (record) => record.laneId === laneId,
      ),
    )
  ) {
    return { ok: false, reason: "ledger_checkpoint_invalid" };
  }
  if (permitChain) {
    const crossState = validateMarketBaseResourcePermitChainDominatesAnchor(
      permitChain,
      state.permitAnchor,
    );
    if (!crossState.ok) {
      return {
        ok: false,
        reason: crossState.reason ?? "ledger_permit_anchor_mismatch",
      };
    }
  }
  if (state.blocker !== undefined) {
    if (
      !isPlainRecord(state.blocker) ||
      !exactKeys(state.blocker, ["code", "detailHash", "detectedAt"]) ||
      !isBoundedString(state.blocker.code, 128) ||
      !isSafeInteger(state.blocker.detectedAt) ||
      !isDigest(state.blocker.detailHash)
    ) {
      return { ok: false, reason: "ledger_blocker_invalid" };
    }
    return { ok: false, reason: state.blocker.code };
  }
  const seenAttempts = new Set<number>();
  const seenEvidence = new Set<string>();
  for (const receipt of state.legacyQuotaReceipts) {
    if (
      receipt.sourceVersion !== 2 ||
      !validQuotaReceipt(receipt) ||
      receipt.attemptSeq > state.checkpoint.prunedThroughAttemptSeq ||
      seenAttempts.has(receipt.attemptSeq) ||
      seenEvidence.has(receipt.evidenceKey)
    ) {
      return { ok: false, reason: "ledger_legacy_receipt_invalid" };
    }
    seenAttempts.add(receipt.attemptSeq);
    seenEvidence.add(receipt.evidenceKey);
  }
  if (
    state.pending &&
    (!validPending(state.pending) ||
      state.pending.attemptSeq !== state.nextAttemptSeq - 1 ||
      !isPlainRecord(state.terminalSlotReservation) ||
      !exactKeys(state.terminalSlotReservation, [
        "attemptSeq",
        "outcomeSlotReserved",
        "receiptSlotReserved",
      ]) ||
      state.terminalSlotReservation.attemptSeq !== state.pending.attemptSeq ||
      state.terminalSlotReservation.outcomeSlotReserved !== true ||
      state.terminalSlotReservation.receiptSlotReserved !== true)
  ) {
    return { ok: false, reason: "ledger_pending_invalid" };
  }
  if (!state.pending && state.terminalSlotReservation !== undefined) {
    return { ok: false, reason: "ledger_orphan_slot_reservation" };
  }
  let previousHead = state.checkpoint.prunedReceiptHeadHash;
  let lastAttempt = state.checkpoint.prunedThroughAttemptSeq;
  let priorAttemptAt = -1;
  let retainedConfirmed = emptyCounters();
  let confirmedCooldownFloor =
    state.checkpoint.confirmedCooldownNotBeforeHighWater;
  const expectedConfirmedCanaries = clone(
    state.checkpoint.confirmedCanaries,
  ) as Record<string, MarketBaseResourceConfirmedCanary>;
  let expectedCanaryAttemptHighWater = clone(
    state.checkpoint.canaryAttemptHighWater,
  ) as Record<string, MarketBaseResourceCanaryAttemptHighWater>;
  const retiredCanaries = new Map(
    state.checkpoint.retiredCanaryCheckpoint.retiredCanaries.map(
      (record) => [record.laneId, record] as const,
    ),
  );
  const receiptByAttempt = new Map<number, MarketBaseResourceReceipt>();
  for (const receipt of state.receipts) {
    if (
      !validReceipt(receipt) ||
      receipt.attemptSeq !== lastAttempt + 1 ||
      receipt.prevHash !== previousHead ||
      receipt.attemptAt < priorAttemptAt ||
      seenAttempts.has(receipt.attemptSeq) ||
      seenEvidence.has(receipt.evidenceKey)
    ) {
      return { ok: false, reason: "ledger_receipt_chain_invalid" };
    }
    seenAttempts.add(receipt.attemptSeq);
    seenEvidence.add(receipt.evidenceKey);
    receiptByAttempt.set(receipt.attemptSeq, receipt);
    if (receipt.status === "confirmed") {
      retainedConfirmed = addCounter(
        retainedConfirmed,
        receipt.resource,
        receipt.sellerRoom,
        receipt.actualAmount,
      );
      confirmedCooldownFloor = Math.max(
        confirmedCooldownFloor,
        receipt.transactionTime! +
          MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
      );
    }
    const confirmedCanary = confirmedCanaryFromReceipt(receipt);
    if (confirmedCanary) {
      const retired = retiredCanaries.get(confirmedCanary.laneId);
      if (retired) {
        if (!sameCanonical(retired.confirmed, confirmedCanary)) {
          return {
            ok: false,
            reason: "ledger_retired_canary_confirmation_conflict",
          };
        }
      } else if (expectedConfirmedCanaries[confirmedCanary.laneId]) {
        return {
          ok: false,
          reason: "ledger_canary_confirmation_conflict",
        };
      } else {
        expectedConfirmedCanaries[confirmedCanary.laneId] = confirmedCanary;
      }
    }
    const canaryAttempt = canaryAttemptFromReceipt(receipt);
    if (canaryAttempt) {
      const retired = retiredCanaries.get(canaryAttempt.laneId);
      if (retired) {
        if (!sameCanonical(retired.attempt, canaryAttempt)) {
          return {
            ok: false,
            reason: "ledger_retired_canary_attempt_conflict",
          };
        }
      } else {
        const applied = applyCanaryAttemptHighWater(
          expectedCanaryAttemptHighWater,
          canaryAttempt,
        );
        if ("reason" in applied) {
          return {
            ok: false,
            reason: applied.reason,
          };
        }
        expectedCanaryAttemptHighWater = clone(applied.attempts) as Record<
          string,
          MarketBaseResourceCanaryAttemptHighWater
        >;
      }
    }
    previousHead = receipt.headHash;
    lastAttempt = receipt.attemptSeq;
    priorAttemptAt = receipt.attemptAt;
  }
  const pendingCanaryAttempt = state.pending
    ? canaryAttemptFromPending(state.pending)
    : undefined;
  if (pendingCanaryAttempt) {
    if (retiredCanaries.has(pendingCanaryAttempt.laneId)) {
      return {
        ok: false,
        reason: "ledger_pending_retired_canary",
      };
    }
    const applied = applyCanaryAttemptHighWater(
      expectedCanaryAttemptHighWater,
      pendingCanaryAttempt,
    );
    if ("reason" in applied) {
      return {
        ok: false,
        reason: applied.reason,
      };
    }
    expectedCanaryAttemptHighWater = clone(applied.attempts) as Record<
      string,
      MarketBaseResourceCanaryAttemptHighWater
    >;
  }
  if (
    previousHead !== state.receiptHeadHash ||
    lastAttempt !== state.finalizedAttemptSeq ||
    !sameCanonical(
      addCounters(state.checkpoint.lifetimeConfirmed, retainedConfirmed),
      state.lifetimeConfirmed,
    ) ||
    state.confirmedCooldownNotBefore !== confirmedCooldownFloor ||
    !sameCanonical(
      expectedCanaryAttemptHighWater,
      state.canaryAttemptHighWater,
    ) ||
    !sameCanonical(expectedConfirmedCanaries, state.confirmedCanaries)
  ) {
    return { ok: false, reason: "ledger_tip_or_lifetime_invalid" };
  }
  const outcomeByAttempt = new Map<number, MarketBaseResourceOutcome>();
  const outcomeEvidence = new Map<string, number>();
  let priorOutcomeAttempt = 0;
  let retryFloor = state.checkpoint.retryNotBeforeHighWater;
  for (const outcome of state.outcomes) {
    const receipt = receiptByAttempt.get(outcome.attemptSeq);
    if (
      !validOutcome(outcome) ||
      outcome.attemptSeq <= priorOutcomeAttempt ||
      outcomeByAttempt.has(outcome.attemptSeq) ||
      outcomeEvidence.has(outcome.evidenceKey) ||
      outcome.attemptSeq >
        (state.pending?.attemptSeq ?? state.finalizedAttemptSeq) ||
      (receipt && !outcomeMatchesReceipt(outcome, receipt))
    ) {
      return { ok: false, reason: "ledger_outcome_invalid" };
    }
    outcomeByAttempt.set(outcome.attemptSeq, outcome);
    outcomeEvidence.set(outcome.evidenceKey, outcome.attemptSeq);
    priorOutcomeAttempt = outcome.attemptSeq;
    if (outcome.status !== "confirmed") {
      retryFloor = Math.max(
        retryFloor,
        outcome.attemptAt + MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS,
      );
    }
  }
  if (state.retryNotBefore < retryFloor) {
    return { ok: false, reason: "ledger_retry_high_water_rollback" };
  }
  const processedByAttempt = new Map<number, string>();
  const processedByKey = new Map<string, number>();
  let priorProcessedAttempt = 0;
  for (const entry of state.processedEvidenceKeys) {
    if (
      !isPlainRecord(entry) ||
      !exactKeys(entry, ["attemptSeq", "key"]) ||
      !isPositiveSafeInteger(entry.attemptSeq) ||
      !isDigest(entry.key) ||
      entry.attemptSeq <= priorProcessedAttempt ||
      entry.attemptSeq > state.finalizedAttemptSeq ||
      processedByAttempt.has(entry.attemptSeq) ||
      processedByKey.has(entry.key) ||
      (receiptByAttempt.has(entry.attemptSeq) &&
        receiptByAttempt.get(entry.attemptSeq)?.evidenceKey !== entry.key)
    ) {
      return { ok: false, reason: "ledger_processed_key_invalid" };
    }
    processedByAttempt.set(entry.attemptSeq, entry.key);
    processedByKey.set(entry.key, entry.attemptSeq);
    priorProcessedAttempt = entry.attemptSeq;
  }
  const pending = state.pending;
  if (!pending) {
    if (
      state.nextAttemptSeq !== state.finalizedAttemptSeq + 1 ||
      (state.receipts.length > 0 &&
        processedByAttempt.get(state.finalizedAttemptSeq) !==
          state.receipts[state.receipts.length - 1].evidenceKey)
    ) {
      return { ok: false, reason: "ledger_idle_high_water_invalid" };
    }
    return { ok: true, prefix: "idle" };
  }
  const outcome = outcomeByAttempt.get(pending.attemptSeq);
  const receipt = receiptByAttempt.get(pending.attemptSeq);
  const processed = processedByAttempt.get(pending.attemptSeq);
  if (
    (outcome && !pendingMatchesOutcome(pending, outcome)) ||
    (receipt && !outcome) ||
    (processed && !receipt) ||
    state.nextAttemptSeq !== pending.attemptSeq + 1 ||
    (receipt
      ? state.finalizedAttemptSeq !== pending.attemptSeq
      : state.finalizedAttemptSeq !== pending.attemptSeq - 1)
  ) {
    return { ok: false, reason: "ledger_wal_prefix_invalid" };
  }
  const combinedReceiptCount =
    state.legacyQuotaReceipts.length + state.receipts.length;
  if (!outcome) {
    return state.outcomes.length < MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT &&
      combinedReceiptCount < MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT &&
      state.processedEvidenceKeys.length <
        MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT
      ? { ok: true, prefix: "waiting_outcome" }
      : { ok: false, reason: "ledger_terminal_slot_reservation_lost" };
  }
  if (!receipt) {
    return combinedReceiptCount < MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT &&
      state.processedEvidenceKeys.length <
        MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT
      ? { ok: true, prefix: "outcome_written" }
      : { ok: false, reason: "ledger_terminal_slot_reservation_lost" };
  }
  if (
    !processed &&
    state.processedEvidenceKeys.length >=
      MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT
  ) {
    return { ok: false, reason: "ledger_processed_slot_reservation_lost" };
  }
  return processed !== undefined
    ? { ok: true, prefix: "processed_key_written" }
    : { ok: true, prefix: "receipt_written" };
}

const ledgerValidationCache = new WeakMap<
  object,
  {
    readonly tick: number | undefined;
    readonly permitChain: MarketBaseResourcePermitChainState | undefined;
    readonly validation: MarketBaseResourceLedgerValidation;
  }
>();

/**
 * 同一 tick 的 readiness/live-scope/lane gate 会反复读取同一个 immutable
 * ledger。canonical builder 产物递归 frozen，因此可按 object identity
 * 复用一次完整验证；mutable Memory/raw fixture 仍永远走完整 validator。
 */
export function validateMarketBaseResourceLedger(
  value: unknown,
  tick?: number,
  permitChain?: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedgerValidation {
  if (
    value !== null &&
    typeof value === "object" &&
    ledgerDeepFrozenValues.has(value) &&
    (permitChain === undefined ||
      isMarketBaseResourcePermitDeepFrozen(permitChain) ||
      ledgerDeepFrozenValues.has(permitChain))
  ) {
    const cached = ledgerValidationCache.get(value);
    if (cached && cached.tick === tick && cached.permitChain === permitChain) {
      return cached.validation;
    }
    const validation = validateMarketBaseResourceLedgerUncached(
      value,
      tick,
      permitChain,
    );
    ledgerValidationCache.set(value, { tick, permitChain, validation });
    return validation;
  }
  return validateMarketBaseResourceLedgerUncached(value, tick, permitChain);
}

export interface MarketBaseResourceLedgerRuntimeAnchor {
  readonly schemaVersion: 3;
  readonly hashRevision: "market-base-resource-ledger-runtime-anchor-v1";
  readonly permitRuntimeAnchor: MarketBaseResourcePermitRuntimeAnchor;
  readonly permitAnchorHash: string;
  readonly checkpointHash: string;
  readonly prunedThroughAttemptSeq: number;
  readonly coverageStartTick: number;
  readonly finalizedAttemptSeq: number;
  readonly nextAttemptSeq: number;
  readonly receiptHeadHash: string;
  readonly pendingAttemptSeq: number | null;
  readonly pendingFrozenEvidenceHash: string | null;
  readonly outcomeCommitment: string;
  readonly processedEvidenceKeysCommitment: string;
  readonly terminalSlotReservationCommitment: string;
  readonly retryNotBefore: number;
  readonly confirmedCooldownNotBefore: number;
  readonly canaryAttemptHighWaterCommitment: string;
  readonly confirmedCanaryCommitment: string;
  readonly retiredCanaryCheckpointCommitment: string;
  readonly lifetimeConfirmedCommitment: string;
  readonly quotaFactCommitment: string;
  readonly blocker: MarketBaseResourceLedgerBlocker | null;
  readonly blockerCommitment: string;
  readonly walStateCommitment: string;
  readonly anchorCommitment: string;
}

interface MarketBaseResourceLedgerRuntimeFactCommitments {
  readonly outcomeCommitment: string;
  readonly processedEvidenceKeysCommitment: string;
  readonly terminalSlotReservationCommitment: string;
  readonly quotaFactCommitment: string;
}

function fastLedgerRuntimeCollectionRoot(
  state: MarketBaseResourceLedger,
): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let third = 0x85ebca6b;
  let fourth = 0xc2b2ae35;
  const mixTokenHash = (tokenHash: number) => {
    first = Math.imul(first ^ tokenHash, 0x01000193);
    second = Math.imul(second ^ tokenHash, 0x85ebca6b);
    third = Math.imul(third ^ tokenHash, 0xc2b2ae35);
    fourth = Math.imul(fourth ^ tokenHash, 0x27d4eb2f);
  };
  const token = (value: unknown) => {
    const typeCode =
      value === null
        ? 1
        : value === undefined
          ? 2
          : typeof value === "string"
            ? 3
            : typeof value === "number"
              ? 4
              : typeof value === "boolean"
                ? 5
                : 6;
    const text =
      typeof value === "number" && Object.is(value, -0)
        ? "0"
        : typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ? String(value)
          : "";
    let tokenHash = Math.imul(0x811c9dc5 ^ typeCode, 0x01000193);
    tokenHash = Math.imul(tokenHash ^ text.length, 0x01000193);
    for (let index = 0; index < text.length; index += 1) {
      tokenHash = Math.imul(tokenHash ^ text.charCodeAt(index), 0x01000193);
    }
    mixTokenHash(tokenHash);
  };
  token("market-base-resource:ledger-runtime-collections-v1");
  token(state.legacyQuotaReceipts.length);
  for (const receipt of state.legacyQuotaReceipts) {
    if (receipt.status === "confirmed") {
      token(
        `n${receipt.attemptSeq}|s${receipt.evidenceKey.length}:` +
          `${receipt.evidenceKey}|s${receipt.resource.length}:${receipt.resource}` +
          `|s${receipt.sellerRoom.length}:${receipt.sellerRoom}` +
          `|n${receipt.actualAmount}|n${receipt.retentionTick}` +
          `|n${receipt.transactionTime}`,
      );
    }
  }
  token(state.receipts.length);
  for (const receipt of state.receipts) {
    if (receipt.status === "confirmed") {
      token(
        `n${receipt.attemptSeq}|s${receipt.eventHash.length}:${receipt.eventHash}` +
          `|s${receipt.resource.length}:${receipt.resource}` +
          `|s${receipt.sellerRoom.length}:${receipt.sellerRoom}` +
          `|n${receipt.actualAmount}|n${receipt.retentionTick}` +
          `|n${receipt.transactionTime}`,
      );
    }
  }
  token(
    state.receipts.length === 0
      ? null
      : canonicalStableHashV1(state.receipts[0]),
  );
  token(
    state.receipts.length === 0
      ? null
      : canonicalStableHashV1(state.receipts[state.receipts.length - 1]),
  );
  if (state.pending) {
    token(5);
    token(state.pending.attemptSeq);
    token(state.pending.historicalLane.resource);
    token(state.pending.historicalLane.sellerRoom);
    token(state.pending.plannedAmount);
    token(state.pending.frozenEvidenceHash);
  } else {
    token(null);
  }
  const currentOutcome = state.pending
    ? state.outcomes[state.outcomes.length - 1]
    : undefined;
  if (
    state.pending &&
    currentOutcome?.attemptSeq === state.pending.attemptSeq
  ) {
    token(23);
    token(currentOutcome.schemaVersion);
    token(currentOutcome.hashRevision);
    token(currentOutcome.attemptSeq);
    token(currentOutcome.status);
    token(currentOutcome.permitId);
    token(currentOutcome.permitEpoch);
    token(currentOutcome.laneId);
    token(currentOutcome.sellerRoom);
    token(currentOutcome.resource);
    token(currentOutcome.orderId);
    token(currentOutcome.orderRoom);
    token(currentOutcome.attemptAt);
    token(currentOutcome.plannedAmount);
    token(currentOutcome.resolvedAt);
    token(currentOutcome.evidenceKey);
    token(currentOutcome.actualAmount);
    token(currentOutcome.reason);
    token(currentOutcome.transactionId);
    token(currentOutcome.transactionTime);
    token(currentOutcome.actualTransactionEnergy);
    token(currentOutcome.actualNetCreditsMilli);
    token(currentOutcome.pendingEvidenceHash);
    token(currentOutcome.outcomeEventHash);
  } else {
    token(null);
  }
  const currentProcessed = state.pending
    ? state.processedEvidenceKeys[state.processedEvidenceKeys.length - 1]
    : undefined;
  token(state.processedEvidenceKeys.length);
  for (const entry of state.processedEvidenceKeys) {
    token(`n${entry.attemptSeq}|s${entry.key.length}:${entry.key}`);
  }
  if (
    state.pending &&
    currentProcessed?.attemptSeq === state.pending.attemptSeq
  ) {
    token(2);
    token(currentProcessed.attemptSeq);
    token(currentProcessed.key);
  } else {
    token(null);
  }
  if (state.terminalSlotReservation) {
    token(3);
    token(state.terminalSlotReservation.attemptSeq);
    token(state.terminalSlotReservation.outcomeSlotReserved);
    token(state.terminalSlotReservation.receiptSlotReserved);
  } else {
    token(null);
  }
  const avalanche32 = (input: number) => {
    let result = input >>> 0;
    result ^= result >>> 16;
    result = Math.imul(result, 0x7feb352d);
    result ^= result >>> 15;
    result = Math.imul(result, 0x846ca68b);
    result ^= result >>> 16;
    return result >>> 0;
  };
  const words = [first, second, third, fourth]
    .map(avalanche32)
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
  return `csh1:${words}`;
}

/**
 * runtime collection root 只承诺 hot path 会读取的事实：全部 receipt 的
 * status/eventHash、confirmed quota facts、oldest/last frontier、current
 * pending outcome，以及完整 processed replay set。旧 non-current outcome
 * payload 是 operator/full-audit-only，不进入每 tick 授权面。
 */
function ledgerRuntimeFactCommitments(
  state: MarketBaseResourceLedger,
): MarketBaseResourceLedgerRuntimeFactCommitments {
  const collectionRoot = fastLedgerRuntimeCollectionRoot(state);
  return {
    outcomeCommitment: collectionRoot,
    processedEvidenceKeysCommitment: collectionRoot,
    terminalSlotReservationCommitment: collectionRoot,
    quotaFactCommitment: collectionRoot,
  };
}

function ledgerBlockerCommitment(
  blocker: MarketBaseResourceLedgerBlocker | null,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:ledger-runtime-blocker-v1",
    blocker,
  });
}

function validLedgerBlocker(
  value: unknown,
): value is MarketBaseResourceLedgerBlocker {
  return (
    isPlainRecord(value) &&
    exactKeys(value, ["code", "detailHash", "detectedAt"]) &&
    isBoundedString(value.code, 128) &&
    isSafeInteger(value.detectedAt) &&
    isDigest(value.detailHash)
  );
}

function ledgerWalStateCommitment(
  state: MarketBaseResourceLedger,
  facts: {
    readonly outcomeCommitment: string;
    readonly processedEvidenceKeysCommitment: string;
    readonly terminalSlotReservationCommitment: string;
    readonly blockerCommitment: string;
  },
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:ledger-wal-state-v1",
    permitAnchorHash: state.permitAnchor.anchorHash,
    checkpointHash: state.checkpoint.checkpointHash,
    prunedThroughAttemptSeq: state.checkpoint.prunedThroughAttemptSeq,
    coverageStartTick: state.coverageStartTick,
    finalizedAttemptSeq: state.finalizedAttemptSeq,
    nextAttemptSeq: state.nextAttemptSeq,
    receiptHeadHash: state.receiptHeadHash,
    pendingAttemptSeq: state.pending?.attemptSeq ?? null,
    pendingFrozenEvidenceHash: state.pending?.frozenEvidenceHash ?? null,
    outcomeCommitment: facts.outcomeCommitment,
    processedEvidenceKeysCommitment: facts.processedEvidenceKeysCommitment,
    terminalSlotReservationCommitment: facts.terminalSlotReservationCommitment,
    retryNotBefore: state.retryNotBefore,
    confirmedCooldownNotBefore: state.confirmedCooldownNotBefore,
    blockerCommitment: facts.blockerCommitment,
  });
}

function ledgerRuntimeAnchorCommitment(
  anchor: Omit<MarketBaseResourceLedgerRuntimeAnchor, "anchorCommitment">,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:ledger-runtime-anchor-v1",
    anchor,
  });
}

function validLedgerRuntimeAnchor(
  value: unknown,
): value is MarketBaseResourceLedgerRuntimeAnchor {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "anchorCommitment",
      "blocker",
      "blockerCommitment",
      "canaryAttemptHighWaterCommitment",
      "checkpointHash",
      "confirmedCooldownNotBefore",
      "confirmedCanaryCommitment",
      "coverageStartTick",
      "finalizedAttemptSeq",
      "hashRevision",
      "lifetimeConfirmedCommitment",
      "nextAttemptSeq",
      "outcomeCommitment",
      "pendingAttemptSeq",
      "pendingFrozenEvidenceHash",
      "permitAnchorHash",
      "permitRuntimeAnchor",
      "processedEvidenceKeysCommitment",
      "prunedThroughAttemptSeq",
      "quotaFactCommitment",
      "receiptHeadHash",
      "retiredCanaryCheckpointCommitment",
      "retryNotBefore",
      "schemaVersion",
      "terminalSlotReservationCommitment",
      "walStateCommitment",
    ]) ||
    value.schemaVersion !== 3 ||
    value.hashRevision !== "market-base-resource-ledger-runtime-anchor-v1" ||
    !isDigest(value.permitAnchorHash) ||
    !isDigest(value.checkpointHash) ||
    !isSafeInteger(value.prunedThroughAttemptSeq) ||
    !isSafeInteger(value.coverageStartTick) ||
    !isSafeInteger(value.finalizedAttemptSeq) ||
    !isPositiveSafeInteger(value.nextAttemptSeq) ||
    !isDigest(value.receiptHeadHash) ||
    (value.pendingAttemptSeq !== null &&
      !isPositiveSafeInteger(value.pendingAttemptSeq)) ||
    (value.pendingFrozenEvidenceHash !== null &&
      !isDigest(value.pendingFrozenEvidenceHash)) ||
    !isDigest(value.outcomeCommitment) ||
    !isDigest(value.processedEvidenceKeysCommitment) ||
    !isDigest(value.terminalSlotReservationCommitment) ||
    !isSafeInteger(value.retryNotBefore) ||
    !isSafeInteger(value.confirmedCooldownNotBefore) ||
    !isDigest(value.canaryAttemptHighWaterCommitment) ||
    !isDigest(value.confirmedCanaryCommitment) ||
    !isDigest(value.retiredCanaryCheckpointCommitment) ||
    !isDigest(value.lifetimeConfirmedCommitment) ||
    !isDigest(value.quotaFactCommitment) ||
    (value.blocker !== null && !validLedgerBlocker(value.blocker)) ||
    !isDigest(value.blockerCommitment) ||
    value.blockerCommitment !==
      ledgerBlockerCommitment(
        value.blocker as MarketBaseResourceLedgerBlocker | null,
      ) ||
    !isDigest(value.walStateCommitment) ||
    !isDigest(value.anchorCommitment)
  ) {
    return false;
  }
  const { anchorCommitment: _anchorCommitment, ...payload } =
    value as unknown as MarketBaseResourceLedgerRuntimeAnchor;
  return value.anchorCommitment === ledgerRuntimeAnchorCommitment(payload);
}

export function buildMarketBaseResourceLedgerRuntimeAnchor(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedgerRuntimeAnchor {
  const validation = validateMarketBaseResourceLedger(
    state,
    undefined,
    permitChain,
  );
  if (!validation.ok) {
    throw new TypeError(
      validation.reason ?? "invalid ledger runtime anchor basis",
    );
  }
  return buildMarketBaseResourceLedgerRuntimeAnchorUnchecked(
    state,
    permitChain,
  );
}

function buildMarketBaseResourceLedgerRuntimeAnchorUnchecked(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
  validatedPermitRuntimeAnchor?: MarketBaseResourcePermitRuntimeAnchor,
): MarketBaseResourceLedgerRuntimeAnchor {
  const runtimeFacts = ledgerRuntimeFactCommitments(state);
  const {
    outcomeCommitment,
    processedEvidenceKeysCommitment,
    terminalSlotReservationCommitment,
    quotaFactCommitment,
  } = runtimeFacts;
  const blocker = state.blocker ? clone(state.blocker) : null;
  const blockerCommitment = ledgerBlockerCommitment(blocker);
  const walStateCommitment = ledgerWalStateCommitment(state, {
    outcomeCommitment,
    processedEvidenceKeysCommitment,
    terminalSlotReservationCommitment,
    blockerCommitment,
  });
  const payload = {
    schemaVersion: 3 as const,
    hashRevision: "market-base-resource-ledger-runtime-anchor-v1" as const,
    permitRuntimeAnchor:
      validatedPermitRuntimeAnchor ??
      buildMarketBaseResourcePermitRuntimeAnchor(permitChain),
    permitAnchorHash: state.permitAnchor.anchorHash,
    checkpointHash: state.checkpoint.checkpointHash,
    prunedThroughAttemptSeq: state.checkpoint.prunedThroughAttemptSeq,
    coverageStartTick: state.coverageStartTick,
    finalizedAttemptSeq: state.finalizedAttemptSeq,
    nextAttemptSeq: state.nextAttemptSeq,
    receiptHeadHash: state.receiptHeadHash,
    pendingAttemptSeq: state.pending?.attemptSeq ?? null,
    pendingFrozenEvidenceHash: state.pending?.frozenEvidenceHash ?? null,
    outcomeCommitment,
    processedEvidenceKeysCommitment,
    terminalSlotReservationCommitment,
    retryNotBefore: state.retryNotBefore,
    confirmedCooldownNotBefore: state.confirmedCooldownNotBefore,
    canaryAttemptHighWaterCommitment: canaryAttemptHighWaterCommitment(
      state.canaryAttemptHighWater,
    ),
    confirmedCanaryCommitment: confirmedCanaryCommitment(
      state.confirmedCanaries,
    ),
    retiredCanaryCheckpointCommitment:
      state.checkpoint.retiredCanaryCheckpoint.commitment,
    lifetimeConfirmedCommitment: canonicalStableHashV1({
      domain: "market-base-resource:ledger-lifetime-confirmed-v1",
      counters: state.lifetimeConfirmed,
    }),
    quotaFactCommitment,
    blocker,
    blockerCommitment,
    walStateCommitment,
  };
  return deepFreeze({
    ...payload,
    anchorCommitment: ledgerRuntimeAnchorCommitment(payload),
  }) as MarketBaseResourceLedgerRuntimeAnchor;
}

export function validateMarketBaseResourceLedgerRuntimeGate(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
  anchor: MarketBaseResourceLedgerRuntimeAnchor,
  tick?: number,
): MarketBaseResourceLedgerValidation {
  marketBaseResourceLedgerRuntimeTestProbe?.("runtime_gate");
  try {
    if (
      !isPlainRecord(state) ||
      !Array.isArray(state.receipts) ||
      !Array.isArray(state.legacyQuotaReceipts) ||
      !Array.isArray(state.outcomes) ||
      !Array.isArray(state.processedEvidenceKeys) ||
      !state.receipts.every(isPlainRecord) ||
      !state.legacyQuotaReceipts.every(isPlainRecord) ||
      (state.pending !== undefined && !validPending(state.pending))
    ) {
      return { ok: false, reason: "ledger_runtime_gate_mismatch" };
    }
    const runtimeFacts = ledgerRuntimeFactCommitments(state);
    if (
      !validLedgerRuntimeAnchor(anchor) ||
      !validateMarketBaseResourcePermitRuntimeGate(
        permitChain,
        anchor.permitRuntimeAnchor,
      ).ok ||
      state.receipts.length > MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT ||
      state.receipts.length + state.legacyQuotaReceipts.length >
        MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT ||
      state.outcomes.length > MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT ||
      state.processedEvidenceKeys.length >
        MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT ||
      (state.blocker !== undefined && !validLedgerBlocker(state.blocker)) ||
      !validCanaryAttemptHighWaterMap(
        state.canaryAttemptHighWater,
        state.nextAttemptSeq - 1,
      ) ||
      !validConfirmedCanaryMap(
        state.confirmedCanaries,
        state.finalizedAttemptSeq,
      ) ||
      (tick !== undefined &&
        (!isSafeInteger(tick) ||
          state.coverageStartTick >
            Math.max(
              0,
              tick - (MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS - 1),
            ))) ||
      state.permitAnchor.anchorHash !== anchor.permitAnchorHash ||
      state.checkpoint.checkpointHash !== anchor.checkpointHash ||
      state.checkpoint.prunedThroughAttemptSeq !==
        anchor.prunedThroughAttemptSeq ||
      state.coverageStartTick !== anchor.coverageStartTick ||
      state.finalizedAttemptSeq !== anchor.finalizedAttemptSeq ||
      state.nextAttemptSeq !== anchor.nextAttemptSeq ||
      state.receiptHeadHash !== anchor.receiptHeadHash ||
      (state.pending?.attemptSeq ?? null) !== anchor.pendingAttemptSeq ||
      (state.pending?.frozenEvidenceHash ?? null) !==
        anchor.pendingFrozenEvidenceHash ||
      runtimeFacts.outcomeCommitment !== anchor.outcomeCommitment ||
      runtimeFacts.processedEvidenceKeysCommitment !==
        anchor.processedEvidenceKeysCommitment ||
      runtimeFacts.terminalSlotReservationCommitment !==
        anchor.terminalSlotReservationCommitment ||
      state.retryNotBefore !== anchor.retryNotBefore ||
      state.confirmedCooldownNotBefore !== anchor.confirmedCooldownNotBefore ||
      canaryAttemptHighWaterCommitment(state.canaryAttemptHighWater) !==
        anchor.canaryAttemptHighWaterCommitment ||
      confirmedCanaryCommitment(state.confirmedCanaries) !==
        anchor.confirmedCanaryCommitment ||
      state.checkpoint.retiredCanaryCheckpoint.commitment !==
        anchor.retiredCanaryCheckpointCommitment ||
      canonicalStableHashV1({
        domain: "market-base-resource:ledger-lifetime-confirmed-v1",
        counters: state.lifetimeConfirmed,
      }) !== anchor.lifetimeConfirmedCommitment ||
      runtimeFacts.quotaFactCommitment !== anchor.quotaFactCommitment ||
      !sameCanonical(state.blocker ?? null, anchor.blocker) ||
      ledgerBlockerCommitment(state.blocker ?? null) !==
        anchor.blockerCommitment ||
      ledgerWalStateCommitment(state, {
        outcomeCommitment: anchor.outcomeCommitment,
        processedEvidenceKeysCommitment: anchor.processedEvidenceKeysCommitment,
        terminalSlotReservationCommitment:
          anchor.terminalSlotReservationCommitment,
        blockerCommitment: anchor.blockerCommitment,
      }) !== anchor.walStateCommitment
    ) {
      return { ok: false, reason: "ledger_runtime_gate_mismatch" };
    }
    if (state.blocker) {
      return { ok: false, reason: state.blocker.code };
    }
    return {
      ok: true,
      prefix: state.pending
        ? state.receipts[state.receipts.length - 1]?.attemptSeq ===
          state.pending.attemptSeq
          ? state.processedEvidenceKeys[
              state.processedEvidenceKeys.length - 1
            ]?.attemptSeq === state.pending.attemptSeq
            ? "processed_key_written"
            : "receipt_written"
          : state.outcomes[state.outcomes.length - 1]?.attemptSeq ===
              state.pending.attemptSeq
            ? "outcome_written"
            : "waiting_outcome"
        : "idle",
    };
  } catch {
    return { ok: false, reason: "ledger_runtime_gate_mismatch" };
  }
}

const MARKET_BASE_RESOURCE_LEDGER_RUNTIME_CONTEXT = Symbol(
  "market-base-resource-ledger-runtime-context",
);
const marketBaseResourceLedgerRuntimeContexts = new WeakSet<object>();
const consumedMarketBaseResourceLedgerRuntimeContexts = new WeakSet<object>();

/**
 * 本 tick 内的 opaque runtime capability。Symbol 不导出且实例必须存在于
 * 模块私有 WeakSet；Memory/JSON 反序列化或普通对象无法伪造。
 */
export interface MarketBaseResourceLedgerRuntimeContext {
  readonly state: MarketBaseResourceLedger;
  readonly permitChain: MarketBaseResourcePermitChainState;
  readonly anchor: MarketBaseResourceLedgerRuntimeAnchor;
  /** Runtime gate 后一次构建；同 tick 的 prepare/WAL successor 复用。 */
  readonly quotaReceipts: readonly MarketBaseResourceQuotaReceipt[];
  readonly tick: number;
  readonly [MARKET_BASE_RESOURCE_LEDGER_RUNTIME_CONTEXT]: true;
}

export type MarketBaseResourceLedgerRuntimeContextResult =
  | {
      readonly ok: true;
      readonly context: MarketBaseResourceLedgerRuntimeContext;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export function createMarketBaseResourceLedgerRuntimeContext(input: {
  readonly state: MarketBaseResourceLedger;
  readonly permitChain: MarketBaseResourcePermitChainState;
  readonly anchor: MarketBaseResourceLedgerRuntimeAnchor;
  readonly tick: number;
}): MarketBaseResourceLedgerRuntimeContextResult {
  if (!isSafeInteger(input.tick)) {
    return { ok: false, reason: "ledger_runtime_context_tick_invalid" };
  }
  const gate = validateMarketBaseResourceLedgerRuntimeGate(
    input.state,
    input.permitChain,
    input.anchor,
    input.tick,
  );
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason ?? "ledger_runtime_context_gate_failed",
    };
  }
  // gate 后立即复制并递归冻结 canonical snapshot，关闭 validate→use 之间
  // 的 nested mutation 窗口；外部 Memory 原对象随后变化不会污染 capability。
  const snapshot = {
    // gate 已逐字段认证 runtime authority。原位递归冻结关闭 TOCTOU，
    // 同时避免在每 tick 再 JSON clone 512-ring；所有 ledger mutator 都
    // 返回新 immutable state，不依赖对旧 Memory 对象的原位写入。
    state: deepFreeze(input.state) as MarketBaseResourceLedger,
    permitChain: deepFreeze({
      ...input.permitChain,
      retainedPermits: [
        clone(
          input.permitChain.retainedPermits[
            input.permitChain.retainedPermits.length - 1
          ],
        ),
      ],
      prefixCheckpoint: clone(input.permitChain.prefixCheckpoint),
      laneTombstoneCheckpoint: clone(input.permitChain.laneTombstoneCheckpoint),
      v2EventCutoverCheckpoint: clone(
        input.permitChain.v2EventCutoverCheckpoint,
      ),
    }) as MarketBaseResourcePermitChainState,
    anchor: deepFreeze(
      clone(input.anchor),
    ) as MarketBaseResourceLedgerRuntimeAnchor,
    quotaReceipts: deepFreeze(
      confirmedQuotaReceipts(input.state),
    ) as readonly MarketBaseResourceQuotaReceipt[],
    tick: input.tick,
  };
  return {
    ok: true,
    context: registerMarketBaseResourceLedgerRuntimeContext(snapshot),
  };
}

function registerMarketBaseResourceLedgerRuntimeContext(input: {
  readonly state: MarketBaseResourceLedger;
  readonly permitChain: MarketBaseResourcePermitChainState;
  readonly anchor: MarketBaseResourceLedgerRuntimeAnchor;
  readonly quotaReceipts: readonly MarketBaseResourceQuotaReceipt[];
  readonly tick: number;
}): MarketBaseResourceLedgerRuntimeContext {
  const context = Object.freeze({
    state: input.state,
    permitChain: input.permitChain,
    anchor: input.anchor,
    quotaReceipts: input.quotaReceipts,
    tick: input.tick,
    [MARKET_BASE_RESOURCE_LEDGER_RUNTIME_CONTEXT]: true as const,
  }) as MarketBaseResourceLedgerRuntimeContext;
  marketBaseResourceLedgerRuntimeContexts.add(context);
  return context;
}

function validMarketBaseResourceLedgerRuntimeContext(
  value: MarketBaseResourceLedgerRuntimeContext,
  consume: boolean,
): boolean {
  if (
    !marketBaseResourceLedgerRuntimeContexts.has(value) ||
    consumedMarketBaseResourceLedgerRuntimeContexts.has(value) ||
    value[MARKET_BASE_RESOURCE_LEDGER_RUNTIME_CONTEXT] !== true ||
    !Object.isFrozen(value) ||
    !isSafeInteger(value.tick) ||
    value.state.blocker !== undefined ||
    !ledgerDeepFrozenValues.has(value.state) ||
    !ledgerDeepFrozenValues.has(value.permitChain) ||
    !ledgerDeepFrozenValues.has(value.anchor) ||
    !ledgerDeepFrozenValues.has(value.quotaReceipts)
  ) {
    return false;
  }
  if (consume) {
    consumedMarketBaseResourceLedgerRuntimeContexts.add(value);
  }
  return true;
}

function sameRuntimeBlockerOrSetOnly(
  previous: MarketBaseResourceLedgerBlocker | null,
  next: MarketBaseResourceLedgerBlocker | null,
): boolean {
  return previous === null
    ? next === null || validLedgerBlocker(next)
    : next !== null && sameCanonical(previous, next);
}

function projectMarketBaseResourceLedgerRuntimeAnchor(
  context: MarketBaseResourceLedgerRuntimeContext,
  nextState: MarketBaseResourceLedger,
): MarketBaseResourceLedgerRuntimeAnchor | undefined {
  if (
    !sameRuntimeBlockerOrSetOnly(
      context.anchor.blocker,
      nextState.blocker ?? null,
    ) ||
    nextState.permitAnchor.anchorHash !== context.anchor.permitAnchorHash
  ) {
    return undefined;
  }
  const nextAnchor = buildMarketBaseResourceLedgerRuntimeAnchorUnchecked(
    nextState,
    context.permitChain,
    context.anchor.permitRuntimeAnchor,
  );
  return nextAnchor;
}

export interface MarketBaseResourceLedgerOperation {
  readonly state: MarketBaseResourceLedger;
  readonly ok: boolean;
  readonly action:
    | "prepared"
    | "outcome_written"
    | "outcome_idempotent"
    | "receipt_written"
    | "processed_key_written"
    | "pending_deleted"
    | "waiting_for_outcome"
    | "idle"
    | "blocked";
  readonly blockerCode?: string;
}

export interface MarketBaseResourceLedgerRuntimeOperation extends MarketBaseResourceLedgerOperation {
  readonly runtimeAnchor: MarketBaseResourceLedgerRuntimeAnchor;
  readonly runtimeContext: MarketBaseResourceLedgerRuntimeContext;
}

function runtimeOperation(
  context: MarketBaseResourceLedgerRuntimeContext,
  operation: MarketBaseResourceLedgerOperation,
): MarketBaseResourceLedgerRuntimeOperation {
  const nextQuotaReceipts = (() => {
    if (operation.action !== "receipt_written") {
      return context.quotaReceipts;
    }
    const receipt = operation.state.receipts[operation.state.receipts.length - 1];
    if (
      !receipt ||
      receipt.status !== "confirmed" ||
      context.quotaReceipts.some(
        (candidate) => candidate.attemptSeq === receipt.attemptSeq,
      )
    ) {
      return context.quotaReceipts;
    }
    return deepFreeze([
      ...context.quotaReceipts,
      quotaReceiptFromV3(receipt),
    ]) as readonly MarketBaseResourceQuotaReceipt[];
  })();
  const runtimeAnchor = projectMarketBaseResourceLedgerRuntimeAnchor(
    context,
    operation.state,
  );
  if (!runtimeAnchor) {
    const blocked = blockedOperation(
      context.state,
      "ledger_runtime_transition_invalid",
      context.tick,
      {
        sourceAnchorCommitment: context.anchor.anchorCommitment,
        action: operation.action,
      },
    );
    const blockedAnchor = projectMarketBaseResourceLedgerRuntimeAnchor(
      context,
      blocked.state,
    );
    if (!blockedAnchor) {
      throw new TypeError("ledger_runtime_blocker_projection_failed");
    }
    return {
      ...blocked,
      runtimeAnchor: blockedAnchor,
      runtimeContext: registerMarketBaseResourceLedgerRuntimeContext({
        state: blocked.state,
        permitChain: context.permitChain,
        anchor: blockedAnchor,
        quotaReceipts: context.quotaReceipts,
        tick: context.tick,
      }),
    };
  }
  return {
    ...operation,
    runtimeAnchor,
    runtimeContext: registerMarketBaseResourceLedgerRuntimeContext({
      state: operation.state,
      permitChain: context.permitChain,
      anchor: runtimeAnchor,
      quotaReceipts: nextQuotaReceipts,
      tick: context.tick,
    }),
  };
}

function blockedOperation(
  state: MarketBaseResourceLedger,
  code: string,
  tick: number,
  detail: unknown,
): MarketBaseResourceLedgerOperation {
  const detectedAt = isSafeInteger(tick) ? tick : state.coverageStartTick;
  const next = state.blocker
    ? state
    : ({
        ...clone(state),
        blocker: {
          code,
          detectedAt,
          detailHash: canonicalStableHashV1({
            domain: "market-base-resource:ledger-blocker-v1",
            code,
            detail,
          }),
        },
      } as MarketBaseResourceLedger);
  return {
    state: deepFreeze(next) as MarketBaseResourceLedger,
    ok: false,
    action: "blocked",
    blockerCode: code,
  };
}

function transientBlock(
  state: MarketBaseResourceLedger,
  blockerCode: string,
): MarketBaseResourceLedgerOperation {
  return {
    state,
    ok: false,
    action: "blocked",
    blockerCode,
  };
}

type PrepareCompactionResult =
  | { readonly ok: true; readonly state: MarketBaseResourceLedger }
  | { readonly ok: false; readonly reason: string };

/**
 * 新 pending 写入前在局部副本上同时为 outcome、receipt 和 processed key
 * 留出一格。只有严格离开 30k 窗口的 receipt 才能吸收到连续 checkpoint；
 * 任何一步失败都丢弃局部副本，原 state 保持不变。
 */
function compactMarketBaseResourceLedgerForPrepare(
  state: MarketBaseResourceLedger,
  tick: number,
  permitChain: MarketBaseResourcePermitChainState,
  skipFullValidation = false,
): PrepareCompactionResult {
  const windowStartTick =
    tick - (MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS - 1);
  let next = { ...state } as MarketBaseResourceLedger;
  let checkpoint = clone(next.checkpoint);
  let checkpointChanged = false;
  const legacyQuotaReceipts = next.legacyQuotaReceipts.filter(
    (receipt) => receipt.retentionTick >= windowStartTick,
  );
  if (legacyQuotaReceipts.length !== next.legacyQuotaReceipts.length) {
    checkpointChanged = true;
    next = {
      ...next,
      legacyQuotaReceipts,
    };
  }
  while (
    next.legacyQuotaReceipts.length + next.receipts.length >=
    MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT
  ) {
    const oldest = next.receipts[0];
    if (
      !oldest ||
      oldest.retentionTick >= windowStartTick ||
      oldest.attemptSeq !== checkpoint.prunedThroughAttemptSeq + 1 ||
      oldest.prevHash !== checkpoint.prunedReceiptHeadHash
    ) {
      return { ok: false, reason: "terminal_slot_unavailable" };
    }
    const prunedCanary = confirmedCanaryFromReceipt(oldest);
    const retiredCanary =
      checkpoint.retiredCanaryCheckpoint.retiredCanaries.find(
        (record) => record.laneId === oldest.laneId,
      );
    if (
      prunedCanary &&
      (retiredCanary
        ? !sameCanonical(retiredCanary.confirmed, prunedCanary)
        : checkpoint.confirmedCanaries[prunedCanary.laneId] !== undefined)
    ) {
      return {
        ok: false,
        reason: "confirmed_canary_checkpoint_conflict",
      };
    }
    const prunedCanaryAttempt = canaryAttemptFromReceipt(oldest);
    if (
      retiredCanary &&
      prunedCanaryAttempt &&
      !sameCanonical(retiredCanary.attempt, prunedCanaryAttempt)
    ) {
      return {
        ok: false,
        reason: "retired_canary_checkpoint_conflict",
      };
    }
    const canaryAttemptCheckpoint =
      prunedCanaryAttempt && !retiredCanary
        ? applyCanaryAttemptHighWater(
            checkpoint.canaryAttemptHighWater,
            prunedCanaryAttempt,
          )
        : undefined;
    if (canaryAttemptCheckpoint && "reason" in canaryAttemptCheckpoint) {
      return {
        ok: false,
        reason: canaryAttemptCheckpoint.reason,
      };
    }
    checkpoint = {
      ...checkpoint,
      prunedThroughAttemptSeq: oldest.attemptSeq,
      prunedReceiptHeadHash: oldest.headHash,
      coverageStartTick: Math.max(
        checkpoint.coverageStartTick,
        Math.max(0, windowStartTick),
      ),
      retryNotBeforeHighWater:
        oldest.status === "confirmed"
          ? checkpoint.retryNotBeforeHighWater
          : Math.max(
              checkpoint.retryNotBeforeHighWater,
              oldest.attemptAt + MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS,
            ),
      confirmedCooldownNotBeforeHighWater:
        oldest.status === "confirmed"
          ? Math.max(
              checkpoint.confirmedCooldownNotBeforeHighWater,
              oldest.transactionTime! +
                MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
            )
          : checkpoint.confirmedCooldownNotBeforeHighWater,
      lifetimeConfirmed:
        oldest.status === "confirmed"
          ? addCounter(
              checkpoint.lifetimeConfirmed,
              oldest.resource,
              oldest.sellerRoom,
              oldest.actualAmount,
            )
          : checkpoint.lifetimeConfirmed,
      canaryAttemptHighWater:
        canaryAttemptCheckpoint?.ok === true
          ? canaryAttemptCheckpoint.attempts
          : checkpoint.canaryAttemptHighWater,
      confirmedCanaries:
        prunedCanary && !retiredCanary
          ? {
              ...checkpoint.confirmedCanaries,
              [prunedCanary.laneId]: prunedCanary,
            }
          : checkpoint.confirmedCanaries,
    };
    checkpointChanged = true;
    next = {
      ...next,
      receipts: next.receipts.slice(1),
      outcomes: next.outcomes.filter(
        (outcome) => outcome.attemptSeq > oldest.attemptSeq,
      ),
      processedEvidenceKeys: next.processedEvidenceKeys.filter(
        (entry) => entry.attemptSeq > oldest.attemptSeq,
      ),
    };
  }
  if (next.outcomes.length >= MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT) {
    next = {
      ...next,
      outcomes: next.outcomes.slice(
        next.outcomes.length - (MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT - 1),
      ),
    };
  }
  if (
    next.processedEvidenceKeys.length >=
    MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT
  ) {
    next = {
      ...next,
      processedEvidenceKeys: next.processedEvidenceKeys.slice(
        next.processedEvidenceKeys.length -
          (MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT - 1),
      ),
    };
  }
  if (checkpointChanged) {
    const checkpointPayload = {
      ...checkpoint,
      coverageStartTick: Math.max(
        checkpoint.coverageStartTick,
        Math.max(0, windowStartTick),
      ),
      legacyQuotaReceiptCommitment: legacyQuotaReceiptCommitment(
        next.legacyQuotaReceipts,
      ),
      confirmedCanaryCommitment: confirmedCanaryCommitment(
        checkpoint.confirmedCanaries,
      ),
      canaryAttemptHighWaterCommitment: canaryAttemptHighWaterCommitment(
        checkpoint.canaryAttemptHighWater,
      ),
    };
    const { checkpointHash: _oldCheckpointHash, ...withoutHash } =
      checkpointPayload;
    const sealedCheckpoint: MarketBaseResourceLedgerCheckpoint = {
      ...withoutHash,
      checkpointHash: checkpointHash(withoutHash),
    };
    next = {
      ...next,
      coverageStartTick: sealedCheckpoint.coverageStartTick,
      checkpoint: sealedCheckpoint,
    };
  }
  if (skipFullValidation) {
    return {
      ok: true,
      state: deepFreeze(next) as MarketBaseResourceLedger,
    };
  }
  const validation = validateMarketBaseResourceLedger(next, tick, permitChain);
  return validation.ok
    ? {
        ok: true,
        state: deepFreeze(next) as MarketBaseResourceLedger,
      }
    : {
        ok: false,
        reason: validation.reason ?? "prepare_compaction_invalid",
      };
}

function prepareAuthorizationFailure(
  input: PrepareMarketBaseResourceAttemptInput,
  skipFullValidation = false,
): string | undefined {
  if (!skipFullValidation) {
    const permitValidation = validateMarketBaseResourcePermitChain(
      input.permitChain,
    );
    if (!permitValidation.ok) {
      return permitValidation.reason ?? "historical_permit_chain_invalid";
    }
  }
  const current =
    input.permitChain.retainedPermits[
      input.permitChain.retainedPermits.length - 1
    ];
  if (!current || current.schemaVersion !== 3) {
    return "historical_v3_permit_missing";
  }
  const historicalPermit = input.historicalPermit;
  const binding = marketBaseResourcePermitBindingFor(current);
  if (
    historicalPermit.permitId !== current.permitId ||
    historicalPermit.permitEpoch !== current.epoch ||
    historicalPermit.permitSelfHash !== current.selfHash ||
    historicalPermit.permitHead !== current.permitHead ||
    historicalPermit.prefixBindingHash !== historicalPermitBindingHash(binding)
  ) {
    return "historical_permit_reference_mismatch";
  }
  const lane = input.historicalLane;
  const grant = current.signedLaneGrants.find(
    (candidate) => candidate.laneId === lane.laneId,
  );
  if (
    !grant ||
    grant.status !== "active" ||
    grant.newDealGrant !== "enabled" ||
    grant.resource !== lane.resource ||
    grant.resourcePolicyId !== lane.resourcePolicyId ||
    grant.resourcePolicyFingerprint !== lane.resourcePolicyFingerprint ||
    grant.roomInstanceId !== lane.roomInstanceId ||
    grant.sellerRoom !== lane.sellerRoom ||
    grant.roomFingerprint !== lane.roomFingerprint ||
    grant.sharedPolicyFingerprint !== lane.sharedPolicyFingerprint ||
    grant.sharedPolicyFingerprint !== current.sharedPolicy.fingerprint
  ) {
    return "historical_lane_grant_mismatch";
  }
  if (
    (input.executionPolicy === "canary" && grant.stage !== "canary") ||
    (input.executionPolicy === "continuous" && grant.stage !== "continuous")
  ) {
    return "historical_lane_stage_mismatch";
  }
  if (
    !sameCanonical(input.firstDynamicScope, input.secondDynamicScope) ||
    input.firstDynamicScope.laneId !== lane.laneId ||
    input.firstDynamicScope.roomInstanceId !== lane.roomInstanceId ||
    input.firstDynamicScope.admissionPolicyFingerprint !==
      current.sharedPolicy.roomAdmissionPolicy.fingerprint
  ) {
    return "dynamic_scope_double_read_mismatch";
  }
  if (
    input.fullReads.firstReadFingerprint !==
    input.fullReads.secondReadFingerprint
  ) {
    return "full_read_fingerprint_mismatch";
  }
  return undefined;
}

export type MarketBaseResourceCanaryGrantAvailability =
  | {
      readonly ok: true;
      readonly available: true;
      readonly permitId: string;
      readonly permitEpoch: number;
    }
  | {
      readonly ok: true;
      readonly available: false;
      readonly reason: "canary_grant_already_attempted";
      readonly attempt: MarketBaseResourceCanaryAttemptHighWater;
    }
  | {
      readonly ok: false;
      readonly available: false;
      readonly reason: string;
      readonly attempt?: MarketBaseResourceCanaryAttemptHighWater;
    };

/**
 * Automation 的写前 one-shot 门禁。只有 current exact canary grant 所在
 * successor 还没有任何 prepare 记录时才返回 available；只要同一 laneId
 * 曾 prepare，任何更高 permit epoch/id 也不能重新发放 one-shot。
 */
export function inspectMarketBaseResourceCanaryGrantAvailability(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
  laneId: string,
): MarketBaseResourceCanaryGrantAvailability {
  return inspectMarketBaseResourceCanaryGrantAvailabilityCore(
    state,
    permitChain,
    laneId,
    false,
  );
}

function inspectMarketBaseResourceCanaryGrantAvailabilityCore(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
  laneId: string,
  skipFullValidation: boolean,
): MarketBaseResourceCanaryGrantAvailability {
  if (!isDigest(laneId)) {
    return {
      ok: false,
      available: false,
      reason: "canary_lane_id_invalid",
    };
  }
  if (!skipFullValidation) {
    const validation = validateMarketBaseResourceLedger(
      state,
      undefined,
      permitChain,
    );
    if (!validation.ok) {
      return {
        ok: false,
        available: false,
        reason: validation.reason ?? "ledger_invalid",
      };
    }
  }
  const current =
    permitChain.retainedPermits[permitChain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    return {
      ok: false,
      available: false,
      reason: "current_v3_permit_missing",
    };
  }
  const grant = current.signedLaneGrants.find(
    (candidate) => candidate.laneId === laneId,
  );
  if (
    !grant ||
    grant.status !== "active" ||
    grant.stage !== "canary" ||
    grant.newDealGrant !== "enabled"
  ) {
    return {
      ok: false,
      available: false,
      reason: "current_canary_grant_missing",
    };
  }
  const prior = state.canaryAttemptHighWater[laneId];
  const retired = state.checkpoint.retiredCanaryCheckpoint.retiredCanaries.find(
    (record) => record.laneId === laneId,
  );
  if (retired) {
    if (!retired.attempt) {
      return {
        ok: false,
        available: false,
        reason: "retired_canary_attempt_missing",
      };
    }
    return {
      ok: true,
      available: false,
      reason: "canary_grant_already_attempted",
      attempt: deepFreeze(
        clone(retired.attempt),
      ) as MarketBaseResourceCanaryAttemptHighWater,
    };
  }
  if (!prior) {
    return {
      ok: true,
      available: true,
      permitId: current.permitId,
      permitEpoch: current.epoch,
    };
  }
  return {
    ok: true,
    available: false,
    reason: "canary_grant_already_attempted",
    attempt: deepFreeze(
      clone(prior),
    ) as MarketBaseResourceCanaryAttemptHighWater,
  };
}

export function inspectMarketBaseResourceCanaryGrantAvailabilityWithRuntimeContext(
  context: MarketBaseResourceLedgerRuntimeContext,
  laneId: string,
): MarketBaseResourceCanaryGrantAvailability {
  if (!validMarketBaseResourceLedgerRuntimeContext(context, false)) {
    return {
      ok: false,
      available: false,
      reason: "ledger_runtime_context_invalid",
    };
  }
  return inspectMarketBaseResourceCanaryGrantAvailabilityCore(
    context.state,
    context.permitChain,
    laneId,
    true,
  );
}

export function prepareMarketBaseResourceAttempt(
  state: MarketBaseResourceLedger,
  input: PrepareMarketBaseResourceAttemptInput,
): MarketBaseResourceLedgerOperation {
  return prepareMarketBaseResourceAttemptCore(state, input, false);
}

function prepareMarketBaseResourceAttemptCore(
  state: MarketBaseResourceLedger,
  input: PrepareMarketBaseResourceAttemptInput,
  skipFullValidation: boolean,
  authenticatedQuotaReceipts?: readonly MarketBaseResourceQuotaReceipt[],
): MarketBaseResourceLedgerOperation {
  const trialPermit = input.trialCooldownNotBefore === undefined
    ? undefined
    : input.permitChain.retainedPermits.find((record) =>
        record.schemaVersion === 3 &&
        record.permitId === input.trialPermitId &&
        record.permitId === input.permitChain.currentPermitId);
  const trialPolicy = trialPermit?.schemaVersion === 3
    ? trialPermit.resourcePolicies.find((policy) =>
        policy.resource === input.historicalLane.resource)
    : undefined;
  const trialGrant = trialPermit?.schemaVersion === 3
    ? trialPermit.signedLaneGrants.find((grant) =>
        grant.laneId === input.historicalLane.laneId)
    : undefined;
  if (
    !isSafeInteger(input.tick) ||
    !isPositiveSafeInteger(input.resourceLimit) ||
    !isBoundedString(input.orderId, 128) ||
    !isBoundedString(input.orderRoom, 64) ||
    !isSafeInteger(input.plannedTransactionEnergy) ||
    input.plannedTransactionEnergy > 1_000 ||
    !isPositiveSafeInteger(input.plannedNetCreditsMilli) ||
    !isPositiveSafeInteger(input.worstUnitNetCreditsMilli) ||
    !isDigest(input.evidenceKeyHint) ||
    (input.trialCooldownNotBefore !== undefined &&
      (!isSafeInteger(input.trialCooldownNotBefore) ||
       input.trialCooldownNotBefore <
         state.checkpoint.confirmedCooldownNotBeforeHighWater ||
       input.executionPolicy !== "continuous" ||
       !((input.historicalLane.sellerRoom === "E4N58" &&
          input.historicalLane.resource === "X") ||
         (input.historicalLane.sellerRoom === "E1N57" &&
          input.historicalLane.resource === "L")) ||
       input.trialPermitId !== input.historicalPermit.permitId ||
       trialPolicy?.cooldownTicks !== 100 ||
       trialPolicy.fingerprint !== input.historicalLane.resourcePolicyFingerprint ||
       trialGrant?.stage !== "continuous" ||
       trialGrant.newDealGrant !== "enabled" ||
       trialGrant.status !== "active" ||
       trialGrant.roomInstanceId !== input.historicalLane.roomInstanceId)) ||
    !validExecutionEvidence(
      input.executionEvidence,
      input.tick,
      input.worstUnitNetCreditsMilli,
    )
  ) {
    return transientBlock(state, "prepare_input_invalid");
  }
  if (!skipFullValidation) {
    const validation = validateMarketBaseResourceLedger(
      state,
      input.tick,
      input.permitChain,
    );
    if (!validation.ok) {
      return blockedOperation(
        state,
        validation.reason ?? "ledger_invalid",
        input.tick,
        state,
      );
    }
  }
  if (state.pending) {
    return transientBlock(state, "single_pending_already_active");
  }
  const authorizationFailure = prepareAuthorizationFailure(
    input,
    skipFullValidation,
  );
  if (authorizationFailure) {
    return transientBlock(state, authorizationFailure);
  }
  if (input.executionPolicy === "canary") {
    const availability = inspectMarketBaseResourceCanaryGrantAvailabilityCore(
      state,
      input.permitChain,
      input.historicalLane.laneId,
      skipFullValidation,
    );
    if ("reason" in availability) {
      return transientBlock(state, availability.reason);
    }
  }
  if (
    input.executionPolicy === "canary" &&
    state.confirmedCanaries[input.historicalLane.laneId]
  ) {
    return transientBlock(state, "canary_already_confirmed");
  }
  const compacted = compactMarketBaseResourceLedgerForPrepare(
    state,
    input.tick,
    input.permitChain,
    skipFullValidation,
  );
  if ("reason" in compacted) {
    return transientBlock(state, compacted.reason);
  }
  const working = compacted.state;
  const quota = computeMarketBaseResourceQuota({
    tick: input.tick,
    resource: input.historicalLane.resource,
    sellerRoom: input.historicalLane.sellerRoom,
    resourceLimit: input.resourceLimit,
    receipts: skipFullValidation
      ? (authenticatedQuotaReceipts ?? [])
      : allQuotaReceipts(working),
    retryNotBefore: working.retryNotBefore,
  });
  if (
    [quota.global, quota.resourceQuota, quota.room, quota.lane].some(
      (layer) => layer.remaining < MARKET_BASE_RESOURCE_PLANNED_AMOUNT,
    ) ||
    input.tick < (input.trialCooldownNotBefore ??
      Math.max(quota.confirmedCooldownNotBefore,
        working.confirmedCooldownNotBefore)) ||
    input.tick < quota.retryNotBefore
  ) {
    return {
      state,
      ok: false,
      action: "blocked",
      blockerCode: "quota_or_global_cooldown",
    };
  }
  const payload: PendingWithoutHash = {
    schemaVersion: 3,
    hashRevision: MARKET_BASE_RESOURCE_PENDING_HASH_REVISION,
    attemptSeq: working.nextAttemptSeq,
    executionPolicy: input.executionPolicy,
    historicalPermit: clone(input.historicalPermit),
    historicalLane: clone(input.historicalLane),
    dynamicScope: {
      admissionPolicyFingerprint:
        input.firstDynamicScope.admissionPolicyFingerprint,
      rosterFingerprint: input.firstDynamicScope.rosterFingerprint,
      laneSetFingerprint: input.firstDynamicScope.laneSetFingerprint,
    },
    fullReads: clone(input.fullReads),
    executionEvidence: clone(input.executionEvidence),
    orderId: input.orderId,
    orderRoom: input.orderRoom,
    attemptAt: input.tick,
    plannedAmount: MARKET_BASE_RESOURCE_PLANNED_AMOUNT,
    plannedTransactionEnergy: input.plannedTransactionEnergy,
    plannedNetCreditsMilli: input.plannedNetCreditsMilli,
    worstUnitNetCreditsMilli: input.worstUnitNetCreditsMilli,
    quota,
    evidenceKeyHint: input.evidenceKeyHint,
  };
  const pending: MarketBaseResourcePendingAttempt = {
    ...payload,
    frozenEvidenceHash: pendingHash(payload),
  };
  if (!validPending(pending)) {
    return blockedOperation(
      working,
      "prepared_pending_invalid",
      input.tick,
      pending,
    );
  }
  const canaryAttempt = canaryAttemptFromPending(pending);
  const canaryAttemptHighWater = canaryAttempt
    ? applyCanaryAttemptHighWater(working.canaryAttemptHighWater, canaryAttempt)
    : undefined;
  if (canaryAttemptHighWater && "reason" in canaryAttemptHighWater) {
    return transientBlock(working, canaryAttemptHighWater.reason);
  }
  const next: MarketBaseResourceLedger = {
    ...working,
    nextAttemptSeq: working.nextAttemptSeq + 1,
    canaryAttemptHighWater:
      canaryAttemptHighWater?.ok === true
        ? canaryAttemptHighWater.attempts
        : working.canaryAttemptHighWater,
    pending,
    terminalSlotReservation: {
      attemptSeq: pending.attemptSeq,
      outcomeSlotReserved: true,
      receiptSlotReserved: true,
    },
  };
  return {
    state: deepFreeze(next) as MarketBaseResourceLedger,
    ok: true,
    action: "prepared",
  };
}

export function recordMarketBaseResourceOutcome(
  state: MarketBaseResourceLedger,
  outcome: MarketBaseResourceOutcome,
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedgerOperation {
  return recordMarketBaseResourceOutcomeCore(
    state,
    outcome,
    permitChain,
    false,
  );
}

function recordMarketBaseResourceOutcomeCore(
  state: MarketBaseResourceLedger,
  outcome: MarketBaseResourceOutcome,
  permitChain: MarketBaseResourcePermitChainState,
  skipFullValidation: boolean,
): MarketBaseResourceLedgerOperation {
  if (!skipFullValidation) {
    const validation = validateMarketBaseResourceLedger(
      state,
      undefined,
      permitChain,
    );
    if (!validation.ok) {
      return blockedOperation(
        state,
        validation.reason ?? "ledger_invalid",
        outcome.resolvedAt,
        state,
      );
    }
  }
  const existing = skipFullValidation
    ? state.outcomes[state.outcomes.length - 1]?.attemptSeq ===
      outcome.attemptSeq
      ? state.outcomes[state.outcomes.length - 1]
      : undefined
    : state.outcomes.find(
        (candidate) => candidate.attemptSeq === outcome.attemptSeq,
      );
  if (existing) {
    return sameCanonical(existing, outcome)
      ? {
          state,
          ok: true,
          action: "outcome_idempotent",
        }
      : blockedOperation(
          state,
          "outcome_conflict",
          outcome.resolvedAt,
          outcome,
        );
  }
  const existingReceipt = skipFullValidation
    ? state.receipts[state.receipts.length - 1]?.attemptSeq ===
      outcome.attemptSeq
      ? state.receipts[state.receipts.length - 1]
      : undefined
    : state.receipts.find(
        (candidate) => candidate.attemptSeq === outcome.attemptSeq,
      );
  if (existingReceipt) {
    return validOutcome(outcome) &&
      outcomeMatchesReceipt(outcome, existingReceipt)
      ? { state, ok: true, action: "outcome_idempotent" }
      : blockedOperation(
          state,
          "outcome_receipt_conflict",
          outcome.resolvedAt,
          outcome,
        );
  }
  const pending = state.pending;
  if (!pending) {
    return blockedOperation(
      state,
      "outcome_without_pending",
      outcome.resolvedAt,
      outcome,
    );
  }
  if (
    !validOutcome(outcome) ||
    !pendingMatchesOutcome(pending, outcome) ||
    state.outcomes.length >= MARKET_BASE_RESOURCE_OUTCOME_RING_LIMIT ||
    (!skipFullValidation &&
      (state.outcomes.some(
        (candidate) => candidate.evidenceKey === outcome.evidenceKey,
      ) ||
        state.receipts.some(
          (candidate) =>
            candidate.evidenceKey === outcome.evidenceKey &&
            candidate.attemptSeq !== outcome.attemptSeq,
        ) ||
        state.processedEvidenceKeys.some(
          (candidate) => candidate.key === outcome.evidenceKey,
        )))
  ) {
    return blockedOperation(
      state,
      "outcome_pending_mismatch",
      outcome.resolvedAt,
      outcome,
    );
  }
  const next = {
    ...state,
    outcomes: [...state.outcomes, clone(outcome)],
    retryNotBefore:
      outcome.status === "confirmed"
        ? state.retryNotBefore
        : Math.max(
            state.retryNotBefore,
            outcome.attemptAt + MARKET_BASE_RESOURCE_FAILED_RETRY_TICKS,
          ),
  };
  return {
    state: deepFreeze(next) as MarketBaseResourceLedger,
    ok: true,
    action: "outcome_written",
  };
}

function addCounter(
  counters: MarketBaseResourceLedgerCounters,
  resource: string,
  sellerRoom: string,
  amount: number,
): MarketBaseResourceLedgerCounters {
  const resources = clone(counters.resources) as Record<
    string,
    { count: number; amount: number }
  >;
  const rooms = clone(counters.rooms) as Record<
    string,
    { count: number; amount: number }
  >;
  const lanes = clone(counters.lanes) as Record<
    string,
    { count: number; amount: number }
  >;
  for (const [bucket, key] of [
    ["resources", resource],
    ["rooms", sellerRoom],
    ["lanes", `${resource}:${sellerRoom}`],
  ] as const) {
    const target = { resources, rooms, lanes }[bucket];
    const current = target[key] ?? { count: 0, amount: 0 };
    target[key] = {
      count: current.count + 1,
      amount: current.amount + amount,
    };
  }
  return {
    global: {
      count: counters.global.count + 1,
      amount: counters.global.amount + amount,
    },
    resources,
    rooms,
    lanes,
  };
}

function receiptFrom(
  pending: MarketBaseResourcePendingAttempt,
  outcome: MarketBaseResourceOutcome,
  prevHash: string,
): MarketBaseResourceReceipt {
  return sealReceipt(
    {
      schemaVersion: 3,
      hashRevision: MARKET_BASE_RESOURCE_RECEIPT_HASH_REVISION,
      attemptSeq: pending.attemptSeq,
      executionPolicy: pending.executionPolicy,
      status: outcome.status,
      permitId: outcome.permitId,
      permitEpoch: outcome.permitEpoch,
      laneId: outcome.laneId,
      sellerRoom: outcome.sellerRoom,
      resource: outcome.resource,
      orderId: outcome.orderId,
      orderRoom: outcome.orderRoom,
      attemptAt: outcome.attemptAt,
      plannedAmount: outcome.plannedAmount,
      resolvedAt: outcome.resolvedAt,
      retentionTick:
        outcome.status === "confirmed"
          ? outcome.transactionTime!
          : outcome.resolvedAt,
      evidenceKey: outcome.evidenceKey,
      actualAmount: outcome.actualAmount,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.transactionId !== undefined
        ? { transactionId: outcome.transactionId }
        : {}),
      ...(outcome.transactionTime !== undefined
        ? { transactionTime: outcome.transactionTime }
        : {}),
      ...(outcome.actualTransactionEnergy !== undefined
        ? {
            actualTransactionEnergy: outcome.actualTransactionEnergy,
          }
        : {}),
      ...(outcome.actualNetCreditsMilli !== undefined
        ? {
            actualNetCreditsMilli: outcome.actualNetCreditsMilli,
          }
        : {}),
      pendingEvidenceHash: outcome.pendingEvidenceHash,
      outcomeEventHash: outcome.outcomeEventHash,
    },
    prevHash,
  );
}

/**
 * 每次调用最多持久推进一个阶段，调用方必须逐次保存返回 state：
 * outcome(由 record API 写入) → receipt/head/lifetime → processed key →
 * pending delete。
 */
export function advanceMarketBaseResourceWal(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourceLedgerOperation {
  return advanceMarketBaseResourceWalCore(state, permitChain, false);
}

function advanceMarketBaseResourceWalCore(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
  skipFullValidation: boolean,
): MarketBaseResourceLedgerOperation {
  if (!skipFullValidation) {
    const validation = validateMarketBaseResourceLedger(
      state,
      undefined,
      permitChain,
    );
    if (!validation.ok) {
      return blockedOperation(
        state,
        validation.reason ?? "ledger_invalid",
        state.pending?.attemptAt ?? state.coverageStartTick,
        state,
      );
    }
  }
  const pending = state.pending;
  if (!pending) {
    return { state, ok: true, action: "idle" };
  }
  const outcome = skipFullValidation
    ? state.outcomes[state.outcomes.length - 1]?.attemptSeq ===
      pending.attemptSeq
      ? state.outcomes[state.outcomes.length - 1]
      : undefined
    : state.outcomes.find(
        (candidate) => candidate.attemptSeq === pending.attemptSeq,
      );
  if (!outcome) {
    return {
      state,
      ok: true,
      action: "waiting_for_outcome",
    };
  }
  const receipt = skipFullValidation
    ? state.receipts[state.receipts.length - 1]?.attemptSeq ===
      pending.attemptSeq
      ? state.receipts[state.receipts.length - 1]
      : undefined
    : state.receipts.find(
        (candidate) => candidate.attemptSeq === pending.attemptSeq,
      );
  if (!receipt) {
    const appended = receiptFrom(pending, outcome, state.receiptHeadHash);
    const confirmedCanary = confirmedCanaryFromReceipt(appended);
    if (
      state.legacyQuotaReceipts.length + state.receipts.length >=
        MARKET_BASE_RESOURCE_RECEIPT_RING_LIMIT ||
      (confirmedCanary && state.confirmedCanaries[confirmedCanary.laneId])
    ) {
      return blockedOperation(
        state,
        confirmedCanary
          ? "canary_confirmation_conflict"
          : "reserved_receipt_slot_missing",
        outcome.resolvedAt,
        appended,
      );
    }
    const lifetimeConfirmed =
      outcome.status === "confirmed"
        ? addCounter(
            state.lifetimeConfirmed,
            outcome.resource,
            outcome.sellerRoom,
            outcome.actualAmount,
          )
        : state.lifetimeConfirmed;
    const confirmedCanaries = confirmedCanary
      ? {
          ...state.confirmedCanaries,
          [confirmedCanary.laneId]: confirmedCanary,
        }
      : state.confirmedCanaries;
    const next = {
      ...state,
      receipts: [...state.receipts, appended],
      receiptHeadHash: appended.headHash,
      lifetimeConfirmed,
      confirmedCanaries,
      confirmedCooldownNotBefore:
        outcome.status === "confirmed"
          ? Math.max(
              state.confirmedCooldownNotBefore,
              outcome.transactionTime! +
                MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
            )
          : state.confirmedCooldownNotBefore,
      finalizedAttemptSeq: pending.attemptSeq,
    };
    return {
      state: deepFreeze(next) as MarketBaseResourceLedger,
      ok: true,
      action: "receipt_written",
    };
  }
  const processed = skipFullValidation
    ? state.processedEvidenceKeys[state.processedEvidenceKeys.length - 1]
        ?.attemptSeq === pending.attemptSeq
      ? state.processedEvidenceKeys[state.processedEvidenceKeys.length - 1]
      : undefined
    : state.processedEvidenceKeys.find(
        (candidate) => candidate.attemptSeq === pending.attemptSeq,
      );
  if (!processed) {
    const next = {
      ...state,
      processedEvidenceKeys: [
        ...state.processedEvidenceKeys,
        {
          attemptSeq: pending.attemptSeq,
          key: outcome.evidenceKey,
        },
      ].slice(-MARKET_BASE_RESOURCE_PROCESSED_KEY_RING_LIMIT),
    };
    return {
      state: deepFreeze(next) as MarketBaseResourceLedger,
      ok: true,
      action: "processed_key_written",
    };
  }
  const {
    pending: _pending,
    terminalSlotReservation: _terminalSlotReservation,
    ...next
  } = clone(state);
  return {
    state: deepFreeze(next) as MarketBaseResourceLedger,
    ok: true,
    action: "pending_deleted",
  };
}

/**
 * Runtime mutator variants consume a module-authenticated single-use context
 * and atomically return the successor state plus its exact outer anchor.
 */
export function prepareMarketBaseResourceAttemptWithRuntimeContext(
  context: MarketBaseResourceLedgerRuntimeContext,
  input: PrepareMarketBaseResourceAttemptInput,
): MarketBaseResourceLedgerRuntimeOperation {
  if (
    !validMarketBaseResourceLedgerRuntimeContext(context, false) ||
    context.tick !== input.tick ||
    !validMarketBaseResourceLedgerRuntimeContext(context, true)
  ) {
    throw new TypeError("ledger_runtime_context_invalid");
  }
  return runtimeOperation(
    context,
    prepareMarketBaseResourceAttemptCore(
      context.state,
      {
        ...input,
        permitChain: context.permitChain,
      },
      true,
      context.quotaReceipts,
    ),
  );
}

export function recordMarketBaseResourceOutcomeWithRuntimeContext(
  context: MarketBaseResourceLedgerRuntimeContext,
  outcome: MarketBaseResourceOutcome,
): MarketBaseResourceLedgerRuntimeOperation {
  if (
    !validMarketBaseResourceLedgerRuntimeContext(context, false) ||
    outcome.resolvedAt > context.tick ||
    !validMarketBaseResourceLedgerRuntimeContext(context, true)
  ) {
    throw new TypeError("ledger_runtime_context_invalid");
  }
  return runtimeOperation(
    context,
    recordMarketBaseResourceOutcomeCore(
      context.state,
      outcome,
      context.permitChain,
      true,
    ),
  );
}

export function advanceMarketBaseResourceWalWithRuntimeContext(
  context: MarketBaseResourceLedgerRuntimeContext,
): MarketBaseResourceLedgerRuntimeOperation {
  if (!validMarketBaseResourceLedgerRuntimeContext(context, true)) {
    throw new TypeError("ledger_runtime_context_invalid");
  }
  return runtimeOperation(
    context,
    advanceMarketBaseResourceWalCore(context.state, context.permitChain, true),
  );
}

export function marketBaseResourceQuotaProjection(input: {
  readonly state: MarketBaseResourceLedger;
  readonly tick: number;
  readonly lanes: readonly {
    readonly resource: string;
    readonly sellerRoom: string;
    readonly resourceLimit: number;
  }[];
}): readonly MarketBaseResourceQuotaSnapshot[] {
  const receipts = allQuotaReceipts(input.state);
  const pending = input.state.pending
    ? {
        resource: input.state.pending.historicalLane.resource,
        sellerRoom: input.state.pending.historicalLane.sellerRoom,
        plannedAmount: MARKET_BASE_RESOURCE_PLANNED_AMOUNT,
      }
    : undefined;
  return input.lanes.map((lane) => {
    const projection = computeMarketBaseResourceQuota({
      tick: input.tick,
      resource: lane.resource,
      sellerRoom: lane.sellerRoom,
      resourceLimit: lane.resourceLimit,
      receipts,
      pending,
      retryNotBefore: input.state.retryNotBefore,
    });
    return {
      ...projection,
      confirmedCooldownNotBefore: Math.max(
        projection.confirmedCooldownNotBefore,
        input.state.confirmedCooldownNotBefore,
      ),
    };
  });
}

export function marketBaseResourceQuotaProjectionWithRuntimeContext(
  context: MarketBaseResourceLedgerRuntimeContext,
  input: {
    readonly tick: number;
    readonly lanes: readonly {
      readonly resource: string;
      readonly sellerRoom: string;
      readonly resourceLimit: number;
    }[];
  },
): readonly MarketBaseResourceQuotaSnapshot[] {
  if (
    !validMarketBaseResourceLedgerRuntimeContext(context, false) ||
    input.tick !== context.tick
  ) {
    throw new TypeError("ledger_runtime_context_invalid");
  }
  const windowStartTick =
    input.tick - (MARKET_BASE_RESOURCE_ROLLING_WINDOW_TICKS - 1);
  let globalConfirmed = 0;
  let lastGlobalConfirmedAt: number | undefined;
  const resources = new Map<string, number>();
  const rooms = new Map<string, number>();
  const lanes = new Map<string, number>();
  for (const receipt of allQuotaReceipts(context.state)) {
    if (
      receipt.status !== "confirmed" ||
      receipt.transactionTime === undefined ||
      receipt.transactionTime < windowStartTick ||
      receipt.transactionTime > input.tick
    ) {
      continue;
    }
    globalConfirmed += receipt.actualAmount;
    resources.set(
      receipt.resource,
      (resources.get(receipt.resource) ?? 0) + receipt.actualAmount,
    );
    rooms.set(
      receipt.sellerRoom,
      (rooms.get(receipt.sellerRoom) ?? 0) + receipt.actualAmount,
    );
    const laneKey = `${receipt.resource}:${receipt.sellerRoom}`;
    lanes.set(laneKey, (lanes.get(laneKey) ?? 0) + receipt.actualAmount);
    lastGlobalConfirmedAt = Math.max(
      lastGlobalConfirmedAt ?? 0,
      receipt.transactionTime,
    );
  }
  const pending = context.state.pending;
  return input.lanes.map((lane) => {
    if (
      !isMarketBaseResource(lane.resource) ||
      !isBoundedString(lane.sellerRoom, 64) ||
      !isPositiveSafeInteger(lane.resourceLimit)
    ) {
      throw new TypeError("invalid runtime quota lane");
    }
    const pendingAmount = pending?.plannedAmount ?? 0;
    const pendingResource =
      pending?.historicalLane.resource === lane.resource ? pendingAmount : 0;
    const pendingRoom =
      pending?.historicalLane.sellerRoom === lane.sellerRoom
        ? pendingAmount
        : 0;
    const pendingLane =
      pendingResource > 0 &&
      pending?.historicalLane.sellerRoom === lane.sellerRoom
        ? pendingAmount
        : 0;
    const laneKey = `${lane.resource}:${lane.sellerRoom}`;
    return deepFreeze({
      tick: input.tick,
      windowStartTick,
      resource: lane.resource,
      sellerRoom: lane.sellerRoom,
      global: quotaLayer(
        "global",
        MARKET_BASE_RESOURCE_GLOBAL_QUOTA_LIMIT,
        globalConfirmed,
        pendingAmount,
      ),
      resourceQuota: quotaLayer(
        lane.resource,
        lane.resourceLimit,
        resources.get(lane.resource) ?? 0,
        pendingResource,
      ),
      room: quotaLayer(
        lane.sellerRoom,
        MARKET_BASE_RESOURCE_ROOM_QUOTA_LIMIT,
        rooms.get(lane.sellerRoom) ?? 0,
        pendingRoom,
      ),
      lane: quotaLayer(
        laneKey,
        MARKET_BASE_RESOURCE_LANE_QUOTA_LIMIT,
        lanes.get(laneKey) ?? 0,
        pendingLane,
      ),
      ...(lastGlobalConfirmedAt !== undefined ? { lastGlobalConfirmedAt } : {}),
      confirmedCooldownNotBefore: Math.max(
        lastGlobalConfirmedAt === undefined
          ? 0
          : lastGlobalConfirmedAt +
              MARKET_BASE_RESOURCE_CONFIRMED_COOLDOWN_TICKS,
        context.state.confirmedCooldownNotBefore,
      ),
      retryNotBefore: context.state.retryNotBefore,
    }) as MarketBaseResourceQuotaSnapshot;
  });
}

export interface MarketBaseResourceCurrentWalRuntimeProjection {
  readonly prefix:
    | "idle"
    | "waiting_outcome"
    | "outcome_written"
    | "receipt_written"
    | "processed_key_written";
  readonly pending: MarketBaseResourcePendingAttempt | null;
  readonly outcome: MarketBaseResourceOutcome | null;
  readonly receipt: MarketBaseResourceReceipt | null;
  readonly processedEvidenceKey: {
    readonly attemptSeq: number;
    readonly key: string;
  } | null;
}

export function marketBaseResourceCurrentWalProjectionWithRuntimeContext(
  context: MarketBaseResourceLedgerRuntimeContext,
): MarketBaseResourceCurrentWalRuntimeProjection {
  if (!validMarketBaseResourceLedgerRuntimeContext(context, false)) {
    throw new TypeError("ledger_runtime_context_invalid");
  }
  const pending = context.state.pending;
  if (!pending) {
    return deepFreeze({
      prefix: "idle",
      pending: null,
      outcome: null,
      receipt: null,
      processedEvidenceKey: null,
    }) as MarketBaseResourceCurrentWalRuntimeProjection;
  }
  const outcomeCandidate =
    context.state.outcomes[context.state.outcomes.length - 1];
  const outcome =
    outcomeCandidate?.attemptSeq === pending.attemptSeq
      ? outcomeCandidate
      : undefined;
  const receiptCandidate =
    context.state.receipts[context.state.receipts.length - 1];
  const receipt =
    receiptCandidate?.attemptSeq === pending.attemptSeq
      ? receiptCandidate
      : undefined;
  const processedCandidate =
    context.state.processedEvidenceKeys[
      context.state.processedEvidenceKeys.length - 1
    ];
  const processed =
    processedCandidate?.attemptSeq === pending.attemptSeq
      ? processedCandidate
      : undefined;
  return deepFreeze({
    prefix: processed
      ? "processed_key_written"
      : receipt
        ? "receipt_written"
        : outcome
          ? "outcome_written"
          : "waiting_outcome",
    pending: clone(pending),
    outcome: outcome ? clone(outcome) : null,
    receipt: receipt ? clone(receipt) : null,
    processedEvidenceKey: processed ? clone(processed) : null,
  }) as MarketBaseResourceCurrentWalRuntimeProjection;
}

export function hasMarketBaseResourceProcessedEvidenceKeyWithRuntimeContext(
  context: MarketBaseResourceLedgerRuntimeContext,
  evidenceKey: string,
): boolean {
  if (
    !validMarketBaseResourceLedgerRuntimeContext(context, false) ||
    !isDigest(evidenceKey)
  ) {
    throw new TypeError("ledger_runtime_context_invalid");
  }
  return context.state.processedEvidenceKeys.some(
    (entry) => entry.key === evidenceKey,
  );
}

export function marketBaseResourceConfirmedCanaryFor(
  state: MarketBaseResourceLedger,
  laneId: string,
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourceConfirmedCanary | undefined {
  if (!validateMarketBaseResourceLedger(state, undefined, permitChain).ok) {
    return undefined;
  }
  const confirmation =
    state.confirmedCanaries[laneId] ??
    state.checkpoint.retiredCanaryCheckpoint.retiredCanaries.find(
      (record) => record.laneId === laneId,
    )?.confirmed ??
    undefined;
  return confirmation
    ? (deepFreeze(clone(confirmation)) as MarketBaseResourceConfirmedCanary)
    : undefined;
}

export function marketBaseResourceConfirmedCanaryForWithRuntimeContext(
  context: MarketBaseResourceLedgerRuntimeContext,
  laneId: string,
): MarketBaseResourceConfirmedCanary | undefined {
  if (
    !validMarketBaseResourceLedgerRuntimeContext(context, false) ||
    !isDigest(laneId)
  ) {
    return undefined;
  }
  const confirmation =
    context.state.confirmedCanaries[laneId] ??
    context.state.checkpoint.retiredCanaryCheckpoint.retiredCanaries.find(
      (record) => record.laneId === laneId,
    )?.confirmed ??
    undefined;
  return confirmation
    ? (deepFreeze(clone(confirmation)) as MarketBaseResourceConfirmedCanary)
    : undefined;
}

export function buildMarketBaseResourceConfirmedCanaryProof(
  state: MarketBaseResourceLedger,
  laneId: string,
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourceValidatedConfirmedCanaryProof {
  const validation = validateMarketBaseResourceLedger(
    state,
    undefined,
    permitChain,
  );
  const confirmation =
    state.confirmedCanaries[laneId] ??
    state.checkpoint.retiredCanaryCheckpoint.retiredCanaries.find(
      (record) => record.laneId === laneId,
    )?.confirmed ??
    undefined;
  if (!validation.ok || !confirmation) {
    throw new TypeError("validated confirmed canary is unavailable");
  }
  return sealMarketBaseResourceValidatedConfirmedCanaryProof({
    ...clone(confirmation),
    ledgerCheckpointHash: state.checkpoint.checkpointHash,
    ledgerReceiptHeadHash: state.receiptHeadHash,
    ledgerPermitAnchorHash: state.permitAnchor.anchorHash,
  });
}

export interface MarketBaseResourceCanaryReviewFacts {
  readonly laneId: string;
  readonly attempt: MarketBaseResourceCanaryAttemptHighWater;
  readonly confirmed?: MarketBaseResourceConfirmedCanary;
  readonly retired: boolean;
  readonly tombstoneDischargeFingerprint?: string;
  readonly ledgerCheckpointHash: string;
  readonly ledgerReceiptHeadHash: string;
  readonly ledgerPermitAnchorHash: string;
}

/**
 * successor/operator 独立复审的逐 lane authenticated facts。confirmed 内含
 * transactionTime、actualAmount、actualTransactionEnergy 与
 * actualNetCreditsMilli；无需回查可能已裁剪的 512 receipt ring。
 */
export function marketBaseResourceCanaryReviewFactsFor(
  state: MarketBaseResourceLedger,
  laneId: string,
  permitChain: MarketBaseResourcePermitChainState,
): MarketBaseResourceCanaryReviewFacts | undefined {
  if (!validateMarketBaseResourceLedger(state, undefined, permitChain).ok) {
    return undefined;
  }
  const retired = state.checkpoint.retiredCanaryCheckpoint.retiredCanaries.find(
    (record) => record.laneId === laneId,
  );
  const attempt = state.canaryAttemptHighWater[laneId] ?? retired?.attempt;
  if (!attempt) return undefined;
  const confirmed = state.confirmedCanaries[laneId] ?? retired?.confirmed;
  return deepFreeze({
    laneId,
    attempt: clone(attempt),
    ...(confirmed ? { confirmed: clone(confirmed) } : {}),
    retired: Boolean(retired),
    ...(retired
      ? {
          tombstoneDischargeFingerprint: retired.tombstoneDischargeFingerprint,
        }
      : {}),
    ledgerCheckpointHash: state.checkpoint.checkpointHash,
    ledgerReceiptHeadHash: state.receiptHeadHash,
    ledgerPermitAnchorHash: state.permitAnchor.anchorHash,
  }) as MarketBaseResourceCanaryReviewFacts;
}

export function marketBaseResourceRetainedReceiptPermitReferences(
  state: MarketBaseResourceLedger,
  permitChain: MarketBaseResourcePermitChainState,
): readonly MarketBaseResourcePermitReference[] {
  const validation = validateMarketBaseResourceLedger(
    state,
    undefined,
    permitChain,
  );
  if (!validation.ok) {
    throw new TypeError(validation.reason ?? "ledger/permit binding invalid");
  }
  return deepFreeze(
    state.receipts.map((receipt) => ({
      sourceId: receipt.eventHash,
      permitId: receipt.permitId,
    })),
  ) as readonly MarketBaseResourcePermitReference[];
}
