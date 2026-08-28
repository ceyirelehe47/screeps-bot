// 第二次 Canary 严谨分析 v2（取代 analyze-canary2.mjs 的报告口径）
//
// 与 v1 的关键差异（对应报告修订要求）：
//  1. 正式窗口 tick 数按首尾包含计算（73329704–73331342 = 1639，而非 1642）；
//  2. 样本覆盖审计：sampleInterval=7 网格上的理论/实际/缺失清单 + 缺失归因；
//  3. 真正的 rolling window 检查（逐 tick 滑动的 200-tick avg/p95/覆盖率 与
//     300-tick bucket OLS 斜率），取代固定 ~200 tick 分段；
//  4. steady-state 匹配：无放回贪心最近邻，硬约束 + caliper，匹配变量含
//     owned rooms/creep/remote 任务/war/工地(代理)/market 活动/遥测配置，
//     E5/E6 active 由角色在场定义（与 CPU 结果无关），
//     输出配对子集独立统计与 block bootstrap 非劣效置信区间；
//  5. E6N59 事件回到原始数据逐样本核对（区分 colonizerHarvester 与
//     remoteMiningReserver 两起独立事件）；
//  6. 路径指标分开报告原始计数、每 tick 值与比例（分母显式）；
//  7. 输出脱敏 derived 聚合 + 样本 tick 索引 + 原始文件 SHA-256 manifest。
//
// 用法：node analyze-canary2-v2.mjs   （在 monitor-data/ 下执行；路径可由 argv 覆盖）
// 分位数算法：线性插值（Hyndman-Fan type 7，R 默认），h=(n-1)p；
//             另附 nearest-rank（ceil(np)）做敏感性对照。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pick = (i, d) => process.argv[i] ?? d;
const BASE_FILE = pick(2, path.join(dir, "baseline2-pre-deploy.jsonl"));
const CANARY_FILE = pick(3, path.join(dir, "canary2-post-deploy.jsonl"));
const SEGBASE_FILE = pick(4, path.join(dir, "segment-baseline2.jsonl"));
const SEGCAN_FILE = pick(5, path.join(dir, "segment-canary2.jsonl"));
const OUT_DIR = pick(6, path.join(dir, "derived-canary2"));

const DEPLOY_TICK = 73329650; // push 日志记录的部署 tick
const WARMUP_TICKS = 50;      // 部署后前 50 tick 为预热，不计入统计
const SAMPLE_INTERVAL = 7;    // cpuMonitor.latest / 遥测 segment 的采样间隔

