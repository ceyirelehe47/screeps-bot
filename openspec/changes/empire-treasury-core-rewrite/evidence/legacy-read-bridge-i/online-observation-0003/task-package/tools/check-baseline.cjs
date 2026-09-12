'use strict';
const fs=require('node:fs'),path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
function check(refactor,compat){
 if(Number(process.versions.node.split('.')[0])!==22)C.fail('NODE22_REQUIRED');
 U.exactHead(refactor,K.REFACTOR,'refactor/empire-treasury-rearchitecture');U.exactHead(compat,K.COMPAT,'compat/treasury-read-bridge-i');
 if(U.remoteHead(refactor,'refactor/empire-treasury-rearchitecture')!==K.REFACTOR||U.remoteHead(compat,'compat/treasury-read-bridge-i')!==K.COMPAT)C.fail('REMOTE_BASELINE_CHANGED');
 C.loadGuard(compat);
 const at='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/online-observation-0002-guard-joint-probe-ii-verifier-remediation-i';
 const v=JSON.parse(U.git(refactor,['show',K.REFACTOR+':'+at+'/FINAL-VERIFICATION.json']));
 if(v.verifierStatus!=='GUARD_COLLECTOR_CONTROL_PLANE_PROBE_INDEPENDENTLY_VERIFIED')C.fail('PROBE_PREREQUISITE_NOT_ACCEPTED');
 if(process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY||process.env.NODE_OPTIONS)C.fail('UNSAFE_BUILD_OR_NODE_ENVIRONMENT');
 return {status:'FORMAL_0003_BASELINES_VERIFIED',refactor:K.REFACTOR,compat:K.COMPAT,probePrerequisite:true};
}
module.exports={check};if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat']);C.required(o,'refactor','compat');U.verifyPackage();console.log(JSON.stringify(check(o.refactor,o.compat)));});
