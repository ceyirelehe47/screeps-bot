/**
 * 基础矿物 Direct V3 permit chain。
 *
 * 本模块只处理不可变纯数据，不读取 Game/Memory，也不调用市场 API。V2
 * permit 只以调用方已经认证的 opaque record 保存；本模块绝不为旧 payload
 * 补字段、重算 ID 或改变其 hash domain。
 */

import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES,
  MARKET_BASE_RESOURCE_MAX_LANES,
  MARKET_BASE_RESOURCE_MAX_ROOMS,
  MARKET_BASE_RESOURCE_POLICIES,
  MARKET_BASE_RESOURCE_SCHEMA_VERSION,
  type MarketBaseDerivedLaneLifecycle,
  type MarketBaseLaneStage,
  type MarketBaseResource,
  type MarketBaseResourcePolicy,
  type MarketBaseSellerRoomState,
  type MarketBaseSharedPolicy,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  computeMarketBaseResourcePolicyFingerprint,
  validateMarketBaseDerivedLaneLifecycle,
} from "@/runtime/marketBaseResourcePolicy";
import {
  MARKET_DIRECT_CONTINUOUS_CAPABILITY,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
  MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
  MARKET_DIRECT_CONTINUOUS_SCHEMA,
  canonicalStableHashV1,
  type MarketDirectContinuousPermit,
} from "@/runtime/marketDirectContinuousPolicy";

export const MARKET_BASE_RESOURCE_PERMIT_SCHEMA_VERSION =
  MARKET_BASE_RESOURCE_SCHEMA_VERSION;
export const MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION =
  "market-base-resource-permit-hash-v1" as const;
export const MARKET_BASE_RESOURCE_PERMIT_CAPABILITY =
  "market-base-resource-all-rooms" as const;
export const MARKET_BASE_RESOURCE_PERMIT_SUFFIX_LIMIT = 64 as const;
export const MARKET_BASE_RESOURCE_RECEIPT_REFERENCE_LIMIT = 512 as const;
export const MARKET_BASE_RESOURCE_ACTIVE_REVIEW_REFERENCE_LIMIT =
  MARKET_BASE_RESOURCE_MAX_LANES;
export const MARKET_BASE_RESOURCE_REFERENCED_BINDING_LIMIT = 624 as const;
export const MARKET_BASE_RESOURCE_PLANNED_AMOUNT = 1_000 as const;
export const MARKET_BASE_RESOURCE_MAX_TRANSACTION_ENERGY = 1_000 as const;
export const MARKET_BASE_RESOURCE_V2_LEGACY_X_ENTRY_ID =
  "base-x-e6n59-v1" as const;
const MARKET_BASE_RESOURCE_NO_CUTOVER_CHECKPOINT_HASH = canonicalStableHashV1(
  "market-base-resource:no-v2-cutover-checkpoint",
);

const DIGEST_PATTERN = /^(?:csh1:[0-9a-f]{32}|[a-z0-9][a-z0-9:._+-]{7,255})$/;

const permitDeepFrozenValues = new WeakSet<object>();
let marketBaseResourcePermitRuntimeTestProbe:
  ((event: "runtime_gate") => void) | undefined;

/** 仅供复杂度回归测试观测 gate 次数；生产默认无 probe。 */
export function setMarketBaseResourcePermitRuntimeTestProbe(
  probe: ((event: "runtime_gate") => void) | undefined,
): void {
  marketBaseResourcePermitRuntimeTestProbe = probe;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value && typeof value === "object" && !seen.has(value)) {
    if (permitDeepFrozenValues.has(value)) return value;
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested, seen);
    }
    if (!Object.isFrozen(value)) Object.freeze(value);
    permitDeepFrozenValues.add(value);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function isSafeTick(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeTick(value) && value > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalStableHashV1(left) === canonicalStableHashV1(right);
}

export interface MarketBaseResourceV2EventCutoverCheckpoint {
  readonly schemaVersion: 3;
  readonly hashRevision: "market-base-resource-v2-event-cutover-v1";
  readonly outerLedgerSchema: 2;
  readonly lastV2AttemptSeq: number;
  readonly lastV2OutcomeSeq: number;
  readonly v2ReceiptHeadHash: string;
  readonly v2LedgerCheckpointHash: string;
  readonly checkpointHash: string;
}

type CutoverWithoutHash = Omit<
  MarketBaseResourceV2EventCutoverCheckpoint,
  "checkpointHash"
>;

function cutoverPayload(input: CutoverWithoutHash): unknown {
  return {
    domain: "market-base-resource:v2-event-cutover-v1",
    ...input,
  };
}

export function buildMarketBaseResourceV2EventCutoverCheckpoint(input: {
  readonly lastV2AttemptSeq: number;
  readonly lastV2OutcomeSeq: number;
  readonly v2ReceiptHeadHash: string;
  readonly v2LedgerCheckpointHash: string;
}): MarketBaseResourceV2EventCutoverCheckpoint {
  if (
    !isSafeTick(input.lastV2AttemptSeq) ||
    !isSafeTick(input.lastV2OutcomeSeq) ||
    input.lastV2OutcomeSeq > input.lastV2AttemptSeq ||
    !isDigest(input.v2ReceiptHeadHash) ||
    !isDigest(input.v2LedgerCheckpointHash)
  ) {
    throw new TypeError("invalid v2 event cutover checkpoint");
  }
  const payload: CutoverWithoutHash = {
    schemaVersion: 3,
    hashRevision: "market-base-resource-v2-event-cutover-v1",
    outerLedgerSchema: 2,
    lastV2AttemptSeq: input.lastV2AttemptSeq,
    lastV2OutcomeSeq: input.lastV2OutcomeSeq,
    v2ReceiptHeadHash: input.v2ReceiptHeadHash,
    v2LedgerCheckpointHash: input.v2LedgerCheckpointHash,
  };
  return deepFreeze({
    ...payload,
    checkpointHash: canonicalStableHashV1(cutoverPayload(payload)),
  }) as MarketBaseResourceV2EventCutoverCheckpoint;
}

export function validateMarketBaseResourceV2EventCutoverCheckpoint(
  value: unknown,
): value is MarketBaseResourceV2EventCutoverCheckpoint {
  if (!isPlainRecord(value)) return false;
  const expectedKeys = [
    "checkpointHash",
    "hashRevision",
    "lastV2AttemptSeq",
    "lastV2OutcomeSeq",
    "outerLedgerSchema",
    "schemaVersion",
    "v2LedgerCheckpointHash",
    "v2ReceiptHeadHash",
  ];
  if (
    Object.keys(value).sort().join("|") !== expectedKeys.sort().join("|") ||
    value.schemaVersion !== 3 ||
    value.hashRevision !== "market-base-resource-v2-event-cutover-v1" ||
    value.outerLedgerSchema !== 2 ||
    !isSafeTick(value.lastV2AttemptSeq) ||
    !isSafeTick(value.lastV2OutcomeSeq) ||
    value.lastV2OutcomeSeq > value.lastV2AttemptSeq ||
    !isDigest(value.v2ReceiptHeadHash) ||
    !isDigest(value.v2LedgerCheckpointHash) ||
    !isDigest(value.checkpointHash)
  ) {
    return false;
  }
  const { checkpointHash: _checkpointHash, ...payload } =
    value as unknown as MarketBaseResourceV2EventCutoverCheckpoint;
  return (
    value.checkpointHash === canonicalStableHashV1(cutoverPayload(payload))
  );
}

/**
 * 旧 permit 的原始 bytes/payload 由 frozen V2 validator 在外部认证。本包装
 * 只记录该认证结果和 opaque tip，不把 wrapper 字段写回 rawRecord。
 */
export interface MarketBaseResourceLegacyV2OpaquePermitRecord {
  readonly recordVersion: "legacy-v2-opaque";
  readonly schemaVersion: 2;
  readonly epoch: number;
  readonly permitId: string;
  readonly permitHead: string;
  readonly previousPermitId: string;
  readonly previousPermitHead: string;
  readonly opaqueSelfHash: string;
  readonly rawRecord: MarketDirectContinuousPermit;
  readonly rawRecordCommitment: string;
  readonly grantDigest: string;
  readonly reviewDigest: string;
  readonly authenticated: true;
}

function frozenLegacyV2PermitPayload(
  raw: MarketDirectContinuousPermit,
): Omit<MarketDirectContinuousPermit, "permitId" | "permitHead"> {
  const { permitId: _permitId, permitHead: _permitHead, ...payload } = raw;
  return payload;
}

function frozenLegacyV2PermitId(
  payload: Omit<MarketDirectContinuousPermit, "permitId" | "permitHead">,
): string {
  return `mdc-permit-v2:${canonicalStableHashV1({
    domain: "market-direct-continuous:permit-id-v2",
    permit: payload,
  })}`;
}

function frozenLegacyV2PermitHead(
  previousPermitHead: string,
  permitId: string,
  payload: Omit<MarketDirectContinuousPermit, "permitId" | "permitHead">,
): string {
  return canonicalStableHashV1({
    domain: "market-direct-continuous:permit-head-v2",
    permitDigest: canonicalStableHashV1(payload),
    permitId,
    previousPermitHead,
  });
}

function frozenLegacyV2RawCommitment(
  raw: MarketDirectContinuousPermit,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:legacy-v2-raw-permit-v1",
    rawRecord: raw,
  });
}

function frozenLegacyV2GrantDigest(raw: MarketDirectContinuousPermit): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:legacy-v2-grants-v1",
    grants: raw.entryGrants,
  });
}

function frozenLegacyV2ReviewDigest(raw: MarketDirectContinuousPermit): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:legacy-v2-review-v1",
    evidence: raw.reviewedEvidence,
  });
}

function validateFrozenLegacyV2PermitRaw(
  value: unknown,
): value is MarketDirectContinuousPermit {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "accountIdentity",
      "canonicalExecutionTable",
      "capability",
      "createdAt",
      "engineAssumptionCommit",
      "entryGrants",
      "epoch",
      "executorShard",
      "globalPolicy",
      "operatorAuthorizationFingerprint",
      "permitHead",
      "permitId",
      "previousLedgerHead",
      "previousPermitHead",
      "previousPermitId",
      "reviewedEvidence",
      "schema",
      "sharedDirectFingerprint",
      "sharedPolicyFingerprint",
    ])
  ) {
    return false;
  }
  const raw = value as unknown as MarketDirectContinuousPermit;
  if (
    raw.capability !== MARKET_DIRECT_CONTINUOUS_CAPABILITY ||
    raw.schema !== MARKET_DIRECT_CONTINUOUS_SCHEMA ||
    raw.executorShard !== MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD ||
    !isPositiveSafeInteger(raw.epoch) ||
    !isSafeTick(raw.createdAt) ||
    typeof raw.accountIdentity !== "string" ||
    raw.accountIdentity.length === 0 ||
    !isDigest(raw.engineAssumptionCommit) ||
    !isDigest(raw.sharedDirectFingerprint) ||
    !isDigest(raw.sharedPolicyFingerprint) ||
    !isDigest(raw.previousPermitHead) ||
    !isDigest(raw.previousLedgerHead) ||
    (raw.previousPermitId !== "" && !isDigest(raw.previousPermitId)) ||
    !isDigest(raw.operatorAuthorizationFingerprint) ||
    !Array.isArray(raw.entryGrants) ||
    !Array.isArray(raw.reviewedEvidence) ||
    !sameCanonical(
      raw.canonicalExecutionTable,
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
    ) ||
    !sameCanonical(raw.globalPolicy, MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY)
  ) {
    return false;
  }
  if (
    raw.entryGrants.length !==
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.length ||
    raw.entryGrants.some(
      (grant, index) =>
        !isPlainRecord(grant) ||
        !exactKeys(grant, [
          "entryId",
          "lifecycleEvidenceDigest",
          "newDealGrant",
          "resourceFingerprint",
          "stage",
        ]) ||
        grant.entryId !==
          MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE[index]?.entryId ||
        grant.resourceFingerprint !==
          MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE[index]
            ?.resourceFingerprint ||
        typeof grant.stage !== "string" ||
        ![
          "shadow",
          "qualified",
          "canary",
          "review_paused",
          "continuous",
        ].includes(grant.stage) ||
        typeof grant.newDealGrant !== "string" ||
        !["enabled", "suspended"].includes(grant.newDealGrant) ||
        !isDigest(grant.lifecycleEvidenceDigest),
    ) ||
    raw.reviewedEvidence.some(
      (evidence) =>
        !isPlainRecord(evidence) ||
        !exactKeys(evidence, ["digest", "entryId", "evidenceKey", "kind"]) ||
        typeof evidence.entryId !== "string" ||
        !MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.some(
          (entry) => entry.entryId === evidence.entryId,
        ) ||
        !isDigest(evidence.evidenceKey) ||
        !isDigest(evidence.digest),
    )
  ) {
    return false;
  }
  const payload = frozenLegacyV2PermitPayload(raw);
  const expectedId = frozenLegacyV2PermitId(payload);
  return (
    raw.permitId === expectedId &&
    raw.permitHead ===
      frozenLegacyV2PermitHead(raw.previousPermitHead, expectedId, payload)
  );
}

export function wrapAuthenticatedLegacyV2PermitRecord(input: {
  readonly rawRecord: MarketDirectContinuousPermit;
  readonly authenticated: true;
}): MarketBaseResourceLegacyV2OpaquePermitRecord {
  if (
    input.authenticated !== true ||
    !validateFrozenLegacyV2PermitRaw(input.rawRecord)
  ) {
    throw new TypeError("invalid authenticated v2 permit wrapper");
  }
  const rawRecord = clone(input.rawRecord);
  const rawRecordCommitment = frozenLegacyV2RawCommitment(rawRecord);
  return deepFreeze({
    recordVersion: "legacy-v2-opaque" as const,
    schemaVersion: 2 as const,
    epoch: rawRecord.epoch,
    permitId: rawRecord.permitId,
    permitHead: rawRecord.permitHead,
    previousPermitId: rawRecord.previousPermitId,
    previousPermitHead: rawRecord.previousPermitHead,
    opaqueSelfHash: canonicalStableHashV1({
      domain: "market-base-resource:legacy-v2-opaque-self-v1",
      rawRecordCommitment,
    }),
    rawRecord,
    rawRecordCommitment,
    grantDigest: frozenLegacyV2GrantDigest(rawRecord),
    reviewDigest: frozenLegacyV2ReviewDigest(rawRecord),
    authenticated: true as const,
  }) as MarketBaseResourceLegacyV2OpaquePermitRecord;
}

export type MarketBaseResourceNewDealGrant = "enabled" | "suspended";

export interface MarketBaseResourceSignedLaneGrant {
  readonly laneId: string;
  readonly resource: MarketBaseResource;
  readonly resourcePolicyId: string;
  readonly resourcePolicyFingerprint: string;
  readonly roomInstanceId: string;
  readonly sellerRoom: string;
  readonly roomFingerprint: string;
  readonly sharedPolicyFingerprint: string;
  readonly laneStableFingerprint: string;
  readonly status: "active" | "tombstoned";
  readonly stage: MarketBaseLaneStage;
  readonly newDealGrant: MarketBaseResourceNewDealGrant;
  readonly lifecycleEvidenceDigest: string;
  readonly reviewDigest: string;
  readonly grantFingerprint: string;
}

interface SignedLaneGrantWithoutFingerprint extends Omit<
  MarketBaseResourceSignedLaneGrant,
  "grantFingerprint"
> {}

function signedLaneGrantFingerprint(
  grant: SignedLaneGrantWithoutFingerprint,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:signed-lane-grant-v1",
    grant,
  });
}

export function buildMarketBaseResourceSignedLaneGrant(input: {
  readonly lane: MarketBaseDerivedLaneLifecycle;
  readonly status?: "active" | "tombstoned";
  readonly stage?: MarketBaseLaneStage;
  readonly newDealGrant?: MarketBaseResourceNewDealGrant;
  readonly lifecycleEvidenceDigest?: string;
  readonly reviewDigest?: string;
}): MarketBaseResourceSignedLaneGrant {
  const stage = input.stage ?? input.lane.stage;
  const status =
    input.status ??
    (input.lane.status === "tombstoned" ? "tombstoned" : "active");
  const newDealGrant = input.newDealGrant ?? "suspended";
  const lifecycleEvidenceDigest =
    input.lifecycleEvidenceDigest ??
    canonicalStableHashV1({
      domain: "market-base-resource:lane-lifecycle-evidence-v1",
      laneId: input.lane.laneId,
      shadowEvidence: input.lane.shadowEvidence,
      stableFingerprint: input.lane.stableFingerprint,
      stage,
      status,
    });
  const reviewDigest = input.reviewDigest ?? lifecycleEvidenceDigest;
  const payload: SignedLaneGrantWithoutFingerprint = {
    laneId: input.lane.laneId,
    resource: input.lane.resource,
    resourcePolicyId: input.lane.resourcePolicyId,
    resourcePolicyFingerprint: input.lane.resourcePolicyFingerprint,
    roomInstanceId: input.lane.roomInstanceId,
    sellerRoom: input.lane.sellerRoomName,
    roomFingerprint: input.lane.roomFingerprint,
    sharedPolicyFingerprint: input.lane.sharedPolicyFingerprint,
    laneStableFingerprint: input.lane.stableFingerprint,
    status,
    stage,
    newDealGrant,
    lifecycleEvidenceDigest,
    reviewDigest,
  };
  return deepFreeze({
    ...payload,
    grantFingerprint: signedLaneGrantFingerprint(payload),
  }) as MarketBaseResourceSignedLaneGrant;
}

export type MarketBaseResourceReviewedEvidenceKind =
  | "shadow_qualification"
  | "canary_confirmation"
  | "continuous_review"
  | "suspension_review";