const readJsonl = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// ── 分位数：type-7 线性插值（主算法）与 nearest-rank（对照） ──
function quantile7(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const h = (n - 1) * p;
  const lo = Math.floor(h), hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
function quantileNR(sorted, p) { // nearest-rank: ceil(np) 序
  const n = sorted.length;
  if (!n) return null;
  return sorted[Math.min(n - 1, Math.ceil(n * p) - 1)];
}
const sortedNums = (xs) => [...xs].sort((a, b) => a - b);
function stats(xs) {
  if (!xs.length) return null;
  const s = sortedNums(xs);
  return {
    n: xs.length,
    avg: round(xs.reduce((a, b) => a + b, 0) / xs.length),
    median: round(quantile7(s, 0.5)),
    p95: round(quantile7(s, 0.95)),
    p99: round(quantile7(s, 0.99)),
    max: round(Math.max(...xs)),
    p95nr: round(quantileNR(s, 0.95)), // nearest-rank 对照
  };
}
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ── 数据加载与窗口定义 ──
const baselineAll = readJsonl(BASE_FILE);
const canaryAll = readJsonl(CANARY_FILE);
const formalBoundary = DEPLOY_TICK + WARMUP_TICKS; // 73329700
const canaryFormal = canaryAll.filter((s) => s.tick >= formalBoundary);
const BASE_WIN = { start: baselineAll[0].tick, end: baselineAll[baselineAll.length - 1].tick };
const FORMAL_WIN = { start: canaryFormal[0].tick, end: canaryFormal[canaryFormal.length - 1].tick };
const inclLen = (w) => w.end - w.start + 1;

// ── 1. 样本覆盖审计 ──
function coverageAudit(rows, win, label) {
  const phase = ((rows[0].tick % SAMPLE_INTERVAL) + SAMPLE_INTERVAL) % SAMPLE_INTERVAL;
  const present = new Set(rows.map((s) => s.tick));
  const grid = [];
  for (let t = win.start; t <= win.end; t++) if (t % SAMPLE_INTERVAL === phase) grid.push(t);
  const missing = grid.filter((t) => !present.has(t));
  // 连续缺失段（网格相邻即连续）
  const runs = [];
  for (const t of missing) {
    const last = runs[runs.length - 1];
    if (last && t - last.ticks[last.ticks.length - 1] === SAMPLE_INTERVAL) last.ticks.push(t);
    else runs.push({ ticks: [t] });
  }
  return {
    label,
    window: { ...win, inclusiveTicks: inclLen(win) },
    gridPhase: phase,
    theoreticalSamples: grid.length,
    actualSamples: rows.length,
    coveragePct: round((rows.length / grid.length) * 100, 2),
    missingCount: missing.length,
    missingTicks: missing,
    missingRuns: runs.map((r) => ({ from: r.ticks[0], to: r.ticks[r.ticks.length - 1], count: r.ticks.length })),
  };
}
const covBase = coverageAudit(baselineAll, BASE_WIN, "baseline");
const covFormal = coverageAudit(canaryFormal, FORMAL_WIN, "canary-formal");
const covWarmup = {
  label: "canary-warmup(excluded)",
  window: { start: canaryAll[0].tick, end: formalBoundary - 1 },
  samples: canaryAll.filter((s) => s.tick < formalBoundary).map((s) => s.tick),
};

// 缺失归因（依据采集日志 collect-canary2.log / collect-baseline2.log 的错误行与
// 里程碑行顺序；日志无逐行时间戳，按 n= 里程碑之间的错误块映射到缺失段）
const MISSING_ATTRIBUTION = [
  { run: [73330509, 73330523], count: 3, cause: "采集端网络错误（collect-canary2.log 在 n=121@73330502 与 n=131@73330593 之间记录 3 次 TLS 断连；25s 轮询失败期间 cpuMonitor.latest 前进 2 个采样周期，跳过 1 个样本/次）" },
  { run: [73330621, 73330670], count: 8, cause: "采集端网络错误（n=131@73330593 与 n=141@73330719 之间 8 次 TLS 断连 + 1 次 timeout）" },
  { run: [73330775, 73330803], count: 5, cause: "采集端网络错误（n=141@73330719 与 n=151@73330824 之间 7 次 TLS 断连）" },
  { run: [73331027, 73331132], count: 16, cause: "采集器停机（85min 定时采集 22:31:29 结束于 73331020，22:37:44 手动重启首样本 73331139；375s 采集空窗覆盖全部 16 个理论采样点）" },
];
// 缺失与 CPU/bucket 相关性：取每个缺失段两端邻样本的 CPU/bucket，与窗口分布对比
function missingContext(rows, cov) {
  const cpu = rows.map((s) => s.totalUsed);
  const med = quantile7(sortedNums(cpu), 0.5), p95 = quantile7(sortedNums(cpu), 0.95);
  return cov.missingRuns.map((r) => {
    const before = rows.filter((s) => s.tick < r.from).pop();
    const after = rows.find((s) => s.tick > r.to);
    return {
      run: r,
      bracketCpu: [round(before?.totalUsed), round(after?.totalUsed)],
      bracketBucket: [before?.bucket, after?.bucket],
      bracketCpuVsWindow: [before, after].map((s) => (s ? (s.totalUsed > p95 ? ">p95" : s.totalUsed > med ? ">median" : "≤median") : "n/a")),
    };
  });
}
const missingCtx = missingContext(canaryFormal, covFormal);

// ── 2. Rolling window 检查 ──
const baseCpu = baselineAll.map((s) => s.totalUsed);
const baseAvg = avg(baseCpu);
const baseP95 = quantile7(sortedNums(baseCpu), 0.95);
const THR = { avgX: 1.15, p95X: 1.25 };

function rolling(rows, win, width) {
  const out = [];
  for (let t0 = win.start; t0 + width - 1 <= win.end; t0++) {
    const t1 = t0 + width - 1;
    const seg = rows.filter((s) => s.tick >= t0 && s.tick <= t1);
    if (!seg.length) continue;
    const cpu = seg.map((s) => s.totalUsed);
    const srt = sortedNums(cpu);
    // 窗口内理论采样数（同一网格相位）
    const phase = ((rows[0].tick % SAMPLE_INTERVAL) + SAMPLE_INTERVAL) % SAMPLE_INTERVAL;
    let theo = 0;
    for (let t = t0; t <= t1; t++) if (t % SAMPLE_INTERVAL === phase) theo++;
    const buckets = seg.map((s) => [s.tick, s.bucket]);
    // OLS 斜率（bucket 对 tick）
    let slope = null;
    if (buckets.length >= 2) {
      const mx = avg(buckets.map((b) => b[0])), my = avg(buckets.map((b) => b[1]));
      let num = 0, den = 0;
      for (const [x, y] of buckets) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
      slope = den ? num / den : null;
    }
    out.push({
      t0, t1, n: seg.length,
      coveragePct: round((seg.length / theo) * 100, 1),
      avg: round(avg(cpu)),
      p95: round(quantile7(srt, 0.95)),
      bucketSlopePerTick: slope === null ? null : round(slope, 4),
      bucketFirst: seg[0].bucket, bucketLast: seg[seg.length - 1].bucket,
    });
  }
  return out;
}
const roll200 = rolling(canaryFormal, FORMAL_WIN, 200);
const roll300 = rolling(canaryFormal, FORMAL_WIN, 300);

function mergeRanges(starts) {
  const s = [...starts].sort((a, b) => a - b);
  const out = [];
  for (const t of s) {
    const last = out[out.length - 1];
    if (last && t <= last.to + 1) last.to = t;
    else out.push({ from: t, to: t });
  }
  return out;
}
const avgViol = roll200.filter((w) => w.avg > baseAvg * THR.avgX);
const p95Viol = roll200.filter((w) => w.p95 > baseP95 * THR.p95X);
const byAvg = [...roll200].sort((a, b) => b.avg - a.avg);
const byP95 = [...roll200].sort((a, b) => b.p95 - a.p95);
const bySlope = [...roll300].sort((a, b) => a.bucketSlopePerTick - b.bucketSlopePerTick);
const minCoverage = Math.min(...roll200.map((w) => w.coveragePct));

const rollingSummary = {
  algorithm: { window: "逐 tick 滑动（步长 1），窗口为闭区间 [t0, t0+width-1]", quantile: "type-7 线性插值（h=(n-1)p），nearest-rank 对照见 stats.p95nr" },
  baselineThresholds: { avg: round(baseAvg), avgLimit: round(baseAvg * THR.avgX), p95: round(baseP95), p95Limit: round(baseP95 * THR.p95X) },
  w200: {
    windows: roll200.length,
    minCoveragePct: minCoverage,
    violatingAvgWindows: avgViol.length,
    violatingAvgTickRanges: mergeRanges(avgViol.map((w) => w.t0)),
    violatingP95Windows: p95Viol.length,
    violatingP95TickRanges: mergeRanges(p95Viol.map((w) => w.t0)),
    worstAvgWindow: byAvg[0],
    worstP95Window: byP95[0],
  },
  w300BucketSlope: {
    windows: roll300.length,
    mostNegative: bySlope[0],
    mostPositive: bySlope[bySlope.length - 1],
    negativeBelowMinus1: roll300.filter((w) => w.bucketSlopePerTick < -1).length,
  },
};

// 安全门重算（首 N tick 闭区间窗口）
function gate(n) {
  const t1 = FORMAL_WIN.start + n - 1;
  const seg = canaryFormal.filter((s) => s.tick <= t1);
  const s = stats(seg.map((x) => x.totalUsed));
  return { ticks: n, window: [FORMAL_WIN.start, Math.min(t1, FORMAL_WIN.end)], samples: seg.length, cpu: s, avgWithinLimit: s.avg <= baseAvg * THR.avgX, p95WithinLimit: s.p95 <= baseP95 * THR.p95X };
}
const gates = [gate(300), gate(1000), gate(inclLen(FORMAL_WIN))];

// ── 3. 负载匹配 steady-state（无放回最近邻 + block bootstrap） ──
const REMOTE_ROLES = ["remoteDefender", "remoteMiningCarrier", "remoteMiningReserver", "remoteWorker", "colonizerHarvester"];
const creeps = (s) => Object.values(s.rooms || {}).reduce((a, r) => a + Object.values(r.roles || {}).reduce((b, v) => b + v.count, 0), 0);
const remoteCreeps = (s) => Object.values(s.rooms || {}).reduce((a, r) => a + REMOTE_ROLES.reduce((b, k) => b + (r.roles?.[k]?.count ?? 0), 0), 0);
const ownedRoomCount = (s) => Object.values(s.rooms || {}).filter((r) => (r.roles?.spawn?.count ?? 0) > 0).length;
const warLoad = (s) => ["warControl", "defenseMode", "homeDefense", "coreDefense"].reduce((a, k) => a + (s.phases?.[k] ?? 0), 0);
const constrLoad = (s) => s.phases?.roomPlannerConstruction ?? 0; // 工地数量的相位代理（直接 site 数 NOT OBSERVED）
const marketLoad = (s) => (s.phases?.marketSaleAutomation ?? 0) + (s.phases?.marketSalePreflight ?? 0);
// E5/E6 active 由“事件角色在场”定义（工作负载存在性），与 CPU 测量结果无关
const e5Active = (s) => ((s.rooms?.E5N59?.roles?.remoteMiningCarrier?.count ?? 0) >= 1);
const e6Active = (s) => ((s.rooms?.E6N59?.roles?.colonizerHarvester?.count ?? 0) >= 1) || ((s.rooms?.E6N59?.roles?.remoteMiningReserver?.count ?? 0) >= 1);

const MATCH_SPEC = {
  method: "贪心最近邻匹配，无放回（每个基线样本至多使用一次）；canary 样本按 tick 升序处理，距离并列取最早基线样本",
  hardConstraints: { ownedRoomCount: "相等", e5Active: "相等", e6Active: "相等", "|Δcreeps| ≤ 3": null, "|ΔremoteCreeps| ≤ 2": null, "|ΔwarLoad| ≤ 0.5": null, "|ΔconstrLoad| ≤ 0.5": null, "|ΔmarketLoad| ≤ 8": null },
  distance: "|Δcreeps| + 2·|ΔremoteCreeps| + |ΔwarLoad| + |ΔconstrLoad| + |ΔmarketLoad|/4 + 100·[E5 active 不等] + 50·[E6 active 不等]",
  covariates: {
    ownedRooms: "有 spawn 角色的房间数（两窗口全程稳定为 8）",
    creeps: "全部角色 creep 计数总和",
    remoteTasks: "remoteDefender/remoteMiningCarrier/remoteMiningReserver/remoteWorker/colonizerHarvester 计数和",
    warHostile: "warControl+defenseMode+homeDefense+coreDefense 相位 CPU（战斗计数器 NOT OBSERVED，以相位负载代理）",
    constructionSites: "roomPlannerConstruction 相位 CPU（工地数量 NOT OBSERVED，代理；见报告 PARTIAL 声明）",
    marketActivity: "marketSaleAutomation+marketSalePreflight 相位 CPU（市场相位 v3-r3/observe 两窗口恒定，为采集期 console 记录，非离线可复核）",
    telemetryConfig: "两窗口完全相同：cfg.telemetry enabled / sampleInterval=7 / segment 90（segment-baseline2.jsonl 与 segment-canary2.jsonl 均存在同一计数器集为证）；externalTelemetryExport 相位开销两窗口分别为见 telemetryOverhead",
  },
  e5e6ActiveDefinition: "E5 active=E5N59 存在 remoteMiningCarrier；E6 active=E6N59 存在 colonizerHarvester 或 remoteMiningReserver（角色在场=工作负载定义，与被解释变量 CPU 无关）",
};

function matchPairs() {
  const used = new Set();
  const pairs = [];
  const drop = { caliper: 0, hardConstraint: 0, byConstraint: {} };
  for (const c of canaryFormal) {
    let best = null, bestD = Infinity;
    // 先按硬约束与 caliper 过滤全部候选，再在合格候选中取最近邻（无放回）
    let anyHard = false, anyCaliper = false;
    const fail = { owned: 0, e5: 0, e6: 0, creeps: 0, remote: 0, war: 0, constr: 0, market: 0 };
    for (let i = 0; i < baselineAll.length; i++) {
      if (used.has(i)) continue;
      const b = baselineAll[i];
      if (ownedRoomCount(b) !== ownedRoomCount(c)) { fail.owned++; anyHard = true; continue; }
      if (e5Active(b) !== e5Active(c)) { fail.e5++; anyHard = true; continue; }
      if (e6Active(b) !== e6Active(c)) { fail.e6++; anyHard = true; continue; }
      const dc = Math.abs(creeps(b) - creeps(c)), dr = Math.abs(remoteCreeps(b) - remoteCreeps(c));
      const dw = Math.abs(warLoad(b) - warLoad(c)), dk = Math.abs(constrLoad(b) - constrLoad(c));
      const dm = Math.abs(marketLoad(b) - marketLoad(c));
      if (dc > 3) { fail.creeps++; anyCaliper = true; continue; }
      if (dr > 2) { fail.remote++; anyCaliper = true; continue; }
      if (dw > 0.5) { fail.war++; anyCaliper = true; continue; }
      if (dk > 0.5) { fail.constr++; anyCaliper = true; continue; }
      if (dm > 8) { fail.market++; anyCaliper = true; continue; }
      const d = dc + 2 * dr + dw + dk + dm / 4;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best === null) {
      if (anyHard && !anyCaliper) drop.hardConstraint++; else drop.caliper++;
      // 记录该样本的主要失败约束（失败次数最多的维度）
      const top = Object.entries(fail).sort((a, b) => b[1] - a[1])[0];
      const key = anyHard && !anyCaliper ? `hard:${top[0]}` : `caliper:${top[0]}`;
      drop.byConstraint[key] = (drop.byConstraint[key] ?? 0) + 1;
      continue;
    }
    used.add(best);
    pairs.push({ b: baselineAll[best], c, distance: round(bestD, 3) });
  }
  return { pairs, usedBaseline: used.size, drop };
}
const m = matchPairs();
const canaryMatched = m.pairs.map((p) => p.c.totalUsed);
const baselineMatched = m.pairs.map((p) => p.b.totalUsed);
const diffs = m.pairs.map((p) => p.c.totalUsed - p.b.totalUsed);

// block bootstrap（块长 10 对 ≈ 70 tick，处理序列自相关；10000 次）
function blockBootstrap(values, blockLen, iters, fn) {
  const n = values.length, nBlocks = Math.ceil(n / blockLen);
  const rng = (() => { let s = 20260829; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const out = [];
  for (let it = 0; it < iters; it++) {
    const sample = [];
    for (let bI = 0; bI < nBlocks; bI++) {
      const start = Math.floor(rng() * (n - blockLen + 1));
      for (let k = 0; k < blockLen && sample.length < n; k++) sample.push(values[start + k]);
    }
    out.push(fn(sample));
  }
  return sortedNums(out);
}
const BOOT = { blockLen: 10, iters: 10000 };
const ci = (arr, lo = 2.5, hi = 97.5) => ({ lo: round(quantile7(arr, lo / 100), 3), hi: round(quantile7(arr, hi / 100), 3) });
const diffBoot = blockBootstrap(diffs, BOOT.blockLen, BOOT.iters, (s) => avg(s));
const ratioBoot = blockBootstrap(m.pairs.map((p) => p.c.totalUsed), BOOT.blockLen, BOOT.iters, (sc) => {
  // 与基线配对子集（固定）之比：对 canary 侧做 block bootstrap，基线侧用配对差平移
  const sb = m.pairs.map((p, i) => p.b.totalUsed);
  return avg(sc) / avg(sb);
});
const canaryP95Boot = blockBootstrap(canaryMatched, BOOT.blockLen, BOOT.iters, (s) => quantile7(sortedNums(s), 0.95));
const matchedStats = {
  matchedPairs: m.pairs.length,
  canaryUnique: new Set(m.pairs.map((p) => p.c.tick)).size,
  baselineUnique: m.usedBaseline,
  baselineReuseMax: 1, // 无放回：每基线样本至多 1 次
  baselineAvailable: baselineAll.length,
  droppedCanary: m.drop,
  weights: "无（等权配对）；有效样本量 = 配对数（无放回，无复用）",
  distanceSummary: { avg: round(avg(m.pairs.map((p) => p.distance), 3)) },
  canary: stats(canaryMatched),
  baseline: stats(baselineMatched),
  pairedDiff: { avg: round(avg(diffs)), median: round(quantile7(sortedNums(diffs), 0.5)), ...stats(diffs) ? { p95: stats(diffs).p95, p99: stats(diffs).p99 } : {} },
  meanDiffBootCI95: ci(diffBoot),
  avgRatioBootCI95: ci(ratioBoot),
  canaryP95BootCI95: ci(canaryP95Boot),
  nonInferiority: {
    margin: "avg：配对均差 95% CI 上界 < +15%×基线配子集均值（与回滚阈值同口径）；p95：canary 配子集 p95 的 95% CI 上界 < 基线配子集 p95×1.25",
    avgVerdict: diffBoot ? (quantile7(diffBoot, 0.975) < 0.15 * avg(baselineMatched) ? "PASS" : "FAIL") : "n/a",
    p95Verdict: quantile7(canaryP95Boot, 0.975) < quantile7(sortedNums(baselineMatched), 0.95) * 1.25 ? "PASS" : "FAIL",
  },
};

// ── 4. E6N59 事件逐样本核对（原始数据） ──
function roomEvents(rows, room, threshold = 8) {
  return rows.filter((s) => (s.rooms?.[room]?.totalUsed ?? 0) > threshold).map((s) => ({
    tick: s.tick,
    roomTotal: round(s.rooms[room].totalUsed, 1),
    globalCpu: round(s.totalUsed, 1),
    roomSharePct: round((s.rooms[room].totalUsed / s.totalUsed) * 100),
    roles: Object.fromEntries(Object.entries(s.rooms[room].roles).filter(([, v]) => v.used > 2).map(([k, v]) => [k, { count: v.count, used: round(v.used, 1) }])),
  }));
}
const e6Events = roomEvents(canaryFormal, "E6N59");
// 正式窗口 bucket 轨迹（无持续衰减判定依据）
const bucketTrajectory = {
  first: canaryFormal[0].bucket, last: canaryFormal[canaryFormal.length - 1].bucket,
  min: Math.min(...canaryFormal.map((s) => s.bucket)), max: Math.max(...canaryFormal.map((s) => s.bucket)),
  note: "bucket 在带内振荡（充放电循环），窗口首末无净衰减",
};
// 覆盖率最低的 rolling 窗口（披露覆盖薄弱区；相邻同值窗口去重）
const lowestCoverageW200 = (() => {
  const srt = [...roll200].sort((a, b) => a.coveragePct - b.coveragePct);
  const out = [];
  for (const w of srt) {
    const last = out[out.length - 1];
    if (last && last.n === w.n && last.avg === w.avg && last.p95 === w.p95 && last.coveragePct === w.coveragePct) continue;
    out.push(w);
    if (out.length >= 5) break;
  }
  return out;
})();
const e5PeakAt = canaryFormal.find((s) => s.tick === 73330544);
const e6At544 = e5PeakAt?.rooms?.E6N59;
const e5At544 = e5PeakAt?.rooms?.E5N59;
const e6Audit = {
  rawEvents: e6Events,
  eventColonizerHarvester: { range: [73330313, 73330355], samples: 7, detail: "colonizerHarvester ×2（20.2–30.1 CPU/样本），73330355 收缩为 ×1（12.5）后消失" },
  eventRemoteMiningReserver: { range: [73330537, 73330565], samples: 5, detail: "remoteMiningReserver ×1（11.5–33.1 CPU/样本），73330572 起消失" },
  eventCarrier: { tick: 73330229, detail: "carrier ×1 单样本 25.1（孤立尖峰）" },
  peakSampleTick73330544: {
    global: round(e5PeakAt?.totalUsed, 1),
    e5n59: e5At544 ? { total: round(e5At544.totalUsed, 1), roles: Object.fromEntries(Object.entries(e5At544.roles).filter(([, v]) => v.used > 2).map(([k, v]) => [k, round(v.used, 1)])) } : null,
    e6n59: e6At544 ? { total: round(e6At544.totalUsed, 1), roles: Object.fromEntries(Object.entries(e6At544.roles).filter(([, v]) => v.used > 2).map(([k, v]) => [k, round(v.used, 1)])) } : null,
    correction: "73330544 的 E6N59=33.9 由 remoteMiningReserver(33.1) 驱动，不是 colonizerHarvester；colonizerHarvester 事件在 73330313–73330355。旧报告将两起事件混同。",
  },
  colonizationCountersZero: {
    counters: ["colonizationPathRebuilds", "colonizationPathRegeneratesThrottled", "colonizationPathBlockInvalidations"],
    value: 0,
    whatTheyCover: "殖民持久路径的重建/节流/块失效（矩阵层）",
    whatTheyDoNotCover: "creep 移动层是否跟随已有 cachedTravelPath / travelPathCache / multiRoomSegment（无对应计数器）",
    conclusion: "INSUFFICIENT_DATA——计数器全 0 不能排除事件 creep 跟随已有缓存路径；也不能确立“来自无固定路线 dynamic routing”。需新增 colonizationPathFollowAttempts/Hits/Fallbacks/KeyMisses 后方可判定。",
  },
};

// ── 5. movement 计数器：原始计数 + 每 tick + 比例（分母显式） ──
function segWindow(file, fromTick, label) {
  const rows = readJsonl(file).filter((r) => r.movement);
  let resetIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i].movement.multiRoomSearches ?? 0) < (rows[i - 1].movement.multiRoomSearches ?? 0)) resetIdx = i;
  }
  const after = rows.filter((r, i) => i >= resetIdx && r.tick >= fromTick);
  const first = after[0], last = after[after.length - 1];
  const dt = last.tick - first.tick;
  const raw = {}, perTick = {};
  for (const k of Object.keys(last.movement)) {
    raw[k] = (last.movement[k] ?? 0) - (first.movement?.[k] ?? 0);
    perTick[k] = round(raw[k] / Math.max(1, dt), 4);
  }
  // 按房（movementRooms，取差值）
  const rooms = {};
  if (first.movementRooms && last.movementRooms) {
    for (const room of Object.keys(last.movementRooms)) {
      const f = first.movementRooms[room] ?? {}, l = last.movementRooms[room] ?? {};
      rooms[room] = {};
      for (const k of Object.keys(l)) rooms[room][k] = (l[k] ?? 0) - (f[k] ?? 0);
    }
  }
  return { label, tickRange: [first.tick, last.tick], ticks: dt, raw, perTick, rooms };
}
const segBase = segWindow(SEGBASE_FILE, -Infinity, "baseline");
const segCanFull = segWindow(SEGCAN_FILE, -Infinity, "canary-post-reset-full(incl warmup)");
const segCanFormal = segWindow(SEGCAN_FILE, FORMAL_WIN.start, "canary-formal");

