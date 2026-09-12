'use strict';
const C = require('./common.cjs');
const SOURCE_PREFIX = 'src/runtime/';
const HELPER = 'test/treasury-compat/helpers.cjs';
const split0 = b => b.toString('utf8').split('\0').filter(Boolean);
function changedPaths(repo) {
  return [...new Set([...split0(C.git(repo, ['diff', '--name-only', '-z', C.COMPAT])),
    ...split0(C.git(repo, ['ls-files', '--others', '--exclude-standard', '-z']))])].sort();
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function equivalentCheckout(actual, canonical) {
  return actual.equals(canonical) || actual.toString('utf8').replace(/\r\n/g, '\n') === canonical.toString('utf8');
}
function checkBase(repo) {
  if (C.gt(repo, ['rev-parse', 'HEAD']) !== C.COMPAT || C.gt(repo, ['branch', '--show-current']) !== C.BRANCH)
    C.fail('COMPAT_BASELINE_MISMATCH');
  if (C.git(repo, ['diff', '--cached', '--name-only', '-z']).length) C.fail('INDEX_MUST_BE_EMPTY');
  for (const e of C.sourcePlan()) {
    if (e.oldBlob && C.gt(repo, ['rev-parse', C.COMPAT + ':' + e.path]) !== e.oldBlob)
      C.fail('BASE_BLOB_MISMATCH', e.path);
  }
}
/** Only clean, exact v1 payload, or exact v2 payload. Never infer from M/?? alone. */
function inspect(repo) {
  checkBase(repo);
  const plan = C.sourcePlan(), paths = changedPaths(repo);
  const source = plan.filter(e => e.path.startsWith(SOURCE_PREFIX));
  let mode;
  if (!paths.length) mode = 'CLEAN_BASELINE';
  else if (same(paths, source.map(e => e.path).sort())) mode = 'EXACT_V1_SOURCE_APPLIED';
  else if (same(paths, plan.map(e => e.path).sort())) mode = 'EXACT_V2_APPLIED';
  else C.fail('RESUME_SCOPE_MISMATCH', { actual: paths });
  for (const e of plan) {
    const p = C.assertInside(repo, e.path);
    const wantNew = mode === 'EXACT_V2_APPLIED' || (mode === 'EXACT_V1_SOURCE_APPLIED' && e.path.startsWith(SOURCE_PREFIX));
    if (wantNew) {
      if (!C.fs.existsSync(p) || !C.fs.readFileSync(p).equals(e.bytes)) C.fail('RESUME_BYTES_MISMATCH', e.path);
    } else if (e.oldBlob) {
      const old = C.git(repo, ['show', C.COMPAT + ':' + e.path]);
      if (!C.fs.existsSync(p) || !equivalentCheckout(C.fs.readFileSync(p), old)) C.fail('BASE_CHECKOUT_BYTES_MISMATCH', e.path);
    } else if (C.fs.existsSync(p)) C.fail('NEW_FILE_EXISTS', e.path);
  }
  return { status: 'COMPAT_CPU_APPLICATION_INPUT_VERIFIED', mode, changedPaths: paths, indexEmpty: true };
}
function protectedSources(repo) {
  const lock = C.read(C.path.join(C.ROOT, 'references/source-lock.json'));
  for (const [n, sha] of Object.entries(lock.protectedBlobs)) {
    if (C.gt(repo, ['rev-parse', 'HEAD:' + n]) !== sha) C.fail('PROTECTED_HEAD_CHANGED', n);
    const b = C.git(repo, ['show', 'HEAD:' + n]);
    if (!equivalentCheckout(C.fs.readFileSync(C.assertInside(repo, n)), b)) C.fail('PROTECTED_WORKTREE_CHANGED', n);
  }
}
function baseline(compat, refactor) {
  C.clean(refactor);
  if (C.gt(refactor, ['branch', '--show-current']) !== C.REFBRANCH || C.gt(refactor, ['rev-parse', 'HEAD']) !== C.REF)
    C.fail('REFACTOR_BASELINE_MISMATCH');
  for (const [r, branch, head] of [[compat, C.BRANCH, C.COMPAT], [refactor, C.REFBRANCH, C.REF]]) {
    if (C.gt(r, ['rev-parse', 'refs/remotes/origin/' + branch]) !== head) C.fail('REMOTE_TRACKING_BASELINE_MISMATCH');
  }
  const input = inspect(compat); protectedSources(compat);
  return { status: 'COMPAT_CPU_V2_BASELINE_VERIFIED', compat: C.COMPAT, refactor: C.REF,
    input, remoteCheck: 'local tracking refs only; Agent fetches separately' };
}
function applyBytes(root, plan, postCheck) {
  const originals = new Map();
  // Validate every target before writing. Rollback keeps real CRLF bytes.
  for (const e of plan) {
    const p = C.assertInside(root, e.path);
    if (e.oldBlob) {
      if (!C.fs.existsSync(p)) C.fail('SOURCE_MISSING', e.path);
      originals.set(p, C.fs.readFileSync(p));
    } else {
      if (C.fs.existsSync(p)) C.fail('NEW_FILE_EXISTS', e.path);
      originals.set(p, null);
    }
  }
  try {
    for (const e of plan) C.fs.writeFileSync(C.path.join(root, e.path), e.bytes, { flag: e.oldBlob ? 'w' : 'wx' });
    for (const e of plan) if (!C.fs.readFileSync(C.path.join(root, e.path)).equals(e.bytes)) C.fail('PATCH_WRITE_MISMATCH', e.path);
    if (postCheck) postCheck();
  } catch (error) {
    for (const [p, b] of originals) {
      if (b === null) { if (C.fs.existsSync(p)) C.fs.unlinkSync(p); }
      else C.fs.writeFileSync(p, b);
    }
    throw error;
  }
}
function externalSnapshot(repo, destination, input, plan) {
  if (!destination) C.fail('SNAPSHOT_PATH_REQUIRED');
  const out = C.path.resolve(destination);
  for (const base of [repo, C.ROOT]) {
    const rel = C.path.relative(C.path.resolve(base), out);
    if (!rel || (!rel.startsWith('..' + C.path.sep) && rel !== '..' && !C.path.isAbsolute(rel))) C.fail('SNAPSHOT_MUST_BE_EXTERNAL');
  }
  let cursor = out;
  while (true) {
    if (C.fs.existsSync(cursor) && C.fs.lstatSync(cursor).isSymbolicLink()) C.fail('SYMLINK_FORBIDDEN');
    const parent = C.path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  if (C.fs.existsSync(out)) C.fail('OUTPUT_ALREADY_EXISTS');
  const files = {};
  // The verified four paths only; no arbitrary working files, logs or secrets.
  for (const e of plan) {
    const p = C.assertInside(repo, e.path);
    if (!C.fs.existsSync(p)) { files[e.path] = { existed: false }; continue; }
    const b = C.fs.readFileSync(p);
    files[e.path] = { existed: true, bytes: b.length, sha256: C.sha(b) };
    C.put(C.path.join(out, 'files', e.path), b);
  }
  C.put(C.path.join(out, 'SNAPSHOT.json'), { ...input, compatBase: C.COMPAT, files, repositoryWritesMade: false });
  return { out, files };
}
function selectWrites(input, plan) {
  return input.mode === 'CLEAN_BASELINE' ? plan : input.mode === 'EXACT_V1_SOURCE_APPLIED'
    ? plan.filter(e => e.path === HELPER) : [];
}
function apply(repo, snapshot) {
  const input = inspect(repo); protectedSources(repo);
  const plan = C.sourcePlan(), saved = externalSnapshot(repo, snapshot, input, plan);
  // Do not overwrite any change made between the precheck and snapshot.
  const again = inspect(repo);
  if (again.mode !== input.mode) C.fail('APPLICATION_INPUT_CHANGED');
  for (const [n, record] of Object.entries(saved.files)) {
    const p = C.path.join(repo, n);
    if (record.existed ? !C.fs.existsSync(p) || C.sha(C.fs.readFileSync(p)) !== record.sha256 : C.fs.existsSync(p))
      C.fail('APPLICATION_INPUT_CHANGED', n);
  }
  const writes = selectWrites(input, plan);
  applyBytes(repo, writes, () => checkSources(repo));
  return { ...checkSources(repo), inputMode: input.mode, writtenPaths: writes.map(e => e.path),
    previousSourceBytesPreserved: input.mode === 'EXACT_V1_SOURCE_APPLIED', snapshot: saved.out };
}
function checkSources(repo, { staged = false, head = C.COMPAT } = {}) {
  const plan = C.sourcePlan();
  for (const e of plan) {
    const b = staged ? C.git(repo, ['show', ':' + e.path]) : C.fs.readFileSync(C.assertInside(repo, e.path));
    if (!b.equals(e.bytes)) C.fail('PATCHED_BYTES_MISMATCH', e.path);
  }
  protectedSources(repo);
  const expected = plan.map(e => e.path).sort(), names = changedPaths(repo);
  if (!same(names, expected)) C.fail('CHANGE_SCOPE_MISMATCH', { actual: names, expected });
  if (staged) {
    const index = split0(C.git(repo, ['diff', '--cached', '--name-only', '-z', head])).sort();
    if (!same(index, expected)) C.fail('STAGED_SCOPE_MISMATCH');
  }
  return { status: staged ? 'COMPAT_CPU_STAGED_BYTES_VERIFIED' : 'COMPAT_CPU_PATCH_VERIFIED', files: expected,
    budgetChanged: false, generatedCoreChanged: false, configEnabled: false,
    repositoryHelperIntegrated: true, productionRuntimeUnchangedFromV1: true };
}
function checkCommitted(repo) {
  C.clean(repo);
  if (C.gt(repo, ['branch', '--show-current']) !== C.BRANCH || C.gt(repo, ['rev-parse', 'HEAD^']) !== C.COMPAT)
    C.fail('EXPECTED_SINGLE_COMPAT_COMMIT');
  const paths = split0(C.git(repo, ['diff', '--name-only', '-z', C.COMPAT, 'HEAD'])).sort(), plan = C.sourcePlan();
  if (!same(paths, plan.map(e => e.path).sort())) C.fail('COMMITTED_SCOPE_MISMATCH');
  for (const e of plan) if (!C.git(repo, ['show', 'HEAD:' + e.path]).equals(e.bytes)) C.fail('COMMITTED_BYTES_MISMATCH');
  return C.gt(repo, ['rev-parse', 'HEAD']);
}
module.exports = { applyBytes, apply, inspect, baseline, checkSources, checkCommitted, externalSnapshot, selectWrites };
