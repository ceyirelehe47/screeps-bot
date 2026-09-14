'use strict';
/** Regenerates from the exact pre-V capsule; no network, transpilation or deploy.
 * V context adaptation, VII build optimization and IX attribution are composed
 * in order and each layer is exactly reversible. Semantic tests remain the
 * authority; reversibility supplies source provenance only. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const X = require('./lib/treasury-compat-context.cjs');
const B = require('./lib/treasury-compat-build.cjs');
const A = require('./lib/treasury-compat-attribution.cjs');
const ORIGINAL_SHA = '9e28d07181898930a84ff560c73f531935ca6a79c9d6e1e2adbd108555bd9965';
const ORIGINAL_BLOB = '7c20e7544bdc45bee11b1ee059ac5df2a12f2bf3';
const SOURCE_COMMIT = '01bd9831454950c4928df98dd8679692b55603e5';
const GENERATED = 'src/runtime/treasuryCompatReadCore.generated.ts';
const FIXTURE = 'test/treasury-compat/fixtures/core-before-read-optimization-v.ts.txt';
const TEMPLATE = 'scripts/lib/treasury-compat-loader.template.txt';
const PROVENANCE = 'docs/treasury-compat-loader-optimization.json';
const SOURCE_MANIFEST = 'docs/treasury-compat-source-manifest.json';
const MARKER = '/** Loader Optimization III.';
const BASELINE_COMMIT = 'ef23c464c83b90b413d43d07857f67d538f512a3';
const BUILD_VII_BLOB = '4f94acf1c06a60de9ca8ff2f0cdd2910cb6913be';
const FIXED_OUTPUTS = Object.freeze({
  'src/runtime/treasuryCompatRead.ts': { bytes: 21526, sha256: '1d5bd4d7f5922dfad3e6c44522d04695b490ba2bb711a83306858544dde70dec', gitBlob: '556c6d565b3962c407bc82a4b5706d5382935c53' },
  'src/runtime/treasuryCompatCpu.ts': { bytes: 6724, sha256: 'e7dead62745052c278163281a524d765ef109df9556060a283dac35590fa042c', gitBlob: '076cc6b1a02518b0ff0e4f503e09e74b8c47464e' },
  'src/runtime/treasuryCompatTypes.ts': { bytes: 2509, sha256: '0d39f976aad3d95daaa13b72f31cfe7f9a25a9611329faf152a1ded0c6b3e61b', gitBlob: '1f553df048f322a68b445a71d4b7f2b03d096e72' },
  'test/treasuryCompatRead.test.ts': { bytes: 1064, sha256: '5703123386542aabf4ab56307f6c433398478d6c2738adc4bf35ed87191a6026', gitBlob: 'c1b5e04c4ac41c881bfc426a3fbce759cc823722' },
});
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blob = b => crypto.createHash('sha1').update(Buffer.from('blob ' + b.length + '\0')).update(b).digest('hex');
const encode = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
const lf = b => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'));
function check(ok, code) { if (!ok) { const e = new Error(code); e.code = code; throw e; } }
function setOutput(manifest, file, value) {
  let row = manifest.outputs.find(x => x.file === file);
  if (!row) { row = { file }; manifest.outputs.push(row); }
  Object.assign(row, value);
}
function generate(original, template, manifest) {
  const b = lf(original);
  check(b.length === 64604 && sha(b) === ORIGINAL_SHA && blob(b) === ORIGINAL_BLOB, 'CORE_BASELINE_MISMATCH');
  const s = b.toString('utf8'), i = s.indexOf(MARKER);
  check(i > 0 && s.indexOf(MARKER, i + 1) < 0, 'LOADER_BOUNDARY_AMBIGUOUS');
  const originalPrefix = s.slice(0, i), contextPrefix = X.transform(originalPrefix), buildPrefix = B.transform(contextPrefix), prefix = A.transform(buildPrefix);
  const t = lf(template).toString('utf8');
  check(t.startsWith('/** Read Optimization V:') && t.endsWith('\n') &&
    t.includes('export function createCompatibilityReadCore(): CompatReadBuilders {'), 'LOADER_TEMPLATE_INVALID');
  const out = Buffer.from(prefix + t);
  const matches = [...originalPrefix.matchAll(/^"([^"]+)": function\(exports, require\) \{\n/gm)];
  check(matches.length === 8, 'FACTORY_SET_MISMATCH');
  const dependencyStart = originalPrefix.indexOf('const dependencies = {');
  const factoryEnd = originalPrefix.lastIndexOf('\n}\n};\n', dependencyStart);
  const factories = matches.map((m, k) => {
    const start = m.index + m[0].length;
    const end = k + 1 < matches.length ? matches[k + 1].index - 3 : factoryEnd + 1;
    return { path: m[1], originalBodySha256: sha(Buffer.from(originalPrefix.slice(start, end))),
      adaptation: m[1].endsWith('/commitments.ts') ? 'V-context+VII-buckets+IX-attribution' :
        m[1].endsWith('/observation.ts') ? 'VII-allocation+IX-attribution' : 'unchanged',
      lifecycle: m[1].endsWith('/commitmentRevision.ts') ? 'unreachable-retained-original-definition' : 'shared-definition' };
  });
  const m = JSON.parse(JSON.stringify(manifest));
  check(m.sourceCommit === SOURCE_COMMIT && m.sourceManifest.length === 8, 'SOURCE_MANIFEST_MISMATCH');
  check(sha(Buffer.from(JSON.stringify(m.sourceManifest))) === 'f9288bb50f8b5b7ccbd729717d902ee0e5a7a905ed9d99602b8171d94bacce8a', 'CANONICAL_SOURCE_IDENTITIES_CHANGED');
  setOutput(m, GENERATED, { bytes: out.length, sha256: sha(out), gitBlob: blob(out) });
  for (const [file, value] of Object.entries(FIXED_OUTPUTS)) setOutput(m, file, value);
  m.outputs.sort((a, b) => a.file.localeCompare(b.file));
  m.loaderOptimization = { revision: 'IX', provenance: PROVENANCE, canonicalSourceCommit: SOURCE_COMMIT,
    baselineGeneratedBlob: BUILD_VII_BLOB, canonicalInputGeneratedBlob: ORIGINAL_BLOB,
    explicitReadContextAdaptation: true, fullTaskBucketFusion: true, observationAllocationReduction: true,
    boundedSubphaseAttribution: true, attributionChangesAuthorization: false };
  const provenance = {
    revision: 'compat-subphase-attribution-IX', authoring: [TEMPLATE, 'scripts/lib/treasury-compat-context.cjs',
      'scripts/lib/treasury-compat-build.cjs', 'scripts/lib/treasury-compat-attribution.cjs'],
    baselineCommit: BASELINE_COMMIT, baselineBuildVIIBlob: BUILD_VII_BLOB,
    canonicalInputBlob: ORIGINAL_BLOB, canonicalInputSha256: ORIGINAL_SHA, canonicalInputCompiler: '5.9.3',
    originalFactoryPrefixSha256: sha(Buffer.from(originalPrefix)), contextOnlyPrefixSha256: sha(Buffer.from(contextPrefix)),
    buildVIIOnlyPrefixSha256: sha(Buffer.from(buildPrefix)), adaptedFactoryPrefixSha256: sha(Buffer.from(prefix)),
    reversibleContextTransform: true, contextRules: X.rules, reversibleBuildTransform: true, buildRules: B.rules,
    reversibleAttributionTransform: true, attributionRules: A.rules,
    loaderSha256: sha(Buffer.from(t)), generatedSha256: sha(out), generatedBlob: blob(out), factories,
    factoryBodiesChanged: ['src/runtime/treasury/commitments.ts', 'src/runtime/treasury/observation.ts'],
    diagnosticRegions: ['observationSetup','observationRooms','observationFinalize','observationView',
      'commitmentSetup','commitmentTasks','commitmentReservations','commitmentFinalize','projectionRows'],
    perRecordCpuSamples: false, primitiveWorkCountersOnly: true, diagnosticOverheadSubtracted: false,
    topLevelCpuBudgetAuthorityChanged: false, businessValidationChanged: false, querySemanticsChanged: false,
    fullIndexBuiltEagerly: true, lazySecondaryIndexes: false, previewSourceChanged: true,
    cpuAccountingChanged: true, publicTypeSurfaceChanged: true, defaultEnabled: false, budget: 2,
    engineCpuGapRepaired: false, engineMeasurementRequired: true,
    note: 'IX adds coarse nested timing boundaries and bounded primitive work counters to the read-only compatibility capsule. The boundaries overlap existing parent phases, do not authorize work, and do not sample once per record or key. Canonical host sources remain pinned.'
  };
  return { [GENERATED]: out, [PROVENANCE]: encode(provenance), [SOURCE_MANIFEST]: encode(m) };
}
function main(argv) {
  check(argv.length === 1 && ['--check', '--write'].includes(argv[0]), 'ARGUMENT_INVALID');
  const root = path.resolve(__dirname, '..');
  const result = generate(fs.readFileSync(path.join(root, FIXTURE)), fs.readFileSync(path.join(root, TEMPLATE)),
    JSON.parse(fs.readFileSync(path.join(root, SOURCE_MANIFEST), 'utf8')));
  for (const [file, expected] of Object.entries(FIXED_OUTPUTS)) {
    const b = lf(fs.readFileSync(path.join(root, file)));
    check(b.length === expected.bytes && sha(b) === expected.sha256 && blob(b) === expected.gitBlob, 'FIXED_SOURCE_MISMATCH:' + file);
  }
  for (const [name, b] of Object.entries(result)) {
    if (argv[0] === '--write') fs.writeFileSync(path.join(root, name), b);
    else check(lf(fs.readFileSync(path.join(root, name))).equals(b), 'GENERATED_OUTPUT_MISMATCH:' + name);
  }
  return { status: argv[0] === '--check' ? 'COMPAT_LOADER_REGENERATION_VERIFIED' : 'COMPAT_LOADER_REGENERATED',
    files: Object.keys(result), canonicalFactoryBodyRecovery: 'exact', explicitContextAdaptation: true,
    fullTaskBucketFusion: true, observationAllocationReduction: true, boundedSubphaseAttribution: true };
}
module.exports = { generate, main, sha, blob, GENERATED, FIXTURE, TEMPLATE, PROVENANCE, SOURCE_MANIFEST, MARKER,
  X, B, A, FIXED_OUTPUTS, BASELINE_COMMIT, BUILD_VII_BLOB };
if (require.main === module) try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
catch (e) { console.error(JSON.stringify({ status: 'STOP', code: e.code || 'GENERATOR_FAILED' })); process.exitCode = 1; }
