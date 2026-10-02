import { detectLegacyTreasuryStores, readTreasuryCoreStoreHealth } from "@/runtime/treasury/kernel/store";
import { TREASURY_TERMINAL_LANES, treasuryLaneWorkKey, type TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
import { readTreasuryContinuousOHQuota, readTreasuryContinuousOHClosedWorkSet } from "@/runtime/treasuryContinuousOHControl";
import { readTreasuryContinuousOHFenceQuota, continuousFenceClosedWorkAcknowledged } from "@/runtime/treasuryContinuousOHFence";
import type { TreasuryContinuousOHFenceProjection } from "@/runtime/treasuryContinuousOHFence";

export interface TreasuryT1Quota {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly status: "reserved" | "dispatching" | "drained";
  readonly taskId: string;
  readonly taskCreatedAt: number;
  readonly taskAmount: number;
  readonly workKey: string;
  readonly attemptId: string;
  readonly amount: number;
  readonly reservedAtTick: number;
}

export type TreasuryT1Responsibility = { readonly status: "clear" | "held" | "invalid"; readonly reason: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readTreasuryLaneQuota(lane: TreasuryTerminalLane):
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: TreasuryT1Quota } {
  if (lane.continuous) return readTreasuryContinuousOHQuota();
  const raw = (Memory.runtime as unknown as Record<string, unknown> | undefined)?.[lane.quotaKey];
  if (raw === undefined) return { status: "absent" };
  const fields = ["schemaVersion", "runId", "status", "taskId", "taskCreatedAt", "taskAmount",
    "workKey", "attemptId", "amount", "reservedAtTick"].sort();
  if (!object(raw) || Object.keys(raw).sort().join("|") !== fields.join("|") ||
      raw.schemaVersion !== 2 || raw.runId !== lane.runId ||
      !["reserved", "dispatching", "drained"].includes(raw.status as string) ||
      typeof raw.taskId !== "string" || raw.taskId.length < 1 || raw.taskId.length > 80 ||
      raw.workKey !== treasuryLaneWorkKey(lane, raw.taskId) ||
      typeof raw.attemptId !== "string" || raw.attemptId.length < 1 || raw.attemptId.length > 128 ||
      !integer(raw.amount) || raw.amount < 1 || raw.amount > 100 ||
      !integer(raw.taskCreatedAt) || !integer(raw.taskAmount) || raw.taskAmount < raw.amount ||
      !integer(raw.reservedAtTick)) return { status: "invalid" };
  return { status: "valid", value: raw as unknown as TreasuryT1Quota };
}
export function readTreasuryLaneFenceQuota(lane: TreasuryTerminalLane): ReturnType<typeof readTreasuryLaneQuota> {
  return lane.continuous ? readTreasuryContinuousOHFenceQuota() : readTreasuryLaneQuota(lane);
}

const KNOWN_LEGACY_COLLECTIONS = new Set([
  "receipts", "intents", "quarantine", "resolutions", "resolutionCleanup", "attemptLineage",
  "attemptIssuer", "issuedAttemptTickets", "writeFault", "authorizationFaults", "retiredAttemptRanges",
  "cleanupCompletions", "cleanupSupersessions", "chainRetirementCertificates", "generationRetirementProofs",
  "lineageRetirementSummaries", "completionHeadroomReservations",
]);
/** 旧root没有可接受的版本迁移：只识别确证空的已知map/list，坏值与未知字段不能当作空。 */
export function isKnownEmptyLegacyTreasuryRoot(raw: unknown): boolean {
  if (raw === undefined) return true;
  try {
    if (!object(raw) || ![Object.prototype,null].includes(Object.getPrototypeOf(raw))) return false;
    for (const key of Object.getOwnPropertyNames(raw)) {
      if (!KNOWN_LEGACY_COLLECTIONS.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(raw,key);
      if (!descriptor || !("value" in descriptor)) return false;
      const value: unknown = descriptor.value;
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length !== 0 || Object.getOwnPropertyNames(value).some((name) => name !== "length")) return false;
      } else {
        if (!object(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
        for (const entry in value) { if (Object.prototype.hasOwnProperty.call(value,entry)) return false; }
        if (Object.getOwnPropertyNames(value).length !== 0) return false;
      }
    }
    return Object.getOwnPropertySymbols(raw).length === 0;
  } catch { return false; }
}

/** 只读识别责任；不初始化服务、不迁移预约，不把损坏记录当作空表。 */
export function readTreasuryLaneResponsibility(lane: TreasuryTerminalLane,
  coreHealth?: ReturnType<typeof readTreasuryCoreStoreHealth>, fenceProjection = false,
  continuousProjection?: TreasuryContinuousOHFenceProjection,
  queryQuotaReader?: typeof readTreasuryLaneQuota): TreasuryT1Responsibility {
  try {
    const runtime = Memory.runtime as unknown;
    const data = Memory.data as unknown;
    if ((runtime !== undefined && !object(runtime)) || (data !== undefined && !object(data))) {
      return { status: "invalid", reason: "memory_root_invalid" };
    }
    const legacy = object(runtime) ? runtime.treasury : undefined;
    if (!isKnownEmptyLegacyTreasuryRoot(legacy) || detectLegacyTreasuryStores().length > 0) {
      return { status: "invalid", reason: "legacy_store_unreadable" };
    }
    // 仅cargo fence显式注入当次query快照；default/native权威不接纳此reader。
    const quotaReader = fenceProjection ? queryQuotaReader ?? ((known: TreasuryTerminalLane) => known.continuous && continuousProjection
      ? continuousProjection.quota : readTreasuryLaneFenceQuota(known)) : readTreasuryLaneQuota;
    const quota = quotaReader(lane);
    if (TREASURY_TERMINAL_LANES.some((other) => quotaReader(other).status === "invalid")) {
      return { status: "invalid", reason: "quota_invalid" };
    }
    if (quota.status === "invalid") return { status: "invalid", reason: "quota_invalid" };
    const health = coreHealth ?? readTreasuryCoreStoreHealth();
    if (health.status !== "healthy" && health.status !== "absent") {
      return { status: "invalid", reason: "kernel_unhealthy" };
    }
    if (health.status === "healthy" && health.ringDegraded !== null) {
      return { status: "invalid", reason: "kernel_history_unreadable" };
    }
    const resourceControl = object(data) ? data.resourceControl : undefined;
    if (resourceControl !== undefined && !object(resourceControl)) {
      return { status: "invalid", reason: "task_store_unreadable" };
    }
    const tasks = object(resourceControl) ? resourceControl.tasks : undefined;
    if (tasks !== undefined && !object(tasks)) return { status: "invalid", reason: "task_store_unreadable" };
    if (tasks !== undefined) {
      for (const [id, task] of Object.entries(tasks)) {
        if (!object(task) || task.id !== id) return { status: "invalid", reason: "task_store_unreadable" };
        if (task.treasurySlice !== undefined) {
          if (!object(task.treasurySlice) || !TREASURY_TERMINAL_LANES.some((known) => known.runId === (task.treasurySlice as Record<string, unknown>).runId)) return {status:"invalid",reason:"task_lease_unreadable"};
          if (task.treasurySlice.runId === lane.runId) return { status: "held", reason: "task_lease_present" };
        }
      }
    }
    if (health.status === "healthy" && Object.values(health.memory.active).some((record) =>
        record.identity.actionKind === lane.actionKind)) {
      return { status: "held", reason: "kernel_work_present" };
    }
    const continuousClosed = lane.continuous && !fenceProjection ? readTreasuryContinuousOHClosedWorkSet() : undefined;
    if (continuousClosed === null) return { status: "invalid", reason: "closed_work_history_unreadable" };
    if (quota.status === "valid") {
      if (quota.value.status !== "drained") return { status: "held", reason: "quota_unclosed" };
      // drained is the durable task/closure acknowledgement. The bounded ring
      // may later evict history; it is not the authority for a new settlement.
      if (health.status !== "healthy") {
        return { status: "invalid", reason: "drained_quota_without_closure" };
      }
    } else if (health.status === "healthy" && health.memory.ring.some((entry) =>
        entry.workKey.startsWith(`biz:${lane.runId}:`) &&
        !(lane.continuous && (fenceProjection ? continuousProjection
          ? continuousProjection.closed.has(`${entry.workKey}\n${entry.attemptId}`)
          : continuousFenceClosedWorkAcknowledged(entry.workKey, entry.attemptId)
          : continuousClosed?.has(`${entry.workKey}\n${entry.attemptId}`))))) {
      return { status: "invalid", reason: "closed_work_without_quota" };
    }
    return { status: "clear", reason: "no_responsibility" };
  } catch {
    return { status: "invalid", reason: "responsibility_read_failed" };
  }
}
