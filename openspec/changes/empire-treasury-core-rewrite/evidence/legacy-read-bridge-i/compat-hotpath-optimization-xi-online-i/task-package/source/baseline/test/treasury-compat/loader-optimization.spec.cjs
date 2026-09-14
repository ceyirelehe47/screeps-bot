'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('./loader-test-support.cjs');
const { H, fs, path, make, build, task, reservation, oldText, newText } = S;
const G = require(path.join(H.ROOT, 'scripts/build-treasury-compat-loader.cjs'));
const ids = text => [...text.matchAll(/^"([^"]+)": function\(exports, require\)/gm)].map(x => x[1]);
const mutable = ['src/runtime/treasury/commitments.ts', 'src/runtime/treasury/commitmentRevision.ts'];
test('read V baseline fixture is the exact original Git blob', () => {
  const b = Buffer.from(oldText()); assert.equal(G.blob(b), S.OLD_BLOB); assert.equal(b.length, 64604);
});
test('read V context substitutions recover canonical factories after reversing IX and VII transforms', () => {
  const before = oldText().split(G.MARKER)[0];
  const afterIX = G.A.restore(newText().split('/** Read Optimization V:')[0]);
  const afterVII = G.B.restore(afterIX);
  assert.equal(G.X.restore(afterVII), before);
  assert.equal(ids(newText()).length, 8); // unused original revision body retained, not invoked
  assert.equal(G.main(['--check']).status, 'COMPAT_LOADER_REGENERATION_VERIFIED');
});
test('read V module import alone performs no Game Memory or catalog read', () => {
  const s = new Proxy({}, { get() { throw new Error('global touched'); } });
  assert.deepEqual(Object.keys(S.capsule(newText(), s)), ['createCompatibilityReadCore']);
});
test('read V retains the exact public read-only API', () => {
  const s = make(); const a = s.core.createCompatibilityReadCore(); const b = s.core.createCompatibilityReadCore();
  assert.deepEqual(Object.keys(s.core), ['createCompatibilityReadCore']);
  assert.deepEqual(Object.keys(a).sort(), ['buildCommitments', 'buildObservation']);
  assert.notEqual(a, b); assert.notEqual(a.buildObservation, b.buildObservation); assert.notEqual(a.buildCommitments, b.buildCommitments);
  assert.ok(Object.isFrozen(a)); assert.throws(() => { a.buildObservation = () => {}; });
});
test('read V twelve fresh builders execute seven definitions instead of thirty', () => {
  for (const [text, expected] of [[oldText(), 30], [newText(), 7]]) {
    const s = make(text); const first = s.core.createCompatibilityReadCore(); assert.equal(s.factories.length, expected === 30 ? 8 : 7);
    for (let i = 1; i < 12; i++) assert.notEqual(s.core.createCompatibilityReadCore(), first);
    assert.equal(s.factories.length, expected);
    for (const id of ids(text)) {
      const count = expected === 30 ? (mutable.includes(id) ? 12 : 1) : (id.endsWith('/commitmentRevision.ts') ? 0 : 1);
      assert.equal(s.factories.filter(x => x === id).length, count);
    }
  }
});
test('read V no definition prewarm before sample admission and CPU skip', () => {
  const s = make(); s.bucket = 0; assert.equal(s.observer.run().status, 'cpu_skipped'); assert.equal(s.factories.length, 0);
  s.bucket = 9000; s.game.time = 200; s.observer.run(); assert.equal(s.factories.length, 7);
});
test('read V disabled preview never loads definitions', () => {
  const s = make(); const observer = s.api.createTreasuryCompatPreview({ ...s.cfg, enabled: false }, s.ports, { cpuDiagnostics: true });
  assert.equal(observer.run().status, 'disabled'); assert.equal(s.factories.length, 0);
});
test('read V initialization cost remains in the admitted readerLoad interval', () => {
  const s = make(newText(), true, (_id, state) => { state.cpuValue += 0.01; });
  s.observer.run(); const first = s.report(); s.game.time = 200; s.cpuValue = 0.1; s.observer.run(); const second = s.report();
  assert.ok(first.cpuProfile.phases.readerLoad >= 0.0699); assert.equal(second.cpuProfile.phases.readerLoad, 0);
  assert.equal(first.cpuProfile.calls.readerLoad, 1); assert.equal(second.cpuProfile.calls.readerLoad, 1);
  assert.equal(s.factories.length, 7); // Cost model only, not an engine speed claim.
});
for (const name of Object.keys(S.scenarios)) test('read V real-core A/B byte equivalence: ' + name, () => {
  const r = S.compareScenario(name); assert.equal(r.byteEquivalent, true); assert.deepEqual(r.writes, [0, 0]);
  assert.equal(r.reports, 12); assert.deepEqual(r.readers, [12, 12]);
  assert.equal(r.oldFactoryExecutions, 30); assert.equal(r.newFactoryExecutions, 7);
});
test('read V same-tick task mutation without revision changes is visible', () => {
  const s = make(); s.memory.data.resourceControl.tasks.t = task(); const a = build(s);
  s.memory.data.resourceControl.tasks.t.remainingAmount = 12; const b = build(s);
  assert.equal(a.index.outgoing('W1N1', 'H'), 70); assert.equal(b.index.outgoing('W1N1', 'H'), 12);
  assert.equal(a.index.revision, 0); assert.equal(b.index.revision, 0); assert.notEqual(a.index, b.index);
});
test('read V observation snapshots and resource caches do not cross builds', () => {
  const s = make(); const a = build(s); const old = H.json(a.observation.data); a.observation.roomResources('W1N1'); a.observation.empireResources();
  s.game.rooms.W1N1.storage.store.O = 444; s.game.rooms.W1N1.storage.id = 'replacement'; const b = build(s);
  assert.deepEqual(H.json(a.observation.data), old); assert.equal(b.observation.amount('W1N1', 'storage', 'O'), 444);
  assert.equal(b.observation.location('W1N1', 'storage').structureId, 'replacement');
  assert.ok(!a.observation.roomResources('W1N1').includes('O')); assert.ok(b.observation.roomResources('W1N1').includes('O'));
});
test('read V same builder still creates fresh observations and indexes on every call', () => {
  const s = make(); const r = s.core.createCompatibilityReadCore(); const a = build(s, r); const b = build(s, r);
  assert.notEqual(a.observation, b.observation); assert.notEqual(a.index, b.index); assert.notEqual(a.index.metrics, b.index.metrics);
});
test('read V whole Game and Memory root replacements are observed dynamically', () => {
  const s = make(); build(s); s.game = { time: 900, rooms: { W1N1: H.makeRoom() }, getObjectById: () => null };
  s.memory = { runtime: { treasuryWorldSequence: 7, resourceReservations: { r: reservation({ amount: 91, expiresAt: 1000 }) } }, data: { resourceControl: { tasks: {} } } };
  const b = build(s); assert.equal(b.observation.epoch.observedAtTick, 900); assert.equal(b.observation.epoch.worldSequence, 7); assert.equal(b.index.reservedProduction('W1N1', 'H'), 91);
});
test('read V changing health configuration is not cached with definitions', () => {
  const s = make(); s.game.time = 1000; s.memory.data.resourceControl.tasks.t = task({ origin: 'automatic', lastProgressAt: 1 });
  s.memory.cfg = { resourceControl: { capacityBalancing: { automaticTaskNoProgressTtl: 2000 } } };
  const a = build(s); assert.equal(a.index.incoming('W2N1', 'H'), 70);
  s.memory.cfg.resourceControl.capacityBalancing.automaticTaskNoProgressTtl = 100;
  const b = build(s); assert.equal(b.index.incoming('W2N1', 'H'), 0); assert.equal(a.index.incoming('W2N1', 'H'), 70);
});
test('read V changing resource catalog is captured in every fresh commitment module', () => {
  const s = make(); s.memory.data.resourceControl.tasks.t = task({ resource: 'new-test-resource' });
  assert.equal(build(s).index.completeness.complete, false); s.resources = [...s.resources, 'new-test-resource'];
  const b = build(s); assert.equal(b.index.completeness.complete, true); assert.equal(b.index.outgoing('W1N1', 'new-test-resource'), 70);
});
test('read V holder resolver uses current ownership instead of first sample ownership', () => {
  const s = make(); s.memory.runtime.resourceReservations.r = reservation();
  const a = build(s); assert.equal(a.index.metrics.typedOwnerResolved, 1);
  s.game.rooms.W1N1.controller.my = false; const b = build(s);
  assert.equal(b.index.metrics.typedOwnerResolved, 0); assert.equal(b.index.reservedProduction('W1N1', 'H'), 25);
});
test('read V reservation expiration remains strict and records are not deleted', () => {
  const s = make(); s.memory.runtime.resourceReservations.r = reservation({ expiresAt: 100 });
  assert.equal(build(s).index.reservedProduction('W1N1', 'H'), 25); s.game.time = 101;
  assert.equal(build(s).index.reservedProduction('W1N1', 'H'), 0); assert.ok(s.memory.runtime.resourceReservations.r);
});
test('read V private revision zero is neither global host state nor an exposed mutation API', () => {
  for (const text of [oldText(), newText()]) {
    const s = make(text); s.memory.runtime.treasuryCommitmentRevision = 12345;
    const a = build(s); const b = build(s);
    assert.equal(a.index.revision, 0); assert.equal(b.index.revision, 0);
    assert.deepEqual(Object.keys(s.core), ['createCompatibilityReadCore']);
    assert.deepEqual(Object.keys(a.readers).sort(), ['buildCommitments', 'buildObservation']);
  }
});
test('read V failed first initialization does not publish partial shared modules', () => {
  const s = make(); let first = true;
  Object.defineProperty(s, 'resources', { configurable: true, get() { if (first) { first = false; throw new Error('catalog unavailable'); } return ['energy', 'H']; } });
  assert.throws(() => s.core.createCompatibilityReadCore()); assert.equal(s.factories.length, 7);
  s.core.createCompatibilityReadCore(); assert.equal(s.factories.length, 14);
  s.core.createCompatibilityReadCore(); assert.equal(s.factories.length, 14);
});
test('read V failed later initialization does not poison successful definitions', () => {
  const s = make(); s.core.createCompatibilityReadCore(); let bad = true;
  Object.defineProperty(s, 'resources', { get() { if (bad) throw new Error('catalog unavailable'); return ['energy', 'H']; } });
  assert.throws(() => s.core.createCompatibilityReadCore()); bad = false; build(s);
  assert.equal(s.factories.length, 7);
});
test('read V build exception does not expose stale index in next sample', () => {
  const s = make(); s.memory.runtime.resourceReservations.r = reservation(); s.game.getObjectById = () => { throw new Error('lookup'); };
  s.memory.runtime.resourceReservations.r.holderId = '1234567890abcdef12345678'; assert.throws(() => build(s));
  s.game.getObjectById = () => ({ room: { name: 'W1N1' } }); assert.equal(build(s).index.metrics.typedOwnerResolved, 1);
});
test('read V global reset repeats initialization and retains no prior snapshot', () => {
  const a = make(); build(a); build(a); const b = make(); build(b); assert.equal(a.factories.length, 7); assert.equal(b.factories.length, 7);
});
test('read V long run initializes only seven definitions with fresh private catalog per builder', () => {
  const s = make(); for (let i = 0; i < 500; i++) s.core.createCompatibilityReadCore();
  assert.equal(s.factories.length, 7); for (const id of ids(newText()).filter(x => !x.endsWith('/commitmentRevision.ts'))) assert.equal(s.factories.filter(x => x === id).length, 1);
});
test('read V malformed pinned input is rejected before regeneration', () => {
  assert.throws(() => G.generate(Buffer.from(oldText().replace('let commitmentRevision = 0;', 'let commitmentRevision = 1;')), Buffer.from(''), {}), /CORE_BASELINE_MISMATCH/);
});
test('read V inherited dependency property never becomes a host import', () => {
  const text = newText().replace('require("@/runtime/treasury/types")', 'require("toString")');
  const s = make(text); assert.throws(() => s.core.createCompatibilityReadCore(), /unlisted read import/);
});
test('read V generator is byte deterministic and idempotent on metadata', () => {
  const original = Buffer.from(oldText()); const template = fs.readFileSync(path.join(H.ROOT, G.TEMPLATE));
  const manifest = JSON.parse(fs.readFileSync(path.join(H.ROOT, G.SOURCE_MANIFEST)));
  const a = G.generate(original, template, manifest); const b = G.generate(original, template, JSON.parse(a[G.SOURCE_MANIFEST]));
  for (const name of Object.keys(a)) assert.ok(a[name].equals(b[name]));
});
test('read V generator provenance keeps all eight canonical source identities', () => {
  const p = JSON.parse(fs.readFileSync(path.join(H.ROOT, G.PROVENANCE))); assert.equal(p.factories.length, 8);
  assert.equal(p.factories.filter(x => x.lifecycle === 'shared-definition').length, 7); assert.equal(p.engineCpuGapRepaired, false);
  assert.equal(p.generatedSha256, crypto.createHash('sha256').update(newText()).digest('hex'));
  assert.equal(p.reversibleAttributionTransform, true); assert.equal(p.attributionRules.length, 14);
});

