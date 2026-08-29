/**
 * Treasury Facade / Gateway——帝国国库统一入口。
 *
 * 显式 tick 生命周期（main.ts 固定挂载，业务模块不再决定首次构建时点）：
 *   beginTick（一切市场预检/生产/物流/规划之前）
 *     → receipt 清理（retention 过期回收；满容绝不驱逐未过期条目）
 *     → reset 检测 → 归档补救（若上一 tick 缺 endTick）
 *     → 发行本 tick shared epoch（登记 epoch 注册表）→ 对账上一 tick 终态；
 *   endTick（本 tick 全部业务执行之后、最终 profiler flush 之前）
 *     → 归档投影终态（资源 finals + 结构 manifest）→ 关闭本 tick
 *     → 此后登记一律拒绝 tick_closed、fresh 发行一律拒绝。
 *   observation()/commitments()/query() 仍可安全访问：未 begin 时走懒兜底
 *   （计数 lifecycleLazyInitializations，main 挂载后应恒为 0）。
 *
 * 登记门禁：transaction 携带决策 epoch 并通过注册表校验；注册表保存每个
 * epoch 的 exact immutable observation——transaction 的物理可行性验证使用
 * decision 指向的那一次观察（shared 或某次 market-fresh），绝不回退 shared。
 * 幂等（heap 本 tick + Memory receipt 跨 tick 与 global reset）优先于一切
 * 验证；endTick 后拒绝结算与 fresh 发行。
 *
 * 门禁语义：不提供无上下文 available；查询输入（资源/房间/位置/withhold）
 * 非法时 fail closed；owner 声明需 holder 真实存在且房间归属一致，否则
 * fail closed；spendable 非负且超卖显式 overcommitted；查询路径零写。
 */

