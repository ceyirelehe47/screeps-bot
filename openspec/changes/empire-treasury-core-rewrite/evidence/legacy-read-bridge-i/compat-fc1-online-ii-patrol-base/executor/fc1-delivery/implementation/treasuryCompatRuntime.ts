import { TREASURY_COMPAT_CONFIG } from "./treasuryCompatConfig";
import { createTreasuryCompatPreview, validCompatConfig } from "./treasuryCompatRead";
import { createCompatibilityReadCore } from "./treasuryCompatReadCore.generated";
import type { CompatConfig, CompatPorts } from "./treasuryCompatTypes";

/** FC1 changes the EXPERIMENT envelope, not either reader or its correctness.
 * 10 CPU is a cooperative exposure ceiling, NOT a performance acceptance line.
 * Native headroom >= 55 and bucket >= 2000 are required before each sample;
 * the unchanged preview checks 25 CPU remaining at its existing boundaries.
 * Neither this wrapper nor a JS checkpoint can preempt a synchronous builder.
 */
export const FULL_COST_EXPERIMENT = "treasury-full-cost-FC1-online-I-2026-09-24";
export const FULL_COST_POLICY = Object.freeze({
  cooperativeCeilingCpu: 10, retainedReserveCpu: 25,
  admissionHeadroomCpu: 55, minBucket: 2000, maxReceiptBytes: 16384,
});
type NativeCpu = { used: number; limit: number; tickLimit: number; bucket: number };
const validNative = (c: NativeCpu) => !!c && Number.isFinite(c.used) && c.used >= 0
  && Number.isFinite(c.limit) && c.limit > 0 && Number.isFinite(c.tickLimit)
  && c.tickLimit >= c.limit && Number.isSafeInteger(c.bucket) && c.bucket >= 0 && c.bucket <= 10000;

/** Exported seam for deterministic tests. Production supplies REAL native CPU.
 * No code, Memory, Store, index, or resource catalog is warmed outside preview.
 * Retained state is bounded: one preview, one receipt-cost primitive record.
 */
