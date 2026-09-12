'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const REF='0b09414f90c7144bbff61758fe7cf605576231e7',COMPAT='3292e152b0db465263e4f1fa5c9eac068394acef';
const BRANCH='compat/treasury-read-bridge-i',REFBRANCH='refactor/empire-treasury-rearchitecture';
const TARGET='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-reader-cpu-attribution-i-v2';
function fail(code,detail){const e=new Error(code);e.code=code;if(detail!==undefined)e.detail=detail;throw e;}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');
function files(root,prefix=''){const out=[];for(const e of fs.readdirSync(path.join(root,prefix),{withFileTypes:true})){const n=prefix?prefix+'/'+e.name:e.name;if(e.isSymbolicLink())fail('SYMLINK_FORBIDDEN',n);if(e.isDirectory())out.push(...files(root,n));else if(e.isFile())out.push(n);else fail('SPECIAL_FILE_FORBIDDEN',n);}return out.sort();}
function read(p){return JSON.parse(fs.readFileSync(p,'utf8'));}
function put(p,v){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});}
function git(repo,args){const r=spawnSync('git',['-C',path.resolve(repo),...args],{encoding:null,maxBuffer:32*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});if(r.status!==0)fail('GIT_COMMAND_FAILED',{command:args[0],status:r.status});return r.stdout;}
const gt=(repo,args)=>git(repo,args).toString('utf8').trim();
function clean(repo){if(gt(repo,['status','--porcelain','--untracked-files=all']))fail('WORKTREE_NOT_CLEAN');}
function branches(compat,refactor){for(const [repo,branch,head]of [[compat,BRANCH,COMPAT],[refactor,REFBRANCH,REF]]){clean(repo);if(gt(repo,['branch','--show-current'])!==branch||gt(repo,['rev-parse','HEAD'])!==head)fail('BASELINE_MISMATCH');if(gt(repo,['rev-parse','refs/remotes/origin/'+branch])!==head)fail('REMOTE_TRACKING_BASELINE_MISMATCH');}return {compat:COMPAT,refactor:REF,remoteCheck:'local tracking refs only; fetch is a separate Agent step'};}
function integrity(root=ROOT){const m=read(path.join(root,'INTEGRITY.json'));const expected=Object.keys(m.files).sort(),actual=files(root).filter(x=>x!=='INTEGRITY.json');if(JSON.stringify(expected)!==JSON.stringify(actual))fail('PACKAGE_FILE_SET_MISMATCH');for(const n of expected){const b=fs.readFileSync(path.join(root,n));if(b.length!==m.files[n].bytes||sha(b)!==m.files[n].sha256)fail('PACKAGE_BYTES_MISMATCH',n);}return {status:'PACKAGE_INTEGRITY_VERIFIED',files:expected.length};}
function sourcePlan(){const m=read(path.join(ROOT,'references/source-lock.json'));const result=[];for(const e of m.changes){const b=fs.readFileSync(path.join(ROOT,'implementation',e.path));if(sha(b)!==e.newSha256)fail('IMPLEMENTATION_BYTES_MISMATCH');result.push({...e,bytes:b});}return result;}
function assertInside(root,n){if(path.isAbsolute(n)||n.split('/').some(x=>x==='..'||x==='.'||!x))fail('PATH_INVALID');const target=path.join(root,n);let p=root;for(const seg of n.split('/')){p=path.join(p,seg);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())fail('SYMLINK_FORBIDDEN');}return target;}
function safeEnv(){const e={...process.env};for(const k of ['DEST','DEPLOY_ALLOW_DIRTY','SCREEPS_TOKEN','NODE_OPTIONS'])delete e[k];return e;}
module.exports={fs,path,spawnSync,ROOT,REF,COMPAT,BRANCH,REFBRANCH,TARGET,fail,sha,blob,files,read,put,git,gt,clean,branches,integrity,sourcePlan,assertInside,safeEnv};
