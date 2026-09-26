"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");

const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const taskId = "lab-r2-carrier-100H";
const creepName = "lab-r2-carrier";
const manifest = JSON.parse(fs.readFileSync(`${root}/r2/candidate/manifest.json`, "utf8"));
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");

(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  assert.equal((await db.users.findOne({ _id: userId }))?.username, "lab_treasury_t1");
  const code = await db["users.code"].findOne({ user: userId, activeWorld: true });
  assert.equal(crypto.createHash("sha256").update(code?.modules?.main ?? "").digest("hex"),
    manifest.fileSha256);
  assert.equal((await db["rooms.objects"].find({ type: "creep", name: creepName })).length, 0);
  const tick = Number(await env.get(env.keys.GAMETIME));
  const key = env.keys.MEMORY + userId;
  const before = await env.get(key);
  const memory = JSON.parse(before);
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, "off");
  assert.equal(memory.runtime?.treasuryProductionT1Quota?.status, "drained");
  assert.equal(Object.keys(memory.runtime?.treasuryCore?.active ?? {}).length, 0);
  assert.equal(memory.data?.resourceControl?.tasks?.[taskId], undefined);
  delete memory.runtime.treasuryProductionT1Quota;
  memory.cfg.treasuryTerminalTransferSlice0 = { mode: "canary" };
  memory.data.resourceControl.tasks[taskId] = {
    id: taskId, resource: "H", fromRoomName: "E3N59", toRoomName: "E4N58",
    amount: 100, remainingAmount: 100, status: "pending", origin: "manual",
    createdAt: tick, updatedAt: tick, lastProgressAt: tick,
  };
  memory.creeps ??= {};
  memory.creeps[creepName] = { role: "carrier", ready: true, working: false };
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);

  const creep = {
    name: creepName, x: 26, y: 24, room: "E4N58", type: "creep", user: userId,
    body: [{ type: "carry", hits: 100 }, { type: "move", hits: 100 }],
    store: { energy: 0 }, storeCapacity: 50, hits: 200, hitsMax: 200,
    spawning: false, fatigue: 0, notifyWhenAttacked: true, ageTime: tick + 1500,
  };
  await db["rooms.objects"].insert(creep);
  const readback = await db["rooms.objects"].find({ type: "creep", name: creepName });
  assert.equal(readback.length, 1);
  assert.equal(readback[0].user, userId);
  const record = {
    schema: "screeps-treasury-t1-r2-carrier-setup/v1", tick, taskId, creepName,
    creepId: readback[0]._id, codeSha256: manifest.fileSha256,
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex"),
    isolatedWorldOnly: true,
  };
  fs.writeFileSync(`${root}/r2/evidence/setup-carrier.json`, JSON.stringify(record, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(record));
})().then(() => process.exit(0), (error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
