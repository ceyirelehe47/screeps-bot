'use strict';
const C=require('./common.cjs');
const ROOMS=['E3N59','E4N58'],RESOURCES=['energy','H'];
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const integer=x=>Number.isSafeInteger(x)&&x>=0;
function decode(s){return s.replace(/&#(x[0-9a-f]+|[0-9]+);|&(quot|apos|amp|lt|gt);/gi,(_,n,k)=>n?String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10)):({quot:'"',apos:"'",amp:'&',lt:'<',gt:'>'})[k.toLowerCase()]);}
function reportsFromLog(text,runId,userId){
 C.check(!text||text.endsWith('\n'),'TRUNCATED_CONSOLE_LOG');const out=[];
 for(const line of text.split('\n').filter(Boolean)){
  const e=JSON.parse(line);if(e.kind!=='ws-frame')continue;
  C.check(e.runId===runId&&e.redacted===false,'CONSOLE_IDENTITY_CHANGED');let f;try{f=JSON.parse(e.text);}catch{continue;}
  if(!Array.isArray(f)||f[0]!==`user:${userId}/console`||f[1]?.shard!=='shard1')continue;
  for(const l of f[1]?.messages?.log||[]){if(typeof l!=='string')continue;let r;try{r=JSON.parse(decode(l));}catch{continue;}if(r.kind==='treasury-legacy-read-bridge')out.push(r);}
 }return out;
}
function complete(r){
 const errors=[];const need=(b,s)=>{if(!b)errors.push(s);};
 need(r.shard==='shard1'&&C.same(r.scope?.rooms,ROOMS)&&C.same(r.scope?.resources,RESOURCES)&&r.scope?.isEmpireTotal===false,'SCOPE');
 need(r.authorizesActions===false&&r.facadeQueryRun===false&&r.kernelLifecycleRun===false&&r.spendable===null&&r.storageMode==='heap_only','READ_ONLY_BOUNDARY');
 need(r.status==='sampled'&&r.commitments?.status==='read_complete','BUSINESS_STATUS');
 need(finite(r.cpuBeforeSerializationAndEmit)&&r.cpuBeforeSerializationAndEmit<2,'CPU_BUDGET');
 need(r.cpuProfile?.calls?.observationBuild===1&&r.cpuProfile?.calls?.commitmentBuild===1,'ACTUAL_BUILDERS');
 const work=r.cpuProfile?.attribution?.work;need(work?.projectionRowsCompleted===4&&work.projectionRowsPlanned===4&&work.projectionIndexQueries===16,'PROJECTION_WORK');
 need(r.requestedEndpointRows===4&&r.collectedEndpointRows===4&&r.endpoints?.length===4,'ENDPOINT_COUNT');
 for(const room of ROOMS)for(const location of ['storage','terminal']){
   const rows=(r.endpoints||[]).filter(x=>x.room===room&&x.location===location);
   need(rows.length===1&&rows[0].directStatus==='ok'&&rows[0].coreComparison==='match_selected_scope'&&Array.isArray(rows[0].coreMismatches)&&rows[0].coreMismatches.length===0,'DIRECT_CORE:'+room+':'+location);
 }
 need(r.commitments?.rows?.length===4&&r.commitments?.allTableScan===true,'COMMITMENT_COUNT');
 const health=r.commitments?.completeness;need(health?.complete===true&&health.globalIncomplete===false&&health.invalidRecords===0&&health.incompleteScopeCount===0,'COMMITMENT_HEALTH');
 for(const room of ROOMS)for(const resource of RESOURCES){const rows=(r.commitments?.rows||[]).filter(x=>x.room===room&&x.resource===resource);need(rows.length===1&&rows[0].scope==='room_not_endpoint'&&integer(rows[0].outgoing)&&integer(rows[0].incoming)&&integer(rows[0].productionReserved)&&rows[0].completeness==='complete','PROJECTION:'+room+':'+resource);}
 need(r.localSafety?.latched===false,'SAFETY_LATCH');return{tick:r.tick,complete:errors.length===0,prefixCpu:r.cpuBeforeSerializationAndEmit,errors};
}
function analyze(v,reports=[]){
 const result={kind:'read-path-R1-milestone/v1',experimentStatus:v.status,recoveryStatus:v.closure,sourceOff:v.sourceOff===true,
  fullCompatibilityObserved:false,productionSwitchAuthorized:false,secondWindowAuthorized:false,fifthPointAuthorized:false,
  rootCauseAssigned:false,readPathBudget:2,clearMarginTargetCpu:0.2,legacyProjectionMismatches:[],rows:[],
  note:'The 0.2 margin is an explicit readiness target, not a replacement for the unchanged 2 CPU business gate. Final-sample tail remains unobserved. Nonempty online reservation coverage is reported separately.'};
 if(v.status==='NOT_DEPLOYED'){
   result.milestone=v.sourceOff===true&&v.writeBoundaries?.candidate===0&&v.writeBoundaries?.restore===0&&v.issues?.length===0?'NOT_DEPLOYED_NO_PERFORMANCE_CONCLUSION':'NO_DEPLOYMENT_OR_SOURCE_STATE_UNCONFIRMED';
   result.nextAction='Review the recorded admission/setup reason. No automatic retry or new authorization.';return result;
 }
 const ticks=v.expectedTicks||[],validTicks=ticks.length===4&&ticks.every((t,i)=>integer(t)&&(i===0||t===ticks[0]+100*i));
 const selected=[];for(const tick of ticks){const rr=reports.filter(r=>r.tick===tick);if(rr.length===1){selected.push(rr[0]);result.rows.push(complete(rr[0]));}else result.rows.push({tick,complete:false,errors:['REPORT_NOT_UNIQUE']});}
 for(const r of selected)for(const row of r.endpoints||[])if(row.legacyProjection?.status==='mismatch')result.legacyProjectionMismatches.push({tick:r.tick,room:row.room,location:row.location,fields:row.legacyProjection.mismatches});
 const recovery=v.closure==='RESTORED_BYTES_AND_RUNTIME_VERIFIED'&&v.sourceOff===true&&v.uploadOutcomeResolved===true;
 const trusted=validTicks&&v.captureVerified===true&&v.issues?.length===0&&v.rawReports===4&&v.acceptedReports===4&&v.duplicates===0&&reports.length===4&&C.same(v.acceptedTicks,ticks)&&v.writeBoundaries?.candidate===1&&v.writeBoundaries?.restore===1;
 const business=trusted&&result.rows.length===4&&result.rows.every(x=>x.complete)&&v.completeSamples===4;
 const prefixes=result.rows.map(x=>x.prefixCpu).filter(finite);const max=prefixes.length===4?Math.max(...prefixes):null;
 result.captureTrusted=trusted;result.completeBusinessSamples=result.rows.filter(x=>x.complete).length;result.businessGatePassed=business;
 result.maximumPrefixCpu=max;result.minimumMarginCpu=max===null?null:2-max;
 result.completedTails=v.completedTailProfiles||[];result.finalSampleTailObserved=false;
 result.nonemptyReservationsOnlineCovered=selected.some(r=>(r.cpuProfile?.attribution?.work?.commitmentReservationRecords||0)>0);
 if(!recovery){result.milestone='RECOVERY_NOT_CLOSED';result.nextAction='Only read-only reconciliation and preserve evidence; no new upload, restore retry, or second experiment.';}
 else if(!trusted){result.milestone='EXPERIMENT_INCONCLUSIVE_REVIEW_REQUIRED';result.nextAction='Review evidence failure; preserve default OFF, no automatic experiment retry.';}
 else if(business&&result.maximumPrefixCpu<=1.8){result.milestone='FOUR_POINT_READ_PATH_COMPLETE_WITH_MARGIN';result.nextAction='Independent GitHub review. Any future 12-point observation requires a new separately approved package; no production switch.';}
 else if(business){result.milestone='COMPLETE_WITHOUT_CLEAR_MARGIN_REVIEW_REQUIRED';result.nextAction='Review full-path structure and admission criteria; do not automatically issue another micro-optimization experiment.';}
 else{result.milestone='STRUCTURAL_REVIEW_REQUIRED';result.nextAction='Stop automatic hot-spot iteration. Review the compatibility bridge structure and validation route using this trial plus XV evidence. No budget increase, simplified indexes, or repeated unchanged run.';}
 return result;
}
function fromRun(executor,dir,v){const p=C.json(C.path.join(executor,'policy.json'));const file=C.path.join(dir,'console.jsonl');return analyze(v,C.fs.existsSync(file)?reportsFromLog(C.read(file,64*1048576).toString('utf8'),p.parentRunId,p.expected.userId):[]);}
module.exports={decode,reportsFromLog,complete,analyze,fromRun};
