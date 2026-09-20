/** Bounded diagnostic accounting, NOT an authorization or CPU-budget authority.
 * Values come only from the caller's existing CPU port. Probe/diagnostic overhead
 * remains in cumulative costs; no estimated overhead is subtracted. No Game,
 * Memory, module loading, clocks, I/O or persistent cache are used here.
 */
export const COMPAT_CPU_PHASES = Object.freeze([
  "legacyInputs", "directRead", "readerLoad", "observationBuild",
  "coreCompare", "commitmentBuild", "commitmentProjection", "report",
  "serializationAndSize", "emit", "retention",
] as const);
export type CompatCpuPhase = typeof COMPAT_CPU_PHASES[number];
export type CompatCpuCall = "readerLoad" | "observationBuild" | "commitmentBuild";

/** Coarse builder intervals. They are intentionally bounded: one boundary per
 * region, never one CPU read per task, reservation, resource key or query.
 * A subphase is nested inside an existing top-level phase and MUST NOT be added
 * to the parent phase to derive total cost.
 */
export const COMPAT_CPU_SUBPHASES = Object.freeze([
  "observationSetup", "observationRooms", "observationFinalize", "observationView",
  "commitmentSetup", "commitmentTasks", "commitmentReservations", "commitmentFinalize",
  "projectionRows",
] as const);
export type CompatCpuSubphase = typeof COMPAT_CPU_SUBPHASES[number];

/** Primitive work counters describe the composition of the coarse intervals.
 * They are not CPU weights and are not used for authorization or pass/fail.
 */
export const COMPAT_CPU_WORK_KEYS = Object.freeze([
  "observationRooms", "observationLocations", "observationExistingLocations", "observationResourceKeys",
  "commitmentTaskRecords", "commitmentPendingTaskRecords", "commitmentTaskInvalidEvents",
  "commitmentDemandHealthChecks", "commitmentReceiverHealthChecks", "commitmentRouteCandidates",
  "commitmentReservationRecords", "commitmentReservationInvalidEvents", "commitmentOwnerEvaluations",
  "commitmentActiveReservations", "commitmentScopeBuckets", "commitmentRoomBuckets",
  "commitmentMergeRoutes", "commitmentReservationScopes",
  "projectionRowsPlanned", "projectionRowsCompleted", "projectionIndexQueries",
] as const);
export type CompatCpuWorkKey = typeof COMPAT_CPU_WORK_KEYS[number];
export interface CompatCpuAttribution {
  readonly version: 1;
  readonly boundaries: number;
  readonly active: CompatCpuSubphase | null;
  readonly intervals: Readonly<Partial<Record<CompatCpuSubphase, number>>>;
  readonly work: Readonly<Partial<Record<CompatCpuWorkKey, number>>>;
}
export interface CompatCpuProfile {
  readonly version: 1;
  readonly tick: number;
  readonly sampleOrdinal: number;
  readonly boundary: "beforeSerialization" | "afterRetention" | "fault";
  readonly elapsed: number;
  readonly checkpoints: number;
  readonly calls: Readonly<Record<CompatCpuCall, number>>;
  readonly phases: Readonly<Partial<Record<CompatCpuPhase, number>>>;
  readonly attribution?: CompatCpuAttribution;
}
/** One instance per admitted sample; snapshots contain primitive values only.
 * Each interval is charged to the phase that was active BEFORE the checkpoint.
 * Unvisited phases are absent, not invented zero-cost measurements.
 * Phase and subphase costs are inclusive intervals, not profiler-overhead-
 * corrected timings. Subphases overlap their parent phase by design.
 */
export function createCompatCpuAccounting(start: number, tick: number, sampleOrdinal: number) {
  if (![start, tick, sampleOrdinal].every(Number.isFinite) || start < 0
    || !Number.isSafeInteger(tick) || tick < 0
    || !Number.isSafeInteger(sampleOrdinal) || sampleOrdinal < 1) throw new Error("invalid CPU accounting start");
  let last = start, phase: CompatCpuPhase = "legacyInputs", checkpoints = 1;
  const phases: Partial<Record<CompatCpuPhase, number>> = { legacyInputs: 0 };
  const calls: Record<CompatCpuCall, number> = { readerLoad: 0, observationBuild: 0, commitmentBuild: 0 };
  let attributionLast: number | null = null, attributionActive: CompatCpuSubphase | null = null, attributionBoundaries = 0;
  const intervals: Partial<Record<CompatCpuSubphase, number>> = {};
  const work: Partial<Record<CompatCpuWorkKey, number>> = {};
  const attribution = () => attributionBoundaries || Object.keys(work).length
    ? Object.freeze({ version: 1 as const, boundaries: attributionBoundaries, active: attributionActive,
      intervals: Object.freeze({ ...intervals }), work: Object.freeze({ ...work }) })
    : undefined;
  return {
    checkpoint(used: number, next?: CompatCpuPhase): void {
      if (!Number.isFinite(used) || used < last || !COMPAT_CPU_PHASES.includes(next ?? phase))
        throw new Error("invalid CPU accounting checkpoint");
      phases[phase] = (phases[phase] ?? 0) + (used - last);
      last = used;
      checkpoints++;
      if (next) { phase = next; phases[phase] ??= 0; }
    },
    invoked(call: CompatCpuCall): void {
      if (!Object.prototype.hasOwnProperty.call(calls, call) || calls[call] !== 0)
        throw new Error("invalid CPU diagnostic invocation");
      calls[call]++;
    },
    attributionBoundary(used: number, next?: CompatCpuSubphase): void {
      if (!Number.isFinite(used) || used < start || (attributionLast !== null && used < attributionLast)
        || (next !== undefined && !COMPAT_CPU_SUBPHASES.includes(next)))
        throw new Error("invalid CPU attribution boundary");
      if (attributionActive !== null && attributionLast !== null)
        intervals[attributionActive] = (intervals[attributionActive] ?? 0) + (used - attributionLast);
      attributionBoundaries++;
      attributionActive = next ?? null;
      attributionLast = next === undefined ? null : used;
      if (next) intervals[next] ??= 0;
    },
    attributionWork(values: Readonly<Partial<Record<CompatCpuWorkKey, number>>>): void {
      if (!values || typeof values !== "object") throw new Error("invalid CPU attribution work");
      for (const [key, value] of Object.entries(values)) {
        if (!COMPAT_CPU_WORK_KEYS.includes(key as CompatCpuWorkKey) || value === undefined
          || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid CPU attribution work");
        const next = (work[key as CompatCpuWorkKey] ?? 0) + value;
        if (!Number.isSafeInteger(next)) throw new Error("invalid CPU attribution work");
        work[key as CompatCpuWorkKey] = next;
      }
    },
    snapshot(boundary: CompatCpuProfile["boundary"]): CompatCpuProfile {
      const a = attribution();
      return Object.freeze({ version: 1, tick, sampleOrdinal, boundary, elapsed: last - start,
        checkpoints, calls: Object.freeze({ ...calls }), phases: Object.freeze({ ...phases }), ...(a ? { attribution: a } : {}) });
    },
  };
}
