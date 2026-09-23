'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),os=require('node:os');
const C=require('../tools/common.cjs'),F=require('../tools/repair.cjs'),N=require('../tools/integration.cjs'),Prep=require('../tools/prepare.cjs');
const {fs,path,P,ROOT}=C,Q=require('../implementation/treasury-compat-read-path-r1.cjs');
const XV=C.read(path.join(ROOT,'fixtures/core-XV.ts.txt')).toString('utf8');
const R1=C.read(path.join(ROOT,'fixtures/core-R1.expected.ts.txt')).toString('utf8');
const attr='test/treasury-compat/attribution.spec.cjs',hot='test/treasury-compat/hotpath-optimization.spec.cjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'r1-v2-fixture-'));
const plain=x=>JSON.parse(JSON.stringify(x));
function measure(text){
 const counter={get:0};class CountedMap extends Map{get(k){counter.get++;return super.get(k);}}
 const host={module:{exports:{}},Map:CountedMap,Memory:{cfg:{},runtime:{}},Game:{time:100,rooms:{}},RESOURCES_ALL:['energy','H']};
 const a='import type { CompatReadBuilders } from "./treasuryCompatTypes";',b='export function createCompatibilityReadCore(): CompatReadBuilders {';
 assert.equal(text.split(a).length,2);assert.equal(text.split(b).length,2);
 vm.runInNewContext(text.replace(a,'').replace(b,'function createCompatibilityReadCore() {')+'\nmodule.exports=createCompatibilityReadCore;',host,{timeout:3000});
 const builders=host.module.exports(),tasks={};
 for(let i=0;i<37;i++)tasks[i]={id:'t'+i,status:'pending',resource:'H',fromRoomName:'W1N1',toRoomName:'W1N1',amount:100,remainingAmount:70,origin:'manual',reason:'manual',createdAt:1,updatedAt:1,lastProgressAt:99};
 counter.get=0;const index=builders.buildCommitments({tick:100,tasks,reservations:{},observation:{freeCapacity:()=>10000}}),mapGet=counter.get;
 return {mapGet,semantics:plain({outgoing:index.outgoing('W1N1','H'),incoming:index.incoming('W1N1','H'),pending:index.pendingIncoming('W1N1','H'),count:index.incomingTaskCount('W1N1'),receiver:index.receiverCommitments('W1N1'),route:index.findMergeableTaskId('H','W1N1','W1N1','manual','manual'),completeness:index.completeness})};
}
test('v2 retains the exact v1 authorization and run id rather than issuing a retry quota',()=>{
 const old=C.json(path.join(ROOT,'references/r1-v1-PACKAGE.json'));
 assert.equal(P.authorizationId,old.authorizationId);assert.equal(P.runId,old.runId);
 assert.equal(P.repositoryNodeTests,467);assert.equal(P.inheritedToolTests,165);
 assert.equal(P.sourceMessage,old.sourceMessage);assert.deepEqual(P.sourcePaths,old.sourcePaths);
});
test('v2 repair scope adds exactly the two historical tests and no runtime file',()=>{
 assert.deepEqual(P.repairSourcePaths,[attr,hot]);assert.deepEqual(Object.keys(F.FIX).sort(),P.repairSourcePaths);
 assert.equal(new Set([...P.sourcePaths,...P.repairSourcePaths]).size,11);
});
test('v2 production payloads and 43 Core regressions are byte-identical to v1',()=>{
 const old=C.json(path.join(ROOT,'references/r1-v1-INTEGRITY.json'));
 assert.equal(C.sha(C.read(path.join(ROOT,'references/r1-v1-INTEGRITY.json'))),P.priorPackageFingerprint);
 for(const name of ['implementation/treasury-compat-read-path-r1.cjs','implementation/integration-patches.json','implementation/core-identities.json','fixtures/core-XV.ts.txt','fixtures/core-R1.expected.ts.txt','tests/read-path-r1.spec.cjs','tools/milestone.cjs']){
  const b=C.read(path.join(ROOT,name));assert.equal(C.sha(b),old.files[name].sha256,name);assert.equal(b.length,old.files[name].bytes,name);
 }
});
test('original stale length assertion fails on the actual unchanged R1 Core',()=>{
 assert.equal(Buffer.byteLength(XV),70443);assert.equal(Buffer.byteLength(R1),74835);
 assert.throws(()=>assert.equal(Buffer.byteLength(R1),70443),{code:'ERR_ASSERTION'});
});
test('repaired length boundary restores exact XV and separately authenticates current R1',()=>{
 const replacement=F.FIX[attr].changes[0].after;
 const start=replacement.indexOf('const currentCore');
 const execute=text=>vm.runInNewContext(replacement.slice(start),{assert,Buffer,require,generated:{core:Buffer.from(text)},G:{GENERATED:'core',Q}});
 assert.doesNotThrow(()=>execute(R1));assert.throws(()=>execute(R1+' '));
 assert.equal(Q.coreRestore(R1),XV);
});
test('R1 changes actual builder Map-get instrumentation by 111 for 37 self routes',()=>{
 const a=measure(XV),b=measure(R1);assert.deepEqual(a.semantics,b.semantics);
 assert.equal(a.mapGet-b.mapGet,111);assert.deepEqual(measure(Q.coreRestore(R1)),a);
 // This is an operation counter, not a Screeps CPU measurement.
});
test('historical 37 delta assertion remains literal while R1 semantics are checked separately',()=>{
 const r=F.FIX[hot].changes[0].after;
 assert.ok(r.includes('operationCounts(G.Q.coreRestore(afterCore()),37,true)'));
 assert.ok(r.includes('assert.equal(a.commitment.mapGet-b.commitment.mapGet,37)'));
 assert.ok(r.includes('assert.deepEqual(current.semantics,b.semantics)'));
 assert.ok(!r.includes(',148)'));
});
test('repaired historical assertion executes each stage separately and rejects semantic corruption',()=>{
 const r=F.FIX[hot].changes[0].after;let calls=[],corrupt=false;
 const invoke=()=>vm.runInNewContext(r,{test:(n,fn)=>fn(),assert,G:{Q},beforeCore:()=> 'IX-stage-sentinel',afterCore:()=>R1,
  operationCounts:(text,n,self)=>{calls.push(text);assert.equal(n,37);assert.equal(self,true);
   if(text==='IX-stage-sentinel')return {commitment:{mapGet:200},semantics:{a:1}};
   if(text===XV)return {commitment:{mapGet:163},semantics:{a:1}};
   assert.equal(text,R1);return {commitment:{mapGet:52},semantics:{a:corrupt?2:1}};
  }});
 invoke();assert.deepEqual(calls,['IX-stage-sentinel',XV,R1]);corrupt=true;assert.throws(invoke);
 // This checks assertion routing only; the full-runtime counter case is above.
});
for(const[file,p]of Object.entries(F.FIX))test('repair anchors are exact, reversible and reject shifted baseline: '+file,()=>{
 const source=p.changes[0].before;
 assert.equal(N.rewrite(N.rewrite(source,p.changes),p.changes,true),source);
 assert.throws(()=>N.rewrite(source+source,p.changes),/ANCHOR_COUNT/);
 assert.throws(()=>F.repairPatch(file,Buffer.from(source)),/REPAIR_BASE_CHANGED/);
});
function gitFixture(){
 const root=temp(),repo=path.join(root,'repo');fs.mkdirSync(repo);C.git(repo,['init','-b',P.compatBranch]);
 C.git(repo,['config','user.name','Fixture']);C.git(repo,['config','user.email','fixture@example.invalid']);
 const old={};for(const[file,p]of Object.entries(F.FIX)){old[file]=p.beforeBlob;const b=Buffer.from(p.changes[0].before+'\n');C.write(path.join(repo,file),b);p.beforeBlob=C.blob(b);}
 C.write(path.join(repo,P.corePath),R1);C.write(path.join(repo,P.configPath),'OFF\n');
 C.git(repo,['add','.']);C.git(repo,['commit','-m',P.sourceMessage]);
 const original={head:C.head(repo),tree:C.tree(repo)};
 return {root,repo,original,close(){for(const[file,b]of Object.entries(old))F.FIX[file].beforeBlob=b;fs.rmSync(root,{recursive:true,force:true});}};
}
test('native Git repair fixture appends only two tests and preserves the existing source commit',()=>{
 const f=gitFixture();try{
  const s=F.commitRepair(f.repo,{original:f.original,head:f.original.head,alreadyRepaired:false});
  assert.equal(C.text(f.repo,['show','-s','--format=%P',s.head]),f.original.head);
  assert.deepEqual(F.diff(f.repo,f.original.head,s.head),P.repairSourcePaths);
  assert.equal(F.object(f.repo,s.head,P.corePath).toString('utf8'),R1);
  assert.equal(C.text(f.repo,['rev-list','--count',f.original.head+'..HEAD']),'1');
  const m=F.manifest(f.repo,s);assert.equal(m.base,f.original.head);assert.equal(m.expectedSourceTree,s.tree);
  assert.deepEqual(Object.keys(m.files).sort(),P.repairSourcePaths);
 }finally{f.close();}
});
test('native Git fixture recognizes an already committed exact repair without another commit',()=>{
 const f=gitFixture();try{const a=F.commitRepair(f.repo,{original:f.original,head:f.original.head,alreadyRepaired:false});
  const b=F.commitRepair(f.repo,{original:f.original,head:a.head,alreadyRepaired:true});assert.deepEqual(b,a);
  assert.equal(C.text(f.repo,['rev-list','--count',f.original.head+'..HEAD']),'1');
 }finally{f.close();}
});
test('native Git fixture refuses dirty state without overwriting it',()=>{
 const f=gitFixture();try{fs.appendFileSync(path.join(f.repo,attr),'foreign\n');
  assert.throws(()=>F.commitRepair(f.repo,{original:f.original,head:f.original.head,alreadyRepaired:false}),/WORKTREE_NOT_CLEAN/);
  assert.ok(fs.readFileSync(path.join(f.repo,attr),'utf8').endsWith('foreign\n'));assert.equal(C.head(f.repo),f.original.head);
 }finally{f.close();}
});
test('native Git fixture rejects an unrelated or merge-like repair lineage',()=>{
 const f=gitFixture();try{C.write(path.join(f.repo,'foreign.txt'),'foreign');C.git(f.repo,['add','.']);C.git(f.repo,['commit','-m',P.repairMessage]);
  assert.throws(()=>F.lineage(f.repo,C.head(f.repo),f.original.head,P.repairMessage,P.repairSourcePaths),/SCOPE_MISMATCH/);
 }finally{f.close();}
});
test('consumed authorization blocks reuse across work-directory changes without deleting marker',()=>{
 const f=gitFixture();try{const a=F.authorizationUnused(f.repo);C.write(a.marker,JSON.stringify({work:'old'}));
  assert.throws(()=>F.authorizationUnused(f.repo),/ALREADY_CONSUMED/);assert.equal(C.json(a.marker).work,'old');
 }finally{f.close();}
});
test('resolved executor pins the repair parent/message but keeps the original R1 experiment identity',()=>{
 const old={authorizationId:'compat-read-envelope-XV-online-I-retry-I-2026-09-23',compilerVersion:'5.9.3',wallMs:4500000,points:4,runtimeMs:75000,selection:{minimumSlackMs:180000},timing:{safetyFactor:1.5},backupDigest:{hash:'same'},kind:'historical'};
 const source={head:'a'.repeat(40),tree:'b'.repeat(40),base:'c'.repeat(40),repaired:true};
 const p=Prep.resolvedPolicy(old,source);
 assert.equal(p.implementationBase,source.base);assert.equal(p.sourceMessage,P.repairMessage);
 assert.equal(p.compatBase,source.head);assert.equal(p.authorizationId,P.authorizationId);assert.equal(p.parentRunId,P.runId);
 for(const n of ['wallMs','points','runtimeMs','timing','selection','backupDigest'])assert.deepEqual(p[n],old[n]);
});
function priorFixture(){
 const root=temp(),d=path.join(root,'stopped');fs.mkdirSync(d);const saved=P.priorPackageFingerprint;
 const delivery=path.join(d,'executor','r1-delivery');C.write(path.join(delivery,'payload.txt'),'fixture');P.priorPackageFingerprint=C.seal(delivery).fingerprint;
 const executorFingerprint=C.seal(path.join(d,'executor')).fingerprint;
 const source={head:'1'.repeat(40),tree:'2'.repeat(40),base:P.compatBase,paths:9};
 const files={
  'STOP.json':{status:'STOP',phase:'full-offline-gates',code:'COMMAND_FAILED:build',automaticRetryAuthorized:false},
  'prepared.json':{status:'R1_PREPARED',source,executorFingerprint},
  'source-preparation.json':{status:'R1_FIXED_SOURCE_COMMITTED_NOT_YET_PUBLISHED',source,receipt:{package:{fingerprint:P.priorPackageFingerprint}},manifest:{}},
  'tool-tests/result.json':{packageFingerprint:executorFingerprint,tests:165,passed:165,failed:0},
  'commands/build.exit.json':{exit:1},'offline-checks/repository-node.exit.json':{exit:1}
 };
 for(const[n,x]of Object.entries(files))C.durable(path.join(d,n),x);
 for(const n of ['commands/build.stdout','commands/build.stderr','offline-checks/repository-node.stderr'])C.write(path.join(d,n),'');
 C.write(path.join(d,'offline-checks/repository-node.stdout'),'not ok 1 - IX transform exactly restores the committed Build VII core prefix\nnot ok 2 - hotpath XI self routes avoid one duplicate scope lookup per task\n# tests 467\n# pass 465\n# fail 2\n# skipped 0\n# todo 0\n# cancelled 0\n');
 return {d,close(){P.priorPackageFingerprint=saved;fs.rmSync(root,{recursive:true,force:true});}};
}
test('prior-stop fixture binds the old package, executor, source and exactly two failures',()=>{
 const f=priorFixture();try{const r=F.priorAttempt(f.d);assert.equal(r.source.head,'1'.repeat(40));assert.equal(Object.keys(r.files).length,10);
  assert.equal(r.files['STOP.json'].sha256,C.sha(C.read(path.join(f.d,'STOP.json'))));
 }finally{f.close();}
});
for(const mode of ['live','source-published.json','RESULT.json','candidate-attempt.json','restore-attempt.json'])test('prior-stop fixture rejects possible online/published state: '+mode,()=>{
 const f=priorFixture();try{C.write(path.join(f.d,mode),'{}');assert.throws(()=>F.priorAttempt(f.d),/PRIOR_OBSERVE|PRIOR_PHASE/);}finally{f.close();}
});
test('prior-stop fixture rejects a different failed test instead of pretending this repair is sufficient',()=>{
 const f=priorFixture();try{const p=path.join(f.d,'offline-checks/repository-node.stdout');fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('IX transform exactly restores the committed Build VII core prefix','different failure'));assert.throws(()=>F.priorAttempt(f.d),/PRIOR_FAILED_TESTS_CHANGED/);}finally{f.close();}
});
test('prior-stop fixture rejects a modified old delivery or missing logs',()=>{
 const f=priorFixture();try{fs.appendFileSync(path.join(f.d,'executor/r1-delivery/payload.txt'),'changed');assert.throws(()=>F.priorAttempt(f.d),/PACKAGE_BYTES_CHANGED/);}finally{f.close();}
});
test('v2 runner retains mandatory full gates before publish and the single observe entry',()=>{
 const s=C.read(path.join(ROOT,'tools/run.cjs')).toString('utf8');
 assert.ok(s.includes("'prior-work'"));assert.equal(s.split("cmd('observe'").length,2);
 assert.ok(s.indexOf("phase='full-offline-gates'")<s.indexOf("phase='publish-default-off-source'"));
 assert.ok(s.indexOf("phase='publish-default-off-source'")<s.indexOf("phase='single-online-trial'"));
 assert.ok(!s.includes('api.upload(')&&!s.includes('api.restore('));
});

