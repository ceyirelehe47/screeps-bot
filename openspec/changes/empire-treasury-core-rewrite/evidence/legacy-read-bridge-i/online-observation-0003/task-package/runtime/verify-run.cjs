'use strict';
const fs=require('node:fs');const C=require('./common.cjs'),K=require('./policy.cjs'),S=require('./store.cjs'),W=require('./samples.cjs');
function records(run,name,max=70*1048576){
 const p=S.file(run,name);if(!fs.existsSync(p))return [];
 const st=fs.statSync(p);if(!st.isFile()||st.size>max)C.fail('EVIDENCE_FILE_OVERSIZE');
 const text=fs.readFileSync(p,'utf8');return text.trim()?text.trim().split(/\r?\n/).map(l=>JSON.parse(l)):[];
}
function gapsWithin(times,start,end,limit){
 const t=times.filter(x=>x>=start&&x<=end);if(!t.length)return false;
 return t[0]-start<=limit&&end-t.at(-1)<=limit&&t.every((x,i)=>!i||x>=t[i-1]&&x-t[i-1]<=limit);
}
function verifyRun(run){
 const s=C.readJson(S.file(run,'public-session.json'),65536);K.validProfile(s.profile);
 if(s.kind!=='formal-compat-observation-0003-public/v1'||s.compatBase!==K.COMPAT||s.refactorBase!==K.REFACTOR
  ||!/^[a-f0-9]{40}$/.test(s.profileHead)||!/^[a-f0-9]{40}$/.test(s.profileTree)||s.build?.commit!==s.profileHead||s.build?.tree!==s.profileTree||s.build?.deployBranch!=='default'
  ||!/^[a-f0-9]{32}$/.test(s.runId)||s.profile.startTick!==K.profileFor(s.observedTick).startTick
  ||JSON.stringify(s.backupDigest)!==JSON.stringify(C.ORIGINAL_DIGEST))C.fail('PUBLIC_SESSION_INVALID');
 for(const [k,v] of Object.entries(C.EXPECTED))if(s[k]!==v)C.fail('PUBLIC_SESSION_IDENTITY_INVALID');
 const issues=[],need=(ok,code)=>{if(!ok)issues.push(code);};
 const attempt=S.optional(run,'upload-attempt.json'),u=S.optional(run,'upload-result.json'),driver=S.optional(run,'driver-result.json'),closed=S.optional(run,'source-closed.json');
 if(!attempt)return {status:'NOT_DEPLOYED',runId:s.runId,issues:driver?.failure?[driver.failure.error]:[],observed:false,restored:false,receivedTicks:[]};
 need(attempt.runId===s.runId&&attempt.profileHead===s.profileHead&&attempt.candidateHash===s.candidateDigest.hash,'ATTEMPT_IDENTITY');
 need(u?.runId===s.runId&&u.candidateHash===s.candidateDigest.hash&&u.result?.status==='UPLOADED_AND_READBACK_VERIFIED'&&u.result.confirmed===true
  &&JSON.stringify(u.result.digest)===JSON.stringify(s.candidateDigest)&&u.result.build?.commit===s.profileHead,'UPLOAD_UNCONFIRMED');
 const frames=records(run,'console.jsonl');const auth=frames.filter(x=>x.kind==='auth-confirmed'),footer=frames.filter(x=>x.kind==='collector-footer');
 need(auth.length===1&&auth[0].runId===s.runId,'AUTH_SEQUENCE_INVALID');
 const cr=S.optional(run,'collector-result.json');
 need(cr?.runId===s.runId&&cr.status==='closed'&&cr.exitCode===0&&cr.footerWritten===true&&cr.lockRemoved===true,'COLLECTOR_TERMINAL_INVALID');
 need(footer.length===1&&footer[0].runId===s.runId&&footer[0].pid===cr?.pid&&footer[0].exitCode===0&&footer[0].reason==='observation_closed','FOOTER_INVALID');
 const sampleMap=new Map(),sampleLines=new Map(),consoleTimes=[],cpuTimes=[],positiveCpuTimes=[],candidateDeploy=[],restoreDeploy=[];
 let previousFrameTime=-1;
 for(const f of frames){
  need(f.runId===s.runId,'FOREIGN_LOG_RUN');if(f.kind!=='ws-frame')continue;
  const at=Date.parse(f.receivedAt);need(Number.isFinite(at)&&at>=previousFrameTime,'FRAME_TIME_ORDER');previousFrameTime=at;
  if(typeof f.text!=='string'){issues.push('FRAME_TEXT_INVALID');continue;}
  let parsed;try{parsed=JSON.parse(f.text);}catch{continue;}
  if(!Array.isArray(parsed)||parsed.length!==2)continue;const[ch,d]=parsed;
  if(ch===`user:${s.userId}/cpu`&&typeof d?.cpu==='number'&&Number.isFinite(d.cpu)&&d.cpu>=0){cpuTimes.push(at);if(d.cpu>0)positiveCpuTimes.push(at);}
  if(ch!==`user:${s.userId}/console`||d?.shard!==s.shard||!Array.isArray(d.messages?.log)||!Array.isArray(d.messages?.results))continue;
  consoleTimes.push(at);
  for(const line of d.messages.log){if(typeof line!=='string')continue;const text=W.decode(line).trim();
   if(text===`[deploy] ${s.build.tag}`)candidateDeploy.push(at);
   if(text===`[deploy] ${s.backupBuild.tag}`)restoreDeploy.push(at);
   if(text.startsWith('[deploy] ')&&text!==`[deploy] ${s.build.tag}`&&text!==`[deploy] ${s.backupBuild.tag}`)issues.push('UNEXPECTED_DEPLOY_IDENTITY');
   let r;try{r=JSON.parse(text);}catch{if(text.includes('treasury-legacy-read-bridge'))issues.push('BRIDGE_JSON_INVALID');continue;}
   if(r?.kind!=='treasury-legacy-read-bridge')continue;
   need(at>=attempt.startedAtMs,'PRE_UPLOAD_SAMPLE');
   if(sampleMap.has(r.tick)){need(JSON.stringify(sampleMap.get(r.tick))===JSON.stringify(r),'CONFLICTING_DUPLICATE');continue;}
   sampleMap.set(r.tick,r);sampleLines.set(r.tick,text);
  }
 }
 const seq=W.validateSequence([...sampleMap.values()],s.profile);issues.push(...seq.errors.map(x=>x.error));
 const samples=[...sampleMap.values()];for(let i=1;i<samples.length;i++)need(samples[i].previousRun?.emittedBytes===Buffer.byteLength(sampleLines.get(samples[i-1].tick)||''),'EMITTED_BYTES_MISMATCH');
 need(candidateDeploy.some(t=>t>=attempt.startedAtMs),'CANDIDATE_DEPLOY_FRAME_MISSING');
 const restoration=S.optional(run,'restore-attempt.json'),before=S.optional(run,'restore-independent-before.json'),after=S.optional(run,'restore-independent-after.json'),runtime=S.optional(run,'runtime-confirmation.json');
 const checkOriginal=x=>x?.confirmed===true&&x.status==='CURRENT_IS_BACKUP'&&x.checks?.some(c=>c.sameAsBackup===true&&c.sameAsCandidate===false
  &&JSON.stringify(c.digest)===JSON.stringify(s.backupDigest)&&c.build?.commit===C.PRODUCTION_BASE&&Number.isSafeInteger(c.observedTick)&&c.observedTick>=s.observedTick);
 const restored=checkOriginal(before)&&checkOriginal(after)&&runtime?.confirmed===true&&runtime.durationMs>=K.CONFIRM_MS
  &&Number.isFinite(runtime.startedAtMs)&&runtime.endedAtMs-runtime.startedAtMs>=K.CONFIRM_MS;
 need(restored,'RESTORE_CONFIRMATION_INCOMPLETE');
 if(restored){
  const first=before.checks.find(x=>x.sameAsBackup),last=after.checks.find(x=>x.sameAsBackup);need(last.observedTick>=first.observedTick,'POSTFLIGHT_TICK_REGRESSED');
  need(gapsWithin(consoleTimes,runtime.startedAtMs,runtime.startedAtMs+K.CONFIRM_MS,45000),'RESTORED_CONSOLE_COVERAGE');
  need(gapsWithin(cpuTimes,runtime.startedAtMs,runtime.startedAtMs+K.CONFIRM_MS,45000),'RESTORED_CPU_COVERAGE');
  need(positiveCpuTimes.some(t=>t>=runtime.startedAtMs),'NO_POST_RESTORE_CPU');
  need(runtime.collectorPid===cr?.pid,'POST_RESTORE_PID_CHANGED');
  need(gapsWithin(consoleTimes,attempt.startedAtMs,runtime.startedAtMs+K.CONFIRM_MS,45000),'CONSOLE_GAP');
  need(gapsWithin(cpuTimes,attempt.startedAtMs,runtime.startedAtMs+K.CONFIRM_MS,45000),'CPU_GAP');
 }
 need(restoration?.runId===s.runId&&restoration?.backupHash===s.backupDigest.hash,'RESTORE_ATTEMPT_MISSING');
 need(restoreDeploy.some(t=>t>=restoration?.startedAtMs),'RESTORED_DEPLOY_FRAME_MISSING');
 const g=S.optional(run,'guard-result.json');need(g?.runId===s.runId&&g.reason==='LAST_SAMPLE_RECEIVED'&&!g.auditFailed,'GUARD_NOT_NORMAL_COMPLETION');
 need(closed?.status==='SOURCE_DEFAULT_OFF_RESTORED'&&closed.profileHead===s.profileHead&&closed.sameTreeAsCompatBase===true,'SOURCE_NOT_CLOSED');
 for(const n of ['collector.lock','guard.lock','action.lock'])need(!fs.existsSync(S.file(run,n)),'RESIDUAL_'+n.toUpperCase());
 need(!driver?.failure&&driver?.collectorExit===0&&driver?.guardExit===0,'DRIVER_OR_PROCESS_FAILURE');
 const unique=[...new Set(issues)];
 return {status:unique.length?'ONLINE_COMPAT_READ_INCONCLUSIVE':'ONLINE_COMPAT_READ_OBSERVED',closure:restored?'RESTORED':'ONLINE_CLOSE_UNCONFIRMED',
  runId:s.runId,profileHead:s.profileHead,observed:unique.length===0,restored,issues:unique,receivedTicks:seq.receivedTicks,expectedTicks:K.dueTicks(s.profile),
  cpuIncludingEmit:seq.cpuIncludingEmit,finalSampleCpuIncludingEmit:seq.finalSampleCpuIncludingEmit,
  finalSampleCpuBeforeSerializationAndEmit:seq.lastSampleCpuBeforeSerializationAndEmit,
  legacyProjectionComparisons:samples.flatMap(r=>r.endpoints||[]).reduce((o,x)=>{const k=x.legacyProjection?.status||'not_reported';o[k]=(o[k]||0)+1;return o;},{}),
  commitmentEvidence:'12 complete frozen-reader reports required; no independent builder-call counter exists',
  coverage:'two rooms, energy/H, storage/terminal; no empire-total or full Treasury lifecycle equivalence claim'};
}
module.exports={records,gapsWithin,verifyRun};
