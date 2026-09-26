"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");

const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const [expected, next] = process.argv.slice(2);
assert.ok((expected === "canary" && next === "drain") ||
  (expected === "drain" && next === "off"));
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");

(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  assert.equal((await db.users.findOne({ _id: userId }))?.username, "lab_treasury_t1");
  const key = env.keys.MEMORY + userId;
  const before = await env.get(key);
  const memory = JSON.parse(before);
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, expected);
  assert.equal(memory.runtime?.treasuryProductionT1Quota?.taskId, "lab-r2-100H");
  memory.cfg.treasuryTerminalTransferSlice0 = { mode: next };
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const record = {
    schema: "screeps-treasury-t1-r2-mode/v1", tick: Number(await env.get(env.keys.GAMETIME)),
    expected, next,
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex"),
  };
  fs.writeFileSync(`${root}/r2/evidence/mode-${expected}-to-${next}.json`,
    JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(record));
})().then(() => process.exit(0), (error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
