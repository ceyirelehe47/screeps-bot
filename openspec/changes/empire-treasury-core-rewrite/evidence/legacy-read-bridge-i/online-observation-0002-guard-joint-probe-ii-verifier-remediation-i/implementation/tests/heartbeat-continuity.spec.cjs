'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const H=require('../verifier-runtime/heartbeat-continuity.cjs');
const F=require('./fixture.cjs');

function extract(x){
  const lines=F.readLines(require('node:path').join(x.run,'guard-probe.jsonl'));
  const probe=require('../verifier-runtime/common.cjs').readJson(require('node:path').join(x.run,'guard-probe-result.json'));
  return {health:lines.filter(v=>v.kind==='guard-probe-heartbeat'),
    cycleFailures:lines.filter(v=>v.kind==='guard-time-read-cycle-failed'),
    attemptFailures:lines.filter(v=>v.kind==='guard-time-read-attempt-failed'),probe,session:x.session};
}

test('continuity accepts the observed 287-row shape and explains the one retry gap',()=>{
  const x=F.makeValid();try{
    const result=H.analyze(extract(x));
    assert.equal(result.rows,287);
    assert.equal(result.spanMs,1495086);
    assert.equal(result.maximumGapMs,10033);
    assert.equal(result.extendedGapCount,1);
    assert.deepEqual(result.extendedGaps[0].retryAttempts,[1,2,3]);
    assert.ok(result.p95GapMs<=H.POLICY.p95GapMaxMs);
  }finally{F.cleanup(x);}
});

test('continuity is based on coverage and gaps, not a 295-row quota',()=>{
  const x=F.makeValid({rows:251,spanMs:1495086,extendedIndex:140,extendedGapMs:10033});try{
    const result=H.analyze(extract(x));assert.equal(result.rows,251);assert.ok(result.maximumGapMs<=10033);
  }finally{F.cleanup(x);}
});

test('many rows cannot hide a long evidence hole',()=>{
  const x=F.makeValid();try{
    const input=extract(x),health=input.health;
    const pivot=150,extra=60000;
    for(let i=pivot;i<health.length;i++)health[i].atMs+=extra;
    assert.throws(()=>H.analyze(input),error=>['PROBE_HEARTBEAT_COVERAGE_INSUFFICIENT','PROBE_HEARTBEAT_BOUNDARY_INVALID','PROBE_HEARTBEAT_GAP_TOO_LARGE'].includes(error.code));
  }finally{F.cleanup(x);}
});

test('an extended gap must be explained by one recorded failed cycle',()=>{
  const x=F.makeValid();try{const input=extract(x);input.cycleFailures=[];
    assert.throws(()=>H.analyze(input),error=>error.code==='PROBE_HEARTBEAT_GAP_UNEXPLAINED');
  }finally{F.cleanup(x);}
});

test('the explaining failed cycle requires the complete three-attempt evidence',()=>{
  const x=F.makeValid();try{const input=extract(x);input.attemptFailures.pop();
    assert.throws(()=>H.analyze(input),error=>error.code==='PROBE_HEARTBEAT_GAP_RETRY_EVIDENCE_INVALID');
  }finally{F.cleanup(x);}
});

test('even a retry-explained gap is bounded',()=>{
  const x=F.makeValid();try{const input=extract(x),health=input.health,index=x.failureGapIndex+1;
    const delta=6000;for(let i=index;i<health.length;i++)health[i].atMs+=delta;
    assert.throws(()=>H.analyze(input),error=>['PROBE_HEARTBEAT_GAP_TOO_LARGE','PROBE_HEARTBEAT_BOUNDARY_INVALID'].includes(error.code));
  }finally{F.cleanup(x);}
});

test('compressed coverage is rejected regardless of row count',()=>{
  const x=F.makeValid();try{const input=extract(x),first=x.probeStart;
    input.health.forEach((line,index)=>{line.atMs=first+index*1000;});
    assert.throws(()=>H.analyze(input),error=>error.code==='PROBE_HEARTBEAT_COVERAGE_INSUFFICIENT');
  }finally{F.cleanup(x);}
});

test('late first evidence and early last evidence are rejected',()=>{
  let x=F.makeValid();try{const input=extract(x);for(const line of input.health)line.atMs+=10001;input.probe.durationMs+=10001;
    assert.throws(()=>H.analyze(input),error=>error.code==='PROBE_HEARTBEAT_COVERAGE_INSUFFICIENT');
  }finally{F.cleanup(x);}
  x=F.makeValid({spanMs:1479000});try{const input=extract(x);
    assert.throws(()=>H.analyze(input),error=>error.code==='PROBE_HEARTBEAT_COVERAGE_INSUFFICIENT');
  }finally{F.cleanup(x);}
});

test('duplicate or regressing heartbeat timestamps are rejected',()=>{
  let x=F.makeValid();try{const input=extract(x);input.health[20].atMs=input.health[19].atMs;
    assert.throws(()=>H.analyze(input),error=>error.code==='PROBE_HEARTBEAT_TIME_ORDER_INVALID');
  }finally{F.cleanup(x);}
  x=F.makeValid();try{const input=extract(x);input.health[20].atMs=input.health[19].atMs-1;
    assert.throws(()=>H.analyze(input),error=>error.code==='PROBE_HEARTBEAT_TIME_ORDER_INVALID');
  }finally{F.cleanup(x);}
});

test('a generally slow heartbeat distribution is rejected before it becomes a hidden hole',()=>{
  const x=F.makeValid();try{const input=extract(x),start=x.probeStart+4;
    for(let i=0;i<input.health.length;i++)input.health[i].atMs=start+i*8100;
    input.probe.durationMs=input.health.at(-1).atMs-start+20000;
    input.session.durationMs=input.health.at(-1).atMs-start+5000;
    assert.throws(()=>H.analyze(input),error=>['PROBE_HEARTBEAT_DISTRIBUTION_INVALID','PROBE_HEARTBEAT_GAP_UNEXPLAINED'].includes(error.code));
  }finally{F.cleanup(x);}
});
