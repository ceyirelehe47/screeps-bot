'use strict';
const fs=require('node:fs'),path=require('node:path');const C=require('./common.cjs'),P=C.POLICY,O=require('./observer.cjs'),R=require('./recovery.cjs');
const LEAVES=new Set(['input-verification.json','invocation.json','events.jsonl','post-result.json','code-before-runtime.json','code-after-runtime.json','runtime-console.jsonl','runtime-result.json','runtime-verification.json','result.json']);
function approved(name){if(['authorization.json','restore-attempt.json'].includes(name))return true;const p=name.split('/');return p.length===2&&/^invocation-[a-f0-9]{32}$/.test(p[0])&&LEAVES.has(p[1]);}
function verify(root,fingerprint){const files=C.list(root);if(files.some(n=>!approved(n)))C.fail('UNAPPROVED_RECOVERY_EVIDENCE_FILE');const a=C.json(path.join(root,'authorization.json'));if(a.authorizationId!==P.authorizationId||a.parentRunId!==P.parentRunId||a.packageFingerprint!==fingerprint)C.fail('RECOVERY_EVIDENCE_IDENTITY_INVALID');const ap=path.join(root,'restore-attempt.json');let mark=null;if(fs.existsSync(ap))mark=R.markShape(C.json(ap),fingerprint);
 const dirs=fs.readdirSync(root).filter(n=>/^invocation-[a-f0-9]{32}$/.test(n)),results=[];let boundaries=0,totalHttpCalls=0;
 for(const dir of dirs){const d=path.join(root,dir),meta=C.json(path.join(d,'invocation.json')),rp=path.join(d,'result.json');if(meta.packageFingerprint!==fingerprint||meta.parentRunId!==P.parentRunId||'invocation-'+meta.invocationId!==dir)C.fail('INVOCATION_IDENTITY_INVALID');
  const ep=path.join(d,'events.jsonl'),events=fs.existsSync(ep)?C.bytes(ep).toString('utf8').trimEnd().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
  if(events.some((e,i)=>e.parentRunId!==P.parentRunId||e.invocationId!==meta.invocationId||e.authorizationId!==P.authorizationId||!Number.isSafeInteger(e.atMs)||(i&&e.atMs<events[i-1].atMs)))C.fail('RECOVERY_EVENT_IDENTITY_INVALID');
  const writes=events.filter(e=>e.kind==='new-authorized-restore-boundary');boundaries+=writes.length;
  if(writes.length&&(!mark||mark.invocationId!==meta.invocationId||writes.some(w=>w.atMs<mark.atMs||w.backupHash!==P.backupDigest.hash||w.candidateHash!==P.candidateDigest.hash)))C.fail('RECOVERY_BOUNDARY_MARKER_MISMATCH');
  if(!fs.existsSync(rp)){results.push({invocationId:meta.invocationId,status:'INVOCATION_INTERRUPTED',runtimeConfirmed:false,atMs:meta.createdAtMs});continue;}
  const r=C.json(rp);if(r.parentRunId!==P.parentRunId||r.invocationId!==meta.invocationId||r.authorizationId!==P.authorizationId||![0,1].includes(r.httpRestoreCallsInThisInvocation)||r.originalRestorePostAttempts!==1||r.automaticWriteRetry!==false||r.originalCaptureRemains!=='CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE')C.fail('RECOVERY_RESULT_INVALID');totalHttpCalls+=r.httpRestoreCallsInThisInvocation;
  if(r.httpRestoreCallsInThisInvocation&&(!mark||mark.invocationId!==r.invocationId||writes.length!==1))C.fail('HTTP_CALL_WITHOUT_LEDGER_BOUNDARY');
  let independent=null;
  if(r.runtimeConfirmed||r.status==='RESTORED_BYTES_AND_RUNTIME_VERIFIED'){
   const before=C.json(path.join(d,'code-before-runtime.json')),after=C.json(path.join(d,'code-after-runtime.json')),runtime=C.json(path.join(d,'runtime-result.json'));
   for(const x of [before,after])if(x.state!=='CURRENT_IS_BACKUP'||!C.same(x.digest,P.backupDigest)||!C.same(x.build,P.backupBuild)||!Number.isSafeInteger(x.atMs))C.fail('RECOVERY_BYTE_EVIDENCE_INVALID');
   if(before.atMs>runtime.createdAtMs||after.atMs<runtime.endedAtMs||!C.same(r.before,before)||!C.same(r.after,after))C.fail('RECOVERY_BYTES_RUNTIME_ORDER_INVALID');independent=O.verify(d);if(!C.same(r.runtime,independent)||r.status!=='RESTORED_BYTES_AND_RUNTIME_VERIFIED'||r.finalByteReadConfirmed!==true||r.runtimeConfirmed!==true)C.fail('RECOVERY_RUNTIME_RESULT_MISMATCH');
  }
  results.push({invocationId:r.invocationId,status:r.status,runtimeConfirmed:Boolean(independent),finalByteReadConfirmed:r.finalByteReadConfirmed,httpRestoreCallsInThisInvocation:r.httpRestoreCallsInThisInvocation,error:r.error,atMs:r.atMs});
 }
 if(boundaries>1||totalHttpCalls>1)C.fail('ADDITIONAL_RESTORE_QUOTA_EXCEEDED');results.sort((a,b)=>a.atMs-b.atMs);const latest=results.at(-1);return {status:latest?.runtimeConfirmed?'RESTORED_BYTES_AND_RUNTIME_VERIFIED':latest?.status||'RECOVERY_NOT_EXECUTED',parentRunId:P.parentRunId,authorizationId:P.authorizationId,originalCaptureRemains:'CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE',originalRestorePostAttempts:1,additionalBoundaryCount:boundaries,additionalQuotaConsumed:Boolean(mark),results};
}
module.exports={approved,verify,LEAVES};
