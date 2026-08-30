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
 *   （见 OpenSpec 任务表）。projected 字段每次查询动态组合（静态承诺 +
 *   当前 overlay 容量聚合），同 tick transaction 后立即反映最新投影，
 *   绝不缓存到旧结果。
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
  type TreasuryReservationOwnerStatus,
  type TreasuryReservationRecord,
} from "@/runtime/treasury/types";
import { readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import { treasuryHolderExists } from "@/runtime/treasury/holderResolution";
import {
  classifyTreasuryHolderIdAsOwner,
  isValidTreasuryOwnerIdentity,
  treasuryOwnerIdentityKey,
  type TreasuryOwnerIdentity,
} from "@/runtime/treasury/ownerIdentity";


export interface TreasuryReservationInput {
  readonly roomName: string;
  readonly resource: string;
  readonly holderId: string;
  readonly amount: number;
  readonly expiresAt: number;
  /** 持久 typed owner（缺省/非法时按 holderId 保守分类——读侧零写）。 */
  readonly owner?: unknown;
}

export interface TreasuryCommitmentBuildOptions {
  readonly tick: number;
  readonly tasks: Record<string, ResourceTransferTask>;
  readonly reservations: Record<string, TreasuryReservationInput>;
  readonly observation: TreasuryObservationView;
  /**
   * holder 存在性检查（默认走 typed 解析：`nuker:`/`synthesis:` 逻辑名
   * 命名空间 + 裸 Game object id——logical holder 不再被误判 orphan；
   * 测试可注入）。
   */
  readonly holderExists?: (holderId: string) => boolean;
  /** 本 tick 已结算 transaction 的位置容量净变化（facade overlay 注入）。 */
  readonly capacityDelta?: (roomName: string, kind: TreasuryLocationKind) => number;
  readonly onExpiredExcluded?: () => void;
  /** 诊断回调：owner 无法确证失效但保守计入 committed 的 reservation。 */
  readonly onMissingOwnerCommitted?: () => void;
}

function defaultHolderExists(holderId: string): boolean {
  return treasuryHolderExists(holderId);
}

const VALID_RESOURCES_FOR_COMMITMENT: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);

/** task status 合法枚举（与 ResourceTransferTaskStatus 权威一致）。 */
const VALID_TASK_STATUSES: ReadonlySet<string> = new Set<string>([
  "pending",
  "done",
  "cancelled",
  "failed",
]);

/** blockedReason 合法枚举（与 ResourceTransferTaskBlockedReason 权威一致；缺省合法）。 */
const VALID_TASK_BLOCKED_REASONS: ReadonlySet<string> = new Set<string>([
  "receiver_capacity",
  "source_depleted",
  "insufficient_terminal_resource_or_fee",
]);

/** 数值字段完整有效性：有限、整数、安全整数、非负。 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * transfer task 记录级验证（第五轮 completeness）：status/resource/房间/
 * amount/remainingAmount（remaining ≤ amount）/origin/tick 字段的形状与
 * 数值关系。损坏记录不得进入聚合（负 amount 加进 committed、NaN 污染求和
 * 都会提高 spendable），也不得被读取路径删除——只标记 scope incomplete。
 */
export function isValidTreasuryTransferTaskForCommitment(task: ResourceTransferTask): boolean {
  if (!task || typeof task !== "object") return false;
  // status 必须属于合法枚举——未知值（如 "pendng"）是损坏而非"普通非 pending"，
  // 绝不静默跳过后继续授权。
  if (typeof task.status !== "string" || !VALID_TASK_STATUSES.has(task.status)) return false;
  if (typeof task.resource !== "string" || !VALID_RESOURCES_FOR_COMMITMENT.has(task.resource)) return false;
  if (typeof task.fromRoomName !== "string" || task.fromRoomName.length === 0) return false;
  if (typeof task.toRoomName !== "string" || task.toRoomName.length === 0) return false;
  if (!isNonNegativeSafeInteger(task.amount)) return false;
  if (!isNonNegativeSafeInteger(task.remainingAmount)) return false;
  if (task.remainingAmount > task.amount) return false;
  if (task.origin !== "manual" && task.origin !== "automatic") return false;
  if (!isNonNegativeSafeInteger(task.createdAt)) return false;
  if (!isNonNegativeSafeInteger(task.updatedAt)) return false;
  if (!isNonNegativeSafeInteger(task.lastProgressAt)) return false;
  if (task.blockedReason !== undefined && !VALID_TASK_BLOCKED_REASONS.has(task.blockedReason as string)) {
    return false; // 枚举外 blockedReason 是损坏，不是"未阻塞"
  }
  if (task.blockedSince !== undefined && !isNonNegativeSafeInteger(task.blockedSince)) return false;
  return true;
}

