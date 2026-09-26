import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import type { TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
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
}

let temporaryExclusion: TemporaryExclusion | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep both terminals' native writers fenced while a T1 send may be in
 * flight. A damaged quota is held conservatively; a drained quota alone is
 * inert, but an active kernel record or task lease still keeps the fence. */
export function hasTreasuryT1TerminalFence(): boolean {
  const runtime = (Memory as unknown as { runtime?: Record<string, unknown> }).runtime;
  const quota = runtime?.treasuryProductionT1Quota;
  if (quota !== undefined &&
      (!isPlainObject(quota) || quota.runId !== TREASURY_T1_RUN_ID || quota.status !== "drained")) {
    return true;
  }
  const core = runtime?.treasuryCore;
  if (isPlainObject(core) && core.active !== undefined) {
    if (!isPlainObject(core.active)) return true;
    if (Object.values(core.active).some((record) => isPlainObject(record) &&
        isPlainObject(record.identity) && record.identity.actionKind === TREASURY_T1_ACTION_KIND)) {
      return true;
    }
  }
  const tasks = Memory.data?.resourceControl?.tasks;
  return !!tasks && Object.values(tasks).some((task) =>
    (task as ResourceTransferTask & { treasurySlice?: unknown }).treasurySlice !== undefined);
}

/** Keep the exact business row until its native responsibility has closed. */
export function hasTreasuryT1TaskRetention(task: ResourceTransferTask): boolean {
  if (task.treasurySlice !== undefined) return true;
  if (task.fromRoomName !== TREASURY_T1_SOURCE_ROOM ||
      task.toRoomName !== TREASURY_T1_TARGET_ROOM ||
      task.resource !== RESOURCE_HYDROGEN) return false;
  const runtime = (Memory as unknown as { runtime?: Record<string, unknown> }).runtime;
  const quota = runtime?.treasuryProductionT1Quota;
  if (quota !== undefined &&
      (!isPlainObject(quota) ||
       (quota.status !== "drained" &&
        (quota.taskId === task.id || typeof quota.taskId !== "string")))) return true;
  const core = runtime?.treasuryCore;
  if (!isPlainObject(core) || core.active === undefined) return false;
  if (!isPlainObject(core.active)) return true;
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
  const activeSlices = new Map<string, { amount: number; count: number }>();
  for (const record of active) {
    const facts = readDurableFacts(record);
    if (!facts || record.identity.actionKind !== TREASURY_T1_ACTION_KIND ||
        record.workKey !== treasuryT1WorkKey(facts.taskId)) continue;
    const previous = activeSlices.get(facts.taskId);
    activeSlices.set(facts.taskId, {
      amount: facts.amount,
      count: (previous?.count ?? 0) + 1,
    });
  }
  const view: Record<string, ResourceTransferTask> = Object.create(null) as Record<string, ResourceTransferTask>;
  for (const [taskId, task] of Object.entries(tasks)) {
    let excludedAmount = 0;
    const activeSlice = activeSlices.get(taskId);
    if (task.id === taskId && activeSlice?.count === 1) {
      const lease = task.treasurySlice;
      if (
        lease === undefined ||
        (lease.schemaVersion === 1 && lease.runId === TREASURY_T1_RUN_ID &&
          lease.workKey === treasuryT1WorkKey(taskId) && lease.amount === activeSlice.amount)
      ) {
        excludedAmount = activeSlice.amount;
      }
    }
    if (
      excludedAmount === 0 && temporaryExclusion?.taskId === taskId &&
      task.id === taskId && temporaryExclusion.workKey === treasuryT1WorkKey(taskId) &&
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
  temporaryExclusion = { taskId, amount, workKey };
  bumpTreasuryCommitmentRevision();
  try {
    return action();
  } finally {
    temporaryExclusion = null;
    bumpTreasuryCommitmentRevision();
  }
}
