"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");

const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
const manifest = JSON.parse(fs.readFileSync(`${root}/r4/candidate/manifest.json`, "utf8"));
const source = fs.readFileSync(`${root}/r4/candidate/main.js`, "utf8");
const sha = crypto.createHash("sha256").update(source).digest("hex");
assert.equal(manifest.schema, "screeps-t1-first-live-release/v1");
assert.equal(manifest.sourceCommit, "16c2ca4b70b21b05f3c9bedddba3836cdce389ad");
assert.equal(sha, manifest.mainSha256);
assert.equal(Buffer.byteLength(source), manifest.mainBytes);
assert.ok(manifest.mainBytes < 5_000_000);

process.env.STORAGE_HOST = "::1";
process.env.STORAGE_PORT = "21027";
const common = createRequire(`${root}/server/package.json`)("@screeps/common");

(async () => {
  await common.storage._connect();
  const { db, env } = common.storage;
  assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)), "1");
  assert.equal((await db.users.findOne({ _id: userId }))?.username, "lab_treasury_t1");
  const code = await db["users.code"].findOne({ user: userId, activeWorld: true });
  assert.equal(code?.branch, "default");
  const oldSha = crypto.createHash("sha256").update(code.modules?.main ?? "").digest("hex");
  assert.equal(oldSha, "62b83ecf6b3b330c6f54febbe37cc858c1bcbda5e83dc82c97570dddcb7b0966");
  const result = await db["users.code"].update({ _id: code._id }, {
    $set: { modules: { main: source }, timestamp: Date.now() },
  });
  assert.ok(result.modified > 0);
  await db.users.update({ _id: userId }, { $set: { active: 10000 } });
  await env.del(`scrScriptCachedData:${userId}`);
  const after = await db["users.code"].findOne({ _id: code._id });
  assert.equal(crypto.createHash("sha256").update(after.modules?.main ?? "").digest("hex"), sha);
  const output = { status: "loaded", lab: "lab_treasury_t1", tick: Number(await env.get(env.keys.GAMETIME)),
    sourceCommit: manifest.sourceCommit, oldSha256: oldSha, newSha256: sha, bytes: manifest.mainBytes };
  fs.writeFileSync(`${root}/r4/evidence/upload.json`, JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), (error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
