'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../tools/common.cjs'), F = require('./repository-fixture.cjs');
function withFixture(fn, options) { const root = F.fixture(options); try { return fn(root, F.helper(root)); } finally { F.remove(root); } }
test('repository helper and unmodified bridge spec match pinned Git blobs', () => {
  assert.equal(C.blob(C.fs.readFileSync(C.path.join(C.ROOT, 'baseline/test/treasury-compat/helpers.cjs'))), '238caabe0de507c9c026c594290d8e7bfeeca337');
  assert.equal(C.blob(C.fs.readFileSync(C.path.join(C.ROOT, 'references/repository-tests/bridge.spec.cjs'))), '8061a074218ba8a9ce81ec15b5da6e4ad9aa1d83');
});
test('old real repository sandbox reproduces unexpected CPU runtime import', () => {
  withFixture((root, h) => assert.throws(() => h.load('treasuryCompatRead.ts'), /unexpected runtime import: \.\/treasuryCompatCpu/), { legacy: true });
});
test('new exact sandbox mapping runs the unchanged real repository bridge suite', () => {
  withFixture(root => { const r = F.runBridge(root); assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const name of ['fail', 'skipped', 'todo', 'cancelled']) assert.match(r.stdout, new RegExp('^# ' + name + ' 0\\r?$', 'm'));
    assert.match(r.stdout, /^# tests 41\r?$/m); });
});
test('repository scene uses real CPU dependency without host require fallback', () => {
  withFixture((root, h) => { const s = h.scene(); assert.equal(s.observer.run().status, 'sampled');
    assert.equal(s.report().authorizesActions, false); assert.equal(s.report().commitments.status, 'read_complete'); });
});
test('disabled repository runtime stays inert without Game or Memory globals', () => {
  withFixture((root, h) => { const read = h.load('treasuryCompatRead.ts'), config = h.load('treasuryCompatConfig.ts');
    const runtime = h.load('treasuryCompatRuntime.ts', {}, { './treasuryCompatRead': read, './treasuryCompatConfig': config,
      './treasuryCompatReadCore.generated': { createCompatibilityReadCore() { throw Error('core must stay lazy'); } } });
    assert.equal(config.TREASURY_COMPAT_CONFIG.enabled, false); runtime.runTreasuryCompatRead(); });
});
test('sandbox explicit own imports retain priority', () => {
  withFixture((root, h) => { C.fs.writeFileSync(C.path.join(root, 'src/runtime/check.ts'), 'export const value = require("./explicit");');
    const identity = {}; assert.equal(h.load('check.ts', {}, { './explicit': identity }).value, identity); });
});
test('CPU mapping is scoped to treasuryCompatRead and cannot be requested by another parent', () => {
  withFixture((root, h) => { C.fs.writeFileSync(C.path.join(root, 'src/runtime/other.ts'), 'export const value = require("./treasuryCompatCpu");');
    assert.throws(() => h.load('other.ts'), /unexpected runtime import/); });
});
test('sandbox rejects host modules traversal and inherited import properties', () => {
  withFixture((root, h) => { const inherited = Object.create({ inherited: {} });
    for (const id of ['node:fs', '../treasuryCompatCpu', './treasuryCompatCpu.ts', 'inherited', 'toString']) {
      C.fs.writeFileSync(C.path.join(root, 'src/runtime/treasuryCompatRead.ts'), 'export const value = require(' + JSON.stringify(id) + ');');
      assert.throws(() => h.load('treasuryCompatRead.ts', {}, inherited), /unexpected runtime import/);
    } });
});
test('CPU module is cached within one sandbox load and not across scene loads', () => {
  withFixture((root, h) => { C.fs.writeFileSync(C.path.join(root, 'src/runtime/treasuryCompatRead.ts'), 'export const a = require("./treasuryCompatCpu"); export const b = require("./treasuryCompatCpu");');
    const one = h.load('treasuryCompatRead.ts'), two = h.load('treasuryCompatRead.ts');
    assert.equal(one.a, one.b); assert.notEqual(one.a, two.a); });
});
test('CPU dependency missing from real tree is not replaced with a mock', () => {
  withFixture((root, h) => { C.fs.unlinkSync(C.path.join(root, 'src/runtime/treasuryCompatCpu.ts'));
    assert.throws(() => h.load('treasuryCompatRead.ts'), /ENOENT/); });
});
test('v2 runtime source bytes equal all three locked v1 implementation files', () => {
  const expected = {
    'treasuryCompatCpu.ts': '103e7a3e115fcc885fc337b91e7336cdb2cd3e890524f0c8b4d2f4082c0207ef',
    'treasuryCompatRead.ts': 'c14efedac18f865e1bf04fb5ce3ea8c954598f69add84fa0646b4c5470273d03',
    'treasuryCompatRuntime.ts': '9f8736eb9a0a45ba3a6390cada1d9790945e5609252da81d62d258b9f76254f4'
  };
  for (const [n, hash] of Object.entries(expected)) assert.equal(C.sha(C.fs.readFileSync(C.path.join(C.ROOT, 'implementation/src/runtime', n))), hash);
});
