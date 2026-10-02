import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import { runtime, finiteNonNegative, treasuryT1SerializedBytes } from "@/runtime/treasuryFirstLiveState";
import { hashTreasuryCanonicalString, formatTreasuryStableTransactionId } from "@/runtime/treasury/transactionId";
import { treasuryContinuousOHDataToken, treasuryContinuousOHJSONBytes, freezeTreasuryContinuousOHBook } from "@/runtime/treasuryContinuousOHDataTree";
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

interface TreasuryContinuousOHPilotBounds {
  readonly cap: 26;
  readonly sliceCap: 10;
  readonly completedAtTick: number | null;
  readonly completedAtMs: number | null;
  readonly completionReason: "cap_settled" | "demand_satisfied" | "shortened" | null;
  readonly releasedAtTick: number | null;
  readonly releasedAtMs: number | null;
}

/** schema2 的启动等待态明确没有 task 身份；绑定后不允许再回到 null 或更换。 */
export type TreasuryContinuousOHPilot = TreasuryContinuousOHPilotBounds & (
  | { readonly taskId: string; readonly taskCreatedAt: number; readonly taskAmount: number }
  | { readonly taskId: null; readonly taskCreatedAt: null; readonly taskAmount: null }
);

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
  readonly schemaVersion: 1 | 2;
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
  return canonicalStableHashV1({ domain: `treasury-t4:continuous-oh-state-v${payload.schemaVersion}`, payload });
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
    if (![1, 2].includes(state.schemaVersion) || state.runId !== CONTROL_RUN_ID ||
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
    const unbound = pilot.taskId === null && pilot.taskCreatedAt === null && pilot.taskAmount === null;
    const bound = shortString(pilot.taskId, 80) && finiteNonNegative(pilot.taskCreatedAt) &&
      finiteNonNegative(pilot.taskAmount) && pilot.taskAmount > 0;
    if (!fields(pilot, ["taskId", "taskCreatedAt", "taskAmount", "cap", "sliceCap", "completedAtTick", "completedAtMs", "completionReason", "releasedAtTick", "releasedAtMs"]) ||
        !(bound || state.schemaVersion === 2 && unbound) || pilot.cap !== 26 || pilot.sliceCap !== 10 ||
        unbound && (state.sequenceHighWater !== 0 || state.currentCycle !== null || state.closedCycles.length !== 0 ||
          state.consumption.length !== 0 || state.modeTransition !== null || pilot.completedAtTick !== null ||
          pilot.completedAtMs !== null || pilot.completionReason !== null || pilot.releasedAtTick !== null || pilot.releasedAtMs !== null) ||
        state.schemaVersion === 2 && bound && (pilot.taskAmount! > pilot.cap ||
          pilot.taskCreatedAt! < state.enabledAtTick ||
          !new RegExp(`^${pilot.taskCreatedAt}:[1-9][0-9]*:OH:E4N58->E1N57$`).test(pilot.taskId!)) ||
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
    // Budget已经证明sequence严格递增/唯一，绝不以Map覆盖duplicate来修复坏态。
    const debitBySequence = new Map(state.consumption.map((entry) => [entry.sequence, entry] as const));
    for (const cycle of cycles) {
      const debit = debitBySequence.get(cycle.sequence);
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

let validationGame: Game | undefined;
let validationMemory: Memory | undefined;
const validatedData = new Map<string, boolean>();

/** 只记忆完整字节对应的纯数学/签名结论；每次读取仍遍历两本全部 descriptor 和值。 */
function validToken(raw: unknown, token: string): boolean {
  if (validationGame !== Game || validationMemory !== Memory) {
    validationGame = Game; validationMemory = Memory; validatedData.clear();
  }
  const cached = validatedData.get(token);
  if (cached !== undefined) {
    validatedData.delete(token); validatedData.set(token, cached); return cached;
  }
  const valid = validTreasuryContinuousOHState(raw);
  validatedData.set(token, valid);
  while (validatedData.size > 4) validatedData.delete(validatedData.keys().next().value!);
  return valid;
}

function readStatePair(): { read: TreasuryContinuousOHStateRead; token?: string } {
  try {
    const memory = runtime();
    if (memory !== undefined && !object(memory)) return { read: { status: "invalid" } };
    const primarySlot = memory && Object.getOwnPropertyDescriptor(memory, PRIMARY);
    const mirrorSlot = memory && Object.getOwnPropertyDescriptor(memory, MIRROR);
    if ([primarySlot, mirrorSlot].some((slot) => slot && (!("value" in slot) || !slot.enumerable)) ||
        memory && (!primarySlot && PRIMARY in memory || !mirrorSlot && MIRROR in memory)) return { read: { status: "invalid" } };
    const primary = primarySlot?.value;
    const mirror = mirrorSlot?.value;
    if (primary === undefined && mirror === undefined) return { read: { status: "absent" } };
    const first = treasuryContinuousOHDataToken(primary);
    const second = treasuryContinuousOHDataToken(mirror);
    if (first === null || second === null || first !== second || !validToken(primary, first) ||
        !freezeTreasuryContinuousOHBook(primary as object, first) || !freezeTreasuryContinuousOHBook(mirror as object, first)) return { read: { status: "invalid" } };
    return { read: { status: "valid", value: primary as TreasuryContinuousOHState }, token: first };
  } catch { return { read: { status: "invalid" } }; }
}

export function readTreasuryContinuousOHState(): TreasuryContinuousOHStateRead {
  return readStatePair().read;
}

/** 成对发布失败只能恢复已验证签名的原快照；无证据时保留坏态并停新work。 */
export function writeTreasuryContinuousOHState(payload: TreasuryContinuousOHStatePayload): boolean {
  const baselinePair = readStatePair();
  const baseline = baselinePair.read;
  let destination: Record<string, unknown> | undefined;
  let sealed: TreasuryContinuousOHState | undefined;
  let serialized: string | null = null;
  try {
    if (baseline.status === "invalid") return false;
    if (baseline.status === "valid" && (payload.schemaVersion !== baseline.value.schemaVersion ||
        baseline.value.pilot.taskId !== null && (payload.pilot.taskId !== baseline.value.pilot.taskId ||
          payload.pilot.taskCreatedAt !== baseline.value.pilot.taskCreatedAt || payload.pilot.taskAmount !== baseline.value.pilot.taskAmount))) return false;
    sealed = sealTreasuryContinuousOHState(payload);
    serialized = treasuryContinuousOHDataToken(sealed);
    if (serialized === null || !validToken(sealed, serialized) || !freezeTreasuryContinuousOHBook(sealed, serialized)) return false;
    // 已验证自己的两份book是替换，不是新增；坏/未知原值绝不据此减去字节。
    const removedBytes = baselinePair.token === undefined ? 0 : treasuryContinuousOHJSONBytes(baselinePair.token) * 2;
    const projectedBytes = treasuryT1SerializedBytes(Memory) - removedBytes + treasuryContinuousOHJSONBytes(serialized) * 2 + 512;
    if (projectedBytes >= TREASURY_CONTINUOUS_OH_MAX_MEMORY_BYTES) return false;
    const memory = Memory as unknown as { runtime?: Record<string, unknown> };
    if (memory.runtime !== undefined && !object(memory.runtime)) return false;
    memory.runtime ??= {};
    destination = memory.runtime;
    // 两次独立root发布同一深不可变值，RawMemory仍展开完整两本JSON。
    destination[PRIMARY] = sealed;
    destination[MIRROR] = sealed;
    const readback = readStatePair();
    if (readback.read.status === "valid" && readback.token === serialized) return true;
  } catch { /* 只恢复已知baseline，绝不将无效历史当成新session。 */ }
  try {
    if (baseline.status === "valid" && destination !== undefined && runtime() === destination && sealed !== undefined) {
      const before = baselinePair.token;
      const after = serialized;
      if (before === undefined || after === null) return false;
      const known = (raw: unknown) => {
        const token = treasuryContinuousOHDataToken(raw);
        return token !== null && (token === before || token === after);
      };
      const primarySlot = Object.getOwnPropertyDescriptor(destination, PRIMARY);
      const mirrorSlot = Object.getOwnPropertyDescriptor(destination, MIRROR);
      if (primarySlot && mirrorSlot && primarySlot.enumerable && mirrorSlot.enumerable &&
          "value" in primarySlot && "value" in mirrorSlot && known(primarySlot.value) && known(mirrorSlot.value)) {
        destination[PRIMARY] = JSON.parse(before);
        destination[MIRROR] = JSON.parse(before);
      }
    }
  } catch { /* 回滚失败保持invalid，原责任不得删除。 */ }
  return false;
}

let clockMemory: Memory | undefined;
const observedClocks = new Map<string, { tick: number; ms: number }>();
function observedClock(state: TreasuryContinuousOHState): { tick: number; ms: number } {
  if (clockMemory !== Memory) { clockMemory = Memory; observedClocks.clear(); }
  return observedClocks.get(state.sessionId) ?? { tick: state.lastObservedAtTick, ms: state.lastObservedAtMs };
}

/** 普通Game对象换tick不抹峰值；reset从durable恢复，不续任何固定截止。 */
export function observeTreasuryContinuousOHClock(state: TreasuryContinuousOHState, tick: number, ms: number): boolean {
  const before = observedClock(state);
  if (!finiteNonNegative(tick) || !finiteNonNegative(ms) || tick < before.tick || ms < before.ms ||
      tick < state.lastObservedAtTick || ms < state.lastObservedAtMs) return false;
  observedClocks.set(state.sessionId, { tick, ms });
  while (observedClocks.size > 4) observedClocks.delete(observedClocks.keys().next().value!);
  return true;
}

export function treasuryContinuousOHStatePayload(state: TreasuryContinuousOHState): TreasuryContinuousOHStatePayload {
  const { hash: _hash, ...payload } = state;
  // 所有产品写均带观察高水位；时钟倒退的停止写保留原高水位，不回退签名历史。
  const ms = Date.now();
  const tick = Game.time;
  const observed = observedClock(state);
  return { ...payload,
    lastObservedAtTick: finiteNonNegative(tick) ? Math.max(tick, state.lastObservedAtTick, observed.tick) : Math.max(state.lastObservedAtTick, observed.tick),
    lastObservedAtMs: finiteNonNegative(ms) ? Math.max(ms, state.lastObservedAtMs, observed.ms) : Math.max(state.lastObservedAtMs, observed.ms),
  };
}
