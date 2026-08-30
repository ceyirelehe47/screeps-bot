/**
 * Treasury Facade / Gateway——帝国国库统一入口。
 *
 * 显式 tick 生命周期（main.ts 固定挂载，业务模块不再决定首次构建时点）：
 *   beginTick（一切市场预检/生产/物流/规划之前）
 *     → receipt 清理（nextExpiryTick 未到则零扫描；满容绝不驱逐未过期条目）
 *     → reset 检测 → 归档补救（若上一 tick 缺 endTick）
 *     → 作废上一 tick 未决 prepare（跨 tick handle 一律失效）
 *     → 发行本 tick shared epoch（登记 epoch 注册表）→ 对账上一 tick 终态；
 *   endTick（本 tick 全部业务执行之后、最终 profiler flush 之前）
 *     → 归档投影终态（资源 finals + 结构 manifest）→ 关闭本 tick
 *     → 此后登记/prepare 一律拒绝 tick_closed、fresh 发行一律拒绝。
 *   observation()/commitments()/query() 仍可安全访问：未 begin 时走懒兜底
 *   （计数 lifecycleLazyInitializations，main 挂载后应恒为 0）。
 *
 * 登记门禁：transaction 携带决策 epoch 并通过注册表校验；注册表保存每个
 * epoch 的 exact immutable observation——transaction 的物理可行性验证使用
 * decision 指向的那一次观察（shared 或某次 market-fresh），绝不回退 shared。
 * 幂等（heap 本 tick + Memory receipt 跨 tick 与 global reset）优先于一切
 * 验证；endTick 后拒绝结算与 fresh 发行。
 *
 * 两阶段协议（第五轮 write-admission correctness）：prepare 在调用真实
 * Game 写动作**之前**完成全部 Treasury 侧验证，并预留资源、容量与 receipt
 * 槽位（tentative ledger——后续 prepare 与单阶段登记的授权计算都计入
 * tentative，同一资产不得被两笔 prepare 超额授权）；成功返回不可伪造的
 * prepared handle（heap 冻结对象 + 私有 registry 对象身份，tick 与
 * service generation 内有效）。Game API 失败 → abort（原子释放，零状态）；
 * 成功 → commit 执行 tentative → committed 兑现（不做业务 admission，
 * 不再因资源/容量/receipt 条件拒绝；prepare_invalidated 正常路径已删除）。
 * 相同 transactionId、相同 digest 重复 prepare 幂等返回同一 handle；
 * 不同 digest 返回 prepare_conflict。单阶段 recordAcceptedTransaction
 * 保留为兼容入口（同样计入 tentative，不得抢占 prepared 预留）。
 *
 * 门禁语义：不提供无上下文 available；查询输入（资源/房间/位置/withhold/
 * 布尔开关）非法或房间不在管辖集合（unknown/unowned room）时 fail closed；
 * owner 声明需 typed（holderKind 与运行时解析一致）、holder 真实存在且
 * 房间归属一致，否则 fail closed；spendable 非负且超卖显式 overcommitted；
 * 查询路径零写。
 *
 * fresh epoch 上限：每 tick market-fresh 发行数有硬上限（CPU 保护），超限
 * 拒绝并计数——fresh 观察是全房间扫描，无上限即无界 CPU 风险。
 */

import {
  buildTreasuryObservation,
} from "@/runtime/treasury/observation";
import {
  buildTreasuryCanonicalTransaction,
  computeTreasuryPayloadDigest,
  type TreasuryCanonicalTransaction,
} from "@/runtime/treasury/canonicalTransaction";
import {
  createTreasuryProjectionController,
  type TreasuryProjectionController,
  type TreasuryValidatedTransactionShape,
} from "@/runtime/treasury/projection";
import { buildTreasuryCommitmentIndex } from "@/runtime/treasury/commitments";
import {
  cleanupTreasuryReceipts,
  readTreasuryLifecycle,
  readTreasuryReceiptEventCounters,
  releaseAllTreasuryReceiptReservations,
  releaseTreasuryReceiptReservation,
  reserveTreasuryReceiptAdmission,
  writeTreasuryLifecycle,
} from "@/runtime/treasury/receipts";
import { resolveTreasuryHolder } from "@/runtime/treasury/holderResolution";
import { readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import {
  type TreasuryBalanceView,
  type TreasuryCommitmentIndex,
  type TreasuryEpoch,
  type TreasuryHolderResolution,
  type TreasuryJournalEntry,
  type TreasuryLocationKind,
  type TreasuryMetrics,
  type TreasuryObservationView,
  type TreasuryOwnerStatus,
  type TreasuryPreparedAbortResult,
  type TreasuryPreparedCommitResult,
  type TreasuryPreparedHandle,
  type TreasuryPreparedHandleState,
  type TreasuryPreparationResult,
  type TreasuryProjectedArchive,
  type TreasuryQueryContext,
  type TreasuryQueryOwner,
  type TreasuryRecordActionInput,
  type TreasuryReconciliationSummary,
  type TreasuryRejectedResult,
  type TreasurySettlementResult,
  type TreasuryTransactionInput,
  createTreasuryMetrics,
} from "@/runtime/treasury/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

/** 每 tick market-fresh epoch 发行上限（shared 不占额；CPU 保护）。 */
export const TREASURY_FRESH_EPOCH_LIMIT = 8;

/** 服务实例代际序号（模块级单调递增；跨实例 handle 一律无效）。 */
let treasuryServiceGenerationSeq = 0;
function nextTreasuryServiceGeneration(): number {
  treasuryServiceGenerationSeq += 1;
  return treasuryServiceGenerationSeq;
}

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
  /**
   * holder 身份解析（owner 声明验证用）：返回存在性与 typed 归属
   * （game-object / logical + 房间）。默认实现识别 `nuker:`/`synthesis:`
   * 逻辑名命名空间与裸 Game object id——logical holder 不再被误判 orphan。
   */
  readonly resolveHolder?: (holderId: string) => TreasuryHolderResolution | undefined;
}

