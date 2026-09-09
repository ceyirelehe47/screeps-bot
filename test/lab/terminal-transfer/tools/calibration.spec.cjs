'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { LAB, load } = require('./ts-module.cjs');
const check = load('calibrationCheck.ts').checkLabCalibration;
const config = require('./fixtures/review-base-config.json');
const source = fs.readFileSync(path.join(__dirname, 'fixtures/review-base-facts.json'));
function base() {
  const facts = JSON.parse(source); facts.context.codeSource = { repoHead: 'archived-source', labConfigSha256: 'archived-config' }; return facts;
}
function run(mutate, expected = 'fail') {
  const facts = base(), cfg = structuredClone(config); mutate(facts, cfg);
  const before = JSON.stringify(facts); const result = check(cfg, facts);
  assert.equal(result.status, expected, JSON.stringify(result.summary));
  assert.equal(JSON.stringify(facts), before, 'checker mutated evidence');
  return result;
}
test('P01: archived independent baseline and reversed healthy rows pass without mutation', () => {
  run(() => {}, 'pass'); run(f => f.samples.reverse(), 'pass');
  assert.deepEqual(fs.readFileSync(path.join(__dirname,'fixtures/review-base-facts.json')), source);
});
const cases = [
  ['P02 missing all outgoing', f => f.samples.forEach(s => delete s.transactions.outgoing)],
  ['P03 missing latest two views', f => delete f.samples.at(-1).transactions],
  ['P04 early failed quote retains a number', f => f.samples[0].feeQuote.status = 'unavailable'],
  ['P05 missing latest target H/energy', f => {delete f.samples.at(-1).target.resourceAmount; delete f.samples.at(-1).target.energy;}],
  ['P06 source H unstable', f => f.samples[0].source.resourceAmount = 0],
  ['P07 newest deficit cannot hide behind reversed rows', f => {f.samples.at(-1).source.resourceAmount=0;f.samples.reverse();}],
  ['P08 pause 200 leaves no full T201 window', f => f.context.pauseConfirmedTick=200],
  ['P08 pause 199 also loses first sample', f => f.context.pauseConfirmedTick=199],
  ['P09 duplicate tick', f => f.samples[1].tick=f.samples[0].tick],
  ['P09 conflicting same tick', f => {f.samples[1].tick=f.samples[0].tick;f.samples[1].source.energy=10;}],
  ['P09 negative tick', f => f.samples[0].tick=-1],
  ['P09 fractional tick', f => f.samples[0].tick=1.5],
  ['P09 string tick', f => f.samples[0].tick='196'],
  ['P09 overflow', (f,c) => { f.context.pauseConfirmedTick=Number.MAX_SAFE_INTEGER;c.targetTick=Number.MAX_SAFE_INTEGER; }],
  ['P11 exact description conflict', (f,c) => f.samples[0].transactions.outgoing.records.push({description:c.description})],
  ['malformed row', f => f.samples[0]=null],
  ['malformed endpoint', f => f.samples[0].source=null],
  ['malformed controller', f => f.samples[0].source.controller=null],
  ['malformed transaction record', f => f.samples[1].transactions.outgoing.records.push(null)],
  ['missing earlier target view', f => delete f.samples[0].transactions.incoming],
  ['null shard', f => f.samples[0].shard=null],
  ['prototype-like invalid ID is diagnosed, not executed', f => f.samples[0].source.terminalId='__proto__'],
];
for (const [name, mutate] of cases) test(name, () => run(mutate));
for (const value of [undefined, null, NaN, Infinity, -1, 0.5, '0']) {
  test('P05 invalid required number: ' + String(value), () => run(f => f.samples[1].target.energy=value));
}
for (const side of ['source','target']) for (const field of ['energy','freeCapacity','cooldown']) {
  test('stability ' + side + '/' + field, () => run(f => f.samples[0][side][field] += 1));
}
test('P10 reports shard, source ID, cap together', () => {
  const result = run((f,c) => {c.shardName='wrong';c.sourceTerminalId='wrong';c.maxFeeEnergy=10;});
  for (const name of ['shard_matches_config','source_terminal_id','cap_binds_quote']) assert.equal(result.checks.find(c=>c.item===name).result,'fail');
});
test('P11 unrelated description allowed; target zero remains valid', () => run(f => {f.samples[0].transactions.outgoing.records.push({description:'unrelated'});}, 'pass'));
test('P12 non-26 quote binds exactly; candidate cap never changes itself', () => {
  for(const cap of [36,37,38]) run((f,c)=>{f.samples.forEach(s=>s.feeQuote.energyCost=37);c.maxFeeEnergy=cap;},cap===37?'pass':'fail');
});
test('invalid top-level values give diagnostics instead of TypeError', () => {
  for (const input of [null,undefined,{},[],{context:null,samples:[null]}]) assert.equal(check(config,input).status,'fail');
});
test('actual existing CLI: healthy=0 / missing-view=1 / bad JSON=2, files unchanged', () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'calibration-cli-'));
  try {
    fs.mkdirSync(path.join(tmp,'scripts'));fs.mkdirSync(path.join(tmp,'test/lab/terminal-transfer'),{recursive:true});
    fs.copyFileSync(path.resolve(LAB,'../../../scripts/verify-lab-calibration.mjs'),path.join(tmp,'scripts/verify-lab-calibration.mjs'));
    fs.copyFileSync(path.join(LAB,'calibrationCheck.ts'),path.join(tmp,'test/lab/terminal-transfer/calibrationCheck.ts'));
    fs.writeFileSync(path.join(tmp,'test/lab/terminal-transfer/labConfig.ts'),'export const LAB_EXAMPLE_EXPERIMENT = '+JSON.stringify(config)+';');
    execFileSync('git',['init','-q'],{cwd:tmp});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','CLI fixture'],{cwd:tmp});
    const file=path.join(tmp,'facts.json');
    for (const [kind,expected] of [['healthy',0],['missing',1],['bad',2]]) {
      const facts=base();if(kind==='missing') delete facts.samples[1].transactions;
      const bytes=kind==='bad'?'{':JSON.stringify(facts);fs.writeFileSync(file,bytes);
      const env={...process.env,NODE_PATH:path.resolve(require.resolve('typescript'),'../../..')};
      const p=spawnSync(process.execPath,[path.join(tmp,'scripts/verify-lab-calibration.mjs'),'--facts',file],{encoding:'utf8',env});
      assert.equal(p.status,expected,p.stderr);assert.equal(fs.readFileSync(file,'utf8'),bytes);
      if(kind!=='bad') assert.equal(JSON.parse(p.stdout).report.status,expected===0?'pass':'fail');
      else assert.match(p.stderr,/JSON/);
    }
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
