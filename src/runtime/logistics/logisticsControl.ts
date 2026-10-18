import { utf8ByteLength } from "@/util/utf8";
import type { CarrierDispatchRef } from "@/runtime/dispatchOwnership/ref";
import { getMemoryService } from "@/runtime/runtimeServices";

export const LOGISTICS_CFG_SCHEMA_VERSION = 1 as const;
export const LOGISTICS_DATA_SCHEMA_VERSION = 1 as const;
export const LOGISTICS_RUNTIME_SCHEMA_VERSION = 2 as const;
export const LOGISTICS_CONTROL_STORE_LIMIT = 32;
export const LOGISTICS_CONTROL_DATA_LIMIT_BYTES = 16_384;
export const LOGISTICS_COMPACT_WIRE_FORMAT = "compact-v1" as const;
export const DEFAULT_LOGISTICS_RECORD_TTL = 100;
export const MAX_LOGISTICS_RECORD_TTL = 5_000;
export const SYNTHESIS_ROOM_LOGISTICS_PRODUCER = "synthesisControl:room" as const;

export type LogisticsControlMode = "disabled" | "shadow" | "canary" | "enabled";
export type LogisticsExecutionAuthority = "legacy" | "contract";
export type LogisticsRolloutOrigin =
  | "ordinary_balance"
  | "capacity_relief"
  | "synthesis_room"
  | "synthesis_distributed_demand"
  | "synthesis_surplus"
  | "synthesis_compatibility"
  | "power_bank_boost"
  | "survival_energy"
  | "operator"
  | "market";
export type LogisticsRollbackPhase =
  | "requested"
  | "quiescing"
  | "materializing_legacy"
  | "restoring_legacy_authority"
  | "completed"
  | "failed";
export type LogisticsPriorityClass =
  | "deadline"
  | "capacity_emergency"
  | "survival_energy"
  | "operator"
  | "production"
  | "capacity_pressure"
  | "balance"
  | "market";

export const LOGISTICS_PRIORITY_ORDER: Readonly<Record<LogisticsPriorityClass, number>> = Object.freeze({
  deadline: 0,
  capacity_emergency: 1,
  survival_energy: 2,
  operator: 3,
  production: 4,
  capacity_pressure: 5,
  balance: 6,
  market: 7,
});

export interface LogisticsRollbackRequestV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requestedAt: number;
  readonly targetAuthority: "legacy";
  readonly reason: string;
  readonly scope: {
    readonly origins: readonly LogisticsRolloutOrigin[];
    readonly sourceRooms: readonly string[];
  };
  readonly phase: LogisticsRollbackPhase;
  readonly updatedAt: number;
  readonly lastError?: string;
}

export interface LogisticsCanaryScopeV1 {
  readonly origin: LogisticsRolloutOrigin;
  readonly sourceRoomName: string;
}

export interface ResolvedLogisticsControlConfigV1 {
  readonly schemaVersion: 1;
  readonly mode: LogisticsControlMode;
  readonly canaryScopes: readonly LogisticsCanaryScopeV1[];
  readonly rollbackRequest?: LogisticsRollbackRequestV1;
  readonly valid: boolean;
  readonly issue?: "missing" | "unsupported_schema" | "malformed";
}

export interface LogisticsAuthorityDecision {
  readonly requestedAuthority: LogisticsExecutionAuthority;
  readonly effectiveAuthority: LogisticsExecutionAuthority;
  readonly sourceRoomName: string;
  readonly origin: LogisticsRolloutOrigin;
  readonly backendAvailable: boolean;
  readonly reason:
    | "mode_disabled"
    | "shadow_only"
    | "outside_canary_scope"
    | "rollback_requested"
    | "backend_unavailable"
    | "contract_requested";
  readonly rollbackRequestId?: string;
}

export interface LatestLogisticsDemandV1 {
  readonly id: string;
  readonly producer: string;
  readonly demandKey: string;
  readonly generation: number;
  readonly revision: number;
  readonly kind: "demand";
  readonly origin: LogisticsRolloutOrigin;
  readonly active: boolean;
  readonly targetRoomName: string;
  readonly resource: ResourceConstant;
  readonly desiredAmount: number;
  readonly priorityClass: LogisticsPriorityClass;
  readonly firstObservedAt: number;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly deadlineAt?: number;
  readonly fixedSourceRoomNames?: readonly string[];
  readonly minBatch?: number;
  readonly maxBatch?: number;
  readonly product?: ResourceConstant;
}

export interface LatestLogisticsDemandDraft {
  readonly demandKey: string;
  readonly origin: LogisticsRolloutOrigin;
  readonly active?: boolean;
  readonly targetRoomName: string;
  readonly resource: ResourceConstant;
  readonly desiredAmount: number;
  readonly priorityClass: LogisticsPriorityClass;
  readonly ttl?: number;
  readonly deadlineAt?: number;
  readonly fixedSourceRoomNames?: readonly string[];
  readonly minBatch?: number;
  readonly maxBatch?: number;
  readonly product?: ResourceConstant;
}

export type SynthesisObservationComparableReason =
  | "comparable"
  | "expected_policy_difference"
  | "legacy_unpaired"
  | "shadow_unpaired"
  | "out_of_scope"
  | "unsafe_candidate"
  | "input_unavailable";
export type SynthesisLegacyDecision = "created" | "merged" | "no_op" | "no_donor" | "failed";

export interface SynthesisLogisticsObservationV1 {
  readonly intentId: string;
  readonly producer: string;
  readonly demandKey: string;
  readonly inputFingerprint: string;
  readonly localAmount: number;
  readonly incomingAmount: number;
  readonly uncoveredAmount: number;
  readonly decisionOrder: number;
  readonly observedAt: number;
  readonly comparableReason: SynthesisObservationComparableReason;
  readonly legacyDecision: SynthesisLegacyDecision;
  readonly legacyPriorityRank: number;
  readonly legacyPriorityClass: LogisticsPriorityClass;
  readonly legacySourceRoomName?: string;
  readonly legacyAmount?: number;
  readonly legacyTaskId?: string;
  readonly legacyAddedAmount?: number;
  readonly legacyRemainingBefore?: number;
  readonly legacyFeeDelta?: number;
}

export interface SynthesisLogisticsObservationDraft {
  readonly demandKey: string;
  readonly inputFingerprint: string;
  readonly localAmount: number;
  readonly incomingAmount: number;
  readonly uncoveredAmount: number;
  readonly decisionOrder: number;
  readonly comparableReason: SynthesisObservationComparableReason;
  readonly legacyDecision: SynthesisLegacyDecision;
  readonly legacyPriorityRank: number;
  readonly legacyPriorityClass: LogisticsPriorityClass;
  readonly legacySourceRoomName?: string;
  readonly legacyAmount?: number;
  readonly legacyTaskId?: string;
  readonly legacyAddedAmount?: number;
  readonly legacyRemainingBefore?: number;
  readonly legacyFeeDelta?: number;
}

export type LogisticsCapacityState = "normal" | "pressure" | "emergency";

export interface LogisticsRoomResourceFactV1 {
  readonly resource: ResourceConstant;
  readonly sourceAvailableAmount: number;
  readonly sourceTerminalAmount: number;
  readonly receiverResourceHeadroom: number;
}

export interface LogisticsRoomFactV1 {
  readonly id: string;
  readonly roomName: string;
  readonly revision: number;
  readonly epochRevision: string;
  readonly epochFingerprint: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly owned: boolean;
  readonly hasStorage: boolean;
  readonly hasTerminal: boolean;
  readonly terminalReachable: boolean;
  readonly terminalReadyAt: number;
  readonly capacityState: LogisticsCapacityState;
  readonly receiverEligible: boolean;
  readonly receiverStorageHeadroom: number;
  readonly receiverTerminalHeadroom: number;
  readonly terminalStagingFreeCapacity: number;
  readonly transferBatchSize: number;
  readonly actionEnergyBudget: number;
  readonly terminalActionEnergyAmount: number;
  readonly resources: readonly LogisticsRoomResourceFactV1[];
}

export interface LogisticsRoomFactDraft {
  readonly roomName: string;
  readonly epochRevision: string;
  readonly epochFingerprint: string;
  readonly ttl?: number;
  readonly owned: boolean;
  readonly hasStorage: boolean;
  readonly hasTerminal: boolean;
  readonly terminalReachable: boolean;
  readonly terminalReadyAt: number;
  readonly capacityState: LogisticsCapacityState;
  readonly receiverEligible: boolean;
  readonly receiverStorageHeadroom: number;
  readonly receiverTerminalHeadroom: number;
  readonly terminalStagingFreeCapacity: number;
  readonly transferBatchSize: number;
  readonly actionEnergyBudget: number;
  readonly terminalActionEnergyAmount: number;
  readonly resources: readonly LogisticsRoomResourceFactV1[];
}

export type TransferContractState =
  | "planned"
  | "staging"
  | "ready"
  | "blocked"
  | "done"
  | "cancelled"
  | "failed"
  | "superseded";

export type TransferContractBlocker =
  | "receiver_pressure"
  | "lease_unavailable"
  | "source_protection"
  | "source_depleted"
  | "staging"
  | "terminal_cooldown"
  | "fee_shortage"
  | "budget_throttled"
  | "invalid_endpoint";

export interface TransferContractV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly producer: string;
  readonly demandKey: string;
  readonly intentGeneration: number;
  readonly intentRevision: number;
  readonly idempotencyKey: string;
  readonly sourceRoom: string;
  readonly targetRoom: string;
  readonly resource: ResourceConstant;
  readonly origin: LogisticsRolloutOrigin;
  readonly taskOrigin: "manual" | "automatic";
  readonly priorityClass: LogisticsPriorityClass;
  readonly createdAt: number;
  readonly committedAmount: number;
  readonly remainingAmount: number;
  readonly deliveredAmount: number;
  readonly stagedAmount: number;
  readonly sourceCommitmentAmount: number;
  readonly state: TransferContractState;
  readonly nextAttemptAt: number;
  readonly attemptCount: number;
  readonly lastProgressAt: number;
  readonly deadlineAt?: number;
  readonly supersedesContractId?: string;
  readonly blockerCode?: TransferContractBlocker;
  readonly blockedSince?: number;
  readonly capacityLeaseId?: string;
  readonly leaseEpoch?: number;
}

export interface CapacityLeaseV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly contractId: string;
  readonly receiverRoom: string;
  readonly resource: ResourceConstant;
  readonly amount: number;
  readonly epoch: number;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly state: "active" | "consumed" | "released" | "expired";
}

export interface StageWorkClaimV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly contractId: string;
  readonly workRef: CarrierDispatchRef;
  readonly creepName: string;
  readonly claimedAmount: number;
  readonly phase: "claimed" | "withdrawing" | "carrying" | "delivering";
  readonly claimedAt: number;
  readonly leaseUntil: number;
  readonly executionAuthority: "contract";
}

export interface LogisticsMarketProposalV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceRoomName: string;
  readonly kind: "market_buy" | "market_sell";
  readonly resource: ResourceConstant;
  readonly amount: number;
  readonly priorityClass: LogisticsPriorityClass;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly requestId?: string;
}

export interface LogisticsExecutionAuthorityV1 {
  readonly schemaVersion: 1;
  readonly demandId: string;
  readonly origin: LogisticsRolloutOrigin;
  readonly sourceRoomName: string;
  readonly authority: LogisticsExecutionAuthority;
  readonly selectedAt: number;
  readonly rollbackRequestId?: string;
}

export interface LogisticsGenerationV1 {
  readonly value: number;
  readonly updatedAt: number;
}

export interface LogisticsProducerSnapshotV1 {
  readonly producer: string;
  readonly epochRevision: string;
  readonly epochFingerprint: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly captureCpuUsed: number;
  readonly indexBuildCount: number;
  readonly total: number;
  readonly emitted: number;
  readonly dropped: number;
  readonly limit: number;
  readonly truncated: boolean;
}

export interface LogisticsProducerSnapshotInput {
  readonly totalCount: number;
  readonly overflowCount: number;
  readonly ttl?: number;
  readonly epochRevision?: string;
  readonly epochFingerprint?: string;
  readonly captureCpuUsed?: number;
  readonly indexBuildCount?: number;
  readonly roomFacts?: readonly LogisticsRoomFactDraft[];
}

export interface LogisticsControlStoreUsage {
  readonly utf8Bytes: number;
  readonly itemCount: number;
  readonly latestIntentCount: number;
  readonly roomFactCount: number;
  readonly synthesisObservationCount: number;
  readonly producerSnapshotCount: number;
  readonly generationCount: number;
}

export interface LogisticsControlStoreV1 {
  readonly schemaVersion: 1;
  latestIntents: Record<string, LatestLogisticsDemandV1>;
  roomFacts: Record<string, LogisticsRoomFactV1>;
  synthesisObservations: Record<string, SynthesisLogisticsObservationV1>;
  producerSnapshots: Record<string, LogisticsProducerSnapshotV1>;
  generation: Record<string, LogisticsGenerationV1>;
  cursor: number;
}

interface LogisticsControlCompactWireV1 {
  readonly schemaVersion: 1;
  readonly wireFormat: typeof LOGISTICS_COMPACT_WIRE_FORMAT;
  /** Interned UTF-8 strings referenced by tuple indexes. */
  readonly s: readonly string[];
  /** Intent tuples. */
  readonly i: readonly (readonly unknown[])[];
  /** Observation tuples keyed by intent tuple index. */
  readonly o: readonly (readonly unknown[])[];
  /** Rich room-fact tuples with nested resource columns. */
  readonly f: readonly (readonly unknown[])[];
  /** Producer snapshot tuples; generation tombstones are intentionally omitted. */
  readonly p: readonly (readonly unknown[])[];
  /** Global lifecycle high-water. */
  readonly c: number;
}

export interface LogisticsControlStoreReadFailure {
  readonly ok: false;
  readonly reason: "missing" | "malformed_owner" | "malformed_store" | "unsupported_schema";
  readonly schemaVersion?: unknown;
}

export type LogisticsControlStoreRead =
  | { readonly ok: true; readonly store: Readonly<LogisticsControlStoreV1> }
  | LogisticsControlStoreReadFailure;

export interface LogisticsControlExactStoreReadSuccess {
  readonly ok: true;
  readonly store: Readonly<LogisticsControlStoreV1>;
  readonly usage: LogisticsControlStoreUsage;
  readonly readSource:
    | "same_tick_validated_artifact"
    | "unchanged_wire_cache"
    | "strict_compact"
    | "strict_expanded";
  /** Bounded identity for pairing reads; exact mutation checks use the full private token. */
  readonly artifactToken: string;
}

