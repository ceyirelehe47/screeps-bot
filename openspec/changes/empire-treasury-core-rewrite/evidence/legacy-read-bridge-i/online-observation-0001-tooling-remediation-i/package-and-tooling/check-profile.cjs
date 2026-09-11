'use strict';
/** Offline source validation. A caller-supplied tick is NOT a verified live tick. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { sha256 } = require('./common.cjs');
const BRIDGE_SHA = 'a9849e430b4238177653ed10cea085f13af402010e4c414312c64306a966d713';
function load(text, name, ts) {
  const result = ts.transpileModule(text, { fileName: name, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } });
  if ((result.diagnostics || []).some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('TypeScript transpilation failed');
  const exports = {};
  new vm.Script(result.outputText, { filename: name }).runInNewContext({ exports,
    require() { throw new Error('unexpected runtime import in configuration/validator'); },
  }, { timeout: 1000 });
  return exports;
}
function inspectProfile(repo, mode, observedTick, ts) {
  if (!['off', 'on'].includes(mode)) throw new Error('mode must be off or on');
  const bridge = fs.readFileSync(path.join(repo, 'src/runtime/treasuryCompatRead.ts'));
  if (sha256(bridge) !== BRIDGE_SHA) throw new Error('production reader changed; this task does not authorize changing it');
  const b = fs.readFileSync(path.join(repo, 'src/runtime/treasuryCompatConfig.ts'));
  const api = load(bridge.toString('utf8'), 'treasuryCompatRead.ts', ts);
  const cfg = load(b.toString('utf8'), 'treasuryCompatConfig.ts', ts).TREASURY_COMPAT_CONFIG;
  if (!cfg || typeof cfg !== 'object') throw new Error('configuration export missing');
  if (cfg.intervalTicks !== 100 || cfg.minBucket !== 2000 || cfg.maxSampleCpu !== 2 || cfg.reserveCpu !== 5 || cfg.maxLogBytes !== 16384)
    throw new Error('sampling/cost/output limits must remain unchanged for this rollout');
  if (JSON.stringify(cfg.resources) !== JSON.stringify(['energy', 'H'])) throw new Error('this rollout is limited to energy and H');
  let dueTicks = [];
  if (mode === 'off') {
    if (cfg.enabled !== false || cfg.shardName !== '' || !Array.isArray(cfg.rooms) || cfg.rooms.length !== 0 || cfg.startTick !== 0 || cfg.endTick !== 0)
      throw new Error('not the default OFF profile');
  } else {
    if (cfg.enabled !== true || !api.validCompatConfig(cfg)) throw new Error('invalid enabled profile');
    if (cfg.shardName !== 'shard1') throw new Error('this task is limited to shard1');
    if (cfg.startTick % 100 !== 0 || cfg.endTick !== cfg.startTick + 1100) throw new Error('bind exactly twelve 100-tick sample slots');
    if (!Number.isSafeInteger(observedTick) || observedTick < 0) throw new Error('provide a nonnegative safe-integer observed tick');
    if (cfg.startTick < observedTick + 100) throw new Error('insufficient pre-upload lead; do not extend an already uploaded window');
    dueTicks = Array.from({ length: 12 }, (_, i) => cfg.startTick + i * 100);
  }
  return { status: 'PROFILE_SOURCE_VALIDATED_ONLY', mode, configSha256: sha256(b), profile: cfg,
    dueTicks, observedTick: mode === 'on' ? observedTick : null,
    liveTickIndependentlyVerified: false, deploymentAuthorized: false, fullTypecheckPerformed: false };
}
function main(args) {
  if (![4, 6].includes(args.length) || args[0] !== '--repo' || args[2] !== '--mode' || (args.length === 6 && args[4] !== '--observed-tick'))
    throw new Error('usage: node check-profile.cjs --repo PATH --mode off|on [--observed-tick N]');
  const repo = path.resolve(args[1]);
  const ts = createRequire(path.join(repo, 'package.json'))('typescript');
  if (args.length === 6 && !/^\d+$/.test(args[5])) throw new Error('tick must be decimal integer text');
  console.log(JSON.stringify(inspectProfile(repo, args[3], args.length === 6 ? Number(args[5]) : undefined, ts), null, 2));
}
module.exports = { inspectProfile };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(String(e.message).slice(0, 400)); process.exitCode = 2; }
}
