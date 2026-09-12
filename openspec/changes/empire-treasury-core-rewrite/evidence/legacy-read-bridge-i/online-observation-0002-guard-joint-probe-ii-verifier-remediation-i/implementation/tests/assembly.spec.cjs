'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const T=require('../../tools/tool-common.cjs');
const AD=require('../../tools/adjudicate-existing-evidence.cjs');
const IV=require('../../tools/verify-readjudication.cjs');
const AS=require('../../tools/assemble-evidence.cjs');
const VA=require('../../tools/verify-assembled-evidence.cjs');
const VP=require('../../tools/verify-package.cjs');
const F=require('./fixture.cjs');
const PIN=T.readJson(path.resolve(__dirname,'..','..','references','PINNED-EVIDENCE.json'));
function git(repo,args){return cp.execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();}
const RUN_FILES=['collector-private.jsonl','collector-ready.json','collector-ready.stderr','collector-ready.stdout','collector-result.json','collector-stop.json','collector.exit.txt','collector.stderr','collector.stdout','console.jsonl','guard-probe-ready.json','guard-probe-result.json','guard-probe.exit.txt','guard-probe.jsonl','guard-probe.stderr','guard-probe.stdout','heartbeat.json','online-state-verification.json','postflight.stderr','postflight.stdout','preflight-after.json','preflight-before.json','probe-prepared.json','probe-session.json','verify-joint-probe.exit.txt','verify-joint-probe.stderr','verify-joint-probe.stdout'];
function materialized(){
  const fixture=F.makeValid(),root=fs.mkdtempSync(path.join(os.tmpdir(),'assemble-mat-')),source=path.join(root,'source'),run=path.join(source,'run');fs.mkdirSync(source);fs.cpSync(fixture.run,run,{recursive:true});
  for(const name of RUN_FILES){const file=path.join(run,name);if(!fs.existsSync(file))fs.writeFileSync(file,'');}
  fs.writeFileSync(path.join(run,'verify-joint-probe.exit.txt'),'1\n');fs.writeFileSync(path.join(run,'verify-joint-probe.stderr'),'Failure: PROBE_HEARTBEAT_TIMELINE_INVALID\n details: { expectedAtLeast: 295, actual: 287 }\n');fs.writeFileSync(path.join(run,'verify-joint-probe.stdout'),'');
  fs.writeFileSync(path.join(source,'prepare.stderr'),'');fs.writeFileSync(path.join(source,'prepare.stdout'),'{}\n');fs.writeFileSync(path.join(source,'secret-scan.json'),'{}\n');
  const entries=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const a=path.join(dir,e.name);if(e.isDirectory())walk(a);else{const r=path.relative(source,a).replace(/\\/g,'/'),b=fs.readFileSync(a);entries.push({path:r,blob:'f'.repeat(40),bytes:b.length,sha256:T.sha256(b)});}}}walk(source);entries.sort((a,b)=>a.path.localeCompare(b.path));
  const m={status:'PINNED_GUARD_JOINT_PROBE_EVIDENCE_MATERIALIZED',sourceCommit:PIN.sourceCommit,probeRunPath:PIN.probeRunPath,probeRunTree:PIN.probeRunTree,runTree:PIN.runTree,files:entries.length,totalBytes:entries.reduce((s,e)=>s+e.bytes,0),entries};T.writeNew(path.join(root,'SOURCE-EVIDENCE-MANIFEST.json'),m);
  return {fixture,root};
}
test('deterministic assembler creates only the new evidence directory and final verifier accepts it',()=>{
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'assemble-repo-')),m=materialized(),adjudication=path.join(m.root,'adjudication'),independent=path.join(m.root,'independent.json');
  const packageDir=path.join(m.root,'package'),tests=path.join(m.root,'tests'),logs=path.join(m.root,'logs'),zip=path.join(m.root,'package.zip');
  try{
    git(repo,['init']);git(repo,['config','user.email','test@example.invalid']);git(repo,['config','user.name','test']);fs.mkdirSync(path.join(repo,'evidence'),{recursive:true});fs.writeFileSync(path.join(repo,'evidence','.keep'),'tracked\n');git(repo,['add','.']);git(repo,['commit','-m','base']);const head=git(repo,['rev-parse','HEAD']);
    AD.adjudicate(m.root,adjudication);IV.verify(m.root,adjudication,independent);
    fs.mkdirSync(path.join(packageDir,'implementation'),{recursive:true});fs.writeFileSync(path.join(packageDir,'implementation','verifier.cjs'),'module.exports={};\n');T.writeNew(path.join(packageDir,'IMPLEMENTATION-MANIFEST.json'),{status:'fixture'});fs.writeFileSync(zip,'zip');fs.mkdirSync(tests);fs.writeFileSync(path.join(tests,'tests.tap'),'ok\n');fs.mkdirSync(logs);fs.writeFileSync(path.join(logs,'steps.json'),'{}\n');
    const policy={heads:{refactorHead:head},pin:PIN,targetRel:'evidence/readjudication'};
    const assembled=AS.assemble({repo,packageDir,packageZip:zip,testResults:tests,executionLogs:logs,materialized:m.root,adjudication,independentVerdict:independent},policy);assert.equal(assembled.target,'evidence/readjudication');
    const finalFile=path.join(repo,'evidence','readjudication','FINAL-VERIFICATION.json');const final=VA.verify(repo,finalFile,{heads:{refactorHead:head},targetRel:'evidence/readjudication'});assert.equal(final.status,'READJUDICATION_EVIDENCE_PACKAGE_VERIFIED');assert.ok(fs.existsSync(finalFile));
  }finally{F.cleanup(m.fixture);fs.rmSync(m.root,{recursive:true,force:true});fs.rmSync(repo,{recursive:true,force:true});}
});

