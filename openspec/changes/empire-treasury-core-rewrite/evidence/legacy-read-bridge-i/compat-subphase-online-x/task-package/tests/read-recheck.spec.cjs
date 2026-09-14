'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('./reader-fixture.cjs'),W=require('../runtime/samples.cjs'),V=require('../runtime/verify-run.cjs');
function one(opts={}){const f=H.fixture({probeCost:.001,...opts}),p={...H.profile(),endTick:400},v=H.loadReader().exports.createTreasuryCompatPreview(p,f.ports,{cpuDiagnostics:true});f.setTime(100);v.run();return{f,p,r:JSON.parse(f.logs[0])};}
test('attribution validator accepts complete synthetic profile',()=>{const x=one();assert.equal(W.attributionError(x.r.cpuProfile.attribution,x.r.cpuProfile.calls),null);});
test('unknown subphase is rejected',()=>{const x=one();x.r.cpuProfile.attribution.intervals.unknown=1;assert.equal(W.attributionError(x.r.cpuProfile.attribution,x.r.cpuProfile.calls),'CPU_ATTRIBUTION_VALUE_INVALID');});
test('negative work count is rejected',()=>{const x=one();x.r.cpuProfile.attribution.work.commitmentTaskRecords=-1;assert.equal(W.attributionError(x.r.cpuProfile.attribution,x.r.cpuProfile.calls),'CPU_ATTRIBUTION_VALUE_INVALID');});
test('incomplete boundaries reject full sample',()=>{const x=one();x.r.cpuProfile.attribution.boundaries=11;assert.equal(W.sampleError(x.r,x.p),'ATTRIBUTION_SAMPLE_INCOMPLETE');});
test('partial projection work rejects full sample',()=>{const x=one();x.r.cpuProfile.attribution.work.projectionRowsCompleted=3;assert.equal(W.sampleError(x.r,x.p),'ATTRIBUTION_SAMPLE_INCOMPLETE');});
test('duplicate commitment row rejects full sample',()=>{const x=one();x.r.commitments.rows[3]=structuredClone(x.r.commitments.rows[0]);assert.equal(W.sampleError(x.r,x.p),'COMMITMENT_ROW_INVALID');});
test('core mismatch remains diagnostic failure',()=>{const x=one();x.r.endpoints[0].coreComparison='mismatch';assert.equal(W.diagnosticError(x.r,x.p,0),'CORE_COMPARISON_MISMATCH');});
test('legacy projection mismatch does not falsify direct/core match',()=>{const x=one();x.r.endpoints[0].legacyProjection={status:'mismatch',mismatches:['terminalEnergy']};assert.equal(W.sampleError(x.r,x.p),null);});
test('summarize retains attribution and primitive work',()=>{const x=one(),s=V.summarize([x.r],x.p);assert.equal(s.rows[0].attribution.boundaries,12);assert.equal(s.workRows[0].work.projectionIndexQueries,16);});
test('last sample tail remains unobservable without successor',()=>{const x=one(),s=V.summarize([x.r],x.p);assert.equal(s.rows[0].completeProfileReportedBySuccessor,null);});
