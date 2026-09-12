'use strict';
const C=require('./common.cjs'),K=require('./policy.cjs'),D=require('./decoder.cjs');
const nn=x=>Number.isSafeInteger(x)&&x>=0,finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const PHASES=Object.freeze(['legacyInputs','directRead','readerLoad','observationBuild','coreCompare','commitmentBuild','commitmentProjection','report','serializationAndSize','emit','retention']);
const CALLS=Object.freeze(['readerLoad','observationBuild','commitmentBuild']);
const equal=(a,b)=>Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
function profileError(p,tick,ordinal,boundary){
 if(!p||p.version!==1||p.tick!==tick||p.sampleOrdinal!==ordinal||p.boundary!==boundary||!finite(p.elapsed)
 ||!nn(p.checkpoints)||p.checkpoints<1||p.checkpoints>100||!C.obj(p.phases)||!C.obj(p.calls))return 'CPU_PROFILE_IDENTITY_INVALID';
 if(!C.same(Object.keys(p.calls).sort(),[...CALLS].sort())||CALLS.some(k=>![0,1].includes(p.calls[k]))
 ||p.calls.observationBuild>p.calls.readerLoad||p.calls.commitmentBuild>p.calls.observationBuild)return 'CPU_CALL_COUNTS_INVALID';
 if(Object.keys(p.phases).some(k=>!PHASES.includes(k)||!finite(p.phases[k]))||!Object.hasOwn(p.phases,'legacyInputs')
 ||!equal(Object.values(p.phases).reduce((n,x)=>n+x,0),p.elapsed))return 'CPU_PHASE_SUM_INVALID';
 if(boundary==='beforeSerialization'&&['serializationAndSize','emit','retention'].some(k=>(p.phases[k]||0)!==0))return 'CPU_PREFIX_CONTAINS_FUTURE_COST';
 if(p.elapsed>K.MAX_DIAGNOSTIC_OBSERVED_COST)return 'CPU_OBSERVED_SAFETY_STOP';
 return null;
}
function diagnosticError(r,p,i,previous=null,previousText=null){
 if(!r||r.kind!=='treasury-legacy-read-bridge'||r.tick!==K.dueTicks(p)[i])return 'DIAGNOSTIC_TICK_INVALID';
 if(!['sampled','partial_cpu_budget'].includes(r.status))return 'DIAGNOSTIC_UNUSABLE_STATUS';
 if(r.shard!==p.shardName||r.sourceCommit!=='01bd9831454950c4928df98dd8679692b55603e5'||r.productionBase!==C.PRODUCTION_BASE)return 'DIAGNOSTIC_SOURCE_MISMATCH';
 if(r.authorizesActions!==false||r.spendable!==null||r.kernelLifecycleRun!==false||r.facadeQueryRun!==false||r.storageMode!=='heap_only'
 ||r.evaluation!=='observation_and_legacy_commitments_only'||r.cooperativeBudget!==true)return 'DIAGNOSTIC_AUTHORITY_CHANGED';
 if(!C.same(r.scope?.rooms,p.rooms)||!C.same(r.scope?.resources,p.resources)||r.scope.isEmpireTotal!==false)return 'DIAGNOSTIC_SCOPE_CHANGED';
 let e=profileError(r.cpuProfile,r.tick,i+1,'beforeSerialization');if(e)return e;
 if(!finite(r.cpuBeforeSerializationAndEmit)||!equal(r.cpuBeforeSerializationAndEmit,r.cpuProfile.elapsed))return 'CPU_PREFIX_MISMATCH';
 if(r.status==='sampled'&&r.cpuBeforeSerializationAndEmit>=p.maxSampleCpu)return 'SAMPLED_OVER_BUDGET';
 if(i===0){if(r.previousRun!==null||r.previousCpuProfile!==null)return 'FIRST_DIAGNOSTIC_NOT_FRESH';}
 else {
  if(!previous||typeof previousText!=='string')return 'DIAGNOSTIC_PREDECESSOR_MISSING';
  e=profileError(r.previousCpuProfile,previous.tick,i,'afterRetention');if(e)return e;
  const a=r.previousCpuProfile,b=previous.cpuProfile,q=r.previousRun;
  if(a.elapsed+1e-7<b.elapsed||!C.same(a.calls,b.calls)||a.checkpoints<b.checkpoints
  ||Object.keys(b.phases).some(k=>(a.phases[k]??-1)+1e-7<b.phases[k]))return 'CPU_TAIL_NOT_AN_EXTENSION';
  if(!q||q.tick!==previous.tick||!finite(q.cpuIncludingEmit)||q.cpuIncludingEmit+1e-7<b.elapsed
  ||q.cpuIncludingEmit>a.elapsed+1e-7||q.emittedBytes!==Buffer.byteLength(previousText)||q.emittedBytes>p.maxLogBytes||!nn(q.retainedPrimitiveChars))return 'CPU_PREVIOUS_RUN_INVALID';
 }
 if(!Array.isArray(r.endpoints)||r.requestedEndpointRows!==4||r.collectedEndpointRows!==r.endpoints.length||r.endpoints.length>4
 ||!Array.isArray(r.coreObservationRooms)||r.coreObservationRooms.some(x=>!p.rooms.includes(x))||new Set(r.coreObservationRooms).size!==r.coreObservationRooms.length)return 'DIAGNOSTIC_ENDPOINT_SHAPE_INVALID';
 const keys=new Set();for(const x of r.endpoints){const k=x.room+':'+x.location;
  if(!p.rooms.includes(x.room)||!['storage','terminal'].includes(x.location)||keys.has(k))return 'DIAGNOSTIC_ENDPOINT_SHAPE_INVALID';keys.add(k);
  if(['mismatch','existence_mismatch'].includes(x.coreComparison))return 'CORE_COMPARISON_MISMATCH';
 }
 if(Buffer.byteLength(JSON.stringify(r))>p.maxLogBytes)return 'DIAGNOSTIC_OUTPUT_LIMIT';
 return null;
}
/** Full sample qualification is separate from useful CPU diagnosis. Real builder row
 * completeness is a string, not the invented object accepted by the former tool. */
