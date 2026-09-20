'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
const Q=require('./source-contract.cjs');
const {SOURCE_PARENT,SOURCE_MESSAGE,PATHS}=Q;
function verifyPinned(repo){
 if(K.COMPAT!==Q.SOURCE_HEAD||K.SOURCE_TREE!==Q.SOURCE_TREE)C.fail('ENVELOPE_XII_RETRY_SOURCE_POLICY_CHANGED');
 try{return Q.verifyPinned(repo);}catch(e){C.fail(e.code||'ENVELOPE_XII_RETRY_SOURCE_CHECK_FAILED',e.details);}
}
function verifyHead(repo){
 U.exactHead(repo,K.COMPAT,'compat/treasury-read-bridge-i');const v=verifyPinned(repo);
 // Lazy import permits a read-only object-only provenance check, while the real
 // baseline/application/build entry points still check all 47 frozen sources.
 require('../runtime/check-profile.cjs').verifyFrozen(repo);
 return {...v,status:'ENVELOPE_XII_RETRY_SOURCE_VERIFIED'};
}
module.exports={SOURCE_PARENT,SOURCE_MESSAGE,PATHS,verifyPinned,verifyHead,verifyBaseline:verifyHead};
