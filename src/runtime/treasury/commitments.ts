/**
 * Treasury Commitment Index——跨 tick 承诺的每 tick 只读统一索引。
 *
 * 权威边界（不变量：零隐藏写入、零持久化复制）：
 * - transfer tasks 权威在 Memory.data.resourceControl.tasks，本索引只读聚合；
 * - production reservations 权威在 Memory.runtime.resourceReservations；
 *   过期/孤儿条目在读侧排除并计数，删除权保留在 owner/memoryCleanup；
 * - 健康/需求覆盖判定复用 resourceTransferTaskHealth 的 canonical 谓词，
 *   不得在 Treasury 内出现第二套解释；
 * - 索引是点时快照：构建期一次性聚合为 primitive 值（不保留 task/
 *   reservation 对象引用，外部原地修改原对象不影响已构建快照）；
 *   权威数据 mutation 由 bumpTreasuryCommitmentRevision 通知 facade 失效
 *   重建，同 tick 后续查询读到新 revision 的快照；
 * - receiver headroom 为第一版总量口径（free − healthy incoming remaining，
 *   observed 与 projected 双轨），不含 ReceiverCapacityLedger 的 safety
 *   reserve 与独立 reservation——完整语义在该 ledger 并入 Treasury 时提供
 *   （见 OpenSpec 任务表）。
 */

