'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const F=require('./fixture.cjs'),{worldApi}=require('./process-fixture.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),S=require('../runtime/store.cjs');
const {execute}=require('../runtime/driver.cjs'),{verifyRun}=require('../runtime/verify-run.cjs');
test('real supervisor + separate collector + separate recovery worker complete one upload, twelve reports, one restore and runtime tail',async()=>{
 const root=F.runDir(),run=path.join(root,'run');fs.mkdirSync(run);const s=F.makeSession();F.saveSession(run,s);
 C.writeNew(path.join(root,'fake-world.json'),{s,modules:s.backup.modules,mode:'backup',changedAtMs:Date.now(),writes:0});
 const oldSpawn=cp.spawn,oldDigest=C.ORIGINAL_DIGEST,oldConfirm=K.CONFIRM_MS;
 C.ORIGINAL_DIGEST=s.backup.digest;K.CONFIRM_MS=1500;
 cp.spawn=function(bin,args,opts){return oldSpawn.call(cp,bin,['--require',path.resolve(__dirname,'process-fixture.cjs'),...args],{...opts,env:{...process.env,FORMAL_0003_FIXTURE_ROOT:root}});};
 try{
  const result=await execute({repo:root,run,secret:{path:path.join(root,'unused-secret-path'),token:'FAKE',redact:C.redactor()},s,guard:F.guard,api:worldApi(root)});
  assert.equal(result.status,'RESTORED',JSON.stringify(result));assert.equal(result.guardExit,0);assert.equal(result.collectorExit,0);
  assert.equal(C.readJson(path.join(root,'fake-world.json')).writes,2);
  const cr=S.optional(run,'collector-result.json');assert.equal(cr.reason,'observation_closed');
  S.newRecord(run,'source-closed.json',{status:'SOURCE_DEFAULT_OFF_RESTORED',profileHead:s.profileHead,sameTreeAsCompatBase:true});
  const verified=verifyRun(run);assert.equal(verified.observed,true,JSON.stringify(verified));
 }finally{cp.spawn=oldSpawn;C.ORIGINAL_DIGEST=oldDigest;K.CONFIRM_MS=oldConfirm;fs.rmSync(root,{recursive:true,force:true});}
});
for(const mode of ['crashRecovery','failCollector'])test('separate processes preserve one-use restoration after '+mode,async()=>{
 const root=F.runDir(),run=path.join(root,'run');fs.mkdirSync(run);const s=F.makeSession();F.saveSession(run,s);
 C.writeNew(path.join(root,'fake-world.json'),{s,modules:s.backup.modules,mode:'backup',changedAtMs:Date.now(),writes:0,[mode]:true});
 const oldSpawn=cp.spawn,oldDigest=C.ORIGINAL_DIGEST,oldConfirm=K.CONFIRM_MS;C.ORIGINAL_DIGEST=s.backup.digest;K.CONFIRM_MS=1000;
 cp.spawn=function(bin,args,opts){return oldSpawn.call(cp,bin,['--require',path.resolve(__dirname,'process-fixture.cjs'),...args],{...opts,env:{...process.env,FORMAL_0003_FIXTURE_ROOT:root}});};
 try{
  const result=await execute({repo:root,run,secret:{path:path.join(root,'unused-secret-path'),redact:C.redactor()},s,guard:F.guard,api:worldApi(root)});
  const world=C.readJson(path.join(root,'fake-world.json'));assert.equal(world.writes,2,JSON.stringify(result));assert.deepEqual(world.modules,s.backup.modules);
  S.newRecord(run,'source-closed.json',{status:'SOURCE_DEFAULT_OFF_RESTORED',profileHead:s.profileHead,sameTreeAsCompatBase:true});
  assert.equal(verifyRun(run).observed,false);
 }finally{cp.spawn=oldSpawn;C.ORIGINAL_DIGEST=oldDigest;K.CONFIRM_MS=oldConfirm;fs.rmSync(root,{recursive:true,force:true});}
});
