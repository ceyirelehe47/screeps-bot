'use strict';
const C = require('./common.cjs');
const POLICY = C.read(C.path.join(C.ROOT, 'references/policy.json'));
const tapCounts = (b, expected) => {
  const s = b.toString('utf8').replace(/\r\n/g, '\n'); const values = {};
  for (const key of ['tests', 'pass', 'fail', 'skipped', 'todo', 'cancelled']) {
    const found = [...s.matchAll(new RegExp('^# ' + key + ' (\\d+)$', 'gm'))]; if (found.length !== 1) C.fail('TAP_TOTAL_MISSING_OR_AMBIGUOUS', key);
    values[key] = Number(found[0][1]);
  }
  if (values.tests !== expected || values.pass !== expected || ['fail', 'skipped', 'todo', 'cancelled'].some(k => values[k] !== 0)) C.fail('TAP_NOT_ALL_PASSED'); return values;
};
function source(compat, p = POLICY) {
  if (C.text(compat, ['branch', '--show-current']) !== p.compatBranch) C.fail('COMPAT_BRANCH_MISMATCH');
  if (C.git(compat, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length) C.fail('COMPAT_NOT_CLEAN');
  const head = C.text(compat, ['rev-parse', 'HEAD']);
  C.eq(C.text(compat, ['rev-list', '--parents', '-n', '1', head]).split(' ').slice(1), [p.compatBase], 'COMPAT_MUST_BE_EXISTING_SINGLE_COMMIT');
  const wanted = p.sourceLock.changes.map(e => e.path).sort();
  C.eq(C.split0(C.git(compat, ['diff', '--name-only', '--no-renames', '-z', p.compatBase, head])).sort(), wanted, 'COMPAT_CHANGE_SCOPE_MISMATCH');
  for (const e of p.sourceLock.changes) {
    const b = C.git(compat, ['show', head + ':' + e.path]); if (C.sha(b) !== e.newSha256) C.fail('COMPAT_PAYLOAD_MISMATCH', e.path);
    // Checkout line ending conversion is permitted, not source-content changes.
    const disk = C.fs.readFileSync(C.safe(compat, e.path));
    if (!disk.equals(b) && disk.toString('utf8').replace(/\r\n/g, '\n') !== b.toString('utf8')) C.fail('COMPAT_WORKTREE_MISMATCH');
  }
  for (const [n, id] of Object.entries(p.sourceLock.protectedBlobs)) {
    if (C.text(compat, ['rev-parse', head + ':' + n]) !== id) C.fail('PROTECTED_SOURCE_CHANGED', n);
  }
  const check = whitespaceCommand(compat, [p.compatBase, head], p);
  if (check.code !== 0 || check.stdout.length || check.stderr.length) C.fail('COMPAT_SOURCE_WHITESPACE_FAILED');
  return { head, parent: p.compatBase, files: wanted, unchangedPayload: true };
}
function stage(refactor, p = POLICY) {
  if (C.text(refactor, ['branch', '--show-current']) !== p.refactorBranch || C.text(refactor, ['rev-parse', 'HEAD']) !== p.refactorBase) C.fail('REFACTOR_BASELINE_MISMATCH');
  if (C.git(refactor, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '-z']).length) C.fail('UNSTAGED_TRACKED_CHANGE');
  const changed = C.split0(C.git(refactor, ['diff', '--cached', '--name-status', '--no-renames', '-z', p.refactorBase]));
  const names = [];
  for (let i = 0; i < changed.length; i += 2) { if (changed[i] !== 'A' || !changed[i + 1]) C.fail('ONLY_NEW_EVIDENCE_FILES_ALLOWED'); names.push(C.rel(changed[i + 1])); }
  const rows = new Map();
  for (const row of C.split0(C.git(refactor, ['ls-files', '--stage', '-z']))) {
    const m = /^(\d{6}) ([0-9a-f]{40}) (\d)\t(.+)$/.exec(row); if (!m || m[3] !== '0') C.fail('UNMERGED_OR_INVALID_INDEX');
    rows.set(m[4], { mode: m[1], oid: m[2] });
  }
  const selected = names.map(n => { const r = rows.get(n); if (!r || r.mode !== '100644') C.fail('EVIDENCE_MODE_NOT_REGULAR', n); return r.oid; });
  const objects = C.cat(refactor, selected); const bytes = new Map();
  for (const n of names) {
    const b = objects.get(rows.get(n).oid); bytes.set(n, b);
    if (!C.fs.readFileSync(C.safe(refactor, n)).equals(b)) C.fail('INDEX_WORKTREE_BYTES_DIFFER', n);
  }
  return { bytes, names: names.sort(), untracked: C.split0(C.git(refactor, ['ls-files', '--others', '--exclude-standard', '-z'])) };
}
function subset(all, prefix) { return new Map([...all].filter(([n]) => n.startsWith(prefix + '/')).map(([n, b]) => [n.slice(prefix.length + 1), b])); }
function manifestCheck(map, manifestName, expectedNames) {
  C.eq([...map.keys()].sort(), expectedNames.slice().sort(), 'ARCHIVE_FILE_SET_MISMATCH');
  const manifest = C.json(map.get(manifestName));
  if (!manifest || !manifest.files) C.fail('ARCHIVE_MANIFEST_INVALID');
  C.eq(Object.keys(manifest.files).sort(), expectedNames.filter(n => n !== manifestName).sort(), 'MANIFEST_SET_MISMATCH');
  for (const [n, info] of Object.entries(manifest.files)) { C.rel(n); C.verifyBytes(map.get(n), info, 'ARCHIVE_BYTES_MISMATCH'); }
  return manifest;
}
function oldArchive(refactor, all, src, p = POLICY) {
  const map = subset(all, p.oldTarget); manifestCheck(map, 'ARCHIVE-MANIFEST.json', p.oldArchiveFiles);
  C.eq(C.files(C.safe(refactor, p.oldTarget)), p.oldArchiveFiles, 'ARCHIVE_DISK_FILE_SET_MISMATCH');
  if (map.get('.gitattributes').toString('utf8') !== '* -text\n') C.fail('ARCHIVE_ATTRIBUTES_CHANGED');
  for (const [n, info] of Object.entries(p.v2PackageFiles)) C.verifyBytes(map.get('task-package/' + n), info, 'V2_EXECUTED_PACKAGE_CHANGED');
  const get = n => C.json(map.get(n));
  const fin = get('FINAL-VERIFICATION.json'), tests = get('tests/summary.json'), checks = get('checks/summary.json');
  if (fin.compatHead !== src.head || fin.refactorBase !== p.refactorBase || fin.status !== 'COMPAT_CPU_OFFLINE_READY_NOT_DEPLOYED' || fin.engineBudgetGapRepaired !== false || fin.budgetChanged !== false || fin.onlineCallsAuthorized !== false || fin.implementationTests !== 91 || fin.realCoreScenarios !== 10) C.fail('V2_FINAL_RESULT_IDENTITY_MISMATCH');
  if (tests.status !== 'COMPAT_CPU_IMPLEMENTATION_OFFLINE_VERIFIED' || tests.packageFingerprint !== p.v2PackageFiles['INTEGRITY.json'].sha256 || tests.tests !== 91 || tests.passed !== 91 || ['failed', 'skipped', 'todo', 'cancelled'].some(k => tests[k] !== 0)) C.fail('V2_IMPLEMENTATION_EVIDENCE_INVALID');
  tapCounts(map.get('tests/tests.stdout'), 91); tapCounts(map.get('checks/repository-tests.stdout'), 70);
  if (get('tests/type-fixture-result.json').diagnostics.length !== 0) C.fail('TYPE_FIXTURE_NOT_PASSED');
  for (const n of ['tests/tests', ...['repository-tests', 'typecheck-build', 'typecheck-test', 'jest-budget', 'build-only'].map(s => 'checks/' + s)]) {
    const r = get(n + '.exit.json'); if (r.code !== 0 || r.signal || r.error) C.fail('V2_CHECK_NOT_PASSED', n);
  }
  if (checks.status !== 'COMPAT_FULL_OFFLINE_CHECKS_VERIFIED' || checks.base !== p.compatBase || checks.buildOnly !== true || checks.notDeployed !== true) C.fail('FULL_CHECK_EVIDENCE_INVALID');
  C.eq(checks.productionBudgetUnchanged, { suites: 195, tests: 685 }, 'JEST_BUDGET_CHANGED');
  const ab = get('characterization/characterization.json');
  if (ab.status !== 'REAL_PINNED_CORE_OFFLINE_CHARACTERIZED' || ab.generatedBlob !== p.sourceLock.protectedBlobs['src/runtime/treasuryCompatReadCore.generated.ts'] || ab.engineCpuGapRepaired !== false || ab.scenarios?.length !== 10 || ab.scenarios.some(s => s.offByteEquivalent !== true || s.diagnosticSemanticEquivalent !== true)) C.fail('CHARACTERIZATION_INVALID');
  const scenarioNames = ['empty', 'two-manual', 'sixteen-manual', 'bound', 'over-bound', 'invalid', 'missing', 'mutation-no-revision', 'active-reservations', 'expired-reservations'];
  C.eq(ab.scenarios.map(s => s.name), scenarioNames, 'CHARACTERIZATION_SCENARIO_SET_MISMATCH');
  return { map, fingerprint: C.fingerprint(map), sourceCommit: src.head, fileCount: map.size, reusedEvidence: { implementationTests: 91, repositoryNodeCases: 70, jestSuites: 195, jestTests: 685, characterizationScenarios: 10, newEngineCpuMeasurement: false } };
}
function patchContexts(b, lines) {
  const list = b.toString('utf8').split('\n'); let old = 0, next = 0; const contexts = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i], h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(s);
    if (h) { if (old || next) C.fail('PATCH_HUNK_INCOMPLETE'); old = h[2] === undefined ? 1 : +h[2]; next = h[4] === undefined ? 1 : +h[4]; continue; }
    if (!old && !next) continue;
    if (s === '\\ No newline at end of file') continue;
    if (s.startsWith(' ')) { old--; next--; if (s === ' ') contexts.push(i + 1); }
    else if (s.startsWith('-')) old--; else if (s.startsWith('+')) next--;
    else C.fail('PATCH_HUNK_SYNTAX_INVALID');
    if (old < 0 || next < 0) C.fail('PATCH_HUNK_OVERFLOW');
  }
  if (old || next) C.fail('PATCH_HUNK_INCOMPLETE'); C.eq(contexts, lines, 'PATCH_CONTEXT_LINES_MISMATCH'); return contexts;
}
function whitespaceCommand(repo, revisionArgs, p = POLICY, excluded) {
  const args = ['-c', 'color.ui=false', '-c', 'core.quotePath=false', '-c', 'core.whitespace=' + p.coreWhitespace,
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--check', ...revisionArgs, '--', '.'];
  if (excluded) args.push(':(top,exclude,literal)' + excluded);
  return C.gitResult(repo, args);
}
function whitespace(refactor, all, p = POLICY, revisionArgs = ['--cached', p.refactorBase]) {
  const n = p.oldTarget + '/' + p.exception.path, b = all.get(n); if (!b) C.fail('PINNED_PATCH_MISSING');
  C.verifyBytes(b, p.exception, 'PINNED_PATCH_CHANGED'); patchContexts(b, p.exception.lines);
  const full = whitespaceCommand(refactor, revisionArgs, p);
  const expected = p.exception.lines.map(line => `${n}:${line}: trailing whitespace.\n+ \n`).join('');
  if (full.code !== 2 || full.stderr.length || full.stdout.toString('utf8').replace(/\r\n/g, '\n') !== expected) C.fail('UNEXPECTED_WHITESPACE_DIAGNOSTIC', { exit: full.code, stdoutSha256: C.sha(full.stdout), stdout: full.stdout.toString('utf8'), stderr: full.stderr.toString('utf8') });
  const remaining = whitespaceCommand(refactor, revisionArgs, p, n);
  if (remaining.code !== 0 || remaining.stdout.length || remaining.stderr.length) C.fail('NON_EXEMPT_WHITESPACE_ERROR', { exit: remaining.code, stdout: remaining.stdout.toString('utf8'), stderr: remaining.stderr.toString('utf8') });
  return { status: 'STAGED_CHECK_PASSED_WITH_EXACT_PATCH_CONTEXT_EXCEPTION', nativeCheckPassed: false,
    nativeExit: full.code, rawNativeStdout: full.stdout.toString('utf8'), rawNativeStderr: full.stderr.toString('utf8'),
    rawNativeStdoutSha256: C.sha(full.stdout), remainingPathsExit: remaining.code,
    exception: { path: n, sha256: p.exception.sha256, bytes: p.exception.bytes, lines: p.exception.lines, interpretation: 'single-space empty context in immutable previously executed patch' },
    noWildcardPatchExclusion: true, noGitConfigurationWrite: true };
}
function inspectState(compat, refactor, p = POLICY, allowSupplement = false) {
  const src = source(compat, p), index = stage(refactor, p); const old = oldArchive(refactor, index.bytes, src, p);
  const extra = index.names.filter(n => !n.startsWith(p.oldTarget + '/'));
  if (extra.some(n => !allowSupplement || !n.startsWith(p.newTarget + '/'))) C.fail('STAGED_SCOPE_MISMATCH');
  if (index.untracked.some(n => !allowSupplement || !n.startsWith(p.newTarget + '/'))) C.fail('UNEXPECTED_UNTRACKED_FILES');
  return { src, index, old };
}
module.exports = { POLICY, tapCounts, source, stage, subset, manifestCheck, oldArchive, patchContexts, whitespaceCommand, whitespace, inspectState };