function sampleError(r,p){
 if(r?.status!=='sampled'||!finite(r.cpuBeforeSerializationAndEmit)||r.cpuBeforeSerializationAndEmit>=p.maxSampleCpu)return 'SAMPLE_NOT_COMPLETE';
 if(r.endpoints?.length!==4||!C.same(r.coreObservationRooms,p.rooms))return 'ENDPOINTS_INCOMPLETE';
 for(const x of r.endpoints){const d=x.direct;
  if(x.directStatus!=='ok'||x.coreComparison!=='match_selected_scope'||!Array.isArray(x.coreMismatches)||x.coreMismatches.length||!d
  ||typeof d.id!=='string'||!d.id||!nn(d.used)||!nn(d.capacity)||!Number.isSafeInteger(d.free)
  ||!(d.used+d.free===d.capacity||(d.used>d.capacity&&d.free===0))||d.overCapacity!==(d.used>d.capacity)
  ||typeof d.active!=='boolean'||(x.location==='terminal'?!nn(d.cooldown):d.cooldown!==null)
  ||p.resources.some(k=>!nn(d.amounts?.[k]))||p.resources.reduce((n,k)=>n+d.amounts[k],0)>d.used)return 'DIRECT_ENDPOINT_INVALID';
 }
 for(const k of ['tasks','reservations']){const t=r.legacyInputs?.[k];
  if(!t||!['empty','nonempty'].includes(t.status)||!nn(t.count)||t.count>256||(t.status==='empty')!==(t.count===0))return 'LEGACY_INPUT_INCOMPLETE';}
 const c=r.commitments,h=c?.completeness;
 if(c?.status!=='read_complete'||c.allTableScan!==true||c.tableLimitEach!==256||h?.complete!==true||h.globalIncomplete!==false
 ||h.invalidRecords!==0||h.incompleteScopeCount!==0||c.rows?.length!==4)return 'COMMITMENTS_INCOMPLETE';
 for(const room of p.rooms)for(const resource of p.resources){const rows=c.rows.filter(x=>x.room===room&&x.resource===resource);
  if(rows.length!==1||rows[0].scope!=='room_not_endpoint'||rows[0].completeness!=='complete'
  ||![rows[0].outgoing,rows[0].incoming,rows[0].productionReserved].every(nn))return 'COMMITMENT_ROW_INVALID';}
 return null;
}
function createWatch(s,pid,at=Date.now()){
 const state={runId:s.runId,pid,userId:s.userId,shard:s.shard,state:'connecting',socketState:'connecting',updatedAtMs:at,
 authenticatedAtMs:null,lastConsoleAtMs:null,lastCpuAtMs:null,lastPositiveCpuAtMs:null,lastBridgeTick:null,lastBridgeAtMs:null,
 bridgeReports:0,rawBridgeReports:0,completeSamples:0,partialCpuSamples:0,stopReason:null,diagnosticFailure:null,duplicateSamples:0,candidateDeployAtMs:null,restoredDeployAtMs:null};
 const samples=new Map(),texts=new Map();let authCount=0;
 const fail=k=>{state.diagnosticFailure??=k;};
 function frame(text,now=Date.now()){
  state.updatedAtMs=now;
  if(text==='auth ok'||text.startsWith('auth ok ')){if(++authCount!==1){state.stopReason='AUTHENTICATION_REPEATED';return 'auth-failure';}
   state.state='streaming';state.socketState='open';state.authenticatedAtMs=now;return 'auth';}
  if(text.startsWith('auth ')){state.stopReason='AUTHENTICATION_FAILED';return 'auth-failure';}
  let v;try{v=JSON.parse(text);}catch{return 'ignored';}if(!Array.isArray(v)||v.length!==2||state.state!=='streaming')return 'ignored';
  const[ch,d]=v;
  if(ch===`user:${s.userId}/cpu`&&finite(d?.cpu)){state.lastCpuAtMs=now;if(d.cpu>0)state.lastPositiveCpuAtMs=now;return 'cpu';}
  if(ch!==`user:${s.userId}/console`||d?.shard!==s.shard||!Array.isArray(d.messages?.log)||!Array.isArray(d.messages?.results))return 'ignored';
  state.lastConsoleAtMs=now;
  for(const raw of d.messages.log){if(typeof raw!=='string')continue;
   let line;try{line=raw.trimStart().startsWith('{')?raw.trim():D.decodeHtmlOnce(raw).trim();}catch{fail('CONSOLE_ENTITY_INVALID');continue;}
   if(line===`[deploy] ${s.build.tag}`)state.candidateDeployAtMs=now;
   if(line===`[deploy] ${s.backupBuild.tag}`)state.restoredDeployAtMs=now;
   if(line.startsWith('[deploy] ')&&line!==`[deploy] ${s.build.tag}`&&line!==`[deploy] ${s.backupBuild.tag}`)fail('UNEXPECTED_DEPLOY_IDENTITY');
   const parsed=D.parseBridge(raw);if(parsed.kind==='invalid'){fail(parsed.error);continue;}if(parsed.kind!=='bridge')continue;
   state.rawBridgeReports++;
   const r=parsed.report;
   if(samples.has(r.tick)){if(texts.get(r.tick)!==parsed.jsonText)fail('CONFLICTING_DUPLICATE_SAMPLE');else state.duplicateSamples++;continue;}
   const prev=[...samples.values()].at(-1),err=diagnosticError(r,s.profile,samples.size,prev,prev?texts.get(prev.tick):null);
   if(err){fail(err);continue;}
   samples.set(r.tick,r);texts.set(r.tick,parsed.jsonText);state.lastBridgeTick=r.tick;state.lastBridgeAtMs=now;state.bridgeReports=samples.size;
   if(!sampleError(r,s.profile))state.completeSamples++;if(r.status==='partial_cpu_budget')state.partialCpuSamples++;
  }
  return 'console';
 }
 return {state,frame,samples,texts};
}
function health(h,s,now,pid){
 if(!h||h.runId!==s.runId||h.userId!==s.userId||h.shard!==s.shard||!Number.isSafeInteger(h.pid)||h.pid<=0||(pid&&h.pid!==pid))return 'COLLECTOR_IDENTITY_INVALID';
 if(h.stopReason)return h.stopReason;
 if(h.state!=='streaming'||h.socketState!=='open')return 'COLLECTOR_NOT_STREAMING';
 if(!finite(h.updatedAtMs)||now-h.updatedAtMs>10000||h.updatedAtMs>now+1000)return 'COLLECTOR_HEARTBEAT_STALE';
 for(const k of ['lastConsoleAtMs','lastCpuAtMs'])if(!finite(h[k])||now-h[k]>45000||h[k]>now+1000)return 'COLLECTOR_CHANNEL_STALE';return null;
}
module.exports={PHASES,CALLS,profileError,diagnosticError,sampleError,createWatch,health,equal};
