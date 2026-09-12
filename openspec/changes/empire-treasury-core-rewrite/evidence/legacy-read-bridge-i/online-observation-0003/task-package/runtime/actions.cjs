'use strict';
/** All remote writes are explicit one-use POSTs under one local action lock.
 * No server CAS exists. Exclusive ownership of the target branch is a prerequisite. */
const fs=require('node:fs');const {performance}=require('node:perf_hooks');
const C=require('./common.cjs'),P=require('./protocol.cjs'),S=require('./store.cjs'),K=require('./policy.cjs');
const codeOf=e=>/^[A-Z0-9_]{1,96}$/.test(e?.code||'')?e.code:'UNEXPECTED_LOCAL_FAILURE';
async function current(api,guard,{budgetMs=30000}={}){
 const deadline=performance.now()+budgetMs,ms=()=>C.remaining(deadline);
 P.account(await api.me(ms()));P.activeBranch(await api.branches(ms()));
 const modules=P.modulesFromResponse(await api.code(C.EXPECTED.branch,ms()));
 P.activeBranch(await api.branches(ms()));
 const t=await api.time(C.EXPECTED.shard,ms());
 if(t?.ok!==1||!Number.isSafeInteger(t.time)||t.time<0)C.fail('GAME_TICK_UNREADABLE');
 return {modules,digest:P.describeModules(modules,guard),build:P.buildIdentity(modules.main),observedTick:t.time,capturedAtMs:Date.now()};
}
async function uploadOnce(api,guard,s,run,canStart=()=>{}){
 return C.actionLock(run,async()=>{
  if(fs.existsSync(S.file(run,'upload-attempt.json'))||fs.existsSync(S.file(run,'restore-attempt.json'))||fs.existsSync(S.file(run,'closing.json')))C.fail('UPLOAD_ALREADY_ATTEMPTED_OR_CLOSING');
  const before=await current(api,guard);
  if(!P.equalModules(before.modules,s.backup.modules,guard))C.fail('ONLINE_BASELINE_CHANGED');
  const rooms=P.ownedRooms(await api.overview(C.EXPECTED.shard,8000));
  if(K.ROOMS.some(r=>!rooms.includes(r)))C.fail('OBSERVATION_ROOM_NOT_OWNED');
  // Re-read live time after every preflight read, not the earlier preparation tick.
  const live=await api.time(C.EXPECTED.shard,8000);
  if(live?.ok!==1||!Number.isSafeInteger(live.time)||live.time>s.profile.startTick-100)C.fail('PROFILE_WINDOW_EXPIRED');
  P.activeBranch(await api.branches(8000));await canStart();
  const attempt=S.newRecord(run,'upload-attempt.json',{runId:s.runId,candidateHash:s.candidate.digest.hash,profileHead:s.profileHead,startedAtMs:Date.now(),observedTick:live.time});
  let accepted=null,result;
  try{
   const r=await api.setCode(C.EXPECTED.branch,s.candidate.modules,8000);accepted=r?.ok===1;
   if(!accepted)C.fail('API_RESULT_NOT_SUCCESS');
   const after=P.modulesFromResponse(await api.code(C.EXPECTED.branch,8000));P.activeBranch(await api.branches(8000));
   if(!P.equalModules(after,s.candidate.modules,guard))C.fail('UPLOAD_READBACK_MISMATCH');
   result={status:'UPLOADED_AND_READBACK_VERIFIED',confirmed:true,serverAccepted:true,requestAttempted:true,digest:P.describeModules(after,guard),build:P.buildIdentity(after.main),atMs:Date.now()};
  }catch(e){result={status:'UPLOAD_UNCONFIRMED',confirmed:false,serverAccepted:accepted,requestAttempted:true,error:codeOf(e),atMs:Date.now()};}
  S.newRecord(run,'upload-result.json',{runId:s.runId,candidateHash:s.candidate.digest.hash,result});
  return result;
 });
}
async function restoreOnce(api,guard,s,run){
 return C.actionLock(run,async()=>{
  const a=S.optional(run,'upload-attempt.json');
  if(!a)return {status:'NOT_DEPLOYED_NO_RESTORE_NEEDED',confirmed:true,requestAttempted:false,atMs:Date.now()};
  S.assertAttempt(a,s);
  const uploaded=S.optional(run,'upload-result.json');
  const known=uploaded?.runId===s.runId&&uploaded?.candidateHash===s.candidate.digest.hash&&uploaded?.result?.confirmed===true;
  const before=await current(api,guard);
  if(P.equalModules(before.modules,s.backup.modules,guard))return {status:known?'ALREADY_RESTORED':'ONLINE_CLOSE_UNCONFIRMED',
   confirmed:known,requestAttempted:false,reason:known?null:'UPLOAD_OUTCOME_UNRESOLVED',digest:before.digest,atMs:Date.now()};
  if(!P.equalModules(before.modules,s.candidate.modules,guard))return {status:'CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT',confirmed:false,requestAttempted:false,atMs:Date.now()};
  if(fs.existsSync(S.file(run,'restore-attempt.json')))return {status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,requestAttempted:false,reason:'RESTORE_ALREADY_ATTEMPTED',atMs:Date.now()};
  P.activeBranch(await api.branches(8000));
  S.newRecord(run,'restore-attempt.json',{runId:s.runId,candidateHash:s.candidate.digest.hash,backupHash:s.backup.digest.hash,startedAtMs:Date.now()});
  let accepted=null;
  try{
   const r=await api.setCode(C.EXPECTED.branch,s.backup.modules,8000);accepted=r?.ok===1;
   if(!accepted)C.fail('API_RESULT_NOT_SUCCESS');
   const after=P.modulesFromResponse(await api.code(C.EXPECTED.branch,8000));P.activeBranch(await api.branches(8000));
   if(!P.equalModules(after,s.backup.modules,guard))C.fail('RESTORE_READBACK_MISMATCH');
   return {status:'RESTORED_AND_VERIFIED',confirmed:true,requestAttempted:true,serverAccepted:true,digest:P.describeModules(after,guard),atMs:Date.now()};
  }catch(e){return {status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,requestAttempted:true,serverAccepted:accepted,error:codeOf(e),atMs:Date.now()};}
 },10000);
}
async function reconcileReadOnly(api,guard,s,run,{pause=C.pause}={}){
 const checks=[];
 for(let i=0;i<3;i++){
  try{
   const r=await current(api,guard);
   const sameAsBackup=P.equalModules(r.modules,s.backup.modules,guard),sameAsCandidate=P.equalModules(r.modules,s.candidate.modules,guard);
   checks.push({atMs:r.capturedAtMs,sameAsBackup,sameAsCandidate,digest:r.digest,build:r.build,observedTick:r.observedTick});
   if(!sameAsBackup)return {status:sameAsCandidate?'CURRENT_IS_CANDIDATE':'CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT',confirmed:false,checks};
   const upload=S.optional(run,'upload-result.json'),restore=S.optional(run,'restore-attempt.json');
   if(upload?.result?.confirmed!==true&&!restore)return {status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,reason:'UPLOAD_OUTCOME_UNRESOLVED',checks};
   return {status:'CURRENT_IS_BACKUP',confirmed:true,checks};
  }catch(e){checks.push({atMs:Date.now(),error:codeOf(e)});if(i<2)await pause(2000);}
 }
 return {status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,checks};
}
module.exports={codeOf,current,uploadOnce,restoreOnce,reconcileReadOnly};
