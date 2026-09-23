'use strict';
// Inclusive measured costs only. This report is an analysis of independently
// verified records, not a replacement CPU validator or an engine-speed claim.
const fs=require('node:fs'),path=require('node:path'),C=require('../runtime/common.cjs');
const TAIL=Object.freeze(['serializationAndSize','emit','retention']);
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
function scalar(x){return finite(x)?x:null;}
function stats(xs){const a=xs.filter(finite).sort((x,y)=>x-y),n=a.length,m=Math.floor(n/2);return {count:n,minimum:n?a[0]:null,median:n?(n%2?a[m]:(a[m-1]+a[m])/2):null,maximum:n?a[n-1]:null};}
function analyze(v){
 const raw=v.rawSummary||[],tails=v.completedTailProfiles||[],byTick=new Map(),seen=new Set();
 for(const r of raw){if(!Number.isSafeInteger(r.tick)||seen.has(r.tick)||!finite(r.prefix))C.fail('OVERHEAD_RAW_INVALID');seen.add(r.tick);}
 for(const t of tails){
  const r=raw.find(x=>x.tick===t.tick&&x.accepted===true);
  if(!r||byTick.has(t.tick)||!finite(t.elapsed)||t.elapsed<r.prefix||!t.phases)C.fail('OVERHEAD_TAIL_LINK_INVALID');
  const parts={};for(const k of TAIL){if(!finite(t.phases[k]))C.fail('OVERHEAD_TAIL_INVALID');parts[k]=t.phases[k];}
  const sum=Object.values(parts).reduce((a,b)=>a+b,0);
  if(Math.abs(r.prefix+sum-t.elapsed)>1e-6)C.fail('OVERHEAD_TAIL_SUM_INVALID');
  byTick.set(t.tick,{status:'observed',cpu:sum,parts,totalIncludingTail:t.elapsed});
 }
 const rows=raw.map(r=>({tick:r.tick,accepted:r.accepted===true,businessComplete:r.accepted===true&&r.claimedComplete===true,
  prefixCpu:r.prefix,preCommitmentCpu:scalar(r.preCommitmentCpu),calls:r.reportedCalls||null,
  observationCalled:r.reportedCalls?.observationBuild===1,commitmentCalled:r.reportedCalls?.commitmentBuild===1,
  actualCommitmentCallInterval:r.reportedCalls?.commitmentBuild===1&&r.trace?.status==='complete'?scalar(r.trace.callInterval):null,
  phaseIntervals:r.phaseIntervals||null,work:r.work||null,
  tail:byTick.get(r.tick)||{status:'unobserved',cpu:null,parts:null,totalIncludingTail:null}}));
 const accepted=rows.filter(r=>r.accepted),called=accepted.filter(r=>r.commitmentCalled);
 const reference=fs.readFileSync(path.join(__dirname,'../references/prior-XIV-retry-I-review.json'));
 return {kind:'read-envelope-XV-overhead-analysis/v1',captureStatus:v.status,closure:v.closure,
  baseline:{file:'references/prior-XIV-retry-I-review.json',sha256:C.sha(reference),evidenceCommit:C.POLICY.refactorBase},
  accepted:{count:accepted.length,commitmentCalls:called.length,completeBusinessSamples:accepted.filter(r=>r.businessComplete).length,
   prefixCpu:stats(accepted.map(r=>r.prefixCpu)),preCommitmentCpu:stats(accepted.map(r=>r.preCommitmentCpu)),
   actualCommitmentCallCpu:stats(called.map(r=>r.actualCommitmentCallInterval)),tailCpu:stats(accepted.map(r=>r.tail.cpu))},
  rejectedForensicOnly:rows.filter(r=>!r.accepted),rows,
  instrumentationCostSubtracted:false,estimatedMissingTails:0,newCpuProbes:0,diagnosticWireRevision:'XIV',sourceImplementationRevision:'XV',
  engineCpuGapRepaired:false,rootCauseAssigned:false,fullCompatibilityObserved:false,
  interpretation:'Prefix and measured tail are disjoint. Nested call/body/task intervals overlap parent phases and are never added twice. A not-called builder has no measured call cost. Missing tails stay null. Different ticks and workloads are not a causal speedup comparison.'};
}
module.exports={analyze,stats,TAIL};