export interface MarketBaseResourceReviewedEvidence {
  readonly laneId: string;
  readonly kind: MarketBaseResourceReviewedEvidenceKind;
  readonly evidenceKey: string;
  readonly digest: string;
  readonly permitId?: string;
  readonly attemptSeq?: number;
  readonly receiptEventHash?: string;
  readonly ledgerCheckpointHash?: string;
  readonly ledgerReceiptHeadHash?: string;
  readonly ledgerPermitAnchorHash?: string;
  readonly confirmedCanaryReviewDigest?: string;
  readonly operatorReviewSnapshotDigest?: string;
}

export interface MarketBaseResourceValidatedConfirmedCanaryProof {
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
  readonly ledgerCheckpointHash: string;
  readonly ledgerReceiptHeadHash: string;
  readonly ledgerPermitAnchorHash: string;
  readonly proofHash: string;
}

function confirmedCanaryProofPayload(
  proof: Omit<MarketBaseResourceValidatedConfirmedCanaryProof, "proofHash">,
): unknown {
  return {
    domain: "market-base-resource:validated-confirmed-canary-proof-v1",
    proof,
  };
}

export function sealMarketBaseResourceValidatedConfirmedCanaryProof(
  input: Omit<MarketBaseResourceValidatedConfirmedCanaryProof, "proofHash">,
): MarketBaseResourceValidatedConfirmedCanaryProof {
  if (
    !isDigest(input.laneId) ||
    !isPositiveSafeInteger(input.attemptSeq) ||
    !isDigest(input.permitId) ||
    !isPositiveSafeInteger(input.permitEpoch) ||
    !isDigest(input.evidenceKey) ||
    !isDigest(input.receiptEventHash) ||
    !isSafeTick(input.confirmedAt) ||
    !isSafeTick(input.transactionTime) ||
    input.transactionTime !== input.confirmedAt ||
    !isPositiveSafeInteger(input.actualAmount) ||
    input.actualAmount > MARKET_BASE_RESOURCE_PLANNED_AMOUNT ||
    !isSafeTick(input.actualTransactionEnergy) ||
    input.actualTransactionEnergy >
      MARKET_BASE_RESOURCE_MAX_TRANSACTION_ENERGY ||
    !isPositiveSafeInteger(input.actualNetCreditsMilli) ||
    !isDigest(input.reviewDigest) ||
    !isDigest(input.ledgerCheckpointHash) ||
    !isDigest(input.ledgerReceiptHeadHash) ||
    !isDigest(input.ledgerPermitAnchorHash)
  ) {
    throw new TypeError("invalid confirmed canary proof");
  }
  return deepFreeze({
    ...clone(input),
    proofHash: canonicalStableHashV1(confirmedCanaryProofPayload(input)),
  }) as MarketBaseResourceValidatedConfirmedCanaryProof;
}

function validateConfirmedCanaryProof(
  value: unknown,
): value is MarketBaseResourceValidatedConfirmedCanaryProof {
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
      "ledgerCheckpointHash",
      "ledgerPermitAnchorHash",
      "ledgerReceiptHeadHash",
      "permitEpoch",
      "permitId",
      "proofHash",
      "receiptEventHash",
      "reviewDigest",
      "transactionTime",
    ]) ||
    !isDigest(value.proofHash)
  ) {
    return false;
  }
  const { proofHash: _proofHash, ...payload } =
    value as unknown as MarketBaseResourceValidatedConfirmedCanaryProof;
  try {
    const sealed = sealMarketBaseResourceValidatedConfirmedCanaryProof(payload);
    return sealed.proofHash === value.proofHash;
  } catch {
    return false;
  }
}

export interface MarketBaseResourceLegacyV2GrantSuspension {
  readonly entryId: typeof MARKET_BASE_RESOURCE_V2_LEGACY_X_ENTRY_ID;
  readonly previousNewDealGrant: "enabled";
  readonly nextNewDealGrant: "suspended";
  readonly noLegacyBridge: true;
  readonly suspensionDigest: string;
}

export function buildMarketBaseResourceLegacyV2GrantSuspension(input: {
  readonly previousPermitId: string;
  readonly previousPermitHead: string;
  readonly cutoverCheckpointHash: string;
}): MarketBaseResourceLegacyV2GrantSuspension {
  if (
    !isDigest(input.previousPermitId) ||
    !isDigest(input.previousPermitHead) ||
    !isDigest(input.cutoverCheckpointHash)
  ) {
    throw new TypeError("invalid legacy v2 grant suspension basis");
  }
  const payload = {
    entryId: MARKET_BASE_RESOURCE_V2_LEGACY_X_ENTRY_ID,
    previousNewDealGrant: "enabled" as const,
    nextNewDealGrant: "suspended" as const,
    noLegacyBridge: true as const,
  };
  return deepFreeze({
    ...payload,
    suspensionDigest: canonicalStableHashV1({
      domain: "market-base-resource:legacy-v2-x-suspension-v1",
      ...payload,
      ...input,
    }),
  }) as MarketBaseResourceLegacyV2GrantSuspension;
}

export interface MarketBaseResourceRatchetHighWater {
  readonly resource: MarketBaseResource;
  readonly ratchetFloor: number;
  readonly observedAt: number;
  readonly previousFingerprint: string;
  readonly fingerprint: string;
}

type RatchetHighWaterWithoutFingerprint = Omit<
  MarketBaseResourceRatchetHighWater,
  "fingerprint"
>;

function ratchetHighWaterFingerprint(
  value: RatchetHighWaterWithoutFingerprint,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:ratchet-high-water-v1",
    value,
  });
}

export function buildMarketBaseResourceRatchetHighWater(input: {
  readonly resource: MarketBaseResource;
  readonly ratchetFloor: number;
  readonly observedAt: number;
  readonly previousFingerprint: string;
}): MarketBaseResourceRatchetHighWater {
  if (
    !MARKET_BASE_RESOURCE_CATALOG.includes(input.resource) ||
    typeof input.ratchetFloor !== "number" ||
    !Number.isFinite(input.ratchetFloor) ||
    input.ratchetFloor <= 0 ||
    !isSafeTick(input.observedAt) ||
    !isDigest(input.previousFingerprint)
  ) {
    throw new TypeError("invalid ratchet high-water");
  }
  const payload: RatchetHighWaterWithoutFingerprint = {
    resource: input.resource,
    ratchetFloor: input.ratchetFloor,
    observedAt: input.observedAt,
    previousFingerprint: input.previousFingerprint,
  };
  return deepFreeze({
    ...payload,
    fingerprint: ratchetHighWaterFingerprint(payload),
  }) as MarketBaseResourceRatchetHighWater;
}

export function buildMarketBaseResourceBootstrapRatchetHighWater(
  observedAt: number,
): readonly MarketBaseResourceRatchetHighWater[] {
  return deepFreeze(
    MARKET_BASE_RESOURCE_CATALOG.map((resource) =>
      buildMarketBaseResourceRatchetHighWater({
        resource,
        ratchetFloor:
          MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[resource].ratchetFloor,
        observedAt,
        previousFingerprint: MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint,
      }),
    ),
  ) as readonly MarketBaseResourceRatchetHighWater[];
}

function sortedRatchetHighWater(
  entries: readonly MarketBaseResourceRatchetHighWater[],
): readonly MarketBaseResourceRatchetHighWater[] {
  return [...entries]
    .map((entry) => clone(entry))
    .sort(
      (left, right) =>
        MARKET_BASE_RESOURCE_CATALOG.indexOf(left.resource) -
        MARKET_BASE_RESOURCE_CATALOG.indexOf(right.resource),
    );
}

export function validateMarketBaseResourceRatchetHighWater(
  entries: readonly MarketBaseResourceRatchetHighWater[],
): boolean {
  return (
    entries.length === MARKET_BASE_RESOURCE_CATALOG.length &&
    entries.every((entry, index) => {
      const resource = MARKET_BASE_RESOURCE_CATALOG[index];
      if (
        entry.resource !== resource ||
        typeof entry.ratchetFloor !== "number" ||
        !Number.isFinite(entry.ratchetFloor) ||
        entry.ratchetFloor <
          MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[resource]
            .ratchetFloor ||
        !isSafeTick(entry.observedAt) ||
        !isDigest(entry.previousFingerprint) ||
        !isDigest(entry.fingerprint)
      ) {
        return false;
      }
      const { fingerprint: _fingerprint, ...payload } = entry;
      return entry.fingerprint === ratchetHighWaterFingerprint(payload);
    })
  );
}

function ratchetHighWaterCommitment(
  entries: readonly MarketBaseResourceRatchetHighWater[],
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:ratchet-high-water-map-v1",
    entries,
  });
}

function validateRatchetTransition(
  prior: readonly MarketBaseResourceRatchetHighWater[] | undefined,
  next: readonly MarketBaseResourceRatchetHighWater[],
): string | undefined {
  if (!validateMarketBaseResourceRatchetHighWater(next)) {
    return "ratchet_high_water_invalid";
  }
  for (let index = 0; index < next.length; index += 1) {
    const current = next[index];
    const previous = prior?.[index];
    if (!previous) {
      if (
        current.previousFingerprint !==
        MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint
      ) {
        return "ratchet_bootstrap_predecessor_invalid";
      }
      continue;
    }
    if (
      current.resource !== previous.resource ||
      current.ratchetFloor < previous.ratchetFloor ||
      current.observedAt < previous.observedAt
    ) {
      return "ratchet_high_water_rollback";
    }
    if (current.ratchetFloor === previous.ratchetFloor) {
      if (!sameCanonical(current, previous)) {
        return "ratchet_high_water_same_floor_rewrite";
      }
      continue;
    }
    if (current.previousFingerprint !== previous.fingerprint) {
      return "ratchet_high_water_chain_gap";
    }
  }
  return undefined;
}

export interface MarketBaseResourcePermit {
  readonly capability: typeof MARKET_BASE_RESOURCE_PERMIT_CAPABILITY;
  readonly schemaVersion: typeof MARKET_BASE_RESOURCE_PERMIT_SCHEMA_VERSION;
  readonly hashRevision: typeof MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION;
  readonly epoch: number;
  readonly permitId: string;
  readonly selfHash: string;
  readonly permitHead: string;
  readonly accountIdentity: string;
  readonly executorShard: "shard1";
  readonly sharedPolicy: MarketBaseSharedPolicy;
  readonly resourcePolicies: readonly MarketBaseResourcePolicy[];
  readonly ratchetHighWater: readonly MarketBaseResourceRatchetHighWater[];
  readonly signedLaneGrants: readonly MarketBaseResourceSignedLaneGrant[];
  readonly reviewedEvidence: readonly MarketBaseResourceReviewedEvidence[];
  readonly previousPermitId: string;
  readonly previousPermitHead: string;
  readonly previousLedgerHead: string;
  readonly v2EventCutoverCheckpoint?: MarketBaseResourceV2EventCutoverCheckpoint;
  readonly legacyV2GrantSuspension?: MarketBaseResourceLegacyV2GrantSuspension;
  readonly createdAt: number;
  readonly operatorAuthorizationFingerprint: string;
}

type PermitWithoutIdentity = Omit<
  MarketBaseResourcePermit,
  "permitId" | "selfHash" | "permitHead"
>;

function sortPolicies(
  policies: readonly MarketBaseResourcePolicy[],
): readonly MarketBaseResourcePolicy[] {
  const catalogOrder = new Map(
    MARKET_BASE_RESOURCE_CATALOG.map((resource, index) => [resource, index]),
  );
  return [...policies]
    .map((policy) => clone(policy))
    .sort(
      (left, right) =>
        (catalogOrder.get(left.resource) ?? Number.MAX_SAFE_INTEGER) -
        (catalogOrder.get(right.resource) ?? Number.MAX_SAFE_INTEGER),
    );
}

function sortGrants(
  grants: readonly MarketBaseResourceSignedLaneGrant[],
): readonly MarketBaseResourceSignedLaneGrant[] {
  return [...grants]
    .map((grant) => clone(grant))
    .sort((left, right) => left.laneId.localeCompare(right.laneId));
}

function sortReviewedEvidence(
  evidence: readonly MarketBaseResourceReviewedEvidence[],
): readonly MarketBaseResourceReviewedEvidence[] {
  return [...evidence]
    .map((entry) => clone(entry))
    .sort(
      (left, right) =>
        left.laneId.localeCompare(right.laneId) ||
        left.kind.localeCompare(right.kind) ||
        left.evidenceKey.localeCompare(right.evidenceKey),
    );
}

function permitSelfHash(payload: PermitWithoutIdentity): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:permit-self-v1",
    payload,
  });
}

function permitIdFor(epoch: number, selfHash: string): string {
  return `mbr-permit-v3:${epoch}:${selfHash}`;
}

function permitHeadFor(
  previousPermitHead: string,
  permitId: string,
  selfHash: string,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:permit-head-v1",
    permitId,
    previousPermitHead,
    selfHash,
  });
}

function validateResourcePolicies(
  sharedPolicy: MarketBaseSharedPolicy,
  policies: readonly MarketBaseResourcePolicy[],
): boolean {
  if (
    policies.length !== MARKET_BASE_RESOURCE_CATALOG.length ||
    policies.some(
      (policy, index) =>
        policy.resource !== MARKET_BASE_RESOURCE_CATALOG[index] ||
        !isDigest(policy.fingerprint),
    )
  ) {
    return false;
  }
  const canonicalByResource = new Map(
    MARKET_BASE_RESOURCE_POLICIES.map((policy) => [policy.resource, policy]),
  );
  if (
    policies.some((policy) => {
      const canonical = canonicalByResource.get(policy.resource);
      return (
        !canonical ||
        canonical.policyId !== policy.policyId ||
        canonical.fingerprint !== policy.fingerprint
      );
    })
  ) {
    return false;
  }
  const policyFingerprints = policies
    .map((policy) => policy.fingerprint)
    .sort();
  const sharedFingerprints = [
    ...sharedPolicy.resourcePolicyFingerprints,
  ].sort();
  return (
    policyFingerprints.length === sharedFingerprints.length &&
    policyFingerprints.every(
      (fingerprint, index) => fingerprint === sharedFingerprints[index],
    )
  );
}

/**
 * 历史permit的自洽校验：不与当前部署常量比对，只要求内嵌 policy 集合
 * （1）覆盖且仅覆盖 catalog 资源、（2）每条 fingerprint 能按其实际字段
 * 重算复原、（3）与同一 permit 内嵌的 sharedPolicy.resourcePolicyFingerprints
 * 名单一致。permit 的 selfHash 已保证内容不可篡改，这里补的是结构性
 * 自洽，使常量升级（re-sign 迁移）后链上旧版本 permit 仍可验证。
 */
function selfConsistentResourcePolicies(
  sharedPolicy: MarketBaseSharedPolicy,
  policies: readonly MarketBaseResourcePolicy[],
): boolean {
  if (
    policies.length !== MARKET_BASE_RESOURCE_CATALOG.length ||
    policies.some(
      (policy, index) =>
        policy.resource !== MARKET_BASE_RESOURCE_CATALOG[index] ||
        typeof policy.policyId !== "string" ||
        policy.policyId.length === 0 ||
        !isDigest(policy.fingerprint),
    )
  ) {
    return false;
  }
  if (
    policies.some((policy) => {
      const { fingerprint: _fingerprint, ...raw } = policy;
      return (
        policy.fingerprint !== computeMarketBaseResourcePolicyFingerprint(raw)
      );
    })
  ) {
    return false;
  }
  const policyFingerprints = policies
    .map((policy) => policy.fingerprint)
    .sort();
  const sharedFingerprints = [
    ...sharedPolicy.resourcePolicyFingerprints,
  ].sort();
  return (
    policyFingerprints.length === sharedFingerprints.length &&
    policyFingerprints.every(
      (fingerprint, index) => fingerprint === sharedFingerprints[index],
    )
  );
}

function validateSignedLaneGrants(
  grants: readonly MarketBaseResourceSignedLaneGrant[],
  sharedPolicy: MarketBaseSharedPolicy,
  policies: readonly MarketBaseResourcePolicy[],
): boolean {
  if (!Array.isArray(grants)) return false;
  const activeGrantCount = grants.filter(
    (grant) => grant.status === "active",
  ).length;
  const tombstonedGrantCount = grants.length - activeGrantCount;
  if (
    activeGrantCount > MARKET_BASE_RESOURCE_MAX_LANES ||
    tombstonedGrantCount > MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES
  ) {
    return false;
  }
  const policyById = new Map(
    policies.map((policy) => [policy.policyId, policy]),
  );
  const seen = new Set<string>();
  for (const grant of grants) {
    if (
      seen.has(grant.laneId) ||
      !isDigest(grant.laneId) ||
      !isDigest(grant.roomInstanceId) ||
      !isDigest(grant.roomFingerprint) ||
      !isDigest(grant.laneStableFingerprint) ||
      !isDigest(grant.lifecycleEvidenceDigest) ||
      !isDigest(grant.reviewDigest) ||
      grant.sharedPolicyFingerprint !== sharedPolicy.fingerprint ||
      grant.sellerRoom.length === 0 ||
      !["active", "tombstoned"].includes(grant.status) ||
      ![
        "shadow",
        "qualified",
        "canary",
        "review_paused",
        "continuous",
      ].includes(grant.stage) ||
      !["enabled", "suspended"].includes(grant.newDealGrant)
    ) {
      return false;
    }
    const policy = policyById.get(grant.resourcePolicyId);
    if (
      !policy ||
      policy.resource !== grant.resource ||
      policy.fingerprint !== grant.resourcePolicyFingerprint
    ) {
      return false;
    }
    const canWrite =
      grant.status === "active" &&
      (grant.stage === "canary" || grant.stage === "continuous");
    if (grant.newDealGrant === "enabled" && !canWrite) return false;
    const { grantFingerprint: _grantFingerprint, ...payload } = grant;
    if (grant.grantFingerprint !== signedLaneGrantFingerprint(payload)) {
      return false;
    }
    seen.add(grant.laneId);
  }
  const enabled = grants.filter((grant) => grant.newDealGrant === "enabled");
  if (enabled.filter((grant) => grant.stage === "canary").length > 1) {
    return false;
  }
  const enabledCanary = enabled.find((grant) => grant.stage === "canary");
  if (
    enabledCanary &&
    enabled.some(
      (grant) =>
        grant.laneId !== enabledCanary.laneId &&
        grant.resource === enabledCanary.resource,
    )
  ) {
    return false;
  }
  return true;
}

