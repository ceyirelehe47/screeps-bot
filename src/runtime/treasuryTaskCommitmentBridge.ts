import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import type { TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { readTreasuryT1Quota, readTreasuryT1Responsibility } from "@/runtime/treasuryT1Responsibility";
import { readTreasuryT1FirstLiveControl } from "@/runtime/treasuryT1FirstLiveState";
import {
  decodeTreasuryT1DurableFacts,
  TREASURY_T1_ACTION_KIND,
  TREASURY_T1_RUN_ID,
  TREASURY_T1_SOURCE_ROOM,
  TREASURY_T1_TARGET_ROOM,
  treasuryT1WorkKey,
  type DurableT1Facts,
} from "@/runtime/treasuryT1Facts";

export {
  TREASURY_T1_ACTION_KIND,
  TREASURY_T1_RUN_ID,
  TREASURY_T1_SOURCE_ROOM,
  TREASURY_T1_TARGET_ROOM,
  TREASURY_T1_WORK_KEY_PREFIX,
  treasuryT1WorkKey,
} from "@/runtime/treasuryT1Facts";

interface TemporaryExclusion {
  readonly taskId: string;
  readonly amount: number;
  readonly workKey: string;
  readonly taskCreatedAt: number;
  readonly taskAmount: number;
}

let temporaryExclusion: TemporaryExclusion | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep both terminals' native writers fenced while a T1 send may be in
 * flight. A damaged quota is held conservatively; a drained quota alone is
 * inert, but an active kernel record or task lease still keeps the fence. */
export function hasTreasuryT1TerminalFence(): boolean {
  return readTreasuryT1FirstLiveControl().status === "invalid" ||
    readTreasuryT1Responsibility().status !== "clear";
}

/** Keep the exact business row until its native responsibility has closed. */
export function hasTreasuryT1TaskRetention(task: ResourceTransferTask): boolean {
  if (task.treasurySlice !== undefined) return true;
  const matches = task.fromRoomName === TREASURY_T1_SOURCE_ROOM &&
    task.toRoomName === TREASURY_T1_TARGET_ROOM && task.resource === RESOURCE_HYDROGEN;
  const runtime = (Memory as unknown as { runtime?: Record<string, unknown> }).runtime;
  const quota = readTreasuryT1Quota();
  const rawQuota = runtime?.treasuryProductionT1Quota;
  if (quota.status === "invalid" &&
      (isPlainObject(rawQuota) && rawQuota.taskId === task.id || matches)) return true;
  if (quota.status === "valid" && quota.value.status !== "drained" && quota.value.taskId === task.id) return true;
  const core = runtime?.treasuryCore;
  if (core === undefined) return false;
  if (!isPlainObject(core) || !isPlainObject(core.active)) return matches;
  return Object.values(core.active).some((record) =>
    isPlainObject(record) && record.workKey === treasuryT1WorkKey(task.id));
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readDurableFacts(record: TreasuryCoreWorkRecord): DurableT1Facts | null {
  return decodeTreasuryT1DurableFacts(record.identity.durableFacts?.payload);
}

/**
 * Exclude exactly the selected legacy task slice while the matching Treasury
 * work is active. Other tasks and all reservation owners remain committed.
 */
export function treasuryTaskCommitmentView(
  tasks: Record<string, ResourceTransferTask>,
  active: readonly TreasuryCoreWorkRecord[],
): Record<string, ResourceTransferTask> {
  const activeSlices = new Map<string, { amount: number; count: number; taskCreatedAt: number; taskAmount: number | null; attemptId: string }>();
  const quota = readTreasuryT1Quota();
  const control = readTreasuryT1FirstLiveControl();
  for (const record of active) {
    const facts = readDurableFacts(record);
    if (!facts || record.identity.actionKind !== TREASURY_T1_ACTION_KIND ||
        record.workKey !== treasuryT1WorkKey(facts.taskId)) continue;
    const previous = activeSlices.get(facts.taskId);
    activeSlices.set(facts.taskId, {
      amount: facts.amount,
      count: (previous?.count ?? 0) + 1,
      taskCreatedAt: facts.taskCreatedAt,
      taskAmount: quota.status === "valid" && quota.value.taskId === facts.taskId &&
        quota.value.taskCreatedAt === facts.taskCreatedAt && quota.value.attemptId === record.attemptId
        ? quota.value.taskAmount : control.status === "valid" && control.value.taskId === facts.taskId &&
          control.value.taskCreatedAt === facts.taskCreatedAt ? control.value.taskAmount : null,
      attemptId: record.attemptId,
    });
  }
  const view: Record<string, ResourceTransferTask> = Object.create(null) as Record<string, ResourceTransferTask>;
  for (const [taskId, task] of Object.entries(tasks)) {
    let excludedAmount = 0;
    const activeSlice = activeSlices.get(taskId);
    if (task.id === taskId && activeSlice?.count === 1 && task.createdAt === activeSlice.taskCreatedAt &&
        task.amount === activeSlice.taskAmount && task.resource === RESOURCE_HYDROGEN &&
        task.fromRoomName === TREASURY_T1_SOURCE_ROOM && task.toRoomName === TREASURY_T1_TARGET_ROOM) {
      const lease = task.treasurySlice;
      if (
        lease === undefined ||
        (lease.schemaVersion === 1 && lease.runId === TREASURY_T1_RUN_ID &&
          lease.workKey === treasuryT1WorkKey(taskId) && lease.amount === activeSlice.amount &&
          (lease.attemptId === activeSlice.attemptId || (lease.phase === "preparing" && lease.attemptId === "")))
      ) {
        excludedAmount = activeSlice.amount;
      }
    }
    if (
      excludedAmount === 0 && temporaryExclusion?.taskId === taskId &&
      task.id === taskId && temporaryExclusion.workKey === treasuryT1WorkKey(taskId) &&
      task.createdAt === temporaryExclusion.taskCreatedAt && task.amount === temporaryExclusion.taskAmount &&
      task.resource === RESOURCE_HYDROGEN && task.fromRoomName === TREASURY_T1_SOURCE_ROOM &&
      task.toRoomName === TREASURY_T1_TARGET_ROOM &&
      Number.isSafeInteger(task.remainingAmount) && task.remainingAmount >= temporaryExclusion.amount
    ) {
      excludedAmount += temporaryExclusion.amount;
    }
    if (
      excludedAmount > 0 && Number.isSafeInteger(task.remainingAmount) &&
      task.remainingAmount >= excludedAmount
    ) {
      view[taskId] = { ...task, remainingAmount: task.remainingAmount - excludedAmount };
    } else {
      view[taskId] = task;
    }
  }
  return view;
}

/** Synchronous, exact-slice admission exclusion; no persistent task mutation. */
export function withTreasuryTaskSliceExcluded<T>(
  taskId: string,
  amount: number,
  action: () => T,
): T {
  if (temporaryExclusion !== null) throw new Error("nested Treasury task slice exclusion");
  if (!isSafePositiveInteger(amount)) throw new Error("invalid Treasury task slice amount");
  const workKey = treasuryT1WorkKey(taskId);
  const task = Memory.data?.resourceControl?.tasks?.[taskId];
  if (!task || task.id !== taskId) throw new Error("Treasury task identity unavailable");
  temporaryExclusion = { taskId, amount, workKey, taskCreatedAt: task.createdAt, taskAmount: task.amount };
  bumpTreasuryCommitmentRevision();
  try {
    return action();
  } finally {
    temporaryExclusion = null;
    bumpTreasuryCommitmentRevision();
  }
}
