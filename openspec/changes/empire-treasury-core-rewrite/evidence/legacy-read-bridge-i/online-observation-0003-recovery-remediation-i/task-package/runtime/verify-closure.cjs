'use strict';
const fs=require('node:fs'),path=require('node:path');const C=require('./common.cjs'),K=require('./pins.cjs'),I=require('./input.cjs');
function jsonl(p){return C.bytes(p).toString('utf8').trimEnd().split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{C.fail('EVIDENCE_JSONL_INVALID');}});}
function gapMax(times,start,end){const t=[start,...times.filter(n=>n>=start&&n<=end),end];return Math.max(...t.slice(1).map((n,i)=>n-t[i]));}
function verifyObserver(out,closureId,parentRunId,{runtimeMs=K.runtimeMs,silenceMs=K.channelSilenceMs}={}){
 const r=C.json(path.join(out,'runtime-observer-result.json')),events=jsonl(path.join(out,'runtime-console.jsonl'));
 if(r.closureId!==closureId||r.parentRunId!==parentRunId||r.status!=='RECOVERY_RUNTIME_COLLECTED'||r.reason!=='runtime_complete'
 ||!Number.isSafeInteger(r.pid)||r.pid<=0||r.monotonicDurationMs<runtimeMs||r.requestedDurationMs!==runtimeMs
 ||!Number.isSafeInteger(r.startedAtMs)||!Number.isSafeInteger(r.endedAtMs)||r.endedAtMs-r.startedAtMs<runtimeMs-1000
 ||Math.abs(r.endedAtMs-r.startedAtMs-r.monotonicDurationMs)>2000||r.continuityWithOriginalCollectorClaimed!==false||r.observationSamplesAccepted!==0||r.authentications!==1)C.fail('RECOVERY_RUNTIME_RESULT_INVALID');
 if(events.some((x,i)=>x.closureId!==closureId||x.parentRunId!==parentRunId||x.pid!==r.pid||!Number.isSafeInteger(x.atMs)||i&&x.atMs<events[i-1].atMs))C.fail('RECOVERY_RUNTIME_EVENT_IDENTITY_INVALID');
 const one=kind=>{const a=events.filter(x=>x.kind===kind);if(a.length!==1)C.fail('RECOVERY_RUNTIME_EVENT_COUNT_INVALID');return a[0];};
 const begin=one('recovery-runtime-start'),ready=one('recovery-runtime-ready'),auth=one('auth-confirmed'),footer=one('recovery-runtime-footer');
 if(ready.startedAtMs!==r.startedAtMs||footer.startedAtMs!==r.startedAtMs||footer.endedAtMs!==r.endedAtMs||footer.reason!=='runtime_complete'
 ||events.at(-1)!==footer||begin.atMs>auth.atMs||auth.atMs>ready.atMs||footer.atMs<ready.atMs)C.fail('RECOVERY_RUNTIME_BOUNDARY_INVALID');
 const con=[],cpu=[];let positive=0;
 for(const x of events){if(x.kind!=='ws-frame')continue;let frame;try{frame=JSON.parse(x.text);}catch{continue;}
  if(!Array.isArray(frame)||frame.length!==2)continue;const [ch,d]=frame;
  if(ch===`user:${C.EXPECTED.userId}/console`&&d?.shard===C.EXPECTED.shard&&Array.isArray(d.messages?.log)&&Array.isArray(d.messages?.results)){
   con.push(x.atMs);if(d.messages.log.some(v=>typeof v==='string'&&v.includes('treasury-legacy-read-bridge')))C.fail('RECOVERY_UNEXPECTED_BRIDGE');
  }
  if(ch===`user:${C.EXPECTED.userId}/cpu`&&typeof d?.cpu==='number'&&Number.isFinite(d.cpu)&&d.cpu>=0){cpu.push(x.atMs);if(x.atMs>r.startedAtMs&&x.atMs<=r.endedAtMs&&d.cpu>0)positive++;}
 }
 const conMax=gapMax(con,r.startedAtMs,r.endedAtMs),cpuMax=gapMax(cpu,r.startedAtMs,r.endedAtMs);
 if(!con.some(t=>t>r.startedAtMs)||!cpu.some(t=>t>r.startedAtMs)||!positive||conMax>silenceMs||cpuMax>silenceMs)C.fail('RECOVERY_RUNTIME_CHANNEL_GAP');
 return {status:'RECOVERY_RUNTIME_INDEPENDENTLY_VERIFIED',durationMs:r.monotonicDurationMs,collectorPid:r.pid,
  consoleFrames:con.length,cpuFrames:cpu.length,positiveCpuFramesAfterReady:positive,maxConsoleGapMs:conMax,maxCpuGapMs:cpuMax,
  scope:'fresh shard1 console and account CPU; not a continuation of observation 0003'};
}
function verifyClosure(out,pub,options={}){
 const r=C.json(path.join(out,'closure-result.json')),start=C.json(path.join(out,'closure-start.json')),events=jsonl(path.join(out,'closure-events.jsonl'));
 if(r.parentRunId!==pub.runId||start.parentRunId!==pub.runId||r.closureId!==start.closureId||r.newCandidateUploads!==0
 ||r.originalObservationStatus!=='ONLINE_COMPAT_READ_INCONCLUSIVE')C.fail('CLOSURE_RESULT_IDENTITY_INVALID');
 if(events.some(x=>x.closureId!==r.closureId||x.parentRunId!==pub.runId))C.fail('CLOSURE_AUDIT_IDENTITY_INVALID');
 const attempts=events.filter(x=>x.kind==='restore-post-boundary');if(attempts.length>1||Boolean(attempts.length)!==r.requestAttempted)C.fail('RESTORE_POST_COUNT_INVALID');
 if(attempts.length){
  const b=C.bytes(path.join(out,'restore-marker.json')),m=JSON.parse(b),w=C.json(path.join(out,'restore-write-result.json'));
  I.checkMarker(m,{runId:pub.runId,backup:{digest:pub.backupDigest},candidate:{digest:pub.candidateDigest}});
  if(m.recoveryClosureId!==r.closureId||C.sha256(b)!==attempts[0].markerSha256||w.requestAttempted!==true||w.postRetryAllowed!==false||w.closureId!==r.closureId
   ||start.executeRecovery!==true||start.exclusiveTarget!==true||start.priorWorkersStopped!==true)C.fail('RESTORE_WRITE_EVIDENCE_INVALID');
 }
 const beforeHash=C.json(path.join(out,'prior-file-hashes-before.json')),afterHash=fs.existsSync(path.join(out,'prior-file-hashes-after.json'))?C.json(path.join(out,'prior-file-hashes-after.json')):null;
 if(afterHash){for(const [n,v]of Object.entries(beforeHash))if(!C.same(v,afterHash[n]))C.fail('ORIGINAL_EVIDENCE_MUTATED');
  const added=Object.keys(afterHash).filter(n=>!Object.hasOwn(beforeHash,n));if(added.some(n=>n!=='restore-attempt.json'))C.fail('UNEXPECTED_ORIGINAL_RUN_ADDITION');
 }
 const load=name=>fs.existsSync(path.join(out,name))?C.json(path.join(out,name)):null;
 const initial=load('initial-code-state.json'),before=load('code-before-runtime.json'),after=load('code-after-runtime.json');
 for(const x of [initial,before,after].filter(Boolean))if(x.state==='CURRENT_IS_BACKUP'&&!C.same(x.digest,pub.backupDigest))C.fail('BACKUP_READBACK_MISMATCH');
 let bytesConfirmed=Boolean(!r.failure&&afterHash&&(after||before||initial)?.state==='CURRENT_IS_BACKUP');
 if(bytesConfirmed!==r.bytesConfirmed)C.fail('BYTE_CONFIRMATION_INCONSISTENT');
 let runtime=null,issues=[];
 if(bytesConfirmed&&before?.state==='CURRENT_IS_BACKUP'&&after?.state==='CURRENT_IS_BACKUP'){
  try{runtime=verifyObserver(out,r.closureId,pub.runId,options);const observed=C.json(path.join(out,'runtime-observer-result.json'));if(before.capturedAtMs>observed.createdAtMs||after.capturedAtMs<observed.endedAtMs)C.fail('CODE_READBACK_RUNTIME_ORDER_INVALID');}catch(e){runtime=null;issues.push(C.code(e));}
 }
 const complete=Boolean(bytesConfirmed&&runtime);
 if(r.runtimeConfirmed!==complete&&r.runtimeConfirmed)C.fail('RUNTIME_CONFIRMATION_INCONSISTENT');
 return {status:complete?'RECOVERY_CLOSURE_VERIFIED':bytesConfirmed?'RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED':r.status,
  closureId:r.closureId,parentRunId:pub.runId,bytesConfirmed,runtimeConfirmed:complete,runtime,issues,
  restorePostBoundaries:attempts.length,newCandidateUploads:0,observationStatus:'ONLINE_COMPAT_READ_INCONCLUSIVE',
  sourceFailureSuperseded:false,originalRecordsPreserved:!!afterHash,networkUsedByVerifier:false,
  checkedAtMs:Date.now()};
}
module.exports={jsonl,verifyObserver,verifyClosure,gapMax};
