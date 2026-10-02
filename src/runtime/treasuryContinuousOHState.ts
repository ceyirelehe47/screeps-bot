import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import { runtime, finiteNonNegative, treasuryT1SerializedBytes } from "@/runtime/treasuryFirstLiveState";
import { hashTreasuryCanonicalString, formatTreasuryStableTransactionId } from "@/runtime/treasury/transactionId";
import type { TreasuryT1Quota } from "@/runtime/treasuryTerminalResponsibility";
import type { TreasuryCoreRingEntry } from "@/runtime/treasury/kernel/types";
import {
  normalizeTreasuryContinuousOHPolicy, validateTreasuryContinuousOHBudget,
  type TreasuryContinuousOHConsumption, type TreasuryContinuousOHPolicy,
} from "@/runtime/treasuryContinuousOHBudget";

export const PRIMARY = "treasuryContinuousOH";
export const MIRROR = "treasuryContinuousOHMirror";
export const CONTROL_RUN_ID = "treasury-continuous-oh-control-2026-10-02";
export const CONTINUOUS_RUN_ID = "treasury-continuous-oh-T4-2026-10-02";
export const CONTINUOUS_ACTION_KIND = "production.terminal-transfer.oh-continuous.slice";
export const TREASURY_CONTINUOUS_OH_SESSION_MS = 72 * 60 * 60_000;
export const TREASURY_CONTINUOUS_OH_SESSION_TICKS = 72_000;
export const TREASURY_CONTINUOUS_OH_MAX_MEMORY_BYTES = 1_900_000;

export interface TreasuryContinuousOHPilot {
  readonly taskId: string;
  readonly taskCreatedAt: number;
  readonly taskAmount: number;
  readonly cap: 26;
  readonly sliceCap: 10;
  readonly completedAtTick: number | null;
  readonly completedAtMs: number | null;
  readonly completionReason: "cap_settled" | "demand_satisfied" | "shortened" | null;
  readonly releasedAtTick: number | null;
  readonly releasedAtMs: number | null;
}

export interface TreasuryContinuousOHCycle {
  readonly sequence: number;
  readonly status: "preparing" | "active" | "closed";
  readonly startedAtTick: number;
  readonly deadlineTick: number;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly lastHeartbeatAtMs: number;
  readonly controlUntilMs: number;
  readonly taskId: string;
  readonly taskCreatedAt: number;
  readonly taskAmount: number;
  readonly taskRemainingAtArm: number;
  readonly amount: number;
  readonly closeReason: string;
  readonly quota: TreasuryT1Quota | null;
  readonly reservedFee: number | null;
}

/** 完整关闭证书不随 kernel 的近期明细环淘汰；未关闭原责任始终留在 currentCycle。 */
export interface TreasuryContinuousOHClosedCertificate {
  readonly sequence: number;
  readonly cycle: TreasuryContinuousOHCycle;
  readonly closedAtTick: number;
  readonly closedAtMs: number;
  readonly outcome: "committed" | "not_executed" | "cancelled";
  readonly taskRemainingAtClose: number;
  readonly ring: TreasuryCoreRingEntry | null;
}

export interface TreasuryContinuousOHState {
  readonly schemaVersion: 1;
  readonly runId: typeof CONTROL_RUN_ID;
  readonly sessionId: string;
  readonly sessionStatus: "running" | "pilot_complete_awaiting_release" | "stopping" | "stopped";
  /** 关闭证书已落盘、config 尚未交接的窄窗口；reset 后只恢复此已签名的 canary 意图。 */
  readonly modeTransition: "canary_after_closure" | null;
  readonly enabledAtTick: number;
  readonly enabledAtMs: number;
  readonly lastObservedAtTick: number;
  readonly lastObservedAtMs: number;
  readonly deadlineTick: number;
  readonly deadlineMs: number;
  readonly deployTag: string;
  readonly deployBundleHash: string;
  readonly sourceTerminalId: string;
  readonly targetTerminalId: string;
  readonly policy: TreasuryContinuousOHPolicy;
  readonly pilot: TreasuryContinuousOHPilot;
  readonly sequenceHighWater: number;
  readonly currentCycle: TreasuryContinuousOHCycle | null;
  readonly closedCycles: readonly TreasuryContinuousOHClosedCertificate[];
  readonly consumption: readonly TreasuryContinuousOHConsumption[];
  readonly stopReason: string;
  readonly hash: string;
}