function validateReviewedEvidence(
  evidence: readonly MarketBaseResourceReviewedEvidence[],
  grants: readonly MarketBaseResourceSignedLaneGrant[],
): boolean {
  if (
    !Array.isArray(evidence as unknown) ||
    evidence.length > MARKET_BASE_RESOURCE_ACTIVE_REVIEW_REFERENCE_LIMIT
  ) {
    return false;
  }
  const lanes = new Set(grants.map((grant) => grant.laneId));
  const seenKeys = new Map<string, string>();
  for (const entry of evidence) {
    if (
      !isPlainRecord(entry) ||
      !exactKeys(
        entry,
        ["digest", "evidenceKey", "kind", "laneId"],
        [
          "attemptSeq",
          "confirmedCanaryReviewDigest",
          "ledgerCheckpointHash",
          "ledgerPermitAnchorHash",
          "ledgerReceiptHeadHash",
          "operatorReviewSnapshotDigest",
          "permitId",
          "receiptEventHash",
        ],
      ) ||
      !lanes.has(entry.laneId) ||
      ![
        "shadow_qualification",
        "canary_confirmation",
        "continuous_review",
        "suspension_review",
      ].includes(entry.kind) ||
      !isDigest(entry.evidenceKey) ||
      !isDigest(entry.digest) ||
      (entry.permitId !== undefined && !isDigest(entry.permitId)) ||
      (entry.attemptSeq !== undefined &&
        !isPositiveSafeInteger(entry.attemptSeq)) ||
      (entry.receiptEventHash !== undefined &&
        !isDigest(entry.receiptEventHash)) ||
      (entry.ledgerCheckpointHash !== undefined &&
        !isDigest(entry.ledgerCheckpointHash)) ||
      (entry.ledgerPermitAnchorHash !== undefined &&
        !isDigest(entry.ledgerPermitAnchorHash)) ||
      (entry.ledgerReceiptHeadHash !== undefined &&
        !isDigest(entry.ledgerReceiptHeadHash)) ||
      (entry.confirmedCanaryReviewDigest !== undefined &&
        !isDigest(entry.confirmedCanaryReviewDigest)) ||
      (entry.operatorReviewSnapshotDigest !== undefined &&
        !isDigest(entry.operatorReviewSnapshotDigest))
    ) {
      return false;
    }
    if (
      entry.kind === "continuous_review" &&
      (entry.permitId === undefined ||
        entry.attemptSeq === undefined ||
        entry.receiptEventHash === undefined ||
        entry.ledgerCheckpointHash === undefined ||
        entry.ledgerPermitAnchorHash === undefined ||
        entry.ledgerReceiptHeadHash === undefined ||
        entry.confirmedCanaryReviewDigest === undefined ||
        entry.operatorReviewSnapshotDigest === undefined ||
        entry.digest !== entry.operatorReviewSnapshotDigest ||
        entry.confirmedCanaryReviewDigest ===
          entry.operatorReviewSnapshotDigest)
    ) {
      return false;
    }
    if (
      entry.kind !== "continuous_review" &&
      (entry.confirmedCanaryReviewDigest !== undefined ||
        entry.operatorReviewSnapshotDigest !== undefined)
    ) {
      return false;
    }
    const previous = seenKeys.get(entry.evidenceKey);
    if (previous && previous !== entry.digest) return false;
    seenKeys.set(entry.evidenceKey, entry.digest);
  }
  return true;
}

export interface BuildMarketBaseResourcePermitInput {
  readonly epoch: number;
  readonly accountIdentity: string;
  readonly sharedPolicy: MarketBaseSharedPolicy;
  readonly resourcePolicies?: readonly MarketBaseResourcePolicy[];
  readonly ratchetHighWater: readonly MarketBaseResourceRatchetHighWater[];
  readonly signedLaneGrants: readonly MarketBaseResourceSignedLaneGrant[];
  readonly reviewedEvidence?: readonly MarketBaseResourceReviewedEvidence[];
  readonly previousPermitId: string;
  readonly previousPermitHead: string;
  readonly previousLedgerHead: string;
  readonly v2EventCutoverCheckpoint?: MarketBaseResourceV2EventCutoverCheckpoint;
  readonly legacyV2GrantSuspension?: MarketBaseResourceLegacyV2GrantSuspension;
  readonly createdAt: number;
  readonly operatorAuthorizationFingerprint: string;
}

type MarketBaseResourcePolicySetValidator = (
  sharedPolicy: MarketBaseSharedPolicy,
  policies: readonly MarketBaseResourcePolicy[],
) => boolean;

function mintMarketBaseResourcePermit(
  input: BuildMarketBaseResourcePermitInput,
  policySetValidator: MarketBaseResourcePolicySetValidator,
): MarketBaseResourcePermit {
  if (
    !isPositiveSafeInteger(input.epoch) ||
    !isSafeTick(input.createdAt) ||
    input.accountIdentity !==
      input.sharedPolicy.roomAdmissionPolicy.accountIdentity ||
    input.sharedPolicy.schemaVersion !== MARKET_BASE_RESOURCE_SCHEMA_VERSION ||
    !isDigest(input.sharedPolicy.fingerprint) ||
    !isDigest(input.previousPermitId) ||
    !isDigest(input.previousPermitHead) ||
    !isDigest(input.previousLedgerHead) ||
    !isDigest(input.operatorAuthorizationFingerprint)
  ) {
    throw new TypeError("invalid v3 permit basis");
  }
  const resourcePolicies = sortPolicies(
    input.resourcePolicies ?? MARKET_BASE_RESOURCE_POLICIES,
  );
  const signedLaneGrants = sortGrants(input.signedLaneGrants);
  const ratchetHighWater = sortedRatchetHighWater(input.ratchetHighWater);
  const reviewedEvidence = sortReviewedEvidence(input.reviewedEvidence ?? []);
  if (!policySetValidator(input.sharedPolicy, resourcePolicies)) {
    throw new TypeError("invalid v3 permit resource policies");
  }
  if (!validateMarketBaseResourceRatchetHighWater(ratchetHighWater)) {
    throw new TypeError("invalid v3 permit ratchet high-water");
  }
  if (
    !validateSignedLaneGrants(
      signedLaneGrants,
      input.sharedPolicy,
      resourcePolicies,
    )
  ) {
    throw new TypeError("invalid v3 permit lane grants");
  }
  if (!validateReviewedEvidence(reviewedEvidence, signedLaneGrants)) {
    throw new TypeError("invalid v3 permit reviewed evidence");
  }
  if (
    input.v2EventCutoverCheckpoint !== undefined &&
    !validateMarketBaseResourceV2EventCutoverCheckpoint(
      input.v2EventCutoverCheckpoint,
    )
  ) {
    throw new TypeError("invalid v3 permit cutover checkpoint");
  }
  const payload: PermitWithoutIdentity = {
    capability: MARKET_BASE_RESOURCE_PERMIT_CAPABILITY,
    schemaVersion: MARKET_BASE_RESOURCE_PERMIT_SCHEMA_VERSION,
    hashRevision: MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION,
    epoch: input.epoch,
    accountIdentity: input.accountIdentity,
    executorShard: "shard1",
    sharedPolicy: clone(input.sharedPolicy),
    resourcePolicies,
    ratchetHighWater,
    signedLaneGrants,
    reviewedEvidence,
    previousPermitId: input.previousPermitId,
    previousPermitHead: input.previousPermitHead,
    previousLedgerHead: input.previousLedgerHead,
    ...(input.v2EventCutoverCheckpoint
      ? {
          v2EventCutoverCheckpoint: clone(input.v2EventCutoverCheckpoint),
        }
      : {}),
    ...(input.legacyV2GrantSuspension
      ? {
          legacyV2GrantSuspension: clone(input.legacyV2GrantSuspension),
        }
      : {}),
    createdAt: input.createdAt,
    operatorAuthorizationFingerprint: input.operatorAuthorizationFingerprint,
  };
  const selfHash = permitSelfHash(payload);
  const permitId = permitIdFor(input.epoch, selfHash);
  return deepFreeze({
    ...payload,
    permitId,
    selfHash,
    permitHead: permitHeadFor(input.previousPermitHead, permitId, selfHash),
  }) as MarketBaseResourcePermit;
}

export function buildMarketBaseResourcePermit(
  input: BuildMarketBaseResourcePermitInput,
): MarketBaseResourcePermit {
  return mintMarketBaseResourcePermit(input, validateResourcePolicies);
}

/**
 * 仅供测试/历史重放：按自洽规则铸造 v3 permit，允许使用非当前部署
 * 版本的 policy 集合（用于复现"常量升级前"的世界状态）。生产路径
 * 必须走 buildMarketBaseResourcePermit——它要求 policy 集合与当前
 * 部署常量逐条一致，防止铸造出与部署代码脱节的 permit。
 */
export function buildDetachedMarketBaseResourcePermitForReplay(
  input: BuildMarketBaseResourcePermitInput,
): MarketBaseResourcePermit {
  return mintMarketBaseResourcePermit(
    input,
    selfConsistentResourcePolicies,
  );
}

export interface MarketBaseResourcePermitBinding {
  readonly permitId: string;
  readonly epoch: number;
  readonly selfHash: string;
  readonly grantDigest: string;
  readonly reviewDigest: string;
}

export interface MarketBaseResourcePermitReference {
  readonly sourceId: string;
  readonly permitId: string;
}

export interface MarketBaseResourcePermitPrefixCheckpoint {
  readonly schemaVersion: 3;
  readonly hashRevision: "market-base-resource-permit-prefix-v1";
  readonly prunedThroughEpoch: number;
  readonly firstPrunedPermitId: string;
  readonly firstPrunedPreviousPermitHead: string;
  readonly lastPrunedPermitId: string;
  readonly lastPrunedPermitHead: string;
  readonly v2CutoverCheckpointHash: string;
  readonly ratchetPermitEpoch: number;
  readonly ratchetHighWater: readonly MarketBaseResourceRatchetHighWater[];
  readonly ratchetHighWaterCommitment: string;
  readonly referencedPermitBindings: readonly MarketBaseResourcePermitBinding[];
  readonly prefixCommitment: string;
}

export type MarketBaseResourceRetainedPermitRecord =
  MarketBaseResourceLegacyV2OpaquePermitRecord | MarketBaseResourcePermit;

export interface MarketBaseResourcePermitBlocker {
  readonly code: string;
  readonly detectedAt: number;
  readonly detailHash: string;
}

export interface MarketBaseResourceLaneTombstoneDischarge {
  readonly laneId: string;
  readonly resource: MarketBaseResource;
  readonly resourcePolicyId: string;
  readonly resourcePolicyFingerprint: string;
  readonly roomInstanceId: string;
  readonly sellerRoom: string;
  readonly roomFingerprint: string;
  readonly sharedPolicyFingerprint: string;
  readonly laneStableFingerprint: string;
  readonly tombstonedGrantFingerprint: string;
  readonly dischargedAtEpoch: number;
  readonly dischargedByPermitId: string;
  readonly dischargeFingerprint: string;
}

export interface MarketBaseResourceLaneTombstoneCheckpoint {
  readonly schemaVersion: 3;
  readonly hashRevision: "market-base-resource-lane-tombstones-v1";
  readonly compressedCount: number;
  readonly compressedFirstDischargeFingerprint: string;
  readonly compressedLastDischargeFingerprint: string;
  readonly compressedPrefixHead: string;
  readonly compressedRetiredLaneFilter: string;
  readonly dischargedTombstones: readonly MarketBaseResourceLaneTombstoneDischarge[];
  readonly checkpointCommitment: string;
}

export interface MarketBaseResourcePermitChainState {
  readonly schemaVersion: 3;
  readonly hashRevision: typeof MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION;
  readonly currentPermitEpoch: number;
  readonly currentPermitId: string;
  readonly permitChainHead: string;
  readonly permitEpochHighWater: number;
  readonly permitChainHeadHighWater: string;
  readonly totalChainLength: number;
  readonly retainedPermits: readonly MarketBaseResourceRetainedPermitRecord[];
  readonly prefixCheckpoint: MarketBaseResourcePermitPrefixCheckpoint;
  readonly laneTombstoneCheckpoint: MarketBaseResourceLaneTombstoneCheckpoint;
  readonly v2EventCutoverCheckpoint?: MarketBaseResourceV2EventCutoverCheckpoint;
  readonly legacyV2GrantSuspended: boolean;
  readonly blocker?: MarketBaseResourcePermitBlocker;
}

type LaneTombstoneDischargeWithoutFingerprint = Omit<
  MarketBaseResourceLaneTombstoneDischarge,
  "dischargeFingerprint"
>;

const MARKET_BASE_RESOURCE_LANE_TOMBSTONE_FILTER_BITS = 8_192;
const MARKET_BASE_RESOURCE_LANE_TOMBSTONE_FILTER_HEX_LENGTH =
  MARKET_BASE_RESOURCE_LANE_TOMBSTONE_FILTER_BITS / 4;
const MARKET_BASE_RESOURCE_EMPTY_LANE_TOMBSTONE_FILTER = "0".repeat(
  MARKET_BASE_RESOURCE_LANE_TOMBSTONE_FILTER_HEX_LENGTH,
);
const MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE = canonicalStableHashV1(
  "market-base-resource:no-compressed-lane-tombstone-v1",
);

function laneTombstoneDischargeFingerprint(
  discharge: LaneTombstoneDischargeWithoutFingerprint,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:lane-tombstone-discharge-v1",
    discharge,
  });
}

interface LaneTombstonePrefixState {
  readonly compressedCount: number;
  readonly compressedFirstDischargeFingerprint: string;
  readonly compressedLastDischargeFingerprint: string;
  readonly compressedPrefixHead: string;
  readonly compressedRetiredLaneFilter: string;
}

function laneTombstoneCheckpointPayload(
  prefix: LaneTombstonePrefixState,
  dischargedTombstones: readonly MarketBaseResourceLaneTombstoneDischarge[],
): unknown {
  return {
    schemaVersion: 3,
    hashRevision: "market-base-resource-lane-tombstones-v1",
    ...prefix,
    dischargedTombstones,
  };
}

function buildLaneTombstoneCheckpoint(
  dischargedTombstones: readonly MarketBaseResourceLaneTombstoneDischarge[],
  prefix: LaneTombstonePrefixState = {
    compressedCount: 0,
    compressedFirstDischargeFingerprint:
      MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE,
    compressedLastDischargeFingerprint:
      MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE,
    compressedPrefixHead: MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE,
    compressedRetiredLaneFilter:
      MARKET_BASE_RESOURCE_EMPTY_LANE_TOMBSTONE_FILTER,
  },
): MarketBaseResourceLaneTombstoneCheckpoint {
  const sorted = [...dischargedTombstones]
    .map((entry) => clone(entry))
    .sort((left, right) => left.laneId.localeCompare(right.laneId));
  return deepFreeze({
    schemaVersion: 3 as const,
    hashRevision: "market-base-resource-lane-tombstones-v1" as const,
    ...prefix,
    dischargedTombstones: sorted,
    checkpointCommitment: canonicalStableHashV1(
      laneTombstoneCheckpointPayload(prefix, sorted),
    ),
  }) as MarketBaseResourceLaneTombstoneCheckpoint;
}

function laneTombstoneFilterIndexes(laneId: string): readonly number[] {
  const hash = canonicalStableHashV1({
    domain: "market-base-resource:retired-lane-filter-v1",
    laneId,
  }).slice("csh1:".length);
  return [0, 8, 16, 24].map(
    (offset) =>
      Number.parseInt(hash.slice(offset, offset + 8), 16) %
      MARKET_BASE_RESOURCE_LANE_TOMBSTONE_FILTER_BITS,
  );
}

function updateLaneTombstoneFilter(filter: string, laneId: string): string {
  const nibbles = filter.split("");
  for (const bitIndex of laneTombstoneFilterIndexes(laneId)) {
    const nibbleIndex = Math.floor(bitIndex / 4);
    const bit = bitIndex % 4;
    nibbles[nibbleIndex] = (
      Number.parseInt(nibbles[nibbleIndex], 16) |
      (1 << bit)
    ).toString(16);
  }
  return nibbles.join("");
}

function foldCompressedLaneTombstone(
  prefix: LaneTombstonePrefixState,
  discharge: MarketBaseResourceLaneTombstoneDischarge,
): LaneTombstonePrefixState {
  const compressedCount = prefix.compressedCount + 1;
  return {
    compressedCount,
    compressedFirstDischargeFingerprint:
      prefix.compressedCount === 0
        ? discharge.dischargeFingerprint
        : prefix.compressedFirstDischargeFingerprint,
    compressedLastDischargeFingerprint: discharge.dischargeFingerprint,
    compressedPrefixHead: canonicalStableHashV1({
      domain: "market-base-resource:lane-tombstone-prefix-link-v1",
      compressedCount,
      dischargeFingerprint: discharge.dischargeFingerprint,
      laneId: discharge.laneId,
      previousPrefixHead: prefix.compressedPrefixHead,
    }),
    compressedRetiredLaneFilter: updateLaneTombstoneFilter(
      prefix.compressedRetiredLaneFilter,
      discharge.laneId,
    ),
  };
}

