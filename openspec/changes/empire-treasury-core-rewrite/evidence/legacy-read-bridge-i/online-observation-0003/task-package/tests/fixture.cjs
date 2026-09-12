'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const C=require('../runtime/common.cjs'),P=require('../runtime/protocol.cjs'),K=require('../runtime/policy.cjs');
// Test-only typed comparison; production always loads the pinned deployGuard Git blob.
const guard={computeModulesHash:m=>C.sha256(JSON.stringify(Object.keys(m).sort().map(k=>[k,m[k]]))),
 diffRemoteModules:(a,b)=>({match:JSON.stringify(a)===JSON.stringify(b),missing:Object.keys(a).filter(k=>!(k in b)),extra:Object.keys(b).filter(k=>!(k in a)),changed:Object.keys(a).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]))})};
function main(commit,tree,tag){const b=`const BUILD_COMMIT = "${commit}";\nconst BUILD_TREE = "${tree}";\nconst BUILD_DIRTY = "false";\nconst BUILD_DEPLOY_BRANCH = "default";\nconst BUILD_TAG = "${tag}";\n`;return b+`\n;globalThis.__DEPLOY_BUNDLE_HASH__="${C.sha256(b)}";\n`;}
function makeSession(){const profile=K.profileFor(1000),head='a'.repeat(40),tree='b'.repeat(40);
 const backup=P.makeSnapshot({main:main(C.PRODUCTION_BASE,C.PRODUCTION_TREE,'baseline-fixture')},guard),candidate=P.makeSnapshot({main:main(head,tree,'candidate-fixture')},guard);
 return {kind:'formal-compat-observation-0003/v1',runId:'c'.repeat(32),...C.EXPECTED,refactorBase:K.REFACTOR,compatBase:K.COMPAT,observedTick:1000,profile,profileHead:head,profileTree:tree,
  build:P.confirmBuild(candidate.modules,head,tree),backupBuild:P.buildIdentity(backup.modules.main),preparedAtMs:Date.now(),wallLimitMs:K.WALL_MS,backup,candidate};}
function runDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'formal0003-'));}
function saveSession(run,s){for(const key of ['backup','candidate']){C.writeNew(path.join(run,key+'.json'),s[key]);s[key+'FileSha256']=C.sha256(fs.readFileSync(path.join(run,key+'.json')));}
 const{backup,candidate,...base}=s;C.writeNew(path.join(run,'session.json'),base);C.writeNew(path.join(run,'public-session.json'),{...base,kind:'formal-compat-observation-0003-public/v1',backupDigest:backup.digest,candidateDigest:candidate.digest});}
function sample(s,i,previous=null){return {kind:'treasury-legacy-read-bridge',tick:s.profile.startTick+i*100,shard:s.shard,
 sourceCommit:'01bd9831454950c4928df98dd8679692b55603e5',productionBase:C.PRODUCTION_BASE,authorizesActions:false,
 scope:{rooms:s.profile.rooms,resources:s.profile.resources,isEmpireTotal:false},evaluation:'observation_and_legacy_commitments_only',facadeQueryRun:false,spendable:null,kernelLifecycleRun:false,storageMode:'heap_only',
 previousRun:previous?{tick:previous.tick,cpuIncludingEmit:1,emittedBytes:Buffer.byteLength(JSON.stringify(previous)),retainedPrimitiveChars:1200}:null,
 legacyInputs:{tasks:{status:'empty',count:0},reservations:{status:'nonempty',count:1}},
 endpoints:s.profile.rooms.flatMap(room=>['storage','terminal'].map(location=>({room,location,directStatus:'ok',coreComparison:'match_selected_scope',coreMismatches:[],
  direct:{id:room+'-'+location,used:100,free:900,capacity:1000,overCapacity:false,active:true,cooldown:location==='terminal'?0:null,amounts:{energy:50,H:20}},legacyProjection:{status:'stale'}}))),
 commitments:{status:'read_complete',allTableScan:true,tableLimitEach:256,completeness:{complete:true,globalIncomplete:false,invalidRecords:0,incompleteScopeCount:0},
  rows:s.profile.rooms.flatMap(room=>s.profile.resources.map(resource=>({room,resource,scope:'room_not_endpoint',outgoing:0,incoming:0,productionReserved:0,completeness:{complete:true}})))},
 coreObservationRooms:s.profile.rooms,requestedEndpointRows:4,collectedEndpointRows:4,cpuBeforeSerializationAndEmit:0.5,cooperativeBudget:true,status:'sampled'};}
function allSamples(s){const a=[];for(let i=0;i<12;i++)a.push(sample(s,i,a.at(-1)));return a;}
function apiWorld(s,{onWrite,failReadAfterWrite=false}={}){let modules=C.clone(s.backup.modules),writes=0,time=1000;
 const api={me:async()=>({ok:1,_id:s.userId,username:s.username}),branches:async()=>({ok:1,list:[{branch:'default',activeWorld:true}]}),
  time:async()=>({ok:1,time}),overview:async()=>({ok:1,shards:{shard1:{rooms:K.ROOMS}}}),code:async()=>{if(failReadAfterWrite&&writes)C.fail('HTTP_DEADLINE');return {ok:1,modules:C.clone(modules)};},
  setCode:async(branch,m)=>{writes++;modules=C.clone(m);if(onWrite)await onWrite(writes);return {ok:1};}};
 return {api,get writes(){return writes;},get modules(){return modules;},set modules(m){modules=C.clone(m);},set time(t){time=t;}};}
module.exports={guard,main,makeSession,runDir,saveSession,sample,allSamples,apiWorld};