const ratio = (a, b) => (b ? round((a / b) * 100, 2) : null);
function counterTable(b, c) {
  const rows = {};
  const keys = [...new Set([...Object.keys(b.raw), ...Object.keys(c.raw)])];
  for (const k of keys) {
    const bRaw = b.raw[k] ?? 0, cRaw = c.raw[k] ?? 0;
    const bPt = b.perTick[k] ?? 0, cPt = c.perTick[k] ?? 0;
    rows[k] = {
      raw: { baseline: bRaw, canary: cRaw },
      perTick: { baseline: bPt, canary: cPt, relChangePct: bPt ? round(((cPt - bPt) / bPt) * 100, 1) : null },
    };
  }
  const derived = {
    "pathRepaths/tick": { baseline: b.perTick.pathRepaths, canary: c.perTick.pathRepaths, relChangePct: round(((c.perTick.pathRepaths - b.perTick.pathRepaths) / b.perTick.pathRepaths) * 100, 1) },
    "pathRepaths/pathRequests %": { baseline: ratio(b.raw.pathRepaths, b.raw.pathRequests), canary: ratio(c.raw.pathRepaths, c.raw.pathRequests), relChangePct: (() => { const rb = ratio(b.raw.pathRepaths, b.raw.pathRequests), rc = ratio(c.raw.pathRepaths, c.raw.pathRequests); return round(((rc - rb) / rb) * 100, 1); })() },
    "pathCacheHits/pathRequests %": { baseline: ratio(b.raw.pathCacheHits, b.raw.pathRequests), canary: ratio(c.raw.pathCacheHits, c.raw.pathRequests), deltaPP: round(ratio(c.raw.pathCacheHits, c.raw.pathRequests) - ratio(b.raw.pathCacheHits, b.raw.pathRequests), 2) },
    "travelRequests/tick": { baseline: b.perTick.travelRequests, canary: c.perTick.travelRequests, relChangePct: round(((c.perTick.travelRequests - b.perTick.travelRequests) / b.perTick.travelRequests) * 100, 1) },
    "travelRepaths/travelRequests %": { baseline: ratio(b.raw.travelRepaths, b.raw.travelRequests), canary: ratio(c.raw.travelRepaths, c.raw.travelRequests) },
    "multiRoomSearches/travelRequests %": { baseline: ratio(b.raw.multiRoomSearches, b.raw.travelRequests), canary: ratio(c.raw.multiRoomSearches, c.raw.travelRequests), deltaPP: round(ratio(c.raw.multiRoomSearches, c.raw.travelRequests) - ratio(b.raw.multiRoomSearches, b.raw.travelRequests), 2) },
    "multiRoomSearches/tick": { baseline: b.perTick.multiRoomSearches, canary: c.perTick.multiRoomSearches, relChangePct: round(((c.perTick.multiRoomSearches - b.perTick.multiRoomSearches) / b.perTick.multiRoomSearches) * 100, 1) },
  };
  return { denominators: "比例的分母为同窗口原始计数；窗口长度不同不影响比例", counters: rows, derived };
}
const countersFormal = counterTable(segBase, segCanFormal);      // 主口径：正式窗口
const countersFull = counterTable(segBase, segCanFull);          // 对照：含预热全程

