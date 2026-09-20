'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');const C=require('./common.cjs'),P=C.POLICY,I=require('./identity.cjs'),O=require('./observer.cjs');
const RETRY=new Set(['HTTP_DEADLINE','HTTP_TRANSPORT_ERROR','HTTP_BODY_ABORTED','HTTP_BODY_ERROR','HTTP_REQUEST_FAILED','HTTP_TRANSIENT_STATUS']);
async function stableRead({api,origin,record,backupOnly=false,mono=()=>performance.now(),pause=C.pause,budgetMs=P.readDeadlineMs}){const end=mono()+budgetMs;let count=0,last=null,round=0;
 const budget=max=>{const rem=Math.floor(end-mono());if(rem<=0)C.fail('RECOVERY_READ_DEADLINE');return Math.min(max,rem);};
 while(mono()<end){try{const x=await I.readIdentity(api,origin,budget);if(mono()>=end)C.fail('RECOVERY_READ_DEADLINE');record({kind:'identity-read',round:++round,...x});if(backupOnly&&x.state!=='CURRENT_IS_BACKUP'){count=0;last=null;}else{count=x.state===last?count+1:1;last=x.state;if(count>=P.stableReads)return x;}}
  catch(e){const c=C.code(e);record({kind:'identity-read-failed',round:++round,error:c});if(!RETRY.has(c))throw e;count=0;last=null;}
  const wait=backupOnly||count===0?P.readPauseMs:P.stablePauseMs;await pause(Math.min(wait,Math.max(0,end-mono())));
 }
 C.fail('RECOVERY_READ_DEADLINE');
}
function markShape(m,fingerprint){if(!C.obj(m)||m.authorizationId!==P.authorizationId||m.parentRunId!==P.parentRunId||m.backupHash!==P.backupDigest.hash||m.candidateHash!==P.candidateDigest.hash||m.packageFingerprint!==fingerprint||m.quotaConsumed!==true||!/^[a-f0-9]{32}$/.test(m.invocationId)||!Number.isSafeInteger(m.atMs))C.fail('RECOVERY_ATTEMPT_MARKER_INVALID');return m;}
function openLedger(origin,fingerprint){const root=path.join(origin.run,P.ledgerDirectory);if(!fs.existsSync(root))fs.mkdirSync(root,{mode:0o700});if(fs.lstatSync(root).isSymbolicLink())C.fail('LEDGER_SYMLINK');const identity={authorizationId:P.authorizationId,parentRunId:P.parentRunId,packageFingerprint:fingerprint};const p=path.join(root,'authorization.json');if(fs.existsSync(p)){if(!C.same(C.json(p),identity))C.fail('RECOVERY_LEDGER_IDENTITY_CHANGED');}else C.durable(p,identity);return root;}
async function recover({origin,api,secret,fingerprint,execute=false,exclusive=false,workersStopped=false,authorizeAdditional=false,reconcileOnly=false,mono=()=>performance.now(),pause=C.pause,observer=O.observe,verifyObserver=O.verify,readBudgetMs=P.readDeadlineMs}){
 if(!reconcileOnly&&!(execute&&exclusive&&workersStopped&&authorizeAdditional))C.fail('EXPLICIT_NEW_RECOVERY_AUTHORIZATION_REQUIRED');
 if(execute&&reconcileOnly)C.fail('AMBIGUOUS_RECOVERY_MODE');
 let lockFd;const lock=path.join(origin.run,'action.lock');
 if(!reconcileOnly){for(const n of ['collector.lock','guard.lock'])if(fs.existsSync(path.join(origin.run,n)))C.fail('ORIGINAL_WORKER_LOCK_PRESENT');try{lockFd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid,authorizationId:P.authorizationId,atMs:Date.now()}));fs.fsyncSync(lockFd);}catch{if(lockFd!==undefined)fs.closeSync(lockFd);C.fail('RECOVERY_ACTION_LOCK_PRESENT');}}
 try{const root=openLedger(origin,fingerprint),invocationId=crypto.randomBytes(16).toString('hex'),out=path.join(root,'invocation-'+invocationId);fs.mkdirSync(out,{mode:0o700});const attempt=path.join(root,'restore-attempt.json'),record=v=>C.append(path.join(out,'events.jsonl'),{atMs:Date.now(),authorizationId:P.authorizationId,parentRunId:P.parentRunId,invocationId,...v});
  C.durable(path.join(out,'input-verification.json'),origin.originSummary);C.durable(path.join(out,'invocation.json'),{authorizationId:P.authorizationId,parentRunId:P.parentRunId,invocationId,packageFingerprint:fingerprint,mode:reconcileOnly?'read-only':'new-authorized-restore',createdAtMs:Date.now()});
  let before=null,after=null,runtime=null,error=null,httpRestoreCalls=0,postOutcome=null,marker=null;
  try{if(fs.existsSync(attempt))marker=markShape(C.json(attempt),fingerprint);
   before=await stableRead({api,origin,record,mono,pause,budgetMs:readBudgetMs});
   if(before.state==='CURRENT_IS_CANDIDATE'&&!reconcileOnly&&!marker){
    // A fresh identity read directly precedes the durable write boundary. The local
    // action lock is not a remote server CAS; exclusive external ownership is required.
    const last=await stableRead({api,origin,record,mono,pause,budgetMs:readBudgetMs});before=last;
    if(last.state==='CURRENT_IS_CANDIDATE'){
     marker={authorizationId:P.authorizationId,parentRunId:P.parentRunId,invocationId,packageFingerprint:fingerprint,candidateHash:P.candidateDigest.hash,backupHash:P.backupDigest.hash,quotaConsumed:true,mayHaveBeenSent:true,originalRestoreAttempts:1,additionalRestoreAttempt:1,atMs:Date.now()};
     C.durable(attempt,marker);record({kind:'new-authorized-restore-boundary',candidateHash:P.candidateDigest.hash,backupHash:P.backupDigest.hash});
     httpRestoreCalls=1;try{const reply=await api.restore(origin.backup.modules,P.writeDeadlineMs);postOutcome={accepted:reply?.ok===1,error:null};}catch(e){postOutcome={accepted:null,error:C.code(e)};}
     C.durable(path.join(out,'post-result.json'),{...postOutcome,automaticRetry:false});
    }
   }
   // An existing marker (even after a crash before req.end) permanently disables POST.
   before=await stableRead({api,origin,record,backupOnly:true,mono,pause,budgetMs:readBudgetMs});C.durable(path.join(out,'code-before-runtime.json'),before);
   try{await observer({out,secret,invocationId});runtime=verifyObserver(out);C.durable(path.join(out,'runtime-verification.json'),runtime);}catch(e){error=C.code(e);}
   // Liveness failure must never suppress the final byte readback.
   after=await stableRead({api,origin,record,backupOnly:true,mono,pause,budgetMs:readBudgetMs});C.durable(path.join(out,'code-after-runtime.json'),after);
  }catch(e){error=C.code(e);record({kind:'recovery-stopped',error});}
  const beforeOk=before?.state==='CURRENT_IS_BACKUP',afterOk=after?.state==='CURRENT_IS_BACKUP';
  const status=error==='CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT'?'THIRD_PARTY_CODE_NOT_TOUCHED':beforeOk&&afterOk&&runtime?'RESTORED_BYTES_AND_RUNTIME_VERIFIED':beforeOk||afterOk?'RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED':'ONLINE_CLOSE_UNCONFIRMED';
  const result={status,authorizationId:P.authorizationId,parentRunId:P.parentRunId,invocationId,originalCaptureRemains:'CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE',originalRestorePostAttempts:1,additionalRestoreQuotaConsumed:fs.existsSync(attempt),httpRestoreCallsInThisInvocation:httpRestoreCalls,automaticWriteRetry:false,bytesConfirmed:beforeOk||afterOk,finalByteReadConfirmed:afterOk,runtimeConfirmed:Boolean(beforeOk&&afterOk&&runtime),before,after,runtime,error,postOutcome,atMs:Date.now()};
  C.durable(path.join(out,'result.json'),result);return {...result,evidenceDirectory:out};
 }finally{if(lockFd!==undefined){fs.closeSync(lockFd);fs.unlinkSync(lock);}}
}
module.exports={RETRY,stableRead,markShape,openLedger,recover};
