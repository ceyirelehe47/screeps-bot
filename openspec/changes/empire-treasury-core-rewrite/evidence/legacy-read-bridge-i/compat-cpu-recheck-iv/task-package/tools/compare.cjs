'use strict';
/** Offline interpretation of a freshly reverified run against the exact accepted CPU II
 * record. No performance pass threshold; no data, time series or authorization is merged. */
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
const V=require('../runtime/verify-run.cjs'),W=require('../runtime/samples.cjs'),P=require('./prerequisites.cjs');
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
function measures(v){
 if(!Array.isArray(v.analysis?.rows))return null;
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
  successorTailProfiles:rows.filter(r=>r.completeProfileReportedBySuccessor).length,
  lastSampleTail:'unobservable without a successor; no fifth point',
  commitmentActuallyInvoked:invocations.commitmentBuild.count>0,
  reportedTailCostsWithinTwoCpu:rows.some(r=>r.completeProfileReportedBySuccessor)?rows.filter(r=>r.completeProfileReportedBySuccessor).every(r=>r.completeProfileReportedBySuccessor.elapsed<=2):null,
  reportedTailCountForAboveBoolean:rows.filter(r=>r.completeProfileReportedBySuccessor).length};
}
function compareResults(current,prior){
 const before=measures(prior),after=measures(current);
 const a=before.invocations.readerLoad,b=after?.invocations.readerLoad;
 let relation='insufficient_following_invocations';
 // Require at least two actual post-first invocations in BOTH runs for this descriptive median.
 if(current.captureVerified&&b&&a.followingInvocationCount>=2&&b.followingInvocationCount>=2){
  relation=b.followingInvokedIntervalMedian<a.followingInvokedIntervalMedian?'lower_observed_median':
   b.followingInvokedIntervalMedian>a.followingInvokedIntervalMedian?'higher_observed_median':'equal_observed_median';
 }
 return {status:current.captureVerified?'LOADER_IV_COMPARISON_RECORDED':'LOADER_IV_COMPARISON_INCONCLUSIVE',
  currentCaptureVerified:current.captureVerified===true,currentCaptureStatus:current.status,currentClosure:current.closure,
  historical:{sourceCommit:P.LOCK.priorDiagnostic.commit,sourcePath:P.LOCK.priorDiagnostic.path,sourceBlob:P.LOCK.priorDiagnostic.blob,
   sourceSha256:P.LOCK.priorDiagnostic.sha256,acceptedCaptureReused:true,fullHistoricalRunReverifiedHere:false,runId:prior.runId,profileHead:prior.profileHead,measurements:before},
  current:{compatBase:K.COMPAT,refactorBase:K.REFACTOR,runId:current.runId??null,profileHead:current.profileHead??null,measurements:after},
  postFirstReaderInvocationComparison:{relation,baselineCount:a.followingInvocationCount,currentCount:b?.followingInvocationCount??0,
   baselineMedian:a.followingInvokedIntervalMedian,currentMedian:b?.followingInvokedIntervalMedian??null,
   lowerCostRequiredForCaptureAcceptance:false},
  interpretation:{callZeroExcludedFromFunctionCost:true,intervalsAreNotNetFunctionCosts:true,
   firstAdmittedSampleIsNotNecessarilyFirstLoaderCall:true,firstLoaderCallIsNotProofOfEngineColdStart:true,
   onlyActualCallsCountAsObservationOrCommitmentExecution:true,workloadsNotControlledAcrossRuns:true,
   exactSpeedupPercentNotComputed:true,causalSpeedupClaim:false,engineFactoryExecutionCountMeasured:false,
   budget:2,engineCpuGapRepaired:false,fullCompatibilityObserved:false,noNewOnlineCalls:true},
  caution:'Sequential four-point runs, not randomized A/B. Initialization/publication and diagnostic overhead remain inside the sample budget. A call=0 interval is boundary work, never a measured builder invocation. Preserve insufficient evidence instead of adding samples.'};
}
function makeComparison(run){
 const {prior}=P.packaged();let verified;
 try{verified=V.verifyRun(run);}catch(e){verified={status:'CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE',closure:'ONLINE_CLOSE_UNCONFIRMED',captureVerified:false,issues:[C.code(e)]};}
 const result=compareResults(verified,prior);
 result.currentLegacyProjectionDifferences=[];
 const D=require('../runtime/decoder.cjs');
 let rawFrames=[];
 try{rawFrames=V.records(run,'console.jsonl');}catch(e){result.currentRawInspectionError=C.code(e);}
 for(const f of rawFrames){
  if(f.kind!=='ws-frame')continue;let parsed;try{parsed=JSON.parse(f.text);}catch{continue;}
  if(!Array.isArray(parsed)||parsed[0]!==`user:${C.EXPECTED.userId}/console`||parsed[1]?.shard!==C.EXPECTED.shard)continue;
  for(const raw of parsed[1]?.messages?.log||[]){const decoded=D.parseBridge(raw);if(decoded.kind!=='bridge'||!verified.receivedTicks?.includes(decoded.report.tick))continue;
   for(const e of decoded.report.endpoints||[])if(e.legacyProjection?.status==='mismatch')result.currentLegacyProjectionDifferences.push({tick:decoded.report.tick,room:e.room,location:e.location,fields:e.legacyProjection.mismatches,coreComparison:e.coreComparison});
  }
 }
 result.currentVerificationSha256=C.sha256(JSON.stringify(verified,null,2)+'\n');
 result.inputDigests={};
 for(const name of ['public-session.json','console.jsonl','guard-result.json','source-closed.json']){
  const file=path.join(run,name);if(fs.existsSync(file)){const b=C.bytes(file);result.inputDigests[name]={bytes:b.length,sha256:C.sha256(b)};}
 }
 return result;
}
module.exports={measures,compareResults,makeComparison};
if(require.main===module)U.cli(async()=>{const o=U.options(['run','out']);C.required(o,'run','out');U.verifyPackage();U.outside(o.out,o.run);U.outside(o.out,U.ROOT);
 const result=makeComparison(o.run);C.durable(o.out,result);console.log(JSON.stringify(result));if(!result.currentCaptureVerified)process.exitCode=2;});