// V-specific regressions: explicit contexts, not ambient mutable dispatch slots.
test('read V simultaneously live builders retain distinct catalog snapshots in both call orders', () => {
  for (const text of [oldText(), newText()]) {
    const s = make(text); s.resources = ['energy', 'H']; const a = s.core.createCompatibilityReadCore();
    s.resources = ['energy', 'H', 'V_test']; const b = s.core.createCompatibilityReadCore();
    s.resources = []; s.memory.data.resourceControl.tasks.t = task({ resource: 'V_test' });
    assert.equal(build(s, b).index.outgoing('W1N1', 'V_test'), 70);
    assert.equal(build(s, a).index.completeness.complete, false);
    assert.equal(build(s, b).index.completeness.complete, true);
    assert.equal(build(s, a).index.outgoing('W1N1', 'V_test'), 0);
  }
});
test('read V catalog mutation in place after factory creation cannot change existing context', () => {
  const s = make(); s.resources = ['energy', 'H']; const a = s.core.createCompatibilityReadCore();
  s.resources.push('V_test'); const b = s.core.createCompatibilityReadCore(); s.resources.length = 0;
  s.memory.data.resourceControl.tasks.t = task({ resource: 'V_test' });
  assert.equal(build(s, a).index.completeness.complete, false); assert.equal(build(s, b).index.completeness.complete, true);
});
test('read V nested builder creation during outer reservation validation does not swap contexts', () => {
  for (const text of [oldText(), newText()]) {
    const s = make(text); s.resources = ['energy', 'H']; const a = s.core.createCompatibilityReadCore();
    s.memory.runtime.resourceReservations = { one: reservation(), two: reservation({ holderId: 'task:other', amount: 40 }) };
    const observation = a.buildObservation({ scope: 'market-fresh', epochSeq: 1, rooms: Object.values(s.game.rooms) });
    let inner;
    const index = a.buildCommitments({ tick: 100, tasks: {}, reservations: s.memory.runtime.resourceReservations, observation, holderExists: () => {
      s.resources = ['energy']; const b = s.core.createCompatibilityReadCore();
      inner = b.buildCommitments({ tick: 100, tasks: { t: task() }, reservations: {}, observation }); return true;
    } });
    assert.equal(inner.completeness.complete, false); assert.equal(index.completeness.complete, true);
    assert.equal(index.reservedProduction('W1N1', 'H'), 65);
  }
});
test('read V catalog is captured exactly once per builder, including warm calls', () => {
  for (const text of [oldText(), newText()]) {
    const s = make(text); let reads = 0; Object.defineProperty(s, 'resources', { get() { reads++; return ['energy', 'H']; } });
    const a = s.core.createCompatibilityReadCore(); const b = s.core.createCompatibilityReadCore();
    assert.equal(reads, 2); build(s, a); build(s, b); build(s, a); assert.equal(reads, 2);
  }
});
test('read V catalog capture remains inside readerLoad rather than an unaccounted prewarm', () => {
  const s = make(); let reads = 0;
  Object.defineProperty(s, 'resources', { get() { reads++; s.cpuValue += 0.125; return ['energy', 'H']; } });
  s.observer.run(); assert.equal(s.report().cpuProfile.calls.readerLoad, 1);
  assert.ok(s.report().cpuProfile.phases.readerLoad >= 0.125 - 1e-10); assert.equal(reads, 1);
  s.game.time = 200; s.cpuValue = 0.1; s.observer.run(); assert.equal(reads, 2);
  assert.ok(s.report().cpuProfile.phases.readerLoad >= 0.125 - 1e-10);
});
test('read V warm catalog exceptions still fail closed with no old business output fallback', () => {
  const s = make(); s.observer.run(); s.game.time = 200;
  Object.defineProperty(s, 'resources', { get() { throw new Error('unavailable catalog'); } });
  assert.equal(s.observer.run().status, 'fault_disabled');
  assert.equal(s.report().status, 'fault_disabled'); assert.equal(s.observer.stats().retainedEndpoints, 0);
});
test('read V changing mutable task data during a nested call leaves earlier index snapshot fixed', () => {
  const s = make(); s.memory.data.resourceControl.tasks.t = task(); const a = build(s);
  s.memory.data.resourceControl.tasks.t.remainingAmount = 18; const b = build(s);
  s.memory.data.resourceControl.tasks.t.remainingAmount = 5; const c = build(s, a.readers);
  assert.deepEqual([a.index.outgoing('W1N1', 'H'), b.index.outgoing('W1N1', 'H'), c.index.outgoing('W1N1', 'H')], [70, 18, 5]);
});
function apiSnapshot(s, reader) {
  const b = build(s, reader), i = b.index; const rows = [];
  for (const room of ['W1N1', 'W2N1', 'W3N1']) for (const resource of ['H', 'energy', 'U', 'invalid']) rows.push({
    room, resource, completeness: i.commitmentCompleteness(room, resource), outgoing: i.outgoing(room, resource),
    pendingOutgoing: i.pendingOutgoing(room, resource), reason: i.pendingOutgoing(room, resource, 'reason'),
    incoming: i.incoming(room, resource), pendingIncoming: i.pendingIncoming(room, resource),
    production: i.reservedProduction(room, resource),
    excluding: i.reservedProduction(room, resource, { kind: 'logical-service', namespace: 'synthesis', id: 'synthesis:W1N1:H' }),
  });
  const rooms = ['W1N1', 'W2N1', 'W3N1'].map(room => ({ room, incoming: i.incomingTaskCount(room), outgoing: i.outgoingTaskCount(room), receiver: i.receiverCommitments(room) }));
  const merge = i.findMergeableTaskId('H', 'W1N1', 'W2N1', 'manual', 'reason-a');
  return H.json({ keys: Object.keys(i).sort(), revision: i.revision, builtAtTick: i.builtAtTick, completeness: i.completeness,
    rows, rooms, merge, reservations: i.reservationSnapshot(), metrics: i.metrics, observation: b.observation.data });
}
for (const mode of ['manual', 'automatic', 'invalid', 'overflow', 'typed', 'exactExpiry']) test('read V complete index API parity: ' + mode, () => {
  function setup(s) {
    s.game.time = 1000; s.memory.data.resourceControl.tasks = { a: task({ id: 'a', reason: 'reason-a' }), b: task({ id: 'b', reason: 'reason-b', remainingAmount: 20 }) };
    s.memory.runtime.resourceReservations = { r: reservation({ expiresAt: 2000 }) };
    if (mode === 'automatic') { for (const t of Object.values(s.memory.data.resourceControl.tasks)) Object.assign(t, { origin: 'automatic', blockedReason: 'source_depleted', blockedSince: 50 }); }
    if (mode === 'invalid') { s.memory.data.resourceControl.tasks.bad = task({ resource: 'invalid' }); s.memory.runtime.resourceReservations.bad = null; }
    if (mode === 'overflow') for (const t of Object.values(s.memory.data.resourceControl.tasks)) Object.assign(t, { amount: Number.MAX_SAFE_INTEGER, remainingAmount: Number.MAX_SAFE_INTEGER });
    if (mode === 'typed') s.memory.runtime.resourceReservations.x = reservation({ amount: 75, expiresAt: 2000, owner: { kind: 'task', id: 'synthesis:W1N1:H' } });
    if (mode === 'exactExpiry') s.memory.runtime.resourceReservations.r.expiresAt = 1000;
  }
  const a = make(oldText()), b = make(newText()); setup(a); setup(b);
  const ca = { writes: 0 }, cb = { writes: 0 }; a.memory = H.guard(a.memory, ca); b.memory = H.guard(b.memory, cb);
  assert.deepEqual(apiSnapshot(a), apiSnapshot(b)); assert.deepEqual([ca.writes, cb.writes], [0, 0]);
});
test('read V receiver projections still read per-index dynamic capacity callbacks', () => {
  const s = make(); const r = s.core.createCompatibilityReadCore(); const observation = r.buildObservation({ scope: 'market-fresh', epochSeq: 1, rooms: Object.values(s.game.rooms) });
  let delta = 0; const i = r.buildCommitments({ tick: 100, tasks: {}, reservations: {}, observation, capacityDelta: () => delta, strictCapacityDelta: () => delta / 2 });
  const a = i.receiverCommitments('W1N1'); delta = 64; const b = i.receiverCommitments('W1N1');
  assert.equal(a.projectedStorageHeadroom - b.projectedStorageHeadroom, 64);
  assert.equal(a.strictStorageHeadroom - b.strictStorageHeadroom, 32);
});
for (const resources of [['energy'], ['energy', 'H'], ['energy', 'H', 'O', 'U']]) test('read V endpoint Store access reuse preserves every method and core read: ' + resources.length, () => {
  const a = S.measureStoreReads(oldText(), resources), b = S.measureStoreReads(newText(), resources);
  assert.equal(a.directStorePropertyReads, 4 * (4 + resources.length)); assert.equal(b.directStorePropertyReads, 4);
  assert.equal(a.coreStorePropertyReads, b.coreStorePropertyReads); assert.equal(b.coreStorePropertyReads, 12);
  assert.deepEqual(a.methods, b.methods); assert.equal(a.line, b.line);
});
test('read V endpoint-local Store reuse never carries a Store into the next sample', () => {
  const s = make(); s.observer.run(); const old = s.report().endpoints[0].direct;
  s.game.rooms.W1N1 = H.makeRoom(); s.game.rooms.W1N1.storage.store.H = 999;
  s.game.time = 200; s.observer.run(); const now = s.report().endpoints[0].direct;
  assert.equal(old.amounts.H, 300); assert.equal(now.amounts.H, 999);
  assert.equal(s.report().endpoints[0].coreComparison, 'match_selected_scope');
});
test('read V direct methods still run independently of sparse observation data', () => {
  const s = make(); const store = s.game.rooms.W1N1.storage.store;
  Object.defineProperty(store, 'getUsedCapacity', { value: r => r === 'H' ? 299 : r ? store[r] || 0 : 4300, configurable: true });
  s.observer.run(); const row = s.report().endpoints[0]; assert.equal(row.directStatus, 'ok'); assert.equal(row.coreComparison, 'mismatch'); assert.ok(row.coreMismatches.includes('H'));
});
test('read V missing or throwing Store remains unreadable and is not replaced with a projection', () => {
  for (const text of [oldText(), newText()]) {
    const s = make(text); Object.defineProperty(s.game.rooms.W1N1.storage, 'store', { get() { throw new Error('store inaccessible'); } });
    s.observer.run(); assert.equal(s.report().endpoints[0].directStatus, 'unreadable'); assert.equal(s.report().endpoints[0].coreComparison, 'not_read');
  }
});
test('read V native Store method exception preserves fail-closed endpoint behavior', () => {
  const s = make(); Object.defineProperty(s.game.rooms.W1N1.storage.store, 'getCapacity', { value() { throw new Error('capacity unavailable'); } });
  s.observer.run(); assert.equal(s.report().endpoints[0].directStatus, 'unreadable');
});
test('read V preview accessor-table guard is unchanged and does not invoke the builder', () => {
  const s = make(); let invoked = 0; Object.defineProperty(s.memory.data.resourceControl.tasks, 'bad', { enumerable: true, get() { invoked++; throw new Error('must not invoke'); } });
  s.observer.run(); assert.equal(invoked, 0); assert.equal(s.calls.commitments, 0); assert.equal(s.report().legacyInputs.tasks.status, 'accessor_unreadable');
});
test('read V canonical transform refuses a shifted body rather than approximating a match', () => {
  const prefix = oldText().split(G.MARKER)[0]; assert.throws(() => G.X.transform(prefix.replace('new Set(RESOURCES_ALL)', 'new Set([])')), /CONTEXT_TRANSFORM_COUNT/);
});
test('read V layer only adapts commitment context and its edge after reversing VII layer', () => {
  const before = oldText().split(G.MARKER)[0], after = G.B.restore(G.A.restore(newText().split('/** Read Optimization V:')[0]));
  const [a, b] = G.X.region(before), [c, d] = G.X.region(after);
  assert.equal(before.slice(0, a), after.slice(0, c));
  assert.equal(G.X.restore(after), before); assert.notEqual(before.slice(a, b), after.slice(c, d));
});
test('read V stale observation epoch is still rejected by the preview', () => {
  const s = make(); const old = s.ports.readers; s.ports.readers = () => { const r = old(); return { ...r, buildObservation: opts => ({ ...r.buildObservation(opts), epoch: { observedAtTick: 1 } }) }; };
  assert.equal(s.observer.run().status, 'fault_disabled');
});
test('read V catalog omission context mutation is detected by a semantic negative control', () => {
  const text = newText().replace('new Set(RESOURCES_ALL)', 'new Set(["energy"])');
  const s = make(text); s.memory.data.resourceControl.tasks.t = task(); assert.equal(build(s).index.completeness.complete, false);
  const correct = make(); correct.memory.data.resourceControl.tasks.t = task(); assert.equal(build(correct).index.completeness.complete, true);
});
