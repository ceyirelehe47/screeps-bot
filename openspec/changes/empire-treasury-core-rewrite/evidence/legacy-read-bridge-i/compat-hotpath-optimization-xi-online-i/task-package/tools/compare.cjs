'use strict';
/** Recomputes current IX attribution from raw evidence and compares it with the
 * pinned Retry-I result. Subphases overlap parent phases; no causal percentage
 * or probe-overhead subtraction is produced. */
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs');
const V=require('../runtime/verify-run.cjs'),W=require('../runtime/samples.cjs'),D=require('../runtime/decoder.cjs');
const PRIOR=require('../references/prior-online-basis.json');
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
function median(a){return V.median(a.filter(finite));}
function detail(r,p){const a=r.cpuProfile?.attribution||null,c=r.commitments,reason=W.sampleError(r,p),rows=Array.isArray(c?.rows)?c.rows:null;
 return {tick:r.tick,sampleOrdinal:r.cpuProfile?.sampleOrdinal,status:r.status,completeSample:reason===null,sampleCompletenessReason:reason,
  prefixCpu:r.cpuBeforeSerializationAndEmit,calls:r.cpuProfile?.calls||null,parentPhases:r.cpuProfile?.phases||null,
  attribution:a?{boundaries:a.boundaries,active:a.active,intervals:a.intervals,work:a.work}:null,
  tasks:r.legacyInputs?.tasks||null,reservations:r.legacyInputs?.reservations||null,
  commitmentStatus:c?.status??'missing',commitmentIndexComplete:typeof c?.completeness?.complete==='boolean'?c.completeness.complete:null,
  commitmentProjectionRows:rows?.length??null,expectedCommitmentProjectionRows:p.rooms.length*p.resources.length,
  directOkEndpoints:(r.endpoints||[]).filter(x=>x.directStatus==='ok').length,coreMatchedEndpoints:(r.endpoints||[]).filter(x=>x.coreComparison==='match_selected_scope').length};}
function summarize(details){
 const subphases=Object.fromEntries(W.SUBPHASES.map(k=>{const values=details.flatMap(x=>Object.hasOwn(x.attribution?.intervals||{},k)?[x.attribution.intervals[k]]:[]);return[k,{count:values.length,values,median:median(values)}];}));
 const parent=Object.fromEntries(W.PHASES.map(k=>{const values=details.flatMap(x=>Object.hasOwn(x.parentPhases||{},k)?[x.parentPhases[k]]:[]);return[k,{count:values.length,values,median:median(values)}];}));
 const work=Object.fromEntries(W.WORK_KEYS.map(k=>{const values=details.flatMap(x=>Object.hasOwn(x.attribution?.work||{},k)?[x.attribution.work[k]]:[]);return[k,{count:values.length,values,median:median(values)}];}));
 const region=names=>names.map(k=>({subphase:k,...subphases[k]})).filter(x=>x.count).sort((a,b)=>(b.median??-1)-(a.median??-1));
 return {subphases,parentPhases:parent,work,observationRanking:region(W.SUBPHASES.slice(0,4)),commitmentRanking:region(W.SUBPHASES.slice(4,8)),projection:subphases.projectionRows};
}
function selectedReports(run,verified){const pub=fs.existsSync(path.join(run,'public-session.json'))?C.readJson(path.join(run,'public-session.json')):null,selected=new Map();let frames=[];
 try{frames=V.records(run,'console.jsonl');}catch{}
 for(const f of frames){if(f.kind!=='ws-frame')continue;let data;try{data=JSON.parse(f.text);}catch{continue;}if(!Array.isArray(data)||data[0]!==`user:${C.EXPECTED.userId}/console`||data[1]?.shard!==C.EXPECTED.shard)continue;
  for(const raw of data[1]?.messages?.log||[]){const x=D.parseBridge(raw);if(x.kind==='bridge'&&verified.receivedTicks?.includes(x.report.tick)&&!selected.has(x.report.tick))selected.set(x.report.tick,x.report);}}
 return {pub,reports:[...selected.values()].sort((a,b)=>a.tick-b.tick)};}
