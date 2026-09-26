"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");

const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const username = "lab_treasury_t1";
const manifest = JSON.parse(fs.readFileSync(`${root}/r2/candidate/manifest.json`, "utf8"));
const source = fs.readFileSync(`${root}/r2/candidate/main.js`, "utf8");
const hash = crypto.createHash("sha256").update(source).digest("hex");
assert.equal(hash, manifest.fileSha256);
assert.equal(Buffer.byteLength(source), manifest.bytes);
assert.ok(manifest.bytes <= 5 * 1024 * 1024);
assert.equal(manifest.sourceCommit, "cd0d550e3ff3637229e687eefa09fbb90a2dfb20");

process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const fromServer = createRequire(`${root}/server/package.json`);
const common = fromServer("@screeps/common");

(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  const paused = await env.get(env.keys.MAIN_LOOP_PAUSED);
  assert.equal(String(paused), "1", "lab must be paused before changing code");
  const user = await db.users.findOne({ _id: userId });
  assert.equal(user?.username, username);
  const active = await db["users.code"].find({ user: userId, activeWorld: true });
  assert.equal(active.length, 1);
  assert.equal(active[0].branch, "default");
  assert.equal(crypto.createHash("sha256").update(active[0].modules?.main ?? "").digest("hex"),
    "a06c967360673e4766a9d4cf139f6e06a34f3c49f10f593d405fce3f9e8c3dcb",
    "isolated lab starting code changed");

  const result = await db["users.code"].update({ _id: active[0]._id }, {
    $set: { modules: { main: source }, timestamp: Date.now() },
  });
  assert.ok(result.modified > 0, "candidate module update was not applied");
  await db.users.update({ _id: userId }, { $set: { active: 10000 } });
  await env.del(`scrScriptCachedData:${userId}`);
  const readback = await db["users.code"].findOne({ _id: active[0]._id });
  assert.equal(crypto.createHash("sha256").update(readback?.modules?.main ?? "").digest("hex"),
    hash, "candidate module readback mismatch");
  console.log(JSON.stringify({
    status: "candidate_loaded_into_isolated_world",
    sourceCommit: manifest.sourceCommit,
    moduleSha256: hash,
    bytes: manifest.bytes,
    tick: Number(await env.get(env.keys.GAMETIME)),
    paused: true,
  }));
})().then(() => process.exit(0), error => {
  console.error(String(error && error.stack || error));
  process.exit(1);
});
