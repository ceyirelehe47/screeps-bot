/**
 * Treasury Facade——Core Rewrite II 装配层。
 *
 * 协议（openspec/changes/empire-treasury-core-rewrite，II 修订）：
 * - 写路径全部委托 treasury kernel（单一写入口状态机）：authorize =
 *   admit（活跃聚合 + 正向执行许可），execute = 受控 dispatch（许可校验 →
 *   dispatching 发布 → 动作恰好一次 → 三种事实分别持久）。
 * - 授权事实口径统一（§5）：查询严格口径、普通接纳、rearm 与执行前复验
 *   共用 authorizationFacts 的同一判定——观察 + applied overlay + 业务
 *   承诺 + 生产预留 + policy + kernel 占用（流出占存量、流入占接收容量）。
 *   tentative overlay 已删除：admit 后 active 记录即同 tick 扣减权威，
 *   同一责任唯一扣减归属（B09 不双扣）。
 * - 结算结论只来自注册 reconciler（facade 装配 reconcileOutcome 端口交给
 *   kernel 受控编排）；自报 external_settlement_receipt 通道不存在（R07）。
 * - pending 可安全取消（cancelPendingWork + beginTick 跨 tick sweep）；
 *   无受控释放端口时非空消费者义务的接纳被拒绝（R05）。
 * - 查询侧保持既有语义：observation（物理事实快照 + epoch）、commitments
 *  （任务/预留承诺索引）、query（fail-closed 输入 + owner 验证 +
 *   completeness）、容量四口径。查询视图返回独立深快照（不泄漏底层
 *   Memory 引用——R06）；查询路径零写。
 * - beginTick：kernel 恢复推进（保守化/跨 tick pending 取消/期限关闭/
 *   公平清理）+ 观察重建；endTick：kernel 收尾 + 残留保守化。
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
} from "@/runtime/treasury/policyAuthority";
import type { TreasuryActionContract } from "@/runtime/treasury/actionContracts";
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
  TreasuryCoreAdmissionContext,
  TreasuryCoreDispatchPermit,
  TreasuryCoreIdentityFacts,
  TreasuryCoreMemory,
  TreasuryCorePermitPosting,
  TreasuryCorePublicHealth,
  TreasuryCoreRearmPermit,
  TreasuryCoreRingEntry,
  TreasuryCoreWorkRecord,
} from "@/runtime/treasury/kernel/types";
import {
  readTreasuryCoreStoreHealth,
} from "@/runtime/treasury/kernel/store";
import {
  evaluateTreasuryAdmissionFacts,
  treasuryWorstCaseOfPostings,
  type TreasuryAdmissionFactSources,
  type TreasuryAdmissionVerdict,
  type TreasuryCandidateLeg,
} from "@/runtime/treasury/authorizationFacts";
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
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";

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

/** contract 接纳选项（workKey 必填，业务任务身份）。 */
export interface TreasuryContractAuthorizationOptions {
  /** 受控业务任务键（`biz:` 前缀 + 调用方命名空间 + 业务键；活跃集合内排他）。 */
  readonly workKey: string;
  /** 受控外部消费者 key（closing 阶段须逐一幂等释放确认；须有释放端口）。 */
  readonly externalConsumers?: readonly string[];
  /**
   * exact owner 声明（经验证后排除自己的生产预留——§5.3：只有验证过的
   * exact owner/作用域才能排除自己的那一项）。
   */
  readonly owner?: TreasuryQueryOwner;
}

export interface TreasuryRearmCapabilityRequest {
  /** 前代 attempt ID（必须处于 retry_ready）。 */
  readonly attemptId: string;
}

/** 安全取消请求：只结束确定未开始的当前 pending attempt（§6.1）。 */
export interface TreasuryCancelPendingRequest {
  readonly attemptId: string;
}

/** 内核只读日志视图（活跃聚合 + ring 的独立深快照；不含 memory 引用）。 */
export interface TreasuryKernelJournalView {
  readonly health: TreasuryCorePublicHealth;
  readonly legacyStores: readonly string[];
  readonly active: readonly TreasuryCoreWorkRecord[];
  readonly ring: readonly TreasuryCoreRingEntry[];
}

