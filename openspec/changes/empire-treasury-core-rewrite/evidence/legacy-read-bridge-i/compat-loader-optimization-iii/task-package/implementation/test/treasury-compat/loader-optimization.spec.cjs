'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('./loader-test-support.cjs');
const { H, fs, path, make, build, task, reservation, oldText, newText } = S;
const G = require(path.join(H.ROOT, 'scripts/build-treasury-compat-loader.cjs'));
const ids = text => [...text.matchAll(/^"([^"]+)": function\(exports, require\)/gm)].map(x => x[1]);
const mutable = ['src/runtime/treasury/commitments.ts', 'src/runtime/treasury/commitmentRevision.ts'];
test('loader III baseline fixture is the exact original Git blob', () => {
  const b = Buffer.from(oldText()); assert.equal(G.blob(b), S.OLD_BLOB); assert.equal(b.length, 62929);
});
test('loader III all factory bodies and dependency bytes remain unchanged', () => {
  const prefix = oldText().split('export function createCompatibilityReadCore(): CompatReadBuilders {')[0];
  assert.ok(newText().startsWith(prefix)); assert.equal(ids(newText()).length, 8);
  assert.equal(G.main(['--check']).status, 'COMPAT_LOADER_REGENERATION_VERIFIED');
});
test('loader III module import alone performs no Game Memory or catalog read', () => {
  const s = new Proxy({}, { get() { throw new Error('global touched'); } });
  assert.deepEqual(Object.keys(S.capsule(newText(), s)), ['createCompatibilityReadCore']);
});
test('loader III retains the exact public read-only API', () => {
  const s = make(); const a = s.core.createCompatibilityReadCore(); const b = s.core.createCompatibilityReadCore();
  assert.deepEqual(Object.keys(s.core), ['createCompatibilityReadCore']);
  assert.deepEqual(Object.keys(a).sort(), ['buildCommitments', 'buildObservation']);
  assert.notEqual(a, b); assert.notEqual(a.buildObservation, b.buildObservation); assert.notEqual(a.buildCommitments, b.buildCommitments);
  assert.ok(Object.isFrozen(a)); assert.throws(() => { a.buildObservation = () => {}; });
});
test('loader III twelve fresh builders execute 30 factories instead of 96', () => {
  for (const [text, expected] of [[oldText(), 96], [newText(), 30]]) {
    const s = make(text); const first = s.core.createCompatibilityReadCore(); assert.equal(s.factories.length, 8);
    for (let i = 1; i < 12; i++) assert.notEqual(s.core.createCompatibilityReadCore(), first);
    assert.equal(s.factories.length, expected);
    for (const id of ids(text)) assert.equal(s.factories.filter(x => x === id).length, expected === 96 || mutable.includes(id) ? 12 : 1);
  }
});
test('loader III no definition prewarm before sample admission and CPU skip', () => {
  const s = make(); s.bucket = 0; assert.equal(s.observer.run().status, 'cpu_skipped'); assert.equal(s.factories.length, 0);
  s.bucket = 9000; s.game.time = 200; s.observer.run(); assert.equal(s.factories.length, 8);
});
test('loader III disabled preview never loads definitions', () => {
  const s = make(); const observer = s.api.createTreasuryCompatPreview({ ...s.cfg, enabled: false }, s.ports, { cpuDiagnostics: true });
  assert.equal(observer.run().status, 'disabled'); assert.equal(s.factories.length, 0);
});
test('loader III initialization cost remains in the admitted readerLoad interval', () => {
  const s = make(newText(), true, (_id, state) => { state.cpuValue += 0.01; });
  s.observer.run(); const first = s.report(); s.game.time = 200; s.cpuValue = 0.1; s.observer.run(); const second = s.report();
  assert.ok(first.cpuProfile.phases.readerLoad >= 0.0799); assert.ok(second.cpuProfile.phases.readerLoad >= 0.0199);
  assert.equal(first.cpuProfile.calls.readerLoad, 1); assert.equal(second.cpuProfile.calls.readerLoad, 1);
  assert.equal(s.factories.length, 10); // Cost model only, not an engine speed claim.
});
for (const name of Object.keys(S.scenarios)) test('loader III real-core A/B byte equivalence: ' + name, () => {
  const r = S.compareScenario(name); assert.equal(r.byteEquivalent, true); assert.deepEqual(r.writes, [0, 0]);
  assert.equal(r.reports, 12); assert.deepEqual(r.readers, [12, 12]);
  assert.equal(r.oldFactoryExecutions, 96); assert.equal(r.newFactoryExecutions, 30);
});
test('loader III same-tick task mutation without revision changes is visible', () => {
  const s = make(); s.memory.data.resourceControl.tasks.t = task(); const a = build(s);
  s.memory.data.resourceControl.tasks.t.remainingAmount = 12; const b = build(s);
  assert.equal(a.index.outgoing('W1N1', 'H'), 70); assert.equal(b.index.outgoing('W1N1', 'H'), 12);
  assert.equal(a.index.revision, 0); assert.equal(b.index.revision, 0); assert.notEqual(a.index, b.index);
});
test('loader III observation snapshots and resource caches do not cross builds', () => {
  const s = make(); const a = build(s); const old = H.json(a.observation.data); a.observation.roomResources('W1N1'); a.observation.empireResources();
  s.game.rooms.W1N1.storage.store.O = 444; s.game.rooms.W1N1.storage.id = 'replacement'; const b = build(s);
  assert.deepEqual(H.json(a.observation.data), old); assert.equal(b.observation.amount('W1N1', 'storage', 'O'), 444);
  assert.equal(b.observation.location('W1N1', 'storage').structureId, 'replacement');
  assert.ok(!a.observation.roomResources('W1N1').includes('O')); assert.ok(b.observation.roomResources('W1N1').includes('O'));
});
test('loader III same builder still creates fresh observations and indexes on every call', () => {
  const s = make(); const r = s.core.createCompatibilityReadCore(); const a = build(s, r); const b = build(s, r);
  assert.notEqual(a.observation, b.observation); assert.notEqual(a.index, b.index); assert.notEqual(a.index.metrics, b.index.metrics);
});
test('loader III whole Game and Memory root replacements are observed dynamically', () => {
  const s = make(); build(s); s.game = { time: 900, rooms: { W1N1: H.makeRoom() }, getObjectById: () => null };
  s.memory = { runtime: { treasuryWorldSequence: 7, resourceReservations: { r: reservation({ amount: 91, expiresAt: 1000 }) } }, data: { resourceControl: { tasks: {} } } };
  const b = build(s); assert.equal(b.observation.epoch.observedAtTick, 900); assert.equal(b.observation.epoch.worldSequence, 7); assert.equal(b.index.reservedProduction('W1N1', 'H'), 91);
});
test('loader III changing health configuration is not cached with definitions', () => {
  const s = make(); s.game.time = 1000; s.memory.data.resourceControl.tasks.t = task({ origin: 'automatic', lastProgressAt: 1 });
  s.memory.cfg = { resourceControl: { capacityBalancing: { automaticTaskNoProgressTtl: 2000 } } };
  const a = build(s); assert.equal(a.index.incoming('W2N1', 'H'), 70);
  s.memory.cfg.resourceControl.capacityBalancing.automaticTaskNoProgressTtl = 100;
  const b = build(s); assert.equal(b.index.incoming('W2N1', 'H'), 0); assert.equal(a.index.incoming('W2N1', 'H'), 70);
});
test('loader III changing resource catalog is captured in every fresh commitment module', () => {
  const s = make(); s.memory.data.resourceControl.tasks.t = task({ resource: 'new-test-resource' });
  assert.equal(build(s).index.completeness.complete, false); s.resources = [...s.resources, 'new-test-resource'];
  const b = build(s); assert.equal(b.index.completeness.complete, true); assert.equal(b.index.outgoing('W1N1', 'new-test-resource'), 70);
});
test('loader III holder resolver uses current ownership instead of first sample ownership', () => {
  const s = make(); s.memory.runtime.resourceReservations.r = reservation();
  const a = build(s); assert.equal(a.index.metrics.typedOwnerResolved, 1);
  s.game.rooms.W1N1.controller.my = false; const b = build(s);
  assert.equal(b.index.metrics.typedOwnerResolved, 0); assert.equal(b.index.reservedProduction('W1N1', 'H'), 25);
});
test('loader III reservation expiration remains strict and records are not deleted', () => {
  const s = make(); s.memory.runtime.resourceReservations.r = reservation({ expiresAt: 100 });
  assert.equal(build(s).index.reservedProduction('W1N1', 'H'), 25); s.game.time = 101;
  assert.equal(build(s).index.reservedProduction('W1N1', 'H'), 0); assert.ok(s.memory.runtime.resourceReservations.r);
});
test('loader III revision factory is fresh even after a test-only mutation of its private state', () => {
  // Export interception is test-only; no revision or inspection API is shipped.
  const text = newText().replace('return commitmentRevision;', 'return ++commitmentRevision;');
  const s = make(text); const a = build(s); const b = build(s);
  assert.equal(a.index.revision, 1); assert.equal(b.index.revision, 1);
});
test('loader III failed first initialization does not publish partial shared modules', () => {
  const s = make(); let first = true;
  Object.defineProperty(s, 'resources', { configurable: true, get() { if (first) { first = false; throw new Error('catalog unavailable'); } return ['energy', 'H']; } });
  assert.throws(() => s.core.createCompatibilityReadCore()); assert.equal(s.factories.length, 8);
  s.core.createCompatibilityReadCore(); assert.equal(s.factories.length, 16);
  s.core.createCompatibilityReadCore(); assert.equal(s.factories.length, 18);
});
test('loader III failed later initialization does not poison successful definitions', () => {
  const s = make(); s.core.createCompatibilityReadCore(); let bad = true;
  Object.defineProperty(s, 'resources', { get() { if (bad) throw new Error('catalog unavailable'); return ['energy', 'H']; } });
  assert.throws(() => s.core.createCompatibilityReadCore()); bad = false; build(s);
  assert.equal(s.factories.length, 12);
});
test('loader III build exception does not expose stale index in next sample', () => {
  const s = make(); s.memory.runtime.resourceReservations.r = reservation(); s.game.getObjectById = () => { throw new Error('lookup'); };
  s.memory.runtime.resourceReservations.r.holderId = '1234567890abcdef12345678'; assert.throws(() => build(s));
  s.game.getObjectById = () => ({ room: { name: 'W1N1' } }); assert.equal(build(s).index.metrics.typedOwnerResolved, 1);
});
test('loader III global reset repeats initialization and retains no prior snapshot', () => {
  const a = make(); build(a); build(a); const b = make(); build(b); assert.equal(a.factories.length, 10); assert.equal(b.factories.length, 8);
});
test('loader III long run initializes only six bounded shared definitions', () => {
  const s = make(); for (let i = 0; i < 500; i++) s.core.createCompatibilityReadCore();
  assert.equal(s.factories.length, 6 + 2 * 500); for (const id of ids(newText()).filter(x => !mutable.includes(x))) assert.equal(s.factories.filter(x => x === id).length, 1);
});
test('loader III malformed pinned input is rejected before regeneration', () => {
  assert.throws(() => G.generate(Buffer.from(oldText().replace('let commitmentRevision = 0;', 'let commitmentRevision = 1;')), Buffer.from(''), {}), /CORE_BASELINE_MISMATCH/);
});
test('loader III inherited dependency property never becomes a host import', () => {
  const text = newText().replace('require("@/runtime/treasury/types")', 'require("toString")');
  const s = make(text); assert.throws(() => s.core.createCompatibilityReadCore(), /unlisted read import/);
});
test('loader III generator is byte deterministic and idempotent on metadata', () => {
  const original = Buffer.from(oldText()); const template = fs.readFileSync(path.join(H.ROOT, G.TEMPLATE));
  const manifest = JSON.parse(fs.readFileSync(path.join(H.ROOT, G.SOURCE_MANIFEST)));
  const a = G.generate(original, template, manifest); const b = G.generate(original, template, JSON.parse(a[G.SOURCE_MANIFEST]));
  for (const name of Object.keys(a)) assert.ok(a[name].equals(b[name]));
});
test('loader III generator provenance keeps all eight canonical source identities', () => {
  const p = JSON.parse(fs.readFileSync(path.join(H.ROOT, G.PROVENANCE))); assert.equal(p.factories.length, 8);
  assert.equal(p.factories.filter(x => x.lifecycle === 'per-sample').length, 2); assert.equal(p.engineCpuGapRepaired, false);
  assert.equal(p.generatedSha256, crypto.createHash('sha256').update(newText()).digest('hex'));
});
