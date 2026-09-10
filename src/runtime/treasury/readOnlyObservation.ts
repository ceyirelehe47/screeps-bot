/** Bounded read-only diagnostic, NOT a new Treasury authority or planner.
 * Only primitive previous-sample data lives in this module's heap. A reset may
 * lose diagnostics; no risk/permission/ledger/Memory lifecycle is owned here.
 * Budgets are cooperative: an individual getter/query cannot be preempted. */
import type { TreasuryService } from "@/runtime/treasury/facade";
import type { TreasuryLocationKind } from "@/runtime/treasury/types";

export interface TreasuryReadOnlyConfig {
  readonly enabled: boolean;
  readonly shardName: string;
  readonly rooms: readonly string[];
  readonly resources: readonly string[];
  readonly intervalTicks: number;
  readonly maxSampleCpu: number;
  readonly reserveCpu: number;
  readonly minBucket: number;
  readonly maxLogBytes: number;
}
type ReadService = Pick<TreasuryService, "observation" | "commitments" | "query" | "riskAdjustedFreeCapacity" | "kernelJournal">;
export interface TreasuryReadOnlyPorts {
  getTick(): number;
  getShard(): string;
  cpu(): { used: number; tickLimit: number; bucket: number };
  getRoom(name: string): Room | undefined;
  getResourceCatalog(): readonly string[];
  getMemory(): unknown;
  getService(): ReadService;
  emit(line: string): void;
}
type Direct = {
  id: string; used: number; free: number; capacity: number; active: boolean;
  cooldown: number | null; amounts: Record<string, number>;
};
type Previous = { tick: number; endpoints: Record<string, Direct> };
const KINDS: readonly TreasuryLocationKind[] = ["storage", "terminal"];
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, cap: number): v is string => typeof v === "string" && v.length > 0 && v.length <= cap;
const boundedText = (v: unknown): string => typeof v === "string" ? v.slice(0, 96) : "invalid";
const increment = (v: number): number => Math.min(v + 1, 999999999);

export function validTreasuryReadOnlyConfig(c: TreasuryReadOnlyConfig): boolean {
  return object(c) && typeof c.enabled === "boolean" && text(c.shardName, 32)
    && Array.isArray(c.rooms) && c.rooms.length > 0 && c.rooms.length <= 4
    && c.rooms.every(r => typeof r === "string" && /^[WE]\d{1,3}[NS]\d{1,3}$/.test(r))
    && new Set(c.rooms).size === c.rooms.length
    && Array.isArray(c.resources) && c.resources.length > 0 && c.resources.length <= 4
    && c.resources.every(r => typeof r === "string" && /^[A-Za-z0-9_]{1,32}$/.test(r))
    && new Set(c.resources).size === c.resources.length
    && integer(c.intervalTicks) && c.intervalTicks >= 20 && c.intervalTicks <= 10000
    && finite(c.maxSampleCpu) && c.maxSampleCpu > 0 && c.maxSampleCpu <= 10
    && finite(c.reserveCpu) && c.reserveCpu >= 1 && c.reserveCpu <= 100
    && integer(c.minBucket) && c.minBucket <= 10000
    && integer(c.maxLogBytes) && c.maxLogBytes >= 1024 && c.maxLogBytes <= 32768;
}

/** Exact UTF-8 count of JSON text; does not require Buffer/TextEncoder in game. */
export function treasuryReadOnlyUtf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { n += 4; i += 1; }
    else n += 3;
  }
  return n;
}

/** A narrow raw read is intentional. getTerminalActionClaims() synchronizes
 * state and may delete an expired persistent claim; it is NOT a read-only port.
 * This existing market journal is incomplete attribution, never send evidence. */
function marketHints(memory: unknown, rooms: readonly string[], tick: number) {
  const absent = () => ({ status: "absent", coverage: "existing_market_journal_only", rows: [] });
  if (!object(memory)) return { status: "unreadable", rows: [] };
  let node: unknown = memory;
  for (const key of ["data", "marketSaleAutomation"]) {
    if (!object(node)) return { status: "unreadable", rows: [] };
    node = node[key];
    if (node === undefined) return absent();
  }
  if (!object(node)) return { status: "unreadable", rows: [] };
  const raw = node.marketActionJournal;
  if (raw === undefined) return absent();
  if (!Array.isArray(raw)) return { status: "unreadable", rows: [] };
  if (raw.length > 100) return { status: "over_bound", rows: [] };
  const rows: Record<string, unknown>[] = [];
  let relevant = 0;
  for (const r of raw) {
    if (!object(r) || !integer(r.tick) || r.tick > tick || !text(r.actor, 256)
        || !text(r.id, 512) || !text(r.kind, 64) || !text(r.outcome, 64)
        || (r.roomName !== undefined && !text(r.roomName, 16))) return { status: "unreadable", rows: [] };
    if (r.roomName !== undefined && !rooms.includes(r.roomName as string)) continue;
    relevant += 1;
    // Retain newest observed entries only; no claim of a complete event stream.
    rows.push({ tick: r.tick, actor: boundedText(r.actor), kind: r.kind, outcome: r.outcome,
      room: r.roomName ?? null, actorTruncated: r.actor.length > 96 });
  }
  rows.sort((a, b) => (b.tick as number) - (a.tick as number));
  return { status: "ok", coverage: "existing_market_journal_only", recordedCount: raw.length,
    relevantCount: relevant, omittedCount: Math.max(0, relevant - 8), rows: rows.slice(0, 8) };
}

