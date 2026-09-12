/** Read compatibility preview for the old production bot, not a Treasury host.
 * Reuses pinned production observation/commitment builders. Never computes a
 * spendable balance, signs a permit, migrates a store or advances world sequence.
 * One endpoint snapshot and one bounded CPU profile are retained. Reader caches
 * remain per sample; diagnostic profiles never contain a linked history.
 */
import type { CompatConfig, CompatPorts, CompatObservation } from "./treasuryCompatTypes";
import { createCompatCpuAccounting, type CompatCpuPhase, type CompatCpuProfile } from "./treasuryCompatCpu";

type Rec = Record<string, unknown>;
type Kind = "storage" | "terminal";
const KINDS: readonly Kind[] = ["storage", "terminal"];
const TABLE_LIMIT = 256;
const sat = (n: number) => Math.min(n + 1, 999999999);
const obj = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const nonneg = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const own = (x: Rec, k: string) => Object.prototype.hasOwnProperty.call(x, k);
const str = (x: unknown, n: number): x is string => typeof x === "string" && x.length > 0 && x.length <= n;

export function validCompatConfig(c: CompatConfig): boolean {
  return obj(c) && typeof c.enabled === "boolean" && str(c.shardName, 32)
    && Array.isArray(c.rooms) && c.rooms.length > 0 && c.rooms.length <= 2
    && c.rooms.every(r => typeof r === "string" && /^[WE]\d{1,3}[NS]\d{1,3}$/.test(r))
    && new Set(c.rooms).size === c.rooms.length
    && Array.isArray(c.resources) && c.resources.length > 0 && c.resources.length <= 4
    && c.resources.every(r => typeof r === "string" && /^[A-Za-z0-9_]{1,32}$/.test(r))
    && new Set(c.resources).size === c.resources.length
    && nonneg(c.startTick) && nonneg(c.endTick) && c.endTick > c.startTick
    && c.endTick - c.startTick <= 1200
    && nonneg(c.intervalTicks) && c.intervalTicks >= 20 && c.intervalTicks <= 1000
    && Math.ceil(c.startTick / c.intervalTicks) * c.intervalTicks <= c.endTick
    && nonneg(c.minBucket) && c.minBucket <= 10000
    && finite(c.maxSampleCpu) && c.maxSampleCpu > 0 && c.maxSampleCpu <= 10
    && finite(c.reserveCpu) && c.reserveCpu >= 1 && c.reserveCpu <= 100
    && nonneg(c.maxLogBytes) && c.maxLogBytes >= 1024 && c.maxLogBytes <= 16384;
}
export function compatUtf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const a = s.charCodeAt(i);
    if (a < 128) n++;
    else if (a < 2048) n += 2;
    else if (a >= 0xd800 && a <= 0xdbff && i + 1 < s.length
      && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
/** Own-property path read. Missing, null, array, damaged parents and empty object
 * remain distinct. No ensure()/normalizer or getter invocation on table entries. */
function pathValue(root: unknown, path: readonly string[]): { status: string; value?: unknown } {
  let p = root;
  for (const key of path) {
    if (!obj(p)) return { status: "invalid_parent" };
    if (!own(p, key)) return { status: "absent" };
    const desc = Object.getOwnPropertyDescriptor(p, key);
    if (!desc || !("value" in desc)) return { status: "accessor_unreadable" };
    p = desc.value;
  }
  return { status: "present", value: p };
}
function table(root: unknown, path: readonly string[]) {
  const found = pathValue(root, path);
  if (found.status !== "present") return { status: found.status, count: null, value: undefined };
  if (!obj(found.value)) return { status: "invalid_container", count: null, value: undefined };
  // Stop enumeration at bound+1. Never aggregate a selected prefix as the table.
  let count = 0;
  for (const key in found.value) {
    if (!own(found.value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(found.value, key);
    if (!descriptor || !("value" in descriptor)) return { status: "accessor_unreadable", count: null, value: undefined };
    if (++count > TABLE_LIMIT) return { status: "over_bound", count: null, value: undefined };
  }
  return { status: count === 0 ? "empty" : "nonempty", count, value: found.value };
}
function summary(s: { status: string; count: number | null }) { return { status: s.status, count: s.count }; }
type Direct = { id: string; used: number; free: number; capacity: number;
  overCapacity: boolean; active: boolean; cooldown: number | null; amounts: Record<string, number> };
function direct(room: Room | undefined, kind: Kind, resources: readonly string[]): { status: string; value?: Direct } {
  try {
    if (!room) return { status: "not_visible" };
    if (room.controller?.my !== true) return { status: "not_owned" };
    const s = room[kind];
    if (!s) return { status: "absent" };
    if (s.my !== true || !str(s.id, 96) || !s.store || typeof s.isActive !== "function") return { status: "unreadable" };
    const used = s.store.getUsedCapacity(), free = s.store.getFreeCapacity(), capacity = s.store.getCapacity();
    const active = s.isActive(), cooldown = kind === "terminal" ? (s as StructureTerminal).cooldown : null;
    // Capacity reduction may leave inventory above capacity. Preserve signed
    // free or a saturated zero, rather than inventing capacity=used+free.
    if (!nonneg(used) || !nonneg(capacity) || !Number.isSafeInteger(free)
      || !(used + free === capacity || (used > capacity && free === 0))
      || typeof active !== "boolean" || (kind === "terminal" && !nonneg(cooldown))) return { status: "unreadable" };
    const amounts: Record<string, number> = Object.create(null);
    for (const r of resources) {
      const a = s.store.getUsedCapacity(r as ResourceConstant);
      if (!nonneg(a) || a > used) return { status: "unreadable" };
      amounts[r] = a;
    }
    if (Object.values(amounts).reduce((a, b) => a + b, 0) > used) return { status: "unreadable" };
    return { status: "ok", value: { id: s.id, used, free, capacity, overCapacity: used > capacity,
      active, cooldown, amounts } };
  } catch { return { status: "unreadable" }; }
}
function legacyProjection(memory: unknown, room: string, kind: Kind, d: Direct, tick: number) {
  const raw = pathValue(memory, ["runtime", "resourceControl"]);
  if (raw.status !== "present") return { status: raw.status };
  if (!obj(raw.value) || !nonneg(raw.value.updatedAt)) return { status: "unreadable" };
  if (raw.value.updatedAt !== tick) return { status: raw.value.updatedAt > tick ? "future_tick" : "stale",
    updatedAt: raw.value.updatedAt, comparisonPerformed: false };
  const row = pathValue(raw.value, ["rooms", room]);
  if (row.status !== "present") return { status: row.status, comparisonPerformed: false };
  if (!obj(row.value)) return { status: "unreadable" };
  const fields: Record<string, number> = { [kind + "UsedCapacity"]: d.used, [kind + "FreeCapacity"]: d.free };
  if (own(d.amounts, "energy")) fields[kind + "Energy"] = d.amounts.energy;
  const mismatches: string[] = [];
  for (const key of Object.keys(fields)) {
    if (!Number.isSafeInteger(row.value[key])) return { status: "unreadable", comparisonPerformed: false };
    if (row.value[key] !== fields[key]) mismatches.push(key);
  }
  return { status: mismatches.length ? "mismatch" : "match_capacity_and_selected_energy",
    updatedAt: raw.value.updatedAt, comparisonPerformed: true, mismatches };
}

type Previous = { tick: number; endpoints: Record<string, Direct> };
export function createTreasuryCompatPreview(input: CompatConfig, ports: CompatPorts,
  options: { cpuDiagnostics?: boolean } = {}) {
  const cpuDiagnostics = options?.cpuDiagnostics === true;
  let sampleOrdinal = 0, previousCpuProfile: CompatCpuProfile | null = null;
  let cfg = input, enabled = false, invalid = false;
  try {
    enabled = input.enabled === true;
    if (enabled) {
      invalid = !validCompatConfig(input);
      if (!invalid) cfg = Object.freeze({ ...input, rooms: Object.freeze([...input.rooms]), resources: Object.freeze([...input.resources]) });
    }
  } catch { invalid = true; }
  let fault = false, lastTick: number | undefined, previous: Previous | undefined;
  let emitted = 0, cpuSkips = 0;
  let previousRun: { tick: number; cpuIncludingEmit: number; emittedBytes: number; retainedPrimitiveChars: number } | null = null;
  function run(): { status: string } {
    let tick: number | undefined;
    let accounting: ReturnType<typeof createCompatCpuAccounting> | undefined;
    try {
      if (invalid) { fault = true; return { status: "invalid_config" }; }
      if (!enabled) return { status: "disabled" };
      if (fault) return { status: "disabled_after_fault" };
      tick = ports.tick();
      if (!nonneg(tick)) throw new Error("invalid tick");
      if (tick < cfg.startTick || tick > cfg.endTick) { previous = undefined; return { status: "outside_window" }; }
      if (tick % cfg.intervalTicks !== 0 || tick === lastTick) return { status: "not_due" };
      lastTick = tick;
      if (ports.shard() !== cfg.shardName) return { status: "wrong_shard" };
      if (!cfg.resources.every(r => ports.resources().includes(r))) throw new Error("invalid resource");
      const start = ports.cpu();
      const validCpu = (c: ReturnType<CompatPorts["cpu"]>) => finite(c.used) && finite(c.tickLimit) && nonneg(c.bucket);
      if (!validCpu(start)) throw new Error("invalid CPU");
      if (start.bucket < cfg.minBucket || start.tickLimit - start.used < cfg.maxSampleCpu + cfg.reserveCpu) {
        cpuSkips = sat(cpuSkips); return { status: "cpu_skipped" };
      }
      sampleOrdinal = sat(sampleOrdinal);
      if (cpuDiagnostics) accounting = createCompatCpuAccounting(start.used, tick, sampleOrdinal);
      let latestCpu = start.used;
      const budget = (next?: CompatCpuPhase) => {
        const c = ports.cpu();
        if (!validCpu(c) || c.used < latestCpu) throw new Error("invalid CPU progression");
        accounting?.checkpoint(c.used, next);
        latestCpu = c.used;
        return c.used - start.used < cfg.maxSampleCpu && c.tickLimit - c.used >= cfg.reserveCpu && c.bucket >= cfg.minBucket;
      };
      const memory = ports.memory();
      const tasks = table(memory, ["data", "resourceControl", "tasks"]);
      const reservations = table(memory, ["runtime", "resourceReservations"]);
      const marker = pathValue(memory, ["runtime", "resourceReservationsOwnerVersion"]);
      const existingCore = pathValue(memory, ["runtime", "treasuryCore"]);
      const report: Rec = { kind: "treasury-legacy-read-bridge", tick, shard: cfg.shardName,
        sourceCommit: "01bd9831454950c4928df98dd8679692b55603e5", productionBase: "06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c",
        authorizesActions: false, scope: { rooms: [...cfg.rooms], resources: [...cfg.resources], isEmpireTotal: false },
        evaluation: "observation_and_legacy_commitments_only", facadeQueryRun: false,
        spendable: null, kernelLifecycleRun: false, storageMode: "heap_only", previousRun,
        legacyInputs: { tasks: summary(tasks), reservations: summary(reservations),
          reservationVersion: { status: marker.status, value: nonneg(marker.value) ? marker.value : null },
          treasuryCore: { status: existingCore.status === "present" ? "present_not_interpreted" : existingCore.status, activeCount: null } },
      };
      const rows: Rec[] = []; report.endpoints = rows;
      const validRooms: Room[] = [];
      const next: Previous = { tick, endpoints: Object.create(null) };
      let limited = false, observations: CompatObservation | undefined;
      for (const name of cfg.rooms) {
        if (!budget("directRead")) { limited = true; break; }
        const room = ports.room(name);
        let safe = true;
        for (const kind of KINDS) {
          if (!budget()) { limited = true; safe = false; break; }
          const d = direct(room, kind, cfg.resources);
          const row: Rec = { room: name, location: kind, directStatus: d.status };
          rows.push(row);
          if (d.status !== "ok" && d.status !== "absent") safe = false;
          if (d.value) {
            row.direct = d.value;
            row.legacyProjection = legacyProjection(memory, name, kind, d.value, tick);
            const key = name + ":" + kind, old = previous?.endpoints[key];
            next.endpoints[key] = d.value;
            if (!old || !previous) row.change = { status: "no_comparable_previous_sample" };
            else if (old.id !== d.value.id || old.capacity !== d.value.capacity) row.change = { status: "endpoint_or_capacity_changed" };
            else if (tick <= previous.tick || tick - previous.tick > cfg.intervalTicks * 3) row.change = { status: "gap_not_comparable" };
            else row.change = { status: "net_change_unattributed", fromTick: previous.tick, toTick: tick,
              amounts: Object.fromEntries(cfg.resources.map(r => [r, d.value!.amounts[r] - old.amounts[r]])) };
          }
        }
        if (safe && room && room.controller?.my === true) validRooms.push(room);
      }
      // Build from actual Game room objects, NOT from the just-produced direct
      // numbers or legacy Memory projection. Independently enumerates Store keys.
      let readers: ReturnType<CompatPorts["readers"]> | undefined;
      if (validRooms.length && budget("readerLoad")) {
        accounting?.invoked("readerLoad");
        readers = ports.readers();
        if (budget("observationBuild")) {
          accounting?.invoked("observationBuild");
          observations = readers.buildObservation({ scope: "market-fresh", epochSeq: 1, rooms: validRooms });
        } else limited = true;
      } else if (!budget()) limited = true;
      // Diagnostic-only extra checkpoint: its cost is NOT removed from budget.
      if (accounting && !budget("coreCompare")) limited = true;
      if (observations && observations.epoch.observedAtTick !== tick) throw new Error("stale builder");
      const included = new Set(validRooms.map(r => r.name));
      for (const row of rows) {
        if (!observations || !included.has(row.room as string)) { row.coreComparison = "not_read"; continue; }
        const o = observations.location(row.room as string, row.location as Kind), d = row.direct as Direct | undefined;
        if (!d) { row.coreComparison = row.directStatus === "absent" && !o.exists ? "both_absent" : "existence_mismatch"; continue; }
        const mismatch: string[] = [];
        if (!o.exists || o.structureId !== d.id) mismatch.push("structure");
        if (o.usedCapacity !== d.used) mismatch.push("usedCapacity");
        if (o.freeCapacity !== d.free) mismatch.push("freeCapacity");
        for (const r of cfg.resources) if ((o.amounts[r] ?? 0) !== d.amounts[r]) mismatch.push(r);
        row.coreComparison = mismatch.length ? "mismatch" : "match_selected_scope";
        row.coreMismatches = mismatch;
      }
      report.commitments = { status: "not_read", rows: null };
      // Never manufacture empty inputs from missing/damaged/over-bound tables.
      if (!tasks.value || !reservations.value) report.commitments = { status: "unavailable_legacy_input", rows: null };
      else if (readers && observations && budget("commitmentBuild")) {
        accounting?.invoked("commitmentBuild");
        const index = readers.buildCommitments({ tick, tasks: tasks.value, reservations: reservations.value, observation: observations });
        const fields: Rec[] = [];
        for (const name of validRooms.map(r => r.name)) for (const resource of cfg.resources) {
          if (!budget("commitmentProjection")) { limited = true; break; }
          const outgoing = index.outgoing(name, resource), incoming = index.incoming(name, resource), reserved = index.reservedProduction(name, resource);
          if (![outgoing, incoming, reserved].every(nonneg)) throw new Error("invalid index numbers");
          fields.push({ room: name, resource, scope: "room_not_endpoint", outgoing, incoming,
            productionReserved: reserved, completeness: index.commitmentCompleteness(name, resource) });
        }
        const c = index.completeness;
        if (!c || typeof c.complete !== "boolean" || typeof c.globalIncomplete !== "boolean"
          || !nonneg(c.invalidRecords) || !nonneg(c.incompleteScopeCount)) throw new Error("invalid index health");
        report.commitments = { status: limited ? "partial_cpu_budget" : c.complete ? "read_complete" : "read_incomplete",
          rows: fields, completeness: { ...c }, allTableScan: true, tableLimitEach: TABLE_LIMIT };
      } else if (!budget()) { limited = true; report.commitments = { status: "not_read_cpu_budget", rows: null }; }
      if (!budget("report")) limited = true;
      report.status = limited ? "partial_cpu_budget" : "sampled";
      report.coreObservationRooms = validRooms.filter(() => !!observations).map(r => r.name);
      report.requestedEndpointRows = cfg.rooms.length * 2;
      report.collectedEndpointRows = rows.length;
      if (accounting && !budget("serializationAndSize")) report.status = "partial_cpu_budget";
      report.cpuBeforeSerializationAndEmit = latestCpu - start.used;
      if (accounting) {
        // Prefix of THIS sample. Serialization/emit are not known yet. The full
        // completed measurement is published only by the NEXT emitted sample.
        report.cpuProfile = accounting.snapshot("beforeSerialization");
        report.previousCpuProfile = previousCpuProfile;
      }
      report.cooperativeBudget = true;
      let line = JSON.stringify(report), status = report.status as string;
      // One UTF-8 traversal per distinct output string. Reuse the size after
      // emit instead of rescanning the identical (immutable) string.
      let emittedBytes = compatUtf8Bytes(line);
      if (emittedBytes > cfg.maxLogBytes) {
        status = "output_limited";
        line = JSON.stringify({ kind: "treasury-legacy-read-bridge", tick, status,
          authorizesActions: false, previousRun });
        emittedBytes = compatUtf8Bytes(line);
      }
      // Post-serialization sampling cannot retroactively change this report.
      // The following sample carries the measured total, even when over budget.
      if (accounting) budget("emit");
      ports.emit(line);
      const end = ports.cpu();
      if (!validCpu(end) || end.used < latestCpu) throw new Error("invalid ending CPU");
      accounting?.checkpoint(end.used, "retention");
      latestCpu = end.used;
      previous = status === "output_limited" ? undefined : next;
      previousRun = { tick, cpuIncludingEmit: end.used - start.used, emittedBytes,
        retainedPrimitiveChars: previous ? JSON.stringify(previous).length : 0 };
      emitted = sat(emitted);
      if (accounting) {
        // Includes previous-snapshot sizing/bookkeeping. The final snapshot
        // copy and return are outside the endpoint and explicitly not claimed.
        budget();
        previousCpuProfile = accounting.snapshot("afterRetention");
      }
      return { status };
    } catch {
      fault = true; previous = undefined;
      // A fault snapshot stops at the last VALID checkpoint; never guess the
      // cost of a throwing stage or the catch/reporting path.
      if (accounting) previousCpuProfile = accounting.snapshot("fault");
      try { ports.emit(JSON.stringify({ kind: "treasury-legacy-read-bridge", tick: nonneg(tick) ? tick : null,
        status: "fault_disabled", authorizesActions: false })); } catch { /* Do not stop old bot. */ }
      return { status: "fault_disabled" };
    }
  }
  return { run, stats: () => ({ fault, emitted, cpuSkips, retainedEndpoints: previous ? Object.keys(previous.endpoints).length : 0,
    previousRun: previousRun ? { ...previousRun } : null,
    cpuProfile: previousCpuProfile }) };
}