test('package verifier compares exact paths independent of locale-aware traversal order',{concurrency:false},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'package-order-'));
  const originalListFiles=T.listFiles;
  // Different names even after case folding: both files coexist on default NTFS.
  const payloads=[['Z-upper.txt','upper\n'],['a-lower.txt','lower\n']];
  const names=payloads.map(([name])=>name);
  try{
    assert.equal(new Set(names.map(name=>name.toLowerCase())).size,names.length);
    for(const [name,text] of payloads)fs.writeFileSync(path.join(root,name),text,{flag:'wx'});
    assert.deepEqual(fs.readdirSync(root).sort(),[...names].sort());
    const entries=names.map(name=>{const bytes=fs.readFileSync(path.join(root,name));return {path:name,sha256:T.sha256(bytes),bytes:bytes.length};});
    const integrity={schema:'screeps-task-package-integrity/v1',packageName:path.basename(root),packageVersion:1,
      implementationStatus:'complete',agentRole:'verification-only',fileCount:entries.length,files:entries};
    const writeIntegrity=value=>fs.writeFileSync(path.join(root,'INTEGRITY.json'),JSON.stringify(value)+'\n');
    writeIntegrity(integrity);
    assert.equal(VP.verify(root).status,'PACKAGE_INTEGRITY_VERIFIED');
    const actualFiles=originalListFiles(root);
    // Force both traversal orders. The regression does not depend on host locale,
    // filesystem ordering or the relative collation of upper/lower-case letters.
    for(const traversal of [[names[1],'INTEGRITY.json',names[0]],[names[0],names[1],'INTEGRITY.json']]){
      assert.deepEqual([...traversal].sort(),[...actualFiles].sort());
      T.listFiles=dir=>path.resolve(dir)===path.resolve(root)?[...traversal]:originalListFiles(dir);
      assert.equal(VP.verify(root).status,'PACKAGE_INTEGRITY_VERIFIED');
    }
    T.listFiles=originalListFiles;
    // Exact case-sensitive manifest identity remains required, even on NTFS.
    writeIntegrity({...integrity,files:entries.map((entry,index)=>index===0?{...entry,path:'z-upper.txt'}:entry)});
    assert.throws(()=>VP.verify(root),error=>error.code==='PACKAGE_FILE_SET_MISMATCH');
    writeIntegrity(integrity);
    fs.writeFileSync(path.join(root,'unexpected.txt'),'extra\n',{flag:'wx'});
    assert.throws(()=>VP.verify(root),error=>error.code==='PACKAGE_FILE_SET_MISMATCH');
    fs.unlinkSync(path.join(root,'unexpected.txt'));
    fs.writeFileSync(path.join(root,names[0]),'changed\n');
    assert.throws(()=>VP.verify(root),error=>error.code==='PACKAGE_FILE_HASH_MISMATCH');
  }finally{
    T.listFiles=originalListFiles;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
