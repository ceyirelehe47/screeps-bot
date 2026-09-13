'use strict';
/** Deterministic wrapper regeneration: no source transpilation, network or deploy.
 * The pinned input includes the original compiler output. Every factory byte and
 * dependency edge is preserved; only the loader suffix is replaced. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ORIGINAL_SHA = 'decc6a2e019ba931041c8d79d341a59658755473b06075a19a458cc6635bd400';
const ORIGINAL_BLOB = 'c44d8a306f2b11986c6556e098be7d2e10315fa6';
const SOURCE_COMMIT = '01bd9831454950c4928df98dd8679692b55603e5';
const GENERATED = 'src/runtime/treasuryCompatReadCore.generated.ts';
const FIXTURE = 'test/treasury-compat/fixtures/core-before-loader-optimization.ts.txt';
const TEMPLATE = 'scripts/lib/treasury-compat-loader.template.txt';
const PROVENANCE = 'docs/treasury-compat-loader-optimization.json';
const SOURCE_MANIFEST = 'docs/treasury-compat-source-manifest.json';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blob = b => crypto.createHash('sha1').update(Buffer.from('blob ' + b.length + '\0')).update(b).digest('hex');
const encode = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
function check(ok, code) { if (!ok) { const e = new Error(code); e.code = code; throw e; } }
function generate(original, template, manifest) {
  // Accept Git checkout CRLF only as a text encoding; hashes bind the LF artifact.
  const b = Buffer.from(original.toString('utf8').replace(/\r\n/g, '\n'));
  check(b.length === 62929 && sha(b) === ORIGINAL_SHA && blob(b) === ORIGINAL_BLOB, 'CORE_BASELINE_MISMATCH');
  const s = b.toString('utf8');
  const marker = 'export function createCompatibilityReadCore(): CompatReadBuilders {';
  const i = s.indexOf(marker);
  check(i > 0 && s.indexOf(marker, i + 1) < 0, 'LOADER_BOUNDARY_AMBIGUOUS');
  const prefix = s.slice(0, i);
  const t = template.toString('utf8').replace(/\r\n/g, '\n');
  check(t.includes(marker) && t.endsWith('\n'), 'LOADER_TEMPLATE_INVALID');
  const out = Buffer.from(prefix + t);
  const matches = [...prefix.matchAll(/^"([^"]+)": function\(exports, require\) \{\n/gm)];
  check(matches.length === 8, 'FACTORY_SET_MISMATCH');
  const dependencyStart = prefix.indexOf('const dependencies = {');
  const factoryEnd = prefix.lastIndexOf('\n}\n};\n', dependencyStart);
  check(dependencyStart > 0 && factoryEnd > 0, 'FACTORY_BOUNDARY_INVALID');
  const factories = matches.map((m, k) => {
    const start = m.index + m[0].length;
    const end = k + 1 < matches.length ? matches[k + 1].index - 3 : factoryEnd + 1;
    return { path: m[1], bodySha256: sha(Buffer.from(prefix.slice(start, end))),
      lifecycle: /\/(commitments|commitmentRevision)\.ts$/.test(m[1]) ? 'per-sample' : 'definition-only-reused' };
  });
  const m = JSON.parse(JSON.stringify(manifest));
  check(m.sourceCommit === SOURCE_COMMIT && m.sourceManifest.length === 8, 'SOURCE_MANIFEST_MISMATCH');
  check(sha(Buffer.from(JSON.stringify(m.sourceManifest))) === 'f9288bb50f8b5b7ccbd729717d902ee0e5a7a905ed9d99602b8171d94bacce8a', 'CANONICAL_SOURCE_IDENTITIES_CHANGED');
  check(JSON.stringify(m.sourceManifest.map(x => x.path).sort()) === JSON.stringify(factories.map(x => x.path).sort()), 'SOURCE_MODULE_SET_MISMATCH');
  const outputs = m.outputs.filter(x => x.file === GENERATED);
  check(outputs.length === 1, 'GENERATED_MANIFEST_ENTRY_MISSING');
  Object.assign(outputs[0], { bytes: out.length, sha256: sha(out), gitBlob: blob(out) });
  m.loaderOptimization = { revision: 'III', provenance: PROVENANCE,
    bodySourceCommitUnchanged: SOURCE_COMMIT, baselineGeneratedBlob: ORIGINAL_BLOB };
  const provenance = {
    revision: 'compat-reader-loader-optimization-III', authoring: TEMPLATE,
    baselineCommit: '745231048d97fd43fa7613abe988ae324bea10f8',
    baselineBlob: ORIGINAL_BLOB, baselineSha256: ORIGINAL_SHA,
    baselineCompiler: '5.9.3', factoryPrefixSha256: sha(Buffer.from(prefix)),
    loaderSha256: sha(Buffer.from(t)), generatedSha256: sha(out), generatedBlob: blob(out),
    factories, factoryBodiesChanged: false, dependencyEdgesChanged: false,
    firstSuccessfulFactoryExecutions: 8, followingFactoryExecutions: 2,
    definitionInitializationsMovedOutsideBudget: false,
    builderInstanceReused: false, observationReused: false, commitmentIndexReused: false,
    resourceCatalogCapturedPerSample: true,
    engineCpuGapRepaired: false, engineMeasurementRequired: true,
    note: 'Only the wrapper output entry is refreshed here; other outputs retain original assembly provenance.'
  };
  return { [GENERATED]: out, [PROVENANCE]: encode(provenance), [SOURCE_MANIFEST]: encode(m) };
}
function main(argv) {
  check(argv.length === 1 && ['--check', '--write'].includes(argv[0]), 'ARGUMENT_INVALID');
  const root = path.resolve(__dirname, '..');
  const result = generate(fs.readFileSync(path.join(root, FIXTURE)), fs.readFileSync(path.join(root, TEMPLATE)),
    JSON.parse(fs.readFileSync(path.join(root, SOURCE_MANIFEST), 'utf8')));
  for (const [name, b] of Object.entries(result)) {
    if (argv[0] === '--write') fs.writeFileSync(path.join(root, name), b);
    else check(fs.readFileSync(path.join(root, name)).toString('utf8').replace(/\r\n/g, '\n') === b.toString('utf8'), 'GENERATED_OUTPUT_MISMATCH:' + name);
  }
  return { status: argv[0] === '--check' ? 'COMPAT_LOADER_REGENERATION_VERIFIED' : 'COMPAT_LOADER_REGENERATED', files: Object.keys(result), factoryBodiesChanged: false };
}
module.exports = { generate, main, sha, blob, GENERATED, FIXTURE, TEMPLATE, PROVENANCE, SOURCE_MANIFEST };
if (require.main === module) try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
catch (e) { console.error(JSON.stringify({ status: 'STOP', code: e.code || 'GENERATOR_FAILED' })); process.exitCode = 1; }