export interface TreasuryService {
  /** tick 起点：kernel 恢复推进（保守化/取消/期限关闭/公平清理）+ 观察重建（幂等）。 */
  beginTick(): { readonly recovered: number; readonly closed: number; readonly cleaned: number; readonly cancelled: number };
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
  /** 消费 retry 许可：同语义 contract 建立下一代 attempt（新 ID/generation；与普通接纳同一授权口径）。 */
  executeRearm(
    rearm: unknown,
    contract: unknown,
    options?: TreasuryContractAuthorizationOptions,
  ): TreasuryCoreAdmissionResult;
  /**
   * 事后结算（outcome_unknown → committed/not_executed）。结论由内核经
   * 受控 reconcileOutcome 端口（注册 reconciler）得出——调用者不可传入
   * 结论（external_settlement_receipt 自报通道已关闭，R07）。
   */
  settleUnknownOutcome(request: { readonly attemptId: string }): { readonly status: "ok" } | { readonly status: "still_uncertain" } | { readonly status: "rejected"; readonly reason: string };
  /** 安全取消：只结束确定未开始的当前 pending attempt（调用边界未开始）。 */
  cancelPendingWork(request: TreasuryCancelPendingRequest): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string };
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

// ── 本 tick 已发生效果 overlay（heap；每 tick 重建；无 tentative） ────────────

interface TreasuryTickOverlay {
  /** 已发生（dispatch committed / settle executed）的资源净变化：`room\0loc\0res` → delta。 */
  readonly resourceDeltas: Map<string, number>;
  /** 已发生的容量净变化（正流入占用）：`room\0loc` → delta。 */
  readonly capacityDeltas: Map<string, number>;
}

function freshOverlay(): TreasuryTickOverlay {
  return {
    resourceDeltas: new Map(),
    capacityDeltas: new Map(),
  };
}

interface TreasuryTickState {
  tick: number;
  observation: TreasuryObservationView;
  commitmentIndex?: TreasuryCommitmentIndex;
  commitmentBuiltRevision?: number;
  ended: boolean;
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
  /** 已签发未进入调用边界的许可 + 签发 tick（真实 leak 计数用）。 */
  const outstandingPermits = new Set<TreasuryCoreDispatchPermit>();
  const issuedTickOfPermit = new WeakMap<TreasuryCoreDispatchPermit, number>();

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