function validLaneTombstoneDischarge(
  raw: unknown,
): raw is MarketBaseResourceLaneTombstoneDischarge {
  if (
    !isPlainRecord(raw) ||
    !exactKeys(raw, [
      "dischargeFingerprint",
      "dischargedAtEpoch",
      "dischargedByPermitId",
      "laneId",
      "laneStableFingerprint",
      "resource",
      "resourcePolicyFingerprint",
      "resourcePolicyId",
      "roomFingerprint",
      "roomInstanceId",
      "sellerRoom",
      "sharedPolicyFingerprint",
      "tombstonedGrantFingerprint",
    ]) ||
    !isDigest(raw.laneId) ||
    !MARKET_BASE_RESOURCE_CATALOG.includes(
      raw.resource as MarketBaseResource,
    ) ||
    typeof raw.resourcePolicyId !== "string" ||
    raw.resourcePolicyId.length === 0 ||
    !isDigest(raw.resourcePolicyFingerprint) ||
    !isDigest(raw.roomInstanceId) ||
    typeof raw.sellerRoom !== "string" ||
    raw.sellerRoom.length === 0 ||
    !isDigest(raw.roomFingerprint) ||
    !isDigest(raw.sharedPolicyFingerprint) ||
    !isDigest(raw.laneStableFingerprint) ||
    !isDigest(raw.tombstonedGrantFingerprint) ||
    !isPositiveSafeInteger(raw.dischargedAtEpoch) ||
    !isDigest(raw.dischargedByPermitId) ||
    !isDigest(raw.dischargeFingerprint)
  ) {
    return false;
  }
  const { dischargeFingerprint: _dischargeFingerprint, ...payload } = raw;
  return (
    raw.dischargeFingerprint ===
    laneTombstoneDischargeFingerprint(
      payload as LaneTombstoneDischargeWithoutFingerprint,
    )
  );
}

function validLaneTombstoneCheckpoint(
  checkpoint: unknown,
): checkpoint is MarketBaseResourceLaneTombstoneCheckpoint {
  if (
    !isPlainRecord(checkpoint) ||
    !exactKeys(checkpoint, [
      "checkpointCommitment",
      "compressedCount",
      "compressedFirstDischargeFingerprint",
      "compressedLastDischargeFingerprint",
      "compressedPrefixHead",
      "compressedRetiredLaneFilter",
      "dischargedTombstones",
      "hashRevision",
      "schemaVersion",
    ]) ||
    checkpoint.schemaVersion !== 3 ||
    checkpoint.hashRevision !== "market-base-resource-lane-tombstones-v1" ||
    !isSafeTick(checkpoint.compressedCount) ||
    !isDigest(checkpoint.compressedFirstDischargeFingerprint) ||
    !isDigest(checkpoint.compressedLastDischargeFingerprint) ||
    !isDigest(checkpoint.compressedPrefixHead) ||
    typeof checkpoint.compressedRetiredLaneFilter !== "string" ||
    checkpoint.compressedRetiredLaneFilter.length !==
      MARKET_BASE_RESOURCE_LANE_TOMBSTONE_FILTER_HEX_LENGTH ||
    !/^[0-9a-f]+$/.test(checkpoint.compressedRetiredLaneFilter) ||
    !Array.isArray(checkpoint.dischargedTombstones) ||
    checkpoint.dischargedTombstones.length >
      MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES ||
    !isDigest(checkpoint.checkpointCommitment)
  ) {
    return false;
  }
  if (
    checkpoint.compressedCount === 0
      ? checkpoint.compressedFirstDischargeFingerprint !==
          MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE ||
        checkpoint.compressedLastDischargeFingerprint !==
          MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE ||
        checkpoint.compressedPrefixHead !==
          MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE ||
        checkpoint.compressedRetiredLaneFilter !==
          MARKET_BASE_RESOURCE_EMPTY_LANE_TOMBSTONE_FILTER
      : checkpoint.compressedFirstDischargeFingerprint ===
          MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE ||
        checkpoint.compressedLastDischargeFingerprint ===
          MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE ||
        checkpoint.compressedPrefixHead ===
          MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE
  ) {
    return false;
  }
  let previousLaneId = "";
  for (const raw of checkpoint.dischargedTombstones) {
    if (
      !validLaneTombstoneDischarge(raw) ||
      raw.laneId <= previousLaneId ||
      previousLaneId === raw.laneId
    ) {
      return false;
    }
    previousLaneId = raw.laneId;
  }
  return (
    checkpoint.checkpointCommitment ===
    canonicalStableHashV1(
      laneTombstoneCheckpointPayload(
        {
          compressedCount: checkpoint.compressedCount,
          compressedFirstDischargeFingerprint:
            checkpoint.compressedFirstDischargeFingerprint,
          compressedLastDischargeFingerprint:
            checkpoint.compressedLastDischargeFingerprint,
          compressedPrefixHead: checkpoint.compressedPrefixHead,
          compressedRetiredLaneFilter: checkpoint.compressedRetiredLaneFilter,
        },
        checkpoint.dischargedTombstones as readonly MarketBaseResourceLaneTombstoneDischarge[],
      ),
    )
  );
}

/**
 * 离线审计用纯函数：按 runtime 相同规则折叠完整 discharge 历史，证明
 * checkpoint 的有界性。返回值不能作为 lane admission/复活拒绝的授权依据；
 * 超出最近精确窗口的历史归属仍由外层 anchored scope/registry 判定。
 */
export function compactMarketBaseResourceLaneTombstonesForAudit(
  discharges: readonly MarketBaseResourceLaneTombstoneDischarge[],
): MarketBaseResourceLaneTombstoneCheckpoint {
  if (!Array.isArray(discharges) || !Number.isSafeInteger(discharges.length)) {
    throw new Error("invalid lane tombstone discharge audit batch");
  }
  const seenLaneIds = new Set<string>();
  for (const discharge of discharges) {
    if (
      !validLaneTombstoneDischarge(discharge) ||
      seenLaneIds.has(discharge.laneId)
    ) {
      throw new Error("invalid lane tombstone discharge audit batch");
    }
    seenLaneIds.add(discharge.laneId);
  }
  const chronological = [...discharges].sort(
    (left, right) =>
      left.dischargedAtEpoch - right.dischargedAtEpoch ||
      left.laneId.localeCompare(right.laneId),
  );
  const compressedCount = Math.max(
    0,
    chronological.length - MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES,
  );
  let prefix: LaneTombstonePrefixState = {
    compressedCount: 0,
    compressedFirstDischargeFingerprint:
      MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE,
    compressedLastDischargeFingerprint:
      MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE,
    compressedPrefixHead: MARKET_BASE_RESOURCE_NO_COMPRESSED_LANE_TOMBSTONE,
    compressedRetiredLaneFilter:
      MARKET_BASE_RESOURCE_EMPTY_LANE_TOMBSTONE_FILTER,
  };
  for (const discharge of chronological.slice(0, compressedCount)) {
    prefix = foldCompressedLaneTombstone(prefix, discharge);
  }
  const checkpoint = buildLaneTombstoneCheckpoint(
    chronological.slice(compressedCount),
    prefix,
  );
  if (!validLaneTombstoneCheckpoint(checkpoint)) {
    throw new Error("invalid compacted lane tombstone audit checkpoint");
  }
  return checkpoint;
}

function recordEpoch(record: MarketBaseResourceRetainedPermitRecord): number {
  return record.epoch;
}

function recordId(record: MarketBaseResourceRetainedPermitRecord): string {
  return record.permitId;
}

function recordHead(record: MarketBaseResourceRetainedPermitRecord): string {
  return record.permitHead;
}

function recordPreviousId(
  record: MarketBaseResourceRetainedPermitRecord,
): string {
  return record.previousPermitId;
}

function recordPreviousHead(
  record: MarketBaseResourceRetainedPermitRecord,
): string {
  return record.previousPermitHead;
}

function recordBinding(
  record: MarketBaseResourceRetainedPermitRecord,
): MarketBaseResourcePermitBinding {
  if (record.schemaVersion === 2) {
    return {
      permitId: record.permitId,
      epoch: record.epoch,
      selfHash: record.opaqueSelfHash,
      grantDigest: record.grantDigest,
      reviewDigest: record.reviewDigest,
    };
  }
  return {
    permitId: record.permitId,
    epoch: record.epoch,
    selfHash: record.selfHash,
    grantDigest: canonicalStableHashV1({
      domain: "market-base-resource:permit-grants-v1",
      grants: record.signedLaneGrants,
    }),
    reviewDigest: canonicalStableHashV1({
      domain: "market-base-resource:permit-review-v1",
      evidence: record.reviewedEvidence,
    }),
  };
}

function emptyPrefixCheckpoint(
  genesisHead: string,
): MarketBaseResourcePermitPrefixCheckpoint {
  const ratchetHighWater = buildMarketBaseResourceBootstrapRatchetHighWater(0);
  const payload = {
    schemaVersion: 3 as const,
    hashRevision: "market-base-resource-permit-prefix-v1" as const,
    prunedThroughEpoch: 0,
    firstPrunedPermitId: "",
    firstPrunedPreviousPermitHead: genesisHead,
    lastPrunedPermitId: "",
    lastPrunedPermitHead: genesisHead,
    v2CutoverCheckpointHash: MARKET_BASE_RESOURCE_NO_CUTOVER_CHECKPOINT_HASH,
    ratchetPermitEpoch: 0,
    ratchetHighWater,
    ratchetHighWaterCommitment: ratchetHighWaterCommitment(ratchetHighWater),
    referencedPermitBindings: [] as MarketBaseResourcePermitBinding[],
  };
  return {
    ...payload,
    prefixCommitment: canonicalStableHashV1({
      domain: "market-base-resource:permit-prefix-v1",
      payload,
    }),
  };
}

function prefixPayload(
  checkpoint: Omit<
    MarketBaseResourcePermitPrefixCheckpoint,
    "prefixCommitment"
  >,
): unknown {
  return {
    domain: "market-base-resource:permit-prefix-v1",
    payload: checkpoint,
  };
}

function validBinding(
  binding: unknown,
): binding is MarketBaseResourcePermitBinding {
  return (
    isPlainRecord(binding) &&
    exactKeys(binding, [
      "epoch",
      "grantDigest",
      "permitId",
      "reviewDigest",
      "selfHash",
    ]) &&
    isDigest(binding.permitId) &&
    isPositiveSafeInteger(binding.epoch) &&
    isDigest(binding.selfHash) &&
    isDigest(binding.grantDigest) &&
    isDigest(binding.reviewDigest)
  );
}

function validPrefixCheckpoint(
  checkpoint: unknown,
): checkpoint is MarketBaseResourcePermitPrefixCheckpoint {
  if (!isPlainRecord(checkpoint)) return false;
  if (
    !exactKeys(checkpoint, [
      "firstPrunedPermitId",
      "firstPrunedPreviousPermitHead",
      "hashRevision",
      "lastPrunedPermitHead",
      "lastPrunedPermitId",
      "prefixCommitment",
      "prunedThroughEpoch",
      "ratchetHighWater",
      "ratchetHighWaterCommitment",
      "ratchetPermitEpoch",
      "referencedPermitBindings",
      "schemaVersion",
      "v2CutoverCheckpointHash",
    ]) ||
    checkpoint.schemaVersion !== 3 ||
    checkpoint.hashRevision !== "market-base-resource-permit-prefix-v1" ||
    !isSafeTick(checkpoint.prunedThroughEpoch) ||
    !Array.isArray(checkpoint.referencedPermitBindings) ||
    checkpoint.referencedPermitBindings.length >
      MARKET_BASE_RESOURCE_REFERENCED_BINDING_LIMIT ||
    !checkpoint.referencedPermitBindings.every(validBinding) ||
    new Set(
      checkpoint.referencedPermitBindings.map((binding) => binding.permitId),
    ).size !== checkpoint.referencedPermitBindings.length ||
    !isDigest(checkpoint.firstPrunedPreviousPermitHead) ||
    !isDigest(checkpoint.lastPrunedPermitHead) ||
    !isDigest(checkpoint.v2CutoverCheckpointHash) ||
    !isSafeTick(checkpoint.ratchetPermitEpoch) ||
    checkpoint.ratchetPermitEpoch > checkpoint.prunedThroughEpoch ||
    !Array.isArray(checkpoint.ratchetHighWater) ||
    !validateMarketBaseResourceRatchetHighWater(checkpoint.ratchetHighWater) ||
    !isDigest(checkpoint.ratchetHighWaterCommitment) ||
    checkpoint.ratchetHighWaterCommitment !==
      ratchetHighWaterCommitment(checkpoint.ratchetHighWater) ||
    !isDigest(checkpoint.prefixCommitment)
  ) {
    return false;
  }
  if (checkpoint.prunedThroughEpoch === 0) {
    if (
      checkpoint.firstPrunedPermitId !== "" ||
      checkpoint.lastPrunedPermitId !== "" ||
      checkpoint.referencedPermitBindings.length !== 0 ||
      checkpoint.ratchetPermitEpoch !== 0
    ) {
      return false;
    }
  } else if (
    !isDigest(checkpoint.firstPrunedPermitId) ||
    !isDigest(checkpoint.lastPrunedPermitId)
  ) {
    return false;
  }
  const { prefixCommitment: _prefixCommitment, ...payload } =
    checkpoint as unknown as MarketBaseResourcePermitPrefixCheckpoint;
  return (
    checkpoint.prefixCommitment ===
    canonicalStableHashV1(prefixPayload(payload))
  );
}

function validV3PermitSelfIdentity(permit: MarketBaseResourcePermit): boolean {
  if (
    !isPlainRecord(permit) ||
    !exactKeys(
      permit,
      [
        "accountIdentity",
        "capability",
        "createdAt",
        "epoch",
        "executorShard",
        "hashRevision",
        "operatorAuthorizationFingerprint",
        "permitHead",
        "permitId",
        "previousLedgerHead",
        "previousPermitHead",
        "previousPermitId",
        "ratchetHighWater",
        "resourcePolicies",
        "reviewedEvidence",
        "schemaVersion",
        "selfHash",
        "sharedPolicy",
        "signedLaneGrants",
      ],
      ["legacyV2GrantSuspension", "v2EventCutoverCheckpoint"],
    ) ||
    permit.schemaVersion !== 3 ||
    permit.capability !== MARKET_BASE_RESOURCE_PERMIT_CAPABILITY ||
    permit.hashRevision !== MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION ||
    permit.executorShard !== "shard1"
  ) {
    return false;
  }
  const { permitId, selfHash, permitHead, ...payload } = permit;
  const expectedSelfHash = permitSelfHash(payload);
  return (
    selfHash === expectedSelfHash &&
    permitId === permitIdFor(permit.epoch, expectedSelfHash) &&
    permitHead ===
      permitHeadFor(permit.previousPermitHead, permitId, expectedSelfHash) &&
    selfConsistentResourcePolicies(
      permit.sharedPolicy,
      permit.resourcePolicies,
    ) &&
    validateMarketBaseResourceRatchetHighWater(permit.ratchetHighWater) &&
    validateSignedLaneGrants(
      permit.signedLaneGrants,
      permit.sharedPolicy,
      permit.resourcePolicies,
    ) &&
    validateReviewedEvidence(permit.reviewedEvidence, permit.signedLaneGrants)
  );
}

function validRetainedRecord(
  record: MarketBaseResourceRetainedPermitRecord,
): boolean {
  if (record.schemaVersion === 2) {
    return (
      isPlainRecord(record) &&
      exactKeys(record, [
        "authenticated",
        "epoch",
        "grantDigest",
        "opaqueSelfHash",
        "permitHead",
        "permitId",
        "previousPermitHead",
        "previousPermitId",
        "rawRecord",
        "rawRecordCommitment",
        "recordVersion",
        "reviewDigest",
        "schemaVersion",
      ]) &&
      record.recordVersion === "legacy-v2-opaque" &&
      record.authenticated === true &&
      isPositiveSafeInteger(record.epoch) &&
      isDigest(record.permitId) &&
      isDigest(record.permitHead) &&
      (record.previousPermitId === "" || isDigest(record.previousPermitId)) &&
      isDigest(record.previousPermitHead) &&
      isDigest(record.opaqueSelfHash) &&
      validateFrozenLegacyV2PermitRaw(record.rawRecord) &&
      record.rawRecordCommitment ===
        frozenLegacyV2RawCommitment(record.rawRecord) &&
      record.opaqueSelfHash ===
        canonicalStableHashV1({
          domain: "market-base-resource:legacy-v2-opaque-self-v1",
          rawRecordCommitment: record.rawRecordCommitment,
        }) &&
      record.epoch === record.rawRecord.epoch &&
      record.permitId === record.rawRecord.permitId &&
      record.permitHead === record.rawRecord.permitHead &&
      record.previousPermitId === record.rawRecord.previousPermitId &&
      record.previousPermitHead === record.rawRecord.previousPermitHead &&
      record.grantDigest === frozenLegacyV2GrantDigest(record.rawRecord) &&
      record.reviewDigest === frozenLegacyV2ReviewDigest(record.rawRecord) &&
      isDigest(record.grantDigest) &&
      isDigest(record.reviewDigest)
    );
  }
  return validV3PermitSelfIdentity(record);
}

export interface MarketBaseResourcePermitChainValidation {
  readonly ok: boolean;
  readonly reason?: string;
}

