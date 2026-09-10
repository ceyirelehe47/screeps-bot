/** One fixed real Terminal business adapter. Test/lab only; never registered by
 * the production entry. World effects and transaction records are READ, not
 * manufactured. The existing kernel owns admission, risk and retirement. */
import type { TreasuryActionAdapter, TreasuryActionReconcilerFacts } from "@/runtime/treasury/actionContracts";
import type { TreasuryObservationView } from "@/runtime/treasury/types";
import type { LabExperimentConfig } from "../terminal-transfer/labConfig";
import { readControlRecord, writeControlRecord, confirmAttemptedMark } from "../terminal-transfer/controlRecord";

export const LIVE_TRANSFER_KIND = "lab.treasury-terminal-send";
export const LIVE_TRANSFER_SEMANTICS = "lab.terminal@world-fee-v1";
export const SOURCE_ROOM = "W1N57";
export const TARGET_ROOM = "W10N57";
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
const TEXT = /^[A-Za-z0-9 .:_-]{1,100}$/;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const plain = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error).slice(0, 160);

export interface LiveEndpoint {
  readonly id: string;
  readonly h: number;
  readonly energy: number;
  readonly free: number;
  readonly capacity: number;
  readonly cooldown: number;
}
export interface LiveWorld {
  readonly tick: number;
  readonly source: LiveEndpoint;
  readonly target: LiveEndpoint;
}
export interface LiveTransferArgs {
  readonly experimentId: string;
  readonly shardName: string;
  readonly username: string;
  readonly sourceRoomName: string;
  readonly targetRoomName: string;
  readonly sourceTerminalId: string;
  readonly targetTerminalId: string;
  readonly resourceType: "H";
  readonly amount: 100;
  readonly description: string;
  readonly targetTick: number;
  readonly maxFeeEnergy: number;
  readonly quote: number;
  readonly before: LiveWorld;
}
export interface LiveReconciliation {
  readonly conclusion: "observed_committed" | "still_uncertain";
  readonly reason: string;
  readonly transactionId?: string;
  readonly observedFee?: number;
  readonly quotedFee?: number;
}

export function validateLiveConfig(c: LabExperimentConfig): void {
  if (!plain(c)) throw new Error("invalid config");
  for (const name of ["experimentId", "shardName", "username", "sourceTerminalId", "targetTerminalId"] as const) {
    if (typeof c[name] !== "string" || !ID.test(c[name])) throw new Error("invalid config " + name);
  }
  if (c.experimentId.length > 48 || c.username.length > 32) throw new Error("identity too long");
  if (c.sourceRoomName !== SOURCE_ROOM || c.targetRoomName !== TARGET_ROOM || c.sourceTerminalId === c.targetTerminalId
      || c.resourceType !== "H" || c.amount !== 100) throw new Error("outside fixed 100H route");
  if (typeof c.description !== "string" || !TEXT.test(c.description)) throw new Error("invalid exact description");
  if (!integer(c.targetTick) || c.targetTick < 3 || !integer(c.maxFeeEnergy) || c.maxFeeEnergy < 1) throw new Error("invalid tick/fee cap");
}

/** Require genuine, healthy, owned endpoints. Zero resource means a successful
 * Store query returning zero; absent objects/methods/failed reads never mean zero.
 * This first slice deliberately admits ONLY H+energy contents and no power
 * effects. A broader logistics/production environment needs another contract. */
export function readLiveWorld(c: LabExperimentConfig): LiveWorld {
  validateLiveConfig(c);
  if (Game.shard?.name !== c.shardName || !integer(Game.time)) throw new Error("world identity unreadable/mismatch");
  const endpoint = (side: "source" | "target"): LiveEndpoint => {
    const roomName = c[side === "source" ? "sourceRoomName" : "targetRoomName"];
    const expectedId = c[side === "source" ? "sourceTerminalId" : "targetTerminalId"];
    const room = Game.rooms[roomName], terminal = room?.terminal;
    if (!room || !terminal || terminal.id !== expectedId || terminal.my !== true || terminal.owner?.username !== c.username
        || terminal.isActive() !== true || room.controller?.my !== true || room.controller?.owner?.username !== c.username
        || !integer(room.controller?.level) || room.controller.level < 6) throw new Error(side + " identity/health mismatch");
    if (terminal.effects?.length) throw new Error(side + " power effects outside scope");
    const h = terminal.store.getUsedCapacity("H"), energy = terminal.store.getUsedCapacity("energy");
    const free = terminal.store.getFreeCapacity(), capacity = terminal.store.getCapacity(), used = terminal.store.getUsedCapacity();
    const cooldown = terminal.cooldown;
    if (![h, energy, free, capacity, used, cooldown].every(integer) || h + energy !== used || used + free !== capacity) {
      throw new Error(side + " incomplete/inconsistent H+energy store");
    }
    return { id: String(terminal.id), h, energy, free, capacity, cooldown };
  };
  return { tick: Game.time, source: endpoint("source"), target: endpoint("target") };
}

