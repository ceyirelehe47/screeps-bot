import { bumpTreasuryCommitmentRevision, readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import type { TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { createTreasuryFirstLiveState } from "@/runtime/treasuryFirstLiveState";
import { readTreasuryLaneQuota, readTreasuryLaneResponsibility, isKnownEmptyLegacyTreasuryRoot } from "@/runtime/treasuryTerminalResponsibility";
import { decodeTreasuryTerminalFacts } from "@/runtime/treasuryTerminalFacts";
import { TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_TERMINAL_LANES, treasuryLaneWorkKey, treasuryLaneTaskMatches, type TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
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
  readonly lane: TreasuryTerminalLane;
}

let temporaryExclusion: TemporaryExclusion | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep both terminals' native writers fenced while a T1 send may be in
 * flight. A damaged quota is held conservatively; a drained quota alone is
 * inert, but an active kernel record or task lease still keeps the fence. */
interface FenceCache {
  game: Game; memory: Memory; tick: number; revision: number;
  pointers: readonly unknown[]; quotaToken: string; value: boolean;
}
const fenceCache = new Map<string, FenceCache>();
function hasLaneFence(lane: TreasuryTerminalLane): boolean {
  const runtime = Memory.runtime as unknown as Record<string, unknown> | undefined;
  const data = Memory.data as unknown as Record<string, unknown> | undefined;
  const resource = data?.resourceControl as Record<string,unknown> | undefined;
  const core = runtime?.treasuryCore as Record<string,unknown> | undefined;
  const pointers = [runtime,data,resource,resource?.tasks,runtime?.treasury,core,core?.active,core?.ring,
    ...TREASURY_TERMINAL_LANES.flatMap((known) => [runtime?.[known.controlKey],runtime?.[known.controlMirrorKey],runtime?.[known.quotaKey]])];
  const quotaToken = TREASURY_TERMINAL_LANES.map((known) => {
    const q = runtime?.[known.quotaKey] as Record<string,unknown> | undefined;
    const c = runtime?.[known.controlKey] as Record<string,unknown> | undefined;
    return [q?.schemaVersion,q?.runId,q?.status,q?.taskId,q?.workKey,q?.attemptId,q?.amount,q?.taskCreatedAt,q?.taskAmount,q?.reservedAtTick,
      c?.hash,c?.status].join("|");
  }).join(";");
  // Fixed-size control/quota validation is cheap and catches in-place corruption, including the mirror.
  // Only the empire-wide kernel/task responsibility inspection is cached.
  const control = createTreasuryFirstLiveState(lane).readControl();
  if (!isKnownEmptyLegacyTreasuryRoot(runtime?.treasury)) return true;
  if (control.status === "invalid" || TREASURY_TERMINAL_LANES.some((known) => readTreasuryLaneQuota(known).status === "invalid")) return true;
  if (lane.name === "T2" && control.status === "valid" && control.value.status === "active") return true;
  const revision = readTreasuryCommitmentRevision(); const cached = fenceCache.get(lane.name);
  if (cached?.game === Game && cached.memory === Memory && cached.tick === Game.time && cached.revision === revision &&
      cached.quotaToken === quotaToken && cached.pointers.every((pointer,index) => pointer === pointers[index])) return cached.value;
  const value = readTreasuryLaneResponsibility(lane).status !== "clear";
  // Core publication replaces its root; leases bump revision, controls/quotas replace their signed object.
  // Thus same-tick new responsibility is visible without re-scanning the empire on every carrier action.
  fenceCache.set(lane.name,{game:Game,memory:Memory,tick:Game.time,revision,pointers,quotaToken,value});
  return value;
}
export function hasTreasuryT1TerminalFence(): boolean { return hasLaneFence(TREASURY_T1_LANE); }
export function hasTreasuryT2TerminalFence(): boolean { return hasLaneFence(TREASURY_T2_LANE); }
export function hasTreasuryTerminalFence(roomName: string): boolean {
  return TREASURY_TERMINAL_LANES.some((lane) =>
    (roomName === lane.sourceRoom || roomName === lane.targetRoom) && hasLaneFence(lane));
}
/** Exact canonical rows survive cancellation/cleanup while their native responsibility remains. */
export function hasTreasuryT1TaskRetention(task: ResourceTransferTask): boolean {
  if (task.treasurySlice !== undefined) return true;
  const runtime = (Memory as unknown as { runtime?: Record<string, unknown> }).runtime;
  for (const lane of TREASURY_TERMINAL_LANES) {
    const matches = treasuryLaneTaskMatches(lane, task);
    const quota = readTreasuryLaneQuota(lane);
    const rawQuota = runtime?.[lane.quotaKey];
    if (quota.status === "invalid" && (isPlainObject(rawQuota) && rawQuota.taskId === task.id || matches)) return true;
    if (quota.status === "valid" && quota.value.status !== "drained" && quota.value.taskId === task.id) return true;
    const core = runtime?.treasuryCore;
    if (core !== undefined) {
      if (!isPlainObject(core) || !isPlainObject(core.active)) { if (matches) return true; }
      else if (Object.values(core.active).some((record) => isPlainObject(record) && record.workKey === treasuryLaneWorkKey(lane, task.id))) return true;
    }
  }
  return false;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Exclude exactly the selected legacy task slice while the matching Treasury
 * work is active. Other tasks and all reservation owners remain committed.
 */
export function treasuryTaskCommitmentView(
  tasks: Record<string, ResourceTransferTask>,
  active: readonly TreasuryCoreWorkRecord[],
): Record<string, ResourceTransferTask> {
  const activeSlices = new Map<string, { amount: number; count: number; taskCreatedAt: number; taskAmount: number | null; attemptId: string; lane: TreasuryTerminalLane }>();
  for (const record of active) {
    const lane = TREASURY_TERMINAL_LANES.find((entry) => entry.actionKind === record.identity.actionKind);
    if (!lane) continue;
    const facts = decodeTreasuryTerminalFacts(lane, record.identity.durableFacts?.payload);
    const quota = readTreasuryLaneQuota(lane);
    const control = createTreasuryFirstLiveState(lane).readControl();
    if (!facts || record.workKey !== treasuryLaneWorkKey(lane, facts.taskId)) continue;
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
      lane,
    });
  }
  const view: Record<string, ResourceTransferTask> = Object.create(null) as Record<string, ResourceTransferTask>;
  for (const [taskId, task] of Object.entries(tasks)) {
    let excludedAmount = 0;
    const activeSlice = activeSlices.get(taskId);
    if (task.id === taskId && activeSlice?.count === 1 && task.createdAt === activeSlice.taskCreatedAt &&
        task.amount === activeSlice.taskAmount && treasuryLaneTaskMatches(activeSlice.lane, task)) {
      const lease = task.treasurySlice;
      if (
        lease === undefined ||
        (lease.schemaVersion === 1 && lease.runId === activeSlice.lane.runId &&
          lease.workKey === treasuryLaneWorkKey(activeSlice.lane, taskId) && lease.amount === activeSlice.amount &&
          (lease.attemptId === activeSlice.attemptId || (lease.phase === "preparing" && lease.attemptId === "")))
      ) {
        excludedAmount = activeSlice.amount;
      }
    }
    if (
      excludedAmount === 0 && temporaryExclusion?.taskId === taskId &&
      task.id === taskId && temporaryExclusion.workKey === treasuryLaneWorkKey(temporaryExclusion.lane, taskId) &&
      task.createdAt === temporaryExclusion.taskCreatedAt && task.amount === temporaryExclusion.taskAmount &&
      treasuryLaneTaskMatches(temporaryExclusion.lane, task) &&
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
  selectedLane: TreasuryTerminalLane = TREASURY_T1_LANE,
): T {
  if (temporaryExclusion !== null) throw new Error("nested Treasury task slice exclusion");
  if (!isSafePositiveInteger(amount)) throw new Error("invalid Treasury task slice amount");
  const workKey = treasuryLaneWorkKey(selectedLane, taskId);
  const task = Memory.data?.resourceControl?.tasks?.[taskId];
  if (!task || task.id !== taskId) throw new Error("Treasury task identity unavailable");
  temporaryExclusion = { taskId, amount, workKey, taskCreatedAt: task.createdAt, taskAmount: task.amount, lane: selectedLane };
  bumpTreasuryCommitmentRevision();
  try {
    return action();
  } finally {
    temporaryExclusion = null;
    bumpTreasuryCommitmentRevision();
  }
}
