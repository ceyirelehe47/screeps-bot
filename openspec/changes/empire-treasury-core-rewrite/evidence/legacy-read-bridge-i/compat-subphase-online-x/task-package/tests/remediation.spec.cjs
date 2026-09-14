'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const U=require('../tools/util.cjs'),R=require('../tools/remediate.cjs'),Pub=require('../tools/publish.cjs'),K=require('../runtime/policy.cjs');
const ROOT=path.resolve(__dirname,'..');
function copy(src,dst){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);}
function git(repo,args){return U.textGit(repo,args);}
function setup(mode){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'subx-rem-v2-')),repo=path.join(root,'compat'),bare=path.join(root,'remote.git');fs.mkdirSync(repo);
 U.git(repo,['init']);U.git(repo,['config','user.email','fixture@example.invalid']);U.git(repo,['config','user.name','fixture']);U.git(repo,['branch','-M',R.LOCK.compatBranch]);
 for(const row of R.LOCK.changes){if(!row.old)continue;copy(path.join(ROOT,'references/subphase-IX',row.path),path.join(repo,row.path));}copy(path.join(ROOT,'references/treasuryCompatConfig.ts'),path.join(repo,K.CONFIG));
 U.git(repo,['add','.']);U.git(repo,['commit','-m','root']);const base=git(repo,['rev-parse','HEAD']);
 U.git(root,['init','--bare',bare]);U.git(repo,['remote','add','origin',bare]);U.git(repo,['push','-u','origin','HEAD']);
 let partial=null;
 if(mode==='partial'){
  for(const rel of R.partialPaths)copy(path.join(ROOT,'remediation/implementation',rel),path.join(repo,rel));
  U.git(repo,['add','--',...R.partialPaths]);U.git(repo,['commit','-m',R.LOCK.commitMessage]);partial=git(repo,['rev-parse','HEAD']);
 }
 return{root,repo,base,partial,out:path.join(root,'out')};
}
function withGeneratorStub(fn){const old=cp.spawnSync;cp.spawnSync=function(cmd,args,opts){if(cmd===process.execPath&&String(args?.[0]||'').endsWith('scripts/build-treasury-compat-loader.cjs')&&args?.[1]==='--check')return{status:0,signal:null,error:null,stdout:'{"status":"COMPAT_LOADER_REGENERATION_VERIFIED"}\n',stderr:''};return old.apply(this,arguments);};try{return fn();}finally{cp.spawnSync=old;}}
function withCompatBase(base,fn){const old=K.COMPAT,oldLock=R.LOCK.compatBase;K.COMPAT=base;R.LOCK.compatBase=base;try{return fn();}finally{K.COMPAT=old;R.LOCK.compatBase=oldLock;}}
test('remediation porcelain parser preserves a leading-space tracked status and an untracked path',()=>{const f=setup('root');try{fs.appendFileSync(path.join(f.repo,R.LOCK.changes[0].path),'x');fs.writeFileSync(path.join(f.repo,'untracked.txt'),'x');assert.deepEqual(R.statusPaths(f.repo),[R.LOCK.changes[0].path,'untracked.txt'].sort());}finally{fs.rmSync(f.root,{recursive:true,force:true});}});
test('fresh root creates one exact five-path remediation commit',()=>{const f=setup('root');try{withCompatBase(f.base,()=>withGeneratorStub(()=>{const r=R.execute(f.repo,f.out);assert.equal(r.mode,'fresh-full');assert.equal(r.remediationCommits.length,1);assert.deepEqual(r.paths,R.paths);assert.equal(git(f.repo,['rev-parse','HEAD^']),f.base);}));}finally{fs.rmSync(f.root,{recursive:true,force:true});}});
test('exact unpushed four-path partial commit is preserved and completed by one follow-up commit',()=>{const f=setup('partial');try{withCompatBase(f.base,()=>withGeneratorStub(()=>{const r=R.execute(f.repo,f.out);assert.equal(r.mode,'continued-exact-partial');assert.equal(r.continuedFromPartial,f.partial);assert.deepEqual(r.remediationCommits,[f.partial,r.head]);assert.equal(git(f.repo,['rev-parse',r.head+'^']),f.partial);assert.deepEqual(U.git(f.repo,['diff','--name-only','-z',f.partial,r.head],true).toString().split('\0').filter(Boolean),R.completionPaths);}));}finally{fs.rmSync(f.root,{recursive:true,force:true});}});

test('publish close-chain verification accepts exact partial plus completion plus ON and OFF',()=>{const f=setup('partial');try{withCompatBase(f.base,()=>withGeneratorStub(()=>{const r=R.execute(f.repo,f.out),source=r.head,original=fs.readFileSync(path.join(f.repo,K.CONFIG));fs.writeFileSync(path.join(f.repo,K.CONFIG),Buffer.from(original.toString('utf8').replace('enabled: false','enabled: true')));U.git(f.repo,['add','--',K.CONFIG]);U.git(f.repo,['commit','-m','on']);const on=git(f.repo,['rev-parse','HEAD']);fs.writeFileSync(path.join(f.repo,K.CONFIG),original);U.git(f.repo,['add','--',K.CONFIG]);U.git(f.repo,['commit','-m','off']);const off=git(f.repo,['rev-parse','HEAD']);assert.equal(Pub.sourceClosed(f.repo,{sourceHead:source,compatClosedHead:off}),off);assert.equal(git(f.repo,['rev-parse',on+'^']),source);}));}finally{fs.rmSync(f.root,{recursive:true,force:true});}});
test('unknown local commit is not adopted as a partial remediation',()=>{const f=setup('root');try{fs.writeFileSync(path.join(f.repo,'other.txt'),'x');U.git(f.repo,['add','other.txt']);U.git(f.repo,['commit','-m','other']);withCompatBase(f.base,()=>assert.throws(()=>R.inspectStart(f.repo)));}finally{fs.rmSync(f.root,{recursive:true,force:true});}});
