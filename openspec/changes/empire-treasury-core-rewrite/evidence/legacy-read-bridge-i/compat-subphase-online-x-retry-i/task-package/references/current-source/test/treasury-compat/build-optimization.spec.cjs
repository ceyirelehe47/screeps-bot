'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const S = require('./build-test-support.cjs');
const { H, beforeText, afterText, make, build, snapshot, task, reservation } = S;
const G = require('../../scripts/build-treasury-compat-loader.cjs');
function pair(setup, extra) {
  const a = make(beforeText()), b = make(afterText()); setup(a); setup(b);
  const ga={writes:0},gb={writes:0}; a.memory=H.guard(a.memory,ga);b.memory=H.guard(b.memory,gb);
  const x = snapshot(build(a,extra?.(a))), y = snapshot(build(b,extra?.(b)));
  assert.deepEqual(y,x); assert.deepEqual([ga.writes,gb.writes],[0,0]);return {a,b,x,y};
}
test('build VII baseline is exact committed Read V core, not a reconstructed model',()=>{
  const b=Buffer.from(beforeText());assert.equal(G.blob(b),'fe94ebece8f5118b76701007ce3906adfbb4da08');assert.equal(b.length,64266);
});
test('build VII reversible authoring restores all Read V bytes before the unchanged loader',()=>{
  const marker='/** Read Optimization V:';
  assert.equal(G.B.restore(afterText().split(marker)[0]),beforeText().split(marker)[0]);
  assert.equal(afterText().split(marker)[1],beforeText().split(marker)[1]);
  assert.equal(G.main(['--check']).status,'COMPAT_LOADER_REGENERATION_VERIFIED');
});
test('build VII shifted source is rejected rather than approximately transformed',()=>{
  assert.throws(()=>G.B.transform(beforeText().replace('const outgoing = new Map();','const outgoing = new Map([]);')),/BUILD_TRANSFORM_COUNT/);
  assert.throws(()=>G.B.restore(afterText().replace('outBucket.outgoing = mergedOutgoing;','outBucket.outgoing = 0;')),/BUILD_TRANSFORM_COUNT/);
});
for (const n of Object.keys(S.S.scenarios)) test('build VII Read V to VII twelve-sample byte parity: '+n,()=>{
  const x=S.compareScenario(n); assert.equal(x.byteEquivalent,true); assert.deepEqual(x.writes,[0,0]);assert.equal(x.reports,12);
  assert.deepEqual(x.readers,[12,12]);assert.equal(x.oldFactoryExecutions,7);assert.equal(x.newFactoryExecutions,7);
});
test('build VII nonempty full task index reduces map work without skipping eager secondary indexes',()=>{
  const [a,b]=S.operationCounts(37); assert.deepEqual(b.semantics,a.semantics);
  assert.deepEqual(a.commitment,{mapNew:11,mapGet:333,mapSet:334,mapHas:37,entryCalls:0,entryPairs:0,keysCalls:2,valuesCalls:2,roomCloneCalls:0});
  assert.deepEqual(b.commitment,{mapNew:5,mapGet:185,mapSet:42,mapHas:37,entryCalls:0,entryPairs:0,keysCalls:2,valuesCalls:2,roomCloneCalls:0});
});
test('build VII empty tables avoid six maps but retain all queries and completeness',()=>{
  const [a,b]=S.operationCounts(0);assert.deepEqual(a.semantics,b.semantics);assert.equal(a.commitment.mapNew,10);assert.equal(b.commitment.mapNew,4);
});
test('build VII observation removes 136 entry pairs and two room clones without reducing Store enumeration',()=>{
  const [a,b]=S.operationCounts(0,32);assert.deepEqual(a.semantics.observation,b.semantics.observation);
  assert.equal(a.observation.entryPairs,136);assert.equal(b.observation.entryPairs,0);
  assert.equal(a.observation.roomCloneCalls,2);assert.equal(b.observation.roomCloneCalls,0);
  // 4 live Store enumerations remain; 4 snapshot key lists replace entry pairs.
  assert.equal(a.observation.keysCalls,4);assert.equal(b.observation.keysCalls,8);
});
test('build VII self routes alias scope buckets without double-counting their different fields',()=>{
  const {y}=pair(s=>{s.memory.data.resourceControl.tasks={one:task({fromRoomName:'W1N1',toRoomName:'W1N1',remainingAmount:70}),two:task({fromRoomName:'W1N1',toRoomName:'W1N1',remainingAmount:20})};});
  const h=y.rows.find(x=>x.room==='W1N1'&&x.resource==='H');assert.equal(h.outgoing,90);assert.equal(h.incoming,90);assert.equal(h.pendingIncoming,90);
});
test('build VII reciprocal routes reuse buckets while preserving direction and room counts',()=>{
  pair(s=>{s.memory.data.resourceControl.tasks={a:task({id:'a',reason:'reason-a'}),b:task({id:'b',reason:'reason-b',fromRoomName:'W2N1',toRoomName:'W1N1',remainingAmount:31})};});
});
test('build VII duplicate route keeps the first canonical task id',()=>{
  const {b}=pair(s=>{s.memory.data.resourceControl.tasks={z:task({id:'first',reason:'reason-a'}),a:task({id:'later',reason:'reason-a'})};});
  assert.equal(build(b).index.findMergeableTaskId('H','W1N1','W2N1','manual','reason-a'),'first');
});
test('build VII integer-like table keys keep Object.values route order',()=>{
  const {b}=pair(s=>{s.memory.data.resourceControl.tasks={20:task({id:'twenty'}),2:task({id:'two'}),a:task({id:'letter'})};});
  assert.equal(build(b).index.findMergeableTaskId('H','W1N1','W2N1','manual',''),'two');
});
for (const mode of ['outgoing','pendingIncoming','self-route','different-resource','reservations']) test('build VII safe-integer overflow parity: '+mode,()=>{
  const {y}=pair(s=>{
    const huge=Number.MAX_SAFE_INTEGER;
    s.memory.data.resourceControl.tasks={a:task({id:'a',amount:huge,remainingAmount:huge,reason:'reason-a'}),b:task({id:'b',reason:'reason-b',remainingAmount:1})};
    if(mode==='pendingIncoming')s.memory.data.resourceControl.tasks.b.fromRoomName='W3N1';
    if(mode==='self-route')for(const t of Object.values(s.memory.data.resourceControl.tasks))t.toRoomName='W1N1';
    if(mode==='different-resource')s.memory.data.resourceControl.tasks.b.resource='U';
    if(mode==='reservations'){s.memory.data.resourceControl.tasks={};s.memory.runtime.resourceReservations={a:reservation({amount:huge}),b:reservation({amount:1})};}
  });assert.equal(y.completeness.complete,mode==='different-resource');
});
for (const mode of ['automatic-stale','receiver-blocked','source-blocked','nonpending','zero']) test('build VII canonical health and status behavior: '+mode,()=>{
  pair(s=>{s.game.time=5000;const t=task({origin:'automatic',reason:'reason-a'});s.memory.data.resourceControl.tasks={a:t};
    if(mode==='receiver-blocked'){t.blockedReason='receiver_capacity';t.blockedSince=4999;}
    if(mode==='source-blocked'){t.blockedReason='source_depleted';t.blockedSince=1;}
    if(mode==='nonpending')t.status='done';if(mode==='zero')t.remainingAmount=0;
  });
});
test('build VII invalid records retain both scope and global incomplete outcomes',()=>{
  pair(s=>{s.memory.data.resourceControl.tasks={good:task(),fromMissing:task({fromRoomName:''}),resourceUnknown:task({resource:'invalid'}),damaged:null};
    s.memory.runtime.resourceReservations={bad:null,r:reservation({resource:'U'})};});
});
test('build VII all task values are still enumerated even outside the diagnostic resource scope',()=>{
  const {y}=pair(s=>{s.memory.data.resourceControl.tasks={a:task(),u:task({resource:'U',remainingAmount:-1})};});
  assert.equal(y.metrics.taskRecords,2);assert.equal(y.completeness.complete,false);
  assert.equal(y.rows.find(x=>x.room==='W1N1'&&x.resource==='H').completeness,'complete');
});
test('build VII owner identity, conservative commitment and exact expiry behavior are unchanged',()=>{
  pair(s=>{s.memory.runtime.resourceReservations={a:reservation({holderId:'same-id',owner:{kind:'task',id:'same-id'},amount:20}),b:reservation({holderId:'same-id',owner:{kind:'contract',id:'same-id'},amount:30}),c:reservation({expiresAt:100}),d:reservation({expiresAt:99}),e:reservation({holderId:'missing'})};});
});
test('build VII callback order and receiver identity for reservation diagnostics are unchanged',()=>{
  const traces=[];
  for(const text of [beforeText(),afterText()]){
    const s=make(text),r=s.core.createCompatibilityReadCore(),trace=[];
    const observation=r.buildObservation({scope:'market-fresh',epochSeq:1,rooms:Object.values(s.game.rooms)});
    const options={tick:100,tasks:{},reservations:{a:reservation({expiresAt:99}),b:reservation({holderId:'missing'}),c:reservation()},observation,
      holderExists(id){trace.push(['holder',id]);return false;},onExpiredExcluded(){trace.push(['expired',this===options]);},onMissingOwnerCommitted(){trace.push(['missing',this===options]);}};
    const index=r.buildCommitments(options);traces.push({trace,snap:snapshot({observation,index})});
  }assert.deepEqual(traces[1],traces[0]);
});
test('build VII receiver capacity callbacks remain live, ordered and uncached',()=>{
  const logs=[];for(const text of [beforeText(),afterText()]){
    const s=make(text);let d=0;const trace=[];
    const b=build(s,{index:{capacityDelta:(r,k)=>{trace.push(['risk',r,k]);return d;},strictCapacityDelta:(r,k)=>{trace.push(['strict',r,k]);return d/2;}}});
    const one=H.json(b.index.receiverCommitments('W1N1'));d=120;const two=H.json(b.index.receiverCommitments('W1N1'));
    assert.equal(one.projectedTerminalHeadroom-two.projectedTerminalHeadroom,120);logs.push({one,two,trace});
  }assert.deepEqual(logs[1],logs[0]);
});
test('build VII rebuilding same builder never returns an earlier task or observation snapshot',()=>{
  for(const text of [beforeText(),afterText()]){
    const s=make(text);s.memory.data.resourceControl.tasks.t=task();const r=s.core.createCompatibilityReadCore(),a=build(s,{},r);
    s.memory.data.resourceControl.tasks.t.remainingAmount=13;s.game.rooms.W1N1.storage.store.H=7;const b=build(s,{},r);
    assert.equal(a.index.outgoing('W1N1','H'),70);assert.equal(b.index.outgoing('W1N1','H'),13);assert.equal(a.observation.amount('W1N1','storage','H'),300);assert.equal(b.observation.amount('W1N1','storage','H'),7);
    assert.notEqual(a.index.metrics,b.index.metrics);assert.notEqual(a.observation.data,b.observation.data);
  }
});
test('build VII interleaved builders keep separate resource catalogs and task buckets',()=>{
  for(const text of [beforeText(),afterText()]){
    const s=make(text);s.resources=['H'];const a=s.core.createCompatibilityReadCore();s.resources=['energy'];const b=s.core.createCompatibilityReadCore();s.memory.data.resourceControl.tasks.t=task();
    assert.equal(build(s,{},a).index.completeness.complete,true);assert.equal(build(s,{},b).index.completeness.complete,false);assert.equal(build(s,{},a).index.outgoing('W1N1','H'),70);
  }
});
test('build VII frozen observation data and cached resource views have unchanged identities',()=>{
  for(const text of [beforeText(),afterText()]){
    const s=make(text),o=build(s).observation;assert.ok(Object.isFrozen(o.data));assert.ok(Object.isFrozen(o.data.rooms[0]));assert.ok(Object.isFrozen(o.location('W1N1','storage').amounts));
    assert.equal(o.roomResources('W1N1'),o.roomResources('W1N1'));assert.equal(o.empireResources(),o.empireResources());
    assert.throws(()=>{o.data.rooms[0].roomName='other';});assert.notEqual(o.location('unknown','storage'),o.location('unknown','storage'));
  }
});
test('build VII observation callbacks precede totals as before, and post-scan live changes do not alter snapshots',()=>{
  const out=[];for(const text of [beforeText(),afterText()]){
    const s=make(text),r=s.core.createCompatibilityReadCore(),trace=[];
    const options={scope:'market-fresh',epochSeq:1,rooms:Object.values(s.game.rooms),onStoreScanned(n){trace.push([n,this===options]);s.game.rooms.W1N1.storage.store.H=999;}};
    const o=r.buildObservation(options);out.push({trace,data:H.json(o.data)});assert.equal(o.amount('W1N1','storage','H'),300);
  }assert.deepEqual(out[1],out[0]);
});
test('build VII sparse key ordering, nonfinite positives and unusual own names preserve canonical results',()=>{
  pair(s=>{const x=s.game.rooms.W1N1.storage.store;x['10']=10;x['2']=2;x.O=0;x.U=-1;x.inf=Infinity;
    Object.defineProperty(x,'hidden',{value:42});Object.defineProperty(x,'__proto__',{value:3,enumerable:true});x[Symbol('resource')]=5;});
});
test('build VII duplicate room names preserve totals, ordinal list and last map entry',()=>{
  const outs=[];for(const text of [beforeText(),afterText()]){
    const s=make(text),r=s.core.createCompatibilityReadCore(),a=H.makeRoom(),b=H.makeRoom();b.storage.store.H=19;
    const o=r.buildObservation({scope:'market-fresh',epochSeq:1,rooms:[a,b]});outs.push({data:H.json(o.data),names:H.json(o.roomNames()),h:o.amount('W1N1','storage','H')});
  }assert.deepEqual(outs[1],outs[0]);assert.equal(outs[1].h,19);
});
test('build VII snapshot totals do not reread live Store values or reuse direct output',()=>{
  const a=S.S.measureStoreReads(beforeText()),b=S.S.measureStoreReads(afterText());
  assert.deepEqual(b.methods,a.methods);assert.equal(b.line,a.line);assert.equal(b.directStorePropertyReads,4);assert.equal(b.coreStorePropertyReads,12);
});
test('build VII stable accessor and non-enumerable table entries preserve complete index results',()=>{
  pair(s=>{const tasks={a:task({id:'a'})};Object.defineProperty(tasks,'hidden',{value:task({remainingAmount:3})});Object.defineProperty(tasks,'accessor',{enumerable:true,get(){return task({remainingAmount:5});}});s.memory.data.resourceControl.tasks=tasks;});
});
test('build VII same-key malformed aliases retain original scope query semantics',()=>{
  for(const text of [beforeText(),afterText()]){
    const s=make(text);s.resources=['H','x\0H'];s.memory.data.resourceControl.tasks={a:task({fromRoomName:'A\0x',toRoomName:'A\0x'}),b:task({fromRoomName:'A',toRoomName:'A',resource:'x\0H',remainingAmount:5})};
    const i=build(s).index;assert.equal(i.outgoing('A\0x','H'),75);assert.equal(i.outgoing('A','x\0H'),75);assert.equal(i.pendingIncoming('A','x\0H'),75);
  }
});
test('build VII seeded differential corpus covers full indexes across 128 independent snapshots',()=>{
  const a=make(beforeText()),b=make(afterText());
  for(let seed=1;seed<=128;seed++){
    const v=S.deterministicCorpus(seed,seed%2?37:256);a.memory.data.resourceControl.tasks=H.json(v.tasks);b.memory.data.resourceControl.tasks=H.json(v.tasks);
    a.memory.runtime.resourceReservations=H.json(v.reservations);b.memory.runtime.resourceReservations=H.json(v.reservations);
    a.game.time=b.game.time=100+seed;assert.deepEqual(snapshot(build(b)),snapshot(build(a)), 'seed='+seed);
  }
});
test('build VII semantic negative control catches lost outgoing aggregation',()=>{
  const text=afterText().replace('outBucket.outgoing = mergedOutgoing;','outBucket.outgoing = 0;');const a=make(beforeText()),b=make(text);
  a.memory.data.resourceControl.tasks.t=task();b.memory.data.resourceControl.tasks.t=task();assert.notDeepEqual(snapshot(build(a)),snapshot(build(b)));
});
test('build VII semantic negative control catches last-route-wins corruption',()=>{
  const text=afterText().replace('if (!mergeIndex.has(mergeKey)) {','if (true) {');const a=make(beforeText()),b=make(text);
  for(const s of [a,b])s.memory.data.resourceControl.tasks={a:task({id:'first'}),b:task({id:'last'})};assert.notDeepEqual(snapshot(build(a)),snapshot(build(b)));
});
test('build VII baseline fixture proves no preview or CPU checkpoint source edits accompanied VII',()=>{
  const read=path.join(__dirname,'fixtures/reader-before-subphase-attribution-ix.ts.txt');
  const b=require('node:fs').readFileSync(read,'utf8').replace(/\r\n/g,'\n');
  assert.equal(crypto.createHash('sha256').update(b).digest('hex'),'1141250ec31c12b3439f48b6274267c108c7bb95566d328414f4bd04275bef64');
});
