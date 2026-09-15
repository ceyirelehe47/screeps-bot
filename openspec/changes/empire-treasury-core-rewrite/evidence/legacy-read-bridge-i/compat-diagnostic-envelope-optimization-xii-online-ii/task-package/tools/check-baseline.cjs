'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),X=require('./source.cjs'),F=require('../runtime/check-profile.cjs'),M=require('../MATERIALIZATION.json'),{selectLocalSource}=require('./source-state.cjs');
function check(refactor,compat){
 if(Number(process.versions.node.split('.')[0])!==22)C.fail('NODE22_REQUIRED');
 U.exactHead(refactor,K.REFACTOR,'refactor/empire-treasury-rearchitecture');U.clean(compat);
 if(U.textGit(compat,['branch','--show-current'])!=='compat/treasury-read-bridge-i')C.fail('COMPAT_BRANCH_CHANGED');
 const current=U.textGit(compat,['rev-parse','HEAD']),currentTree=U.textGit(compat,['rev-parse','HEAD^{tree}']),selected=selectLocalSource({current,base:K.COMPAT,currentTree,expectedTree:M.expectedSourceTree,supersededTree:M.supersededSourceTree,verifyBaseline:()=>X.verifyBaseline(compat),verifyHead:()=>X.verifyHead(compat),verifySuperseded:()=>X.verifySupersededHead(compat)});
 if(selected.localState==='base')F.verifyBaselineFrozen(compat);else if(selected.localState==='superseded-applied')F.verifySupersededFrozen(compat);else F.verifyFrozen(compat);
 if(U.remoteHead(refactor,'refactor/empire-treasury-rearchitecture')!==K.REFACTOR||U.remoteHead(compat,'compat/treasury-read-bridge-i')!==K.COMPAT)C.fail('REMOTE_BASELINE_CHANGED');
 C.loadGuard(compat);const prerequisites=require('./prerequisites.cjs').checkPrerequisites(refactor);
 if(process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.CPU_DIAG_FIXTURE_ROOT)C.fail('UNSAFE_BUILD_OR_NODE_ENVIRONMENT');
 return {status:'ENVELOPE_XII_BASELINES_VERIFIED',refactor:K.REFACTOR,compatRoot:K.COMPAT,compatLocalHead:selected.source.head,compatLocalTree:selected.source.tree,compatLocalState:selected.localState,migrationRequired:selected.localState==='superseded-applied',diagnosticReportsExpected:K.COUNT,priorCompleteSamples:2,prerequisites};
}
module.exports={check,selectLocalSource};if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat']);C.required(o,'refactor','compat');U.verifyPackage();console.log(JSON.stringify(check(o.refactor,o.compat)));});
