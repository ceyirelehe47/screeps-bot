'use strict';
const fs=require('node:fs');
const C=require('./common.cjs'),P=require('./protocol.cjs'),S=require('./store.cjs'),K=require('./policy.cjs');
const codeOf=C.code;
function event(run,data){C.log(S.file(run,'actions.jsonl'),data);}
function hardFailure(e){return ['ACCOUNT_MISMATCH_OR_UNREADABLE','ACTIVE_WORLD_CHANGED','ACTIVE_WORLD_NOT_UNIQUE',
 'BRANCH_RESPONSE_INVALID','HTTP_AUTH_REJECTED','MODULES_NOT_OBJECT','MODULES_FIELD_MISSING','MODULE_VALUE_INVALID'].includes(C.code(e));}
/** Restore identity reads deliberately have NO game/time or overview dependency. Reads may
 * retry; every remote write has one durable attempt marker and is never automatically retried. */
async function current(api,guard,{record=()=>{},pause=C.pause}={}){
 let last;
 for(let attempt=1;attempt<=3;attempt++){
  let stage='account';
  try{
   P.account(await api.me(8000));stage='active_branch_before';P.activeBranch(await api.branches(8000));
   stage='modules';const modules=P.modulesFromResponse(await api.code(C.EXPECTED.branch,8000));
   stage='active_branch_after';P.activeBranch(await api.branches(8000));
   const result={modules,digest:P.describeModules(modules,guard),build:P.buildIdentity(modules.main),capturedAtMs:Date.now()};
   record({kind:'identity-read',attempt,atMs:result.capturedAtMs,digest:result.digest,build:result.build});return result;
  }catch(e){last=e;record({kind:'identity-read-failed',attempt,stage,error:C.code(e),atMs:Date.now()});if(hardFailure(e))break;
   if(attempt<3)await pause([2000,5000][attempt-1]);}
 }
 throw last;
}
function assertRestoreMarker(m,s){if(!m||m.runId!==s.runId||m.candidateHash!==s.candidate.digest.hash||m.backupHash!==s.backup.digest.hash||!Number.isSafeInteger(m.startedAtMs))C.fail('RESTORE_MARKER_INVALID');}
function classify(x,s,guard){return P.equalModules(x.modules,s.backup.modules,guard)?'CURRENT_IS_BACKUP':
 P.equalModules(x.modules,s.candidate.modules,guard)?'CURRENT_IS_CANDIDATE':'CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT';}