export type TreasuryContinuousOHStatePayload = Omit<TreasuryContinuousOHState, "hash">;
export type TreasuryContinuousOHStateRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: TreasuryContinuousOHState };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function fields<T extends object>(value: T, names: readonly string[]): boolean;
function fields(value: unknown, names: readonly string[]): value is Record<string, unknown>;
function fields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!object(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const expected = [...names].sort();
  const keys = Object.getOwnPropertyNames(value).sort();
  return keys.length === expected.length && keys.every((key, index) =>
    key === expected[index] && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}

const shortString = (value: unknown, max = 160): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const reasonString = (value: unknown): value is string => typeof value === "string" && value.length <= 80;
function plainArray(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
      Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  return names.length === value.length + 1 && names.includes("length") &&
    Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
}

export function treasuryContinuousOHWorkKey(taskId: string, sequence: number): string {
  return `biz:${CONTINUOUS_RUN_ID}:${hashTreasuryCanonicalString(taskId)}:${sequence}`;
}

function validQuota(value: unknown, cycle: TreasuryContinuousOHCycle): value is TreasuryT1Quota {
  if (!fields(value, ["schemaVersion", "runId", "status", "taskId", "taskCreatedAt", "taskAmount",
    "workKey", "attemptId", "amount", "reservedAtTick"])) return false;
  return value.schemaVersion === 2 && value.runId === CONTINUOUS_RUN_ID &&
    ["reserved", "dispatching", "drained"].includes(value.status as string) &&
    value.taskId === cycle.taskId && value.taskCreatedAt === cycle.taskCreatedAt &&
    value.taskAmount === cycle.taskAmount && value.amount === cycle.amount &&
    value.workKey === treasuryContinuousOHWorkKey(cycle.taskId, cycle.sequence) &&
    typeof value.attemptId === "string" && /^[A-Za-z0-9:_\-.]{1,128}$/.test(value.attemptId) && finiteNonNegative(value.reservedAtTick) &&
    value.reservedAtTick >= cycle.startedAtTick;
}

function validCycle(value: unknown, session: TreasuryContinuousOHState, sequence: number): value is TreasuryContinuousOHCycle {
  if (!fields(value, ["sequence", "status", "startedAtTick", "deadlineTick", "startedAtMs", "deadlineMs",
    "lastHeartbeatAtMs", "controlUntilMs", "taskId", "taskCreatedAt", "taskAmount", "taskRemainingAtArm",
    "amount", "closeReason", "quota", "reservedFee"])) return false;
  const cycle = value as unknown as TreasuryContinuousOHCycle;
  if (cycle.sequence !== sequence || !["preparing", "active", "closed"].includes(cycle.status) ||
      ![cycle.startedAtTick, cycle.deadlineTick, cycle.startedAtMs, cycle.deadlineMs,
        cycle.lastHeartbeatAtMs, cycle.controlUntilMs, cycle.taskCreatedAt, cycle.taskAmount,
        cycle.taskRemainingAtArm, cycle.amount].every(finiteNonNegative) ||
      cycle.startedAtTick < session.enabledAtTick || cycle.startedAtMs < session.enabledAtMs ||
      cycle.startedAtTick > session.lastObservedAtTick || cycle.startedAtMs > session.lastObservedAtMs ||
      cycle.deadlineTick <= cycle.startedAtTick || cycle.deadlineTick > Math.min(session.deadlineTick, cycle.startedAtTick + 600) ||
      cycle.deadlineMs <= cycle.startedAtMs || cycle.deadlineMs > Math.min(session.deadlineMs, cycle.startedAtMs + 30 * 60_000) ||
      cycle.lastHeartbeatAtMs < cycle.startedAtMs || cycle.lastHeartbeatAtMs >= cycle.deadlineMs ||
      cycle.controlUntilMs < cycle.lastHeartbeatAtMs ||
      cycle.controlUntilMs > Math.min(cycle.deadlineMs, cycle.lastHeartbeatAtMs + 60_000) ||
      !shortString(cycle.taskId, 80) || cycle.taskAmount < 1 || cycle.taskRemainingAtArm < cycle.amount ||
      cycle.taskRemainingAtArm > cycle.taskAmount || cycle.amount < 1 || cycle.amount > session.policy.sliceAmount ||
      !reasonString(cycle.closeReason) || (cycle.status === "closed" ? cycle.closeReason === "" : cycle.closeReason !== "") ||
      (cycle.quota === null ? cycle.reservedFee !== null : !validQuota(cycle.quota, cycle) ||
        cycle.quota.reservedAtTick > session.lastObservedAtTick ||
        !finiteNonNegative(cycle.reservedFee) || cycle.reservedFee > session.policy.rolling24hEnergy)) return false;
  if (session.pilot.releasedAtTick === null || cycle.startedAtTick <= session.pilot.releasedAtTick) {
    if (cycle.taskId !== session.pilot.taskId || cycle.taskCreatedAt !== session.pilot.taskCreatedAt ||
        cycle.taskAmount !== session.pilot.taskAmount || cycle.amount > session.pilot.sliceCap) return false;
  }
  return true;
}

function validRing(value: unknown, cycle: TreasuryContinuousOHCycle): value is TreasuryCoreRingEntry {
  return fields(value, ["attemptId", "workKey", "generation", "terminalPhase", "closedAtTick"]) &&
    cycle.quota !== null && value.attemptId === cycle.quota.attemptId && value.workKey === cycle.quota.workKey &&
    value.generation === 1 && ["committed", "not_executed", "abandoned"].includes(value.terminalPhase as string) &&
    finiteNonNegative(value.closedAtTick) && value.closedAtTick >= cycle.quota.reservedAtTick;
}

function stateHash(payload: TreasuryContinuousOHStatePayload): string {
  return canonicalStableHashV1({ domain: "treasury-t4:continuous-oh-state-v1", payload });
}

export function sealTreasuryContinuousOHState(payload: TreasuryContinuousOHStatePayload): TreasuryContinuousOHState {
  return { ...payload, hash: stateHash(payload) };
}

export function validTreasuryContinuousOHState(raw: unknown): raw is TreasuryContinuousOHState {
  try {
    if (!fields(raw, ["schemaVersion", "runId", "sessionId", "sessionStatus", "modeTransition", "enabledAtTick", "enabledAtMs", "lastObservedAtTick", "lastObservedAtMs",
      "deadlineTick", "deadlineMs", "deployTag", "deployBundleHash", "sourceTerminalId", "targetTerminalId",
      "policy", "pilot", "sequenceHighWater", "currentCycle", "closedCycles", "consumption", "stopReason", "hash"])) return false;
    const state = raw as unknown as TreasuryContinuousOHState;
    if (state.schemaVersion !== 1 || state.runId !== CONTROL_RUN_ID ||
        !shortString(state.sessionId, 128) ||
        !["running", "pilot_complete_awaiting_release", "stopping", "stopped"].includes(state.sessionStatus) ||
        (state.modeTransition !== null && state.modeTransition !== "canary_after_closure") ||
        state.modeTransition !== null && (state.currentCycle !== null ||
          !["running", "pilot_complete_awaiting_release"].includes(state.sessionStatus) || state.closedCycles.length === 0) ||
        ![state.enabledAtTick, state.enabledAtMs, state.lastObservedAtTick, state.lastObservedAtMs,
          state.deadlineTick, state.deadlineMs, state.sequenceHighWater].every(finiteNonNegative) ||
        state.lastObservedAtTick < state.enabledAtTick || state.lastObservedAtMs < state.enabledAtMs ||
        state.deadlineTick !== state.enabledAtTick + TREASURY_CONTINUOUS_OH_SESSION_TICKS ||
        state.deadlineMs !== state.enabledAtMs + TREASURY_CONTINUOUS_OH_SESSION_MS ||
        ![state.deployTag, state.deployBundleHash, state.sourceTerminalId, state.targetTerminalId].every((v) => shortString(v)) ||
        state.deployBundleHash === "none" || state.sourceTerminalId === state.targetTerminalId ||
        state.sessionId !== formatTreasuryStableTransactionId(CONTROL_RUN_ID, state.enabledAtTick, state.enabledAtMs,
          state.deployTag, state.deployBundleHash, state.sourceTerminalId, state.targetTerminalId) ||
        !reasonString(state.stopReason) ||
        (state.sessionStatus === "stopping" || state.sessionStatus === "stopped" ? state.stopReason === "" : state.stopReason !== "")) return false;
    const normalized = normalizeTreasuryContinuousOHPolicy(state.policy);
    if (!normalized.ok || JSON.stringify(normalized.policy) !== JSON.stringify(state.policy) ||
        state.sequenceHighWater > state.policy.maxPrepareCycles) return false;
    const pilot = state.pilot;
    if (!fields(pilot, ["taskId", "taskCreatedAt", "taskAmount", "cap", "sliceCap", "completedAtTick", "completedAtMs", "completionReason", "releasedAtTick", "releasedAtMs"]) ||
        !shortString(pilot.taskId, 80) || !finiteNonNegative(pilot.taskCreatedAt) ||
        !finiteNonNegative(pilot.taskAmount) || pilot.taskAmount < 1 || pilot.cap !== 26 || pilot.sliceCap !== 10 ||
        ((pilot.completedAtTick === null) !== (pilot.completedAtMs === null)) ||
        ((pilot.completedAtTick === null) !== (pilot.completionReason === null)) ||
        (pilot.completedAtTick !== null && (!finiteNonNegative(pilot.completedAtTick) || !finiteNonNegative(pilot.completedAtMs) ||
          pilot.completedAtTick < state.enabledAtTick || pilot.completedAtTick >= state.deadlineTick ||
          pilot.completedAtMs < state.enabledAtMs || pilot.completedAtMs >= state.deadlineMs ||
          !["cap_settled", "demand_satisfied", "shortened"].includes(pilot.completionReason!))) ||
        ((pilot.releasedAtTick === null) !== (pilot.releasedAtMs === null)) ||
        (pilot.releasedAtTick !== null && (!finiteNonNegative(pilot.releasedAtTick) || !finiteNonNegative(pilot.releasedAtMs) ||
          pilot.releasedAtTick < state.enabledAtTick || pilot.releasedAtTick >= state.deadlineTick ||
          pilot.releasedAtMs < state.enabledAtMs || pilot.releasedAtMs >= state.deadlineMs ||
          pilot.completedAtTick === null || pilot.completedAtMs === null ||
          pilot.releasedAtTick < pilot.completedAtTick || pilot.releasedAtMs < pilot.completedAtMs)) ||
        state.sessionStatus === "pilot_complete_awaiting_release" &&
          (pilot.releasedAtTick !== null || pilot.completedAtTick === null)) return false;
    if (!plainArray(state.closedCycles, state.policy.maxPrepareCycles) ||
        !Array.isArray(state.consumption) ||
        !validateTreasuryContinuousOHBudget(state.policy, state.consumption, state.enabledAtMs,
          state.enabledAtTick, state.sequenceHighWater) ||
        state.sequenceHighWater !== state.closedCycles.length + (state.currentCycle === null ? 0 : 1)) return false;
    if (state.currentCycle !== null && !validCycle(state.currentCycle, state, state.sequenceHighWater)) return false;
    if ((state.sessionStatus === "stopped" || state.sessionStatus === "pilot_complete_awaiting_release") && state.currentCycle !== null) return false;
    const cycles: TreasuryContinuousOHCycle[] = [];
    for (let index = 0; index < state.closedCycles.length; index += 1) {
      const cert = state.closedCycles[index];
      if (!fields(cert, ["sequence", "cycle", "closedAtTick", "closedAtMs", "outcome", "taskRemainingAtClose", "ring"]) ||
          cert.sequence !== index + 1 || !validCycle(cert.cycle, state, cert.sequence) || cert.cycle.status !== "closed" ||
          ![cert.closedAtTick, cert.closedAtMs, cert.taskRemainingAtClose].every(finiteNonNegative) ||
          cert.closedAtTick < cert.cycle.startedAtTick || cert.closedAtMs < cert.cycle.startedAtMs ||
          cert.closedAtTick > state.lastObservedAtTick || cert.closedAtMs > state.lastObservedAtMs ||
          !["committed", "not_executed", "cancelled"].includes(cert.outcome)) return false;
      if (cert.outcome === "cancelled") {
        if (cert.ring !== null || cert.cycle.quota !== null || cert.taskRemainingAtClose !== cert.cycle.taskRemainingAtArm) return false;
      } else {
        if (!validRing(cert.ring, cert.cycle) || cert.cycle.quota?.status !== "drained" ||
            cert.ring.closedAtTick > cert.closedAtTick ||
            (cert.outcome === "committed" ? cert.ring.terminalPhase !== "committed" ||
              cert.taskRemainingAtClose !== cert.cycle.taskRemainingAtArm - cert.cycle.amount :
              !["not_executed", "abandoned"].includes(cert.ring.terminalPhase) ||
              cert.taskRemainingAtClose !== cert.cycle.taskRemainingAtArm)) return false;
      }
      cycles.push(cert.cycle);
    }
    if (state.currentCycle !== null) cycles.push(state.currentCycle);
    let pilotDebited = 0;
    let committedPilot = 0;
    let committedPilotCycles = 0;
    for (const cert of state.closedCycles) {
      if ((pilot.releasedAtTick === null || cert.cycle.startedAtTick <= pilot.releasedAtTick) && cert.outcome === "committed") {
        committedPilot += cert.cycle.amount;
        committedPilotCycles += 1;
      }
    }
    for (const debit of state.consumption) {
      const cycle = cycles[debit.sequence - 1];
      if (!cycle || !cycle.quota || cycle.quota.status === "reserved" ||
          debit.attemptId !== cycle.quota.attemptId || debit.amount !== cycle.amount ||
          debit.fee !== cycle.reservedFee || debit.atTick < cycle.quota.reservedAtTick ||
          debit.atMs < cycle.startedAtMs || debit.atTick > state.lastObservedAtTick || debit.atMs > state.lastObservedAtMs ||
          debit.atTick >= cycle.deadlineTick || debit.atMs >= cycle.deadlineMs ||
          debit.atTick >= state.deadlineTick || debit.atMs >= state.deadlineMs) return false;
      if (pilot.releasedAtTick === null || cycle.startedAtTick <= pilot.releasedAtTick) pilotDebited += debit.amount;
    }
    for (const cycle of cycles) {
      const debit = state.consumption.find((entry) => entry.sequence === cycle.sequence);
      if (cycle.quota?.status === "dispatching" && !debit) return false;
      const cert = state.closedCycles[cycle.sequence - 1];
      if (cert?.outcome === "committed" && !debit) return false;
    }
    if (pilotDebited > pilot.cap || committedPilot > pilot.cap ||
        pilot.completedAtTick !== null && (committedPilotCycles < 1 ||
          pilot.completionReason === "cap_settled" && committedPilot !== pilot.cap ||
          pilot.completionReason === "shortened" && committedPilotCycles !== 1 ||
          pilot.completionReason === "demand_satisfied" && committedPilotCycles < 2) ||
        pilot.releasedAtTick !== null && (committedPilotCycles < 2 || pilot.completionReason === "shortened")) return false;
    const { hash, ...payload } = state;
    return hash === stateHash(payload);
  } catch { return false; }
}

export function readTreasuryContinuousOHState(): TreasuryContinuousOHStateRead {
  try {
    const memory = runtime();
    const primary = memory?.[PRIMARY];
    const mirror = memory?.[MIRROR];
    if (primary === undefined && mirror === undefined) return { status: "absent" };
    if (!validTreasuryContinuousOHState(primary) || !validTreasuryContinuousOHState(mirror) ||
        JSON.stringify(primary) !== JSON.stringify(mirror)) return { status: "invalid" };
    return { status: "valid", value: primary };
  } catch { return { status: "invalid" }; }
}

/** 成对发布失败只能恢复已验证签名的原快照；无证据时保留坏态并停新work。 */
export function writeTreasuryContinuousOHState(payload: TreasuryContinuousOHStatePayload): boolean {
  const baseline = readTreasuryContinuousOHState();
  let destination: Record<string, unknown> | undefined;
  let sealed: TreasuryContinuousOHState | undefined;
  try {
    sealed = sealTreasuryContinuousOHState(payload);
    // 已验证自己的两份book是替换，不是新增；坏/未知原值绝不据此减去字节。
    const removedBytes = baseline.status === "valid" ? treasuryT1SerializedBytes(baseline.value) * 2 : 0;
    const projectedBytes = treasuryT1SerializedBytes(Memory) - removedBytes + treasuryT1SerializedBytes(sealed) * 2 + 512;
    if (!validTreasuryContinuousOHState(sealed) || projectedBytes >= TREASURY_CONTINUOUS_OH_MAX_MEMORY_BYTES) return false;
    const memory = Memory as unknown as { runtime?: Record<string, unknown> };
    if (memory.runtime !== undefined && !object(memory.runtime)) return false;
    memory.runtime ??= {};
    destination = memory.runtime;
    destination[PRIMARY] = JSON.parse(JSON.stringify(sealed));
    destination[MIRROR] = JSON.parse(JSON.stringify(sealed));
    const readback = readTreasuryContinuousOHState();
    if (readback.status === "valid" && readback.value.hash === sealed.hash) return true;
  } catch { /* 只恢复已知baseline，绝不将无效历史当成新session。 */ }
  try {
    if (baseline.status === "valid" && destination !== undefined && runtime() === destination && sealed !== undefined) {
      const before = JSON.stringify(baseline.value);
      const after = JSON.stringify(sealed);
      const known = (raw: unknown) => [before, after].includes(JSON.stringify(raw));
      if (known(destination[PRIMARY]) && known(destination[MIRROR])) {
        destination[PRIMARY] = JSON.parse(before);
        destination[MIRROR] = JSON.parse(before);
      }
    }
  } catch { /* 回滚失败保持invalid，原责任不得删除。 */ }
  return false;
}

export function treasuryContinuousOHStatePayload(state: TreasuryContinuousOHState): TreasuryContinuousOHStatePayload {
  const { hash: _hash, ...payload } = state;
  // 所有产品写均带观察高水位；时钟倒退的停止写保留原高水位，不回退签名历史。
  const ms = Date.now();
  const tick = Game.time;
  return { ...payload,
    lastObservedAtTick: finiteNonNegative(tick) ? Math.max(tick, state.lastObservedAtTick) : state.lastObservedAtTick,
    lastObservedAtMs: finiteNonNegative(ms) ? Math.max(ms, state.lastObservedAtMs) : state.lastObservedAtMs,
  };
}
