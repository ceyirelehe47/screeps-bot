"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const scenario = process.argv[2];
assert.ok(["pre-source", "pre-target", "pre-target-ready", "post-both"].includes(scenario));
const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
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
  const control = memory.runtime?.treasuryT1FirstLiveControl;
  assert.equal(control?.status, "active");
  assert.equal(control.taskId, `lab-r4-${scenario}-H`);
  assert.ok(Date.now() < control.controlUntilMs);
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, "canary");
  assert.equal(memory.runtime?.treasuryProductionT1Quota, undefined);
  const task = memory.data.resourceControl.tasks[control.taskId];
  assert.equal(task?.status, "pending");
  const destinations = scenario === "pre-source" ? ["E3N59"]
    : scenario.startsWith("pre-target") ? ["E4N58"] : ["E3N59", "E4N58"];
  const ids = [];
  for (const [index, destination] of destinations.entries()) {
    const id = `lab-r4-${scenario}-ordinary-${index}`;
    assert.equal(memory.data.resourceControl.tasks[id], undefined);
    const createdAt = scenario.startsWith("pre-") ? task.createdAt - 1 : task.createdAt + 1 + index;
    memory.data.resourceControl.tasks[id] = {
      id, resource: "H", fromRoomName: "W9N8", toRoomName: destination,
      amount: 100, remainingAmount: 100, status: "pending", origin: "manual",
      createdAt, updatedAt: Number(await env.get(env.keys.GAMETIME)),
      lastProgressAt: Number(await env.get(env.keys.GAMETIME)),
    };
    ids.push(id);
  }
  memory.cfg.resourceControl.enabled = true;
  memory.cfg.resourceControl.sampleInterval = 1;
  memory.cfg.resourceControl.taskMaxPerRun = 3;
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const output = { schema: "screeps-t1-first-live-ordinary-setup/v1", scenario,
    isolatedWorldOnly: true, tick: Number(await env.get(env.keys.GAMETIME)), taskIds: ids,
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex") };
  fs.writeFileSync(`${root}/r4/evidence/${scenario}-ordinary-setup.json`,
    JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
