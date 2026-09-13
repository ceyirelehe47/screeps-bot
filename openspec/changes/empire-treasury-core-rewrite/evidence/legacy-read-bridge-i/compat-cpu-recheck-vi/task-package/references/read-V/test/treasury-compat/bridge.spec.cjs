'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { file, load, scene, BASE, guard, makeRoom, json } = require('./helpers.cjs');
const row = (s, kind = 'terminal') => s.report().endpoints.find(r => r.location === kind);

test('disabled profile never reads Game/Memory/builders/CPU, including module construction', () => {
  const api = load('treasuryCompatRead.ts');
  const unavailable = new Proxy({}, { get() { throw new Error('port touched'); } });
  const o = api.createTreasuryCompatPreview({ enabled: false }, unavailable);
  assert.equal(o.run().status, 'disabled');
});
for (const [name, value] of [ ['rooms', []], ['rooms', ['W1N1','W1N1']], ['rooms',['W1N1','W2N1','W3N1']],
  ['endTick', 99], ['endTick', 1301], ['startTick', NaN], ['intervalTicks', 1], ['resources', []], ['maxLogBytes', 100], ['maxSampleCpu', Infinity] ]) {
  test('invalid profile refuses: ' + name + '=' + JSON.stringify(value), () => {
    const s = scene({ [name]: value }); assert.equal(s.observer.run().status, 'invalid_config'); assert.equal(s.calls.readers,0); assert.equal(s.calls.memory,0);
  });
}
test('current fields retain explicit empty state, index values are not balances', () => {
  const s = scene(); assert.equal(s.observer.run().status,'sampled');
  const r=s.report(); assert.equal(r.legacyInputs.tasks.status,'empty'); assert.equal(r.legacyInputs.reservations.status,'empty');
  assert.equal(r.commitments.status,'read_complete'); assert.equal(r.commitments.rows[0].productionReserved,13);
  assert.equal(r.spendable,null); assert.equal(r.authorizesActions,false); assert.equal(r.facadeQueryRun,false); assert.equal(r.kernelLifecycleRun,false);
  assert.equal(row(s).coreComparison,'match_selected_scope');
});
for (const [status, mutate] of [ ['absent', m => delete m.data.resourceControl.tasks], ['invalid_container', m => m.data.resourceControl.tasks = null],
  ['invalid_container', m => m.data.resourceControl.tasks = []], ['invalid_parent', m => m.data = null],
  ['accessor_unreadable', m => Object.defineProperty(m.data.resourceControl,'tasks',{ get(){throw new Error('should not invoke');} })] ]) {
  test('missing/damaged table remains unavailable: '+status+' '+String(mutate), () => {
    const s=scene(); mutate(s.memory); assert.equal(s.observer.run().status,'sampled');
    assert.equal(s.report().legacyInputs.tasks.status,status); assert.equal(s.report().commitments.rows,null); assert.equal(s.calls.commitments,0);
  });
}
test('over-bound table does not aggregate a prefix; exact bound accepted', () => {
  const s=scene(); for(let i=0;i<257;i++)s.memory.data.resourceControl.tasks[i]={};
  s.observer.run(); assert.equal(s.report().legacyInputs.tasks.status,'over_bound'); assert.equal(s.calls.commitments,0);
  delete s.memory.data.resourceControl.tasks[256]; s.game.time=200; s.observer.run(); assert.equal(s.report().legacyInputs.tasks.count,256); assert.equal(s.calls.commitments,1);
});
test('existing Treasury core is not summarized as zero, even malformed or null', () => {
  for(const value of [null,{active:{a:{phase:'outcome_unknown'}}}]) {
    const s=scene();s.memory.runtime.treasuryCore=value;s.observer.run();assert.equal(s.report().legacyInputs.treasuryCore.status,'present_not_interpreted');assert.equal(s.report().legacyInputs.treasuryCore.activeCount,null);
  }
});
test('off-shard, early/late window and non-due tick use zero source reads', () => {
  for (const [tick,shard,status] of [[99,'test-shard','outside_window'],[1301,'test-shard','outside_window'],[101,'test-shard','not_due'],[100,'other','wrong_shard']]) {
    const s=scene();s.game.time=tick;s.game.shard.name=shard;assert.equal(s.observer.run().status,status);assert.equal(s.calls.readers+s.calls.memory+s.calls.room,0);
  }
});
test('low bucket and CPU headroom gate before reading state; legal next sample runs',()=>{
  const s=scene();s.bucket=1999;assert.equal(s.observer.run().status,'cpu_skipped');assert.equal(s.calls.memory,0);
  s.bucket=9000;s.cpuValue=96;s.game.time=200;assert.equal(s.observer.run().status,'cpu_skipped');assert.equal(s.calls.memory,0);
  s.cpuValue=0.1;s.game.time=300;assert.equal(s.observer.run().status,'sampled');
});
test('one attempt per tick and frozen profile scope',()=>{
  const rooms=['W1N1'];const s=scene({rooms});rooms.push('W2N1');s.observer.run();assert.deepEqual(s.report().scope.rooms,['W1N1']);
  const before=s.calls.readers;assert.equal(s.observer.run().status,'not_due');assert.equal(s.calls.readers,before);
});
test('new sample creates new reader instance, old writers need not bump new revision',()=>{
  const s=scene();s.observer.run();s.memory.data.resourceControl.tasks.x={amount:50};s.game.time=200;s.observer.run();assert.equal(s.calls.readers,2);assert.equal(s.lastInputs.tasks.x.amount,50);
});
test('8M storage comes from getCapacity and compares; no 1M hardcode',()=>{
  const s=scene();s.game.rooms.W1N1.storage.capState.cap=8000000;s.observer.run();assert.equal(row(s,'storage').direct.capacity,8000000);assert.equal(row(s,'storage').coreComparison,'match_selected_scope');
});
test('capacity drop with inventory above capacity is visible, no comparable old delta',()=>{
  const s=scene();const x=s.game.rooms.W1N1.storage;x.capState.cap=8000000;x.store.H=4400000;s.observer.run();
  x.capState.cap=1000000;s.game.time=200;s.observer.run();const r=row(s,'storage');assert.equal(r.direct.capacity,1000000);assert.equal(r.direct.overCapacity,true);assert.ok(r.direct.free<0);assert.equal(r.change.status,'endpoint_or_capacity_changed');
});
test('saturated free zero after shrink accepted without inventing capacity',()=>{
  const s=scene();const x=s.game.rooms.W1N1.storage;x.store.H=4400000;x.capState.saturated=true;s.observer.run();
  assert.equal(row(s,'storage').direct.capacity,1000000);assert.equal(row(s,'storage').direct.free,0);assert.equal(row(s,'storage').direct.overCapacity,true);
});
test('missing terminal is absence, not a zero amount',()=>{
  const s=scene();delete s.game.rooms.W1N1.terminal;s.observer.run();assert.equal(row(s).directStatus,'absent');assert.equal(row(s).coreComparison,'both_absent');assert.equal(row(s).direct,undefined);
});
test('unreadable endpoint is not included in snapshot input; other room is still readable',()=>{
  const s=scene({rooms:['W1N1','W2N1']});s.game.rooms.W2N1=makeRoom('W2N1');
  Object.defineProperty(s.game.rooms.W1N1.terminal.store,'getCapacity',{value:()=>null});s.observer.run();
  assert.equal(row(s).directStatus,'unreadable');assert.deepEqual(s.report().coreObservationRooms,['W2N1']);
});
test('NaN and inconsistent capacity never become normal',()=>{
  for(const f of [()=>NaN,()=>123]){const s=scene();Object.defineProperty(s.game.rooms.W1N1.terminal.store,'getCapacity',{value:f});s.observer.run();assert.equal(row(s).directStatus,'unreadable');}
});
test('independent sparse-builder mismatch is detected and legal next sample restores match',()=>{
  const s=scene();s.mutateObservation=o=>{o['W1N1:terminal'].amounts.H=800;};s.observer.run();assert.equal(row(s).coreComparison,'mismatch');assert.ok(row(s).coreMismatches.includes('H'));
  delete s.mutateObservation;s.game.time=200;s.observer.run();assert.equal(row(s).coreComparison,'match_selected_scope');
});
test('legacy projection comparison requires same tick, never yesterday as now',()=>{
  const s=scene();const x=s.game.rooms.W1N1.terminal;
  const legacy=s.memory.runtime.resourceControl={updatedAt:99,rooms:{W1N1:{terminalUsedCapacity:x.store.getUsedCapacity(),terminalFreeCapacity:x.store.getFreeCapacity(),terminalEnergy:999}}};
  s.observer.run();assert.equal(row(s).legacyProjection.status,'stale');legacy.updatedAt=200;s.game.time=200;s.observer.run();assert.equal(row(s).legacyProjection.status,'mismatch');
  legacy.updatedAt=300;legacy.rooms.W1N1.terminalEnergy=x.store.energy;s.game.time=300;s.observer.run();assert.equal(row(s).legacyProjection.status,'match_capacity_and_selected_energy');
});
test('unknown legacy projection values or future tick are explicitly unreadable/future',()=>{
  const s=scene();s.memory.runtime.resourceControl={updatedAt:101,rooms:{}};s.observer.run();assert.equal(row(s).legacyProjection.status,'future_tick');
  s.game.time=200;s.memory.runtime.resourceControl={updatedAt:200,rooms:{W1N1:{}}};s.observer.run();assert.equal(row(s).legacyProjection.status,'unreadable');
});
test('Memory immutable and identity preserved, no table normalization',()=>{
  const s=scene();const before=JSON.stringify(s.memory),counter={writes:0};const original=s.memory;s.memory=guard(s.memory,counter);s.observer.run();assert.equal(counter.writes,0);assert.equal(JSON.stringify(original),before);assert.equal(s.report().authorizesActions,false);
});
test('output limit emits valid omission without baseline; later delta cannot use unseen report',()=>{
  const s=scene({maxLogBytes:1024});s.observer.run();assert.equal(s.report().status,'output_limited');assert.equal(s.observer.stats().retainedEndpoints,0);assert.ok(Buffer.byteLength(s.lines[0])<=1024);
});
test('CPU cooperating budget stops further work and exposes partial result',()=>{
  const s=scene();s.step=0.8;assert.equal(s.observer.run().status,'partial_cpu_budget');assert.equal(s.report().cooperativeBudget,true);assert.equal(s.calls.commitments,0);
});
test('cost of serialization/emission is reported in following sample, not a hard cap',()=>{
  const s=scene();s.emitCost=3;s.observer.run();s.game.time=200;s.observer.run();assert.ok(s.report().previousRun.cpuIncludingEmit>=3);
});
test('logger and reader exceptions disable only preview and do not rethrow',()=>{
  const s=scene();s.throwEmit=true;assert.equal(s.observer.run().status,'fault_disabled');s.game.time=200;assert.equal(s.observer.run().status,'disabled_after_fault');
  const q=scene();q.ports.readers=()=>{throw new Error('boom');};assert.equal(q.observer.run().status,'fault_disabled');assert.equal(q.report().status,'fault_disabled');
});
test('long run retains one primitive snapshot; absolute end survives module reset',()=>{
  const s=scene();for(let i=1;i<=13;i++){s.game.time=i*100;s.observer.run();assert.ok(s.observer.stats().retainedEndpoints<=2);}
  s.game.time=1400;const again=s.api.createTreasuryCompatPreview(s.cfg,s.ports);assert.equal(again.run().status,'outside_window');assert.equal(again.stats().retainedEndpoints,0);
});
test('primitive deltas are not writer attribution or actual fees',()=>{
  const s=scene();s.observer.run();s.game.rooms.W1N1.terminal.store.H-=40;s.game.time=200;s.observer.run();assert.equal(row(s).change.status,'net_change_unattributed');assert.equal(row(s).change.amounts.H,-40);assert.equal(s.report().spendable,null);
});
test('UTF-8 JSON length agrees with Buffer oracle',()=>{
  const api=load('treasuryCompatRead.ts');for(const x of ['中文','🙂','a\\"\n','\ud800','e\u0301','👨‍👩‍👧‍👦']){const j=JSON.stringify({x});assert.equal(api.compatUtf8Bytes(j),Buffer.byteLength(j));}
});
test('runtime default is disabled, does not evaluate read capsule',()=>{
  const core=load('treasuryCompatRead.ts');const config=load('treasuryCompatConfig.ts');
  const runtime=load('treasuryCompatRuntime.ts',{}, {'./treasuryCompatConfig':config,'./treasuryCompatRead':core,
    './treasuryCompatReadCore.generated':{createCompatibilityReadCore(){throw new Error('must not initialize');}}});
  assert.equal(config.TREASURY_COMPAT_CONFIG.enabled,false);runtime.runTreasuryCompatRead();
});
