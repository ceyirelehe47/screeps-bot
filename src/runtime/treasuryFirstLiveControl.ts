import { BUILD_INFO } from "@/buildMeta";
import { createTreasuryFirstLiveState, runtime, finiteNonNegative, treasuryT1SerializedBytes,
  type Control, type Payload } from "@/runtime/treasuryFirstLiveState";
import { TREASURY_TERMINAL_LANES, treasuryLaneTaskMatches, type TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
import { readTreasuryLaneResponsibility } from "@/runtime/treasuryTerminalResponsibility";
import { inspectTreasuryResourceTransferReadiness, inspectTreasuryResourceTransferPreparation } from "@/runtime/resourceControl";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { resolveTreasuryTerminalSliceAmount } from "@/runtime/treasuryTerminalAmount";
import {
  hasTerminalActionClaim,
  hasTerminalSendEffectThisTick,
  hasTerminalCargoEffectThisTick,
} from "@/runtime/marketActionArbiter";
const MAX_MEMORY_BYTES = 1_900_000;
const MIN_CPU_REMAINING = 20;
const MIN_CPU_BUCKET = 2_000;

export function createTreasuryFirstLiveControl(lane: TreasuryTerminalLane) {
const PRIMARY = lane.controlKey;
const MIRROR = lane.controlMirrorKey;
const CONTROL_RUN_ID = lane.controlRunId;
const TREASURY_T1_SOURCE_ROOM = lane.sourceRoom;
const TREASURY_T1_TARGET_ROOM = lane.targetRoom;
const { readControl: readTreasuryT1FirstLiveControl, seal } = createTreasuryFirstLiveState(lane);
const readTreasuryT1Responsibility = () => readTreasuryLaneResponsibility(lane);
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
    hasTerminalActionClaim(roomName) || hasTerminalSendEffectThisTick(roomName) || hasTerminalCargoEffectThisTick(roomName));
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
    task.toRoomName === TREASURY_T1_TARGET_ROOM && treasuryLaneTaskMatches(lane, task) &&
    finiteNonNegative(task.remainingAmount) && Number.isSafeInteger(amount) && amount >= 1 && amount <= 100 &&
    amount <= task.remainingAmount;
}

function taskMatches(control: Control, task: ResourceTransferTask, amount: number): boolean {
  return task.id === control.taskId && task.createdAt === control.taskCreatedAt &&
    task.amount === control.taskAmount &&
    task.remainingAmount === control.taskRemainingAtArm && taskEligible(task, amount);
}

function otherResponsibilityClear(): boolean {
  return TREASURY_TERMINAL_LANES.every((other) => {
    if (other === lane) return true;
    const control = createTreasuryFirstLiveState(other).readControl();
    return control.status !== "invalid" && !(control.status === "valid" && control.value.status !== "closed") &&
      readTreasuryLaneResponsibility(other).status === "clear";
  });
}

function treasuryT1FirstLiveAllows(task: ResourceTransferTask, amount: number): boolean {
  const read = readTreasuryT1FirstLiveControl();
  if (read.status !== "valid" || read.value.status !== "active") return false;
  const control = read.value;
  const now = Date.now();
  const ids = endpointIds();
  return otherResponsibilityClear() && now < control.deadlineMs && now < control.controlUntilMs &&
    Game.time < control.deadlineTick && Game.time >= control.startedAtTick &&
    deploymentMatches() && control.deployTag === BUILD_INFO.tag &&
    control.deployBundleHash === BUILD_INFO.bundleHash &&
    ids?.source === control.sourceTerminalId && ids.target === control.targetTerminalId &&
    (!lane.demandBoundedSlice || finiteNonNegative(control.maxSliceAmount) && amount <= control.maxSliceAmount) &&
    taskMatches(control, task, amount) && safeCpuAndMemory();
}

function rawMode(): unknown {
  const cfg = (Memory as unknown as { cfg?: Record<string, unknown> }).cfg;
  const entry = cfg?.[lane.configKey];
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>).mode : undefined;
}

