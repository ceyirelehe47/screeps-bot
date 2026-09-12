#!/usr/bin/env node
'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const C=require('./common.cjs');
const S=require('./evidence-contract.cjs');
const H=require('./heartbeat-continuity.cjs');

const VERIFIER_VERSION='guard-joint-probe-existing-evidence-verifier/v2';
const PINNED_SOURCE=Object.freeze({
  commit:'64d92713352826fb547a0860a963b11b4de4f440',
  probeRunTree:'f6660ce8aafd6e28ce01993c21a233845609f35a',
  runTree:'9469e42799ace7e2ec40a4656bfc9b4f84b53328',
});

function sha256(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function readExit(file){
  const text=fs.readFileSync(file,'utf8').trim();
  if(text!=='0')C.fail('PROBE_PROCESS_EXIT_NONZERO',{file:path.basename(file),value:text});
}
function readJsonLines(file,maxBytes=128*1024*1024){
  let stat;try{stat=fs.statSync(file);}catch{C.fail('PROBE_JSONL_INVALID',{file:path.basename(file)});}
  if(!stat.isFile()||stat.size>maxBytes)C.fail('PROBE_JSONL_INVALID',{file:path.basename(file)});
  const text=fs.readFileSync(file,'utf8').trim();if(!text)return [];
  return text.split(/\r?\n/).map((line,index)=>{
    try{return JSON.parse(line);}catch{C.fail('PROBE_JSONL_INVALID',{file:path.basename(file),line:index+1});}
  });
}
function validateSourceManifest(value){
  if(!C.obj(value)||value.status!=='PINNED_GUARD_JOINT_PROBE_EVIDENCE_MATERIALIZED'
    ||value.sourceCommit!==PINNED_SOURCE.commit||value.probeRunTree!==PINNED_SOURCE.probeRunTree
    ||value.runTree!==PINNED_SOURCE.runTree||!Number.isSafeInteger(value.files)||value.files<1
    ||!Number.isSafeInteger(value.totalBytes)||value.totalBytes<1||!Array.isArray(value.entries))
    C.fail('SOURCE_EVIDENCE_MANIFEST_INVALID');
  return value;
}

function verifyRun(run,{sourceManifest=null}={}){
  const session=S.loadProbeSession(run);
  const prepared=C.readJson(path.join(run,'probe-prepared.json'),16384);
  const before=C.readJson(path.join(run,'preflight-before.json'),65536);
  const after=C.readJson(path.join(run,'preflight-after.json'),65536);
  const online=C.readJson(path.join(run,'online-state-verification.json'),16384);
  const ready=C.readJson(path.join(run,'collector-ready.json'),16384);
  const probe=C.readJson(path.join(run,'guard-probe-result.json'),65536);
  const collector=C.readJson(path.join(run,'collector-result.json'),65536);
  const heartbeat=C.readJson(path.join(run,'heartbeat.json'),65536);
  const stop=C.readJson(path.join(run,'collector-stop.json'),16384);
  S.validateBaseline(before);S.validateBaseline(after);
  if(!C.exact(session.baseline,before))C.fail('PROBE_SESSION_BASELINE_MISMATCH');
  if(prepared.status!=='CONTROL_PLANE_PROBE_SESSION_PREPARED'||prepared.runId!==session.runId
    ||prepared.preparedAtMs!==session.preparedAtMs||prepared.durationMs!==session.durationMs
    ||prepared.observedTick!==before.observedTick||prepared.digestHash!==before.digest.hash
    ||prepared.formalProfileUsed!==false||prepared.candidateSnapshotUsed!==false
    ||prepared.onlineWriteAuthorized!==false)C.fail('PROBE_PREPARED_EVIDENCE_INVALID');
  const comparison=S.compareBaselines(before,after);
  if(online.status!=='PROBE_ONLINE_STATE_UNCHANGED'||online.digestHash!==comparison.digestHash
    ||online.buildCommit!==comparison.buildCommit||online.beforeTick!==comparison.beforeTick
    ||online.afterTick!==comparison.afterTick)C.fail('PROBE_POSTFLIGHT_EVIDENCE_INVALID');
  if(ready.status!=='PROBE_COLLECTOR_READY'||ready.runId!==session.runId||ready.pid!==probe.collectorPid
    ||!C.safeTime(ready.readyAtMs)||!C.safeTime(ready.lastConsoleAtMs)||!C.safeTime(ready.lastCpuAtMs)
    ||ready.lastConsoleAtMs>ready.readyAtMs||ready.lastCpuAtMs>ready.readyAtMs)C.fail('PROBE_COLLECTOR_READY_INVALID');
  if(probe.kind!=='guard-collector-control-plane-probe/v2'||probe.sessionKind!==S.SESSION_KIND
    ||probe.status!=='GUARD_COLLECTOR_CONTROL_PLANE_PROBE_VERIFIED'||probe.reason!=='probe_complete'
    ||probe.runId!==session.runId||!C.safeTime(probe.startedAtMs)||probe.startedAtMs<ready.readyAtMs
    ||probe.durationMs<session.durationMs||probe.codeWriteRequests!==0
    ||probe.uploadAttemptPresent!==false||probe.formalProfileUsed!==false||probe.candidateSnapshotUsed!==false
    ||probe.backupSnapshotPersisted!==false||probe.collectorTerminal!=='ok'
    ||probe.consoleChannelVerified!==true||probe.cpuChannelVerified!==true
    ||probe.unexpectedBridgeReports!==0||probe.auditFailed!==false||probe.failure!==null
    ||!Number.isSafeInteger(probe.collectorPid)||probe.collectorPid<=0
    ||!Number.isSafeInteger(probe.firstTick)||!Number.isSafeInteger(probe.lastTick)||probe.lastTick<probe.firstTick)
    C.fail('JOINT_PROBE_NOT_VERIFIED');
  const minimum=S.expectedMinimumTimeReads(session.durationMs,session.policy.timeIntervalMs);
  const channel=probe.timeChannel;
  if(probe.expectedMinimumTimeReads!==minimum||!C.obj(channel)
    ||!C.safeTime(channel.createdAtMs)||channel.createdAtMs!==probe.startedAtMs
    ||!Number.isSafeInteger(channel.totalAttempts)||channel.totalAttempts<0
    ||!Number.isSafeInteger(channel.totalSuccessfulReads)||channel.totalSuccessfulReads<minimum
    ||!Number.isSafeInteger(channel.totalFailedCycles)||channel.totalFailedCycles<0
    ||channel.totalFailedCycles>session.policy.maximumTotalFailedCycles
    ||channel.consecutiveFailedCycles!==session.policy.requiredFinalConsecutiveFailedCycles
    ||!C.safeTime(channel.lastSuccessAtMs)||channel.lastFailureAtMs!==null||channel.lastFailure!==null)
    C.fail('PROBE_TIME_CHANNEL_NOT_STABLE');
  if(collector.kind!=='collector-result-v2'||collector.sessionKind!==S.SESSION_KIND
    ||collector.runId!==session.runId||collector.pid!==probe.collectorPid||collector.status!=='closed'
    ||collector.reason!=='probe_complete'||collector.exitCode!==0||collector.footerWritten!==true
    ||collector.lockRemoved!==true||!C.safeTime(collector.closedAtMs)||collector.closedAtMs<probe.startedAtMs)
    C.fail('PROBE_COLLECTOR_TERMINAL_INVALID');
  if(heartbeat.sessionKind!==S.SESSION_KIND||heartbeat.runId!==session.runId||heartbeat.pid!==probe.collectorPid
    ||heartbeat.state!=='closed'||heartbeat.socketState!=='closed'||heartbeat.stopReason!=='probe_complete'
    ||heartbeat.unexpectedBridgeReports!==0||!C.safeTime(heartbeat.closedAtMs)
    ||Math.abs(heartbeat.closedAtMs-collector.closedAtMs)>5000)C.fail('PROBE_FINAL_HEARTBEAT_INVALID');
  if(stop.runId!==session.runId||stop.reason!=='probe_complete'||!C.safeTime(stop.requestedAtMs)
    ||stop.requestedAtMs<probe.startedAtMs||stop.requestedAtMs>collector.closedAtMs)
    C.fail('PROBE_STOP_REQUEST_INVALID');
  readExit(path.join(run,'collector.exit.txt'));
  readExit(path.join(run,'guard-probe.exit.txt'));
  const consoleLines=readJsonLines(path.join(run,'console.jsonl'));
  const footers=consoleLines.filter(line=>line.kind==='collector-footer'&&line.runId===session.runId);
  if(footers.length!==1||footers[0].reason!=='probe_complete'||footers[0].exitCode!==0
    ||footers[0].pid!==probe.collectorPid||footers[0].sessionKind!==S.SESSION_KIND)
    C.fail('PROBE_COLLECTOR_FOOTER_INVALID');
  const probeLines=readJsonLines(path.join(run,'guard-probe.jsonl'),32*1024*1024);
  if(probeLines.some(line=>line.kind==='guard-probe-control-failure'))C.fail('PROBE_CONTROL_FAILURE_RECORDED');
  const starts=probeLines.filter(line=>line.kind==='guard-probe-start');
  if(starts.length!==1||starts[0].runId!==session.runId||starts[0].collectorPid!==probe.collectorPid
    ||starts[0].sessionKind!==S.SESSION_KIND||starts[0].durationMs!==session.durationMs
    ||starts[0].formalProfileUsed!==false||starts[0].candidateSnapshotUsed!==false)
    C.fail('PROBE_START_EVIDENCE_INVALID');
  const successes=probeLines.filter(line=>line.kind==='guard-time-read-success');
  const attemptFailures=probeLines.filter(line=>line.kind==='guard-time-read-attempt-failed');
  const cycleFailures=probeLines.filter(line=>line.kind==='guard-time-read-cycle-failed');
  const ticks=successes.map(line=>line.time),successTimes=successes.map(line=>line.atMs);
  if(successes.length!==channel.totalSuccessfulReads||ticks.some(t=>!Number.isSafeInteger(t)||t<0)
    ||successTimes.some(t=>!C.safeTime(t))||!C.nondecreasing(ticks)||!C.nondecreasing(successTimes)
    ||ticks[0]!==probe.firstTick||ticks[ticks.length-1]!==probe.lastTick
    ||successTimes[successTimes.length-1]!==channel.lastSuccessAtMs
    ||cycleFailures.length!==channel.totalFailedCycles||cycleFailures.some(line=>line.terminal!==false)
    ||channel.totalAttempts<successes.length||channel.totalAttempts>successes.length+attemptFailures.length)
    C.fail('PROBE_TIME_TIMELINE_INVALID');
  const health=probeLines.filter(line=>line.kind==='guard-probe-heartbeat');
  if(health.some(line=>line.collectorPid!==probe.collectorPid
    ||line.collectorState!=='streaming'||line.socketState!=='open'
    ||!Number.isFinite(line.consoleAgeMs)||line.consoleAgeMs<0||line.consoleAgeMs>session.policy.channelSilenceMs
    ||!Number.isFinite(line.cpuAgeMs)||line.cpuAgeMs<0||line.cpuAgeMs>session.policy.channelSilenceMs
    ||line.unexpectedBridgeReports!==0))C.fail('PROBE_HEARTBEAT_STATE_INVALID');
  const continuity=H.analyze({health,cycleFailures,attemptFailures,probe,session});
  const forbidden=['upload-attempt.json','backup.json','candidate.json','session.json','closing.json','guard-result.json',
    'restore-result.json','restore.jsonl','run-upload-result.json','run-restore-result.json','collector.lock',
    'guard-probe.lock','action.lock'];
  for(const name of forbidden)if(fs.existsSync(path.join(run,name)))C.fail('PROBE_FORBIDDEN_ARTIFACT_PRESENT',{name});
  const source=sourceManifest?validateSourceManifest(sourceManifest):null;
  return {
    status:'GUARD_COLLECTOR_CONTROL_PLANE_PROBE_INDEPENDENTLY_VERIFIED',
    verifierVersion:VERIFIER_VERSION,
    ...(source?{sourceEvidence:{
      commit:source.sourceCommit,probeRunTree:source.probeRunTree,runTree:source.runTree,
      materializedFiles:source.files,totalBytes:source.totalBytes,
    }}:{}),
    runId:session.runId,durationMs:probe.durationMs,collectorPid:probe.collectorPid,
    timeChannel:channel,firstTick:probe.firstTick,lastTick:probe.lastTick,
    heartbeatEvidence:continuity,
    onlineState:comparison,onlineDigest:after.digest,collectorResultSha256:sha256(path.join(run,'collector-result.json')),
    guardProbeResultSha256:sha256(path.join(run,'guard-probe-result.json')),
    guardProbeTimelineSha256:sha256(path.join(run,'guard-probe.jsonl')),
    formalProfileUsed:false,candidateSnapshotUsed:false,codeWriteRequests:0,
  };
}

function main(argv){
  const o=C.options(argv,['run','out','source-manifest'],['verify']);C.required(o,'run','out','source-manifest');
  if(!o.verify)C.fail('EXPLICIT_VERIFY_FLAG_REQUIRED');
  const run=path.resolve(o.run),out=path.resolve(o.out),source=validateSourceManifest(C.readJson(path.resolve(o['source-manifest']),2*1024*1024));
  if(fs.existsSync(out))C.fail('OUTPUT_ALREADY_EXISTS');
  const result=verifyRun(run,{sourceManifest:source});
  C.writeNew(out,result);
  console.log(JSON.stringify(result));
}

module.exports={VERIFIER_VERSION,PINNED_SOURCE,readJsonLines,validateSourceManifest,verifyRun,main};
if(require.main===module)C.entrypoint(()=>main(process.argv.slice(2)));
