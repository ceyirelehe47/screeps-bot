'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const T=require('../../tools/tool-common.cjs');
const A=require('../../tools/adjudicate-existing-evidence.cjs');
const R=require('../../tools/verify-readjudication.cjs');
const F=require('./fixture.cjs');
const PIN=T.readJson(path.resolve(__dirname,'..','..','references','PINNED-EVIDENCE.json'));

const RUN_FILES=[
  'collector-private.jsonl','collector-ready.json','collector-ready.stderr','collector-ready.stdout','collector-result.json',
  'collector-stop.json','collector.exit.txt','collector.stderr','collector.stdout','console.jsonl','guard-probe-ready.json',
  'guard-probe-result.json','guard-probe.exit.txt','guard-probe.jsonl','guard-probe.stderr','guard-probe.stdout',
  'heartbeat.json','online-state-verification.json','postflight.stderr','postflight.stdout','preflight-after.json',
  'preflight-before.json','probe-prepared.json','probe-session.json','verify-joint-probe.exit.txt',
  'verify-joint-probe.stderr','verify-joint-probe.stdout',
];
function buildMaterialized(){
  const fixture=F.makeValid(),root=fs.mkdtempSync(path.join(os.tmpdir(),'materialized-')),source=path.join(root,'source'),run=path.join(source,'run');
  fs.mkdirSync(source,{recursive:true});fs.cpSync(fixture.run,run,{recursive:true});
  for(const name of RUN_FILES){const file=path.join(run,name);if(!fs.existsSync(file)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');}}
  fs.writeFileSync(path.join(run,'verify-joint-probe.exit.txt'),'1\n');
  fs.writeFileSync(path.join(run,'verify-joint-probe.stderr'),`Failure [Error]: ${PIN.oldVerifierFailure.errorCode}\n  details: { expectedAtLeast: 295, actual: 287 }\n`);
  fs.writeFileSync(path.join(run,'verify-joint-probe.stdout'),'');
  fs.writeFileSync(path.join(source,'prepare.stderr'),'');fs.writeFileSync(path.join(source,'prepare.stdout'),'{}\n');
  fs.writeFileSync(path.join(source,'secret-scan.json'),'{}\n');
  const files=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const absolute=path.join(dir,entry.name);if(entry.isDirectory())walk(absolute);else{const relative=path.relative(source,absolute).replace(/\\/g,'/'),bytes=fs.readFileSync(absolute);
      files.push({path:relative,blob:'f'.repeat(40),bytes:bytes.length,sha256:T.sha256(bytes)});}}}walk(source);
  assert.equal(files.length,30);
  const manifest={status:'PINNED_GUARD_JOINT_PROBE_EVIDENCE_MATERIALIZED',sourceCommit:PIN.sourceCommit,
    probeRunPath:PIN.probeRunPath,probeRunTree:PIN.probeRunTree,runTree:PIN.runTree,files:files.length,
    totalBytes:files.reduce((sum,item)=>sum+item.bytes,0),entries:files};
  T.writeNew(path.join(root,'SOURCE-EVIDENCE-MANIFEST.json'),manifest);
  return {fixture,root,source,run,manifest};
}
function cleanup(value){F.cleanup(value.fixture);fs.rmSync(value.root,{recursive:true,force:true});}

test('the complete offline chain re-adjudicates existing evidence and independently verifies it',()=>{
  const x=buildMaterialized(),out=path.join(x.root,'adjudication');try{
    const summary=A.adjudicate(x.root,out);assert.equal(summary.status,'EXISTING_GUARD_JOINT_PROBE_EVIDENCE_READJUDICATED');
    const final=R.verify(x.root,out,path.join(x.root,'READJUDICATION-VERIFIED.json'));
    assert.equal(final.status,'EXISTING_GUARD_JOINT_PROBE_EVIDENCE_INDEPENDENTLY_READJUDICATED');
    assert.equal(final.heartbeat.rows,287);assert.equal(final.heartbeat.maximumGapMs,10033);
  }finally{cleanup(x);}
});

test('the chain rejects any mutation of the materialized raw evidence',()=>{
  const x=buildMaterialized();try{fs.appendFileSync(path.join(x.run,'guard-probe.jsonl'),'{}\n');
    assert.throws(()=>A.adjudicate(x.root,path.join(x.root,'out')),error=>error.code==='SOURCE_EVIDENCE_MATERIALIZATION_CHANGED');
  }finally{cleanup(x);}
});

test('the chain refuses to rewrite or reinterpret a different old verifier failure',()=>{
  const x=buildMaterialized();try{fs.writeFileSync(path.join(x.run,'verify-joint-probe.stderr'),'different failure\n');
    const entry=x.manifest.entries.find(item=>item.path==='run/verify-joint-probe.stderr'),bytes=fs.readFileSync(path.join(x.run,'verify-joint-probe.stderr'));
    entry.bytes=bytes.length;entry.sha256=T.sha256(bytes);x.manifest.totalBytes=x.manifest.entries.reduce((sum,item)=>sum+item.bytes,0);
    fs.writeFileSync(path.join(x.root,'SOURCE-EVIDENCE-MANIFEST.json'),JSON.stringify(x.manifest,null,2)+'\n');
    assert.throws(()=>A.adjudicate(x.root,path.join(x.root,'out')),error=>error.code==='OLD_VERIFIER_FALSE_NEGATIVE_EVIDENCE_INVALID');
  }finally{cleanup(x);}
});

test('independent readjudication rejects a tampered success result',()=>{
  const x=buildMaterialized(),out=path.join(x.root,'adjudication');try{A.adjudicate(x.root,out);
    const file=path.join(out,'joint-probe-verification.json'),result=T.readJson(file);result.heartbeatEvidence.maximumGapMs=1;
    fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');
    assert.throws(()=>R.verify(x.root,out,path.join(x.root,'final.json')),error=>error.code==='READJUDICATION_HEARTBEAT_METRICS_MISMATCH');
  }finally{cleanup(x);}
});
