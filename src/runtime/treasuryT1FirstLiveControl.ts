import { BUILD_INFO } from "@/buildMeta";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import {
  hasTerminalActionClaim,
  hasTerminalSendEffectThisTick,
} from "@/runtime/marketActionArbiter";
import { readTreasuryT1Responsibility } from "@/runtime/treasuryT1Responsibility";
import {
  TREASURY_T1_RUN_ID,
  TREASURY_T1_SOURCE_ROOM,
  TREASURY_T1_TARGET_ROOM,
} from "@/runtime/treasuryT1Facts";

const PRIMARY = "treasuryT1FirstLiveControl";
const MIRROR = "treasuryT1FirstLiveControlMirror";
const CONTROL_RUN_ID = "treasury-t1-first-live-2026-09-27";
const MAX_MEMORY_BYTES = 1_900_000;
const MIN_CPU_REMAINING = 20;
const MIN_CPU_BUCKET = 2_000;

interface Control {
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

type Payload = Omit<Control, "hash">;
type Read =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; value: Control };

function runtime(): Record<string, unknown> | undefined {
  return (Memory as unknown as { runtime?: Record<string, unknown> }).runtime;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hash(payload: Payload): string {
  return canonicalStableHashV1({ domain: "treasury-t1:first-live-control-v1", payload });
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

function writeControl(payload: Payload): boolean {
  const baseline = readTreasuryT1FirstLiveControl();
  let destination: Record<string, unknown> | undefined;
  let sealed: Control | undefined;
  try {
    const memory = Memory as unknown as { runtime?: Record<string, unknown> };
    sealed = seal(payload);
    if (treasuryT1SerializedBytes(Memory) + treasuryT1SerializedBytes(sealed) * 2 + 512 > MAX_MEMORY_BYTES) {
      return false;
    }
    memory.runtime ??= {};
    destination = memory.runtime;
    memory.runtime[PRIMARY] = { ...sealed };
    memory.runtime[MIRROR] = { ...sealed };
    const readback = readTreasuryT1FirstLiveControl();
    if (readback.status === "valid" && readback.value.hash === sealed.hash) return true;
  } catch {
    // Only restore a known, signed baseline after our own partial publication.
  }
  try {
    if (baseline.status === "valid" && destination !== undefined && runtime() === destination && sealed !== undefined) {
      const before = JSON.stringify(baseline.value);
      const after = JSON.stringify(sealed);
      const known = (raw: unknown) => [before, after].includes(JSON.stringify(raw));
      if (known(destination[PRIMARY]) && known(destination[MIRROR])) {
        destination[PRIMARY] = { ...baseline.value };
        destination[MIRROR] = { ...baseline.value };
      }
    }
  } catch { /* A failed rollback remains invalid and fenced. */ }
  return false;
}

function safeCpuAndMemory(): boolean {
  try {
    const cpu = Game.cpu;
    const used = cpu.getUsed();
    return Number.isFinite(used) && Number.isFinite(cpu.tickLimit) &&
      Number.isFinite(cpu.bucket) && cpu.tickLimit - used >= MIN_CPU_REMAINING &&
      cpu.bucket >= MIN_CPU_BUCKET && treasuryT1SerializedBytes(Memory) + 4_096 < MAX_MEMORY_BYTES;
  } catch {
    return false;
  }
}

function endpointIds(): { source: string; target: string } | null {
  const source = Game.rooms[TREASURY_T1_SOURCE_ROOM];
  const target = Game.rooms[TREASURY_T1_TARGET_ROOM];
  const endpoints = [source, target];
  if (!endpoints.every((room) => room?.controller?.my === true &&
      room.controller.owner?.username === "forster" &&
      room.terminal?.my === true && room.terminal.owner?.username === "forster" &&
      room.terminal.isActive() === true && typeof room.terminal.id === "string")) return null;
  return { source: source.terminal!.id, target: target.terminal!.id };
}

function endpointAlreadyTouchedThisTick(): boolean {
  return [TREASURY_T1_SOURCE_ROOM, TREASURY_T1_TARGET_ROOM].some((roomName) =>
    hasTerminalActionClaim(roomName) || hasTerminalSendEffectThisTick(roomName));
}

function deploymentMatches(): boolean {
  const state = runtime();
  return Game.shard?.name === "shard1" && !BUILD_INFO.dirty &&
    BUILD_INFO.bundleHash !== "none" &&
    state?.lastDeployTag === BUILD_INFO.tag &&
    state?.lastDeployBundleHash === BUILD_INFO.bundleHash;
}

function taskEligible(task: ResourceTransferTask, amount: number): boolean {
  return typeof task.id === "string" && task.id.length > 0 && task.id.length <= 80 &&
    Number.isSafeInteger(task.amount) && task.amount > 0 &&
    task.status === "pending" &&
    task.fromRoomName === TREASURY_T1_SOURCE_ROOM &&
    task.toRoomName === TREASURY_T1_TARGET_ROOM && task.resource === RESOURCE_HYDROGEN &&
    finiteNonNegative(task.remainingAmount) && amount >= 1 && amount <= 100 &&
    amount <= task.remainingAmount;
}

function taskMatches(control: Control, task: ResourceTransferTask, amount: number): boolean {
  return task.id === control.taskId && task.createdAt === control.taskCreatedAt &&
    task.amount === control.taskAmount &&
    task.remainingAmount === control.taskRemainingAtArm && taskEligible(task, amount);
}

export function treasuryT1FirstLiveAllows(task: ResourceTransferTask, amount: number): boolean {
  const read = readTreasuryT1FirstLiveControl();
  if (read.status !== "valid" || read.value.status !== "active") return false;
  const control = read.value;
  const now = Date.now();
  const ids = endpointIds();
  return now < control.deadlineMs && now < control.controlUntilMs &&
    Game.time < control.deadlineTick && Game.time >= control.startedAtTick &&
    deploymentMatches() && control.deployTag === BUILD_INFO.tag &&
    control.deployBundleHash === BUILD_INFO.bundleHash &&
    ids?.source === control.sourceTerminalId && ids.target === control.targetTerminalId &&
    taskMatches(control, task, amount) && safeCpuAndMemory();
}

function rawMode(): unknown {
  const cfg = (Memory as unknown as { cfg?: Record<string, unknown> }).cfg;
  const entry = cfg?.treasuryTerminalTransferSlice0;
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>).mode : undefined;
}

function setMode(mode: "off" | "canary" | "drain"): boolean {
  try {
  if (rawMode() === mode) return true;
  const memory = Memory as unknown as { cfg?: Record<string, unknown> };
  memory.cfg ??= {};
  const prior = memory.cfg.treasuryTerminalTransferSlice0;
  memory.cfg.treasuryTerminalTransferSlice0 = {
    ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}), mode,
  };
  return rawMode() === mode;
  } catch {
    return false;
  }
}

