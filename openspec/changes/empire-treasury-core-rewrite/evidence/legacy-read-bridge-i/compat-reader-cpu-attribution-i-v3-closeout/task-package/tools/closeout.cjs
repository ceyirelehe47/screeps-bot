'use strict';
const C = require('./common.cjs');
const K = require('./checks.cjs');
function loadProof(dir, p) {
  const b = C.fs.readFileSync(C.safe(dir, 'result.json')), x = C.json(b);
  if (x.status !== 'V2_STOP18_RESUME_INPUT_VERIFIED' || x.refactorBase !== p.refactorBase || x.v2ZipSha256 !== p.v2ZipSha256 || x.oldArchiveFileCount !== 77) C.fail('INSPECTION_PROOF_INVALID');
  return { value: x, bytes: b };
}
function requireSame(state, proof) {
  if (state.src.head !== proof.compatHead || state.old.fingerprint !== proof.oldArchiveFingerprint) C.fail('ORIGINAL_EVIDENCE_OR_SOURCE_CHANGED_SINCE_INSPECTION');
}
function inspect(o, p = K.POLICY) {
  const dest = C.external(o.out, [o.compat, o.refactor]);
  for (const [r, branch, head] of [[o.compat, p.compatBranch, p.compatBase], [o.refactor, p.refactorBranch, p.refactorBase]]) {
    if (C.text(r, ['rev-parse', 'refs/remotes/origin/' + branch]) !== head) C.fail('REMOTE_TRACKING_BASELINE_MISMATCH');
  }
  const state = K.inspectState(o.compat, o.refactor, p); if (state.index.untracked.length) C.fail('UNEXPECTED_UNTRACKED_FILES');
  const check = K.whitespace(o.refactor, state.index.bytes, p);
  const result = { status: 'V2_STOP18_RESUME_INPUT_VERIFIED', refactorBase: p.refactorBase, compatHead: state.src.head,
    compatParent: p.compatBase, sourceFiles: state.src.files, v2ZipSha256: p.v2ZipSha256,
    oldArchiveFileCount: state.old.fileCount, oldArchiveFingerprint: state.old.fingerprint,
    originalFiles: Object.fromEntries([...state.old.map].map(([n, b]) => [n, C.identity(b)])),
    originalIndexTree: C.text(o.refactor, ['write-tree']), reusedEvidence: state.old.reusedEvidence,
    whitespace: check, repositoryContentWrites: 0, indexContentWrites: 0, onlineCalls: 0 };
  C.put(C.path.join(dest, 'result.json'), result); return result;
}
function testsProof(dir, root = C.ROOT) {
  const m = C.read(C.safe(dir, 'result.json')); const want = C.read(C.path.join(root, 'references/test-set.json')).tests;
  if (m.status !== 'CLOSEOUT_FIXED_TESTS_VERIFIED' || m.packageFingerprint !== C.sha(C.fs.readFileSync(C.path.join(root, 'INTEGRITY.json'))) || m.tests !== want || m.exit !== 0 || m.stderr !== '') C.fail('CLOSEOUT_TEST_PROOF_INVALID');
  K.tapCounts(Buffer.from(m.stdout), want); return m;
}
function report(proof, p) {
  return '# Compat Reader CPU I · v3 归档收尾补充\n\n' +
    `沿用 compat 源码提交 ${proof.compatHead}，父提交 ${p.compatBase}。\n` +
    `refactor evidence 父提交固定为 ${p.refactorBase}。\n\n` +
    '本轮不重新应用 CPU 源码，不创建第二个 compat 提交，不重跑已留存的 91 项、70 项、195/685、十场景 A/B 或构建。复用的前提是提交、固定包身份、原始退出码和证据字节全部核验一致。\n\n' +
    'v2 步骤17的逐字节归档要求与步骤18的无例外 whitespace 检查冲突。原生 git diff --cached --check 仍为 exit 2，不得改写为原生检查通过。\n' +
    `唯一例外：${p.oldTarget}/${p.exception.path} 的第73、78行；整个文件 SHA-256 ${p.exception.sha256}。两行均为 unified diff hunk 中的单空格空上下文，不是生产源文件中的尾随空格。\n\n` +
    '新门禁先验证该整个固定文件及 hunk 语法，再要求原生完整检查的诊断恰好只有这两处；只排除这一个精确路径进行剩余文件检查，剩余文件必须零诊断、exit 0。没有排除全部 .patch，也没有修改 Git 配置、签名或钩子。\n\n' +
    `原77文件 fingerprint：${proof.oldArchiveFingerprint}。这些文件保留原始字节，包括旧任务书与旧失败规则；本补充是后续授权，不追改旧包。旧步骤18失败 stdout/stderr/exit 继续保留在 Agent Git 外工作目录。\n\n` +
    '新增补充记录中的原始检查输出用 JSON 转义无损保存，避免把诊断文本自身的行尾空格再次引入新文件。\n\n' +
    '范围仍为默认 OFF、预算2、不使用 token、不连接 Screeps、不上传候选、不执行恢复、不启动0004。引擎CPU缺口仍未解决；原0003仍为1条raw/0条完整，恢复闭合事实不变。\n\n' +
    '本文件在提交前装配，不声称推送已完成；只有最终 staged gate、唯一 evidence 提交和两条远端普通推送回读全部通过后，才允许报告本轮最终成功。\n';
}
function newPlan(proof, testResult, p, root) {
  const map = new Map(); map.set('.gitattributes', Buffer.from('* -text\n'));
  for (const n of C.files(root)) map.set('task-package/' + n, C.fs.readFileSync(C.safe(root, n)));
  map.set('PRE-COMMIT-VERIFICATION.json', C.encoded(proof)); map.set('CLOSEOUT-TESTS.json', C.encoded(testResult));
  map.set('EXECUTION-ADDENDUM.md', Buffer.from(report(proof, p)));
  const manifest = { files: Object.fromEntries([...map].map(([n, b]) => [n, C.identity(b)])) };
  map.set('MANIFEST.json', C.encoded(manifest)); return map;
}
function assemble(o, p = K.POLICY, root = C.ROOT) {
  const dest = C.external(o.out, [o.compat, o.refactor]), proof = loadProof(o.inspection, p).value;
  const t = testsProof(o.tests, root), state = K.inspectState(o.compat, o.refactor, p); requireSame(state, proof);
  if (state.index.untracked.length) C.fail('UNEXPECTED_UNTRACKED_FILES');
  const target = C.safe(o.refactor, p.newTarget); if (C.fs.existsSync(target)) C.fail('ADDENDUM_ALREADY_EXISTS');
  const map = newPlan(proof, t, p, root);
  let owned = false;
  try {
    C.fs.mkdirSync(target, { recursive: true }); owned = true;
    for (const [n, b] of map) C.put(C.path.join(target, n), b);
    const after = K.inspectState(o.compat, o.refactor, p, true); requireSame(after, proof);
    if (C.text(o.refactor, ['write-tree']) !== proof.originalIndexTree) C.fail('INDEX_CHANGED_DURING_ASSEMBLY');
    C.eq(C.files(target), [...map.keys()].sort(), 'ADDENDUM_WRITE_SET_MISMATCH');
    for (const [n, b] of map) if (!C.fs.readFileSync(C.safe(target, n)).equals(b)) C.fail('ADDENDUM_WRITE_BYTES_MISMATCH');
  } catch (e) { if (owned) C.fs.rmSync(target, { recursive: true, force: true }); throw e; }
  const result = { status: 'CLOSEOUT_ADDENDUM_ASSEMBLED', oldFilesPreserved: 77, sourceCommitReused: proof.compatHead,
    newFiles: map.size, target: p.newTarget, indexUnchanged: true, autoStagePerformed: false, originalArchiveFingerprint: proof.oldArchiveFingerprint };
  C.put(C.path.join(dest, 'result.json'), result); return result;
}
function gate(o, p = K.POLICY, root = C.ROOT) {
  const dest = C.external(o.out, [o.compat, o.refactor]), proof = loadProof(o.inspection, p).value;
  const state = K.inspectState(o.compat, o.refactor, p, true); requireSame(state, proof);
  if (state.index.untracked.length) C.fail('UNEXPECTED_UNTRACKED_FILES');
  const added = K.subset(state.index.bytes, p.newTarget); if (!added.size) C.fail('ADDENDUM_NOT_STAGED');
  const testResult = C.json(added.get('CLOSEOUT-TESTS.json'));
  const count = C.read(C.path.join(root, 'references/test-set.json')).tests;
  if (testResult.status !== 'CLOSEOUT_FIXED_TESTS_VERIFIED' || testResult.packageFingerprint !== C.sha(C.fs.readFileSync(C.path.join(root, 'INTEGRITY.json'))) || testResult.tests !== count || testResult.exit !== 0 || testResult.stderr !== '') C.fail('CLOSEOUT_TEST_PROOF_INVALID');
  K.tapCounts(Buffer.from(testResult.stdout), count);
  const expected = newPlan(proof, testResult, p, root);
  C.eq([...added.keys()].sort(), [...expected.keys()].sort(), 'ADDENDUM_FILE_SET_MISMATCH');
  for (const [n, b] of expected) if (!added.get(n).equals(b)) C.fail('ADDENDUM_BYTES_MISMATCH', n);
  C.eq(C.files(C.safe(o.refactor, p.newTarget)), [...expected.keys()].sort(), 'ADDENDUM_DISK_SET_MISMATCH');
  const check = K.whitespace(o.refactor, state.index.bytes, p);
  const result = { status: 'FINAL_STAGED_CLOSEOUT_GATE_VERIFIED', compatHead: state.src.head, refactorBase: p.refactorBase,
    originalArchiveFingerprint: state.old.fingerprint, originalFilesPreserved: 77, totalStagedFiles: state.index.bytes.size,
    indexTree: C.text(o.refactor, ['write-tree']), addendumFingerprint: C.fingerprint(added),
    whitespace: check, sourceChangedByV3: false, noNewDeployment: true };
  C.put(C.path.join(dest, 'result.json'), result); return result;
}
function committed(o, p = K.POLICY) {
  const dest = C.external(o.out, [o.compat, o.refactor]); const proof = C.read(C.safe(o.gate, 'result.json'));
  if (proof.status !== 'FINAL_STAGED_CLOSEOUT_GATE_VERIFIED' || proof.refactorBase !== p.refactorBase) C.fail('FINAL_GATE_REQUIRED');
  const src = K.source(o.compat, p); if (src.head !== proof.compatHead) C.fail('COMPAT_HEAD_CHANGED_AFTER_GATE');
  if (C.text(o.refactor, ['branch', '--show-current']) !== p.refactorBranch || C.git(o.refactor, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length) C.fail('REFACTOR_NOT_CLEAN');
  const head = C.text(o.refactor, ['rev-parse', 'HEAD']);
  C.eq(C.text(o.refactor, ['rev-list', '--parents', '-n', '1', head]).split(' ').slice(1), [p.refactorBase], 'EXPECTED_SINGLE_EVIDENCE_COMMIT');
  if (C.text(o.refactor, ['rev-parse', 'HEAD^{tree}']) !== proof.indexTree) C.fail('COMMITTED_TREE_DIFFERS_FROM_GATE');
  const n = p.oldTarget + '/' + p.exception.path;
  const check = K.whitespace(o.refactor, new Map([[n, C.git(o.refactor, ['show', 'HEAD:' + n])]]), p, [p.refactorBase, head]);
  const result = { status: 'CPU_V3_CLOSEOUT_COMMITTED_NOT_YET_REMOTE_VERIFIED', compatHead: src.head, refactorHead: head,
    evidenceParent: p.refactorBase, originalFilesPreserved: 77, whitespace: check, onlineCalls: 0 };
  C.put(C.path.join(dest, 'result.json'), result); return result;
}
function remote(o, p = K.POLICY) {
  const dest = C.external(o.out, [o.compat, o.refactor]); const proof = C.read(C.safe(o.committed, 'result.json'));
  if (proof.status !== 'CPU_V3_CLOSEOUT_COMMITTED_NOT_YET_REMOTE_VERIFIED') C.fail('COMMITTED_PROOF_REQUIRED');
  const found = {};
  for (const [repo, branch, head, key] of [[o.compat, p.compatBranch, proof.compatHead, 'compatHead'], [o.refactor, p.refactorBranch, proof.refactorHead, 'refactorHead']]) {
    if (C.text(repo, ['rev-parse', 'HEAD']) !== head || C.git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length) C.fail('LOCAL_STATE_CHANGED_BEFORE_REMOTE_VERIFY');
    const output = C.text(repo, ['ls-remote', '--refs', 'origin', 'refs/heads/' + branch]);
    if (output !== head + '\trefs/heads/' + branch) C.fail('REMOTE_HEAD_NOT_CONFIRMED', branch); found[key] = head;
  }
  const result = { status: 'CPU_V3_CLOSEOUT_REMOTE_VERIFIED', ...found,
    labels: ['COMPAT_CPU_OFFLINE_READY_NOT_DEPLOYED', 'CPU_PHASE_DIAGNOSTICS_IMPLEMENTED', 'UTF8_NORMAL_OUTPUT_RESCAN_REMOVED', 'ENGINE_CPU_BUDGET_GAP_UNRESOLVED', 'NOT_DEPLOYED'],
    sourceCommitReused: true, originalArchiveFilesPreserved: 77, screepsCalls: 0, newEngineCpuMeasurement: false };
  C.put(C.path.join(dest, 'result.json'), result); return result;
}
module.exports = { inspect, assemble, gate, committed, remote, loadProof, report, newPlan };
