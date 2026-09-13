'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const {performance}=require('node:perf_hooks');
const C=require('./common.cjs'),S=require('./store.cjs'),G=require('./guard-control.cjs'),W=require('./samples.cjs'),A=require('./actions.cjs');
const {closeout}=require('./closeout.cjs');
function spawnWorker(name,args,run){
 const stdout=fs.openSync(S.file(run,name+'.stdout'),'wx',0o600),stderr=fs.openSync(S.file(run,name+'.stderr'),'wx',0o600);
 const child=cp.spawn(process.execPath,[path.join(__dirname,name+'.cjs'),...args],{stdio:['ignore',stdout,stderr],detached:true,windowsHide:true});
 fs.closeSync(stdout);fs.closeSync(stderr);const p={child,closed:false,exit:null,error:null};
 child.once('error',()=>{p.error='WORKER_SPAWN_FAILED';p.closed=true;});
 child.once('close',(code,signal)=>{p.closed=true;p.exit=code;try{S.newRecord(run,name+'.exit.json',{code,signal,pid:child.pid??null});}catch{p.error='EXIT_EVIDENCE_WRITE_FAILED';}});
 S.newRecord(run,name+'.process.json',{pid:child.pid??null,atMs:Date.now()});return p;
}
async function waitFor(fn,ms,{pause=C.pause}={}){const end=performance.now()+ms;while(performance.now()<end){const v=await fn();if(v)return v;await pause(250);}C.fail('WAIT_DEADLINE');}
async function execute({repo,run,secret,s,guard,api,spawner=spawnWorker,closer=closeout}){
 S.newRecord(run,'execution-attempt.json',{runId:s.runId,pid:process.pid,atMs:Date.now(),exclusiveTarget:true});
 const args=['--repo',path.resolve(repo),'--run',path.resolve(run),'--secret',secret.path];
 const workers={};let upload=null,failure=null,closure=null;
 const close=reason=>{try{if(!S.optional(run,'closing.json'))S.newRecord(run,'closing.json',{runId:s.runId,reason,atMs:Date.now()});}catch{}};
 const onSignal=()=>close('OPERATOR_STOP');process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
 try{
  workers.collector=spawner('collector',args,run);
  await waitFor(async()=>{if(workers.collector.closed)C.fail('COLLECTOR_EARLY_EXIT');const h=await G.readJsonArtifact(S.file(run,'heartbeat.json'),16384);return !W.health(h,s,Date.now())&&!h.diagnosticFailure;},20000);
  workers.guard=spawner('recovery-worker',[...args,'--execute'],run);
  const ready=async()=>{if(workers.guard.closed)C.fail('GUARD_EARLY_EXIT');const g=await G.readJsonArtifact(S.file(run,'guard-ready.json'),16384);
   if(g?.runId!==s.runId||g.state!=='ready'||Date.now()-g.updatedAtMs>10000)return false;
   const h=await G.readJsonArtifact(S.file(run,'heartbeat.json'),16384);return !W.health(h,s,Date.now(),g.collectorPid)&&!h.diagnosticFailure;};
  await waitFor(ready,20000);
  upload=await A.uploadOnce(api,guard,s,run,async()=>{if(!await ready()||S.optional(run,'closing.json'))C.fail('GUARD_NOT_READY_FOR_UPLOAD');});
  if(!upload.confirmed)close('UPLOAD_UNCONFIRMED');
  const end=performance.now()+s.wallLimitMs+360000;
  while(!workers.guard.closed&&performance.now()<end){
   if(workers.collector.closed&&!S.optional(run,'closing.json'))close('COLLECTOR_EXITED');
   const h=await G.readJsonArtifact(S.file(run,'guard-ready.json'),16384);
   if(h?.state==='ready'&&Date.now()-h.updatedAtMs>30000)close('GUARD_HEARTBEAT_STALE');
   await C.pause(500);
  }
  if(!workers.guard.closed){close('PARENT_WALL_DEADLINE');C.fail('GUARD_STILL_RUNNING');}
 }catch(e){failure={error:C.code(e),atMs:Date.now()};close(failure.error);}
 if(workers.guard&&!workers.guard.closed){try{await waitFor(()=>workers.guard.closed,360000);}catch{}}
 if(workers.guard&&!workers.guard.closed){
  const r={runId:s.runId,status:'ONLINE_CLOSE_UNCONFIRMED',failure,guardStillRunning:true,atMs:Date.now()};S.newRecord(run,'driver-result.json',r);
  process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);workers.guard.child.unref();workers.collector?.child.unref();return r;
 }
 // Only an exited worker permits a second actor. The attempt quota is still shared.
 const g=S.optional(run,'guard-result.json');closure=g?.closure;
 if(S.optional(run,'upload-attempt.json')&&!closure?.runtimeConfirmed){
  try{closure=await closer({api,guard,s,run,secret,actor:'supervisor'});}catch(e){closure={status:'ONLINE_CLOSE_UNCONFIRMED',error:C.code(e),runtimeConfirmed:false};}
 }
 if(workers.collector&&!workers.collector.closed){
  try{if(!S.optional(run,'collector-stop.json'))S.newRecord(run,'collector-stop.json',{runId:s.runId,reason:S.optional(run,'upload-attempt.json')?'observation_closed':'no_upload',atMs:Date.now()});await waitFor(()=>workers.collector.closed,15000);}
  catch(e){failure??={error:C.code(e)};workers.collector.child.unref();}
 }
 const r={runId:s.runId,status:!S.optional(run,'upload-attempt.json')?'NOT_DEPLOYED':closure?.status||'ONLINE_CLOSE_UNCONFIRMED',
 upload,failure,closure,collectorExit:workers.collector?.exit??null,guardExit:workers.guard?.exit??null,atMs:Date.now()};
 S.newRecord(run,'driver-result.json',r);process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);return r;
}
module.exports={spawnWorker,waitFor,execute};
