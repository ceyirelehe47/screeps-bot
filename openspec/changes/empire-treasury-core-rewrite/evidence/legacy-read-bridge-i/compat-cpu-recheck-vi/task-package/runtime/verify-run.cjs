'use strict';
const fs=require('node:fs'),path=require('node:path');
const C=require('./common.cjs'),K=require('./policy.cjs'),S=require('./store.cjs'),W=require('./samples.cjs'),D=require('./decoder.cjs');
const {verifyObserver,gapMax}=require('./verify-runtime.cjs');
function records(run,name){const p=path.join(run,name);if(!fs.existsSync(p))return [];const text=C.bytes(p).toString('utf8');
 if(text&&!text.endsWith('\n'))C.fail('INCOMPLETE_JSONL');return text.trimEnd().split('\n').filter(Boolean).map(s=>{try{return JSON.parse(s);}catch{C.fail('INVALID_JSONL');}});}
function closureEvidence(run,s){
 const candidates=[];const uploadOutcomeResolved=Boolean(S.optional(run,'upload-result.json')?.result?.confirmed===true||S.optional(run,'restore-attempt.json'));
 for(const actor of ['worker','supervisor','operator']){
  const dir=path.join(run,'recovery-'+actor);if(!fs.existsSync(dir))continue;
  const get=n=>S.optional(dir,n),r=get('closure-result.json'),start=get('closure-start.json'),before=get('code-before-runtime.json'),after=get('code-after-runtime.json');
  const issues=[];let runtime=null;
  const validIdentity=r?.parentRunId===s.runId&&start?.parentRunId===s.runId&&r?.closureId===start?.closureId&&r?.actor===actor;
  const original=x=>x?.confirmed===true&&x.status==='CURRENT_IS_BACKUP'&&C.same(x.digest,s.backupDigest)&&x.build?.commit===C.PRODUCTION_BASE&&Number.isSafeInteger(x.atMs);
  // Bytes and liveness are deliberately separate: never discard verified bytes because a stream died.
  const bytesConfirmed=Boolean(validIdentity&&original(after||before));
  if(!validIdentity)issues.push('CLOSURE_IDENTITY_INVALID');
  if(bytesConfirmed&&original(before)&&original(after)){
   try{runtime=verifyObserver(dir,r.closureId,s.runId);const o=get('runtime-observer-result.json');
    if(before.atMs>o.createdAtMs||after.atMs<o.endedAtMs)C.fail('RECOVERY_CODE_RUNTIME_ORDER_INVALID');
   }catch(e){runtime=null;issues.push(C.code(e));}
  }
  candidates.push({actor,closureId:r?.closureId||null,bytesConfirmed,runtimeConfirmed:Boolean(runtime&&uploadOutcomeResolved),uploadOutcomeResolved,runtime,issues,atMs:after?.atMs||before?.atMs||0});
 }
 const latest=candidates.sort((a,b)=>a.atMs-b.atMs).at(-1);
 return {status:latest?.runtimeConfirmed?'RESTORED_BYTES_AND_RUNTIME_VERIFIED':latest?.bytesConfirmed&&uploadOutcomeResolved?'RESTORED_BYTES_CONFIRMED_RUNTIME_UNCONFIRMED':'ONLINE_CLOSE_UNCONFIRMED',
  bytesConfirmed:latest?.bytesConfirmed||false,runtimeConfirmed:latest?.runtimeConfirmed||false,selectedActor:latest?.actor||null,candidates};
}
function median(values){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;}
function summarize(samples,p){
 const tails=samples.slice(1).map(r=>r.previousCpuProfile).filter(Boolean);
 const rows=samples.map(r=>({tick:r.tick,sampleOrdinal:r.cpuProfile?.sampleOrdinal,status:r.status,
  completeSample:!W.sampleError(r,p),sampleCompletenessReason:W.sampleError(r,p),cpuBeforeSerializationAndEmit:r.cpuBeforeSerializationAndEmit,
  calls:r.cpuProfile?.calls||null,phaseIntervals:r.cpuProfile?.phases||null,
  commitmentsStatus:r.commitments?.status||'missing',completeProfileReportedBySuccessor:tails.find(t=>t.tick===r.tick)||null}));
 const phaseSummary=W.PHASES.map(phase=>{
  const first=rows[0]?.phaseIntervals?.[phase]??null,rest=rows.slice(1).flatMap(x=>Object.hasOwn(x.phaseIntervals||{},phase)?[x.phaseIntervals[phase]]:[]);
  return {phase,firstAdmittedPrefix:first,followingAdmittedPrefixMedian:median(rest),followingMeasuredIntervals:rest.length,
   completedIntervals:tails.filter(x=>Object.hasOwn(x.phases,phase)).map(x=>({tick:x.tick,cpu:x.phases[phase]}))};});
 return {rows,phaseSummary,measurementBoundary:'inclusive intervals; accounting overhead retained; final snapshot-copy/return not measured',
  firstSampleMeaning:'first admitted sample in one module lifetime, NOT proof of cold engine startup',
  lastSampleTail:'unobservable without a successor; no fifth sample and no invented cost',
  completeTailProfiles:tails.length,engineBudget:2,engineCpuGapRepaired:false,nodeTimeToEngineConversion:false};
}
function verifyRun(run){
 const s=S.optional(run,'public-session.json');
 if(!s){if(S.optional(run,'upload-attempt.json'))C.fail('UPLOAD_WITHOUT_PUBLIC_SESSION');return {status:'NOT_DEPLOYED',captureVerified:false,closure:'NOT_DEPLOYED',issues:['PREPARATION_NOT_COMPLETE'],rawReports:0,completeSamples:0};}
 K.validProfile(s.profile);
 if(s.kind!==K.PUBLIC_KIND||s.refactorBase!==K.REFACTOR||s.compatBase!==K.COMPAT||s.wallLimitMs!==K.WALL_MS
 ||!/^[a-f0-9]{32}$/.test(s.runId)||!/^[a-f0-9]{40}$/.test(s.profileHead)||!/^[a-f0-9]{40}$/.test(s.profileTree)
 ||s.build?.commit!==s.profileHead||s.build?.tree!==s.profileTree||s.build?.deployBranch!==s.branch
 ||s.profile.startTick!==K.profileFor(s.observedTick).startTick||!C.same(s.backupDigest,C.ORIGINAL_DIGEST))C.fail('PUBLIC_SESSION_INVALID');
 for(const[k,v]of Object.entries(C.EXPECTED))if(s[k]!==v)C.fail('PUBLIC_SESSION_IDENTITY_INVALID');
 const issues=[],need=(v,k)=>{if(!v)issues.push(k);};
 const a=S.optional(run,'upload-attempt.json'),u=S.optional(run,'upload-result.json'),driver=S.optional(run,'driver-result.json'),off=S.optional(run,'source-closed.json');
 if(!a)return {status:'NOT_DEPLOYED',captureVerified:false,closure:'NOT_DEPLOYED',runId:s.runId,issues:driver?.failure?[driver.failure.error]:[],rawReports:0,completeSamples:0};
 need(a.runId===s.runId&&a.profileHead===s.profileHead&&a.candidateHash===s.candidateDigest?.hash,'UPLOAD_ATTEMPT_IDENTITY_INVALID');
 need(u?.runId===s.runId&&u.candidateHash===s.candidateDigest.hash&&u.result?.confirmed===true&&C.same(u.result.digest,s.candidateDigest)&&u.result.build?.commit===s.profileHead,'UPLOAD_UNCONFIRMED');
 const frames=records(run,'console.jsonl'),auth=frames.filter(x=>x.kind==='auth-confirmed'),footer=frames.filter(x=>x.kind==='collector-footer');
 const cr=S.optional(run,'collector-result.json');
 need(auth.length===1&&auth[0].runId===s.runId&&auth[0].pid===cr?.pid,'AUTH_SEQUENCE_INVALID');
 need(cr?.runId===s.runId&&cr.status==='closed'&&cr.exitCode===0&&cr.footerWritten&&cr.lockRemoved,'COLLECTOR_TERMINAL_INVALID');
 need(footer.length===1&&frames.at(-1)===footer[0]&&footer[0].runId===s.runId&&footer[0].pid===cr?.pid&&footer[0].exitCode===0,'COLLECTOR_FOOTER_INVALID');
 const samples=[],texts=[],con=[],cpu=[],deploy=[];let raw=0,duplicate=0,previousTime=-1;
 for(const f of frames){need(f.runId===s.runId,'FOREIGN_LOG_RUN');if(f.kind!=='ws-frame')continue;
  const at=Date.parse(f.receivedAt);need(Number.isFinite(at)&&at>=previousTime,'FRAME_TIME_ORDER');previousTime=at;
  need(f.redacted===false,'OBSERVATION_FRAME_REDACTED');
  let data;try{data=JSON.parse(f.text);}catch{continue;}if(!Array.isArray(data)||data.length!==2)continue;const[ch,d]=data;
  if(ch===`user:${s.userId}/cpu`&&typeof d?.cpu==='number'&&Number.isFinite(d.cpu)&&d.cpu>=0)cpu.push(at);
  if(ch!==`user:${s.userId}/console`||d?.shard!==s.shard||!Array.isArray(d.messages?.log)||!Array.isArray(d.messages?.results))continue;
  con.push(at);for(const text of d.messages.log){if(typeof text!=='string')continue;
   let line;try{line=text.trimStart().startsWith('{')?text.trim():D.decodeHtmlOnce(text).trim();}catch{issues.push('CONSOLE_ENTITY_INVALID');continue;}
   if(line===`[deploy] ${s.build.tag}`)deploy.push(at);
   if(line.startsWith('[deploy] ')&&line!==`[deploy] ${s.build.tag}`&&line!==`[deploy] ${s.backupBuild.tag}`)issues.push('UNEXPECTED_DEPLOY_IDENTITY');
   const parsed=D.parseBridge(text);if(parsed.kind==='invalid'){issues.push(parsed.error);continue;}if(parsed.kind!=='bridge')continue;raw++;
   need(at>=a.startedAtMs,'PRE_UPLOAD_DIAGNOSTIC');const r=parsed.report,prior=samples.findIndex(x=>x.tick===r.tick);
   if(prior>=0){need(texts[prior]===parsed.jsonText,'CONFLICTING_DUPLICATE_SAMPLE');duplicate++;continue;}
   const error=W.diagnosticError(r,s.profile,samples.length,samples.at(-1),texts.at(-1));if(error){issues.push(error);continue;}
   samples.push(r);texts.push(parsed.jsonText);
  }
 }
 need(samples.length===K.COUNT,'FOUR_DIAGNOSTIC_REPORTS_REQUIRED');need(deploy.some(t=>t>=a.startedAtMs),'CANDIDATE_DEPLOY_FRAME_MISSING');
 const g=S.optional(run,'guard-result.json'),closing=S.optional(run,'closing.json');
 need(g?.runId===s.runId&&g.reason==='DIAGNOSTIC_WINDOW_COMPLETE'&&!g.auditFailed,'GUARD_DID_NOT_COMPLETE_DIAGNOSTIC');
 const end=closing?.atMs;
 need(Number.isSafeInteger(end)&&end>=a.startedAtMs,'CLOSING_BOUNDARY_INVALID');
 if(Number.isSafeInteger(end)){need(con.some(t=>t>=a.startedAtMs)&&gapMax(con,a.startedAtMs,end)<=45000,'CONSOLE_EVIDENCE_GAP');need(cpu.some(t=>t>=a.startedAtMs)&&gapMax(cpu,a.startedAtMs,end)<=45000,'CPU_EVIDENCE_GAP');}
 const events=records(run,'actions.jsonl'),writes=events.filter(x=>x.kind==='code-write-boundary'),ups=writes.filter(x=>x.action==='candidate'),rest=writes.filter(x=>x.action==='restore'),mark=S.optional(run,'restore-attempt.json');
 need(ups.length===1&&rest.length<=1&&writes.length===ups.length+rest.length&&writes.every(x=>x.runId===s.runId),'WRITE_QUOTA_INVALID');
 need(ups[0]?.atMs>=a.startedAtMs,'UPLOAD_MARKER_ORDER_INVALID');
 if(mark)need(mark.runId===s.runId&&mark.backupHash===s.backupDigest.hash&&mark.candidateHash===s.candidateDigest.hash,'RESTORE_MARKER_IDENTITY_INVALID');
 if(rest.length)need(mark&&rest[0].atMs>=mark.startedAtMs,'RESTORE_MARKER_ORDER_INVALID');
 const restoration=closureEvidence(run,s);need(restoration.runtimeConfirmed,'RESTORE_CLOSURE_INCOMPLETE');
 need(off?.status==='SOURCE_DEFAULT_OFF_RESTORED'&&off.profileHead===s.profileHead&&off.sameTreeAsCompatBase===true,'SOURCE_DEFAULT_OFF_UNCONFIRMED');
 need(!driver?.failure&&driver?.collectorExit===0&&driver?.guardExit===0&&!driver?.guardStillRunning,'DRIVER_OR_PROCESS_FAILURE');
 for(const n of ['collector.lock','guard.lock','action.lock'])need(!fs.existsSync(path.join(run,n)),'RESIDUAL_'+n.toUpperCase());
 const analysis=summarize(samples,s.profile),unique=[...new Set(issues)],captureVerified=unique.length===0;
 return {status:captureVerified?'CPU_DIAGNOSTIC_CAPTURE_VERIFIED':'CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE',captureVerified,
  closure:restoration.status,restoration,runId:s.runId,profileHead:s.profileHead,rawReports:raw,diagnosticReports:samples.length,
  completeSamples:analysis.rows.filter(x=>x.completeSample).length,partialCpuSamples:samples.filter(x=>x.status==='partial_cpu_budget').length,
  duplicateReports:duplicate,expectedTicks:K.dueTicks(s.profile),receivedTicks:samples.map(x=>x.tick),analysis,
  writeBoundaries:{candidate:ups.length,restore:rest.length},issues:unique,fullCompatibilityObserved:false,engineCpuGapRepaired:false,
  prior0003:{raw:1,complete:0,recoveryClosed:true},networkUsedByVerifier:false};
}
module.exports={verifyRun,records,closureEvidence,summarize,median};
