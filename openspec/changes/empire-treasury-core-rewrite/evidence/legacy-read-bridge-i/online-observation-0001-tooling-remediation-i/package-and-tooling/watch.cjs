'use strict';
const {obj}=require('./common.cjs');
function decodeLog(s) {
  return s.replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#(\d+);/g,(_,n)=>{n=Number(n);return n<=0x10ffff?String.fromCodePoint(n):'\uFFFD';})
    .replace(/&amp;/g,'&');
}
function createWatch(s,pid,at=Date.now()) {
  const state={runId:s.runId,pid,userId:s.userId,shard:s.shard,state:'connecting',updatedAtMs:at,
    lastConsoleAtMs:null,lastCpuAtMs:null,lastBridgeTick:null,badSamples:0,stopReason:null,bridgeReports:0};
  const seen=new Map();
  function report(r) {
    if(!obj(r)||r.kind!=='treasury-legacy-read-bridge')return;
    if(!Number.isSafeInteger(r.tick)||r.tick<s.profile.startTick||r.tick>s.profile.endTick||r.tick%100!==0){state.stopReason='sample_outside_profile';return;}
    const encoded=JSON.stringify(r);
    if(seen.has(r.tick)){if(seen.get(r.tick)!==encoded)state.stopReason='conflicting_duplicate_sample';return;}
    seen.set(r.tick,encoded);state.lastBridgeTick=Math.max(state.lastBridgeTick??0,r.tick);state.bridgeReports++;
    if(r.authorizesActions!==false||r.status==='fault_disabled'){state.stopReason='bridge_fault_or_authority';return;}
    if(r.previousRun&&typeof r.previousRun.cpuIncludingEmit==='number'&&r.previousRun.cpuIncludingEmit>5){state.stopReason='sample_cpu_exceeded';return;}
    if(r.status==='output_limited'){state.badSamples++;if(state.badSamples>=2)state.stopReason='consecutive_partial_samples';return;}
    if(r.shard!==s.shard||JSON.stringify(r.scope?.rooms)!==JSON.stringify(s.profile.rooms)
      ||JSON.stringify(r.scope?.resources)!==JSON.stringify(s.profile.resources)||r.spendable!==null
      ||r.facadeQueryRun!==false||r.kernelLifecycleRun!==false){state.stopReason='sample_identity_or_authority';return;}
    if(!Array.isArray(r.endpoints)){state.stopReason='sample_shape_invalid';return;}
    if(r.endpoints.some(x=>x.coreComparison==='mismatch'||x.coreComparison==='existence_mismatch')){state.stopReason='core_observation_mismatch';return;}
    const complete=r.status==='sampled'&&r.commitments?.status==='read_complete'
      &&r.endpoints.length===s.profile.rooms.length*2
      &&s.profile.rooms.every(room=>['storage','terminal'].every(kind=>r.endpoints.filter(x=>x.room===room&&x.location===kind
        &&x.directStatus==='ok'&&x.coreComparison==='match_selected_scope').length===1));
    state.badSamples=complete?0:state.badSamples+1;
    if(state.badSamples>=2)state.stopReason='consecutive_partial_samples';
  }
  function frame(text,now=Date.now()) {
    if(text==='auth ok'||text.startsWith('auth ok ')){state.state='streaming';state.updatedAtMs=now;return 'auth';}
    if(text.startsWith('auth ')){state.state='failed';state.stopReason='authentication_failed';return 'auth-failure';}
    let x;try{x=JSON.parse(text);}catch{return 'ignored';}
    if(!Array.isArray(x)||x.length!==2)return 'ignored';
    const [channel,data]=x;
    if(channel===`user:${s.userId}/console`&&obj(data)&&data.shard===s.shard&&obj(data.messages)
      &&Array.isArray(data.messages.log)&&Array.isArray(data.messages.results)) {
      if(state.state!=='streaming')return 'ignored';
      state.lastConsoleAtMs=now;
      for(const line of data.messages.log)if(typeof line==='string'){
        try{report(JSON.parse(decodeLog(line)));}catch{/* Preserve raw frame; do not invent a parsed sample. */}
      }
      state.updatedAtMs=now;return 'console';
    }
    if(channel===`user:${s.userId}/cpu`&&obj(data)&&Object.values(data).some(n=>typeof n==='number'&&Number.isFinite(n))){
      if(state.state!=='streaming')return 'ignored';state.lastCpuAtMs=now;state.updatedAtMs=now;return 'cpu';
    }
    return 'ignored';
  }
  return {state,frame};
}
module.exports={createWatch,decodeLog};
