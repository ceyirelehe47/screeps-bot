'use strict';
/** These tests REQUIRE the generated pinned production readers. There is no
 * mock/fallback implementation and no skip-if-missing path. Run after assembly. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, file, scene, guard, json } = require('./helpers.cjs');
assert.ok(fs.existsSync(file('treasuryCompatReadCore.generated.ts')), 'run the pinned candidate assembler before real-readers tests');
const rrow = (s,resource='H') => s.report().commitments.rows.find(r=>r.room==='W1N1'&&r.resource===resource);
const task = (overrides={}) => ({id:'legacy-task-1',origin:'manual',status:'pending',resource:'H',fromRoomName:'W1N1',toRoomName:'W2N1',
  amount:100,remainingAmount:70,createdAt:50,updatedAt:90,lastProgressAt:90,...overrides});
const reservation = (overrides={}) => ({roomName:'W1N1',resource:'H',holderId:'synthesis:W1N1:H',amount:40,updatedAt:90,expiresAt:500,...overrides});

test('pinned runtime graph contains only read dependencies and no facade, kernel, Defense or old writer',()=>{
  const m=JSON.parse(fs.readFileSync(path.join(ROOT,'docs/treasury-compat-source-manifest.json'),'utf8'));
  assert.equal(m.sourceCommit,'01bd9831454950c4928df98dd8679692b55603e5');
  for(const s of m.sourceManifest){assert.ok(m.allowedRuntimeSources.includes(s.path));assert.ok(!/facade|\/kernel\/|runtimeServices|resourceReservation\.ts|Defense|defense/.test(s.path));}
  assert.ok(m.sourceManifest.length>0&&m.sourceManifest.length<=8);
  const s=scene({},true);assert.deepEqual(Object.keys(s.core),['createCompatibilityReadCore']);assert.deepEqual(Object.keys(s.core.createCompatibilityReadCore()).sort(),['buildCommitments','buildObservation']);
});
test('actual observation/index on empty legacy tables, no new Memory keys or writes',()=>{
  const s=scene({},true);const raw=s.memory,before=JSON.stringify(raw),count={writes:0};s.memory=guard(raw,count);
  assert.equal(s.observer.run().status,'sampled');assert.equal(s.report().commitments.status,'read_complete');
  assert.equal(rrow(s).outgoing,0);assert.equal(rrow(s).productionReserved,0);
  assert.equal(count.writes,0);assert.equal(JSON.stringify(raw),before);assert.equal(raw.runtime.treasuryCore,undefined);assert.equal(raw.runtime.resourceReservationsOwnerVersion,undefined);
});
test('actual canonical readers count nonempty legacy task and unversioned reservation without migration',()=>{
  const s=scene({},true);s.memory.data.resourceControl.tasks['id']=task();s.memory.runtime.resourceReservations['W1N1:H:synthesis:W1N1:H']=reservation();
  const raw=s.memory,before=JSON.stringify(raw),counter={writes:0};s.memory=guard(raw,counter);
  assert.equal(s.observer.run().status,'sampled');assert.equal(rrow(s).outgoing,70);assert.equal(rrow(s).productionReserved,40);
  assert.equal(counter.writes,0);assert.equal(JSON.stringify(raw),before);assert.equal(s.report().spendable,null);
});
test('old writer mutates same reservation/table identity without revision bump, next sample sees it',()=>{
  const s=scene({},true);const t=task(),r=reservation();s.memory.data.resourceControl.tasks['id']=t;s.memory.runtime.resourceReservations.r=r;
  s.observer.run();assert.equal(rrow(s).outgoing,70);assert.equal(rrow(s).productionReserved,40);
  t.remainingAmount=25;r.amount=10;s.game.time=200;s.observer.run();assert.equal(rrow(s).outgoing,25);assert.equal(rrow(s).productionReserved,10);assert.equal(s.calls.readers,2);
});
test('expired reservation excluded by canonical read predicate, original record not deleted',()=>{
  const s=scene({},true);s.memory.runtime.resourceReservations.r=reservation({expiresAt:150});s.observer.run();assert.equal(rrow(s).productionReserved,40);
  s.game.time=200;s.observer.run();assert.equal(rrow(s).productionReserved,0);assert.ok(s.memory.runtime.resourceReservations.r);
});
test('unresolved owner remains reserved rather than silently orphan-released',()=>{
  const s=scene({},true);s.memory.runtime.resourceReservations.r=reservation({holderId:'legacy-owner-opaque'});s.observer.run();assert.equal(rrow(s).productionReserved,40);
});
test('malformed record reaches original completeness logic and is not normalized/deleted',()=>{
  for(const mutate of [m=>m.data.resourceControl.tasks.bad=null,m=>m.runtime.resourceReservations.bad=null]){
    const s=scene({},true);mutate(s.memory);const before=JSON.stringify(s.memory);s.observer.run();assert.equal(s.report().commitments.status,'read_incomplete');assert.equal(s.report().commitments.completeness.complete,false);assert.equal(JSON.stringify(s.memory),before);
  }
});
test('explicit foreign kernel state is preserved without lifecycle or interpretation',()=>{
  const s=scene({},true);s.memory.runtime.treasuryCore={version:3,active:{x:{phase:'outcome_unknown'}}};const raw=s.memory,before=JSON.stringify(raw),c={writes:0};s.memory=guard(raw,c);s.observer.run();assert.equal(s.report().legacyInputs.treasuryCore.activeCount,null);assert.equal(c.writes,0);assert.equal(JSON.stringify(raw),before);
});
test('8M and then reduced capacity use actual observation functions and invalidate only diagnostic delta',()=>{
  const s=scene({},true);const x=s.game.rooms.W1N1.storage;x.capState.cap=8000000;x.store.H=4400000;
  s.observer.run();let row=s.report().endpoints.find(r=>r.location==='storage');assert.equal(row.coreComparison,'match_selected_scope');assert.equal(row.direct.capacity,8000000);
  x.capState.cap=1000000;s.game.time=200;s.observer.run();row=s.report().endpoints.find(r=>r.location==='storage');assert.equal(row.direct.overCapacity,true);assert.equal(row.change.status,'endpoint_or_capacity_changed');assert.equal(row.coreComparison,'match_selected_scope');
});
test('missing table is NOT replaced with empty object before invoking canonical index',()=>{
  const s=scene({},true);delete s.memory.data.resourceControl.tasks;s.observer.run();assert.equal(s.report().legacyInputs.tasks.status,'absent');assert.equal(s.report().commitments.status,'unavailable_legacy_input');assert.equal(s.report().commitments.rows,null);
});
