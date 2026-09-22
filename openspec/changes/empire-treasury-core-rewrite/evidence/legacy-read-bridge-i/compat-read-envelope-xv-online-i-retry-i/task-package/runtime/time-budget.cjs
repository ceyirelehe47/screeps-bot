'use strict';
// Game ticks and elapsed wall time are different budgets. This module never writes code.
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const crypto = require('node:crypto');
const C = require('./common.cjs');
const I = require('./identity.cjs');
const P = C.POLICY, K = P.timing;
const clock = {mono: () => performance.now(), wall: () => Date.now(), id: crypto.randomBytes(16).toString('hex')};
const transient = e => ['HTTP_DEADLINE','HTTP_TRANSPORT_ERROR','HTTP_BODY_ABORTED','HTTP_BODY_ERROR','HTTP_REQUEST_FAILED','HTTP_TRANSIENT_STATUS'].includes(C.code(e));
const finite = n => Number.isFinite(n) && n >= 0;
const file = dir => path.join(dir, 'time-observations.jsonl');

async function readTime(api, dir, purpose, ms = K.requestMs, c = clock) {
  if (!finite(ms) || ms === 0) C.fail('TIME_READ_DEADLINE');
  const r = {runId:P.parentRunId, id:crypto.randomBytes(16).toString('hex'), clockId:c.id,
    pid:process.pid, purpose, sentMonoMs:c.mono(), sentAtMs:c.wall()};
  try {
    r.tick = I.tick(await api.time(Math.min(ms, K.requestMs)));
    r.receivedMonoMs = c.mono(); r.receivedAtMs = c.wall(); r.ok = true;
    if (!finite(r.receivedMonoMs) || r.receivedMonoMs < r.sentMonoMs ||
        r.receivedMonoMs - r.sentMonoMs > ms) C.fail('TIME_READ_DEADLINE');
    if (Math.abs((r.receivedAtMs-r.sentAtMs)-(r.receivedMonoMs-r.sentMonoMs)) > K.clockDriftMs) C.fail('CLOCK_DISCONTINUITY');
    const prior=C.jsonl(file(dir)).filter(x=>x.ok===true&&x.clockId===r.clockId).at(-1);
    if(prior) relation(prior,r);
    C.append(file(dir), r); return r;
  } catch (e) {
    r.ok = false; r.error = C.code(e); r.receivedMonoMs=c.mono(); r.receivedAtMs=c.wall();
    C.append(file(dir), r); throw e;
  }
}
function validateRead(r) {
  if (!r || r.runId!==P.parentRunId || r.ok!==true || !/^[a-f0-9]{32}$/.test(r.id||'') ||
      !/^[a-f0-9]{32}$/.test(r.clockId||'') || !Number.isSafeInteger(r.pid) || r.pid<=0 ||
      !Number.isSafeInteger(r.tick) || r.tick<0 || !finite(r.sentMonoMs) ||
      !finite(r.receivedMonoMs) || r.receivedMonoMs<r.sentMonoMs ||
      !Number.isSafeInteger(r.sentAtMs) || !Number.isSafeInteger(r.receivedAtMs)) C.fail('TIMING_READ_INVALID');
  if (Math.abs((r.receivedAtMs-r.sentAtMs)-(r.receivedMonoMs-r.sentMonoMs))>K.clockDriftMs) C.fail('CLOCK_DISCONTINUITY');
}
function relation(a,b) {
  validateRead(a); validateRead(b);
  if (a.clockId!==b.clockId || a.pid!==b.pid || b.sentMonoMs<a.receivedMonoMs) C.fail('TIMING_CLOCK_OR_ORDER_INVALID');
  if (b.tick<a.tick) C.fail('GAME_TICK_REGRESSED');
  if (Math.abs((b.receivedAtMs-a.receivedAtMs)-(b.receivedMonoMs-a.receivedMonoMs))>K.clockDriftMs) C.fail('CLOCK_DISCONTINUITY');
}
function measurement(reads) {
  if (!Array.isArray(reads) || reads.length < K.minSamples) C.fail('TICK_RATE_EVIDENCE_INSUFFICIENT');
  const ids=new Set(); let anchor=reads[0], worst=0;
  for (let i=0;i<reads.length;i++) {
    const r=reads[i]; validateRead(r);
    if(r.purpose!=='rate-measurement'||ids.has(r.id)) C.fail('TIMING_READ_SET_INVALID'); ids.add(r.id);
    if(i) relation(reads[i-1],r);
    if(r.tick>anchor.tick) {
      // Includes the uncertainty of the earlier request and any stalled/failed reads.
      worst=Math.max(worst,(r.receivedMonoMs-anchor.sentMonoMs)/(r.tick-anchor.tick)); anchor=r;
    }
  }
  const first=reads[0],last=reads.at(-1),span=last.receivedMonoMs-first.receivedMonoMs,advance=last.tick-first.tick;
  if(span<K.minSpanMs||advance<K.minTickAdvance) C.fail('TICK_RATE_EVIDENCE_INSUFFICIENT');
  worst=Math.max(worst,(last.receivedMonoMs-first.sentMonoMs)/advance);
  return {kind:'tick-rate-measurement/v1',runId:P.parentRunId,clockId:first.clockId,
    readIds:reads.map(x=>x.id),samples:reads.length,spanMs:span,tickAdvance:advance,
    firstTick:first.tick,lastTick:last.tick,lastRead:last,
    worstObservedMsPerTick:worst,
    conservativeMsPerTick:Math.max(K.floorMsPerTick,Math.ceil(worst*K.safetyFactor)),
    safetyFactor:K.safetyFactor,notAFutureSpeedGuarantee:true};
}
async function calibrate(api,dir,{c=clock,pause=C.pause,deadlineMonoMs=Infinity}={}) {
  const deadline=Math.min(c.mono()+K.measurementMaxMs,deadlineMonoMs),reads=[];
  while(c.mono()<deadline) {
    try {
      reads.push(await readTime(api,dir,'rate-measurement',Math.min(K.requestMs,deadline-c.mono()),c));
      let result;
      try { result=measurement(reads); } catch(e) { if(C.code(e)!=='TICK_RATE_EVIDENCE_INSUFFICIENT') throw e; }
      if(result) { C.durable(path.join(dir,'timing-measurement.json'),result); return result; }
    } catch(e) { if(!transient(e)) throw e; }
    await pause(Math.min(K.pollMs,Math.max(0,deadline-c.mono())));
  }
  C.fail('TICK_RATE_MEASUREMENT_INCONCLUSIVE');
}
function loadMeasurement(dir) {
  const m=C.json(path.join(dir,'timing-measurement.json'));
  const all=C.jsonl(file(dir));
  const reads=all.filter(r=>r.purpose==='rate-measurement'&&r.ok===true);
  if(!C.same(measurement(reads),m)) C.fail('TIMING_MEASUREMENT_CHANGED');
  return m;
}
function plan(m, current, profile, stage) {
  if(!['binding','upload'].includes(stage)) C.fail('TIMING_STAGE_INVALID');
  relation(m.lastRead,current);
  const age=current.receivedMonoMs-m.lastRead.receivedMonoMs;
  if(age>K.maxAgeMs) C.fail('TICK_RATE_EVIDENCE_STALE');
  if(current.purpose!== (stage==='binding'?'bind-preflight':'upload-preflight')) C.fail('TIMING_PURPOSE_CHANGED');
  let bound=m.conservativeMsPerTick;
  const progress=current.tick-m.lastTick;
  if(age>=K.pollMs) {
    if(progress<=0) C.fail('TICK_PROGRESS_STALLED');
    bound=Math.max(bound,Math.ceil((current.receivedMonoMs-m.lastRead.sentMonoMs)/progress*K.safetyFactor));
  }
  const start=profile.startTick,end=profile.endTick;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%100!==0||end!==start+300||profile.intervalTicks!==100||
    profile.maxSampleCpu!==2||profile.reserveCpu!==5||!C.same(profile.rooms,P.rooms)||!C.same(profile.resources,P.resources)) C.fail('TIMING_PROFILE_INVALID');
  if(current.tick>start-100) C.fail('PROFILE_EXPIRED');
  const remainingTicks=end-current.tick,estimatedMs=remainingTicks*bound,
    requiredMs=Math.ceil(estimatedMs+K.deliveryReserveMs);
  return {kind:'tick-window-admission/v1',runId:P.parentRunId,stage,status:requiredMs>P.wallMs?'TIME_BUDGET_INSUFFICIENT':requiredMs+P.selection.minimumSlackMs>P.wallMs?'TIME_BUDGET_MARGIN_INSUFFICIENT':'TIME_BUDGET_ADMITTED',
    measurementSha256:C.sha(JSON.stringify(m)),readId:current.id,currentTick:current.tick,
    startTick:start,endTick:end,remainingTicks,conservativeMsPerTick:bound,
    estimatedRemainingMs:estimatedMs,deliveryReserveMs:K.deliveryReserveMs,requiredMs,
    exposureLimitMs:P.wallMs,slackMs:P.wallMs-requiredMs,minimumSlackMs:P.selection.minimumSlackMs,
    measurementAgeMs:age,readAtMs:current.receivedAtMs,readMonoMs:current.receivedMonoMs,
    noAutomaticExtension:true};
}
function admit(dir,current,profile,stage) {
  const m=loadMeasurement(dir),r=plan(m,current,profile,stage);
  C.durable(path.join(dir,'timing-'+stage+'.json'),r);
  C.event(dir,'time-budget-admission',{stage,status:r.status,currentTick:r.currentTick,requiredMs:r.requiredMs,exposureLimitMs:P.wallMs});
  if(r.status!=='TIME_BUDGET_ADMITTED') C.fail(r.status);
  return r;
}
function verifyPlan(dir,profile,stage) {
  const m=loadMeasurement(dir),p=C.json(path.join(dir,'timing-'+stage+'.json'));
  const r=C.jsonl(file(dir)).filter(r=>r.id===p.readId);
  if(r.length!==1 || !C.same(plan(m,r[0],profile,stage),p) || p.status!=='TIME_BUDGET_ADMITTED') C.fail('TIME_ADMISSION_INVALID');
  return p;
}
function ensureFresh(r,c=clock) {
  const age=c.mono()-r.receivedMonoMs;
  if(r.clockId!==c.id||!finite(age)||age>K.freshReadMaxMs) C.fail('TIMING_FINAL_READ_STALE');
  if(Math.abs((c.wall()-r.receivedAtMs)-age)>K.clockDriftMs) C.fail('CLOCK_DISCONTINUITY');
}
function verifyRun(dir,s,attempt) {
  const selection=require('./window-selection.cjs').verifySelected(dir);
  if(C.sha(C.bytes(path.join(dir,'window-selection/result.json')))!==s.windowSelectionFileSha256||selection.currentTick!==s.observedTick)C.fail('SESSION_SELECTION_CHANGED');
  const bind=verifyPlan(dir,s.profile,'binding'),upload=verifyPlan(dir,s.profile,'upload');
  if(bind.currentTick!==s.observedTick || upload.currentTick<bind.currentTick ||
    C.sha(C.bytes(path.join(dir,'timing-measurement.json')))!==s.timingMeasurementFileSha256 ||
    C.sha(C.bytes(path.join(dir,'timing-binding.json')))!==s.timingBindingFileSha256 ||
    C.sha(C.bytes(path.join(dir,'timing-upload.json')))!==attempt.timingAdmissionSha256 ||
    attempt.wallBudgetMs!==P.wallMs || attempt.wallDeadlineAtMs!==attempt.atMs+P.wallMs ||
    attempt.atMs<upload.readAtMs || attempt.atMs-upload.readAtMs>K.freshReadMaxMs+K.clockDriftMs) C.fail('TIME_ADMISSION_SESSION_MISMATCH');
  return {status:'TIME_ADMISSION_INDEPENDENTLY_VERIFIED',binding:bind,upload,
    fixedCloseDeadlineAtMs:attempt.wallDeadlineAtMs};
}
// A worker uses its OWN monotonic clock. Never compare performance.now() between processes.
function exposureGuard(attempt,c=clock) {
  if(attempt.runId!==P.parentRunId || attempt.wallBudgetMs!==P.wallMs ||
    !Number.isSafeInteger(attempt.atMs)||attempt.wallDeadlineAtMs!==attempt.atMs+P.wallMs) C.fail('EXPOSURE_MARKER_INVALID');
  const wall0=c.wall(),mono0=c.mono(),remaining=Math.max(0,Math.min(P.wallMs,attempt.wallDeadlineAtMs-wall0));
  if(wall0<attempt.atMs-K.clockDriftMs) C.fail('CLOCK_DISCONTINUITY');
  const check = () => {
    const elapsed=c.mono()-mono0,wallElapsed=c.wall()-wall0;
    if(!finite(elapsed)||Math.abs(wallElapsed-elapsed)>K.clockDriftMs) return 'CLOCK_DISCONTINUITY';
    if(c.wall()>=attempt.wallDeadlineAtMs||elapsed>=remaining) return 'WALL_DEADLINE';
    return null;
  };
  check.remaining = () => Math.max(0,Math.min(remaining-(c.mono()-mono0),attempt.wallDeadlineAtMs-c.wall()));
  return check;
}
module.exports={clock,readTime,measurement,calibrate,loadMeasurement,plan,admit,verifyPlan,ensureFresh,verifyRun,exposureGuard,relation};
