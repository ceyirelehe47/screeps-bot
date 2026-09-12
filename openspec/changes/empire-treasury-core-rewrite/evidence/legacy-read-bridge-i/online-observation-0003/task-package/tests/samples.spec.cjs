'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const F=require('./fixture.cjs'),W=require('../runtime/samples.cjs'),K=require('../runtime/policy.cjs'),C=require('../runtime/common.cjs');
test('twelve source-shaped reports retain eleven attributable post-emit CPU costs',()=>{const s=F.makeSession(),r=W.validateSequence(F.allSamples(s),s.profile);assert.equal(r.complete,true);assert.equal(r.cpuIncludingEmit.length,11);assert.equal(r.finalSampleCpuIncludingEmit,'not_observable_with_frozen_reader');});
for(const [name,mutate,code] of [
 ['authority',r=>r.spendable=100,'SAMPLE_AUTHORITY_CHANGED'],['partial CPU',r=>r.status='partial_cpu_budget','SAMPLE_NOT_COMPLETE'],
 ['output limit',r=>r.status='output_limited','SAMPLE_NOT_COMPLETE'],['missing table',r=>r.legacyInputs.tasks.status='absent','LEGACY_TABLE_UNAVAILABLE'],
 ['damaged table',r=>r.legacyInputs.tasks.status='invalid_container','LEGACY_TABLE_UNAVAILABLE'],['table over-bound',r=>r.legacyInputs.reservations.count=257,'LEGACY_TABLE_UNAVAILABLE'],
 ['observation mismatch',r=>r.endpoints[0].coreComparison='mismatch','CORE_OBSERVATION_MISMATCH'],
 ['duplicate endpoint',r=>r.endpoints[1]=r.endpoints[0],'ENDPOINT_DUPLICATE_OR_MISSING'],
 ['invalid capacity',r=>r.endpoints[0].direct.free=1,'DIRECT_ENDPOINT_INVALID'],
 ['incomplete commitment',r=>r.commitments.completeness.complete=false,'COMMITMENTS_INCOMPLETE'],
 ['duplicate commitment',r=>r.commitments.rows[1]=r.commitments.rows[0],'COMMITMENT_ROW_INVALID'],
 ['wrong scope',r=>r.scope.rooms=['E3N59'],'SAMPLE_SCOPE_MISMATCH'],
 ['wrong source',r=>r.sourceCommit='d'.repeat(40),'SAMPLE_SOURCE_MISMATCH'],
 ['CPU budget',r=>r.cpuBeforeSerializationAndEmit=2,'SAMPLE_CPU_BUDGET']
])test('rejects '+name,()=>{const s=F.makeSession(),r=F.sample(s,0);mutate(r);assert.equal(W.sampleError(r,s.profile),code);});
test('a missing scheduled sample cannot be repaired by another tick',()=>{const s=F.makeSession(),a=F.allSamples(s);a.splice(5,1);assert.equal(W.validateSequence(a,s.profile).complete,false);});
test('heap reset and CPU overrun are rejected by previousRun linkage',()=>{const s=F.makeSession(),a=F.allSamples(s);a[7].previousRun=null;assert.equal(W.validateSequence(a,s.profile).complete,false);a[7].previousRun={tick:a[6].tick,cpuIncludingEmit:6};assert.equal(W.validateSequence(a,s.profile).complete,false);});
test('fresh binding is computed from execution-time tick rather than a literal window',()=>{const a=K.profileFor(73635026),b=K.profileFor(73637026);assert.equal(b.startTick-a.startTick,2000);assert.equal(a.endTick-a.startTick,1100);assert.ok(a.startTick>=73635026+150);assert.equal(K.dueTicks(a).length,12);});
test('configuration limits cannot be enlarged',()=>{const p=K.profileFor(1000);p.rooms.push('E5N59');assert.throws(()=>K.renderConfig(p),{code:'FORMAL_PROFILE_INVALID'});});
test('WebSocket watch pins authentication, shard and duplicate identity',()=>{const s=F.makeSession(),w=W.createWatch(s,12,100);w.frame('auth ok',101);const r=F.sample(s,0),frame=x=>JSON.stringify([`user:${s.userId}/console`,{shard:'shard1',messages:{log:[JSON.stringify(x)],results:[]}}]);w.frame(frame(r),102);w.frame(frame(r),103);assert.equal(w.state.bridgeReports,1);assert.equal(w.state.duplicateSamples,1);r.cpuBeforeSerializationAndEmit=0.7;w.frame(frame(r),104);assert.equal(w.state.stopReason,'CONFLICTING_DUPLICATE_SAMPLE');});
test('channel freshness requires actual CPU rather than merely a memory field',()=>{const s=F.makeSession(),w=W.createWatch(s,12,100);w.frame('auth ok',101);w.frame(JSON.stringify([`user:${s.userId}/cpu`,{memory:100}]),102);assert.equal(w.state.lastCpuAtMs,null);});
test('an unknown deploy identity during observation is rejected immediately',()=>{const s=F.makeSession(),w=W.createWatch(s,12);w.frame('auth ok');w.frame(JSON.stringify([`user:${s.userId}/console`,{shard:s.shard,messages:{log:['[deploy] foreign-code'],results:[]}}]));assert.equal(w.state.stopReason,'UNEXPECTED_DEPLOY_IDENTITY');});
test('missing aggregate commitment-health fields are not fabricated as healthy zeros',()=>{const s=F.makeSession(),r=F.sample(s,0);delete r.commitments.completeness.invalidRecords;assert.equal(W.sampleError(r,s.profile),'COMMITMENTS_INCOMPLETE');});
