/**
 * Treasury Facade——Core Rewrite I 薄装配层。
 *
 * 新协议（openspec/changes/empire-treasury-core-rewrite）：
 * - 写路径全部委托 treasury kernel（单一写入口状态机）：authorize =
 *   admit（活跃聚合 + 正向执行许可），execute = 受控 dispatch（许可校验 →
 *   dispatching 发布 → 动作恰好一次 → 三种事实分别持久）。
 * - 旧 Ticket / Intent / Quarantine / Resolution / receipt / GRA /
 *   certificate / summary 多 store 权威已退役；发现旧业务数据时 kernel
 *   报告 incompatible 并阻断写入（不解析、不擦除）。
 * - 查询侧保持既有语义：observation（物理事实快照 + epoch）、commitments
 *  （任务/预留承诺索引）、query（fail-closed 输入 + owner 验证 +
 *   completeness）、容量四口径（strict / risk-adjusted）。本 tick 投影
 *   overlay 由 admit（tentative）与 dispatch committed（已发生）驱动，
 *   每 tick 重建；跨 tick 风险占用由 kernel 活跃聚合承担。
 * - beginTick：kernel 恢复推进（dispatching 残留保守化、retry 期限关闭、
 *   清理公平推进）+ 观察重建；endTick：kernel 收尾 + 残留保守化。查询
 *   路径零写（不初始化 store、不迁移、不 GC）。
 */

