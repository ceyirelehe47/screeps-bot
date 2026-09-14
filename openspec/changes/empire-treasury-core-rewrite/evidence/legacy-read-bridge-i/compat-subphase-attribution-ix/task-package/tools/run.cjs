'use strict';
const C = require('./common.cjs');
const { workflow } = require('./workflow.cjs');
function options(args) { const o = {}; for (let i = 0; i < args.length; i += 2) { const k = args[i]; C.check(/^--[a-z-]+$/.test(k) && args[i + 1] && !args[i + 1].startsWith('--') && !Object.hasOwn(o, k.slice(2)), 'ARGUMENT_INVALID'); o[k.slice(2)] = args[i + 1]; } return o; }
function requireKeys(o, keys, allowed = keys) { C.check(Object.keys(o).every(k => allowed.includes(k)), 'UNKNOWN_ARGUMENT'); for (const k of keys) C.check(typeof o[k] === 'string' && o[k], 'ARGUMENT_REQUIRED', k); }
function modulePath(repo) { const p = C.path.join(C.path.resolve(repo), 'node_modules'); C.check(C.fs.existsSync(C.path.join(p, 'typescript', 'lib', 'typescript.js')), 'REPOSITORY_DEPENDENCIES_REQUIRED'); return p; }
function materializeSlice(dest) {
  C.fs.mkdirSync(dest); for (const dir of ['baseline', 'implementation']) for (const n of C.list(C.path.join(C.ROOT, dir))) {
    const p = C.safePath(dest, n); C.fs.mkdirSync(C.path.dirname(p), { recursive: true }); C.fs.writeFileSync(p, C.fs.readFileSync(C.path.join(C.ROOT, dir, n)));
  }
}
function tests(o) {
  requireKeys(o, ['typescript-repo', 'out'], ['typescript-repo', 'out', 'compat', 'refactor']); const modules = modulePath(o['typescript-repo']);
  const out = C.newOutput(o.out, [C.ROOT, o.compat, o.refactor, o['typescript-repo']]);
  const fixture = C.path.join(out, 'repository-slice'); materializeSlice(fixture); const set = C.json(C.path.join(C.ROOT, 'references/test-set.json'));
  const spec = n => C.path.join(fixture, 'test/treasury-compat', n + '.spec.cjs');
  const reader = C.capture(out, 'reader-tests', ['--test', '--test-reporter=tap', ...['bridge', 'real-readers', 'loader-optimization', 'build-optimization', 'attribution'].map(spec)], { cwd: fixture, env: C.environment(modules) });
  C.tap(reader.stdout.text, set.readerTests);
  const tools = C.capture(out, 'workflow-tests', ['--test', '--test-reporter=tap', C.path.join(C.ROOT, 'tests/workflow.spec.cjs')], { env: C.environment(modules) }); C.tap(tools.stdout.text, set.workflowTests);
  const v = { status: 'SUBPHASE_IX_FIXED_TESTS_VERIFIED', readerTests: set.readerTests, workflowTests: set.workflowTests,
    node: process.version, platform: process.platform, typescript: require(C.path.join(modules, 'typescript')).version,
    packageFingerprint: workflow().fingerprint(), onlineRun: false, engineCpuMeasurement: false };
  C.writeNew(C.path.join(out, 'summary.json'), v); return v;
}
function profile(name, setup) {
  const A = require(C.path.join(process.cwd(), 'test/treasury-compat/attribution-test-support.cjs'));
  const s = A.diagnosticScene(setup); const result = s.observer.run(), report = s.report();
  C.check(result.status === 'sampled' && report.status === 'sampled', 'ATTRIBUTION_SYNTHETIC_SAMPLE_INCOMPLETE', name);
  const a = report.cpuProfile?.attribution, work = a?.work || {};
  C.check(a?.version === 1 && a.boundaries === 12 && a.active === null, 'ATTRIBUTION_BOUNDARY_MISMATCH', name);
  const completeProjection = work.projectionRowsPlanned === 4 && work.projectionRowsCompleted === 4 && work.projectionIndexQueries === 16 && report.commitments?.rows?.length === 4;
  C.check(completeProjection, 'ATTRIBUTION_PROJECTION_MISMATCH', name);
  return { name, status: report.status, commitmentStatus: report.commitments.status, boundaries: a.boundaries, active: a.active,
    intervals: a.intervals, work, cpuPortReads: s.calls.cpu, completeProjection,
    topLevelCalls: report.cpuProfile.calls, topLevelPhases: report.cpuProfile.phases,
    note: 'synthetic Node CPU increments; interval values are not Screeps engine timing' };
}
function characterize(o) {
  requireKeys(o, ['compat', 'out'], ['compat', 'out', 'refactor']); const w = workflow();
  if (C.gt(o.compat, ['rev-parse', 'HEAD']) === w.policy.compatBase) w.checkSource(o.compat); else w.committed(o.compat);
  const out = C.newOutput(o.out, [C.ROOT, o.compat, o.refactor]);
  const repo = C.path.resolve(o.compat), oldCwd = process.cwd(); process.chdir(repo);
  try {
    const A = require(C.path.join(repo, 'test/treasury-compat/attribution-test-support.cjs')), S = A.S;
    const scenarios = Object.keys(S.scenarios).map(n => A.compareScenario(n));
    C.check(scenarios.length === 20 && scenarios.every(x => x.byteEquivalent && x.writes.every(n => n === 0)), 'AB_COMPARISON_FAILED');
    const profiles = [
      profile('empty', () => {}),
      profile('tasks16', s => { for (let i = 0; i < 16; i++) s.memory.data.resourceControl.tasks['t' + i] = S.task({ id: 't' + i }); }),
      profile('tasks256', s => { for (let i = 0; i < 256; i++) s.memory.data.resourceControl.tasks['t' + i] = S.task({ id: 't' + i }); }),
      profile('invalid-task-and-reservation', s => { s.memory.data.resourceControl.tasks.bad = S.task({ id: 'bad', remainingAmount: -1 }); s.memory.runtime.resourceReservations.bad = S.reservation({ amount: -1 }); }),
    ];
    const contract = C.json(C.path.join(C.ROOT, 'references/attribution-contract.json'));
    C.check(profiles.every(x => x.boundaries === contract.expectedBoundaryCallsForOneCompleteSample && x.active === null && x.completeProjection), 'ATTRIBUTION_PROFILE_INVALID');
    C.check(new Set(profiles.map(x => x.cpuPortReads)).size === 1, 'CPU_PORT_READS_SCALE_WITH_RECORD_COUNT');
    const r = { status: 'ATTRIBUTION_IX_REAL_CORE_VERIFIED', packageFingerprint: w.fingerprint(), contract, scenarios, profiles,
      oldGeneratedBlob: C.blob(Buffer.from(A.beforeText())), newGeneratedBlob: C.blob(Buffer.from(A.afterText())),
      attributionBounded: true, perRecordCpuSampling: false, primitiveWorkCountersOnly: true, diagnosticOverheadSubtracted: false,
      subphasesOverlapParentPhases: true, businessSemanticsChanged: false, authorizationChanged: false,
      onlineRun: false, actualEngineMeasurement: false, engineCpuGapRepaired: false };
    C.writeNew(C.path.join(out, 'characterization.json'), r);
    return { status: r.status, scenarios: scenarios.length, profiles: profiles.length, boundaryCalls: 12, onlineRun: false, engineCpuGapRepaired: false };
  } finally { process.chdir(oldCwd); }
}
function fullCheck(o) {
  requireKeys(o, ['compat', 'out'], ['compat', 'out', 'refactor']); const w = workflow(); w.checkSource(o.compat);
  for (const k of ['DEST', 'DEPLOY_ALLOW_DIRTY', 'NODE_OPTIONS', 'NODE_PATH']) C.check(!process.env[k], 'UNSAFE_BUILD_ENVIRONMENT', k);
  const repo = C.path.resolve(o.compat), out = C.newOutput(o.out, [repo, o.refactor, C.ROOT]); modulePath(repo);
  const set = C.json(C.path.join(C.ROOT, 'references/test-set.json'));
  const r = C.capture(out, 'repository-tests', ['--test', '--test-reporter=tap', ...['bridge', 'real-readers', 'independent', 'loader-optimization', 'build-optimization', 'attribution'].map(n => C.path.join(repo, 'test/treasury-compat/' + n + '.spec.cjs'))], { cwd: repo }); C.tap(r.stdout.text, set.repositoryTests);
  C.capture(out, 'regenerate', [C.path.join(repo, 'scripts/build-treasury-compat-loader.cjs'), '--check'], { cwd: repo });
  for (const [name, entry, args] of [['typecheck-build', 'typescript/bin/tsc', ['-p', 'tsconfig.build.json', '--noEmit']], ['typecheck-test', 'typescript/bin/tsc', ['-p', 'tsconfig.json', '--noEmit']]]) C.capture(out, name, [C.path.join(repo, 'node_modules', entry), ...args], { cwd: repo });
  const j = C.capture(out, 'jest-budget', [C.path.join(repo, 'scripts/verify-jest-budget.mjs')], { cwd: repo }); C.check(j.stdout.text.includes('"suites":195,"tests":685'), 'JEST_BUDGET_MISMATCH');
  C.capture(out, 'build-only', [C.path.join(repo, 'node_modules/rollup/dist/bin/rollup'), '-c'], { cwd: repo }); w.checkSource(repo);
  const v = { status: 'SUBPHASE_IX_FULL_CHECKS_VERIFIED', packageFingerprint: w.fingerprint(), compatBase: w.policy.compatBase,
    repositoryNodeTests: set.repositoryTests, jestSuites: 195, jestTests: 685, buildOnly: true, onlineRun: false, deployed: false };
  C.writeNew(C.path.join(out, 'summary.json'), v); return v;
}
function main(argv) {
  const command = argv.shift(), o = options(argv); C.integrity(); const w = workflow(); let r;
  switch (command) {
    case 'verify-package': requireKeys(o, []); r = C.integrity(); break;
    case 'baseline': requireKeys(o, ['compat', 'refactor']); r = w.baseline(o.compat, o.refactor); break;
    case 'test': r = tests(o); break;
    case 'apply': requireKeys(o, ['compat', 'snapshot']); r = w.apply(o.compat, o.snapshot); break;
    case 'verify-source': requireKeys(o, ['compat'], ['compat', 'staged']); C.check(!o.staged || ['yes', 'no'].includes(o.staged), 'ARGUMENT_INVALID'); r = w.checkSource(o.compat, o.staged === 'yes'); break;
    case 'stage-source': requireKeys(o, ['compat']); r = w.stageSource(o.compat); break;
    case 'verify-source-commit': requireKeys(o, ['compat']); r = { status: 'SOURCE_COMMIT_VERIFIED', compatHead: w.committed(o.compat) }; break;
    case 'characterize': r = characterize(o); break;
    case 'full-check': r = fullCheck(o); break;
    case 'archive': requireKeys(o, ['compat', 'refactor', 'tests', 'checks', 'characterization']); r = w.archive(o.compat, o.refactor, o.tests, o.checks, o.characterization); break;
    case 'verify-archive': requireKeys(o, ['refactor'], ['refactor', 'staged']); C.check(!o.staged || ['yes', 'no'].includes(o.staged), 'ARGUMENT_INVALID'); r = w.verifyArchive(o.refactor, o.staged === 'yes'); break;
    case 'stage-archive': requireKeys(o, ['refactor']); r = w.stageArchive(o.refactor); break;
    case 'verify-commits': requireKeys(o, ['compat', 'refactor']); r = w.postCommit(o.compat, o.refactor); break;
    case 'publish': requireKeys(o, ['compat', 'refactor']); r = w.publish(o.compat, o.refactor); break;
    default: C.fail('UNKNOWN_COMMAND');
  }
  console.log(JSON.stringify(r)); return r;
}
module.exports = { materializeSlice, tests, characterize, fullCheck, main };
if (require.main === module) try { main(process.argv.slice(2)); }
catch (e) { console.error(JSON.stringify({ status: 'STOP', code: e.code || 'LOCAL_OPERATION_FAILED', detail: e.detail || null })); process.exitCode = 1; }
