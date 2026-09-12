'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const C=require('../runtime/common.cjs');const G=require('../runtime/guard-control.cjs');

function policy(overrides={}) {
  return {
    attemptsPerCycle:3,perAttemptMaxMs:500,retryDelaysMs:[0,0],
    maxConsecutiveFailedCycles:2,maxSuccessAgeMs:10000,...overrides,
  };
}
function queuedApi(values) {
  let index=0;
  return {calls:[],async time(shard,budget){
    this.calls.push({shard,budget});
    const value=values[index++];
    if(value instanceof Error)throw value;
    return value;
  }};
}
test('classifies time transport, deadline and payload failures without a generic catch-all label',()=>{
  assert.equal(G.classifyGuardFailure('game_time_read',new C.Failure('HTTP_TRANSPORT_ERROR')).reason,
    'guard_time_transport_failure');
  assert.equal(G.classifyGuardFailure('game_time_read',new C.Failure('HTTP_DEADLINE')).reason,
    'guard_time_deadline_failure');
  assert.equal(G.classifyGuardFailure('game_time_read',new C.Failure('GAME_TICK_UNREADABLE')).reason,
    'guard_time_payload_failure');
});
test('classifies immutable attempt reads and readiness writes separately',()=>{
  assert.equal(G.classifyGuardFailure('upload_attempt_read',new Error('x')).reason,
    'guard_upload_attempt_read_failure');
  assert.equal(G.classifyGuardFailure('guard_ready_write',new Error('x')).reason,
    'guard_artifact_write_failure');
});
test('safe diagnostics contain no raw message or stack and hash only redacted bounded text',()=>{
  const token='0123456789abcdef0123456789abcdef';
  const error=new Error(`authorization=${token}`);error.code='HTTP_TRANSPORT_ERROR';
  const value=G.safeGuardDiagnostic('game_time_read',error,C.redactor([token]));
  assert.equal('message' in value,false);assert.equal('stack' in value,false);
  assert.equal(value.code,'HTTP_TRANSPORT_ERROR');assert.equal(value.redactionChanged,true);
  assert.match(value.messageSha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(value).includes(token),false);
});
test('a transient first attempt can recover inside the same bounded cycle',async()=>{
  let now=1000;
  const api=queuedApi([new C.Failure('HTTP_TRANSPORT_ERROR'),{ok:1,time:77}]);
  const state=G.createTimeChannelState(now);
  const result=await G.readGameTimeResilient({api,shard:'shard1',budgetMs:2000,state,
    now:()=>now,pause:async ms=>{now+=ms;},policy:policy()});
  assert.equal(result.status,'ok');assert.equal(result.time,77);assert.equal(api.calls.length,2);
  assert.equal(result.state.consecutiveFailedCycles,0);
});
test('one fully failed time-read cycle is degraded, not terminal',async()=>{
  let now=1000;
  const api=queuedApi(Array.from({length:3},()=>new C.Failure('HTTP_TRANSPORT_ERROR')));
  const state=G.createTimeChannelState(now);
  const result=await G.readGameTimeResilient({api,shard:'shard1',budgetMs:2000,state,
    now:()=>now,pause:async ms=>{now+=ms;},policy:policy()});
  assert.equal(result.status,'degraded');assert.equal(result.failure.reason,'guard_time_transport_failure');
  assert.equal(result.state.consecutiveFailedCycles,1);
});
test('a second consecutive failed cycle fails closed with the exact last channel class',async()=>{
  let now=1000;
  const api=queuedApi(Array.from({length:6},()=>new C.Failure('HTTP_DEADLINE')));
  const state=G.createTimeChannelState(now);
  const args={api,shard:'shard1',budgetMs:2000,state,now:()=>now,
    pause:async ms=>{now+=ms;},policy:policy()};
  assert.equal((await G.readGameTimeResilient(args)).status,'degraded');
  now+=15000;
  const result=await G.readGameTimeResilient(args);
  assert.equal(result.status,'terminal');assert.equal(result.failure.reason,'guard_time_deadline_failure');
  assert.equal(result.state.consecutiveFailedCycles,2);
});
test('a successful later cycle resets the consecutive failure counter',async()=>{
  let now=1000;
  const api=queuedApi([
    new C.Failure('HTTP_TRANSPORT_ERROR'),new C.Failure('HTTP_TRANSPORT_ERROR'),new C.Failure('HTTP_TRANSPORT_ERROR'),
    {ok:1,time:88},
  ]);
  const state=G.createTimeChannelState(now);
  const args={api,shard:'shard1',budgetMs:2000,state,now:()=>now,
    pause:async ms=>{now+=ms;},policy:policy()};
  assert.equal((await G.readGameTimeResilient(args)).status,'degraded');
  now+=15000;
  const result=await G.readGameTimeResilient(args);
  assert.equal(result.status,'ok');assert.equal(result.state.consecutiveFailedCycles,0);
  assert.equal(result.state.totalFailedCycles,1);assert.equal(result.state.totalSuccessfulReads,1);
});
test('an unreadable HTTP success payload is classified as payload failure',async()=>{
  let now=1000;
  const api=queuedApi([{ok:1,time:'bad'},{ok:1,time:'bad'},{ok:1,time:'bad'}]);
  const state=G.createTimeChannelState(now);
  const result=await G.readGameTimeResilient({api,shard:'shard1',budgetMs:2000,state,
    now:()=>now,pause:async ms=>{now+=ms;},policy:policy()});
  assert.equal(result.status,'degraded');assert.equal(result.failure.reason,'guard_time_payload_failure');
});
test('time read budgets stay positive and never exceed the per-attempt cap',async()=>{
  let now=1000;
  const api=queuedApi([new C.Failure('HTTP_TRANSPORT_ERROR'),{ok:1,time:9}]);
  const state=G.createTimeChannelState(now);
  await G.readGameTimeResilient({api,shard:'shard1',budgetMs:600,state,
    now:()=>now,pause:async ms=>{now+=ms;},policy:policy({perAttemptMaxMs:500})});
  assert.ok(api.calls.every(x=>x.budget>=1&&x.budget<=500));
});

