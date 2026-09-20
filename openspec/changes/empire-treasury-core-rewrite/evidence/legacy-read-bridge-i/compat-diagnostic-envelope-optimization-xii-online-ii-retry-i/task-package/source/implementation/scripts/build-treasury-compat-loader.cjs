'use strict';
/** Regenerates from the exact pre-V capsule; no network, transpilation or deploy.
 * V context adaptation, VII build optimization, IX attribution, XI hot-path and
 * XII diagnostic-envelope transforms are composed in order and exactly reversible.
 * Semantic tests remain authoritative; reversibility supplies provenance only. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const X = require('./lib/treasury-compat-context.cjs');
const B = require('./lib/treasury-compat-build.cjs');
const A = require('./lib/treasury-compat-attribution.cjs');
const H = require('./lib/treasury-compat-hotpath.cjs');
const P_XI = require('./lib/treasury-compat-preview-hotpath.cjs');
const D = require('./lib/treasury-compat-envelope.cjs');
/** Public current-preview transform. Historical hotpath tests import G.P and
 * therefore it must map the pinned IX preview directly to the current XII
 * preview, while P_XI remains available for intermediate provenance checks. */
const P = Object.freeze({
  transform(text) { return D.transform(P_XI.transform(text)); },
  restore(text) { return P_XI.restore(D.restore(text)); },
  rules: Object.freeze([
    ...P_XI.rules.map(x => Object.freeze({ ...x, stage: 'XI-hotpath' })),
    ...D.rules.map(x => Object.freeze({ ...x, stage: 'XII-envelope' })),
  ]),
});
const ORIGINAL_SHA = '9e28d07181898930a84ff560c73f531935ca6a79c9d6e1e2adbd108555bd9965';
const ORIGINAL_BLOB = '7c20e7544bdc45bee11b1ee059ac5df2a12f2bf3';
const SOURCE_COMMIT = '01bd9831454950c4928df98dd8679692b55603e5';
const GENERATED = 'src/runtime/treasuryCompatReadCore.generated.ts';
const PREVIEW = 'src/runtime/treasuryCompatRead.ts';
const FIXTURE = 'test/treasury-compat/fixtures/core-before-read-optimization-v.ts.txt';
const PREVIEW_FIXTURE = 'test/treasury-compat/fixtures/reader-before-hotpath-optimization-xi.ts.txt';
const XI_PREVIEW_FIXTURE = 'test/treasury-compat/fixtures/reader-before-envelope-optimization-xii.ts.txt';
const CPU_XI_FIXTURE = 'test/treasury-compat/fixtures/cpu-before-envelope-optimization-xii.ts.txt';
const TEMPLATE = 'scripts/lib/treasury-compat-loader.template.txt';
const PROVENANCE = 'docs/treasury-compat-loader-optimization.json';
const SOURCE_MANIFEST = 'docs/treasury-compat-source-manifest.json';
const MARKER = '/** Loader Optimization III.';
const BASELINE_COMMIT = '91b9a99226a7a135a0e75b8a1d0db255eefe2200';
const BUILD_VII_BLOB = '4f94acf1c06a60de9ca8ff2f0cdd2910cb6913be';
const IX_CORE_BLOB = '62752b09e3828e67a9000aeffcda0b2436368bf1';
const IX_PREVIEW_BLOB = '556c6d565b3962c407bc82a4b5706d5382935c53';
const IX_PREVIEW_SHA = '1d5bd4d7f5922dfad3e6c44522d04695b490ba2bb711a83306858544dde70dec';
const XI_PREVIEW_BLOB = 'fe92498f5e76d860e4fef98d842df3c2e8fc48ad';
const XI_PREVIEW_SHA = '9e454bde732a08ba1880cae02ada391219054c70cb54aff600d7a8bde667bd2f';
const XII_PREVIEW_BLOB = 'c3297bce75ad644d60555fe3a578b09e49f41bec';
const XII_PREVIEW_SHA = '9bc900e4d99c12d4cb8573be50db56c8a427927b3c1c5d905c0f0d6e39a6c1ff';
const FIXED_OUTPUTS = Object.freeze({
  'docs/treasury-legacy-read-bridge.md': { bytes: 4854, sha256: '23352cd61c5725021d5aed3798b714d702f766d41781d1beffd07e87773e4877', gitBlob: 'fa47f2b26745cdf45fca2e228726777a9918e8a6' },
  'src/main.test.ts': { bytes: 11031, sha256: '8fbb186cae2a1426496dd539cbc4414ce2317fc4ff848a4bc4ee179ec2d4a0ab', gitBlob: '9b8b42363e8f687742088dfca094a422d6ecf3b0' },
  'src/main.ts': { bytes: 6271, sha256: '3bebfb632d40dd989baa9ae70a87cc49810207df6fc0cfd3f9cda53673f9dc57', gitBlob: 'e8bf1c56e6147dfe4fcbb18052e29ee636da62ac' },
  'src/runtime/treasuryCompatConfig.ts': { bytes: 531, sha256: 'ff291683faf1a2a3711f231b9affe7d1cd759416c3482dc77563cfd9a628ab02', gitBlob: '8e2214fef5a6a69b7eb40c82eee76dda1646ccbf' },
  'src/runtime/treasuryCompatCpu.ts': { bytes: 7697, sha256: 'c2dd2a61294e799f6aac4739b19ce6fc3d0cea00958a10bfaeef453dd4e022bc', gitBlob: 'c66f1a975778a2b4e5ae951f93c581f43ef598e0' },
  'src/runtime/treasuryCompatRuntime.ts': { bytes: 865, sha256: '9f8736eb9a0a45ba3a6390cada1d9790945e5609252da81d62d258b9f76254f4', gitBlob: '5916fbcafbb88d40cf5463d329b683ba0d776ad8' },
  'src/runtime/treasuryCompatTypes.ts': { bytes: 2509, sha256: '0d39f976aad3d95daaa13b72f31cfe7f9a25a9611329faf152a1ded0c6b3e61b', gitBlob: '1f553df048f322a68b445a71d4b7f2b03d096e72' },
  'test/treasury-compat/bridge.spec.cjs': { bytes: 11489, sha256: '278491b3c996874db2fe560973708ba1d2a0d34cfc94f413ad36f23a3067a50f', gitBlob: '8061a074218ba8a9ce81ec15b5da6e4ad9aa1d83' },
  'test/treasury-compat/helpers.cjs': { bytes: 6806, sha256: 'c200b1f2b6dc55deae8b50ac7ae9f0e5ecb191be6592a42c713fce7d3d289e74', gitBlob: 'f7406cf25124324069c08a444683d383477e0a23' },
  'test/treasury-compat/real-readers.spec.cjs': { bytes: 8178, sha256: '162630b8712f90fa71bb11eba25d3128dd92408b1474ea8540a2adb02a2f20c2', gitBlob: '28c78e89a8039518fe9d8d3e4d8027aff0015e8c' },
  'test/treasuryCompatRead.test.ts': { bytes: 1139, sha256: '7e0190e8ca5f7910cca57133e0f044a57868f4c6d768c9c0958a8b167ba6d9d7', gitBlob: '551a1a3557cdde27f02096487b2e338757038b4f' },
});
const EXPECTED_OUTPUT_PATHS = Object.freeze([...Object.keys(FIXED_OUTPUTS), GENERATED, PREVIEW].sort());
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
function generate(original, template, manifest, previewOriginal) {
  const b = lf(original);
  check(b.length === 64604 && sha(b) === ORIGINAL_SHA && blob(b) === ORIGINAL_BLOB, 'CORE_BASELINE_MISMATCH');
  const s = b.toString('utf8'), i = s.indexOf(MARKER);
  check(i > 0 && s.indexOf(MARKER, i + 1) < 0, 'LOADER_BOUNDARY_AMBIGUOUS');
  const originalPrefix = s.slice(0, i), contextPrefix = X.transform(originalPrefix), buildPrefix = B.transform(contextPrefix),
    attributionPrefix = A.transform(buildPrefix), prefix = H.transform(attributionPrefix);
  const t = lf(template).toString('utf8');
  check(t.startsWith('/** Read Optimization V:') && t.endsWith('\n') &&
    t.includes('export function createCompatibilityReadCore(): CompatReadBuilders {'), 'LOADER_TEMPLATE_INVALID');
  const out = Buffer.from(prefix + t);
  const previewBase = lf(previewOriginal);
  check(previewBase.length === 21526 && sha(previewBase) === IX_PREVIEW_SHA && blob(previewBase) === IX_PREVIEW_BLOB, 'PREVIEW_BASELINE_MISMATCH');
  const previewXI = Buffer.from(P_XI.transform(previewBase.toString('utf8')));
  check(previewXI.length === 21631 && sha(previewXI) === XI_PREVIEW_SHA && blob(previewXI) === XI_PREVIEW_BLOB, 'XI_PREVIEW_MISMATCH');
  const previewOut = Buffer.from(P.transform(previewBase.toString('utf8')));
  check(previewOut.equals(Buffer.from(D.transform(previewXI.toString('utf8')))), 'CURRENT_PREVIEW_COMPOSITION_MISMATCH');
  check(previewOut.length === 22660 && sha(previewOut) === XII_PREVIEW_SHA && blob(previewOut) === XII_PREVIEW_BLOB, 'XII_PREVIEW_MISMATCH');
  const matches = [...originalPrefix.matchAll(/^"([^"]+)": function\(exports, require\) \{\n/gm)];
  check(matches.length === 8, 'FACTORY_SET_MISMATCH');
  const dependencyStart = originalPrefix.indexOf('const dependencies = {');
  const factoryEnd = originalPrefix.lastIndexOf('\n}\n};\n', dependencyStart);
  const factories = matches.map((m, k) => {
    const start = m.index + m[0].length;
    const end = k + 1 < matches.length ? matches[k + 1].index - 3 : factoryEnd + 1;
    return { path: m[1], originalBodySha256: sha(Buffer.from(originalPrefix.slice(start, end))),
      adaptation: m[1].endsWith('/commitments.ts') ? 'V-context+VII-buckets+IX-attribution+XI-hotpath' :
        m[1].endsWith('/observation.ts') ? 'VII-allocation+IX-attribution+XI-hotpath' : 'unchanged',
      lifecycle: m[1].endsWith('/commitmentRevision.ts') ? 'unreachable-retained-original-definition' : 'shared-definition' };
  });
  const m = JSON.parse(JSON.stringify(manifest));
  check(m.sourceCommit === SOURCE_COMMIT && m.sourceManifest.length === 8, 'SOURCE_MANIFEST_MISMATCH');
  check(sha(Buffer.from(JSON.stringify(m.sourceManifest))) === 'f9288bb50f8b5b7ccbd729717d902ee0e5a7a905ed9d99602b8171d94bacce8a', 'CANONICAL_SOURCE_IDENTITIES_CHANGED');
  const outputPaths = m.outputs.map(x => x.file);
  check(new Set(outputPaths).size === outputPaths.length && JSON.stringify([...outputPaths].sort()) === JSON.stringify(EXPECTED_OUTPUT_PATHS), 'SOURCE_MANIFEST_OUTPUT_SET_MISMATCH');
  setOutput(m, GENERATED, { bytes: out.length, sha256: sha(out), gitBlob: blob(out) });
  setOutput(m, PREVIEW, { bytes: previewOut.length, sha256: sha(previewOut), gitBlob: blob(previewOut) });
  for (const [file, value] of Object.entries(FIXED_OUTPUTS)) setOutput(m, file, value);
  m.outputs.sort((a, b) => a.file.localeCompare(b.file));
  m.loaderOptimization = { revision: 'XII', provenance: PROVENANCE, canonicalSourceCommit: SOURCE_COMMIT,
    baselineGeneratedBlob: IX_CORE_BLOB, canonicalInputGeneratedBlob: ORIGINAL_BLOB,
    explicitReadContextAdaptation: true, fullTaskBucketFusion: true, observationAllocationReduction: true,
    boundedSubphaseAttribution: true, attributionChangesAuthorization: false,
    sparseKeyEnumerationReuse: true, observationLookupBuiltInRoomPass: true,
    singleAuthorityTableEnumeration: true, canonicalDemandHelperFastPath: true,
    previewSelectedTotalSinglePass: true, previewResourceCatalogSingleRead: true,
    diagnosticCompletionTailOnly: true, sampleRootCursorReuse: true,
    legacyProjectionFieldObjectRemoved: true, boundedRoomMembershipNoSet: true,
    singlePassDeltaObject: true, projectionArrayValidationRemoved: true,
    sourceManifestOutputValidation: 'all-listed-outputs', sourceManifestOutputIdentityCount: EXPECTED_OUTPUT_PATHS.length };
  const provenance = {
    revision: 'compat-diagnostic-envelope-optimization-XII',
    authoring: [TEMPLATE, 'scripts/lib/treasury-compat-context.cjs', 'scripts/lib/treasury-compat-build.cjs',
      'scripts/lib/treasury-compat-attribution.cjs', 'scripts/lib/treasury-compat-hotpath.cjs',
      'scripts/lib/treasury-compat-preview-hotpath.cjs', 'scripts/lib/treasury-compat-envelope.cjs'],
    baselineCommit: BASELINE_COMMIT, baselineBuildVIIBlob: BUILD_VII_BLOB,
    baselineIXCoreBlob: IX_CORE_BLOB, baselineIXPreviewBlob: IX_PREVIEW_BLOB,
    baselineXIPreviewBlob: XI_PREVIEW_BLOB,
    canonicalInputBlob: ORIGINAL_BLOB, canonicalInputSha256: ORIGINAL_SHA, canonicalInputCompiler: '5.9.3',
    originalFactoryPrefixSha256: sha(Buffer.from(originalPrefix)), contextOnlyPrefixSha256: sha(Buffer.from(contextPrefix)),
    buildVIIOnlyPrefixSha256: sha(Buffer.from(buildPrefix)), attributionOnlyPrefixSha256: sha(Buffer.from(attributionPrefix)),
    adaptedFactoryPrefixSha256: sha(Buffer.from(prefix)),
    reversibleContextTransform: true, contextRules: X.rules,
    reversibleBuildTransform: true, buildRules: B.rules,
    reversibleAttributionTransform: true, attributionRules: A.rules,
    reversibleHotpathTransform: true, hotpathRules: H.rules,
    reversiblePreviewHotpathTransform: true, previewHotpathRules: P_XI.rules,
    reversiblePreviewEnvelopeTransform: true, previewEnvelopeRules: D.rules,
    reversibleCurrentPreviewTransform: true, currentPreviewRules: P.rules,
    loaderSha256: sha(Buffer.from(t)), generatedSha256: sha(out), generatedBlob: blob(out),
    previewXISha256: sha(previewXI), previewXIBlob: blob(previewXI),
    previewSha256: sha(previewOut), previewBlob: blob(previewOut), factories,
    factoryBodiesChanged: ['src/runtime/treasury/commitments.ts', 'src/runtime/treasury/observation.ts'],
    diagnosticRegions: ['observationSetup','observationRooms','observationFinalize','observationView',
      'commitmentSetup','commitmentTasks','commitmentReservations','commitmentFinalize','projectionRows'],
    perRecordCpuSamples: false, primitiveWorkCountersOnly: true, diagnosticOverheadSubtracted: false,
    topLevelCpuBudgetAuthorityChanged: false, businessValidationChanged: false, querySemanticsChanged: false,
    fullIndexBuiltEagerly: true, lazySecondaryIndexes: false, previewSourceChanged: true,
    diagnosticCompletionTailOnly: true, sampleRootCursorReuse: true,
    legacyProjectionFieldObjectRemoved: true, boundedRoomMembershipNoSet: true,
    singlePassDeltaObject: true, projectionArrayValidationRemoved: true,
    cpuAccountingChanged: true, publicTypeSurfaceChanged: true, defaultEnabled: false, budget: 2,
    sourceManifestOutputValidation: 'all-listed-outputs', sourceManifestOutputIdentityCount: EXPECTED_OUTPUT_PATHS.length,
    engineCpuGapRepaired: false, engineMeasurementRequired: true,
    note: 'XII compacts successor-carried completion profiles to measured tail phases and removes bounded preview bookkeeping allocations while preserving independent Store reads, full validation, eager indexes, four projection rows and default OFF.'
  };
  return { [GENERATED]: out, [PREVIEW]: previewOut, [PROVENANCE]: encode(provenance), [SOURCE_MANIFEST]: encode(m) };
}
function verifyOutputIdentities(root, expected = FIXED_OUTPUTS) {
  for (const [file, identity] of Object.entries(expected)) {
    const b = lf(fs.readFileSync(path.join(root, file)));
    check(b.length === identity.bytes && sha(b) === identity.sha256 && blob(b) === identity.gitBlob, 'FIXED_SOURCE_MISMATCH:' + file);
  }
  return Object.keys(expected).length;
}
function applyOrCheckGenerated(root, result, mode) {
  for (const [name, b] of Object.entries(result)) {
    if (mode === '--write') fs.writeFileSync(path.join(root, name), b);
    else check(lf(fs.readFileSync(path.join(root, name))).equals(b), 'GENERATED_OUTPUT_MISMATCH:' + name);
  }
}
function verifyRoot(root, mode) {
  check(['--check', '--write'].includes(mode), 'ARGUMENT_INVALID');
  const result = generate(fs.readFileSync(path.join(root, FIXTURE)), fs.readFileSync(path.join(root, TEMPLATE)),
    JSON.parse(fs.readFileSync(path.join(root, SOURCE_MANIFEST), 'utf8')), fs.readFileSync(path.join(root, PREVIEW_FIXTURE)));
  verifyOutputIdentities(root);
  applyOrCheckGenerated(root, result, mode);
  return { status: mode === '--check' ? 'COMPAT_LOADER_REGENERATION_VERIFIED' : 'COMPAT_LOADER_REGENERATED',
    files: Object.keys(result), canonicalFactoryBodyRecovery: 'exact', explicitContextAdaptation: true,
    fullTaskBucketFusion: true, observationAllocationReduction: true, boundedSubphaseAttribution: true,
    hotpathOptimizationXI: true, diagnosticEnvelopeOptimizationXII: true,
    sourceManifestOutputValidation: 'all-listed-outputs', sourceManifestOutputIdentityCount: EXPECTED_OUTPUT_PATHS.length };
}
function main(argv) {
  check(argv.length === 1, 'ARGUMENT_INVALID');
  return verifyRoot(path.resolve(__dirname, '..'), argv[0]);
}
module.exports = { generate, main, sha, blob, GENERATED, FIXTURE, TEMPLATE, PROVENANCE, SOURCE_MANIFEST, MARKER,
  X, B, A, H, P_XI, P, D, FIXED_OUTPUTS, EXPECTED_OUTPUT_PATHS, verifyOutputIdentities, applyOrCheckGenerated, verifyRoot,
  BASELINE_COMMIT, BUILD_VII_BLOB, IX_CORE_BLOB, IX_PREVIEW_BLOB, XI_PREVIEW_BLOB,
  PREVIEW, PREVIEW_FIXTURE, XI_PREVIEW_FIXTURE, CPU_XI_FIXTURE };
if (require.main === module) try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
catch (e) { console.error(JSON.stringify({ status: 'STOP', code: e.code || 'GENERATOR_FAILED' })); process.exitCode = 1; }
