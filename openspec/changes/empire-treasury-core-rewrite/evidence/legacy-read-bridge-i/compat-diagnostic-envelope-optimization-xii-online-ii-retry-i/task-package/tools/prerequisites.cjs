'use strict';
const C=require('../runtime/common.cjs'),U=require('./util.cjs'),K=require('../runtime/policy.cjs');
const LOCK=require('../references/prerequisites.json');
function checkedBytes(b,e){if(!Buffer.isBuffer(b)||b.length!==e.bytes||C.blob(b)!==e.blob||C.sha256(b)!==e.sha256)C.fail('PREREQUISITE_BYTES_MISMATCH',{path:e.path});return JSON.parse(b.toString('utf8'));}
const read=(repo,e)=>checkedBytes(U.git(repo,['show',LOCK.commit+':'+e.path],true),e);
function checkPrerequisites(repo){const final=read(repo,LOCK.finalVerification),offline=read(repo,LOCK.offlineResult),application=read(repo,LOCK.sourceApplication);
 if(final.status!=='NOT_DEPLOYED'||final.captureVerified!==false||final.closure!=='NOT_DEPLOYED'||final.rawReports!==0||final.completeSamples!==0)C.fail('PRIOR_XII_NOT_DEPLOYED_EVIDENCE_INVALID');
 if(offline.status!=='ENVELOPE_XII_OFFLINE_VERIFIED'||offline.sourceHead!==K.COMPAT||offline.sourceTree!==K.SOURCE_TREE||offline.repositoryNodeTests!==290||offline.tests?.suites!==195||offline.tests?.tests!==685)C.fail('PRIOR_XII_OFFLINE_EVIDENCE_INVALID');
 if(application.status!=='ENVELOPE_XII_SOURCE_VERIFIED'||application.head!==K.COMPAT||application.tree!==K.SOURCE_TREE||application.changedPaths!==11)C.fail('PRIOR_XII_SOURCE_EVIDENCE_INVALID');
 return{status:'ENVELOPE_XII_RETRY_PREREQUISITES_VERIFIED',priorRun:{commit:LOCK.commit,capture:final.status,offline:offline.status,source:application.status,noUpload:true},networkUsed:false};}
module.exports={LOCK,checkedBytes,checkPrerequisites};
