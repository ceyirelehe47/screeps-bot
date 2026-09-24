"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FULL_COST_POLICY = exports.FULL_COST_EXPERIMENT = void 0;
exports.createFullCostRuntime = createFullCostRuntime;
exports.runTreasuryCompatRead = runTreasuryCompatRead;
const treasuryCompatConfig_1 = require("./treasuryCompatConfig");
const treasuryCompatRead_1 = require("./treasuryCompatRead");
const treasuryCompatReadCore_generated_1 = require("./treasuryCompatReadCore.generated");
/** FC1 changes the EXPERIMENT envelope, not either reader or its correctness.
 * 10 CPU is a cooperative exposure ceiling, NOT a performance acceptance line.
 * Native headroom >= 55 and bucket >= 2000 are required before each sample;
 * the unchanged preview checks 25 CPU remaining at its existing boundaries.
 * Neither this wrapper nor a JS checkpoint can preempt a synchronous builder.
 */
exports.FULL_COST_EXPERIMENT = "treasury-full-cost-FC1-online-I-2026-09-24";
exports.FULL_COST_POLICY = Object.freeze({
    cooperativeCeilingCpu: 10, retainedReserveCpu: 25,
    admissionHeadroomCpu: 55, minBucket: 2000, maxReceiptBytes: 16384,
});
const validNative = (c) => !!c && Number.isFinite(c.used) && c.used >= 0
    && Number.isFinite(c.limit) && c.limit > 0 && Number.isFinite(c.tickLimit)
    && c.tickLimit >= c.limit && Number.isSafeInteger(c.bucket) && c.bucket >= 0 && c.bucket <= 10000;
/** Exported seam for deterministic tests. Production supplies REAL native CPU.
 * No code, Memory, Store, index, or resource catalog is warmed outside preview.
 * Retained state is bounded: one preview, one receipt-cost primitive record.
 */
