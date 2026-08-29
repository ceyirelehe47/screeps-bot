/**
 * Treasury Facade / Gateway——帝国国库统一入口。
 *
 * 全部状态由服务实例持有（经 RuntimeServices 挂载，无新增 global 私有槽、
 * 无 Memory schema 字段），tick 生命周期：
 *   首次访问 observation() → reconcile 上一 tick → 新 epoch 构建（缓存至 tick 结束）；
 *   commitments() 同 tick 懒构建一次；
 *   recordAcceptedAction() 只接受当前 epoch 且幂等 actionId；
 *   下一 tick 首次访问时归档上一 tick 投影终态并对账。
 *
 * 门禁语义：不提供无上下文 available；stale epoch 不可用于即时授权；
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
  type TreasuryBalanceView,
  type TreasuryCommitmentIndex,
  type TreasuryJournalEntry,
  type TreasuryLocationKind,
  type TreasuryMetrics,
  type TreasuryObservationView,
  type TreasuryQueryContext,
  type TreasuryRecordActionInput,
  type TreasuryRecordActionResult,
  type TreasuryReconciliationSummary,
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
  /** shared observation：同 tick 缓存复用（不可变）。 */
  observation(): TreasuryObservationView;
  /** market-fresh：每次独立构建，不污染 shared 缓存（未来市场接入点）。 */
  beginFreshObservation(): TreasuryObservationView;
  /** 承诺统一索引：同 tick 缓存复用；过期/孤儿读侧排除。 */
  commitments(): TreasuryCommitmentIndex;
  /** 带上下文余额查询（禁止无上下文 available）。 */
  query(context: TreasuryQueryContext): TreasuryBalanceView;
  /** 已接受动作登记（Game API OK 后调用；幂等、stale 拒绝）。 */
  recordAcceptedAction(input: TreasuryRecordActionInput): TreasuryRecordActionResult;
  /** 当前 tick journal 快照（冻结条目）。 */
  journal(): readonly TreasuryJournalEntry[];
  /** 最近一次跨 tick 对账结果。 */
  lastReconciliation(): TreasuryReconciliationSummary | null;
  metrics(): TreasuryMetrics;
  /** 仅供测试：清空全部状态（observation/commitment/journal/指标）。 */
  resetForTest(): void;
}

