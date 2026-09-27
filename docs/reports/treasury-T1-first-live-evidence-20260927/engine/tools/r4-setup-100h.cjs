"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const taskId = "lab-r4-100H";
const manifest = JSON.parse(fs.readFileSync(`${root}/r4/candidate/manifest.json`, "utf8"));
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");
(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  assert.equal((await db.users.findOne({ _id: userId }))?.username, "forster");
  const code = await db["users.code"].findOne({ user: userId, activeWorld: true });
  assert.equal(crypto.createHash("sha256").update(code?.modules?.main ?? "").digest("hex"), manifest.mainSha256);
  const tick = Number(await env.get(env.keys.GAMETIME));
  const key = env.keys.MEMORY + userId;
  const before = await env.get(key);
  const memory = JSON.parse(before);
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, "off");
  assert.equal(memory.runtime?.treasuryProductionT1Quota?.status, "drained");
  assert.equal(Object.keys(memory.runtime?.treasuryCore?.active ?? {}).length, 0);
  assert.equal(memory.runtime?.treasuryT1FirstLiveControl, undefined);
  assert.equal(memory.data?.resourceControl?.tasks?.[taskId], undefined);
  // This synthetic lab deliberately starts a new test instance. Production
  // must never clear a consumed T1 quota or invent a business task.
  delete memory.runtime.treasuryProductionT1Quota;
  delete memory.runtime.__labT1Probe;
  memory.data.resourceControl.tasks[taskId] = {
    id: taskId, resource: "H", fromRoomName: "E3N59", toRoomName: "E4N58",
    amount: 100, remainingAmount: 100, status: "pending", origin: "manual",
    createdAt: tick, updatedAt: tick, lastProgressAt: tick,
  };
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const output = { schema: "screeps-t1-first-live-lab-setup/v1", tick, taskId,
    codeSha256: manifest.mainSha256, beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex"), isolatedWorldOnly: true };
  fs.writeFileSync(`${root}/r4/evidence/setup-100h.json`, JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
