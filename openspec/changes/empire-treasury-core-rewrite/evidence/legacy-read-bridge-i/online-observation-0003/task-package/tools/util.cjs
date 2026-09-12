'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
const ROOT=path.resolve(__dirname,'..');
function git(repo,args,buffer=false){try{return cp.execFileSync('git',['-C',repo,...args],{encoding:buffer?undefined:'utf8',maxBuffer:32*1048576,timeout:30000,stdio:['ignore','pipe','pipe']});}catch{C.fail('GIT_OPERATION_FAILED');}}
const textGit=(repo,args)=>git(repo,args).trim();
function clean(repo){if(textGit(repo,['status','--porcelain']))C.fail('WORKTREE_NOT_CLEAN');}
function exactHead(repo,head,branch){clean(repo);if(textGit(repo,['rev-parse','HEAD'])!==head||textGit(repo,['branch','--show-current'])!==branch)C.fail('BASELINE_HEAD_OR_BRANCH_CHANGED');}
function remoteHead(repo,branch){const l=textGit(repo,['ls-remote','--exit-code','origin','refs/heads/'+branch]).split(/\s+/);return l[0];}
function outside(p,repo){const a=path.resolve(p),b=path.resolve(repo);if(a===b||a.startsWith(b+path.sep))C.fail('WORK_MUST_BE_OUTSIDE_REPOSITORY');return a;}
function verifyPackage(){const m=C.readJson(path.join(ROOT,'INTEGRITY.json'));const files=[];
 function walk(p){for(const n of fs.readdirSync(p).sort()){const a=path.join(p,n),st=fs.lstatSync(a);if(st.isSymbolicLink())C.fail('PACKAGE_SYMLINK');if(st.isDirectory())walk(a);else files.push(path.relative(ROOT,a).split(path.sep).join('/'));}}walk(ROOT);
 const payload=files.filter(x=>x!=='INTEGRITY.json').sort();if(JSON.stringify(payload)!==JSON.stringify(Object.keys(m.files).sort()))C.fail('PACKAGE_FILE_SET_MISMATCH');
 for(const name of payload){const b=fs.readFileSync(path.join(ROOT,name));if(C.sha256(b)!==m.files[name].sha256||b.length!==m.files[name].bytes)C.fail('PACKAGE_BYTES_CHANGED');}
 return {status:'PACKAGE_INTEGRITY_VERIFIED',files:payload.length};
}
async function cli(fn){try{await fn();}catch(e){process.stderr.write(JSON.stringify({error:/^[A-Z0-9_]{1,96}$/.test(e?.code||'')?e.code:'UNEXPECTED_LOCAL_FAILURE'})+'\n');process.exitCode=1;}}
function options(names,flags=[]){return C.options(process.argv.slice(2),names,flags);}
function newDir(p){fs.mkdirSync(p,{recursive:false,mode:0o700});}
module.exports={ROOT,git,textGit,clean,exactHead,remoteHead,outside,verifyPackage,cli,options,newDir};
