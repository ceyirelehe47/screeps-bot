'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const {performance}=require('node:perf_hooks');
const C=require('./common.cjs'),K=require('./pins.cjs'),I=require('./input.cjs'),P=require('../vendor/0003/protocol.cjs');
const {observeRuntime}=require('./closure-observer.cjs');
const hardReadFailure=code=>['HTTP_AUTH_REJECTED','ACCOUNT_MISMATCH_OR_UNREADABLE','ACTIVE_WORLD_CHANGED','ACTIVE_WORLD_NOT_UNIQUE','BRANCH_RESPONSE_INVALID'].includes(code);
async function readCurrent(api,s,record,{pause=C.pause}={}){
 let last;
 for(let attempt=1;attempt<=3;attempt++){
  const end=performance.now()+32000;let stage='account';const ms=()=>Math.max(1,Math.min(8000,end-performance.now()));
  try{
   P.account(await api.me(ms()));stage='active_branch_before';P.activeBranch(await api.branches(ms()));
   stage='code_read';const modules=P.modulesFromResponse(await api.code(ms()));
   stage='active_branch_after';P.activeBranch(await api.branches(ms()));
   const digest=P.describeModules(modules,I.guard),backup=P.equalModules(modules,s.backup.modules,I.guard),candidate=P.equalModules(modules,s.candidate.modules,I.guard);
   const result={state:backup?'CURRENT_IS_BACKUP':candidate?'CURRENT_IS_CANDIDATE':'CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT',
    capturedAtMs:Date.now(),digest,account:C.EXPECTED.username,branch:C.EXPECTED.branch};
   record({kind:'code-read',attempt,...result});return result;
  }catch(e){last={error:C.code(e),stage};record({kind:'code-read-failed',attempt,...last});
   if(hardReadFailure(last.error))break;if(attempt<3)await pause(K.readBackoffMs[attempt-1]);
  }
 }
 return {state:'ONLINE_CLOSE_UNCONFIRMED',...last,capturedAtMs:Date.now()};
}
function snapshotPrior(prior){return Object.fromEntries(C.list(prior).map(n=>{const b=C.bytes(path.join(prior,n));return [n,{bytes:b.length,sha256:C.sha256(b)}];}));}
function assertPriorUnchanged(prior,before,{markerAdded=false}={}){
 const after=snapshotPrior(prior),keys=Object.keys(before).sort();
 const expected=[...keys,...(markerAdded&&!keys.includes('restore-attempt.json')?['restore-attempt.json']:[])].sort();
 if(!C.same(Object.keys(after).sort(),expected))C.fail('PRIOR_FILE_SET_CHANGED');
 for(const n of keys)if(!C.same(before[n],after[n]))C.fail('PRIOR_BYTES_CHANGED');return {originalFiles:keys.length,unchanged:true,newRestoreMarker:markerAdded};
}
async function close0003({api,s,prior,out,executeRecovery=false,exclusiveTarget=false,priorWorkersStopped=false,secret,
 pause=C.pause,observer=observeRuntime,isCancelled=()=>false}){
 if(executeRecovery&&(!exclusiveTarget||!priorWorkersStopped))C.fail('EXCLUSIVE_STOPPED_ATTESTATIONS_REQUIRED');
 I.ensureStopped(prior);const priorHashes=snapshotPrior(prior);const closureId=crypto.randomBytes(16).toString('hex');
 C.mkdirNew(out);C.durable(path.join(out,'prior-file-hashes-before.json'),priorHashes);const record=v=>C.log(path.join(out,'closure-events.jsonl'),{closureId,parentRunId:s.runId,...v});
 C.durable(path.join(out,'closure-start.json'),{closureId,parentRunId:s.runId,atMs:Date.now(),executeRecovery,exclusiveTarget,priorWorkersStopped,
  originalObservationStatus:'ONLINE_COMPAT_READ_INCONCLUSIVE',newCandidateUploadAuthorized:false});
 let markerAdded=false,attempted=false,accepted=null,writeError=null,initial=null,before=null,after=null,runtime=null,failure=null,priorIntegrity=null;
 try{
  initial=await readCurrent(api,s,record,{pause});C.durable(path.join(out,'initial-code-state.json'),initial);
  if(initial.state==='CURRENT_IS_CANDIDATE'&&executeRecovery){
   await C.actionLock(prior,async()=>{
    const existing=I.ledger(prior,s);
    if(existing){C.durable(path.join(out,'restore-marker.json'),existing);record({kind:'restore-skipped',reason:'RESTORE_ALREADY_ATTEMPTED'});return;}
    // Recheck remote identity under the original action lock; reads may retry but POST never does.
    const check=await readCurrent(api,s,record,{pause});C.durable(path.join(out,'prewrite-code-state.json'),check);
    if(check.state!=='CURRENT_IS_CANDIDATE'){record({kind:'restore-skipped',reason:check.state});return;}
    if(isCancelled())C.fail('OPERATOR_STOP_BEFORE_WRITE');
    const marker={runId:s.runId,candidateHash:s.candidate.digest.hash,backupHash:s.backup.digest.hash,startedAtMs:Date.now(),
     recoveryClosureId:closureId,authorizedBy:'0003-recovery-remediation-I'};
    // Same durable marker as 0003, never renamed, erased, replaced or recreated by this tool.
    C.durable(path.join(prior,'restore-attempt.json'),marker);markerAdded=true;
    C.durable(path.join(out,'restore-marker.json'),marker);
    record({kind:'restore-post-boundary',markerSha256:C.sha256(C.bytes(path.join(prior,'restore-attempt.json')))});
    attempted=true;
    try{const response=await api.restoreBackup(s.backup.modules);accepted=response?.ok===1;if(!accepted)C.fail('API_RESULT_NOT_SUCCESS');}
    catch(e){writeError=C.code(e);}
    C.durable(path.join(out,'restore-write-result.json'),{requestAttempted:true,serverAccepted:accepted,error:writeError,
     runId:s.runId,closureId,postRetryAllowed:false});
   });
  }
  // Read-only mode does not start a new observer. Recovery mode verifies state independently of old collector.
  if(executeRecovery){
   before=await readCurrent(api,s,record,{pause});C.durable(path.join(out,'code-before-runtime.json'),before);
   if(before.state==='CURRENT_IS_BACKUP'&&!isCancelled()){
    try{runtime=await observer({out,closureId,parentRunId:s.runId,secret,isCancelled});}
    catch(e){runtime={status:'RECOVERY_RUNTIME_UNCONFIRMED',reason:C.code(e)};}
    // Always perform an independent final code read, even when the recovery-only observer failed.
    after=await readCurrent(api,s,record,{pause});C.durable(path.join(out,'code-after-runtime.json'),after);
   }
  }
 }catch(e){failure={error:C.code(e)};try{record({kind:'closure-failure',...failure});}catch{}}
 try{priorIntegrity=assertPriorUnchanged(prior,priorHashes,{markerAdded});C.durable(path.join(out,'prior-file-hashes-after.json'),snapshotPrior(prior));}catch(e){failure={error:C.code(e)};}
 const bytesConfirmed=!failure&&(after||before||initial)?.state==='CURRENT_IS_BACKUP';
 const runtimeCollected=runtime?.status==='RECOVERY_RUNTIME_COLLECTED';
 const runtimeConfirmed=bytesConfirmed&&runtimeCollected&&before?.state==='CURRENT_IS_BACKUP'&&after?.state==='CURRENT_IS_BACKUP';
 const state=after?.state||before?.state||initial?.state;
 const status=runtimeConfirmed?'RECOVERY_CLOSURE_COLLECTED':bytesConfirmed?'RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED':
  state==='CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT'?state:state==='CURRENT_IS_CANDIDATE'?'RESTORE_STILL_REQUIRED':'ONLINE_CLOSE_UNCONFIRMED';
 const result={status,closureId,parentRunId:s.runId,readOnly:!executeRecovery,requestAttempted:attempted,serverAccepted:accepted,writeError,
  bytesConfirmed,runtimeCollected,runtimeConfirmed,originalObservationStatus:'ONLINE_COMPAT_READ_INCONCLUSIVE',
  newCandidateUploads:0,priorIntegrity,failure,atMs:Date.now()};
 C.durable(path.join(out,'closure-result.json'),result);return result;
}
module.exports={readCurrent,close0003,snapshotPrior,assertPriorUnchanged};
