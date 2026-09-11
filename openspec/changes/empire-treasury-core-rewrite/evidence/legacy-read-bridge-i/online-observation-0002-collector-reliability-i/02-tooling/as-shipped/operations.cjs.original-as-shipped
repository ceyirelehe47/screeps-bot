'use strict';
const {performance}=require('node:perf_hooks');
const {fail,remaining,EXPECTED,PRODUCTION_BASE,ORIGINAL_DIGEST}=require('./common.cjs');
const P=require('./protocol.cjs');
async function preflight(api,guard,{budgetMs=30000,now=Date.now,expectedOriginalDigest=ORIGINAL_DIGEST}={}) {
  const deadline=performance.now()+budgetMs;
  P.account(await api.me(remaining(deadline)));
  const branch=P.activeBranch(await api.branches(remaining(deadline)));
  const modules=P.modulesFromResponse(await api.code(branch,remaining(deadline)));
  P.activeBranch(await api.branches(remaining(deadline)),branch);
  if(JSON.stringify(P.describeModules(modules,guard))!==JSON.stringify(expectedOriginalDigest))fail('ONLINE_BASELINE_BYTES_CHANGED');
  const build=P.buildIdentity(modules.main);
  if(build.commit!==PRODUCTION_BASE)fail('ONLINE_BASELINE_CHANGED');
  const rooms=P.ownedRooms(await api.overview(EXPECTED.shard,remaining(deadline)));
  const t=await api.time(EXPECTED.shard,remaining(deadline));
  if(t.ok!==1||!Number.isSafeInteger(t.time)||t.time<0)fail('GAME_TICK_UNREADABLE');
  return {snapshot:P.makeSnapshot(modules,guard,EXPECTED,now()), build, observedTick:t.time, ownedRooms:rooms};
}
/** Return status is deliberately about confirmed remote bytes, not merely a submitted POST. */
async function restore(api,guard,backup,deployed,{execute=false,budgetMs=30000,event=()=>{},unresolvedUpload=false}={}) {
  const deadline=performance.now()+budgetMs;
  P.validateSnapshot(backup,guard);P.validateSnapshot(deployed,guard);
  if(P.equalModules(backup.modules,deployed.modules,guard))fail('IDENTICAL_BACKUP_AND_DEPLOYMENT');
  P.account(await api.me(remaining(deadline)));
  P.activeBranch(await api.branches(remaining(deadline)));
  const current=P.modulesFromResponse(await api.code(EXPECTED.branch,remaining(deadline)));
  if(P.equalModules(current,backup.modules,guard)) {
    // A local upload timeout cannot establish that the server will never apply it.
    if(unresolvedUpload)return {status:'ONLINE_CLOSE_UNCONFIRMED',reason:'UPLOAD_OUTCOME_UNRESOLVED',requestAttempted:false,serverAccepted:null,confirmed:false};
    return {status:'ALREADY_RESTORED',requestAttempted:false,serverAccepted:null,confirmed:true};
  }
  if(!P.equalModules(current,deployed.modules,guard)) return {status:'CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT',requestAttempted:false,serverAccepted:null,confirmed:false};
  if(!execute)return {status:'DRY_RUN_WOULD_RESTORE',requestAttempted:false,serverAccepted:null,confirmed:false};
  // Recheck current world branch immediately before POST. This is NOT server-side CAS.
  P.activeBranch(await api.branches(remaining(deadline)));
  let requestAttempted=false,serverAccepted=null,auditFailed=false;
  try{event({kind:'restore-request-start'});}catch{auditFailed=true;}
  try {
    requestAttempted=true;
    const r=await api.setCode(EXPECTED.branch,backup.modules,remaining(deadline));
    serverAccepted=r?.ok===1;
    if(!serverAccepted)fail('API_RESULT_NOT_SUCCESS');
    const after=P.modulesFromResponse(await api.code(EXPECTED.branch,remaining(deadline)));
    P.activeBranch(await api.branches(remaining(deadline)));
    if(!P.equalModules(after,backup.modules,guard))fail('RESTORE_READBACK_MISMATCH');
    return {status:'RESTORED_AND_VERIFIED',requestAttempted,serverAccepted,confirmed:true,auditFailed};
  }catch{
    // A timeout after POST might have committed remotely. Never resend automatically.
    return {status:'ONLINE_CLOSE_UNCONFIRMED',requestAttempted,serverAccepted,confirmed:false,auditFailed};
  }
}
async function upload(api,guard,backup,deployed,{profile,execute=false,markAttempt=()=>{},canStart=()=>{},budgetMs=30000}={}) {
  const deadline=performance.now()+budgetMs;
  P.validateSnapshot(backup,guard);P.validateSnapshot(deployed,guard);
  if(P.equalModules(backup.modules,deployed.modules,guard))fail('IDENTICAL_BACKUP_AND_DEPLOYMENT');
  P.account(await api.me(remaining(deadline)));P.activeBranch(await api.branches(remaining(deadline)));
  const current=P.modulesFromResponse(await api.code(EXPECTED.branch,remaining(deadline)));
  if(!P.equalModules(current,backup.modules,guard))fail('ONLINE_BASELINE_CHANGED');
  const rooms=P.ownedRooms(await api.overview(EXPECTED.shard,remaining(deadline)));
  if(!profile.rooms?.length||profile.rooms.some(r=>!rooms.includes(r)))fail('OBSERVATION_ROOM_NOT_OWNED');
  const t=await api.time(EXPECTED.shard,remaining(deadline));
  if(t.ok!==1||!Number.isSafeInteger(t.time)||t.time<0||t.time>profile.startTick-100)fail('INSUFFICIENT_LIVE_TICK_LEAD');
  P.activeBranch(await api.branches(remaining(deadline)));
  if(!execute)return {status:'DRY_RUN_WOULD_UPLOAD',requestAttempted:false,confirmed:false};
  canStart();
  // This callback must durably create the one-use local attempt marker BEFORE POST.
  markAttempt();
  let accepted=null;
  try {
    const r=await api.setCode(EXPECTED.branch,deployed.modules,remaining(deadline));accepted=r?.ok===1;
    if(!accepted)fail('API_RESULT_NOT_SUCCESS');
    const after=P.modulesFromResponse(await api.code(EXPECTED.branch,remaining(deadline)));
    P.activeBranch(await api.branches(remaining(deadline)));
    if(!P.equalModules(after,deployed.modules,guard))fail('UPLOAD_READBACK_MISMATCH');
    return {status:'UPLOADED_AND_READBACK_VERIFIED',requestAttempted:true,serverAccepted:accepted,confirmed:true};
  }catch{return {status:'UPLOAD_UNCONFIRMED',requestAttempted:true,serverAccepted:accepted,confirmed:false};}
}
module.exports={preflight,restore,upload};
