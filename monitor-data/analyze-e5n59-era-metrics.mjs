// 第一次 Canary（c51fffb）三时期 E5N59 房间级单位负载指标
// 目的：取代 rca-report 中无效的"pathing avg ÷ E5 活跃样本占比"归一化。
// 口径：房间 CPU/creep（房间 CPU 均值 ÷ 房间 creep 数均值）、
//       remoteMiningCarrier 在场率、active 期 rmc used 均值、
//       全局 pathing/creep（全局相位 CPU ÷ 全局 creep 数——仅作全局对照，
//       不再做"÷ 活跃占比"的伪归一）。
// 输入：monitor-data/baseline-pre-deploy.jsonl、post-deploy.jsonl（canary 段 73327107–73327450，
//       回滚段 ≥73327457）。分位数：type-7 线性插值。
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const q7 = (xs, p) => { const s = [...xs].sort((a, b) => a - b); const h = (s.length - 1) * p; const lo = Math.floor(h); return s[lo] + (h - lo) * (s[Math.min(s.length - 1, lo + 1)] - s[lo]); };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

const roomCreeps = (s, room) => Object.values(s.rooms?.[room]?.roles ?? {}).reduce((a, v) => a + v.count, 0);
const globalCreeps = (s) => Object.values(s.rooms || {}).reduce((a, r) => a + Object.values(r.roles || {}).reduce((b, v) => b + v.count, 0), 0);

function era(label, rows) {
  const roomCpu = rows.map((s) => s.rooms?.E5N59?.totalUsed ?? 0).filter((x) => x > 0);
  const creeps = rows.map((s) => roomCreeps(s, "E5N59"));
  const rmcPresent = rows.map((s) => ((s.rooms?.E5N59?.roles?.remoteMiningCarrier?.count ?? 0) > 0 ? 1 : 0));
  const rmcUsedActive = rows.map((s) => s.rooms?.E5N59?.roles?.remoteMiningCarrier?.used ?? 0).filter((x) => x > 0);
  const pathing = rows.map((s) => s.phases?.["creepWork:pathing"] ?? 0);
  return {
    label, n: rows.length, tickRange: [rows[0].tick, rows[rows.length - 1].tick],
    e5n59: { avg: round(avg(roomCpu), 2), median: round(q7(roomCpu, 0.5), 2), p95: round(q7(roomCpu, 0.95), 2), max: round(Math.max(...roomCpu), 2) },
    cpuPerCreep: round(avg(roomCpu) / avg(creeps)),
    rmcPresentPct: round(avg(rmcPresent), 2),
    rmcUsedWhenActive: { avg: round(avg(rmcUsedActive), 2), max: round(Math.max(...rmcUsedActive), 2) },
    globalPathingPerCreep: round(avg(pathing) / avg(rows.map(globalCreeps))),
  };
}

const base = read("baseline-pre-deploy.jsonl");
const post = read("post-deploy.jsonl");
const canary = post.filter((s) => s.tick >= 73327107 && s.tick <= 73327450);
const rolled = post.filter((s) => s.tick >= 73327457);
const out = {
  generatedAt: new Date().toISOString(),
  script: "monitor-data/analyze-e5n59-era-metrics.mjs",
  note: "取代 rca-report 旧版无效归一化（pathing avg ÷ E5 活跃样本占比）的房间级单位负载指标；回滚后时期事件角色在场率下降且安静期更长，单位指标不可与前三窗口直接比较，仅作参考",
  eras: [era("baseline-6fc4bf2", base), era("canary-c51fffb", canary), era("rolledback-6fc4bf2", rolled)],
};
fs.writeFileSync(path.join(dir, "derived-canary2", "e5n59-era-metrics.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