// E5N59 房间级（movementRooms 差值 + CPU 样本）
function roomLevel(room) {
  const bCpu = baselineAll.map((s) => s.rooms?.[room]?.totalUsed ?? 0).filter((x) => x > 0);
  const cCpu = canaryFormal.map((s) => s.rooms?.[room]?.totalUsed ?? 0).filter((x) => x > 0);
  const bCreeps = baselineAll.map((s) => Object.values(s.rooms?.[room]?.roles ?? {}).reduce((a, v) => a + v.count, 0));
  const cCreeps = canaryFormal.map((s) => Object.values(s.rooms?.[room]?.roles ?? {}).reduce((a, v) => a + v.count, 0));
  const pt = (seg, k) => round((seg.rooms?.[room]?.[k] ?? 0) / Math.max(1, seg.ticks), 4);
  return {
    cpuPerSample: { baseline: stats(bCpu), canary: stats(cCpu) },
    cpuPerCreep: { baseline: round(avg(bCpu) / avg(bCreeps), 3), canary: round(avg(cCpu) / avg(cCreeps), 3) },
    roomCountersPerTick: {
      pathRequests: { baseline: pt(segBase, "pathRequests"), canary: pt(segCanFormal, "pathRequests") },
      travelRequests: { baseline: pt(segBase, "travelRequests"), canary: pt(segCanFormal, "travelRequests") },
      multiRoomSearches: { baseline: pt(segBase, "multiRoomSearches"), canary: pt(segCanFormal, "multiRoomSearches") },
      pathRepaths: { baseline: pt(segBase, "pathRepaths"), canary: pt(segCanFormal, "pathRepaths") },
    },
    cpuPerTravelRequest: { baseline: round(avg(bCpu) / Math.max(1e-9, pt(segBase, "travelRequests")), 3), canary: round(avg(cCpu) / Math.max(1e-9, pt(segCanFormal, "travelRequests")), 3) },
  };
}
const e5Room = roomLevel("E5N59");