test('a late first failed cycle is still degraded when there has never been a successful read',async()=>{
  let now=60000;
  const api=queuedApi(Array.from({length:3},()=>new C.Failure('HTTP_TRANSPORT_ERROR')));
  const state=G.createTimeChannelState(0);
  const result=await G.readGameTimeResilient({api,shard:'shard1',budgetMs:2000,state,
    now:()=>now,pause:async ms=>{now+=ms;},policy:policy()});
  assert.equal(result.status,'degraded');
  assert.equal(result.state.consecutiveFailedCycles,1);
});

test('failure audit records do not retain injected credential text',async()=>{
  let now=1000;const token='feedfacefeedfacefeedfacefeedface';
  const error=new C.Failure('HTTP_TRANSPORT_ERROR');error.message=`token=${token}`;
  const api=queuedApi([error,error,error]);const records=[];
  const state=G.createTimeChannelState(now);
  await G.readGameTimeResilient({api,shard:'shard1',budgetMs:2000,state,record:x=>records.push(x),
    now:()=>now,pause:async ms=>{now+=ms;},redact:C.redactor([token]),policy:policy()});
  assert.equal(JSON.stringify(records).includes(token),false);
  assert.ok(records.some(x=>x.kind==='guard-time-read-cycle-failed'));
});

test('stableErrorCode rejects unsafe failure codes instead of echoing arbitrary text',()=>{
  const error=new C.Failure('not safe secret-shaped code');
  assert.equal(G.stableErrorCode(error),'UNEXPECTED_LOCAL_FAILURE');
});

test('safe diagnostics enforce a true UTF-8 byte ceiling',()=>{
  const error=new Error('界'.repeat(800));
  const value=G.safeGuardDiagnostic('internal',error,C.redactor());
  assert.ok(value.messageBytes<=1024);
  assert.equal(value.messageTruncated,true);
});

test('artifact reads tolerate bounded transient failures and preserve the final value',async()=>{
  let calls=0,pauses=[];
  const value=await G.readJsonArtifact('x.json',1024,{
    required:true,
    exists:()=>true,
    read:()=>{calls++;if(calls<3)throw new C.Failure('LOCAL_JSON_UNREADABLE');return {ok:true};},
    pause:async ms=>{pauses.push(ms);},
  });
  assert.deepEqual(value,{ok:true});
  assert.equal(calls,3);
  assert.deepEqual(pauses,[20,50]);
});

test('artifact reads return undefined for an absent optional file and fail for an absent required file',async()=>{
  assert.equal(await G.readJsonArtifact('missing.json',1024,{exists:()=>false}),undefined);
  await assert.rejects(()=>G.readJsonArtifact('missing.json',1024,{required:true,exists:()=>false}),
    error=>error instanceof C.Failure&&error.code==='LOCAL_JSON_UNREADABLE');
});