export function createFullCostRuntime(config: CompatConfig, ports: CompatPorts,
  nativeCpu: () => NativeCpu,
  factory: typeof createTreasuryCompatPreview = createTreasuryCompatPreview): { run(): void } {
  if (!config.enabled) return { run() { /* Zero native CPU or input reads when OFF. */ } };
  const policyValid = validCompatConfig(config)
    && config.maxSampleCpu === FULL_COST_POLICY.cooperativeCeilingCpu
    && config.reserveCpu === FULL_COST_POLICY.retainedReserveCpu
    && config.minBucket === FULL_COST_POLICY.minBucket
    && config.intervalTicks === 100
    && config.endTick === Math.ceil(config.startTick / 100) * 100 + 300;
  // The historical 5-CPU heap latch is replaced, explicitly, by this wrapper's
  // admission + 10-CPU observed stop. The preview's REAL cooperative checks stay.
  const preview = factory(config, ports, {
    cpuDiagnostics: true, commitmentBoundaryDiagnostics: true,
    taskBoundaryDiagnostics: true, localSafetyStop: false,
  });
  let stopped = false, noticeEmitted = false, ordinal = 0, lastTick = -1;
  let previousReceiptOverhead: { tick: number; elapsedAfterPreviewReturn: number } | null = null;
  const stop = (reason: string, tick: number | null, native?: NativeCpu) => {
    stopped = true;
    if (noticeEmitted) return;
    noticeEmitted = true;
    try { ports.emit(JSON.stringify({ kind: "treasury-compat-safety-stop", version: 1,
      experimentId: FULL_COST_EXPERIMENT, tick, reason, thresholdCpu: 10,
      nativeCpu: native, requiredHeadroomCpu: FULL_COST_POLICY.admissionHeadroomCpu,
      scope: "full_cost_runtime_heap", stopsFutureSamples: true,
      currentCallPreempted: false, authorizesActions: false })); } catch { /* Keep latched. */ }
  };
  return { run() {
    if (stopped) return;
    let tick: number | null = null;
    try {
      tick = ports.tick();
      if (!Number.isSafeInteger(tick) || tick < 0) { stop("INVALID_TICK", null); return; }
      if (!policyValid) { stop("FULL_COST_PROFILE_INVALID", tick); return; }
      if (tick < config.startTick || tick > config.endTick || tick % 100 !== 0 || tick === lastTick) return;
      lastTick = tick;
      if (ports.shard() !== config.shardName) { stop("WRONG_SHARD", tick); return; }
      if (ordinal === 0 && tick !== Math.ceil(config.startTick / 100) * 100) {
        stop("WINDOW_RESTART_UNPROVEN", tick); return;
      }
      const entry = nativeCpu();
      if (!validNative(entry)) { stop("INVALID_NATIVE_CPU", tick); return; }
      if (entry.bucket < FULL_COST_POLICY.minBucket
        || entry.tickLimit - entry.used < FULL_COST_POLICY.admissionHeadroomCpu) {
        // No opportunistic resampling at another tick and no fabricated zero.
        stop("INSUFFICIENT_NATIVE_HEADROOM", tick, entry); return;
      }
      ordinal += 1;
      const result = preview.run();
      const returned = nativeCpu();
      if (!validNative(returned) || returned.used < entry.used
        || returned.limit !== entry.limit || returned.tickLimit !== entry.tickLimit) {
        stop("INVALID_NATIVE_CPU_PROGRESSION", tick); return;
      }
      const elapsed = returned.used - entry.used;
      const reason = result.status !== "sampled" ? "PREVIEW_NOT_COMPLETE"
        : elapsed > FULL_COST_POLICY.cooperativeCeilingCpu ? "CPU_OBSERVED_EXPOSURE_STOP"
        : returned.tickLimit - returned.used < FULL_COST_POLICY.retainedReserveCpu ? "CPU_RESERVE_DEPLETED"
        : returned.bucket < FULL_COST_POLICY.minBucket ? "BUCKET_DEPLETED" : null;
      const stats = preview.stats();
      const receipt = {
        kind: "treasury-full-cost-sample", version: 1, experimentId: FULL_COST_EXPERIMENT,
        tick, sampleOrdinal: ordinal, windowStart: config.startTick, windowEnd: config.endTick,
        authorizesActions: false, performanceTargetCpu: null,
        policy: FULL_COST_POLICY, nativeEntry: entry, nativeReturn: returned,
        elapsedThroughPreviewReturn: elapsed, previewStatus: result.status,
        currentTailProfile: stats.cpuProfile ?? null,
        previousReceiptOverhead, stopsFutureSamples: reason !== null, stopReason: reason,
        measurementBoundary: "before-preview-run_to_after-preview-return",
        exclusions: "receipt preparation/emission is carried by the next receipt; final receipt tail and outer scheduler/flush are not measured here",
      };
      const line = JSON.stringify(receipt);
      // Every field is fixed ASCII or a bounded numeric/enum profile; this is
      // a separate receipt, never a replacement for the unchanged main report.
      if (line.length > FULL_COST_POLICY.maxReceiptBytes) { stop("COST_RECEIPT_TOO_LARGE", tick); return; }
      ports.emit(line);
      const afterReceipt = nativeCpu();
      if (!validNative(afterReceipt) || afterReceipt.used < returned.used
        || afterReceipt.limit !== entry.limit || afterReceipt.tickLimit !== entry.tickLimit) {
        stop("INVALID_RECEIPT_CPU_PROGRESSION", tick); return;
      }
      previousReceiptOverhead = { tick, elapsedAfterPreviewReturn: afterReceipt.used - returned.used };
      if (reason) stop(reason, tick);
      else if (afterReceipt.used - entry.used > FULL_COST_POLICY.cooperativeCeilingCpu
        || afterReceipt.tickLimit - afterReceipt.used < FULL_COST_POLICY.retainedReserveCpu
        || afterReceipt.bucket < FULL_COST_POLICY.minBucket) stop("RECEIPT_OBSERVED_EXPOSURE_STOP", tick);
    } catch { stop("FULL_COST_WRAPPER_FAULT", tick); }
  } };
}

const runtime = createFullCostRuntime(TREASURY_COMPAT_CONFIG, {
  tick: () => Game.time, shard: () => Game.shard.name,
  cpu: () => ({ used: Game.cpu.getUsed(), tickLimit: Game.cpu.tickLimit, bucket: Game.cpu.bucket }),
  room: name => Game.rooms[name], memory: () => Memory, resources: () => RESOURCES_ALL,
  readers: createCompatibilityReadCore, emit: line => console.log(line),
}, () => ({ used: Game.cpu.getUsed(), limit: Game.cpu.limit,
  tickLimit: Game.cpu.tickLimit, bucket: Game.cpu.bucket }));
export function runTreasuryCompatRead(): void { runtime.run(); }
