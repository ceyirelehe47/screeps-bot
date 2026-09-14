'use strict';
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),X=require('./source.cjs');
function payload(rel){const p=path.join(U.ROOT,'source/implementation',rel),b=fs.readFileSync(p);const x=X.IMPL.implementation[rel];
 const n=Buffer.from(b.toString('utf8').replace(/\r\n/g,'\n'));if(n.length!==x.bytes||C.sha256(n)!==x.sha256||C.blob(n)!==x.blob)C.fail('PACKAGE_IMPLEMENTATION_BYTES_CHANGED',{path:rel});return n;}
function stagedBytes(repo,rel){try{return U.git(repo,['show',':'+rel],true);}catch{C.fail('STAGED_IMPLEMENTATION_MISSING',{path:rel});}}
function apply(repo,out){
 U.verifyPackage();U.outside(out,repo);if(fs.existsSync(out))C.fail('OUTPUT_ALREADY_EXISTS');
 const current=U.textGit(repo,['rev-parse','HEAD']);
 if(current!==K.COMPAT){const v=X.verifyHead(repo);const r={status:'HOTPATH_XI_SOURCE_ALREADY_APPLIED',...v,resumed:true};C.durable(out,r);return r;}
 X.verifyBaseline(repo);if(U.remoteHead(repo,'compat/treasury-read-bridge-i')!==K.COMPAT)C.fail('REMOTE_BASELINE_CHANGED');
 for(const rel of X.IMPL.paths){const dest=path.join(repo,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,payload(rel));}
 const wt=U.textGit(repo,['status','--porcelain=v1','--untracked-files=all']);if(!wt)C.fail('IMPLEMENTATION_WRITE_EMPTY');
 U.git(repo,['diff','--check']);U.git(repo,['add','--',...X.IMPL.paths]);
 const staged=U.textGit(repo,['diff','--cached','--name-only']).split('\n').filter(Boolean).sort();
 if(JSON.stringify(staged)!==JSON.stringify([...X.IMPL.paths].sort()))C.fail('IMPLEMENTATION_STAGED_SCOPE_INVALID');
 for(const rel of staged){const a=stagedBytes(repo,rel),b=payload(rel);if(!a.equals(b))C.fail('IMPLEMENTATION_STAGED_BYTES_CHANGED',{path:rel});}
 U.git(repo,['diff','--cached','--check']);U.git(repo,['commit','-m',X.IMPL.commitMessage]);U.clean(repo);
 const v=X.verifyHead(repo),r={status:'HOTPATH_XI_SOURCE_APPLIED',...v,resumed:false,implementationFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'references/implementation-lock.json'))),atMs:Date.now()};
 C.durable(out,r);return r;
}
module.exports={apply,payload};
if(require.main===module)U.cli(async()=>{const o=U.options(['compat','out']);C.required(o,'compat','out');console.log(JSON.stringify(apply(path.resolve(o.compat),path.resolve(o.out))));});
