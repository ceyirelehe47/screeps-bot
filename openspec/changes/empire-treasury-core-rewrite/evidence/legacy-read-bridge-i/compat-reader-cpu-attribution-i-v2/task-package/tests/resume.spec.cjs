'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os');
const C = require('../tools/common.cjs'), W = require('../tools/workflow.cjs');
function setup(fn) {
  const root = C.fs.mkdtempSync(C.path.join(os.tmpdir(), 'cpu-resume-v2-')), repo = C.path.join(root, 'repo'), old = C.COMPAT;
  try {
    C.fs.mkdirSync(repo); C.fs.cpSync(C.path.join(C.ROOT, 'baseline'), repo, { recursive: true });
    C.git(repo, ['init', '-q', '-b', C.BRANCH]);
    for (const [key, value] of [['user.email', 'fixture@example.invalid'], ['user.name', 'Fixture'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['core.hooksPath', C.path.join(root, 'no-hooks')]]) C.git(repo, ['config', '--local', key, value]);
    C.git(repo, ['add', '.']); C.git(repo, ['commit', '-qm', 'fixture base']); C.COMPAT = C.gt(repo, ['rev-parse', 'HEAD']);
    fn({ root, repo, plan: C.sourcePlan() });
  } finally { C.COMPAT = old; C.fs.rmSync(root, { recursive: true, force: true }); }
}
const v1 = (repo, plan) => W.applyBytes(repo, plan.filter(e => e.path.startsWith('src/')));
test('resume inspector accepts a clean exact Git fixture base', () => setup(({ repo }) => {
  assert.equal(W.inspect(repo).mode, 'CLEAN_BASELINE');
}));
test('resume inspector accepts exact v1 dirty three-file state and selects helper only', () => setup(({ repo, plan }) => {
  v1(repo, plan); const input = W.inspect(repo);
  assert.equal(input.mode, 'EXACT_V1_SOURCE_APPLIED'); assert.deepEqual(W.selectWrites(input, plan).map(e => e.path), ['test/treasury-compat/helpers.cjs']);
}));
test('resume snapshots original bytes before helper adaptation and preserves the three sources', () => setup(({ root, repo, plan }) => {
  v1(repo, plan);
  const helper = C.path.join(repo, 'test/treasury-compat/helpers.cjs');
  C.fs.writeFileSync(helper, C.fs.readFileSync(helper, 'utf8').replace(/\n/g, '\r\n'));
  C.git(repo, ['config', '--local', 'core.autocrlf', 'true']);
  const input = W.inspect(repo), snapshot = W.externalSnapshot(repo, C.path.join(root, 'input-snapshot'), input, plan);
  const before = Object.fromEntries(plan.map(e => [e.path, C.fs.readFileSync(C.path.join(repo, e.path))]));
  assert.ok(C.fs.readFileSync(C.path.join(snapshot.out, 'files/test/treasury-compat/helpers.cjs')).equals(before['test/treasury-compat/helpers.cjs']));
  W.applyBytes(repo, W.selectWrites(input, plan));
  for (const e of plan.filter(e => e.path.startsWith('src/'))) assert.ok(C.fs.readFileSync(C.path.join(repo, e.path)).equals(before[e.path]));
  assert.equal(W.inspect(repo).mode, 'EXACT_V2_APPLIED');
}));
test('resume rejects v1 source edits even if changed path set matches', () => setup(({ repo, plan }) => {
  v1(repo, plan); C.fs.appendFileSync(C.path.join(repo, 'src/runtime/treasuryCompatRead.ts'), '// unknown edit\n');
  assert.throws(() => W.inspect(repo), { code: 'RESUME_BYTES_MISMATCH' });
}));
test('resume rejects extra untracked or modified paths', () => setup(({ repo, plan }) => {
  v1(repo, plan); C.put(C.path.join(repo, 'unrelated.txt'), 'do not overwrite');
  assert.throws(() => W.inspect(repo), { code: 'RESUME_SCOPE_MISMATCH' });
}));
test('resume rejects staged changes and does not unstage them', () => setup(({ repo, plan }) => {
  v1(repo, plan); C.git(repo, ['add', 'src/runtime/treasuryCompatRead.ts']);
  const before = C.git(repo, ['diff', '--cached']); assert.throws(() => W.inspect(repo), { code: 'INDEX_MUST_BE_EMPTY' });
  assert.ok(C.git(repo, ['diff', '--cached']).equals(before));
}));
test('resume rejects partially applied input rather than guessing how to complete it', () => setup(({ repo, plan }) => {
  W.applyBytes(repo, plan.filter(e => e.path.endsWith('/treasuryCompatCpu.ts')));
  assert.throws(() => W.inspect(repo), { code: 'RESUME_SCOPE_MISMATCH' });
}));
test('resume rejects helper edits even when original sources are the exact v1 payload', () => setup(({ repo, plan }) => {
  v1(repo, plan); C.fs.appendFileSync(C.path.join(repo, 'test/treasury-compat/helpers.cjs'), '// unknown edit\n');
  assert.throws(() => W.inspect(repo), { code: 'RESUME_BYTES_MISMATCH' });
}));
test('snapshot refuses existing or repository-contained destinations', () => setup(({ root, repo, plan }) => {
  const input = W.inspect(repo);
  assert.throws(() => W.externalSnapshot(repo, C.path.join(repo, 'snapshot'), input, plan), { code: 'SNAPSHOT_MUST_BE_EXTERNAL' });
  const out = C.path.join(root, 'snapshot'); C.fs.mkdirSync(out);
  assert.throws(() => W.externalSnapshot(repo, out, input, plan), { code: 'OUTPUT_ALREADY_EXISTS' });
}));
test('helper write validation failure rolls back CRLF bytes without reverting the v1 sources', () => setup(({ repo, plan }) => {
  v1(repo, plan); const helper = C.path.join(repo, 'test/treasury-compat/helpers.cjs');
  C.fs.writeFileSync(helper, C.fs.readFileSync(helper, 'utf8').replace(/\n/g, '\r\n')); const before = C.fs.readFileSync(helper);
  assert.throws(() => W.applyBytes(repo, plan.filter(e => e.path.startsWith('test/')), () => { throw Error('postcheck failed'); }), /postcheck failed/);
  assert.ok(C.fs.readFileSync(helper).equals(before));
  for (const e of plan.filter(e => e.path.startsWith('src/'))) assert.ok(C.fs.readFileSync(C.path.join(repo, e.path)).equals(e.bytes));
}));
test('exact v2 input is checkable without selecting any source writes', () => setup(({ repo, plan }) => {
  W.applyBytes(repo, plan); const input = W.inspect(repo);
  assert.equal(input.mode, 'EXACT_V2_APPLIED'); assert.equal(W.selectWrites(input, plan).length, 0);
}));
