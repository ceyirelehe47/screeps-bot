'use strict';
/** Read-only prerequisites: exact accepted Git evidence, never an assumed latest report. */
const fs=require('node:fs'),path=require('node:path');
const C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),U=require('./util.cjs');
const LOCK=require('../references/prerequisites.json');
function checkedBytes(b,entry){
 if(!Buffer.isBuffer(b)||b.length!==entry.bytes||C.blob(b)!==entry.blob||C.sha256(b)!==entry.sha256)C.fail('PREREQUISITE_BYTES_MISMATCH');
 return JSON.parse(b.toString('utf8'));
}
function packaged(){
 const prior=checkedBytes(fs.readFileSync(path.join(U.ROOT,LOCK.priorDiagnostic.file)),LOCK.priorDiagnostic);
 const accepted=checkedBytes(fs.readFileSync(path.join(U.ROOT,LOCK.loaderAcceptance.file)),LOCK.loaderAcceptance);
 if(prior.status!=='CPU_DIAGNOSTIC_CAPTURE_VERIFIED'||!prior.captureVerified||prior.closure!=='RESTORED_BYTES_AND_RUNTIME_VERIFIED'
 ||prior.diagnosticReports!==4||prior.completeSamples!==0||prior.analysis?.engineBudget!==2||prior.analysis?.completeTailProfiles!==3)C.fail('PRIOR_DIAGNOSTIC_NOT_ACCEPTED');
 if(accepted.status!=='LOADER_III_OFFLINE_VERIFIED_NOT_DEPLOYED'||accepted.compatHead!=='ae15ec55b0363933d31c93acc2480b6adbea306a'
 ||accepted.budget!==2||accepted.enabled!==false||accepted.factoryBodiesChanged!==false||accepted.runtimeDefinitionReuse!==true)C.fail('LOADER_III_NOT_ACCEPTED');
 return {prior,accepted};
}
function checkPrerequisites(refactor){
 packaged();
 for(const entry of Object.values(LOCK)){
  const b=U.git(refactor,['show',entry.commit+':'+entry.path],true);checkedBytes(b,entry);
  if(!b.equals(fs.readFileSync(path.join(U.ROOT,entry.file))))C.fail('PACKAGED_PREREQUISITE_CHANGED');
 }
 return {status:'LOADER_IV_PREREQUISITES_VERIFIED',priorDiagnostic:{commit:LOCK.priorDiagnostic.commit,blob:LOCK.priorDiagnostic.blob},loaderAcceptance:{commit:LOCK.loaderAcceptance.commit,blob:LOCK.loaderAcceptance.blob},networkUsed:false};
}
module.exports={LOCK,checkedBytes,packaged,checkPrerequisites};
