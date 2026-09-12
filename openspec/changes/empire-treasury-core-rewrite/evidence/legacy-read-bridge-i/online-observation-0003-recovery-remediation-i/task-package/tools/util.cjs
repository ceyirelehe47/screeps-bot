'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const C=require('../runtime/common.cjs'),K=require('../runtime/pins.cjs');
const ROOT=path.resolve(__dirname,'..');
function gitBytes(repo,args){try{return cp.execFileSync('git',['-C',repo,...args],{timeout:15000,maxBuffer:32*1048576,stdio:['ignore','pipe','pipe']});}catch{C.fail('GIT_READ_FAILED');}}
const git=(repo,args)=>gitBytes(repo,args).toString('utf8').trim();
function verifyPackage(root=ROOT){
 const m=C.json(path.join(root,'INTEGRITY.json'));const expected=Object.keys(m.files).sort();
 const actual=C.list(root).filter(n=>n!=='INTEGRITY.json').sort();if(!C.same(actual,expected))C.fail('PACKAGE_FILE_SET_MISMATCH');
 for(const n of expected){const b=C.bytes(path.join(root,n));if(b.length!==m.files[n].bytes||C.sha256(b)!==m.files[n].sha256)C.fail('PACKAGE_BYTES_CHANGED');}
 return {status:'PACKAGE_INTEGRITY_VERIFIED',files:expected.length,exactFileSet:true};
}
function heads(repo,compat){
 for(const [r,branch,sha]of[[repo,'refactor/empire-treasury-rearchitecture',K.refactor],[compat,'compat/treasury-read-bridge-i',K.compat]]){
  if(git(r,['rev-parse','HEAD'])!==sha||git(r,['branch','--show-current'])!==branch||git(r,['rev-parse','refs/remotes/origin/'+branch])!==sha)C.fail('BASELINE_HEAD_MISMATCH');
  if(git(r,['status','--porcelain']))C.fail('WORKTREE_NOT_CLEAN');
 }
 if(git(compat,['rev-parse','HEAD^{tree}'])!==K.compatTree)C.fail('COMPAT_OFF_TREE_MISMATCH');
 return {status:'RECOVERY_0003_BASELINE_VERIFIED',refactor:K.refactor,compat:K.compat};
}
function parseTree(b){return b.toString('utf8').split('\0').filter(Boolean).map(x=>{const m=x.match(/^100644 blob ([a-f0-9]{40})\t([A-Za-z0-9_.-]+)$/);if(!m)C.fail('SOURCE_TREE_INVALID');return {blob:m[1],name:m[2]};});}
function materialize(repo,out,policy=K){
 if(git(repo,['rev-parse',policy.refactor+':'+policy.sourceRoot+'/run'])!==policy.runTree)C.fail('SOURCE_TREE_MISMATCH');
 const entries=parseTree(gitBytes(repo,['ls-tree','-rz',policy.refactor+':'+policy.sourceRoot+'/run']));
 if(entries.length!==29)C.fail('SOURCE_FILE_COUNT_MISMATCH');
 const anchor={'public-session.json':policy.publicBlob,'console.jsonl':policy.consoleBlob,'upload-attempt.json':policy.uploadAttemptBlob,'upload-result.json':policy.uploadResultBlob};
 for(const [n,h]of Object.entries(anchor))if(entries.find(x=>x.name===n)?.blob!==h)C.fail('SOURCE_ANCHOR_MISMATCH');
 const files=entries.map(e=>{const b=gitBytes(repo,['cat-file','blob',e.blob]);if(C.blob(b)!==e.blob)C.fail('SOURCE_BLOB_MISMATCH');return {...e,bytes:b.length,sha256:C.sha256(b),body:b};});
 C.mkdirNew(out);try{fs.mkdirSync(path.join(out,'run'));for(const f of files)fs.writeFileSync(path.join(out,'run',f.name),f.body,{flag:'wx',mode:0o600});
  C.durable(path.join(out,'MANIFEST.json'),{status:'SOURCE_0003_MATERIALIZED',sourceCommit:policy.refactor,runTree:policy.runTree,
   files:files.map(({body,...f})=>f)});
 }catch(e){throw e;} // Do not silently remove a partially materialized forensic directory.
 return verifySource(out,policy);
}
function treeHash(files){const body=Buffer.concat([...files].sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name))).map(f=>Buffer.concat([Buffer.from('100644 '+f.name+'\0'),Buffer.from(f.blob,'hex')])));return crypto.createHash('sha1').update(Buffer.from('tree '+body.length+'\0')).update(body).digest('hex');}
function verifySource(source,policy=K){
 const m=C.json(path.join(source,'MANIFEST.json'));
 if(m.sourceCommit!==policy.refactor||m.runTree!==policy.runTree||m.files.length!==29)C.fail('SOURCE_MANIFEST_MISMATCH');
 if(!C.same(C.list(source).sort(),['MANIFEST.json',...m.files.map(f=>'run/'+f.name)].sort()))C.fail('SOURCE_FILE_SET_CHANGED');
 const names=new Set();
 for(const f of m.files){if(!/^[A-Za-z0-9_.-]+$/.test(f.name)||names.has(f.name))C.fail('SOURCE_MANIFEST_INVALID');names.add(f.name);
  const b=C.bytes(path.join(source,'run',f.name));if(b.length!==f.bytes||C.sha256(b)!==f.sha256||C.blob(b)!==f.blob)C.fail('SOURCE_BYTES_CHANGED');}
 if(treeHash(m.files)!==policy.runTree)C.fail('SOURCE_MANIFEST_TREE_MISMATCH');
 const pins={'public-session.json':policy.publicBlob,'console.jsonl':policy.consoleBlob,'upload-attempt.json':policy.uploadAttemptBlob,'upload-result.json':policy.uploadResultBlob};
 for(const [name,blob]of Object.entries(pins))if(m.files.find(x=>x.name===name)?.blob!==blob)C.fail('SOURCE_ANCHOR_MISMATCH');
 return {status:'SOURCE_0003_BYTES_VERIFIED',files:m.files.length,sourceCommit:m.sourceCommit,runTree:m.runTree};
}
module.exports={ROOT,gitBytes,git,verifyPackage,heads,materialize,verifySource,parseTree,treeHash};