function setMode(mode: "off" | "canary" | "drain"): boolean {
  try {
  if (rawMode() === mode) return true;
  const memory = Memory as unknown as { cfg?: Record<string, unknown> };
  memory.cfg ??= {};
  const prior = memory.cfg[lane.configKey];
  memory.cfg[lane.configKey] = {
    ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}), mode,
  };
  return rawMode() === mode;
  } catch {
    return false;
  }
}

function startTreasuryFirstLive(taskId: string, createdAt: number, requestedAmount: number, initialStatus: "preparing" | "active"): { ok: boolean; reason: string } {
  if (!Number.isSafeInteger(requestedAmount) || requestedAmount < 1 || requestedAmount > 100 ||
      !lane.demandBoundedSlice && requestedAmount !== 100) return { ok: false, reason: "slice_amount_invalid" };
  if (initialStatus === "preparing" && !lane.demandBoundedSlice) return { ok: false, reason: "preparation_not_supported" };
  const prior = readTreasuryT1FirstLiveControl();
  const prepared = initialStatus === "active" && lane.demandBoundedSlice && prior.status === "valid" && prior.value.status === "preparing" ? prior.value : undefined;
  if (!otherResponsibilityClear() || prior.status !== "absent" && prepared === undefined ||
      runtime()?.[lane.quotaKey] !== undefined ||
      readTreasuryT1Responsibility().status !== "clear") return { ok: false, reason: "already_used_or_unsettled" };
  if (prepared === undefined ? rawMode() !== undefined && rawMode() !== "off" : rawMode() !== "canary") return { ok: false, reason: "mode_not_off" };
  if (!deploymentMatches() || !safeCpuAndMemory()) return { ok: false, reason: "environment_gate" };
  const now = Date.now();
  if (prepared && (now < prepared.startedAtMs || now >= prepared.deadlineMs || now >= prepared.controlUntilMs ||
      Game.time < prepared.startedAtTick || Game.time >= prepared.deadlineTick ||
      prepared.deployTag !== BUILD_INFO.tag || prepared.deployBundleHash !== BUILD_INFO.bundleHash ||
      prepared.maxSliceAmount !== requestedAmount)) return { ok: false, reason: "preparation_expired_or_changed" };
  if (endpointAlreadyTouchedThisTick()) return { ok: false, reason: "terminal_action_this_tick" };
  const task = Memory.data?.resourceControl?.tasks?.[taskId] as ResourceTransferTask | undefined;
  const ids = endpointIds();
  if (!task || !ids || task.id !== taskId || task.createdAt !== createdAt ||
      task.treasurySlice !== undefined ||
      !taskEligible(task, Math.min(task.remainingAmount, 100))) {
    return { ok: false, reason: "task_or_endpoint_gate" };
  }
  if (prepared && (!taskMatches(prepared, task, 1) || ids.source !== prepared.sourceTerminalId ||
      ids.target !== prepared.targetTerminalId)) return { ok: false, reason: "preparation_identity_changed" };
  const source = Game.rooms[TREASURY_T1_SOURCE_ROOM].terminal!;
  const target = Game.rooms[TREASURY_T1_TARGET_ROOM].terminal!;
  const amount = resolveTreasuryTerminalSliceAmount(lane, task, requestedAmount);
  if (amount < 1) return { ok: false, reason: "synthesis_need_already_covered" };
  let fee: number;
  try { fee = Game.market.calcTransactionCost(amount, TREASURY_T1_SOURCE_ROOM, TREASURY_T1_TARGET_ROOM); }
  catch { return { ok: false, reason: "quote_unavailable" }; }
  if (!finiteNonNegative(fee) || fee > 100 ||
      initialStatus === "active" && (source.cooldown !== 0 || (source.store.getUsedCapacity(lane.resource) ?? 0) < amount) ||
      (source.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) < fee ||
      (target.store.getFreeCapacity() ?? 0) < amount) {
    return { ok: false, reason: "live_send_not_ready" };
  }
  if (lane.requiredProduct !== undefined) {
    const ready = initialStatus === "preparing" ? inspectTreasuryResourceTransferPreparation(task, amount, fee)
      : inspectTreasuryResourceTransferReadiness(task, amount, fee);
    if (!ready.ok) return { ok: false, reason: ready.reason };
  }
  const payload: Payload = prepared ? (() => { const { hash: _hash, ...original } = prepared; return {...original, status: "active" as const}; })() : {
    schemaVersion: 1, runId: CONTROL_RUN_ID, status: initialStatus,
    startedAtTick: Game.time, deadlineTick: Game.time + 600,
    startedAtMs: now, deadlineMs: now + 30 * 60_000,
    lastHeartbeatAtMs: now,
    controlUntilMs: now + 60_000,
    taskId, taskCreatedAt: task.createdAt, taskAmount: task.amount,
    taskRemainingAtArm: task.remainingAmount,
    sourceTerminalId: ids.source, targetTerminalId: ids.target,
    deployTag: BUILD_INFO.tag, deployBundleHash: BUILD_INFO.bundleHash,
    closeReason: "",
    ...(lane.demandBoundedSlice ? { maxSliceAmount: requestedAmount } : {}),
  };
  if (!writeControl(payload)) return { ok: false, reason: "control_write_failed" };
  if (!setMode("canary")) return { ok: false, reason: "mode_write_failed" };
  return { ok: true, reason: initialStatus === "preparing" ? "prepared" : "armed" };
}

