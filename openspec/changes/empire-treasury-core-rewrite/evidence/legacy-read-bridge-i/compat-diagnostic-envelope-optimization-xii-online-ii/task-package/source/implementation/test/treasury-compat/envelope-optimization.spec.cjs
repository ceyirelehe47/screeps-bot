'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const S = require('./loader-test-support.cjs');
const A = require('./attribution-test-support.cjs');
const { H } = S;
const G = require(path.join(H.ROOT, 'scripts/build-treasury-compat-loader.cjs'));
const D = require(path.join(H.ROOT, 'scripts/lib/treasury-compat-envelope.cjs'));
const xiReader = () => fs.readFileSync(path.join(__dirname, 'fixtures/reader-before-envelope-optimization-xii.ts.txt'), 'utf8').replace(/\r\n/g, '\n');
const xiCpu = () => fs.readFileSync(path.join(__dirname, 'fixtures/cpu-before-envelope-optimization-xii.ts.txt'), 'utf8').replace(/\r\n/g, '\n');
const xiiReader = () => fs.readFileSync(H.file('treasuryCompatRead.ts'), 'utf8').replace(/\r\n/g, '\n');
const realmNeutral = value => JSON.stringify(value);
function cpuApi(text) {
  const js = S.ts.transpileModule(text, { compilerOptions: { module: S.ts.ModuleKind.CommonJS, target: S.ts.ScriptTarget.ES2019 } }).outputText;
  const ctx = vm.createContext({ exports: {} }); vm.runInContext(js, ctx, { timeout: 5000 }); return ctx.exports;
}
function sceneWithReader(text, diagnostics = false, setup = () => {}) {
  const s = S.make(A.afterText(), diagnostics); setup(s); s.api = S.readerApi(text);
  s.observer = s.api.createTreasuryCompatPreview(s.cfg, s.ports, { cpuDiagnostics: diagnostics }); return s;
}
function guardedRun(s, count = 12) {
  const g = { writes: 0 }; s.memory = H.guard(s.memory, g);
  for (let i = 1; i <= count; i++) { s.game.time = i * 100; s.cpuValue = 0.1; s.observer.run(); }
  return g;
}
function populateAccounting(api) {
  const a = api.createCompatCpuAccounting(0, 100, 1);
  a.attributionBoundary(0.02, 'observationSetup'); a.attributionBoundary(0.04, 'observationRooms');
  a.attributionBoundary(0.06); a.attributionWork({ observationRooms: 2, observationLocations: 4 });
  a.checkpoint(0.4, 'serializationAndSize'); a.checkpoint(0.6, 'emit'); a.checkpoint(0.7, 'retention'); a.checkpoint(0.75);
  return { prefix: a.snapshot('beforeSerialization'), completed: a.snapshot('afterRetention') };
}

