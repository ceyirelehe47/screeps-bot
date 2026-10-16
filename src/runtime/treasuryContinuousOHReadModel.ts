/** 从 treasuryContinuousOHControl.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { type Control, type Read } from "@/runtime/treasuryFirstLiveState";
import { type TreasuryT1Quota } from "@/runtime/treasuryTerminalResponsibility";
import { CONTROL_RUN_ID, readTreasuryContinuousOHState } from "@/runtime/treasuryContinuousOHState";

export type TreasuryContinuousOHQuotaRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: TreasuryT1Quota };

export function readTreasuryContinuousOHControl(): Read {
  const read = readTreasuryContinuousOHState();
  if (read.status !== "valid") return read;
  const state = read.value;
  const cycle = state.currentCycle;
  const value: Control & { sequence: number } = {
    schemaVersion: 1, runId: CONTROL_RUN_ID,
    status: cycle?.status ?? (state.sessionStatus === "stopped" || state.sessionStatus === "stopping" ? "closed" : "active"),
    startedAtTick: cycle?.startedAtTick ?? state.enabledAtTick,
    startedAtMs: cycle?.startedAtMs ?? state.enabledAtMs,
    deadlineTick: cycle?.deadlineTick ?? state.deadlineTick,
    deadlineMs: cycle?.deadlineMs ?? state.deadlineMs,
    lastHeartbeatAtMs: cycle?.lastHeartbeatAtMs ?? state.enabledAtMs,
    controlUntilMs: cycle?.controlUntilMs ?? state.deadlineMs,
    taskId: cycle?.taskId ?? "", taskCreatedAt: cycle?.taskCreatedAt ?? 0,
    taskAmount: cycle?.taskAmount ?? 0, taskRemainingAtArm: cycle?.taskRemainingAtArm ?? 0,
    sourceTerminalId: state.sourceTerminalId, targetTerminalId: state.targetTerminalId,
    deployTag: state.deployTag, deployBundleHash: state.deployBundleHash,
    closeReason: cycle?.closeReason ?? state.stopReason,
    maxSliceAmount: cycle?.amount ?? 0, sequence: cycle?.sequence ?? 0, hash: state.hash,
  };
  return { status: "valid", value };
}

export function readTreasuryContinuousOHQuota(): TreasuryContinuousOHQuotaRead {
  const read = readTreasuryContinuousOHState();
  if (read.status !== "valid") return read;
  const quota = read.value.currentCycle?.quota;
  return quota ? { status: "valid", value: quota } : { status: "absent" };
}

export function continuousClosedWorkAcknowledged(workKey: string, attemptId?: string): boolean {
  const read = readTreasuryContinuousOHState();
  return read.status === "valid" && read.value.closedCycles.some((cert) => cert.ring !== null &&
    cert.cycle.quota?.status === "drained" && cert.ring.workKey === workKey &&
    (attemptId === undefined || cert.ring.attemptId === attemptId));
}

/** 同次 fresh 责任读取只验证一遍完整book，不为ring每条再读整本。 */
export function readTreasuryContinuousOHClosedWorkSet(): ReadonlySet<string> | null {
  const read = readTreasuryContinuousOHState();
  if (read.status === "invalid") return null;
  return new Set(read.status === "absent" ? [] : read.value.closedCycles.flatMap((cert) =>
    cert.ring !== null && cert.cycle.quota?.status === "drained" ? [`${cert.ring.workKey}\n${cert.ring.attemptId}`] : []));
}

export function continuousSessionOwnsActivity(): boolean {
  const read = readTreasuryContinuousOHState();
  return read.status === "invalid" || read.status === "valid" && read.value.sessionStatus !== "stopped";
}
