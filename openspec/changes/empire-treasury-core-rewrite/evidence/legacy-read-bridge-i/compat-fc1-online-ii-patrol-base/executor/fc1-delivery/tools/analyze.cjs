'use strict';
const C=require('./common.cjs'),{path,fs,P}=C;
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
function executionComplete(r){const w=r.cpuProfile?.attribution?.work;return r.status==='sampled'&&r.cpuProfile?.calls?.readerLoad===1&&r.cpuProfile?.calls?.observationBuild===1&&r.cpuProfile?.calls?.commitmentBuild===1&&r.requestedEndpointRows===4&&r.collectedEndpointRows===4&&r.commitments?.allTableScan===true&&r.commitments.rows?.length===4&&w?.projectionRowsPlanned===4&&w.projectionRowsCompleted===4&&w.projectionIndexQueries===16;}
function analyze(v,reports,costs,complete){const expected=v.expectedTicks||[],rows=expected.map(tick=>{const rr=reports.filter(r=>r.tick===tick),cc=costs.filter(c=>c.tick===tick),r=rr.length===1?rr[0]:null,c=cc.length===1?cc[0]:null;return{tick,executionComplete:!!r&&executionComplete(r),correctAndComplete:!!r&&complete(r),prefixCpu:r?.cpuBeforeSerializationAndEmit??null,
  measuredThroughPreviewReturn:c?.elapsedThroughPreviewReturn??null,mainReportAfterRetention:c?.currentTailProfile?.elapsed??null,
  nativeEntry:c?.nativeEntry??null,nativeReturn:c?.nativeReturn??null,stopped:c?.stopsFutureSamples??null,
  taskRecords:r?.cpuProfile?.attribution?.work?.commitmentTaskRecords??null,reservationRecords:r?.cpuProfile?.attribution?.work?.commitmentReservationRecords??null,
  measurementClass:r?.cpuProfile?.sampleOrdinal===1?'first_scheduled_sample':'subsequent_scheduled_sample'};});
 const trusted=expected.length===4&&expected.every((t,i)=>Number.isSafeInteger(t)&&(i===0||t===expected[0]+100*i))&&v.captureVerified===true&&v.issues?.length===0&&v.rawReports===4&&v.acceptedReports===4&&v.duplicates===0&&reports.length===4&&costs.length===4&&C.same(v.acceptedTicks,expected);
 const recovered=v.closure==='RESTORED_BYTES_AND_RUNTIME_VERIFIED'&&v.sourceOff===true&&v.uploadOutcomeResolved===true;
 const values=rows.map(r=>r.measuredThroughPreviewReturn).filter(finite),completeCount=rows.filter(r=>r.correctAndComplete).length;
 const legacy=[];for(const r of reports)for(const e of r.endpoints||[])if(e.legacyProjection?.status==='mismatch')legacy.push({tick:r.tick,room:e.room,location:e.location,fields:e.legacyProjection.mismatches});
 const receiptCosts=[];for(const c of costs){const prev=c.previousReceiptOverhead;if(prev&&finite(prev.elapsedAfterPreviewReturn)){const prior=costs.find(x=>x.tick===prev.tick);if(prior)receiptCosts.push({tick:prev.tick,throughOwnReceiptEmission:prior.elapsedThroughPreviewReturn+prev.elapsedAfterPreviewReturn});}}
 const result={kind:'full-cost-FC1-analysis/v1',experimentStatus:v.status,recoveryStatus:v.closure,sourceOff:v.sourceOff===true,
  performanceTargetCpu:null,oldR1VerdictUnchanged:true,captureTrusted:trusted,rows,executionCompleteSamples:rows.filter(r=>r.executionComplete).length,
  correctAndCompleteSamples:completeCount,costAssessment:'Measured evidence is not a production CPU allocation approval.',
  mainReportTailsObserved:costs.filter(x=>x.currentTailProfile?.boundary==='afterRetention').map(x=>x.tick),knownReceiptInclusiveCosts:receiptCosts,
  finalReceiptOwnTailObserved:false,excludedCosts:['non-due scheduler checks','module startup before the wrapper entry mark','cpuProfiler.flush and engine Memory serialization after the wrapper','last receipt preparation/emission tail; earlier receipt overhead is separately carried forward'],
  nonemptyReservationsOnlineCovered:rows.some(r=>r.reservationRecords>0),legacyProjectionMismatches:legacy,
  nativeBucketTrendConclusion:'Four sparse sample snapshots do not establish long-term CPU/bucket sustainability.',
  fullCompatibilityObserved:false,productionSwitchAuthorized:false,secondWindowAuthorized:false,fifthBusinessSampleAuthorized:false,rootCauseAssigned:false};
 if(trusted&&values.length===4){result.costSummary={minimum:Math.min(...values),maximum:Math.max(...values),mean:values.reduce((a,b)=>a+b,0)/4,
  frequencyEquivalentCpuPerTick:values.reduce((a,b)=>a+b,0)/400,frequencyEquivalentMeaning:'Arithmetic normalization at one sample per 100 ticks; excludes the listed costs, not a measured long-run average.'};}
 result.milestone=v.status==='NOT_DEPLOYED'?'NOT_DEPLOYED_NO_COST_CONCLUSION':!recovered?'RECOVERY_NOT_CLOSED':!trusted?'COST_MEASUREMENT_INCONCLUSIVE':completeCount===4?'FULL_PATH_COST_MEASURED':rows.every(r=>r.executionComplete)?'FULL_PATH_EXECUTED_INPUT_OR_COMPARISON_NOT_CLEAN':'FULL_PATH_NOT_COMPLETED';
 result.nextAction='Independent review of functional completeness, correctness, actual measured cost and native headroom. Do not automatically optimize, change the exposure ceiling, run another window, or switch production.';return result;
}
function fromRun(executor,dir,v){const W=require(path.join(executor,'runtime/samples.cjs')),C2=require(path.join(executor,'runtime/common.cjs'));if(!fs.existsSync(path.join(dir,'session.json')))return analyze(v,[],[],W.complete);const s=C2.json(path.join(dir,'session.json')),w=W.watch(s);let auth=0;for(const e of C2.jsonl(path.join(dir,'console.jsonl'))){if(e.kind==='auth-confirmed')auth++;if(e.kind==='ws-frame'&&auth===1)w.frame(e.text,e.atMs);}return analyze(v,w.raw,w.costs,W.complete);}
module.exports={executionComplete,analyze,fromRun};