export function armTreasuryT1FirstLive(taskId: string, createdAt: number): { ok: boolean; reason: string } {
  if (readTreasuryT1FirstLiveControl().status !== "absent" ||
      runtime()?.treasuryProductionT1Quota !== undefined ||
      readTreasuryT1Responsibility().status !== "clear") return { ok: false, reason: "already_used_or_unsettled" };
  if (rawMode() !== undefined && rawMode() !== "off") return { ok: false, reason: "mode_not_off" };
  if (!deploymentMatches() || !safeCpuAndMemory()) return { ok: false, reason: "environment_gate" };
  if (endpointAlreadyTouchedThisTick()) return { ok: false, reason: "terminal_action_this_tick" };
  const task = Memory.data?.resourceControl?.tasks?.[taskId] as ResourceTransferTask | undefined;
  const ids = endpointIds();
  if (!task || !ids || task.id !== taskId || task.createdAt !== createdAt ||
      task.treasurySlice !== undefined ||
      !taskEligible(task, Math.min(task.remainingAmount, 100))) {
    return { ok: false, reason: "task_or_endpoint_gate" };
  }
  const source = Game.rooms[TREASURY_T1_SOURCE_ROOM].terminal!;
  const target = Game.rooms[TREASURY_T1_TARGET_ROOM].terminal!;
  const amount = Math.min(task.remainingAmount, 100);
  let fee: number;
  try { fee = Game.market.calcTransactionCost(amount, TREASURY_T1_SOURCE_ROOM, TREASURY_T1_TARGET_ROOM); }
  catch { return { ok: false, reason: "quote_unavailable" }; }
  if (source.cooldown !== 0 || !finiteNonNegative(fee) || fee > 100 ||
      (source.store.getUsedCapacity(RESOURCE_HYDROGEN) ?? 0) < amount ||
      (source.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) < fee ||
      (target.store.getFreeCapacity() ?? 0) < amount) {
    return { ok: false, reason: "live_send_not_ready" };
  }
  const now = Date.now();
  const payload: Payload = {
    schemaVersion: 1, runId: CONTROL_RUN_ID, status: "active",
    startedAtTick: Game.time, deadlineTick: Game.time + 600,
    startedAtMs: now, deadlineMs: now + 30 * 60_000,
    lastHeartbeatAtMs: now,
    controlUntilMs: now + 60_000,
    taskId, taskCreatedAt: task.createdAt, taskAmount: task.amount,
    taskRemainingAtArm: task.remainingAmount,
    sourceTerminalId: ids.source, targetTerminalId: ids.target,
    deployTag: BUILD_INFO.tag, deployBundleHash: BUILD_INFO.bundleHash,
    closeReason: "",
  };
  if (!writeControl(payload)) return { ok: false, reason: "control_write_failed" };
  if (!setMode("canary")) return { ok: false, reason: "mode_write_failed" };
  return { ok: true, reason: "armed" };
}

