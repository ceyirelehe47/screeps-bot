'use strict';
const C=require('../runtime/common.cjs'),U=require('./util.cjs');
const LOCK=require('../references/prerequisites.json');
function checkedBytes(b,entry){if(!Buffer.isBuffer(b)||b.length!==entry.bytes||C.blob(b)!==entry.blob||C.sha256(b)!==entry.sha256)C.fail('PREREQUISITE_BYTES_MISMATCH');return JSON.parse(b.toString('utf8'));}
function read(refactor,entry){return checkedBytes(U.git(refactor,['show',LOCK.commit+':'+entry.path],true),entry);}
function checkPrerequisites(refactor){
 const final=read(refactor,LOCK.priorFinal);if(final.status!=='NOT_DEPLOYED'||final.captureVerified!==false||final.closure!=='NOT_DEPLOYED'||final.rawReports!==0||!Array.isArray(final.issues)||!final.issues.includes('COLLECTOR_EARLY_EXIT'))C.fail('PRIOR_RETRY_TRIGGER_NOT_VERIFIED');
 const remediation=read(refactor,LOCK.priorRemediation);if(remediation.status!=='SOURCE_MANIFEST_REMEDIATION_COMMIT_VERIFIED'||remediation.head!==LOCK.sourceHead||remediation.tree!==LOCK.sourceTree||remediation.generatorCheck!=='all-listed-outputs')C.fail('SOURCE_MANIFEST_REMEDIATION_NOT_VERIFIED');
 const offline=read(refactor,LOCK.priorOffline);if(offline.status!=='SUBPHASE_X_OFFLINE_VERIFIED'||offline.sourceHead!==LOCK.sourceHead||offline.sourceTree!==LOCK.sourceTree||offline.repositoryNodeTests!==246||offline.loaderRegenerated!==true||offline.sourceManifestOutputValidation!=='all-listed-outputs'||offline.tests?.suites!==195||offline.tests?.tests!==685)C.fail('PRIOR_OFFLINE_GATE_NOT_VERIFIED');
 const closed=read(refactor,LOCK.priorSourceClosed);if(closed.status!=='SOURCE_DEFAULT_OFF_RESTORED'||closed.sourceHead!==LOCK.sourceHead||closed.closedHead!==LOCK.closedCompatHead||closed.sameTreeAsSource!==true)C.fail('PRIOR_SOURCE_CLOSE_NOT_VERIFIED');
 return {status:'SUBPHASE_X_RETRY_PREREQUISITES_VERIFIED',priorRun:{commit:LOCK.commit,status:final.status,issue:'COLLECTOR_EARLY_EXIT',candidatePost:false},sourceRemediation:{head:LOCK.sourceHead,tree:LOCK.sourceTree,outputs:13},closedCompatHead:LOCK.closedCompatHead,networkUsed:false};
}
module.exports={LOCK,checkedBytes,checkPrerequisites};
