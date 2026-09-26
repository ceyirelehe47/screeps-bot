import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

const RUN_ID = "market-base-egress-r2-2026-09-26";
const PRIMARY = "marketBaseResourceEgressTrialR2";
const MIRROR = "marketBaseResourceEgressTrialR2Mirror";
export const MARKET_EGRESS_R2_MIN_INTERVAL = 100;
export const MARKET_EGRESS_R2_MAX_CALLS = 10;
export const MARKET_EGRESS_R2_MAX_AMOUNT = 10_000;

export interface MarketEgressTrialR2 {
  readonly schemaVersion: 1;
  readonly runId: typeof RUN_ID;
  readonly status: "active" | "closed";
  readonly startedAtTick: number;
  readonly endTick: number;
  readonly startedAtMs: number;
  readonly endMs: number;
  readonly controlUntilMs: number;
  readonly originalNotBefore: number;
  readonly permitId: string;
  readonly permitEpoch: number;
  readonly startAttemptSeq: number;
  readonly lastAttemptSeq: number;
  readonly callsReserved: number;
  readonly amountReserved: number;
  readonly lastReservedAtTick: number;
  readonly closeReason: string;
  readonly hash: string;
}

type TrialPayload = Omit<MarketEgressTrialR2, "hash">;
type TrialRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: MarketEgressTrialR2 };