export type LogisticsControlExactStoreRead =
  | LogisticsControlExactStoreReadSuccess
  | LogisticsControlStoreReadFailure;

export interface LogisticsControlCodecDiagnostics {
  readonly encodePasses: number;
  readonly decodePasses: number;
  readonly wireSerializePasses: number;
  readonly strictReads: number;
  readonly artifactFastReads: number;
  readonly unchangedWireFastReads: number;
  readonly artifactFallbacks: number;
  readonly attachSuccesses: number;
  readonly roomFactEpochShortCircuits: number;
  readonly roomFactSemanticComparisons: number;
}

export type EnsureLogisticsControlStoreResult =
  | { readonly ok: true; readonly store: LogisticsControlStoreV1; readonly created: boolean }
  | LogisticsControlStoreReadFailure;

export type ReplaceLogisticsRecordsResult<T> =
  | { readonly ok: true; readonly entries: readonly T[] }
  | { readonly ok: false; readonly reason: string };

type UnknownRecord = Record<string, unknown>;
type ResourceControlOwnerWithLogistics = UnknownRecord & { logistics?: unknown };

interface LogisticsControlValidatedArtifact {
  readonly tick: number;
  readonly owner: ResourceControlOwnerWithLogistics;
  readonly raw: LogisticsControlCompactWireV1;
  readonly exactToken: string;
  readonly artifactToken: string;
  readonly store: LogisticsControlStoreV1;
  readonly usage: LogisticsControlStoreUsage;
}

interface LogisticsControlPreparedCommit {
  readonly wire: LogisticsControlCompactWireV1;
  readonly exactToken: string;
  readonly artifactToken: string;
  readonly store: LogisticsControlStoreV1;
  readonly usage: LogisticsControlStoreUsage;
}

interface LogisticsControlCommitFailure {
  readonly ok: false;
  readonly reason:
    | "store_invariant"
    | "data_byte_limit"
    | "compact_wire_invalid";
}

type LogisticsControlCommitResult =
  | { readonly ok: true; readonly artifact: LogisticsControlValidatedArtifact }
  | LogisticsControlCommitFailure;

const logisticsControlCodecDiagnostics: {
  -readonly [Key in keyof LogisticsControlCodecDiagnostics]: number;
} = {
  encodePasses: 0,
  decodePasses: 0,
  wireSerializePasses: 0,
  strictReads: 0,
  artifactFastReads: 0,
  unchangedWireFastReads: 0,
  artifactFallbacks: 0,
  attachSuccesses: 0,
  roomFactEpochShortCircuits: 0,
  roomFactSemanticComparisons: 0,
};

let sameTickValidatedArtifact: LogisticsControlValidatedArtifact | undefined;

/**
 * 跨 tick 的 wire 等值缓存：记录最近一次 attach 成功时的完整 serialized
 * wire 与对应已冻结 store。下一 epoch 的首读（wire 尚未被任何人改写）与
 * 该 token 全串等值时直接复用 decode 结果，跳过 decode + 逐记录语义校验。
 * 命中依据是字节级全串比较，与 same-tick artifact 的防篡改强度一致：
 * 任何外部原位篡改都会改变 serialize 结果而回落到完整 strict read。
 */
interface UnchangedWireCache {
  readonly exactToken: string;
  readonly artifactToken: string;
  readonly store: LogisticsControlStoreV1;
  readonly usage: LogisticsControlStoreUsage;
}
let unchangedWireCache: UnchangedWireCache | undefined;

function isRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownValue(source: UnknownRecord, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownKeys(source: UnknownRecord): string[] | null {
  try {
    return Object.keys(source);
  } catch {
    return null;
  }
}

function defineRecordValue<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function createRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function serializeLogisticsWire(value: unknown): string | null {
  logisticsControlCodecDiagnostics.wireSerializePasses += 1;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function inspectSerializedLogisticsWire(
  serialized: string,
  format: string,
): { readonly utf8Bytes: number; readonly artifactToken: string } {
  // 字节计数保持逐码元精确（attestation 依赖 exact bytes）；
  // 摘要改为码元对混合，imul 次数减半。artifactToken 只做同 tick 身份比对。
  let utf8Bytes = 0;
  let hash = 0x811c9dc5;
  const length = serialized.length;
  for (let index = 0; index < length; index += 1) {
    const code = serialized.charCodeAt(index);
    if ((index & 1) === 0) {
      const next = index + 1 < length ? serialized.charCodeAt(index + 1) : 0;
      hash ^= code | (next << 16);
      hash = (Math.imul(hash, 0x01000193)) >>> 0;
    }
    if (code <= 0x7f) {
      utf8Bytes += 1;
    } else if (code <= 0x7ff) {
      utf8Bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < length) {
      const next = serialized.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        utf8Bytes += 4;
        index += 1;
      } else {
        utf8Bytes += 3;
      }
    } else {
      utf8Bytes += 3;
    }
  }
  return {
    utf8Bytes,
    artifactToken: `${format}:${serialized.length.toString(36)}:${hash.toString(36)}`,
  };
}

function collectionCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  return ownKeys(value)?.length ?? 0;
}

function logisticsControlStoreUsageFromBytes(
  store: Readonly<LogisticsControlStoreV1>,
  utf8Bytes: number,
): LogisticsControlStoreUsage {
  const latestIntentCount = collectionCount(store.latestIntents);
  const roomFactCount = collectionCount(store.roomFacts);
  const synthesisObservationCount = collectionCount(store.synthesisObservations);
  const producerSnapshotCount = collectionCount(store.producerSnapshots);
  const generationCount = collectionCount(store.generation);
  return {
    utf8Bytes,
    itemCount:
      latestIntentCount
      + roomFactCount
      + synthesisObservationCount
      + producerSnapshotCount
      + generationCount,
    latestIntentCount,
    roomFactCount,
    synthesisObservationCount,
    producerSnapshotCount,
    generationCount,
  };
}

export function getLogisticsControlCodecDiagnostics(): LogisticsControlCodecDiagnostics {
  return { ...logisticsControlCodecDiagnostics };
}

export function resetLogisticsControlCodecDiagnosticsForTest(): void {
  for (const key of Object.keys(logisticsControlCodecDiagnostics) as (keyof LogisticsControlCodecDiagnostics)[]) {
    logisticsControlCodecDiagnostics[key] = 0;
  }
}

export function clearLogisticsControlValidatedArtifactForTest(): void {
  sameTickValidatedArtifact = undefined;
  unchangedWireCache = undefined;
}

export function getLogisticsControlStoreUsage(
  store: Readonly<LogisticsControlStoreV1>,
): LogisticsControlStoreUsage {
  const serialized = serializeLogisticsWire(encodeCompactLogisticsStore(store));
  return logisticsControlStoreUsageFromBytes(
    store,
    serialized === null
      ? LOGISTICS_CONTROL_DATA_LIMIT_BYTES + 1
      : utf8ByteLength(serialized),
  );
}

function cloneRecord<T>(source: Record<string, T>): Record<string, T> {
  const result = createRecord<T>();
  for (const key of Object.keys(source)) defineRecordValue(result, key, source[key]);
  return result;
}

function isNonEmptyBoundedString(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** JSON wire canonical order must not depend on host locale collation. */
function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeTick(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeAmount(value: unknown): number | null {
  return isStoredAmount(value) ? value : null;
}

function isStoredAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LOGISTICS_RECORD_TTL;
  return Math.min(MAX_LOGISTICS_RECORD_TTL, Math.max(1, Math.floor(value)));
}

function isRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[WE]\d+[NS]\d+$/.test(value);
}

function isPriorityClass(value: unknown): value is LogisticsPriorityClass {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LOGISTICS_PRIORITY_ORDER, value);
}

const LOGISTICS_ROLLOUT_ORIGIN_VALUES: readonly LogisticsRolloutOrigin[] = [
  "ordinary_balance",
  "capacity_relief",
  "synthesis_room",
  "synthesis_distributed_demand",
  "synthesis_surplus",
  "synthesis_compatibility",
  "power_bank_boost",
  "survival_energy",
  "operator",
  "market",
];
const LOGISTICS_ROLLOUT_ORIGINS = new Set<LogisticsRolloutOrigin>(LOGISTICS_ROLLOUT_ORIGIN_VALUES);

const LOGISTICS_PRIORITY_CLASS_VALUES: readonly LogisticsPriorityClass[] = [
  "deadline",
  "capacity_emergency",
  "survival_energy",
  "operator",
  "production",
  "capacity_pressure",
  "balance",
  "market",
];

const LOGISTICS_ROLLBACK_PHASES = new Set<LogisticsRollbackPhase>([
  "requested",
  "quiescing",
  "materializing_legacy",
  "restoring_legacy_authority",
  "completed",
  "failed",
]);

const SYNTHESIS_OBSERVATION_REASON_VALUES: readonly SynthesisObservationComparableReason[] = [
  "comparable",
  "expected_policy_difference",
  "legacy_unpaired",
  "shadow_unpaired",
  "out_of_scope",
  "unsafe_candidate",
  "input_unavailable",
];
const SYNTHESIS_OBSERVATION_REASONS = new Set<SynthesisObservationComparableReason>(
  SYNTHESIS_OBSERVATION_REASON_VALUES,
);

const SYNTHESIS_LEGACY_DECISION_VALUES: readonly SynthesisLegacyDecision[] = [
  "created",
  "merged",
  "no_op",
  "no_donor",
  "failed",
];
const SYNTHESIS_LEGACY_DECISIONS = new Set<SynthesisLegacyDecision>(SYNTHESIS_LEGACY_DECISION_VALUES);

const LOGISTICS_CAPACITY_STATE_VALUES: readonly LogisticsCapacityState[] = [
  "normal",
  "pressure",
  "emergency",
];

function isRolloutOrigin(value: unknown): value is LogisticsRolloutOrigin {
  return typeof value === "string" && LOGISTICS_ROLLOUT_ORIGINS.has(value as LogisticsRolloutOrigin);
}

function isRollbackPhase(value: unknown): value is LogisticsRollbackPhase {
  return typeof value === "string" && LOGISTICS_ROLLBACK_PHASES.has(value as LogisticsRollbackPhase);
}

function normalizeRoomNames(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LOGISTICS_CONTROL_STORE_LIMIT) return null;
  const roomNames = [...new Set(value.filter(isRoomName))].sort(compareCanonicalStrings);
  return roomNames.length === value.length ? roomNames : null;
}

function encodeIntentBaseKey(producer: string, demandKey: string): string {
  return JSON.stringify(["logistics-intent/v1", producer, demandKey]);
}

function encodeIntentId(producer: string, demandKey: string, generation: number): string {
  return JSON.stringify(["logistics-demand/v1", producer, demandKey, generation]);
}

function encodeRoomFactKey(roomName: string): string {
  return JSON.stringify(["logistics-room-fact/v1", roomName]);
}

function encodeProducerSnapshotKey(producer: string): string {
  return JSON.stringify(["logistics-producer-snapshot/v1", producer]);
}

function decodeIntentBaseKey(key: string): readonly [string, string] | null {
  try {
    const decoded = JSON.parse(key) as unknown;
    return Array.isArray(decoded)
      && decoded.length === 3
      && decoded[0] === "logistics-intent/v1"
      && isNonEmptyBoundedString(decoded[1])
      && isNonEmptyBoundedString(decoded[2])
      ? [decoded[1], decoded[2]]
      : null;
  } catch {
    return null;
  }
}

const LOGISTICS_COMPACT_STRING_LIMIT = 512;

function compactEnumIndex<T extends string>(values: readonly T[], value: T): number {
  return values.indexOf(value);
}

function compactEnumValue<T extends string>(values: readonly T[], index: unknown): T | null {
  return isSafeTick(index) && index < values.length ? values[index] : null;
}

function encodeCompactLogisticsStore(
  store: Readonly<LogisticsControlStoreV1>,
): LogisticsControlCompactWireV1 {
  logisticsControlCodecDiagnostics.encodePasses += 1;
  const strings: string[] = [];
  const stringIndexes = new Map<string, number>();
  const intern = (value: string): number => {
    const current = stringIndexes.get(value);
    if (current !== undefined) return current;
    const index = strings.length;
    strings.push(value);
    stringIndexes.set(value, index);
    return index;
  };
  const optionalString = (value: string | undefined): number | null =>
    value === undefined ? null : intern(value);

  const intentEntries = Object.entries(store.latestIntents)
    .sort(([left], [right]) => compareCanonicalStrings(left, right));
  const intentIndexById = new Map<string, number>();
  const intents = intentEntries.map(([, intent], index) => {
    intentIndexById.set(intent.id, index);
    return [
      intern(intent.producer),
      intern(intent.demandKey),
      intent.generation,
      intent.revision,
      compactEnumIndex(LOGISTICS_ROLLOUT_ORIGIN_VALUES, intent.origin),
      intent.active ? 1 : 0,
      intern(intent.targetRoomName),
      intern(intent.resource),
      intent.desiredAmount,
      compactEnumIndex(LOGISTICS_PRIORITY_CLASS_VALUES, intent.priorityClass),
      intent.firstObservedAt,
      intent.observedAt,
      intent.expiresAt,
      intent.deadlineAt ?? null,
      intent.fixedSourceRoomNames?.map(intern) ?? null,
      intent.minBatch ?? null,
      intent.maxBatch ?? null,
      optionalString(intent.product),
    ];
  });

  const observations = Object.values(store.synthesisObservations)
    .sort((left, right) => {
      const leftIndex = intentIndexById.get(left.intentId) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = intentIndexById.get(right.intentId) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    })
    .map((observation) => [
      intentIndexById.get(observation.intentId) ?? -1,
      intern(observation.inputFingerprint),
      observation.localAmount,
      observation.incomingAmount,
      observation.uncoveredAmount,
      observation.decisionOrder,
      observation.observedAt,
      compactEnumIndex(SYNTHESIS_OBSERVATION_REASON_VALUES, observation.comparableReason),
      compactEnumIndex(SYNTHESIS_LEGACY_DECISION_VALUES, observation.legacyDecision),
      observation.legacyPriorityRank,
      compactEnumIndex(LOGISTICS_PRIORITY_CLASS_VALUES, observation.legacyPriorityClass),
      optionalString(observation.legacySourceRoomName),
      observation.legacyAmount ?? null,
      optionalString(observation.legacyTaskId),
      observation.legacyAddedAmount ?? null,
      observation.legacyRemainingBefore ?? null,
      observation.legacyFeeDelta ?? null,
    ]);

  const facts = Object.values(store.roomFacts)
    .sort((left, right) => compareCanonicalStrings(left.roomName, right.roomName))
    .map((fact) => [
      intern(fact.roomName),
      fact.revision,
      intern(fact.epochRevision),
      intern(fact.epochFingerprint),
      fact.observedAt,
      fact.expiresAt,
      (fact.owned ? 1 : 0)
        | (fact.hasStorage ? 2 : 0)
        | (fact.hasTerminal ? 4 : 0)
        | (fact.terminalReachable ? 8 : 0)
        | (fact.receiverEligible ? 16 : 0),
      fact.terminalReadyAt,
      compactEnumIndex(LOGISTICS_CAPACITY_STATE_VALUES, fact.capacityState),
      fact.receiverStorageHeadroom,
      fact.receiverTerminalHeadroom,
      fact.terminalStagingFreeCapacity,
      fact.transferBatchSize,
      fact.actionEnergyBudget,
      fact.terminalActionEnergyAmount,
      [...fact.resources]
        .sort((left, right) => compareCanonicalStrings(left.resource, right.resource))
        .map((resource) => [
          intern(resource.resource),
          resource.sourceAvailableAmount,
          resource.sourceTerminalAmount,
          resource.receiverResourceHeadroom,
        ]),
    ]);

  const producerSnapshots = Object.values(store.producerSnapshots)
    .sort((left, right) => compareCanonicalStrings(left.producer, right.producer))
    .map((snapshot) => [
      intern(snapshot.producer),
      intern(snapshot.epochRevision),
      intern(snapshot.epochFingerprint),
      snapshot.observedAt,
      snapshot.expiresAt,
      snapshot.captureCpuUsed,
      snapshot.indexBuildCount,
      snapshot.total,
      snapshot.emitted,
      snapshot.dropped,
      snapshot.limit,
      snapshot.truncated ? 1 : 0,
    ]);

  return {
    schemaVersion: LOGISTICS_DATA_SCHEMA_VERSION,
    wireFormat: LOGISTICS_COMPACT_WIRE_FORMAT,
    s: strings,
    i: intents,
    o: observations,
    f: facts,
    p: producerSnapshots,
    c: store.cursor,
  };
}