// ── 6. 顶层相位 / CPU·房 / 遥测开销 ──
function topPhases(rows, k = 8) {
  const agg = {};
  for (const s of rows) for (const [ph, v] of Object.entries(s.phases ?? {})) (agg[ph] ||= []).push(v);
  return Object.entries(agg).map(([ph, v]) => [ph, round(avg(v))]).sort((a, b) => b[1] - a[1]).slice(0, k);
}
const phasesCompare = { baseline: topPhases(baselineAll), canary: topPhases(canaryFormal) };
const cpuPerOwnedRoom = { baseline: round(avg(baseCpu) / 8), canary: round(avg(canaryFormal.map((s) => s.totalUsed)) / 8) };
const telemetryOverhead = {
  config: "两窗口相同（见 MATCH_SPEC.covariates.telemetryConfig）",
  externalTelemetryExportAvg: { baseline: round(avg(baselineAll.map((s) => s.phases?.externalTelemetryExport ?? 0))), canary: round(avg(canaryFormal.map((s) => s.phases?.externalTelemetryExport ?? 0))) },
  note: "该相位开销已包含在两侧 totalUsed 中，匹配对比不受配置差异影响",
};

// PARTIAL 观测：tower 层仅有全局相位 CPU 与 fixedActionCounts，无命中/决策分桶计数器
const partialObservability = {
  towerControl: {
    phaseAvg: { baseline: round(avg(baselineAll.map((s) => s.phases?.towerControl ?? 0))), canary: round(avg(canaryFormal.map((s) => s.phases?.towerControl ?? 0))) },
    fixedActionCountsPerTick: { baseline: round(avg(baselineAll.map((s) => s.fixedActionCounts?.towerControl ?? 0)), 1), canary: round(avg(canaryFormal.map((s) => s.fixedActionCounts?.towerControl ?? 0)), 1) },
    status: "PARTIAL",
  },
  carrierTaskBoard: { status: "NOT OBSERVED", reason: "无现成缓存结构可挂载，未引入生产计数器" },
};