  function kernelOccupancyNow(options: {
    observation?: TreasuryObservationView;
    excludeAttemptId?: string;
  } = {}): { byKey: ReadonlyMap<string, number>; inflowByLocation: ReadonlyMap<string, number> } {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") {
      return { byKey: new Map(), inflowByLocation: new Map() };
    }
    // 观察覆盖判定锚点（§6.2）：世界序优先（同步生效模型精确判定），
    // tick 边界兜底（世界序缺失的旧记录保守占用）。
    const occupancy = computeTreasuryCoreOccupancy(health.memory, {
      observationWorldSequence: options.observation?.epoch.worldSequence,
      observationAsOfTick: options.observation?.epoch.observedAtTick,
      excludeAttemptId: options.excludeAttemptId,
    });
    return { byKey: occupancy.byKey, inflowByLocation: occupancy.inflowByLocation };
  }

  // ── 统一授权事实来源（接纳 / rearm / kernel 容量端口 / 执行前复验共用） ──
  //
  // R2/§4.1：判定只此一份——kernel 容量端口与 facade 入口消费同一公式与
  // 同一上下文（真实 contract 身份 + 验证 owner），不再有匿名二次裁决。
  // R5/§6.1：已确认未入观察的效果由 occupancy 承担（observationAsOfTick
  // 覆盖判定），实例本地 overlay 不参与授权。

  function buildAdmissionFactSources(
    state: TreasuryTickState,
    occupancy: { byKey: ReadonlyMap<string, number>; inflowByLocation: ReadonlyMap<string, number> },
    policyContext: {
      readonly contractId: string;
      readonly contractDigest: string;
      readonly actionKind: string;
      readonly ownerIdentity: TreasuryCoreAdmissionContext["ownerIdentity"];
    },
  ): TreasuryAdmissionFactSources {
    const ownerKeyForPolicy =
      policyContext.ownerIdentity !== null
        ? `${policyContext.ownerIdentity.kind}:${policyContext.ownerIdentity.id}`
        : "anonymous";
    return {
      observedAmount: (roomName, locationKind, resource) =>
        state.observation.amount(roomName, locationKind as TreasuryLocationKind, resource),
      observedFreeCapacity: (roomName, locationKind) =>
        state.observation.freeCapacity(roomName, locationKind as TreasuryLocationKind),
      occupancyOutflow: (roomName, locationKind, resource) =>
        occupancy.byKey.get(overlayResourceKey(roomName, locationKind, resource)) ?? 0,
      occupancyInflow: (roomName, locationKind) =>
        occupancy.inflowByLocation.get(overlayLocationKey(roomName, locationKind)) ?? 0,
      committedOutgoing: (roomName, resource) =>
        service.commitments().pendingOutgoing(roomName, resource),
      reservedProduction: (roomName, resource, excludeOwner) =>
        service.commitments().reservedProduction(roomName, resource, excludeOwner),
      policyReserve: (resource, rooms) => {
        const resolver = findTreasuryPolicyResolver();
        if (resolver === undefined) {
          return { status: "rejected" as const, reasonCode: "policy_unavailable" as const, reason: "无注册 policy resolver（fail closed：不得自报 withhold）" };
        }
        let decision: ReturnType<typeof resolver.evaluate>;
        try {
          decision = resolver.evaluate({
            contractId: policyContext.contractId,
            contractDigest: policyContext.contractDigest,
            actionKind: policyContext.actionKind,
            resource,
            rooms: [...rooms],
            ownerIdentity: ownerKeyForPolicy,
            tick: Game.time,
          });
        } catch (error) {
          return {
            status: "rejected" as const,
            reasonCode: "policy_fault" as const,
            reason: "policy_fault：resolver 抛错 " + String(error instanceof Error ? error.message : error).slice(0, 96),
          };
        }
        if ("status" in decision) {
          return { status: "rejected" as const, reasonCode: "policy_violation" as const, reason: "policy 拒绝：" + decision.reason };
        }
        const validated = validateTreasuryPolicyDecision(decision);
        if (validated !== null) {
          return { status: "rejected" as const, reasonCode: "policy_fault" as const, reason: "policy_fault：" + validated };
        }
        return { status: "ok" as const, reserve: decision.withhold + decision.strategicReserve };
      },
    };
  }

  /**
   * 共同授权判定（唯一公式）：接纳、rearm、kernel 容量端口与执行前复验
   * 都经此入口。context 携带真实 contract 身份、经验证 owner 与复验时的
   * 本笔排除（§4.3：本笔 pending 是"既有责任继续兑现"，不自我双扣）。
   */
  function evaluateAdmission(
    candidateLegs: readonly TreasuryCandidateLeg[],
    context: TreasuryCoreAdmissionContext,
  ): TreasuryAdmissionVerdict {
    const state = ensureTickState(true);
    const excludeOwner: TreasuryOwnerIdentity | undefined =
      context.ownerIdentity !== null
        ? (context.ownerIdentity as TreasuryOwnerIdentity)
        : undefined;
    const occupancy = kernelOccupancyNow({
      observation: state.observation,
      excludeAttemptId: context.excludeAttemptId,
    });
    const sources = buildAdmissionFactSources(state, occupancy, context);
    return evaluateTreasuryAdmissionFacts(sources, candidateLegs, {
      excludeOwner,
    });
  }

  /**
   * 执行前复验判定（§4.4）：使用**当前世界的 fresh 观察**（结构 incarnation
   * 与容量事实以执行时刻为准——同 tick 内结构消失/重建必须被拦截）；fresh
   * 额度（TREASURY_FRESH_EPOCH_LIMIT）耗尽时退回本 tick 缓存快照（有界退化，
   * 占用仍从 Memory 实时派生）。复验排除本笔自身占用（§4.3 不自我双扣）。
   */
  function evaluateRevalidation(
    candidateLegs: readonly TreasuryCandidateLeg[],
    context: TreasuryCoreAdmissionContext,
  ): { verdict: TreasuryAdmissionVerdict; observation: TreasuryObservationView } {
    const fresh = service.beginFreshObservation();
    const observation = fresh ?? ensureTickState(true).observation;
    const excludeOwner: TreasuryOwnerIdentity | undefined =
      context.ownerIdentity !== null
        ? (context.ownerIdentity as TreasuryOwnerIdentity)
        : undefined;
    const occupancy = kernelOccupancyNow({
      observation,
      excludeAttemptId: context.excludeAttemptId,
    });
    const sources = buildAdmissionFactSources(
      { tick: Game.time, observation, ended: false },
      occupancy,
      context,
    );
    return { verdict: evaluateTreasuryAdmissionFacts(sources, candidateLegs, { excludeOwner }), observation };
  }

  const kernel = createTreasuryCoreKernel({
    nowTick: () => Game.time,
    runtimeGeneration: () => serviceGeneration,
    findAdapter: coreAdapterPort,
    reconcileOutcome: (record) => {
      // 受控对账端口：内核唯一结算通道（§4.4）。reconciler 收到的是当前
      // attempt 的可信 durable facts/动作身份与当前有效观察——不是调用者
      // 拼出的另一笔事实。缺 adapter/身份不匹配/抛错/未知结论 → rejected
      //（unknown 保留，不转换成 not_executed）。
      // 跨 reset 匹配标准（design II §7.3）：kind + version + stable
      // semanticIdentity——registrationId 含 global 内注册序号，只证明同一
      // global 内实现未替换，不参与跨 reset 的 reconciler 解释权判定；
      // semanticIdentity 声明不变即作者承诺 reconcile 语义一致。
      const adapter = findTreasuryActionAdapter(record.identity.actionKind);
      if (
        adapter === undefined ||
        adapter.version !== record.identity.adapterVersion ||
        adapter.semanticIdentity !== record.identity.adapterSemanticIdentity
      ) {
        return { status: "rejected" as const, reason: "reconciler 语义身份与聚合不一致（stable semantic identity 匹配失败）" };
      }
      if (adapter.reconcile === undefined) {
        return { status: "rejected" as const, reason: "该 action kind 未提供 reconciler" };
      }
      let raw: string;
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
        return { status: "rejected" as const, reason: "reconciler 抛错：" + String(error instanceof Error ? error.message : error).slice(0, 96) };
      }
      if (raw !== "observed_committed" && raw !== "observed_not_executed" && raw !== "still_uncertain") {
        return { status: "rejected" as const, reason: "reconciler 返回未知结论（不转换）" };
      }
      const conclusion = raw === "observed_committed" ? "executed" : raw === "observed_not_executed" ? "not_executed" : "still_uncertain";
      return { status: "ok" as const, conclusion, source: adapter.semanticIdentity };
    },
    checkAdmissionCapacity: (worstCase, context) => {
      // kernel 侧容量端口（R2）：与接纳/复验同一判定、同一上下文——
      // context 携带真实 contract 身份与经验证 owner，不存在匿名口径。
      if (context === undefined) {
        return { reason: "接纳缺少授权上下文（拒绝——不允许匿名裁决）", reasonCode: "invalid_input" as const };
      }
      const state = ensureTickState(true);
      // 观察覆盖（§4.4）：动作目标位置必须被当前观察覆盖（结构存在）。
      const seenLocations = new Set<string>();
      for (const leg of worstCase) {
        const key = `${leg.roomName}\u0000${leg.locationKind}`;
        if (seenLocations.has(key)) continue;
        seenLocations.add(key);
        if (!state.observation.locationExists(leg.roomName, leg.locationKind as TreasuryLocationKind)) {
          return {
            reason: `观察未覆盖动作目标位置 ${leg.roomName}/${leg.locationKind}（结构不存在或不可控——fail closed）`,
            reasonCode: "structure_changed" as const,
          };
        }
      }
      const candidateLegs: TreasuryCandidateLeg[] = worstCase.map((leg) => ({
        roomName: leg.roomName,
        locationKind: leg.locationKind,
        resource: leg.resource,
        delta: leg.delta,
      }));
      const verdict = evaluateAdmission(candidateLegs, context);
      return verdict.status === "ok" ? null : { reason: verdict.reason, reasonCode: verdict.reasonCode as TreasuryCoreRejectionCode };
    },
  });

  /**
   * 共享授权窗口（C06/§4.4）：lifecycle.lastEndTick 是持久共享事实——
   * endTick 后本 tick 任何实例不得接纳/rearm/dispatch；恢复/安全清理仍按
   * 预算继续（kernel.beginTick 不受此限）。下一 tick 经正常入口开新窗口。
   */
  function admissionWindowOpen(): { status: "open" } | { status: "closed"; reason: string } {
    const health = readTreasuryCoreStoreHealth();
    if (health.status === "healthy" && health.memory.lifecycle.lastEndTick === Game.time) {
      return { status: "closed", reason: "本 tick 授权窗口已关闭（endTick 后不得接纳/执行/rearm；恢复与安全清理继续）" };
    }
    return { status: "open" };
  }

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
      outstandingPermits.clear();
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

  /** 候选原始 posting 腿（contract 派生；双向腿持久化用 treasuryWorstCaseOfPostings）。 */
  function candidateLegsOfContract(contract: TreasuryActionContract): TreasuryCandidateLeg[] {
    return contract.postings.map((p) => ({
      roomName: p.roomName,
      locationKind: p.locationKind,
      resource: p.resource,
      delta: p.delta,
    }));
  }

  /**
   * 构造完整授权上下文（R2/§4.1）：真实 contract 身份 + 验证 owner。
   * owner 声明非法时返回 rejected（fail closed）。
   */
  function buildAdmissionContext(
    contract: TreasuryActionContract,
    owner: TreasuryQueryOwner | undefined,
  ): { status: "ok"; context: TreasuryCoreAdmissionContext } | { status: "rejected"; reason: string } {
    const ownerCheck = resolveOwnerStatus(owner, resolveHolder);
    if (owner !== undefined && !ownerCheck.valid) {
      return { status: "rejected", reason: "owner 声明非法（fail closed）" };
    }
    return {
      status: "ok",
      context: {
        contractId: contract.contractId,
        contractDigest: contract.digest,
        actionKind: contract.actionKind,
        ownerIdentity:
          ownerCheck.valid && ownerCheck.ownerIdentity && owner !== undefined && ownerCheck.ownerRoom !== undefined
            ? (ownerCheck.ownerIdentity as TreasuryCoreAdmissionContext["ownerIdentity"])
            : null,
        excludeAttemptId: null,
      },
    };
  }

  /** 签发时观察的结构绑定快照（位置去重；复验比对 incarnation）。 */
  function structureBindingsOfLegs(
    legs: readonly TreasuryCandidateLeg[],
  ): readonly { roomName: string; locationKind: string; structureId: string }[] {
    const state = ensureTickState(true);
    const bindings: { roomName: string; locationKind: string; structureId: string }[] = [];
    const seen = new Set<string>();
    for (const leg of legs) {
      const key = `${leg.roomName}\u0000${leg.locationKind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const location = state.observation.location(leg.roomName, leg.locationKind as TreasuryLocationKind);
      if (location.exists && location.structureId !== undefined) {
        bindings.push({ roomName: leg.roomName, locationKind: leg.locationKind, structureId: location.structureId });
      }
    }
    return bindings;
  }

  /** 已确认效果进入本 tick overlay（世界效果已发生，观察快照 stale）。 */
  function applyCommittedPostings(postings: readonly TreasuryCorePermitPosting[]): void {
    for (const posting of postings) {
      const key = overlayResourceKey(posting.roomName, posting.locationKind, posting.resource);
      overlay.resourceDeltas.set(key, (overlay.resourceDeltas.get(key) ?? 0) + posting.delta);
      const locKey = overlayLocationKey(posting.roomName, posting.locationKind);
      overlay.capacityDeltas.set(locKey, (overlay.capacityDeltas.get(locKey) ?? 0) + posting.delta);
    }
    overlayRevision += 1;
  }

  const service: TreasuryService = {
    beginTick() {
      if (current !== null && current.tick === Game.time && !current.ended) {
        // 幂等重复 beginTick（预算经持久记账共享——B17）。
        return kernel.beginTick();
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
      const stats = kernel.beginTick();
      current = null;
      ensureTickState(false);
      // C06/§4.4：同 tick endTick 之后重复 beginTick（或第二实例）不得重开
      // 已关闭的授权窗口——恢复/清理照常按预算继续，接纳/执行仍拒绝。
      if (admissionWindowOpen().status === "closed" && current !== null) {
        current.ended = true;
      }
      return stats;
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
        // 容量占用口径（R5）：occupancy 流入投影（含未覆盖 committed 流入）；
        // strict 口径为展示值（overlay 缓存）。
        capacityDelta: (roomName, kind) =>
          kernelUnknownInflowOccupancy(roomName, kind, state.observation),
        strictCapacityDelta: (roomName, kind) =>
          Math.max(0, overlay.capacityDeltas.get(overlayLocationKey(roomName, kind)) ?? 0),
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

      // 本 tick 已发生的世界效果（applied overlay——展示缓存；授权判定由
      // occupancy 承担，R5。同一责任单次表达，不双扣）。
      let projected = observed;
      if (allowProjected) {
        for (const roomName of rooms) {
          for (const kind of kinds) {
            const key = overlayResourceKey(roomName, kind, context.resource);
            projected += overlay.resourceDeltas.get(key) ?? 0;
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
      // 统一扣减桶（§4.1：与接纳/执行/rearm 同一权威口径）：任务流出 +
      // 生产预留 + kernel 占用（pending/dispatching/unknown 的最坏流出 +
      // 未被当前观察覆盖的已确认流出——R5）。
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
        const occupancy = kernelOccupancyNow({ observation });
        if (occupancy.byKey.size > 0) {
          for (const roomName of rooms) {
            for (const kind of kinds) {
              const occupied = occupancy.byKey.get(overlayResourceKey(roomName, kind, context.resource)) ?? 0;
              if (occupied > 0) committed += occupied;
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

      // authorizationSafe 联合判定：owner/承诺完整性 + kernel store 健康 +
      // 旧业务数据兼容 + 共享 reservation store 健康 + policy 可用性
      // （C04/§4.5：严格查询的阻断条件与接纳/执行/rearm 同源——无注册
      // resolver 时不得宣称任何数字"可授权"）。
      const blockers: string[] = [];
      if (!ownerCheck.valid && context.owner) blockers.push("invalid_owner");
      if (!commitmentComplete) blockers.push("commitment_incomplete");
      if (findTreasuryPolicyResolver() === undefined) blockers.push("policy_unavailable");
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
        Math.max(0, overlay.capacityDeltas.get(overlayLocationKey(roomName, kind)) ?? 0)
      );
    },

    strictProjectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      const state = ensureTickState(true);
      return (
        state.observation.freeCapacity(roomName, kind) -
        Math.max(0, overlay.capacityDeltas.get(overlayLocationKey(roomName, kind)) ?? 0)
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
      // 统一占用口径（§6.1/R5）：unknown 的可能流入 + 未被当前观察覆盖的
      // 已确认流入都占接收容量（occupancy 投影），同一责任单次扣减。
      const kernelInflow = kernelUnknownInflowOccupancy(roomName, kind, state.observation);
      return state.observation.freeCapacity(roomName, kind) - kernelInflow;
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
      // 共享授权窗口（C06）：endTick 后本 tick 不再接纳（多实例共享事实）。
      const window = admissionWindowOpen();
      if (window.status === "closed") {
        return { status: "rejected", reason: window.reason, reasonCode: "lifecycle_closed" };
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
      const candidateLegs = candidateLegsOfContract(typed);
      const worstCase = treasuryWorstCaseOfPostings(candidateLegs);
      if (worstCase.length === 0) {
        return { status: "rejected", reason: "postings 为空（无可持久的动作腿）", reasonCode: "invalid_input" };
      }
      // 完整授权上下文（R2）：判定在 kernel 容量端口内以同一上下文完成——
      // facade 不再做第二份匿名预判。
      const context = buildAdmissionContext(typed, options.owner);
      if (context.status === "rejected") {
        metrics.transactionsRejectedInvalid += 1;
        return { status: "rejected", reason: context.reason, reasonCode: "invalid_input" };
      }
      const admission = kernel.admit({
        workKey: options.workKey,
        identity: identity.facts,
        worstCase,
        externalConsumers: options.externalConsumers ?? [],
        canonicalArgs: typed.args,
        postings: candidateLegs.map((leg) => ({ ...leg })),
        admissionContext: context.context,
        structureBindings: structureBindingsOfLegs(candidateLegs),
      });
      if (admission.status === "rejected" && admission.reasonCode === "capacity_insufficient") {
        metrics.transactionsRejectedInvalid += 1;
      }
      if (admission.status === "admitted") {
        permitsIssuedThisTick += 1;
        issuedPermits.add(admission.dispatch);
        outstandingPermits.add(admission.dispatch);
        issuedTickOfPermit.set(admission.dispatch, Game.time);
      }
      return admission;
    },

    executeAuthorizedDispatch(dispatch: unknown): TreasuryCoreDispatchOutcome {
      // 最终执行门禁（R3/§4.4）：许可对象有效不等于当前可执行——在进入
      // kernel 调用边界之前复验共享窗口、当前授权事实（policy/承诺/容量，
      // 排除本笔自身占用——§4.3 不自我双扣）与结构 incarnation。失败时
      // 动作调用为 0、不消费许可、记录保持 pending（可显式取消或按既定
      // 规则过期取消）。
      const window = admissionWindowOpen();
      if (window.status === "closed") {
        return { status: "blocked", reasonCode: "lifecycle_closed", reason: window.reason };
      }
      if (typeof dispatch !== "object" || dispatch === null) {
        return { status: "rejected", reason: "dispatch 许可对象缺失" };
      }
      const permit = dispatch as TreasuryCoreDispatchPermit;
      if (
        typeof permit.attemptId !== "string" ||
        typeof permit.canonicalDigest !== "string" ||
        typeof permit.actionKind !== "string" ||
        !Array.isArray(permit.postings) ||
        typeof permit.issuedAtTick !== "number" ||
        permit.issuedAtTick !== Game.time
      ) {
        // 形状预检：完整许可校验在 kernel（WeakSet 身份/冻结/generation）。
        return { status: "rejected", reason: "dispatch 许可形状不可信（kernel 终验前的前置拒绝）" };
      }
      // 复验（§4.4）：当前 policy/承诺/容量/结构事实——同一判定公式，
      // 排除本笔 pending 占用（既有责任继续兑现，不双扣）。
      const revalidation = evaluateRevalidation(
        permit.postings.map((p) => ({ roomName: p.roomName, locationKind: p.locationKind, resource: p.resource, delta: p.delta })),
        {
          contractId: `ac:${permit.canonicalDigest}`,
          contractDigest: permit.canonicalDigest,
          actionKind: permit.actionKind,
          ownerIdentity: permit.ownerIdentity,
          excludeAttemptId: permit.attemptId,
        },
      );
      if (revalidation.verdict.status === "rejected") {
        return { status: "blocked", reasonCode: revalidation.verdict.reasonCode, reason: `执行前复验失败：${revalidation.verdict.reason}` };
      }
      // 结构 incarnation（§4.4）：签发时的结构绑定必须与**当前世界**一致。
      for (const binding of Array.isArray(permit.structureBindings) ? permit.structureBindings : []) {
        const location = revalidation.observation.location(binding.roomName, binding.locationKind as TreasuryLocationKind);
        if (!location.exists || location.structureId !== binding.structureId) {
          return {
            status: "blocked",
            reasonCode: "structure_changed",
            reason: `动作目标结构已变化：${binding.roomName}/${binding.locationKind}（观察 incarnation 与签发时不一致）`,
          };
        }
      }
      const outcome = kernel.executeDispatch(dispatch);
      if (issuedPermits.has(permit)) {
        outstandingPermits.delete(permit);
      }
      // 已确认效果进入本 tick 展示 overlay（可重建缓存——授权判定由
      // occupancy 承担，R5；此缓存仅供 query projected 展示口径）。
      if (
        outcome.status === "committed" ||
        (outcome.status === "persist_failed" && outcome.observed === "committed")
      ) {
        if (issuedPermits.has(permit)) {
          applyCommittedPostings(permit.postings);
        }
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
      const window = admissionWindowOpen();
      if (window.status === "closed") {
        return { status: "rejected", reason: window.reason, reasonCode: "lifecycle_closed" };
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
      const candidateLegs = candidateLegsOfContract(typed);
      const worstCase = treasuryWorstCaseOfPostings(candidateLegs);
      // rearm 与新接纳同一授权口径（§4.1）：判定在 kernel 容量端口以真实
      // contract/owner 上下文完成——rearm 不继承前代余额或 policy 豁免。
      const context = buildAdmissionContext(typed, options?.owner);
      if (context.status === "rejected") {
        return { status: "rejected", reason: context.reason, reasonCode: "invalid_input" };
      }
      const admission = kernel.executeRearm(rearm, {
        identity: identity.facts,
        worstCase,
        canonicalArgs: typed.args,
        postings: candidateLegs.map((leg) => ({ ...leg })),
        admissionContext: context.context,
        structureBindings: structureBindingsOfLegs(candidateLegs),
      });
      if (admission.status === "admitted") {
        permitsIssuedThisTick += 1;
        issuedPermits.add(admission.dispatch);
        outstandingPermits.add(admission.dispatch);
        issuedTickOfPermit.set(admission.dispatch, Game.time);
      }
      return admission;
    },

    settleUnknownOutcome(request: { readonly attemptId: string }) {
      // adapter_reconcile 证据的结论由内核经受控 reconcileOutcome 端口调用
      // 注册 reconciler 得出——facade 到 kernel 的信任边界封闭；调用者
      // 只能指定 attempt，不能提交结论（R07）。
      return kernel.settle({ attemptId: request.attemptId });
    },

    cancelPendingWork(request: TreasuryCancelPendingRequest) {
      return kernel.cancelPending({ attemptId: request.attemptId });
    },

    closeWork(request: { readonly attemptId: string; readonly reason: "retry_expired" | "abandoned" }) {
      return kernel.closeWork(request);
    },

    dispatchLeakAudit(): { readonly issuedThisTick: number; readonly unconsumed: number } {
      // 未消费 = 本 tick 签发且尚未进入调用边界（进入 kernel 调用边界后
      // 从 outstanding 集合移除；跨 tick 许可本就失效）。
      let unconsumed = 0;
      for (const permit of outstandingPermits) {
        if (issuedTickOfPermit.get(permit) === Game.time) unconsumed += 1;
      }
      return { issuedThisTick: permitsIssuedThisTick, unconsumed };
    },

    kernelJournal(): TreasuryKernelJournalView {
      const health = readTreasuryCoreStoreHealth();
      // 独立深快照（R06/B22）：health 只给状态与有界诊断（不暴露 memory
      // 引用）；active/ring 逐条深冻结快照（与 Memory 无共享可变引用）。
      // R7：ring 非数组（healthy + ringDegraded 可达）不得使查询崩溃——
      // 返回空历史 + ringDegraded 诊断，首次调用零 Memory 写、不修环。
      const publicHealth: TreasuryCorePublicHealth =
        health.status === "healthy"
          ? { status: "healthy", reason: null, ringDegraded: health.ringDegraded }
          : health.status === "absent"
            ? { status: "absent", reason: null, ringDegraded: null }
            : { status: health.status, reason: health.reason, ringDegraded: null };
      const active: readonly TreasuryCoreWorkRecord[] =
        health.status === "healthy"
          ? listTreasuryCoreActiveWorks(health.memory).map((record) => treasuryBoundedDeepFreezeSnapshot(record) as TreasuryCoreWorkRecord)
          : [];
      const ringSource =
        health.status === "healthy" && Array.isArray(health.memory.ring) ? health.memory.ring : [];
      const ring: readonly TreasuryCoreRingEntry[] = ringSource.map(
        (entry) => treasuryBoundedDeepFreezeSnapshot(entry) as TreasuryCoreRingEntry,
      );
      return {
        health: Object.freeze(publicHealth),
        legacyStores: kernel.legacyStores(),
        active,
        ring,
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

  /** kernel 侧占用流入投影（unknown + 未覆盖 committed；统一 occupancy 口径）。 */
  function kernelUnknownInflowOccupancy(roomName: string, kind: TreasuryLocationKind, observation: TreasuryObservationView): number {
    return (
      kernelOccupancyNow({ observation }).inflowByLocation.get(overlayLocationKey(roomName, kind)) ?? 0
    );
  }

  return service;
}
