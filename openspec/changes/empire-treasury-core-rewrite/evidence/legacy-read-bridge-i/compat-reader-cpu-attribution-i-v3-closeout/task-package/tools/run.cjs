#!/usr/bin/env node
'use strict';
const C = require('./common.cjs'), K = require('./checks.cjs'), F = require('./closeout.cjs');
function opts(args) {
  const out = {}; for (let i = 0; i < args.length; i += 2) {
    const k = args[i]; if (!/^--[a-z-]+$/.test(k) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(out, k.slice(2))) C.fail('ARGUMENT_INVALID'); out[k.slice(2)] = args[i + 1];
  } return out;
}
function test(o) {
  const dest = C.external(o.out, []), spec = C.read(C.path.join(C.ROOT, 'references/test-set.json'));
  const e = C.env(); delete e.NODE_OPTIONS;
  const r = C.cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...spec.files.map(n => C.safe(C.ROOT, n))], { env: e, encoding: null, timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  const result = { status: 'CLOSEOUT_FIXED_TESTS_FAILED', exit: r.status, signal: r.signal || null, error: r.error?.code || null,
    node: process.version, platform: process.platform, tests: spec.tests, packageFingerprint: C.sha(C.fs.readFileSync(C.path.join(C.ROOT, 'INTEGRITY.json'))),
    stdout: (r.stdout || Buffer.alloc(0)).toString('utf8'), stderr: (r.stderr || Buffer.alloc(0)).toString('utf8') };
  let ok = false;
  try { if (r.status === 0 && !r.error && !r.signal && result.stderr === '') { K.tapCounts(r.stdout, spec.tests); ok = true; } } catch { /* Keep raw failure evidence. */ }
  if (ok) result.status = 'CLOSEOUT_FIXED_TESTS_VERIFIED'; C.put(C.path.join(dest, 'result.json'), result);
  if (!ok) C.fail('CLOSEOUT_TESTS_FAILED'); return { ...result, stdout: '[saved in result.json]' };
}
function main(args) {
  const command = args.shift(), o = opts(args); C.integrity();
  const allowed = {
    'verify-package': [], test: ['out'], inspect: ['compat', 'refactor', 'out'],
    assemble: ['compat', 'refactor', 'inspection', 'tests', 'out'], gate: ['compat', 'refactor', 'inspection', 'out'],
    'verify-committed': ['compat', 'refactor', 'gate', 'out'], 'verify-remote': ['compat', 'refactor', 'committed', 'out']
  };
  if (!Object.hasOwn(allowed, command)) C.fail('UNKNOWN_COMMAND');
  C.eq(Object.keys(o).sort(), allowed[command].slice().sort(), 'REQUIRED_ARGUMENT_SET_MISMATCH');
  const result = command === 'verify-package' ? C.integrity() : command === 'test' ? test(o) : command === 'verify-committed' ? F.committed(o) : command === 'verify-remote' ? F.remote(o) : F[command](o);
  console.log(JSON.stringify(result)); return result;
}
if (require.main === module) try { main(process.argv.slice(2)); } catch (e) { console.error(JSON.stringify({ status: 'STOP', code: e.code || 'LOCAL_FAILURE', detail: e.detail || null })); process.exitCode = 1; }
module.exports = { main, test, opts };
