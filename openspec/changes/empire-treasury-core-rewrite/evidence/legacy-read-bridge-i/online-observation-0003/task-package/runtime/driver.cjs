'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const {performance}=require('node:perf_hooks');
const C=require('./common.cjs'),S=require('./store.cjs'),G=require('./guard-control.cjs'),W=require('./samples.cjs'),A=require('./actions.cjs'),K=require('./policy.cjs');
function spawnWorker(name,args,run){
 const stdout=fs.openSync(S.file(run,name+'.stdout'),'wx',0o600),stderr=fs.openSync(S.file(run,name+'.stderr'),'wx',0o600);
 const child=cp.spawn(process.execPath,[path.join(__dirname,name+'.cjs'),...args],{stdio:['ignore',stdout,stderr],detached:true,windowsHide:true});
 fs.closeSync(stdout);fs.closeSync(stderr);
 const p={child,closed:false,exit:null,error:null};
 child.once('error',()=>{p.error='WORKER_SPAWN_FAILED';p.closed=true;});
 child.once('close',(code,signal)=>{p.closed=true;p.exit=code;try{S.newRecord(run,name+'.exit.json',{code,signal,pid:child.pid??null});}catch{p.error='EXIT_EVIDENCE_WRITE_FAILED';}});
 S.newRecord(run,name+'.process.json',{pid:child.pid??null,atMs:Date.now()});return p;
}
async function waitFor(fn,ms,{pause=C.pause}={}){const end=performance.now()+ms;while(performance.now()<end){const x=await fn();if(x)return x;await pause(250);}C.fail('WAIT_DEADLINE');}
async function postRestore(api,guard,s,run,{pause=C.pause,confirmMs=K.CONFIRM_MS,now=Date.now}={}){
 const before=await A.reconcileReadOnly(api,guard,s,run,{pause});S.newRecord(run,'restore-independent-before.json',before);
 if(!before.confirmed)return {confirmed:false,reason:'REMOTE_BYTES_NOT_CONFIRMED'};
 const startedAtMs=now(),end=performance.now()+confirmMs;let pid=null,checks=0;
 while(performance.now()<end){
  const h=await G.readJsonArtifact(S.file(run,'heartbeat.json'),16384,{required:true});
  const bad=W.health(h,s,now(),pid);if(bad)return {confirmed:false,reason:bad};pid=h.pid;checks++;await pause(500);
 }
 const h=await G.readJsonArtifact(S.file(run,'heartbeat.json'),16384,{required:true});
 const after=await A.reconcileReadOnly(api,guard,s,run,{pause});S.newRecord(run,'restore-independent-after.json',after);
 const confirmed=after.confirmed&&h.lastConsoleAtMs>startedAtMs&&h.lastCpuAtMs>startedAtMs&&h.lastPositiveCpuAtMs>startedAtMs;
 return {confirmed,status:confirmed?'RESTORED_BYTES_AND_RUNTIME_CONFIRMED':'RESTORE_RUNTIME_UNCONFIRMED',startedAtMs,endedAtMs:now(),durationMs:confirmMs,
  collectorPid:pid,healthChecks:checks,lastConsoleAtMs:h.lastConsoleAtMs,lastCpuAtMs:h.lastCpuAtMs,lastPositiveCpuAtMs:h.lastPositiveCpuAtMs,
  cpuChannelScope:'account-channel; shard1 is independently checked by console frames and code readback'};
}
async function execute({repo,run,secret,s,guard,api}){
 S.newRecord(run,'execution-attempt.json',{runId:s.runId,atMs:Date.now()});
 const args=['--repo',path.resolve(repo),'--run',path.resolve(run),'--secret',secret.path];
 const workers={};let upload=null,failure=null,post=null;
 const close=reason=>{try{C.atomicJson(S.file(run,'closing.json'),{runId:s.runId,reason,atMs:Date.now()});}catch{}};
 const onSignal=()=>close('OPERATOR_STOP');process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
 try{
  workers.collector=spawnWorker('collector',args,run);
  await waitFor(async()=>{if(workers.collector.closed)C.fail('COLLECTOR_EARLY_EXIT');const h=await G.readJsonArtifact(S.file(run,'heartbeat.json'),16384);return !W.health(h,s,Date.now())?h:null;},20000);
  workers.guard=spawnWorker('recovery-worker',[...args,'--execute'],run);
  const ready=async()=>{if(workers.guard.closed)C.fail('GUARD_EARLY_EXIT');const g=await G.readJsonArtifact(S.file(run,'guard-ready.json'),16384);
   if(g?.runId!==s.runId||g.state!=='ready'||Date.now()-g.updatedAtMs>5000)return false;
   const h=await G.readJsonArtifact(S.file(run,'heartbeat.json'),16384);return !W.health(h,s,Date.now(),g.collectorPid);};
  await waitFor(ready,20000);
  upload=await A.uploadOnce(api,guard,s,run,async()=>{if(!await ready()||fs.existsSync(S.file(run,'closing.json')))C.fail('GUARD_NOT_READY_FOR_UPLOAD');});
  if(!upload.confirmed)close('UPLOAD_UNCONFIRMED');
  const end=performance.now()+s.wallLimitMs+120000;
  while(performance.now()<end){
   if(workers.guard.closed)break;
   if(workers.collector.closed)close('COLLECTOR_EXITED');
   const r=await G.readJsonArtifact(S.file(run,'guard-ready.json'),16384);
   // An independent supervisor never kills a potentially restoring worker.
   // A hung worker triggers a closing request; its action lock protects recovery.
   if(r&&Date.now()-r.updatedAtMs>30000)close('GUARD_HEARTBEAT_STALE');
   await C.pause(500);
  }
  if(!workers.guard.closed){close('PARENT_WALL_DEADLINE');C.fail('GUARD_DID_NOT_CLOSE');}
 }catch(e){failure={error:A.codeOf(e),atMs:Date.now()};close(failure.error);}
 // Give a healthy independent guard time to recover after a parent-side failure.
 if(workers.guard&&!workers.guard.closed){try{await waitFor(()=>workers.guard.closed,60000);}catch{}}
 if(!workers.guard||workers.guard.closed){
  const priorRestore=S.optional(run,'restore-result.json');
  if(!priorRestore||(!priorRestore.confirmed&&!fs.existsSync(S.file(run,'restore-attempt.json')))){
   try{const r=await A.restoreOnce(api,guard,s,run);S.newRecord(run,'supervisor-restore-result.json',r);}catch(e){S.newRecord(run,'supervisor-restore-result.json',{status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,error:A.codeOf(e)});}
  }
 }
 // A still-running guard forbids another recovery writer. Do not stop its collector.
 if(workers.guard&&!workers.guard.closed){
  S.newRecord(run,'driver-result.json',{runId:s.runId,status:'ONLINE_CLOSE_UNCONFIRMED',failure,guardStillRunning:true});
  process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);workers.guard.child.unref();workers.collector?.child.unref();return;
 }
 if(fs.existsSync(S.file(run,'upload-attempt.json'))){
  try{post=await postRestore(api,guard,s,run);}catch(e){post={confirmed:false,error:A.codeOf(e)};}
  S.newRecord(run,'runtime-confirmation.json',post);
 }
 if(workers.collector&&!workers.collector.closed){
  try{S.newRecord(run,'collector-stop.json',{runId:s.runId,reason:upload?'observation_closed':'no_upload',atMs:Date.now()});await waitFor(()=>workers.collector.closed,10000);}catch(e){failure=failure||{error:A.codeOf(e)};}
 }
 const result={runId:s.runId,status:!fs.existsSync(S.file(run,'upload-attempt.json'))?'NOT_DEPLOYED':post?.confirmed?'RESTORED':'ONLINE_CLOSE_UNCONFIRMED',
  upload,failure,post,collectorExit:workers.collector?.exit??null,guardExit:workers.guard?.exit??null,atMs:Date.now()};
 S.newRecord(run,'driver-result.json',result);process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);return result;
}
module.exports={spawnWorker,waitFor,postRestore,execute};
