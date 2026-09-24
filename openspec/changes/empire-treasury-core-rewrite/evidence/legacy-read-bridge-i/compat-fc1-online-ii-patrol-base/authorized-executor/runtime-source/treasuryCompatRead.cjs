"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validCompatConfig = validCompatConfig;
exports.compatUtf8Bytes = compatUtf8Bytes;
exports.createTreasuryCompatPreview = createTreasuryCompatPreview;
const treasuryCompatCpu_1 = require("./treasuryCompatCpu");
const KINDS = ["storage", "terminal"];
const TABLE_LIMIT = 256;
const sat = (n) => Math.min(n + 1, 999999999);
const obj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const nonneg = (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const finite = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
const str = (x, n) => typeof x === "string" && x.length > 0 && x.length <= n;
function validCompatConfig(c) {
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
// XV: stateless ASCII detection; non-ASCII retains the exact surrogate-aware path.
// The reported byte limit is unchanged. No truncation, dropped fields or estimate.
const COMPAT_NON_ASCII = /[^\x00-\x7f]/;
function compatUtf8Bytes(s) {
    if (typeof s === "string" && !COMPAT_NON_ASCII.test(s))
        return s.length;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const a = s.charCodeAt(i);
        if (a < 128)
            n++;
        else if (a < 2048)
            n += 2;
        else if (a >= 0xd800 && a <= 0xdbff && i + 1 < s.length
            && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
            n += 4;
            i++;
        }
        else
            n += 3;
    }
    return n;
}
/** Own-property path read. Missing, null, array, damaged parents and empty object
 * remain distinct. No ensure()/normalizer or getter invocation on table entries. */
function pathValue(root, path) {
    let p = root;
    for (const key of path) {
        if (!obj(p))
            return { status: "invalid_parent" };
        const desc = Object.getOwnPropertyDescriptor(p, key);
        if (!desc)
            return { status: "absent" };
        if (!("value" in desc))
            return { status: "accessor_unreadable" };
        p = desc.value;
    }
    return { status: "present", value: p };
}
function pathFrom(found, path) {
    return found.status === "present" ? pathValue(found.value, path) : { status: found.status };
}
function tableFound(found) {
    if (found.status !== "present")
        return { status: found.status, count: null, value: undefined };
    if (!obj(found.value))
        return { status: "invalid_container", count: null, value: undefined };
    // Stop enumeration at bound+1. Never aggregate a selected prefix as the table.
    let count = 0;
    for (const key in found.value) {
        // XV: the descriptor lookup itself establishes own membership. Inherited
        // enumerable keys are ignored; own accessors still reject the WHOLE table.
        const descriptor = Object.getOwnPropertyDescriptor(found.value, key);
        if (!descriptor)
            continue;
        if (!("value" in descriptor))
            return { status: "accessor_unreadable", count: null, value: undefined };
        if (++count > TABLE_LIMIT)
            return { status: "over_bound", count: null, value: undefined };
    }
    return { status: count === 0 ? "empty" : "nonempty", count, value: found.value };
}
function table(root, path) { return tableFound(pathValue(root, path)); }
function summary(s) { return { status: s.status, count: s.count }; }
function direct(room, kind, resources) {
    var _a;
    try {
        if (!room)
            return { status: "not_visible" };
        if (((_a = room.controller) === null || _a === void 0 ? void 0 : _a.my) !== true)
            return { status: "not_owned" };
        const s = room[kind];
        if (!s)
            return { status: "absent" };
        if (s.my !== true || !str(s.id, 96))
            return { status: "unreadable" };
        // Endpoint-local reference only: no value or Store is retained across calls.
        // Core observation still obtains its own Store and independently enumerates it.
        const store = s.store;
        if (!store || typeof s.isActive !== "function")
            return { status: "unreadable" };
        const used = store.getUsedCapacity(), free = store.getFreeCapacity(), capacity = store.getCapacity();
        const active = s.isActive(), cooldown = kind === "terminal" ? s.cooldown : null;
        // Capacity reduction may leave inventory above capacity. Preserve signed
        // free or a saturated zero, rather than inventing capacity=used+free.
        if (!nonneg(used) || !nonneg(capacity) || !Number.isSafeInteger(free)
            || !(used + free === capacity || (used > capacity && free === 0))
            || typeof active !== "boolean" || (kind === "terminal" && !nonneg(cooldown)))
            return { status: "unreadable" };
        const amounts = Object.create(null);
        let selectedTotal = 0;
        for (const r of resources) {
            const a = store.getUsedCapacity(r);
            if (!nonneg(a) || a > used)
                return { status: "unreadable" };
            amounts[r] = a;
            selectedTotal += a;
        }
        if (selectedTotal > used)
            return { status: "unreadable" };
        return { status: "ok", value: { id: s.id, used, free, capacity, overCapacity: used > capacity,
                active, cooldown, amounts } };
    }
    catch {
        return { status: "unreadable" };
    }
}
function legacyProjection(raw, room, kind, d, tick) {
    if (raw.status !== "present")
        return { status: raw.status };
    if (!obj(raw.value) || !nonneg(raw.value.updatedAt))
        return { status: "unreadable" };
    if (raw.value.updatedAt !== tick)
        return { status: raw.value.updatedAt > tick ? "future_tick" : "stale",
            updatedAt: raw.value.updatedAt, comparisonPerformed: false };
    const row = pathValue(raw.value, ["rooms", room]);
    if (row.status !== "present")
        return { status: row.status, comparisonPerformed: false };
    if (!obj(row.value))
        return { status: "unreadable" };
    const mismatches = [];
    const usedKey = kind + "UsedCapacity", freeKey = kind + "FreeCapacity";
    if (!Number.isSafeInteger(row.value[usedKey]))
        return { status: "unreadable", comparisonPerformed: false };
    if (row.value[usedKey] !== d.used)
        mismatches.push(usedKey);
    if (!Number.isSafeInteger(row.value[freeKey]))
        return { status: "unreadable", comparisonPerformed: false };
    if (row.value[freeKey] !== d.free)
        mismatches.push(freeKey);
    if (own(d.amounts, "energy")) {
        const energyKey = kind + "Energy";
        if (!Number.isSafeInteger(row.value[energyKey]))
            return { status: "unreadable", comparisonPerformed: false };
        if (row.value[energyKey] !== d.amounts.energy)
            mismatches.push(energyKey);
    }
    return { status: mismatches.length ? "mismatch" : "match_capacity_and_selected_energy",
        updatedAt: raw.value.updatedAt, comparisonPerformed: true, mismatches };
}
function createTreasuryCompatPreview(input, ports, options = {}) {
    const cpuDiagnostics = (options === null || options === void 0 ? void 0 : options.cpuDiagnostics) === true;
    const traceCommitment = cpuDiagnostics && (options === null || options === void 0 ? void 0 : options.commitmentBoundaryDiagnostics) === true;
    const taskBoundaryDiagnostics = traceCommitment && (options === null || options === void 0 ? void 0 : options.taskBoundaryDiagnostics) === true;
    const localSafetyStop = (options === null || options === void 0 ? void 0 : options.localSafetyStop) === true;
    let sampleOrdinal = 0, previousCpuProfile = null;
    let cfg = input, enabled = false, invalid = false;
    try {
        enabled = input.enabled === true;
        if (enabled) {
            invalid = !validCompatConfig(input);
            if (!invalid)
                cfg = Object.freeze({ ...input, rooms: Object.freeze([...input.rooms]), resources: Object.freeze([...input.resources]) });
        }
    }
    catch {
        invalid = true;
    }
    let fault = false, lastTick, previous;
    let emitted = 0, cpuSkips = 0;
    // XIII: local containment, never an engine interrupt or a production rollback.
    // No Memory write. A new heap arriving after the first due tick cannot re-arm.
    let safetyStop;
    let safetyNoticeAttempted = false;
    const latch = (tick, used) => {
        if (localSafetyStop && used > 5 && !safetyStop)
            safetyStop = { tick, reason: "CPU_OBSERVED_SAFETY_STOP", observedCpu: used };
    };
    const notifySafety = () => {
        if (!safetyStop || safetyNoticeAttempted)
            return;
        safetyNoticeAttempted = true;
        try {
            ports.emit(JSON.stringify({ kind: "treasury-compat-safety-stop", version: 1,
                ...safetyStop, thresholdCpu: 5, stopsFutureSamples: true,
                currentCallPreempted: false, scope: "preview_heap_instance", authorizesActions: false }));
        }
        catch { /* Stop remains latched even if the one control notification fails. */ }
    };
    let previousRun = null;
    function run() {
        var _a, _b, _c;
        let tick;
        let accounting;
        try {
            if (invalid) {
                fault = true;
                return { status: "invalid_config" };
            }
            if (!enabled)
                return { status: "disabled" };
            if (fault)
                return { status: "disabled_after_fault" };
            if (safetyStop)
                return { status: "disabled_after_safety_stop" };
            tick = ports.tick();
            if (!nonneg(tick))
                throw new Error("invalid tick");
            if (tick < cfg.startTick || tick > cfg.endTick) {
                previous = undefined;
                return { status: "outside_window" };
            }
            if (tick % cfg.intervalTicks !== 0 || tick === lastTick)
                return { status: "not_due" };
            lastTick = tick;
            if (localSafetyStop && sampleOrdinal === 0 && tick !== Math.ceil(cfg.startTick / cfg.intervalTicks) * cfg.intervalTicks) {
                safetyStop = { tick, reason: "WINDOW_RESTART_UNPROVEN", observedCpu: null };
                notifySafety();
                return { status: "disabled_after_safety_stop" };
            }
            if (ports.shard() !== cfg.shardName)
                return { status: "wrong_shard" };
            const availableResources = ports.resources();
            if (!cfg.resources.every(r => availableResources.includes(r)))
                throw new Error("invalid resource");
            const start = ports.cpu();
            const validCpu = (c) => finite(c.used) && finite(c.tickLimit) && nonneg(c.bucket);
            if (!validCpu(start))
                throw new Error("invalid CPU");
            if (start.bucket < cfg.minBucket || start.tickLimit - start.used < cfg.maxSampleCpu + cfg.reserveCpu) {
                cpuSkips = sat(cpuSkips);
                return { status: "cpu_skipped" };
            }
            sampleOrdinal = sat(sampleOrdinal);
            if (cpuDiagnostics)
                accounting = (0, treasuryCompatCpu_1.createCompatCpuAccounting)(start.used, tick, sampleOrdinal, traceCommitment, taskBoundaryDiagnostics);
            let latestCpu = start.used;
            const budget = (next) => {
                const c = ports.cpu();
                if (!validCpu(c) || c.used < latestCpu)
                    throw new Error("invalid CPU progression");
                accounting === null || accounting === void 0 ? void 0 : accounting.checkpoint(c.used, next);
                latestCpu = c.used;
                latch(tick, c.used - start.used);
                return !safetyStop && c.used - start.used < cfg.maxSampleCpu && c.tickLimit - c.used >= cfg.reserveCpu && c.bucket >= cfg.minBucket;
            };
            // Builder boundaries are diagnostic-only and never authorize work. Each
            // boundary samples the same CPU port, so its overhead remains in both the
            // parent phase and the reported subphase interval. Builders emit bounded
            // primitive work counters instead of sampling once per record/key/query.
            const builderDiagnostics = accounting ? (() => {
                const sampleAccounting = accounting;
                return Object.freeze({
                    boundary(phase) {
                        const c = ports.cpu();
                        if (!validCpu(c) || c.used < latestCpu)
                            throw new Error("invalid CPU progression");
                        sampleAccounting.attributionBoundary(c.used, phase);
                        latestCpu = c.used;
                        latch(tick, c.used - start.used);
                    },
                    work(values) { sampleAccounting.attributionWork(values); },
                    ...(taskBoundaryDiagnostics ? {
                        taskBoundary(mark, recordOrdinal) {
                            const c = ports.cpu();
                            if (!validCpu(c) || c.used < latestCpu)
                                throw new Error("invalid CPU progression");
                            sampleAccounting.taskMark(mark, c.used, recordOrdinal);
                            latestCpu = c.used;
                            latch(tick, c.used - start.used);
                        },
                    } : {}),
                });
            })() : undefined;
            // Two added CPU reads per actual traced build. Argument creation stays
            // inside parentStart -> callStart; wrapper/prologue stays before bodyStart.
            const markCommitment = (name) => {
                if (!traceCommitment || !accounting)
                    return;
                const c = ports.cpu();
                if (!validCpu(c) || c.used < latestCpu)
                    throw new Error("invalid CPU progression");
                accounting.commitmentMark(name, c.used);
                latestCpu = c.used;
                latch(tick, c.used - start.used);
            };
            const memory = ports.memory();
            // XII: resolve the two own-data roots once for this admitted sample. This
            // is not a cross-sample business cache; all tables are still fully scanned.
            const dataRoot = pathValue(memory, ["data"]), runtimeRoot = pathValue(memory, ["runtime"]);
            const tasks = tableFound(pathFrom(dataRoot, ["resourceControl", "tasks"]));
            const reservations = tableFound(pathFrom(runtimeRoot, ["resourceReservations"]));
            const marker = pathFrom(runtimeRoot, ["resourceReservationsOwnerVersion"]);
            const existingCore = pathFrom(runtimeRoot, ["treasuryCore"]);
            const report = { kind: "treasury-legacy-read-bridge", tick, shard: cfg.shardName,
                sourceCommit: "01bd9831454950c4928df98dd8679692b55603e5", productionBase: "06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c",
                authorizesActions: false, scope: { rooms: cfg.rooms, resources: cfg.resources, isEmpireTotal: false },
                evaluation: "observation_and_legacy_commitments_only", facadeQueryRun: false,
                spendable: null, kernelLifecycleRun: false, storageMode: "heap_only", previousRun,
                legacyInputs: { tasks: summary(tasks), reservations: summary(reservations),
                    reservationVersion: { status: marker.status, value: nonneg(marker.value) ? marker.value : null },
                    treasuryCore: { status: existingCore.status === "present" ? "present_not_interpreted" : existingCore.status, activeCount: null } },
            };
            // XIV: own-data path cursor, local to this admitted sample; never Store authority.
            let projectionSource;
            const rows = [];
            report.endpoints = rows;
            const validRooms = [];
            const validRoomNames = [];
            const next = { tick, endpoints: Object.create(null) };
            let limited = false, observations;
            for (const name of cfg.rooms) {
                if (!budget("directRead")) {
                    limited = true;
                    break;
                }
                const room = ports.room(name);
                let safe = true;
                for (const kind of KINDS) {
                    if (!budget()) {
                        limited = true;
                        safe = false;
                        break;
                    }
                    const d = direct(room, kind, cfg.resources);
                    const row = { room: name, location: kind, directStatus: d.status };
                    rows.push(row);
                    if (d.status !== "ok" && d.status !== "absent")
                        safe = false;
                    if (d.value) {
                        row.direct = d.value;
                        projectionSource !== null && projectionSource !== void 0 ? projectionSource : (projectionSource = pathFrom(runtimeRoot, ["resourceControl"]));
                        row.legacyProjection = legacyProjection(projectionSource, name, kind, d.value, tick);
                        const key = name + ":" + kind, old = previous === null || previous === void 0 ? void 0 : previous.endpoints[key];
                        next.endpoints[key] = d.value;
                        if (!old || !previous)
                            row.change = { status: "no_comparable_previous_sample" };
                        else if (old.id !== d.value.id || old.capacity !== d.value.capacity)
                            row.change = { status: "endpoint_or_capacity_changed" };
                        else if (tick <= previous.tick || tick - previous.tick > cfg.intervalTicks * 3)
                            row.change = { status: "gap_not_comparable" };
                        else {
                            const amounts = Object.create(null);
                            for (const r of cfg.resources)
                                amounts[r] = d.value.amounts[r] - old.amounts[r];
                            row.change = { status: "net_change_unattributed", fromTick: previous.tick, toTick: tick, amounts };
                        }
                    }
                }
                if (safe && room && ((_a = room.controller) === null || _a === void 0 ? void 0 : _a.my) === true) {
                    validRooms.push(room);
                    validRoomNames.push(name);
                }
            }
            // Build from actual Game room objects, NOT from the just-produced direct
            // numbers or legacy Memory projection. Independently enumerates Store keys.
            let readers;
            if (validRooms.length && budget("readerLoad")) {
                accounting === null || accounting === void 0 ? void 0 : accounting.invoked("readerLoad");
                readers = ports.readers();
                if (budget("observationBuild")) {
                    accounting === null || accounting === void 0 ? void 0 : accounting.invoked("observationBuild");
                    observations = readers.buildObservation({ scope: "market-fresh", epochSeq: 1, rooms: validRooms, compatDiagnostics: builderDiagnostics });
                }
                else
                    limited = true;
            }
            else if (!budget())
                limited = true;
            // Diagnostic-only extra checkpoint: its cost is NOT removed from budget.
            if (accounting && !budget("coreCompare"))
                limited = true;
            if (observations && observations.epoch.observedAtTick !== tick)
                throw new Error("stale builder");
            // At most two admitted rooms and four endpoint rows: avoid a Set allocation
            // while retaining the same bounded membership semantics and row order.
            for (const row of rows) {
                if (!observations || !validRoomNames.includes(row.room)) {
                    row.coreComparison = "not_read";
                    continue;
                }
                const o = observations.location(row.room, row.location), d = row.direct;
                if (!d) {
                    row.coreComparison = row.directStatus === "absent" && !o.exists ? "both_absent" : "existence_mismatch";
                    continue;
                }
                const mismatch = [];
                if (!o.exists || o.structureId !== d.id)
                    mismatch.push("structure");
                if (o.usedCapacity !== d.used)
                    mismatch.push("usedCapacity");
                if (o.freeCapacity !== d.free)
                    mismatch.push("freeCapacity");
                for (const r of cfg.resources)
                    if (((_b = o.amounts[r]) !== null && _b !== void 0 ? _b : 0) !== d.amounts[r])
                        mismatch.push(r);
                row.coreComparison = mismatch.length ? "mismatch" : "match_selected_scope";
                row.coreMismatches = mismatch;
            }
            report.commitments = { status: "not_read", rows: null };
            // Never manufacture empty inputs from missing/damaged/over-bound tables.
            if (!tasks.value || !reservations.value)
                report.commitments = { status: "unavailable_legacy_input", rows: null };
            else if (readers && observations && budget("commitmentBuild")) {
                const commitmentOptions = { tick, tasks: tasks.value, reservations: reservations.value, observation: observations, compatDiagnostics: builderDiagnostics };
                markCommitment("callStart");
                if (safetyStop || (traceCommitment && latestCpu - start.used >= cfg.maxSampleCpu)) {
                    limited = true;
                    report.commitments = { status: "not_read_cpu_budget", rows: null };
                }
                else {
                    accounting === null || accounting === void 0 ? void 0 : accounting.invoked("commitmentBuild");
                    const index = readers.buildCommitments(commitmentOptions);
                    markCommitment("callEnd");
                    const fields = [];
                    const projectionRowsPlanned = validRoomNames.length * cfg.resources.length;
                    builderDiagnostics === null || builderDiagnostics === void 0 ? void 0 : builderDiagnostics.boundary("projectionRows");
                    for (const name of validRoomNames)
                        for (const resource of cfg.resources) {
                            if (!budget("commitmentProjection")) {
                                limited = true;
                                break;
                            }
                            const outgoing = index.outgoing(name, resource), incoming = index.incoming(name, resource), reserved = index.reservedProduction(name, resource);
                            if (!nonneg(outgoing) || !nonneg(incoming) || !nonneg(reserved))
                                throw new Error("invalid index numbers");
                            fields.push({ room: name, resource, scope: "room_not_endpoint", outgoing, incoming,
                                productionReserved: reserved, completeness: index.commitmentCompleteness(name, resource) });
                        }
                    builderDiagnostics === null || builderDiagnostics === void 0 ? void 0 : builderDiagnostics.work({ projectionRowsPlanned, projectionRowsCompleted: fields.length, projectionIndexQueries: fields.length * 4 });
                    builderDiagnostics === null || builderDiagnostics === void 0 ? void 0 : builderDiagnostics.boundary();
                    const c = index.completeness;
                    if (!c || typeof c.complete !== "boolean" || typeof c.globalIncomplete !== "boolean"
                        || !nonneg(c.invalidRecords) || !nonneg(c.incompleteScopeCount))
                        throw new Error("invalid index health");
                    report.commitments = { status: limited ? "partial_cpu_budget" : c.complete ? "read_complete" : "read_incomplete",
                        rows: fields, completeness: { ...c }, allTableScan: true, tableLimitEach: TABLE_LIMIT };
                }
            }
            else if (!budget()) {
                limited = true;
                report.commitments = { status: "not_read_cpu_budget", rows: null };
            }
            if (!budget("report"))
                limited = true;
            report.status = limited ? "partial_cpu_budget" : "sampled";
            report.coreObservationRooms = observations ? validRoomNames : [];
            report.requestedEndpointRows = cfg.rooms.length * 2;
            report.collectedEndpointRows = rows.length;
            if (accounting && !budget("serializationAndSize"))
                report.status = "partial_cpu_budget";
            report.cpuBeforeSerializationAndEmit = latestCpu - start.used;
            if (accounting) {
                // Prefix of THIS sample. Serialization/emit are not known yet. The full
                // completed measurement is published only by the NEXT emitted sample.
                report.cpuProfile = accounting.snapshot("beforeSerialization");
                report.previousCpuProfile = previousCpuProfile;
            }
            report.cooperativeBudget = true;
            if (traceCommitment)
                report.diagnosticRevision = taskBoundaryDiagnostics ? "XIV" : "XIII";
            if (localSafetyStop)
                report.localSafety = { thresholdCpu: 5, latched: !!safetyStop,
                    reason: (_c = safetyStop === null || safetyStop === void 0 ? void 0 : safetyStop.reason) !== null && _c !== void 0 ? _c : null, scope: "preview_heap_instance", currentCallPreempted: false };
            let line = JSON.stringify(report), status = report.status;
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
            if (accounting)
                budget("emit");
            ports.emit(line);
            const end = ports.cpu();
            if (!validCpu(end) || end.used < latestCpu)
                throw new Error("invalid ending CPU");
            accounting === null || accounting === void 0 ? void 0 : accounting.checkpoint(end.used, "retention");
            latestCpu = end.used;
            latch(tick, end.used - start.used);
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
            notifySafety();
            return { status };
        }
        catch {
            fault = true;
            previous = undefined;
            // A fault snapshot stops at the last VALID checkpoint; never guess the
            // cost of a throwing stage or the catch/reporting path.
            if (accounting)
                previousCpuProfile = accounting.snapshot("fault");
            try {
                ports.emit(JSON.stringify({ kind: "treasury-legacy-read-bridge", tick: nonneg(tick) ? tick : null,
                    status: "fault_disabled", authorizesActions: false }));
            }
            catch { /* Do not stop old bot. */ }
            return { status: "fault_disabled" };
        }
    }
    return { run, stats: () => {
            var _a;
            return ({ fault, emitted, cpuSkips, retainedEndpoints: previous ? Object.keys(previous.endpoints).length : 0,
                previousRun: previousRun ? { ...previousRun } : null,
                cpuProfile: previousCpuProfile,
                ...(localSafetyStop ? { safetyStopped: !!safetyStop, safetyReason: (_a = safetyStop === null || safetyStop === void 0 ? void 0 : safetyStop.reason) !== null && _a !== void 0 ? _a : null } : {}) });
        } };
}