async function reconcileReadOnly(api,guard,s,run,{pause=C.pause}={}){
 try{const x=await current(api,guard,{pause,record:v=>event(run,{runId:s.runId,...v})});const status=classify(x,s,guard);
  return {status,confirmed:status==='CURRENT_IS_BACKUP',atMs:x.capturedAtMs,digest:x.digest,build:x.build};
 }catch(e){return {status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,error:codeOf(e),atMs:Date.now()};}
}
async function uploadOnce(api,guard,s,run,canStart=async()=>{}){
 return C.actionLock(run,async()=>{
  if(['upload-attempt.json','restore-attempt.json','closing.json'].some(n=>fs.existsSync(S.file(run,n))))C.fail('UPLOAD_ALREADY_ATTEMPTED_OR_CLOSING');
  const before=await current(api,guard,{record:v=>event(run,{runId:s.runId,...v})});
  if(!P.equalModules(before.modules,s.backup.modules,guard))C.fail('ONLINE_BASELINE_CHANGED');
  const rooms=P.ownedRooms(await api.overview(C.EXPECTED.shard,8000));if(K.ROOMS.some(r=>!rooms.includes(r)))C.fail('OBSERVATION_ROOM_NOT_OWNED');
  P.activeBranch(await api.branches(8000));const live=await api.time(s.shard,8000);
  if(live?.ok!==1||!Number.isSafeInteger(live.time)||live.time<s.observedTick||live.time>s.profile.startTick-100)C.fail('PROFILE_WINDOW_EXPIRED');
  await canStart();
  S.newRecord(run,'upload-attempt.json',{runId:s.runId,candidateHash:s.candidate.digest.hash,profileHead:s.profileHead,startedAtMs:Date.now(),observedTick:live.time});
  event(run,{kind:'code-write-boundary',action:'candidate',runId:s.runId,atMs:Date.now()});
  let accepted=null,result;
  try{
   const r=await api.setCode(s.branch,s.candidate.modules,8000);accepted=r?.ok===1;if(!accepted)C.fail('API_RESULT_NOT_SUCCESS');
   const after=await current(api,guard,{record:v=>event(run,{runId:s.runId,...v})});
   if(!P.equalModules(after.modules,s.candidate.modules,guard))C.fail('UPLOAD_READBACK_MISMATCH');
   result={status:'UPLOADED_AND_READBACK_VERIFIED',confirmed:true,serverAccepted:true,requestAttempted:true,digest:after.digest,build:after.build,atMs:Date.now()};
  }catch(e){result={status:'UPLOAD_UNCONFIRMED',confirmed:false,serverAccepted:accepted,requestAttempted:true,error:codeOf(e),atMs:Date.now()};}
  S.newRecord(run,'upload-result.json',{runId:s.runId,candidateHash:s.candidate.digest.hash,result});return result;
 });
}
async function restoreOnce(api,guard,s,run,{pause=C.pause}={}){
 return C.actionLock(run,async()=>{
  const a=S.optional(run,'upload-attempt.json');if(!a)return {status:'NOT_DEPLOYED_NO_RESTORE_NEEDED',confirmed:true,requestAttempted:false,atMs:Date.now()};
  S.assertAttempt(a,s);const mark=S.optional(run,'restore-attempt.json');if(mark)assertRestoreMarker(mark,s);
  const before=await current(api,guard,{pause,record:v=>event(run,{runId:s.runId,...v})});const state=classify(before,s,guard);
  if(state==='CURRENT_IS_BACKUP')return {status:'ALREADY_RESTORED',confirmed:true,requestAttempted:false,digest:before.digest,atMs:Date.now()};
  if(state!=='CURRENT_IS_CANDIDATE')return {status:state,confirmed:false,requestAttempted:false,atMs:Date.now()};
  if(mark)return {status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,requestAttempted:false,reason:'RESTORE_ALREADY_ATTEMPTED',atMs:Date.now()};
  // Re-read immediately under the same action lock. Never replace third-party code.
  const prewrite=await current(api,guard,{pause,record:v=>event(run,{runId:s.runId,...v})});const last=classify(prewrite,s,guard);
  if(last==='CURRENT_IS_BACKUP')return {status:'ALREADY_RESTORED',confirmed:true,requestAttempted:false,digest:prewrite.digest,atMs:Date.now()};
  if(last!=='CURRENT_IS_CANDIDATE')return {status:last,confirmed:false,requestAttempted:false,atMs:Date.now()};
  S.newRecord(run,'restore-attempt.json',{runId:s.runId,candidateHash:s.candidate.digest.hash,backupHash:s.backup.digest.hash,startedAtMs:Date.now()});
  event(run,{kind:'code-write-boundary',action:'restore',runId:s.runId,atMs:Date.now()});
  let accepted=null,error=null;
  try{const r=await api.setCode(s.branch,s.backup.modules,8000);accepted=r?.ok===1;if(!accepted)C.fail('API_RESULT_NOT_SUCCESS');}catch(e){error=codeOf(e);}
  // Even when the POST reply was lost, readback is safe. The POST is NEVER resent.
  const after=await reconcileReadOnly(api,guard,s,run,{pause});
  return {status:after.confirmed?'RESTORED_BYTES_CONFIRMED':'ONLINE_CLOSE_UNCONFIRMED',confirmed:after.confirmed,requestAttempted:true,
   serverAccepted:accepted,error,digest:after.digest||null,readback:after,postRetryAllowed:false,atMs:Date.now()};
 },180000);
}
module.exports={codeOf,current,uploadOnce,restoreOnce,reconcileReadOnly,assertRestoreMarker,classify};
