'use strict';
const C=require('../runtime/common.cjs'),U=require('./util.cjs');
const LOCK=require('../references/prerequisites.json');
function checkedBytes(b,entry){if(!Buffer.isBuffer(b)||b.length!==entry.bytes||C.blob(b)!==entry.blob||C.sha256(b)!==entry.sha256)C.fail('PREREQUISITE_BYTES_MISMATCH');return JSON.parse(b.toString('utf8'));}
function read(refactor,entry){return checkedBytes(U.git(refactor,['show',LOCK.commit+':'+entry.path],true),entry);}
function checkPrerequisites(refactor){
 const final=read(refactor,LOCK.priorFinal);if(final.status!=='CPU_DIAGNOSTIC_CAPTURE_VERIFIED'||final.captureVerified!==true||final.closure!=='RESTORED_BYTES_AND_RUNTIME_VERIFIED'||final.rawReports!==4||final.diagnosticReports!==4||final.completeSamples!==1||final.partialCpuSamples!==3)C.fail('PRIOR_ONLINE_RESULT_NOT_VERIFIED');
 const attr=read(refactor,LOCK.priorAttribution);if(attr.status!=='SUBPHASE_X_RETRY_ATTRIBUTION_RECORDED'||attr.captureVerified!==true||attr.reports?.raw!==4||attr.reports?.complete!==1||attr.reports?.attributed!==4||attr.interpretation?.engineCpuGapRepaired!==false)C.fail('PRIOR_ATTRIBUTION_NOT_VERIFIED');
 const driver=read(refactor,LOCK.priorDriver);if(driver.status!=='RESTORED_BYTES_AND_RUNTIME_VERIFIED'||driver.failure!==null||driver.collectorExit!==0||driver.guardExit!==0||driver.closure?.bytesConfirmed!==true||driver.closure?.runtimeConfirmed!==true)C.fail('PRIOR_RECOVERY_NOT_VERIFIED');
 return {status:'HOTPATH_XI_PREREQUISITES_VERIFIED',priorRun:{commit:LOCK.commit,capture:final.status,completeSamples:1,partialCpuSamples:3,closure:final.closure},closedCompatHead:LOCK.closedCompatHead,sourceTree:LOCK.sourceTree,networkUsed:false};
}
module.exports={LOCK,checkedBytes,checkPrerequisites};