function decodeCompactLogisticsStore(
  raw: UnknownRecord,
  options?: { trustedRecords?: boolean },
): LogisticsControlStoreV1 | null {
  // trustedRecords：wire 来自本 tick 对已校验 store 的 encode（attach 路径），
  // 逐记录 isXxxRecord 复核可省；写入结果仍会在下一 tick 的 strict read
  // 与 monitor 侧被完整校验，编解码不对称只会 fail closed 一个 epoch。
  const trusted = options?.trustedRecords === true;
  logisticsControlCodecDiagnostics.decodePasses += 1;
  const rawStrings = ownValue(raw, "s");
  const rawIntents = ownValue(raw, "i");
  const rawObservations = ownValue(raw, "o");
  const rawFacts = ownValue(raw, "f");
  const rawSnapshots = ownValue(raw, "p");
  const cursor = ownValue(raw, "c");
  if (
    !Array.isArray(rawStrings)
    || rawStrings.length > LOGISTICS_COMPACT_STRING_LIMIT
    || !rawStrings.every((value) => isNonEmptyBoundedString(value, 512))
    || !Array.isArray(rawIntents)
    || rawIntents.length > LOGISTICS_CONTROL_STORE_LIMIT
    || !Array.isArray(rawObservations)
    || rawObservations.length > LOGISTICS_CONTROL_STORE_LIMIT
    || !Array.isArray(rawFacts)
    || rawFacts.length > LOGISTICS_CONTROL_STORE_LIMIT
    || !Array.isArray(rawSnapshots)
    || rawSnapshots.length > LOGISTICS_CONTROL_STORE_LIMIT
    || !isSafeTick(cursor)
  ) return null;
  const strings = rawStrings as string[];
  const readString = (index: unknown): string | null =>
    isSafeTick(index) && index < strings.length ? strings[index] : null;
  const readOptionalString = (index: unknown): string | undefined | null =>
    index === null ? undefined : readString(index);
  const readOptionalAmount = (value: unknown): number | undefined | null =>
    value === null ? undefined : (isStoredAmount(value) ? value : null);

  const latestIntents = createRecord<LatestLogisticsDemandV1>();
  const decodedIntents: LatestLogisticsDemandV1[] = [];
  for (const rawIntent of rawIntents) {
    if (!Array.isArray(rawIntent) || rawIntent.length !== 18) return null;
    const producer = readString(rawIntent[0]);
    const demandKey = readString(rawIntent[1]);
    const origin = compactEnumValue(LOGISTICS_ROLLOUT_ORIGIN_VALUES, rawIntent[4]);
    const targetRoomName = readString(rawIntent[6]);
    const resource = readString(rawIntent[7]);
    const priorityClass = compactEnumValue(LOGISTICS_PRIORITY_CLASS_VALUES, rawIntent[9]);
    const fixedIndexes = rawIntent[14];
    const fixedSourceRoomNames = fixedIndexes === null
      ? undefined
      : Array.isArray(fixedIndexes)
        ? fixedIndexes.map(readString)
        : null;
    const product = readOptionalString(rawIntent[17]);
    const minBatch = readOptionalAmount(rawIntent[15]);
    const maxBatch = readOptionalAmount(rawIntent[16]);
    if (
      !producer
      || !demandKey
      || !origin
      || !targetRoomName
      || !resource
      || !priorityClass
      || (rawIntent[5] !== 0 && rawIntent[5] !== 1)
      || fixedSourceRoomNames === null
      || fixedSourceRoomNames?.some((roomName) => roomName === null)
      || product === null
      || minBatch === null
      || maxBatch === null
    ) return null;
    const generation = rawIntent[2];
    const deadlineAt = rawIntent[13];
    const intent: LatestLogisticsDemandV1 = {
      id: encodeIntentId(producer, demandKey, generation as number),
      producer,
      demandKey,
      generation: generation as number,
      revision: rawIntent[3] as number,
      kind: "demand",
      origin,
      active: rawIntent[5] === 1,
      targetRoomName,
      resource: resource as ResourceConstant,
      desiredAmount: rawIntent[8] as number,
      priorityClass,
      firstObservedAt: rawIntent[10] as number,
      observedAt: rawIntent[11] as number,
      expiresAt: rawIntent[12] as number,
      ...(deadlineAt === null ? {} : { deadlineAt: deadlineAt as number }),
      ...(fixedSourceRoomNames === undefined
        ? {}
        : { fixedSourceRoomNames: fixedSourceRoomNames as string[] }),
      ...(minBatch === undefined ? {} : { minBatch }),
      ...(maxBatch === undefined ? {} : { maxBatch }),
      ...(product === undefined ? {} : { product: product as ResourceConstant }),
    };
    if (!trusted && !isDemandRecord(intent)) return null;
    const key = encodeIntentBaseKey(producer, demandKey);
    if (Object.prototype.hasOwnProperty.call(latestIntents, key)) return null;
    defineRecordValue(latestIntents, key, intent);
    decodedIntents.push(intent);
  }

  const synthesisObservations = createRecord<SynthesisLogisticsObservationV1>();
  for (const rawObservation of rawObservations) {
    if (!Array.isArray(rawObservation) || rawObservation.length !== 17) return null;
    const intentIndex = rawObservation[0];
    if (!isSafeTick(intentIndex) || intentIndex >= decodedIntents.length) return null;
    const intent = decodedIntents[intentIndex];
    const inputFingerprint = readString(rawObservation[1]);
    const comparableReason = compactEnumValue(
      SYNTHESIS_OBSERVATION_REASON_VALUES,
      rawObservation[7],
    );
    const legacyDecision = compactEnumValue(SYNTHESIS_LEGACY_DECISION_VALUES, rawObservation[8]);
    const legacyPriorityClass = compactEnumValue(LOGISTICS_PRIORITY_CLASS_VALUES, rawObservation[10]);
    const legacySourceRoomName = readOptionalString(rawObservation[11]);
    const legacyAmount = readOptionalAmount(rawObservation[12]);
    const legacyTaskId = readOptionalString(rawObservation[13]);
    const legacyAddedAmount = readOptionalAmount(rawObservation[14]);
    const legacyRemainingBefore = readOptionalAmount(rawObservation[15]);
    const legacyFeeDelta = readOptionalAmount(rawObservation[16]);
    if (
      !inputFingerprint
      || !comparableReason
      || !legacyDecision
      || !legacyPriorityClass
      || legacySourceRoomName === null
      || legacyAmount === null
      || legacyTaskId === null
      || legacyAddedAmount === null
      || legacyRemainingBefore === null
      || legacyFeeDelta === null
    ) return null;
    const observation: SynthesisLogisticsObservationV1 = {
      intentId: intent.id,
      producer: intent.producer,
      demandKey: intent.demandKey,
      inputFingerprint,
      localAmount: rawObservation[2] as number,
      incomingAmount: rawObservation[3] as number,
      uncoveredAmount: rawObservation[4] as number,
      decisionOrder: rawObservation[5] as number,
      observedAt: rawObservation[6] as number,
      comparableReason,
      legacyDecision,
      legacyPriorityRank: rawObservation[9] as number,
      legacyPriorityClass,
      ...(legacySourceRoomName === undefined ? {} : { legacySourceRoomName }),
      ...(legacyAmount === undefined ? {} : { legacyAmount }),
      ...(legacyTaskId === undefined ? {} : { legacyTaskId }),
      ...(legacyAddedAmount === undefined ? {} : { legacyAddedAmount }),
      ...(legacyRemainingBefore === undefined ? {} : { legacyRemainingBefore }),
      ...(legacyFeeDelta === undefined ? {} : { legacyFeeDelta }),
    };
    if (
      (!trusted && !isSynthesisObservationRecord(observation))
      || Object.prototype.hasOwnProperty.call(synthesisObservations, intent.id)
    ) return null;
    defineRecordValue(synthesisObservations, intent.id, observation);
  }

  const roomFacts = createRecord<LogisticsRoomFactV1>();
  for (const rawFact of rawFacts) {
    if (!Array.isArray(rawFact) || rawFact.length !== 16) return null;
    const roomName = readString(rawFact[0]);
    const epochRevision = readString(rawFact[2]);
    const epochFingerprint = readString(rawFact[3]);
    const flags = rawFact[6];
    const capacityState = compactEnumValue(LOGISTICS_CAPACITY_STATE_VALUES, rawFact[8]);
    const rawResources = rawFact[15];
    if (
      !roomName
      || !epochRevision
      || !epochFingerprint
      || !isSafeTick(flags)
      || flags > 31
      || !capacityState
      || !Array.isArray(rawResources)
      || rawResources.length > LOGISTICS_CONTROL_STORE_LIMIT
    ) return null;
    const resources: LogisticsRoomResourceFactV1[] = [];
    for (const rawResource of rawResources) {
      if (!Array.isArray(rawResource) || rawResource.length !== 4) return null;
      const resource = readString(rawResource[0]);
      if (!resource) return null;
      resources.push({
        resource: resource as ResourceConstant,
        sourceAvailableAmount: rawResource[1] as number,
        sourceTerminalAmount: rawResource[2] as number,
        receiverResourceHeadroom: rawResource[3] as number,
      });
    }
    const key = encodeRoomFactKey(roomName);
    const fact: LogisticsRoomFactV1 = {
      id: key,
      roomName,
      revision: rawFact[1] as number,
      epochRevision,
      epochFingerprint,
      observedAt: rawFact[4] as number,
      expiresAt: rawFact[5] as number,
      owned: (flags & 1) !== 0,
      hasStorage: (flags & 2) !== 0,
      hasTerminal: (flags & 4) !== 0,
      terminalReachable: (flags & 8) !== 0,
      receiverEligible: (flags & 16) !== 0,
      terminalReadyAt: rawFact[7] as number,
      capacityState,
      receiverStorageHeadroom: rawFact[9] as number,
      receiverTerminalHeadroom: rawFact[10] as number,
      terminalStagingFreeCapacity: rawFact[11] as number,
      transferBatchSize: rawFact[12] as number,
      actionEnergyBudget: rawFact[13] as number,
      terminalActionEnergyAmount: rawFact[14] as number,
      resources,
    };
    if ((!trusted && !isRoomFactRecord(fact)) || Object.prototype.hasOwnProperty.call(roomFacts, key)) return null;
    defineRecordValue(roomFacts, key, fact);
  }

  const producerSnapshots = createRecord<LogisticsProducerSnapshotV1>();
  for (const rawSnapshot of rawSnapshots) {
    if (!Array.isArray(rawSnapshot) || rawSnapshot.length !== 12) return null;
    const producer = readString(rawSnapshot[0]);
    const epochRevision = readString(rawSnapshot[1]);
    const epochFingerprint = readString(rawSnapshot[2]);
    if (!producer || !epochRevision || !epochFingerprint || (rawSnapshot[11] !== 0 && rawSnapshot[11] !== 1)) {
      return null;
    }
    const snapshot: LogisticsProducerSnapshotV1 = {
      producer,
      epochRevision,
      epochFingerprint,
      observedAt: rawSnapshot[3] as number,
      expiresAt: rawSnapshot[4] as number,
      captureCpuUsed: rawSnapshot[5] as number,
      indexBuildCount: rawSnapshot[6] as number,
      total: rawSnapshot[7] as number,
      emitted: rawSnapshot[8] as number,
      dropped: rawSnapshot[9] as number,
      limit: rawSnapshot[10] as number,
      truncated: rawSnapshot[11] === 1,
    };
    const key = encodeProducerSnapshotKey(producer);
    if (
      (!trusted && !isProducerSnapshotRecord(snapshot))
      || Object.prototype.hasOwnProperty.call(producerSnapshots, key)
    ) {
      return null;
    }
    defineRecordValue(producerSnapshots, key, snapshot);
  }

  const generation = createRecord<LogisticsGenerationV1>();
  for (const [key, intent] of Object.entries(latestIntents)) {
    defineRecordValue(generation, key, { value: intent.generation, updatedAt: intent.observedAt });
  }
  return {
    schemaVersion: LOGISTICS_DATA_SCHEMA_VERSION,
    latestIntents,
    roomFacts,
    synthesisObservations,
    producerSnapshots,
    generation,
    cursor,
  };
}

