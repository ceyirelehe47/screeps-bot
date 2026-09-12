'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./fixture.cjs'), { C, K, F } = H;
function run(name, fn) { test(name, () => { const f = H.fixture(); try { fn(f); } finally { f.close(); } }); }
const thrown = (fn, code) => assert.throws(fn, code ? { code } : undefined);

test('original pinned patch contains exactly two single-space hunk context lines', () => {
  const b = Buffer.from(H.old['patches/0001-reader-cpu-accounting.patch'], 'base64');
  C.verifyBytes(b, K.POLICY.exception, 'unexpected'); assert.deepEqual(K.patchContexts(b, [73, 78]), [73, 78]);
});
test('the exception is one exact path and full bytes, not a glob', () => {
  assert.equal(K.POLICY.exception.path, 'task-package/patches/0001-reader-cpu-accounting.patch');
  assert.equal(K.POLICY.exception.sha256, '5067582c5e52de06c1bb1fac0126b9e6e65e483ec9bc8b0d09eca8ec0d5e5067');
});
run('actual original patches still apply to original baseline with identical four output files', f => {
  const r = f.out('patch-apply'); C.fs.mkdirSync(r); H.g(r, ['init', '-q']);
  for (const [n, b] of Object.entries(H.old)) if (n.startsWith('baseline/')) H.put(r, n.slice(9), Buffer.from(b, 'base64'));
  for (const n of ['0001-reader-cpu-accounting.patch', '0002-repository-sandbox-import.patch']) {
    const patch = f.out(n); C.fs.writeFileSync(patch, Buffer.from(H.old['patches/' + n], 'base64'));
    H.g(r, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--check', patch]);
    H.g(r, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', patch]);
  }
  for (const e of f.p.sourceLock.changes) assert.equal(C.sha(C.fs.readFileSync(C.path.join(r, e.path))), e.newSha256);
});
run('archive then stage reproduces native exit 2 and scoped gate passes only those diagnostics', f => {
  const before = C.text(f.refactor, ['write-tree']); const r = H.inspect(f);
  assert.equal(r.whitespace.nativeExit, 2); assert.equal(r.whitespace.nativeCheckPassed, false); assert.equal(r.whitespace.remainingPathsExit, 0);
  assert.equal(r.oldArchiveFileCount, 77); assert.equal(C.text(f.refactor, ['write-tree']), before);
});
run('normal system/global autocrlf settings need no global isolation', f => {
  const old = [process.env.GIT_CONFIG_SYSTEM, process.env.GIT_CONFIG_GLOBAL];
  C.fs.writeFileSync(f.out('system.config'), '[core]\n\tautocrlf = true\n'); C.fs.writeFileSync(f.out('global.config'), '[core]\n\tautocrlf = true\n');
  process.env.GIT_CONFIG_SYSTEM = f.out('system.config'); process.env.GIT_CONFIG_GLOBAL = f.out('global.config');
  try { H.staged(f); assert.equal(H.gate(f).whitespace.remainingPathsExit, 0); }
  finally { for (const [i, k] of ['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL'].entries()) if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; }
});
run('leading work directory spaces and one source commit are supported', f => { assert.match(f.root, /cpu closeout /); assert.equal(H.inspect(f).compatHead, f.sourceHead); });
run('sanitizing the two old patch lines is rejected as evidence mutation', f => {
  const n = f.p.exception.path; H.mutate(f, n, f.map.get(n).toString('utf8').replace(/^ $/gm, ''));
  thrown(() => H.inspect(f), 'V2_EXECUTED_PACKAGE_CHANGED');
});
run('a different patch change is not covered by the exception', f => {
  const n = 'task-package/patches/0002-repository-sandbox-import.patch'; H.mutate(f, n, Buffer.concat([f.map.get(n), Buffer.from(' \n')]));
  thrown(() => H.inspect(f), 'V2_EXECUTED_PACKAGE_CHANGED');
});
run('normal report trailing whitespace remains fatal even with updated archive checksum', f => {
  H.mutate(f, 'EXECUTION-REPORT.md', '# normal text with bad whitespace \n'); thrown(() => H.inspect(f), 'UNEXPECTED_WHITESPACE_DIAGNOSTIC');
});
run('extra end blank lines remain fatal', f => { H.mutate(f, 'checks/build-only.stdout', 'ok\n\n\n'); thrown(() => H.inspect(f), 'UNEXPECTED_WHITESPACE_DIAGNOSTIC'); });
run('changed payload with internally recalculated archive manifest is rejected', f => {
  const n = 'task-package/implementation/src/runtime/treasuryCompatRead.ts'; H.mutate(f, n, Buffer.concat([f.map.get(n), Buffer.from('// changed\n')]));
  thrown(() => H.inspect(f), 'V2_EXECUTED_PACKAGE_CHANGED');
});
run('source commit with extra configuration edits cannot be reused', f => {
  H.put(f.compat, 'src/runtime/treasuryCompatConfig.ts', '// unauthorized\n'); H.g(f.compat, ['add', '.']); H.g(f.compat, ['-c', 'commit.gpgSign=false', 'commit', '--amend', '--no-edit', '-q']);
  thrown(() => H.inspect(f), 'COMPAT_CHANGE_SCOPE_MISMATCH');
});
run('second compat commit is rejected', f => { H.g(f.compat, ['commit', '--allow-empty', '-qm', 'not authorized second source commit']); thrown(() => H.inspect(f), 'COMPAT_MUST_BE_EXISTING_SINGLE_COMMIT'); });
run('untracked file in compat is rejected', f => { H.put(f.compat, 'extra.txt', 'x\n'); thrown(() => H.inspect(f), 'COMPAT_NOT_CLEAN'); });
run('untracked file outside evidence in refactor is rejected', f => { H.put(f.refactor, 'unexpected.patch', ' \n'); thrown(() => H.inspect(f), 'UNEXPECTED_UNTRACKED_FILES'); });
run('additional staged file outside scope is rejected', f => { H.put(f.refactor, 'unexpected.txt', 'x\n'); H.g(f.refactor, ['add', 'unexpected.txt']); thrown(() => H.inspect(f), 'STAGED_SCOPE_MISMATCH'); });
run('unstaged old archive change is rejected', f => { C.fs.appendFileSync(C.path.join(f.refactor, f.p.oldTarget, 'EXECUTION-REPORT.md'), 'changed\n'); thrown(() => H.inspect(f), 'UNSTAGED_TRACKED_CHANGE'); });
run('archive manifest absent entry is rejected', f => {
  const n = f.p.oldTarget + '/ARCHIVE-MANIFEST.json', m = C.read(C.path.join(f.refactor, n)); delete m.files['EXECUTION-REPORT.md']; H.put(f.refactor, n, m); H.g(f.refactor, ['add', n]); thrown(() => H.inspect(f), 'MANIFEST_SET_MISMATCH');
});
run('executable mode in archived evidence is refused', f => { H.g(f.refactor, ['config', 'core.filemode', 'false']); H.g(f.refactor, ['update-index', '--chmod=+x', f.p.oldTarget + '/EXECUTION-REPORT.md']); thrown(() => H.inspect(f), 'EVIDENCE_MODE_NOT_REGULAR'); });
run('remote-tracking baseline drift is refused', f => { H.g(f.compat, ['update-ref', 'refs/remotes/origin/' + f.p.compatBranch, f.sourceHead]); thrown(() => H.inspect(f), 'REMOTE_TRACKING_BASELINE_MISMATCH'); });
run('failed historical full-check exit cannot be reused', f => { H.mutate(f, 'checks/jest-budget.exit.json', C.encoded({ code: 1, signal: null, error: null })); thrown(() => H.inspect(f), 'V2_CHECK_NOT_PASSED'); });
run('wrong implementation test count cannot be reused', f => { H.mutate(f, 'tests/tests.stdout', H.tap(90)); thrown(() => H.inspect(f), 'TAP_NOT_ALL_PASSED'); });
run('ambiguous TAP totals cannot be reused', f => { H.mutate(f, 'tests/tests.stdout', H.tap(91) + '# pass 91\n'); thrown(() => H.inspect(f), 'TAP_TOTAL_MISSING_OR_AMBIGUOUS'); });
run('wrong full source SHA in historical result is refused', f => {
  const x = C.json(f.map.get('FINAL-VERIFICATION.json')); x.compatHead = f.p.compatBase; H.mutate(f, 'FINAL-VERIFICATION.json', C.encoded(x)); thrown(() => H.inspect(f), 'V2_FINAL_RESULT_IDENTITY_MISMATCH');
});
run('output path inside repo or existing output is refused without replacing files', f => {
  thrown(() => F.inspect({ compat: f.compat, refactor: f.refactor, out: C.path.join(f.refactor, 'out') }, f.p), 'OUTPUT_MUST_BE_EXTERNAL');
  H.inspect(f); thrown(() => H.inspect(f), 'OUTPUT_ALREADY_EXISTS');
});
run('assembly only adds a sibling directory and preserves all original staged bytes', f => {
  const oldIndex = C.text(f.refactor, ['write-tree']); const r = H.inspect(f); H.assemble(f);
  assert.equal(C.text(f.refactor, ['write-tree']), oldIndex); const s = K.inspectState(f.compat, f.refactor, f.p, true);
  assert.equal(s.old.fingerprint, r.oldArchiveFingerprint); assert.equal(s.old.fileCount, 77); assert.equal(s.src.head, f.sourceHead);
});
run('changed old evidence after inspection is rejected even when checksums remain self-consistent', f => {
  H.inspect(f); H.mutate(f, 'checks/build-only.stdout', 'changed but syntactically clean\n');
  thrown(() => H.assemble(f), 'ORIGINAL_EVIDENCE_OR_SOURCE_CHANGED_SINCE_INSPECTION');
});
run('preexisting supplemental target is never overwritten', f => {
  H.inspect(f); H.put(f.refactor, f.p.newTarget + '/keep.txt', 'preserve\n');
  thrown(() => H.assemble(f)); assert.equal(C.fs.readFileSync(C.path.join(f.refactor, f.p.newTarget, 'keep.txt'), 'utf8'), 'preserve\n');
});
run('addendum must be staged, not just written', f => { H.inspect(f); H.assemble(f); thrown(() => H.gate(f), 'UNEXPECTED_UNTRACKED_FILES'); });
run('full combined gate preserves native failure disclosure and verifies new files too', f => {
  H.staged(f); const r = H.gate(f); assert.equal(r.status, 'FINAL_STAGED_CLOSEOUT_GATE_VERIFIED'); assert.equal(r.whitespace.nativeCheckPassed, false);
  assert.equal(r.originalFilesPreserved, 77); assert.ok(r.totalStagedFiles > 77); assert.equal(r.sourceChangedByV3, false);
});
run('tampered supplementary documentation is rejected rather than exempted', f => {
  H.staged(f); const n = f.p.newTarget + '/EXECUTION-ADDENDUM.md'; H.put(f.refactor, n, 'changed \n'); H.g(f.refactor, ['add', n]); thrown(() => H.gate(f), 'ADDENDUM_BYTES_MISMATCH');
});
run('new same-name patch elsewhere is not whitelisted', f => {
  H.staged(f); const n = f.p.newTarget + '/task-package/patches/0001-reader-cpu-accounting.patch'; H.put(f.refactor, n, ' \n'); H.g(f.refactor, ['add', n]); thrown(() => H.gate(f), 'ADDENDUM_FILE_SET_MISMATCH');
});
run('real Git commit and tree verification reuse source commit without amend', f => {
  H.staged(f); const r = H.gate(f); H.g(f.refactor, ['commit', '-qm', 'isolated complete closeout']);
  const result = F.committed({ compat: f.compat, refactor: f.refactor, gate: f.out('gate'), out: f.out('committed') }, f.p);
  assert.equal(result.compatHead, f.sourceHead); assert.equal(C.text(f.refactor, ['rev-parse', 'HEAD^{tree}']), r.indexTree);
});
run('post-gate different committed tree is refused', f => {
  H.staged(f); H.gate(f); H.put(f.refactor, 'unreviewed.txt', 'not allowed\n'); H.g(f.refactor, ['add', '.']); H.g(f.refactor, ['commit', '-qm', 'different tree']);
  thrown(() => F.committed({ compat: f.compat, refactor: f.refactor, gate: f.out('gate'), out: f.out('committed') }, f.p), 'COMMITTED_TREE_DIFFERS_FROM_GATE');
});
run('complete archive-stage-gate-commit-push-readback uses only isolated local bare remotes', f => {
  H.staged(f); H.gate(f); H.g(f.refactor, ['commit', '-qm', 'complete evidence']);
  F.committed({ compat: f.compat, refactor: f.refactor, gate: f.out('gate'), out: f.out('committed') }, f.p);
  const remote = f.out('local.git'); H.g(f.root, ['init', '--bare', '-q', remote]);
  for (const [repo, branch] of [[f.compat, f.p.compatBranch], [f.refactor, f.p.refactorBranch]]) {
    H.g(repo, ['remote', 'add', 'origin', remote]); H.g(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/' + branch]);
  }
  const r = F.remote({ compat: f.compat, refactor: f.refactor, committed: f.out('committed'), out: f.out('remote-proof') }, f.p);
  assert.equal(r.status, 'CPU_V3_CLOSEOUT_REMOTE_VERIFIED'); assert.equal(r.screepsCalls, 0); assert.equal(r.compatHead, f.sourceHead);
});
run('failed gate does not change index or erase original archive', f => {
  H.mutate(f, 'EXECUTION-REPORT.md', 'bad \n'); const before = C.text(f.refactor, ['write-tree']); thrown(() => H.inspect(f));
  assert.equal(C.text(f.refactor, ['write-tree']), before); assert.equal(C.fs.existsSync(C.path.join(f.refactor, f.p.oldTarget, 'ARCHIVE-MANIFEST.json')), true);
});
test('all closeout tools have no Screeps transport or deployment client', () => {
  for (const n of C.files(C.path.join(C.ROOT, 'tools'))) {
    const s = C.fs.readFileSync(C.path.join(C.ROOT, 'tools', n), 'utf8');
    assert.equal(/require\(['"](?:node:)?(?:https?|net|tls|ws)['"]\)/.test(s), false, n);
    assert.equal(/\b(?:fetch|WebSocket)\s*\(/.test(s), false, n);
    assert.equal(/git\([^\n]*\[\s*['"](?:reset|clean|rebase)['"]/.test(s), false, n);
  }
});
