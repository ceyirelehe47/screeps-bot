'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStopController, decodeText, decodeEnvelope } = require('./stop-controller.cjs');
const { runSession } = require('./lab-control.cjs');
const cfg=require('./fixtures/review-base-config.json');
const facts=require('./fixtures/review-base-facts.json');
const SLOT='__labTerminalTransferProbe';
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
class Clock {
  time=0;next=0;timers=new Map();
  now=()=>this.time;
  setTimer=(fn,ms)=>{const id=++this.next;this.timers.set(id,{at:this.time+ms,fn});return id;};
  clearTimer=id=>this.timers.delete(id);
  async advance(ms){const end=this.time+ms;await drain();for(;;){const jobs=[...this.timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at);if(!jobs.length)break;const[id,v]=jobs[0];this.timers.delete(id);this.time=v.at;v.fn();await drain();}this.time=end;await drain();}
}
function sample(tick){return {kind:'lab-sample',experimentId:cfg.experimentId,configTargetTick:cfg.targetTick,tick,
  source:{...facts.samples[1].source,roomName:'W1N57'},target:{...facts.samples[1].target,roomName:'W10N57'},feeQuote:{status:'ok',energyCost:26},transactions:{incoming:{status:'ok',records:[]},outgoing:{status:'ok',records:[]}}};}
function envelope(s,user='u'){return {channel:`user:${user}/console`,payload:JSON.stringify({userId:user,messages:{log:[JSON.stringify(s)]}})};}
function fixture(overrides={}){
  const clock=new Clock(),logs=[],pauses=[],kills=[];
  const ports={now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,audit:e=>logs.push(e),pause:()=>{pauses.push(clock.time);return Promise.resolve('OK');},readState:async()=>({paused:true,tick:cfg.targetTick+21}),killTree:async()=>{kills.push(clock.time);},...overrides};
  const c=createStopController({userId:'u',config:cfg},ports);c.start();return {clock,logs,pauses,kills,c};
}
test('full 23-tick stream triggers pause at terminal sample, not at 180 seconds',async()=>{
  const f=fixture();for(let t=cfg.targetTick-2;t<=cfg.targetTick+20;t++)f.c.ingest(envelope(sample(t)));
  assert.deepEqual(f.pauses,[0]);await f.clock.advance(1100);const r=await f.c.done;assert.equal(r.reason,'window_complete');assert.equal(r.ok,true);assert.equal(r.sampleTicks.length,23);assert.equal(f.kills.length,0);
});
test('healthy prefix does not stop early; external timer is immutable',async()=>{
  const f=fixture();f.c.ingest(envelope(sample(cfg.targetTick-2)));await f.clock.advance(1000);assert.equal(f.pauses.length,0);assert.throws(()=>f.c.start(),/cannot restart/);
  await f.clock.advance(179000);assert.equal(f.pauses[0],180000);await f.clock.advance(1100);const r=await f.c.done;assert.equal(r.reason,'deadline');assert.equal(r.ok,false);
});
test('other users and tickStarted="1" cannot complete this window',async()=>{
  const f=fixture();f.c.ingest(envelope(sample(cfg.targetTick+20),'other'));f.c.ingest({channel:'tickStarted',payload:'1'});assert.equal(f.pauses.length,0);await f.clock.advance(181100);assert.equal((await f.c.done).reason,'deadline');
});
test('late/duplicate/missing tick fails instead of accepting a terminal-only log',async()=>{
  for(const variant of ['late','duplicate']){const f=fixture();f.c.ingest(envelope(sample(cfg.targetTick-2)));f.c.ingest(envelope(sample(variant==='late'?cfg.targetTick+20:cfg.targetTick-2)));await f.clock.advance(1100);assert.equal((await f.c.done).reason,'window_gap_or_duplicate');}
});
test('wrong experiment, malformed view, source mismatch or decode failure stops promptly',async()=>{
  for(const mutate of [s=>s.experimentId='other',s=>delete s.transactions.outgoing,s=>s.source.terminalId='wrong']){const f=fixture();const s=sample(cfg.targetTick-2);mutate(s);f.c.ingest(envelope(s));assert.equal(f.pauses.length,1);await f.clock.advance(1100);assert.equal((await f.c.done).ok,false);}
  const f=fixture();f.c.ingest({channel:'user:u/console',payload:'{'});assert.equal(f.pauses.length,1);await f.clock.advance(1100);assert.equal((await f.c.done).reason,'console_decode_failure');
});
test('duplicate stop signals are idempotent, never resume',async()=>{
  const f=fixture();f.c.stop('collector_disconnected');f.c.stop('deadline');f.c.stop('other');assert.equal(f.pauses.length,1);await f.clock.advance(1100);assert.deepEqual((await f.c.done).extraReasons,['deadline','other']);
});
test('pause reject/non-OK/synchronous throw all reach process fallback',async()=>{
  for(const pause of [()=>Promise.reject(Error('broken')),()=>Promise.resolve('ERR'),()=>{throw Error('broken');}]){
    const f=fixture({pause});f.c.stop('deadline');await f.clock.advance(1);const r=await f.c.done;assert.equal(f.kills.length,1);assert.equal(r.killConfirmed,true);assert.equal(r.ok,false);
  }
});
test('hung pause OR changing tick reaches fallback within 5s',async()=>{
  for(const overrides of [{pause:()=>new Promise(()=>{})},{readState:(()=>{let tick=100;return async()=>({paused:true,tick:tick++});})()}]){
    const f=fixture(overrides);f.c.stop('deadline');await f.clock.advance(5000);assert.equal(f.kills[0],5000);assert.equal((await f.c.done).ok,false);
  }
});
test('kill failure is reported, not silently converted to success',async()=>{
  const f=fixture({pause:()=>Promise.reject(Error('pause')),killTree:()=>Promise.reject(Error('cannot kill'))});f.c.stop('deadline');await f.clock.advance(1);const r=await f.c.done;assert.equal(r.killConfirmed,false);assert.match(r.error,/cannot kill/);assert.equal(r.ok,false);
});
test('logging failure prevents a healthy result but does not prevent stop',async()=>{
  const f=fixture({audit:()=>{throw Error('disk full');}});await f.clock.advance(1100);const r=await f.c.done;assert.equal(f.pauses.length,1);assert.equal(r.ok,false);assert.ok(r.logErrors.length);
});
test('HTML entity decoding is one pass; payload/user ID mismatch is rejected',()=>{
  assert.equal(decodeText('&#x22;x&#34;'),'"x"');assert.equal(decodeText('&amp;quot;'),'&quot;');assert.throws(()=>decodeEnvelope({channel:'user:u/console',payload:{userId:'v'}},'u'),/mismatch/);
});
test('actual runSession wiring: subscription before resume, raw save before stop, disarm then bound kill',async()=>{
  let subscribed, memory=JSON.stringify({[SLOT]:{experimentId:cfg.experimentId,armed:true,attempted:true,attemptedTick:cfg.targetTick,syncResult:{ok:true,code:0}}});
  const events=[],files={};let kills=0,resumes=0;
  const io={binding:{userId:'u'},pubsub:{subscribe:async(ch,fn)=>{subscribed=fn;},publish:async(ch,p)=>{subscribed.call({channel:ch},p);}},assertIdentity:async()=>{},assertPausedStable:async()=>cfg.targetTick+21,
    readState:async()=>({paused:true,tick:cfg.targetTick+21}),pause:async()=>{events.push('pause');return 'OK';},killTree:async()=>{kills++;events.push('kill');},
    readRuntimeMemory:async()=>memory,writeRuntimeMemory:async raw=>{memory=raw;events.push('memory-write');},
    resume:async()=>{resumes++;events.push('resume');for(let t=cfg.targetTick-2;t<=cfg.targetTick+20;t++){const e=envelope(sample(t));subscribed.call({channel:e.channel},e.payload);}return 'OK';},
    finalSnapshot:async()=>({memory,transactions:[],objects:[],state:{paused:true,tick:cfg.targetTick+21}}),
  };
  const evidence={audit:e=>events.push(e.kind),raw:()=>events.push('raw'),file:(n,v)=>{files[n]=v;}};
  const result=await runSession(io,cfg,'formal',true,evidence);
  assert.equal(resumes,1);assert.equal(kills,1);assert.equal(result.result.windowComplete,true);
  assert.ok(events.indexOf('stop-ready')<events.indexOf('resume'));
  assert.ok(events.lastIndexOf('raw') < events.indexOf('pause'));
  assert.ok(events.indexOf('pause') < events.indexOf('pause-request'));
  assert.ok(events.indexOf('memory-write')<events.indexOf('kill'));assert.equal(JSON.parse(memory)[SLOT].attempted,true);assert.equal(JSON.parse(memory)[SLOT].armed,false);
});

