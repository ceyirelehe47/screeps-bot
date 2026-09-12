'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const C=require('../runtime/common.cjs'),I=require('../runtime/input.cjs'),P=require('../vendor/0003/protocol.cjs');
const {observeRuntime}=require('../runtime/closure-observer.cjs');
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'screeps-recovery-'));
function main(commit,tree,tag){const t=`const BUILD_COMMIT = "${commit}";\nconst BUILD_TREE = "${tree}";\nconst BUILD_DIRTY = "false";\nconst BUILD_DEPLOY_BRANCH = "default";\nconst BUILD_TAG = "${tag}";\n`;return t+`\n;globalThis.__DEPLOY_BUNDLE_HASH__="${C.sha256(t)}";\n`;}
function session(){
 const backup=P.makeSnapshot({main:main(C.PRODUCTION_BASE,C.PRODUCTION_TREE,'backup-fixture')},I.guard);
 const candidate=P.makeSnapshot({main:main('a'.repeat(40),'b'.repeat(40),'candidate-fixture')},I.guard);
 return {kind:'formal-compat-observation-0003-public/v1',runId:'d'.repeat(32),...C.EXPECTED,profileHead:'a'.repeat(40),profileTree:'b'.repeat(40),
  profile:{enabled:true,shardName:'shard1',rooms:['E3N59','E4N58'],resources:['energy','H'],startTick:73646500,endTick:73647600,intervalTicks:100,minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384},
  backup,candidate,backupDigest:backup.digest,candidateDigest:candidate.digest,build:P.confirmBuild(candidate.modules,'a'.repeat(40),'b'.repeat(40)),backupBuild:P.buildIdentity(backup.modules.main)};
}
function priorFiles(prior,s){fs.mkdirSync(prior);
 const a={runId:s.runId,candidateHash:s.candidate.digest.hash,profileHead:s.profileHead,startedAtMs:1};
 const u={runId:s.runId,candidateHash:s.candidate.digest.hash,result:{confirmed:true,status:'UPLOADED_AND_READBACK_VERIFIED'}};
 for(const n of ['backup','candidate']){C.durable(path.join(prior,n+'.json'),s[n]);s[n+'FileSha256']=C.sha256(C.bytes(path.join(prior,n+'.json')));}
 const {backup,candidate,...pub}=s;C.durable(path.join(prior,'public-session.json'),pub);C.durable(path.join(prior,'upload-attempt.json'),a);C.durable(path.join(prior,'upload-result.json'),u);
 C.durable(path.join(prior,'collector-result.json'),{status:'failed',reason:'BRIDGE_JSON_INVALID',exitCode:1});return pub;
}
function fakeApi(s,{initial='candidate',failCodeReads=0,lostAck=false,applyWrite=true,authWrong=false}={}){
 let modules=C.clone(s[initial]?.modules||{main:'third party code'}),posts=0,reads=0,times=0;
 const api={me:async()=>({ok:1,_id:authWrong?'other':s.userId,username:s.username}),branches:async()=>({ok:1,list:[{branch:'default',activeWorld:true}]}),
  code:async()=>{reads++;if(reads<=failCodeReads)throw new C.Failure('HTTP_TRANSPORT_ECONNRESET');return {ok:1,modules:C.clone(modules)};},
  time:async()=>{times++;throw new Error('Must not be called by recovery');},
  restoreBackup:async m=>{posts++;if(applyWrite)modules=C.clone(m);if(lostAck)throw new C.Failure('HTTP_DEADLINE');return {ok:1};}};
 return {api,get posts(){return posts;},get reads(){return reads;},get times(){return times;},set modules(x){modules=x;}};
}
const token='FIXTURE_SECRET_TOKEN_NOT_A_REAL_CREDENTIAL';
const secret={token,redact:C.redactor([token])};
function wsClass(mode='healthy'){
 return class FakeWebSocket{
  constructor(){this.map=new Map();this.interval=null;this.closed=false;setTimeout(()=>this.emit('open',{}),1);}
  addEventListener(n,f){this.map.set(n,[...(this.map.get(n)||[]),f]);}
  emit(n,v){for(const f of this.map.get(n)||[])f(v);}
  send(t){if(t.startsWith('auth ')){setTimeout(()=>this.emit('message',{data:'auth ok '+token}),1);return;}
   if(t.endsWith('/cpu')){const send=()=>{if(this.closed)return;
    const user=C.EXPECTED.userId;const logs=mode==='bridge'?['{&#x22;kind&#x22;:&#x22;treasury-legacy-read-bridge&#x22;}']:mode==='redact'?[token]:[];
    if(mode!=='no-console')this.emit('message',{data:JSON.stringify([`user:${user}/console`,{shard:mode==='wrong-shard'?'shard2':'shard1',messages:{log:logs,results:[]}}])});
    if(mode!=='no-cpu')this.emit('message',{data:JSON.stringify([`user:${user}/cpu`,{cpu:mode==='zero-cpu'?0:42}])});};
    this.interval=setInterval(send,3);send();if(mode==='close')setTimeout(()=>{if(!this.closed)this.emit('close',{});},12);
    if(mode==='reauth')setTimeout(()=>this.emit('message',{data:'auth ok '+token}),10);
   }}
  close(){this.closed=true;clearInterval(this.interval);}
 };
}
const fastObserver=opts=>observeRuntime({...opts,WebSocketClass:wsClass(),durationMs:250,startupMs:1500,silenceMs:1000,pollMs:5});
function observedReport(){const tick=73646500;
 const endpoints=[['E3N59','storage','69eeae0db590d0089d87b487',800000,200000,1000000,179236,135505],['E3N59','terminal','69fcff2ed22e9226307ce4fe',260000,40000,300000,72600,0],['E4N58','storage','69eedb6224f1bd9c6041e6ab',4633540,3366460,8000000,249263,2892],['E4N58','terminal','69fc583c60d86221e8bdf547',231245,68755,300000,25412,0]];
 return {kind:'treasury-legacy-read-bridge',tick,shard:'shard1',sourceCommit:'01bd9831454950c4928df98dd8679692b55603e5',productionBase:C.PRODUCTION_BASE,
  authorizesActions:false,scope:{rooms:['E3N59','E4N58'],resources:['energy','H'],isEmpireTotal:false},evaluation:'observation_and_legacy_commitments_only',facadeQueryRun:false,
  spendable:null,kernelLifecycleRun:false,storageMode:'heap_only',previousRun:null,
  legacyInputs:{tasks:{status:'nonempty',count:2},reservations:{status:'empty',count:0},reservationVersion:{status:'absent',value:null},treasuryCore:{status:'absent',activeCount:null}},
  endpoints:endpoints.map(([room,location,id,used,free,capacity,energy,H])=>({room,location,directStatus:'ok',direct:{id,used,free,capacity,overCapacity:false,active:true,cooldown:location==='storage'?null:0,amounts:{energy,H}},
   legacyProjection:{status:'match_capacity_and_selected_energy',updatedAt:tick,comparisonPerformed:true,mismatches:[]},change:{status:'no_comparable_previous_sample'},coreComparison:'match_selected_scope',coreMismatches:[]})),
  commitments:{status:'not_read_cpu_budget',rows:null},status:'partial_cpu_budget',coreObservationRooms:['E3N59','E4N58'],requestedEndpointRows:4,collectedEndpointRows:4,
  cpuBeforeSerializationAndEmit:2.4981476000029943,cooperativeBudget:true};
}
function firstFrame(s,report=observedReport(),encode=t=>t.replace(/"/g,'&#x22;')){
 return JSON.stringify({kind:'ws-frame',runId:s.runId,receivedAt:'2026-09-12T03:01:13.049Z',redacted:false,
 text:JSON.stringify([`user:${s.userId}/console`,{messages:{log:[encode(JSON.stringify(report))],results:[]},shard:s.shard}])})+'\n';
}
function git(repo,args){return cp.execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function initGit(repo){fs.mkdirSync(repo);git(repo,['init','-q']);git(repo,['config','user.email','test@example.invalid']);git(repo,['config','user.name','Fixture']);git(repo,['config','core.autocrlf','false']);}
module.exports={root,main,session,priorFiles,fakeApi,secret,wsClass,fastObserver,observedReport,firstFrame,git,initGit};