function directEndpoint(room: Room | undefined, kind: TreasuryLocationKind, resources: readonly string[]):
  { status: string; value?: Direct } {
  try {
    if (!room) return { status: "not_visible" };
    if (room.controller?.my !== true) return { status: "not_owned" };
    const s = room[kind];
    if (!s) return { status: "absent" };
    if (s.my !== true || !text(s.id, 96) || !s.store || typeof s.isActive !== "function") return { status: "unreadable" };
    const used = s.store.getUsedCapacity(), free = s.store.getFreeCapacity(), capacity = s.store.getCapacity();
    const active = s.isActive();
    const cooldown = kind === "terminal" ? (s as StructureTerminal).cooldown : null;
    if (!integer(used) || !integer(free) || !integer(capacity) || used + free !== capacity
        || typeof active !== "boolean" || (kind === "terminal" && !integer(cooldown))) return { status: "unreadable" };
    const amounts: Record<string, number> = Object.create(null);
    for (const r of resources) {
      const n = s.store.getUsedCapacity(r as ResourceConstant);
      if (!integer(n) || n > used) return { status: "unreadable" };
      amounts[r] = n;
    }
    if (Object.values(amounts).reduce((a, b) => a + b, 0) > used) return { status: "unreadable" };
    return { status: "ok", value: { id: s.id, used, free, capacity, active, cooldown, amounts } };
  } catch { return { status: "unreadable" }; }
}

function changes(previous: Previous | undefined, key: string, current: Direct, tick: number, interval: number) {
  const old = previous?.endpoints[key];
  if (!previous || !old) return { status: "no_comparable_previous_sample" };
  if (tick <= previous.tick || tick - previous.tick > interval * 3) return { status: "gap_not_comparable" };
  if (old.id !== current.id || old.capacity !== current.capacity) return { status: "endpoint_changed" };
  return { status: "net_change_unattributed", fromTick: previous.tick, toTick: tick,
    amounts: Object.fromEntries(Object.keys(current.amounts).map(r => [r, current.amounts[r] - old.amounts[r]])),
    used: current.used - old.used, free: current.free - old.free };
}

