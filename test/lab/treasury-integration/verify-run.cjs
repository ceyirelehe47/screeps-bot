'use strict';
// Post-run evidence checking only. This never grants permission to dispatch,
// writes game Memory, creates a transaction, or converts unknown to completed.
const { decodeEnvelope } = require('../terminal-transfer/tools/stop-controller.cjs');
function checkTreasuryRun(config, userId, rawEnvelopes, before, after, stop, processStop) {
  const issues = [], warnings = [];
  const expect = (yes, reason) => { if (!yes) issues.push(reason); };
  let rows;
  try { rows = rawEnvelopes.flatMap(e => decodeEnvelope(e, userId)); }
  catch (error) { return { status: 'INCONCLUSIVE', issues: ['console decode: ' + error], warnings }; }
  const exact = rows.filter(r => r.experimentId === config.experimentId);
  const samples = exact.filter(r => r.kind === 'lab-sample');
  const first = samples.find(r => r.tick === config.targetTick), last = samples.find(r => r.tick === config.targetTick + 20);
  const attempts = exact.filter(r => r.kind === 'lab-send-attempt');
  const boundaries = attempts.filter(r => r.phase === 'boundary'), returns = attempts.filter(r => r.phase === 'sync-return');
  const preCalls = attempts.filter(r => r.phase === 'pre-call');
  const allBoundaries = rows.filter(r => r.kind === 'lab-send-attempt' && r.phase === 'boundary');
  expect(samples.length === 23 && samples.every((r, i) => r.tick === config.targetTick - 2 + i), 'not one complete 23-tick raw observation window');
  expect(allBoundaries.length === 1 && boundaries.length === 1 && boundaries[0].tick === config.targetTick, 'not one exact live call boundary');
  expect(returns.length === 1 && returns[0].tick === config.targetTick && returns[0].result?.ok === true && returns[0].result?.code === 0, 'no exact OK acceptance');
  expect(preCalls.length === 1 && preCalls[0].tick === config.targetTick && preCalls[0].fee === config.maxFeeEnergy, 'pre-call frozen fee mismatch');
  expect(!rows.some(r => /error|truncated/.test(r.kind || '') || r.kind === 'lab-precondition-rejection' || r.phase === 'sync-throw'), 'runtime reported a failure');
  expect(stop?.ok === true && stop.windowComplete === true && stop.pauseConfirmed === true && Number.isFinite(stop.triggerLatencyMs) && stop.triggerLatencyMs >= 0 && stop.triggerLatencyMs <= 1000, 'window/pause not confirmed');
  expect(processStop?.terminated === true && Number.isFinite(processStop.elapsedMs) && processStop.elapsedMs >= 0 && processStop.elapsedMs < 4500 && Array.isArray(processStop.observedPids) && processStop.observedPids.length > 0
    && Array.isArray(processStop.auditErrors) && processStop.auditErrors.length === 0, 'automatic bound-tree exit not confirmed');
  let core, initialCore, control;
  try {
    const mem = JSON.parse(after.memory), initial = JSON.parse(before.memory);
    core = mem.runtime?.treasuryCore; initialCore = initial.runtime?.treasuryCore;
    control = mem.__labTerminalTransferProbe;
  } catch { issues.push('raw Memory snapshot missing/corrupt'); }
  expect(initialCore === undefined, 'not a pristine Treasury integration world');
  expect(core?.version === 3 && core.active && typeof core.active === 'object' && !Array.isArray(core.active) && Object.keys(core.active).length === 0, 'kernel active work did not retire');
  expect(core?.counters?.admitted === 1 && core?.counters?.dispatched === 1 && core?.counters?.settledCommitted === 1 && core?.counters?.rearmings === 0, 'kernel lifecycle counters not one dispatch/settlement with no rearm');
  expect(control?.experimentId === config.experimentId && control.attempted === true && control.attemptedTick === config.targetTick
    && control.syncResult?.ok === true && control.syncResult?.code === 0, 'attempted control facts lost/mismatched');
  const states = exact.filter(r => r.kind === 'lab-treasury-state');
  const admitted = states.find(r => r.tick === config.targetTick && r.stage === 'admitted');
  const dispatched = states.find(r => r.tick === config.targetTick && r.stage === 'dispatched');
  const final = states.find(r => r.tick === config.targetTick + 20 && r.stage === 'end');
  const workKey = 'biz:terminal-lab:' + config.experimentId;
  const id = admitted?.active?.[0]?.attemptId;
  expect(admitted?.active?.length === 1 && admitted.active[0].workKey === workKey && admitted.active[0].phase === 'pending', 'no kernel pending admission evidence');
  expect(dispatched?.active?.length === 1 && dispatched.active[0].attemptId === id && dispatched.active[0].phase === 'outcome_unknown', 'OK was not retained as unknown until world confirmation');
  expect(Array.isArray(core?.ring) && core.ring.some(r => r.attemptId === id && r.workKey === workKey && r.terminalPhase === 'committed'), 'retirement audit does not correlate with admitted work');
  if (first && last && admitted && dispatched && final) {
    const integer = n => Number.isSafeInteger(n) && n >= 0;
    for (const s of samples) for (const side of ['source', 'target']) {
      expect(s[side]?.readStatus === 'ok' && s[side]?.terminalId === config[side + 'TerminalId'] && s[side]?.ownerUsername === config.username
        && ['resourceAmount','energy','freeCapacity','cooldown'].every(k => integer(s[side][k])), 'invalid raw endpoint sample');
    }
    const fee = first.source.energy - last.source.energy;
    expect(integer(fee) && fee >= 1 && fee <= config.maxFeeEnergy, 'observed fee not within frozen maximum');
    expect(last.source.resourceAmount === first.source.resourceAmount - 100 && last.target.resourceAmount === first.target.resourceAmount + 100
      && last.target.energy === first.target.energy && last.source.freeCapacity === first.source.freeCapacity + 100 + fee
      && last.target.freeCapacity === first.target.freeCapacity - 100, 'not the exact physical transfer');
    if (fee !== config.maxFeeEnergy) warnings.push('Observed fee differs from quote; accepted only as bounded expenditure, not as a verified fee model.');
    for (const state of [admitted, dispatched]) {
      const p = state.projection;
      expect(p?.sourceH?.observed === first.source.resourceAmount && p.sourceH.committed === 100 && p.sourceH.spendable === first.source.resourceAmount - 100
        && p.sourceEnergy.observed === first.source.energy && p.sourceEnergy.committed === config.maxFeeEnergy && p.sourceEnergy.spendable === first.source.energy - config.maxFeeEnergy
        && p.targetRiskAdjustedFree === first.target.freeCapacity - 100, 'pre-result obligations missing or double-counted');
    }
    const p = final.projection;
    expect(final.health?.status === 'healthy' && Array.isArray(final.active) && final.active.length === 0, 'final query health/active mismatch');
    expect(p?.sourceH?.observed === last.source.resourceAmount && p.sourceH.spendable === last.source.resourceAmount && p.sourceH.committed === 0
      && p.sourceEnergy.observed === last.source.energy && p.sourceEnergy.spendable === last.source.energy && p.sourceEnergy.committed === 0
      && p.targetH.observed === last.target.resourceAmount && p.targetH.spendable === last.target.resourceAmount
      && p.targetRiskAdjustedFree === last.target.freeCapacity, 'residual/double resource or capacity occupancy');
    const txn = (after.transactions || []).filter(r => r.description === config.description);
    expect(txn.length === 1 && txn[0].from === config.sourceRoomName && txn[0].to === config.targetRoomName && txn[0].sender === userId
      && txn[0].recipient === userId && txn[0].amount === 100 && txn[0].resourceType === 'H' && txn[0].time === config.targetTick, 'raw transaction snapshot mismatch');
    const object = side => (after.objects || []).find(r => r._id === config[side + 'TerminalId']);
    expect(object('source')?.store?.H === last.source.resourceAmount && object('source')?.store?.energy === last.source.energy
      && object('target')?.store?.H === last.target.resourceAmount && object('target')?.store?.energy === last.target.energy, 'raw world snapshot differs from player view');
    // The adapter already validates mirrors, but the test verdict independently
    // checks the ID/route/parties rather than trusting its committed label.
    for (const direction of ['incoming', 'outgoing']) {
      const view = last.transactions?.[direction];
      const matches = (view?.records || []).filter(r => r.description === config.description);
      expect(view?.status === 'ok' && matches.length === 1 && matches[0].transactionId === txn[0]?._id
        && matches[0].from === config.sourceRoomName && matches[0].to === config.targetRoomName && matches[0].amount === 100
        && matches[0].resourceType === 'H' && matches[0].time === config.targetTick && matches[0].sender?.username === config.username
        && matches[0].recipient?.username === config.username && matches[0].order === undefined, 'player transaction mirror mismatch: ' + direction);
    }
    return { status: issues.length ? 'INCONCLUSIVE' : 'TREASURY_INTEGRATION_PASS', issues: [...new Set(issues)], warnings, observedFee: fee, quotedFee: config.maxFeeEnergy, attemptId: id };
  }
  issues.push('missing admission/dispatch/final query facts');
  return { status: 'INCONCLUSIVE', issues: [...new Set(issues)], warnings };
}
function verifyTreasuryRun(...args) {
  try { return checkTreasuryRun(...args); }
  catch (error) { return { status: 'INCONCLUSIVE', issues: ['malformed/incomplete evidence: ' + String(error)], warnings: [] }; }
}
module.exports = { verifyTreasuryRun };
