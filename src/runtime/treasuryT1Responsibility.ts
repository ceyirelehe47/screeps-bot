import { detectLegacyTreasuryStores, readTreasuryCoreStoreHealth } from "@/runtime/treasury/kernel/store";
import { TREASURY_T1_ACTION_KIND, TREASURY_T1_RUN_ID, TREASURY_T1_WORK_KEY_PREFIX, treasuryT1WorkKey } from "@/runtime/treasuryT1Facts";

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

export function readTreasuryT1Quota():
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: TreasuryT1Quota } {
  const raw = (Memory.runtime as unknown as Record<string, unknown> | undefined)?.treasuryProductionT1Quota;
  if (raw === undefined) return { status: "absent" };
  const fields = ["schemaVersion", "runId", "status", "taskId", "taskCreatedAt", "taskAmount",
    "workKey", "attemptId", "amount", "reservedAtTick"].sort();
  if (!object(raw) || Object.keys(raw).sort().join("|") !== fields.join("|") ||
      raw.schemaVersion !== 2 || raw.runId !== TREASURY_T1_RUN_ID ||
      !["reserved", "dispatching", "drained"].includes(raw.status as string) ||
      typeof raw.taskId !== "string" || raw.taskId.length < 1 || raw.taskId.length > 80 ||
      raw.workKey !== treasuryT1WorkKey(raw.taskId) ||
      typeof raw.attemptId !== "string" || raw.attemptId.length < 1 || raw.attemptId.length > 128 ||
      !integer(raw.amount) || raw.amount < 1 || raw.amount > 100 ||
      !integer(raw.taskCreatedAt) || !integer(raw.taskAmount) || raw.taskAmount < raw.amount ||
      !integer(raw.reservedAtTick)) return { status: "invalid" };
  return { status: "valid", value: raw as unknown as TreasuryT1Quota };
}

/** 只读识别责任；不初始化服务、不迁移预约，不把损坏记录当作空表。 */
export function readTreasuryT1Responsibility(): TreasuryT1Responsibility {
  try {
    const runtime = Memory.runtime as unknown;
    const data = Memory.data as unknown;
    if ((runtime !== undefined && !object(runtime)) || (data !== undefined && !object(data))) {
      return { status: "invalid", reason: "memory_root_invalid" };
    }
    const legacy = object(runtime) ? runtime.treasury : undefined;
    if ((legacy !== undefined && !object(legacy)) || detectLegacyTreasuryStores().length > 0) {
      return { status: "invalid", reason: "legacy_store_unreadable" };
    }
    const quota = readTreasuryT1Quota();
    if (quota.status === "invalid") return { status: "invalid", reason: "quota_invalid" };
    const health = readTreasuryCoreStoreHealth();
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
        if (task.treasurySlice !== undefined) return { status: "held", reason: "task_lease_present" };
      }
    }
    if (health.status === "healthy" && Object.values(health.memory.active).some((record) =>
        record.identity.actionKind === TREASURY_T1_ACTION_KIND)) {
      return { status: "held", reason: "kernel_work_present" };
    }
    if (quota.status === "valid") {
      if (quota.value.status !== "drained") return { status: "held", reason: "quota_unclosed" };
      // drained is the durable task/closure acknowledgement. The bounded ring
      // may later evict history; it is not the authority for a new settlement.
      if (health.status !== "healthy") {
        return { status: "invalid", reason: "drained_quota_without_closure" };
      }
    } else if (health.status === "healthy" && health.memory.ring.some((entry) =>
        entry.workKey.startsWith(TREASURY_T1_WORK_KEY_PREFIX))) {
      return { status: "invalid", reason: "closed_work_without_quota" };
    }
    return { status: "clear", reason: "no_responsibility" };
  } catch {
    return { status: "invalid", reason: "responsibility_read_failed" };
  }
}
