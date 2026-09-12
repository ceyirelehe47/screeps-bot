'use strict';

const path=require('node:path');
const C=require('./common.cjs');

const BASELINE_KIND='guard-control-plane-probe-baseline/v2';
const SESSION_KIND='guard-control-plane-probe-session/v2';
const MIN_DURATION_MS=1200000;
const MAX_DURATION_MS=1800000;
const SESSION_START_GRACE_MS=5*60*1000;
const SESSION_WALL_MARGIN_MS=3*60*1000;
const PROBE_POLICY=Object.freeze({
  timeIntervalMs:15000,
  startupGraceMs:15000,
  channelSilenceMs:45000,
  minimumSuccessfulReadsFor25m:98,
  maximumTotalFailedCycles:1,
  requiredFinalConsecutiveFailedCycles:0,
});

function validateBaseline(value){
  if(!C.obj(value)||value.kind!==BASELINE_KIND||!C.safeTime(value.capturedAtMs)
    ||value.server!==C.EXPECTED.server||value.username!==C.EXPECTED.username
    ||value.userId!==C.EXPECTED.userId||value.branch!==C.EXPECTED.branch||value.shard!==C.EXPECTED.shard
    ||!Number.isSafeInteger(value.observedTick)||value.observedTick<0||value.moduleBodiesPersisted!==false
    ||C.own(value,'modules'))C.fail('PROBE_BASELINE_INVALID');
  if(!C.obj(value.build)||value.build.commit!==C.PRODUCTION_BASE||value.build.tree!==C.PRODUCTION_TREE
    ||value.build.deployBranch!==C.EXPECTED.branch||!['false','folded_out'].includes(value.build.dirty)
    ||typeof value.build.tag!=='string'||!value.build.tag.length)C.fail('PROBE_BASELINE_BUILD_INVALID');
  if(!C.exact(value.digest,C.ORIGINAL_DIGEST))C.fail('PROBE_BASELINE_DIGEST_INVALID');
  return value;
}

function validateProbeSession(value){
  if(!C.obj(value)||value.kind!==SESSION_KIND||typeof value.runId!=='string'||!/^[a-f0-9]{32}$/.test(value.runId)
    ||!C.safeTime(value.preparedAtMs)||value.startDeadlineAtMs!==value.preparedAtMs+SESSION_START_GRACE_MS
    ||!Number.isSafeInteger(value.durationMs)||value.durationMs<MIN_DURATION_MS||value.durationMs>MAX_DURATION_MS
    ||value.wallLimitMs!==value.durationMs+SESSION_WALL_MARGIN_MS
    ||value.server!==C.EXPECTED.server||value.username!==C.EXPECTED.username||value.userId!==C.EXPECTED.userId
    ||value.branch!==C.EXPECTED.branch||value.shard!==C.EXPECTED.shard
    ||!C.exact(value.policy,PROBE_POLICY)||value.formalProfileUsed!==false||value.candidateSnapshotUsed!==false
    ||value.backupSnapshotPersisted!==false||value.onlineWriteAuthorized!==false)C.fail('PROBE_SESSION_INVALID');
  for(const forbidden of ['profile','candidate','backup','dueTicks','startTick','endTick'])
    if(C.own(value,forbidden))C.fail('PROBE_SESSION_FORMAL_FIELD_FORBIDDEN',{field:forbidden});
  validateBaseline(value.baseline);
  return value;
}

function loadProbeSession(run){return validateProbeSession(C.readJson(path.join(run,'probe-session.json'),65536));}

function compareBaselines(before,after){
  validateBaseline(before);validateBaseline(after);
  if(before.server!==after.server||before.username!==after.username||before.userId!==after.userId
    ||before.branch!==after.branch||before.shard!==after.shard)C.fail('PROBE_ONLINE_IDENTITY_CHANGED');
  if(!C.exact(before.digest,after.digest)||!C.exact(before.build,after.build))C.fail('PROBE_ONLINE_CODE_CHANGED');
  if(after.observedTick<before.observedTick)C.fail('PROBE_ONLINE_TICK_REGRESSED');
  return {
    status:'PROBE_ONLINE_STATE_UNCHANGED',beforeTick:before.observedTick,afterTick:after.observedTick,
    digestHash:after.digest.hash,buildCommit:after.build.commit,
  };
}

function expectedMinimumTimeReads(durationMs,timeIntervalMs=PROBE_POLICY.timeIntervalMs){
  if(!Number.isSafeInteger(durationMs)||durationMs<1||!Number.isSafeInteger(timeIntervalMs)||timeIntervalMs<1)
    C.fail('PROBE_SCHEDULE_ARGUMENT_INVALID');
  return Math.max(1,Math.floor(durationMs/timeIntervalMs)-2);
}

module.exports={
  BASELINE_KIND,SESSION_KIND,MIN_DURATION_MS,MAX_DURATION_MS,
  SESSION_START_GRACE_MS,SESSION_WALL_MARGIN_MS,PROBE_POLICY,
  validateBaseline,validateProbeSession,loadProbeSession,compareBaselines,expectedMinimumTimeReads,
};