test('XII preview transform is exact and exactly reversible over committed XI bytes', () => {
  assert.equal(D.transform(xiReader()), xiiReader()); assert.equal(D.restore(xiiReader()), xiReader());
  assert.equal(D.rules.length, 8); assert.ok(D.rules.every(x => x.replacements === 1));
});
test('XII preview transform refuses shifted source instead of approximate rewriting', () => {
  assert.throws(() => D.transform(xiReader().replace('const memory = ports.memory();', 'const memory  = ports.memory();')), /ENVELOPE_XII_TRANSFORM_COUNT/);
});
test('XII generator reproduces committed core, preview, provenance and manifest bytes', () => {
  const result = G.generate(fs.readFileSync(path.join(H.ROOT, G.FIXTURE)), fs.readFileSync(path.join(H.ROOT, G.TEMPLATE)),
    JSON.parse(fs.readFileSync(path.join(H.ROOT, G.SOURCE_MANIFEST), 'utf8')), fs.readFileSync(path.join(H.ROOT, G.PREVIEW_FIXTURE)));
  for (const [name, bytes] of Object.entries(result)) assert.equal(fs.readFileSync(path.join(H.ROOT, name)).toString('utf8').replace(/\r\n/g, '\n'), bytes.toString('utf8'));
  assert.equal(result[G.PREVIEW].length, 22660); assert.equal(G.D.rules.length, 8);
  const ix = fs.readFileSync(path.join(H.ROOT, G.PREVIEW_FIXTURE), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(G.P.transform(ix), xiiReader()); assert.equal(G.P.restore(xiiReader()), ix);
});
test('XII after-retention profile is a tail-only completion with exact allowed phases', () => {
  const p = populateAccounting(H.load('treasuryCompatCpu.ts')).completed;
  assert.equal(p.boundary, 'afterRetention'); assert.equal(p.completion, 'tail_only'); assert.equal(p.attribution, undefined);
  assert.deepEqual(Object.keys(p.phases).sort(), ['emit','retention','serializationAndSize']);
  assert.equal(realmNeutral(p.calls), realmNeutral({ readerLoad: 0, observationBuild: 0, commitmentBuild: 0 }));
});
test('XII tail-only completion serializes smaller than the prior full completion', () => {
  const old = populateAccounting(cpuApi(xiCpu())).completed, current = populateAccounting(H.load('treasuryCompatCpu.ts')).completed;
  assert.equal(old.completion, undefined); assert.ok(old.attribution); assert.equal(current.completion, 'tail_only');
  assert.ok(JSON.stringify(current).length < JSON.stringify(old).length);
  assert.equal(current.elapsed, old.elapsed); assert.equal(realmNeutral(current.calls), realmNeutral(old.calls));
});
test('XII diagnostics-off reports remain byte-identical to XI for every fixed scenario', () => {
  for (const name of Object.keys(S.scenarios)) {
    const a = sceneWithReader(xiReader(), false, S.scenarios[name]);
    const b = sceneWithReader(xiiReader(), false, S.scenarios[name]);
    const ga = guardedRun(a), gb = guardedRun(b);
    assert.equal(JSON.stringify(a.lines), JSON.stringify(b.lines), name);
    assert.deepEqual([ga.writes, gb.writes], [0, 0], name);
    assert.deepEqual([a.calls.readers,a.calls.observation,a.calls.commitments], [b.calls.readers,b.calls.observation,b.calls.commitments], name);
  }
});
test('XII prefix keeps full attribution while the successor carries only its tail', () => {
  const s = A.diagnosticScene(); s.observer.run(); const first = H.json(s.report().cpuProfile);
  s.game.time = 200; s.cpuValue = 0.1; s.observer.run(); const tail = s.report().previousCpuProfile;
  assert.equal(first.boundary, 'beforeSerialization'); assert.ok(first.attribution); assert.equal(tail.tick, first.tick);
  assert.equal(tail.sampleOrdinal, first.sampleOrdinal); assert.equal(tail.completion, 'tail_only'); assert.equal(tail.attribution, undefined);
  assert.equal(realmNeutral(tail.calls), realmNeutral(first.calls)); assert.ok(tail.elapsed >= first.elapsed); assert.ok(tail.checkpoints >= first.checkpoints);
});
test('XII preview allocation changes do not add CPU-port probes', () => {
  const a = sceneWithReader(xiReader(), true), b = sceneWithReader(xiiReader(), true);
  a.observer.run(); b.observer.run(); assert.equal(a.calls.cpu, b.calls.cpu);
  assert.equal(a.calls.readers, b.calls.readers); assert.equal(a.calls.observation, b.calls.observation); assert.equal(a.calls.commitments, b.calls.commitments);
});
test('XII root cursors preserve malformed-root and accessor status bytes', () => {
  const mutations = [
    m => { m.data = null; },
    m => { m.runtime = null; },
    m => { Object.defineProperty(m, 'data', { configurable: true, get() { throw new Error('must not invoke'); } }); },
    m => { Object.defineProperty(m, 'runtime', { configurable: true, get() { throw new Error('must not invoke'); } }); },
  ];
  for (const mutate of mutations) {
    const a = sceneWithReader(xiReader()), b = sceneWithReader(xiiReader()); mutate(a.memory); mutate(b.memory);
    a.observer.run(); b.observer.run(); assert.equal(a.lines[0], b.lines[0]);
  }
});
test('XII source manifest retains all output identities and records envelope flags', () => {
  const m = JSON.parse(fs.readFileSync(path.join(H.ROOT, G.SOURCE_MANIFEST), 'utf8'));
  assert.deepEqual(m.outputs.map(x => x.file).sort(), G.EXPECTED_OUTPUT_PATHS);
  assert.equal(m.loaderOptimization.revision, 'XII'); assert.equal(m.loaderOptimization.diagnosticCompletionTailOnly, true);
  assert.equal(m.loaderOptimization.sampleRootCursorReuse, true); assert.equal(m.loaderOptimization.boundedRoomMembershipNoSet, true);
  assert.equal(m.loaderOptimization.sourceManifestOutputValidation, 'all-listed-outputs');
});
