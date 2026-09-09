'use strict';
// Node-side loader for trusted lab sources only. No filesystem/runtime fallback
// is exposed to the evaluated TypeScript module. Does not install dependencies.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const LAB = path.resolve(__dirname, '..');
const cache = new Map();
function emit(relative) {
  const filename = path.resolve(LAB, relative);
  if (path.relative(LAB, filename).startsWith('..')) throw new Error('source outside lab');
  const source = fs.readFileSync(filename, 'utf8');
  const cached = cache.get(filename);
  if (cached && cached.source === source) return cached.code;
  const result = ts.transpileModule(source, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  if ((result.diagnostics || []).some(d => d.category === ts.DiagnosticCategory.Error)) {
    throw new Error('TypeScript transpilation failed: ' + filename);
  }
  cache.set(filename, { source, code: result.outputText });
  return result.outputText;
}
function load(relative, globals = {}) {
  const exports = {};
  const sandbox = { ...globals, exports, module: { exports }, require(name) {
    throw new Error('unregistered dependency in standalone lab module: ' + name);
  } };
  vm.runInNewContext(emit(relative), sandbox, { filename: relative, timeout: 1000 });
  return sandbox.module.exports;
}
module.exports = { LAB, emit, load };