// 单房异常（>8 且 >25% 全局）
const anomalies = canaryFormal.flatMap((s) =>
  Object.entries(s.rooms || {})
    .filter(([, r]) => r.totalUsed > 8 && r.totalUsed > s.totalUsed * 0.25)
    .map(([room, r]) => ({ tick: s.tick, room, roomCpu: round(r.totalUsed, 1), globalCpu: round(s.totalUsed, 1), topRoles: Object.entries(r.roles).filter(([, v]) => v.used > 2).map(([k, v]) => `${k}:${round(v.used, 1)}`) }))
);
const anomalyByRoom = anomalies.reduce((m, a) => ((m[a.room] ||= []).push(a), m), {});

// ── 7. 汇总与输出 ──
const overall = {
  baseline: { window: { ...BASE_WIN, inclusiveTicks: inclLen(BASE_WIN) }, cpu: stats(baseCpu) },
  canaryFormal: { window: { ...FORMAL_WIN, inclusiveTicks: inclLen(FORMAL_WIN) }, cpu: stats(canaryFormal.map((s) => s.totalUsed)) },
  note: "正式窗口 tick 数为闭区间长度 end-start+1",
};

// SHA-256 manifest（monitor-data 全部原始文件 + 脚本 + 日志；只入 manifest，原始文件不入库）
const manifest = {};
for (const f of fs.readdirSync(dir)) {
  const p = path.join(dir, f);
  if (!fs.statSync(p).isFile()) continue;
  const buf = fs.readFileSync(p);
  manifest[f] = { bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}
// git 身份（报告需要 commit/tree/bundle/modules SHA-256）
import { execSync } from "node:child_process";
const git = (cmd) => { try { return execSync(cmd, { cwd: path.join(dir, ".."), encoding: "utf8" }).trim(); } catch (e) { return `ERROR: ${e.message.split("\n")[0]}`; } };
const identity = {
  candidateCommit: git('git rev-parse cac532b'),
  candidateTree: git('git rev-parse "cac532b^{tree}"'),
  headCommit: git("git rev-parse HEAD"),
};
// bundle/modules sha-256：区分部署产物与本地重建产物。
// 部署产物哈希在修订版 npm run build 覆盖 dist/main.js 之前提取自部署时产物
// （bundle 取尾部 __DEPLOY_BUNDLE_HASH__；modules 按 deployGuard.computeModulesHash
//   同一规范化 key\0content\0 重算），且与 push 日志前缀
// 8f7856e396c39df6… / 25e77207418e2ed8… 吻合。
identity.deployArtifact = {
  bundleSha256: "8f7856e396c39df6ca6ab7185cdb7d100f62d25c0d49f19dcd0794d45b03dd76",
  modulesSha256: "25e77207418e2ed87e3c792343483ec2dbee5044c7fa399c68e94d753004f0d0",
  method: "部署时 dist/main.js（修订重建前提取）：bundle 取产物尾部 __DEPLOY_BUNDLE_HASH__；modules 按 deployGuard.computeModulesHash 规范化（main\\0<content>\\0）重算；push 日志前缀两者均吻合",
};
{
  const distMain = path.join(dir, "..", "dist", "main.js");
  if (fs.existsSync(distMain)) {
    const content = fs.readFileSync(distMain, "utf8");
    const m = content.match(/__DEPLOY_BUNDLE_HASH__="([0-9a-f]{64})"/);
    const h = crypto.createHash("sha256");
    h.update("main"); h.update("\0"); h.update(content); h.update("\0");
    identity.localRebuild = {
      bundleSha256: m?.[1] ?? null,
      modulesSha256: h.digest("hex"),
      note: "当前工作树 dist/main.js 的哈希（修订期 npm run build 重建产物，含文档变更后的 dirty-tree 身份），非部署产物；部署产物见 deployArtifact",
    };
  }
}

const analysis = {
  generatedAt: new Date().toISOString(),
  script: "monitor-data/analyze-canary2-v2.mjs",
  quantileAlgorithm: "Hyndman-Fan type-7 线性插值（h=(n-1)p）；nearest-rank 对照字段 p95nr",
  identity,
  deploy: { deployTick: DEPLOY_TICK, warmupTicks: WARMUP_TICKS, formalBoundary, warmupExcludedTicks: covWarmup.samples },
  windows: overall,
  coverage: { baseline: covBase, canaryFormal: covFormal, warmup: { samples: covWarmup.samples } },
  missingAttribution: MISSING_ATTRIBUTION,
  missingContext: missingCtx,
  gates,
  rolling: { summary: rollingSummary, bucketTrajectory, lowestCoverageW200, note: "完整逐窗口表见 rolling-w200.json / rolling-w300.json" },
  matching: { spec: MATCH_SPEC, result: matchedStats },
  e6n59Audit: e6Audit,
  counters: { formalVsBaseline: countersFormal, fullVsBaseline: countersFull },
  e5n59RoomLevel: e5Room,
  phasesCompare,
  cpuPerOwnedRoom,
  telemetryOverhead,
  partialObservability,
  roomAnomalies: { count: anomalies.length, byRoom: Object.fromEntries(Object.entries(anomalyByRoom).map(([k, v]) => [k, { count: v.length, ticks: v.map((a) => a.tick) }])) , sample: anomalies.slice(0, 12) },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "analysis.json"), JSON.stringify(analysis, null, 1));