function isValidScopePair(roomName: unknown, resource: unknown): roomName is string {
  return typeof roomName === "string" && roomName.length > 0 && typeof resource === "string" && resource.length > 0;
}

/** 聚合累加（多条合法安全整数相加后仍须为安全整数；溢出返回 null）。 */
function addSafeInteger(current: number, addend: number): number | null {
  const next = current + addend;
  return Number.isSafeInteger(next) ? next : null;
}

/** production reservation 记录级验证（数值与 owner identity 形状）。 */
function isValidReservationForCommitment(entry: TreasuryReservationInput): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.roomName !== "string" || entry.roomName.length === 0) return false;
  if (typeof entry.resource !== "string" || !VALID_RESOURCES_FOR_COMMITMENT.has(entry.resource)) return false;
  if (!isNonNegativeSafeInteger(entry.amount)) return false;
  if (!isNonNegativeSafeInteger(entry.expiresAt)) return false;
  if (typeof entry.holderId !== "string" || entry.holderId.length === 0) return false;
  if (entry.owner !== undefined && !isValidTreasuryOwnerIdentity(entry.owner)) return false;
  return true;
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
    missingOwnerStillCommitted: 0,
    typedOwnerResolved: 0,
    legacyUnresolvedOwners: 0,
    invalidCommitmentRecords: 0,
    incompleteCommitmentScopes: 0,
    globallyIncomplete: false,
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

  // completeness（第五轮）：损坏记录不进聚合、不删原数据；能定位 bucket 的
  // 标记 (room,resource) scope incomplete，连 scope 都无法确定的标记全局
  // incomplete——incomplete scope 的 spendable/授权必须 fail closed。
  const invalidCommitmentRecords = { count: 0 };
  const incompleteScopes = new Set<string>();
  let globalIncomplete = false;
  const recordInvalid = (): void => {
    invalidCommitmentRecords.count += 1;
  };

  metrics.taskRecords = Object.keys(options.tasks).length;
  for (const task of Object.values(options.tasks)) {
    if (!isValidTreasuryTransferTaskForCommitment(task)) {
      // 损坏任务影响 donor 与 receiver 双侧 bucket：能定位哪侧就标记哪侧
      // scope incomplete；双侧都不可定位（连资源/房间都读不出）则全局
      // incomplete。绝不静默跳过后给出乐观 spendable，也绝不删除原记录。
      recordInvalid();
      // scope 定位要求 (room, resource) 二元均合法：非法 resource（不在官方
      // catalog）无法构成任何合法 scope——绝不能因"非法资源不会命中合法
      // 查询"就静默跳过，直接全局 incomplete（一切授权 fail closed）。
      const resourceKnown =
        typeof task?.resource === "string" && VALID_RESOURCES_FOR_COMMITMENT.has(task.resource);
      const fromLocated = resourceKnown && typeof task?.fromRoomName === "string" && task.fromRoomName.length > 0;
      const toLocated = resourceKnown && typeof task?.toRoomName === "string" && task.toRoomName.length > 0;
      if (fromLocated) incompleteScopes.add(taskKey(task.fromRoomName, task.resource));
      if (toLocated) incompleteScopes.add(taskKey(task.toRoomName, task.resource));
      if (!fromLocated || !toLocated) globalIncomplete = true;
      continue;
    }
    if (task.status !== "pending") continue;
    metrics.pendingTaskRecords += 1;
    const reason = task.reason || "";

    // 聚合安全整数检查：多条合法安全整数相加后仍须安全——溢出即该 task
    // 影响的全部 scope incomplete（数值不再作为授权依据），不静默丢弃。
    const outKey = taskKey(task.fromRoomName, task.resource);
    const mergedOutgoing = addSafeInteger(outgoing.get(outKey) ?? 0, task.remainingAmount);
    const mergedPendingIncoming = addSafeInteger(
      pendingIncoming.get(taskKey(task.toRoomName, task.resource)) ?? 0,
      task.remainingAmount,
    );
    if (mergedOutgoing === null || mergedPendingIncoming === null) {
      recordInvalid();
      incompleteScopes.add(outKey);
      incompleteScopes.add(taskKey(task.toRoomName, task.resource));
      continue;
    }

    outgoingTaskCountByRoom.set(task.fromRoomName, (outgoingTaskCountByRoom.get(task.fromRoomName) ?? 0) + 1);
    outgoing.set(outKey, mergedOutgoing);
    const byReason = outgoingByReason.get(outKey) ?? new Map<string, number>();
    const mergedByReason = addSafeInteger(byReason.get(reason) ?? 0, task.remainingAmount);
    if (mergedByReason === null) {
      recordInvalid();
      incompleteScopes.add(outKey);
      continue;
    }
    byReason.set(reason, mergedByReason);
    outgoingByReason.set(outKey, byReason);

    pendingIncoming.set(taskKey(task.toRoomName, task.resource), mergedPendingIncoming);

    const countsTowardDemand = countsResourceTransferTaskTowardDemand(task, healthOptions);
    if (countsTowardDemand) {
      const inKey = taskKey(task.toRoomName, task.resource);
      const mergedIncoming = addSafeInteger(incoming.get(inKey) ?? 0, task.remainingAmount);
      if (mergedIncoming === null) {
        recordInvalid();
        incompleteScopes.add(inKey);
        continue;
      }
      incoming.set(inKey, mergedIncoming);
      incomingTaskCountByRoom.set(task.toRoomName, (incomingTaskCountByRoom.get(task.toRoomName) ?? 0) + 1);
    }
    if (task.origin === "manual" || countsTowardDemand) {
      // 与旧 findMergeablePendingTask 语义一致：manual 无条件、automatic 需
      // 健康；同 route 重复 key 时保留第一个匹配（Object.values 插入顺序），
      // 不得用后写覆盖（那是"最后一个匹配"，会改变 merge 目标选择）。
      const mergeKey = mergeKeyOf(task.resource, task.fromRoomName, task.toRoomName, task.origin, reason);
      if (!mergeIndex.has(mergeKey)) {
        mergeIndex.set(mergeKey, task.id);
      }
    }
    if (isHealthyReceiverCapacityCommitment(task, healthOptions.automaticTaskNoProgressTtl)) {
      healthyIncomingByRoom.set(task.toRoomName, (healthyIncomingByRoom.get(task.toRoomName) ?? 0) + task.remainingAmount);
      healthyIncomingCountByRoom.set(task.toRoomName, (healthyIncomingCountByRoom.get(task.toRoomName) ?? 0) + 1);
    }
  }

  // ── production reservation 索引（保守 committed：只有 expiresAt 到期或
  //    显式 release 解除占用；owner 无法确证失效一律继续全额扣除）──────────
  //    orphan 语义修正（第五轮）：missing/active-unresolved owner 只是诊断
  //    分类，不代表库存可重新支配——绝不从 committed 排除。
  const reservationSnapshot: TreasuryReservationRecord[] = [];
  const reservedByRoomResource = new Map<string, { total: number; byOwner: Map<string, number> }>();
  metrics.reservationRecords = Object.keys(options.reservations).length;
  for (const entry of Object.values(options.reservations)) {
    if (!isValidReservationForCommitment(entry)) {
      recordInvalid();
      const roomLocated = typeof entry?.roomName === "string" && entry.roomName.length > 0;
      // resource 必须在官方 catalog 内才能构成合法 scope（与 task 同口径）。
      const resourceKnown =
        typeof entry?.resource === "string" && VALID_RESOURCES_FOR_COMMITMENT.has(entry.resource);
      if (roomLocated && resourceKnown) incompleteScopes.add(taskKey(entry.roomName, entry.resource));
      else globalIncomplete = true;
      continue;
    }
    const expired = entry.expiresAt < tick;
    const owner: TreasuryOwnerIdentity = isValidTreasuryOwnerIdentity(entry.owner)
      ? entry.owner
      : classifyTreasuryHolderIdAsOwner(entry.holderId);
    const runtimeResolved =
      !expired &&
      (owner.kind === "game-object" || owner.kind === "logical-service") &&
      holderExists(owner.id);
    const ownerStatus: TreasuryReservationOwnerStatus = expired
      ? "expired"
      : owner.kind === "legacy-unresolved"
        ? "missing-owner"
        : runtimeResolved
          ? "active-resolved"
          : "active-unresolved";
    const record: TreasuryReservationRecord = Object.freeze({
      roomName: entry.roomName,
      resource: entry.resource,
      holderId: entry.holderId,
      owner,
      amount: entry.amount,
      expiresAt: entry.expiresAt,
      expired,
      ownerStatus,
    });
    reservationSnapshot.push(record);
    if (expired) {
      metrics.expiredReservationsExcluded += 1;
      options.onExpiredExcluded?.();
      continue;
    }
    // 活跃预留（含 owner 无法确证失效的）全部计入 committed。
    if (ownerStatus !== "active-resolved") {
      metrics.missingOwnerStillCommitted += 1;
      options.onMissingOwnerCommitted?.();
    } else {
      metrics.typedOwnerResolved += 1;
    }
    if (owner.kind === "legacy-unresolved") metrics.legacyUnresolvedOwners += 1;
    metrics.activeReservationRecords += 1;
    const key = taskKey(entry.roomName, entry.resource);
    const bucket = reservedByRoomResource.get(key) ?? { total: 0, byOwner: new Map<string, number>() };
    // 聚合安全整数检查：溢出即该 (room,resource) scope incomplete。
    const mergedTotal = addSafeInteger(bucket.total, entry.amount);
    const ownerKey = treasuryOwnerIdentityKey(owner);
    const mergedOwner = addSafeInteger(bucket.byOwner.get(ownerKey) ?? 0, entry.amount);
    if (mergedTotal === null || mergedOwner === null) {
      recordInvalid();
      incompleteScopes.add(key);
      continue;
    }
    bucket.total = mergedTotal;
    bucket.byOwner.set(ownerKey, mergedOwner);
    reservedByRoomResource.set(key, bucket);
  }

  metrics.invalidCommitmentRecords = invalidCommitmentRecords.count;
  metrics.incompleteCommitmentScopes = incompleteScopes.size;
  metrics.globallyIncomplete = globalIncomplete;
  const completenessSnapshot = Object.freeze({
    complete: invalidCommitmentRecords.count === 0,
    globalIncomplete,
    incompleteScopeCount: incompleteScopes.size,
    invalidRecords: invalidCommitmentRecords.count,
  });

  const index: TreasuryCommitmentIndex = {    builtAtTick: tick,
    revision,
    completeness: completenessSnapshot,
    commitmentCompleteness(roomName, resource) {
      metrics.indexQueries += 1;
      if (globalIncomplete) return "globally-incomplete";
      return incompleteScopes.has(taskKey(roomName, resource)) ? "incomplete-scope" : "complete";
    },
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
    reservedProduction(roomName, resource, excludeOwner) {
      metrics.indexQueries += 1;
      const bucket = reservedByRoomResource.get(taskKey(roomName, resource));
      if (!bucket) return 0;
      if (!excludeOwner) return bucket.total;
      // 完整 typed identity 比较：同 kind + 同 id + 同 namespace 才排除；
      // 同字符串不同 kind / legacy-unresolved 不互相排除。
      return bucket.total - (bucket.byOwner.get(treasuryOwnerIdentityKey(excludeOwner)) ?? 0);
    },
    reservationSnapshot() {
      metrics.indexQueries += 1;
      return Object.freeze([...reservationSnapshot]);
    },
    receiverCommitments(roomName) {
      metrics.indexQueries += 1;
      let roomComplete = !globalIncomplete;
      if (roomComplete) {
        for (const scope of incompleteScopes) {
          if (scope.startsWith(`${roomName} `)) { roomComplete = false; break; }
        }
      }
      // 每次动态组合：静态承诺（healthy incoming，点时快照）+ observed 容量
      // （O(1) map 读）+ 当前 overlay 容量净变化（facade 注入的 O(1) 位置
      // 聚合）。绝不缓存依赖当前 overlay 的 projected 字段——同 tick 结算
      // 新 transaction 后的下一次查询必须立即反映最新投影。
      const healthyIncomingAmount = healthyIncomingByRoom.get(roomName) ?? 0;
      const healthyIncomingTaskCount = healthyIncomingCountByRoom.get(roomName) ?? 0;
      const storageFreeCapacity = options.observation.freeCapacity(roomName, "storage");
      const terminalFreeCapacity = options.observation.freeCapacity(roomName, "terminal");
      const projectedStorageFree = storageFreeCapacity - capacityDelta(roomName, "storage");
      const projectedTerminalFree = terminalFreeCapacity - capacityDelta(roomName, "terminal");
      return Object.freeze({
        roomName,
        healthyIncomingAmount,
        healthyIncomingTaskCount,
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
        // 承诺视图完整才可用于 receiver admission 授权。
        commitmentComplete: roomComplete,
      });
    },
    metrics,
  };

  return index;
}
