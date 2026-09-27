"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const scenario = process.argv[2];
assert.ok(["pre-source", "pre-target", "pre-target-ready", "post-both"].includes(scenario));
const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const taskId = `lab-r4-${scenario}-H`;
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");
(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  assert.equal((await db.users.findOne({ _id: userId }))?.username, "forster");
  const key = env.keys.MEMORY + userId;
  const before = await env.get(key);
  const memory = JSON.parse(before);
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, "off");
  assert.equal(Object.keys(memory.runtime?.treasuryCore?.active ?? {}).length, 0);
  assert.ok(memory.runtime?.treasuryProductionT1Quota === undefined ||
    memory.runtime.treasuryProductionT1Quota.status === "drained");
  assert.equal(memory.data?.resourceControl?.tasks?.[taskId], undefined);
  const tick = Number(await env.get(env.keys.GAMETIME));
  // Synthetic world reset only. This must never run on production Memory.
  delete memory.runtime.treasuryProductionT1Quota;
  delete memory.runtime.treasuryT1FirstLiveControl;
  delete memory.runtime.treasuryT1FirstLiveControlMirror;
  delete memory.runtime.__labArmResult;
  for (const id of Object.keys(memory.data.resourceControl.tasks)) {
    if (id.startsWith("lab-r4-")) delete memory.data.resourceControl.tasks[id];
  }
  memory.cfg.resourceControl.enabled = false;
  memory.cfg.resourceControl.sampleInterval = 1;
  memory.cfg.resourceControl.taskMaxPerRun = 3;
  memory.cfg.resourceControl.market = { enabled: false };
  memory.data.resourceControl.tasks[taskId] = {
    id: taskId, resource: "H", fromRoomName: "E3N59", toRoomName: "E4N58",
    amount: 100, remainingAmount: 100, status: "pending", origin: "manual",
    createdAt: tick, updatedAt: tick, lastProgressAt: tick,
  };
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const output = { schema: "screeps-t1-first-live-competition-setup/v1", scenario,
    isolatedWorldOnly: true, tick, taskId,
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex") };
  fs.writeFileSync(`${root}/r4/evidence/${scenario}-setup.json`, JSON.stringify(output, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
