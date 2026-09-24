'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const F=require('./executor-fixtures.cjs');

const ROOT=path.resolve(__dirname,'..');
const ARTIFACTS=require(path.join(ROOT,'runtime-source-manifest.json'));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function actualRuntime(){
 const cfg={enabled:true,shardName:'shard1',rooms:['E3N59','E4N58'],resources:['energy','H'],startTick:100,endTick:400,
  intervalTicks:100,minBucket:2000,maxSampleCpu:10,reserveCpu:25,maxLogBytes:16384};
 const logs=[];let used=50;
 const makeStore=()=>{
  const amounts={energy:10000,H:50},store={...amounts};
  Object.defineProperties(store,{
   getUsedCapacity:{value(resource){return resource===undefined?10050:amounts[resource]||0;}},
   getFreeCapacity:{value(){return 89950;}},
   getCapacity:{value(){return 100000;}},
  });
  return store;
 };
 const rooms={};
 for(const name of cfg.rooms){
  rooms[name]={name,controller:{my:true},storage:{id:'store-'+name,my:true,isActive:()=>true,store:makeStore()},
   terminal:{id:'term-'+name,my:true,isActive:()=>true,cooldown:0,store:makeStore()}};
 }
 const tasks={};
 for(let index=0;index<5;index++)tasks[index]={id:'t'+index,status:'pending',resource:'energy',fromRoomName:cfg.rooms[0],
  toRoomName:cfg.rooms[1],amount:100,remainingAmount:70,origin:'manual',reason:'manual',createdAt:1,updatedAt:1,lastProgressAt:1};
 const Memory={cfg:{resourceControl:{capacityBalancing:{}}},data:{resourceControl:{tasks}},
  runtime:{resourceReservations:{r:{roomName:'E3N59',resource:'H',holderId:'task:synthetic',amount:60,expiresAt:1000}}}};
 const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
 freeze(Memory);
 const Game={time:100,shard:{name:'shard1'},rooms,cpu:{limit:100,tickLimit:500,bucket:6000,getUsed(){used+=.09;return used;}},
  getObjectById(){return null;}};
 const globals={Game,Memory,RESOURCES_ALL:['energy','H'],console:{log(line){logs.push(JSON.parse(line));}}};
 const cache=Object.create(null);
 function load(name){
  if(name==='treasuryCompatConfig')return{TREASURY_COMPAT_CONFIG:cfg};
  if(cache[name])return cache[name];
  const item=ARTIFACTS.files[name+'.cjs'];
  assert.ok(item,'runtime source artifact missing: '+name);
  const file=path.join(ROOT,item.path),bytes=fs.readFileSync(file);
  assert.equal(bytes.length,item.outputBytes,'runtime artifact size changed: '+name);
  assert.equal(sha(bytes),item.outputSha256,'runtime artifact fingerprint changed: '+name);
  const module={exports:{}};cache[name]=module.exports;
  const localRequire=id=>load(id.replace(/^\.\//,'').replace(/\.js$/,'').replace(/\.cjs$/,''));
  const context=vm.createContext({...globals,exports:module.exports,require:localRequire});
  new vm.Script(bytes.toString('utf8'),{filename:item.sourcePath}).runInContext(context);
  cache[name]=module.exports;
  return module.exports;
 }
 const runtime=load('treasuryCompatRuntime');
 return{cfg,Game,Memory,logs,run(tick){Game.time=tick;used=50;runtime.runTreasuryCompatRead();}};
}

test('source-verified runtime and preview emit four reports and receipts accepted by the final collector under a fresh external run',()=>{
 const {W,policy}=F.load();
 assert.equal(policy.authorizationId,'treasury-full-cost-FC1-online-II-2026-09-24');
 assert.equal(policy.parentRunId,'4d9fb3da-29c7-4313-9d53-925fcbdbcb5d');
 assert.equal(policy.runtimeEmitterId,'treasury-full-cost-FC1-online-I-2026-09-24');
 assert.notEqual(policy.authorizationId,policy.runtimeEmitterId);
 assert.equal(ARTIFACTS.sourceHead,policy.compatBase);
 assert.equal(ARTIFACTS.runtimeEmitterId,policy.runtimeEmitterId);

 const host=actualRuntime(),watch=W.watch(F.session());
 let consumed=0;
 for(const tick of [100,200,300,400]){
  host.run(tick);
  const fresh=host.logs.slice(consumed);consumed=host.logs.length;
  watch.frame(F.frame(fresh),tick);
 }
 const state=watch.state();
 assert.equal(state.accepted,4);
 assert.equal(state.costReceipts,4);
 assert.equal(state.complete,4);
 assert.deepEqual(state.issues,[]);
 assert.deepEqual(watch.costs.map(item=>item.experimentId),Array(4).fill(policy.runtimeEmitterId));
 assert.ok(watch.accepted.every(report=>report.sourceCommit==='01bd9831454950c4928df98dd8679692b55603e5'));
 assert.ok(watch.accepted.every(report=>report.productionBase===policy.backupBuild.commit));
 assert.ok(watch.accepted.every(report=>report.shard==='shard1'&&report.authorizesActions===false));
});
