"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const taskId = "lab-r4-post-both-ordinary-source-late";
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");
(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  const key = env.keys.MEMORY + userId;
  const before = await env.get(key);
  const memory = JSON.parse(before);
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, "drain");
  assert.equal(memory.runtime?.treasuryT1FirstLiveControl?.status, "closed");
  assert.equal(memory.runtime?.treasuryProductionT1Quota?.status, "dispatching");
  assert.equal(memory.data.resourceControl.tasks[taskId], undefined);
  const tick = Number(await env.get(env.keys.GAMETIME));
  memory.data.resourceControl.tasks[taskId] = {
    id: taskId, resource: "H", fromRoomName: "W9N8", toRoomName: "E3N59",
    amount: 100, remainingAmount: 100, status: "pending", origin: "manual",
    createdAt: tick, updatedAt: tick, lastProgressAt: tick,
  };
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const output = { schema: "screeps-t1-first-live-lab-late-source/v1", tick,
    isolatedWorldOnly: true, taskId,
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex") };
  fs.writeFileSync(`${root}/r4/evidence/post-both-late-source-setup.json`,
    JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
