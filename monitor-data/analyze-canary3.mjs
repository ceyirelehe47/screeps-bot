// Canary3 分析：baseline(canary2-post-deploy, cac532b) vs canary3(9ecc5d5)。
// 口径：cpuProfiler 采样 tick（两侧同为 sampleInterval=7）。
// 输出：total avg/median/p95、top phase 均值对比、bucket 趋势、市场子分解。
import fs from "node:fs";

function findCpuMonitor(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (value.phases && typeof value.totalUsed === "number" && typeof value.tick === "number") {
    return value;
  }
  for (const key of Object.keys(value)) {
    const found = findCpuMonitor(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function loadSamples(path, { warmupSkip = 10, sinceTick = 0 } = {}) {
  const lines = fs.readFileSync(path, "utf8").split("\n").filter(Boolean);
  const samples = [];
  for (const line of lines) {
    try {
      const s = findCpuMonitor(JSON.parse(line)) ?? JSON.parse(line);
      if (
        typeof s.tick === "number" &&
        typeof s.totalUsed === "number" &&
        s.phases &&
        s.tick >= sinceTick
      ) {
        samples.push(s);
      }
    } catch {}
  }
  return samples.slice(warmupSkip);
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function phaseAvg(samples, phase) {
  let sum = 0;
  let n = 0;
  for (const s of samples) {
    const v = s.phases?.[phase];
    if (typeof v === "number") {
      sum += v;
      n += 1;
    }
  }
  return n === 0 ? NaN : sum / n;
}

function bucketSlope(samples) {
  if (samples.length < 2) return NaN;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const ticks = last.tick - first.tick;
  return ticks > 0 ? (last.bucket - first.bucket) / ticks : NaN;
}

function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(2) : "n/a";
}

const PHASES = [
  "marketSalePreflight",
  "marketSaleAutomation",
  "resourceControl",
  "creepWork",
  "creepWork:decision",
  "creepWork:pathing",
  "creepWork:intent",
  "externalTelemetryExport",
  "towerControl",
  "remoteMining",
  "spawnWork",
  "scheduleSpawnTasks",
];

const baselinePath = process.argv[2] || "monitor-data/canary2-post-deploy.jsonl";
const canaryPath = process.argv[3] || "monitor-data/canary3.jsonl";

const base = loadSamples(baselinePath);
const canary = loadSamples(canaryPath, { sinceTick: Number(process.argv[4] || 0) });

const baseSorted = base.map((s) => s.totalUsed).sort((a, b) => a - b);
const canarySorted = canary.map((s) => s.totalUsed).sort((a, b) => a - b);

console.log("=== Canary3 A/B（采样 tick 口径，warmup skip 10） ===");
console.log(`baseline(${baselinePath}): n=${base.length}, tick ${base[0]?.tick}..${base.at(-1)?.tick}`);
console.log(`canary(${canaryPath}):    n=${canary.length}, tick ${canary[0]?.tick}..${canary.at(-1)?.tick}`);
console.log("");
console.log("total     |   avg    |  median  |   p95    | bucket slope/tick");
console.log(`baseline  | ${fmt(baseSorted.reduce((a, b) => a + b, 0) / Math.max(1, baseSorted.length))} | ${fmt(quantile(baseSorted, 0.5))} | ${fmt(quantile(baseSorted, 0.95))} | ${fmt(bucketSlope(base))}`);
console.log(`canary    | ${fmt(canarySorted.reduce((a, b) => a + b, 0) / Math.max(1, canarySorted.length))} | ${fmt(quantile(canarySorted, 0.5))} | ${fmt(quantile(canarySorted, 0.95))} | ${fmt(bucketSlope(canary))}`);
console.log("");
console.log("phase                     | baseline |  canary  |   delta  |  delta%");
for (const phase of PHASES) {
  const b = phaseAvg(base, phase);
  const c = phaseAvg(canary, phase);
  const d = c - b;
  const dp = Number.isFinite(b) && b !== 0 ? (d / b) * 100 : NaN;
  console.log(
    `${phase.padEnd(25)} | ${fmt(b).padStart(8)} | ${fmt(c).padStart(8)} | ${fmt(d).padStart(8)} | ${Number.isFinite(dp) ? dp.toFixed(1) + "%" : "n/a"}`,
  );
}
const marketB = phaseAvg(base, "marketSalePreflight") + phaseAvg(base, "marketSaleAutomation");
const marketC = phaseAvg(canary, "marketSalePreflight") + phaseAvg(canary, "marketSaleAutomation");
console.log("");
console.log(`市场合计: ${fmt(marketB)} -> ${fmt(marketC)} (Δ ${fmt(marketC - marketB)}, ${(Number.isFinite(marketB) ? ((marketC - marketB) / marketB) * 100 : NaN).toFixed(1)}%)`);
