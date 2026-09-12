'use strict';
const os = require('node:os');
const C = require('../tools/common.cjs'), K = require('../tools/checks.cjs'), F = require('../tools/closeout.cjs');
const old = C.read(C.path.join(C.ROOT, 'tests/fixtures/v2-bytes.json')).files;
const tap = n => `TAP version 13\n1..${n}\n# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
function put(repo, n, b) { const path = C.path.join(repo, n); C.fs.mkdirSync(C.path.dirname(path), { recursive: true }); C.fs.writeFileSync(path, Buffer.isBuffer(b) ? b : typeof b === 'string' ? b : C.encoded(b)); }
function g(repo, args) { return C.git(repo, ['-c', 'user.name=Closeout isolated fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args]); }
function fixture() {
  const root = C.fs.mkdtempSync(C.path.join(os.tmpdir(), 'cpu closeout ')), compat = C.path.join(root, 'compat'), refactor = C.path.join(root, 'refactor');
  const p = JSON.parse(JSON.stringify(K.POLICY));
  for (const [repo, branch] of [[compat, p.compatBranch], [refactor, p.refactorBranch]]) {
    C.fs.mkdirSync(repo); g(repo, ['init', '-q', '-b', branch]); g(repo, ['config', 'core.autocrlf', 'false']);
    put(repo, 'seed', 'synthetic repository; not a user execution\n');
  }
  for (const [n, b] of Object.entries(old)) if (n.startsWith('baseline/')) put(compat, n.slice(9), Buffer.from(b, 'base64'));
  const core = Buffer.from('// synthetic stand-in used for isolated Git identity tests only\n');
  put(compat, 'src/runtime/treasuryCompatReadCore.generated.ts', core);
  p.sourceLock.protectedBlobs['src/runtime/treasuryCompatReadCore.generated.ts'] = C.blob(core);
  for (const repo of [compat, refactor]) { g(repo, ['add', '.']); g(repo, ['commit', '-qm', 'isolated baseline']); }
  p.compatBase = C.text(compat, ['rev-parse', 'HEAD']); p.refactorBase = C.text(refactor, ['rev-parse', 'HEAD']);
  for (const [repo, branch, base] of [[compat, p.compatBranch, p.compatBase], [refactor, p.refactorBranch, p.refactorBase]]) g(repo, ['update-ref', 'refs/remotes/origin/' + branch, base]);
  for (const e of p.sourceLock.changes) put(compat, e.path, Buffer.from(old['implementation/' + e.path], 'base64'));
  g(compat, ['add', '.']); g(compat, ['commit', '-qm', 'existing fixed v2 source commit']); const sourceHead = C.text(compat, ['rev-parse', 'HEAD']);
  const m = new Map(Object.entries(old).map(([n, b]) => ['task-package/' + n, Buffer.from(b, 'base64')]));
  m.set('.gitattributes', Buffer.from('* -text\n'));
  const j = (n, x) => m.set(n, C.encoded(x));
  m.set('EXECUTION-REPORT.md', Buffer.from('# SYNTHETIC fixture evidence\n\nNot real Windows/Jest/engine execution.\n'));
  j('FINAL-VERIFICATION.json', { status: 'COMPAT_CPU_OFFLINE_READY_NOT_DEPLOYED', compatHead: sourceHead, refactorBase: p.refactorBase, implementationTests: 91, realCoreScenarios: 10, engineBudgetGapRepaired: false, budgetChanged: false, onlineCallsAuthorized: false });
  j('tests/summary.json', { status: 'COMPAT_CPU_IMPLEMENTATION_OFFLINE_VERIFIED', packageFingerprint: p.v2PackageFiles['INTEGRITY.json'].sha256, tests: 91, passed: 91, failed: 0, skipped: 0, todo: 0, cancelled: 0, synthetic: true });
  m.set('tests/tests.stdout', Buffer.from(tap(91))); m.set('tests/tests.stderr', Buffer.alloc(0)); j('tests/tests.exit.json', { code: 0, signal: null, error: null });
  j('tests/type-fixture-result.json', { diagnostics: [] });
  j('checks/summary.json', { status: 'COMPAT_FULL_OFFLINE_CHECKS_VERIFIED', base: p.compatBase, productionBudgetUnchanged: { suites: 195, tests: 685 }, buildOnly: true, notDeployed: true, synthetic: true });
  for (const n of ['repository-tests', 'typecheck-build', 'typecheck-test', 'jest-budget', 'build-only']) {
    m.set('checks/' + n + '.stdout', Buffer.from(n === 'repository-tests' ? tap(70) : 'synthetic success fixture, not real execution\n'));
    m.set('checks/' + n + '.stderr', Buffer.alloc(0)); j('checks/' + n + '.exit.json', { code: 0, signal: null, error: null });
  }
  j('characterization/characterization.json', { status: 'REAL_PINNED_CORE_OFFLINE_CHARACTERIZED', generatedBlob: p.sourceLock.protectedBlobs['src/runtime/treasuryCompatReadCore.generated.ts'], engineCpuGapRepaired: false,
    scenarios: ['empty', 'two-manual', 'sixteen-manual', 'bound', 'over-bound', 'invalid', 'missing', 'mutation-no-revision', 'active-reservations', 'expired-reservations'].map(name => ({ name, offByteEquivalent: true, diagnosticSemanticEquivalent: true })), synthetic: true });
  j('ARCHIVE-MANIFEST.json', { files: Object.fromEntries([...m].map(([n, b]) => [n, C.identity(b)])) });
  for (const [n, b] of m) put(refactor, p.oldTarget + '/' + n, b);
  g(refactor, ['add', '--', p.oldTarget]);
  return { root, compat, refactor, p, sourceHead, map: m, out: n => C.path.join(root, n), close() { C.fs.rmSync(root, { recursive: true, force: true }); } };
}
function mutate(f, n, bytes, updateManifest = true) {
  put(f.refactor, f.p.oldTarget + '/' + n, bytes);
  if (updateManifest) {
    const name = f.p.oldTarget + '/ARCHIVE-MANIFEST.json', m = C.read(C.path.join(f.refactor, name));
    m.files[n] = C.identity(C.fs.readFileSync(C.path.join(f.refactor, f.p.oldTarget, n))); put(f.refactor, name, m);
  }
  g(f.refactor, ['add', '--', f.p.oldTarget]);
}
function testProof(f) {
  const n = C.read(C.path.join(C.ROOT, 'references/test-set.json')).tests, dir = f.out('closeout-tests');
  C.put(C.path.join(dir, 'result.json'), { status: 'CLOSEOUT_FIXED_TESTS_VERIFIED', tests: n, exit: 0, stderr: '', stdout: tap(n), packageFingerprint: C.sha(C.fs.readFileSync(C.path.join(C.ROOT, 'INTEGRITY.json'))), synthetic: true });
  return dir;
}
function inspect(f) { return F.inspect({ compat: f.compat, refactor: f.refactor, out: f.out('inspection') }, f.p); }
function assemble(f) { return F.assemble({ compat: f.compat, refactor: f.refactor, inspection: f.out('inspection'), tests: testProof(f), out: f.out('assembly') }, f.p); }
function staged(f) { inspect(f); assemble(f); g(f.refactor, ['add', '--', f.p.newTarget]); }
function gate(f) { return F.gate({ compat: f.compat, refactor: f.refactor, inspection: f.out('inspection'), out: f.out('gate') }, f.p); }
module.exports = { C, K, F, old, tap, put, g, fixture, mutate, testProof, inspect, assemble, staged, gate };