export function prepareLiveTransfer(c: LabExperimentConfig): LiveTransferArgs {
  const before = readLiveWorld(c);
  if (before.tick !== c.targetTick || before.source.cooldown !== 0) throw new Error("not the sole ready dispatch tick");
  const quote = Game.market.calcTransactionCost(100, SOURCE_ROOM, TARGET_ROOM);
  if (!integer(quote) || quote < 1 || quote !== c.maxFeeEnergy) throw new Error("quote unavailable/differs from this experiment's frozen quotation");
  if (before.source.h < 100 || before.source.energy < quote || before.target.free < 100) throw new Error("insufficient physical resources/capacity");
  return {
    experimentId: c.experimentId, shardName: c.shardName, username: c.username,
    sourceRoomName: SOURCE_ROOM, targetRoomName: TARGET_ROOM,
    sourceTerminalId: c.sourceTerminalId, targetTerminalId: c.targetTerminalId,
    resourceType: "H", amount: 100, description: c.description,
    targetTick: c.targetTick, maxFeeEnergy: c.maxFeeEnergy, quote, before,
  };
}

function asConfig(a: LiveTransferArgs): LabExperimentConfig {
  return { ...a, mode: "single-shot", maxSamples: 32 };
}
function sameConfig(a: LiveTransferArgs, c: LabExperimentConfig): boolean {
  return (["experimentId", "shardName", "username", "sourceRoomName", "targetRoomName", "sourceTerminalId", "targetTerminalId",
    "resourceType", "amount", "description", "targetTick", "maxFeeEnergy"] as const).every(k => a[k] === c[k]);
}
function validEndpoint(e: LiveEndpoint): boolean {
  return plain(e) && typeof e.id === "string" && ID.test(e.id) && [e.h, e.energy, e.free, e.capacity, e.cooldown].every(integer)
    && e.h + e.energy + e.free === e.capacity;
}
export function validateLiveArgs(value: unknown, c?: LabExperimentConfig): string | null {
  try {
    if (!plain(value)) return "args absent";
    const a = value as unknown as LiveTransferArgs;
    validateLiveConfig(asConfig(a));
    if (c && !sameConfig(a, c)) return "args differ from compiled route/identity/budget";
    if (!integer(a.quote) || a.quote < 1 || a.quote > a.maxFeeEnergy || !plain(a.before) || a.before.tick !== a.targetTick
        || !validEndpoint(a.before.source) || !validEndpoint(a.before.target)
        || a.before.source.id !== a.sourceTerminalId || a.before.target.id !== a.targetTerminalId
        || a.before.source.cooldown !== 0 || a.before.source.h < 100 || a.before.source.energy < a.quote || a.before.target.free < 100) return "invalid prepared facts";
    if (encodeLivePayload(a).length > 512) return "durable payload exceeds existing kernel bound";
    return null;
  } catch (error) { return errorText(error); }
}

/** Fixed-order printable payload uses the kernel's EXISTING 512-character
 * field. No JSON quoting, arbitrary history or additional persistent store. */
export function encodeLivePayload(a: LiveTransferArgs): string {
  const end = (e: LiveEndpoint): string => [e.h, e.energy, e.free, e.capacity, e.cooldown].join(",");
  return ["lt1", a.experimentId, a.shardName, a.username, a.sourceRoomName, a.targetRoomName, a.sourceTerminalId,
    a.targetTerminalId, a.resourceType, a.amount, a.description, a.targetTick, a.maxFeeEnergy, a.quote,
    end(a.before.source), end(a.before.target)].join("|");
}
export function decodeLivePayload(raw: unknown): LiveTransferArgs | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const p = raw.split("|");
  if (p.length !== 16 || p[0] !== "lt1") return null;
  const number = (s: string): number => /^(0|[1-9][0-9]*)$/.test(s) && integer(Number(s)) ? Number(s) : NaN;
  const end = (s: string, id: string): LiveEndpoint => {
    const n = s.split(",").map(number);
    if (n.length !== 5) throw new Error("endpoint field count");
    return { id, h: n[0], energy: n[1], free: n[2], capacity: n[3], cooldown: n[4] };
  };
  try {
    const a: LiveTransferArgs = {
      experimentId: p[1], shardName: p[2], username: p[3], sourceRoomName: p[4], targetRoomName: p[5],
      sourceTerminalId: p[6], targetTerminalId: p[7], resourceType: p[8] as "H", amount: number(p[9]) as 100,
      description: p[10], targetTick: number(p[11]), maxFeeEnergy: number(p[12]), quote: number(p[13]),
      before: { tick: number(p[11]), source: end(p[14], p[6]), target: end(p[15], p[7]) },
    };
    return validateLiveArgs(a) === null && encodeLivePayload(a) === raw ? a : null;
  } catch { return null; }
}
export function livePostings(a: LiveTransferArgs) {
  return [
    { roomName: a.sourceRoomName, locationKind: "terminal", resource: "H", delta: -100 },
    { roomName: a.sourceRoomName, locationKind: "terminal", resource: "energy", delta: -a.quote },
    { roomName: a.targetRoomName, locationKind: "terminal", resource: "H", delta: 100 },
  ];
}
function samePostings(raw: TreasuryActionReconcilerFacts["postings"], a: LiveTransferArgs): boolean {
  const key = (p: { roomName: string; locationKind: string; resource: string; delta: number }): string => [p.roomName, p.locationKind, p.resource, p.delta].join("|");
  return Array.isArray(raw) && raw.length === 3 && raw.map(key).sort().join(";") === livePostings(a).map(key).sort().join(";");
}

