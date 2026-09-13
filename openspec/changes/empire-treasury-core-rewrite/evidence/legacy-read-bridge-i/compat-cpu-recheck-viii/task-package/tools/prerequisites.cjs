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
 const accepted=checkedBytes(fs.readFileSync(path.join(U.ROOT,LOCK.buildAcceptance.file)),LOCK.buildAcceptance);
 if(prior.status!=='CPU_DIAGNOSTIC_CAPTURE_VERIFIED'||!prior.captureVerified||prior.closure!=='RESTORED_BYTES_AND_RUNTIME_VERIFIED'
 ||prior.diagnosticReports!==4||prior.completeSamples!==0||prior.analysis?.engineBudget!==2||prior.analysis?.completeTailProfiles!==3
 ||prior.analysis.rows.filter(r=>r.calls?.observationBuild===1).length!==3||prior.analysis.rows.filter(r=>r.calls?.commitmentBuild===1).length!==3)C.fail('PRIOR_DIAGNOSTIC_NOT_ACCEPTED');
 if(accepted.status!=='BUILD_VII_OFFLINE_VERIFIED_NOT_DEPLOYED'||accepted.compatHead!==LOCK.buildAcceptance.compatHead||accepted.budget!==2||accepted.enabled!==false
 ||!C.same(accepted.factoryBodiesChanged,['commitments: full task-bucket storage','observation: intermediates'])
 ||accepted.runtimeDefinitionReuse!==true||accepted.firstSuccessfulFactoryExecutions!==7||accepted.followingFactoryExecutions!==0
 ||accepted.directReadChanged!==false||accepted.taskBucketStorageChanged!==true||accepted.observationIntermediatesReduced!==true
 ||accepted.fullIndexBuiltEagerly!==true||accepted.actualEngineMeasurement!==false||accepted.engineCpuGapRepaired!==false)C.fail('BUILD_VII_NOT_ACCEPTED');
 return {prior,accepted};
}
function checkPrerequisites(refactor){
 packaged();
 for(const entry of Object.values(LOCK)){
  const b=U.git(refactor,['show',entry.commit+':'+entry.path],true);checkedBytes(b,entry);
  if(!b.equals(fs.readFileSync(path.join(U.ROOT,entry.file))))C.fail('PACKAGED_PREREQUISITE_CHANGED');
 }
 return {status:'BUILD_VIII_PREREQUISITES_VERIFIED',priorDiagnostic:{commit:LOCK.priorDiagnostic.commit,blob:LOCK.priorDiagnostic.blob},
  buildAcceptance:{commit:LOCK.buildAcceptance.commit,blob:LOCK.buildAcceptance.blob},networkUsed:false};
}
module.exports={LOCK,checkedBytes,packaged,checkPrerequisites};
