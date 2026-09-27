"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const phase = process.argv[2];
assert.match(phase ?? "", /^[a-z0-9-]{1,40}$/);
const manifest = JSON.parse(fs.readFileSync(`${root}/r4/candidate/manifest.json`, "utf8"));
process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");
(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  const [tick, paused, rawMemory, user, code, objects, transactions] = await Promise.all([
    env.get(env.keys.GAMETIME), env.get(env.keys.MAIN_LOOP_PAUSED),
    env.get(env.keys.MEMORY + userId), db.users.findOne({ _id: userId }),
    db["users.code"].findOne({ user: userId, activeWorld: true }),
    db["rooms.objects"].find({ room: { $in: ["E3N59", "E4N58", "W1N1"] } }),
    db.transactions.find({ $or: [{ sender: userId }, { recipient: userId }] }),
  ]);
  assert.equal(String(paused), "1");
  assert.ok(user?.username === "lab_treasury_t1" || user?.username === "forster");
  assert.ok(typeof rawMemory === "string");
  const codeSha256 = crypto.createHash("sha256").update(code?.modules?.main ?? "").digest("hex");
  assert.equal(codeSha256, manifest.mainSha256);
  const record = {
    schema: "screeps-t1-first-live-engine-snapshot/v1", phase,
    capturedAtUtc: new Date().toISOString(), tick: Number(tick), paused: true,
    user: { _id: user._id, username: user.username, cpu: user.cpu, cpuAvailable: user.cpuAvailable },
    code: { branch: code.branch, sha256: codeSha256, bytes: Buffer.byteLength(code.modules.main) },
    rawMemory, objects, transactions,
  };
  const output = path.join(root, "r4", "evidence", `${phase}.json`);
  fs.writeFileSync(output, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ phase, tick: record.tick, codeSha256,
    memoryBytes: rawMemory.length, objectCount: objects.length, transactionCount: transactions.length }));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