function readResourceControlOwner(): ResourceControlOwnerWithLogistics | undefined | null {
  const data = (Memory as unknown as { data?: unknown }).data;
  if (data === undefined) return undefined;
  if (!isRecord(data)) return null;
  const owner = ownValue(data, "resourceControl");
  if (owner === undefined) return undefined;
  return isRecord(owner) ? owner : null;
}

function prepareValidatedCompactLogisticsStore(
  store: Readonly<LogisticsControlStoreV1>,
): LogisticsControlPreparedCommit | LogisticsControlCommitFailure {
  // store 全部来自已校验输入：保留条目经 strict read / same-tick artifact /
  // unchanged-wire 缓存的完整校验，新条目经草稿归一化 + preflight 跨记录配对
  // + buildRoomFactReplacement fail-closed 归一化。逐记录 isXxxRecord 复核
  // 在该路径上属重复劳动；跨记录不变量（intent↔observation 配对、snapshot
  // emitted 计数、generation/cursor 一致）仍全量复核，构造错误最迟在下一
  // tick strict read fail closed 一个 epoch。
  if (
    !hasValidBoundedStoreEntriesSemantic(store as unknown as UnknownRecord, {
      trustedRecords: true,
    })
  ) {
    return { ok: false, reason: "store_invariant" };
  }
  const wire = encodeCompactLogisticsStore(store);
  if (
    wire.s.length > LOGISTICS_COMPACT_STRING_LIMIT
    || wire.s.some((value) => !isNonEmptyBoundedString(value, 512))
  ) return { ok: false, reason: "compact_wire_invalid" };
  const exactToken = serializeLogisticsWire(wire);
  if (exactToken === null) return { ok: false, reason: "compact_wire_invalid" };
  const identity = inspectSerializedLogisticsWire(exactToken, LOGISTICS_COMPACT_WIRE_FORMAT);
  if (identity.utf8Bytes > LOGISTICS_CONTROL_DATA_LIMIT_BYTES) {
    return { ok: false, reason: "data_byte_limit" };
  }
  // artifact store 必须保持 decode 侧 canonical 形态（字段序与 wire 解码
  // 一致，monitor replay 与测试的字节级比较依赖它），故保留 decode 往返；
  // trustedRecords 表示 encode 输入已通过上方跨记录校验，decode 侧跳过
  // 逐记录谓词复核。
  const decoded = decodeCompactLogisticsStore(wire as unknown as UnknownRecord, {
    trustedRecords: true,
  });
  if (!decoded) {
    return { ok: false, reason: "compact_wire_invalid" };
  }
  try {
    freezeLogisticsControlArtifactStore(decoded);
  } catch {
    return { ok: false, reason: "compact_wire_invalid" };
  }
  const usage = Object.freeze(
    logisticsControlStoreUsageFromBytes(decoded, identity.utf8Bytes),
  );
  return {
    wire,
    exactToken,
    artifactToken: identity.artifactToken,
    store: decoded,
    usage,
  };
}

/**
 * Artifact semantics are detached from the compact Memory wire. Freeze the
 * entire decoded graph before caching/exposing it so a same-tick reader cannot
 * mutate the semantic view while the raw attestation token remains unchanged.
 * Writer drafts are encoded first and are never frozen by this boundary.
 */
function freezeLogisticsControlArtifactStore(
  store: LogisticsControlStoreV1,
): void {
  const visited = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(store);
}

function attachLogisticsStore(
  owner: ResourceControlOwnerWithLogistics,
  store: LogisticsControlStoreV1,
): LogisticsControlCommitResult {
  const prepared = prepareValidatedCompactLogisticsStore(store);
  if ("ok" in prepared) return prepared;
  sameTickValidatedArtifact = undefined;
  try {
    Object.defineProperty(owner, "logistics", {
      value: prepared.wire,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } catch {
    return { ok: false, reason: "compact_wire_invalid" };
  }
  if (ownValue(owner, "logistics") !== prepared.wire) {
    return { ok: false, reason: "compact_wire_invalid" };
  }
  const artifact: LogisticsControlValidatedArtifact = {
    tick: Game.time,
    owner,
    raw: prepared.wire,
    exactToken: prepared.exactToken,
    artifactToken: prepared.artifactToken,
    store: prepared.store,
    usage: prepared.usage,
  };
  sameTickValidatedArtifact = artifact;
  unchangedWireCache = {
    exactToken: prepared.exactToken,
    artifactToken: prepared.artifactToken,
    store: prepared.store,
    usage: prepared.usage,
  };
  logisticsControlCodecDiagnostics.attachSuccesses += 1;
  return { ok: true, artifact };
}

function createEmptyStore(): LogisticsControlStoreV1 {
  return {
    schemaVersion: LOGISTICS_DATA_SCHEMA_VERSION,
    latestIntents: createRecord<LatestLogisticsDemandV1>(),
    roomFacts: createRecord<LogisticsRoomFactV1>(),
    synthesisObservations: createRecord<SynthesisLogisticsObservationV1>(),
    producerSnapshots: createRecord<LogisticsProducerSnapshotV1>(),
    generation: createRecord<LogisticsGenerationV1>(),
    cursor: 0,
  };
}

function isStoreCollectionsShape(value: UnknownRecord): boolean {
  return isRecord(ownValue(value, "latestIntents"))
    && isRecord(ownValue(value, "roomFacts"))
    && isRecord(ownValue(value, "synthesisObservations"))
    && isRecord(ownValue(value, "producerSnapshots"))
    && isRecord(ownValue(value, "generation"))
    && isSafeTick(ownValue(value, "cursor"));
}

function hasValidBoundedStoreEntriesSemantic(
  value: UnknownRecord,
  options?: { trustedRecords?: boolean },
): boolean {
  // trustedRecords：记录级 isXxxRecord 校验由调用方保证已完成（decode 逐记录
  // 校验后失败即返回 null），此处只复核跨记录不变量，避免双重遍历。
  const trusted = options?.trustedRecords === true;
  const latestIntents = ownValue(value, "latestIntents");
  const roomFacts = ownValue(value, "roomFacts");
  const synthesisObservations = ownValue(value, "synthesisObservations");
  const producerSnapshots = ownValue(value, "producerSnapshots");
  const generation = ownValue(value, "generation");
  const cursor = ownValue(value, "cursor");
  if (
    !isRecord(latestIntents)
    || !isRecord(roomFacts)
    || !isRecord(synthesisObservations)
    || !isRecord(producerSnapshots)
    || !isRecord(generation)
    || !isSafeTick(cursor)
  ) {
    return false;
  }
  const intentKeys = ownKeys(latestIntents);
  const factKeys = ownKeys(roomFacts);
  const observationKeys = ownKeys(synthesisObservations);
  const snapshotKeys = ownKeys(producerSnapshots);
  const generationKeys = ownKeys(generation);
  if (
    !intentKeys || !factKeys || !observationKeys || !snapshotKeys || !generationKeys
    || intentKeys.length > LOGISTICS_CONTROL_STORE_LIMIT
    || factKeys.length > LOGISTICS_CONTROL_STORE_LIMIT
    || observationKeys.length > LOGISTICS_CONTROL_STORE_LIMIT
    || snapshotKeys.length > LOGISTICS_CONTROL_STORE_LIMIT
    || generationKeys.length > LOGISTICS_CONTROL_STORE_LIMIT
  ) return false;

  const intentsById = new Map<string, LatestLogisticsDemandV1>();
  const intentCountByProducer = new Map<string, number>();
  const intentExpiresAtByProducer = new Map<string, number>();
  for (const key of intentKeys) {
    const rawIntent = ownValue(latestIntents, key);
    if (rawIntent === undefined || (!trusted && !isDemandRecord(rawIntent))) return false;
    const intent = rawIntent as LatestLogisticsDemandV1;
    if (
      key !== encodeIntentBaseKey(intent.producer, intent.demandKey)
      || intent.generation > cursor
    ) return false;
    intentsById.set(intent.id, intent);
    intentCountByProducer.set(intent.producer, (intentCountByProducer.get(intent.producer) ?? 0) + 1);
    intentExpiresAtByProducer.set(
      intent.producer,
      Math.max(intentExpiresAtByProducer.get(intent.producer) ?? 0, intent.expiresAt),
    );
    const generationEntry = ownValue(generation, key);
    const generationRecord = generationValue(generationEntry);
    if (!generationRecord || generationRecord.value < intent.generation) return false;
  }
  for (const key of factKeys) {
    const rawFact = ownValue(roomFacts, key);
    if (rawFact === undefined || (!trusted && !isRoomFactRecord(rawFact))) return false;
    if (key !== (rawFact as LogisticsRoomFactV1).id) return false;
  }
  const observationOrdersByProducer = new Map<string, Set<number>>();
  for (const key of observationKeys) {
    const rawObservation = ownValue(synthesisObservations, key);
    if (
      rawObservation === undefined
      || (!trusted && !isSynthesisObservationRecord(rawObservation))
    ) return false;
    const observation = rawObservation as SynthesisLogisticsObservationV1;
    const intent = intentsById.get(observation.intentId);
    if (
      key !== observation.intentId
      || !intent
      || observation.producer !== intent.producer
      || observation.demandKey !== intent.demandKey
    ) return false;
    const orders = observationOrdersByProducer.get(observation.producer) ?? new Set<number>();
    if (orders.has(observation.decisionOrder)) return false;
    orders.add(observation.decisionOrder);
    observationOrdersByProducer.set(observation.producer, orders);
  }
  const snapshotProducers = new Set<string>();
  for (const key of snapshotKeys) {
    const rawSnapshot = ownValue(producerSnapshots, key);
    if (rawSnapshot === undefined || (!trusted && !isProducerSnapshotRecord(rawSnapshot))) return false;
    const snapshot = rawSnapshot as LogisticsProducerSnapshotV1;
    if (
      key !== encodeProducerSnapshotKey(snapshot.producer)
      || snapshot.emitted !== (intentCountByProducer.get(snapshot.producer) ?? 0)
      || snapshot.expiresAt < (intentExpiresAtByProducer.get(snapshot.producer) ?? 0)
    ) return false;
    const orders = [...(observationOrdersByProducer.get(snapshot.producer) ?? [])].sort((left, right) => left - right);
    if (!snapshot.truncated && orders.some((order, index) => order !== index)) return false;
    snapshotProducers.add(snapshot.producer);
  }
  for (const producer of intentCountByProducer.keys()) {
    if (!snapshotProducers.has(producer)) return false;
  }
  for (const key of generationKeys) {
    const entry = generationValue(ownValue(generation, key));
    if (!decodeIntentBaseKey(key) || !entry || entry.value > cursor) return false;
  }
  return true;
}

export function readLogisticsControlStoreExact(): LogisticsControlExactStoreRead {
  const owner = readResourceControlOwner();
  const raw = owner && ownValue(owner, "logistics");
  let serialized: string | null | undefined;
  const artifact = sameTickValidatedArtifact;
  if (
    artifact
    && owner !== undefined
    && owner !== null
    && isRecord(raw)
    && artifact.tick === Game.time
    && artifact.owner === owner
    && (artifact.raw as unknown) === raw
  ) {
    // serialize 比对不可省：同 tick 的原位字段篡改（如 console 直改
    // Memory.data.resourceControl.logistics.c）不改变对象身份，必须以字节级
    // 比对方能落入 artifactFallbacks 走 strict read。
    serialized = serializeLogisticsWire(raw);
    if (serialized !== null && serialized === artifact.exactToken) {
      logisticsControlCodecDiagnostics.artifactFastReads += 1;
      return {
        ok: true,
        store: artifact.store,
        usage: artifact.usage,
        readSource: "same_tick_validated_artifact",
        artifactToken: artifact.artifactToken,
      };
    }
  }
  if (artifact) {
    logisticsControlCodecDiagnostics.artifactFallbacks += 1;
    sameTickValidatedArtifact = undefined;
  }
  logisticsControlCodecDiagnostics.strictReads += 1;
  if (owner === undefined) return { ok: false, reason: "missing" };
  if (owner === null) return { ok: false, reason: "malformed_owner" };
  if (raw === undefined) return { ok: false, reason: "missing" };
  if (!isRecord(raw)) return { ok: false, reason: "malformed_store" };
  const schemaVersion = ownValue(raw, "schemaVersion");
  if (schemaVersion !== LOGISTICS_DATA_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema", schemaVersion };
  }
  const wireFormat = ownValue(raw, "wireFormat");
  if (wireFormat !== undefined) {
    if (wireFormat !== LOGISTICS_COMPACT_WIRE_FORMAT) {
      return { ok: false, reason: "malformed_store", schemaVersion };
    }
    serialized ??= serializeLogisticsWire(raw);
    if (serialized === null) {
      return { ok: false, reason: "malformed_store", schemaVersion };
    }
    const identity = inspectSerializedLogisticsWire(serialized, LOGISTICS_COMPACT_WIRE_FORMAT);
    if (identity.utf8Bytes > LOGISTICS_CONTROL_DATA_LIMIT_BYTES) {
      return { ok: false, reason: "malformed_store", schemaVersion };
    }
    // 跨 epoch 未改写的 wire：与最近一次 attach 的 token 全串等值即可复用
    // 其已冻结的 decode 结果。等值是字节级比较，原位篡改必然 miss 并回落
    // 到下方完整 strict 校验。
    if (
      unchangedWireCache
      && unchangedWireCache.exactToken === serialized
    ) {
      logisticsControlCodecDiagnostics.unchangedWireFastReads += 1;
      return {
        ok: true,
        store: unchangedWireCache.store,
        usage: unchangedWireCache.usage,
        readSource: "unchanged_wire_cache",
        artifactToken: identity.artifactToken,
      };
    }
    const decoded = decodeCompactLogisticsStore(raw);
    if (
      !decoded
      || !hasValidBoundedStoreEntriesSemantic(decoded as unknown as UnknownRecord, {
        trustedRecords: true,
      })
    ) {
      return { ok: false, reason: "malformed_store", schemaVersion };
    }
    // serialize+decode+语义校验已完整拦截外部写入的损坏 wire；
    // canonical 形态由 monitor 侧独立 replay 复核，此处不再二次 encode 往返。
    try {
      // 冻结后建立跨 epoch 等值缓存基线：后续 epoch 未改写的 wire 命中
      // token 比对即可跳过整条 decode+校验管线。
      freezeLogisticsControlArtifactStore(decoded);
      unchangedWireCache = {
        exactToken: serialized,
        artifactToken: identity.artifactToken,
        store: decoded,
        usage: logisticsControlStoreUsageFromBytes(decoded, identity.utf8Bytes),
      };
    } catch {
      return { ok: false, reason: "malformed_store", schemaVersion };
    }
    return {
      ok: true,
      store: decoded,
      usage: unchangedWireCache.usage,
      readSource: "strict_compact",
      artifactToken: identity.artifactToken,
    };
  }
  serialized ??= serializeLogisticsWire(raw);
  if (serialized === null) {
    return { ok: false, reason: "malformed_store", schemaVersion };
  }
  const identity = inspectSerializedLogisticsWire(serialized, "expanded-v1");
  if (
    identity.utf8Bytes > LOGISTICS_CONTROL_DATA_LIMIT_BYTES
    || !isStoreCollectionsShape(raw)
    || !hasValidBoundedStoreEntriesSemantic(raw)
  ) {
    return { ok: false, reason: "malformed_store", schemaVersion };
  }
  const store = raw as unknown as LogisticsControlStoreV1;
  const compactToken = serializeLogisticsWire(encodeCompactLogisticsStore(store));
  const compactUtf8Bytes = compactToken === null
    ? LOGISTICS_CONTROL_DATA_LIMIT_BYTES + 1
    : utf8ByteLength(compactToken);
  if (
    compactToken === null
    || compactUtf8Bytes > LOGISTICS_CONTROL_DATA_LIMIT_BYTES
  ) {
    return { ok: false, reason: "malformed_store", schemaVersion };
  }
  return {
    ok: true,
    store,
    usage: logisticsControlStoreUsageFromBytes(store, compactUtf8Bytes),
    readSource: "strict_expanded",
    artifactToken: identity.artifactToken,
  };
}

export function peekLogisticsControlStore(): LogisticsControlStoreRead {
  const read = readLogisticsControlStoreExact();
  return read.ok
    ? { ok: true, store: read.store }
    : read;
}

export function ensureLogisticsControlStore(): EnsureLogisticsControlStoreResult {
  const current = peekLogisticsControlStore();
  if (current.ok === true) {
    const owner = readResourceControlOwner();
    const raw = owner && ownValue(owner, "logistics");
    if (owner && isRecord(raw) && ownValue(raw, "wireFormat") === undefined) {
      const migrated = current.store as LogisticsControlStoreV1;
      const committed = attachLogisticsStore(owner, migrated);
      if (!committed.ok) {
        return {
          ok: false,
          reason: "malformed_store",
          schemaVersion: LOGISTICS_DATA_SCHEMA_VERSION,
        };
      }
      return { ok: true, store: committed.artifact.store, created: false };
    }
    return { ok: true, store: current.store as LogisticsControlStoreV1, created: false };
  }
  if (current.reason === "malformed_store" && current.schemaVersion === LOGISTICS_DATA_SCHEMA_VERSION) {
    const owner = readResourceControlOwner();
    const raw = owner && ownValue(owner, "logistics");
    if (owner && isRecord(raw)) {
      if (ownValue(raw, "wireFormat") !== undefined) return current;
      const latestIntents = ownValue(raw, "latestIntents");
      const roomFacts = ownValue(raw, "roomFacts");
      const synthesisObservations = ownValue(raw, "synthesisObservations");
      const producerSnapshots = ownValue(raw, "producerSnapshots");
      const generation = ownValue(raw, "generation");
      const cursor = ownValue(raw, "cursor");
      if (
        (latestIntents === undefined || isRecord(latestIntents))
        && (roomFacts === undefined || isRecord(roomFacts))
        && (synthesisObservations === undefined || isRecord(synthesisObservations))
        && (producerSnapshots === undefined || isRecord(producerSnapshots))
        && (generation === undefined || isRecord(generation))
        && (cursor === undefined || isSafeTick(cursor))
      ) {
        const repaired: LogisticsControlStoreV1 = {
          schemaVersion: LOGISTICS_DATA_SCHEMA_VERSION,
          latestIntents: (latestIntents ?? createRecord<LatestLogisticsDemandV1>()) as Record<string, LatestLogisticsDemandV1>,
          roomFacts: (roomFacts ?? createRecord<LogisticsRoomFactV1>()) as Record<string, LogisticsRoomFactV1>,
          synthesisObservations: (
            synthesisObservations ?? createRecord<SynthesisLogisticsObservationV1>()
          ) as Record<string, SynthesisLogisticsObservationV1>,
          producerSnapshots: (
            producerSnapshots ?? createRecord<LogisticsProducerSnapshotV1>()
          ) as Record<string, LogisticsProducerSnapshotV1>,
          generation: (generation ?? createRecord<LogisticsGenerationV1>()) as Record<string, LogisticsGenerationV1>,
          cursor: (cursor ?? 0) as number,
        };
        // repair 集合来自未通过 strict 读的外部原始数据：attach 前必须做
        // 非 trusted 逐记录校验。prepare 侧的 trusted 复核只信任已校验
        // 输入，不能替代这里对损坏记录的拦截，否则损坏态会以 compact
        // wire 形式提交并被跨 epoch 等值缓存长期遮蔽。
        if (
          !hasValidBoundedStoreEntriesSemantic(repaired as unknown as UnknownRecord)
        ) {
          return current;
        }
        const committed = attachLogisticsStore(owner, repaired);
        if (!committed.ok) return current;
        return { ok: true, store: committed.artifact.store, created: false };
      }
    }
  }
  if (current.reason !== "missing") return current;

  const data = getMemoryService().ensureData();
  let owner = (data as unknown as UnknownRecord).resourceControl as unknown;
  if (owner === undefined) {
    owner = {};
    data.resourceControl = owner as NonNullable<Memory["data"]>["resourceControl"];
  }
  if (!isRecord(owner)) return { ok: false, reason: "malformed_owner" };
  const existing = ownValue(owner, "logistics");
  if (existing !== undefined) {
    return peekLogisticsControlStore() as EnsureLogisticsControlStoreResult;
  }
  const store = createEmptyStore();
  const committed = attachLogisticsStore(owner, store);
  if (!committed.ok) {
    return { ok: false, reason: "malformed_store", schemaVersion: LOGISTICS_DATA_SCHEMA_VERSION };
  }
  return { ok: true, store: committed.artifact.store, created: true };
}

function parseRollbackRequest(raw: unknown): LogisticsRollbackRequestV1 | undefined {
  if (!isRecord(raw) || ownValue(raw, "schemaVersion") !== 1) return undefined;
  const requestId = ownValue(raw, "requestId");
  const requestedAt = ownValue(raw, "requestedAt");
  const targetAuthority = ownValue(raw, "targetAuthority");
  const reason = ownValue(raw, "reason");
  const scope = ownValue(raw, "scope");
  const phase = ownValue(raw, "phase");
  const updatedAt = ownValue(raw, "updatedAt");
  const lastError = ownValue(raw, "lastError");
  if (!isRecord(scope)) return undefined;
  const sourceRooms = normalizeRoomNames(ownValue(scope, "sourceRooms"));
  const rawOrigins = ownValue(scope, "origins");
  if (!Array.isArray(rawOrigins) || rawOrigins.length > LOGISTICS_CONTROL_STORE_LIMIT) return undefined;
  const origins = [...new Set(rawOrigins.filter(isRolloutOrigin))].sort();
  if (
    !isNonEmptyBoundedString(requestId)
    || !isSafeTick(requestedAt)
    || targetAuthority !== "legacy"
    || !isNonEmptyBoundedString(reason)
    || sourceRooms === null
    || origins.length !== rawOrigins.length
    || !isRollbackPhase(phase)
    || !isSafeTick(updatedAt)
    || updatedAt < requestedAt
    || (lastError !== undefined && !isNonEmptyBoundedString(lastError))
  ) return undefined;
  return {
    schemaVersion: 1,
    requestId,
    requestedAt,
    targetAuthority,
    reason,
    scope: { origins, sourceRooms },
    phase,
    updatedAt,
    ...(typeof lastError === "string" ? { lastError } : {}),
  };
}

function parseCanaryScopes(raw: unknown): LogisticsCanaryScopeV1[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > LOGISTICS_CONTROL_STORE_LIMIT) return null;
  const result = new Map<string, LogisticsCanaryScopeV1>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const origin = ownValue(entry, "origin");
    const sourceRoomName = ownValue(entry, "sourceRoomName");
    if (!isRolloutOrigin(origin) || !isRoomName(sourceRoomName)) return null;
    const key = JSON.stringify([origin, sourceRoomName]);
    if (result.has(key)) return null;
    result.set(key, { origin, sourceRoomName });
  }
  return [...result.values()].sort((left, right) =>
    compareCanonicalStrings(left.origin, right.origin)
      || compareCanonicalStrings(left.sourceRoomName, right.sourceRoomName)
  );
}

