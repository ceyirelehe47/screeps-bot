'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
const C=require('./common.cjs');

const DEFAULT_TIME_POLICY=Object.freeze({
  attemptsPerCycle:3,
  perAttemptMaxMs:2500,
  retryDelaysMs:Object.freeze([250,750]),
  maxConsecutiveFailedCycles:2,
  maxSuccessAgeMs:45000,
});

const VALID_STAGES=new Set([
  'startup','heartbeat_read','collector_result_read','upload_attempt_read',
  'game_time_read','guard_ready_write','closing_write','restore_dispatch','internal',
]);

function stableErrorCode(error) {
  const code=error&&typeof error.code==='string'?error.code:null;
  return code&&/^[A-Z0-9_.:-]{1,128}$/.test(code)?code:'UNEXPECTED_LOCAL_FAILURE';
}
function stableErrorName(error) {
  return error&&typeof error.name==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(error.name)
    ?error.name:null;
}
function hashText(value) {
  return value?crypto.createHash('sha256').update(value).digest('hex'):null;
}
function truncateUtf8(value,maxBytes) {
  const text=String(value??'');let out='',bytes=0;
  for(const ch of text){const size=Buffer.byteLength(ch);if(bytes+size>maxBytes)break;out+=ch;bytes+=size;}
  return {text:out,bytes,truncated:bytes<Buffer.byteLength(text)};
}
function safeGuardDiagnostic(stage,error,redact=C.redactor()) {
  const raw=error&&typeof error.message==='string'?error.message:'';
  const redacted=redact(raw);
  const sanitized=truncateUtf8(redacted,1024);
  return {
    stage:VALID_STAGES.has(stage)?stage:'internal',
    code:stableErrorCode(error),
    name:stableErrorName(error),
    messageBytes:sanitized.bytes,
    messageSha256:hashText(sanitized.text),
    messageTruncated:sanitized.truncated,
    redactionChanged:redacted!==raw,
  };
}
function classifyGuardFailure(stage,error) {
  const code=stableErrorCode(error);
  if(stage==='game_time_read') {
    if(code==='HTTP_TRANSPORT_ERROR')return {reason:'guard_time_transport_failure',stage,code};
    if(code==='HTTP_DEADLINE'||code==='OPERATION_DEADLINE')return {reason:'guard_time_deadline_failure',stage,code};
    if(code==='GAME_TICK_UNREADABLE')return {reason:'guard_time_payload_failure',stage,code};
    return {reason:'guard_time_unclassified_failure',stage,code};
  }
  if(stage==='upload_attempt_read')return {reason:'guard_upload_attempt_read_failure',stage,code};
  if(stage==='guard_ready_write'||stage==='closing_write')return {reason:'guard_artifact_write_failure',stage,code};
  if(stage==='heartbeat_read'||stage==='collector_result_read')return {reason:'guard_artifact_read_failure',stage,code};
  if(stage==='restore_dispatch')return {reason:'guard_restore_dispatch_failure',stage,code};
  return {reason:'guard_internal_failure',stage:VALID_STAGES.has(stage)?stage:'internal',code};
}

async function readJsonArtifact(file,maxBytes,{required=false,attempts=3,retryDelaysMs=[20,50],
  pause=C.pause,exists=fs.existsSync,read=C.readJson}={}) {
  if(typeof file!=='string'||!file||!Number.isSafeInteger(maxBytes)||maxBytes<1
    ||!Number.isSafeInteger(attempts)||attempts<1||attempts>5
    ||!Array.isArray(retryDelaysMs)||retryDelaysMs.length!==attempts-1
    ||retryDelaysMs.some(x=>!Number.isSafeInteger(x)||x<0||x>1000)
    ||typeof pause!=='function'||typeof exists!=='function'||typeof read!=='function')C.fail('ARTIFACT_READ_ARGUMENT_INVALID');
  if(!exists(file)) {
    if(required)C.fail('LOCAL_JSON_UNREADABLE');
    return undefined;
  }
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++) {
    try{return read(file,maxBytes);}
    catch(error){lastError=error;if(attempt<attempts)await pause(retryDelaysMs[attempt-1]);}
  }
  if(!required&&!exists(file))return undefined;
  throw lastError||new C.Failure('LOCAL_JSON_UNREADABLE');
}

