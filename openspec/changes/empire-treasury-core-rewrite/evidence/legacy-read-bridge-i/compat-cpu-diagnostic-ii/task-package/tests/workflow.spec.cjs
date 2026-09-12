'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const F=require('./fixture.cjs'),U=require('../tools/util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
const A=require('../tools/archive.cjs'),Pub=require('../tools/publish.cjs'),{closeSource}=require('../tools/close-source.cjs');
function init(dir,branch){fs.mkdirSync(dir);cp.execFileSync('git',['-c','core.autocrlf=false','init','-b',branch,dir],{stdio:'pipe'});
 const cfg=(k,v)=>U.git(dir,['config','--local',k,v]);cfg('user.name','fixture');cfg('user.email','fixture@example.invalid');cfg('commit.gpgSign','false');
 fs.mkdirSync(path.join(dir,'.git','empty-hooks'));cfg('core.hooksPath',path.join(dir,'.git','empty-hooks'));
 fs.writeFileSync(path.join(dir,'seed.txt'),'fixture, not the real repository\n');
 U.git(dir,['add','.']);U.git(dir,['commit','-m','fixture base']);return U.textGit(dir,['rev-parse','HEAD']);}
function make(){const root=F.tmp(),ref=path.join(root,'refactor'),compat=path.join(root,'compat'),run=path.join(root,'run'),tests=path.join(root,'tests'),offline=path.join(root,'offline');
 init(ref,'refactor/empire-treasury-rearchitecture');init(compat,'compat/treasury-read-bridge-i');
 const parent=path.dirname(path.join(ref,K.EVIDENCE));fs.mkdirSync(parent,{recursive:true});fs.writeFileSync(path.join(parent,'fixture-marker'),'not production evidence\n');U.git(ref,['add','.']);U.git(ref,['commit','-m','fixture evidence parent']);
 fs.mkdirSync(path.join(compat,'src/runtime'),{recursive:true});fs.copyFileSync(path.join(U.ROOT,'references/treasuryCompatConfig.ts'),path.join(compat,K.CONFIG));U.git(compat,['add','.']);U.git(compat,['commit','-m','fixture config']);
 const saved={refactor:K.REFACTOR,compat:K.COMPAT,load:C.loadSecret};K.REFACTOR=U.textGit(ref,['rev-parse','HEAD']);K.COMPAT=U.textGit(compat,['rev-parse','HEAD']);const secret={token:require('node:crypto').randomBytes(24).toString('hex')};C.loadSecret=()=>secret;
 for(const d of [run,tests,offline])fs.mkdirSync(d);
 for(const n of ['summary.json','tests.tap','tests.stderr','tests.exit.json'])fs.writeFileSync(path.join(tests,n),n.endsWith('.json')?'{}\n':'fixture test evidence \n');
 for(const n of A.CHECK_ALLOW)fs.writeFileSync(path.join(offline,n),n.endsWith('.json')?'{}\n':'fixture CLI output with whitespace \n');
 return {root,ref,compat,run,tests,offline,secret,cleanup:()=>{K.REFACTOR=saved.refactor;K.COMPAT=saved.compat;C.loadSecret=saved.load;}};
}
function archived(f){return A.archive({refactor:f.ref,run:f.run,tests:f.tests,offline:f.offline,secret:'fixture-only'});}
test('package inventory and native whitespace gate both accept the SAME final package bytes',()=>{U.verifyPackage();const root=F.tmp(),dir=path.join(root,'git');init(dir,'check');fs.cpSync(U.ROOT,path.join(dir,'task-package'),{recursive:true});U.git(dir,['add','.']);U.git(dir,['diff','--cached','--check']);});
test('config ON/OFF closes to identical source tree without changing CPU files',()=>{const f=make();try{const p=K.profileFor(1000);C.durable(path.join(f.run,'binding-intent.json'),{profile:p});fs.writeFileSync(path.join(f.compat,K.CONFIG),K.renderConfig(p));U.git(f.compat,['add',K.CONFIG]);U.git(f.compat,['commit','-m','fixture ON']);
 const on=U.textGit(f.compat,['rev-parse','HEAD']);C.durable(path.join(f.run,'binding.json'),{profileHead:on});const r=closeSource(f.compat,f.run);assert.equal(r.sameTreeAsCompatBase,true);assert.equal(U.textGit(f.compat,['rev-parse','HEAD~2']),K.COMPAT);assert.equal(closeSource(f.compat,f.run).closedHead,r.closedHead);
 }finally{f.cleanup();}});
