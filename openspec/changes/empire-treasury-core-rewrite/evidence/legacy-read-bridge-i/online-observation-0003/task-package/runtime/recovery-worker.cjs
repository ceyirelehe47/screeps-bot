'use strict';
const fs=require('node:fs');const {performance}=require('node:perf_hooks');
const C=require('./common.cjs'),S=require('./store.cjs'),G=require('./guard-control.cjs'),W=require('./samples.cjs'),A=require('./actions.cjs');
const {client}=require('./transport.cjs');
function termination({s,h,attempt,upload,now,elapsed,tick,closing}){
 if(closing)return 'EXPLICIT_CLOSE';
 if(attempt&&(now-attempt.startedAtMs>=s.wallLimitMs||elapsed>=s.wallLimitMs))return 'WALL_DEADLINE';
 const health=W.health(h,s,now);if(health)return health;
 if(!attempt)return now-s.preparedAtMs>300000?'PREPARATION_EXPIRED':null;
 if(upload&&!upload.result?.confirmed)return 'UPLOAD_UNCONFIRMED';
 if(!upload&&now-attempt.startedAtMs>60000)return 'UPLOAD_RESULT_MISSING';
 if(h.lastBridgeTick===s.profile.endTick&&h.bridgeReports===12)return 'LAST_SAMPLE_RECEIVED';
 if(Number.isSafeInteger(tick)){
  if(tick>s.profile.endTick+20)return 'TICK_WINDOW_ENDED';
  if(tick>=s.profile.startTick+200&&(!Number.isSafeInteger(h.lastBridgeTick)||h.lastBridgeTick<tick-200))return 'BRIDGE_SAMPLE_STALLED';
 }
 return null;
}
async function guardLoop({s,run,api,guard,redact=C.redactor(),pause=C.pause,now=Date.now,mono=()=>performance.now()}){
 S.newRecord(run,'guard.lock',{runId:s.runId,pid:process.pid});
 let reason=null,failure=null,tick,seen=null,initialElapsed=0,pid=null,auditFailed=false,nextRead=0,stage='startup';
 const begun=mono(),state=G.createTimeChannelState(now());
 const event=v=>{try{C.audit(S.file(run,'guard-events.jsonl'),{runId:s.runId,...v},redact);}catch{auditFailed=true;}};
 const signal=()=>{reason='OPERATOR_STOP';};process.once('SIGINT',signal);process.once('SIGTERM',signal);
 event({kind:'guard-start',pid:process.pid});
 try{
  while(!reason){
   stage='heartbeat_read';
   const h=await G.readJsonArtifact(S.file(run,'heartbeat.json'),16384,{required:true});
   stage='upload_attempt_read';
   const a=await G.readJsonArtifact(S.file(run,'upload-attempt.json'),16384);
   stage='collector_result_read';
   const upload=await G.readJsonArtifact(S.file(run,'upload-result.json'),16384);
   if(a){S.assertAttempt(a,s);if(seen===null){seen=mono();initialElapsed=Math.max(0,now()-a.startedAtMs);}}
   if(pid===null)pid=h.pid;if(pid!==h.pid){reason='COLLECTOR_PID_CHANGED';break;}
   if(auditFailed){reason='AUDIT_IO_FAILURE';break;}
   reason=termination({s,h,attempt:a,upload,now:now(),elapsed:seen===null?0:initialElapsed+mono()-seen,tick,closing:fs.existsSync(S.file(run,'closing.json'))});
   if(reason)break;
   if(a&&mono()>=nextRead){
    const remaining=s.wallLimitMs-(initialElapsed+mono()-seen);
    stage='game_time_read';
    const r=await G.readGameTimeResilient({api,shard:s.shard,budgetMs:Math.max(1,Math.min(8000,Math.floor(remaining))),state,
     record:event,redact,now,pause});nextRead=mono()+15000;
    if(r.status==='terminal'){reason=r.failure.reason;failure=r.failure;break;}
    if(r.status==='ok'){if(tick!==undefined&&r.time<tick){reason='GAME_TICK_REGRESSED';break;}tick=r.time;}
   }
   stage='guard_ready_write';
   C.atomicJson(S.file(run,'guard-ready.json'),{runId:s.runId,pid:process.pid,state:'ready',updatedAtMs:now(),collectorPid:pid,tick:tick??null,
    controlPlane:state.consecutiveFailedCycles?'degraded':'healthy'});
   await pause(500);
  }
 }catch(e){const classified=G.classifyGuardFailure(stage,e);reason=classified.reason;failure={...classified,diagnostic:G.safeGuardDiagnostic(stage,e,redact)};event({kind:'guard-control-failure',failure});}
 event({kind:'close-trigger',reason,timeChannel:G.timeChannelSnapshot(state)});
 try{C.atomicJson(S.file(run,'closing.json'),{runId:s.runId,reason,atMs:now()});}catch{auditFailed=true;}
 try{C.atomicJson(S.file(run,'guard-ready.json'),{runId:s.runId,pid:process.pid,state:'closing',updatedAtMs:now()});}catch{auditFailed=true;}
 let restoration;
 try{restoration=await A.restoreOnce(api,guard,s,run);}catch(e){restoration={status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,error:A.codeOf(e),atMs:now()};}
 try{S.newRecord(run,'restore-result.json',restoration);}catch{auditFailed=true;}
 try{fs.unlinkSync(S.file(run,'guard.lock'));}catch{auditFailed=true;}
 const result={runId:s.runId,status:restoration.confirmed&&!auditFailed?'GUARD_CLOSED_CONFIRMED':'ONLINE_CLOSE_UNCONFIRMED',reason,
  restoration,auditFailed,failure,elapsedMs:Math.floor(mono()-begun),timeChannel:G.timeChannelSnapshot(state),atMs:now()};
 event({kind:'guard-finished',status:result.status});S.newRecord(run,'guard-result.json',result);
 process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);return result;
}
async function main(){const o=C.options(process.argv.slice(2),['repo','run','secret'],['execute']);C.required(o,'repo','run','secret');if(!o.execute)C.fail('EXPLICIT_EXECUTE_REQUIRED');
 const secret=C.loadSecret(o.secret),guard=C.loadGuard(o.repo),s=S.loadRun(o.run,guard);
 const r=await guardLoop({s,run:o.run,api:client(secret),guard,redact:secret.redact});console.log(JSON.stringify(r));process.exitCode=r.status==='GUARD_CLOSED_CONFIRMED'?0:6;
}
module.exports={termination,guardLoop};if(require.main===module)C.entrypoint(main);
