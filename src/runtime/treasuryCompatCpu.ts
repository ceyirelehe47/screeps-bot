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
export interface CompatCpuProfile {
  readonly version: 1;
  readonly tick: number;
  readonly sampleOrdinal: number;
  readonly boundary: "beforeSerialization" | "afterRetention" | "fault";
  readonly elapsed: number;
  readonly checkpoints: number;
  readonly calls: Readonly<Record<CompatCpuCall, number>>;
  readonly phases: Readonly<Partial<Record<CompatCpuPhase, number>>>;
}
/** One instance per admitted sample; snapshots contain primitive values only.
 * Each interval is charged to the phase that was active BEFORE the checkpoint.
 * Unvisited phases are absent, not invented zero-cost measurements.
 * Phase costs are inclusive intervals, not profiler-overhead-corrected timings.
 */
export function createCompatCpuAccounting(start: number, tick: number, sampleOrdinal: number) {
  if (![start, tick, sampleOrdinal].every(Number.isFinite) || start < 0
    || !Number.isSafeInteger(tick) || tick < 0
    || !Number.isSafeInteger(sampleOrdinal) || sampleOrdinal < 1) throw new Error("invalid CPU accounting start");
  let last = start, phase: CompatCpuPhase = "legacyInputs", checkpoints = 1;
  const phases: Partial<Record<CompatCpuPhase, number>> = { legacyInputs: 0 };
  const calls: Record<CompatCpuCall, number> = { readerLoad: 0, observationBuild: 0, commitmentBuild: 0 };
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
    snapshot(boundary: CompatCpuProfile["boundary"]): CompatCpuProfile {
      return Object.freeze({ version: 1, tick, sampleOrdinal, boundary, elapsed: last - start,
        checkpoints, calls: Object.freeze({ ...calls }), phases: Object.freeze({ ...phases }) });
    },
  };
}
