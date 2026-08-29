import { getMemoryService } from "@/runtime/runtimeServices";
import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import {
  countsResourceTransferTaskTowardDemand,
  getResourceTransferTaskDemandCoverageExpirationReason,
  isHealthyReceiverCapacityCommitment,
  isHealthyResourceTransferTaskReservation,
  resolveResourceTransferTaskHealthOptions,
  type ResourceTransferTaskHealthOptions,
} from "@/runtime/logistics/resourceTransferTaskHealth";

export type ResourceTransferTaskStatus = "pending" | "done" | "cancelled" | "failed";
export type ResourceTransferTaskOrigin = "manual" | "automatic";
export type ResourceTransferTaskBlockedReason =
  | "receiver_capacity"
  | "source_depleted"
  | "insufficient_terminal_resource_or_fee";

// 健康/需求覆盖谓词已上提至 resourceTransferTaskHealth.ts（canonical 单一实现，
// Treasury 索引与既有消费者共用）；此处 re-export 保持 import 路径兼容。
export {
  countsResourceTransferTaskTowardDemand,
  getResourceTransferTaskDemandCoverageExpirationReason,
  isHealthyReceiverCapacityCommitment,
  isHealthyResourceTransferTaskReservation,
  resolveResourceTransferTaskHealthOptions,
  DEFAULT_AUTOMATIC_TASK_NO_PROGRESS_TTL,
  DEFAULT_SOURCE_DEPLETED_GRACE_TICKS,
  DEFAULT_RECEIVER_CAPACITY_DEMAND_COVERAGE_GRACE_TICKS,
} from "@/runtime/logistics/resourceTransferTaskHealth";
export type {
  ResourceTransferTaskHealthOptions,
  ResourceTransferTaskDemandCoverageExpirationReason,
} from "@/runtime/logistics/resourceTransferTaskHealth";

export const RESOURCE_TRANSFER_TASK_SCHEMA_VERSION = 2;

export interface ResourceTransferTask {
  id: string;
  resource: ResourceConstant;
  fromRoomName: string;
  toRoomName: string;
  amount: number;
  remainingAmount: number;
  status: ResourceTransferTaskStatus;
  createdAt: number;
  updatedAt: number;
  origin: ResourceTransferTaskOrigin;
  lastProgressAt: number;
  blockedReason?: ResourceTransferTaskBlockedReason;
  blockedSince?: number;
  reason?: string;
  lastError?: string;
}

export interface ResourceTransferTaskAmountIndex {
  getOutgoing(roomName: string, resource: ResourceConstant): number;
  getPendingOutgoing(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
  getIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
  getPendingIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
}

export interface CreateResourceTransferTaskResult {
  ok: true;
  task: ResourceTransferTask;
}

export interface CancelResourceTransferTaskResult {
  ok: true;
  taskId: string;
  previousStatus: ResourceTransferTaskStatus;
}

export interface ListResourceTransferTasksResult {
  ok: true;
  tasks: ResourceTransferTask[];
}

let taskIdSequence = 0;
let taskIdSequenceTick = -1;

const AUTOMATIC_LEGACY_REASON_PREFIXES = [
  "hub:",
  "synthesis:",
  "auto:synthesis:",
  "powerBankBoost",
  "energy-support",
  "capacity:",
];

interface ResourceTransferTaskStoreMemory {
  tasks?: Record<string, ResourceTransferTask>;
  taskSchemaVersion?: number;
}

function inferLegacyTaskOrigin(reason?: string): ResourceTransferTaskOrigin {
  if (reason && AUTOMATIC_LEGACY_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))) {
    return "automatic";
  }
  return "manual";
}

