/** 从 marketBaseResourceAutomation.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { AUTHORITY_EXECUTOR_SHARD, AUTHORITY_ROOMS } from "@/config/deployment";
import {
  claimPreparedDirectMarketClaims,
  executePreparedDirectMarketDeal,
  getMarketAccountClaim,
  getMarketActionJournal,
  getTerminalActionClaim,
  hasMarketActionIntentThisTick,
  releasePreparedDirectMarketClaims,
} from "@/runtime/marketActionArbiter";
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
import { validateContinuousLedger, type MarketDirectContinuousLedger } from "@/runtime/marketDirectContinuousLedger";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
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
  createMarketBaseRoomAdmissionPolicy,
  createMarketBaseSharedPolicy,
  marketBaseDerivedLaneSetFingerprint,
  reconcileMarketBaseSellerRooms,
  validateMarketBaseDerivedLaneLifecycle,
  type MarketBaseDerivedLaneLifecycle,
  type MarketBaseDynamicFloorState,
  type MarketBaseRoomIncarnationRegistry,
  type MarketBaseSellerRoomState,
} from "@/runtime/marketBaseResourcePolicy";
import {
  buildMarketBaseResourceReadinessAuthorization,
  buildMarketBaseResourceReadinessAuthorizationWithRuntimeContext,
  createMarketBaseResourcePermitRuntimeContext,
  hasAcceptedMarketBaseResourceV3Successor,
  marketBaseResourcePermitAllowsNewDealWithRuntimeContext,
  marketBaseResourceSellerRoomBasis,
  validateMarketBaseResourcePermitRuntimeGate,
  validateMarketBaseResourcePermitChain,
  type MarketBaseResourcePermit,
  type MarketBaseResourcePermitChainState,
  type MarketBaseResourcePermitRuntimeContext,
  type MarketBaseResourceReadinessAuthorization,
} from "@/runtime/marketBaseResourcePermit";
import {
  createMarketBaseResourceLedgerRuntimeContext,
  inspectMarketBaseResourceCanaryGrantAvailabilityWithRuntimeContext,
  validateMarketBaseResourcePermitChainDominatesAnchor,
  validateMarketBaseResourceLedger,
  type MarketBaseResourceLedger,
  type MarketBaseResourceLedgerRuntimeAnchor,
  type MarketBaseResourceLedgerRuntimeContext,
} from "@/runtime/marketBaseResourceLedger";
import {
  MARKET_BASE_RESOURCE_MAX_ACTIVE_ROOMS,
  MARKET_BASE_RESOURCE_MAX_ACTIVE_LANES,
  MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES,
  stableCompare,
} from "@/runtime/marketBaseResourcePlanning";
import type {
  MarketBaseResourcePricingRatchetState,
  MarketBaseResourcePlanningSnapshot,
  MarketBaseResourceOutgoingWindow,
  MarketBaseResourceTerminalRead,
  MarketBaseResourceOutgoingTransaction,
} from "@/runtime/marketBaseResourcePlanning";


export const MARKET_BASE_RESOURCE_SCOPE_LANE_TOMBSTONE_CHECKPOINT_REVISION =
  "market-base-resource-scope-lane-tombstones-v1" as const;

export function pricingRatchetPayload(input: {
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
  executorShard: typeof AUTHORITY_EXECUTOR_SHARD;
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

declare const MARKET_BASE_RESOURCE_READINESS_RUNTIME_CAPABILITY_BRAND: unique symbol;

export interface MarketBaseResourceReadinessRuntimeCapability {
  readonly [MARKET_BASE_RESOURCE_READINESS_RUNTIME_CAPABILITY_BRAND]: true;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
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
      legacyEntry.allowedRoomNames[0] !== AUTHORITY_ROOMS.legacyXSeller ||
      !lifecycle ||
      !marketDirectPermitAllowsNewDeal(outer.permitChain, {
        shard: MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
        entryId: legacyEntry.entryId,
        lifecycle,
      }) ||
      !room ||
      room.roomName !== AUTHORITY_ROOMS.legacyXSeller ||
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
        roomName: AUTHORITY_ROOMS.legacyXSeller,
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
    permit.executorShard !== AUTHORITY_EXECUTOR_SHARD ||
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

export const MARKET_BASE_RESOURCE_NO_SCOPE_LANE_TOMBSTONE_DISCHARGE =
  canonicalStableHashV1(
    "market-base-resource:no-scope-lane-tombstone-discharge-v1",
  );

export type MarketBaseResourceScopeLaneTombstone = MarketBaseDerivedLaneLifecycle & {
  retiredAt: number;
};

export type ScopeLaneTombstoneCheckpointWithoutCommitment = Omit<
  MarketBaseResourceScopeLaneTombstoneDischargeCheckpoint,
  "checkpointCommitment"
>;

export function scopeLaneTombstoneCheckpointPayload(
  checkpoint: ScopeLaneTombstoneCheckpointWithoutCommitment,
): unknown {
  return {
    domain: "market-base-resource:scope-lane-tombstone-checkpoint-v1",
    ...checkpoint,
  };
}

export function validScopeLaneTombstoneCheckpoint(
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

export function validateScopeLaneTombstones(
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

export function currentRosterFingerprint(
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
export const MAX_OUTGOING_TRANSACTIONS = 100;

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

export function currentV3Permit(
  chain: MarketBaseResourcePermitChainState,
): MarketBaseResourcePermit | undefined {
  const current = chain.retainedPermits[chain.retainedPermits.length - 1];
  return current?.schemaVersion === 3 ? current : undefined;
}

export interface MarketBaseResourceRuntimeSession {
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

export const marketBaseResourceReadinessRuntimeCapabilities = new WeakMap<
  object,
  MarketBaseResourceReadinessRuntimeCapabilityState
>();

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

export const marketBaseResourceCanonicalReadinessRuntimeCache = new WeakMap<
  object,
  MarketBaseResourceCanonicalReadinessRuntimeCache
>();

export type MarketBaseResourceRuntimeSessionResult =
  | {
      ok: true;
      session: MarketBaseResourceRuntimeSession;
    }
  | {
      ok: false;
      reason: string;
    };

export const marketBaseResourceRuntimeDeepFrozenValues = new WeakSet<object>();

export function freezeMarketBaseResourceRuntimeSnapshot<T>(value: T): T {
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

export function createMarketBaseResourceRuntimeScopeContext(
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

export function marketBaseResourceRuntimeInvariantCommitment(
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

export function marketBaseResourceRuntimePricingRatchetCommitment(
  state: MarketBaseResourceV3RuntimeState,
): string {
  return canonicalStableHashV1({
    domain: "market-base-resource:runtime-pricing-ratchet-v1",
    pricingRatchet: state.pricingRatchet ?? null,
  });
}

export function marketBaseResourceRuntimeSnapshotMismatch(
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

export function issueMarketBaseResourceReadinessRuntimeCapability(
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
export function advanceMarketBaseResourceReadinessRuntimeCapabilityInternal(
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
    state.scope !== undefined &&
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
      state.scope !== undefined &&
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

export function readCachedMarketBaseResourceCanonicalReadiness(
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
      activationAnchor.executorShard !== AUTHORITY_EXECUTOR_SHARD ||
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
            laneAllowsRuntimeWrite(capability.session, AUTHORITY_EXECUTOR_SHARD, lane),
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

export function openMarketBaseResourceRuntimeSession(
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

export function laneAllowsRuntimeWrite(
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
