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
  const reader = C.capture(out, 'reader-tests', ['--test', '--test-reporter=tap', ...['bridge', 'real-readers', 'loader-optimization'].map(spec)], { cwd: fixture, env: C.environment(modules) });
  C.tap(reader.stdout.text, set.readerTests);
  const tools = C.capture(out, 'workflow-tests', ['--test', '--test-reporter=tap', C.path.join(C.ROOT, 'tests/workflow.spec.cjs')], { env: C.environment(modules) }); C.tap(tools.stdout.text, set.workflowTests);
  const v = { status: 'LOADER_III_FIXED_TESTS_VERIFIED', readerTests: set.readerTests, workflowTests: set.workflowTests,
    node: process.version, platform: process.platform, typescript: require(C.path.join(modules, 'typescript')).version,
    packageFingerprint: workflow().fingerprint(), engineCpuMeasurement: false };
  C.writeNew(C.path.join(out, 'summary.json'), v); return v;
}
function characterize(o) {
  requireKeys(o, ['compat', 'out'], ['compat', 'out', 'refactor']); const w = workflow();
  if (C.gt(o.compat, ['rev-parse', 'HEAD']) === w.policy.compatBase) w.checkSource(o.compat); else w.committed(o.compat);
  const out = C.newOutput(o.out, [C.ROOT, o.compat, o.refactor]); const support = require(C.path.join(C.path.resolve(o.compat), 'test/treasury-compat/loader-test-support.cjs'));
  const scenarios = Object.keys(support.scenarios).map(n => support.compareScenario(n));
  C.check(scenarios.length === 20 && scenarios.every(x => x.byteEquivalent && x.writes.every(n => n === 0)), 'AB_COMPARISON_FAILED');
  C.check(scenarios.every(x => x.oldFactoryExecutions === 96 && x.newFactoryExecutions === 30), 'AB_FACTORY_COUNT_MISMATCH');
  const r = { status: 'LOADER_III_REAL_CORE_AB_VERIFIED', packageFingerprint: w.fingerprint(), scenarios,
    oldGeneratedBlob: C.blob(Buffer.from(support.oldText())), newGeneratedBlob: C.blob(Buffer.from(support.newText())),
    engineCpuGapRepaired: false, engineTimingMeasured: false, directReadOptimized: false };
  C.writeNew(C.path.join(out, 'characterization.json'), r); return { status: r.status, scenarios: scenarios.length, firstFactories: 8, subsequentFactories: 2 };
}
function fullCheck(o) {
  requireKeys(o, ['compat', 'out'], ['compat', 'out', 'refactor']); const w = workflow(); w.checkSource(o.compat);
  for (const k of ['DEST', 'DEPLOY_ALLOW_DIRTY', 'NODE_OPTIONS', 'NODE_PATH']) C.check(!process.env[k], 'UNSAFE_BUILD_ENVIRONMENT', k);
  const repo = C.path.resolve(o.compat), out = C.newOutput(o.out, [repo, o.refactor, C.ROOT]); modulePath(repo);
  const set = C.json(C.path.join(C.ROOT, 'references/test-set.json'));
  const r = C.capture(out, 'repository-tests', ['--test', '--test-reporter=tap', ...['bridge', 'real-readers', 'independent', 'loader-optimization'].map(n => C.path.join(repo, 'test/treasury-compat/' + n + '.spec.cjs'))], { cwd: repo }); C.tap(r.stdout.text, set.repositoryTests);
  C.capture(out, 'regenerate', [C.path.join(repo, 'scripts/build-treasury-compat-loader.cjs'), '--check'], { cwd: repo });
  for (const [name, entry, args] of [['typecheck-build', 'typescript/bin/tsc', ['-p', 'tsconfig.build.json', '--noEmit']], ['typecheck-test', 'typescript/bin/tsc', ['-p', 'tsconfig.json', '--noEmit']]]) C.capture(out, name, [C.path.join(repo, 'node_modules', entry), ...args], { cwd: repo });
  const j = C.capture(out, 'jest-budget', [C.path.join(repo, 'scripts/verify-jest-budget.mjs')], { cwd: repo }); C.check(j.stdout.text.includes('"suites":195,"tests":685'), 'JEST_BUDGET_MISMATCH');
  C.capture(out, 'build-only', [C.path.join(repo, 'node_modules/rollup/dist/bin/rollup'), '-c'], { cwd: repo }); w.checkSource(repo);
  const v = { status: 'LOADER_III_FULL_CHECKS_VERIFIED', packageFingerprint: w.fingerprint(), compatBase: w.policy.compatBase,
    repositoryNodeTests: set.repositoryTests, jestSuites: 195, jestTests: 685, buildOnly: true, deployed: false };
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
