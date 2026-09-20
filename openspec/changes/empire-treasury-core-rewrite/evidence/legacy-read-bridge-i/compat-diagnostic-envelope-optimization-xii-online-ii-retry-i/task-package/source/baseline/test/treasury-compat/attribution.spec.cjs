'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const A = require('./attribution-test-support.cjs');
const { S, H } = A;
const G = require(path.join(H.ROOT, 'scripts/build-treasury-compat-loader.cjs'));

// CPU-accounting unit boundaries: nested attribution never replaces the parent total.
test('IX accounting omits attribution when no boundary or work was recorded', () => {
  const api = H.load('treasuryCompatCpu.ts'); const a = api.createCompatCpuAccounting(1, 100, 1);
  a.checkpoint(1.5, 'directRead'); const p = a.snapshot('beforeSerialization');
  assert.equal(p.elapsed, 0.5); assert.equal(p.attribution, undefined);
});
test('IX accounting records bounded nested intervals and keeps parent elapsed independent', () => {
  const api = H.load('treasuryCompatCpu.ts'); const a = api.createCompatCpuAccounting(1, 100, 1);
  a.attributionBoundary(1.1, 'observationSetup'); a.attributionBoundary(1.3, 'observationRooms');
  a.attributionBoundary(1.6); a.attributionWork({ observationRooms: 2, observationLocations: 4 });
  let p = a.snapshot('beforeSerialization');
  assert.equal(p.elapsed, 0); assert.equal(p.attribution.boundaries, 3); assert.equal(p.attribution.active, null);
  assert.ok(Math.abs(p.attribution.intervals.observationSetup - 0.2) < 1e-12);
  assert.ok(Math.abs(p.attribution.intervals.observationRooms - 0.3) < 1e-12);
  a.checkpoint(1.7); p = a.snapshot('beforeSerialization'); assert.ok(Math.abs(p.elapsed - 0.7) < 1e-12);
});
test('IX accounting exposes an active region on a fault snapshot instead of inventing an end', () => {
  const api = H.load('treasuryCompatCpu.ts'); const a = api.createCompatCpuAccounting(0, 100, 1);
  a.attributionBoundary(0.1, 'commitmentTasks'); const p = a.snapshot('fault');
  assert.equal(p.attribution.active, 'commitmentTasks'); assert.equal(p.attribution.intervals.commitmentTasks, 0);
});
test('IX accounting accumulates primitive work and freezes snapshots', () => {
  const api = H.load('treasuryCompatCpu.ts'); const a = api.createCompatCpuAccounting(0, 100, 1);
  a.attributionWork({ commitmentTaskRecords: 2 }); a.attributionWork({ commitmentTaskRecords: 3, commitmentPendingTaskRecords: 4 });
  const p = a.snapshot('beforeSerialization'); assert.equal(p.attribution.work.commitmentTaskRecords, 5);
  assert.equal(p.attribution.work.commitmentPendingTaskRecords, 4); assert.ok(Object.isFrozen(p.attribution.work));
  assert.ok(Object.isFrozen(p.attribution.intervals)); assert.ok(Object.isFrozen(p.attribution));
});
test('IX accounting rejects unknown, negative, fractional and overflowing work', () => {
  const api = H.load('treasuryCompatCpu.ts');
  for (const value of [{ nope: 1 }, { observationRooms: -1 }, { observationRooms: 1.5 }]) {
    const a = api.createCompatCpuAccounting(0, 100, 1); assert.throws(() => a.attributionWork(value));
  }
  const a = api.createCompatCpuAccounting(0, 100, 1); a.attributionWork({ observationRooms: Number.MAX_SAFE_INTEGER });
  assert.throws(() => a.attributionWork({ observationRooms: 1 }));
});
test('IX accounting rejects non-monotonic and unlisted subphase boundaries', () => {
  const api = H.load('treasuryCompatCpu.ts'); const a = api.createCompatCpuAccounting(1, 100, 1);
  assert.throws(() => a.attributionBoundary(0.9, 'observationSetup'));
  assert.throws(() => a.attributionBoundary(1.1, 'not-real'));
  a.attributionBoundary(1.2, 'observationSetup'); assert.throws(() => a.attributionBoundary(1.1));
});

