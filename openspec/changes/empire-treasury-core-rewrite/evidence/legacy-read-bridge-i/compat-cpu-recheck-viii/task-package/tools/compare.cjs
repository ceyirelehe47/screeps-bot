'use strict';
/** Offline interpretation of a freshly reverified run against the exact accepted CPU VI
 * record. No performance pass threshold; no data, time series or authorization is merged. */
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
const V=require('../runtime/verify-run.cjs'),W=require('../runtime/samples.cjs'),P=require('./prerequisites.cjs');
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
function measures(v){
 if(!Array.isArray(v?.analysis?.rows))return null;
 const rows=v.analysis.rows;
 if(rows.length!==v.diagnosticReports||rows.length>4)C.fail('COMPARISON_ROW_COUNT_INVALID');
 for(const [i,r]of rows.entries()){
  if(!Number.isSafeInteger(r.tick)||r.sampleOrdinal!==i+1||!finite(r.cpuBeforeSerializationAndEmit)
   ||!C.obj(r.calls)||!C.obj(r.phaseIntervals)||!['sampled','partial_cpu_budget'].includes(r.status))C.fail('COMPARISON_ROW_INVALID');
  for(const phase of W.CALLS)if(![0,1].includes(r.calls[phase])||(r.calls[phase]===1&&!finite(r.phaseIntervals[phase])))C.fail('COMPARISON_INVOCATION_INTERVAL_MISSING');
 }
 const invocations=Object.fromEntries(W.CALLS.map(phase=>{
  const invoked=rows.filter(r=>r.calls[phase]===1).map(r=>({tick:r.tick,sampleOrdinal:r.sampleOrdinal,inclusiveInterval:r.phaseIntervals[phase]}));
  const boundaryOnly=rows.filter(r=>r.calls[phase]===0&&Object.hasOwn(r.phaseIntervals,phase)).map(r=>({tick:r.tick,interval:r.phaseIntervals[phase],invoked:false}));
  return [phase,{count:invoked.length,invokedIntervals:invoked,firstInvocation:invoked[0]||null,
   followingInvocationCount:Math.max(0,invoked.length-1),followingInvokedIntervalMedian:V.median(invoked.slice(1).map(x=>x.inclusiveInterval)),
   allInvokedIntervalMedian:V.median(invoked.map(x=>x.inclusiveInterval)),boundaryOnlyIntervals:boundaryOnly}];
 }));
 return {rawReports:v.rawReports,diagnosticReports:v.diagnosticReports,completeSamples:v.completeSamples,partialCpuSamples:v.partialCpuSamples,
  firstAdmittedTick:rows[0]?.tick??null,firstReaderInvocationTick:invocations.readerLoad.firstInvocation?.tick??null,
  firstAdmissionIsFirstReaderInvocation:rows.length?rows[0].tick===invocations.readerLoad.firstInvocation?.tick:null,
  prefixRows:rows.map(r=>({tick:r.tick,sampleOrdinal:r.sampleOrdinal,status:r.status,completeSample:r.completeSample,
   prefixCpu:r.cpuBeforeSerializationAndEmit,phaseIntervals:r.phaseIntervals,calls:r.calls,commitmentsStatus:r.commitmentsStatus,
   afterRetentionCpu:r.completeProfileReportedBySuccessor?.elapsed??null})),
  invocations,firstDirectReadInterval:rows[0]?.phaseIntervals.directRead??null,
  followingDirectReadIntervalMedian:V.median(rows.slice(1).flatMap(r=>finite(r.phaseIntervals.directRead)?[r.phaseIntervals.directRead]:[])),
  allPrefixMedian:V.median(rows.map(r=>r.cpuBeforeSerializationAndEmit)),
  followingPrefixMedian:V.median(rows.slice(1).map(r=>r.cpuBeforeSerializationAndEmit)),
  successorTailProfiles:rows.filter(r=>r.completeProfileReportedBySuccessor).length,
  lastSampleTail:'unobservable without a successor; no fifth point',
  commitmentActuallyInvoked:invocations.commitmentBuild.count>0,
  reportedTailCostsWithinTwoCpu:rows.some(r=>r.completeProfileReportedBySuccessor)?rows.filter(r=>r.completeProfileReportedBySuccessor).every(r=>r.completeProfileReportedBySuccessor.elapsed<=2):null,
  reportedTailCountForAboveBoolean:rows.filter(r=>r.completeProfileReportedBySuccessor).length};
}
function relation(a,b,min=2){
 if(!a||!b||a.count<min||b.count<min||!finite(a.median)||!finite(b.median))return 'insufficient_invocations';
 return b.median<a.median?'lower_observed_median':b.median>a.median?'higher_observed_median':'equal_observed_median';
}
function phaseSummary(before,after,phase,{following=false,min=2}={}){
 const a=before?.invocations?.[phase],b=after?.invocations?.[phase];
 const baseline={count:following?a?.followingInvocationCount??0:a?.count??0,median:following?a?.followingInvokedIntervalMedian??null:a?.allInvokedIntervalMedian??null};
 const current={count:following?b?.followingInvocationCount??0:b?.count??0,median:following?b?.followingInvokedIntervalMedian??null:b?.allInvokedIntervalMedian??null};
 return {scope:following?'after_first_actual_invocation':'all_actual_invocations',baseline,current,relation:relation(baseline,current,min),improvementRequiredForCaptureAcceptance:false};
}
function scalarRelation(a,b,countA,countB,min=2){return relation({median:a,count:countA},{median:b,count:countB},min);}
function compareResults(current,prior){
 const before=measures(prior),after=measures(current);
 const loader=phaseSummary(before,after,'readerLoad',{following:true,min:2});
 const observation=phaseSummary(before,after,'observationBuild',{min:2});
 const commitment=phaseSummary(before,after,'commitmentBuild',{min:2});
 const direct={scope:'admitted_samples_after_first',baseline:{count:Math.max(0,(before?.diagnosticReports??0)-1),median:before?.followingDirectReadIntervalMedian??null},
  current:{count:Math.max(0,(after?.diagnosticReports??0)-1),median:after?.followingDirectReadIntervalMedian??null}};
 direct.relation=scalarRelation(direct.baseline.median,direct.current.median,direct.baseline.count,direct.current.count,2);direct.improvementRequiredForCaptureAcceptance=false;
 const prefix={scope:'all_diagnostic_prefixes',baseline:{count:before?.diagnosticReports??0,median:before?.allPrefixMedian??null},current:{count:after?.diagnosticReports??0,median:after?.allPrefixMedian??null}};
 prefix.relation=scalarRelation(prefix.baseline.median,prefix.current.median,prefix.baseline.count,prefix.current.count,2);prefix.improvementRequiredForCaptureAcceptance=false;
 if(!current.captureVerified){for(const x of [loader,observation,commitment,direct,prefix])x.relation='insufficient_invocations';}
 return {status:current.captureVerified?'BUILD_VIII_COMPARISON_RECORDED':'BUILD_VIII_COMPARISON_INCONCLUSIVE',
  currentCaptureVerified:current.captureVerified===true,currentCaptureStatus:current.status,currentClosure:current.closure,
  historical:{sourceCommit:P.LOCK.priorDiagnostic.commit,sourcePath:P.LOCK.priorDiagnostic.path,sourceBlob:P.LOCK.priorDiagnostic.blob,
   sourceSha256:P.LOCK.priorDiagnostic.sha256,acceptedCaptureReused:true,fullHistoricalRunReverifiedHere:false,runId:prior.runId,profileHead:prior.profileHead,measurements:before},
  current:{compatBase:K.COMPAT,refactorBase:K.REFACTOR,runId:current.runId??null,profileHead:current.profileHead??null,measurements:after},
  phaseComparisons:{readerLoad:loader,observationBuild:observation,commitmentBuild:commitment,directRead:direct,prefixCpu:prefix},
  postFirstReaderInvocationComparison:{relation:loader.relation,baselineCount:loader.baseline.count,currentCount:loader.current.count,
   baselineMedian:loader.baseline.median,currentMedian:loader.current.median,lowerCostRequiredForCaptureAcceptance:false},
  progress:{baselineObservationBuilds:before?.invocations.observationBuild.count??0,currentObservationBuilds:after?.invocations.observationBuild.count??0,
   baselineCommitmentBuilds:before?.invocations.commitmentBuild.count??0,currentCommitmentBuilds:after?.invocations.commitmentBuild.count??0,
   baselineCompleteSamples:before?.completeSamples??0,currentCompleteSamples:after?.completeSamples??0,
   completeSampleRequiredForComparisonRecord:false},
  interpretation:{callZeroExcludedFromFunctionCost:true,intervalsAreNotNetFunctionCosts:true,
   firstAdmittedSampleIsNotNecessarilyFirstLoaderCall:true,firstLoaderCallIsNotProofOfEngineColdStart:true,
   onlyActualCallsCountAsObservationOrCommitmentExecution:true,workloadsNotControlledAcrossRuns:true,
   exactSpeedupPercentNotComputed:true,causalSpeedupClaim:false,engineOperationReductionMeasuredOfflineOnly:true,
   budget:2,engineCpuGapRepaired:false,fullCompatibilityObserved:false,comparisonToolNetworkUsed:false,currentCaptureRequiresOnlineRun:true,
   resultCompletenessAndIndexCompletenessRemainDistinct:true},
  caution:'Sequential four-point runs, not randomized A/B. Inventory, task count, engine state and diagnostic overhead can differ. A call=0 interval is boundary work, never a measured builder invocation. Preserve insufficient evidence instead of adding samples.'};
}
/** Describes emitted content only. Index completeness, projected rows and full
 * sample qualification are distinct; [] is never converted to a zero balance. */
