'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),X=require('./source.cjs');
function check(refactor,compat){
 if(Number(process.versions.node.split('.')[0])!==22)C.fail('NODE22_REQUIRED');
 U.exactHead(refactor,K.REFACTOR,'refactor/empire-treasury-rearchitecture');const source=X.verifyBaseline(compat);
 if(U.remoteHead(refactor,'refactor/empire-treasury-rearchitecture')!==K.REFACTOR||U.remoteHead(compat,'compat/treasury-read-bridge-i')!==K.COMPAT)C.fail('REMOTE_BASELINE_CHANGED');
 C.loadGuard(compat);const prerequisites=require('./prerequisites.cjs').checkPrerequisites(refactor);
 if(process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.CPU_DIAG_FIXTURE_ROOT)C.fail('UNSAFE_BUILD_OR_NODE_ENVIRONMENT');
 return {status:'HOTPATH_XI_BASELINES_VERIFIED',refactor:K.REFACTOR,compat:K.COMPAT,compatTree:source.tree,diagnosticReportsExpected:K.COUNT,priorCompleteSamples:1,prerequisites};
}
module.exports={check};
if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat']);C.required(o,'refactor','compat');U.verifyPackage();console.log(JSON.stringify(check(o.refactor,o.compat)));});
