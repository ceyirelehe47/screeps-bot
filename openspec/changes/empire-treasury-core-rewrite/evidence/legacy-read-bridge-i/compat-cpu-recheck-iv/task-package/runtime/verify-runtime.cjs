'use strict';
const path=require('node:path');const C=require('./common.cjs'),K=require('./policy.cjs');
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
  scope:'fresh shard1 console and account CPU; not a continuation of diagnostic observation'};
}
module.exports={jsonl,verifyObserver,gapMax};
