// 遥测 segment 90 采集器：每 25s 记录 movement 计数器快照（累计值，分析时取窗口差值）
import https from "node:https";
import fs from "node:fs";
import zlib from "node:zlib";
const TOKEN = process.argv[2];
const OUT = process.argv[3];
const DURATION_MS = Number(process.argv[4] || 200 * 60 * 1000);

function get(path) {
  return new Promise((res, rej) => {
    const r = https.get({ host: "screeps.com", path, headers: { "X-Token": TOKEN } }, (r2) => {
      let d = []; r2.on("data", (c) => d.push(c));
      r2.on("end", () => res(JSON.parse(Buffer.concat(d).toString())));
    });
    r.on("error", rej);
    r.setTimeout(15000, () => r.destroy(new Error("timeout")));
  });
}
const dec = (o) => {
  if (typeof o === "string" && o.startsWith("gz:")) { try { return JSON.parse(zlib.gunzipSync(Buffer.from(o.slice(3), "base64")).toString()); } catch { return o; } }
  if (typeof o === "string") { try { return JSON.parse(o); } catch { return o; } }
  return o;
};

const start = Date.now();
let lastTick = -1, n = 0;
console.log(`[segment-collect] start ${new Date().toISOString()} -> ${OUT}, duration ${Math.round(DURATION_MS / 60000)}min`);
const timer = setInterval(async () => {
  try {
    const r = await get("/api/user/memory-segment?segment=90&shard=shard1");
    const seg = dec(r.data);
    if (!seg || typeof seg !== "object" || typeof seg.tick !== "number") return;
    if (seg.tick <= lastTick) return;
    lastTick = seg.tick; n++;
    const rec = {
      at: new Date().toISOString(),
      tick: seg.tick,
      movement: seg.totals?.movement ?? null,
      gauges: seg.totals?.gauges ?? seg.gauges ?? null,
      movementRooms: seg.movementRooms ?? null,
      truncated: seg.truncated === true,
    };
    fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
    if (n % 10 === 1) {
      const m = rec.movement || {};
      console.log(`[segment-collect] n=${n} tick=${seg.tick} mrs=${m.multiRoomSearches} travelRepaths=${m.travelRepaths} staticMatrixBuilds=${m.staticMatrixBuilds ?? "n/a"}`);
    }
  } catch (e) { console.log("[segment-collect] err:", e.message); }
}, 25000);
setTimeout(() => { clearInterval(timer); console.log(`[segment-collect] done ${new Date().toISOString()}, samples=${n}, lastTick=${lastTick}`); process.exit(0); }, DURATION_MS);