function migrateResourceTransferTasksToV2(memory: ResourceTransferTaskStoreMemory): void {
  if ((memory.taskSchemaVersion ?? 0) >= RESOURCE_TRANSFER_TASK_SCHEMA_VERSION) {
    return;
  }

  for (const task of Object.values(memory.tasks || {})) {
    const legacyTask = task as ResourceTransferTask & {
      origin?: ResourceTransferTaskOrigin;
      lastProgressAt?: number;
      updatedAt?: number;
    };
    if (legacyTask.origin !== "manual" && legacyTask.origin !== "automatic") {
      legacyTask.origin = inferLegacyTaskOrigin(legacyTask.reason);
    }

    const fallbackUpdatedAt = Number.isFinite(legacyTask.updatedAt) ? legacyTask.updatedAt! : legacyTask.createdAt;
    legacyTask.updatedAt = fallbackUpdatedAt;
    if (!Number.isFinite(legacyTask.lastProgressAt)) {
      legacyTask.lastProgressAt = fallbackUpdatedAt;
    }

    if (legacyTask.lastError === "insufficient_terminal_resource_or_fee") {
      legacyTask.blockedReason = "insufficient_terminal_resource_or_fee";
      legacyTask.blockedSince = legacyTask.blockedSince ?? fallbackUpdatedAt;
      legacyTask.lastError = undefined;
    }
  }

  memory.taskSchemaVersion = RESOURCE_TRANSFER_TASK_SCHEMA_VERSION;
}

export function ensureResourceTransferTaskStore(): Record<string, ResourceTransferTask> {
  const data = getMemoryService().ensureData();
  data.resourceControl = data.resourceControl || { tasks: {} };
  data.resourceControl.tasks = data.resourceControl.tasks || {};
  migrateResourceTransferTasksToV2(data.resourceControl);
  return data.resourceControl.tasks;
}

export function getResourceTransferTaskListSorted(): ResourceTransferTask[] {
  return Object.values(ensureResourceTransferTaskStore()).sort((left, right) => left.createdAt - right.createdAt);
}

function createTaskId(resource: ResourceConstant, fromRoomName: string, toRoomName: string): string {
  if (taskIdSequenceTick !== Game.time) {
    taskIdSequenceTick = Game.time;
    taskIdSequence = 0;
  }

  taskIdSequence += 1;
  return `${Game.time}:${taskIdSequence}:${resource}:${fromRoomName}->${toRoomName}`;
}

