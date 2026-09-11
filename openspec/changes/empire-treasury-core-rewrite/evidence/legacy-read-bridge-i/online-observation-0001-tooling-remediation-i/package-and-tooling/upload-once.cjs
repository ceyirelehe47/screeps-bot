#!/usr/bin/env node
'use strict';
const path=require('node:path');const fs=require('node:fs');
const C=require('./common.cjs');const {client}=require('./transport.cjs');const {upload}=require('./operations.cjs');const {loadSession,heartbeatReason}=require('./session.cjs');
async function main(argv) {
  const o=C.options(argv,['repo','secret','run'],['execute']);C.required(o,'repo','secret','run');
  const secret=C.loadSecret(o.secret),g=C.assertCandidate(o.repo),s=loadSession(o.run,g.guard);
  if(g.head!==s.profileHead||g.tree!==s.profileTree)C.fail('PROFILE_HEAD_CHANGED');
  const attemptFile=path.join(o.run,'upload-attempt.json'),closing=path.join(o.run,'closing.json');
  function canStart(){
    if(fs.existsSync(attemptFile))C.fail('UPLOAD_ALREADY_ATTEMPTED');
    if(fs.existsSync(closing))C.fail('SESSION_CLOSING');
    if(Date.now()-s.preparedAtMs>15*60*1000)C.fail('PREPARATION_EXPIRED');
    const ready=C.readJson(path.join(o.run,'guard-ready.json'),16384);
    if(ready.runId!==s.runId||!Number.isSafeInteger(ready.pid)||ready.pid<=0||ready.state!=='ready'
      ||ready.updatedAtMs>Date.now()+1000||Date.now()-ready.updatedAtMs>5000)C.fail('GUARD_NOT_READY');
    try{process.kill(ready.pid,0);}catch{C.fail('GUARD_NOT_ALIVE');}
    const h=C.readJson(path.join(o.run,'heartbeat.json'),16384);
    if(heartbeatReason(h,s,Date.now()))C.fail('COLLECTOR_NOT_READY');
  }
  if(o.execute)canStart();
  const result=await C.actionLock(o.run,()=>upload(client(secret),g.guard,s.backup,s.candidate,
    {profile:s.profile,execute:!!o.execute,canStart,markAttempt:()=>C.writeNew(attemptFile,
      {runId:s.runId,startedAtMs:Date.now(),pid:process.pid,profileHead:s.profileHead,candidateHash:s.candidate.digest.hash})}));
  let auditFailed=false;
  if(o.execute){try{C.atomicJson(path.join(o.run,'upload-result.json'),{runId:s.runId,candidateHash:s.candidate.digest.hash,result,atMs:Date.now()});}catch{auditFailed=true;}}
  try{C.audit(path.join(o.run,'upload.jsonl'),result,secret.redact);}catch{auditFailed=true;}
  if(o.execute&&(!result.confirmed||auditFailed)){
    try{C.atomicJson(closing,{runId:s.runId,reason:auditFailed?'upload_audit_failure':'upload_unconfirmed',atMs:Date.now()});}catch{auditFailed=true;}
  }
  if(auditFailed){result.auditFailed=true;result.status='UPLOAD_AUDIT_UNCONFIRMED';}
  console.log(secret.redact(JSON.stringify(result)));
  if(o.execute&&(!result.confirmed||auditFailed))process.exitCode=6;
}
module.exports={main};if(require.main===module)C.entrypoint(()=>main(process.argv.slice(2)));