function recordKey(r: Record<string, unknown>): string {
  // Include presence of market order, so a send mirror cannot hide a deal.
  return JSON.stringify([r.transactionId, r.time, (r.sender as { username?: string })?.username,
    (r.recipient as { username?: string })?.username, r.from, r.to, r.resourceType, r.amount, r.description,
    r.order === undefined ? "send" : ["order", r.order]]);
}
export function reconcileLiveTransfer(a: LiveTransferArgs, observation: TreasuryObservationView): LiveReconciliation {
  const uncertain = (reason: string): LiveReconciliation => ({ conclusion: "still_uncertain", reason });
  try {
    if (validateLiveArgs(a) !== null) return uncertain("payload_invalid");
    const w = readLiveWorld(asConfig(a));
    if (w.tick <= a.targetTick || !observation || observation.epoch?.observedAtTick !== w.tick) return uncertain("later_observation_required");
    for (const side of ["source", "target"] as const) {
      const e = w[side], room = side === "source" ? a.sourceRoomName : a.targetRoomName;
      const o = observation.location(room, "terminal");
      if (!o?.exists || o.structureId !== e.id || (o.amounts.H ?? 0) !== e.h || (o.amounts.energy ?? 0) !== e.energy
          || o.freeCapacity !== e.free || o.usedCapacity !== e.h + e.energy) return uncertain("world_and_treasury_observation_differ");
    }
    const incoming = Game.market.incomingTransactions as unknown as Record<string, unknown>[];
    const outgoing = Game.market.outgoingTransactions as unknown as Record<string, unknown>[];
    if (!Array.isArray(incoming) || !Array.isArray(outgoing) || incoming.length > 256 || outgoing.length > 256) return uncertain("transactions_unreadable_or_over_bound");
    const all = [...incoming, ...outgoing];
    const related = all.filter(r => plain(r) && r.description === a.description);
    if (!related.length || related.some(r => typeof r.transactionId !== "string" || !ID.test(r.transactionId))) return uncertain("no_unique_transaction");
    const ids = new Set(related.map(r => r.transactionId));
    if (ids.size !== 1) return uncertain("multiple_related_transactions");
    const id = related[0].transactionId as string;
    // Find every copy by ID BEFORE checking completion/route/amount. A
    // contradictory copy must not vanish because it fails the match predicate.
    const copies = all.filter(r => plain(r) && r.transactionId === id);
    if (copies.some(r => recordKey(r) !== recordKey(copies[0]))) return uncertain("conflicting_transaction_mirrors");
    if (!incoming.some(r => plain(r) && r.transactionId === id) || !outgoing.some(r => plain(r) && r.transactionId === id)) return uncertain("both_player_views_required");
    const r = copies[0];
    if (r.time !== a.targetTick || r.description !== a.description || r.from !== a.sourceRoomName || r.to !== a.targetRoomName
        || r.resourceType !== "H" || r.amount !== 100 || r.order !== undefined
        || (r.sender as { username?: string })?.username !== a.username || (r.recipient as { username?: string })?.username !== a.username) return uncertain("transaction_not_exact_full_send");
    const fee = a.before.source.energy - w.source.energy;
    if (!integer(fee) || fee < 1 || fee > a.quote || w.source.h !== a.before.source.h - 100 || w.target.h !== a.before.target.h + 100
        || w.target.energy !== a.before.target.energy || w.source.capacity !== a.before.source.capacity || w.target.capacity !== a.before.target.capacity
        || w.source.free !== a.before.source.free + 100 + fee || w.target.free !== a.before.target.free - 100) return uncertain("world_delta_not_covered_by_admitted_budget");
    return { conclusion: "observed_committed", reason: fee === a.quote ? "exact_transfer_and_fee" : "exact_transfer_with_lower_observed_fee",
      transactionId: id, quotedFee: a.quote, observedFee: fee };
  } catch (error) { return uncertain("read_failed:" + errorText(error)); }
}