function createTimeChannelState(now=Date.now()) {
  return {
    createdAtMs:now,
    consecutiveFailedCycles:0,
    totalAttempts:0,
    totalSuccessfulReads:0,
    totalFailedCycles:0,
    lastSuccessAtMs:null,
    lastFailureAtMs:null,
    lastFailure:null,
  };
}
function timeChannelSnapshot(state) {
  return {
    createdAtMs:state.createdAtMs,
    consecutiveFailedCycles:state.consecutiveFailedCycles,
    totalAttempts:state.totalAttempts,
    totalSuccessfulReads:state.totalSuccessfulReads,
    totalFailedCycles:state.totalFailedCycles,
    lastSuccessAtMs:state.lastSuccessAtMs,
    lastFailureAtMs:state.lastFailureAtMs,
    lastFailure:state.lastFailure?{...state.lastFailure}:null,
  };
}
function validState(state) {
  return state&&Number.isSafeInteger(state.createdAtMs)&&state.createdAtMs>=0
    &&Number.isSafeInteger(state.consecutiveFailedCycles)&&state.consecutiveFailedCycles>=0
    &&Number.isSafeInteger(state.totalAttempts)&&state.totalAttempts>=0
    &&Number.isSafeInteger(state.totalSuccessfulReads)&&state.totalSuccessfulReads>=0
    &&Number.isSafeInteger(state.totalFailedCycles)&&state.totalFailedCycles>=0;
}
function validPolicy(policy) {
  return policy&&Number.isSafeInteger(policy.attemptsPerCycle)&&policy.attemptsPerCycle>=1&&policy.attemptsPerCycle<=5
    &&Number.isSafeInteger(policy.perAttemptMaxMs)&&policy.perAttemptMaxMs>=100&&policy.perAttemptMaxMs<=8000
    &&Array.isArray(policy.retryDelaysMs)&&policy.retryDelaysMs.length===policy.attemptsPerCycle-1
    &&policy.retryDelaysMs.every(x=>Number.isSafeInteger(x)&&x>=0&&x<=5000)
    &&Number.isSafeInteger(policy.maxConsecutiveFailedCycles)&&policy.maxConsecutiveFailedCycles>=1
    &&policy.maxConsecutiveFailedCycles<=5
    &&Number.isSafeInteger(policy.maxSuccessAgeMs)&&policy.maxSuccessAgeMs>=10000&&policy.maxSuccessAgeMs<=120000;
}
async function readGameTimeResilient({
  api,shard,budgetMs,state,record=()=>{},now=Date.now,pause=C.pause,redact=C.redactor(),
  policy=DEFAULT_TIME_POLICY,
}) {
  if(!api||typeof api.time!=='function'||typeof shard!=='string'||!shard.length)C.fail('TIME_CHANNEL_ARGUMENT_INVALID');
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>60000)C.fail('TIME_CHANNEL_BUDGET_INVALID');
  if(!validState(state)||!validPolicy(policy)||typeof now!=='function'||typeof pause!=='function'
    ||typeof record!=='function'||typeof redact!=='function')C.fail('TIME_CHANNEL_ARGUMENT_INVALID');
  const cycleStartedAt=now();
  let lastFailure=null;
  for(let attempt=1;attempt<=policy.attemptsPerCycle;attempt++) {
    const elapsed=Math.max(0,now()-cycleStartedAt);
    const remaining=budgetMs-elapsed;
    if(remaining<=0) {
      const error=new C.Failure('OPERATION_DEADLINE');
      const classified=classifyGuardFailure('game_time_read',error);
      lastFailure={...classified,diagnostic:safeGuardDiagnostic('game_time_read',error,redact)};
      record({kind:'guard-time-read-attempt-failed',attempt,...lastFailure});
      break;
    }
    state.totalAttempts++;
    try {
      const response=await api.time(shard,Math.max(1,Math.min(policy.perAttemptMaxMs,remaining)));
      if(!response||response.ok!==1||!Number.isSafeInteger(response.time)||response.time<0) {
        C.fail('GAME_TICK_UNREADABLE');
      }
      const atMs=now();
      state.consecutiveFailedCycles=0;
      state.totalSuccessfulReads++;
      state.lastSuccessAtMs=atMs;
      state.lastFailureAtMs=null;
      state.lastFailure=null;
      record({kind:'guard-time-read-success',attempt,time:response.time,atMs});
      return {status:'ok',time:response.time,state:timeChannelSnapshot(state)};
    } catch(error) {
      const classified=classifyGuardFailure('game_time_read',error);
      lastFailure={...classified,diagnostic:safeGuardDiagnostic('game_time_read',error,redact)};
      record({kind:'guard-time-read-attempt-failed',attempt,...lastFailure});
      if(attempt<policy.attemptsPerCycle)await pause(policy.retryDelaysMs[attempt-1]);
    }
  }
  const atMs=now();
  state.consecutiveFailedCycles++;
  state.totalFailedCycles++;
  state.lastFailureAtMs=atMs;
  state.lastFailure=lastFailure||{
    reason:'guard_time_unclassified_failure',stage:'game_time_read',code:'NO_FAILURE_DETAIL',
    diagnostic:{stage:'game_time_read',code:'NO_FAILURE_DETAIL',name:null,messageBytes:0,
      messageSha256:null,messageTruncated:false,redactionChanged:false},
  };
  const terminal=state.consecutiveFailedCycles>=policy.maxConsecutiveFailedCycles
    ||(state.lastSuccessAtMs!==null&&atMs-state.lastSuccessAtMs>=policy.maxSuccessAgeMs);
  record({kind:'guard-time-read-cycle-failed',terminal,atMs,timeChannel:timeChannelSnapshot(state)});
  return {status:terminal?'terminal':'degraded',failure:{...state.lastFailure},state:timeChannelSnapshot(state)};
}

module.exports={
  DEFAULT_TIME_POLICY,stableErrorCode,truncateUtf8,safeGuardDiagnostic,classifyGuardFailure,readJsonArtifact,
  createTimeChannelState,timeChannelSnapshot,readGameTimeResilient,
};
