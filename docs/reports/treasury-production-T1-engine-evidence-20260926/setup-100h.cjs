"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");

const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const manifest = JSON.parse(fs.readFileSync(`${root}/r2/candidate/manifest.json`, "utf8"));
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");

(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  const user = await db.users.findOne({ _id: userId });
  assert.equal(user?.username, "lab_treasury_t1");
  const code = await db["users.code"].findOne({ user: userId, activeWorld: true });
  assert.equal(crypto.createHash("sha256").update(code?.modules?.main ?? "").digest("hex"),
    manifest.fileSha256);
  const tick = Number(await env.get(env.keys.GAMETIME));
  const key = env.keys.MEMORY + userId;
  const before = await env.get(key);
  assert.equal(typeof before, "string");
  const memory = JSON.parse(before);
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, "off");
  assert.equal(memory.runtime?.treasuryProductionT1Quota?.status, "drained");
  assert.equal(Object.keys(memory.runtime?.treasuryCore?.active ?? {}).length, 0);
  const taskId = "lab-r2-100H";
  assert.equal(memory.data?.resourceControl?.tasks?.[taskId], undefined);

  delete memory.runtime.treasuryProductionT1Quota;
  memory.cfg.treasuryTerminalTransferSlice0 = { mode: "canary" };
  memory.data.resourceControl.tasks[taskId] = {
    id: taskId, resource: "H", fromRoomName: "E3N59", toRoomName: "E4N58",
    amount: 100, remainingAmount: 100, status: "pending", origin: "manual",
    createdAt: tick, updatedAt: tick, lastProgressAt: tick,
  };
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const record = {
    schema: "screeps-treasury-t1-r2-setup/v1", tick, taskId,
    codeSha256: manifest.fileSha256,
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex"),
    isolatedWorldOnly: true,
  };
  fs.writeFileSync(`${root}/r2/evidence/setup-100h.json`, JSON.stringify(record, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(record));
})().then(() => process.exit(0), (error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