/**
 * prepared handle 的内部记录：canonical transaction + 验证形状 + tentative
 * 预留 key + 签发上下文（tick/generation）。state 即 handle 状态机。
 */
interface PreparedTransaction {
  readonly handle: TreasuryPreparedHandle;
  readonly canonical: TreasuryCanonicalTransaction;
  readonly digest: string;
  readonly observation: TreasuryObservationView;
  readonly shape: TreasuryValidatedTransactionShape;
  readonly tentativeKey: string;
  readonly preparedAtTick: number;
  readonly generation: number;
  state: TreasuryPreparedHandleState;
}

export interface TreasuryService {
  /** tick 起点：发行 shared epoch + 对账 + receipt 清理（幂等，可重复调用）。 */
  beginTick(): void;
  /** tick 终点：归档投影终态并关闭本 tick（幂等；之后登记拒绝 tick_closed）。 */
  endTick(): void;
  /** shared observation：同 tick 缓存复用（不可变）。 */
  observation(): TreasuryObservationView;
  /**
   * market-fresh：每次独立构建并登记独立 epoch，不污染 shared 缓存。
   * endTick 后或本 tick fresh 数量达上限时返回 null（拒绝发行）。
   */
  beginFreshObservation(): TreasuryObservationView | null;
  /** 承诺统一索引：同 tick 缓存；权威 mutation 后按 revision 失效重建。 */
  commitments(): TreasuryCommitmentIndex;
  /** 带上下文余额查询（输入非法/owner 非法 fail closed）。 */
  query(context: TreasuryQueryContext): TreasuryBalanceView;
  /**
   * 两阶段 prepare：在调用真实 Game 写动作之前完成全部 Treasury 侧验证
   * （幂等/digest 冲突/epoch/格式/tentative 感知物理可行性）并预留资源、
   * 容量与 receipt 槽位。返回不可伪造的 prepared handle。
   */
  prepareTransaction(input: TreasuryTransactionInput): TreasuryPreparationResult;
  /**
   * 两阶段 commit：handle 验证（registry 对象身份 + generation + tick，
   * 不依赖调用方先 beginTick）后执行 tentative → committed 兑现——不做
   * 业务 admission，Game API 已返回 OK 后不再因业务条件拒绝。
   */
  commitPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedCommitResult;
  /** 两阶段 abort：原子释放 tentative 资源/容量/receipt 槽与 handle，零结算写入。 */
  abortPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedAbortResult;
  /** 唯一权威单阶段登记入口：多 posting 原子交易 + 决策 epoch 绑定 + 幂等。 */
  recordAcceptedTransaction(input: TreasuryTransactionInput): TreasurySettlementResult;
  /** 单 posting convenience（内部转 transaction；decision 与幂等语义相同）。 */
  recordAcceptedAction(input: TreasuryRecordActionInput): TreasurySettlementResult;
  /** 当前 tick journal 快照（冻结副本）。 */
  journal(): readonly TreasuryJournalEntry[];
  /** 最近一次跨 tick 对账结果。 */
  lastReconciliation(): TreasuryReconciliationSummary | null;
  /** projected 口径容量（observed ± 本 tick 已结算净变化；只读）。 */
  projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  projectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** 单调投影版本（本 tick 已接受 transaction 数驱动；诊断/缓存失效用）。 */
  projectionRevision(): number;
  metrics(): TreasuryMetrics;
  /** 仅供测试：清空全部 heap 状态（持久 receipt 用 clearTreasuryPersistenceForTest）。 */
  resetForTest(): void;
}

interface TreasuryTickState {
  tick: number;
  observation: TreasuryObservationView;
  commitmentIndex?: TreasuryCommitmentIndex;
  commitmentBuiltRevision?: number;
  ended: boolean;
  /** endTick（或补救）归档的投影终态 + 结构 manifest（供下一 tick 对账）。 */
  archived?: TreasuryProjectedArchive;
  lastReconciliation?: TreasuryReconciliationSummary;
}

