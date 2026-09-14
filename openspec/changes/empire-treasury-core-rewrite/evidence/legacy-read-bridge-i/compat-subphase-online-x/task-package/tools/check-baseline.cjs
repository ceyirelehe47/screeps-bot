'use strict';
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),R=require('./remediate.cjs');
const BASE=require('../references/base-source-lock.json');
function verifyBaseFrozen(repo,skip=[]){const ignored=new Set(skip);for(const[n,x]of Object.entries(BASE)){if(ignored.has(n))continue;const b=fs.readFileSync(path.join(repo,n));if(C.blob(b)!==x.blob||C.sha256(b)!==x.sha256)C.fail('BASE_SOURCE_CHANGED',{path:n});}return true;}
function verifySourceFrozen(repo){const lock=require('../references/source-lock.json');for(const[n,x]of Object.entries(lock)){const b=fs.readFileSync(path.join(repo,n));if(C.blob(b)!==x.blob||C.sha256(b)!==x.sha256)C.fail('SOURCE_LOCK_CHANGED',{path:n});}return true;}
function check(refactor,compat){
 if(Number(process.versions.node.split('.')[0])!==22)C.fail('NODE22_REQUIRED');
 U.exactHead(refactor,K.REFACTOR,'refactor/empire-treasury-rearchitecture');const start=R.inspectStart(compat);
 if(U.remoteHead(refactor,'refactor/empire-treasury-rearchitecture')!==K.REFACTOR||U.remoteHead(compat,'compat/treasury-read-bridge-i')!==K.COMPAT)C.fail('REMOTE_BASELINE_CHANGED');
 C.loadGuard(compat);if(start.mode==='root')verifyBaseFrozen(compat);else if(start.mode==='partial')verifyBaseFrozen(compat,R.partialPaths);else verifySourceFrozen(compat);R.verifyPayload();
 const prerequisites=require('./prerequisites.cjs').checkPrerequisites(refactor);
 if(process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.CPU_DIAG_FIXTURE_ROOT)C.fail('UNSAFE_BUILD_OR_NODE_ENVIRONMENT');
 return {status:'SUBPHASE_X_BASELINES_VERIFIED',refactor:K.REFACTOR,compatRoot:K.COMPAT,compatLocalHead:start.head,compatStartMode:start.mode,diagnosticReportsExpected:K.COUNT,manifestRemediationRequired:start.mode!=='complete',prerequisites};
}
module.exports={check,verifyBaseFrozen,verifySourceFrozen};
if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat']);C.required(o,'refactor','compat');U.verifyPackage();console.log(JSON.stringify(check(o.refactor,o.compat)));});