import {
  buildTreasuryObservation,
} from "@/runtime/treasury/observation";
import {
  createTreasuryProjectionController,
  type TreasuryProjectionController,
} from "@/runtime/treasury/projection";
import { buildTreasuryCommitmentIndex } from "@/runtime/treasury/commitments";
import {
  cleanupTreasuryReceipts,
  readTreasuryLifecycle,
  readTreasuryReceiptEventCounters,
  writeTreasuryLifecycle,
} from "@/runtime/treasury/receipts";
import { readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import {
  type TreasuryBalanceView,
  type TreasuryCommitmentIndex,
  type TreasuryEpoch,
  type TreasuryJournalEntry,
  type TreasuryLocationKind,
  type TreasuryMetrics,
  type TreasuryObservationView,
  type TreasuryOwnerStatus,
  type TreasuryProjectedArchive,
  type TreasuryQueryContext,
  type TreasuryQueryOwner,
  type TreasuryRecordActionInput,
  type TreasuryReconciliationSummary,
  type TreasurySettlementResult,
  type TreasuryTransactionInput,
  createTreasuryMetrics,
} from "@/runtime/treasury/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

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
  /** holder → 归属房间解析（owner 声明验证用；生产=Game.getObjectById().room.name）。 */
  readonly resolveHolderRoom?: (holderId: string) => string | undefined;
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
   * endTick 后返回 null（tick 已关闭，不得再发行 fresh epoch）。
   */
  beginFreshObservation(): TreasuryObservationView | null;
  /** 承诺统一索引：同 tick 缓存；权威 mutation 后按 revision 失效重建。 */
  commitments(): TreasuryCommitmentIndex;
  /** 带上下文余额查询（输入非法/owner 非法 fail closed）。 */
  query(context: TreasuryQueryContext): TreasuryBalanceView;
  /** 唯一权威登记入口：多 posting 原子交易 + 决策 epoch 绑定 + 幂等。 */
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

function defaultResolveHolderRoom(holderId: string): string | undefined {
  const resolved = Game.getObjectById?.(holderId as Id<Structure>);
  const room = (resolved as { room?: { name?: string } } | null)?.room;
  return room?.name;
}

/**
 * 查询上下文 fail-closed 校验：非法资源、非法/重复房间、非法/重复位置、
 * 非有限非负 withhold 一律拒绝（重复条目会双倍累计，绝不静默去重）。
 * 返回有界错误描述（null = 合法）。
 */
function validateQueryContext(context: TreasuryQueryContext): string | null {
  if (!context || typeof context !== "object") return "context 缺失";
  if (typeof context.resource !== "string" || !VALID_QUERY_RESOURCES.has(context.resource)) {
    return `resource 非法: ${String(context.resource)}`;
  }
  if (context.rooms !== undefined) {
    if (!Array.isArray(context.rooms)) return "rooms 必须为数组";
    const seen = new Set<string>();
    for (const roomName of context.rooms) {
      if (typeof roomName !== "string" || roomName.length === 0) {
        return `rooms 含非法房间名: ${String(roomName)}`;
      }
      if (seen.has(roomName)) return `rooms 含重复房间: ${roomName}`;
      seen.add(roomName);
    }
  }
  if (context.locations !== undefined) {
    if (!Array.isArray(context.locations)) return "locations 必须为数组";
    const seen = new Set<string>();
    for (const kind of context.locations) {
      if (kind !== "storage" && kind !== "terminal") {
        return `locations 含非法位置类型: ${String(kind)}`;
      }
      if (seen.has(kind)) return `locations 含重复位置: ${String(kind)}`;
      seen.add(kind);
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
 * owner 声明强化验证（fail closed）：
 * - 格式（scope/holderId/roomName）；
 * - holder 真实存在（运行时解析）；
 * - 声明房间与 holder 真实归属一致。
 * 通过后返回归属房间——查询多房间时只在该房间排除该 holder 的预留。
 */
function resolveOwnerStatus(
  owner: TreasuryQueryOwner | undefined,
  resolveHolderRoom: (holderId: string) => string | undefined,
): { valid: boolean; ownerRoom: string | undefined } {
  if (!owner) return { valid: true, ownerRoom: undefined };
  if (!owner || typeof owner !== "object") return { valid: false, ownerRoom: undefined };
  if (owner.scope !== "production-reservation") return { valid: false, ownerRoom: undefined };
  if (typeof owner.holderId !== "string" || owner.holderId.length === 0 || owner.holderId.length > 64) {
    return { valid: false, ownerRoom: undefined };
  }
  if (typeof owner.roomName !== "string" || owner.roomName.length === 0) {
    return { valid: false, ownerRoom: undefined };
  }
  const resolvedRoom = resolveHolderRoom(owner.holderId);
  if (resolvedRoom === undefined) return { valid: false, ownerRoom: undefined };
  if (resolvedRoom !== owner.roomName) return { valid: false, ownerRoom: undefined };
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

  /** 预分配 epochSeq 并登记 exact observation（两阶段：先建观察、后入表）。 */
  function issueEpoch(
    scope: "shared" | "market-fresh",
    observation: TreasuryObservationView,
  ): TreasuryEpoch {
    epochSeq += 1;
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
      metrics.receiptsCorruptedEvicted += cleanup.corruptedEvicted;
    }

    epochRegistry.clear();
    epochSeq += 1; // 预分配（build 需要 epochSeq；登记在 build 之后）
    const built = buildObservation("shared", epochSeq, previousArchive);
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

  const service: TreasuryService = {
    beginTick(): void {
      if (current && current.tick === Game.time) return; // 幂等
      performBeginTick(false);
    },

    endTick(): void {
      if (!current || current.tick !== Game.time || current.ended) return; // 幂等
      current.archived = projection.archiveProjectedFinal(current.observation);
      current.ended = true;
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
      epochSeq += 1; // 预分配
      const built = buildObservation("market-fresh", epochSeq);
      issueEpoch("market-fresh", built.observation);
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

      // 输入规范化 fail closed：非法资源/重复房间/重复位置/NaN withhold 等
      // 一律返回保守全零视图（不报乐观可用量），并计数可审计。
      const invalidReason = validateQueryContext(context);
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

      const resolveHolderRoom = deps.resolveHolderRoom ?? defaultResolveHolderRoom;
      const ownerCheck = resolveOwnerStatus(context.owner, resolveHolderRoom);
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
      // 决策 epoch 校验：必须命中本 tick 注册表中的活跃 epoch。
      const decision = input.decision;
      if (!decision || typeof decision !== "object") {
        metrics.staleEpochRejections += 1;
        return { status: "rejected", reason: "stale_epoch", detail: "decision 缺失" };
      }
      if (decision.observedAtTick !== Game.time) {
        metrics.staleEpochRejections += 1;
        return { status: "rejected", reason: "stale_epoch", detail: `决策基于 tick ${String(decision.observedAtTick)} 的观察` };
      }
      const registered = epochRegistry.get(decision.epochSeq);
      if (registered === undefined) {
        metrics.unknownEpochRejections += 1;
        return { status: "rejected", reason: "unknown_epoch", detail: `epochSeq ${String(decision.epochSeq)} 未在本 tick 注册` };
      }
      if (registered.scope !== decision.scope) {
        metrics.epochScopeMismatches += 1;
        return {
          status: "rejected",
          reason: "scope_mismatch",
          detail: `epochSeq ${String(decision.epochSeq)} 注册为 ${registered.scope}，决策声明 ${decision.scope}`,
        };
      }
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
      const receiptEvents = readTreasuryReceiptEventCounters();
      return {
        ...metrics,
        commitmentIndexQueries: metrics.commitmentIndexQueries + liveQueries,
        receiptStoreMigrationsExecuted: receiptEvents.migrationsExecuted,
        receiptStoreIncompatibleFailures: receiptEvents.incompatibleFailures,
      };
    },

    resetForTest(): void {
      const keys = Object.keys(metrics) as Array<keyof TreasuryMetrics>;
      for (const key of keys) metrics[key] = 0;
      projection.resetForTest();
      epochSeq = 0;
      current = null;
      epochRegistry.clear();
    },
  };

  return service;
}