function normalizeTaskReason(reason?: string): string | undefined {
  if (!reason) {
    return undefined;
  }

  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findMergeablePendingTask(
  tasks: Record<string, ResourceTransferTask>,
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  origin: ResourceTransferTaskOrigin,
  reason?: string,
): ResourceTransferTask | null {
  const healthOptions = origin === "automatic"
    ? resolveResourceTransferTaskHealthOptions()
    : null;
  for (const task of Object.values(tasks)) {
    if (
      task.status === "pending" &&
      task.fromRoomName === fromRoomName &&
      task.toRoomName === toRoomName &&
      task.resource === resource &&
      task.origin === origin &&
      task.reason === reason &&
      (origin === "manual" || countsResourceTransferTaskTowardDemand(task, healthOptions!))
    ) {
      return task;
    }
  }

  return null;
}

function createResourceTransferTaskWithOrigin(
  origin: ResourceTransferTaskOrigin,
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): CreateResourceTransferTaskResult | string {
  if (!fromRoomName || !toRoomName) {
    return "ERR_INVALID_ROOM";
  }
  if (fromRoomName === toRoomName) {
    return "ERR_SAME_ROOM";
  }
  if (typeof resource !== "string" || resource.length === 0) {
    return "ERR_INVALID_RESOURCE";
  }
  if (!RESOURCES_ALL.includes(resource as ResourceConstant)) {
    return "ERR_INVALID_RESOURCE";
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return "ERR_INVALID_AMOUNT";
  }

  const normalizedAmount = Math.floor(amount);
  if (normalizedAmount <= 0) {
    return "ERR_INVALID_AMOUNT";
  }

  const normalizedReason = normalizeTaskReason(reason);
  const store = ensureResourceTransferTaskStore();
  const mergeTarget = findMergeablePendingTask(store, fromRoomName, toRoomName, resource, origin, normalizedReason);
  if (mergeTarget) {
    mergeTarget.amount += normalizedAmount;
    mergeTarget.remainingAmount += normalizedAmount;
    mergeTarget.updatedAt = Game.time;
    mergeTarget.lastError = undefined;
    bumpTreasuryCommitmentRevision();
    return {
      ok: true,
      task: mergeTarget,
    };
  }

  const task: ResourceTransferTask = {
    id: createTaskId(resource, fromRoomName, toRoomName),
    resource,
    fromRoomName,
    toRoomName,
    amount: normalizedAmount,
    remainingAmount: normalizedAmount,
    status: "pending",
    createdAt: Game.time,
    updatedAt: Game.time,
    origin,
    lastProgressAt: Game.time,
    reason: normalizedReason,
  };

  store[task.id] = task;
  bumpTreasuryCommitmentRevision();
  return {
    ok: true,
    task,
  };
}

export function createResourceTransferTask(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): CreateResourceTransferTaskResult | string {
  return createResourceTransferTaskWithOrigin("manual", fromRoomName, toRoomName, resource, amount, reason);
}

export function createAutomaticResourceTransferTask(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): CreateResourceTransferTaskResult | string {
  return createResourceTransferTaskWithOrigin("automatic", fromRoomName, toRoomName, resource, amount, reason);
}

export function cancelResourceTransferTask(taskId: string): CancelResourceTransferTaskResult | string {
  const store = ensureResourceTransferTaskStore();
  const task = store[taskId];
  if (!task) {
    return `ERR_TASK_NOT_FOUND:${taskId}`;
  }

  const previousStatus = task.status;
  task.status = "cancelled";
  task.updatedAt = Game.time;
  task.blockedReason = undefined;
  task.blockedSince = undefined;
  task.lastError = "cancelled_by_command";
  bumpTreasuryCommitmentRevision();

  return {
    ok: true,
    taskId,
    previousStatus,
  };
}

export function markResourceTransferTaskBlocked(
  task: ResourceTransferTask,
  reason: ResourceTransferTaskBlockedReason,
): void {
  if (task.status !== "pending") {
    return;
  }

  if (task.blockedReason !== reason || !Number.isFinite(task.blockedSince)) {
    task.blockedReason = reason;
    task.blockedSince = Game.time;
    task.updatedAt = Game.time;
  }
  task.lastError = undefined;
  bumpTreasuryCommitmentRevision();
}

export function clearResourceTransferTaskBlocker(task: ResourceTransferTask): void {
  if (task.blockedReason === undefined && task.blockedSince === undefined) {
    return;
  }

  task.blockedReason = undefined;
  task.blockedSince = undefined;
  task.updatedAt = Game.time;
  bumpTreasuryCommitmentRevision();
}

export function recordResourceTransferTaskProgress(task: ResourceTransferTask): void {
  task.blockedReason = undefined;
  task.blockedSince = undefined;
  task.lastProgressAt = Game.time;
  task.updatedAt = Game.time;
  task.lastError = undefined;
  bumpTreasuryCommitmentRevision();
}

function cancelAutomaticTask(task: ResourceTransferTask, reason: string): void {
  task.status = "cancelled";
  task.updatedAt = Game.time;
  task.lastError = reason;
  bumpTreasuryCommitmentRevision();
}

export function reconcileResourceTransferTasks(
  options: Partial<ResourceTransferTaskHealthOptions> = {},
): number {
  const configured = resolveResourceTransferTaskHealthOptions();
  const automaticTaskNoProgressTtl = Number.isFinite(options.automaticTaskNoProgressTtl)
    ? Math.max(0, Math.floor(options.automaticTaskNoProgressTtl!))
    : configured.automaticTaskNoProgressTtl;
  const sourceDepletedGraceTicks = Number.isFinite(options.sourceDepletedGraceTicks)
    ? Math.max(0, Math.floor(options.sourceDepletedGraceTicks!))
    : configured.sourceDepletedGraceTicks;
  const receiverCapacityDemandCoverageGraceTicks = Number.isFinite(
    options.receiverCapacityDemandCoverageGraceTicks,
  )
    ? Math.max(0, Math.floor(options.receiverCapacityDemandCoverageGraceTicks!))
    : configured.receiverCapacityDemandCoverageGraceTicks;
  const healthOptions: ResourceTransferTaskHealthOptions = {
    automaticTaskNoProgressTtl,
    sourceDepletedGraceTicks,
    receiverCapacityDemandCoverageGraceTicks,
  };

  let cancelled = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status !== "pending" || task.origin !== "automatic") {
      continue;
    }

    const expirationReason = getResourceTransferTaskDemandCoverageExpirationReason(task, healthOptions);
    if (expirationReason) {
      cancelAutomaticTask(task, expirationReason);
      cancelled += 1;
    }
  }

  return cancelled;
}

