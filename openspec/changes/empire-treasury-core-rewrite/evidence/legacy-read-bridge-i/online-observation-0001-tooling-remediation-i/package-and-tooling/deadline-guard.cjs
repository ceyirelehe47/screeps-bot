#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const path=require('node:path');const {performance}=require('node:perf_hooks');
const C=require('./common.cjs');const {client}=require('./transport.cjs');const {loadSession,triggerReason,heartbeatReason}=require('./session.cjs');const {runBounded}=require('./bounded-child.cjs');
async function main(argv) {
  const o=C.options(argv,['repo','secret','run'],['execute']);C.required(o,'repo','secret','run');
  if(!o.execute)C.fail('EXPLICIT_EXECUTE_REQUIRED_FOR_GUARD');
  const secret=C.loadSecret(o.secret),g=C.loadGuard(o.repo),s=loadSession(o.run,g);
  const file=n=>path.join(o.run,n),api=client(secret);
  C.writeNew(file('guard.lock'),{runId:s.runId,pid:process.pid});
  const begun=performance.now();let reason=null,lastTimeRead=-Infinity,tick,seenAttemptAt=null,attemptStart=null,initialElapsedMs=0;
  let auditFailed=false;
  const record=x=>{try{C.audit(file('guard.jsonl'),x,secret.redact);}catch{auditFailed=true;}};
  const signal=()=>{reason='operator_stop';};process.once('SIGINT',signal);process.once('SIGTERM',signal);
  record({kind:'guard-start',runId:s.runId,pid:process.pid});
  try {
    while(!reason) {
      let h,attempt;
      try {h=C.readJson(file('heartbeat.json'),16384);}catch{}
      if(fs.existsSync(file('upload-attempt.json'))) {
        attempt=C.readJson(file('upload-attempt.json'),16384);
        if(attempt.runId!==s.runId||attempt.candidateHash!==s.candidate.digest.hash||!Number.isSafeInteger(attempt.startedAtMs)||attempt.startedAtMs>Date.now()+1000){reason='attempt_record_invalid';break;}
        if(seenAttemptAt===null){seenAttemptAt=performance.now();attemptStart=attempt.startedAtMs;initialElapsedMs=Math.max(0,Date.now()-attempt.startedAtMs);}
        if(attemptStart!==attempt.startedAtMs){reason='attempt_record_changed';break;}
      }
      if(auditFailed){reason='audit_io_failure';break;}
      // Startup is bounded; no guard-ready is published before valid console activity.
      if(!attempt&&heartbeatReason(h,s,Date.now())&&performance.now()-begun<15000){await C.pause(250);continue;}
      const elapsed=seenAttemptAt===null?0:initialElapsedMs+performance.now()-seenAttemptAt;
      reason=triggerReason({session:s,heartbeat:h,now:Date.now(),attempt,elapsedSinceAttemptMs:elapsed,tick,closing:fs.existsSync(file('closing.json'))});
      if(reason)break;
      // Retain freshness of the tick watchdog even if the collector process is alive.
      if(attempt && performance.now()-lastTimeRead>=15000) {
        const budget=Math.max(1,Math.min(8000,s.wallLimitMs-(Date.now()-attempt.startedAtMs),s.wallLimitMs-elapsed));
        const r=await api.time(s.shard,budget);
        if(!Number.isSafeInteger(r.time)||r.time<0){reason='game_tick_unreadable';break;}
        if(tick!==undefined&&r.time<tick){reason='game_tick_regressed';break;}tick=r.time;lastTimeRead=performance.now();
        reason=triggerReason({session:s,heartbeat:h,now:Date.now(),attempt,elapsedSinceAttemptMs:elapsed,tick});if(reason)break;
      }
      C.atomicJson(file('guard-ready.json'),{runId:s.runId,pid:process.pid,updatedAtMs:Date.now(),state:'ready'});
      await C.pause(500);
    }
  }catch{reason='guard_read_or_channel_failure';}
  record({kind:'close-trigger',reason});
  try{C.atomicJson(file('closing.json'),{runId:s.runId,reason,atMs:Date.now()});}catch{auditFailed=true;}
  try{C.atomicJson(file('guard-ready.json'),{runId:s.runId,pid:process.pid,state:'closing',updatedAtMs:Date.now()});}catch{auditFailed=true;}
  const outcome=await runBounded(process.execPath,[path.join(__dirname,'restore-modules.cjs'),'--repo',path.resolve(o.repo),
    '--secret',path.resolve(o.secret),'--run',path.resolve(o.run),'--execute'],{redact:secret.redact});
  let result;try{result=JSON.parse(outcome.stdout.trim().split('\n').pop());}catch{}
  const restored=outcome.code===0&&outcome.childClosed&&!outcome.timedOut&&result?.confirmed===true
    &&['RESTORED_AND_VERIFIED','ALREADY_RESTORED'].includes(result.status)&&!result.auditFailed;
  record({kind:'guard-result',reason,restored,childClosed:outcome.childClosed,timedOut:outcome.timedOut,
    killRequested:outcome.killRequested,elapsedMs:outcome.elapsedMs,restoreStatus:result?.status||'NO_VALID_RESULT'});
  const terminal={status:restored&&!auditFailed?'ONLINE_BYTES_RESTORED':'ONLINE_CLOSE_UNCONFIRMED',
    runId:s.runId,reason,restored,auditFailed,childClosed:outcome.childClosed,timedOut:outcome.timedOut};
  try{C.atomicJson(file('guard-result.json'),terminal);}catch{terminal.auditFailed=true;terminal.status='ONLINE_CLOSE_UNCONFIRMED';}
  try{fs.unlinkSync(file('guard.lock'));}catch{terminal.auditFailed=true;terminal.status='ONLINE_CLOSE_UNCONFIRMED';}
  console.log(secret.redact(JSON.stringify(terminal)));
  process.exitCode=terminal.status==='ONLINE_BYTES_RESTORED'?0:6;
}
module.exports={main};if(require.main===module)C.entrypoint(()=>main(process.argv.slice(2)));
