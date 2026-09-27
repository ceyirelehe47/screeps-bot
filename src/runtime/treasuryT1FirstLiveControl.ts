import { BUILD_INFO } from "@/buildMeta";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import {
  hasTerminalActionClaim,
  hasTerminalSendEffectThisTick,
} from "@/runtime/marketActionArbiter";
import { hasTreasuryT1TerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
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
  | { status: "absent" | "invalid" }
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
  const state = runtime();
  const primary = state?.[PRIMARY];
  const mirror = state?.[MIRROR];
  if (primary === undefined && mirror === undefined) return { status: "absent" };
  if (!valid(primary) || !valid(mirror) ||
      JSON.stringify(primary) !== JSON.stringify(mirror)) return { status: "invalid" };
  return { status: "valid", value: primary };
}

function writeControl(payload: Payload): boolean {
  try {
    const memory = Memory as unknown as { runtime?: Record<string, unknown> };
    const sealed = seal(payload);
    if (JSON.stringify(Memory).length + JSON.stringify(sealed).length * 2 + 512 > MAX_MEMORY_BYTES) {
      return false;
    }
    memory.runtime ??= {};
    memory.runtime[PRIMARY] = { ...sealed };
    memory.runtime[MIRROR] = { ...sealed };
    const readback = readTreasuryT1FirstLiveControl();
    return readback.status === "valid" && readback.value.hash === sealed.hash;
  } catch {
    return false;
  }
}

function safeCpuAndMemory(): boolean {
  try {
    const cpu = Game.cpu;
    const used = cpu.getUsed();
    return Number.isFinite(used) && Number.isFinite(cpu.tickLimit) &&
      Number.isFinite(cpu.bucket) && cpu.tickLimit - used >= MIN_CPU_REMAINING &&
      cpu.bucket >= MIN_CPU_BUCKET && JSON.stringify(Memory).length + 4_096 < MAX_MEMORY_BYTES;
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

function setMode(mode: "off" | "canary" | "drain"): void {
  const memory = Memory as unknown as { cfg?: Record<string, unknown> };
  memory.cfg ??= {};
  const prior = memory.cfg.treasuryTerminalTransferSlice0;
  memory.cfg.treasuryTerminalTransferSlice0 = {
    ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}), mode,
  };
}

export function armTreasuryT1FirstLive(taskId: string, createdAt: number): { ok: boolean; reason: string } {
  if (readTreasuryT1FirstLiveControl().status !== "absent" ||
      runtime()?.treasuryProductionT1Quota !== undefined ||
      hasTreasuryT1TerminalFence()) return { ok: false, reason: "already_used_or_unsettled" };
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
  setMode("canary");
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
  if (read.value.status === "active") {
    const { hash: _hash, ...payload } = read.value;
    if (!writeControl({ ...payload, status: "closed", closeReason: reason.slice(0, 80) || "closed" })) {
      return { ok: false, reason: "control_write_failed" };
    }
  }
  setMode(hasTreasuryT1TerminalFence() ? "drain" : "off");
  return { ok: true, reason: "closed" };
}

export function treasuryT1FirstLiveStatus(): unknown {
  const read = readTreasuryT1FirstLiveControl();
  return read.status === "valid" ? { ...read.value, mode: rawMode(),
    quotaPresent: runtime()?.treasuryProductionT1Quota !== undefined } : { status: read.status, mode: rawMode() };
}