import {
  countsResourceTransferTaskTowardDemand,
  isHealthyReceiverCapacityCommitment,
  resolveResourceTransferTaskHealthOptions,
} from "@/runtime/logistics/resourceTransferTaskHealth";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import {
  type TreasuryCommitmentIndex,
  type TreasuryCommitmentMetrics,
  type TreasuryLocationKind,
  type TreasuryObservationView,
  type TreasuryReceiverCommitments,
  type TreasuryReservationRecord,
} from "@/runtime/treasury/types";
import { readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";

export interface TreasuryReservationInput {
  readonly roomName: string;
  readonly resource: string;
  readonly holderId: string;
  readonly amount: number;
  readonly expiresAt: number;
}

export interface TreasuryCommitmentBuildOptions {
  readonly tick: number;
  readonly tasks: Record<string, ResourceTransferTask>;
  readonly reservations: Record<string, TreasuryReservationInput>;
  readonly observation: TreasuryObservationView;
  /** holder 存在性检查（生产=Game.getObjectById；测试可注入）。 */
  readonly holderExists?: (holderId: string) => boolean;
  /** 本 tick 已结算 transaction 的位置容量净变化（facade overlay 注入）。 */
  readonly capacityDelta?: (roomName: string, kind: TreasuryLocationKind) => number;
  readonly onExpiredExcluded?: () => void;
  readonly onOrphanExcluded?: () => void;
}

function defaultHolderExists(holderId: string): boolean {
  const resolved = Game.getObjectById?.(holderId as Id<Structure>);
  return resolved != null;
}

/** 内部构建期可变副本；对外经 TreasuryCommitmentIndex.metrics 以 readonly 暴露。 */
type MutableCommitmentMetrics = {
  -readonly [K in keyof TreasuryCommitmentMetrics]: TreasuryCommitmentMetrics[K];
};

const taskKey = (roomName: string, resource: string) => `${roomName}\u0000${resource}`;
const mergeKeyOf = (
  resource: string,
  fromRoomName: string,
  toRoomName: string,
  origin: string,
  reason: string,
) => `${resource}\u0000${fromRoomName}\u0000${toRoomName}\u0000${origin}\u0000${reason}`;

export function buildTreasuryCommitmentIndex(
  options: TreasuryCommitmentBuildOptions,
): TreasuryCommitmentIndex {
  const tick = options.tick;
  const revision = readTreasuryCommitmentRevision();
  const healthOptions = resolveResourceTransferTaskHealthOptions();
  const holderExists = options.holderExists ?? defaultHolderExists;
  const capacityDelta = options.capacityDelta ?? (() => 0);

  const metrics: MutableCommitmentMetrics = {
    taskRecords: 0,
    pendingTaskRecords: 0,
    reservationRecords: 0,
    activeReservationRecords: 0,
    expiredReservationsExcluded: 0,
    orphanReservationsExcluded: 0,
    indexQueries: 0,
  };

  // ── transfer task 索引（pending 维度与旧 amount index 对齐）───────────────
  const outgoing = new Map<string, number>();
  const outgoingByReason = new Map<string, Map<string, number>>();
  const pendingIncoming = new Map<string, number>();
  const incoming = new Map<string, number>();
  const incomingTaskCountByRoom = new Map<string, number>();
  const outgoingTaskCountByRoom = new Map<string, number>();
  // route merge 预构建索引：mergeKey → taskId（查询零线性扫描）。
  const mergeIndex = new Map<string, string>();
  // receiver 维度预聚合：房间 → 健康入站合计/任务数（canonical 谓词）。
  const healthyIncomingByRoom = new Map<string, number>();
  const healthyIncomingCountByRoom = new Map<string, number>();

  metrics.taskRecords = Object.keys(options.tasks).length;
  for (const task of Object.values(options.tasks)) {
    if (task.status !== "pending") continue;
    metrics.pendingTaskRecords += 1;
    const reason = task.reason || "";

    outgoingTaskCountByRoom.set(task.fromRoomName, (outgoingTaskCountByRoom.get(task.fromRoomName) ?? 0) + 1);
    const outKey = taskKey(task.fromRoomName, task.resource);
    outgoing.set(outKey, (outgoing.get(outKey) ?? 0) + task.remainingAmount);
    const byReason = outgoingByReason.get(outKey) ?? new Map<string, number>();
    byReason.set(reason, (byReason.get(reason) ?? 0) + task.remainingAmount);
    outgoingByReason.set(outKey, byReason);

    pendingIncoming.set(
      taskKey(task.toRoomName, task.resource),
      (pendingIncoming.get(taskKey(task.toRoomName, task.resource)) ?? 0) + task.remainingAmount,
    );

    const countsTowardDemand = countsResourceTransferTaskTowardDemand(task, healthOptions);
    if (countsTowardDemand) {
      const inKey = taskKey(task.toRoomName, task.resource);
      incoming.set(inKey, (incoming.get(inKey) ?? 0) + task.remainingAmount);
      incomingTaskCountByRoom.set(task.toRoomName, (incomingTaskCountByRoom.get(task.toRoomName) ?? 0) + 1);
    }
    if (task.origin === "manual" || countsTowardDemand) {
      // 与旧 findMergeablePendingTask 语义一致：manual 无条件、automatic 需健康。
      mergeIndex.set(
        mergeKeyOf(task.resource, task.fromRoomName, task.toRoomName, task.origin, reason),
        task.id,
      );
    }
    if (isHealthyReceiverCapacityCommitment(task, healthOptions.automaticTaskNoProgressTtl)) {
      healthyIncomingByRoom.set(task.toRoomName, (healthyIncomingByRoom.get(task.toRoomName) ?? 0) + task.remainingAmount);
      healthyIncomingCountByRoom.set(task.toRoomName, (healthyIncomingCountByRoom.get(task.toRoomName) ?? 0) + 1);
    }
  }

  // ── production reservation 索引（读侧排除过期/孤儿，不删除原记录）─────────
  const reservationSnapshot: TreasuryReservationRecord[] = [];
  const reservedByRoomResource = new Map<string, { total: number; byHolder: Map<string, number> }>();
  metrics.reservationRecords = Object.keys(options.reservations).length;
  for (const entry of Object.values(options.reservations)) {
    const expired = entry.expiresAt < tick;
    const orphan = !expired && !holderExists(entry.holderId);
    const record: TreasuryReservationRecord = Object.freeze({
      roomName: entry.roomName,
      resource: entry.resource,
      holderId: entry.holderId,
      amount: entry.amount,
      expiresAt: entry.expiresAt,
      expired,
      orphan,
    });
    reservationSnapshot.push(record);
    if (expired) {
      metrics.expiredReservationsExcluded += 1;
      options.onExpiredExcluded?.();
      continue;
    }
    if (orphan) {
      metrics.orphanReservationsExcluded += 1;
      options.onOrphanExcluded?.();
      continue;
    }
    metrics.activeReservationRecords += 1;
    const key = taskKey(entry.roomName, entry.resource);
    const bucket = reservedByRoomResource.get(key) ?? { total: 0, byHolder: new Map<string, number>() };
    bucket.total += entry.amount;
    bucket.byHolder.set(entry.holderId, (bucket.byHolder.get(entry.holderId) ?? 0) + entry.amount);
    reservedByRoomResource.set(key, bucket);
  }

  const receiverCache = new Map<string, TreasuryReceiverCommitments>();

  const index: TreasuryCommitmentIndex = {
    builtAtTick: tick,
    revision,
    outgoing(roomName, resource) {
      metrics.indexQueries += 1;
      return outgoing.get(taskKey(roomName, resource)) ?? 0;
    },
    pendingOutgoing(roomName, resource, reasonPrefix) {
      metrics.indexQueries += 1;
      if (!reasonPrefix) return outgoing.get(taskKey(roomName, resource)) ?? 0;
      let total = 0;
      for (const [reason, amount] of outgoingByReason.get(taskKey(roomName, resource)) ?? []) {
        if (reason.startsWith(reasonPrefix)) total += amount;
      }
      return total;
    },
    incoming(roomName, resource) {
      metrics.indexQueries += 1;
      return incoming.get(taskKey(roomName, resource)) ?? 0;
    },
    pendingIncoming(roomName, resource) {
      metrics.indexQueries += 1;
      return pendingIncoming.get(taskKey(roomName, resource)) ?? 0;
    },
    incomingTaskCount(roomName) {
      metrics.indexQueries += 1;
      return incomingTaskCountByRoom.get(roomName) ?? 0;
    },
    outgoingTaskCount(roomName) {
      metrics.indexQueries += 1;
      return outgoingTaskCountByRoom.get(roomName) ?? 0;
    },
    findMergeableTaskId(resource, fromRoomName, toRoomName, origin, reason) {
      metrics.indexQueries += 1;
      return (
        mergeIndex.get(mergeKeyOf(resource, fromRoomName, toRoomName, origin, reason || "")) ?? null
      );
    },
    reservedProduction(roomName, resource, excludeHolderId) {
      metrics.indexQueries += 1;
      const bucket = reservedByRoomResource.get(taskKey(roomName, resource));
      if (!bucket) return 0;
      if (!excludeHolderId) return bucket.total;
      return bucket.total - (bucket.byHolder.get(excludeHolderId) ?? 0);
    },
    reservationSnapshot() {
      metrics.indexQueries += 1;
      return Object.freeze([...reservationSnapshot]);
    },
    receiverCommitments(roomName) {
      metrics.indexQueries += 1;
      const cached = receiverCache.get(roomName);
      if (cached) return cached;
      const healthyIncomingAmount = healthyIncomingByRoom.get(roomName) ?? 0;
      const storageFreeCapacity = options.observation.freeCapacity(roomName, "storage");
      const terminalFreeCapacity = options.observation.freeCapacity(roomName, "terminal");
      // projected 口径：observed free 扣减本 tick 已结算 transaction 的容量净变化。
      const projectedStorageFree = storageFreeCapacity - capacityDelta(roomName, "storage");
      const projectedTerminalFree = terminalFreeCapacity - capacityDelta(roomName, "terminal");
      const result: TreasuryReceiverCommitments = Object.freeze({
        roomName,
        healthyIncomingAmount,
        healthyIncomingTaskCount: healthyIncomingCountByRoom.get(roomName) ?? 0,
        storageFreeCapacity,
        terminalFreeCapacity,
        // 与旧 ReceiverCapacityLedger.getAvailability 的 min 语义一致：
        // 入站承接是每结构独立扣全量、取 min；任一结构维度超卖即超卖。
        storageHeadroom: storageFreeCapacity - healthyIncomingAmount,
        terminalHeadroom: terminalFreeCapacity - healthyIncomingAmount,
        overcommitted:
          healthyIncomingAmount > storageFreeCapacity ||
          healthyIncomingAmount > terminalFreeCapacity,
        projectedStorageHeadroom: projectedStorageFree - healthyIncomingAmount,
        projectedTerminalHeadroom: projectedTerminalFree - healthyIncomingAmount,
        projectedOvercommitted:
          healthyIncomingAmount > projectedStorageFree ||
          healthyIncomingAmount > projectedTerminalFree,
      });
      receiverCache.set(roomName, result);
      return result;
    },
    metrics,
  };

  return index;
}