function makeAttribution(run){let verified;try{verified=V.verifyRun(run);}catch(e){verified={status:'CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE',captureVerified:false,closure:'ONLINE_CLOSE_UNCONFIRMED',issues:[C.code(e)]};}
 const {pub,reports}=selectedReports(run,verified),details=pub?reports.map(r=>detail(r,pub.profile)):[],summary=summarize(details);
 const attributed=details.filter(x=>x.attribution),complete=details.filter(x=>x.completeSample).length;
 const status=verified.captureVerified&&details.length===4&&attributed.length>=1?'HOTPATH_XI_ATTRIBUTION_RECORDED':'HOTPATH_XI_ATTRIBUTION_INCONCLUSIVE';
 const result={status,captureVerified:verified.captureVerified===true,captureStatus:verified.status,closure:verified.closure,sourceHead:verified.sourceHead??pub?.sourceHead??null,profileHead:verified.profileHead??null,
  reports:{raw:verified.rawReports??0,diagnostic:verified.diagnosticReports??0,complete,partialCpu:verified.partialCpuSamples??0,attributed:attributed.length},details,summary,
  interpretation:{subphasesOverlapParentPhases:true,intervalsAreInclusive:true,diagnosticOverheadSubtracted:false,perRecordCpuSampling:false,primitiveWorkCountersAreNotCpuWeights:true,
   exactSpeedupPercentNotComputed:true,causalOptimizationClaim:false,budget:2,engineCpuGapRepaired:false,fullCompatibilityObserved:false,lastSampleTailUnobservable:true},inputDigests:{}};
 for(const name of ['public-session.json','console.jsonl','guard-result.json','source-closed.json','diagnostic-verification.json']){const f=path.join(run,name);if(fs.existsSync(f)){const b=C.bytes(f);result.inputDigests[name]={bytes:b.length,sha256:C.sha256(b)};}}
 return result;}
function metricRows(current,prior){const keys=[...new Set([...Object.keys(prior),...Object.keys(current)])].sort();return Object.fromEntries(keys.map(k=>{const a=prior[k]??null,b=current[k]?.median??null;return[k,{prior:a,current:b,delta:(finite(a)&&finite(b))?b-a:null,currentCount:current[k]?.count??0}];}));}
function makeComparison(run){const current=makeAttribution(run),prior=PRIOR;
 const result={status:current.status==='HOTPATH_XI_ATTRIBUTION_RECORDED'?'HOTPATH_XI_COMPARISON_RECORDED':'HOTPATH_XI_COMPARISON_INCONCLUSIVE',captureVerified:current.captureVerified,closure:current.closure,
  priorEvidence:{refactorCommit:prior.refactorCommit,compatClosedHead:prior.compatClosedHead,finalVerification:prior.finalVerification,attribution:prior.attribution,reports:prior.reports},current,
  comparison:{completeSamples:{prior:prior.reports.complete,current:current.reports.complete,delta:current.reports.complete-prior.reports.complete,multipleCurrent:current.reports.complete>=2},
   partialCpuSamples:{prior:prior.reports.partialCpu,current:current.reports.partialCpu,delta:current.reports.partialCpu-prior.reports.partialCpu},
   subphases:metricRows(current.summary.subphases,prior.subphaseMedians),parentPhases:metricRows(current.summary.parentPhases,prior.parentPhaseMedians)},
  decisionBoundary:{performanceImprovementRequiredForCapture:false,exactCausalSpeedupComputed:false,automaticProductionCutoverAuthorized:false,engineCpuGapRepaired:false,fullCompatibilityObserved:false}};
 return result;}
module.exports={makeAttribution,makeComparison,detail,summarize,metricRows};
if(require.main===module)U.cli(async()=>{const o=U.options(['run','out']);C.required(o,'run','out');U.verifyPackage();U.outside(o.out,o.run);U.outside(o.out,U.ROOT);const result=makeComparison(o.run);C.durable(o.out,result);console.log(JSON.stringify(result));if(result.status!=='HOTPATH_XI_COMPARISON_RECORDED')process.exitCode=2;});