// Exact authoring and callback placement.
test('IX transform exactly restores the committed Build VII core prefix', () => {
  const marker = '/** Read Optimization V:';
  assert.equal(G.A.restore(A.afterText().split(marker)[0]), A.beforeText().split(marker)[0]);
  assert.equal(G.A.rules.length, 14); const generated = G.generate(fs.readFileSync(path.join(H.ROOT, G.FIXTURE)), fs.readFileSync(path.join(H.ROOT, G.TEMPLATE)), JSON.parse(fs.readFileSync(path.join(H.ROOT, G.SOURCE_MANIFEST), 'utf8'))); assert.equal(generated[G.GENERATED].length, 68416);
});
test('IX transform refuses shifted source instead of approximately instrumenting it', () => {
  const prefix = A.beforeText().split('/** Read Optimization V:')[0];
  assert.throws(() => G.A.transform(prefix.replace('const tick = options.tick;', 'const tick  = options.tick;')), /ATTRIBUTION_TRANSFORM_COUNT/);
});
test('IX direct builder callback sequence is coarse and deterministic', () => {
  const x = A.directBuild();
  assert.deepEqual(x.d.boundaries, ['observationSetup','observationRooms','observationFinalize','observationView',null,
    'commitmentSetup','commitmentTasks','commitmentReservations','commitmentFinalize',null]);
});
test('IX empty direct build reports bounded observation and commitment work', () => {
  const { d } = A.directBuild();
  assert.deepEqual({ rooms: d.work.observationRooms, locations: d.work.observationLocations,
    existing: d.work.observationExistingLocations, keys: d.work.observationResourceKeys }, { rooms: 2, locations: 4, existing: 4, keys: 8 });
  assert.equal(d.work.commitmentTaskRecords, 0); assert.equal(d.work.commitmentReservationRecords, 0);
  assert.equal(d.work.commitmentScopeBuckets, 0); assert.equal(d.work.commitmentRoomBuckets, 0);
});
test('IX task work counters describe validation, health and route composition', () => {
  const { d } = A.directBuild(undefined, s => {
    s.memory.data.resourceControl.tasks.a = S.task({ id: 'a' });
    s.memory.data.resourceControl.tasks.b = S.task({ id: 'b', origin: 'automatic' });
    s.memory.data.resourceControl.tasks.bad = S.task({ id: 'bad', remainingAmount: -1 });
  });
  assert.equal(d.work.commitmentTaskRecords, 3); assert.equal(d.work.commitmentPendingTaskRecords, 2);
  assert.equal(d.work.commitmentTaskInvalidEvents, 1); assert.equal(d.work.commitmentDemandHealthChecks, 2);
  assert.equal(d.work.commitmentReceiverHealthChecks, 2); assert.equal(d.work.commitmentRouteCandidates, 2);
});
test('IX reservation work counters separate invalid events, owner evaluations and active rows', () => {
  const { d } = A.directBuild(undefined, s => {
    s.memory.runtime.resourceReservations.active = S.reservation({ expiresAt: 500 });
    s.memory.runtime.resourceReservations.expired = S.reservation({ holderId: 'task:old', expiresAt: 99 });
    s.memory.runtime.resourceReservations.bad = null;
  });
  assert.equal(d.work.commitmentReservationRecords, 3); assert.equal(d.work.commitmentReservationInvalidEvents, 1);
  assert.equal(d.work.commitmentOwnerEvaluations, 2); assert.equal(d.work.commitmentActiveReservations, 1);
});
test('IX work reports final private index sizes without exposing the maps', () => {
  const { d } = A.directBuild(undefined, s => {
    s.memory.data.resourceControl.tasks.a = S.task({ id: 'a' });
    s.memory.runtime.resourceReservations.r = S.reservation();
  });
  for (const key of ['commitmentScopeBuckets','commitmentRoomBuckets','commitmentMergeRoutes','commitmentReservationScopes']) {
    assert.equal(Number.isSafeInteger(d.work[key]), true); assert.ok(d.work[key] >= 1);
  }
});
test('IX diagnostics are optional and absent callbacks preserve Build VII direct API bytes', () => {
  const a = A.directBuild(A.beforeText()), b = A.directBuild(A.afterText());
  const snapshot = x => H.json({ observation: x.observation.data, completeness: x.index.completeness,
    outgoing: x.index.outgoing('W1N1','H'), incoming: x.index.incoming('W2N1','H'), metrics: x.index.metrics });
  assert.deepEqual(snapshot(a), snapshot(b));
});