export function resolveLogisticsControlConfig(): ResolvedLogisticsControlConfigV1 {
  const rawOwner = Memory.cfg?.resourceControl as unknown;
  if (rawOwner === undefined) {
    return { schemaVersion: 1, mode: "disabled", canaryScopes: [], valid: true, issue: "missing" };
  }
  if (!isRecord(rawOwner)) {
    return { schemaVersion: 1, mode: "disabled", canaryScopes: [], valid: false, issue: "malformed" };
  }
  const raw = ownValue(rawOwner, "logistics");
  if (raw === undefined) {
    return { schemaVersion: 1, mode: "disabled", canaryScopes: [], valid: true, issue: "missing" };
  }
  if (!isRecord(raw)) {
    return { schemaVersion: 1, mode: "disabled", canaryScopes: [], valid: false, issue: "malformed" };
  }
  if (ownValue(raw, "schemaVersion") !== LOGISTICS_CFG_SCHEMA_VERSION) {
    return {
      schemaVersion: 1,
      mode: "disabled",
      canaryScopes: [],
      valid: false,
      issue: "unsupported_schema",
    };
  }
  const mode = ownValue(raw, "mode");
  const canaryScopes = parseCanaryScopes(ownValue(raw, "canaryScopes"));
  const rollbackRaw = ownValue(raw, "rollbackRequest");
  const rollbackRequest = rollbackRaw === undefined ? undefined : parseRollbackRequest(rollbackRaw);
  if (
    !["disabled", "shadow", "canary", "enabled"].includes(mode as string)
    || canaryScopes === null
    || (rollbackRaw !== undefined && rollbackRequest === undefined)
  ) {
    return { schemaVersion: 1, mode: "disabled", canaryScopes: [], valid: false, issue: "malformed" };
  }
  return {
    schemaVersion: 1,
    mode: mode as LogisticsControlMode,
    canaryScopes,
    rollbackRequest,
    valid: true,
  };
}

function rollbackApplies(
  request: LogisticsRollbackRequestV1 | undefined,
  origin: LogisticsRolloutOrigin,
  sourceRoomName: string,
): boolean {
  return !!request
    && (request.scope.origins.length === 0 || request.scope.origins.includes(origin))
    && (request.scope.sourceRooms.length === 0 || request.scope.sourceRooms.includes(sourceRoomName));
}

export function resolveLogisticsExecutionAuthority(
  config: ResolvedLogisticsControlConfigV1,
  origin: LogisticsRolloutOrigin,
  sourceRoomName: string,
  backendAvailable = false,
): LogisticsAuthorityDecision {
  if (rollbackApplies(config.rollbackRequest, origin, sourceRoomName)) {
    return {
      requestedAuthority: "legacy",
      effectiveAuthority: "legacy",
      sourceRoomName,
      origin,
      backendAvailable,
      reason: "rollback_requested",
      rollbackRequestId: config.rollbackRequest!.requestId,
    };
  }
  if (!backendAvailable) {
    return {
      requestedAuthority: "legacy",
      effectiveAuthority: "legacy",
      sourceRoomName,
      origin,
      backendAvailable,
      reason: "backend_unavailable",
    };
  }
  if (config.mode === "disabled") {
    return { requestedAuthority: "legacy", effectiveAuthority: "legacy", sourceRoomName, origin, backendAvailable, reason: "mode_disabled" };
  }
  if (config.mode === "shadow") {
    return { requestedAuthority: "legacy", effectiveAuthority: "legacy", sourceRoomName, origin, backendAvailable, reason: "shadow_only" };
  }
  if (
    config.mode === "canary"
    && !config.canaryScopes.some((scope) => scope.origin === origin && scope.sourceRoomName === sourceRoomName)
  ) {
    return {
      requestedAuthority: "legacy",
      effectiveAuthority: "legacy",
      sourceRoomName,
      origin,
      backendAvailable,
      reason: "outside_canary_scope",
    };
  }
  return {
    requestedAuthority: "contract",
    effectiveAuthority: "contract",
    sourceRoomName,
    origin,
    backendAvailable,
    reason: "contract_requested",
  };
}

export function mapLegacyTransferPriority(
  origin: "manual" | "automatic",
  reason?: string,
  options: { readonly deadlineAt?: number; readonly capacityEmergency?: boolean } = {},
): LogisticsPriorityClass {
  if (isSafeTick(options.deadlineAt)) return "deadline";
  if (origin === "manual" || reason?.startsWith("manual:")) return "operator";
  if (!reason) return "balance";
  if (reason.startsWith("energy-support") || reason.startsWith("survival:")) return "survival_energy";
  if (reason.startsWith("capacity:relief:")) {
    return options.capacityEmergency ? "capacity_emergency" : "capacity_pressure";
  }
  if (
    reason.startsWith("synthesis:")
    || reason.startsWith("auto:synthesis:")
    || reason.startsWith("powerBankBoost")
    || reason.startsWith("nuker:")
  ) return "production";
  if (reason.startsWith("market:")) return "market";
  return "balance";
}

export function mapLegacyTransferOrigin(
  origin: "manual" | "automatic",
  reason?: string,
): LogisticsRolloutOrigin {
  if (origin === "manual") return "operator";
  if (!reason) return "ordinary_balance";
  if (reason.startsWith("auto:synthesis:")) return "synthesis_compatibility";
  if (reason.startsWith("synthesis:surplus:")) return "synthesis_surplus";
  if (
    reason.startsWith("synthesis:direct:")
    || reason.startsWith("synthesis:hub-route:")
    || reason.startsWith("synthesis:resupply:")
  ) return "synthesis_distributed_demand";
  if (reason.startsWith("synthesis:")) return "synthesis_room";
  if (reason.startsWith("capacity:relief:")) return "capacity_relief";
  if (reason.startsWith("powerBankBoost")) return "power_bank_boost";
  if (reason.startsWith("energy-support") || reason.startsWith("survival:")) return "survival_energy";
  if (reason.startsWith("market:")) return "market";
  return "ordinary_balance";
}