function validateMarketBaseResourcePermitChainUncached(
  state: MarketBaseResourcePermitChainState,
  highWaterCheckpoint?: {
    readonly permitEpochHighWater: number;
    readonly permitChainHeadHighWater: string;
    readonly totalChainLength: number;
    readonly prefixCommitment: string;
    readonly laneTombstoneCheckpointCommitment?: string;
  },
): MarketBaseResourcePermitChainValidation {
  if (state.blocker) {
    return { ok: false, reason: state.blocker.code };
  }
  if (
    state.schemaVersion !== 3 ||
    state.hashRevision !== MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION ||
    !isSafeTick(state.currentPermitEpoch) ||
    state.currentPermitEpoch !== state.permitEpochHighWater ||
    state.permitEpochHighWater !== state.totalChainLength ||
    state.retainedPermits.length !==
      Math.min(
        MARKET_BASE_RESOURCE_PERMIT_SUFFIX_LIMIT,
        state.totalChainLength,
      ) ||
    state.prefixCheckpoint.prunedThroughEpoch + state.retainedPermits.length !==
      state.totalChainLength ||
    !validPrefixCheckpoint(state.prefixCheckpoint) ||
    !validLaneTombstoneCheckpoint(state.laneTombstoneCheckpoint) ||
    !isDigest(state.permitChainHead) ||
    state.permitChainHead !== state.permitChainHeadHighWater ||
    (state.currentPermitId !== "" && !isDigest(state.currentPermitId))
  ) {
    return { ok: false, reason: "permit_chain_shape_invalid" };
  }
  if (
    highWaterCheckpoint &&
    (highWaterCheckpoint.permitEpochHighWater !== state.permitEpochHighWater ||
      highWaterCheckpoint.permitChainHeadHighWater !==
        state.permitChainHeadHighWater ||
      highWaterCheckpoint.totalChainLength !== state.totalChainLength ||
      highWaterCheckpoint.prefixCommitment !==
        state.prefixCheckpoint.prefixCommitment ||
      (highWaterCheckpoint.laneTombstoneCheckpointCommitment !== undefined &&
        highWaterCheckpoint.laneTombstoneCheckpointCommitment !==
          state.laneTombstoneCheckpoint.checkpointCommitment))
  ) {
    return { ok: false, reason: "permit_high_water_rollback" };
  }
  let previousId =
    state.prefixCheckpoint.prunedThroughEpoch > 0
      ? state.prefixCheckpoint.lastPrunedPermitId
      : "";
  let previousHead = state.prefixCheckpoint.lastPrunedPermitHead;
  let expectedEpoch = state.prefixCheckpoint.prunedThroughEpoch + 1;
  let priorRatchetHighWater:
    readonly MarketBaseResourceRatchetHighWater[] | undefined =
    state.prefixCheckpoint.ratchetPermitEpoch > 0
      ? state.prefixCheckpoint.ratchetHighWater
      : undefined;
  for (const record of state.retainedPermits) {
    if (
      !validRetainedRecord(record) ||
      recordEpoch(record) !== expectedEpoch ||
      recordPreviousId(record) !== previousId ||
      recordPreviousHead(record) !== previousHead
    ) {
      return { ok: false, reason: "permit_suffix_invalid" };
    }
    if (record.schemaVersion === 3) {
      const ratchetError = validateRatchetTransition(
        priorRatchetHighWater,
        record.ratchetHighWater,
      );
      if (ratchetError) {
        return { ok: false, reason: ratchetError };
      }
      priorRatchetHighWater = record.ratchetHighWater;
    }
    previousId = recordId(record);
    previousHead = recordHead(record);
    expectedEpoch += 1;
  }
  if (
    state.totalChainLength === 0
      ? state.currentPermitId !== "" ||
        state.permitChainHead !== state.prefixCheckpoint.lastPrunedPermitHead
      : state.currentPermitId !== previousId ||
        state.permitChainHead !== previousHead
  ) {
    return { ok: false, reason: "permit_tip_invalid" };
  }
  const firstV3Index = state.retainedPermits.findIndex(
    (record) => record.schemaVersion === 3,
  );
  if (
    firstV3Index >= 0 &&
    state.retainedPermits
      .slice(firstV3Index)
      .some((record) => record.schemaVersion !== 3)
  ) {
    return { ok: false, reason: "permit_mixed_version_gap" };
  }
  if (
    state.v2EventCutoverCheckpoint !== undefined &&
    !validateMarketBaseResourceV2EventCutoverCheckpoint(
      state.v2EventCutoverCheckpoint,
    )
  ) {
    return { ok: false, reason: "permit_cutover_invalid" };
  }
  const firstRetainedV3 = state.retainedPermits.find(
    (record): record is MarketBaseResourcePermit => record.schemaVersion === 3,
  );
  if (
    firstRetainedV3?.v2EventCutoverCheckpoint &&
    (!state.v2EventCutoverCheckpoint ||
      !sameCanonical(
        firstRetainedV3.v2EventCutoverCheckpoint,
        state.v2EventCutoverCheckpoint,
      ))
  ) {
    return { ok: false, reason: "permit_cutover_state_mismatch" };
  }
  if (
    state.prefixCheckpoint.prunedThroughEpoch > 0 &&
    state.v2EventCutoverCheckpoint &&
    state.prefixCheckpoint.v2CutoverCheckpointHash !==
      state.v2EventCutoverCheckpoint.checkpointHash
  ) {
    return {
      ok: false,
      reason: "permit_cutover_prefix_commitment_mismatch",
    };
  }
  const hasV3 =
    state.retainedPermits.some((record) => record.schemaVersion === 3) ||
    (state.prefixCheckpoint.prunedThroughEpoch > 0 &&
      state.legacyV2GrantSuspended);
  if (
    hasV3 &&
    (!state.v2EventCutoverCheckpoint || state.legacyV2GrantSuspended !== true)
  ) {
    return { ok: false, reason: "permit_cutover_incomplete" };
  }
  const currentV3 = state.retainedPermits[state.retainedPermits.length - 1];
  if (currentV3?.schemaVersion === 3) {
    const fullTombstones = currentV3.signedLaneGrants.filter(
      (grant) => grant.status === "tombstoned",
    );
    const discharged = state.laneTombstoneCheckpoint.dischargedTombstones;
    const retiredIds = new Set(discharged.map((entry) => entry.laneId));
    if (
      fullTombstones.length + discharged.length >
        MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES ||
      fullTombstones.some((grant) => retiredIds.has(grant.laneId)) ||
      currentV3.signedLaneGrants.some(
        (grant) => grant.status === "active" && retiredIds.has(grant.laneId),
      ) ||
      discharged.some(
        (entry) => entry.dischargedAtEpoch > state.permitEpochHighWater,
      )
    ) {
      return { ok: false, reason: "lane_tombstone_checkpoint_invalid" };
    }
  }
  return { ok: true };
}

const permitChainValidationCache = new WeakMap<
  MarketBaseResourcePermitChainState,
  MarketBaseResourcePermitChainValidation
>();

export function isMarketBaseResourcePermitDeepFrozen(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    permitDeepFrozenValues.has(value)
  );
}

/**
 * Canonical builders 返回递归 frozen 的不可变 chain；同一 runtime object 的
 * 重复 reader/plan 校验可安全复用首次完整结果。来自 Memory reset 的普通
 * mutable object 仍每次完整重验，任何 nested bit flip 都不会命中缓存。
 */
export function validateMarketBaseResourcePermitChain(
  state: MarketBaseResourcePermitChainState,
  highWaterCheckpoint?: {
    readonly permitEpochHighWater: number;
    readonly permitChainHeadHighWater: string;
    readonly totalChainLength: number;
    readonly prefixCommitment: string;
    readonly laneTombstoneCheckpointCommitment?: string;
  },
): MarketBaseResourcePermitChainValidation {
  if (highWaterCheckpoint === undefined && permitDeepFrozenValues.has(state)) {
    const cached = permitChainValidationCache.get(state);
    if (cached) return cached;
    const validation = validateMarketBaseResourcePermitChainUncached(state);
    permitChainValidationCache.set(state, validation);
    return validation;
  }
  return validateMarketBaseResourcePermitChainUncached(
    state,
    highWaterCheckpoint,
  );
}

export interface MarketBaseResourcePermitRuntimeAnchor {
  readonly schemaVersion: 3;
  readonly hashRevision: "market-base-resource-permit-runtime-anchor-v2";
  readonly permitEpochHighWater: number;
  readonly currentPermitId: string;
  readonly permitChainHeadHighWater: string;
  readonly totalChainLength: number;
  readonly currentPermitSelfHash: string;
  readonly currentAuthorityCommitment: string;
  readonly prefixCommitment: string;
  readonly laneTombstoneCheckpointCommitment: string;
  readonly v2CutoverCheckpointHash: string;
  readonly ratchetHighWaterCommitment: string;
  readonly anchorCommitment: string;
}

function permitRuntimeAnchorCommitment(
  anchor: Omit<MarketBaseResourcePermitRuntimeAnchor, "anchorCommitment">,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:permit-runtime-anchor-v2",
    anchor,
  });
}

function currentPermitRuntimeAuthorityCommitment(
  value: unknown,
): string | undefined {
  try {
    if (
      !isPlainRecord(value) ||
      !exactKeys(
        value,
        [
          "accountIdentity",
          "capability",
          "createdAt",
          "epoch",
          "executorShard",
          "hashRevision",
          "operatorAuthorizationFingerprint",
          "permitHead",
          "permitId",
          "previousLedgerHead",
          "previousPermitHead",
          "previousPermitId",
          "ratchetHighWater",
          "resourcePolicies",
          "reviewedEvidence",
          "schemaVersion",
          "selfHash",
          "sharedPolicy",
          "signedLaneGrants",
        ],
        ["legacyV2GrantSuspension", "v2EventCutoverCheckpoint"],
      )
    ) {
      return undefined;
    }
    const permit = value as unknown as MarketBaseResourcePermit;
    if (
      permit.schemaVersion !== 3 ||
      permit.capability !== MARKET_BASE_RESOURCE_PERMIT_CAPABILITY ||
      permit.hashRevision !== MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION ||
      permit.executorShard !== "shard1" ||
      !isPositiveSafeInteger(permit.epoch) ||
      !isSafeTick(permit.createdAt) ||
      typeof permit.accountIdentity !== "string" ||
      permit.accountIdentity.length === 0 ||
      permit.accountIdentity.length > 128 ||
      !isDigest(permit.permitId) ||
      !isDigest(permit.selfHash) ||
      !isDigest(permit.permitHead) ||
      (permit.previousPermitId !== "" && !isDigest(permit.previousPermitId)) ||
      !isDigest(permit.previousPermitHead) ||
      !isDigest(permit.previousLedgerHead) ||
      !isDigest(permit.operatorAuthorizationFingerprint) ||
      !isPlainRecord(permit.sharedPolicy) ||
      !isDigest(permit.sharedPolicy.fingerprint) ||
      !Array.isArray(permit.resourcePolicies) ||
      !selfConsistentResourcePolicies(
        permit.sharedPolicy,
        permit.resourcePolicies,
      ) ||
      !Array.isArray(permit.ratchetHighWater) ||
      !validateMarketBaseResourceRatchetHighWater(permit.ratchetHighWater) ||
      !Array.isArray(permit.signedLaneGrants) ||
      permit.signedLaneGrants.length >
        MARKET_BASE_RESOURCE_MAX_LANES +
          MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES ||
      !Array.isArray(permit.reviewedEvidence) ||
      permit.reviewedEvidence.length >
        MARKET_BASE_RESOURCE_ACTIVE_REVIEW_REFERENCE_LIMIT
    ) {
      return undefined;
    }
    const policyById = new Map(
      permit.resourcePolicies.map((policy) => [policy.policyId, policy]),
    );
    const enabled: MarketBaseResourceSignedLaneGrant[] = [];
    for (const candidate of permit.signedLaneGrants as readonly unknown[]) {
      if (
        !isPlainRecord(candidate) ||
        (candidate.newDealGrant !== "enabled" &&
          candidate.newDealGrant !== "suspended")
      ) {
        return undefined;
      }
      if (candidate.newDealGrant !== "enabled") continue;
      const grant = candidate as unknown as MarketBaseResourceSignedLaneGrant;
      const policy = policyById.get(grant.resourcePolicyId);
      const { grantFingerprint: _grantFingerprint, ...payload } = grant;
      if (
        enabled.length >= MARKET_BASE_RESOURCE_MAX_LANES ||
        !isDigest(grant.laneId) ||
        !isDigest(grant.roomInstanceId) ||
        !isDigest(grant.roomFingerprint) ||
        !isDigest(grant.laneStableFingerprint) ||
        !isDigest(grant.lifecycleEvidenceDigest) ||
        !isDigest(grant.reviewDigest) ||
        !isDigest(grant.grantFingerprint) ||
        grant.sharedPolicyFingerprint !== permit.sharedPolicy.fingerprint ||
        typeof grant.sellerRoom !== "string" ||
        grant.sellerRoom.length === 0 ||
        grant.status !== "active" ||
        (grant.stage !== "canary" && grant.stage !== "continuous") ||
        !policy ||
        policy.resource !== grant.resource ||
        policy.fingerprint !== grant.resourcePolicyFingerprint ||
        grant.grantFingerprint !== signedLaneGrantFingerprint(payload)
      ) {
        return undefined;
      }
      enabled.push(grant);
    }
    if (
      new Set(enabled.map((grant) => grant.laneId)).size !== enabled.length ||
      enabled.filter((grant) => grant.stage === "canary").length > 1
    ) {
      return undefined;
    }
    return canonicalStableHashV1({
      domain: "market-base-resource:permit-runtime-authority-v1",
      authority: {
        accountIdentity: permit.accountIdentity,
        createdAt: permit.createdAt,
        enabledGrantFingerprints: enabled
          .map((grant) => grant.grantFingerprint)
          .sort(),
        epoch: permit.epoch,
        executorShard: permit.executorShard,
        operatorAuthorizationFingerprint:
          permit.operatorAuthorizationFingerprint,
        permitHead: permit.permitHead,
        permitId: permit.permitId,
        previousLedgerHead: permit.previousLedgerHead,
        previousPermitHead: permit.previousPermitHead,
        previousPermitId: permit.previousPermitId,
        ratchetHighWaterCommitment: ratchetHighWaterCommitment(
          permit.ratchetHighWater,
        ),
        resourcePolicyFingerprints: permit.resourcePolicies.map(
          (policy) => policy.fingerprint,
        ),
        selfHash: permit.selfHash,
        sharedPolicyFingerprint: permit.sharedPolicy.fingerprint,
      },
    });
  } catch {
    return undefined;
  }
}

function validPermitRuntimeAnchor(
  value: unknown,
): value is MarketBaseResourcePermitRuntimeAnchor {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      "anchorCommitment",
      "currentAuthorityCommitment",
      "currentPermitId",
      "currentPermitSelfHash",
      "hashRevision",
      "laneTombstoneCheckpointCommitment",
      "permitChainHeadHighWater",
      "permitEpochHighWater",
      "prefixCommitment",
      "ratchetHighWaterCommitment",
      "schemaVersion",
      "totalChainLength",
      "v2CutoverCheckpointHash",
    ]) ||
    value.schemaVersion !== 3 ||
    value.hashRevision !== "market-base-resource-permit-runtime-anchor-v2" ||
    !isPositiveSafeInteger(value.permitEpochHighWater) ||
    value.totalChainLength !== value.permitEpochHighWater ||
    !isDigest(value.currentPermitId) ||
    !isDigest(value.currentPermitSelfHash) ||
    !isDigest(value.currentAuthorityCommitment) ||
    !isDigest(value.permitChainHeadHighWater) ||
    !isDigest(value.prefixCommitment) ||
    !isDigest(value.laneTombstoneCheckpointCommitment) ||
    !isDigest(value.v2CutoverCheckpointHash) ||
    !isDigest(value.ratchetHighWaterCommitment) ||
    !isDigest(value.anchorCommitment)
  ) {
    return false;
  }
  const { anchorCommitment: _anchorCommitment, ...payload } =
    value as unknown as MarketBaseResourcePermitRuntimeAnchor;
  return value.anchorCommitment === permitRuntimeAnchorCommitment(payload);
}

export function buildMarketBaseResourcePermitRuntimeAnchor(
  state: MarketBaseResourcePermitChainState,
): MarketBaseResourcePermitRuntimeAnchor {
  const validation = validateMarketBaseResourcePermitChain(state);
  const current = state.retainedPermits[state.retainedPermits.length - 1];
  if (
    !validation.ok ||
    !current ||
    current.schemaVersion !== 3 ||
    !state.v2EventCutoverCheckpoint
  ) {
    throw new TypeError("invalid permit runtime anchor basis");
  }
  const payload = {
    schemaVersion: 3 as const,
    hashRevision: "market-base-resource-permit-runtime-anchor-v2" as const,
    permitEpochHighWater: state.permitEpochHighWater,
    currentPermitId: state.currentPermitId,
    permitChainHeadHighWater: state.permitChainHeadHighWater,
    totalChainLength: state.totalChainLength,
    currentPermitSelfHash: current.selfHash,
    currentAuthorityCommitment:
      currentPermitRuntimeAuthorityCommitment(current)!,
    prefixCommitment: state.prefixCheckpoint.prefixCommitment,
    laneTombstoneCheckpointCommitment:
      state.laneTombstoneCheckpoint.checkpointCommitment,
    v2CutoverCheckpointHash: state.v2EventCutoverCheckpoint.checkpointHash,
    ratchetHighWaterCommitment: ratchetHighWaterCommitment(
      current.ratchetHighWater,
    ),
  };
  return deepFreeze({
    ...payload,
    anchorCommitment: permitRuntimeAnchorCommitment(payload),
  }) as MarketBaseResourcePermitRuntimeAnchor;
}

/**
 * 每 tick write gate：历史 suffix/tombstone payload 由 outer anchor 承诺，
 * 此处重验 current permit 的可写权限投影及当前 tip。全部 grant 都扫描
 * newDealGrant，任何 suspended→enabled 都改变 authority commitment；只有
 * 最多 112 条 enabled grant 重算完整 fingerprint。暂停 grant 的非授权字段
 * 由 operator/full-chain audit 负责，不进入 25 CPU 成交前窗口。
 */
