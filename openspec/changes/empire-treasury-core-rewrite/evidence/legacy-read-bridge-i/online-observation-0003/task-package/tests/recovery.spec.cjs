'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const F=require('./fixture.cjs'),R=require('../runtime/recovery-worker.cjs'),W=require('../runtime/samples.cjs');
function situation(){const s=F.makeSession(),now=Date.now(),w=W.createWatch(s,9,now);w.frame('auth ok',now);w.frame(JSON.stringify([`user:${s.userId}/console`,{shard:s.shard,messages:{log:[],results:[]}}]),now);w.frame(JSON.stringify([`user:${s.userId}/cpu`,{cpu:50}]),now);return {s,h:w.state,now,attempt:{startedAtMs:now},upload:{result:{confirmed:true}},elapsed:0,tick:s.profile.startTick-10,closing:false};}
test('normal active observation does not ask for restore',()=>assert.equal(R.termination(situation()),null));
for(const[n,edit,expect]of[
 ['explicit close',x=>x.closing=true,'EXPLICIT_CLOSE'],['wall deadline',x=>x.elapsed=x.s.wallLimitMs,'WALL_DEADLINE'],
 ['stale collector',x=>x.h.updatedAtMs-=10001,'COLLECTOR_HEARTBEAT_STALE'],['stale CPU',x=>x.h.lastCpuAtMs-=45001,'COLLECTOR_CHANNEL_STALE'],
 ['uncertain upload',x=>x.upload.result.confirmed=false,'UPLOAD_UNCONFIRMED'],['all twelve samples',x=>{x.h.lastBridgeTick=x.s.profile.endTick;x.h.bridgeReports=12;},'LAST_SAMPLE_RECEIVED'],
 ['window expired with delivery grace exhausted',x=>x.tick=x.s.profile.endTick+21,'TICK_WINDOW_ENDED'],
 ['missing samples',x=>x.tick=x.s.profile.startTick+201,'BRIDGE_SAMPLE_STALLED']
])test('recovery closes on '+n,()=>{const x=situation();edit(x);assert.equal(R.termination(x),expect);});
test('one late tick after end does not race the final console frame',()=>{const x=situation();x.tick=x.s.profile.endTick+1;x.h.lastBridgeTick=x.s.profile.endTick-100;assert.equal(R.termination(x),null);});