function normalizeDemandDraft(draft: LatestLogisticsDemandDraft): Omit<LatestLogisticsDemandV1, "id" | "producer" | "generation" | "revision" | "firstObservedAt" | "observedAt" | "expiresAt"> | null {
  const desiredAmount = normalizeAmount(draft.desiredAmount);
  const minBatch = draft.minBatch === undefined ? undefined : normalizeAmount(draft.minBatch);
  const maxBatch = draft.maxBatch === undefined ? undefined : normalizeAmount(draft.maxBatch);
  const fixedSourceRoomNames = normalizeRoomNames(draft.fixedSourceRoomNames);
  if (
    !isNonEmptyBoundedString(draft.demandKey)
    || !isRolloutOrigin(draft.origin)
    || (draft.active !== undefined && typeof draft.active !== "boolean")
    || !isRoomName(draft.targetRoomName)
    || typeof draft.resource !== "string"
    || !RESOURCES_ALL.includes(draft.resource)
    || desiredAmount === null
    || !isPriorityClass(draft.priorityClass)
    || fixedSourceRoomNames === null
    || minBatch === null
    || maxBatch === null
    || (minBatch !== undefined && maxBatch !== undefined && minBatch > maxBatch)
    || (draft.product !== undefined && !RESOURCES_ALL.includes(draft.product))
    || (draft.deadlineAt !== undefined && !isSafeTick(draft.deadlineAt))
  ) return null;
  return {
    kind: "demand",
    origin: draft.origin,
    active: draft.active ?? true,
    demandKey: draft.demandKey,
    targetRoomName: draft.targetRoomName,
    resource: draft.resource,
    desiredAmount,
    priorityClass: draft.priorityClass,
    ...(draft.deadlineAt === undefined ? {} : { deadlineAt: draft.deadlineAt }),
    ...(fixedSourceRoomNames.length === 0 ? {} : { fixedSourceRoomNames }),
    ...(minBatch === undefined ? {} : { minBatch }),
    ...(maxBatch === undefined ? {} : { maxBatch }),
    ...(draft.product === undefined ? {} : { product: draft.product }),
  };
}

/**
 * 逐字段等价比较（kind/origin/active/demandKey/targetRoomName/resource/
 * desiredAmount/priorityClass/deadlineAt/fixedSourceRoomNames/minBatch/
 * maxBatch/product 全集）；仅用于 sameSemantic 判定，避免每 epoch 为两侧
 * 各构建一次 JSON 签名串。
 */
function isSameDemandSemantic(
  left: Omit<LatestLogisticsDemandV1, "id" | "producer" | "generation" | "revision" | "firstObservedAt" | "observedAt" | "expiresAt">,
  right: Omit<LatestLogisticsDemandV1, "id" | "producer" | "generation" | "revision" | "firstObservedAt" | "observedAt" | "expiresAt">,
): boolean {
  if (
    left.kind !== right.kind
    || left.origin !== right.origin
    || left.active !== right.active
    || left.demandKey !== right.demandKey
    || left.targetRoomName !== right.targetRoomName
    || left.resource !== right.resource
    || left.desiredAmount !== right.desiredAmount
    || left.priorityClass !== right.priorityClass
    || left.deadlineAt !== right.deadlineAt
    || left.minBatch !== right.minBatch
    || left.maxBatch !== right.maxBatch
    || left.product !== right.product
  ) return false;
  // 空数组与省略在语义上等价（旧 JSON 签名对 undefined ?? [] 归一），
  // store 中 legacy/外部写入的 [] 不能触发 revision 无谓递增。
  const leftFixed = left.fixedSourceRoomNames ?? [];
  const rightFixed = right.fixedSourceRoomNames ?? [];
  if (leftFixed.length !== rightFixed.length) return false;
  return leftFixed.every((roomName, index) => roomName === rightFixed[index]);
}

function isDemandRecord(value: unknown): value is LatestLogisticsDemandV1 {
  if (!isRecord(value)) return false;
  const producer = ownValue(value, "producer");
  const demandKey = ownValue(value, "demandKey");
  const generation = ownValue(value, "generation");
  const revision = ownValue(value, "revision");
  const id = ownValue(value, "id");
  const deadlineAt = ownValue(value, "deadlineAt");
  const rawFixedSourceRoomNames = ownValue(value, "fixedSourceRoomNames");
  const fixedSourceRoomNames = normalizeRoomNames(rawFixedSourceRoomNames);
  const minBatch = ownValue(value, "minBatch");
  const maxBatch = ownValue(value, "maxBatch");
  const product = ownValue(value, "product");
  return isNonEmptyBoundedString(producer)
    && isNonEmptyBoundedString(demandKey)
    && isSafeTick(generation) && generation > 0
    && isSafeTick(revision) && revision > 0
    && id === encodeIntentId(producer, demandKey, generation)
    && ownValue(value, "kind") === "demand"
    && isRolloutOrigin(ownValue(value, "origin"))
    && typeof ownValue(value, "active") === "boolean"
    && isRoomName(ownValue(value, "targetRoomName"))
    && typeof ownValue(value, "resource") === "string"
    && RESOURCES_ALL.includes(ownValue(value, "resource") as ResourceConstant)
    && isStoredAmount(ownValue(value, "desiredAmount"))
    && isPriorityClass(ownValue(value, "priorityClass"))
    && (deadlineAt === undefined || isSafeTick(deadlineAt))
    && fixedSourceRoomNames !== null
    && (
      rawFixedSourceRoomNames === undefined
      || (
        Array.isArray(rawFixedSourceRoomNames)
        && rawFixedSourceRoomNames.length === fixedSourceRoomNames.length
        && rawFixedSourceRoomNames.every(
          (roomName, index) => roomName === fixedSourceRoomNames[index],
        )
      )
    )
    && (minBatch === undefined || isStoredAmount(minBatch))
    && (maxBatch === undefined || isStoredAmount(maxBatch))
    && (
      minBatch === undefined
      || maxBatch === undefined
      || (minBatch as number) <= (maxBatch as number)
    )
    && (product === undefined || (typeof product === "string" && RESOURCES_ALL.includes(product as ResourceConstant)))
    && isSafeTick(ownValue(value, "firstObservedAt"))
    && isSafeTick(ownValue(value, "observedAt"))
    && isSafeTick(ownValue(value, "expiresAt"))
    && (ownValue(value, "firstObservedAt") as number) <= (ownValue(value, "observedAt") as number)
    && (ownValue(value, "observedAt") as number) <= (ownValue(value, "expiresAt") as number);
}

function generationValue(value: unknown): LogisticsGenerationV1 | undefined {
  if (!isRecord(value)) return undefined;
  const generation = ownValue(value, "value");
  const updatedAt = ownValue(value, "updatedAt");
  if (!isSafeTick(generation) || generation <= 0 || !isSafeTick(updatedAt)) return undefined;
  return { value: generation, updatedAt };
}

function isProducerSnapshotRecord(value: unknown): value is LogisticsProducerSnapshotV1 {
  if (!isRecord(value)) return false;
  const total = ownValue(value, "total");
  const emitted = ownValue(value, "emitted");
  const dropped = ownValue(value, "dropped");
  const truncated = ownValue(value, "truncated");
  const captureCpuUsed = ownValue(value, "captureCpuUsed");
  return isNonEmptyBoundedString(ownValue(value, "producer"))
    && isNonEmptyBoundedString(ownValue(value, "epochRevision"), 512)
    && isNonEmptyBoundedString(ownValue(value, "epochFingerprint"), 512)
    && isSafeTick(ownValue(value, "observedAt"))
    && isSafeTick(ownValue(value, "expiresAt"))
    && (ownValue(value, "observedAt") as number) <= (ownValue(value, "expiresAt") as number)
    && typeof captureCpuUsed === "number"
    && Number.isFinite(captureCpuUsed)
    && captureCpuUsed >= 0
    && isSafeTick(ownValue(value, "indexBuildCount"))
    && (ownValue(value, "indexBuildCount") as number) <= LOGISTICS_CONTROL_STORE_LIMIT
    && isSafeTick(total)
    && isSafeTick(emitted)
    && isSafeTick(dropped)
    && ownValue(value, "limit") === LOGISTICS_CONTROL_STORE_LIMIT
    && (emitted as number) <= LOGISTICS_CONTROL_STORE_LIMIT
    && (emitted as number) <= (total as number)
    && (dropped as number) === (total as number) - (emitted as number)
    && typeof truncated === "boolean"
    && truncated === ((dropped as number) > 0);
}

function pruneGeneration(
  generation: Record<string, LogisticsGenerationV1>,
  activeKeys: ReadonlySet<string>,
): Record<string, LogisticsGenerationV1> {
  const entries = Object.entries(generation)
    .filter(([, value]) => generationValue(value) !== undefined)
    .sort((left, right) => {
      const leftActive = activeKeys.has(left[0]);
      const rightActive = activeKeys.has(right[0]);
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (left[1].updatedAt !== right[1].updatedAt) return right[1].updatedAt - left[1].updatedAt;
      return compareCanonicalStrings(left[0], right[0]);
    })
    .slice(0, LOGISTICS_CONTROL_STORE_LIMIT);
  const result = createRecord<LogisticsGenerationV1>();
  for (const [key, value] of entries) defineRecordValue(result, key, value);
  return result;
}

function normalizeSynthesisObservation(
  producer: string,
  intent: Pick<LatestLogisticsDemandV1, "id" | "demandKey">,
  draft: SynthesisLogisticsObservationDraft,
): SynthesisLogisticsObservationV1 | null {
  const localAmount = normalizeAmount(draft.localAmount);
  const incomingAmount = normalizeAmount(draft.incomingAmount);
  const uncoveredAmount = normalizeAmount(draft.uncoveredAmount);
  const legacyAmount = draft.legacyAmount === undefined ? undefined : normalizeAmount(draft.legacyAmount);
  const legacyAddedAmount = draft.legacyAddedAmount === undefined
    ? undefined
    : normalizeAmount(draft.legacyAddedAmount);
  const legacyRemainingBefore = draft.legacyRemainingBefore === undefined
    ? undefined
    : normalizeAmount(draft.legacyRemainingBefore);
  const legacyFeeDelta = draft.legacyFeeDelta === undefined ? undefined : normalizeAmount(draft.legacyFeeDelta);
  if (
    draft.demandKey !== intent.demandKey
    || !isNonEmptyBoundedString(draft.inputFingerprint, 512)
    || localAmount === null
    || incomingAmount === null
    || uncoveredAmount === null
    || !isSafeTick(draft.decisionOrder)
    || draft.decisionOrder >= LOGISTICS_CONTROL_STORE_LIMIT
    || !SYNTHESIS_OBSERVATION_REASONS.has(draft.comparableReason)
    || !SYNTHESIS_LEGACY_DECISIONS.has(draft.legacyDecision)
    || !isSafeTick(draft.legacyPriorityRank)
    || !isPriorityClass(draft.legacyPriorityClass)
    || (draft.legacySourceRoomName !== undefined && !isRoomName(draft.legacySourceRoomName))
    || (draft.legacyTaskId !== undefined && !isNonEmptyBoundedString(draft.legacyTaskId, 512))
    || legacyAmount === null
    || legacyAddedAmount === null
    || legacyRemainingBefore === null
    || legacyFeeDelta === null
  ) return null;
  return {
    intentId: intent.id,
    producer,
    demandKey: intent.demandKey,
    inputFingerprint: draft.inputFingerprint,
    localAmount,
    incomingAmount,
    uncoveredAmount,
    decisionOrder: draft.decisionOrder,
    observedAt: Game.time,
    comparableReason: draft.comparableReason,
    legacyDecision: draft.legacyDecision,
    legacyPriorityRank: draft.legacyPriorityRank,
    legacyPriorityClass: draft.legacyPriorityClass,
    ...(draft.legacySourceRoomName === undefined ? {} : { legacySourceRoomName: draft.legacySourceRoomName }),
    ...(legacyAmount === undefined ? {} : { legacyAmount }),
    ...(draft.legacyTaskId === undefined ? {} : { legacyTaskId: draft.legacyTaskId }),
    ...(legacyAddedAmount === undefined ? {} : { legacyAddedAmount }),
    ...(legacyRemainingBefore === undefined ? {} : { legacyRemainingBefore }),
    ...(legacyFeeDelta === undefined ? {} : { legacyFeeDelta }),
  };
}

function isSynthesisObservationRecord(value: unknown): value is SynthesisLogisticsObservationV1 {
  if (!isRecord(value)) return false;
  const legacySourceRoomName = ownValue(value, "legacySourceRoomName");
  const legacyTaskId = ownValue(value, "legacyTaskId");
  const optionalAmounts = [
    ownValue(value, "legacyAmount"),
    ownValue(value, "legacyAddedAmount"),
    ownValue(value, "legacyRemainingBefore"),
    ownValue(value, "legacyFeeDelta"),
  ];
  return isNonEmptyBoundedString(ownValue(value, "intentId"), 512)
    && isNonEmptyBoundedString(ownValue(value, "producer"))
    && isNonEmptyBoundedString(ownValue(value, "demandKey"))
    && isNonEmptyBoundedString(ownValue(value, "inputFingerprint"), 512)
    && isStoredAmount(ownValue(value, "localAmount"))
    && isStoredAmount(ownValue(value, "incomingAmount"))
    && isStoredAmount(ownValue(value, "uncoveredAmount"))
    && isSafeTick(ownValue(value, "decisionOrder"))
    && (ownValue(value, "decisionOrder") as number) < LOGISTICS_CONTROL_STORE_LIMIT
    && isSafeTick(ownValue(value, "observedAt"))
    && SYNTHESIS_OBSERVATION_REASONS.has(
      ownValue(value, "comparableReason") as SynthesisObservationComparableReason,
    )
    && SYNTHESIS_LEGACY_DECISIONS.has(ownValue(value, "legacyDecision") as SynthesisLegacyDecision)
    && isSafeTick(ownValue(value, "legacyPriorityRank"))
    && isPriorityClass(ownValue(value, "legacyPriorityClass"))
    && (legacySourceRoomName === undefined || isRoomName(legacySourceRoomName))
    && (legacyTaskId === undefined || isNonEmptyBoundedString(legacyTaskId, 512))
    && optionalAmounts.every((amount) => amount === undefined || isStoredAmount(amount));
}