function reportDetail(report,profile){
 const c=report.commitments,reason=W.sampleError(report,profile),rows=Array.isArray(c?.rows)?c.rows:null;
 return {tick:report.tick,sampleOrdinal:report.cpuProfile.sampleOrdinal,
  requestedEndpointRows:report.requestedEndpointRows,collectedEndpointRows:report.collectedEndpointRows,
  directOkEndpoints:report.endpoints.filter(x=>x.directStatus==='ok').length,
  coreMatchedEndpoints:report.endpoints.filter(x=>x.coreComparison==='match_selected_scope').length,
  legacyInputs:report.legacyInputs,
  commitmentActuallyInvoked:report.cpuProfile.calls.commitmentBuild===1,
  commitmentStatus:c?.status??'missing',commitmentIndexComplete:typeof c?.completeness?.complete==='boolean'?c.completeness.complete:null,
  commitmentProjectionRows:rows?.length??null,expectedCommitmentProjectionRows:profile.rooms.length*profile.resources.length,
  commitmentProjectionKeys:rows?.map(x=>({room:x.room,resource:x.resource,completeness:x.completeness}))??null,
  emptyRowsProveNoCommitments:false,completeSample:reason===null,sampleCompletenessReason:reason};
}
function makeComparison(run){
 const {prior}=P.packaged();let verified;
 try{verified=V.verifyRun(run);}catch(e){verified={status:'CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE',closure:'ONLINE_CLOSE_UNCONFIRMED',captureVerified:false,issues:[C.code(e)]};}
 const result=compareResults(verified,prior);
 result.currentLegacyProjectionDifferences=[];result.currentReportDetails=[];
 result.historicalProjectionDetails='not included in the pinned VI verdict; original raw history is not reconstructed here';
 const selected=new Set(),publicSession=S_readPublic(run),D=require('../runtime/decoder.cjs');let rawFrames=[];
 try{rawFrames=V.records(run,'console.jsonl');}catch(e){result.currentRawInspectionError=C.code(e);}
 for(const f of rawFrames){
  if(f.kind!=='ws-frame')continue;let parsed;try{parsed=JSON.parse(f.text);}catch{continue;}
  if(!Array.isArray(parsed)||parsed[0]!==`user:${C.EXPECTED.userId}/console`||parsed[1]?.shard!==C.EXPECTED.shard)continue;
  for(const raw of parsed[1]?.messages?.log||[]){const decoded=D.parseBridge(raw);if(decoded.kind!=='bridge'||!verified.receivedTicks?.includes(decoded.report.tick))continue;
   if(!selected.has(decoded.report.tick)){selected.add(decoded.report.tick);result.currentReportDetails.push(reportDetail(decoded.report,publicSession.profile));}
   for(const e of decoded.report.endpoints||[])if(e.legacyProjection?.status==='mismatch')result.currentLegacyProjectionDifferences.push({tick:decoded.report.tick,room:e.room,location:e.location,fields:e.legacyProjection.mismatches,coreComparison:e.coreComparison});
  }
 }
 result.currentProjectionSummary={reports:result.currentReportDetails.length,
  actualCommitmentBuildReports:result.currentReportDetails.filter(x=>x.commitmentActuallyInvoked).length,
  indexCompleteReports:result.currentReportDetails.filter(x=>x.commitmentIndexComplete===true).length,
  reportsWithAllProjectionRows:result.currentReportDetails.filter(x=>x.commitmentProjectionRows===x.expectedCommitmentProjectionRows).length,
  fullSamples:result.currentReportDetails.filter(x=>x.completeSample).length,countsAreDescriptionsNotAcceptanceGates:true};
 result.currentVerificationSha256=C.sha256(JSON.stringify(verified,null,2)+'\n');result.inputDigests={};
 for(const name of ['public-session.json','console.jsonl','guard-result.json','source-closed.json']){const file=path.join(run,name);if(fs.existsSync(file)){const b=C.bytes(file);result.inputDigests[name]={bytes:b.length,sha256:C.sha256(b)};}}
 return result;
}
function S_readPublic(run){try{const f=path.join(run,'public-session.json');return fs.existsSync(f)?C.readJson(f):null;}catch{return null;}}
module.exports={measures,compareResults,makeComparison,reportDetail,phaseSummary};
if(require.main===module)U.cli(async()=>{const o=U.options(['run','out']);C.required(o,'run','out');U.verifyPackage();U.outside(o.out,o.run);U.outside(o.out,U.ROOT);
 const result=makeComparison(o.run);C.durable(o.out,result);console.log(JSON.stringify(result));if(!result.currentCaptureVerified)process.exitCode=2;});
