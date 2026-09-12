'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const C=require('../verifier-runtime/common.cjs');
const V=require('../verifier-runtime/verify-joint-probe.cjs');
const F=require('./fixture.cjs');

function runHash(run){
  const out=[];for(const name of fs.readdirSync(run).sort()){
    const file=path.join(run,name),stat=fs.statSync(file);if(stat.isFile())out.push([name,C.sha256File(file)]);
  }return JSON.stringify(out);
}

test('full verifier independently accepts the observed-shape evidence',()=>{
  const x=F.makeValid();try{
    const before=runHash(x.run),result=V.verifyRun(x.run,{sourceManifest:F.sourceManifest()});
    assert.equal(result.status,'GUARD_COLLECTOR_CONTROL_PLANE_PROBE_INDEPENDENTLY_VERIFIED');
    assert.equal(result.verifierVersion,V.VERIFIER_VERSION);
    assert.equal(result.heartbeatEvidence.rows,287);
    assert.equal(result.heartbeatEvidence.spanMs,1495086);
    assert.equal(result.heartbeatEvidence.maximumGapMs,10033);
    assert.equal(result.heartbeatEvidence.extendedGapCount,1);
    assert.equal(result.sourceEvidence.commit,V.PINNED_SOURCE.commit);
    assert.equal(runHash(x.run),before,'verification must not mutate the evidence');
  }finally{F.cleanup(x);}
});

test('full verifier accepts continuity with fewer than 295 rows',()=>{
  const x=F.makeValid({rows:251,spanMs:1495086,extendedIndex:140,extendedGapMs:10033});try{
    assert.equal(V.verifyRun(x.run).heartbeatEvidence.rows,251);
  }finally{F.cleanup(x);}
});

test('full verifier rejects PID changes and stale channel evidence',()=>{
  let x=F.makeValid();try{F.mutateLines(x.run,lines=>{lines.find(v=>v.kind==='guard-probe-heartbeat').collectorPid++;});
    assert.throws(()=>V.verifyRun(x.run),error=>error.code==='PROBE_HEARTBEAT_STATE_INVALID');
  }finally{F.cleanup(x);}
  x=F.makeValid();try{F.mutateLines(x.run,lines=>{lines.find(v=>v.kind==='guard-probe-heartbeat').cpuAgeMs=45001;});
    assert.throws(()=>V.verifyRun(x.run),error=>error.code==='PROBE_HEARTBEAT_STATE_INVALID');
  }finally{F.cleanup(x);}
});

test('full verifier rejects a long heartbeat hole even when row count remains high',()=>{
  const x=F.makeValid();try{F.mutateLines(x.run,lines=>{
    const health=lines.filter(v=>v.kind==='guard-probe-heartbeat');const pivot=200;
    for(let i=pivot;i<health.length;i++)health[i].atMs+=30000;
  });assert.throws(()=>V.verifyRun(x.run));
  }finally{F.cleanup(x);}
});

test('full verifier rejects formal-session, upload, restore and lock artifacts',()=>{
  for(const name of ['session.json','upload-attempt.json','restore.jsonl','collector.lock','guard-probe.lock']){
    const x=F.makeValid();try{fs.writeFileSync(path.join(x.run,name),'{}\n');
      assert.throws(()=>V.verifyRun(x.run),error=>error.code==='PROBE_FORBIDDEN_ARTIFACT_PRESENT');
    }finally{F.cleanup(x);}
  }
});

test('full verifier rejects duplicate footer and malformed stop evidence',()=>{
  let x=F.makeValid();try{const file=path.join(x.run,'console.jsonl');fs.appendFileSync(file,fs.readFileSync(file));
    assert.throws(()=>V.verifyRun(x.run),error=>error.code==='PROBE_COLLECTOR_FOOTER_INVALID');
  }finally{F.cleanup(x);}
  x=F.makeValid();try{const file=path.join(x.run,'collector-stop.json'),value=C.readJson(file);value.reason='operator_stop';F.writeJson(file,value);
    assert.throws(()=>V.verifyRun(x.run),error=>error.code==='PROBE_STOP_REQUEST_INVALID');
  }finally{F.cleanup(x);}
});

test('full verifier rejects session/preflight mismatch and changed postflight code',()=>{
  let x=F.makeValid();try{const file=path.join(x.run,'preflight-before.json'),value=C.readJson(file);value.capturedAtMs++;F.writeJson(file,value);
    assert.throws(()=>V.verifyRun(x.run),error=>error.code==='PROBE_SESSION_BASELINE_MISMATCH');
  }finally{F.cleanup(x);}
  x=F.makeValid();try{const file=path.join(x.run,'preflight-after.json'),value=C.readJson(file);value.digest.hash='0'.repeat(64);F.writeJson(file,value);
    assert.throws(()=>V.verifyRun(x.run));
  }finally{F.cleanup(x);}
});

test('full verifier rejects tick regression and counter inconsistency',()=>{
  let x=F.makeValid();try{F.mutateLines(x.run,lines=>{const successes=lines.filter(v=>v.kind==='guard-time-read-success');successes[50].time=1;});
    assert.throws(()=>V.verifyRun(x.run),error=>error.code==='PROBE_TIME_TIMELINE_INVALID');
  }finally{F.cleanup(x);}
  x=F.makeValid();try{const file=path.join(x.run,'guard-probe-result.json'),value=C.readJson(file);value.timeChannel.totalFailedCycles=0;F.writeJson(file,value);
    assert.throws(()=>V.verifyRun(x.run),error=>error.code==='PROBE_TIME_TIMELINE_INVALID');
  }finally{F.cleanup(x);}
});

test('source manifest is pinned to the immutable evidence commit and tree',()=>{
  const valid=F.sourceManifest();assert.equal(V.validateSourceManifest(valid),valid);
  for(const key of ['sourceCommit','probeRunTree','runTree']){
    const bad=JSON.parse(JSON.stringify(valid));bad[key]='0'.repeat(40);
    assert.throws(()=>V.validateSourceManifest(bad),error=>error.code==='SOURCE_EVIDENCE_MANIFEST_INVALID');
  }
});