// Full preview integration and bounded CPU-port sampling.
test('IX real preview emits all nine subphase intervals and closes the active region', () => {
  const s = A.diagnosticScene(); assert.equal(s.observer.run().status, 'sampled');
  const a = s.report().cpuProfile.attribution;
  assert.equal(a.boundaries, 12); assert.equal(a.active, null);
  for (const key of ['observationSetup','observationRooms','observationFinalize','observationView','commitmentSetup','commitmentTasks','commitmentReservations','commitmentFinalize','projectionRows']) {
    assert.equal(typeof a.intervals[key], 'number'); assert.ok(a.intervals[key] >= 0);
  }
});
test('IX real preview reports projection plan, completed rows and exact query count', () => {
  const s = A.diagnosticScene(); s.observer.run(); const w = s.report().cpuProfile.attribution.work;
  assert.equal(w.projectionRowsPlanned, 4); assert.equal(w.projectionRowsCompleted, 4); assert.equal(w.projectionIndexQueries, 16);
  assert.equal(s.report().commitments.rows.length, 4);
});
test('IX preview attribution remains nested in existing top-level calls and phases', () => {
  const s = A.diagnosticScene(); s.observer.run(); const p = s.report().cpuProfile;
  assert.deepEqual(p.calls, { readerLoad: 1, observationBuild: 1, commitmentBuild: 1 });
  for (const key of ['readerLoad','observationBuild','commitmentBuild','commitmentProjection']) assert.equal(typeof p.phases[key], 'number');
  assert.ok(p.elapsed >= p.phases.observationBuild); assert.ok(p.elapsed >= p.phases.commitmentBuild);
});
test('IX diagnostics-disabled preview emits no cpuProfile and remains byte-identical to Build VII', () => {
  const a = S.make(A.beforeText(), false), b = S.make(A.afterText(), false);
  a.observer.run(); b.observer.run(); assert.equal(a.lines[0], b.lines[0]);
  assert.equal(Object.hasOwn(JSON.parse(b.lines[0]), 'cpuProfile'), false);
});
test('IX CPU-port reads remain bounded rather than scaling with 256 tasks', () => {
  const empty = A.diagnosticScene(); empty.observer.run();
  const full = A.diagnosticScene(s => { for (let i = 0; i < 256; i++) s.memory.data.resourceControl.tasks[i] = S.task({ id: 't'+i }); });
  full.observer.run(); assert.equal(full.calls.cpu, empty.calls.cpu);
  assert.equal(full.report().cpuProfile.attribution.work.commitmentTaskRecords, 256);
});
test('IX first and later samples each retain only their own primitive attribution snapshot', () => {
  const s = A.diagnosticScene(); s.observer.run(); const first = H.json(s.report().cpuProfile.attribution);
  s.memory.data.resourceControl.tasks.x = S.task(); s.game.time = 200; s.cpuValue = 0.1; s.observer.run();
  assert.equal(s.report().cpuProfile.attribution.work.commitmentTaskRecords, 1);
  assert.equal(first.work.commitmentTaskRecords, 0); assert.equal(s.report().previousCpuProfile.attribution.work.commitmentTaskRecords, 0);
});
test('IX partial projection reports planned and completed rows without manufacturing completeness', () => {
  const s = A.diagnosticScene(undefined, 0.11); s.cfg = { ...s.cfg, maxSampleCpu: 2 };
  s.observer = s.api.createTreasuryCompatPreview(s.cfg, s.ports, { cpuDiagnostics: true });
  s.observer.run(); const r = s.report(), w = r.cpuProfile.attribution?.work || {};
  assert.equal(r.status, 'partial_cpu_budget'); assert.ok((w.projectionRowsCompleted || 0) <= (w.projectionRowsPlanned || 4));
  if (r.commitments.rows) assert.equal(r.commitments.status, 'partial_cpu_budget');
});
test('IX invalid work callback faults only the compatibility preview, never old business state', () => {
  const s = A.diagnosticScene(); const original = s.ports.readers;
  s.ports.readers = () => { const r = original(); return { ...r, buildObservation(o) { o.compatDiagnostics.work({ observationRooms: -1 }); return r.buildObservation(o); } }; };
  s.observer = s.api.createTreasuryCompatPreview(s.cfg, s.ports, { cpuDiagnostics: true });
  const before = JSON.stringify(s.memory); assert.equal(s.observer.run().status, 'fault_disabled'); assert.equal(JSON.stringify(s.memory), before);
});

