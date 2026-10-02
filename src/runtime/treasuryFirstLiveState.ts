import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

import type { TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";

export interface Control {
  schemaVersion: 1;
  runId: string;
  status: "preparing" | "active" | "closed";
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
  /** 只有 T3 编码拥有此字段；旧 T1/T2 的签名形状保持不变。 */
  maxSliceAmount?: number;
  /** 仅持续 lane 派生的控制视图使用；旧三 lane 不接受此额外字段。 */
  sequence?: number;
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

const FENCE_CONTROL_FIELDS = ["schemaVersion", "runId", "status", "startedAtTick", "deadlineTick",
  "startedAtMs", "deadlineMs", "lastHeartbeatAtMs", "controlUntilMs", "taskId", "taskCreatedAt",
  "taskAmount", "taskRemainingAtArm", "sourceTerminalId", "targetTerminalId", "deployTag",
  "deployBundleHash", "closeReason", "hash"] as const;
const FENCE_CONTROL_KEYS = new Set<string>(FENCE_CONTROL_FIELDS);
const FENCE_SLICE_CONTROL_KEYS = new Set<string>([...FENCE_CONTROL_FIELDS, "maxSliceAmount"]);
const FENCE_IDENTITY_FIELDS = new Set(["taskId", "sourceTerminalId", "targetTerminalId", "deployTag", "deployBundleHash"]);
const validFenceControls = new WeakMap<TreasuryTerminalLane, Set<string>>();

function plainFenceObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(raw));
}

function boundedFenceScalar(name: string, value: unknown, hasSlice: boolean, runId: string): boolean {
  if (name === "schemaVersion") return value === 1;
  if (name === "runId") return value === runId;
  if (name === "status") return value === "active" || value === "closed" || hasSlice && value === "preparing";
  if (name === "hash") return typeof value === "string" && value.length === 37 && /^csh1:[0-9a-f]{32}$/.test(value);
  if (name === "closeReason") return typeof value === "string" && value.length <= 80;
  if (FENCE_IDENTITY_FIELDS.has(name)) return typeof value === "string" && value.length > 0 && value.length <= 160;
  return finiteNonNegative(value);
}

/** 每次读全部 own descriptor 和有界 scalar；不冻结旧本，也不执行 getter/toJSON。 */
function fenceControlSnapshot(raw: unknown, hasSlice: boolean, runId: string): Control | null {
  if (!plainFenceObject(raw) || Object.getOwnPropertySymbols(raw).length !== 0 || "toJSON" in raw) return null;
  const expected = hasSlice ? FENCE_SLICE_CONTROL_KEYS : FENCE_CONTROL_KEYS;
  const names = Object.getOwnPropertyNames(raw);
  if (names.length !== expected.size) return null;
  const snapshot = Object.create(null) as Record<string, string | number>;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (!expected.has(name) || !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") || !descriptor.enumerable ||
        !boundedFenceScalar(name, descriptor.value, hasSlice, runId)) return null;
    // 保留原字段顺序：旧主镜像协议的 JSON 字节相等要求不被 canonical 化放宽。
    snapshot[name] = descriptor.value as string | number;
  }
  return snapshot as unknown as Control;
}

