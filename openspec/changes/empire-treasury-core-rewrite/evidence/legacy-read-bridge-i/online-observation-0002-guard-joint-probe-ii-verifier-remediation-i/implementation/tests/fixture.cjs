'use strict';

const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const C=require('../verifier-runtime/common.cjs');
const S=require('../verifier-runtime/evidence-contract.cjs');
const V=require('../verifier-runtime/verify-joint-probe.cjs');

function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
function baseline(tick,at){return {
  kind:S.BASELINE_KIND,capturedAtMs:at,...C.EXPECTED,observedTick:tick,
  build:{commit:C.PRODUCTION_BASE,tree:C.PRODUCTION_TREE,dirty:'folded_out',deployBranch:C.EXPECTED.branch,tag:'2026.8.29-6+06ffedb@test'},
  digest:C.clone(C.ORIGINAL_DIGEST),moduleBodiesPersisted:false,
};}
function session(before,{runId='a'.repeat(32),durationMs=1500000,preparedAtMs=950000}={}){return {
  kind:S.SESSION_KIND,runId,preparedAtMs,startDeadlineAtMs:preparedAtMs+S.SESSION_START_GRACE_MS,
  durationMs,wallLimitMs:durationMs+S.SESSION_WALL_MARGIN_MS,...C.EXPECTED,
  baseline:C.clone(before),policy:{...S.PROBE_POLICY},formalProfileUsed:false,candidateSnapshotUsed:false,
  backupSnapshotPersisted:false,onlineWriteAuthorized:false,
};}
function distributedGaps({spanMs=1495086,rows=287,extendedIndex=164,extendedGapMs=10033}={}){
  const count=rows-1;if(count<2)throw new Error('rows');
  const ordinaryCount=count-1,ordinaryTotal=spanMs-extendedGapMs;
  const base=Math.floor(ordinaryTotal/ordinaryCount),remainder=ordinaryTotal-base*ordinaryCount;
  const gaps=[];let ordinarySeen=0;
  for(let index=0;index<count;index++){
    if(index===extendedIndex){gaps.push(extendedGapMs);continue;}
    gaps.push(base+(ordinarySeen<remainder?1:0));ordinarySeen++;
  }
  if(gaps.reduce((sum,value)=>sum+value,0)!==spanMs)throw new Error('gap sum');
  return gaps;
}
function healthTimes({probeStart=1000000,firstOffset=4,...options}={}){
  const gaps=distributedGaps(options),times=[probeStart+firstOffset];
  for(const gap of gaps)times.push(times[times.length-1]+gap);
  return {times,gaps};
}
function makeValid(options={}){
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'readjudication-'));
  const run=path.join(parent,'run');fs.mkdirSync(run);
  const probeStart=options.probeStart??1000000;
  const durationMs=options.durationMs??1500000;
  const probeDurationMs=options.probeDurationMs??1500460;
  const collectorPid=options.collectorPid??32772;
  const before=baseline(73636408,probeStart-49058),after=baseline(73636832,probeStart+durationMs+21079);
  const probeSession=session(before,{durationMs,preparedAtMs:probeStart-49058});
  writeJson(path.join(run,'probe-session.json'),probeSession);
  writeJson(path.join(run,'preflight-before.json'),before);
  writeJson(path.join(run,'preflight-after.json'),after);
  writeJson(path.join(run,'probe-prepared.json'),{
    status:'CONTROL_PLANE_PROBE_SESSION_PREPARED',runId:probeSession.runId,preparedAtMs:probeSession.preparedAtMs,
    durationMs,observedTick:before.observedTick,digestHash:before.digest.hash,
    formalProfileUsed:false,candidateSnapshotUsed:false,onlineWriteAuthorized:false,
  });
  writeJson(path.join(run,'online-state-verification.json'),S.compareBaselines(before,after));
  const readyAtMs=probeStart-285;
  writeJson(path.join(run,'collector-ready.json'),{status:'PROBE_COLLECTOR_READY',runId:probeSession.runId,pid:collectorPid,
    readyAtMs,lastConsoleAtMs:readyAtMs-10,lastCpuAtMs:readyAtMs-12});
  const collectorClosedAtMs=probeStart+1500361;
  writeJson(path.join(run,'collector-result.json'),{kind:'collector-result-v2',sessionKind:S.SESSION_KIND,
    runId:probeSession.runId,pid:collectorPid,status:'closed',reason:'probe_complete',exitCode:0,footerWritten:true,
    lockRemoved:true,closedAtMs:collectorClosedAtMs});
  writeJson(path.join(run,'heartbeat.json'),{sessionKind:S.SESSION_KIND,runId:probeSession.runId,pid:collectorPid,
    state:'closed',socketState:'closed',stopReason:'probe_complete',unexpectedBridgeReports:0,closedAtMs:collectorClosedAtMs-3});
  writeJson(path.join(run,'collector-stop.json'),{runId:probeSession.runId,reason:'probe_complete',
    requestedAtMs:probeStart+1500209,requestedByPid:9052});
  const {times,gaps}=healthTimes({probeStart,rows:options.rows??287,spanMs:options.spanMs??1495086,
    extendedIndex:options.extendedIndex??164,extendedGapMs:options.extendedGapMs??10033});
  const failureGapIndex=options.extendedIndex??164;
  const failureFrom=times[failureGapIndex];
  const attemptTimes=[failureFrom+4016,failureFrom+6782,failureFrom+9521];
  const cycleAt=failureFrom+9522;
  const successCount=99,lastSuccessAtMs=probeStart+1486396;
  const successLines=[];
  for(let index=0;index<successCount;index++){
    const atMs=Math.round(probeStart+1387+index*((lastSuccessAtMs-(probeStart+1387))/(successCount-1)));
    const tick=Math.round(73636421+index*((73636790-73636421)/(successCount-1)));
    successLines.push({at:new Date(atMs).toISOString(),kind:'guard-time-read-success',attempt:1,time:tick,atMs});
  }
  const attemptLines=attemptTimes.map((atMs,index)=>({at:new Date(atMs).toISOString(),kind:'guard-time-read-attempt-failed',
    attempt:index+1,reason:'guard_time_deadline_failure',stage:'game_time_read',code:'HTTP_DEADLINE'}));
  const cycleLine={at:new Date(cycleAt).toISOString(),kind:'guard-time-read-cycle-failed',terminal:false,atMs:cycleAt};
  const events=[{at:new Date(probeStart).toISOString(),kind:'guard-probe-start',runId:probeSession.runId,pid:9052,
    durationMs,collectorPid,sessionKind:S.SESSION_KIND,formalProfileUsed:false,candidateSnapshotUsed:false}];
  for(const atMs of times)events.push({at:new Date(atMs).toISOString(),kind:'guard-probe-heartbeat',atMs,collectorPid,
    collectorState:'streaming',socketState:'open',consoleAgeMs:Math.min(5200,100+(atMs%4700)),
    cpuAgeMs:Math.min(5200,102+(atMs%4700)),unexpectedBridgeReports:0});
  events.push(...successLines,...attemptLines,cycleLine);
  events.sort((left,right)=>{
    const lt=left.atMs??Date.parse(left.at),rt=right.atMs??Date.parse(right.at);
    return lt-rt||String(left.kind).localeCompare(String(right.kind));
  });
  fs.writeFileSync(path.join(run,'guard-probe.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(run,'console.jsonl'),JSON.stringify({kind:'collector-footer',sessionKind:S.SESSION_KIND,
    runId:probeSession.runId,pid:collectorPid,reason:'probe_complete',exitCode:0})+'\n');
  fs.writeFileSync(path.join(run,'collector.exit.txt'),'0\n');
  fs.writeFileSync(path.join(run,'guard-probe.exit.txt'),'0\n');
  writeJson(path.join(run,'guard-probe-result.json'),{
    kind:'guard-collector-control-plane-probe/v2',sessionKind:S.SESSION_KIND,
    status:'GUARD_COLLECTOR_CONTROL_PLANE_PROBE_VERIFIED',runId:probeSession.runId,reason:'probe_complete',
    startedAtMs:probeStart,durationMs:probeDurationMs,firstTick:successLines[0].time,lastTick:successLines.at(-1).time,
    expectedMinimumTimeReads:98,timeChannel:{createdAtMs:probeStart,consecutiveFailedCycles:0,totalAttempts:102,
      totalSuccessfulReads:99,totalFailedCycles:1,lastSuccessAtMs,lastFailureAtMs:null,lastFailure:null},
    collectorTerminal:'ok',collectorPid,consoleChannelVerified:true,cpuChannelVerified:true,
    collectorResult:{status:'closed',reason:'probe_complete',exitCode:0,footerWritten:true,pid:collectorPid},
    unexpectedBridgeReports:0,uploadAttemptPresent:false,codeWriteRequests:0,formalProfileUsed:false,
    candidateSnapshotUsed:false,backupSnapshotPersisted:false,auditFailed:false,failure:null,
  });
  return {parent,run,session:probeSession,probeStart,times,gaps,failureGapIndex,cycleAt,attemptTimes};
}
function readLines(file){return fs.readFileSync(file,'utf8').trim().split(/\r?\n/).map(JSON.parse);}
function writeLines(file,lines){fs.writeFileSync(file,lines.map(JSON.stringify).join('\n')+'\n');}
function mutateLines(run,fn){const file=path.join(run,'guard-probe.jsonl'),lines=readLines(file);fn(lines);writeLines(file,lines);}
function cleanup(value){fs.rmSync(value.parent,{recursive:true,force:true});}
function sourceManifest(){return {status:'PINNED_GUARD_JOINT_PROBE_EVIDENCE_MATERIALIZED',
  sourceCommit:V.PINNED_SOURCE.commit,probeRunTree:V.PINNED_SOURCE.probeRunTree,runTree:V.PINNED_SOURCE.runTree,
  files:30,totalBytes:260000,entries:[{path:'run/guard-probe.jsonl',blob:'x',bytes:1,sha256:'0'.repeat(64)}]};}
module.exports={writeJson,baseline,session,distributedGaps,healthTimes,makeValid,readLines,writeLines,mutateLines,cleanup,sourceManifest};