export function listResourceTransferTasks(): ListResourceTransferTasksResult {
  return {
    ok: true,
    tasks: getResourceTransferTaskListSorted(),
  };
}

export function getOutgoingResourceTransferAmount(roomName: string, resource: ResourceConstant): number {
  let total = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status === "pending" && task.fromRoomName === roomName && task.resource === resource) {
      total += task.remainingAmount;
    }
  }
  return total;
}

function transferAmountKey(roomName: string, resource: ResourceConstant): string {
  return `${roomName}:${resource}`;
}

function getIndexedAmount(
  totals: Map<string, number>,
  byReason: Map<string, Map<string, number>>,
  roomName: string,
  resource: ResourceConstant,
  reasonPrefix?: string,
): number {
  const key = transferAmountKey(roomName, resource);
  if (!reasonPrefix) return totals.get(key) || 0;

  let total = 0;
  for (const [reason, amount] of byReason.get(key) || []) {
    if (reason.startsWith(reasonPrefix)) total += amount;
  }
  return total;
}

/**
 * Builds a point-in-time lookup for transfer planning. Only pending tasks
 * contribute, matching the public incoming/outgoing amount helpers.
 */
export function createResourceTransferTaskAmountIndex(): ResourceTransferTaskAmountIndex {
  const incoming = new Map<string, number>();
  const incomingByReason = new Map<string, Map<string, number>>();
  const outgoing = new Map<string, number>();
  const outgoingByReason = new Map<string, Map<string, number>>();
  const pendingIncoming = new Map<string, number>();
  const pendingIncomingByReason = new Map<string, Map<string, number>>();
  const healthOptions = resolveResourceTransferTaskHealthOptions();

  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status !== "pending") continue;

    const outgoingKey = transferAmountKey(task.fromRoomName, task.resource);
    outgoing.set(outgoingKey, (outgoing.get(outgoingKey) || 0) + task.remainingAmount);
    const reason = task.reason || "";
    const outgoingReasonAmounts = outgoingByReason.get(outgoingKey) || new Map<string, number>();
    outgoingReasonAmounts.set(reason, (outgoingReasonAmounts.get(reason) || 0) + task.remainingAmount);
    outgoingByReason.set(outgoingKey, outgoingReasonAmounts);

    const incomingKey = transferAmountKey(task.toRoomName, task.resource);
    pendingIncoming.set(incomingKey, (pendingIncoming.get(incomingKey) || 0) + task.remainingAmount);
    const pendingReasonAmounts = pendingIncomingByReason.get(incomingKey) || new Map<string, number>();
    pendingReasonAmounts.set(reason, (pendingReasonAmounts.get(reason) || 0) + task.remainingAmount);
    pendingIncomingByReason.set(incomingKey, pendingReasonAmounts);

    if (!countsResourceTransferTaskTowardDemand(task, healthOptions)) continue;
    incoming.set(incomingKey, (incoming.get(incomingKey) || 0) + task.remainingAmount);
    const reasonAmounts = incomingByReason.get(incomingKey) || new Map<string, number>();
    reasonAmounts.set(reason, (reasonAmounts.get(reason) || 0) + task.remainingAmount);
    incomingByReason.set(incomingKey, reasonAmounts);
  }

  return {
    getOutgoing(roomName: string, resource: ResourceConstant): number {
      return outgoing.get(transferAmountKey(roomName, resource)) || 0;
    },
    getPendingOutgoing(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number {
      return getIndexedAmount(outgoing, outgoingByReason, roomName, resource, reasonPrefix);
    },
    getIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number {
      return getIndexedAmount(incoming, incomingByReason, roomName, resource, reasonPrefix);
    },
    getPendingIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number {
      return getIndexedAmount(pendingIncoming, pendingIncomingByReason, roomName, resource, reasonPrefix);
    },
  };
}

