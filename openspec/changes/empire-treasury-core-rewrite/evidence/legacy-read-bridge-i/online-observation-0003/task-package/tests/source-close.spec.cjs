'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('./fixture.cjs'),U=require('../tools/util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),{closeSource}=require('../tools/close-source.cjs');
test('real Git profile close adds one linear OFF commit and restores the exact original tree',()=>{
 const root=F.runDir(),repo=path.join(root,'repo'),run=path.join(root,'run');fs.mkdirSync(repo);fs.mkdirSync(run);const oldBase=K.COMPAT;
 try{U.git(repo,['init','-q']);U.git(repo,['config','user.email','fixture@example.invalid']);U.git(repo,['config','user.name','Fixture']);U.git(repo,['config','core.autocrlf','false']);U.git(repo,['checkout','-b','compat/treasury-read-bridge-i']);
  fs.mkdirSync(path.dirname(path.join(repo,K.CONFIG)),{recursive:true});fs.writeFileSync(path.join(repo,K.CONFIG),'default OFF\n');U.git(repo,['add','.']);U.git(repo,['commit','-qm','base']);K.COMPAT=U.textGit(repo,['rev-parse','HEAD']);
  fs.writeFileSync(path.join(repo,K.CONFIG),K.renderConfig(K.profileFor(1000)));U.git(repo,['add','.']);U.git(repo,['commit','-qm','profile']);const profileHead=U.textGit(repo,['rev-parse','HEAD']);C.writeNew(path.join(run,'binding.json'),{profileHead});
  const r=closeSource(repo,run);assert.equal(r.sameTreeAsCompatBase,true);assert.equal(U.textGit(repo,['rev-parse','HEAD^']),profileHead);assert.equal(fs.readFileSync(path.join(repo,K.CONFIG),'utf8'),'default OFF\n');assert.deepEqual(closeSource(repo,run),r);
 }finally{K.COMPAT=oldBase;fs.rmSync(root,{recursive:true,force:true});}
});
test('a failed profile commit repairs only the recognized task-owned config and index path',()=>{
 const root=F.runDir(),repo=path.join(root,'repo'),run=path.join(root,'run');fs.mkdirSync(repo);fs.mkdirSync(run);const oldBase=K.COMPAT;
 try{U.git(repo,['init','-q']);U.git(repo,['config','user.email','fixture@example.invalid']);U.git(repo,['config','user.name','Fixture']);U.git(repo,['config','core.autocrlf','false']);U.git(repo,['checkout','-b','compat/treasury-read-bridge-i']);
  fs.mkdirSync(path.dirname(path.join(repo,K.CONFIG)),{recursive:true});fs.writeFileSync(path.join(repo,K.CONFIG),'default OFF\n');U.git(repo,['add','.']);U.git(repo,['commit','-qm','base']);K.COMPAT=U.textGit(repo,['rev-parse','HEAD']);
  const profile=K.profileFor(1000);C.writeNew(path.join(run,'binding-intent.json'),{profile});fs.writeFileSync(path.join(repo,K.CONFIG),K.renderConfig(profile));U.git(repo,['add','--',K.CONFIG]);
  const r=closeSource(repo,run);assert.equal(r.closedHead,K.COMPAT);assert.equal(U.textGit(repo,['status','--porcelain']),'');assert.equal(fs.readFileSync(path.join(repo,K.CONFIG),'utf8'),'default OFF\n');
 }finally{K.COMPAT=oldBase;fs.rmSync(root,{recursive:true,force:true});}
});
