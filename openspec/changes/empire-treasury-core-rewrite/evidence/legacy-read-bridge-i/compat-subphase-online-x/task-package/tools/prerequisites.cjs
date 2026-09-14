'use strict';
/** Read-only prerequisites from accepted Git evidence. IX acceptance is used for
 * functional attribution only; this package repairs its stale source-manifest identities before any online action. */
const C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),U=require('./util.cjs');
const LOCK=require('../references/prerequisites.json'),CONTRACT=require('../references/attribution-contract.json');
function checkedBytes(b,entry){if(!Buffer.isBuffer(b)||b.length!==entry.bytes||C.blob(b)!==entry.blob||(entry.sha256&&C.sha256(b)!==entry.sha256))C.fail('PREREQUISITE_BYTES_MISMATCH');return JSON.parse(b.toString('utf8'));}
function checkPrerequisites(refactor){
 const prior=checkedBytes(U.git(refactor,['show',LOCK.priorDiagnostic.commit+':'+LOCK.priorDiagnostic.path],true),LOCK.priorDiagnostic);
 if(prior.status!=='CPU_DIAGNOSTIC_CAPTURE_VERIFIED'||!prior.captureVerified||prior.closure!=='RESTORED_BYTES_AND_RUNTIME_VERIFIED'||prior.diagnosticReports!==4||prior.completeSamples!==0||prior.analysis?.engineBudget!==2||prior.analysis?.completeTailProfiles!==3)C.fail('PRIOR_DIAGNOSTIC_NOT_ACCEPTED');
 const ix=checkedBytes(U.git(refactor,['show',LOCK.ixAcceptance.commit+':'+LOCK.ixAcceptance.path],true),LOCK.ixAcceptance);
 if(ix.status!=='SUBPHASE_IX_OFFLINE_VERIFIED_NOT_DEPLOYED'||ix.compatHead!==LOCK.ixAcceptance.compatHead||ix.enabled!==false||ix.budget!==2||ix.expectedBoundaryCalls!==12||ix.perRecordCpuSampling!==false||ix.actualEngineMeasurement!==false||ix.onlineRun!==false||ix.engineCpuGapRepaired!==false||!C.same(ix.subphases,CONTRACT.subphases))C.fail('SUBPHASE_IX_NOT_ACCEPTED');
 return {status:'SUBPHASE_X_PREREQUISITES_VERIFIED',priorDiagnostic:{commit:LOCK.priorDiagnostic.commit,blob:LOCK.priorDiagnostic.blob},ixAcceptance:{commit:LOCK.ixAcceptance.commit,blob:LOCK.ixAcceptance.blob},manifestRemediationRequired:true,networkUsed:false};
}
module.exports={LOCK,checkedBytes,checkPrerequisites};
