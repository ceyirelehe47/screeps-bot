/**
 * Treasury Facade / Gateway——帝国国库统一入口。
 *
 * 显式 tick 生命周期（main.ts 固定挂载，业务模块不再决定首次构建时点）：
 *   beginTick（一切市场预检/生产/物流/规划之前）
 *     → receipt 清理 → reset 检测 → 归档补救（若上一 tick 缺 endTick）
 *     → 发行本 tick shared epoch（登记 epoch 注册表）→ 对账上一 tick 终态；
 *   endTick（本 tick 全部业务执行之后、最终 profiler flush 之前）
 *     → 归档投影终态 → 关闭本 tick（此后登记一律拒绝 tick_closed）。
 *   observation()/commitments()/query() 仍可安全访问：未 begin 时走懒兜底
 *   （计数 lifecycleLazyInitializations，main 挂载后应恒为 0）。
 *
 * 登记门禁：transaction 携带决策 epoch 并通过注册表校验（stale/unknown/
 * scope 混用一律拒绝）；幂等（heap 本 tick + Memory receipt 跨 tick 与
 * global reset）优先于一切验证；endTick 后拒绝结算。
 *
 * 门禁语义：不提供无上下文 available；owner 声明非法时 fail closed；
 * spendable 非负且超卖显式 overcommitted；查询路径零写。
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
  type TreasuryProjectedFinal,
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
}

export interface TreasuryService {
  /** tick 起点：发行 shared epoch + 对账 + receipt 清理（幂等，可重复调用）。 */
  beginTick(): void;
  /** tick 终点：归档投影终态并关闭本 tick（幂等；之后登记拒绝 tick_closed）。 */
  endTick(): void;
  /** shared observation：同 tick 缓存复用（不可变）。 */
  observation(): TreasuryObservationView;
  /** market-fresh：每次独立构建并登记独立 epoch，不污染 shared 缓存。 */
  beginFreshObservation(): TreasuryObservationView;
  /** 承诺统一索引：同 tick 缓存；权威 mutation 后按 revision 失效重建。 */
  commitments(): TreasuryCommitmentIndex;
  /** 带上下文余额查询（禁止无上下文 available；owner 非法 fail closed）。 */
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
  /** endTick（或补救）归档的投影终态（供下一 tick 对账）。 */
  archivedFinals?: Map<string, TreasuryProjectedFinal>;
  lastReconciliation?: TreasuryReconciliationSummary;
}

const DEFAULT_LOCATION_KINDS: readonly TreasuryLocationKind[] = ["storage", "terminal"];

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

/** owner 声明合法性（fail closed 判定）。 */
function isValidQueryOwner(owner: TreasuryQueryOwner | undefined): owner is TreasuryQueryOwner {
  if (!owner || typeof owner !== "object") return false;
  if (owner.scope !== "production-reservation") return false;
  return typeof owner.holderId === "string" && owner.holderId.length > 0 && owner.holderId.length <= 64;
}