/** 输入失败时原子撤回尚未执行的规划证据；已接受运输及 generation 保留。 */
export function invalidateLogisticsProducerSnapshot(producer: string): boolean {
  const ensured = ensureLogisticsControlStore();
  if (!ensured.ok) return false;
  const key = encodeProducerSnapshotKey(producer);
  if (!Object.prototype.hasOwnProperty.call(ensured.store.producerSnapshots, key)) return true;
  const producerSnapshots = cloneRecord(ensured.store.producerSnapshots);
  Reflect.deleteProperty(producerSnapshots, key);
  const latestIntents = cloneRecord(ensured.store.latestIntents);
  const synthesisObservations = cloneRecord(ensured.store.synthesisObservations);
  for (const [id, intent] of Object.entries(latestIntents)) if (intent.producer === producer) Reflect.deleteProperty(latestIntents, id);
  for (const [id, observation] of Object.entries(synthesisObservations)) if (observation.producer === producer) Reflect.deleteProperty(synthesisObservations, id);
  const owner = readResourceControlOwner();
  if (!owner) return false;
  return attachLogisticsStore(owner, { ...ensured.store, latestIntents, synthesisObservations, producerSnapshots }).ok;
}

export function replaceLatestLogisticsDemandsForProducer(
  producer: string,
  drafts: readonly LatestLogisticsDemandDraft[],
  observationDrafts?: readonly SynthesisLogisticsObservationDraft[],
  snapshotInput?: LogisticsProducerSnapshotInput,
): ReplaceLogisticsRecordsResult<LatestLogisticsDemandV1> {
  if (!isNonEmptyBoundedString(producer) || drafts.length > LOGISTICS_CONTROL_STORE_LIMIT) {
    return { ok: false, reason: "invalid_producer_or_count" };
  }
  if (observationDrafts && observationDrafts.length > LOGISTICS_CONTROL_STORE_LIMIT) {
    return { ok: false, reason: "observation_store_limit" };
  }
  const totalCount = snapshotInput?.totalCount ?? drafts.length;
  const overflowCount = snapshotInput?.overflowCount ?? 0;
  const snapshotTtl = normalizeTtl(snapshotInput?.ttl);
  const epochRevision = snapshotInput?.epochRevision
    ?? JSON.stringify(["logistics-producer-epoch/v1", producer, Game.time]);
  const epochFingerprint = snapshotInput?.epochFingerprint ?? epochRevision;
  const captureCpuUsed = snapshotInput?.captureCpuUsed ?? 0;
  const indexBuildCount = snapshotInput?.indexBuildCount ?? 0;
  if (
    !isSafeTick(totalCount)
    || !isSafeTick(overflowCount)
    || totalCount !== drafts.length + overflowCount
    || !isNonEmptyBoundedString(epochRevision, 512)
    || !isNonEmptyBoundedString(epochFingerprint, 512)
    || !Number.isFinite(captureCpuUsed)
    || captureCpuUsed < 0
    || !isSafeTick(indexBuildCount)
    || indexBuildCount > LOGISTICS_CONTROL_STORE_LIMIT
  ) {
    return { ok: false, reason: "invalid_producer_snapshot" };
  }
  const normalized = new Map<string, { value: ReturnType<typeof normalizeDemandDraft> & {}; ttl: number }>();
  for (const draft of drafts) {
    const value = normalizeDemandDraft(draft);
    if (!value) return { ok: false, reason: "invalid_draft" };
    const baseKey = encodeIntentBaseKey(producer, value.demandKey);
    if (normalized.has(baseKey)) return { ok: false, reason: "duplicate_demand_key" };
    normalized.set(baseKey, { value, ttl: normalizeTtl(draft.ttl) });
  }
  const preflightObservationKeys = new Set<string>();
  const preflightDecisionOrders = new Set<number>();
  for (const draft of observationDrafts ?? []) {
    if (
      preflightObservationKeys.has(draft.demandKey)
      || preflightDecisionOrders.has(draft.decisionOrder)
    ) {
      return {
        ok: false,
        reason: preflightObservationKeys.has(draft.demandKey)
          ? "duplicate_observation_key"
          : "duplicate_observation_order",
      };
    }
    if (!normalized.has(encodeIntentBaseKey(producer, draft.demandKey))) {
      return { ok: false, reason: "observation_without_intent" };
    }
    // 字段级归一化只在 publish 循环执行一次；预检只做去重/配对结构检查。
    preflightObservationKeys.add(draft.demandKey);
    preflightDecisionOrders.add(draft.decisionOrder);
  }
  if (snapshotInput?.roomFacts !== undefined) {
    if (snapshotInput.roomFacts.length > LOGISTICS_CONTROL_STORE_LIMIT) {
      return { ok: false, reason: "store_limit" };
    }
    const roomNames = new Set<string>();
    for (const fact of snapshotInput.roomFacts) {
      // 字段级归一化由 buildRoomFactReplacement 执行并 fail closed；
      // 预检只复核房间唯一性与 epoch 一致性。
      if (
        roomNames.has(fact.roomName)
        || fact.epochRevision !== epochRevision
        || fact.epochFingerprint !== epochFingerprint
      ) {
        return {
          ok: false,
          reason: roomNames.has(fact.roomName) ? "invalid_or_duplicate_room" : "invalid_room_fact",
        };
      }
      roomNames.add(fact.roomName);
    }
  }
  const ensured = ensureLogisticsControlStore();
  if (ensured.ok === false) return { ok: false, reason: ensured.reason };
  const store = ensured.store;
  let nextRoomFacts = store.roomFacts;
  if (snapshotInput?.roomFacts !== undefined) {
    if (snapshotInput.roomFacts.some((fact) =>
      fact.epochRevision !== epochRevision || fact.epochFingerprint !== epochFingerprint
    )) {
      return { ok: false, reason: "epoch_mismatch" };
    }
    const replacement = buildRoomFactReplacement(store, snapshotInput.roomFacts);
    if (replacement.ok === false) return replacement;
    if (!replacement.record) return { ok: false, reason: "invalid_room_fact_replacement" };
    nextRoomFacts = replacement.record;
  }
  const nextIntents = createRecord<LatestLogisticsDemandV1>();
  for (const [key, current] of Object.entries(store.latestIntents)) {
    if (!isDemandRecord(current)) continue;
    if (current.producer !== producer) defineRecordValue(nextIntents, key, current);
  }
  const nextGeneration = cloneRecord(store.generation);
  let nextCursor = store.cursor;
  const published: LatestLogisticsDemandV1[] = [];
  for (const [baseKey, entry] of [...normalized.entries()].sort((a, b) =>
    compareCanonicalStrings(a[0], b[0])
  )) {
    const current = store.latestIntents[baseKey];
    const validCurrent = isDemandRecord(current) && current.producer === producer ? current : undefined;
    const semantic = entry.value;
    const expired = !!validCurrent && validCurrent.expiresAt < Game.time;
    const reactivated = !!validCurrent && !validCurrent.active && semantic.active;
    const startsLifecycle = !validCurrent || expired || reactivated;
    if (startsLifecycle) {
      if (nextCursor >= Number.MAX_SAFE_INTEGER) {
        return { ok: false, reason: "generation_cursor_overflow" };
      }
      nextCursor += 1;
    }
    const generation = startsLifecycle ? nextCursor : validCurrent.generation;
    const sameSemantic = validCurrent && !expired
      ? isSameDemandSemantic(validCurrent, semantic)
      : false;
    const revision = validCurrent && !startsLifecycle
      ? (sameSemantic ? validCurrent.revision : validCurrent.revision + 1)
      : 1;
    const observedAt = sameSemantic && validCurrent
      ? Math.max(validCurrent.observedAt, Game.time)
      : Game.time;
    const expiresAt = sameSemantic && validCurrent
      ? Math.max(validCurrent.expiresAt, Game.time + entry.ttl)
      : Game.time + entry.ttl;
    const firstObservedAt = validCurrent && !startsLifecycle
      ? validCurrent.firstObservedAt
      : Game.time;
    const next: LatestLogisticsDemandV1 = {
      ...semantic,
      id: encodeIntentId(producer, semantic.demandKey, generation),
      producer,
      generation,
      revision,
      firstObservedAt,
      observedAt,
      expiresAt,
    };
    defineRecordValue(nextIntents, baseKey, next);
    defineRecordValue(nextGeneration, baseKey, { value: generation, updatedAt: Game.time });
    published.push(next);
  }
  let nextObservations = store.synthesisObservations;
  {
    const observationsToPublish = observationDrafts ?? [];
    nextObservations = createRecord<SynthesisLogisticsObservationV1>();
    for (const [key, current] of Object.entries(store.synthesisObservations)) {
      if (isSynthesisObservationRecord(current) && current.producer !== producer) {
        defineRecordValue(nextObservations, key, current);
      }
    }
    const intentByDemandKey = new Map(published.map((intent) => [intent.demandKey, intent] as const));
    const seenDemandKeys = new Set<string>();
    const seenDecisionOrders = new Set<number>();
    for (const draft of observationsToPublish) {
      if (seenDemandKeys.has(draft.demandKey)) return { ok: false, reason: "duplicate_observation_key" };
      if (seenDecisionOrders.has(draft.decisionOrder)) {
        return { ok: false, reason: "duplicate_observation_order" };
      }
      seenDemandKeys.add(draft.demandKey);
      seenDecisionOrders.add(draft.decisionOrder);
      const intent = intentByDemandKey.get(draft.demandKey);
      if (!intent) return { ok: false, reason: "observation_without_intent" };
      const observation = normalizeSynthesisObservation(producer, intent, draft);
      if (!observation) return { ok: false, reason: "invalid_observation" };
      defineRecordValue(nextObservations, observation.intentId, observation);
    }
  }
  const snapshotKey = encodeProducerSnapshotKey(producer);
  const nextProducerSnapshots = cloneRecord(store.producerSnapshots);
  if (
    !Object.prototype.hasOwnProperty.call(nextProducerSnapshots, snapshotKey)
    && Object.keys(nextProducerSnapshots).length >= LOGISTICS_CONTROL_STORE_LIMIT
  ) {
    return { ok: false, reason: "producer_snapshot_store_limit" };
  }
  const publishSnapshot = (): void => {
    const emitted = published.length;
    const dropped = totalCount - emitted;
    const expiresAt = published.reduce(
      (latest, intent) => Math.max(latest, intent.expiresAt),
      Object.values(nextRoomFacts).reduce(
        (latest, fact) => fact.epochRevision === epochRevision && fact.epochFingerprint === epochFingerprint
          ? Math.max(latest, fact.expiresAt)
          : latest,
        Game.time + snapshotTtl,
      ),
    );
    defineRecordValue(nextProducerSnapshots, snapshotKey, {
      producer,
      epochRevision,
      epochFingerprint,
      observedAt: Game.time,
      expiresAt,
      captureCpuUsed,
      indexBuildCount,
      total: totalCount,
      emitted,
      dropped,
      limit: LOGISTICS_CONTROL_STORE_LIMIT,
      truncated: dropped > 0,
    });
  };
  const dropLastPublished = (): boolean => {
    const dropped = published.pop();
    if (!dropped) return false;
    const baseKey = encodeIntentBaseKey(producer, dropped.demandKey);
    Reflect.deleteProperty(nextIntents, baseKey);
    Reflect.deleteProperty(nextObservations, dropped.id);
    const previousGeneration = generationValue(store.generation[baseKey]);
    if (previousGeneration) {
      defineRecordValue(nextGeneration, baseKey, previousGeneration);
    } else {
      Reflect.deleteProperty(nextGeneration, baseKey);
    }
    return true;
  };
  while (
    Object.keys(nextIntents).length > LOGISTICS_CONTROL_STORE_LIMIT
    || Object.keys(nextObservations).length > LOGISTICS_CONTROL_STORE_LIMIT
  ) {
    if (!dropLastPublished()) return { ok: false, reason: "store_limit" };
  }
  const buildNextStore = (): LogisticsControlStoreV1 => {
    publishSnapshot();
    return {
      schemaVersion: 1,
      latestIntents: nextIntents,
      roomFacts: nextRoomFacts,
      synthesisObservations: nextObservations,
      producerSnapshots: nextProducerSnapshots,
      generation: pruneGeneration(nextGeneration, new Set(Object.keys(nextIntents))),
      cursor: nextCursor,
    };
  };
  const nextStore = buildNextStore();
  const owner = readResourceControlOwner();
  if (!owner) return { ok: false, reason: "owner_unavailable" };
  const committed = attachLogisticsStore(owner, nextStore);
  if (committed.ok === false) return { ok: false, reason: committed.reason };
  return { ok: true, entries: published };
}

type LogisticsRoomFactSemantic = Omit<
  LogisticsRoomFactV1,
  "id" | "revision" | "observedAt" | "expiresAt"
>;

function normalizeRoomResources(value: unknown): LogisticsRoomResourceFactV1[] | null {
  if (!Array.isArray(value) || value.length > LOGISTICS_CONTROL_STORE_LIMIT) return null;
  const byResource = new Map<ResourceConstant, LogisticsRoomResourceFactV1>();
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const resource = ownValue(raw, "resource");
    const sourceAvailableAmount = normalizeAmount(ownValue(raw, "sourceAvailableAmount"));
    const sourceTerminalAmount = normalizeAmount(ownValue(raw, "sourceTerminalAmount"));
    const receiverResourceHeadroom = normalizeAmount(ownValue(raw, "receiverResourceHeadroom"));
    if (
      typeof resource !== "string"
      || !RESOURCES_ALL.includes(resource as ResourceConstant)
      || byResource.has(resource as ResourceConstant)
      || sourceAvailableAmount === null
      || sourceTerminalAmount === null
      || receiverResourceHeadroom === null
      || sourceTerminalAmount > sourceAvailableAmount
    ) return null;
    byResource.set(resource as ResourceConstant, {
      resource: resource as ResourceConstant,
      sourceAvailableAmount,
      sourceTerminalAmount,
      receiverResourceHeadroom,
    });
  }
  return [...byResource.values()].sort((left, right) =>
    compareCanonicalStrings(left.resource, right.resource)
  );
}

