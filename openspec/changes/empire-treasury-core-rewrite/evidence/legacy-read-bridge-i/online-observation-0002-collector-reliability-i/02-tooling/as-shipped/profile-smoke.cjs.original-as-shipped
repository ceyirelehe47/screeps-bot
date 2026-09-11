'use strict';
/** Executes candidate bridge + REAL generated readers against a MOCK world.
 * Never connects to Screeps. Not a substitute for server/runtime evidence. */
const path = require('node:path');
const assert = require('node:assert/strict');
function main(args) {
  if (args.length !== 2 || args[0] !== '--repo') throw new Error('usage: node profile-smoke.cjs --repo CANDIDATE');
  const repo = path.resolve(args[1]);
  const {load, scene, makeRoom, guard} = require(path.join(repo, 'test/treasury-compat/helpers.cjs'));
  const cfg = load('treasuryCompatConfig.ts').TREASURY_COMPAT_CONFIG;
  assert.equal(cfg.enabled, true, 'only for the separately bound enabled profile');
  function make(tick) {
    const s = scene(cfg, true); // Requires generated fixed-source core; never falls back.
    assert.equal(s.api.validCompatConfig(cfg), true);
    s.game.time = tick;
    s.game.rooms = Object.fromEntries(cfg.rooms.map(name => [name, makeRoom(name)]));
    return s;
  }
  const s = make(cfg.startTick), raw = s.memory, before = JSON.stringify(raw), writes = {writes: 0};
  s.memory = guard(raw, writes);
  assert.equal(s.observer.run().status, 'sampled');
  const first = s.report();
  assert.equal(first.authorizesActions, false); assert.equal(first.spendable, null);
  assert.equal(first.kernelLifecycleRun, false); assert.equal(first.facadeQueryRun, false);
  assert.equal(first.commitments.status, 'read_complete');
  assert.equal(first.endpoints.length, cfg.rooms.length * 2);
  for (const row of first.endpoints) assert.equal(row.coreComparison, 'match_selected_scope');
  assert.equal(s.calls.observation, 1); assert.equal(s.calls.commitments, 1);
  assert.equal(s.observer.run().status, 'not_due');
  assert.equal(s.calls.observation, 1); assert.equal(s.calls.commitments, 1);
  s.game.time = cfg.endTick; assert.equal(s.observer.run().status, 'sampled');
  const calls = {...s.calls}; s.game.time = cfg.endTick + 1;
  assert.equal(s.observer.run().status, 'outside_window'); assert.deepEqual(s.calls, calls);
  assert.equal(writes.writes, 0); assert.equal(JSON.stringify(raw), before);
  for (const tick of [cfg.startTick - 1, cfg.endTick + 1]) {
    const x = make(tick); assert.equal(x.observer.run().status, 'outside_window');
    assert.equal(x.calls.readers, 0); assert.equal(x.calls.memory, 0);
  }
  const wrong = make(cfg.startTick); wrong.game.shard.name = 'different-shard';
  assert.equal(wrong.observer.run().status, 'wrong_shard'); assert.equal(wrong.calls.readers, 0);
  const low = make(cfg.startTick); low.bucket = cfg.minBucket - 1;
  assert.equal(low.observer.run().status, 'cpu_skipped'); assert.equal(low.calls.readers, 0);
  console.log(JSON.stringify({ status: 'PROFILE_MOCK_WORLD_SMOKE_PASSED',
    usedPinnedGeneratedReaders: true, realGameExecuted: false, deploymentAuthorized: false,
    checks: ['first/last sample', 'same-tick once', 'outside window', 'reset after deadline', 'wrong shard', 'low CPU bucket', 'no Memory writes'] }));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch { console.error('PROFILE_MOCK_WORLD_SMOKE_FAILED: retain local test input; no network action was attempted'); process.exitCode = 1; }
}
