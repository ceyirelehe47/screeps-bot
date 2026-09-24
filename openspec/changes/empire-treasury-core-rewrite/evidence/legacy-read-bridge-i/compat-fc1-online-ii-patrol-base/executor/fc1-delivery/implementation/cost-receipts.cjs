'use strict';
const C=require('./common.cjs'),P=C.POLICY;
const fin=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const nn=x=>Number.isSafeInteger(x)&&x>=0;
const need=(b,s)=>{if(!b)C.fail(s);};
function native(c){return C.obj(c)&&fin(c.used)&&fin(c.limit)&&c.limit>0&&fin(c.tickLimit)&&c.tickLimit>=c.limit&&nn(c.bucket)&&c.bucket<=10000;}
function validate(r,report,s,previous){
 need(r?.kind==='treasury-full-cost-sample'&&r.version===1&&r.experimentId===P.runtimeEmitterId,'COST_IDENTITY');
 need(!!report&&r.tick===report.tick&&r.sampleOrdinal===report.cpuProfile.sampleOrdinal&&r.windowStart===s.profile.startTick&&r.windowEnd===s.profile.endTick,'COST_SAMPLE_BINDING');
 need(r.authorizesActions===false&&r.performanceTargetCpu===null&&r.measurementBoundary==='before-preview-run_to_after-preview-return','COST_AUTHORITY_OR_BOUNDARY');
 need(C.same(r.policy,{cooperativeCeilingCpu:10,retainedReserveCpu:25,admissionHeadroomCpu:55,minBucket:2000,maxReceiptBytes:16384}),'COST_POLICY');
 need(native(r.nativeEntry)&&native(r.nativeReturn)&&r.nativeEntry.limit===r.nativeReturn.limit&&r.nativeEntry.tickLimit===r.nativeReturn.tickLimit&&r.nativeReturn.used>=r.nativeEntry.used,'COST_NATIVE_PROGRESSION');
 need(r.nativeEntry.bucket>=2000&&r.nativeEntry.tickLimit-r.nativeEntry.used>=55,'COST_ADMISSION_UNPROVEN');
 const W=require('./samples.cjs');
 need(fin(r.elapsedThroughPreviewReturn)&&W.near(r.elapsedThroughPreviewReturn,r.nativeReturn.used-r.nativeEntry.used),'COST_DELTA');
 need(r.previewStatus===report.status&&typeof r.stopsFutureSamples==='boolean','COST_PREVIEW_STATUS');
 const tail=W.completion(report.cpuProfile,r.currentTailProfile);
 need(r.elapsedThroughPreviewReturn+1e-7>=tail.elapsed,'COST_RETURN_PRECEDES_TAIL');
 const reason=r.previewStatus!=='sampled'?'PREVIEW_NOT_COMPLETE':r.elapsedThroughPreviewReturn>10?'CPU_OBSERVED_EXPOSURE_STOP':r.nativeReturn.tickLimit-r.nativeReturn.used<25?'CPU_RESERVE_DEPLETED':r.nativeReturn.bucket<2000?'BUCKET_DEPLETED':null;
 need(r.stopReason===reason&&r.stopsFutureSamples===(reason!==null),'COST_STOP_ACCOUNTING');
 if(!previous)need(r.previousReceiptOverhead===null&&r.sampleOrdinal===1,'COST_FIRST_NOT_FRESH');
 else{
  need(!previous.stopsFutureSamples,'COST_CONTINUED_AFTER_STOP');
  const p=r.previousReceiptOverhead;
  need(p?.tick===previous.tick&&fin(p.elapsedAfterPreviewReturn),'COST_PREVIOUS_RECEIPT');
  need(previous.elapsedThroughPreviewReturn+p.elapsedAfterPreviewReturn<=10+1e-7&&previous.nativeReturn.tickLimit-previous.nativeReturn.used-p.elapsedAfterPreviewReturn>=25-1e-7,'COST_CONTINUED_AFTER_EXPOSURE');
 }
 need(Buffer.byteLength(JSON.stringify(r))<=16384,'COST_RECEIPT_TOO_LARGE');
 return {tick:r.tick,previewReturnCpu:r.elapsedThroughPreviewReturn,fullMainReportTail:tail,
   nativeHeadroomBefore:r.nativeEntry.tickLimit-r.nativeEntry.used,nativeHeadroomAfter:r.nativeReturn.tickLimit-r.nativeReturn.used};
}
module.exports={validate,native};