export function makeLiveTransferAdapter(config: LabExperimentConfig): TreasuryActionAdapter<LiveTransferArgs, { ok: boolean; code?: number; reason?: string }> {
  validateLiveConfig(config);
  const c = Object.freeze({ ...config });
  return {
    kind: LIVE_TRANSFER_KIND, version: 1, semanticIdentity: LIVE_TRANSFER_SEMANTICS,
    settlesOnAccept: false, nonOkOutcome: "unknown", // no retryFacts: no rearm protocol
    validate: value => validateLiveArgs(value, c),
    derivePostings: livePostings,
    structureBindings: a => [
      { roomName: a.sourceRoomName, locationKind: "terminal", role: "source", objectId: a.sourceTerminalId, expectedType: "terminal", expectedRoom: a.sourceRoomName },
      { roomName: a.sourceRoomName, locationKind: "terminal", role: "fee_source", objectId: a.sourceTerminalId, expectedType: "terminal", expectedRoom: a.sourceRoomName },
      { roomName: a.targetRoomName, locationKind: "terminal", role: "target", objectId: a.targetTerminalId, expectedType: "terminal", expectedRoom: a.targetRoomName },
    ],
    durableFacts: a => ({ version: 1, payload: encodeLivePayload(a) }),
    execute(a) {
      const reject = (reason: string) => {
        console.log(JSON.stringify({ kind: "lab-precondition-rejection", experimentId: c.experimentId, tick: Game.time, reason }));
        return { ok: false, reason };
      };
      if (validateLiveArgs(a, c) !== null) return reject("live_args_mismatch");
      const control = readControlRecord();
      if (control.status !== "ok" || control.record.experimentId !== c.experimentId || !control.record.armed
          || control.record.attempted || control.record.stopped || control.record.attemptedTick !== undefined || control.record.syncResult !== undefined) return reject("live_control_not_pristine_armed");
      let fresh: LiveTransferArgs;
      try { fresh = prepareLiveTransfer(c); } catch (error) { return reject(errorText(error)); }
      if (encodeLivePayload(fresh) !== encodeLivePayload(a)) return reject("live_prepared_facts_changed");
      const attempted = { ...control.record, attempted: true, attemptedTick: Game.time };
      if (!writeControlRecord(attempted).ok || confirmAttemptedMark({ experimentId: c.experimentId, attemptedTick: Game.time }).status !== "confirmed") return reject("live_attempted_mark_unconfirmed");
      console.log(JSON.stringify({ kind: "lab-send-attempt", phase: "pre-call", experimentId: c.experimentId, tick: Game.time, fee: a.quote }));
      console.log(JSON.stringify({ kind: "lab-send-attempt", phase: "boundary", experimentId: c.experimentId, tick: Game.time }));
      let code: ScreepsReturnCode;
      try {
        // The ONLY live API call. Called by kernel.executeAuthorizedDispatch,
        // never by the entry, coordinator, observer or reconciler.
        code = Game.rooms[a.sourceRoomName].terminal!.send("H", 100, a.targetRoomName, a.description);
      } catch (error) {
        writeControlRecord({ ...attempted, stopped: true, syncResult: { ok: false, error: errorText(error) } });
        console.log(JSON.stringify({ kind: "lab-send-attempt", phase: "sync-throw", experimentId: c.experimentId, tick: Game.time, error: errorText(error) }));
        console.log(JSON.stringify({ kind: "lab-treasury-api-error", experimentId: c.experimentId, tick: Game.time, reason: "api_threw" }));
        throw error; // kernel retains unknown; never reverse/clear attempted
      }
      const result = { ok: code === OK, code };
      const persisted = writeControlRecord({ ...attempted, stopped: true, syncResult: result });
      console.log(JSON.stringify({ kind: "lab-send-attempt", phase: "sync-return", experimentId: c.experimentId, tick: Game.time, result }));
      if (!result.ok || !persisted.ok) {
        console.log(JSON.stringify({ kind: "lab-treasury-api-error", experimentId: c.experimentId, tick: Game.time,
          reason: !result.ok ? "api_non_ok" : "result_record_write_failed", result }));
      }
      return result;
    },
    reconcile(facts, observation) {
      const a = decodeLivePayload(facts.durablePayload);
      if (facts.actionKind !== LIVE_TRANSFER_KIND || facts.durablePayloadVersion !== 1 || a === null || !sameConfig(a, c) || !samePostings(facts.postings, a)) return "still_uncertain";
      const result = reconcileLiveTransfer(a, observation as TreasuryObservationView);
      console.log(JSON.stringify({ kind: "lab-treasury-reconcile", experimentId: c.experimentId, tick: Game.time, attemptId: facts.transactionId, ...result }));
      return result.conclusion;
    },
  };
}
