'use strict';
const fs=require('node:fs');const path=require('node:path');
const {readJson,fail,sha256,integer,EXPECTED}=require('./common.cjs');
const P=require('./protocol.cjs');
function loadSession(dir,guard) {
  const s=readJson(path.join(dir,'session.json'),32768);
  if(s.kind!=='compat-online-run-v1'||typeof s.runId!=='string'||!/^[a-f0-9]{32}$/.test(s.runId))fail('SESSION_INVALID');
  for(const [k,v] of Object.entries(EXPECTED))if(s[k]!==v)fail('SESSION_IDENTITY_MISMATCH');
  integer(s.preparedAtMs,0,Number.MAX_SAFE_INTEGER);integer(s.wallLimitMs,1,5400000);
  const cfg=s.profile;
  if(!cfg||cfg.enabled!==true||cfg.shardName!==s.shard||!Array.isArray(cfg.rooms)||cfg.rooms.length<1||cfg.rooms.length>2
    ||cfg.rooms.some(r=>!['E3N59','E4N58'].includes(r))||new Set(cfg.rooms).size!==cfg.rooms.length
    ||JSON.stringify(cfg.resources)!=='["energy","H"]'||cfg.intervalTicks!==100||cfg.endTick!==cfg.startTick+1100
    ||!Number.isSafeInteger(cfg.startTick)||cfg.startTick<0||cfg.startTick%100!==0
    ||cfg.minBucket!==2000||cfg.maxSampleCpu!==2||cfg.reserveCpu!==5||cfg.maxLogBytes!==16384)fail('SESSION_PROFILE_INVALID');
  for(const name of ['backup','candidate']) {
    const p=path.join(dir,name+'.json'),raw=fs.readFileSync(p);
    if(sha256(raw)!==s[name+'FileSha256'])fail('SESSION_SNAPSHOT_CHANGED');
    s[name]=P.validateSnapshot(JSON.parse(raw),guard);
  }
  if(P.equalModules(s.backup.modules,s.candidate.modules,guard))fail('IDENTICAL_BACKUP_AND_DEPLOYMENT');
  return s;
}
function heartbeatReason(h,s,now,{maxAgeMs=10000,maxSilenceMs=45000}={}) {
  if(!h||h.runId!==s.runId||!Number.isSafeInteger(h.pid)||h.pid<=0||h.state!=='streaming'
    ||h.userId!==s.userId||h.shard!==s.shard) return 'collector_identity_or_state';
  for(const key of ['updatedAtMs','lastConsoleAtMs'])if(!Number.isFinite(h[key])||h[key]>now+1000||now-h[key]>(key==='updatedAtMs'?maxAgeMs:maxSilenceMs)) return 'collector_stalled';
  if(h.stopReason)return 'collector_reported_failure';
  return null;
}
function triggerReason({session:s,heartbeat:h,now,attempt,elapsedSinceAttemptMs=0,tick,closing=false}) {
  if(closing)return 'explicit_close';
  if(attempt && (now-attempt.startedAtMs>=s.wallLimitMs||elapsedSinceAttemptMs>=s.wallLimitMs))return 'wall_deadline';
  const bad=heartbeatReason(h,s,now);if(bad)return bad;
  if(!attempt)return now-s.preparedAtMs>15*60*1000?'preparation_expired':null;
  if(Number.isSafeInteger(tick)) {
    if(tick>s.profile.endTick)return 'tick_window_ended';
    if(tick>=s.profile.startTick+200 && (!Number.isSafeInteger(h.lastBridgeTick)||h.lastBridgeTick<tick-200))return 'bridge_sample_stalled';
  }
  if(h.lastBridgeTick===s.profile.endTick)return 'last_sample_received';
  return null;
}
module.exports={loadSession,heartbeatReason,triggerReason};
