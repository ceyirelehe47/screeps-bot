'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const A=require('../../tools/assemble-evidence.cjs');

function result(){return {durationMs:1500460,timeChannel:{totalSuccessfulReads:99,totalFailedCycles:1,consecutiveFailedCycles:0},
  heartbeatEvidence:{rows:287,spanMs:1495086,medianGapMs:5097,p95GapMs:5600,maximumGapMs:10033,extendedGapCount:1},
  collectorPid:32772,firstTick:73636421,lastTick:73636790,codeWriteRequests:0};}

test('generated report uses the independent-verification labels without claiming deployment',()=>{
  const text=A.renderReport(result(),{status:'EXISTING_GUARD_JOINT_PROBE_EVIDENCE_INDEPENDENTLY_READJUDICATED'},'a'.repeat(64));
  for(const marker of ['GUARD_COLLECTOR_CONTROL_PLANE_PROBE_INDEPENDENTLY_VERIFIED','EXISTING_EVIDENCE_READJUDICATED','NOT_DEPLOYED'])assert.ok(text.includes(marker));
  assert.equal(text.includes('ONLINE_COMPAT_READ_OBSERVED'),false);assert.equal(text.includes('TREASURY_PRODUCTION_READY'),false);
});

test('generated report preserves the source procedural deviation and no-rerun boundary',()=>{
  const text=A.renderReport(result(),{status:'EXISTING_GUARD_JOINT_PROBE_EVIDENCE_INDEPENDENTLY_READJUDICATED'},'b'.repeat(64));
  assert.ok(text.includes('non-material procedural deviation'));
  assert.ok(text.includes('no collector restart'));
  assert.ok(text.includes('no 25-minute rerun'));
  assert.ok(text.includes('raw failure artifact remains unchanged'));
});
