'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');

const assembled=fs.existsSync(path.join(__dirname,'../runtime/time-budget.cjs'));
if(!assembled){
 const A=require('../tools/adapt-executor.cjs');
 const baseline=fs.readFileSync(path.join(__dirname,'../references/time-budget.original.cjs'),'utf8');
 test('FC1 generator patches the exact baseline admission site once',()=>{
  const out=A.timeBudget(baseline);
  assert.match(out,/P\.measurementPolicy/);
  assert.match(out,/P\.fullCostMeasurement!==true/);
  assert.match(out,/profile\.maxSampleCpu!==10/);
  assert.match(out,/profile\.reserveCpu!==25/);
  assert.throws(()=>A.timeBudget(out),/EXECUTOR_PATCH_ANCHOR/);
 });
 test('FC1 generator enforces the 10/25/55, bucket, interval, sample and receipt policy',()=>{
  const out=A.timeBudget(baseline);
  for(const fragment of ['cooperativeCeilingCpu!==10','retainedReserveCpu!==25','admissionHeadroomCpu!==55',
   'minBucket!==2000','intervalTicks!==100','points!==4','receiptBytes!==16384'])assert.ok(out.includes(fragment),fragment);
 });
 test('FC1 cannot fall back to the legacy protocol; the immutable baseline retains 2/5',()=>{
  const out=A.timeBudget(baseline);
  assert.match(out,/P\.fullCostMeasurement!==true/);
  assert.match(out,/profile\.maxSampleCpu!==10/);
  assert.match(out,/profile\.reserveCpu!==25/);
  assert.match(baseline,/profile\.maxSampleCpu!==2/);
  assert.match(baseline,/profile\.reserveCpu!==5/);
 });
 test('both live entry points receive a fail-closed fresh-authorization guard',()=>{
  const run=fs.readFileSync(path.join(__dirname,'../tools/run.cjs'),'utf8');
  const observe=fs.readFileSync(path.join(__dirname,'../references/observe.original.cjs'),'utf8');
  assert.match(run,/NEW_ROUND_AUTHORIZATION_REQUIRED/);
  assert.match(A.observeGate(observe),/NEW_ROUND_AUTHORIZATION_REQUIRED/);
 });
}else{
 const C=require('../runtime/common.cjs'),P=C.POLICY,T=require('../runtime/time-budget.cjs');
 const R=require('../tools/repository.cjs'),A=require('../runtime/actions.cjs');
 const selection=require('./time-helper.cjs'),actionFixtures=require('./helpers.cjs'),repoFixtures=require('./admission-fixtures.cjs');
 const tmp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'fc1-admission-test-'));return d;};
 const measure=()=>{
  const dir=tmp();fs.mkdirSync(path.join(dir,'window-selection'),{recursive:true});
  const timing=selection.seed(dir,T,C);return{dir,timing,profile:R.profileFor(50)};
 };
 const cleanup=x=>{if(x?.close)x.close();else if(x?.dir)fs.rmSync(x.dir,{recursive:true,force:true});};
 const rowsFor=(timing,count,tickStep)=>Array.from({length:count},(_,i)=>timing.row(i*tickStep,i*20000));
 const admissionApi=(s,P)=>{
  let current=s.backup,uploads=0,restores=0;
  const api={
   me:async()=>({ok:1,_id:P.expected.userId,username:P.expected.username}),
   branches:async()=>({ok:1,list:[{branch:P.expected.branch,activeWorld:true}]}),
   code:async()=>({ok:1,modules:current}),
   overview:async()=>({ok:1,shards:{[P.expected.shard]:{rooms:P.rooms}}}),
   time:async()=>({ok:1,time:s.observedTick}),
   upload:async modules=>{assert.ok(fs.existsSync(path.join(s.runDir,'candidate-attempt.json')));uploads++;current=modules;return{ok:1};},
   restore:async modules=>{assert.ok(fs.existsSync(path.join(s.runDir,'restore-attempt.json')));restores++;current=modules;return{ok:1};}
  };
  return{api,get writes(){return[uploads,restores];},current:()=>current};
 };
 async function blockUpload(adjust,expected){
  const dir=tmp();
  try{
   const x=actionFixtures.scene(dir);x.s.runDir=dir;
   await adjust(x,dir);
   await assert.rejects(A.uploadOnce(x.api,x.s,dir,()=>{},{clock:x.clock}),new RegExp(expected));
   assert.deepEqual(x.writes,[0,0]);
   assert.equal(fs.existsSync(path.join(dir,'candidate-attempt.json')),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
 test('repository profile passes both binding and upload admission after selection',()=>{
  const x=measure();
  try{
   const p=x.profile;
   assert.deepEqual({enabled:p.enabled,shardName:p.shardName,rooms:p.rooms,resources:p.resources,startTick:p.startTick,
    endTick:p.endTick,intervalTicks:p.intervalTicks,minBucket:p.minBucket,maxSampleCpu:p.maxSampleCpu,
    reserveCpu:p.reserveCpu,maxLogBytes:p.maxLogBytes},
    {enabled:true,shardName:'shard1',rooms:['E3N59','E4N58'],resources:['energy','H'],startTick:200,endTick:500,
     intervalTicks:100,minBucket:2000,maxSampleCpu:10,reserveCpu:25,maxLogBytes:16384});
   const binding=T.verifyPlan(x.dir,p,'binding');assert.equal(binding.status,'TIME_BUDGET_ADMITTED');
   const read=x.timing.row(50,200000,'upload-preflight');
   assert.equal(T.plan(x.timing.measurement,read,p,'upload').status,'TIME_BUDGET_ADMITTED');
  }finally{cleanup(x);}
 });
 test('FC1 rejects legacy 2/5, mixed, expanded and changed-scope profiles',()=>{
  const x=measure();
  try{
   const changes=[
    ['legacy',{maxSampleCpu:2,reserveCpu:5}],['ceiling-expanded',{maxSampleCpu:11}],
    ['reserve-reduced',{reserveCpu:24}],['reserve-expanded',{reserveCpu:26}],
    ['bucket-reduced',{minBucket:1999}],['log-expanded',{maxLogBytes:16385}],
    ['interval-changed',{intervalTicks:20}],['room-drift',{rooms:['E3N59']}],
    ['resource-drift',{resources:['energy']}],['disabled',{enabled:false}],['shard-drift',{shardName:'shard0'}]
   ];
   for(const[name,delta]of changes)assert.throws(()=>T.plan(x.timing.measurement,x.timing.binding,{...x.profile,...delta},'binding'),/TIMING_PROFILE_INVALID/,name);
  }finally{cleanup(x);}
 });
 test('FC1 refuses a mutated protocol policy instead of admitting a mixed profile',()=>{
  const x=measure(),original=P.measurementPolicy;
  try{P.measurementPolicy={...original,admissionHeadroomCpu:54};assert.throws(()=>T.plan(x.timing.measurement,x.timing.binding,x.profile,'binding'),/TIMING_FULL_COST_POLICY_INVALID/);}
  finally{P.measurementPolicy=original;cleanup(x);}
 });
 test('final collector close waits for four validated cost receipts as well as four reports',()=>{
  const Worker=require('../runtime/worker.cjs'),now=Date.now();
  const heartbeat={runId:P.parentRunId,streaming:true,pid:process.pid,atMs:now,lastConsole:now,lastCpu:now,
   issues:[],safety:false,accepted:4,costReceipts:3};
  assert.equal(Worker.collectorHealth(heartbeat,now),null);
  heartbeat.costReceipts=4;
  assert.equal(Worker.collectorHealth(heartbeat,now),'FOUR_REPORTS_CAPTURED');
 });
 test('expired timing evidence, insufficient time, clock identity drift and expired windows fail closed',()=>{
  const x=measure();
  try{
   const stale=x.timing.row(51,120000+P.timing.maxAgeMs+1,'bind-preflight');
   assert.throws(()=>T.plan(x.timing.measurement,stale,x.profile,'binding'),/TICK_RATE_EVIDENCE_STALE/);
   const slow=T.measurement(rowsFor(x.timing,11,2)),slowCurrent=x.timing.row(21,200000,'bind-preflight');
   assert.equal(slow.conservativeMsPerTick,15000);
   assert.equal(T.plan(slow,slowCurrent,R.profileFor(0),'binding').status,'TIME_BUDGET_INSUFFICIENT');
   const drift={...x.timing.binding,clockId:'e'.repeat(32)};
   assert.throws(()=>T.plan(x.timing.measurement,drift,x.profile,'binding'),/TIMING_CLOCK_OR_ORDER_INVALID/);
   const expired={...x.timing.binding,purpose:'upload-preflight',tick:x.profile.startTick-99};
   assert.throws(()=>T.plan(x.timing.measurement,expired,x.profile,'upload'),/PROFILE_EXPIRED/);
  }finally{cleanup(x);}
 });
 test('FC1 generated profile binds, loads as a session, passes upload review, restores once and closes OFF',async()=>{
  const f=repoFixtures.fixture();
  try{
   const C=f.mod('runtime/common.cjs'),P=C.POLICY,T=f.mod('runtime/time-budget.cjs'),R=f.mod('tools/repository.cjs'),
    I=f.mod('runtime/identity.cjs'),A=f.mod('runtime/actions.cjs');
   const dir=path.join(f.root,'run');fs.mkdirSync(dir);
   const makeModule=(build,tag)=>{
    const source=`const BUILD_COMMIT = "${build.commit}";\nconst BUILD_TREE = "${build.tree}";\nconst BUILD_DEPLOY_BRANCH = "default";\nconst BUILD_TAG = "${tag}";\n`;
    return{main:source+`\n;globalThis.__DEPLOY_BUNDLE_HASH__="${C.sha(source)}";\n`};
   };
   const backup=makeModule(P.backupBuild,P.backupBuild.tag);P.backupDigest=I.digest(backup);
   const timing=f.mod('tests/time-helper.cjs').seed(dir,T,C),b=R.bind(f.repo,dir,50);
   assert.equal(b.profile.maxSampleCpu,10);assert.equal(b.profile.reserveCpu,25);
   assert.equal(T.verifyPlan(dir,b.profile,'binding').status,'TIME_BUDGET_ADMITTED');
   const candidate=makeModule({commit:b.profileHead,tree:b.profileTree},'fixture-candidate');
   const backupPath=path.join(dir,'backup.json'),candidatePath=path.join(dir,'candidate.json');
   C.durable(backupPath,backup);C.durable(candidatePath,candidate);
   const s={runId:P.parentRunId,packageFingerprint:C.verifyPackage().fingerprint,source:b.source,profileHead:b.profileHead,
    profileTree:b.profileTree,profile:b.profile,observedTick:50,...timing.sessionFields(),build:I.candidate(candidate,b.profileHead,b.profileTree),
    candidateDigest:I.digest(candidate),backupDigest:P.backupDigest,backupFileSha256:C.sha(C.bytes(backupPath)),
    candidateFileSha256:C.sha(C.bytes(candidatePath))};
   C.durable(path.join(dir,'session.json'),s);
   const bad={...s,profile:{...s.profile,maxSampleCpu:2,reserveCpu:5}};
   fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify(bad,null,2)+'\n');
   assert.throws(()=>A.loadSession(dir),/SESSION_PROFILE_OR_SOURCE_CHANGED/);
   fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify(s,null,2)+'\n');const loaded=A.loadSession(dir);loaded.runDir=dir;
   const fapi=admissionApi(loaded,P),result=await A.uploadOnce(fapi.api,loaded,dir,()=>{},{clock:timing.clock});
   assert.equal(result.confirmed,true);assert.deepEqual(fapi.writes,[1,0]);
   assert.equal(T.verifyPlan(dir,b.profile,'upload').status,'TIME_BUDGET_ADMITTED');
   const restored=await A.restoreOnce(fapi.api,loaded,dir,{pause:async()=>{}});
   assert.equal(restored.confirmed,true);assert.deepEqual(fapi.writes,[1,1]);
   assert.equal(I.eq(fapi.current(),backup),true);
   const off=await R.closeSource(f.repo,dir);assert.equal(off.sameTreeAsSource,true);assert.equal(R.tree(f.repo),b.source.tree);
  }finally{f.close();}
 });
 test('pre-upload review rejects stale timing evidence without a write',()=>blockUpload(async(x)=>{x.clock.now+=P.timing.maxAgeMs+1;},'TICK_RATE_EVIDENCE_STALE'));
 test('pre-upload review rejects insufficient time without a write',()=>blockUpload(async(x,dir)=>{
  const rows=C.jsonl(path.join(dir,'time-observations.jsonl')),base=rows.find(r=>r.purpose==='rate-measurement');
  const slow=Array.from({length:11},(_,i)=>{const mono=i*20000;return{...base,id:crypto.randomBytes(16).toString('hex'),tick:i*2,
   sentMonoMs:mono,receivedMonoMs:mono,sentAtMs:base.sentAtMs-base.sentMonoMs+mono,
   receivedAtMs:base.receivedAtMs-base.receivedMonoMs+mono};});
  const rest=rows.filter(r=>r.purpose!=='rate-measurement');
  const all=[...slow,...rest].sort((a,b)=>a.sentMonoMs-b.sentMonoMs);
  fs.writeFileSync(path.join(dir,'time-observations.jsonl'),all.map(r=>JSON.stringify(r)).join('\n')+'\n');
  fs.writeFileSync(path.join(dir,'timing-measurement.json'),JSON.stringify(T.measurement(slow),null,2)+'\n');
 },'TIME_BUDGET_INSUFFICIENT'));
 test('pre-upload review rejects account identity drift without a write',()=>blockUpload(async(x)=>{
  x.api.me=async()=>({ok:1,_id:'different-user',username:P.expected.username});
 },'ACCOUNT_MISMATCH'));
 test('pre-upload review rejects an invalid FC1 profile and an expired window without a write',async()=>{
  await blockUpload(async(x)=>{x.s.profile={...x.s.profile,maxSampleCpu:2,reserveCpu:5};},'TIMING_PROFILE_INVALID');
  await blockUpload(async(x)=>{x.api.time=async()=>({ok:1,time:x.s.profile.startTick-99});},'PROFILE_EXPIRED');
 });
 test('authorized release still rejects missing repository identity before side effects',async()=>{
  const Run=require('../fc1-delivery/tools/run.cjs'),Observe=require('../tools/observe.cjs');
  const guide=fs.readFileSync(path.join(__dirname,'../AGENT-RUN.md'),'utf8');
  const grant=C.json(path.join(__dirname,'../AUTHORIZATION.json'));
  assert.match(guide,/AUTHORIZATION\.json/);
  assert.doesNotMatch(guide,/XV.*Online I Retry I/);
  assert.equal(P.newRoundAuthorization.status,'AUTHORIZED');
  assert.equal(grant.authorizationId,P.authorizationId);
  assert.equal(grant.runId,P.parentRunId);
  const args={compat:'/no-network/compat',refactor:'/no-network/refactor',work:'/no-network/run',secret:'/no-network/secret',
   execute:true,'exclusive-target':true,'prior-workers-stopped':true};
  await assert.rejects(Run.run(args),/NEW_ROUND_AUTHORIZATION_REQUIRED/);
  await assert.rejects(Observe.observe(args),/GIT_OPERATION_FAILED/);
  assert.equal(fs.existsSync(args.work),false);
 });
}