export function heartbeatTreasuryT1FirstLive(): { ok: boolean; reason: string } {
  const read = readTreasuryT1FirstLiveControl();
  if (read.status !== "valid" || read.value.status !== "active") return { ok: false, reason: "not_active" };
  const now = Date.now();
  const value = read.value;
  if (now >= value.controlUntilMs || now >= value.deadlineMs ||
      Game.time >= value.deadlineTick || !deploymentMatches() ||
      runtime()?.treasuryProductionT1Quota !== undefined) {
    return { ok: false, reason: "expired_or_consumed" };
  }
  const { hash: _hash, ...payload } = value;
  return writeControl({ ...payload, lastHeartbeatAtMs: now,
    controlUntilMs: Math.min(value.deadlineMs, now + 60_000) })
    ? { ok: true, reason: "renewed" } : { ok: false, reason: "control_write_failed" };
}

export function closeTreasuryT1FirstLive(reason = "operator_stop"): { ok: boolean; reason: string } {
  const read = readTreasuryT1FirstLiveControl();
  if (read.status !== "valid") return { ok: false, reason: read.status };
  const nextMode = readTreasuryT1Responsibility().status === "clear" ? "off" : "drain";
  if (read.value.status === "closed" && rawMode() === nextMode) return { ok: true, reason: "closed" };
  if (!safeCpuAndMemory()) return { ok: false, reason: "environment_gate" };
  if (read.value.status === "active") {
    const { hash: _hash, ...payload } = read.value;
    if (!writeControl({ ...payload, status: "closed", closeReason: reason.slice(0, 80) || "closed" })) {
      return { ok: false, reason: "control_write_failed" };
    }
  }
  if (!setMode(nextMode)) {
    return { ok: false, reason: "mode_write_failed" };
  }
  return { ok: true, reason: "closed" };
}

/** 每 tick、挑任务前执行；停止接纳与完成责任恢复分别处理。 */
export function normalizeTreasuryT1FirstLiveControl(): { ok: boolean; reason: string } {
  try {
  const read = readTreasuryT1FirstLiveControl();
  if (read.status === "absent") return { ok: true, reason: "absent" };
  if (read.status === "invalid") {
    if (safeCpuAndMemory()) setMode("drain");
    return { ok: false, reason: "control_invalid" };
  }
  if (read.value.status === "closed") return closeTreasuryT1FirstLive();
  const value = read.value;
  const now = Date.now();
  let reason = "";
  if (Game.time >= value.deadlineTick) reason = "fixed_tick_deadline";
  else if (now >= value.deadlineMs) reason = "fixed_wall_deadline";
  else if (now >= value.controlUntilMs) reason = "control_lease_expired";
  else if (now < value.startedAtMs || Game.time < value.startedAtTick) reason = "clock_regressed";
  else if (!deploymentMatches() || value.deployTag !== BUILD_INFO.tag ||
      value.deployBundleHash !== BUILD_INFO.bundleHash) reason = "deployment_changed";
  else if (runtime()?.treasuryProductionT1Quota !== undefined) reason = "quota_consumed";
  else if (rawMode() !== "canary") reason = "mode_stopped";
  else {
    const responsibility = readTreasuryT1Responsibility();
    if (responsibility.status === "invalid") return { ok: false, reason: responsibility.reason };
    const task = Memory.data?.resourceControl?.tasks?.[value.taskId];
    const ids = endpointIds();
    if (!task || !taskMatches(value, task, Math.min(task.remainingAmount, 100))) reason = "task_identity_changed";
    else if (!ids || ids.source !== value.sourceTerminalId || ids.target !== value.targetTerminalId) {
      reason = "endpoint_identity_changed";
    } else if (responsibility.status === "held") reason = "pre_native_recovery";
  }
  return reason ? closeTreasuryT1FirstLive(reason) : { ok: true, reason: "active" };
  } catch {
    return { ok: false, reason: "control_normalization_failed" };
  }
}

export function treasuryT1FirstLiveStatus(): unknown {
  const read = readTreasuryT1FirstLiveControl();
  return read.status === "valid" ? { ...read.value, mode: rawMode(),
    quotaPresent: runtime()?.treasuryProductionT1Quota !== undefined } : { status: read.status, mode: rawMode() };
}