export function createTreasuryReadOnlyObserver(input: TreasuryReadOnlyConfig, ports: TreasuryReadOnlyPorts) {
  // Freeze only the bounded, validated profile. The caller cannot change scope
  // midway through a heap lifetime and silently reuse an incompatible baseline.
  let config = input, enabled = false, invalidSetup = false;
  try {
    enabled = input.enabled === true;
    if (enabled) {
      invalidSetup = !validTreasuryReadOnlyConfig(input);
      if (!invalidSetup) config = Object.freeze({ enabled: true, shardName: input.shardName,
        rooms: Object.freeze([...input.rooms]), resources: Object.freeze([...input.resources]),
        intervalTicks: input.intervalTicks, maxSampleCpu: input.maxSampleCpu, reserveCpu: input.reserveCpu,
        minBucket: input.minBucket, maxLogBytes: input.maxLogBytes });
    }
  } catch { invalidSetup = true; }
  let lastAttemptTick: number | undefined, previous: Previous | undefined;
  let previousRun: { tick: number; totalCpuIncludingEmit: number; emittedBytes: number; retainedPrimitiveChars: number } | null = null;
  let disabledByFault = false, emitted = 0, cpuSkips = 0;
  const stats = () => ({ disabledByFault, emitted, cpuSkips, lastAttemptTick: lastAttemptTick ?? null,
    retainedEndpoints: previous ? Object.keys(previous.endpoints).length : 0, previousRun: previousRun ? { ...previousRun } : null });

  function run(): { status: string } {
    let tick: number | undefined;
    try {
      if (invalidSetup) { disabledByFault = true; return { status: "invalid_config" }; }
      if (!enabled) return { status: "disabled" };
      if (disabledByFault) return { status: "disabled_after_fault" };
      tick = ports.getTick();
      if (!integer(tick)) throw new Error("invalid tick");
      if (tick % config.intervalTicks !== 0 || lastAttemptTick === tick) return { status: "not_due" };
      lastAttemptTick = tick; // before any expensive or fallible read; no same-tick retries
      if (ports.getShard() !== config.shardName) return { status: "wrong_shard" };
      const catalog = ports.getResourceCatalog();
      if (!config.resources.every(r => catalog.includes(r))) { disabledByFault = true; return { status: "invalid_resource" }; }
      const start = ports.cpu();
      const validCpu = (c: ReturnType<TreasuryReadOnlyPorts["cpu"]>) => finite(c.used) && finite(c.tickLimit) && integer(c.bucket);
      if (!validCpu(start)) throw new Error("invalid CPU observation");
      if (start.bucket < config.minBucket || start.tickLimit - start.used < config.reserveCpu + config.maxSampleCpu) {
        cpuSkips = increment(cpuSkips); return { status: "cpu_skipped" };
      }
      let latestCpu = start.used;
      const withinBudget = () => {
        const c = ports.cpu();
        if (!validCpu(c) || c.used < latestCpu) throw new Error("invalid CPU progression");
        latestCpu = c.used;
        return c.used - start.used < config.maxSampleCpu && c.tickLimit - c.used >= config.reserveCpu && c.bucket >= config.minBucket;
      };
      const service = ports.getService();
      if (!withinBudget()) { cpuSkips = increment(cpuSkips); return { status: "cpu_skipped_after_service" }; }
      const observation = service.observation();
      const fresh = observation.epoch.observedAtTick === tick && !observation.isStale();
      const endpoints: Record<string, unknown>[] = [];
      const selectedCommitments: Record<string, unknown>[] = [];
      const nextPrevious: Previous = { tick, endpoints: Object.create(null) };
      let limited = false;
      const report: Record<string, unknown> = {
        kind: "treasury-read-only", tick, shard: config.shardName,
        scope: { rooms: [...config.rooms], resources: [...config.resources], locations: [...KINDS], isEmpireTotal: false },
        authorizesActions: false, queryWithhold: 0, strategyPolicyEvaluated: false,
        storageMode: "heap_only", observationTick: observation.epoch.observedAtTick,
        observationStatus: fresh ? "current_tick" : "stale", endpoints, selectedCommitments,
        writerAttribution: "incomplete; net changes and journal hints are not action receipts",
        previousRun,
      };
      // Existing indexes are the authority. No duplicate ledger and no raw task
      // enumeration/normalizer/expiry cleanup in this observer.
      let index: ReturnType<ReadService["commitments"]> | undefined;
      if (fresh && withinBudget()) {
        index = service.commitments();
        report.globalCommitmentIndex = { builtAtTick: index.builtAtTick, revision: index.revision,
          completeness: { ...index.completeness }, metrics: { ...index.metrics } };
      }
      outer: for (const roomName of config.rooms) {
        for (const kind of KINDS) {
          if (!withinBudget()) { limited = true; break outer; }
          const row: Record<string, unknown> = { room: roomName, location: kind };
          endpoints.push(row);
          const direct = directEndpoint(ports.getRoom(roomName), kind, config.resources);
          row.directStatus = direct.status;
          if (!fresh) { row.comparison = "unavailable_stale_observation"; continue; }
          if (direct.status !== "ok" && direct.status !== "absent") { row.comparison = "unavailable_direct_read"; continue; }
          const governed = observation.hasRoom(roomName);
          if (!governed) { row.comparison = "outside_treasury_coverage"; continue; }
          const observed = observation.location(roomName, kind);
          if (direct.status === "absent") { row.comparison = observed.exists ? "existence_mismatch" : "both_absent"; continue; }
          if (!direct.value) { row.comparison = "unavailable_direct_read"; continue; }
          const d = direct.value, key = roomName + ":" + kind;
          row.direct = d;
          nextPrevious.endpoints[key] = d;
          row.changeSinceSample = changes(previous, key, d, tick, config.intervalTicks);
          const mismatch: string[] = [];
          if (!observed.exists || observed.structureId !== d.id) mismatch.push("structure");
          if (observed.usedCapacity !== d.used) mismatch.push("usedCapacity");
          if (observed.freeCapacity !== d.free) mismatch.push("freeCapacity");
          for (const r of config.resources) if ((observed.amounts[r] ?? 0) !== d.amounts[r]) mismatch.push(r);
          row.comparison = mismatch.length ? "mismatch" : "match_selected_scope";
          row.mismatches = mismatch;
          const balances: Record<string, unknown> = Object.create(null);
          row.balances = balances;
          for (const resource of config.resources) {
            if (!withinBudget()) { row.balanceStatus = "cpu_limited"; limited = true; break outer; }
            const q = service.query({ resource, rooms: [roomName], locations: [kind], allowProjected: false,
              allowIncoming: false, subtractOutgoing: true, subtractReservations: true, withhold: 0 });
            if (![q.observed, q.committed, q.incoming, q.spendable].every(integer)
                || q.epoch.observedAtTick !== tick || typeof q.authorizationSafe !== "boolean"
                || !Array.isArray(q.authorizationBlockers) || !Array.isArray(q.writeAdmission.blockers)) throw new Error("invalid query result");
            balances[resource] = { observed: q.observed, committed: q.committed, incoming: q.incoming, spendable: q.spendable,
              contextStatus: q.contextStatus, commitmentStatus: q.commitmentStatus, authorizationSafe: q.authorizationSafe,
              blockers: q.authorizationBlockers.slice(0, 8).map(boundedText), blockersTruncated: q.authorizationBlockers.length > 8,
              writeReady: q.writeAdmission.ready, writeBlockers: q.writeAdmission.blockers.slice(0, 8).map(boundedText),
              writeBlockersTruncated: q.writeAdmission.blockers.length > 8 };
          }
          if (!withinBudget()) { limited = true; break outer; }
          row.riskAdjustedFreeCapacity = service.riskAdjustedFreeCapacity(roomName, kind);
          if (!finite(row.riskAdjustedFreeCapacity)) throw new Error("invalid capacity query");
        }
        if (index && observation.hasRoom(roomName)) {
          for (const resource of config.resources) {
            if (!withinBudget()) { limited = true; break outer; }
            selectedCommitments.push({ room: roomName, resource, scope: "room_not_endpoint", completeness: index.commitmentCompleteness(roomName, resource),
              outgoing: index.outgoing(roomName, resource), incoming: index.incoming(roomName, resource),
              productionReserved: index.reservedProduction(roomName, resource) });
          }
        }
      }
      if (withinBudget()) {
        const j = service.kernelJournal();
        const readable = j.health.status === "healthy" || j.health.status === "absent";
        report.kernel = { health: { ...j.health }, scope: "global_kernel_only",
          legacyStores: Array.isArray(j.legacyStores) ? j.legacyStores.slice(0, 8).map(boundedText) : null,
          legacyStoresTruncated: Array.isArray(j.legacyStores) && j.legacyStores.length > 8, activeCount: readable ? j.active.length : null,
          ringCount: readable && j.health.ringDegraded === null ? j.ring.length : null,
          phases: readable ? j.active.reduce((m, r) => { m[r.phase] = (m[r.phase] ?? 0) + 1; return m; }, {} as Record<string, number>) : null };
      } else { limited = true; report.kernel = { status: "not_read_cpu_budget" }; }
      if (withinBudget()) report.marketHints = marketHints(ports.getMemory(), config.rooms, tick);
      else { limited = true; report.marketHints = { status: "not_read_cpu_budget" }; }
      report.status = limited ? "partial_cpu_budget" : "sampled";
      report.collectedEndpointRows = endpoints.length;
      report.requestedEndpointRows = config.rooms.length * KINDS.length;
      report.cooperativeCpuBudgetExceeded = !withinBudget(); // individual calls/emit cannot be preempted
      report.cpuBeforeSerializationAndEmit = latestCpu - start.used;
      // Hard output bound. An omitted report is not silently converted to a
      // healthy/empty report, and partial text is never emitted as broken JSON.
      let resultStatus = report.status as string;
      let line = JSON.stringify(report);
      if (treasuryReadOnlyUtf8Bytes(line) > config.maxLogBytes) {
        resultStatus = "output_limited";
        line = JSON.stringify({ kind: "treasury-read-only", tick, shard: config.shardName, status: "output_limited",
          authorizesActions: false, requestedEndpointRows: config.rooms.length * KINDS.length, previousRun });
      }
      ports.emit(line);
      const emittedBytes = treasuryReadOnlyUtf8Bytes(line);
      const retainedPrimitiveChars = resultStatus === "output_limited" ? 0 : JSON.stringify(nextPrevious).length;
      const end = ports.cpu();
      if (!validCpu(end) || end.used < latestCpu) throw new Error("invalid ending CPU");
      // An omitted payload is NOT a published baseline for later net deltas.
      previous = resultStatus === "output_limited" ? undefined : nextPrevious;
      previousRun = { tick, totalCpuIncludingEmit: end.used - start.used, emittedBytes, retainedPrimitiveChars };
      emitted = increment(emitted);
      return { status: resultStatus };
    } catch {
      disabledByFault = true; previous = undefined;
      // At most one bounded failure line per heap lifetime; even a throwing
      // logger is contained. Never invoke a Treasury mutation to "recover".
      try { ports.emit(JSON.stringify({ kind: "treasury-read-only", tick: integer(tick) ? tick : null, status: "disabled_after_read_or_output_error", authorizesActions: false })); } catch { /* logging cannot stop the bot */ }
      return { status: "fault_disabled" };
    }
  }
  return { run, stats };
}