function normalizeRoomFactDraft(draft: LogisticsRoomFactDraft): LogisticsRoomFactSemantic | null {
  const receiverStorageHeadroom = normalizeAmount(draft.receiverStorageHeadroom);
  const receiverTerminalHeadroom = normalizeAmount(draft.receiverTerminalHeadroom);
  const terminalStagingFreeCapacity = normalizeAmount(draft.terminalStagingFreeCapacity);
  const transferBatchSize = normalizeAmount(draft.transferBatchSize);
  const actionEnergyBudget = normalizeAmount(draft.actionEnergyBudget);
  const terminalActionEnergyAmount = normalizeAmount(draft.terminalActionEnergyAmount);
  const resources = normalizeRoomResources(draft.resources);
  if (
    !isRoomName(draft.roomName)
    || !isNonEmptyBoundedString(draft.epochRevision, 512)
    || !isNonEmptyBoundedString(draft.epochFingerprint, 512)
    || typeof draft.owned !== "boolean"
    || typeof draft.hasStorage !== "boolean"
    || typeof draft.hasTerminal !== "boolean"
    || typeof draft.terminalReachable !== "boolean"
    || !isSafeTick(draft.terminalReadyAt)
    || !["normal", "pressure", "emergency"].includes(draft.capacityState)
    || typeof draft.receiverEligible !== "boolean"
    || receiverStorageHeadroom === null
    || receiverTerminalHeadroom === null
    || terminalStagingFreeCapacity === null
    || transferBatchSize === null
    || transferBatchSize <= 0
    || actionEnergyBudget === null
    || terminalActionEnergyAmount === null
    || terminalActionEnergyAmount > actionEnergyBudget
    || resources === null
  ) return null;
  return {
    roomName: draft.roomName,
    epochRevision: draft.epochRevision,
    epochFingerprint: draft.epochFingerprint,
    owned: draft.owned,
    hasStorage: draft.hasStorage,
    hasTerminal: draft.hasTerminal,
    terminalReachable: draft.terminalReachable,
    terminalReadyAt: draft.terminalReadyAt,
    capacityState: draft.capacityState,
    receiverEligible: draft.receiverEligible,
    receiverStorageHeadroom,
    receiverTerminalHeadroom,
    terminalStagingFreeCapacity,
    transferBatchSize,
    actionEnergyBudget,
    terminalActionEnergyAmount,
    resources,
  };
}

/**
 * 逐字段等价比较（roomFact 全语义字段 + 逐资源三元组）；仅用于
 * sameSemantic 判定，避免每 epoch 为两侧各构建一次 JSON 签名串。
 */
function isSameRoomFactSemantic(
  left: LogisticsRoomFactSemantic,
  right: LogisticsRoomFactSemantic,
): boolean {
  if (
    left.roomName !== right.roomName
    || left.epochRevision !== right.epochRevision
    || left.epochFingerprint !== right.epochFingerprint
    || left.owned !== right.owned
    || left.hasStorage !== right.hasStorage
    || left.hasTerminal !== right.hasTerminal
    || left.terminalReachable !== right.terminalReachable
    || left.terminalReadyAt !== right.terminalReadyAt
    || left.capacityState !== right.capacityState
    || left.receiverEligible !== right.receiverEligible
    || left.receiverStorageHeadroom !== right.receiverStorageHeadroom
    || left.receiverTerminalHeadroom !== right.receiverTerminalHeadroom
    || left.terminalStagingFreeCapacity !== right.terminalStagingFreeCapacity
    || left.transferBatchSize !== right.transferBatchSize
    || left.actionEnergyBudget !== right.actionEnergyBudget
    || left.terminalActionEnergyAmount !== right.terminalActionEnergyAmount
    || left.resources.length !== right.resources.length
  ) return false;
  return left.resources.every((resource, index) => {
    const other = right.resources[index];
    return resource.resource === other.resource
      && resource.sourceAvailableAmount === other.sourceAvailableAmount
      && resource.sourceTerminalAmount === other.sourceTerminalAmount
      && resource.receiverResourceHeadroom === other.receiverResourceHeadroom;
  });
}

function isRoomResourceFactRecord(value: unknown): value is LogisticsRoomResourceFactV1 {
  if (!isRecord(value)) return false;
  const resource = ownValue(value, "resource");
  const sourceAvailableAmount = ownValue(value, "sourceAvailableAmount");
  const sourceTerminalAmount = ownValue(value, "sourceTerminalAmount");
  return typeof resource === "string"
    && RESOURCES_ALL.includes(resource as ResourceConstant)
    && isStoredAmount(sourceAvailableAmount)
    && isStoredAmount(sourceTerminalAmount)
    && sourceTerminalAmount <= sourceAvailableAmount
    && isStoredAmount(ownValue(value, "receiverResourceHeadroom"));
}

function isRoomFactRecord(value: unknown): value is LogisticsRoomFactV1 {
  if (!isRecord(value)) return false;
  const roomName = ownValue(value, "roomName");
  const observedAt = ownValue(value, "observedAt");
  const expiresAt = ownValue(value, "expiresAt");
  const resources = ownValue(value, "resources");
  const actionEnergyBudget = ownValue(value, "actionEnergyBudget");
  const terminalActionEnergyAmount = ownValue(value, "terminalActionEnergyAmount");
  if (!Array.isArray(resources) || resources.length > LOGISTICS_CONTROL_STORE_LIMIT) return false;
  const resourceNames = new Set<string>();
  for (const resource of resources) {
    if (!isRoomResourceFactRecord(resource) || resourceNames.has(resource.resource)) return false;
    resourceNames.add(resource.resource);
  }
  return isRoomName(roomName)
    && ownValue(value, "id") === encodeRoomFactKey(roomName)
    && isSafeTick(ownValue(value, "revision"))
    && (ownValue(value, "revision") as number) > 0
    && isNonEmptyBoundedString(ownValue(value, "epochRevision"), 512)
    && isNonEmptyBoundedString(ownValue(value, "epochFingerprint"), 512)
    && isSafeTick(observedAt)
    && isSafeTick(expiresAt)
    && observedAt <= expiresAt
    && typeof ownValue(value, "owned") === "boolean"
    && typeof ownValue(value, "hasStorage") === "boolean"
    && typeof ownValue(value, "hasTerminal") === "boolean"
    && typeof ownValue(value, "terminalReachable") === "boolean"
    && isSafeTick(ownValue(value, "terminalReadyAt"))
    && ["normal", "pressure", "emergency"].includes(ownValue(value, "capacityState") as string)
    && typeof ownValue(value, "receiverEligible") === "boolean"
    && isStoredAmount(ownValue(value, "receiverStorageHeadroom"))
    && isStoredAmount(ownValue(value, "receiverTerminalHeadroom"))
    && isStoredAmount(ownValue(value, "terminalStagingFreeCapacity"))
    && isStoredAmount(ownValue(value, "transferBatchSize"))
    && (ownValue(value, "transferBatchSize") as number) > 0
    && isStoredAmount(actionEnergyBudget)
    && isStoredAmount(terminalActionEnergyAmount)
    && terminalActionEnergyAmount <= actionEnergyBudget;
}

function buildRoomFactReplacement(
  store: Readonly<LogisticsControlStoreV1>,
  drafts: readonly LogisticsRoomFactDraft[],
): ReplaceLogisticsRecordsResult<LogisticsRoomFactV1> & {
  readonly record?: Record<string, LogisticsRoomFactV1>;
} {
  if (drafts.length > LOGISTICS_CONTROL_STORE_LIMIT) return { ok: false, reason: "store_limit" };
  const nextFacts = createRecord<LogisticsRoomFactV1>();
  const published: LogisticsRoomFactV1[] = [];
  for (const draft of [...drafts].sort((left, right) =>
    compareCanonicalStrings(left.roomName, right.roomName)
  )) {
    const key = encodeRoomFactKey(draft.roomName);
    if (Object.prototype.hasOwnProperty.call(nextFacts, key)) {
      return { ok: false, reason: "invalid_or_duplicate_room" };
    }
    const semantic = normalizeRoomFactDraft(draft);
    if (!semantic) return { ok: false, reason: "invalid_draft" };
    const current = store.roomFacts[key];
    const validCurrent = isRoomFactRecord(current);
    let sameSemantic = false;
    if (validCurrent) {
      if (
        current.epochRevision !== semantic.epochRevision
        || current.epochFingerprint !== semantic.epochFingerprint
      ) {
        logisticsControlCodecDiagnostics.roomFactEpochShortCircuits += 1;
      } else {
        logisticsControlCodecDiagnostics.roomFactSemanticComparisons += 1;
        sameSemantic = isSameRoomFactSemantic(current, semantic);
      }
    }
    const observedAt = sameSemantic && validCurrent
      ? Math.max(current.observedAt, Game.time)
      : Game.time;
    const expiresAt = sameSemantic && validCurrent
      ? Math.max(current.expiresAt, Game.time + normalizeTtl(draft.ttl))
      : Game.time + normalizeTtl(draft.ttl);
    const next: LogisticsRoomFactV1 = {
      ...semantic,
      id: key,
      revision: validCurrent ? (sameSemantic ? current.revision : current.revision + 1) : 1,
      observedAt,
      expiresAt,
    };
    defineRecordValue(nextFacts, key, next);
    published.push(next);
  }
  return { ok: true, entries: published, record: nextFacts };
}

export function replaceLogisticsRoomFacts(
  drafts: readonly LogisticsRoomFactDraft[],
): ReplaceLogisticsRecordsResult<LogisticsRoomFactV1> {
  if (drafts.length > LOGISTICS_CONTROL_STORE_LIMIT) return { ok: false, reason: "store_limit" };
  const roomNames = new Set<string>();
  for (const draft of drafts) {
    if (roomNames.has(draft.roomName)) return { ok: false, reason: "invalid_or_duplicate_room" };
    if (!normalizeRoomFactDraft(draft)) return { ok: false, reason: "invalid_draft" };
    roomNames.add(draft.roomName);
  }
  const ensured = ensureLogisticsControlStore();
  if (ensured.ok === false) return { ok: false, reason: ensured.reason };
  const replacement = buildRoomFactReplacement(ensured.store, drafts);
  if (replacement.ok === false || !replacement.record) return replacement;
  const nextStore: LogisticsControlStoreV1 = {
    schemaVersion: 1,
    latestIntents: ensured.store.latestIntents,
    roomFacts: replacement.record,
    synthesisObservations: ensured.store.synthesisObservations,
    producerSnapshots: ensured.store.producerSnapshots,
    generation: ensured.store.generation,
    cursor: ensured.store.cursor,
  };
  const owner = readResourceControlOwner();
  if (!owner) return { ok: false, reason: "owner_unavailable" };
  const committed = attachLogisticsStore(owner, nextStore);
  if (committed.ok === false) return { ok: false, reason: committed.reason };
  return { ok: true, entries: replacement.entries };
}

export function cleanupLogisticsControlStore(
  ownedRooms: ReadonlySet<string>,
  currentTick = Game.time,
): number {
  const read = peekLogisticsControlStore();
  if (!read.ok) return 0;
  const store = read.store;
  const intents = createRecord<LatestLogisticsDemandV1>();
  const roomFacts = createRecord<LogisticsRoomFactV1>();
  const synthesisObservations = createRecord<SynthesisLogisticsObservationV1>();
  const producerSnapshots = createRecord<LogisticsProducerSnapshotV1>();
  const invalidProducers = new Set<string>();
  let removed = 0;
  for (const snapshot of Object.values(store.producerSnapshots)) {
    if (!isProducerSnapshotRecord(snapshot) || snapshot.expiresAt < currentTick) {
      if (isProducerSnapshotRecord(snapshot)) invalidProducers.add(snapshot.producer);
    }
  }
  for (const value of Object.values(store.latestIntents)) {
    if (
      !isDemandRecord(value)
      || value.expiresAt < currentTick
      || !ownedRooms.has(value.targetRoomName)
    ) {
      if (isDemandRecord(value)) invalidProducers.add(value.producer);
    }
  }
  for (const [key, value] of Object.entries(store.latestIntents)) {
    if (
      !isDemandRecord(value)
      || value.expiresAt < currentTick
      || !ownedRooms.has(value.targetRoomName)
      || invalidProducers.has(value.producer)
    ) {
      removed += 1;
      continue;
    }
    defineRecordValue(intents, key, value);
  }
  for (const [key, value] of Object.entries(store.roomFacts)) {
    if (!isRoomFactRecord(value) || value.expiresAt < currentTick || !ownedRooms.has(value.roomName)) {
      removed += 1;
      continue;
    }
    defineRecordValue(roomFacts, key, value);
  }
  const retainedIntentIds = new Set(Object.values(intents).map((intent) => intent.id));
  for (const [key, value] of Object.entries(store.synthesisObservations)) {
    if (!isSynthesisObservationRecord(value) || key !== value.intentId || !retainedIntentIds.has(value.intentId)) {
      removed += 1;
      continue;
    }
    defineRecordValue(synthesisObservations, key, value);
  }
  const retainedIntentCountByProducer = new Map<string, number>();
  for (const intent of Object.values(intents)) {
    retainedIntentCountByProducer.set(
      intent.producer,
      (retainedIntentCountByProducer.get(intent.producer) ?? 0) + 1,
    );
  }
  for (const [key, value] of Object.entries(store.producerSnapshots)) {
    if (
      !isProducerSnapshotRecord(value)
      || key !== encodeProducerSnapshotKey(value.producer)
      || value.expiresAt < currentTick
      || invalidProducers.has(value.producer)
      || value.emitted !== (retainedIntentCountByProducer.get(value.producer) ?? 0)
    ) {
      removed += 1;
      continue;
    }
    defineRecordValue(producerSnapshots, key, value);
  }
  const activeKeys = new Set(Object.keys(intents));
  const generation = pruneGeneration(store.generation, activeKeys);
  if (
    removed === 0
    && Object.keys(generation).length === Object.keys(store.generation).length
  ) return 0;
  const owner = readResourceControlOwner();
  if (!owner) return 0;
  const cleanedStore: LogisticsControlStoreV1 = {
    schemaVersion: 1,
    latestIntents: intents,
    roomFacts,
    synthesisObservations,
    producerSnapshots,
    generation,
    cursor: store.cursor,
  };
  if (!attachLogisticsStore(owner, cleanedStore).ok) return 0;
  return removed;
}
