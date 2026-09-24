'use strict';
// All retries in this module are read-only and precede the ONE binding/POST boundary.
// Each calibration round is retained separately; no failed proposal is overwritten.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./common.cjs');
const T = require('./time-budget.cjs');
const I = require('./identity.cjs');
const P = C.POLICY, S = P.selection;
const file = (dir, name) => path.join(dir, 'window-selection', name);
const roundName = n => 'round-' + String(n).padStart(2, '0');
const transient = e => ['HTTP_DEADLINE','HTTP_TRANSPORT_ERROR','HTTP_BODY_ABORTED',
  'HTTP_BODY_ERROR','HTTP_REQUEST_FAILED','HTTP_TRANSIENT_STATUS'].includes(C.code(e));
const recalibrate = e => ['TICK_RATE_MEASUREMENT_INCONCLUSIVE','TICK_RATE_EVIDENCE_STALE',
  'TICK_PROGRESS_STALLED','SELECTION_STEP_DEADLINE'].includes(C.code(e));
const stamp = c => ({atMs:c.wall(), monoMs:c.mono()});
function profileFor(t) { return require('../tools/repository.cjs').profileFor(t); }
function startRecord(c) {
  return {kind:'pre-binding-selection/v1',runId:P.parentRunId,clockId:c.id,pid:process.pid,
    startedAtMs:c.wall(),startedMonoMs:c.mono(),maxMs:S.maxMs,maxRounds:S.maxRounds,
    minimumSlackMs:S.minimumSlackMs,probeMaxMs:S.probeMaxMs,probePollMs:S.probePollMs,
    maxProbesPerRound:S.maxProbesPerRound,identityMaxMs:S.identityMaxMs,
    measurementMaxMs:P.timing.measurementMaxMs,noAutomaticExtension:true};
}
function guard(start,c,limit=Infinity) {
  const elapsed=c.mono()-start.startedMonoMs;
  if (!Number.isFinite(elapsed)||elapsed<0||c.id!==start.clockId||
      Math.abs(c.wall()-start.startedAtMs-elapsed)>P.timing.clockDriftMs) C.fail('CLOCK_DISCONTINUITY');
  const remaining=Math.min(start.startedMonoMs+S.maxMs,limit)-c.mono();
  if (remaining<=0) C.fail('SELECTION_STEP_DEADLINE');
  return remaining;
}
function hashes(root) {
  return Object.fromEntries(C.list(root).filter(n=>n!=='result.json').map(n=>{
    const b=C.bytes(path.join(root,n));return [n,{bytes:b.length,sha256:C.sha(b)}];
  }));
}
function chronological(dir,start) {
  const all=[];
  for(let n=1;n<=S.maxRounds;n++) {
    const p=file(dir,roundName(n));if(!fs.existsSync(p))break;
    all.push(...C.jsonl(path.join(p,'time-observations.jsonl')));
  }
  const readiness=C.jsonl(path.join(dir,'time-observations.jsonl')).filter(r=>r.purpose==='readiness'&&r.ok);
  let previous=readiness.at(-1),ids=new Set();
  for(const r of all) {
    if(r.runId!==P.parentRunId||r.clockId!==start.clockId||r.pid!==start.pid||ids.has(r.id))C.fail('SELECTION_READ_IDENTITY');
    ids.add(r.id);
    if(r.ok){if(previous)T.relation(previous,r);previous=r;}
  }
  return all;
}
async function identity(api,dir,round,start,c,limit) {
  const sent=stamp(c),id=crypto.randomBytes(16).toString('hex');
  const end=Math.min(limit,sent.monoMs+S.identityMaxMs,start.startedMonoMs+S.maxMs);
  const budget=n=>Math.min(n,guard(start,c,end));
  try {
    const x=await I.current(api,budget);I.canonical(x.modules);
    const rooms=I.rooms(await api.overview(budget(P.timing.requestMs)));guard(start,c,end);
    const r={id,runId:P.parentRunId,round,clockId:c.id,pid:process.pid,status:'CANONICAL_REVALIDATED',
      sent,received:stamp(c),digest:x.digest,build:x.build,rooms:rooms.filter(n=>P.rooms.includes(n)).sort()};
    C.append(path.join(dir,'identities.jsonl'),r);return r;
  } catch(e) {
    C.append(path.join(dir,'identities.jsonl'),{id,runId:P.parentRunId,round,clockId:c.id,pid:process.pid,
      status:'IDENTITY_READ_FAILED',sent,received:stamp(c),error:C.code(e)});throw e;
  }
}
function decision(dir,round,stage,read,m,c,identityId=null) {
  const profile=profileFor(read.tick),plan=T.plan(m,read,profile,'binding');
  const ordinal=C.jsonl(path.join(dir,'decisions.jsonl')).length+1;
  const r={ordinal,round,stage,runId:P.parentRunId,readId:read.id,identityId,profile,plan,...stamp(c)};
  C.append(path.join(dir,'decisions.jsonl'),r);return r;
}
// Used by select and deterministic fixtures. Always revalidated before binding or upload.
function seal(dir,start,rounds,outcome,reason,selected,c) {
  const root=file(dir,''),elapsed=c.mono()-start.startedMonoMs;
  const result={kind:'pre-binding-selection-result/v1',runId:P.parentRunId,outcome,reason,
    rounds,selected,startedAtMs:start.startedAtMs,endedAtMs:c.wall(),elapsedMs:elapsed,
    maximumMs:S.maxMs,maximumRounds:S.maxRounds,noCodeWrittenBySelector:true,files:hashes(root)};
  C.durable(path.join(root,'result.json'),result);return result;
}
function promote(dir,round,chosen) {
  const rd=file(dir,roundName(round)),m=C.json(path.join(rd,'timing-measurement.json'));
  const reads=C.jsonl(path.join(rd,'time-observations.jsonl'));
  // The old single-measurement API sees precisely the selected calibration. Other rounds
  // remain in their original directories and are recomputed by verifySelection().
  if(C.optional(dir,'timing-measurement.json')||C.optional(dir,'timing-binding.json')||
     C.jsonl(path.join(dir,'time-observations.jsonl')).some(r=>r.purpose==='rate-measurement'))C.fail('SELECTION_PROMOTION_CONFLICT');
  for(const r of reads)C.append(path.join(dir,'time-observations.jsonl'),r);
  C.durable(path.join(dir,'timing-measurement.json'),m);
  const r=reads.find(r=>r.id===chosen.readId);if(!r)C.fail('SELECTION_READ_MISSING');
  const plan=T.admit(dir,r,chosen.profile,'binding');
  return {round,decisionOrdinal:chosen.ordinal,readId:r.id,identityId:chosen.identityId,
    currentTick:r.tick,profile:chosen.profile,plan,
    measurementFileSha256:C.sha(C.bytes(path.join(dir,'timing-measurement.json'))),
    bindingFileSha256:C.sha(C.bytes(path.join(dir,'timing-binding.json')))};
}
async function select(api,dir,{c=T.clock,pause=C.pause}={}) {
  if(['binding-intent.json','binding.json','session.json','candidate-attempt.json','restore-attempt.json','closing.json']
    .some(n=>C.optional(dir,n)))C.fail('SELECTION_AFTER_BINDING_FORBIDDEN');
  const root=file(dir,'');fs.mkdirSync(root);const start=startRecord(c);C.durable(path.join(root,'start.json'),start);
  let count=0,outcome='WINDOW_SELECTION_EXHAUSTED',reason='MAXIMUM_ROUNDS',selected=null,fatal=null;
  try {
    for(let round=1;round<=S.maxRounds;round++) {
      guard(start,c);count=round;const rd=file(dir,roundName(round));fs.mkdirSync(rd);
      const began=stamp(c);C.durable(path.join(rd,'start.json'),{runId:P.parentRunId,round,...began});
      let roundReason='PROBE_PERIOD_EXHAUSTED',chosen=null;
      try {
        const m=await T.calibrate(api,rd,{c,pause,deadlineMonoMs:Math.min(start.startedMonoMs+S.maxMs,began.monoMs+P.timing.measurementMaxMs)});
        chronological(dir,start);guard(start,c);
        const end=Math.min(m.lastRead.receivedMonoMs+S.probeMaxMs,start.startedMonoMs+S.maxMs);
        for(let probe=0;probe<S.maxProbesPerRound&&c.mono()<end;probe++) {
          try {
            const read=await T.readTime(api,rd,'bind-preflight',Math.min(P.timing.requestMs,guard(start,c,end)),c);
            chronological(dir,start);const proposed=decision(rd,round,'probe',read,m,c);
            if(proposed.plan.status==='TIME_BUDGET_ADMITTED') {
              const freshIdentity=await identity(api,rd,round,start,c,end);
              const finalRead=await T.readTime(api,rd,'bind-preflight',Math.min(P.timing.requestMs,guard(start,c,end)),c);
              chronological(dir,start);const final=decision(rd,round,'after_identity',finalRead,m,c,freshIdentity.id);
              if(final.plan.status==='TIME_BUDGET_ADMITTED') {T.ensureFresh(finalRead,c);chosen=final;roundReason='SELECTED';break;}
            }
          } catch(e) {
            C.append(path.join(rd,'errors.jsonl'),{runId:P.parentRunId,round,error:C.code(e),...stamp(c)});
            if(!transient(e))throw e;
          }
          await pause(Math.min(S.probePollMs,Math.max(0,end-c.mono())));
          guard(start,c);
        }
      } catch(e) {
        chronological(dir,start);roundReason=C.code(e);
        if(!recalibrate(e))throw e;
      } finally {
        C.durable(path.join(rd,'result.json'),{runId:P.parentRunId,round,reason:roundReason,
          selectedOrdinal:chosen?.ordinal??null,started:began,ended:stamp(c)});
      }
      if(chosen) {guard(start,c);selected=promote(dir,round,chosen);guard(start,c);outcome='WINDOW_SELECTED';reason='FIRST_ADMISSIBLE_REVALIDATED_PROPOSAL';break;}
    }
  } catch(e) {
    reason=C.code(e);
    if(reason==='SELECTION_STEP_DEADLINE')reason='READ_ONLY_SELECTION_DEADLINE';
    else {outcome='WINDOW_SELECTION_FAILED';fatal=e;}
  }
  const result=seal(dir,start,count,outcome,reason,selected,c);
  if(outcome!=='WINDOW_SELECTED') {
    if(fatal)throw fatal;
    C.fail('WINDOW_SELECTION_EXHAUSTED');
  }
  verifySelected(dir);return result.selected;
}
function verifySelection(dir) {
  const root=file(dir,''),start=C.json(path.join(root,'start.json')),r=C.json(path.join(root,'result.json'));
  const fail=()=>C.fail('WINDOW_SELECTION_EVIDENCE_INVALID');
  if(start.kind!=='pre-binding-selection/v1'||start.runId!==P.parentRunId||r.runId!==P.parentRunId||
    !/^[a-f0-9]{32}$/.test(start.clockId||'')||!Number.isSafeInteger(start.pid)||start.pid<=0||
    !Number.isSafeInteger(start.startedAtMs)||!Number.isFinite(start.startedMonoMs)||start.startedMonoMs<0||
    !['WINDOW_SELECTED','WINDOW_SELECTION_EXHAUSTED','WINDOW_SELECTION_FAILED'].includes(r.outcome)||
    !Number.isInteger(r.rounds)||r.rounds<0||r.rounds>S.maxRounds||
    !Number.isFinite(r.elapsedMs)||r.elapsedMs<0||r.startedAtMs!==start.startedAtMs||r.maximumMs!==S.maxMs||r.maximumRounds!==S.maxRounds||r.noCodeWrittenBySelector!==true||!C.same(hashes(root),r.files))fail();
  for(const [name,value]of Object.entries({maxMs:S.maxMs,maxRounds:S.maxRounds,minimumSlackMs:S.minimumSlackMs,
    probeMaxMs:S.probeMaxMs,probePollMs:S.probePollMs,maxProbesPerRound:S.maxProbesPerRound,
    identityMaxMs:S.identityMaxMs,measurementMaxMs:P.timing.measurementMaxMs,noAutomaticExtension:true}))if(start[name]!==value)fail();
  if(r.outcome==='WINDOW_SELECTED'&&(r.elapsedMs>S.maxMs||Math.abs(r.endedAtMs-r.startedAtMs-r.elapsedMs)>P.timing.clockDriftMs))fail();
  const roots=fs.readdirSync(root).filter(n=>n.startsWith('round-')).sort();
  if(!C.same(roots,Array.from({length:r.rounds},(_,i)=>roundName(i+1))))fail();
  if(r.outcome==='WINDOW_SELECTION_EXHAUSTED'&&r.rounds<S.maxRounds&&r.elapsedMs<S.maxMs)fail();
  const all=chronological(dir,start);let decisions=0,rejected=0,selectedDecision=null,priorEnd=start.startedMonoMs;
  for(let n=1;n<=r.rounds;n++) {
    const rd=path.join(root,roundName(n)),beg=C.json(path.join(rd,'start.json')),end=C.json(path.join(rd,'result.json'));
    if(beg.round!==n||beg.runId!==P.parentRunId||end.runId!==P.parentRunId||end.round!==n||
      beg.monoMs<priorEnd||end.ended.monoMs<beg.monoMs||!C.same(end.started,begWithoutIdentity(beg)))fail();
    priorEnd=end.ended.monoMs;
    const rows=C.jsonl(path.join(rd,'time-observations.jsonl')),ds=C.jsonl(path.join(rd,'decisions.jsonl'));
    if(ds.length>2*S.maxProbesPerRound)fail();
    const m=C.optional(rd,'timing-measurement.json');
    if(m&&!C.same(T.measurement(rows.filter(x=>x.ok&&x.purpose==='rate-measurement')),m))fail();
    if(ds.length&&!m)fail();
    const identities=C.jsonl(path.join(rd,'identities.jsonl'));const used=new Set();
    if(ds.filter(d=>d.stage==='probe').length>S.maxProbesPerRound)fail();
    const measured=rows.filter(x=>x.ok&&x.purpose==='rate-measurement');
    if(measured.some(x=>x.sentMonoMs<beg.monoMs||x.receivedMonoMs>beg.monoMs+P.timing.measurementMaxMs))fail();
    const probeEnd=m?Math.min(m.lastRead.receivedMonoMs+S.probeMaxMs,start.startedMonoMs+S.maxMs):null;
    for(let i=0;i<ds.length;i++) {
      const d=ds[i],matches=rows.filter(x=>x.id===d.readId);decisions++;
      if(d.ordinal!==i+1||d.round!==n||d.runId!==P.parentRunId||matches.length!==1||used.has(d.readId))fail();
      used.add(d.readId);const read=matches[0];
      if(!['probe','after_identity'].includes(d.stage)||!C.same(d.profile,profileFor(read.tick))||
        !C.same(d.plan,T.plan(m,read,d.profile,'binding'))||d.monoMs<read.receivedMonoMs||
        d.monoMs-read.receivedMonoMs>P.timing.freshReadMaxMs||d.monoMs>end.ended.monoMs||d.monoMs>probeEnd)fail();
      if(d.plan.status!=='TIME_BUDGET_ADMITTED')rejected++;
      if(d.stage==='after_identity') {
        const ix=identities.filter(x=>x.id===d.identityId);
        if(ix.length!==1)fail();const x=ix[0];
        if(x.status!=='CANONICAL_REVALIDATED'||x.runId!==P.parentRunId||x.round!==n||x.clockId!==start.clockId||x.pid!==start.pid||
          !C.same(x.digest,P.backupDigest)||x.build?.commit!==P.backupBuild.commit||x.build?.tree!==P.backupBuild.tree||
          x.build?.tag!==P.backupBuild.tag||x.build?.deployBranch!==P.expected.branch||!C.same(x.rooms,[...P.rooms].sort())||
          x.sent.monoMs>x.received.monoMs||x.received.monoMs>read.sentMonoMs||
          x.received.monoMs-x.sent.monoMs>S.identityMaxMs||
          i===0||ds[i-1].stage!=='probe'||ds[i-1].plan.status!=='TIME_BUDGET_ADMITTED'||
          ds[i-1].monoMs>x.sent.monoMs)fail();
        if(d.plan.status==='TIME_BUDGET_ADMITTED') {
          if(selectedDecision||n!==r.rounds||i!==ds.length-1)fail();
          selectedDecision={round:n,decision:d,read,m};
        }
      } else if(d.identityId!==null)fail();
    }
    if(end.selectedOrdinal!==(selectedDecision?.round===n?selectedDecision.decision.ordinal:null))fail();
  }
  if(r.outcome==='WINDOW_SELECTED') {
    const s=r.selected,x=selectedDecision;if(!s||!x||s.round!==x.round||s.decisionOrdinal!==x.decision.ordinal||
      s.readId!==x.read.id||s.identityId!==x.decision.identityId||s.currentTick!==x.read.tick||
      !C.same(s.profile,x.decision.profile)||!C.same(s.plan,x.decision.plan)||
      !C.same(C.json(path.join(dir,'timing-measurement.json')),x.m)||
      !C.same(C.json(path.join(dir,'timing-binding.json')),x.decision.plan)||
      s.measurementFileSha256!==C.sha(C.bytes(path.join(dir,'timing-measurement.json')))||
      s.bindingFileSha256!==C.sha(C.bytes(path.join(dir,'timing-binding.json'))))fail();
    const copied=C.jsonl(path.join(dir,'time-observations.jsonl'));
    for(const row of C.jsonl(path.join(root,roundName(s.round),'time-observations.jsonl'))) {
      const matches=copied.filter(a=>a.id===row.id);if(matches.length!==1||!C.same(matches[0],row))fail();
    }
    if(!C.same(T.loadMeasurement(dir),x.m))fail();
  } else if(r.selected!==null||selectedDecision)fail();
  return {status:'WINDOW_SELECTION_INDEPENDENTLY_VERIFIED',outcome:r.outcome,reason:r.reason,
    rounds:r.rounds,decisions,rejectedDecisions:rejected,successfulTimeReads:all.filter(x=>x.ok).length,
    failedTimeReads:all.filter(x=>!x.ok).length,elapsedMs:r.elapsedMs,maximumMs:S.maxMs,
    currentTick:r.selected?.currentTick??null,selectedRound:r.selected?.round??null,
    minimumSlackMs:S.minimumSlackMs,noCodeWrittenBySelector:true};
}
function begWithoutIdentity(b) {return {atMs:b.atMs,monoMs:b.monoMs};}
function verifySelected(dir) {
  const result=verifySelection(dir);if(result.outcome!=='WINDOW_SELECTED')C.fail('WINDOW_NOT_SELECTED');return result;
}
module.exports={select,verifySelection,verifySelected,startRecord,seal,promote,decision,identity,guard};
