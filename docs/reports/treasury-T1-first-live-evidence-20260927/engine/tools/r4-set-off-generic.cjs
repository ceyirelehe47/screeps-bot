"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const label = process.argv[2];
const taskId = process.argv[3];
const keepResourceControl = process.argv[4] === "keep-rc";
assert.match(label ?? "", /^[a-z0-9-]{1,40}$/);
assert.match(taskId ?? "", /^lab-r4-[A-Za-z0-9-]{1,70}$/);
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
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, "drain");
  assert.equal(memory.runtime?.treasuryT1FirstLiveControl?.status, "closed");
  const quota = memory.runtime?.treasuryProductionT1Quota;
  assert.equal(quota?.status, "dispatching");
  assert.equal(quota?.taskId, taskId);
  assert.equal(Object.keys(memory.runtime?.treasuryCore?.active ?? {}).length, 0);
  const terminal = (memory.runtime?.treasuryCore?.ring ?? []).find((item) =>
    item.workKey === quota.workKey && item.attemptId === quota.attemptId);
  assert.equal(terminal?.terminalPhase, "committed");
  const task = memory.data.resourceControl.tasks[taskId];
  assert.equal(task?.status, "done");
  assert.equal(task.remainingAmount, 0);
  assert.equal(task.treasurySlice?.phase, "closing");
  assert.equal(task.treasurySlice?.outcome, "committed");
  memory.cfg.treasuryTerminalTransferSlice0.mode = "off";
  if (!keepResourceControl) memory.cfg.resourceControl.enabled = false;
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const output = { schema: "screeps-t1-first-live-lab-generic-off/v1", label, taskId,
    tick: Number(await env.get(env.keys.GAMETIME)), terminalPhase: terminal.terminalPhase,
    keepResourceControl,
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex") };
  fs.writeFileSync(`${root}/r4/evidence/${label}-set-off.json`, JSON.stringify(output, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
