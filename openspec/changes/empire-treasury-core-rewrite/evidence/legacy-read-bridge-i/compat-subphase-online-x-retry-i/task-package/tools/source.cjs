'use strict';
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
const LOCK=require('../references/source-lock.json');
const SOURCE_TREE='c30d5beeb9c8e17b2a152047521f72691c214fd3';
function verifyFrozen(repo){
 for(const [name,x] of Object.entries(LOCK)){
  let b;try{b=fs.readFileSync(path.join(repo,name));}catch{C.fail('SOURCE_LOCK_MISSING',{path:name});}
  if(b.length!==x.bytes||C.blob(b)!==x.blob||C.sha256(b)!==x.sha256)C.fail('SOURCE_LOCK_CHANGED',{path:name});
 }
 return true;
}
function verifyHead(repo){
 U.exactHead(repo,K.COMPAT,'compat/treasury-read-bridge-i');
 const tree=U.textGit(repo,['rev-parse','HEAD^{tree}']);if(tree!==SOURCE_TREE)C.fail('SOURCE_TREE_CHANGED');
 verifyFrozen(repo);return {status:'SUBPHASE_X_RETRY_SOURCE_VERIFIED',head:K.COMPAT,tree,files:Object.keys(LOCK).length};
}
module.exports={LOCK,SOURCE_TREE,verifyFrozen,verifyHead};
