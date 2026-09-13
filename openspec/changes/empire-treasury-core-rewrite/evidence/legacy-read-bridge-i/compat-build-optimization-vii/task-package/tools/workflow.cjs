'use strict';
const C = require('./common.cjs');
function workflow(policy = C.json(C.path.join(C.ROOT, 'references/source-lock.json')), root = C.ROOT) {
  const files = policy.changes.map(x => x.path).sort();
  const payload = n => C.fs.readFileSync(C.safePath(C.path.join(root, 'implementation'), n));
  const fingerprint = () => C.sha(C.fs.readFileSync(C.path.join(root, 'INTEGRITY.json')));
  function repoHead(repo, head, branch) { C.check(C.gt(repo, ['rev-parse', 'HEAD']) === head && C.gt(repo, ['branch', '--show-current']) === branch, 'HEAD_OR_BRANCH_MISMATCH'); }
  function remote(repo, branch) { return C.gt(repo, ['ls-remote', '--exit-code', 'origin', 'refs/heads/' + branch]).split(/\s+/)[0]; }
  function baseline(compat, refactor) {
    C.clean(compat); C.clean(refactor); repoHead(compat, policy.compatBase, policy.compatBranch); repoHead(refactor, policy.refactorBase, policy.refactorBranch);
    for (const [r, b, h] of [[compat, policy.compatBranch, policy.compatBase], [refactor, policy.refactorBranch, policy.refactorBase]]) C.check(remote(r, b) === h, 'REMOTE_BASELINE_DRIFT');
    for (const x of policy.changes.filter(x => x.oldBlob)) { const b = C.git(compat, ['show', policy.compatBase + ':' + x.path]); C.check(C.blob(b) === x.oldBlob, 'BASELINE_BLOB_MISMATCH', x.path); }
    for (const [n, b] of Object.entries(policy.protectedBlobs)) C.check(C.gt(compat, ['rev-parse', policy.compatBase + ':' + n]) === b, 'FROZEN_BLOB_MISMATCH', n);
    return { status: 'BUILD_VII_BASELINES_VERIFIED', compatBase: policy.compatBase, refactorBase: policy.refactorBase };
  }
  function checkSource(compat, staged = false) {
    const head = C.gt(compat, ['rev-parse', 'HEAD']); C.check(head === policy.compatBase, 'SOURCE_BASELINE_MOVED');
    C.check(C.gt(compat, ['branch', '--show-current']) === policy.compatBranch, 'WRONG_COMPAT_BRANCH');
    for (const x of policy.changes) { const b = staged ? C.git(compat, ['show', ':' + x.path]) : C.fs.readFileSync(C.safePath(compat, x.path)); C.check(b.equals(payload(x.path)) && C.sha(b) === x.newSha256, 'SOURCE_BYTES_MISMATCH', x.path); }
    const changed = new Set([...C.pathList(C.git(compat, ['diff', '--name-only', '-z', policy.compatBase])), ...C.pathList(C.git(compat, ['ls-files', '--others', '--exclude-standard', '-z'])), ...policy.changes.filter(x => !x.oldBlob && C.fs.existsSync(C.safePath(compat, x.path))).map(x => x.path)]);
    C.check(JSON.stringify([...changed].sort()) === JSON.stringify(files), 'SOURCE_SCOPE_MISMATCH');
    for (const [n, id] of Object.entries(policy.protectedBlobs)) { const b = C.fs.readFileSync(C.safePath(compat, n)); const canonical = Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n')); C.check(C.blob(canonical) === id, 'FROZEN_FILE_CHANGED', n); }
    if (staged) { const selected = C.pathList(C.git(compat, ['diff', '--cached', '--name-only', '-z'])); C.check(JSON.stringify(selected) === JSON.stringify(files), 'STAGED_SOURCE_SCOPE_MISMATCH'); }
    return { status: 'BUILD_VII_SOURCE_BYTES_VERIFIED', staged, files: files.length, budgetChanged: false, directReadChanged: false };
  }
  function apply(compat, snapshot) {
    C.clean(compat); repoHead(compat, policy.compatBase, policy.compatBranch);
    const original = new Map();
    for (const x of policy.changes) { const dest = C.safePath(compat, x.path); const b = C.fs.existsSync(dest) ? C.fs.readFileSync(dest) : null;
      if (x.oldBlob) C.check(b && C.blob(Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'))) === x.oldBlob, 'BASELINE_FILE_MISMATCH', x.path);
      else C.check(b === null, 'NEW_PATH_ALREADY_EXISTS', x.path);
      C.check(C.sha(payload(x.path)) === x.newSha256, 'PAYLOAD_CHANGED'); original.set(x.path, b);
    }
    const out = C.newOutput(snapshot, [compat, root]);
    for (const [n, b] of original) if (b) C.writeNew(C.path.join(out, 'before', n), b);
    C.writeNew(C.path.join(out, 'snapshot.json'), { compatBase: policy.compatBase, files: Object.fromEntries([...original].map(([n, b]) => [n, b ? { bytes: b.length, sha256: C.sha(b) } : null])) });
    const written = [];
    try { for (const n of files) { const dest = C.safePath(compat, n); C.fs.mkdirSync(C.path.dirname(dest), { recursive: true }); written.push(n); C.fs.writeFileSync(dest, payload(n)); } return checkSource(compat); }
    catch (e) { const failed = []; for (const n of written.reverse()) try { const b = original.get(n); if (b === null) C.fs.rmSync(C.safePath(compat, n), { force: true }); else C.fs.writeFileSync(C.safePath(compat, n), b); } catch { failed.push(n); }
      if (failed.length) C.fail('APPLY_ROLLBACK_INCOMPLETE', { paths: failed, snapshot: out }); throw e; }
  }
  function stageSource(compat) { checkSource(compat); C.check(!C.gt(compat, ['diff', '--cached', '--name-only']), 'INDEX_NOT_EMPTY'); C.git(compat, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'add', '-f', '--', ...files]); const r = checkSource(compat, true); C.git(compat, ['diff', '--cached', '--check']); return { ...r, sourceIndexTree: C.gt(compat, ['write-tree']) }; }
  function committed(compat) {
    C.clean(compat); C.check(C.gt(compat, ['branch', '--show-current']) === policy.compatBranch, 'WRONG_COMPAT_BRANCH'); const h = C.gt(compat, ['rev-parse', 'HEAD']);
    C.check(C.gt(compat, ['rev-list', '--parents', '-n', '1', h]) === h + ' ' + policy.compatBase, 'SOURCE_COMMIT_PARENT_MISMATCH');
    const names = C.pathList(C.git(compat, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', h])); C.check(JSON.stringify(names) === JSON.stringify(files), 'SOURCE_COMMIT_SCOPE_MISMATCH');
    for (const n of files) C.check(C.git(compat, ['show', h + ':' + n]).equals(payload(n)), 'COMMITTED_SOURCE_CHANGED', n);
    return h;
  }
  function accepted(testDir, checksDir, abDir) {
    const t = C.json(C.path.join(testDir, 'summary.json')), p = C.json(C.path.join(checksDir, 'summary.json')), ab = C.json(C.path.join(abDir, 'characterization.json'));
    C.check(t.status === 'BUILD_VII_FIXED_TESTS_VERIFIED' && p.status === 'BUILD_VII_FULL_CHECKS_VERIFIED' && ab.status === 'BUILD_VII_REAL_CORE_AB_VERIFIED', 'REQUIRED_CHECK_MISSING');
    C.check([t, p, ab].every(x => x.packageFingerprint === fingerprint()), 'CHECK_PACKAGE_IDENTITY_MISMATCH');
    const sets = C.json(C.path.join(root, 'references/test-set.json'));
    for (const [dir, name, count] of [[testDir, 'reader-tests', sets.readerTests], [testDir, 'workflow-tests', sets.workflowTests], [checksDir, 'repository-tests', sets.repositoryTests]]) {
      const v = C.json(C.path.join(dir, name + '.json')); C.check(v.exit === 0 && !v.signal && !v.error, 'RAW_CHECK_FAILED', name); C.tap(C.validatePacket(v.stdout), count); C.validatePacket(v.stderr);
    }
    for (const name of ['regenerate', 'typecheck-build', 'typecheck-test', 'jest-budget', 'build-only']) { const v = C.json(C.path.join(checksDir, name + '.json')); C.check(v.exit === 0 && !v.signal && !v.error, 'RAW_PROJECT_CHECK_FAILED', name); C.validatePacket(v.stdout); C.validatePacket(v.stderr); }
    const j = C.json(C.path.join(checksDir, 'jest-budget.json')); C.check(C.validatePacket(j.stdout).includes('"suites":195,"tests":685'), 'JEST_BUDGET_MISMATCH');
    C.check(ab.scenarios.length === 20 && ab.scenarios.every(x => x.byteEquivalent && x.writes.every(v => v === 0)) && ab.engineCpuGapRepaired === false, 'AB_EVIDENCE_INVALID');
    C.check(ab.scenarios.every(x => x.oldFactoryExecutions === 7 && x.newFactoryExecutions === 7), 'AB_FACTORY_COUNT_MISMATCH');
    C.check(JSON.stringify(ab.operationCounts) === JSON.stringify(C.json(C.path.join(root, 'references/operation-contract.json'))), 'BUILD_OPERATION_COUNT_MISMATCH');
    return { test: t, project: p, ab };
  }
  function archive(compat, refactor, testDir, checksDir, abDir) {
    const h = committed(compat); C.clean(refactor); repoHead(refactor, policy.refactorBase, policy.refactorBranch); const evidence = accepted(testDir, checksDir, abDir);
    const target = C.safePath(refactor, policy.evidenceTarget); C.check(!C.fs.existsSync(target), 'ARCHIVE_ALREADY_EXISTS');
    const plan = new Map(); plan.set('.gitattributes', Buffer.from('* -text\n'));
    for (const n of C.list(root)) plan.set('task-package/' + n, C.fs.readFileSync(C.safePath(root, n)));
    for (const [dir, names, prefix] of [[testDir, ['reader-tests.json', 'workflow-tests.json', 'summary.json'], 'tests'], [checksDir, ['repository-tests.json', 'regenerate.json', 'typecheck-build.json', 'typecheck-test.json', 'jest-budget.json', 'build-only.json', 'summary.json'], 'checks'], [abDir, ['characterization.json'], 'characterization']]) {
      for (const n of names) plan.set(prefix + '/' + n, C.fs.readFileSync(C.path.join(dir, n)));
    }
    const final = { status: 'BUILD_VII_OFFLINE_VERIFIED_NOT_DEPLOYED', compatHead: h, compatBase: policy.compatBase, refactorBase: policy.refactorBase,
      packageFingerprint: fingerprint(), factoryBodiesChanged: ['commitments: full task-bucket storage', 'observation: intermediates'], runtimeDefinitionReuse: true,
      firstSuccessfulFactoryExecutions: 7, followingFactoryExecutions: 0, actualEngineMeasurement: false,
      directReadChanged: false, taskBucketStorageChanged: true, observationIntermediatesReduced: true, fullIndexBuiltEagerly: true, engineCpuGapRepaired: false, budget: 2, enabled: false,
      originalCpuRecheckVI: { raw: 4, diagnostic: 4, complete: 0, commitmentBuilds: 3, recoveryClosed: true } };
    plan.set('FINAL-VERIFICATION.json', C.encode(final));
    plan.set('EXECUTION-REPORT.md', Buffer.from('# Compat Build Optimization VII\n\n' +
      `源码基线：${policy.compatBase}\n源码提交：${h}\n证据父提交：${policy.refactorBase}\n\n` +
      '本轮仅改变只读兼容 capsule 的完整任务索引存储方式及 observation 中间分配。每次仍创建全新 scope/room buckets、完整索引、observation、指标与视图；没有跨样本缓存或延迟构建次级索引。\n\n' +
      '全表枚举、记录校验、安全整数溢出及部分更新顺序、reason/merge/receiver 查询语义和预留 owner/expiry 规则保留。直接读取、preview、CPU检查点、上下文及加载器均未修改。VII逆变换还原Read V；V逆变换还原canonical前缀。逆变换不代替语义对照。\n\n' +
      '原生Map计数与136个临时entry pair的减少是合成输入的确定性工作量，不是引擎CPU结果。20场景A/B及完整API反例通过；实际源/目标核心字节固定。\n\n' +
      '预算2、配置OFF、窗口0；无Screeps调用、token、上传或恢复。CPU VI历史仍4诊断/0完整、3次承诺构建、恢复闭合。引擎缺口仍未解决。\n'));

    const manifest = { files: Object.fromEntries([...plan].map(([n, b]) => [n, { bytes: b.length, sha256: C.sha(b) }])) };
    plan.set('ARCHIVE-MANIFEST.json', C.encode(manifest));
    try { for (const [n, b] of plan) C.writeNew(C.path.join(target, n), b); }
    catch (e) { C.fs.rmSync(target, { recursive: true, force: true }); throw e; }
    return { ...final, archiveFiles: plan.size, verificationReused: !!evidence };
  }
  function verifyArchive(refactor, staged = false, committedHead = null) {
    const target = C.safePath(refactor, policy.evidenceTarget); const m = C.json(C.path.join(target, 'ARCHIVE-MANIFEST.json'));
    C.verifyInventory(target, m.files, ['ARCHIVE-MANIFEST.json']);
    const required = ['.gitattributes', 'FINAL-VERIFICATION.json', 'EXECUTION-REPORT.md',
      ...C.list(root).map(n => 'task-package/' + n),
      ...['reader-tests', 'workflow-tests', 'summary'].map(n => 'tests/' + n + '.json'),
      ...['repository-tests', 'regenerate', 'typecheck-build', 'typecheck-test', 'jest-budget', 'build-only', 'summary'].map(n => 'checks/' + n + '.json'),
      'characterization/characterization.json'].sort();
    C.check(JSON.stringify(Object.keys(m.files).sort()) === JSON.stringify(required), 'ARCHIVE_WHITELIST_MISMATCH');
    accepted(C.path.join(target, 'tests'), C.path.join(target, 'checks'), C.path.join(target, 'characterization'));
    const final = C.json(C.path.join(target, 'FINAL-VERIFICATION.json'));
    C.check(final.status === 'BUILD_VII_OFFLINE_VERIFIED_NOT_DEPLOYED' && final.enabled === false && final.budget === 2 &&
      final.engineCpuGapRepaired === false && final.actualEngineMeasurement === false && final.firstSuccessfulFactoryExecutions === 7 &&
      final.followingFactoryExecutions === 0 && final.directReadChanged === false && final.fullIndexBuiltEagerly === true && final.packageFingerprint === fingerprint(), 'FINAL_SCOPE_CLAIM_INVALID');

    const all = [...Object.keys(m.files), 'ARCHIVE-MANIFEST.json'].sort();
    for (const n of C.list(root)) C.check(C.fs.readFileSync(C.path.join(target, 'task-package', n)).equals(C.fs.readFileSync(C.path.join(root, n))), 'ARCHIVED_PACKAGE_CHANGED', n);
    const revision = committedHead || (staged ? '' : null);
    if (revision !== null) { for (const n of all) C.check(C.git(refactor, ['show', revision + ':' + policy.evidenceTarget + '/' + n]).equals(C.fs.readFileSync(C.path.join(target, n))), 'INDEX_ARCHIVE_BYTES_MISMATCH', n);
      const actual = C.pathList(C.git(refactor, ['diff', ...(committedHead ? [] : ['--cached']), '--name-only', '-z', policy.refactorBase, ...(committedHead ? [committedHead] : [])]));
      C.check(JSON.stringify(actual) === JSON.stringify(all.map(n => policy.evidenceTarget + '/' + n).sort()), 'ARCHIVE_SCOPE_MISMATCH');
      C.git(refactor, ['diff', ...(committedHead ? [] : ['--cached']), '--check', policy.refactorBase, ...(committedHead ? [committedHead] : [])]);
    }
    return { status: 'BUILD_VII_ARCHIVE_VERIFIED', files: all.length, staged, committedHead, nativeWhitespaceCheck: revision === null ? 'not-run' : 'passed-zero-exceptions', packageFingerprint: fingerprint() };
  }
  function stageArchive(refactor) { repoHead(refactor, policy.refactorBase, policy.refactorBranch); verifyArchive(refactor); C.check(!C.gt(refactor, ['diff', '--cached', '--name-only']), 'INDEX_NOT_EMPTY'); C.git(refactor, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'add', '-f', '--', policy.evidenceTarget]); const v = verifyArchive(refactor, true); return { ...v, indexTree: C.gt(refactor, ['write-tree']) }; }
  function postCommit(compat, refactor) { const ch = committed(compat); C.clean(refactor); C.check(C.gt(refactor, ['branch', '--show-current']) === policy.refactorBranch, 'WRONG_REFACTOR_BRANCH'); const rh = C.gt(refactor, ['rev-parse', 'HEAD']);
    C.check(C.gt(refactor, ['rev-list', '--parents', '-n', '1', rh]) === rh + ' ' + policy.refactorBase, 'EVIDENCE_PARENT_MISMATCH'); verifyArchive(refactor, false, rh);
    const v = C.json(C.path.join(refactor, policy.evidenceTarget, 'FINAL-VERIFICATION.json')); C.check(v.compatHead === ch && v.packageFingerprint === fingerprint(), 'ARCHIVE_SOURCE_IDENTITY_MISMATCH'); return { status: 'BUILD_VII_COMMITS_VERIFIED', compatHead: ch, refactorHead: rh };
  }
  function publish(compat, refactor) { const v = postCommit(compat, refactor);
    for (const [r, branch, before, after] of [[compat, policy.compatBranch, policy.compatBase, v.compatHead], [refactor, policy.refactorBranch, policy.refactorBase, v.refactorHead]]) {
      const current = remote(r, branch); C.check(current === before || current === after, 'REMOTE_DRIFT_NO_FORCE_PUSH');
      if (current !== after) C.git(r, ['push', 'origin', after + ':refs/heads/' + branch]); C.check(remote(r, branch) === after, 'PUSH_READBACK_MISMATCH');
    } return { ...v, status: 'BUILD_VII_PUBLISHED_NOT_DEPLOYED' };
  }
  return { policy, root, files, payload, fingerprint, baseline, checkSource, apply, stageSource, committed, accepted, archive, verifyArchive, stageArchive, postCommit, publish };
}
module.exports = { workflow };
