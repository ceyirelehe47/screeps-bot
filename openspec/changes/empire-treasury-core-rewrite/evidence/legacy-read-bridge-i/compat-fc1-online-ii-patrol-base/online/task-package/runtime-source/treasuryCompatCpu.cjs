"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPAT_TASK_MARKS = exports.COMPAT_COMMITMENT_MARKS = exports.COMPAT_CPU_WORK_KEYS = exports.COMPAT_CPU_SUBPHASES = exports.COMPAT_CPU_PHASES = void 0;
exports.createCompatCpuAccounting = createCompatCpuAccounting;
/** Bounded diagnostic accounting, NOT an authorization or CPU-budget authority.
 * Values come only from the caller's existing CPU port. Probe/diagnostic overhead
 * remains in cumulative costs; no estimated overhead is subtracted. No Game,
 * Memory, module loading, clocks, I/O or persistent cache are used here.
 */
exports.COMPAT_CPU_PHASES = Object.freeze([
    "legacyInputs", "directRead", "readerLoad", "observationBuild",
    "coreCompare", "commitmentBuild", "commitmentProjection", "report",
    "serializationAndSize", "emit", "retention",
]);
/** Coarse builder intervals. They are intentionally bounded: one boundary per
 * region, never one CPU read per task, reservation, resource key or query.
 * A subphase is nested inside an existing top-level phase and MUST NOT be added
 * to the parent phase to derive total cost.
 */
exports.COMPAT_CPU_SUBPHASES = Object.freeze([
    "observationSetup", "observationRooms", "observationFinalize", "observationView",
    "commitmentSetup", "commitmentTasks", "commitmentReservations", "commitmentFinalize",
    "projectionRows",
]);
/** Primitive work counters describe the composition of the coarse intervals.
 * They are not CPU weights and are not used for authorization or pass/fail.
 */
exports.COMPAT_CPU_WORK_KEYS = Object.freeze([
    "observationRooms", "observationLocations", "observationExistingLocations", "observationResourceKeys",
    "commitmentTaskRecords", "commitmentPendingTaskRecords", "commitmentTaskInvalidEvents",
    "commitmentDemandHealthChecks", "commitmentReceiverHealthChecks", "commitmentRouteCandidates",
    "commitmentReservationRecords", "commitmentReservationInvalidEvents", "commitmentOwnerEvaluations",
    "commitmentActiveReservations", "commitmentScopeBuckets", "commitmentRoomBuckets",
    "commitmentMergeRoutes", "commitmentReservationScopes",
    "projectionRowsPlanned", "projectionRowsCompleted", "projectionIndexQueries",
]);
exports.COMPAT_COMMITMENT_MARKS = Object.freeze([
    "parentStart", "callStart", "bodyStart", "bodyEnd", "callEnd", "parentEnd",
]);
exports.COMPAT_TASK_MARKS = Object.freeze(["tasksStart", "firstPendingStart", "firstPendingEnd", "tasksEnd"]);
// XV: private, definition-only membership sets, never business/input caches.
// No mutator or set reference escapes this module. Snapshot/validation semantics
// and every CPU observation stay unchanged; no diagnostic overhead is subtracted.
const CPU_PHASE_NAMES = new Set(exports.COMPAT_CPU_PHASES);
const CPU_SUBPHASE_NAMES = new Set(exports.COMPAT_CPU_SUBPHASES);
const CPU_WORK_NAMES = new Set(exports.COMPAT_CPU_WORK_KEYS);
const CPU_TAIL_PHASES = Object.freeze(["serializationAndSize", "emit", "retention"]);
/** One instance per admitted sample; snapshots contain primitive values only.
 * Each interval is charged to the phase that was active BEFORE the checkpoint.
 * Unvisited phases are absent, not invented zero-cost measurements.
 * Phase and subphase costs are inclusive intervals, not profiler-overhead-
 * corrected timings. Subphases overlap their parent phase by design.
 */
