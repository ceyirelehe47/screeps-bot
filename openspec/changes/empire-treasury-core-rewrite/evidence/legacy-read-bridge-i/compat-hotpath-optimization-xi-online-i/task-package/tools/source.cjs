'use strict';
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
const BASE_LOCK=require('../references/source-baseline-lock.json');
const LOCK=require('../references/source-lock.json');
const IMPL=require('../references/implementation-lock.json');
const SOURCE_BASE_TREE='c30d5beeb9c8e17b2a152047521f72691c214fd3';
function verifyFiles(repo,lock,code='SOURCE_LOCK_CHANGED'){
 for(const [name,x] of Object.entries(lock)){
  let b;try{b=fs.readFileSync(path.join(repo,name));}catch{C.fail(code,{path:name});}
  b=Buffer.from(b.toString('utf8').replace(/\r\n/g,'\n'));
  if(b.length!==x.bytes||C.blob(b)!==x.blob||C.sha256(b)!==x.sha256)C.fail(code,{path:name});
 }
 return true;
}
function branch(repo){if(U.textGit(repo,['branch','--show-current'])!=='compat/treasury-read-bridge-i')C.fail('COMPAT_BRANCH_CHANGED');}
function verifyBaseline(repo){
 U.exactHead(repo,K.COMPAT,'compat/treasury-read-bridge-i');
 const tree=U.textGit(repo,['rev-parse','HEAD^{tree}']);if(tree!==SOURCE_BASE_TREE)C.fail('SOURCE_BASE_TREE_CHANGED');
 verifyFiles(repo,BASE_LOCK,'SOURCE_BASELINE_CHANGED');
 for(const name of IMPL.newPaths)if(fs.existsSync(path.join(repo,name)))C.fail('IMPLEMENTATION_PATH_ALREADY_EXISTS',{path:name});
 return {status:'HOTPATH_XI_BASE_SOURCE_VERIFIED',head:K.COMPAT,tree,files:Object.keys(BASE_LOCK).length};
}
function verifyHead(repo){
 U.clean(repo);branch(repo);const head=U.textGit(repo,['rev-parse','HEAD']);
 if(head===K.COMPAT)C.fail('HOTPATH_XI_SOURCE_NOT_APPLIED');
 if(U.textGit(repo,['rev-parse','HEAD^'])!==K.COMPAT)C.fail('HOTPATH_XI_SOURCE_PARENT_INVALID');
 const names=U.textGit(repo,['diff','--name-only',K.COMPAT,head]).split('\n').filter(Boolean).sort();
 if(JSON.stringify(names)!==JSON.stringify([...IMPL.paths].sort()))C.fail('HOTPATH_XI_SOURCE_SCOPE_INVALID');
 if(U.textGit(repo,['show','-s','--format=%s',head])!==IMPL.commitMessage)C.fail('HOTPATH_XI_SOURCE_MESSAGE_INVALID');
 verifyFiles(repo,LOCK,'HOTPATH_XI_SOURCE_BYTES_CHANGED');
 const tree=U.textGit(repo,['rev-parse','HEAD^{tree}']);
 return {status:'HOTPATH_XI_SOURCE_VERIFIED',head,tree,base:K.COMPAT,files:Object.keys(LOCK).length,changedPaths:IMPL.paths.length};
}
module.exports={BASE_LOCK,LOCK,IMPL,SOURCE_BASE_TREE,verifyFiles,verifyBaseline,verifyHead};