export function createTreasuryService(deps: TreasuryServiceDeps): TreasuryService {
  const metrics = createTreasuryMetrics();
  const projection: TreasuryProjectionController = createTreasuryProjectionController({
    onDuplicateRejected: () => {
      metrics.duplicateSettlementsRejected += 1;
    },
    onInvalidRejected: () => {
      metrics.transactionsRejectedInvalid += 1;
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
  /** 本 tick 发行的全部 epoch（shared 1 + fresh N）：登记校验的权威注册表。 */
  const epochRegistry = new Map<number, { scope: "shared" | "market-fresh"; observedAtTick: number }>();

  function issueEpoch(scope: "shared" | "market-fresh"): TreasuryEpoch {
    epochSeq += 1;
    const epoch: TreasuryEpoch = { scope, epochSeq, observedAtTick: Game.time };
    epochRegistry.set(epochSeq, { scope, observedAtTick: epoch.observedAtTick });
    return epoch;
  }

  function buildObservation(
    epoch: TreasuryEpoch,
    previousFinals?: { tick: number; finals: Map<string, TreasuryProjectedFinal> },
  ): { observation: TreasuryObservationView; reconciliation: TreasuryReconciliationSummary | null } {
    const observation = buildTreasuryObservation({
      scope: epoch.scope,
      epochSeq: epoch.epochSeq,
      rooms: deps.getRooms(),
      onStoreScanned: (nonZeroKeys) => {
        metrics.storeEnumerations += 1;
        metrics.resourceKeysEnumerated += nonZeroKeys;
        metrics.nonZeroEntries += nonZeroKeys;
        metrics.locationsScanned += 1;
      },
    });
    if (epoch.scope === "shared") {
      metrics.observationRebuilds += 1;
      // 对账必须用 shared 观察（fresh 不参与对账链路）。
      return { observation, reconciliation: projection.reconcile(previousFinals, observation) };
    }
    metrics.freshObservationBuilds += 1;
    return { observation, reconciliation: null };
  }

  /** beginTick 的实际执行体（显式调用与懒兜底共享；调用方保证幂等检查）。 */
  function performBeginTick(lazy: boolean): TreasuryTickState {
    if (lazy) metrics.lifecycleLazyInitializations += 1;

    let previousFinals: { tick: number; finals: Map<string, TreasuryProjectedFinal> } | undefined;
    if (current) {
      if (!current.ended) {
        // 上一 tick 缺 endTick（异常/未挂载）：补救归档，显式计数不静默。
        metrics.lifecycleMissingEndWarnings += 1;
        current.archivedFinals = projection.archiveProjectedFinal(current.observation);
      }
      if (current.archivedFinals) {
        previousFinals = { tick: current.tick, finals: current.archivedFinals };
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
      metrics.receiptsEvictedByCap += cleanup.capEvicted;
      metrics.receiptEvictionsBlocked += cleanup.evictionsBlocked;
    }

    epochRegistry.clear();
    const epoch = issueEpoch("shared");
    const built = buildObservation(epoch, previousFinals);
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
      current.archivedFinals = projection.archiveProjectedFinal(current.observation);
      current.ended = true;
      metrics.lifecycleEndTicks += 1;
      writeTreasuryLifecycle({ lastEndTick: Game.time });
    },

    observation(): TreasuryObservationView {
      const state = ensureTickState(true);
      metrics.observationReuseHits += 1;
      return state.observation;
    },

    beginFreshObservation(): TreasuryObservationView {
      // 确保本 tick 生命周期已初始化（fresh epoch 必须登记进本 tick 注册表）。
      ensureTickState(true);
      const epoch = issueEpoch("market-fresh");
      return buildObservation(epoch).observation;
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

      const ownerValid = context.owner === undefined || isValidQueryOwner(context.owner);
      const ownerStatus: TreasuryOwnerStatus = !ownerValid
        ? "invalid_fail_closed"
        : context.owner
          ? "excluded-own-reservations"
          : "none";

      const commitments = this.commitments();
      const excludeHolder = ownerValid && context.owner ? context.owner.holderId : undefined;
      let committed = 0;
      if (context.subtractOutgoing !== false) {
        for (const roomName of rooms) {
          committed += commitments.pendingOutgoing(roomName, context.resource);
        }
      }
      if (context.subtractReservations !== false) {
        for (const roomName of rooms) {
          committed += commitments.reservedProduction(roomName, context.resource, excludeHolder);
        }
      }

      const incoming = context.allowIncoming
        ? rooms.reduce((sum, roomName) => sum + commitments.incoming(roomName, context.resource), 0)
        : 0;

      const base = (allowProjected ? projected : observed) + incoming;
      const withhold = Math.max(0, context.withhold ?? 0);
      // fail closed：owner 非法时不给乐观可用量，只报保守结论。
      const rawSpendable = ownerValid ? base - committed - withhold : 0;

      return {
        resource: context.resource,
        observed,
        projected,
        committed,
        incoming,
        spendable: ownerValid ? Math.max(0, rawSpendable) : 0,
        overcommitted: !ownerValid || rawSpendable < 0,
        ownerStatus,
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
      return projection.recordTransaction(input, state.observation);
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

    metrics(): TreasuryMetrics {
      const liveIndex = current?.commitmentIndex;
      const liveQueries = liveIndex?.metrics.indexQueries ?? 0;
      return { ...metrics, commitmentIndexQueries: metrics.commitmentIndexQueries + liveQueries };
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