export function validateMarketBaseResourcePermitRuntimeGate(
  state: MarketBaseResourcePermitChainState,
  anchor: MarketBaseResourcePermitRuntimeAnchor,
): MarketBaseResourcePermitChainValidation {
  marketBaseResourcePermitRuntimeTestProbe?.("runtime_gate");
  try {
    if (
      !isPlainRecord(state) ||
      !validPermitRuntimeAnchor(anchor) ||
      state.blocker
    ) {
      return { ok: false, reason: "permit_runtime_anchor_invalid" };
    }
    const current = state.retainedPermits[state.retainedPermits.length - 1];
    const authorityCommitment =
      current?.schemaVersion === 3
        ? currentPermitRuntimeAuthorityCommitment(current)
        : undefined;
    if (
      !current ||
      current.schemaVersion !== 3 ||
      authorityCommitment === undefined ||
      authorityCommitment !== anchor.currentAuthorityCommitment ||
      state.currentPermitEpoch !== anchor.permitEpochHighWater ||
      state.permitEpochHighWater !== anchor.permitEpochHighWater ||
      state.totalChainLength !== anchor.totalChainLength ||
      state.currentPermitId !== anchor.currentPermitId ||
      state.permitChainHead !== anchor.permitChainHeadHighWater ||
      state.permitChainHeadHighWater !== anchor.permitChainHeadHighWater ||
      current.permitId !== anchor.currentPermitId ||
      current.permitHead !== anchor.permitChainHeadHighWater ||
      current.selfHash !== anchor.currentPermitSelfHash ||
      state.prefixCheckpoint.prefixCommitment !== anchor.prefixCommitment ||
      state.laneTombstoneCheckpoint.checkpointCommitment !==
        anchor.laneTombstoneCheckpointCommitment ||
      state.v2EventCutoverCheckpoint?.checkpointHash !==
        anchor.v2CutoverCheckpointHash ||
      ratchetHighWaterCommitment(current.ratchetHighWater) !==
        anchor.ratchetHighWaterCommitment
    ) {
      return { ok: false, reason: "permit_runtime_gate_mismatch" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "permit_runtime_gate_mismatch" };
  }
}

const MARKET_BASE_RESOURCE_PERMIT_RUNTIME_CONTEXT = Symbol(
  "market-base-resource-permit-runtime-context",
);
const marketBaseResourcePermitRuntimeContexts = new WeakSet<object>();

export interface MarketBaseResourcePermitRuntimeContext {
  readonly state: MarketBaseResourcePermitChainState;
  readonly anchor: MarketBaseResourcePermitRuntimeAnchor;
  readonly tick: number;
  readonly [MARKET_BASE_RESOURCE_PERMIT_RUNTIME_CONTEXT]: true;
}

export type MarketBaseResourcePermitRuntimeContextResult =
  | {
      readonly ok: true;
      readonly context: MarketBaseResourcePermitRuntimeContext;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * 每 tick 只从 exact runtime anchor 铸造一次 opaque read capability。
 * 私有 Symbol + WeakSet 使 Memory/JSON 对象不能冒充 validated context。
 */
export function createMarketBaseResourcePermitRuntimeContext(input: {
  readonly state: MarketBaseResourcePermitChainState;
  readonly anchor: MarketBaseResourcePermitRuntimeAnchor;
  readonly tick: number;
}): MarketBaseResourcePermitRuntimeContextResult {
  if (!isSafeTick(input.tick)) {
    return { ok: false, reason: "permit_runtime_context_tick_invalid" };
  }
  const gate = validateMarketBaseResourcePermitRuntimeGate(
    input.state,
    input.anchor,
  );
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason ?? "permit_runtime_context_gate_failed",
    };
  }
  const current =
    input.state.retainedPermits[input.state.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    return { ok: false, reason: "permit_runtime_current_missing" };
  }
  const context = Object.freeze({
    state: deepFreeze({
      ...input.state,
      retainedPermits: [clone(current)],
      prefixCheckpoint: clone(input.state.prefixCheckpoint),
      laneTombstoneCheckpoint: clone(input.state.laneTombstoneCheckpoint),
      v2EventCutoverCheckpoint: clone(input.state.v2EventCutoverCheckpoint),
    }) as MarketBaseResourcePermitChainState,
    anchor: deepFreeze(
      clone(input.anchor),
    ) as MarketBaseResourcePermitRuntimeAnchor,
    tick: input.tick,
    [MARKET_BASE_RESOURCE_PERMIT_RUNTIME_CONTEXT]: true as const,
  }) as MarketBaseResourcePermitRuntimeContext;
  marketBaseResourcePermitRuntimeContexts.add(context);
  return { ok: true, context };
}

function validMarketBaseResourcePermitRuntimeContext(
  context: MarketBaseResourcePermitRuntimeContext,
): boolean {
  return (
    marketBaseResourcePermitRuntimeContexts.has(context) &&
    context[MARKET_BASE_RESOURCE_PERMIT_RUNTIME_CONTEXT] === true &&
    Object.isFrozen(context) &&
    permitDeepFrozenValues.has(context.state) &&
    permitDeepFrozenValues.has(context.anchor) &&
    isSafeTick(context.tick)
  );
}

export function createMarketBaseResourcePermitChainState(input: {
  readonly legacyV2PermitRecords: readonly MarketBaseResourceLegacyV2OpaquePermitRecord[];
}): MarketBaseResourcePermitChainState {
  const records = [...input.legacyV2PermitRecords]
    .map((record) => clone(record))
    .sort((left, right) => left.epoch - right.epoch);
  if (
    records.length === 0 ||
    records.length > MARKET_BASE_RESOURCE_PERMIT_SUFFIX_LIMIT
  ) {
    throw new RangeError("legacy v2 permit suffix is empty or unbounded");
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const previous = records[index - 1];
    if (
      !validRetainedRecord(record) ||
      record.epoch !== index + 1 ||
      (previous &&
        (record.previousPermitId !== previous.permitId ||
          record.previousPermitHead !== previous.permitHead))
    ) {
      throw new TypeError("legacy v2 permit suffix is not continuous");
    }
  }
  const first = records[0];
  const tip = records[records.length - 1];
  const state: MarketBaseResourcePermitChainState = {
    schemaVersion: 3,
    hashRevision: MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION,
    currentPermitEpoch: tip.epoch,
    currentPermitId: tip.permitId,
    permitChainHead: tip.permitHead,
    permitEpochHighWater: tip.epoch,
    permitChainHeadHighWater: tip.permitHead,
    totalChainLength: records.length,
    retainedPermits: records,
    prefixCheckpoint: emptyPrefixCheckpoint(first.previousPermitHead),
    laneTombstoneCheckpoint: buildLaneTombstoneCheckpoint([]),
    legacyV2GrantSuspended: false,
  };
  const validation = validateMarketBaseResourcePermitChain(state);
  if (!validation.ok) {
    throw new TypeError(validation.reason ?? "invalid initial permit chain");
  }
  return deepFreeze(state) as MarketBaseResourcePermitChainState;
}

function stateWithBlocker(
  state: MarketBaseResourcePermitChainState,
  code: string,
  tick: number,
  detail: unknown,
): MarketBaseResourcePermitChainState {
  if (state.blocker) return state;
  return deepFreeze({
    ...clone(state),
    blocker: {
      code,
      detectedAt: tick,
      detailHash: canonicalStableHashV1({
        domain: "market-base-resource:permit-blocker-v1",
        code,
        detail,
      }),
    },
  }) as MarketBaseResourcePermitChainState;
}

function previousV3Permit(
  state: MarketBaseResourcePermitChainState,
): MarketBaseResourcePermit | undefined {
  for (let index = state.retainedPermits.length - 1; index >= 0; index -= 1) {
    const record = state.retainedPermits[index];
    if (record.schemaVersion === 3) return record;
  }
  return undefined;
}

function evidenceFor(
  permit: MarketBaseResourcePermit,
  laneId: string,
  kind: MarketBaseResourceReviewedEvidenceKind,
): MarketBaseResourceReviewedEvidence | undefined {
  return permit.reviewedEvidence.find(
    (entry) => entry.laneId === laneId && entry.kind === kind,
  );
}

function stableGrantIdentity(
  grant: MarketBaseResourceSignedLaneGrant,
): unknown {
  return {
    laneId: grant.laneId,
    resource: grant.resource,
    resourcePolicyId: grant.resourcePolicyId,
    resourcePolicyFingerprint: grant.resourcePolicyFingerprint,
    roomInstanceId: grant.roomInstanceId,
    sellerRoom: grant.sellerRoom,
    roomFingerprint: grant.roomFingerprint,
    sharedPolicyFingerprint: grant.sharedPolicyFingerprint,
    laneStableFingerprint: grant.laneStableFingerprint,
  };
}

function grantIdentityAndReviewWithoutDealGrant(
  grant: MarketBaseResourceSignedLaneGrant,
): unknown {
  const {
    grantFingerprint: _grantFingerprint,
    newDealGrant: _newDealGrant,
    ...stable
  } = grant;
  return stable;
}

function stageRank(stage: MarketBaseLaneStage): number {
  switch (stage) {
    case "shadow":
      return 0;
    case "qualified":
      return 1;
    case "canary":
      return 2;
    case "review_paused":
      return 3;
    case "continuous":
      return 4;
  }
}

/** 策略重签保留原 lane 状态；v3 显式放开数量帽时仍须保留执行安全参数。 */
function isPreservedPolicyMigrationGrant(
  prior: MarketBaseResourcePermit,
  next: MarketBaseResourcePermit,
  old: MarketBaseResourceSignedLaneGrant | undefined,
  grant: MarketBaseResourceSignedLaneGrant,
): boolean {
  if (
    !old ||
    prior.sharedPolicy.fingerprint === next.sharedPolicy.fingerprint ||
    old.status !== "active" || grant.status !== "active" ||
    old.stage !== grant.stage ||
    old.newDealGrant !== grant.newDealGrant ||
    !sameCanonical({
      laneId: old.laneId, resource: old.resource,
      resourcePolicyId: old.resourcePolicyId,
      roomInstanceId: old.roomInstanceId,
      sellerRoom: old.sellerRoom, roomFingerprint: old.roomFingerprint,
    }, {
      laneId: grant.laneId, resource: grant.resource,
      resourcePolicyId: grant.resourcePolicyId,
      roomInstanceId: grant.roomInstanceId,
      sellerRoom: grant.sellerRoom, roomFingerprint: grant.roomFingerprint,
    }) ||
    !sameCanonical({
      schemaVersion: prior.sharedPolicy.schemaVersion,
      catalogRevision: prior.sharedPolicy.catalogRevision,
      catalog: prior.sharedPolicy.catalog,
      energyDisposition: prior.sharedPolicy.energyDisposition,
      roomAdmissionPolicy: prior.sharedPolicy.roomAdmissionPolicy,
      laneDerivationPolicy: prior.sharedPolicy.laneDerivationPolicy,
    }, {
      schemaVersion: next.sharedPolicy.schemaVersion,
      catalogRevision: next.sharedPolicy.catalogRevision,
      catalog: next.sharedPolicy.catalog,
      energyDisposition: next.sharedPolicy.energyDisposition,
      roomAdmissionPolicy: next.sharedPolicy.roomAdmissionPolicy,
      laneDerivationPolicy: next.sharedPolicy.laneDerivationPolicy,
    })
  ) return false;
  const oldPolicy = prior.resourcePolicies.find((policy) => policy.resource === old.resource);
  const newPolicy = next.resourcePolicies.find((policy) => policy.resource === grant.resource);
  if (!oldPolicy || !newPolicy) return false;
  const executionShape = (policy: MarketBaseResourcePolicy) => ({
    policyId: policy.policyId,
    resource: policy.resource,
    resourceClass: policy.resourceClass,
    laneReserve: policy.laneReserve,
    minOrderAmount: policy.minOrderAmount,
    maxDealAmount: policy.maxDealAmount,
    cooldownTicks: policy.cooldownTicks,
    rollingWindowTicks: policy.rollingWindowTicks,
    rollingOpportunityReserveAmount: policy.rollingOpportunityReserveAmount,
    maxRawOrdersScanned: policy.maxRawOrdersScanned,
    maxEligibleOrdersPriced: policy.maxEligibleOrdersPriced,
    maxTransactionEnergy: policy.maxTransactionEnergy,
    terminalEnergyReserve: policy.terminalEnergyReserve,
  });
  if (!sameCanonical(executionShape(oldPolicy), executionShape(newPolicy))) {
    return false;
  }
  const sameVolumeCap =
    oldPolicy.rollingMaxAmount === newPolicy.rollingMaxAmount;
  const authorizedUnboundedUpgrade =
    prior.sharedPolicy.engineRevision !== "market-base-resource-engine-v3" &&
    next.sharedPolicy.engineRevision === "market-base-resource-engine-v3" &&
    newPolicy.rollingMaxAmount === 1_000_000_000 &&
    newPolicy.inventoryReferenceAmount === oldPolicy.rollingMaxAmount;
  if (!sameVolumeCap && !authorizedUnboundedUpgrade) return false;
  if (
    (old.stage === "continuous" || old.stage === "review_paused") &&
    old.reviewDigest !== grant.reviewDigest
  ) return false;
  if (old.stage === "qualified") return true;
  if (old.stage === "continuous" || old.stage === "review_paused") return true;
  if (old.stage === "canary" && old.newDealGrant === "suspended") return true;
  const oldQualification = evidenceFor(prior, old.laneId, "shadow_qualification");
  const newQualification = evidenceFor(next, grant.laneId, "shadow_qualification");
  return oldQualification?.digest === old.lifecycleEvidenceDigest &&
    newQualification?.digest === grant.lifecycleEvidenceDigest;
}

function tombstoneDischargeFromGrant(
  grant: MarketBaseResourceSignedLaneGrant,
  successor: MarketBaseResourcePermit,
): MarketBaseResourceLaneTombstoneDischarge {
  const payload: LaneTombstoneDischargeWithoutFingerprint = {
    laneId: grant.laneId,
    resource: grant.resource,
    resourcePolicyId: grant.resourcePolicyId,
    resourcePolicyFingerprint: grant.resourcePolicyFingerprint,
    roomInstanceId: grant.roomInstanceId,
    sellerRoom: grant.sellerRoom,
    roomFingerprint: grant.roomFingerprint,
    sharedPolicyFingerprint: grant.sharedPolicyFingerprint,
    laneStableFingerprint: grant.laneStableFingerprint,
    tombstonedGrantFingerprint: grant.grantFingerprint,
    dischargedAtEpoch: successor.epoch,
    dischargedByPermitId: successor.permitId,
  };
  return {
    ...payload,
    dischargeFingerprint: laneTombstoneDischargeFingerprint(payload),
  };
}

function advanceLaneTombstoneCheckpoint(
  current: MarketBaseResourceLaneTombstoneCheckpoint,
  prior: MarketBaseResourcePermit | undefined,
  next: MarketBaseResourcePermit,
):
  | {
      readonly ok: true;
      readonly checkpoint: MarketBaseResourceLaneTombstoneCheckpoint;
    }
  | { readonly ok: false; readonly reason: string } {
  const dischargedByLane = new Map(
    current.dischargedTombstones.map((entry) => [entry.laneId, entry]),
  );
  if (
    next.signedLaneGrants.some((grant) => dischargedByLane.has(grant.laneId))
  ) {
    return { ok: false, reason: "discharged_lane_reintroduced" };
  }
  if (prior) {
    const nextLaneIds = new Set(
      next.signedLaneGrants.map((grant) => grant.laneId),
    );
    for (const old of prior.signedLaneGrants) {
      if (nextLaneIds.has(old.laneId)) continue;
      if (old.status !== "tombstoned" || old.newDealGrant !== "suspended") {
        return {
          ok: false,
          reason: "prior_grant_missing_suspended_tombstone",
        };
      }
      dischargedByLane.set(old.laneId, tombstoneDischargeFromGrant(old, next));
    }
  }
  const fullTombstoneCount = next.signedLaneGrants.filter(
    (grant) => grant.status === "tombstoned",
  ).length;
  const recentCapacity =
    MARKET_BASE_RESOURCE_MAX_LANE_TOMBSTONES - fullTombstoneCount;
  if (recentCapacity < 0) {
    return {
      ok: false,
      reason: "lane_tombstone_history_bound_exceeded",
    };
  }
  let prefix: LaneTombstonePrefixState = {
    compressedCount: current.compressedCount,
    compressedFirstDischargeFingerprint:
      current.compressedFirstDischargeFingerprint,
    compressedLastDischargeFingerprint:
      current.compressedLastDischargeFingerprint,
    compressedPrefixHead: current.compressedPrefixHead,
    compressedRetiredLaneFilter: current.compressedRetiredLaneFilter,
  };
  const orderedForCompression = [...dischargedByLane.values()].sort(
    (left, right) =>
      left.dischargedAtEpoch - right.dischargedAtEpoch ||
      left.laneId.localeCompare(right.laneId),
  );
  const compressionCount = orderedForCompression.length - recentCapacity;
  if (
    compressionCount > 0 &&
    (!Number.isSafeInteger(prefix.compressedCount + compressionCount) ||
      prefix.compressedCount + compressionCount > Number.MAX_SAFE_INTEGER)
  ) {
    return {
      ok: false,
      reason: "lane_tombstone_prefix_count_exceeded",
    };
  }
  for (const discharge of orderedForCompression.slice(
    0,
    Math.max(0, compressionCount),
  )) {
    prefix = foldCompressedLaneTombstone(prefix, discharge);
    dischargedByLane.delete(discharge.laneId);
  }
  const checkpoint = buildLaneTombstoneCheckpoint(
    [...dischargedByLane.values()],
    prefix,
  );
  return {
    ok: true,
    checkpoint,
  };
}