export function createTreasuryFirstLiveState(lane: TreasuryTerminalLane) {
const PRIMARY = lane.controlKey;
const MIRROR = lane.controlMirrorKey;
const CONTROL_RUN_ID = lane.controlRunId;
function hash(payload: Payload): string {
  return canonicalStableHashV1({ domain: `treasury-${lane.name.toLowerCase()}:first-live-control-v1`, payload });
}

function seal(payload: Payload): Control {
  return { ...payload, hash: hash(payload) };
}

function valid(raw: unknown): raw is Control {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Control;
  const expected = ["schemaVersion", "runId", "status", "startedAtTick", "deadlineTick",
    "startedAtMs", "deadlineMs", "lastHeartbeatAtMs", "controlUntilMs", "taskId", "taskCreatedAt",
    "taskAmount", "taskRemainingAtArm", "sourceTerminalId", "targetTerminalId",
    "deployTag", "deployBundleHash", "closeReason", "hash",
    ...(lane.demandBoundedSlice ? ["maxSliceAmount"] : [])].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  if (value.schemaVersion !== 1 || value.runId !== CONTROL_RUN_ID ||
      (value.status !== "active" && value.status !== "closed" && !(lane.demandBoundedSlice && value.status === "preparing")) ||
      ![value.startedAtTick, value.deadlineTick, value.startedAtMs, value.deadlineMs,
      value.lastHeartbeatAtMs, value.controlUntilMs, value.taskCreatedAt, value.taskAmount,
        value.taskRemainingAtArm].every(finiteNonNegative) ||
      value.taskAmount < 1 || value.taskRemainingAtArm < 1 ||
      value.taskRemainingAtArm > value.taskAmount ||
      (lane.demandBoundedSlice && (!finiteNonNegative(value.maxSliceAmount) ||
        value.maxSliceAmount < 1 || value.maxSliceAmount > 100)) ||
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
      (value.status !== "closed" && value.closeReason !== "") ||
      (value.status === "closed" && value.closeReason === "")) return false;
  const { hash: digest, ...payload } = value;
  return digest === hash(payload);
}

function readControl(): Read {
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

/** 仅 cargo fence 复用纯签名/数学成功；Native 权威继续调用原 readControl。 */
function readControlForFence(): Read {
  try {
    const runtimeSlot = Object.getOwnPropertyDescriptor(Memory, "runtime");
    if (runtimeSlot ? !Object.prototype.hasOwnProperty.call(runtimeSlot, "value") || !runtimeSlot.enumerable : "runtime" in Memory) return { status: "invalid" };
    const state = runtimeSlot?.value;
    if (state === undefined) return { status: "absent" };
    if (!plainFenceObject(state)) return { status: "invalid" };
    const primarySlot = Object.getOwnPropertyDescriptor(state, PRIMARY);
    const mirrorSlot = Object.getOwnPropertyDescriptor(state, MIRROR);
    if ([primarySlot, mirrorSlot].some((slot) => slot && (!Object.prototype.hasOwnProperty.call(slot, "value") || !slot.enumerable)) ||
        !primarySlot && PRIMARY in state || !mirrorSlot && MIRROR in state) return { status: "invalid" };
    const primaryRaw = primarySlot?.value;
    const mirrorRaw = mirrorSlot?.value;
    if (primaryRaw === undefined && mirrorRaw === undefined) return { status: "absent" };
    if ("toJSON" in Object.prototype || "toJSON" in Array.prototype) return { status: "invalid" };
    const hasSlice = Boolean(lane.demandBoundedSlice);
    const primary = fenceControlSnapshot(primaryRaw, hasSlice, CONTROL_RUN_ID);
    const mirror = fenceControlSnapshot(mirrorRaw, hasSlice, CONTROL_RUN_ID);
    if (!primary || !mirror) return { status: "invalid" };
    const bytes = JSON.stringify(primary);
    if (bytes !== JSON.stringify(mirror)) return { status: "invalid" };
    const identityFields = Object.create(null) as Record<string, string | boolean>;
    identityFields.domain = `treasury-${lane.name.toLowerCase()}:first-live-control-v1`;
    identityFields.runId = CONTROL_RUN_ID;
    identityFields.hasSlice = hasSlice;
    const identity = JSON.stringify(identityFields) + "\n" + bytes;
    const cached = validFenceControls.get(lane);
    if (cached?.has(identity)) {
      cached.delete(identity); cached.add(identity);
    } else {
      if (!valid(primary)) return { status: "invalid" };
      const identities = cached ?? new Set<string>();
      identities.add(identity);
      while (identities.size > 4) identities.delete(identities.values().next().value!);
      validFenceControls.set(lane, identities);
    }
    return { status: "valid", value: Object.freeze(primary) };
  } catch { return { status: "invalid" }; }
}

return { seal, readControl, readControlForFence };
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