import {
  buildTreasuryObservation,
} from "@/runtime/treasury/observation";
import {
  buildTreasuryCommitmentIndex,
} from "@/runtime/treasury/commitments";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import {
  resolveTreasuryHolder,
  type TreasuryHolderResolution,
} from "@/runtime/treasury/holderResolution";
import type { TreasuryOwnerIdentity } from "@/runtime/treasury/ownerIdentity";
import {
  ensureReservationSchemaActivated,
  isReservationOwnerMigrationComplete,
  readReservationMutationCounters,
  validateReservationStoreHealth,
} from "@/runtime/resourceReservation";
import { readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import {
  findTreasuryActionAdapter,
  readTreasuryActionContractCounters,
  verifyTreasuryActionContractForAuthorization,
} from "@/runtime/treasury/actionContracts";
import {
  findTreasuryPolicyResolver,
  validateTreasuryPolicyDecision,
  type TreasuryRegisteredPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import type { TreasuryActionContract, TreasuryActionReconcilerConclusion } from "@/runtime/treasury/actionContracts";
import { canonicalizeTreasuryAdapterRetryFacts } from "@/runtime/treasury/adapterRetrySemantics";
import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
import {
  createTreasuryCoreKernel,
  type TreasuryCoreActionAdapterPort,
  type TreasuryCoreRejectionCode,
  type TreasuryCoreAdmissionResult,
  type TreasuryCoreDispatchOutcome,
  type TreasuryCoreKernelMetrics,
} from "@/runtime/treasury/kernel/kernel";
import {
  computeTreasuryCoreOccupancy,
  listTreasuryCoreActiveWorks,
} from "@/runtime/treasury/kernel/occupancy";
import type {
  TreasuryCoreDispatchPermit,
  TreasuryCoreIdentityFacts,
  TreasuryCoreMemory,
  TreasuryCoreRearmPermit,
  TreasuryCoreRingEntry,
  TreasuryCoreStoreHealth,
  TreasuryCoreWorkRecord,
  TreasuryCoreWorstCaseLeg,
} from "@/runtime/treasury/kernel/types";
import {
  readTreasuryCoreStoreHealth,
} from "@/runtime/treasury/kernel/store";
import type {
  TreasuryCommitmentCompleteness,
  TreasuryCommitmentIndex,
  TreasuryLocationKind,
  TreasuryMetrics,
  TreasuryObservationView,
  TreasuryOwnerStatus,
  TreasuryQueryContext,
  TreasuryQueryOwner,
  TreasuryBalanceView,
} from "@/runtime/treasury/types";
import { createTreasuryMetrics } from "@/runtime/treasury/types";

export const TREASURY_FRESH_EPOCH_LIMIT = 8;

export interface TreasuryServiceDeps {
  /** 生产=TickContext.getMyRooms()（注入避免 runtimeServices 依赖环）。 */
  readonly getRooms: () => readonly Room[];
  /** 直读 Memory 路径（不 ensure——查询零写）；默认实现见下。 */
  readonly getTasks?: () => Record<string, ResourceTransferTask>;
  readonly getReservations?: () => Record<string, {
    roomName: string;
    resource: string;
    holderId: string;
    amount: number;
    expiresAt: number;
  }>;
  readonly holderExists?: (holderId: string) => boolean;
  /** holder 身份解析（owner 声明验证用）。 */
  readonly resolveHolder?: (holderId: string) => TreasuryHolderResolution | undefined;
}

/** contract 接纳选项（Core Rewrite I：workKey 必填，业务任务身份）。 */
export interface TreasuryContractAuthorizationOptions {
  /** 受控业务任务键（`biz:` 前缀 + 调用方命名空间 + 业务键；活跃集合内排他）。 */
  readonly workKey: string;
  /** 受控外部消费者 key（closing 阶段须逐一幂等释放确认）。 */
  readonly externalConsumers?: readonly string[];
}

export interface TreasuryRearmCapabilityRequest {
  /** 前代 attempt ID（必须处于 retry_ready）。 */
  readonly attemptId: string;
}

export interface TreasurySettleRequest {
  readonly attemptId: string;
  /** adapter_reconcile：结论由 facade 调用注册 reconciler 得出（不可传入）。 */
  readonly evidenceKind: "adapter_reconcile" | "external_settlement_receipt";
  /** 仅 external_settlement_receipt 模式使用（受控外部对账通道）。 */
  readonly conclusion?: "executed" | "not_executed" | "still_uncertain";
}

/** 内核只读日志视图（活跃聚合 + ring 的深冻结投影）。 */
export interface TreasuryKernelJournalView {
  readonly health: TreasuryCoreStoreHealth;
  readonly legacyStores: readonly string[];
  readonly active: readonly TreasuryCoreWorkRecord[];
  readonly ring: readonly TreasuryCoreRingEntry[];
}

export interface TreasuryService {
  beginTick(): void;
  endTick(): void;
  observation(): TreasuryObservationView;
  beginFreshObservation(): TreasuryObservationView | null;
  commitments(): TreasuryCommitmentIndex;
  query(context: TreasuryQueryContext): TreasuryBalanceView;
  strictProjectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  strictProjectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** @deprecated 兼容别名：= strictProjectedUsedCapacity。 */
  projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** @deprecated 兼容别名：= riskAdjustedFreeCapacity。 */
  projectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  riskAdjustedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  projectionRevision(): number;
  metrics(): TreasuryMetrics;
  /** contract-first 接纳（唯一生产写入口）：admit 活跃聚合 + 签发正向执行许可。 */
  authorizeTreasuryActionContract(
    contract: unknown,
    options?: TreasuryContractAuthorizationOptions,
  ): TreasuryCoreAdmissionResult;
  /** 受控 dispatch：许可校验 → 发布 → 动作恰好一次 → 三种事实持久。 */
  executeAuthorizedDispatch(dispatch: unknown): TreasuryCoreDispatchOutcome;
  /** retry 许可（exact not-executed + 清理完成后才可签发）。 */
  issueTreasuryRearmCapability(
    request: TreasuryRearmCapabilityRequest,
  ): { readonly status: "ok"; readonly rearm: TreasuryCoreRearmPermit } | { readonly status: "rejected"; readonly reason: string };
  /** 消费 retry 许可：同语义 contract 建立下一代 attempt（新 ID/generation）。 */
  executeRearm(
    rearm: unknown,
    contract: unknown,
    options?: TreasuryContractAuthorizationOptions,
  ): TreasuryCoreAdmissionResult;
  /** 事后结算（outcome_unknown → committed/not_executed，须受控证据）。 */
  settleUnknownOutcome(request: TreasurySettleRequest): { readonly status: "ok" } | { readonly status: "still_uncertain" } | { readonly status: "rejected"; readonly reason: string };
  /** 安全关闭（retry 期限到期 / 业务显式放弃；执行未知的记录不可关闭）。 */
  closeWork(request: { readonly attemptId: string; readonly reason: "retry_expired" | "abandoned" }): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string };
  /** 本 tick 签发未消费的 dispatch 许可审计（heap 计数）。 */
  dispatchLeakAudit(): { readonly issuedThisTick: number; readonly unconsumed: number };
  /** 内核只读视图（零写）。 */
  kernelJournal(): TreasuryKernelJournalView;
  kernelMetrics(): TreasuryCoreKernelMetrics;
  resetForTest(): void;
}

// ── 查询侧 fail-closed 校验（语义与旧实现一致） ─────────────────────────────

const DEFAULT_LOCATION_KINDS: readonly TreasuryLocationKind[] = ["storage", "terminal"];
const VALID_QUERY_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
const QUERY_BOOLEAN_KEYS: ReadonlyArray<"allowProjected" | "allowIncoming" | "subtractOutgoing" | "subtractReservations"> = [
  "allowProjected",
  "allowIncoming",
  "subtractOutgoing",
  "subtractReservations",
];

function defaultGetTasks(): Record<string, ResourceTransferTask> {
  return Memory.data?.resourceControl?.tasks ?? {};
}

function defaultGetReservations(): Record<string, {
  roomName: string;
  resource: string;
  holderId: string;
  amount: number;
  expiresAt: number;
}> {
  return (Memory.runtime?.resourceReservations ?? {}) as Record<string, {
    roomName: string;
    resource: string;
    holderId: string;
    amount: number;
    expiresAt: number;
  }>;
}

function validateQueryContext(
  context: TreasuryQueryContext,
  governedRoomNames: ReadonlySet<string>,
): string | null {
  if (!context || typeof context !== "object") return "context 缺失";
  if (typeof context.resource !== "string" || !VALID_QUERY_RESOURCES.has(context.resource)) {
    return `resource 非法: ${String(context.resource)}`;
  }
  if (context.rooms !== undefined) {
    if (!Array.isArray(context.rooms)) return "rooms 必须为数组";
    if (context.rooms.length === 0) return "rooms 为空数组（空 room scope 非法）";
    const seen = new Set<string>();
    for (const roomName of context.rooms) {
      if (typeof roomName !== "string" || roomName.length === 0) {
        return `rooms 含非法房间名: ${String(roomName)}`;
      }
      if (seen.has(roomName)) return `rooms 含重复房间: ${roomName}`;
      if (!governedRoomNames.has(roomName)) {
        return `rooms 含非管辖房间（unknown/unowned）: ${roomName}`;
      }
      seen.add(roomName);
    }
  }
  if (context.locations !== undefined) {
    if (!Array.isArray(context.locations)) return "locations 必须为数组";
    if (context.locations.length === 0) return "locations 为空数组（空位置 scope 非法）";
    const seen = new Set<string>();
    for (const kind of context.locations) {
      if (kind !== "storage" && kind !== "terminal") {
        return `locations 含非法位置类型: ${String(kind)}`;
      }
      if (seen.has(kind)) return `locations 含重复位置: ${kind}`;
      seen.add(kind);
    }
  }
  for (const key of QUERY_BOOLEAN_KEYS) {
    const value = (context as unknown as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean") {
      return `${key} 必须为布尔（got ${typeof value}）`;
    }
  }
  if (context.withhold !== undefined) {
    if (
      typeof context.withhold !== "number" ||
      !Number.isSafeInteger(context.withhold) ||
      context.withhold < 0
    ) {
      return `withhold 必须为非负安全整数: ${String(context.withhold)}`;
    }
  }
  return null;
}

function resolveOwnerStatus(
  owner: TreasuryQueryOwner | undefined,
  resolveHolder: (holderId: string) => TreasuryHolderResolution | undefined,
): { valid: boolean; ownerRoom: string | undefined; ownerIdentity: TreasuryOwnerIdentity | undefined } {
  if (!owner) return { valid: true, ownerRoom: undefined, ownerIdentity: undefined };
  if (typeof owner !== "object") return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  if (owner.scope !== "production-reservation") return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  if (owner.ownerKind !== "game-object" && owner.ownerKind !== "logical-service") {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  if (typeof owner.ownerId !== "string" || owner.ownerId.length === 0 || owner.ownerId.length > 128) {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  if (typeof owner.roomName !== "string" || owner.roomName.length === 0) {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  if (owner.namespace !== undefined && (typeof owner.namespace !== "string" || owner.namespace.length === 0)) {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  const resolved = resolveHolder(owner.ownerId);
  if (resolved === undefined) return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  const runtimeKind = resolved.kind === "game-object" ? "game-object" : "logical-service";
  if (runtimeKind !== owner.ownerKind) return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  if (resolved.roomName !== owner.roomName) return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  if (owner.namespace !== undefined && owner.ownerId.startsWith(`${owner.namespace}:`) === false) {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  const ownerIdentity: TreasuryOwnerIdentity =
    owner.ownerKind === "logical-service"
      ? { kind: "logical-service", id: owner.ownerId, namespace: owner.namespace ?? owner.ownerId.split(":")[0], roomName: owner.roomName }
      : { kind: "game-object", id: owner.ownerId, roomName: owner.roomName };
  return { valid: true, ownerRoom: owner.roomName, ownerIdentity };
}

// ── 本 tick 投影 overlay（heap；每 tick 重建） ───────────────────────────────

interface TreasuryTickOverlay {
  /** 已发生（dispatch committed）的资源净变化：`room\0loc\0res` → delta。 */
  readonly resourceDeltas: Map<string, number>;
  /** 已发生的容量净变化（正流入占用）：`room\0loc` → delta。 */
  readonly capacityDeltas: Map<string, number>;
  /** admit 后 dispatch 前的 tentative 预留（防同 tick 超卖）。 */
  readonly tentativeResource: Map<string, number>;
  readonly tentativeCapacity: Map<string, number>;
}

function freshOverlay(): TreasuryTickOverlay {
  return {
    resourceDeltas: new Map(),
    capacityDeltas: new Map(),
    tentativeResource: new Map(),
    tentativeCapacity: new Map(),
  };
}

interface TreasuryTickState {
  tick: number;
  observation: TreasuryObservationView;
  commitmentIndex?: TreasuryCommitmentIndex;
  commitmentBuiltRevision?: number;
  ended: boolean;
}

interface PostingDelta {
  readonly roomName: string;
  readonly locationKind: string;
  readonly resource: string;
  readonly delta: number;
}

function overlayResourceKey(roomName: string, locationKind: string, resource: string): string {
  return `${roomName}\u0000${locationKind}\u0000${resource}`;
}

function overlayLocationKey(roomName: string, locationKind: string): string {
  return `${roomName}\u0000${locationKind}`;
}

/** service 实例代数（global reset / resetForTest 后 +1——permit 失效依据）。 */
let serviceGenerationCounter = 0;

export function createTreasuryService(deps: TreasuryServiceDeps): TreasuryService {
  const metrics = createTreasuryMetrics();
  const serviceGeneration = ++serviceGenerationCounter;
  const getTasks = deps.getTasks ?? defaultGetTasks;
  const getReservations = deps.getReservations ?? defaultGetReservations;
  const resolveHolder = deps.resolveHolder ?? resolveTreasuryHolder;

  let epochSeq = 0;
  let current: TreasuryTickState | null = null;
  let freshEpochsThisTick = 0;
  let overlay: TreasuryTickOverlay = freshOverlay();
  let overlayRevision = 0;
  /** 本 tick 签发的 dispatch 许可（leak audit 用）。 */
  let permitsIssuedThisTick = 0;
  const issuedPermits = new WeakSet<TreasuryCoreDispatchPermit>();

  function coreAdapterPort(kind: string): TreasuryCoreActionAdapterPort | undefined {
    const adapter = findTreasuryActionAdapter(kind);
    if (adapter === undefined) return undefined;
    return {
      kind: adapter.kind,
      version: adapter.version,
      registrationId: adapter.registrationId,
      semanticIdentity: adapter.semanticIdentity,
      execute: (args: unknown) => adapter.execute(args),
      settlesOnAccept: adapter.settlesOnAccept === true,
      nonOkOutcome: adapter.nonOkOutcome === "not_executed" ? "not_executed" : "unknown",
    };
  }

  function kernelOccupancyForAdmission(worstCase: readonly TreasuryCoreWorstCaseLeg[]): string | null {
    // 容量接纳检查（design §6.2）：物理观察 − 本 tick tentative/已发生占用
    // − kernel 活跃占用（跨 tick 风险），逐腿校验最坏流出可覆盖。
    const state = ensureTickState(true);
    const health = readTreasuryCoreStoreHealth();
    if (health.status === "healthy") {
      const occupancy = computeTreasuryCoreOccupancy(health.memory);
      for (const leg of worstCase) {
        const key = overlayResourceKey(leg.roomName, leg.locationKind, leg.resource);
        const tentativeOutflow = Math.max(0, -(overlay.tentativeResource.get(key) ?? 0));
        const appliedDelta = overlay.resourceDeltas.get(key) ?? 0;
        const available =
          state.observation.amount(leg.roomName, leg.locationKind as TreasuryLocationKind, leg.resource) +
          appliedDelta -
          tentativeOutflow -
          (occupancy.byKey.get(key) ?? 0);
        const legOutflow = Math.max(0, -leg.delta);
        if (available < legOutflow) {
          return `容量不足：${leg.roomName}/${leg.locationKind}/${leg.resource} 可用 ${String(available)} < 最坏流出 ${String(legOutflow)}`;
        }
        // 正流入容量占用（receiver capacity：同 tick 多笔不得重复占满接收空间）。
        const locationKey = overlayLocationKey(leg.roomName, leg.locationKind);
        const inflowOccupied =
          Math.max(0, overlay.capacityDeltas.get(locationKey) ?? 0) +
          Math.max(0, overlay.tentativeCapacity.get(locationKey) ?? 0);
        const freeCapacity =
          state.observation.freeCapacity(leg.roomName, leg.locationKind as TreasuryLocationKind) - inflowOccupied;
        const legInflow = worstCase
          .filter((l) => overlayLocationKey(l.roomName, l.locationKind) === locationKey)
          .reduce((sum, l) => sum + Math.max(0, l.delta), 0);
        if (legInflow > freeCapacity) {
          return `接收容量不足：${leg.roomName}/${leg.locationKind} 剩余 ${String(freeCapacity)} < 本笔最坏流入 ${String(legInflow)}`;
        }
      }
    }
    return null;
  }

  /** kernel 侧 unknown/closing 的最坏正流入容量占用（risk 口径输入）。 */
  function kernelUnknownInflowOccupancy(roomName: string, kind: TreasuryLocationKind): number {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return 0;
    let total = 0;
    for (const record of listTreasuryCoreActiveWorks(health.memory)) {
      if (record.phase !== "outcome_unknown" && record.phase !== "closing") continue;
      for (const leg of record.worstCase) {
        if (leg.roomName === roomName && leg.locationKind === kind) total += Math.max(0, leg.delta);
      }
    }
    return total;
  }

  const kernel = createTreasuryCoreKernel({
    nowTick: () => Game.time,
    runtimeGeneration: () => serviceGeneration,
    findAdapter: coreAdapterPort,
    checkAdmissionCapacity: kernelOccupancyForAdmission,
  });

  function ensureTickState(lazy: boolean): TreasuryTickState {
    if (current !== null && current.tick === Game.time) {
      metrics.observationReuseHits += 1;
      return current;
    }
    if (lazy) metrics.lifecycleLazyInitializations += 1;
    metrics.observationRebuilds += 1;
    epochSeq += 1;
    const observation = buildTreasuryObservation({
      scope: "shared",
      epochSeq,
      rooms: deps.getRooms(),
      onStoreScanned: (nonZeroKeys) => {
        metrics.storeEnumerations += 1;
        metrics.resourceKeysEnumerated += nonZeroKeys;
        metrics.nonZeroEntries += nonZeroKeys;
        metrics.locationsScanned += 1;
      },
    });
    current = { tick: Game.time, observation, ended: false };
    overlay = freshOverlay();
    freshEpochsThisTick = 0;
    permitsIssuedThisTick = 0;
    return current;
  }

  function buildIdentityFacts(contract: TreasuryActionContract): { status: "ok"; facts: TreasuryCoreIdentityFacts } | { status: "rejected"; reason: string } {
    const adapter = findTreasuryActionAdapter(contract.actionKind);
    if (adapter === undefined) return { status: "rejected", reason: `action kind ${contract.actionKind} 未注册` };
    const postingsText = contract.postings
      .map((p) => `${p.roomName}|${p.locationKind}|${p.resource}|${String(p.delta)}`)
      .join(",");
    const retryCanonical = adapter.retryFacts
      ? canonicalizeTreasuryAdapterRetryFacts(adapter.retryFacts(contract.args))
      : null;
    if (retryCanonical !== null && retryCanonical.status === "rejected") {
      return { status: "rejected", reason: `retry facts canonicalization 失败：${retryCanonical.detail}` };
    }
    const durable = adapter.durableFacts ? adapter.durableFacts(contract.args) : null;
    return {
      status: "ok",
      facts: {
        actionKind: contract.actionKind,
        adapterVersion: contract.adapterVersion,
        adapterRegistrationId: contract.adapterRegistrationId,
        adapterSemanticIdentity: contract.adapterSemanticIdentity,
        canonicalDigest: contract.digest,
        postingsDigest: hashTreasuryCanonicalString(postingsText).slice(0, 16),
        retryFactsDigest:
          retryCanonical !== null && retryCanonical.status === "canonicalized"
            ? hashTreasuryCanonicalString(retryCanonical.text).slice(0, 16)
            : null,
        durableFacts:
          durable === null
            ? null
            : { version: durable.version, payload: durable.payload.slice(0, 512) },
      },
    };
  }

  function worstCaseOfPostings(postings: readonly PostingDelta[]): TreasuryCoreWorstCaseLeg[] {
    const merged = new Map<string, TreasuryCoreWorstCaseLeg>();
    for (const posting of postings) {
      if (posting.delta >= 0) continue;
      const key = overlayResourceKey(posting.roomName, posting.locationKind, posting.resource);
      const existing = merged.get(key);
      const delta = posting.delta;
      merged.set(key, {
        roomName: posting.roomName,
        locationKind: posting.locationKind,
        resource: posting.resource,
        delta: (existing?.delta ?? 0) + delta,
      });
    }
    return [...merged.values()];
  }

  function applyTentativeHold(attemptId: string, postings: readonly PostingDelta[]): void {
    void attemptId;
    for (const posting of postings) {
      const key = overlayResourceKey(posting.roomName, posting.locationKind, posting.resource);
      overlay.tentativeResource.set(key, (overlay.tentativeResource.get(key) ?? 0) + posting.delta);
      const locKey = overlayLocationKey(posting.roomName, posting.locationKind);
      overlay.tentativeCapacity.set(locKey, (overlay.tentativeCapacity.get(locKey) ?? 0) + posting.delta);
    }
    overlayRevision += 1;
  }

  function releaseTentative(postings: readonly PostingDelta[], committed: boolean): void {
    for (const posting of postings) {
      const key = overlayResourceKey(posting.roomName, posting.locationKind, posting.resource);
      const remaining = (overlay.tentativeResource.get(key) ?? 0) - posting.delta;
      if (remaining === 0) overlay.tentativeResource.delete(key);
      else overlay.tentativeResource.set(key, remaining);
      const locKey = overlayLocationKey(posting.roomName, posting.locationKind);
      const remainingCap = (overlay.tentativeCapacity.get(locKey) ?? 0) - posting.delta;
      if (remainingCap === 0) overlay.tentativeCapacity.delete(locKey);
      else overlay.tentativeCapacity.set(locKey, remainingCap);
      if (committed) {
        // 世界效果已发生：本 tick 投影按实际 delta 修正（观察快照 stale）。
        overlay.resourceDeltas.set(key, (overlay.resourceDeltas.get(key) ?? 0) + posting.delta);
        overlay.capacityDeltas.set(locKey, (overlay.capacityDeltas.get(locKey) ?? 0) + posting.delta);
      }
    }
    overlayRevision += 1;
  }

  /**
   * policy withhold 检查（contract-first 接纳路径）：注册 policy resolver 的
   * withhold/strategicReserve 参与 per-resource 额度（保守扣减——不得自报）。
   * resolver 缺失/抛错/输出非法一律 fail closed 拒绝接纳。
   */
  function checkPolicyForAdmission(
    contract: TreasuryActionContract,
    worstCase: readonly TreasuryCoreWorstCaseLeg[],
    state: TreasuryTickState,
  ): { reasonCode: TreasuryCoreRejectionCode; reason: string } | null {
    void state;
    const resolver = findTreasuryPolicyResolver();
    if (resolver === undefined) {
      return { reasonCode: "policy_unavailable", reason: "无注册 policy resolver（fail closed：不得自报 withhold）" };
    }
    const rooms = [...new Set(worstCase.map((leg) => leg.roomName))];
    const ownerKey = contract.transactionId.length > 0 ? "contract:" + contract.digest.slice(0, 8) : "anonymous";
    for (const resource of new Set(worstCase.map((leg) => leg.resource))) {
      let decision: ReturnType<TreasuryRegisteredPolicyResolver["evaluate"]>;
      try {
        decision = resolver.evaluate({
          contractId: contract.contractId,
          contractDigest: contract.digest,
          actionKind: contract.actionKind,
          resource,
          rooms,
          ownerIdentity: ownerKey,
          tick: Game.time,
        });
      } catch (error) {
        return {
          reasonCode: "policy_fault",
          reason: "policy_fault：resolver 抛错 " + String(error instanceof Error ? error.message : error).slice(0, 96),
        };
      }
      if ("status" in decision) {
        return { reasonCode: "policy_violation", reason: "policy 拒绝：" + decision.reason };
      }
      const validated = validateTreasuryPolicyDecision(decision);
      if (validated !== null) {
        return { reasonCode: "policy_fault", reason: "policy_fault：" + validated };
      }
      const reserve = decision.withhold + decision.strategicReserve;
      for (const leg of worstCase.filter((l) => l.resource === resource && l.delta < 0)) {
        const outflow = -leg.delta;
        let roomObserved = 0;
        for (const kind of ["storage", "terminal"] as const) {
          roomObserved += state.observation.amount(leg.roomName, kind, resource);
        }
        if (roomObserved - reserve < outflow) {
          return {
            reasonCode: "insufficient_amount",
            reason:
              "policy 额度不足：" + resource + " 可支配 " + String(Math.max(0, roomObserved - reserve)) +
              "（policy withhold " + String(decision.withhold) + " + reserve " + String(decision.strategicReserve) + "）< 最坏流出 " + String(outflow),
          };
        }
      }
    }
    return null;
  }

  function postingsOfContract(contract: TreasuryActionContract): readonly PostingDelta[] {
    return contract.postings.map((p) => ({
      roomName: p.roomName,
      locationKind: p.locationKind,
      resource: p.resource,
      delta: p.delta,
    }));
  }

  const service: TreasuryService = {
    beginTick(): void {
      if (current !== null && current.tick === Game.time && !current.ended) {
        // 幂等重复 beginTick。
        kernel.beginTick();
        return;
      }
      metrics.lifecycleBeginTicks += 1;
      if (current !== null && current.tick !== Game.time) {
        // 上一 tick 缺 endTick：kernel 恢复承担补救（保守推进）。
        metrics.lifecycleMissingEndWarnings += 1;
      }
      // reservation schema activation gate（沿旧语义）：显式 beginTick 先于
      // 全部 planner/reservation writer 完成激活；失败不写数据、计数。
      const schemaGate = ensureReservationSchemaActivated();
      if (schemaGate.status === 'rejected') {
        metrics.reservationSchemaActivationFailures += 1;
      }
      kernel.beginTick();
      current = null;
      ensureTickState(false);
    },

    endTick(): void {
      const state = ensureTickState(true);
      if (state.ended) return;
      metrics.lifecycleEndTicks += 1;
      kernel.endTick();
      state.ended = true;
    },

    observation(): TreasuryObservationView {
      return ensureTickState(true).observation;
    },

    beginFreshObservation(): TreasuryObservationView | null {
      const state = ensureTickState(true);
      if (state.ended) return null;
      if (freshEpochsThisTick >= TREASURY_FRESH_EPOCH_LIMIT) {
        metrics.freshEpochLimitRejections += 1;
        return null;
      }
      metrics.freshObservationBuilds += 1;
      freshEpochsThisTick += 1;
      epochSeq += 1;
      return buildTreasuryObservation({
        scope: "market-fresh",
        epochSeq,
        rooms: deps.getRooms(),
        onStoreScanned: (nonZeroKeys) => {
          metrics.storeEnumerations += 1;
          metrics.resourceKeysEnumerated += nonZeroKeys;
          metrics.nonZeroEntries += nonZeroKeys;
          metrics.locationsScanned += 1;
        },
      });
    },

    commitments(): TreasuryCommitmentIndex {
      const state = ensureTickState(true);
      const revision = readTreasuryCommitmentRevision();
      if (
        state.commitmentIndex !== undefined &&
        state.commitmentBuiltRevision === revision
      ) {
        metrics.commitmentIndexQueries += 1;
        return state.commitmentIndex;
      }
      metrics.commitmentRebuilds += 1;
      const index = buildTreasuryCommitmentIndex({
        tick: Game.time,
        tasks: getTasks(),
        reservations: getReservations(),
        observation: state.observation,
        holderExists: deps.holderExists,
        capacityDelta: (roomName, kind) =>
          (overlay.capacityDeltas.get(overlayLocationKey(roomName, kind)) ?? 0) +
          kernelUnknownInflowOccupancy(roomName, kind),
        strictCapacityDelta: (roomName, kind) =>
          overlay.capacityDeltas.get(overlayLocationKey(roomName, kind)) ?? 0,
        onExpiredExcluded: () => {
          metrics.expiredCommitmentsExcluded += 1;
        },
        onMissingOwnerCommitted: () => {
          metrics.missingOwnerStillCommitted += 1;
        },
      });
      state.commitmentIndex = index;
      state.commitmentBuiltRevision = revision;
      metrics.commitmentRecords = index.metrics.taskRecords + index.metrics.reservationRecords;
      metrics.typedOwnerResolvedCount = index.metrics.typedOwnerResolved;
      metrics.legacyUnresolvedOwnerCount = index.metrics.legacyUnresolvedOwners;
      metrics.invalidCommitmentRecords = index.metrics.invalidCommitmentRecords;
      metrics.incompleteCommitmentScopes = index.metrics.incompleteCommitmentScopes;
      metrics.commitmentGloballyIncomplete = index.metrics.globallyIncomplete;
      return index;
    },

    query(context: TreasuryQueryContext): TreasuryBalanceView {
      const state = ensureTickState(true);
      const observation = state.observation;
      const invalidReason = validateQueryContext(context, new Set(observation.roomNames()));
      if (invalidReason !== null) {
        metrics.queryInvalidContexts += 1;
        return {
          resource: typeof context?.resource === "string" ? context.resource : String(context?.resource),
          observed: 0,
          projected: 0,
          committed: 0,
          incoming: 0,
          spendable: 0,
          overcommitted: true,
          ownerStatus: context?.owner ? "invalid_fail_closed" : "none",
          contextStatus: "invalid_fail_closed",
          commitmentStatus: "globally-incomplete",
          authorizationSafe: false,
          authorizationBlockers: ["invalid_context"],
          writeAdmission: { ready: false, blockers: ["invalid_context"] },
          epoch: observation.epoch,
        };
      }
      const rooms = Object.freeze([...(context.rooms ?? observation.roomNames())]);
      const kinds = Object.freeze([...(context.locations ?? DEFAULT_LOCATION_KINDS)]);
      const allowProjected = context.allowProjected !== false;

      let observed = 0;
      for (const roomName of rooms) {
        for (const kind of kinds) {
          observed += observation.amount(roomName, kind, context.resource);
        }
      }

      let projected = observed;
      if (allowProjected) {
        for (const roomName of rooms) {
          for (const kind of kinds) {
            const key = overlayResourceKey(roomName, kind, context.resource);
            projected += (overlay.resourceDeltas.get(key) ?? 0) + (overlay.tentativeResource.get(key) ?? 0);
          }
        }
      }

      const ownerCheck = resolveOwnerStatus(context.owner, resolveHolder);
      const ownerStatus: TreasuryOwnerStatus = !context.owner
        ? "none"
        : ownerCheck.valid
          ? "excluded-own-reservations"
          : "invalid_fail_closed";

      const commitments = service.commitments();
      let committed = 0;
      if (context.subtractOutgoing !== false) {
        for (const roomName of rooms) {
          committed += commitments.pendingOutgoing(roomName, context.resource);
        }
      }
      if (context.subtractReservations !== false) {
        for (const roomName of rooms) {
          const excludeOwner =
            ownerCheck.valid && ownerCheck.ownerIdentity && roomName === ownerCheck.ownerRoom
              ? ownerCheck.ownerIdentity
              : undefined;
          committed += commitments.reservedProduction(roomName, context.resource, excludeOwner);
        }
        // kernel 活跃占用（Core Rewrite I）：pending/dispatching/unknown/
        // closing(committed) 的最坏流出计入 committed（保守——可能已执行）。
        const kernelHealth = readTreasuryCoreStoreHealth();
        if (kernelHealth.status === "healthy") {
          const occupancy = computeTreasuryCoreOccupancy(kernelHealth.memory);
          if (occupancy.byKey.size > 0) {
            for (const roomName of rooms) {
              for (const kind of kinds) {
                const occupied = occupancy.byKey.get(overlayResourceKey(roomName, kind, context.resource)) ?? 0;
                if (occupied > 0) committed += occupied;
              }
            }
          }
        }
      }

      const incoming = context.allowIncoming
        ? rooms.reduce((sum, roomName) => sum + commitments.incoming(roomName, context.resource), 0)
        : 0;

      let commitmentStatus: TreasuryCommitmentCompleteness = "complete";
      if (commitments.completeness.globalIncomplete) {
        commitmentStatus = "globally-incomplete";
      } else {
        for (const roomName of rooms) {
          if (commitments.commitmentCompleteness(roomName, context.resource) !== "complete") {
            commitmentStatus = "incomplete-scope";
            break;
          }
        }
      }
      const commitmentComplete = commitmentStatus === "complete";

      const base = (allowProjected ? projected : observed) + incoming;
      const withhold = Math.max(0, context.withhold ?? 0);
      const authorizable = ownerCheck.valid && commitmentComplete;
      const rawSpendable = authorizable ? base - committed - withhold : 0;

      // authorizationSafe 联合判定（Core Rewrite I 口径）：owner/承诺完整性 +
      // kernel store 健康 + 旧业务数据兼容 + 共享 reservation store 健康。
      const blockers: string[] = [];
      if (!ownerCheck.valid && context.owner) blockers.push("invalid_owner");
      if (!commitmentComplete) blockers.push("commitment_incomplete");
      const kernelHealth = kernel.health();
      if (kernelHealth.status === "unhealthy") blockers.push("kernel_store_unhealthy");
      else if (kernelHealth.status === "incompatible") blockers.push("kernel_store_incompatible");
      if (kernel.legacyStores().length > 0) blockers.push("legacy_store_present");
      if (state.ended) blockers.push("lifecycle_closed");
      if (state.tick !== Game.time) blockers.push("stale_tick_state");
      if (!isReservationOwnerMigrationComplete()) blockers.push("reservation_migration_incomplete");
      const reservationHealth = validateReservationStoreHealth();
      if (!reservationHealth.healthy) blockers.push("reservation_store_unhealthy");
      const authorizationSafe = authorizable && blockers.length === 0;

      return {
        resource: context.resource,
        observed,
        projected,
        committed,
        incoming,
        spendable: Math.max(0, rawSpendable),
        overcommitted: !authorizable || rawSpendable < 0,
        ownerStatus,
        contextStatus: "valid",
        commitmentStatus,
        authorizationSafe,
        authorizationBlockers: blockers,
        writeAdmission: { ready: authorizationSafe, blockers },
        epoch: observation.epoch,
      };
    },

    strictProjectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      const state = ensureTickState(true);
      return (
        state.observation.usedCapacity(roomName, kind) +
        (overlay.capacityDeltas.get(overlayLocationKey(roomName, kind)) ?? 0) +
        (overlay.tentativeCapacity.get(overlayLocationKey(roomName, kind)) ?? 0)
      );
    },

    strictProjectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      const state = ensureTickState(true);
      return (
        state.observation.freeCapacity(roomName, kind) -
        (overlay.capacityDeltas.get(overlayLocationKey(roomName, kind)) ?? 0) -
        (overlay.tentativeCapacity.get(overlayLocationKey(roomName, kind)) ?? 0)
      );
    },

    projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      return service.strictProjectedUsedCapacity(roomName, kind);
    },

    projectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      return service.riskAdjustedFreeCapacity(roomName, kind);
    },

    riskAdjustedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      metrics.riskAdjustedCapacityLookups += 1;
      const state = ensureTickState(true);
      const locationKey = overlayLocationKey(roomName, kind);
      const kernelHealth = readTreasuryCoreStoreHealth();
      let kernelInflow = 0;
      if (kernelHealth.status === "healthy") {
        for (const record of listTreasuryCoreActiveWorks(kernelHealth.memory)) {
          // 可能已流入的 uncertain/committed 资源占用空间：按该位置最坏
          // 流入合计（receiver capacity 口径——正流入减少 free）。
          if (record.phase === "outcome_unknown" || record.phase === "closing") {
            for (const leg of record.worstCase) {
              if (leg.roomName === roomName && leg.locationKind === kind) {
                kernelInflow += Math.max(0, leg.delta);
              }
            }
          }
        }
      }
      return (
        state.observation.freeCapacity(roomName, kind) -
        (overlay.capacityDeltas.get(locationKey) ?? 0) -
        (overlay.tentativeCapacity.get(locationKey) ?? 0) -
        kernelInflow
      );
    },

    projectionRevision(): number {
      return overlayRevision;
    },

    metrics(): TreasuryMetrics {
      const contractCounters = readTreasuryActionContractCounters();
      const kernelM = kernel.metrics();
      return {
        ...metrics,
        transactionsRecorded: kernelM.counters.settledCommitted,
        transactionsRejectedInvalid: kernelM.counters.rejectedAdmissions,
        preparedActive: kernelM.activeCount,
        freshEpochLimitRejections: metrics.freshEpochLimitRejections,
        reservationSchemaActivationFailures:
          metrics.reservationSchemaActivationFailures + readReservationMutationCounters().schemaActivationFailures,
        reservationMutationRejections: readReservationMutationCounters().mutationRejections,
        reservationStoreHealthy: validateReservationStoreHealth().healthy,
        kernelActiveWorks: kernelM.activeCount,
        kernelUnknownWorks: kernelM.unknownCount,
        kernelRetryReadyWorks: kernelM.retryReadyCount,
        kernelRingEntries: kernelM.ringCount,
        kernelIssuanceFrontier: kernelM.frontier,
        kernelIssuanceBurned: kernelM.burned,
        contractsBuilt: contractCounters.built,
        contractsRejected: contractCounters.rejected,
      } as TreasuryMetrics;
    },

    authorizeTreasuryActionContract(
      contract: unknown,
      options?: TreasuryContractAuthorizationOptions,
    ): TreasuryCoreAdmissionResult {
      if (options === undefined || typeof options.workKey !== "string") {
        return { status: "rejected", reason: "接纳必须提供 workKey（业务任务身份）", reasonCode: "invalid_input" };
      }
      const verify = verifyTreasuryActionContractForAuthorization(contract);
      if (verify.status !== "ok") {
        return { status: "rejected", reason: `contract 无效：${verify.detail}`, reasonCode: "invalid_input" };
      }
      const typed = verify.contract;
      const identity = buildIdentityFacts(typed);
      if (identity.status === "rejected") {
        return { status: "rejected", reason: identity.reason, reasonCode: "invalid_input" };
      }
      const postings = postingsOfContract(typed);
      const worstCase = worstCaseOfPostings(postings);
      if (worstCase.length === 0) {
        return { status: "rejected", reason: "postings 无流出腿（worstCase 为空）", reasonCode: "invalid_input" };
      }
      const policyProblem = checkPolicyForAdmission(typed, worstCase, ensureTickState(true));
      if (policyProblem !== null) {
        metrics.transactionsRejectedInvalid += 1;
        return { status: "rejected", reason: policyProblem.reason, reasonCode: policyProblem.reasonCode };
      }
      const admission = kernel.admit({
        workKey: options.workKey,
        identity: identity.facts,
        worstCase,
        externalConsumers: options.externalConsumers ?? [],
        canonicalArgs: typed.args,
      });
      if (admission.status === "admitted") {
        applyTentativeHold(admission.attemptId, postings);
        permitsIssuedThisTick += 1;
        issuedPermits.add(admission.dispatch);
      }
      return admission;
    },

    executeAuthorizedDispatch(dispatch: unknown): TreasuryCoreDispatchOutcome {
      let postings: readonly PostingDelta[] | null = null;
      if (
        typeof dispatch === "object" &&
        dispatch !== null &&
        issuedPermits.has(dispatch as TreasuryCoreDispatchPermit)
      ) {
        // 记录本 permit 的 posting 形状（tentative 释放与 overlay 修正）。
        const adapter = findTreasuryActionAdapter((dispatch as TreasuryCoreDispatchPermit).actionKind);
        if (adapter !== undefined) {
          const args = (dispatch as TreasuryCoreDispatchPermit).canonicalArgs;
          postings = adapter.derivePostings(args).map((p) => ({
            roomName: p.roomName,
            locationKind: p.locationKind,
            resource: p.resource,
            delta: p.delta,
          }));
        }
      }
      const outcome = kernel.executeDispatch(dispatch);
      if (postings !== null && (outcome.status !== "rejected" || outcome.reason === "")) {
        // dispatch 已发生（前置拒绝/发布失败之外的一切）→ 释放 tentative；
        // committed 则按实际 delta 修正本 tick overlay。
        const committed = outcome.status === "committed" || (outcome.status === "persist_failed" && outcome.observed === "committed");
        releaseTentative(postings, committed);
      }
      return outcome;
    },

    issueTreasuryRearmCapability(request: TreasuryRearmCapabilityRequest) {
      return kernel.issueRearmPermit({ parentAttemptId: request.attemptId });
    },

    executeRearm(
      rearm: unknown,
      contract: unknown,
      options?: TreasuryContractAuthorizationOptions,
    ): TreasuryCoreAdmissionResult {
      const verify = verifyTreasuryActionContractForAuthorization(contract);
      if (verify.status !== "ok") {
        return { status: "rejected", reason: `contract 无效：${verify.detail}`, reasonCode: "invalid_input" };
      }
      const typed = verify.contract;
      const identity = buildIdentityFacts(typed);
      if (identity.status === "rejected") {
        return { status: "rejected", reason: identity.reason, reasonCode: "invalid_input" };
      }
      const postings = postingsOfContract(typed);
      const worstCase = worstCaseOfPostings(postings);
      const admission = kernel.executeRearm(rearm, {
        identity: identity.facts,
        worstCase,
        canonicalArgs: typed.args,
      });
      if (admission.status === "admitted") {
        applyTentativeHold(admission.attemptId, postings);
        permitsIssuedThisTick += 1;
        issuedPermits.add(admission.dispatch);
        void options;
      }
      return admission;
    },

    settleUnknownOutcome(request: TreasurySettleRequest) {
      // adapter_reconcile 证据的结论必须来自注册 reconciler 本身——facade
      // 内部调用（durable facts + 当前 shared observation），调用方不可传
      // conclusion（防伪造）。external_settlement_receipt 是显式外部对账
      // 通道（本轮真实 driver 禁用；结论由受控协作者传入并在证据中记录
      // 来源——接入真实 driver 前必须升级为受控 capability，见 design 限制）。
      let conclusion: "executed" | "not_executed" | "still_uncertain";
      let adapterIdentity: string | undefined;
      if (request.evidenceKind === "adapter_reconcile") {
        const h = readTreasuryCoreStoreHealth();
        if (h.status !== "healthy") {
          return { status: "rejected", reason: "kernel store 不可读" };
        }
        const record = h.memory.active[request.attemptId];
        if (record === undefined) return { status: "rejected", reason: "attempt 不在活跃集合" };
        const adapter = findTreasuryActionAdapter(record.identity.actionKind);
        if (
          adapter === undefined ||
          adapter.registrationId !== record.identity.adapterRegistrationId ||
          adapter.semanticIdentity !== record.identity.adapterSemanticIdentity
        ) {
          return { status: "rejected", reason: "reconciler 注册身份与聚合不一致" };
        }
        if (adapter.reconcile === undefined) {
          return { status: "rejected", reason: "该 action kind 未提供 reconciler" };
        }
        let raw: TreasuryActionReconcilerConclusion;
        try {
          raw = adapter.reconcile(
            {
              actionKind: record.identity.actionKind,
              transactionId: record.attemptId,
              contractId: "ac:" + record.identity.canonicalDigest,
              contractDigest: record.identity.canonicalDigest,
              adapterVersion: record.identity.adapterVersion,
              durablePayload: record.identity.durableFacts?.payload,
              durablePayloadVersion: record.identity.durableFacts?.version,
              postings: record.worstCase.map((leg) => ({
                roomName: leg.roomName,
                locationKind: leg.locationKind as "storage" | "terminal",
                resource: leg.resource,
                delta: leg.delta,
              })),
            },
            service.observation(),
          );
        } catch (error) {
          return { status: "rejected", reason: "reconciler 抛错：" + String(error instanceof Error ? error.message : error).slice(0, 96) };
        }
        conclusion = raw === "observed_committed" ? "executed" : raw === "observed_not_executed" ? "not_executed" : "still_uncertain";
        adapterIdentity = adapter.semanticIdentity;
      } else {
        if (request.conclusion === undefined) {
          return { status: "rejected", reason: "external_settlement_receipt 必须提供结论" };
        }
        conclusion = request.conclusion;
      }
      return kernel.settle({
        attemptId: request.attemptId,
        evidenceKind: request.evidenceKind,
        conclusion,
        adapterSemanticIdentity: adapterIdentity,
      });
    },

    closeWork(request: { readonly attemptId: string; readonly reason: "retry_expired" | "abandoned" }) {
      return kernel.closeWork(request);
    },

    dispatchLeakAudit(): { readonly issuedThisTick: number; readonly unconsumed: number } {
      return { issuedThisTick: permitsIssuedThisTick, unconsumed: permitsIssuedThisTick };
    },

    kernelJournal(): TreasuryKernelJournalView {
      const health = readTreasuryCoreStoreHealth();
      const active =
        health.status === "healthy"
          ? listTreasuryCoreActiveWorks(health.memory)
          : [];
      return {
        health,
        legacyStores: kernel.legacyStores(),
        active,
        ring: health.status === "healthy" ? health.memory.ring : [],
      };
    },

    kernelMetrics(): TreasuryCoreKernelMetrics {
      return kernel.metrics();
    },

    resetForTest(): void {
      const runtime = Memory.runtime as Record<string, unknown> | undefined;
      if (runtime && typeof runtime === "object") {
        delete runtime.treasuryCore;
      }
      current = null;
      overlay = freshOverlay();
      freshEpochsThisTick = 0;
      permitsIssuedThisTick = 0;
      epochSeq = 0;
      Object.assign(metrics, createTreasuryMetrics());
    },
  };

  return service;
}