function validateGrantTransition(
  prior: MarketBaseResourcePermit | undefined,
  next: MarketBaseResourcePermit,
  firstV3: boolean,
  confirmedCanaryProofs: Readonly<
    Map<string, MarketBaseResourceValidatedConfirmedCanaryProof>
  >,
): string | undefined {
  const ratchetError = validateRatchetTransition(
    prior?.ratchetHighWater,
    next.ratchetHighWater,
  );
  if (ratchetError) return ratchetError;
  if (firstV3) {
    if (
      next.signedLaneGrants.some(
        (grant) =>
          grant.status !== "active" ||
          grant.stage !== "shadow" ||
          grant.newDealGrant !== "suspended",
      )
    ) {
      return "first_v3_grants_must_be_shadow_suspended";
    }
    return undefined;
  }
  if (!prior) return "prior_v3_permit_missing";
  const priorByLane = new Map(
    prior.signedLaneGrants.map((grant) => [grant.laneId, grant]),
  );
  for (const grant of next.signedLaneGrants) {
    const old = priorByLane.get(grant.laneId);
    const identityChanged =
      !old ||
      !sameCanonical(stableGrantIdentity(old), stableGrantIdentity(grant));
    if (old?.status === "tombstoned" && !sameCanonical(old, grant)) {
      return "tombstoned_grant_rewrite";
    }
    if (identityChanged) {
      if (isPreservedPolicyMigrationGrant(prior, next, old, grant)) {
        continue;
      }
      if (grant.stage !== "shadow" || grant.newDealGrant !== "suspended") {
        return "new_or_changed_grant_must_be_shadow_suspended";
      }
      continue;
    }
    if (
      stageRank(grant.stage) < stageRank(old.stage) &&
      grant.status !== "tombstoned"
    ) {
      return "grant_stage_regressed";
    }
    if (
      grant.newDealGrant === "suspended" &&
      (old.stage === "canary" || old.stage === "continuous") &&
      !(
        old.status === "active" &&
        grant.status === "tombstoned" &&
        grant.stage === old.stage &&
        grant.lifecycleEvidenceDigest === old.lifecycleEvidenceDigest &&
        grant.reviewDigest === old.reviewDigest
      ) &&
      !sameCanonical(
        grantIdentityAndReviewWithoutDealGrant(old),
        grantIdentityAndReviewWithoutDealGrant(grant),
      )
    ) {
      return "writable_grant_suspension_rewrite";
    }
    if (grant.newDealGrant !== "enabled") continue;
    if (grant.stage === "canary") {
      if (old.stage === "canary") {
        return "canary_lane_already_consumed";
      }
      const qualification = evidenceFor(
        next,
        grant.laneId,
        "shadow_qualification",
      );
      if (
        old.newDealGrant !== "suspended" ||
        !["shadow", "qualified"].includes(old.stage) ||
        !qualification ||
        qualification.digest !== grant.lifecycleEvidenceDigest
      ) {
        return "canary_requires_prior_suspended_grant_and_qualification";
      }
    } else if (grant.stage === "continuous") {
      if (
        old.stage === "continuous" &&
        old.newDealGrant === "enabled" &&
        !sameCanonical(old, grant)
      ) {
        return "continuous_grant_rewrite";
      }
      const review = evidenceFor(next, grant.laneId, "continuous_review");
      const confirmation = confirmedCanaryProofs.get(grant.laneId);
      if (
        !["canary", "review_paused", "continuous"].includes(old.stage) ||
        !review ||
        !confirmation ||
        review.digest !== grant.reviewDigest ||
        review.operatorReviewSnapshotDigest !== grant.reviewDigest ||
        review.confirmedCanaryReviewDigest !== confirmation.reviewDigest ||
        review.evidenceKey !== confirmation.evidenceKey ||
        review.permitId !== confirmation.permitId ||
        review.attemptSeq !== confirmation.attemptSeq ||
        review.receiptEventHash !== confirmation.receiptEventHash ||
        review.ledgerCheckpointHash !== confirmation.ledgerCheckpointHash ||
        review.ledgerPermitAnchorHash !== confirmation.ledgerPermitAnchorHash ||
        review.ledgerReceiptHeadHash !== confirmation.ledgerReceiptHeadHash
      ) {
        return "continuous_requires_prior_canary_and_review";
      }
    }
  }
  return undefined;
}

function grantMatchesDerivedLane(
  grant: MarketBaseResourceSignedLaneGrant,
  lane: MarketBaseDerivedLaneLifecycle,
): boolean {
  return sameCanonical(stableGrantIdentity(grant), {
    laneId: lane.laneId,
    resource: lane.resource,
    resourcePolicyId: lane.resourcePolicyId,
    resourcePolicyFingerprint: lane.resourcePolicyFingerprint,
    roomInstanceId: lane.roomInstanceId,
    sellerRoom: lane.sellerRoomName,
    roomFingerprint: lane.roomFingerprint,
    sharedPolicyFingerprint: lane.sharedPolicyFingerprint,
    laneStableFingerprint: lane.stableFingerprint,
  });
}

function expectedGrantLifecycleEvidenceDigest(
  grant: MarketBaseResourceSignedLaneGrant,
  lane: MarketBaseDerivedLaneLifecycle,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:lane-lifecycle-evidence-v1",
    laneId: lane.laneId,
    shadowEvidence: lane.shadowEvidence,
    stableFingerprint: lane.stableFingerprint,
    stage: grant.stage,
    status: grant.status,
  });
}

function validateCurrentDerivedScope(
  permit: MarketBaseResourcePermit,
  derivedLanes: readonly MarketBaseDerivedLaneLifecycle[],
): string | undefined {
  if (derivedLanes.length > MARKET_BASE_RESOURCE_MAX_LANES) {
    return "derived_lane_bound_exceeded";
  }
  const activeGrants = permit.signedLaneGrants.filter(
    (grant) => grant.status === "active",
  );
  if (
    activeGrants.length !== derivedLanes.length ||
    new Set(derivedLanes.map((lane) => lane.laneId)).size !==
      derivedLanes.length
  ) {
    return "permit_derived_lane_scope_mismatch";
  }
  for (const lane of derivedLanes) {
    const lifecycleError = validateMarketBaseDerivedLaneLifecycle(lane);
    if (lifecycleError) {
      return lifecycleError;
    }
    const grant = activeGrants.find(
      (candidate) => candidate.laneId === lane.laneId,
    );
    if (!grant || !grantMatchesDerivedLane(grant, lane)) {
      return "permit_derived_lane_binding_mismatch";
    }
    if (
      grant.lifecycleEvidenceDigest !==
      expectedGrantLifecycleEvidenceDigest(grant, lane)
    ) {
      return "permit_derived_lane_lifecycle_digest_mismatch";
    }
  }
  return undefined;
}

function permitBindingById(
  state: MarketBaseResourcePermitChainState,
  permitId: string,
): MarketBaseResourcePermitBinding | undefined {
  const retained = state.retainedPermits.find(
    (record) => recordId(record) === permitId,
  );
  if (retained) return recordBinding(retained);
  return state.prefixCheckpoint.referencedPermitBindings.find(
    (binding) => binding.permitId === permitId,
  );
}

function referenceBindings(input: {
  readonly state: MarketBaseResourcePermitChainState;
  readonly nextPermit: MarketBaseResourcePermit;
  readonly currentDerivedLanes: readonly MarketBaseDerivedLaneLifecycle[];
  readonly receiptPermitReferences: readonly MarketBaseResourcePermitReference[];
  readonly activeReviewPermitReferences: readonly MarketBaseResourcePermitReference[];
}):
  | {
      readonly ok: true;
      readonly bindings: readonly MarketBaseResourcePermitBinding[];
    }
  | { readonly ok: false; readonly reason: string } {
  // 624 是两个合法 source 集合闭合后的总 binding 上界。若输入同时越过
  // source 与 unique-binding 上界，优先报告更强的持久历史边界；重复引用
  // 仍由下面各 source 自己的 512/112 上界约束。
  const rawUniquePermitIds = new Set(
    [
      ...input.receiptPermitReferences,
      ...input.activeReviewPermitReferences,
    ].map((reference) => reference.permitId),
  );
  if (rawUniquePermitIds.size > MARKET_BASE_RESOURCE_REFERENCED_BINDING_LIMIT) {
    return { ok: false, reason: "permit_binding_bound_exceeded" };
  }
  if (
    input.receiptPermitReferences.length >
      MARKET_BASE_RESOURCE_RECEIPT_REFERENCE_LIMIT ||
    input.activeReviewPermitReferences.length >
      MARKET_BASE_RESOURCE_ACTIVE_REVIEW_REFERENCE_LIMIT
  ) {
    return { ok: false, reason: "permit_reference_source_bound_exceeded" };
  }
  const receiptIds = new Set<string>();
  const reviewLanes = new Set<string>();
  const bindingByPermit = new Map<string, MarketBaseResourcePermitBinding>();
  for (const reference of input.receiptPermitReferences) {
    const authenticated = permitBindingById(input.state, reference.permitId);
    if (
      !isDigest(reference.sourceId) ||
      !isDigest(reference.permitId) ||
      !authenticated ||
      receiptIds.has(reference.sourceId)
    ) {
      return { ok: false, reason: "receipt_permit_reference_invalid" };
    }
    receiptIds.add(reference.sourceId);
    const normalized = authenticated;
    const previous = bindingByPermit.get(reference.permitId);
    if (previous && !sameCanonical(previous, normalized)) {
      return { ok: false, reason: "permit_binding_conflict" };
    }
    bindingByPermit.set(reference.permitId, normalized);
  }
  const currentLaneIds = new Set(
    input.currentDerivedLanes.map((lane) => lane.laneId),
  );
  for (const reference of input.activeReviewPermitReferences) {
    const authenticated = permitBindingById(input.state, reference.permitId);
    const reviewed = input.nextPermit.reviewedEvidence.some(
      (entry) =>
        entry.laneId === reference.sourceId &&
        entry.permitId === reference.permitId,
    );
    if (
      !isDigest(reference.sourceId) ||
      !isDigest(reference.permitId) ||
      !authenticated ||
      !currentLaneIds.has(reference.sourceId) ||
      !reviewed ||
      reviewLanes.has(reference.sourceId)
    ) {
      return { ok: false, reason: "review_permit_reference_invalid" };
    }
    reviewLanes.add(reference.sourceId);
    const normalized = authenticated;
    const previous = bindingByPermit.get(reference.permitId);
    if (previous && !sameCanonical(previous, normalized)) {
      return { ok: false, reason: "permit_binding_conflict" };
    }
    bindingByPermit.set(reference.permitId, normalized);
  }
  const bindings = [...bindingByPermit.values()].sort(
    (left, right) =>
      left.epoch - right.epoch || left.permitId.localeCompare(right.permitId),
  );
  if (bindings.length > MARKET_BASE_RESOURCE_REFERENCED_BINDING_LIMIT) {
    return { ok: false, reason: "permit_binding_bound_exceeded" };
  }
  return { ok: true, bindings };
}

function compactPermitSuffix(input: {
  readonly state: MarketBaseResourcePermitChainState;
  readonly records: readonly MarketBaseResourceRetainedPermitRecord[];
  readonly bindings: readonly MarketBaseResourcePermitBinding[];
  readonly activePendingPermitId?: string;
  readonly v2CutoverCheckpointHash?: string;
}):
  | {
      readonly ok: true;
      readonly records: readonly MarketBaseResourceRetainedPermitRecord[];
      readonly prefixCheckpoint: MarketBaseResourcePermitPrefixCheckpoint;
    }
  | { readonly ok: false; readonly reason: string } {
  const pruneCount = Math.max(
    0,
    input.records.length - MARKET_BASE_RESOURCE_PERMIT_SUFFIX_LIMIT,
  );
  if (pruneCount === 0) {
    return {
      ok: true,
      records: input.records,
      prefixCheckpoint: input.state.prefixCheckpoint,
    };
  }
  const pruned = input.records.slice(0, pruneCount);
  if (
    input.activePendingPermitId &&
    pruned.some((record) => recordId(record) === input.activePendingPermitId)
  ) {
    return { ok: false, reason: "active_pending_permit_pin" };
  }
  const bindingById = new Map(
    input.bindings.map((binding) => [binding.permitId, binding]),
  );
  for (const oldBinding of input.state.prefixCheckpoint
    .referencedPermitBindings) {
    const nextBinding = bindingById.get(oldBinding.permitId);
    if (nextBinding && !sameCanonical(nextBinding, oldBinding)) {
      return {
        ok: false,
        reason: "permit_binding_checkpoint_rewrite",
      };
    }
  }
  for (const record of pruned) {
    const binding = bindingById.get(recordId(record));
    if (binding && !sameCanonical(binding, recordBinding(record))) {
      return { ok: false, reason: "permit_binding_record_mismatch" };
    }
  }
  const retained = input.records.slice(pruneCount);
  const previous = input.state.prefixCheckpoint;
  const firstPruned = pruned[0];
  const lastPruned = pruned[pruned.length - 1];
  const lastPrunedV3 = [...pruned]
    .reverse()
    .find(
      (record): record is MarketBaseResourcePermit =>
        record.schemaVersion === 3,
    );
  const ratchetHighWater = lastPrunedV3
    ? lastPrunedV3.ratchetHighWater
    : previous.ratchetHighWater;
  const activeBindings = input.bindings.filter(
    (binding) => binding.epoch <= recordEpoch(lastPruned) && binding.epoch >= 1,
  );
  const payload = {
    schemaVersion: 3 as const,
    hashRevision: "market-base-resource-permit-prefix-v1" as const,
    prunedThroughEpoch: recordEpoch(lastPruned),
    firstPrunedPermitId:
      previous.prunedThroughEpoch > 0
        ? previous.firstPrunedPermitId
        : recordId(firstPruned),
    firstPrunedPreviousPermitHead: previous.firstPrunedPreviousPermitHead,
    lastPrunedPermitId: recordId(lastPruned),
    lastPrunedPermitHead: recordHead(lastPruned),
    v2CutoverCheckpointHash:
      input.v2CutoverCheckpointHash ??
      input.state.v2EventCutoverCheckpoint?.checkpointHash ??
      previous.v2CutoverCheckpointHash,
    ratchetPermitEpoch: lastPrunedV3?.epoch ?? previous.ratchetPermitEpoch,
    ratchetHighWater,
    ratchetHighWaterCommitment: ratchetHighWaterCommitment(ratchetHighWater),
    referencedPermitBindings: activeBindings,
  };
  return {
    ok: true,
    records: retained,
    prefixCheckpoint: {
      ...payload,
      prefixCommitment: canonicalStableHashV1(prefixPayload(payload)),
    },
  };
}

export interface AppendMarketBaseResourcePermitInput {
  readonly tick: number;
  readonly currentShard: string;
  readonly currentLedgerHead: string;
  readonly currentLedgerCheckpointHash?: string;
  readonly currentLedgerPermitAnchorHash?: string;
  readonly currentV2LedgerCheckpointHash?: string;
  readonly currentV2AttemptSeqHighWater?: number;
  readonly currentV2OutcomeSeqHighWater?: number;
  readonly currentDerivedLanes: readonly MarketBaseDerivedLaneLifecycle[];
  readonly currentLifecycleCheckpointCommitment: string;
  readonly hasPending: boolean;
  readonly hasQuarantine: boolean;
  readonly hasGap: boolean;
  readonly hasUnmatchedReservation: boolean;
  readonly receiptPermitReferences?: readonly MarketBaseResourcePermitReference[];
  readonly activeReviewPermitReferences?: readonly MarketBaseResourcePermitReference[];
  readonly confirmedCanaryProofs?: readonly MarketBaseResourceValidatedConfirmedCanaryProof[];
  readonly activePendingPermitId?: string;
  readonly highWaterCheckpoint?: {
    readonly permitEpochHighWater: number;
    readonly permitChainHeadHighWater: string;
    readonly totalChainLength: number;
    readonly prefixCommitment: string;
    readonly laneTombstoneCheckpointCommitment?: string;
  };
}

export type AppendMarketBaseResourcePermitResult =
  | {
      readonly status: "appended" | "idempotent";
      readonly state: MarketBaseResourcePermitChainState;
    }
  | {
      readonly status: "rejected" | "conflict";
      readonly reason: string;
      readonly state: MarketBaseResourcePermitChainState;
    };