function createFullCostRuntime(config, ports, nativeCpu, factory = treasuryCompatRead_1.createTreasuryCompatPreview) {
    if (!config.enabled)
        return { run() { } };
    const policyValid = (0, treasuryCompatRead_1.validCompatConfig)(config)
        && config.maxSampleCpu === exports.FULL_COST_POLICY.cooperativeCeilingCpu
        && config.reserveCpu === exports.FULL_COST_POLICY.retainedReserveCpu
        && config.minBucket === exports.FULL_COST_POLICY.minBucket
        && config.intervalTicks === 100
        && config.endTick === Math.ceil(config.startTick / 100) * 100 + 300;
    // The historical 5-CPU heap latch is replaced, explicitly, by this wrapper's
    // admission + 10-CPU observed stop. The preview's REAL cooperative checks stay.
    const preview = factory(config, ports, {
        cpuDiagnostics: true, commitmentBoundaryDiagnostics: true,
        taskBoundaryDiagnostics: true, localSafetyStop: false,
    });
    let stopped = false, noticeEmitted = false, ordinal = 0, lastTick = -1;
    let previousReceiptOverhead = null;
    const stop = (reason, tick, native) => {
        stopped = true;
        if (noticeEmitted)
            return;
        noticeEmitted = true;
        try {
            ports.emit(JSON.stringify({ kind: "treasury-compat-safety-stop", version: 1,
                experimentId: exports.FULL_COST_EXPERIMENT, tick, reason, thresholdCpu: 10,
                nativeCpu: native, requiredHeadroomCpu: exports.FULL_COST_POLICY.admissionHeadroomCpu,
                scope: "full_cost_runtime_heap", stopsFutureSamples: true,
                currentCallPreempted: false, authorizesActions: false }));
        }
        catch { /* Keep latched. */ }
    };
    return { run() {
            var _a;
            if (stopped)
                return;
            let tick = null;
            try {
                tick = ports.tick();
                if (!Number.isSafeInteger(tick) || tick < 0) {
                    stop("INVALID_TICK", null);
                    return;
                }
                if (!policyValid) {
                    stop("FULL_COST_PROFILE_INVALID", tick);
                    return;
                }
                if (tick < config.startTick || tick > config.endTick || tick % 100 !== 0 || tick === lastTick)
                    return;
                lastTick = tick;
                if (ports.shard() !== config.shardName) {
                    stop("WRONG_SHARD", tick);
                    return;
                }
                if (ordinal === 0 && tick !== Math.ceil(config.startTick / 100) * 100) {
                    stop("WINDOW_RESTART_UNPROVEN", tick);
                    return;
                }
                const entry = nativeCpu();
                if (!validNative(entry)) {
                    stop("INVALID_NATIVE_CPU", tick);
                    return;
                }
                if (entry.bucket < exports.FULL_COST_POLICY.minBucket
                    || entry.tickLimit - entry.used < exports.FULL_COST_POLICY.admissionHeadroomCpu) {
                    // No opportunistic resampling at another tick and no fabricated zero.
                    stop("INSUFFICIENT_NATIVE_HEADROOM", tick, entry);
                    return;
                }
                ordinal += 1;
                const result = preview.run();
                const returned = nativeCpu();
                if (!validNative(returned) || returned.used < entry.used
                    || returned.limit !== entry.limit || returned.tickLimit !== entry.tickLimit) {
                    stop("INVALID_NATIVE_CPU_PROGRESSION", tick);
                    return;
                }
                const elapsed = returned.used - entry.used;
                const reason = result.status !== "sampled" ? "PREVIEW_NOT_COMPLETE"
                    : elapsed > exports.FULL_COST_POLICY.cooperativeCeilingCpu ? "CPU_OBSERVED_EXPOSURE_STOP"
                        : returned.tickLimit - returned.used < exports.FULL_COST_POLICY.retainedReserveCpu ? "CPU_RESERVE_DEPLETED"
                            : returned.bucket < exports.FULL_COST_POLICY.minBucket ? "BUCKET_DEPLETED" : null;
                const stats = preview.stats();
                const receipt = {
                    kind: "treasury-full-cost-sample", version: 1, experimentId: exports.FULL_COST_EXPERIMENT,
                    tick, sampleOrdinal: ordinal, windowStart: config.startTick, windowEnd: config.endTick,
                    authorizesActions: false, performanceTargetCpu: null,
                    policy: exports.FULL_COST_POLICY, nativeEntry: entry, nativeReturn: returned,
                    elapsedThroughPreviewReturn: elapsed, previewStatus: result.status,
                    currentTailProfile: (_a = stats.cpuProfile) !== null && _a !== void 0 ? _a : null,
                    previousReceiptOverhead, stopsFutureSamples: reason !== null, stopReason: reason,
                    measurementBoundary: "before-preview-run_to_after-preview-return",
                    exclusions: "receipt preparation/emission is carried by the next receipt; final receipt tail and outer scheduler/flush are not measured here",
                };
                const line = JSON.stringify(receipt);
                // Every field is fixed ASCII or a bounded numeric/enum profile; this is
                // a separate receipt, never a replacement for the unchanged main report.
                if (line.length > exports.FULL_COST_POLICY.maxReceiptBytes) {
                    stop("COST_RECEIPT_TOO_LARGE", tick);
                    return;
                }
                ports.emit(line);
                const afterReceipt = nativeCpu();
                if (!validNative(afterReceipt) || afterReceipt.used < returned.used
                    || afterReceipt.limit !== entry.limit || afterReceipt.tickLimit !== entry.tickLimit) {
                    stop("INVALID_RECEIPT_CPU_PROGRESSION", tick);
                    return;
                }
                previousReceiptOverhead = { tick, elapsedAfterPreviewReturn: afterReceipt.used - returned.used };
                if (reason)
                    stop(reason, tick);
                else if (afterReceipt.used - entry.used > exports.FULL_COST_POLICY.cooperativeCeilingCpu
                    || afterReceipt.tickLimit - afterReceipt.used < exports.FULL_COST_POLICY.retainedReserveCpu
                    || afterReceipt.bucket < exports.FULL_COST_POLICY.minBucket)
                    stop("RECEIPT_OBSERVED_EXPOSURE_STOP", tick);
            }
            catch {
                stop("FULL_COST_WRAPPER_FAULT", tick);
            }
        } };
}
const runtime = createFullCostRuntime(treasuryCompatConfig_1.TREASURY_COMPAT_CONFIG, {
    tick: () => Game.time, shard: () => Game.shard.name,
    cpu: () => ({ used: Game.cpu.getUsed(), tickLimit: Game.cpu.tickLimit, bucket: Game.cpu.bucket }),
    room: name => Game.rooms[name], memory: () => Memory, resources: () => RESOURCES_ALL,
    readers: treasuryCompatReadCore_generated_1.createCompatibilityReadCore, emit: line => console.log(line),
}, () => ({ used: Game.cpu.getUsed(), limit: Game.cpu.limit,
    tickLimit: Game.cpu.tickLimit, bucket: Game.cpu.bucket }));
function runTreasuryCompatRead() { runtime.run(); }
