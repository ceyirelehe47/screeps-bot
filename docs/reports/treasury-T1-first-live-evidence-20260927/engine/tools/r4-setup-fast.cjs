"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const taskId = "lab-r4b-100H";
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");
(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  assert.equal((await db.users.findOne({ _id: userId }))?.username, "forster");
  const tick = Number(await env.get(env.keys.GAMETIME));
  const key = env.keys.MEMORY + userId;
  const before = await env.get(key);
  const memory = JSON.parse(before);
  assert.equal(memory.runtime?.treasuryT1FirstLiveControl?.status, "active");
  assert.ok(Date.now() >= memory.runtime.treasuryT1FirstLiveControl.controlUntilMs);
  assert.equal(memory.runtime?.treasuryProductionT1Quota, undefined);
  assert.equal(Object.keys(memory.runtime?.treasuryCore?.active ?? {}).length, 0);
  const prior = memory.data.resourceControl.tasks["lab-r4-100H"];
  assert.equal(prior?.remainingAmount, 100);
  assert.equal(prior?.treasurySlice, undefined);
  assert.equal(memory.data.resourceControl.tasks[taskId], undefined);
  // Synthetic lab reset. Never use this operation on shard1 production.
  delete memory.runtime.treasuryT1FirstLiveControl;
  delete memory.runtime.treasuryT1FirstLiveControlMirror;
  delete memory.runtime.__labArmResult;
  delete memory.data.resourceControl.tasks["lab-r4-100H"];
  memory.cfg.treasuryTerminalTransferSlice0 = { mode: "off" };
  memory.cfg.resourceControl.sampleInterval = 1;
  memory.data.resourceControl.tasks[taskId] = {
    id: taskId, resource: "H", fromRoomName: "E3N59", toRoomName: "E4N58",
    amount: 100, remainingAmount: 100, status: "pending", origin: "manual",
    createdAt: tick, updatedAt: tick, lastProgressAt: tick,
  };
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const output = { schema: "screeps-t1-first-live-lab-fast-setup/v1", tick, taskId,
    resetExpiredControlOnlyInIsolatedLab: true,
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex") };
  fs.writeFileSync(`${root}/r4/evidence/setup-fast.json`, JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