export function getIncomingResourceTransferAmount(roomName: string, resource: ResourceConstant): number {
  let total = 0;
  const healthOptions = resolveResourceTransferTaskHealthOptions();
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (
      task.status === "pending" &&
      task.toRoomName === roomName &&
      task.resource === resource &&
      countsResourceTransferTaskTowardDemand(task, healthOptions)
    ) {
      total += task.remainingAmount;
    }
  }
  return total;
}

export function countPendingOutgoingResourceTransferTasksByRoom(roomName: string): number {
  let count = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status === "pending" && task.fromRoomName === roomName) {
      count += 1;
    }
  }

  return count;
}

export function countPendingIncomingResourceTransferTasksByRoom(roomName: string): number {
  let count = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status === "pending" && task.toRoomName === roomName) {
      count += 1;
    }
  }

  return count;
}

export function countDemandCoveringIncomingResourceTransferTasksByRoom(roomName: string): number {
  let count = 0;
  const healthOptions = resolveResourceTransferTaskHealthOptions();
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (
      task.toRoomName === roomName &&
      countsResourceTransferTaskTowardDemand(task, healthOptions)
    ) {
      count += 1;
    }
  }

  return count;
}

export function cleanupResourceTransferTaskStore(
  ownedRooms: Set<string>,
  terminalTaskTtl: number,
  automaticTaskNoProgressTtl?: number,
  sourceDepletedGraceTicks?: number,
  receiverCapacityDemandCoverageGraceTicks?: number,
): number {
  const tasks = getMemoryService().ensureData().resourceControl?.tasks;
  if (!tasks) {
    return 0;
  }

  reconcileResourceTransferTasks({
    automaticTaskNoProgressTtl,
    sourceDepletedGraceTicks,
    receiverCapacityDemandCoverageGraceTicks,
  });

  let removed = 0;
  for (const [taskId, task] of Object.entries(tasks)) {
    const sourceOrTargetLost = !ownedRooms.has(task.fromRoomName) || !ownedRooms.has(task.toRoomName);
    const terminalStale =
      (task.status === "done" || task.status === "cancelled" || task.status === "failed") &&
      Game.time - task.updatedAt > terminalTaskTtl;
    if (sourceOrTargetLost || terminalStale) {
      delete tasks[taskId];
      removed += 1;
    }
  }

  if (Object.keys(tasks).length === 0) {
    // ResourceControl owns sibling logistics state under the same persistent
    // branch. Keep cleanup scoped to the legacy task fields so an empty task
    // store cannot erase a versioned shadow/contract adapter.
    const resourceControl = getMemoryService().ensureData().resourceControl;
    if (resourceControl) {
      resourceControl.taskSchemaVersion = RESOURCE_TRANSFER_TASK_SCHEMA_VERSION;
      resourceControl.tasks = {};
    }
  }

  if (removed > 0) bumpTreasuryCommitmentRevision();
  return removed;
}