export function appendMarketBaseResourcePermit(
  state: MarketBaseResourcePermitChainState,
  permit: MarketBaseResourcePermit,
  input: AppendMarketBaseResourcePermitInput,
): AppendMarketBaseResourcePermitResult {
  if (!isSafeTick(input.tick)) {
    return { status: "rejected", reason: "tick_invalid", state };
  }
  const validation = validateMarketBaseResourcePermitChain(
    state,
    input.highWaterCheckpoint,
  );
  if (!validation.ok) {
    const conflicted = stateWithBlocker(
      state,
      validation.reason ?? "permit_chain_invalid",
      input.tick,
      input.highWaterCheckpoint ?? null,
    );
    return {
      status: "conflict",
      reason: validation.reason ?? "permit_chain_invalid",
      state: conflicted,
    };
  }
  if (!validV3PermitSelfIdentity(permit)) {
    const conflicted = stateWithBlocker(
      state,
      "permit_self_hash_mismatch",
      input.tick,
      permit,
    );
    return {
      status: "conflict",
      reason: "permit_self_hash_mismatch",
      state: conflicted,
    };
  }
  const retainedExisting = state.retainedPermits.find(
    (record) => recordEpoch(record) === permit.epoch,
  );
  if (retainedExisting) {
    if (
      retainedExisting.schemaVersion === 3 &&
      sameCanonical(retainedExisting, permit)
    ) {
      return { status: "idempotent", state };
    }
    const conflicted = stateWithBlocker(
      state,
      "permit_epoch_conflict",
      input.tick,
      permit,
    );
    return {
      status: "conflict",
      reason: "permit_epoch_conflict",
      state: conflicted,
    };
  }
  if (permit.epoch <= state.prefixCheckpoint.prunedThroughEpoch) {
    const retainedBinding =
      state.prefixCheckpoint.referencedPermitBindings.find(
        (binding) => binding.permitId === permit.permitId,
      );
    if (
      retainedBinding &&
      !sameCanonical(retainedBinding, recordBinding(permit))
    ) {
      const conflicted = stateWithBlocker(
        state,
        "pruned_permit_binding_conflict",
        input.tick,
        permit,
      );
      return {
        status: "conflict",
        reason: "pruned_permit_binding_conflict",
        state: conflicted,
      };
    }
    return {
      status: "rejected",
      reason: "pruned_epoch_not_replayable",
      state,
    };
  }
  if (
    input.hasPending ||
    input.hasQuarantine ||
    input.hasGap ||
    input.hasUnmatchedReservation
  ) {
    return {
      status: "rejected",
      reason: "permit_wal_not_quiescent",
      state,
    };
  }
  if (
    input.currentShard !== "shard1" ||
    permit.executorShard !== input.currentShard ||
    permit.epoch !== state.permitEpochHighWater + 1 ||
    permit.previousPermitId !== state.currentPermitId ||
    permit.previousPermitHead !== state.permitChainHead ||
    permit.previousLedgerHead !== input.currentLedgerHead
  ) {
    const conflicted = stateWithBlocker(
      state,
      "permit_predecessor_mismatch",
      input.tick,
      {
        currentLedgerHead: input.currentLedgerHead,
        permitEpoch: permit.epoch,
      },
    );
    return {
      status: "conflict",
      reason: "permit_predecessor_mismatch",
      state: conflicted,
    };
  }
  const firstV3 = !state.v2EventCutoverCheckpoint;
  if (firstV3) {
    const expectedLegacySuspension = permit.v2EventCutoverCheckpoint
      ? buildMarketBaseResourceLegacyV2GrantSuspension({
          previousPermitId: state.currentPermitId,
          previousPermitHead: state.permitChainHead,
          cutoverCheckpointHash: permit.v2EventCutoverCheckpoint.checkpointHash,
        })
      : undefined;
    if (
      !permit.v2EventCutoverCheckpoint ||
      !permit.legacyV2GrantSuspension ||
      permit.legacyV2GrantSuspension.entryId !==
        MARKET_BASE_RESOURCE_V2_LEGACY_X_ENTRY_ID ||
      permit.legacyV2GrantSuspension.nextNewDealGrant !== "suspended" ||
      permit.legacyV2GrantSuspension.noLegacyBridge !== true ||
      !expectedLegacySuspension ||
      !sameCanonical(
        permit.legacyV2GrantSuspension,
        expectedLegacySuspension,
      ) ||
      permit.v2EventCutoverCheckpoint.v2ReceiptHeadHash !==
        input.currentLedgerHead ||
      permit.v2EventCutoverCheckpoint.v2LedgerCheckpointHash !==
        input.currentV2LedgerCheckpointHash ||
      permit.v2EventCutoverCheckpoint.lastV2AttemptSeq !==
        input.currentV2AttemptSeqHighWater ||
      permit.v2EventCutoverCheckpoint.lastV2OutcomeSeq !==
        input.currentV2OutcomeSeqHighWater
    ) {
      return {
        status: "rejected",
        reason: "first_v3_cutover_incomplete",
        state,
      };
    }
  } else if (
    permit.v2EventCutoverCheckpoint !== undefined ||
    permit.legacyV2GrantSuspension !== undefined
  ) {
    return {
      status: "rejected",
      reason: "v2_cutover_may_only_appear_once",
      state,
    };
  }
  const scopeError = validateCurrentDerivedScope(
    permit,
    input.currentDerivedLanes,
  );
  if (scopeError) {
    return { status: "rejected", reason: scopeError, state };
  }
  if (!isDigest(input.currentLifecycleCheckpointCommitment)) {
    return {
      status: "rejected",
      reason: "lane_lifecycle_checkpoint_invalid",
      state,
    };
  }
  let expectedLifecycleCheckpointCommitment: string;
  try {
    expectedLifecycleCheckpointCommitment =
      marketBaseDerivedLaneLifecycleCheckpointCommitment(
        input.currentDerivedLanes,
      );
  } catch {
    return {
      status: "rejected",
      reason: "lane_lifecycle_checkpoint_invalid",
      state,
    };
  }
  if (
    input.currentLifecycleCheckpointCommitment !==
    expectedLifecycleCheckpointCommitment
  ) {
    return {
      status: "rejected",
      reason: "lane_lifecycle_checkpoint_mismatch",
      state,
    };
  }
  const priorV3Permit = previousV3Permit(state);
  const tombstoneCheckpoint = advanceLaneTombstoneCheckpoint(
    state.laneTombstoneCheckpoint,
    priorV3Permit,
    permit,
  );
  if ("reason" in tombstoneCheckpoint) {
    return {
      status: "rejected",
      reason: tombstoneCheckpoint.reason,
      state,
    };
  }
  const confirmedCanaryProofs = new Map<
    string,
    MarketBaseResourceValidatedConfirmedCanaryProof
  >();
  for (const proof of input.confirmedCanaryProofs ?? []) {
    if (
      !validateConfirmedCanaryProof(proof) ||
      confirmedCanaryProofs.has(proof.laneId) ||
      proof.ledgerReceiptHeadHash !== input.currentLedgerHead ||
      proof.ledgerCheckpointHash !== input.currentLedgerCheckpointHash ||
      proof.ledgerPermitAnchorHash !== input.currentLedgerPermitAnchorHash
    ) {
      return {
        status: "rejected",
        reason: "confirmed_canary_proof_invalid",
        state,
      };
    }
    confirmedCanaryProofs.set(proof.laneId, proof);
  }
  const transitionError = validateGrantTransition(
    priorV3Permit,
    permit,
    firstV3,
    confirmedCanaryProofs,
  );
  if (transitionError) {
    return { status: "rejected", reason: transitionError, state };
  }
  const references = referenceBindings({
    state,
    nextPermit: permit,
    currentDerivedLanes: input.currentDerivedLanes,
    receiptPermitReferences: input.receiptPermitReferences ?? [],
    activeReviewPermitReferences: input.activeReviewPermitReferences ?? [],
  });
  if ("reason" in references) {
    return {
      status: "rejected",
      reason: references.reason,
      state,
    };
  }
  const records = [...state.retainedPermits, clone(permit)];
  const compacted = compactPermitSuffix({
    state,
    records,
    bindings: references.bindings,
    activePendingPermitId: input.activePendingPermitId,
    v2CutoverCheckpointHash:
      state.v2EventCutoverCheckpoint?.checkpointHash ??
      permit.v2EventCutoverCheckpoint?.checkpointHash,
  });
  if ("reason" in compacted) {
    return {
      status: "rejected",
      reason: compacted.reason,
      state,
    };
  }
  const next: MarketBaseResourcePermitChainState = {
    schemaVersion: 3,
    hashRevision: MARKET_BASE_RESOURCE_PERMIT_HASH_REVISION,
    currentPermitEpoch: permit.epoch,
    currentPermitId: permit.permitId,
    permitChainHead: permit.permitHead,
    permitEpochHighWater: permit.epoch,
    permitChainHeadHighWater: permit.permitHead,
    totalChainLength: state.totalChainLength + 1,
    retainedPermits: compacted.records,
    prefixCheckpoint: compacted.prefixCheckpoint,
    laneTombstoneCheckpoint: tombstoneCheckpoint.checkpoint,
    v2EventCutoverCheckpoint:
      state.v2EventCutoverCheckpoint ?? permit.v2EventCutoverCheckpoint,
    legacyV2GrantSuspended:
      state.legacyV2GrantSuspended || Boolean(permit.legacyV2GrantSuspension),
  };
  const nextValidation = validateMarketBaseResourcePermitChain(next);
  if (!nextValidation.ok) {
    const conflicted = stateWithBlocker(
      state,
      nextValidation.reason ?? "permit_append_atomicity_failure",
      input.tick,
      next,
    );
    return {
      status: "conflict",
      reason: nextValidation.reason ?? "permit_append_atomicity_failure",
      state: conflicted,
    };
  }
  return {
    status: "appended",
    state: deepFreeze(next) as MarketBaseResourcePermitChainState,
  };
}

export function hasAcceptedMarketBaseResourceV3Successor(
  state: MarketBaseResourcePermitChainState,
): boolean {
  if (!validateMarketBaseResourcePermitChain(state).ok) return false;
  const current = state.retainedPermits[state.retainedPermits.length - 1];
  return Boolean(
    current?.schemaVersion === 3 &&
    state.v2EventCutoverCheckpoint &&
    state.legacyV2GrantSuspended,
  );
}

export function marketBaseResourcePermitAllowsNewDeal(
  state: MarketBaseResourcePermitChainState,
  input: {
    readonly shard: string;
    readonly lane: MarketBaseDerivedLaneLifecycle;
  },
): boolean {
  return marketBaseResourcePermitAllowsNewDealCore(state, input, false);
}

function marketBaseResourcePermitAllowsNewDealCore(
  state: MarketBaseResourcePermitChainState,
  input: {
    readonly shard: string;
    readonly lane: MarketBaseDerivedLaneLifecycle;
  },
  skipFullValidation: boolean,
): boolean {
  if (
    input.shard !== "shard1" ||
    (skipFullValidation
      ? !(
          state.v2EventCutoverCheckpoint &&
          state.legacyV2GrantSuspended === true
        )
      : !hasAcceptedMarketBaseResourceV3Successor(state))
  ) {
    return false;
  }
  const current = state.retainedPermits[state.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) return false;
  const grant = current.signedLaneGrants.find(
    (candidate) => candidate.laneId === input.lane.laneId,
  );
  return Boolean(
    grant &&
    grant.status === "active" &&
    grant.newDealGrant === "enabled" &&
    (grant.stage === "canary" || grant.stage === "continuous") &&
    input.lane.stage === grant.stage &&
    input.lane.status === "writable" &&
    grantMatchesDerivedLane(grant, input.lane) &&
    grant.lifecycleEvidenceDigest ===
      canonicalStableHashV1({
        domain: "market-base-resource:lane-lifecycle-evidence-v1",
        laneId: input.lane.laneId,
        shadowEvidence: input.lane.shadowEvidence,
        stableFingerprint: input.lane.stableFingerprint,
        stage: grant.stage,
        status: grant.status,
      }),
  );
}

export function marketBaseResourcePermitAllowsNewDealWithRuntimeContext(
  context: MarketBaseResourcePermitRuntimeContext,
  input: {
    readonly shard: string;
    readonly lane: MarketBaseDerivedLaneLifecycle;
  },
): boolean {
  return (
    validMarketBaseResourcePermitRuntimeContext(context) &&
    marketBaseResourcePermitAllowsNewDealCore(context.state, input, true)
  );
}

export interface MarketBaseResourceReadinessRoomBasis {
  readonly roomName: string;
  readonly roomInstanceId: string;
  readonly terminalId: string;
  readonly status: "admitted";
}

export interface MarketBaseResourceReadinessAuthorization {
  readonly schemaVersion: 3;
  readonly validated: true;
  readonly status: "authorized";
  readonly revision: string;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly maxTransactionEnergy: typeof MARKET_BASE_RESOURCE_MAX_TRANSACTION_ENERGY;
  readonly rooms: readonly {
    readonly roomName: string;
    readonly roomInstanceId: string;
    readonly terminalId: string;
    readonly status: "authorized";
  }[];
}

export type BuildMarketBaseResourceReadinessAuthorizationResult =
  | {
      readonly ok: true;
      readonly readinessAuthorization: MarketBaseResourceReadinessAuthorization;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * 给 ResourceControl 的窄投影构造器。ResourceControl 不需要也不应该自行
 * 解析完整 permit chain。
 */
export function buildMarketBaseResourceReadinessAuthorization(
  state: MarketBaseResourcePermitChainState,
  input: {
    readonly tick: number;
    readonly ttl: number;
    readonly roster: readonly MarketBaseResourceReadinessRoomBasis[];
    readonly lanes: readonly MarketBaseDerivedLaneLifecycle[];
  },
): BuildMarketBaseResourceReadinessAuthorizationResult {
  return buildMarketBaseResourceReadinessAuthorizationCore(state, input, false);
}

function buildMarketBaseResourceReadinessAuthorizationCore(
  state: MarketBaseResourcePermitChainState,
  input: {
    readonly tick: number;
    readonly ttl: number;
    readonly roster: readonly MarketBaseResourceReadinessRoomBasis[];
    readonly lanes: readonly MarketBaseDerivedLaneLifecycle[];
  },
  skipFullValidation: boolean,
): BuildMarketBaseResourceReadinessAuthorizationResult {
  if (
    !Array.isArray(input.roster) ||
    input.roster.length > MARKET_BASE_RESOURCE_MAX_ROOMS
  ) {
    return { ok: false, reason: "readiness_roster_invalid" };
  }
  if (
    !Array.isArray(input.lanes) ||
    input.lanes.length > MARKET_BASE_RESOURCE_MAX_LANES
  ) {
    return { ok: false, reason: "readiness_lane_invalid" };
  }
  if (
    !isSafeTick(input.tick) ||
    !isPositiveSafeInteger(input.ttl) ||
    (skipFullValidation
      ? !(
          state.v2EventCutoverCheckpoint &&
          state.legacyV2GrantSuspended === true
        )
      : !hasAcceptedMarketBaseResourceV3Successor(state))
  ) {
    return { ok: false, reason: "readiness_permit_invalid" };
  }
  const current = state.retainedPermits[state.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    return { ok: false, reason: "readiness_current_permit_missing" };
  }
  const rosterByInstance = new Map<
    string,
    MarketBaseResourceReadinessRoomBasis
  >();
  const rosterRoomNames = new Set<string>();
  for (const candidate of input.roster as readonly unknown[]) {
    if (
      !isPlainRecord(candidate) ||
      candidate.status !== "admitted" ||
      typeof candidate.roomName !== "string" ||
      candidate.roomName.length === 0 ||
      candidate.roomName.length > 16 ||
      !isDigest(candidate.roomInstanceId) ||
      candidate.roomInstanceId.length > 256 ||
      !isDigest(candidate.terminalId) ||
      candidate.terminalId.length > 128 ||
      rosterByInstance.has(candidate.roomInstanceId) ||
      rosterRoomNames.has(candidate.roomName)
    ) {
      return { ok: false, reason: "readiness_roster_invalid" };
    }
    const room = candidate as unknown as MarketBaseResourceReadinessRoomBasis;
    rosterByInstance.set(room.roomInstanceId, room);
    rosterRoomNames.add(room.roomName);
  }
  const roomsByInstance = new Map<
    string,
    MarketBaseResourceReadinessAuthorization["rooms"][number]
  >();
  const laneById = new Map<string, MarketBaseDerivedLaneLifecycle>();
  for (const candidate of input.lanes as readonly unknown[]) {
    if (
      !isPlainRecord(candidate) ||
      !isDigest(candidate.laneId) ||
      !isDigest(candidate.roomInstanceId) ||
      (!skipFullValidation && validateMarketBaseDerivedLaneLifecycle(candidate))
    ) {
      return { ok: false, reason: "readiness_lane_invalid" };
    }
    const lane = candidate as unknown as MarketBaseDerivedLaneLifecycle;
    if (lane.laneId.length > 256 || lane.roomInstanceId.length > 256) {
      return { ok: false, reason: "readiness_lane_invalid" };
    }
    if (laneById.has(lane.laneId)) {
      return { ok: false, reason: "readiness_lane_duplicate" };
    }
    laneById.set(lane.laneId, lane);
  }
  for (const grant of current.signedLaneGrants) {
    if (
      grant.status !== "active" ||
      grant.newDealGrant !== "enabled" ||
      !["canary", "continuous"].includes(grant.stage)
    ) {
      continue;
    }
    const lane = laneById.get(grant.laneId);
    if (
      !lane ||
      (skipFullValidation && validateMarketBaseDerivedLaneLifecycle(lane)) ||
      !grantMatchesDerivedLane(grant, lane)
    ) {
      return {
        ok: false,
        reason: "readiness_grant_lane_mismatch",
      };
    }
    if (
      !marketBaseResourcePermitAllowsNewDealCore(
        state,
        {
          shard: "shard1",
          lane,
        },
        skipFullValidation,
      )
    ) {
      continue;
    }
    const room = rosterByInstance.get(grant.roomInstanceId);
    if (!room || room.roomName !== grant.sellerRoom) {
      return {
        ok: false,
        reason: "readiness_grant_roster_mismatch",
      };
    }
    roomsByInstance.set(room.roomInstanceId, {
      roomName: room.roomName,
      roomInstanceId: room.roomInstanceId,
      terminalId: room.terminalId,
      status: "authorized",
    });
  }
  const rooms = [...roomsByInstance.values()].sort((left, right) =>
    left.roomName.localeCompare(right.roomName),
  );
  if (rooms.length === 0) {
    return { ok: false, reason: "readiness_no_enabled_v3_grant" };
  }
  return {
    ok: true,
    readinessAuthorization: deepFreeze({
      schemaVersion: 3 as const,
      validated: true as const,
      status: "authorized" as const,
      revision: canonicalStableHashV1({
        domain: "market-base-resource:readiness-authorization-v3",
        permitHead: current.permitHead,
        permitId: current.permitId,
        rooms,
        tick: input.tick,
      }),
      updatedAt: input.tick,
      expiresAt: input.tick + input.ttl,
      maxTransactionEnergy: MARKET_BASE_RESOURCE_MAX_TRANSACTION_ENERGY,
      rooms,
    }) as MarketBaseResourceReadinessAuthorization,
  };
}

export function buildMarketBaseResourceReadinessAuthorizationWithRuntimeContext(
  context: MarketBaseResourcePermitRuntimeContext,
  input: {
    readonly tick: number;
    readonly ttl: number;
    readonly roster: readonly MarketBaseResourceReadinessRoomBasis[];
    readonly lanes: readonly MarketBaseDerivedLaneLifecycle[];
  },
): BuildMarketBaseResourceReadinessAuthorizationResult {
  if (
    !validMarketBaseResourcePermitRuntimeContext(context) ||
    input.tick !== context.tick
  ) {
    return { ok: false, reason: "permit_runtime_context_invalid" };
  }
  return buildMarketBaseResourceReadinessAuthorizationCore(
    context.state,
    input,
    true,
  );
}

export function marketBaseResourcePermitBindingFor(
  permit: MarketBaseResourceRetainedPermitRecord,
): MarketBaseResourcePermitBinding {
  return deepFreeze(recordBinding(permit)) as MarketBaseResourcePermitBinding;
}

export function marketBaseResourceSellerRoomBasis(
  room: MarketBaseSellerRoomState,
): MarketBaseResourceReadinessRoomBasis {
  return {
    roomName: room.roomName,
    roomInstanceId: room.roomInstanceId,
    terminalId: room.terminalId,
    status: "admitted",
  };
}
