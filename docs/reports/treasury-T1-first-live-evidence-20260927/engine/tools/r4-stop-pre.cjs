"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const scenario = process.argv[2];
assert.ok(scenario === "pre-source" || scenario === "pre-target" || scenario === "pre-target-ready");
const root = "/srv/screeps-treasury-t1";
const userId = "7dad41a4bfc9d96";
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
  assert.equal(memory.cfg?.treasuryTerminalTransferSlice0?.mode, "canary");
  assert.equal(memory.runtime?.treasuryProductionT1Quota, undefined);
  assert.equal(memory.data?.resourceControl?.tasks?.[`lab-r4-${scenario}-H`]?.remainingAmount, 100);
  memory.cfg.treasuryTerminalTransferSlice0.mode = "off";
  memory.cfg.resourceControl.enabled = false;
  const after = JSON.stringify(memory);
  await env.set(key, after);
  assert.equal(await env.get(key), after);
  const output = { schema: "screeps-t1-first-live-lab-pre-stop/v1", scenario,
    isolatedWorldOnly: true, tick: Number(await env.get(env.keys.GAMETIME)),
    beforeMemorySha256: crypto.createHash("sha256").update(before).digest("hex"),
    afterMemorySha256: crypto.createHash("sha256").update(after).digest("hex") };
  fs.writeFileSync(`${root}/r4/evidence/${scenario}-stop.json`, JSON.stringify(output, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(output));
})().then(() => process.exit(0), error => { console.error(String(error?.stack ?? error)); process.exit(1); });
