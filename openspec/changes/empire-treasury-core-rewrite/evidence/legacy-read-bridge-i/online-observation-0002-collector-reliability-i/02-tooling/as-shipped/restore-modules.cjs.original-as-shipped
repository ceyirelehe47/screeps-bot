#!/usr/bin/env node
'use strict';
const path=require('node:path');const fs=require('node:fs');const {performance}=require('node:perf_hooks');
const C=require('./common.cjs');const {client}=require('./transport.cjs');const {restore}=require('./operations.cjs');const {loadSession}=require('./session.cjs');
async function main(argv) {
  const o=C.options(argv,['repo','secret','run'],['execute']);C.required(o,'repo','secret','run');
  const secret=C.loadSecret(o.secret),guard=C.loadGuard(o.repo),s=loadSession(o.run,guard),end=performance.now()+40000;
  let auditFailed=false;const record=x=>{try{C.audit(path.join(o.run,'restore.jsonl'),x,secret.redact);}catch{auditFailed=true;}};
  let result;
  let unresolvedUpload=false;
  if(fs.existsSync(path.join(o.run,'upload-attempt.json'))){
    unresolvedUpload=true;
    try{const u=C.readJson(path.join(o.run,'upload-result.json'),16384);
      unresolvedUpload=!(u.runId===s.runId&&u.candidateHash===s.candidate.digest.hash&&u.result?.confirmed===true&&u.result?.status==='UPLOADED_AND_READBACK_VERIFIED');
    }catch{}
  }
  try {
    result=await C.actionLock(o.run,()=>restore(client(secret),guard,s.backup,s.candidate,
      {execute:!!o.execute,budgetMs:Math.min(30000,C.remaining(end)),event:record,unresolvedUpload}),Math.min(10000,C.remaining(end)));
  } catch(e) {result={status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,...C.safeFailure(e)};}
  record({kind:'restore-result',...result});result.auditFailed=auditFailed||!!result.auditFailed;
  try{C.atomicJson(path.join(o.run,'restore-result.json'),result);}catch{result.auditFailed=true;}
  console.log(secret.redact(JSON.stringify(result)));
  if(!result.confirmed||result.auditFailed)process.exitCode=6;
}
module.exports={main};if(require.main===module)C.entrypoint(()=>main(process.argv.slice(2)));
