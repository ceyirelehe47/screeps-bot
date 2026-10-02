import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

export const PRIMARY = "treasuryT1FirstLiveControl";
export const MIRROR = "treasuryT1FirstLiveControlMirror";
export const CONTROL_RUN_ID = "treasury-t1-first-live-2026-09-27";

export interface Control {
  schemaVersion: 1;
  runId: typeof CONTROL_RUN_ID;
  status: "active" | "closed";
  startedAtTick: number;
  deadlineTick: number;
  startedAtMs: number;
  deadlineMs: number;
  lastHeartbeatAtMs: number;
  controlUntilMs: number;
  taskId: string;
  taskCreatedAt: number;
  taskAmount: number;
  taskRemainingAtArm: number;
  sourceTerminalId: string;
  targetTerminalId: string;
  deployTag: string;
  deployBundleHash: string;
  closeReason: string;
  hash: string;
}

export type Payload = Omit<Control, "hash">;
export type Read =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; value: Control };

export function runtime(): Record<string, unknown> | undefined {
  return (Memory as unknown as { runtime?: Record<string, unknown> }).runtime;
}

export function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hash(payload: Payload): string {
  return canonicalStableHashV1({ domain: "treasury-t1:first-live-control-v1", payload });
}

export function seal(payload: Payload): Control {
  return { ...payload, hash: hash(payload) };
}

function valid(raw: unknown): raw is Control {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Control;
  const expected = ["schemaVersion", "runId", "status", "startedAtTick", "deadlineTick",
    "startedAtMs", "deadlineMs", "lastHeartbeatAtMs", "controlUntilMs", "taskId", "taskCreatedAt",
    "taskAmount", "taskRemainingAtArm", "sourceTerminalId", "targetTerminalId",
    "deployTag", "deployBundleHash", "closeReason", "hash"].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  if (value.schemaVersion !== 1 || value.runId !== CONTROL_RUN_ID ||
      (value.status !== "active" && value.status !== "closed") ||
      ![value.startedAtTick, value.deadlineTick, value.startedAtMs, value.deadlineMs,
      value.lastHeartbeatAtMs, value.controlUntilMs, value.taskCreatedAt, value.taskAmount,
        value.taskRemainingAtArm].every(finiteNonNegative) ||
      value.taskAmount < 1 || value.taskRemainingAtArm < 1 ||
      value.taskRemainingAtArm > value.taskAmount ||
      value.deadlineTick !== value.startedAtTick + 600 ||
      value.deadlineMs !== value.startedAtMs + 30 * 60_000 ||
      value.lastHeartbeatAtMs < value.startedAtMs ||
      value.lastHeartbeatAtMs >= value.deadlineMs ||
      value.controlUntilMs < value.lastHeartbeatAtMs ||
      value.controlUntilMs > Math.min(value.deadlineMs, value.lastHeartbeatAtMs + 60_000) ||
      ![value.taskId, value.sourceTerminalId, value.targetTerminalId,
        value.deployTag, value.deployBundleHash].every((item) =>
        typeof item === "string" && item.length > 0 && item.length <= 160) ||
      typeof value.closeReason !== "string" || value.closeReason.length > 80 ||
      (value.status === "active" && value.closeReason !== "") ||
      (value.status === "closed" && value.closeReason === "")) return false;
  const { hash: digest, ...payload } = value;
  return digest === hash(payload);
}

export function readTreasuryT1FirstLiveControl(): Read {
  try {
  const state = runtime();
  const primary = state?.[PRIMARY];
  const mirror = state?.[MIRROR];
  if (primary === undefined && mirror === undefined) return { status: "absent" };
  if (!valid(primary) || !valid(mirror) ||
      JSON.stringify(primary) !== JSON.stringify(mirror)) return { status: "invalid" };
  return { status: "valid", value: primary };
  } catch {
    return { status: "invalid" };
  }
}

/** Screeps 不依赖 Node Buffer/TextEncoder；JSON 的 UTF-8 保守字节口径。 */
export function treasuryT1SerializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  let bytes = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    const code = serialized.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < serialized.length &&
        serialized.charCodeAt(i + 1) >= 0xdc00 && serialized.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

