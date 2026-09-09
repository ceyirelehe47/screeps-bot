'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SLOT, readMemory, planMemoryUpdate, updateMemory, assessControlSamples } = require('./memory-control.cjs');
const { buildProbe, writeProbe } = require('./build-control-probe.cjs');
const { load } = require('./ts-module.cjs');
const { parseArgs } = require('./lab-control.cjs');
const { identityMatches, belongsToEnvironment } = require('./process-scope.cjs');
const ID='local-offline-test';
const pristine={experimentId:ID,armed:false,attempted:false};
const raw=r=>JSON.stringify({keep:{nested:['保留','😀']},[SLOT]:r});
const sample=(tick,armed=false)=>({kind:'lab-control-sample',sampler:{name:'lab-control-probe',version:'1'},userId:'u',user:{username:'lab-u'},expectedExperimentId:ID,tick,control:{status:'ok',record:{...pristine,armed}}});
const expected={userId:'u',username:'lab-u',experimentId:ID,armed:false};

test('initialize -> arm once -> disarm preserves foreign Memory',()=>{
  const before='{"keep":{"nested":["保留","😀"]}}';
  const init=planMemoryUpdate(before,'initialize',ID);assert.equal(init.record.armed,false);
  const armed=planMemoryUpdate(init.afterRaw,'arm',ID);assert.equal(armed.record.armed,true);
  assert.throws(()=>planMemoryUpdate(armed.afterRaw,'arm',ID),/rearm/);
  const done=planMemoryUpdate(armed.afterRaw,'disarm',ID);
  assert.deepEqual(JSON.parse(done.afterRaw).keep,JSON.parse(before).keep);
  assert.equal(done.totalMemoryBytes,Buffer.byteLength(done.afterRaw));
  assert.equal(done.record.stopped,true);
  assert.throws(()=>planMemoryUpdate(done.afterRaw,'arm',ID),/rearm/);
});
for(const bad of [null,undefined,'','{','null','[]','4'])test('invalid whole Memory '+String(bad),()=>assert.throws(()=>readMemory(bad)));
for (const record of [{...pristine,attempted:true},{...pristine,stopped:true},{...pristine,attemptedTick:1},{...pristine,syncResult:{ok:false}},{...pristine,experimentId:'other'},{...pristine,extra:1}]) {
  test('arm refuses historical/corrupt control '+JSON.stringify(record),()=>assert.throws(()=>planMemoryUpdate(raw(record),'arm',ID)));
}
test('disarm never erases attempted, tick or result',()=>{
  const prior={...pristine,armed:true,attempted:true,attemptedTick:10,syncResult:{ok:false,error:'unknown'},stopped:true};
  assert.deepEqual(planMemoryUpdate(raw(prior),'disarm',ID).record,{...prior,armed:false});
});
test('size 4095/4096 pass, 4097 corrupt; unicode counted as UTF8',()=>{
  const record={...pristine,armed:true,attempted:true,syncResult:{ok:false,error:'保留😀'}};
  const initial=Buffer.byteLength(JSON.stringify(record));
  for(const n of [4095,4096,4097]) {
    const r=structuredClone(record);r.syncResult.error+='x'.repeat(n-initial);
    assert.equal(readMemory(raw(r)).controlBytes,n);
    assert.equal(readMemory(raw(r)).read.status,n<=4096?'ok':'corrupt');
  }
});
test('exactly one env write; storage confirmation is NOT player confirmation',async()=>{
  let value=raw(pristine),writes=0;
  const io={assertIdentity:async()=>{},assertPausedStable:async()=>9,readRuntimeMemory:async()=>value,writeRuntimeMemory:async s=>{writes++;value=s;}};
  const result=await updateMemory(io,'arm',ID);assert.equal(writes,1);assert.equal(result.storageConfirmed,true);assert.equal(result.playerConfirmed,false);
});
test('stale world/Memory abort before write',async()=>{
  let reads=0,writes=0;
  const io={assertIdentity:async()=>{},assertPausedStable:async()=>9,readRuntimeMemory:async()=>++reads===1?raw(pristine):'{}',writeRuntimeMemory:async()=>writes++};
  await assert.rejects(updateMemory(io,'arm',ID),/changed/);assert.equal(writes,0);
});
test('silent lost env write has no fallback, retry or rollback',async()=>{
  let writes=0;
  const io={assertIdentity:async()=>{},assertPausedStable:async()=>9,readRuntimeMemory:async()=>raw(pristine),writeRuntimeMemory:async()=>writes++};
  await assert.rejects(updateMemory(io,'arm',ID),/readback mismatch/);assert.equal(writes,1);
});
test('logging failure prevents the mutation',async()=>{
  let writes=0;const io={assertIdentity:async()=>{},assertPausedStable:async()=>9,readRuntimeMemory:async()=>raw(pristine),writeRuntimeMemory:async()=>writes++};
  await assert.rejects(updateMemory(io,'arm',ID,()=>{throw Error('disk');}),/disk/);assert.equal(writes,0);
});
test('db mirror data cannot stand in for absent runtime control',()=>{
  assert.equal(assessControlSamples([sample(1),sample(2)],expected,'{}').ready,false);
  assert.equal(assessControlSamples([sample(1),sample(2)],expected,raw(pristine)).ready,true);
});
test('roundtrip requires same user, ID, values and distinct real ticks',()=>{
  for(const change of [s=>s.userId='other',s=>s.control.record.experimentId='other',s=>s.control.record.attempted=true,s=>s.tick=1,s=>s.control.status='absent']) {
    const samples=[sample(1),sample(2)];change(samples[1]);assert.equal(assessControlSamples(samples,expected).ready,false);
  }
  assert.equal(assessControlSamples([sample(1)],expected).ready,false);
});
test('actual probe bundle: module loading is inert, two ticks read only; never touches send',()=>{
  const cfg=load('labConfig.ts').LAB_EXAMPLE_EXPERIMENT;
  let writes=0,sendReads=0;const logs=[];
  const memory=new Proxy({[SLOT]:{...pristine,experimentId:cfg.experimentId}}, {set(){writes++;throw Error('write');},deleteProperty(){writes++;throw Error('delete');}});
  function room(id){return {controller:{my:true,level:8,owner:{username:cfg.username}},terminal:{id,my:true,isActive:()=>true,owner:{username:cfg.username},cooldown:0,store:{H:1000,energy:10000,getFreeCapacity:()=>200000},get send(){sendReads++;throw Error('send must not be read');}}};}
  const game={time:1,shard:{name:cfg.shardName},rooms:{[cfg.sourceRoomName]:room(cfg.sourceTerminalId),[cfg.targetRoomName]:room(cfg.targetTerminalId)},market:{calcTransactionCost:()=>26,incomingTransactions:[],outgoingTransactions:[]}};
  const e={};vm.runInNewContext(buildProbe().code,{exports:e,Game:game,Memory:memory,console:{log:s=>logs.push(JSON.parse(s))}},{timeout:1000});
  assert.equal(logs.length,0);e.loop();game.time=2;e.loop();e.loop();assert.equal(logs.length,2);
  assert.equal(logs[0].control.record.armed,false);assert.equal(logs[0].user.username,cfg.username);
  assert.equal(writes,0);assert.equal(sendReads,0);
});
test('probe build cannot overwrite an existing output or repository directory',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'probe-build-'));
  try {const p=path.join(tmp,'out');const manifest=writeProbe(p);assert.equal(manifest.status,'PREPARED_NOT_RUN');assert.throws(()=>writeProbe(p),/exists/);assert.throws(()=>writeProbe(path.join(__dirname,'forbidden')),/repository/);}finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('process scope rejects unrelated node, reused PID and command changes; no process killed',()=>{
  const a={pid:42,started:'1',executable:'/usr/bin/node',command:['node','/tmp/new-lab/server/bin.js']};
  assert.equal(belongsToEnvironment(a,'/tmp/new-lab'),true);assert.equal(belongsToEnvironment(a,'/tmp/other'),false);
  assert.ok(identityMatches(a,{...a}));assert.ok(!identityMatches(a,{...a,started:'2'}));assert.ok(!identityMatches(a,{...a,command:['other']}));
});
test('CLI requires complete explicit bindings; --help has no side effects',()=>{
  assert.deepEqual(parseArgs(['--help']),{help:true});assert.throws(()=>parseArgs(['--command','arm']),/required/);assert.throws(()=>parseArgs(['--unknown','1']),/unknown/);
});
test('a later config path is not launcher ownership; ancestry excludes unrelated processes',()=>{
  const { descendantIds }=require('./process-scope.cjs');
  assert.equal(belongsToEnvironment({pid:3,executable:'/usr/bin/node',command:['node','/other/script.js','--config=/tmp/lab/file']},'/tmp/lab'),false);
  assert.deepEqual(descendantIds([{pid:12,ppid:10},{pid:13,ppid:12},{pid:99,ppid:1}],10),[10,12,13]);
});

test('missing launcher is not proof of worker exit',()=>{
  const { requireOwnedRoot }=require('./process-scope.cjs');
  const owner={pid:42,started:'1',executable:'/usr/bin/node',command:['node','/tmp/lab/start.js']};
  assert.throws(()=>requireOwnedRoot(owner,null),/descendant cleanup unconfirmed/);
  assert.throws(()=>requireOwnedRoot(owner,{...owner,started:'2'}),/identity changed/);
  assert.doesNotThrow(()=>requireOwnedRoot(owner,{...owner}));
});