function runtime(): Record<string, unknown> | undefined {
  return (Memory as unknown as { runtime?: Record<string, unknown> }).runtime;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function trialHash(payload: TrialPayload): string {
  return canonicalStableHashV1({ domain: "market-base-egress-r2:trial-v1", payload });
}

function sealTrial(payload: TrialPayload): MarketEgressTrialR2 {
  return { ...payload, hash: trialHash(payload) };
}

function validTrial(raw: unknown): raw is MarketEgressTrialR2 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const value = raw as MarketEgressTrialR2;
  const keys = Object.keys(value).sort();
  const expected = ["schemaVersion", "runId", "status", "startedAtTick", "endTick",
    "startedAtMs", "endMs", "controlUntilMs", "originalNotBefore", "permitId", "permitEpoch",
    "startAttemptSeq", "lastAttemptSeq", "callsReserved", "amountReserved",
    "lastReservedAtTick", "closeReason", "hash"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  if (value.schemaVersion !== 1 || value.runId !== RUN_ID ||
      (value.status !== "active" && value.status !== "closed") ||
      ![value.startedAtTick, value.endTick, value.startedAtMs, value.endMs,
        value.controlUntilMs,
        value.originalNotBefore, value.permitEpoch, value.startAttemptSeq,
        value.lastAttemptSeq, value.callsReserved, value.amountReserved,
        value.lastReservedAtTick].every(safeInteger) ||
      typeof value.permitId !== "string" || value.permitId.length === 0 ||
      typeof value.closeReason !== "string" || value.closeReason.length > 80 ||
      typeof value.hash !== "string" ||
      value.endTick !== value.startedAtTick + 3_000 ||
      value.endMs !== value.startedAtMs + 60 * 60 * 1_000 ||
      value.controlUntilMs < value.startedAtMs || value.controlUntilMs > value.endMs ||
      value.startAttemptSeq < 1 || value.permitEpoch < 1 ||
      value.callsReserved > MARKET_EGRESS_R2_MAX_CALLS ||
      value.amountReserved !== value.callsReserved * 1_000 ||
      value.lastAttemptSeq < value.startAttemptSeq - 1 ||
      (value.callsReserved === 0 &&
        (value.lastAttemptSeq !== value.startAttemptSeq - 1 ||
         value.lastReservedAtTick !== 0)) ||
      (value.callsReserved > 0 && value.lastReservedAtTick < value.startedAtTick) ||
      (value.status === "active" && value.closeReason !== "") ||
      (value.status === "closed" && value.closeReason === "")) return false;
  const { hash, ...payload } = value;
  return hash === trialHash(payload);
}

export function readMarketEgressTrialR2(): TrialRead {
  const state = runtime();
  const primary = state?.[PRIMARY];
  const mirror = state?.[MIRROR];
  if (primary === undefined && mirror === undefined) return { status: "absent" };
  if (!validTrial(primary) || !validTrial(mirror) || primary.hash !== mirror.hash) {
    return { status: "invalid" };
  }
  return { status: "valid", value: primary };
}

function writeTrial(payload: TrialPayload): boolean {
  try {
    const memory = Memory as unknown as { runtime?: Record<string, unknown> };
    const sealed = sealTrial(payload);
    // Screeps rejects the whole Memory write near 2 MiB. Leave headroom for
    // the rest of this tick's existing ledgers before reserving a native call.
    const currentBytes = JSON.stringify(Memory).length;
    if (currentBytes + JSON.stringify(sealed).length * 2 + 512 > 1_900_000) return false;
    memory.runtime ??= {};
    memory.runtime[PRIMARY] = { ...sealed };
    memory.runtime[MIRROR] = { ...sealed };
    const readback = readMarketEgressTrialR2();
    return readback.status === "valid" && readback.value.hash === sealed.hash;
  } catch {
    return false;
  }
}

export function startMarketEgressTrialR2(input: {
  tick: number;
  permitId: string;
  permitEpoch: number;
  originalNotBefore: number;
  nextAttemptSeq: number;
}): { ok: true; trial: MarketEgressTrialR2 } | { ok: false; reason: string } {
  if (readMarketEgressTrialR2().status !== "absent") {
    return { ok: false, reason: "trial_already_used_or_corrupt" };
  }
  const now = Date.now();
  if (![input.tick, input.permitEpoch, input.originalNotBefore,
        input.nextAttemptSeq, now].every(safeInteger) ||
      input.permitEpoch < 1 || input.nextAttemptSeq < 1 ||
      typeof input.permitId !== "string" || input.permitId.length === 0) {
    return { ok: false, reason: "trial_start_invalid" };
  }
  const payload: TrialPayload = {
    schemaVersion: 1, runId: RUN_ID, status: "active",
    startedAtTick: input.tick, endTick: input.tick + 3_000,
    startedAtMs: now, endMs: now + 60 * 60 * 1_000,
    controlUntilMs: now + 60_000,
    originalNotBefore: input.originalNotBefore,
    permitId: input.permitId, permitEpoch: input.permitEpoch,
    startAttemptSeq: input.nextAttemptSeq,
    lastAttemptSeq: input.nextAttemptSeq - 1,
    callsReserved: 0, amountReserved: 0, lastReservedAtTick: 0,
    closeReason: "",
  };
  if (!writeTrial(payload)) return { ok: false, reason: "trial_persistence_failed" };
  return { ok: true, trial: sealTrial(payload) };
}

export function stopMarketEgressTrialR2(reason: string): boolean {
  const current = readMarketEgressTrialR2();
  if (current.status !== "valid") return false;
  if (current.value.status === "closed") return true;
  const { hash: _hash, ...payload } = current.value;
  return writeTrial({ ...payload, status: "closed", closeReason: reason.slice(0, 80) || "stopped" });
}

/** External observer must refresh this lease; it never extends the trial itself. */
export function heartbeatMarketEgressTrialR2(tick: number): boolean {
  const current = readMarketEgressTrialR2();
  const now = Date.now();
  if (current.status !== "valid" || current.value.status !== "active" ||
      !safeInteger(now) || now < current.value.startedAtMs ||
      now >= current.value.controlUntilMs || now >= current.value.endMs ||
      tick < current.value.startedAtTick || tick >= current.value.endTick) return false;
  const { hash: _hash, ...payload } = current.value;
  return writeTrial({ ...payload,
    controlUntilMs: Math.max(current.value.controlUntilMs,
      Math.min(now + 60_000, current.value.endMs)),
  });
}

export function activeMarketEgressTrialR2(input: {
  tick: number;
  permitId: string;
  permitEpoch: number;
}): MarketEgressTrialR2 | null {
  const current = readMarketEgressTrialR2();
  const now = Date.now();
  if (current.status !== "valid" || current.value.status !== "active" ||
      !safeInteger(now) || now < current.value.startedAtMs ||
      now >= current.value.controlUntilMs ||
      input.tick < current.value.startedAtTick ||
      input.tick >= current.value.endTick || now >= current.value.endMs ||
      current.value.callsReserved >= MARKET_EGRESS_R2_MAX_CALLS ||
      current.value.amountReserved >= MARKET_EGRESS_R2_MAX_AMOUNT ||
      current.value.permitId !== input.permitId ||
      current.value.permitEpoch !== input.permitEpoch) return null;
  return current.value;
}

export function trialLaneEligible(input: {
  roomName: string;
  resource: string;
  stage: string;
  capacityState: string;
  policyCooldownTicks: number;
}): boolean {
  return input.stage === "continuous" && input.policyCooldownTicks === 100 &&
    ((input.roomName === "E4N58" && input.resource === "X") ||
     (input.roomName === "E1N57" && input.resource === "L")) &&
    (input.capacityState === "pressure" || input.capacityState === "emergency");
}

export function trialCooldownNotBefore(
  trial: MarketEgressTrialR2,
  baselineNotBefore: number,
): number {
  return Math.max(trial.originalNotBefore,
    trial.lastReservedAtTick > 0 ? trial.lastReservedAtTick + MARKET_EGRESS_R2_MIN_INTERVAL : 0,
    Math.max(0, baselineNotBefore - (1_000 - MARKET_EGRESS_R2_MIN_INTERVAL)));
}

export function readMarketEgressTrialCapacityState(roomName: string, tick: number): string | null {
  const control = (Memory as unknown as { runtime?: { resourceControl?: {
    updatedAt?: number;
    rooms?: Record<string, { capacityState?: string }>;
  } } }).runtime?.resourceControl;
  if (control?.updatedAt !== tick) return null;
  return control.rooms?.[roomName]?.capacityState ?? null;
}

/** A failed or unknown native result still consumes its reserved call and amount. */
export function reserveMarketEgressTrialNative(input: {
  tick: number;
  permitId: string;
  permitEpoch: number;
  attemptSeq: number;
  pendingEvidenceHash: string;
  roomName: string;
  resource: string;
  stage: string;
  capacityState: string;
  policyCooldownTicks: number;
  amount: number;
  baselineNotBefore: number;
}): boolean {
  const trial = activeMarketEgressTrialR2(input);
  if (!trial || input.amount !== 1_000 ||
      !trialLaneEligible(input) ||
      input.attemptSeq <= trial.lastAttemptSeq ||
      input.attemptSeq < trial.startAttemptSeq ||
      input.tick < trialCooldownNotBefore(trial, input.baselineNotBefore) ||
      trial.amountReserved + input.amount > MARKET_EGRESS_R2_MAX_AMOUNT) return false;
  const canonical = (Memory as unknown as { data?: { marketSaleAutomation?: {
    directAutomation?: { baseResourceV3?: { ledger?: { pending?: {
      attemptSeq?: number; attemptAt?: number; frozenEvidenceHash?: string;
      plannedAmount?: number; executionPolicy?: string;
      historicalPermit?: { permitId?: string };
      historicalLane?: { sellerRoom?: string; resource?: string };
    } } } }
  } } }).data?.marketSaleAutomation?.directAutomation?.baseResourceV3?.ledger?.pending;
  if (!canonical || canonical.attemptSeq !== input.attemptSeq ||
      canonical.attemptAt !== input.tick ||
      canonical.frozenEvidenceHash !== input.pendingEvidenceHash ||
      canonical.plannedAmount !== input.amount ||
      canonical.executionPolicy !== "continuous" ||
      canonical.historicalPermit?.permitId !== input.permitId ||
      canonical.historicalLane?.sellerRoom !== input.roomName ||
      canonical.historicalLane?.resource !== input.resource) return false;
  const { hash: _hash, ...payload } = trial;
  return writeTrial({
    ...payload,
    callsReserved: trial.callsReserved + 1,
    amountReserved: trial.amountReserved + input.amount,
    lastAttemptSeq: input.attemptSeq,
    lastReservedAtTick: input.tick,
  });
}

export function closeExpiredMarketEgressTrialR2(tick: number): void {
  const current = readMarketEgressTrialR2();
  if (current.status !== "valid" || current.value.status !== "active") return;
  const state = current.value;
  const now = Date.now();
  const bothNormal = readMarketEgressTrialCapacityState("E4N58", tick) === "normal" &&
    readMarketEgressTrialCapacityState("E1N57", tick) === "normal";
  const reason = tick >= state.endTick ? "tick_deadline"
    : !safeInteger(now) || now >= state.endMs ? "wall_deadline"
      : now < state.startedAtMs || now >= state.controlUntilMs ? "control_lost"
      : state.callsReserved >= MARKET_EGRESS_R2_MAX_CALLS ? "call_limit"
        : state.amountReserved >= MARKET_EGRESS_R2_MAX_AMOUNT ? "amount_limit"
          : bothNormal ? "capacity_recovered" : "";
  if (reason) stopMarketEgressTrialR2(reason);
}