for (const name of Object.keys(S.scenarios)) test('IX Build VII/IX diagnostics-off byte parity: ' + name, () => {
  const r = A.compareScenario(name); assert.equal(r.byteEquivalent, true); assert.deepEqual(r.writes, [0,0]);
  assert.equal(r.readers[0], r.readers[1]); assert.equal(r.observations[0], r.observations[1]); assert.equal(r.commitments[0], r.commitments[1]);
});



function manifestFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-manifest-gate-'));
  for (const n of [G.FIXTURE, G.TEMPLATE, G.SOURCE_MANIFEST, G.GENERATED, G.PROVENANCE]) {
    const src = path.join(H.ROOT, n), dst = path.join(root, n);
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
  }
  return root;
}
function withManifestFixture(fn) { const root = manifestFixture(); try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } }
function generatedFor(root) { return G.generate(fs.readFileSync(path.join(root, G.FIXTURE)), fs.readFileSync(path.join(root, G.TEMPLATE)), JSON.parse(fs.readFileSync(path.join(root, G.SOURCE_MANIFEST), 'utf8'))); }

test('IX source manifest gate covers every listed output identity', () => {
  const m = JSON.parse(fs.readFileSync(path.join(H.ROOT, G.SOURCE_MANIFEST), 'utf8'));
  assert.deepEqual(m.outputs.map(x => x.file).sort(), G.EXPECTED_OUTPUT_PATHS);
  assert.equal(Object.keys(G.FIXED_OUTPUTS).length, 12); assert.equal(G.EXPECTED_OUTPUT_PATHS.length, 13);
  assert.equal(m.loaderOptimization.sourceManifestOutputValidation, 'all-listed-outputs');
});
test('IX generated-output gate rejects a stale manifest identity', () => withManifestFixture(root => {
  const result = generatedFor(root), p = path.join(root, G.SOURCE_MANIFEST), m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.outputs.find(x => x.file === 'src/runtime/treasuryCompatRuntime.ts').bytes = 839;
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  assert.throws(() => G.applyOrCheckGenerated(root, result, '--check'), /GENERATED_OUTPUT_MISMATCH:docs\/treasury-compat-source-manifest\.json/);
}));
test('IX fixed-output gate rejects a byte-changed listed output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-output-identity-'));
  try {
    const rel = 'src/runtime/treasuryCompatRead.ts', dst = path.join(root, rel); fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(H.ROOT, rel), dst); G.verifyOutputIdentities(root, { [rel]: G.FIXED_OUTPUTS[rel] });
    fs.appendFileSync(dst, '\n'); assert.throws(() => G.verifyOutputIdentities(root, { [rel]: G.FIXED_OUTPUTS[rel] }), /FIXED_SOURCE_MISMATCH/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('IX source manifest gate rejects missing or duplicate output rows', () => {
  for (const mutate of [m => m.outputs.pop(), m => m.outputs.push({ ...m.outputs[0] })]) withManifestFixture(root => {
    const p = path.join(root, G.SOURCE_MANIFEST), m = JSON.parse(fs.readFileSync(p, 'utf8')); mutate(m);
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
    assert.throws(() => generatedFor(root), /SOURCE_MANIFEST_OUTPUT_SET_MISMATCH/);
  });
});