const DEFAULT_LOCATION_KINDS: readonly TreasuryLocationKind[] = ["storage", "terminal"];
const VALID_QUERY_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
const VALID_HOLDER_KINDS: ReadonlySet<string> = new Set<string>(["game-object", "logical"]);
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

/**
 * 查询上下文 fail-closed 校验：非法资源、非法/重复/非管辖（unknown 或
 * unowned）房间、空 room/location scope、非法/重复位置、非有限非负
 * withhold、非布尔开关字段一律拒绝（重复条目会双倍累计，绝不静默去重；
 * 空 scope 是退化输入，不给"合法零集"错觉）。返回有界错误描述（null=合法）。
 */
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
    if (typeof context.withhold !== "number" || !Number.isFinite(context.withhold) || context.withhold < 0) {
      return `withhold 必须为有限非负数: ${String(context.withhold)}`;
    }
  }
  return null;
}

/**
 * owner 声明强化验证（typed，fail closed）：
 * - 格式（scope/holderKind/holderId/roomName）；
 * - holder 真实存在（运行时解析，logical 名走命名空间、game-object 走
 *   getObjectById）；
 * - 声明 holderKind 与运行时解析类型一致（防字符串冒充其他类型 owner）；
 * - 声明房间与 holder 真实归属一致。
 * 通过后返回归属房间——查询多房间时只在该房间排除该 holder 的预留。
 */
function resolveOwnerStatus(
  owner: TreasuryQueryOwner | undefined,
  resolveHolder: (holderId: string) => TreasuryHolderResolution | undefined,
): { valid: boolean; ownerRoom: string | undefined } {
  if (!owner) return { valid: true, ownerRoom: undefined };
  if (typeof owner !== "object") return { valid: false, ownerRoom: undefined };
  if (owner.scope !== "production-reservation") return { valid: false, ownerRoom: undefined };
  if (typeof owner.holderKind !== "string" || !VALID_HOLDER_KINDS.has(owner.holderKind)) {
    return { valid: false, ownerRoom: undefined };
  }
  if (typeof owner.holderId !== "string" || owner.holderId.length === 0 || owner.holderId.length > 64) {
    return { valid: false, ownerRoom: undefined };
  }
  if (typeof owner.roomName !== "string" || owner.roomName.length === 0) {
    return { valid: false, ownerRoom: undefined };
  }
  const resolved = resolveHolder(owner.holderId);
  if (resolved === undefined) return { valid: false, ownerRoom: undefined };
  if (resolved.kind !== owner.holderKind) return { valid: false, ownerRoom: undefined };
  if (resolved.roomName !== owner.roomName) return { valid: false, ownerRoom: undefined };
  return { valid: true, ownerRoom: owner.roomName };
}

