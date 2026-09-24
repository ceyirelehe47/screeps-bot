'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');

const ROOT=path.resolve(__dirname,'..');
const POLICY=require(path.join(ROOT,'policy.json'));
const CONTRACT=require(path.join(ROOT,'references/test-contract.json'));
const fingerprint=require(path.join(ROOT,'runtime/common.cjs')).verifyPackage().fingerprint;
const SOURCE={head:POLICY.compatBase,tree:POLICY.compatBaseTree,runtimeEmitterId:POLICY.runtimeEmitterId};

function executorResult(){
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'fc1-entry-closure-tests-'));
 try{
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const run=cp.spawnSync(process.execPath,[path.join(ROOT,'tools/run-tests.cjs'),'--out',path.join(out,'groups')],
   {cwd:ROOT,env,encoding:'utf8',maxBuffer:64*1024*1024,timeout:1200000});
  assert.equal(run.error,undefined,run.stderr);
  assert.equal(run.status,0,run.stderr);
  return JSON.parse(fs.readFileSync(path.join(out,'groups/result.json'),'utf8'));
 }finally{fs.rmSync(out,{recursive:true,force:true});}
}

function observeWith(result){
 const barrier={hit:false};
 const P={...POLICY,newRoundAuthorization:{status:'AUTHORIZED',authorizationId:'synthetic-authorization',runId:'synthetic-run'},
  authorizationId:'synthetic-authorization',parentRunId:'synthetic-run',historicalAuthorizationId:'historical-authorization',
  historicalRunId:'historical-run'};
 const C={POLICY:P,verifyPackage:()=>({fingerprint}),
  json(file){if(file.endsWith('references/test-contract.json'))return CONTRACT;
   if(file.endsWith('tests/result.json'))return structuredClone(result);
   if(file.endsWith('offline/result.json'))return{status:'FC1_OFFLINE_VERIFIED',onlineAttempted:false,
    packageFingerprint:fingerprint,source:SOURCE};
   throw new Error('UNEXPECTED_JSON_READ');},
  outside(){},fail(code){const e=new Error(code);e.code=code;throw e;},code:e=>e.code||'LOCAL_OPERATION_FAILED'};
 const fakeFs={mkdirSync(dir){if(dir!=='/synthetic/work')throw new Error('UNEXPECTED_FILESYSTEM_WRITE');barrier.hit=true;
  const e=new Error('SIDE_EFFECT_BARRIER');e.code=e.message;throw e;}};
 const R={ROOT:path.join(ROOT,'tools'),baseline(){},source(){return SOURCE;},outside(){}};
 const cache={
  '../runtime/common.cjs':C,
  '../runtime/actions.cjs':{},
  '../runtime/identity.cjs':{},
  './repository.cjs':R,
  '../runtime/time-budget.cjs':{},
  '../runtime/test-results.cjs':require(path.join(ROOT,'runtime/test-results.cjs')),
  '../references/test-contract.json':CONTRACT,
 };
 const load=name=>{if(!Object.hasOwn(cache,name))throw new Error('UNEXPECTED_MODULE:'+name);return cache[name];};
 const req=name=>name==='node:fs'?fakeFs:name==='node:path'?path:name==='node:child_process'?{}:
  name==='node:perf_hooks'?require('node:perf_hooks'):load(name);
 const file=path.join(ROOT,'tools/observe.cjs'),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:req,module,exports:module.exports,
  __dirname:path.dirname(file),console,Date,Buffer,URL,structuredClone},{filename:file,timeout:10000});
 return{result:module.exports.observe({compat:'/synthetic/compat',refactor:'/synthetic/refactor',
  work:'/synthetic/work',secret:'/synthetic/secret',offline:'/synthetic/offline',tests:'/synthetic/tests',
  execute:true,'exclusive-target':true,'prior-workers-stopped':true}),barrier};
}

test('authentic grouped test result passes observe gate and stops at the first write boundary',async()=>{
 const result=executorResult();
 assert.equal(result.status,'FC1_FINAL_EXECUTOR_VERIFIED');
 assert.equal(result.packageFingerprint,fingerprint);
 const attempt=observeWith(result);
 await assert.rejects(attempt.result,e=>e.code==='SIDE_EFFECT_BARRIER');
 assert.equal(attempt.barrier.hit,true);
});

test('missing, failed, zero, stale and inconsistent groups fail before the write boundary',async()=>{
 const original=executorResult();
 const bad=[];
 const missing=structuredClone(original);delete missing.groups.finalFc1Composition;bad.push(missing);
 const zero=structuredClone(original);zero.groups.legacyRiskRegressions.tests=0;
 zero.groups.legacyRiskRegressions.passed=0;zero.tests-=CONTRACT.minimumLegacyTests;zero.passed-=CONTRACT.minimumLegacyTests;bad.push(zero);
 const failed=structuredClone(original);failed.groups.finalFc1Composition.failed=1;failed.groups.finalFc1Composition.passed--;
 failed.failed++;failed.passed--;bad.push(failed);
 const stale=structuredClone(original);stale.packageFingerprint='0'.repeat(64);bad.push(stale);
 const inconsistent=structuredClone(original);inconsistent.passed--;bad.push(inconsistent);
 for(const result of bad){
  const attempt=observeWith(result);
  await assert.rejects(attempt.result,e=>e.code==='OFFLINE_GATES_MISSING');
  assert.equal(attempt.barrier.hit,false);
 }
});
