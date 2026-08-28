// 紧急回滚：把 monitor-data/rollback-default-pre-canary2.json 中的 modules POST 回 default
// 用法：node rollback-canary2.mjs [reason]
import https from "node:https";
import fs from "node:fs";

const TOKEN = fs.readFileSync(".env", "utf8").match(/SCREEPS_TOKEN=(.*)/)?.[1]?.trim();
const reason = process.argv[2] || "manual";
if (!TOKEN) { console.error("no token"); process.exit(1); }
const backup = JSON.parse(fs.readFileSync("monitor-data/rollback-default-pre-canary2.json", "utf8"));
if (!backup.modules || !backup.modules.main) { console.error("backup modules missing"); process.exit(1); }

function post(path, body) {
  return new Promise((res, rej) => {
    const payload = JSON.stringify(body);
    const r = https.request({
      host: "screeps.com", path, method: "POST",
      headers: { "X-Token": TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (r2) => {
      let d = []; r2.on("data", (c) => d.push(c));
      r2.on("end", () => { try { res(JSON.parse(Buffer.concat(d).toString())); } catch (e) { rej(e); } });
    });
    r.on("error", rej);
    r.setTimeout(120000, () => r.destroy(new Error("timeout")));
    r.write(payload);
    r.end();
  });
}

console.log(`[rollback] reason=${reason} | backup capturedAt=${backup.capturedAt} | main size=${backup.modules.main.length}`);
const result = await post("/api/user/code", { branch: "default", modules: backup.modules });
console.log("[rollback] upload:", result.ok === 1 ? "ok" : JSON.stringify(result).slice(0, 300));
process.exit(result.ok === 1 ? 0 : 1);