function createCompatCpuAccounting(start, tick, sampleOrdinal, traceCommitment = false, traceTasks = false) {
    if (!Number.isFinite(start) || !Number.isFinite(tick) || !Number.isFinite(sampleOrdinal) || start < 0
        || !Number.isSafeInteger(tick) || tick < 0
        || !Number.isSafeInteger(sampleOrdinal) || sampleOrdinal < 1)
        throw new Error("invalid CPU accounting start");
    let last = start, phase = "legacyInputs", checkpoints = 1;
    const phases = { legacyInputs: 0 };
    const calls = { readerLoad: 0, observationBuild: 0, commitmentBuild: 0 };
    let attributionLast = null, attributionActive = null, attributionBoundaries = 0;
    const intervals = {};
    const work = {};
    let hasWork = false;
    const attribution = () => attributionBoundaries || hasWork
        ? Object.freeze({ version: 1, boundaries: attributionBoundaries, active: attributionActive,
            intervals: Object.freeze({ ...intervals }), work: Object.freeze({ ...work }) })
        : undefined;
    const commitmentMarks = {};
    let markIndex = -1, markLast = start;
    const mark = (name, used) => {
        if (!traceCommitment)
            return;
        const i = exports.COMPAT_COMMITMENT_MARKS.indexOf(name);
        if (i < 0 || i <= markIndex || !Number.isFinite(used) || used < markLast || used < start)
            throw new Error("invalid commitment envelope boundary");
        commitmentMarks[name] = used - start;
        markIndex = i;
        markLast = used;
    };
    const envelope = () => !traceCommitment ? undefined : Object.freeze({
        version: 1,
        status: calls.commitmentBuild === 0 ? "not_called"
            : exports.COMPAT_COMMITMENT_MARKS.every(k => commitmentMarks[k] !== undefined) ? "complete" : "incomplete",
        marks: Object.freeze({ ...commitmentMarks }),
    });
    const taskMarks = {};
    let taskMarkIndex = -1, taskMarkLast = start, firstPendingOrdinal = null;
    const taskMark = (name, used, ordinal) => {
        if (!traceTasks)
            return;
        const i = exports.COMPAT_TASK_MARKS.indexOf(name);
        if (i < 0 || i <= taskMarkIndex || !Number.isFinite(used) || used < taskMarkLast || used < start)
            throw new Error("invalid first pending task boundary");
        if (name === "firstPendingStart" || name === "firstPendingEnd") {
            if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 256
                || (firstPendingOrdinal !== null && ordinal !== firstPendingOrdinal))
                throw new Error("invalid first pending task ordinal");
            firstPendingOrdinal = ordinal;
        }
        taskMarks[name] = used - start;
        taskMarkIndex = i;
        taskMarkLast = used;
    };
    const taskEnvelope = () => !traceTasks ? undefined : Object.freeze({
        version: 1,
        status: calls.commitmentBuild === 0 ? "not_called"
            : exports.COMPAT_TASK_MARKS.every(k => taskMarks[k] !== undefined) ? "complete"
                : taskMarks.tasksStart !== undefined && taskMarks.tasksEnd !== undefined && firstPendingOrdinal === null
                    ? "no_pending" : "incomplete",
        firstPendingOrdinal, marks: Object.freeze({ ...taskMarks }),
    });
    return {
        taskMark(name, used, ordinal) { taskMark(name, used, ordinal); },
        commitmentMark(name, used) { mark(name, used); },
        checkpoint(used, next) {
            var _a, _b;
            if (!Number.isFinite(used) || used < last || !CPU_PHASE_NAMES.has(next !== null && next !== void 0 ? next : phase))
                throw new Error("invalid CPU accounting checkpoint");
            if (traceCommitment && phase !== "commitmentBuild" && next === "commitmentBuild")
                mark("parentStart", used);
            if (traceCommitment && phase === "commitmentBuild" && next && next !== "commitmentBuild")
                mark("parentEnd", used);
            phases[phase] = ((_a = phases[phase]) !== null && _a !== void 0 ? _a : 0) + (used - last);
            last = used;
            checkpoints++;
            if (next) {
                phase = next;
                (_b = phases[phase]) !== null && _b !== void 0 ? _b : (phases[phase] = 0);
            }
        },
        invoked(call) {
            if (!Object.prototype.hasOwnProperty.call(calls, call) || calls[call] !== 0)
                throw new Error("invalid CPU diagnostic invocation");
            calls[call]++;
        },
        attributionBoundary(used, next) {
            var _a, _b;
            if (!Number.isFinite(used) || used < start || (attributionLast !== null && used < attributionLast)
                || (next !== undefined && !CPU_SUBPHASE_NAMES.has(next)))
                throw new Error("invalid CPU attribution boundary");
            if (traceTasks && next === "commitmentTasks")
                taskMark("tasksStart", used);
            if (traceTasks && attributionActive === "commitmentTasks" && next === "commitmentReservations")
                taskMark("tasksEnd", used);
            if (traceCommitment && next === "commitmentSetup")
                mark("bodyStart", used);
            if (traceCommitment && attributionActive === "commitmentFinalize" && next === undefined)
                mark("bodyEnd", used);
            if (attributionActive !== null && attributionLast !== null)
                intervals[attributionActive] = ((_a = intervals[attributionActive]) !== null && _a !== void 0 ? _a : 0) + (used - attributionLast);
            attributionBoundaries++;
            attributionActive = next !== null && next !== void 0 ? next : null;
            attributionLast = next === undefined ? null : used;
            if (next)
                (_b = intervals[next]) !== null && _b !== void 0 ? _b : (intervals[next] = 0);
        },
        attributionWork(values) {
            var _a;
            if (!values || typeof values !== "object")
                throw new Error("invalid CPU attribution work");
            for (const [key, value] of Object.entries(values)) {
                if (!CPU_WORK_NAMES.has(key) || value === undefined
                    || !Number.isSafeInteger(value) || value < 0)
                    throw new Error("invalid CPU attribution work");
                const next = ((_a = work[key]) !== null && _a !== void 0 ? _a : 0) + value;
                if (!Number.isSafeInteger(next))
                    throw new Error("invalid CPU attribution work");
                work[key] = next;
                hasWork = true;
            }
        },
        snapshot(boundary) {
            if (boundary === "afterRetention") {
                // XII: the preceding report already carries the full prefix snapshot.
                // Publish only the measured serialization/emit/retention continuation
                // instead of serializing its attribution and parent phases a second time.
                const tail = {};
                for (const key of CPU_TAIL_PHASES)
                    if (phases[key] !== undefined)
                        tail[key] = phases[key];
                return Object.freeze({ version: 1, tick, sampleOrdinal, boundary, elapsed: last - start,
                    checkpoints, calls: Object.freeze({ ...calls }), phases: Object.freeze(tail), completion: "tail_only" });
            }
            const a = attribution(), e = envelope(), t = taskEnvelope();
            return Object.freeze({ version: 1, tick, sampleOrdinal, boundary, elapsed: last - start,
                checkpoints, calls: Object.freeze({ ...calls }), phases: Object.freeze({ ...phases }),
                ...(a ? { attribution: a } : {}), ...(e ? { commitmentEnvelope: e } : {}), ...(t ? { taskEnvelope: t } : {}) });
        },
    };
}
