// 部署前/后 CPU 基线采集：轮询 analytics.cpuMonitor.latest，按 tick 去重记录
import https from "node:https";
import fs from "node:fs";
import zlib from "node:zlib";
const T = process.argv[2];
const OUT = process.argv[3];
const DURATION_MS = Number(process.argv[4] || 28 * 60 * 1000);
const INTERVAL_MS = 25000;
function get(path) {
  return new Promise((res, rej) => {
    const r = https.get({ host: "screeps.com", path, headers: { "X-Token": T } }, (r) => {
      let d = []; r.on("data", (c) => d.push(c));
      r.on("end", () => res(JSON.parse(Buffer.concat(d).toString())));
    });
    r.on("error", rej);
    r.setTimeout(15000, () => { r.destroy(new Error("timeout")); });
  });
}
function dec(o){if(typeof o==="string"&&o.startsWith("gz:")){try{return JSON.parse(zlib.gunzipSync(Buffer.from(o.slice(3),"base64")).toString())}catch(e){return o}}return o}
const start = Date.now();
let lastTick = -1, n = 0;
console.log(`[collect] start ${new Date().toISOString()} -> ${OUT}, duration ${DURATION_MS / 60000}min`);
const timer = setInterval(async () => {
  try {
    const r = await get("/api/user/memory?path=analytics.cpuMonitor.latest&shard=shard1");
    const m = dec(r.data);
    if (!m || typeof m !== "object" || typeof m.tick !== "number") { console.log("[collect] bad sample:", JSON.stringify(r).slice(0, 120)); return; }
    if (m.tick <= lastTick) return;
    lastTick = m.tick; n++;
    const rec = { at: new Date().toISOString(), tick: m.tick, totalUsed: m.totalUsed, bucket: m.bucket, limit: m.limit, tickLimit: m.tickLimit, ema: m.emaTotalUsed, untracked: m.untracked, phases: m.phases, fixedActionCounts: m.fixedActionCounts, rooms: m.rooms };
    fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
    if (n % 10 === 1) console.log(`[collect] n=${n} tick=${m.tick} cpu=${m.totalUsed && m.totalUsed.toFixed(1)} bucket=${m.bucket} ema=${m.emaTotalUsed && m.emaTotalUsed.toFixed(1)}`);
  } catch (e) { console.log("[collect] err:", e.message); }
}, INTERVAL_MS);
setTimeout(() => { clearInterval(timer); console.log(`[collect] done at ${new Date().toISOString()}, samples=${n}, lastTick=${lastTick}`); process.exit(0); }, DURATION_MS);