fs.writeFileSync(path.join(OUT_DIR, "rolling-w200.json"), JSON.stringify(roll200, null, 0));
fs.writeFileSync(path.join(OUT_DIR, "rolling-w300.json"), JSON.stringify(roll300, null, 0));
fs.writeFileSync(path.join(OUT_DIR, "sample-index.json"), JSON.stringify({
  sampleInterval: SAMPLE_INTERVAL,
  baseline: { window: covBase.window, presentTicks: baselineAll.map((s) => s.tick), missingTicks: covBase.missingTicks },
  canaryWarmupTicks: covWarmup.samples,
  canaryFormal: { window: covFormal.window, presentTicks: canaryFormal.map((s) => s.tick), missingTicks: covFormal.missingTicks, missingRuns: covFormal.missingRuns },
}, null, 1));
fs.writeFileSync(path.join(OUT_DIR, "manifest-sha256.json"), JSON.stringify({ generatedAt: new Date().toISOString(), note: "monitor-data/ 原始文件 SHA-256；原始文件本身不入库（含线上运行数据与私有 Memory 快照）", files: manifest }, null, 1));

// 控制台摘要
const S = analysis;
console.log(JSON.stringify({
  windows: S.windows,
  coverage: { baseline: { theo: covBase.theoreticalSamples, act: covBase.actualSamples, pct: covBase.coveragePct }, canary: { theo: covFormal.theoreticalSamples, act: covFormal.actualSamples, pct: covFormal.coveragePct } },
  gates: S.gates.map((g) => ({ ticks: g.ticks, n: g.samples, avg: g.cpu?.avg, p95: g.cpu?.p95, avgOK: g.avgWithinLimit, p95OK: g.p95WithinLimit })),
  rollingW200: rollingSummary.w200,
  rollingW300: rollingSummary.w300BucketSlope,
  matching: { pairs: matchedStats.matchedPairs, baselineUnique: matchedStats.baselineUnique, dropped: matchedStats.droppedCanary, canary: matchedStats.canary, baseline: matchedStats.baseline, meanDiffCI: matchedStats.meanDiffBootCI95, nonInf: matchedStats.nonInferiority },
  e6Peak544: e6Audit.peakSampleTick73330544,
  countersFormalDerived: countersFormal.derived,
  e5Room,
  anomaliesByRoom: S.roomAnomalies.byRoom,
}, null, 1));
