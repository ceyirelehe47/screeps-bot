'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('./common.cjs'),S=require('./store.cjs'),A=require('./actions.cjs');
const {observeRuntime}=require('./closure-observer.cjs'),{verifyObserver}=require('./verify-runtime.cjs');
/** Never reuses the diagnostic collector. Each actor writes a separate immutable closure
 * directory, but every actor shares ONE upload/restore ledger and action lock in run. */
async function closeout({api,guard,s,run,secret,actor,observer=observeRuntime,verify=verifyObserver,pause=C.pause}){
 if(!['worker','supervisor','operator'].includes(actor))C.fail('RECOVERY_ACTOR_INVALID');
 const out=path.join(run,'recovery-'+actor);fs.mkdirSync(out,{recursive:false,mode:0o700});const closureId=crypto.randomBytes(16).toString('hex');
 C.durable(path.join(out,'closure-start.json'),{closureId,parentRunId:s.runId,actor,atMs:Date.now(),observationContinuation:false});
 let restoration,before,after,runtime=null,runtimeVerification=null,error=null;
 try{restoration=await A.restoreOnce(api,guard,s,run,{pause});}catch(e){restoration={status:'ONLINE_CLOSE_UNCONFIRMED',confirmed:false,error:C.code(e)};}
 C.durable(path.join(out,'restore-result.json'),restoration);
 // Request observation shutdown regardless of sample success; this is not a recovery precondition.
 if(!S.optional(run,'collector-stop.json'))S.newRecord(run,'collector-stop.json',{runId:s.runId,reason:'observation_closed',atMs:Date.now()});
 if(S.optional(run,'upload-attempt.json')){
  before=await A.reconcileReadOnly(api,guard,s,run,{pause});C.durable(path.join(out,'code-before-runtime.json'),before);
  if(before.confirmed){
   try{runtime=await observer({out,closureId,parentRunId:s.runId,secret});runtimeVerification=verify(out,closureId,s.runId);}
   catch(e){error=C.code(e);}
   // Runtime failure never suppresses the final independent identity/byte read.
   after=await A.reconcileReadOnly(api,guard,s,run,{pause});C.durable(path.join(out,'code-after-runtime.json'),after);
  }
 }
 const bytesConfirmed=Boolean((after||before)?.confirmed);
 const uploadOutcomeResolved=Boolean(S.optional(run,'upload-result.json')?.result?.confirmed===true||S.optional(run,'restore-attempt.json'));
 const runtimeConfirmed=Boolean(bytesConfirmed&&uploadOutcomeResolved&&before?.confirmed&&after?.confirmed&&runtimeVerification);
 const status=!S.optional(run,'upload-attempt.json')?'NOT_DEPLOYED':runtimeConfirmed?'RESTORED_BYTES_AND_RUNTIME_VERIFIED':
 bytesConfirmed&&uploadOutcomeResolved?'RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED':'ONLINE_CLOSE_UNCONFIRMED';
 const result={status,closureId,parentRunId:s.runId,actor,bytesConfirmed,uploadOutcomeResolved,runtimeConfirmed,error,runtimeVerification,atMs:Date.now()};
 C.durable(path.join(out,'closure-result.json'),result);return result;
}
module.exports={closeout};
