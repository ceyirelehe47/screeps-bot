'use strict';
/** Regenerates from the exact pre-V capsule; no network, transpilation or deploy.
 * The only body adaptation is reversible lexical-context threading in the
 * commitments factory. All other compiler bodies stay byte-identical. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const X = require('./lib/treasury-compat-context.cjs');
const ORIGINAL_SHA = '9e28d07181898930a84ff560c73f531935ca6a79c9d6e1e2adbd108555bd9965';
const ORIGINAL_BLOB = '7c20e7544bdc45bee11b1ee059ac5df2a12f2bf3';
const SOURCE_COMMIT = '01bd9831454950c4928df98dd8679692b55603e5';
const GENERATED = 'src/runtime/treasuryCompatReadCore.generated.ts';
const FIXTURE = 'test/treasury-compat/fixtures/core-before-read-optimization-v.ts.txt';
const TEMPLATE = 'scripts/lib/treasury-compat-loader.template.txt';
const PROVENANCE = 'docs/treasury-compat-loader-optimization.json';
const SOURCE_MANIFEST = 'docs/treasury-compat-source-manifest.json';
const MARKER = '/** Loader Optimization III.';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blob = b => crypto.createHash('sha1').update(Buffer.from('blob ' + b.length + '\0')).update(b).digest('hex');
const encode = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
const lf = b => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'));
function check(ok, code) { if (!ok) { const e = new Error(code); e.code = code; throw e; } }
function generate(original, template, manifest) {
  const b = lf(original);
  check(b.length === 64604 && sha(b) === ORIGINAL_SHA && blob(b) === ORIGINAL_BLOB, 'CORE_BASELINE_MISMATCH');
  const s = b.toString('utf8'), i = s.indexOf(MARKER);
  check(i > 0 && s.indexOf(MARKER, i + 1) < 0, 'LOADER_BOUNDARY_AMBIGUOUS');
  const originalPrefix = s.slice(0, i), prefix = X.transform(originalPrefix);
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
      adaptation: m[1].endsWith('/commitments.ts') ? 'explicit-context-parameters-only' : 'unchanged',
      lifecycle: m[1].endsWith('/commitmentRevision.ts') ? 'unreachable-retained-original-definition' : 'shared-definition' };
  });
  const m = JSON.parse(JSON.stringify(manifest));
  check(m.sourceCommit === SOURCE_COMMIT && m.sourceManifest.length === 8, 'SOURCE_MANIFEST_MISMATCH');
  check(sha(Buffer.from(JSON.stringify(m.sourceManifest))) === 'f9288bb50f8b5b7ccbd729717d902ee0e5a7a905ed9d99602b8171d94bacce8a', 'CANONICAL_SOURCE_IDENTITIES_CHANGED');
  const outputs = m.outputs.filter(x => x.file === GENERATED);
  check(outputs.length === 1, 'GENERATED_MANIFEST_ENTRY_MISSING');
  Object.assign(outputs[0], { bytes: out.length, sha256: sha(out), gitBlob: blob(out) });
  const preview = m.outputs.filter(x => x.file === 'src/runtime/treasuryCompatRead.ts');
  check(preview.length === 1, 'PREVIEW_MANIFEST_ENTRY_MISSING');
  Object.assign(preview[0], {"bytes": 20118, "sha256": "1141250ec31c12b3439f48b6274267c108c7bb95566d328414f4bd04275bef64", "gitBlob": "58f1ca27d217fdd7af3e50bcec5de45bf3ee14ac"});
  m.loaderOptimization = { revision: 'V', provenance: PROVENANCE, canonicalSourceCommit: SOURCE_COMMIT,
    baselineGeneratedBlob: ORIGINAL_BLOB, explicitReadContextAdaptation: true };
  const provenance = {
    revision: 'compat-read-optimization-V', authoring: [TEMPLATE, 'scripts/lib/treasury-compat-context.cjs'],
    baselineCommit: 'af7cfb7507d42bb12a32b8ea9d85dadd87d97fae', baselineBlob: ORIGINAL_BLOB, baselineSha256: ORIGINAL_SHA,
    baselineCompiler: '5.9.3', originalFactoryPrefixSha256: sha(Buffer.from(originalPrefix)),
    adaptedFactoryPrefixSha256: sha(Buffer.from(prefix)), reversibleContextTransform: true, contextRules: X.rules,
    loaderSha256: sha(Buffer.from(t)), generatedSha256: sha(out), generatedBlob: blob(out), factories,
    factoryBodiesChanged: ['src/runtime/treasury/commitments.ts'],
    dependencyEdgesRemoved: ['commitments -> commitmentRevision'],
    aggregationValidationQueryAlgorithmsChanged: false, revisionSemantics: 'private read-only capsule revision zero per builder; NOT the host revision',
    firstSuccessfulFactoryExecutions: 7, followingFactoryExecutions: 0,
    resourceCatalogCapturedPerBuilder: true, contextGlobalsUsed: false,
    definitionInitializationsMovedOutsideBudget: false, builderInstanceReused: false, observationReused: false, commitmentIndexReused: false,
    engineCpuGapRepaired: false, engineMeasurementRequired: true,
    note: 'The canonical source bodies are not edited; generated commitments code threads explicit private context. All aggregation, owner, expiry and completeness operations are retained. The preview output entry is also refreshed; original assembly provenance for other outputs is unchanged.'
  };
  return { [GENERATED]: out, [PROVENANCE]: encode(provenance), [SOURCE_MANIFEST]: encode(m) };
}
function main(argv) {
  check(argv.length === 1 && ['--check', '--write'].includes(argv[0]), 'ARGUMENT_INVALID');
  const root = path.resolve(__dirname, '..');
  const result = generate(fs.readFileSync(path.join(root, FIXTURE)), fs.readFileSync(path.join(root, TEMPLATE)),
    JSON.parse(fs.readFileSync(path.join(root, SOURCE_MANIFEST), 'utf8')));
  check(sha(lf(fs.readFileSync(path.join(root, 'src/runtime/treasuryCompatRead.ts')))) === '1141250ec31c12b3439f48b6274267c108c7bb95566d328414f4bd04275bef64', 'PREVIEW_SOURCE_MISMATCH');
  for (const [name, b] of Object.entries(result)) {
    if (argv[0] === '--write') fs.writeFileSync(path.join(root, name), b);
    else check(lf(fs.readFileSync(path.join(root, name))).equals(b), 'GENERATED_OUTPUT_MISMATCH:' + name);
  }
  return { status: argv[0] === '--check' ? 'COMPAT_LOADER_REGENERATION_VERIFIED' : 'COMPAT_LOADER_REGENERATED',
    files: Object.keys(result), canonicalFactoryBodyRecovery: 'exact', explicitContextAdaptation: true };
}
module.exports = { generate, main, sha, blob, GENERATED, FIXTURE, TEMPLATE, PROVENANCE, SOURCE_MANIFEST, MARKER, X };
if (require.main === module) try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
catch (e) { console.error(JSON.stringify({ status: 'STOP', code: e.code || 'GENERATOR_FAILED' })); process.exitCode = 1; }