interface TreasuryTickState {
  tick: number;
  observation: TreasuryObservationView;
  commitmentIndex?: TreasuryCommitmentIndex;
  /** 上一 tick 归档的投影终态（供本 tick 首次构建时对账）。 */
  previousFinals?: {
    tick: number;
    finals: Map<string, { roomName: string; locationKind: "storage" | "terminal"; resource: string; amount: number }>;
  };
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

export function createTreasuryService(deps: TreasuryServiceDeps): TreasuryService {
  const metrics = createTreasuryMetrics();
  const projection: TreasuryProjectionController = createTreasuryProjectionController({
    onDuplicateRejected: () => {
      metrics.duplicateSettlementsRejected += 1;
    },
    onStaleRejected: () => {
      metrics.staleEpochRejections += 1;
    },
    onRecorded: (entry) => {
      metrics.journalEntries += 1;
      void entry;
    },
    onReconciliation: (summary) => {
      metrics.reconciliationChecks += 1;
      metrics.reconciliationInflowMismatches += summary.inflowMismatches;
      metrics.reconciliationOutflowMismatches += summary.outflowMismatches;
    },
  });

  let epochSeq = 0;
  let current: TreasuryTickState | null = null;

  function ensureTickState(): TreasuryTickState {
    if (current && current.tick === Game.time) {
      return current;
    }

    let previousFinals: TreasuryTickState["previousFinals"];
    if (current) {
      // tick 切换：归档上一 tick 投影终态（若有），重置 journal/overlay。
      const finals = projection.archiveProjectedFinal(current.observation);
      projection.beginNextTick();
      previousFinals = { tick: current.tick, finals };
    }
    epochSeq += 1;
    const built = buildObservation("shared", previousFinals);
    current = {
      tick: Game.time,
      observation: built.observation,
      previousFinals,
      lastReconciliation: built.reconciliation,
    };
    return current;
  }

  function buildObservation(
    scope: "shared" | "market-fresh",
    previousFinals?: TreasuryTickState["previousFinals"],
  ): { observation: TreasuryObservationView; reconciliation: TreasuryReconciliationSummary | null } {
    const observation = buildTreasuryObservation({
      scope,
      epochSeq,
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
      const summary = projection.reconcile(previousFinals, observation);
      return { observation, reconciliation: summary.previousTick !== null ? summary : null };
    }
    metrics.freshObservationBuilds += 1;
    return { observation, reconciliation: null };
  }

  const service: TreasuryService = {
    observation(): TreasuryObservationView {
      const state = ensureTickState();
      metrics.observationReuseHits += 1;
      return state.observation;
    },

    beginFreshObservation(): TreasuryObservationView {
      // fresh 构建使用独立递增的 epochSeq（与 shared 缓存隔离；不回写 shared）。
      epochSeq += 1;
      return buildObservation("market-fresh").observation;
    },

    commitments(): TreasuryCommitmentIndex {
      const state = ensureTickState();
      if (!state.commitmentIndex) {
        metrics.commitmentRebuilds += 1;
        state.commitmentIndex = buildTreasuryCommitmentIndex({
          tick: Game.time,
          tasks: (deps.getTasks ?? defaultGetTasks)(),
          reservations: (deps.getReservations ?? defaultGetReservations)(),
          observation: state.observation,
          holderExists: deps.holderExists,
          onExpiredExcluded: () => {
            metrics.expiredCommitmentsExcluded += 1;
          },
          onOrphanExcluded: () => {
            metrics.orphanReservationsExcluded += 1;
          },
        });
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

      const commitments = this.commitments();
      let committed = 0;
      if (context.subtractOutgoing !== false) {
        for (const roomName of rooms) {
          committed += commitments.pendingOutgoing(roomName, context.resource);
        }
      }
      if (context.subtractReservations !== false) {
        for (const roomName of rooms) {
          committed += commitments.reservedProduction(roomName, context.resource);
        }
      }

      const incoming = context.allowIncoming
        ? rooms.reduce((sum, roomName) => sum + commitments.incoming(roomName, context.resource), 0)
        : 0;

      const base = (allowProjected ? projected : observed) + incoming;
      const withhold = Math.max(0, context.withhold ?? 0);
      const rawSpendable = base - committed - withhold;

      return {
        resource: context.resource,
        observed,
        projected,
        committed,
        incoming,
        spendable: Math.max(0, rawSpendable),
        overcommitted: rawSpendable < 0,
        epoch: observation.epoch,
      };
    },

    recordAcceptedAction(input: TreasuryRecordActionInput): TreasuryRecordActionResult {
      const state = ensureTickState();
      return projection.record(input, state.observation.epoch);
    },

    journal(): readonly TreasuryJournalEntry[] {
      return projection.journalSnapshot();
    },

    lastReconciliation(): TreasuryReconciliationSummary | null {
      return current?.lastReconciliation ?? null;
    },

    metrics(): TreasuryMetrics {
      return { ...metrics };
    },

    resetForTest(): void {
      metrics.observationRebuilds = 0;
      metrics.observationReuseHits = 0;
      metrics.freshObservationBuilds = 0;
      metrics.locationsScanned = 0;
      metrics.nonZeroEntries = 0;
      metrics.storeEnumerations = 0;
      metrics.resourceKeysEnumerated = 0;
      metrics.roomFindCalls = 0;
      metrics.fallbackLiveReads = 0;
      metrics.commitmentRebuilds = 0;
      metrics.commitmentRecords = 0;
      metrics.commitmentIndexQueries = 0;
      metrics.expiredCommitmentsExcluded = 0;
      metrics.orphanReservationsExcluded = 0;
      metrics.journalEntries = 0;
      metrics.duplicateSettlementsRejected = 0;
      metrics.staleEpochRejections = 0;
      metrics.reconciliationInflowMismatches = 0;
      metrics.reconciliationOutflowMismatches = 0;
      metrics.reconciliationChecks = 0;
      epochSeq = 0;
      current = null;
    },
  };

  return service;
}
