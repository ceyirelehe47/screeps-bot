'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const C = require('../tools/common.cjs');
const { workflow } = require('../tools/workflow.cjs');
function temp(t) { const p = C.fs.mkdtempSync(C.path.join(os.tmpdir(), 'loader-III-')); t.after(() => C.fs.rmSync(p, { recursive: true, force: true })); return p; }
function init(repo, branch) {
  C.fs.mkdirSync(repo); C.git(repo, ['init', '-q']); C.git(repo, ['checkout', '-qb', branch]);
  C.git(repo, ['config', 'user.name', 'Loader III fixture']); C.git(repo, ['config', 'user.email', 'fixture@example.invalid']); C.git(repo, ['config', 'commit.gpgsign', 'false']);
  C.fs.cpSync(C.path.join(C.ROOT, 'baseline'), repo, { recursive: true }); C.git(repo, ['add', '.']); C.git(repo, ['commit', '-qm', 'synthetic repository fixture with pinned source files']);
  return C.gt(repo, ['rev-parse', 'HEAD']);
}
function fixture(t) {
  const root = temp(t), compat = C.path.join(root, 'compat'), refactor = C.path.join(root, 'refactor'), bare = C.path.join(root, 'remote.git');
  const policy = C.json(C.path.join(C.ROOT, 'references/source-lock.json'));
  policy.compatBase = init(compat, policy.compatBranch); policy.refactorBase = init(refactor, policy.refactorBranch);
  // The real CLI contract is NOT overridden; only this in-process isolated fixture policy.
  policy.protectedBlobs = Object.fromEntries(Object.entries(policy.protectedBlobs).filter(([n]) => C.fs.existsSync(C.path.join(compat, n))));
  C.fs.mkdirSync(bare); C.git(bare, ['init', '--bare', '-q']);
  for (const [repo, branch] of [[compat, policy.compatBranch], [refactor, policy.refactorBranch]]) { C.git(repo, ['remote', 'add', 'origin', bare]); C.git(repo, ['push', '-qu', 'origin', branch]); }
  return { root, compat, refactor, bare, policy, w: workflow(policy) };
}
function apply(f) { return f.w.apply(f.compat, C.path.join(f.root, 'before-apply')); }
function sourceCommit(f) { apply(f); f.w.stageSource(f.compat); C.git(f.compat, ['commit', '-qm', 'test source payload']); return f.w.committed(f.compat); }
function fakeValidation(f) {
  // Tests of archiving mechanics ONLY. Explicitly synthetic; not a project test run.
  const set = C.json(C.path.join(C.ROOT, 'references/test-set.json'));
  const out = name => { const p = C.path.join(f.root, name); C.fs.mkdirSync(p); return p; };
  const tests = out('tests'), checks = out('checks'), ab = out('ab'); const fingerprint = f.w.fingerprint();
  function record(dir, name, text) { C.writeNew(C.path.join(dir, name + '.json'), { syntheticWorkflowFixture: true, exit: 0, error: null, signal: null, stdout: C.packet(text || ''), stderr: C.packet('original trailing bytes  \n') }); }
  const tap = n => ['TAP version 13', '# tests ' + n, '# pass ' + n, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', ''].join('\n');
  record(tests, 'reader-tests', tap(set.readerTests)); record(tests, 'workflow-tests', tap(set.workflowTests)); record(checks, 'repository-tests', tap(set.repositoryTests));
  for (const n of ['regenerate', 'typecheck-build', 'typecheck-test', 'build-only']) record(checks, n);
  record(checks, 'jest-budget', '{"suites":195,"tests":685}\n');
  C.writeNew(C.path.join(tests, 'summary.json'), { status: 'LOADER_III_FIXED_TESTS_VERIFIED', packageFingerprint: fingerprint });
  C.writeNew(C.path.join(checks, 'summary.json'), { status: 'LOADER_III_FULL_CHECKS_VERIFIED', packageFingerprint: fingerprint });
  C.writeNew(C.path.join(ab, 'characterization.json'), { status: 'LOADER_III_REAL_CORE_AB_VERIFIED', packageFingerprint: fingerprint, engineCpuGapRepaired: false, scenarios: Array.from({ length: 20 }, (_, i) => ({ name: 'synthetic-workflow-' + i, byteEquivalent: true, writes: [0, 0] })) });
  return { tests, checks, ab };
}
function assemble(f) { sourceCommit(f); const v = fakeValidation(f); f.w.archive(f.compat, f.refactor, v.tests, v.checks, v.ab); return v; }
test('workflow III package integrity uses exact case-sensitive paths without case-colliding fixtures', () => { assert.equal(C.integrity().status, 'PACKAGE_INTEGRITY_VERIFIED'); });
test('workflow III output packets retain trailing whitespace bytes losslessly', () => {
  const b = Buffer.from('line  \r\n\t\n'); const p = C.packet(b); assert.ok(Buffer.from(C.validatePacket(p)).equals(b));
  p.text = p.text.trim(); assert.throws(() => C.validatePacket(p), /OUTPUT_PACKET_CHANGED/);
});
test('workflow III exact pinned files accept patch then reproduce all eleven payload files', t => {
  const f = fixture(t); const p = C.path.join(C.ROOT, 'patches/0001-loader-definition-reuse.patch');
  C.git(f.compat, ['-c', 'core.autocrlf=false', 'apply', '--check', p]); C.git(f.compat, ['-c', 'core.autocrlf=false', 'apply', p]); assert.equal(f.w.checkSource(f.compat).files, 11);
});
test('workflow III real archive stage native-check commit push and readback end to end', t => {
  const f = fixture(t); assert.equal(f.w.baseline(f.compat, f.refactor).status, 'LOADER_III_BASELINES_VERIFIED'); assemble(f);
  const staged = f.w.stageArchive(f.refactor); assert.equal(staged.nativeWhitespaceCheck, 'passed-zero-exceptions');
  C.git(f.refactor, ['commit', '-qm', 'test evidence payload']); assert.equal(C.gt(f.refactor, ['rev-parse', 'HEAD^{tree}']), staged.indexTree);
  assert.equal(f.w.postCommit(f.compat, f.refactor).status, 'LOADER_III_COMMITS_VERIFIED'); assert.equal(f.w.publish(f.compat, f.refactor).status, 'LOADER_III_PUBLISHED_NOT_DEPLOYED');
  assert.equal(f.w.publish(f.compat, f.refactor).status, 'LOADER_III_PUBLISHED_NOT_DEPLOYED'); // idempotent readback, not a second experiment
});
test('workflow III unknown dirty source input is refused before any snapshot or write', t => {
  const f = fixture(t); const n = C.path.join(f.compat, 'src/runtime/treasuryCompatRead.ts'); C.fs.appendFileSync(n, '// unknown\n');
  const b = C.fs.readFileSync(n); assert.throws(() => apply(f), /WORKTREE_NOT_CLEAN/); assert.ok(C.fs.readFileSync(n).equals(b));
});
test('workflow III existing snapshot target is never deleted or overwritten', t => {
  const f = fixture(t); const dest = C.path.join(f.root, 'before-apply'); C.fs.mkdirSync(dest); C.fs.writeFileSync(C.path.join(dest, 'keep'), 'keep');
  assert.throws(() => apply(f), /OUTPUT_ALREADY_EXISTS/); assert.equal(C.fs.readFileSync(C.path.join(dest, 'keep'), 'utf8'), 'keep'); C.clean(f.compat);
});
test('workflow III fixed write failure restores original CRLF bytes transactionally', t => {
  const f = fixture(t); const n = C.path.join(f.compat, 'src/runtime/treasuryCompatRead.ts');
  const lf = C.fs.readFileSync(n, 'utf8'); C.fs.writeFileSync(n, lf.replace(/\n/g, '\r\n'));
  // Git checkout semantics must identify this as unchanged, independent of machine-level config.
  C.git(f.compat, ['config', 'core.autocrlf', 'true']);
  C.git(f.compat, ['checkout', '--', 'src/runtime/treasuryCompatRead.ts']);
  assert.ok(C.fs.readFileSync(n).includes(Buffer.from('\r\n')));
  // This is a clean CRLF checkout under the repository's own configuration.
  C.clean(f.compat); const original = C.inventory(C.path.join(f.compat, 'src'));
  const write = C.fs.writeFileSync; let hit = false;
  C.fs.writeFileSync = function (p, ...args) { if (!hit && String(p) === C.path.join(f.compat, 'src/runtime/treasuryCompatReadCore.generated.ts')) { hit = true; throw new Error('injected write failure'); } return write.call(this, p, ...args); };
  try { assert.throws(() => apply(f), /injected write failure/); } finally { C.fs.writeFileSync = write; }
  assert.ok(hit); C.verifyInventory(C.path.join(f.compat, 'src'), original); C.clean(f.compat);
});
test('workflow III additional untracked source file is refused at staging', t => {
  const f = fixture(t); apply(f); C.fs.writeFileSync(C.path.join(f.compat, 'extra.ts'), 'unrequested\n');
  assert.throws(() => f.w.stageSource(f.compat), /SOURCE_SCOPE_MISMATCH/); assert.equal(C.gt(f.compat, ['diff', '--cached', '--name-only']), '');
});
test('workflow III changed payload file is rejected without staging it', t => {
  const f = fixture(t); apply(f); C.fs.appendFileSync(C.path.join(f.compat, f.w.files[0]), '\n'); assert.throws(() => f.w.stageSource(f.compat), /SOURCE_BYTES_MISMATCH/);
});
test('workflow III a second source commit cannot be silently adopted', t => {
  const f = fixture(t); sourceCommit(f); C.git(f.compat, ['commit', '--allow-empty', '-qm', 'unrequested second commit']); assert.throws(() => f.w.committed(f.compat), /SOURCE_COMMIT_PARENT_MISMATCH/);
});
test('workflow III failed full-check artifact cannot pass the archive gate', t => {
  const f = fixture(t); sourceCommit(f); const v = fakeValidation(f); const p = C.path.join(v.checks, 'jest-budget.json'); const x = C.json(p); x.exit = 1; C.fs.writeFileSync(p, C.encode(x));
  assert.throws(() => f.w.archive(f.compat, f.refactor, v.tests, v.checks, v.ab), /RAW_PROJECT_CHECK_FAILED/); C.clean(f.refactor);
});
test('workflow III raw packet tampering is detected before archiving', t => {
  const f = fixture(t); sourceCommit(f); const v = fakeValidation(f); const p = C.path.join(v.tests, 'reader-tests.json'); const x = C.json(p); x.stdout.sha256 = '0'.repeat(64); C.fs.writeFileSync(p, C.encode(x));
  assert.throws(() => f.w.archive(f.compat, f.refactor, v.tests, v.checks, v.ab), /OUTPUT_PACKET_CHANGED/);
});
test('workflow III archive must retain the exact implementation package bytes', t => {
  const f = fixture(t); assemble(f); const p = C.path.join(f.refactor, f.policy.evidenceTarget, 'task-package/README.md'); C.fs.appendFileSync(p, 'mutated\n');
  assert.throws(() => f.w.verifyArchive(f.refactor), /FILE_BYTES_MISMATCH/);
});
test('workflow III native whitespace gate rejects ordinary trailing whitespace with no exclusions', t => {
  const f = fixture(t); assemble(f); const target = C.path.join(f.refactor, f.policy.evidenceTarget), p = C.path.join(target, 'EXECUTION-REPORT.md');
  C.fs.appendFileSync(p, 'bad  \n'); const m = C.json(C.path.join(target, 'ARCHIVE-MANIFEST.json')), b = C.fs.readFileSync(p);
  m.files['EXECUTION-REPORT.md'] = { bytes: b.length, sha256: C.sha(b) }; C.fs.writeFileSync(C.path.join(target, 'ARCHIVE-MANIFEST.json'), C.encode(m));
  assert.throws(() => f.w.stageArchive(f.refactor), /GIT_COMMAND_FAILED/);
});
test('workflow III existing archive requires verify not destructive reassembly', t => {
  const f = fixture(t); const v = assemble(f); const before = C.inventory(C.path.join(f.refactor, f.policy.evidenceTarget));
  assert.throws(() => f.w.archive(f.compat, f.refactor, v.tests, v.checks, v.ab), /WORKTREE_NOT_CLEAN|ARCHIVE_ALREADY_EXISTS/);
  C.verifyInventory(C.path.join(f.refactor, f.policy.evidenceTarget), before);
});
test('workflow III remote branch drift cannot trigger force push', t => {
  const f = fixture(t); assemble(f); f.w.stageArchive(f.refactor); C.git(f.refactor, ['commit', '-qm', 'test evidence']);
  const other = C.path.join(f.root, 'other'); C.git(f.root, ['clone', '-q', '--branch', f.policy.compatBranch, f.bare, other]);
  C.git(other, ['config', 'user.name', 'Other fixture']); C.git(other, ['config', 'user.email', 'other@example.invalid']); C.git(other, ['config', 'commit.gpgsign', 'false']);
  C.git(other, ['commit', '--allow-empty', '-qm', 'concurrent writer']); C.git(other, ['push', '-q', 'origin', f.policy.compatBranch]);
  assert.throws(() => f.w.publish(f.compat, f.refactor), /REMOTE_DRIFT_NO_FORCE_PUSH/);
});
test('workflow III package paths reject traversal and repository-contained outputs', t => {
  const dir = temp(t); assert.throws(() => C.safePath(dir, '../outside'), /INVALID_RELATIVE_PATH/); assert.throws(() => C.outside(dir, [dir]), /OUTPUT_INSIDE_REPOSITORY/);
});
test('workflow III system and global autocrlf true do not change payload or staged archive', t => {
  const dir = temp(t), oldSystem = process.env.GIT_CONFIG_SYSTEM, oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  const system = C.path.join(dir, 'system.gitconfig'), global = C.path.join(dir, 'global.gitconfig');
  C.fs.writeFileSync(system, '[core]\n autocrlf = true\n'); C.fs.writeFileSync(global, '[core]\n autocrlf = true\n');
  process.env.GIT_CONFIG_SYSTEM = system; process.env.GIT_CONFIG_GLOBAL = global;
  try { const f = fixture(t); assemble(f); assert.equal(f.w.stageArchive(f.refactor).nativeWhitespaceCheck, 'passed-zero-exceptions'); }
  finally { if (oldSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = oldSystem; if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobal; }
});