function armTreasuryT1FirstLive(taskId: string, createdAt: number, requestedAmount = 100): { ok: boolean; reason: string } {
  return startTreasuryFirstLive(taskId, createdAt, requestedAmount, "active");
}
function prepareTreasuryFirstLive(taskId: string, createdAt: number, requestedAmount = 100): { ok: boolean; reason: string } {
  return startTreasuryFirstLive(taskId, createdAt, requestedAmount, "preparing");
}

function heartbeatTreasuryT1FirstLive(): { ok: boolean; reason: string } {
  const read = readTreasuryT1FirstLiveControl();
  if (read.status !== "valid" || read.value.status === "closed") return { ok: false, reason: "not_active" };
  const now = Date.now();
  const value = read.value;
  if (now >= value.controlUntilMs || now >= value.deadlineMs ||
      Game.time >= value.deadlineTick || !deploymentMatches() ||
      runtime()?.[lane.quotaKey] !== undefined) {
    return { ok: false, reason: "expired_or_consumed" };
  }
  const { hash: _hash, ...payload } = value;
  return writeControl({ ...payload, lastHeartbeatAtMs: now,
    controlUntilMs: Math.min(value.deadlineMs, now + 60_000) })
    ? { ok: true, reason: "renewed" } : { ok: false, reason: "control_write_failed" };
}

function closeTreasuryT1FirstLive(reason = "operator_stop"): { ok: boolean; reason: string } {
  const read = readTreasuryT1FirstLiveControl();
  if (read.status !== "valid") return { ok: false, reason: read.status };
  const nextMode = readTreasuryT1Responsibility().status === "clear" ? "off" : "drain";
  if (read.value.status === "closed" && rawMode() === nextMode) return { ok: true, reason: "closed" };
  if (!safeCpuAndMemory()) return { ok: false, reason: "environment_gate" };
  if (read.value.status !== "closed") {
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
function normalizeTreasuryT1FirstLiveControl(): { ok: boolean; reason: string } {
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
  else if (runtime()?.[lane.quotaKey] !== undefined) reason = "quota_consumed";
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
  return reason ? closeTreasuryT1FirstLive(reason) : { ok: true, reason: value.status };
  } catch {
    return { ok: false, reason: "control_normalization_failed" };
  }
}

function treasuryT1FirstLiveStatus(): unknown {
  const read = readTreasuryT1FirstLiveControl();
  return read.status === "valid" ? { ...read.value, mode: rawMode(),
    quotaPresent: runtime()?.[lane.quotaKey] !== undefined } : { status: read.status, mode: rawMode() };
}

return {
  arm: armTreasuryT1FirstLive, prepare: prepareTreasuryFirstLive, heartbeat: heartbeatTreasuryT1FirstLive,
  close: closeTreasuryT1FirstLive, normalize: normalizeTreasuryT1FirstLiveControl,
  allows: treasuryT1FirstLiveAllows, status: treasuryT1FirstLiveStatus,
  read: readTreasuryT1FirstLiveControl,
};
}