test('unrecognized config edits are refused without clearing worktree',()=>{const f=make();try{fs.appendFileSync(path.join(f.compat,K.CONFIG),'// user change\n');assert.throws(()=>closeSource(f.compat,f.run));assert.ok(U.textGit(f.compat,['status','--porcelain']).includes('M'));}finally{f.cleanup();}});
test('archive stage bytes whitespace commit and local bare push/readback all agree',()=>{const f=make();try{
 const cbase=K.COMPAT,rbase=K.REFACTOR;
 for(const[repo,name,branch]of[[f.ref,'refbare','refactor/empire-treasury-rearchitecture'],[f.compat,'compbare','compat/treasury-read-bridge-i']]){
  const bare=path.join(f.root,name);cp.execFileSync('git',['init','--bare',bare],{stdio:'pipe'});U.git(repo,['remote','add','origin',bare]);U.git(repo,['push','origin','HEAD:refs/heads/'+branch]);
 }
 C.durable(path.join(f.run,'source-closed.json'),{status:'SOURCE_DEFAULT_OFF_RESTORED',closedHead:cbase,profileHead:null,sameTreeAsCompatBase:true});
 archived(f);Pub.verifyArchive(f.ref);const gate=Pub.stageGate(f.ref,f.compat);assert.equal(gate.whitespaceExceptions,0);
 const result=Pub.publish(f.ref,f.compat,{push:true,out:path.join(f.root,'receipt.json')});assert.equal(result.pushed,true);assert.equal(result.compatHead,cbase);assert.equal(U.textGit(f.ref,['rev-parse','HEAD^']),rbase);
 const resume=Pub.publish(f.ref,f.compat,{push:true,out:path.join(f.root,'receipt-resume.json')});assert.equal(resume.refactorHead,result.refactorHead);
 }finally{f.cleanup();}});
test('raw CLI trailing spaces are preserved in JSON wrappers, not silently trimmed',()=>{const f=make();try{archived(f);const j=C.readJson(path.join(f.ref,K.EVIDENCE,'tool-tests/tests.tap.json'));assert.ok(j.text.endsWith(' \n'));assert.equal(j.sha256,C.sha256(Buffer.from(j.text)));Pub.stageGate(f.ref,f.compat);}finally{f.cleanup();}});
test('private modules and session files are never archived',()=>{const f=make();try{for(const n of ['backup.json','candidate.json','session.json'])fs.writeFileSync(path.join(f.run,n),'PRIVATE MODULE BODY');archived(f);for(const n of ['backup.json','candidate.json','session.json'])assert.ok(!fs.existsSync(path.join(f.ref,K.EVIDENCE,'run',n)));}finally{f.cleanup();}});
test('secret in permitted raw evidence refuses archive before touching repo',()=>{const f=make();try{fs.writeFileSync(path.join(f.run,'collector.stdout'),f.secret.token);assert.throws(()=>archived(f),e=>e.code==='SECRET_IN_ARCHIVE_INPUT');assert.ok(!fs.existsSync(path.join(f.ref,K.EVIDENCE)));}finally{f.cleanup();}});
test('staged evidence content mismatch is detected',()=>{const f=make();try{archived(f);U.git(f.ref,['add',K.EVIDENCE]);fs.appendFileSync(path.join(f.ref,K.EVIDENCE,'EXECUTION-REPORT.md'),'tampered\n');assert.throws(()=>Pub.verifyArchive(f.ref,{staged:true}));}finally{f.cleanup();}});
test('unrelated staged file is not swept into evidence commit',()=>{const f=make();try{archived(f);fs.writeFileSync(path.join(f.ref,'unexpected.txt'),'x\n');U.git(f.ref,['add','unexpected.txt']);assert.throws(()=>Pub.stageGate(f.ref,f.compat));assert.equal(U.textGit(f.ref,['rev-parse','HEAD']),K.REFACTOR);}finally{f.cleanup();}});
test('unknown phase does not bypass exact package inventory check',()=>{const tmp=F.tmp();fs.cpSync(U.ROOT,tmp,{recursive:true});fs.writeFileSync(path.join(tmp,'unknown.txt'),'x');const r=cp.spawnSync(process.execPath,['-e',`require(${JSON.stringify(path.join(tmp,'tools/util.cjs'))}).verifyPackage()`],{encoding:'utf8'});assert.notEqual(r.status,0);});
test('build environment cannot inject a deployment target',()=>{const B=require('../tools/build.cjs'),old=process.env.DEST;try{process.env.DEST='main';assert.throws(()=>B.runNode('.', 'fake.cjs',[],'.','x'));}finally{if(old===undefined)delete process.env.DEST;else process.env.DEST=old;}});
test('a live or unresolved action lock blocks archive, without deletion',()=>{const f=make();try{fs.writeFileSync(path.join(f.run,'action.lock'),'locked');assert.throws(()=>archived(f),e=>e.code==='ACTION_LOCK_STILL_PRESENT');assert.ok(fs.existsSync(path.join(f.run,'action.lock')));}finally{f.cleanup();}});