test('slow raw persistence/audit cannot hide a >1s pause delay',async()=>{
  const f=fixture();
  for(let t=cfg.targetTick-2;t<cfg.targetTick+20;t++)f.c.ingest(envelope(sample(t)));
  const last=envelope(sample(cfg.targetTick+20));last.recvMonotonicMs=0;
  f.clock.time=1500;f.c.ingest(last);await f.clock.advance(1100);
  const r=await f.c.done;assert.equal(r.triggerLatencyMs,1500);assert.equal(r.ok,false);
});

test('actual preparation session confirms two player ticks without writing or killing',async()=>{
  for(const armed of [false,true]){
    let subscribed;const record={experimentId:cfg.experimentId,armed,attempted:false};const memory=JSON.stringify({[SLOT]:record});
    let writes=0,kills=0;const files={};
    const io={binding:{userId:'u'},pubsub:{subscribe:async(ch,fn)=>{subscribed=fn;},publish:async(ch,p)=>subscribed.call({channel:ch},p)},assertIdentity:async()=>{},assertPausedStable:async()=>99,
      readState:async()=>({paused:true,tick:99}),pause:async()=> 'OK',killTree:async()=>{kills++;},readRuntimeMemory:async()=>memory,writeRuntimeMemory:async()=>{writes++;},
      resume:async()=>{for(const tick of [97,98]){const row={...sample(tick),kind:'lab-control-sample',expectedExperimentId:cfg.experimentId,sampler:{name:'lab-control-probe',version:'1'},user:{username:cfg.username},control:{status:'ok',record}};const e=envelope(row);subscribed.call({channel:e.channel},e.payload);}return 'OK';},
      finalSnapshot:async()=>({memory,state:{paused:true,tick:99},objects:[],transactions:[]}),
    };
    const result=await runSession(io,cfg,'control',armed,{audit(){},raw(){},file:(n,v)=>{files[n]=v;}});
    assert.equal(result.pausedForNextStage,true);assert.equal(files['roundtrip-result.json'].ready,true);assert.equal(writes,0);assert.equal(kills,0);
  }
});
