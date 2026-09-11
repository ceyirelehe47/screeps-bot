'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const P=require('../guard-probe.cjs');

const session={runId:'a'.repeat(32)};
test('minimum time-read count keeps a small scheduling margin but requires sustained reads',()=>{
  assert.equal(P.expectedMinimumTimeReads(1200000),78);
  assert.equal(P.expectedMinimumTimeReads(1500000),98);
});
test('collector probe terminal requires the exact run, clean reason, zero exit and footer',()=>{
  const ok={kind:'collector-result-v2',runId:session.runId,status:'closed',reason:'probe_complete',
    exitCode:0,footerWritten:true};
  assert.equal(P.validateProbeTerminal(ok,session),true);
  assert.equal(P.validateProbeTerminal({...ok,runId:'b'.repeat(32)},session),false);
  assert.equal(P.validateProbeTerminal({...ok,exitCode:1},session),false);
  assert.equal(P.validateProbeTerminal({...ok,footerWritten:false},session),false);
});
test('stop request is create-once and a conflicting existing request is rejected',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-probe-stop-')),file=path.join(dir,'collector-stop.json');
  try{
    assert.equal(P.requestCollectorStop(file,session,'probe_complete',1234),true);
    assert.equal(P.requestCollectorStop(file,session,'probe_complete',5678),false);
    const value=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(value.requestedAtMs,1234);
    value.reason='operator_stop';fs.writeFileSync(file,JSON.stringify(value));
    assert.throws(()=>P.requestCollectorStop(file,session,'probe_complete',9999));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('collector result waiter refuses malformed or unexpected terminal evidence',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-probe-result-')),file=path.join(dir,'collector-result.json');
  try{
    fs.writeFileSync(file,'not json');
    assert.equal((await P.waitForCollectorResult(file,session,{timeoutMs:10})).status,'invalid');
    fs.writeFileSync(file,JSON.stringify({kind:'collector-result-v2',runId:session.runId,status:'failed',
      reason:'operator_stop',exitCode:1,footerWritten:true}));
    assert.equal((await P.waitForCollectorResult(file,session,{timeoutMs:10})).status,'unexpected');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('probe implementation is structurally read-only with respect to Screeps code',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'..','guard-probe.cjs'),'utf8');
  assert.equal(source.includes('.setCode('),false);
  assert.equal(source.includes('restore-modules'),false);
  assert.equal(source.includes('upload-once'),false);
  assert.match(source,/codeWriteRequests:0/);
  assert.match(source,/totalFailedCycles<=1/);
  assert.match(source,/auditFailed/);
  assert.ok(source.indexOf("fs.unlinkSync(file('guard-probe.lock'))")
    <source.indexOf("C.writeNew(file('guard-probe-result.json')"));
});
test('formal deadline guard consumes classified resilient time reads and drops the old generic label',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'..','deadline-guard.cjs'),'utf8');
  const control=fs.readFileSync(path.resolve(__dirname,'..','guard-control.cjs'),'utf8');
  assert.match(source,/require\('\.\/guard-control\.cjs'\)/);
  assert.match(source,/readGameTimeResilient/);
  assert.equal(source.includes("guard_read_or_channel_failure"),false);
  assert.match(source,/failure,timeChannel/);
  assert.match(control,/guard_restore_dispatch_failure/);
  assert.ok(source.indexOf("fs.unlinkSync(file('guard.lock'))")
    <source.indexOf("C.atomicJson(file('guard-result.json')"));
});

test('joint heartbeat requires a stable collector pid and a fresh CPU channel',()=>{
  const now=100000;
  const base={pid:42,lastCpuAtMs:99999};
  assert.equal(P.additionalJointHeartbeatReason(base,now,{expectedPid:42}),null);
  assert.equal(P.additionalJointHeartbeatReason({...base,pid:43},now,{expectedPid:42}),'collector_pid_changed');
  assert.equal(P.additionalJointHeartbeatReason({pid:42,lastCpuAtMs:null},now,{expectedPid:42}),'collector_cpu_never_seen');
  assert.equal(P.additionalJointHeartbeatReason({pid:42,lastCpuAtMs:40000},now,{expectedPid:42}),'collector_cpu_silent');
});

test('formal guard uses resilient artifact reads instead of swallowing JSON failures',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'..','deadline-guard.cjs'),'utf8');
  assert.match(source,/readJsonArtifact\(file\('heartbeat\.json'\)/);
  assert.match(source,/readJsonArtifact\(file\('collector-result\.json'\)/);
  assert.match(source,/readJsonArtifact\(file\('upload-attempt\.json'\)/);
  assert.equal(source.includes("try {h=C.readJson(file('heartbeat.json')"),false);
});
