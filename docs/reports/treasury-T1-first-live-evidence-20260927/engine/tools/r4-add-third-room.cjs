"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const room = "W9N8";
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");
(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  assert.equal((await db.users.findOne({ _id: userId }))?.username, "forster");
  assert.equal((await db.rooms.findOne({ _id: room }))?.status, "normal");
  const controller = await db["rooms.objects"].findOne({ room, type: "controller" });
  assert.equal(controller?.level, 0);
  assert.equal(controller.user, undefined);
  assert.equal((await db["rooms.objects"].find({ room, type: "terminal" })).length, 0);
  assert.equal((await db["rooms.objects"].find({ room, type: "storage" })).length, 0);
  const sourceTerminal = await db["rooms.objects"].findOne({ room: "E3N59", type: "terminal" });
  const sourceStorage = await db["rooms.objects"].findOne({ room: "E3N59", type: "storage" });
  assert.ok(sourceTerminal && sourceStorage);
  const tick = Number(await env.get(env.keys.GAMETIME));
  await db["rooms.objects"].update({ _id: controller._id }, { $set: {
    user: userId, level: 8, progress: 0, downgradeTime: tick + 200_000, safeMode: null,
  } });
  const clone = (source, x, y, store) => {
    const { _id, $loki, meta, ...copy } = source;
    return { ...copy, room, user: userId, x, y, store };
  };
  const terminal = await db["rooms.objects"].insert({
    ...clone(sourceTerminal, 25, 25, { H: 1000, energy: 10000 }),
    cooldown: 0, cooldownTime: 0,
  });
  const storage = await db["rooms.objects"].insert(
    clone(sourceStorage, 26, 25, { H: 1000, energy: 100000 }));
  assert.equal((await db["rooms.objects"].findOne({ _id: terminal._id }))?.room, room);
  const output = { schema: "screeps-t1-first-live-lab-third-room/v1", tick,
    isolatedWorldOnly: true, room, ownerUserId: userId,
    controllerId: controller._id, terminalId: terminal._id, storageId: storage._id };
  fs.writeFileSync(`${root}/r4/evidence/third-room-setup.json`, JSON.stringify(output, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
