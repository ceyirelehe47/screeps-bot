#!/usr/bin/env node
'use strict';
// A four-module fixed-graph probe build. No changes to the original Rollup builder
// or its three outputs. Runtime require cannot reach Node, main or singleShot.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { LAB, emit } = require('./ts-module.cjs');
const hash = data => createHash('sha256').update(data).digest('hex');
const FILES = ['labConfig.ts', 'controlRecord.ts', 'worldRead.ts', 'tools/controlProbe.ts'];
function buildProbe() {
  const factories = FILES.map(file => `${JSON.stringify(file.slice(0, -3))}: function(exports,module,require){\n${emit(file)}\n}`).join(',\n');
  const code = `/* Read-only control probe; PREPARED_NOT_RUN. */\n'use strict';\n(function(){\nconst factories={${factories}};\nconst cache=Object.create(null);\nfunction load(id){\n if(!Object.prototype.hasOwnProperty.call(factories,id)) throw new Error('unregistered probe module: '+id);\n if(cache[id]) return cache[id].exports;\n const m={exports:{}}; cache[id]=m;\n factories[id](m.exports,m,function(name){\n  const target=name.startsWith('../') ? name.slice(3) : name.startsWith('./') ? name.slice(2) : '';\n  if(!['labConfig','controlRecord','worldRead'].includes(target)) throw new Error('probe dependency refused');\n  return load(target);\n });\n return m.exports;\n}\nexports.loop=load('tools/controlProbe').loop;\n})();\n`;
  return { code, sources: Object.fromEntries(FILES.map(file => [file, hash(fs.readFileSync(path.join(LAB, file)))])) };
}
function writeProbe(out) {
  // mkdir non-recursive with wx files: no overwrite, no symlink output target.
  const dir = path.resolve(out), parent = fs.realpathSync(path.dirname(dir));
  const repo = path.resolve(LAB, '../../..');
  const relative = path.relative(repo, parent);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('probe output must be a NEW directory outside the repository');
  }
  if (fs.existsSync(dir)) throw new Error('output already exists');
  const result = buildProbe();
  const config = require('./ts-module.cjs').load('labConfig.ts').LAB_EXAMPLE_EXPERIMENT;
  let repoHead = 'unknown';
  try { repoHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); } catch {}
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'main.js'), result.code, { flag: 'wx' });
  const manifest = { status: 'PREPARED_NOT_RUN', mode: 'control-probe', repoHead, config,
    sources: result.sources, output: { file: 'main.js', bytes: Buffer.byteLength(result.code), sha256: hash(result.code) } };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--out') throw new Error('usage: build-control-probe.cjs --out <new-external-directory>');
    console.log(JSON.stringify(writeProbe(args[1]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildProbe, writeProbe };
