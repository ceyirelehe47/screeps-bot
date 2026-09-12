'use strict';
const C=require('./common.cjs'),K=require('./policy.cjs');
const nn=x=>Number.isSafeInteger(x)&&x>=0;
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
function decode(s){return s.replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')
 .replace(/&#(\d+);/g,(_,n)=>+n<=0x10ffff?String.fromCodePoint(+n):'\uFFFD').replace(/&amp;/g,'&');}
function complete(c){return c?.complete===true&&c.globalIncomplete!==true&&(!('invalidRecords' in c)||c.invalidRecords===0)
 &&(!('incompleteScopeCount' in c)||c.incompleteScopeCount===0);}
function sampleError(r,p){
 if(!r||r.kind!=='treasury-legacy-read-bridge'||!K.dueTicks(p).includes(r.tick))return 'SAMPLE_OUTSIDE_WINDOW';
 if(r.status!=='sampled')return 'SAMPLE_NOT_COMPLETE';
 if(r.shard!==p.shardName||r.sourceCommit!=='01bd9831454950c4928df98dd8679692b55603e5'||r.productionBase!==C.PRODUCTION_BASE)return 'SAMPLE_SOURCE_MISMATCH';
 if(r.authorizesActions!==false||r.spendable!==null||r.kernelLifecycleRun!==false||r.facadeQueryRun!==false
  ||r.storageMode!=='heap_only'||r.evaluation!=='observation_and_legacy_commitments_only')return 'SAMPLE_AUTHORITY_CHANGED';
 if(JSON.stringify(r.scope?.rooms)!==JSON.stringify(p.rooms)||JSON.stringify(r.scope?.resources)!==JSON.stringify(p.resources)||r.scope?.isEmpireTotal!==false)return 'SAMPLE_SCOPE_MISMATCH';
 if(!finite(r.cpuBeforeSerializationAndEmit)||r.cpuBeforeSerializationAndEmit>=p.maxSampleCpu||r.cooperativeBudget!==true)return 'SAMPLE_CPU_BUDGET';
 if(!Array.isArray(r.endpoints)||r.endpoints.length!==4||r.requestedEndpointRows!==4||r.collectedEndpointRows!==4
  ||JSON.stringify(r.coreObservationRooms)!==JSON.stringify(p.rooms))return 'ENDPOINT_COUNT_MISMATCH';
 for(const room of p.rooms)for(const kind of ['storage','terminal']){
  const a=r.endpoints.filter(x=>x.room===room&&x.location===kind);if(a.length!==1)return 'ENDPOINT_DUPLICATE_OR_MISSING';
  const x=a[0],d=x.direct;
  if(x.directStatus!=='ok'||x.coreComparison!=='match_selected_scope'||!Array.isArray(x.coreMismatches)||x.coreMismatches.length)return 'CORE_OBSERVATION_MISMATCH';
  if(!d||typeof d.id!=='string'||!d.id||!nn(d.used)||!nn(d.capacity)||!Number.isSafeInteger(d.free)
   ||!(d.used+d.free===d.capacity||(d.used>d.capacity&&d.free===0))||d.overCapacity!==(d.used>d.capacity)
   ||typeof d.active!=='boolean'||(kind==='terminal'?!nn(d.cooldown):d.cooldown!==null)
   ||p.resources.some(z=>!nn(d.amounts?.[z]))||p.resources.reduce((n,z)=>n+d.amounts[z],0)>d.used)return 'DIRECT_ENDPOINT_INVALID';
 }
 for(const key of ['tasks','reservations']){
  const t=r.legacyInputs?.[key];if(!t||!['empty','nonempty'].includes(t.status)||!nn(t.count)||t.count>256
   ||(t.status==='empty')!==(t.count===0))return 'LEGACY_TABLE_UNAVAILABLE';
 }
 const c=r.commitments;
 if(c?.status!=='read_complete'||c.allTableScan!==true||c.tableLimitEach!==256||!complete(c.completeness)||typeof c.completeness.globalIncomplete!=='boolean'||!nn(c.completeness.invalidRecords)||!nn(c.completeness.incompleteScopeCount)
  ||!Array.isArray(c.rows)||c.rows.length!==4)return 'COMMITMENTS_INCOMPLETE';
 for(const room of p.rooms)for(const resource of p.resources){
  const a=c.rows.filter(x=>x.room===room&&x.resource===resource);if(a.length!==1)return 'COMMITMENT_ROW_INVALID';
  const x=a[0];if(x.scope!=='room_not_endpoint'||![x.outgoing,x.incoming,x.productionReserved].every(nn)||!complete(x.completeness))return 'COMMITMENT_ROW_INVALID';
 }
 if(Buffer.byteLength(JSON.stringify(r))>p.maxLogBytes)return 'OUTPUT_LIMIT_EXCEEDED';
 return null;
}
function validateSequence(samples,p){
 const due=K.dueTicks(p),missing=due.filter(t=>!samples.some(r=>r.tick===t));
 const errors=[];for(const r of samples){const e=sampleError(r,p);if(e)errors.push({tick:r.tick,error:e});}
 if(samples.length!==12||missing.length)errors.push({error:'EXPECTED_12_SAMPLES',missing});
 const cpu=[];
 for(let i=0;i<samples.length;i++){
  const r=samples[i];if(r.tick!==due[i])errors.push({error:'SAMPLE_ORDER_INVALID',tick:r.tick});
  if(i===0){if(r.previousRun!==null)errors.push({error:'FIRST_SAMPLE_NOT_FRESH'});continue;}
  const prev=r.previousRun;
  if(!prev||prev.tick!==samples[i-1].tick||!finite(prev.cpuIncludingEmit)||prev.cpuIncludingEmit>5
   ||!nn(prev.emittedBytes)||prev.emittedBytes>p.maxLogBytes||!nn(prev.retainedPrimitiveChars))errors.push({error:'PREVIOUS_SAMPLE_COST_INVALID',tick:r.tick});
  else cpu.push({tick:prev.tick,cpuIncludingEmit:prev.cpuIncludingEmit});
 }
 return {complete:errors.length===0,errors,missing,receivedTicks:samples.map(x=>x.tick),cpuIncludingEmit:cpu,
  finalSampleCpuIncludingEmit:'not_observable_with_frozen_reader',lastSampleCpuBeforeSerializationAndEmit:samples.at(-1)?.cpuBeforeSerializationAndEmit??null};
}
function createWatch(s,pid,at=Date.now()){
 const state={runId:s.runId,pid,userId:s.userId,shard:s.shard,state:'connecting',socketState:'connecting',updatedAtMs:at,
  authenticatedAtMs:null,lastConsoleAtMs:null,lastCpuAtMs:null,lastPositiveCpuAtMs:null,lastBridgeTick:null,
  lastBridgeAtMs:null,bridgeReports:0,stopReason:null,duplicateSamples:0,candidateDeployAtMs:null,restoredDeployAtMs:null};
 const samples=new Map();let authCount=0;
 function frame(text,now=Date.now()){
  state.updatedAtMs=now;
  if(text==='auth ok'||text.startsWith('auth ok ')){
   if(++authCount!==1){state.stopReason='AUTHENTICATION_REPEATED';return 'auth-failure';}
   state.state='streaming';state.socketState='open';state.authenticatedAtMs=now;return 'auth';
  }
  if(text.startsWith('auth ')){state.stopReason='AUTHENTICATION_FAILED';return 'auth-failure';}
  let v;try{v=JSON.parse(text);}catch{return 'ignored';}
  if(!Array.isArray(v)||v.length!==2||state.state!=='streaming')return 'ignored';
  const [ch,d]=v;
  if(ch===`user:${s.userId}/cpu`&&finite(d?.cpu)){
   state.lastCpuAtMs=now;if(d.cpu>0)state.lastPositiveCpuAtMs=now;return 'cpu';
  }
  if(ch!==`user:${s.userId}/console`||d?.shard!==s.shard||!Array.isArray(d.messages?.log)||!Array.isArray(d.messages?.results))return 'ignored';
  state.lastConsoleAtMs=now;
  for(const raw of d.messages.log){
   if(typeof raw!=='string')continue;const line=decode(raw).trim();
   if(line===`[deploy] ${s.build.tag}`)state.candidateDeployAtMs=now;
   if(line===`[deploy] ${s.backupBuild.tag}`)state.restoredDeployAtMs=now;
   if(line.startsWith('[deploy] ')&&line!==`[deploy] ${s.build.tag}`&&line!==`[deploy] ${s.backupBuild.tag}`)state.stopReason='UNEXPECTED_DEPLOY_IDENTITY';
   let r;try{r=JSON.parse(line);}catch{if(line.includes('treasury-legacy-read-bridge'))state.stopReason='BRIDGE_JSON_INVALID';continue;}
   if(r?.kind!=='treasury-legacy-read-bridge')continue;
   const e=sampleError(r,s.profile);if(e){state.stopReason=e;continue;}
   if(samples.has(r.tick)){
    if(JSON.stringify(samples.get(r.tick))!==JSON.stringify(r))state.stopReason='CONFLICTING_DUPLICATE_SAMPLE';
    else state.duplicateSamples++;continue;
   }
   if(r.tick!==s.profile.startTick+samples.size*100){state.stopReason='SAMPLE_MISSING_OR_REORDERED';continue;}
   if(samples.size&&(!r.previousRun||r.previousRun.tick!==state.lastBridgeTick||!finite(r.previousRun.cpuIncludingEmit)||r.previousRun.cpuIncludingEmit>5))state.stopReason='PREVIOUS_SAMPLE_COST_INVALID';
   samples.set(r.tick,r);state.lastBridgeTick=r.tick;state.lastBridgeAtMs=now;state.bridgeReports=samples.size;
  }
  return 'console';
 }
 return {state,frame,samples};
}
function health(h,s,now,pid){
 if(!h||h.runId!==s.runId||h.userId!==s.userId||h.shard!==s.shard||!Number.isSafeInteger(h.pid)||h.pid<=0||(pid&&h.pid!==pid))return 'COLLECTOR_IDENTITY_INVALID';
 if(h.stopReason)return h.stopReason;
 if(h.state!=='streaming'||h.socketState!=='open')return 'COLLECTOR_NOT_STREAMING';
 if(!finite(h.updatedAtMs)||now-h.updatedAtMs>10000||h.updatedAtMs>now+1000)return 'COLLECTOR_HEARTBEAT_STALE';
 for(const k of ['lastConsoleAtMs','lastCpuAtMs'])if(!finite(h[k])||now-h[k]>45000||h[k]>now+1000)return 'COLLECTOR_CHANNEL_STALE';
 return null;
}
module.exports={decode,sampleError,validateSequence,createWatch,health};
