#!/usr/bin/env node
'use strict';
// Independent local-only builder. No production Rollup config, upload plugin,
// test mocks or Node runtime module is reachable from the generated bundle.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '../../..');
const ENTRY = 'test/lab/treasury-integration/main.ts';
const hash = b => createHash('sha256').update(b).digest('hex');
const posix = p => p.split(path.sep).join('/');
function inside(root, file) { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); }
function blocked(id) {
  return /(^|\/)(mock|node_modules)\//.test(id) || /\.(test|spec)\./.test(id)
    || /(^|\/)runtimeServices\.[cm]?[jt]s$/.test(id) || /^src\/main\./.test(id)
    || /(^|\/)singleShot\.ts$/.test(id);
}
function transpile(text, filename) {
  const result = ts.transpileModule(text, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, importHelpers: false } });
  if ((result.diagnostics || []).some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('transpile failed: ' + filename);
  return result.outputText;
}
function buildGraph(root = ROOT, entry = ENTRY) {
  root = fs.realpathSync(root);
  const modules = new Map();
  function visit(filename) {
    filename = fs.realpathSync(filename);
    if (!inside(root, filename)) throw new Error('dependency escapes repository');
    const id = posix(path.relative(root, filename));
    if (blocked(id)) throw new Error('forbidden live bundle dependency: ' + id);
    if (modules.has(id)) return id;
    if (modules.size >= 128) throw new Error('unexpectedly large integration dependency graph');
    const bytes = fs.readFileSync(filename);
    const module = { id, sourceSha256: hash(bytes), bytes: bytes.length, code: transpile(bytes.toString('utf8'), filename), deps: {} };
    modules.set(id, module); // break legitimate circular imports
    const ast = ts.createSourceFile(filename + '.js', module.code, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
    const names = new Set();
    function walk(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error('dynamic require forbidden: ' + id);
        names.add(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    }
    walk(ast);
    for (const name of names) {
      if (name === 'lodash') { module.deps[name] = '@game/lodash'; continue; }
      if (name.startsWith('@mock/') || (!name.startsWith('@/') && !name.startsWith('.'))) throw new Error('unapproved runtime dependency: ' + name);
      const base = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.resolve(path.dirname(filename), name);
      const file = [base, base + '.ts', base + '.js', path.join(base, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!file) throw new Error('missing actual source: ' + name + ' from ' + id);
      module.deps[name] = visit(file);
    }
    return id;
  }
  const entryId = visit(path.resolve(root, entry));
  const list = [...modules.values()].sort((a,b) => a.id.localeCompare(b.id));
  const factories = list.map(m => `${JSON.stringify(m.id)}:function(exports,module,require){\n${m.code}\n}`).join(',\n');
  const maps = Object.fromEntries(list.map(m => [m.id, m.deps]));
  const code = `/* Isolated Treasury integration; default disabled; NOT production deployment. */\n'use strict';\n(function(){\nconst factories={${factories}};\nconst maps=${JSON.stringify(maps)};\nconst cache=Object.create(null);\nfunction load(id){\nif(id==='@game/lodash'){if(typeof _==='undefined')throw new Error('Game lodash unavailable');return _;}\nif(!Object.prototype.hasOwnProperty.call(factories,id))throw new Error('unregistered integration module');\nif(cache[id])return cache[id].exports;\nconst m={exports:{}};cache[id]=m;\nfactories[id](m.exports,m,function(name){if(!Object.prototype.hasOwnProperty.call(maps[id],name))throw new Error('unregistered dependency');return load(maps[id][name]);});\nreturn m.exports;\n}\nexports.loop=load(${JSON.stringify(entryId)}).loop;\n})();\n`;
  return { code, sources: Object.fromEntries(list.map(m => [m.id, { sha256: m.sourceSha256, bytes: m.bytes }])), modules: list.map(m => m.id) };
}
function evaluateConstant(root, relative) {
  const e = {}, sandbox = { exports: e, module: { exports: e } };
  vm.runInNewContext(transpile(fs.readFileSync(path.join(root, relative), 'utf8'), relative), sandbox, { timeout: 1000 });
  return sandbox.module.exports;
}
function buildBundle(root = ROOT) {
  const result = buildGraph(root);
  const config = evaluateConstant(root, 'test/lab/terminal-transfer/labConfig.ts').LAB_EXAMPLE_EXPERIMENT;
  const enabled = evaluateConstant(root, 'test/lab/treasury-integration/enabled.ts').TREASURY_INTEGRATION_ENABLED;
  if (typeof enabled !== 'boolean') throw new Error('invalid compile-time enable flag');
  return { ...result, config, enabled };
}
function assertCommittedSources(root, sources) {
  const files = Object.keys(sources).sort();
  if (!files.length) throw new Error('empty source graph');
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 };
  const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], options).trim();
  execFileSync('git', ['ls-files', '--error-unmatch', '--', ...files], options);
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...files], options);
  if (status.trim()) throw new Error('integration source graph differs from committed HEAD; commit before official build');
  return head;
}
function writeBundle(out) {
  const dir = path.resolve(out), parent = fs.realpathSync(path.dirname(dir));
  if (inside(fs.realpathSync(ROOT), parent) || fs.existsSync(dir)) throw new Error('output must be a NEW external directory');
  const result = buildBundle();
  const repoSourceCommit = assertCommittedSources(ROOT, result.sources);
  const manifest = { status: 'PREPARED_NOT_RUN', mode: 'treasury-integration', repoSourceCommit, config: result.config,
    enabled: result.enabled, sources: result.sources, output: { file: 'main.js', bytes: Buffer.byteLength(result.code), sha256: hash(result.code) } };
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'main.js'), result.code, { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
if (require.main === module) {
  try {
    const a = process.argv.slice(2);
    if (a.length !== 2 || a[0] !== '--out') throw new Error('usage: node test/lab/treasury-integration/build.cjs --out <NEW external dir>');
    console.log(JSON.stringify(writeBundle(a[1]), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
module.exports = { ROOT, ENTRY, buildGraph, buildBundle, writeBundle, blocked, assertCommittedSources };
