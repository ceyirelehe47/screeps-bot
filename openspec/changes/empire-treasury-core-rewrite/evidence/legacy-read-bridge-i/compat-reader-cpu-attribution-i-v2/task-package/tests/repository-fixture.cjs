'use strict';
const C = require('../tools/common.cjs'), H = require('./harness.cjs');
const os = require('node:os'), vm = require('node:vm'), { createRequire } = require('node:module');
function fixture({ legacy = false, source = 'new' } = {}) {
  const root = C.fs.mkdtempSync(C.path.join(os.tmpdir(), 'compat-cpu-repo-v2-'));
  C.fs.cpSync(C.path.join(C.ROOT, 'baseline'), root, { recursive: true });
  if (source === 'new') for (const e of C.sourcePlan().filter(e => e.path.startsWith('src/'))) {
    C.fs.writeFileSync(C.path.join(root, e.path), e.bytes);
  }
  if (!legacy) C.fs.copyFileSync(C.path.join(C.ROOT, 'implementation/test/treasury-compat/helpers.cjs'), C.path.join(root, 'test/treasury-compat/helpers.cjs'));
  C.fs.copyFileSync(C.path.join(C.ROOT, 'references/repository-tests/bridge.spec.cjs'), C.path.join(root, 'test/treasury-compat/bridge.spec.cjs'));
  return root;
}
function helper(root) {
  const file = C.path.join(root, 'test/treasury-compat/helpers.cjs');
  const Module = require('node:module'), loaded = new Module(file);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(C.path.dirname(file));
  const hostRequire = loaded.require.bind(loaded);
  loaded.require = id => id === 'typescript' ? H.typescript() : hostRequire(id);
  // Execute the exact CJS helper in the host realm, as Node normally does.
  // Only TypeScript resolution is supplied; its internal VM require is unchanged.
  loaded._compile(C.fs.readFileSync(file, 'utf8'), file);
  return loaded.exports;
}
function childEnv() {
  const resolved = process.env.CPU_I_TS_REPO
    ? createRequire(C.path.resolve(process.env.CPU_I_TS_REPO, 'package.json')).resolve('typescript')
    : require.resolve(process.env.CPU_I_TS_MODULE);
  const env = { ...C.safeEnv(), NODE_PATH: C.path.dirname(C.path.dirname(C.path.dirname(resolved))) };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
function runBridge(root) {
  return C.spawnSync(process.execPath, ['--test', '--test-reporter=tap', C.path.join(root, 'test/treasury-compat/bridge.spec.cjs')],
    { cwd: root, env: childEnv(), encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
}
function remove(root) { C.fs.rmSync(root, { recursive: true, force: true }); }
module.exports = { fixture, helper, childEnv, runBridge, remove };
