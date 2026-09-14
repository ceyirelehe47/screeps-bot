'use strict';
const {performance}=require('node:perf_hooks');
const C=require('./common.cjs');

/** Read-only retry policy. It may be used only for GET-like observations.
 * Candidate and recovery POSTs remain single-attempt and must never call this helper. */
const DEFAULT_READ_POLICY=Object.freeze({
  attempts:3,
  perAttemptMaxMs:2500,
  retryDelaysMs:Object.freeze([250,750]),
  retryHttpStatuses:Object.freeze([429,500,502,503,504]),
});
const TRANSIENT_CODES=new Set([
  'HTTP_TRANSPORT_ERROR','HTTP_DEADLINE','HTTP_BODY_ABORTED','HTTP_BODY_ERROR','HTTP_REQUEST_FAILED',
]);
function validPolicy(p){return p&&Number.isSafeInteger(p.attempts)&&p.attempts>=1&&p.attempts<=5
 &&Number.isSafeInteger(p.perAttemptMaxMs)&&p.perAttemptMaxMs>=100&&p.perAttemptMaxMs<=8000
 &&Array.isArray(p.retryDelaysMs)&&p.retryDelaysMs.length===p.attempts-1
 &&p.retryDelaysMs.every(x=>Number.isSafeInteger(x)&&x>=0&&x<=5000)
 &&Array.isArray(p.retryHttpStatuses)&&p.retryHttpStatuses.every(x=>Number.isSafeInteger(x)&&x>=400&&x<=599);
}
function retryable(error,policy=DEFAULT_READ_POLICY){
 const code=C.code(error);if(TRANSIENT_CODES.has(code))return true;
 return code==='HTTP_NOT_200'&&policy.retryHttpStatuses.includes(error?.details?.httpStatus);
}
function safeEvent(operation,attempt,outcome,error,extra={}){
 const code=error?C.code(error):null,status=Number.isSafeInteger(error?.details?.httpStatus)?error.details.httpStatus:null;
 return {kind:'read-only-attempt',operation,attempt,outcome,code,httpStatus:status,...extra};
}
async function readWithRetry({operation,budgetMs=8000,read,record=()=>{},pause=C.pause,now=()=>performance.now(),policy=DEFAULT_READ_POLICY}){
 if(typeof operation!=='string'||!/^[a-zA-Z0-9_.:-]{1,96}$/.test(operation)||typeof read!=='function'||typeof record!=='function'
  ||typeof pause!=='function'||typeof now!=='function'||!Number.isSafeInteger(budgetMs)||budgetMs<100||budgetMs>60000||!validPolicy(policy))C.fail('READ_RETRY_ARGUMENT_INVALID');
 const started=now(),deadline=started+budgetMs;let last;
 for(let attempt=1;attempt<=policy.attempts;attempt++){
  const remaining=Math.floor(deadline-now());
  if(remaining<=0){const e=new C.Failure('OPERATION_DEADLINE',{readOperation:operation,readAttempts:attempt-1});record(safeEvent(operation,attempt,'deadline',e,{remainingMs:0}));throw e;}
  const attemptBudget=Math.max(1,Math.min(policy.perAttemptMaxMs,remaining));
  try{
   const value=await read(attemptBudget,attempt);
   record(safeEvent(operation,attempt,'success',null,{attemptBudgetMs:attemptBudget,elapsedMs:Math.max(0,Math.floor(now()-started))}));
   return value;
  }catch(error){
   last=error;const canRetry=retryable(error,policy)&&attempt<policy.attempts;
   let delayMs=0;
   if(canRetry){
    const configured=policy.retryDelaysMs[attempt-1];
    const retryAfter=Number(error?.details?.retryAfterSeconds);
    const requested=Number.isFinite(retryAfter)&&retryAfter>=0?Math.ceil(retryAfter*1000):0;
    delayMs=Math.max(configured,Math.min(requested,2000));
   }
   const remainingAfter=Math.floor(deadline-now());
   const willRetry=canRetry&&remainingAfter>delayMs;
   record(safeEvent(operation,attempt,willRetry?'retry':'failed',error,{attemptBudgetMs:attemptBudget,delayMs:willRetry?delayMs:0,remainingMs:Math.max(0,remainingAfter)}));
   if(!willRetry)throw error;
   await pause(delayMs);
  }
 }
 throw last||new C.Failure('READ_RETRY_EXHAUSTED',{readOperation:operation});
}
module.exports={DEFAULT_READ_POLICY,TRANSIENT_CODES,validPolicy,retryable,readWithRetry};
