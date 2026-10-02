import { bumpTreasuryCommitmentRevision, readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryCoreStoreHealth } from "@/runtime/treasury/kernel/store";
import { readTreasuryWorldSequence } from "@/runtime/treasury/observation";
import { readTreasuryTerminalControl, readTreasuryTerminalFenceControl } from "@/runtime/treasuryTerminalControl";
import { readTreasuryContinuousOHFenceProjection, type TreasuryContinuousOHFenceProjection } from "@/runtime/treasuryContinuousOHFence";
import type { TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { readTreasuryLaneQuota, readTreasuryLaneFenceQuota, readTreasuryLaneResponsibility, isKnownEmptyLegacyTreasuryRoot } from "@/runtime/treasuryTerminalResponsibility";
import { decodeTreasuryTerminalFacts } from "@/runtime/treasuryTerminalFacts";
import { TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_T3_LANE, TREASURY_TERMINAL_LANES, treasuryLaneWorkKey, treasuryLaneTaskMatches, type TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
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
  game: Game; memory: Memory; tick: number; revision: number; worldSequence: number;
  pointers: readonly unknown[]; quotaToken: string; value: boolean;
}
const fenceCache = new Map<string, FenceCache>();
let coreFenceSnapshot: (Omit<FenceCache, "value"> & { health: ReturnType<typeof readTreasuryCoreStoreHealth> }) | null = null;
function sameFenceSnapshot(cached: Omit<FenceCache, "value"> | null | undefined,
  revision: number, worldSequence: number, quotaToken: string, pointers: readonly unknown[]): boolean {
  return cached?.game === Game && cached.memory === Memory && cached.tick === Game.time &&
    cached.revision === revision && cached.worldSequence === worldSequence && cached.quotaToken === quotaToken &&
    cached.pointers.length === pointers.length && cached.pointers.every((pointer,index) => pointer === pointers[index]);
}
function hasLaneFence(lane: TreasuryTerminalLane, continuousProjection = readTreasuryContinuousOHFenceProjection()): boolean {
  // 投影已拒绝未知root/accessor时先持住责任；不能为缓存pointer/token再读取未知getter。
  if (continuousProjection.control.status === "invalid" || continuousProjection.quota.status === "invalid") return true;
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
  const control = lane.continuous ? continuousProjection.control : readTreasuryTerminalFenceControl(lane);
  if (!isKnownEmptyLegacyTreasuryRoot(runtime?.treasury)) return true;
  if (control.status === "invalid" || TREASURY_TERMINAL_LANES.some((known) =>
      (known.continuous ? continuousProjection.quota : readTreasuryLaneFenceQuota(known)).status === "invalid")) return true;
  if (lane.requiredProduct !== undefined && control.status === "valid" && control.value.status === "active" &&
      (!lane.continuous || control.value.taskId !== "")) return true;
  const revision = readTreasuryCommitmentRevision(); const worldSequence = readTreasuryWorldSequence();
  const cached = fenceCache.get(lane.name);
  if (sameFenceSnapshot(cached, revision, worldSequence, quotaToken, pointers)) return cached!.value;
  // 两个 lane 共用端点时只复用同一 core 的验证快照；各 lane 的额度、
  // task lease、actionKind 与历史仍各自检查，绝不把另一个 lane 的 clear 当作本 lane clear。
  if (!sameFenceSnapshot(coreFenceSnapshot, revision, worldSequence, quotaToken, pointers)) {
    try {
      coreFenceSnapshot = {game:Game,memory:Memory,tick:Game.time,revision,worldSequence,pointers,quotaToken,
        health:readTreasuryCoreStoreHealth()};
    } catch { return true; }
  }
  const value = readTreasuryLaneResponsibility(lane, coreFenceSnapshot!.health, true, continuousProjection).status !== "clear";
  // Core publication replaces its root; leases bump revision, controls/quotas replace their signed object.
  // Thus same-tick new responsibility is visible without re-scanning the empire on every carrier action.
  fenceCache.set(lane.name,{game:Game,memory:Memory,tick:Game.time,revision,worldSequence,pointers,quotaToken,value});
  return value;
}
export function hasTreasuryT1TerminalFence(): boolean { return hasLaneFence(TREASURY_T1_LANE); }
export function hasTreasuryT2TerminalFence(): boolean { return hasLaneFence(TREASURY_T2_LANE); }
export function hasTreasuryT3TerminalFence(): boolean { return hasLaneFence(TREASURY_T3_LANE); }
export function hasTreasuryTerminalFence(roomName: string): boolean {
  const lanes = TREASURY_TERMINAL_LANES.filter((lane) => roomName === lane.sourceRoom || roomName === lane.targetRoom);
  if (lanes.length === 0) return false;
  const snapshot: TreasuryContinuousOHFenceProjection = readTreasuryContinuousOHFenceProjection();
  return lanes.some((lane) => hasLaneFence(lane, snapshot));
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
  const activeSlices = new Map<string, { amount: number; count: number; taskCreatedAt: number; taskAmount: number | null; workKey: string; attemptId: string; lane: TreasuryTerminalLane }>();
  for (const record of active) {
    const lane = TREASURY_TERMINAL_LANES.find((entry) => entry.actionKind === record.identity.actionKind);
    if (!lane) continue;
    const facts = decodeTreasuryTerminalFacts(lane, record.identity.durableFacts?.payload);
    const quota = readTreasuryLaneQuota(lane);
    const control = readTreasuryTerminalControl(lane);
    if (!facts || record.workKey !== treasuryLaneWorkKey(lane, facts.taskId, facts.sequence)) continue;
    const previous = activeSlices.get(facts.taskId);
    activeSlices.set(facts.taskId, {
      amount: facts.amount,
      workKey: record.workKey,
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
          lease.workKey === activeSlice.workKey && lease.amount === activeSlice.amount &&
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