export function createTreasuryService(deps: TreasuryServiceDeps): TreasuryService {
  const metrics = createTreasuryMetrics();
  const projection: TreasuryProjectionController = createTreasuryProjectionController({
    onDuplicateRejected: () => {
      metrics.duplicateSettlementsRejected += 1;
    },
    onInvalidRejected: (reason) => {
      metrics.transactionsRejectedInvalid += 1;
      if (reason === "receipt_capacity_exhausted") metrics.receiptCapacityRejections += 1;
    },
    onRecorded: (entry) => {
      metrics.transactionsRecorded += 1;
      metrics.postingsRecorded += entry.postings.length;
    },
    onReconciliation: (summary) => {
      metrics.reconciliationChecks += 1;
      metrics.reconciliationInflowMismatches += summary.inflowMismatches;
      metrics.reconciliationOutflowMismatches += summary.outflowMismatches;
      metrics.reconciliationStructuralChanges += summary.structuralChanges;
      if (summary.tickGap) metrics.tickGapReconciles += 1;
    },
  });

  let epochSeq = 0;
  let current: TreasuryTickState | null = null;
  let freshEpochsThisTick = 0;
  /**
   * 本 tick 发行的全部 epoch（shared 1 + fresh N）：登记校验的权威注册表。
   * 每个条目保存该 epoch 的 exact immutable observation——transaction 物理
   * 验证必须用 decision 指向的那一次观察，不得回退 shared。heap-only，
   * 每 tick 清空（global reset 后旧 epoch 全部不可恢复 → unknown_epoch）。
   */
  const epochRegistry = new Map<
    number,
    { scope: "shared" | "market-fresh"; observedAtTick: number; observation: TreasuryObservationView }
  >();
  /**
   * 两阶段 prepared handles（heap，tick 内有效）：
   * - handleRegistry（WeakSet）是 handle 防伪权威——只有本服务实例签发
   *   （且经对象身份注册）的 handle 能通过 commit/abort 验证；调用方构造
   *   结构相同的普通对象或 JSON round-trip 副本不在集合内，一律 invalid；
   * - preparedByHandle 保留全部 handle（含终态，供重复 commit/abort 幂等
   *   判定）；preparedById 只保留未终态记录（同 id 新 prepare 合法）；
   * - endTick/beginTick 全部作废（expired）并释放 tentative 与 receipt 预留。
   */
  const handleRegistry = new WeakSet<TreasuryPreparedHandle>();
  const preparedByHandle = new Map<TreasuryPreparedHandle, PreparedTransaction>();
  const preparedById = new Map<string, PreparedTransaction>();
  /** 服务实例代际：跨 service 实例的 handle 一律无效（global reset 防御）。 */
  const serviceGeneration = nextTreasuryServiceGeneration();

  /**
   * epochSeq 单点递增（每发行恰好 +1，无空洞——issueEpoch 只登记不递增）。
   */
  function nextEpochSeq(): number {
    epochSeq += 1;
    return epochSeq;
  }

  /** 登记 exact observation（两阶段：先递增取号、建观察，后入表）。 */
  function issueEpoch(
    scope: "shared" | "market-fresh",
    observation: TreasuryObservationView,
  ): TreasuryEpoch {
    epochRegistry.set(observation.epoch.epochSeq, {
      scope,
      observedAtTick: observation.epoch.observedAtTick,
      observation,
    });
    return observation.epoch;
  }

  function buildObservation(
    scope: "shared" | "market-fresh",
    epochSeqForBuild: number,
    previousArchive?: TreasuryProjectedArchive,
  ): { observation: TreasuryObservationView; reconciliation: TreasuryReconciliationSummary | null } {
    const observation = buildTreasuryObservation({
      scope,
      epochSeq: epochSeqForBuild,
      rooms: deps.getRooms(),
      onStoreScanned: (nonZeroKeys) => {
        metrics.storeEnumerations += 1;
        metrics.resourceKeysEnumerated += nonZeroKeys;
        metrics.nonZeroEntries += nonZeroKeys;
        metrics.locationsScanned += 1;
      },
    });
    if (scope === "shared") {
      metrics.observationRebuilds += 1;
      // 对账必须用 shared 观察（fresh 不参与对账链路）。
      return { observation, reconciliation: projection.reconcile(previousArchive, observation) };
    }
    metrics.freshObservationBuilds += 1;
    return { observation, reconciliation: null };
  }

  /**
   * 作废全部未决 prepare（tick 边界）：handle 转 expired 终态，释放全部
   * tentative 预留与 receipt 槽（零 journal 状态）。endTick 侧的审计
   * （outstanding 计数/样本/executing 严重故障）在 facade.endTick 内联。
   */
  function invalidatePreparedTransactions(): void {
    if (preparedById.size === 0) return;
    for (const record of preparedById.values()) {
      record.state = "expired";
    }
    preparedById.clear();
    projection.tentativeReleaseAll();
    releaseAllTreasuryReceiptReservations();
  }

  /** beginTick 的实际执行体（显式调用与懒兜底共享；调用方保证幂等检查）。 */
  function performBeginTick(lazy: boolean): TreasuryTickState {
    if (lazy) metrics.lifecycleLazyInitializations += 1;

    let previousArchive: TreasuryProjectedArchive | undefined;
    if (current) {
      if (!current.ended) {
        // 上一 tick 缺 endTick（异常/未挂载）：补救归档，显式计数不静默。
        metrics.lifecycleMissingEndWarnings += 1;
        current.archived = projection.archiveProjectedFinal(current.observation);
      }
      if (current.archived) {
        previousArchive = current.archived;
      }
    }

    // global reset 检测：heap 无前序状态，但 Memory 生命周期记录证明近期运行过。
    const lifecycle = readTreasuryLifecycle();
    const afterGlobalReset = current === null && lifecycle?.lastEndTick !== undefined;
    if (afterGlobalReset) metrics.globalResetRecoveries += 1;

    // 懒兜底路径保持查询零写：receipt 清理与 lifecycle 写入只在显式 beginTick
    // 执行（main 固定挂载后懒路径不应出现；出现也不得产生隐藏写入）。
    if (!lazy) {
      const cleanup = cleanupTreasuryReceipts(Game.time);
      metrics.receiptsEvictedByRetention += cleanup.retentionEvicted;
    }

    // 跨 tick prepared handle 一律作废（observation 是 tick 级物理快照，
    // 世界已变，必须重新 prepare）；fresh 计数随注册表一起重置。
    invalidatePreparedTransactions();
    epochRegistry.clear();
    freshEpochsThisTick = 0;
    const sharedEpochSeq = nextEpochSeq();
    const built = buildObservation("shared", sharedEpochSeq, previousArchive);
    issueEpoch("shared", built.observation);
    const reconciliation = built.reconciliation
      ? Object.freeze({ ...built.reconciliation, afterGlobalReset })
      : null;

    current = {
      tick: Game.time,
      observation: built.observation,
      ended: false,
      lastReconciliation: reconciliation ?? undefined,
    };
    metrics.lifecycleBeginTicks += 1;
    if (!lazy) writeTreasuryLifecycle({ lastBeginTick: Game.time });
    return current;
  }

  function ensureTickState(lazy: boolean): TreasuryTickState {
    if (current && current.tick === Game.time) return current;
    return performBeginTick(lazy);
  }

  /**
   * 决策 epoch 校验（单阶段登记与两阶段 prepare 共用）：必须命中本 tick
   * 注册表中的活跃 epoch 且 scope 一致。返回注册表条目或拒绝结果。
   */
  function resolveDecisionEpoch(
    decision: TreasuryTransactionInput["decision"],
  ): { registered: { scope: string; observedAtTick: number; observation: TreasuryObservationView } } | { rejection: TreasuryRejectedResult } {
    if (!decision || typeof decision !== "object") {
      metrics.staleEpochRejections += 1;
      return { rejection: { status: "rejected", reason: "stale_epoch", detail: "decision 缺失" } };
    }
    if (decision.observedAtTick !== Game.time) {
      metrics.staleEpochRejections += 1;
      return {
        rejection: {
          status: "rejected",
          reason: "stale_epoch",
          detail: `决策基于 tick ${String(decision.observedAtTick)} 的观察`,
        },
      };
    }
    const registered = epochRegistry.get(decision.epochSeq);
    if (registered === undefined) {
      metrics.unknownEpochRejections += 1;
      return {
        rejection: {
          status: "rejected",
          reason: "unknown_epoch",
          detail: `epochSeq ${String(decision.epochSeq)} 未在本 tick 注册`,
        },
      };
    }
    if (registered.scope !== decision.scope) {
      metrics.epochScopeMismatches += 1;
      return {
        rejection: {
          status: "rejected",
          reason: "scope_mismatch",
          detail: `epochSeq ${String(decision.epochSeq)} 注册为 ${registered.scope}，决策声明 ${decision.scope}`,
        },
      };
    }
    return { registered };
  }

  const service: TreasuryService = {
    beginTick(): void {
      if (current && current.tick === Game.time) return; // 幂等
      performBeginTick(false);
    },

    endTick(): void {
      if (!current || current.tick !== Game.time || current.ended) return; // 幂等
      current.archived = projection.archiveProjectedFinal(current.observation);
      current.ended = true;
      // tick 关闭：未决 prepare 全部作废（Game API 结果未知的动作留待
      // 对账发现；绝不跨 tick 保留 handle）。
      invalidatePreparedTransactions();
      metrics.lifecycleEndTicks += 1;
      writeTreasuryLifecycle({ lastEndTick: Game.time });
    },

    observation(): TreasuryObservationView {
      const state = ensureTickState(true);
      metrics.observationReuseHits += 1;
      return state.observation;
    },

    beginFreshObservation(): TreasuryObservationView | null {
      // 确保本 tick 生命周期已初始化（fresh epoch 必须登记进本 tick 注册表）。
      const state = ensureTickState(true);
      // endTick 后不得再发行 fresh epoch（tick 已关闭，fresh 决策无合法窗口）。
      if (state.ended) return null;
      // fresh 数量上限：fresh 观察是全房间扫描，无上限即无界 CPU 风险。
      if (freshEpochsThisTick >= TREASURY_FRESH_EPOCH_LIMIT) {
        metrics.freshEpochLimitRejections += 1;
        return null;
      }
      const freshEpochSeq = nextEpochSeq();
      const built = buildObservation("market-fresh", freshEpochSeq);
      issueEpoch("market-fresh", built.observation);
      freshEpochsThisTick += 1;
      return built.observation;
    },

    commitments(): TreasuryCommitmentIndex {
      const state = ensureTickState(true);
      const revision = readTreasuryCommitmentRevision();
      if (!state.commitmentIndex || state.commitmentBuiltRevision !== revision) {
        metrics.commitmentRebuilds += 1;
        const queriesBefore = state.commitmentIndex?.metrics.indexQueries ?? 0;
        state.commitmentIndex = buildTreasuryCommitmentIndex({
          tick: Game.time,
          tasks: (deps.getTasks ?? defaultGetTasks)(),
          reservations: (deps.getReservations ?? defaultGetReservations)(),
          observation: state.observation,
          holderExists: deps.holderExists,
          capacityDelta: (roomName, kind) => projection.locationCapacityDelta(roomName, kind),
          onExpiredExcluded: () => {
            metrics.expiredCommitmentsExcluded += 1;
          },
          onOrphanExcluded: () => {
            metrics.orphanReservationsExcluded += 1;
          },
        });
        state.commitmentBuiltRevision = revision;
        // facade 级累计：包含被替换索引的历史查询（跨重建累计口径）。
        metrics.commitmentIndexQueries += queriesBefore;
        metrics.commitmentRecords =
          state.commitmentIndex.metrics.taskRecords + state.commitmentIndex.metrics.reservationRecords;
      }
      return state.commitmentIndex;
    },

    query(context: TreasuryQueryContext): TreasuryBalanceView {
      const observation = this.observation();

      // 输入规范化 fail closed：非法资源/非管辖或重复房间/空 scope/非法布尔
      // 开关/NaN withhold 等一律返回保守全零视图（不报乐观可用量），并计数。
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
          epoch: observation.epoch,
        };
      }

      const rooms = context.rooms ?? observation.roomNames();
      const kinds = context.locations ?? DEFAULT_LOCATION_KINDS;
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
            projected += projection.projectedDelta(roomName, kind, context.resource);
          }
        }
      }

      const resolveHolder = deps.resolveHolder ?? resolveTreasuryHolder;
      const ownerCheck = resolveOwnerStatus(context.owner, resolveHolder);
      const ownerStatus: TreasuryOwnerStatus = !context.owner
        ? "none"
        : ownerCheck.valid
          ? "excluded-own-reservations"
          : "invalid_fail_closed";

      const commitments = this.commitments();
      let committed = 0;
      if (context.subtractOutgoing !== false) {
        for (const roomName of rooms) {
          committed += commitments.pendingOutgoing(roomName, context.resource);
        }
      }
      if (context.subtractReservations !== false) {
        for (const roomName of rooms) {
          // owner 自排除只发生在其合法归属房间；其他房间照常扣除全部预留。
          const excludeHolder =
            ownerCheck.valid && context.owner && roomName === ownerCheck.ownerRoom
              ? context.owner.holderId
              : undefined;
          committed += commitments.reservedProduction(roomName, context.resource, excludeHolder);
        }
      }

      const incoming = context.allowIncoming
        ? rooms.reduce((sum, roomName) => sum + commitments.incoming(roomName, context.resource), 0)
        : 0;

      const base = (allowProjected ? projected : observed) + incoming;
      const withhold = Math.max(0, context.withhold ?? 0);
      // fail closed：owner 非法时不给乐观可用量，只报保守结论。
      const rawSpendable = ownerCheck.valid ? base - committed - withhold : 0;

      return {
        resource: context.resource,
        observed,
        projected,
        committed,
        incoming,
        spendable: ownerCheck.valid ? Math.max(0, rawSpendable) : 0,
        overcommitted: !ownerCheck.valid || rawSpendable < 0,
        ownerStatus,
        contextStatus: "valid",
        epoch: observation.epoch,
      };
    },

    prepareTransaction(input: TreasuryTransactionInput): TreasuryPreparationResult {
      const state = ensureTickState(true);
      // 幂等优先：已结算 id 的重放（含重复 prepare 已 commit 的 id）。
      const settledAt = projection.isSettled(input.transactionId);
      if (settledAt !== undefined) {
        metrics.duplicateSettlementsRejected += 1;
        return { status: "already_settled", transactionId: input.transactionId, firstRecordedAtTick: settledAt };
      }
      // 相同 transactionId 的重复 prepare：canonical payload digest 比较——
      // digest 相同幂等返回同一 handle；不同则 prepare_conflict（同一 id 只
      // 能绑定一个 canonical payload，绝不能"ID 相同就无条件返回 prepared"）。
      const canonical = buildTreasuryCanonicalTransaction(input);
      const digest = computeTreasuryPayloadDigest(canonical);
      metrics.digestGenerations += 1;
      const existingPrepare = preparedById.get(input.transactionId);
      if (existingPrepare) {
        if (existingPrepare.digest !== digest) {
          metrics.prepareConflicts += 1;
          return {
            status: "rejected",
            reason: "prepare_conflict",
            detail: `transactionId 已绑定不同 canonical payload（既有 digest ${existingPrepare.digest}，新 digest ${digest}）`,
          };
        }
        return {
          status: "prepared",
          handle: existingPrepare.handle,
          transactionId: input.transactionId,
          preparedAtTick: existingPrepare.preparedAtTick,
          digest,
        };
      }
      if (state.ended) {
        metrics.settlementsAfterEndRejected += 1;
        return { status: "rejected", reason: "tick_closed", detail: `tick ${Game.time} 已 endTick` };
      }
      const decision = resolveDecisionEpoch(input.decision);
      if ("rejection" in decision) {
        return { status: "rejected", reason: decision.rejection.reason, detail: decision.rejection.detail };
      }
      // 完整验证（格式/合并/tentative 感知物理可行性）在占用任何槽位之前
      // ——无效输入不得预留；新 prepare 的授权计算计入全部既有 tentative。
      const validation = projection.validateTransaction(input, decision.registered.observation);
      if (validation.status === "invalid") {
        metrics.transactionsRejectedInvalid += 1;
        return { status: "rejected", reason: validation.result.reason, detail: validation.result.detail };
      }
      // admission 预留：成功即占一个容量槽（commit 兑现不再因容量被拒）。
      const reservation = reserveTreasuryReceiptAdmission(input.transactionId, Game.time);
      if (reservation.status === "already_settled") {
        metrics.duplicateSettlementsRejected += 1;
        return {
          status: "already_settled",
          transactionId: input.transactionId,
          firstRecordedAtTick: reservation.firstSettledAtTick,
        };
      }
      if (reservation.status === "rejected") {
        metrics.transactionsRejectedInvalid += 1;
        if (reservation.reason === "receipt_capacity_exhausted") metrics.receiptCapacityRejections += 1;
        return { status: "rejected", reason: reservation.reason, detail: reservation.detail };
      }
      // 签发不可伪造 handle（冻结对象 + 私有 registry 对象身份注册）并
      // 登记 tentative 资源/容量预留。
      const handle: TreasuryPreparedHandle = Object.freeze({
        __brand: "treasury-prepared-handle",
        transactionId: input.transactionId,
        digest,
      });
      const record: PreparedTransaction = {
        handle,
        canonical,
        digest,
        observation: decision.registered.observation,
        shape: validation.shape,
        tentativeKey: `prepare:${input.transactionId}`,
        preparedAtTick: Game.time,
        generation: serviceGeneration,
        state: "prepared",
      };
      handleRegistry.add(handle);
      preparedByHandle.set(handle, record);
      preparedById.set(input.transactionId, record);
      projection.tentativeHold(record.tentativeKey, validation.shape);
      metrics.transactionsPrepared += 1;
      return {
        status: "prepared",
        handle,
        transactionId: input.transactionId,
        preparedAtTick: record.preparedAtTick,
        digest,
      };
    },

    commitPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedCommitResult {
      // handle 自行验证（不依赖调用方先 beginTick）：对象身份 → generation
      // → 状态机 → 签发 tick（跨 tick 一律 expired）。
      const invalid = (detail: string): TreasuryPreparedCommitResult => {
        metrics.invalidHandleRejections += 1;
        return { status: "rejected", reason: "invalid_handle", detail };
      };
      if (!handle || typeof handle !== "object" || !handleRegistry.has(handle)) {
        return invalid("handle 未在本服务实例签发（伪造对象/JSON 副本/跨实例 handle 一律无效）");
      }
      const record = preparedByHandle.get(handle);
      if (!record || record.generation !== serviceGeneration) {
        return invalid("handle 代际不匹配");
      }
      if (record.state === "expired" || record.preparedAtTick !== Game.time) {
        return {
          status: "rejected",
          reason: "handle_expired",
          detail: `handle 于 tick ${String(record.preparedAtTick)} 签发，当前 tick ${String(Game.time)}（tick 边界作废）`,
        };
      }
      if (record.state === "committed") {
        const settledAt = projection.isSettled(record.canonical.transactionId);
        return settledAt !== undefined
          ? { status: "already_settled", transactionId: record.canonical.transactionId, firstRecordedAtTick: settledAt }
          : invalid("handle 已 committed 但 receipt 缺失（内部不一致）");
      }
      if (record.state === "aborted") {
        return { status: "rejected", reason: "handle_finalized", detail: "handle 已 aborted，不可 commit" };
      }
      if (record.state === "faulted") {
        return { status: "rejected", reason: "handle_faulted", detail: "handle 所在 commit 发生意外的内部写故障" };
      }
      if (record.state === "executing" || record.state === "committing") {
        return invalid(`handle 处于 ${record.state} 状态，不可重入`);
      }
      // tentative → committed 兑现（无业务 admission；资源/容量/槽位已预留）。
      record.state = "committing";
      const result = projection.commitPreparedTransaction(
        record.canonical,
        record.shape,
        record.tentativeKey,
      );
      if (result.status === "recorded") {
        record.state = "committed";
        preparedById.delete(record.canonical.transactionId);
        metrics.preparedCommits += 1;
        return { status: "committed", transactionId: result.transactionId, postings: result.postings, tick: result.tick };
      }
      if (result.status === "already_settled") {
        // prepare→commit 之间被同 id 结算（合法竞态）：handle 终态化并释放
        // tentative 预留（该 id 的结算事实已存在）。
        record.state = "committed";
        preparedById.delete(record.canonical.transactionId);
        projection.tentativeRelease(record.tentativeKey);
        releaseTreasuryReceiptReservation(record.canonical.transactionId);
        return result;
      }
      // 理论不可达（commit 路径无业务 admission）：按内部故障处理。
      record.state = "faulted";
      metrics.transactionsRejectedInvalid += 1;
      return { status: "rejected", reason: "handle_faulted", detail: result.detail };
    },

    abortPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedAbortResult {
      const invalid = (detail: string): TreasuryPreparedAbortResult => {
        metrics.invalidHandleRejections += 1;
        return { status: "rejected", reason: "invalid_handle", detail };
      };
      if (!handle || typeof handle !== "object" || !handleRegistry.has(handle)) {
        return invalid("handle 未在本服务实例签发（伪造对象/JSON 副本/跨实例 handle 一律无效）");
      }
      const record = preparedByHandle.get(handle);
      if (!record || record.generation !== serviceGeneration) {
        return invalid("handle 代际不匹配");
      }
      if (record.state === "expired" || record.preparedAtTick !== Game.time) {
        return {
          status: "rejected",
          reason: "handle_expired",
          detail: `handle 于 tick ${String(record.preparedAtTick)} 签发，当前 tick ${String(Game.time)}（tick 边界作废）`,
        };
      }
      if (record.state === "committed") {
        const settledAt = projection.isSettled(record.canonical.transactionId);
        return {
          status: "already_finalized",
          transactionId: record.canonical.transactionId,
          finalizedAs: "committed",
          committedAtTick: settledAt ?? record.preparedAtTick,
        };
      }
      if (record.state === "aborted") {
        return { status: "already_finalized", transactionId: record.canonical.transactionId, finalizedAs: "aborted" };
      }
      if (record.state === "faulted") {
        return { status: "rejected", reason: "handle_faulted", detail: "faulted handle 的预留不释放（对账前保持占用）" };
      }
      if (record.state === "executing" || record.state === "committing") {
        return invalid(`handle 处于 ${record.state} 状态，不可 abort`);
      }
      // 原子释放：tentative 资源/容量 + receipt 槽 + handle 终态；不写
      // settled receipt / committed journal / overlay / projected capacity。
      record.state = "aborted";
      preparedById.delete(record.canonical.transactionId);
      projection.tentativeRelease(record.tentativeKey);
      releaseTreasuryReceiptReservation(record.canonical.transactionId);
      metrics.transactionPreparesAborted += 1;
      return { status: "aborted", transactionId: record.canonical.transactionId };
    },

    recordAcceptedTransaction(input: TreasuryTransactionInput): TreasurySettlementResult {
      const state = ensureTickState(true);
      // 幂等优先于一切：已结算 id 的重放无论决策上下文一律 already_settled。
      const settledAt = projection.isSettled(input.transactionId);
      if (settledAt !== undefined) {
        metrics.duplicateSettlementsRejected += 1;
        return { status: "already_settled", transactionId: input.transactionId, firstRecordedAtTick: settledAt };
      }
      if (state.ended) {
        metrics.settlementsAfterEndRejected += 1;
        return { status: "rejected", reason: "tick_closed", detail: `tick ${Game.time} 已 endTick` };
      }
      const decision = resolveDecisionEpoch(input.decision);
      if ("rejection" in decision) return decision.rejection;
      const registered = decision.registered;
      // 物理可行性验证使用 decision 指向的 exact observation（绝不回退 shared）。
      return projection.recordTransaction(input, registered.observation);
    },

    recordAcceptedAction(input: TreasuryRecordActionInput): TreasurySettlementResult {
      return this.recordAcceptedTransaction({
        transactionId: input.transactionId,
        kind: input.kind,
        source: input.source,
        decision: input.decision,
        postings: [
          {
            roomName: input.roomName,
            locationKind: input.locationKind,
            resource: input.resource,
            delta: input.delta,
          },
        ],
      });
    },

    journal(): readonly TreasuryJournalEntry[] {
      return projection.journalSnapshot();
    },

    lastReconciliation(): TreasuryReconciliationSummary | null {
      return current?.lastReconciliation ?? null;
    },

    projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      return this.observation().usedCapacity(roomName, kind) + projection.locationCapacityDelta(roomName, kind);
    },

    projectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      return this.observation().freeCapacity(roomName, kind) - projection.locationCapacityDelta(roomName, kind);
    },

    projectionRevision(): number {
      return projection.projectionRevision();
    },

    metrics(): TreasuryMetrics {
      const liveIndex = current?.commitmentIndex;
      const liveQueries = liveIndex?.metrics.indexQueries ?? 0;
      const receiptCounters = readTreasuryReceiptEventCounters();
      const tentativeKeys = projection.tentativeKeyCounts();
      return {
        ...metrics,
        commitmentIndexQueries: metrics.commitmentIndexQueries + liveQueries,
        preparedActive: preparedById.size,
        tentativeResourceKeys: tentativeKeys.resourceKeys,
        tentativeCapacityKeys: tentativeKeys.capacityKeys,
        receiptStoreMigrationsExecuted: receiptCounters.migrationsExecuted,
        receiptStoreIncompatibleFailures: receiptCounters.incompatibleFailures,
        receiptFullScans: receiptCounters.receiptFullScans,
        receiptAdmissionFastPaths: receiptCounters.admissionFastPaths,
        receiptAdmissionFullStoreBlocked: receiptCounters.admissionFullStoreBlocked,
        receiptExpiryCleanupScans: receiptCounters.expiryCleanupScans,
        receiptSlotsRemaining: receiptCounters.slotsRemaining,
        receiptNextExpiryTick: receiptCounters.nextExpiryTick,
      };
    },

    resetForTest(): void {
      const keys = Object.keys(metrics) as Array<keyof TreasuryMetrics>;
      for (const key of keys) metrics[key] = 0;
      projection.resetForTest();
      epochSeq = 0;
      current = null;
      freshEpochsThisTick = 0;
      epochRegistry.clear();
      preparedByHandle.clear();
      preparedById.clear();
    },
  };

  return service;
}