function recipeFixture(corrupt){
 const root=temp(),repo=path.join(root,'repo'),saved={base:P.compatBase,tree:P.compatBaseTree},patchPins={},repairPins={};
 fs.mkdirSync(repo);C.git(repo,['init','-b',P.compatBranch]);C.git(repo,['config','user.name','Fixture']);C.git(repo,['config','user.email','fixture@example.invalid']);
 for(const[file,p]of Object.entries(N.PATCHES)){
  const bytes=Buffer.from(p.changes.flatMap(r=>Array(r.count).fill(r.before)).join('\n/* fixture boundary */\n')+'\n');
  patchPins[file]=p.beforeBlob;p.beforeBlob=C.blob(bytes);C.write(path.join(repo,file),bytes);
 }
 for(const[file,p]of Object.entries(F.FIX)){const bytes=Buffer.from(p.changes[0].before+'\n');repairPins[file]=p.beforeBlob;p.beforeBlob=C.blob(bytes);C.write(path.join(repo,file),bytes);}
 for(const n of ['docs/treasury-compat-loader-optimization.json','docs/treasury-compat-source-manifest.json'])C.write(path.join(repo,n),'before\n');
 C.write(path.join(repo,P.corePath),XV);C.write(path.join(repo,P.configPath),'OFF\n');C.git(repo,['add','.']);C.git(repo,['commit','-m','synthetic XV base']);
 P.compatBase=C.head(repo);P.compatBaseTree=C.tree(repo);
 for(const file of Object.keys(N.PATCHES))fs.writeFileSync(path.join(repo,file),N.patch(file,F.object(repo,P.compatBase,file)));
 for(const[file,payload]of Object.entries({
  'scripts/lib/treasury-compat-read-path-r1.cjs':'implementation/treasury-compat-read-path-r1.cjs',
  'test/treasury-compat/read-path-r1.spec.cjs':'tests/read-path-r1.spec.cjs',
  'test/treasury-compat/fixtures/core-before-read-path-r1.ts.txt':'fixtures/core-XV.ts.txt'
 }))C.write(path.join(repo,file),C.read(path.join(ROOT,payload)));
 fs.writeFileSync(path.join(repo,P.corePath),R1);
 for(const n of ['docs/treasury-compat-loader-optimization.json','docs/treasury-compat-source-manifest.json'])fs.writeFileSync(path.join(repo,n),'after\n');
 if(corrupt)corrupt(repo);
 C.git(repo,['add','.']);C.git(repo,['commit','-m',P.sourceMessage]);
 const source={head:C.head(repo),tree:C.tree(repo),base:P.compatBase,paths:9},files={};
 for(const n of P.sourcePaths){const a=C.git(repo,['show',P.compatBase+':'+n],{allowFailure:true}),b=F.object(repo,source.head,n),id=x=>x?{bytes:x.length,sha256:C.sha(x),blob:C.blob(x)}:null;files[n]={before:id(a),after:id(b)};}
 const prior={source,manifest:{kind:'read-path-R1-source/v1',base:P.compatBase,baseTree:P.compatBaseTree,expectedSourceTree:source.tree,files}};
 return {repo,prior,close(){P.compatBase=saved.base;P.compatBaseTree=saved.tree;for(const[f,p]of Object.entries(patchPins))N.PATCHES[f].beforeBlob=p;for(const[f,p]of Object.entries(repairPins))F.FIX[f].beforeBlob=p;fs.rmSync(root,{recursive:true,force:true});}};
}
test('synthetic Git recipe fixture validates all nine predecessor paths and then the exact two-file child',()=>{
 const f=recipeFixture();try{const a=F.verifyExistingR1(f.repo,f.prior);assert.equal(a.alreadyRepaired,false);
  F.commitRepair(f.repo,a);const b=F.verifyExistingR1(f.repo,f.prior);assert.equal(b.alreadyRepaired,true);assert.equal(b.original.head,a.original.head);
 }finally{f.close();}
});
test('recipe verifier rejects forged matching receipts when the added R1 implementation bytes differ',()=>{
 const f=recipeFixture(repo=>fs.appendFileSync(path.join(repo,'scripts/lib/treasury-compat-read-path-r1.cjs'),'// changed\n'));
 try{assert.throws(()=>F.verifyExistingR1(f.repo,f.prior),/R1_ADDITION_CHANGED/);}finally{f.close();}
});
test('recipe verifier rejects altered runtime Core even when its receipt and tree match',()=>{
 const f=recipeFixture(repo=>fs.appendFileSync(path.join(repo,P.corePath),' '));
 try{assert.throws(()=>F.verifyExistingR1(f.repo,f.prior),/GENERATED_R1_IDENTITY_CHANGED/);}finally{f.close();}
});
test('recipe verifier rejects an unlisted implementation path',()=>{
 const f=recipeFixture(repo=>C.write(path.join(repo,'src/unlisted.ts'),'bad\n'));
 try{assert.throws(()=>F.verifyExistingR1(f.repo,f.prior),/SOURCE_CHANGE_SCOPE_MISMATCH/);}finally{f.close();}
});
test('recipe verifier rejects source mode changes instead of accepting only content hashes',()=>{
 const f=recipeFixture(repo=>{C.git(repo,['config','core.filemode','false']);C.git(repo,['add','--',P.corePath]);C.git(repo,['update-index','--chmod=+x','--',P.corePath]);});
 try{assert.throws(()=>F.verifyExistingR1(f.repo,f.prior),/SOURCE_MODE_CHANGED/);}finally{f.close();}
});
test('executor resolution fixture preserves every inherited runtime byte and binds the two-file repair manifest',()=>{
 const root=temp();try{
  const inherited=path.join(root,'inherited');fs.mkdirSync(inherited);
  const old={authorizationId:'compat-read-envelope-XV-online-I-retry-I-2026-09-23',compilerVersion:'5.9.3',wallMs:4500000,points:4,runtimeMs:75000,selection:{minimumSlackMs:180000},kind:'historical-fixture'};
  C.durable(path.join(inherited,'policy.json'),old);C.durable(path.join(inherited,'source-manifest.json'),{});
  for(let i=0;i<64;i++)C.write(path.join(inherited,'runtime/f'+i+'.cjs'),'// immutable fixture '+i+'\n');
  C.seal(inherited);const source={head:'a'.repeat(40),tree:'b'.repeat(40),base:'c'.repeat(40),repaired:true};
  const manifest={expectedSourceTree:source.tree,files:Object.fromEntries(P.repairSourcePaths.map(n=>[n,{after:{bytes:1,sha256:'d'.repeat(64)}}]))};
  const out=path.join(root,'executor');Prep.resolveExecutor(inherited,out,source,manifest,{fixture:true});
  const policy=C.json(path.join(out,'policy.json'));assert.equal(policy.implementationBase,source.base);assert.equal(policy.sourceMessage,P.repairMessage);
  assert.equal(policy.authorizationId,P.authorizationId);assert.deepEqual(C.json(path.join(out,'source-manifest.json')),manifest);
  assert.deepEqual(C.json(path.join(out,'READ-PATH-R1.json')).sourcePaths,P.repairSourcePaths);
  for(let i=0;i<64;i++)assert.equal(C.sha(C.read(path.join(out,'runtime/f'+i+'.cjs'))),C.sha(C.read(path.join(inherited,'runtime/f'+i+'.cjs'))));
  assert.doesNotThrow(()=>C.verify(out));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
