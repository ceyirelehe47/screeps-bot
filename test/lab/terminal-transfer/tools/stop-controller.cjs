'use strict';
const { assessControlSamples } = require('./memory-control.cjs');
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

// One-pass decoding of the driver's escaped console text. Never decode twice:
// &amp;quot; must remain literal &quot;, not become a fabricated JSON quote.
function decodeText(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|quot|apos|amp|lt|gt);/gi, (all, key) => {
    if (key[0] === '#') {
      const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (!integer(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error('invalid HTML entity');
      return String.fromCodePoint(n);
    }
    return { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' }[key.toLowerCase()];
  });
}
function decodeEnvelope(envelope, userId) {
  if (!object(envelope)) throw new Error('invalid console envelope');
  if (envelope.channel !== `user:${userId}/console`) return [];
  const payload = typeof envelope.payload === 'string' ? JSON.parse(envelope.payload) : envelope.payload;
  if (!object(payload) || payload.userId !== userId) throw new Error('console payload/user mismatch');
  if (payload.error || payload.messages?.error) throw new Error('player console error');
  if (!object(payload.messages) || !Array.isArray(payload.messages.log)) throw new Error('missing console messages');
  return payload.messages.log.map(line => {
    if (typeof line !== 'string') throw new Error('non-string console log');
    const text = decodeText(line).trim();
    if (!text.startsWith('{')) return null; // preserve ordinary diagnostic text in raw log
    const sample = JSON.parse(text);
    if (!object(sample)) throw new Error('invalid lab log');
    return { ...sample, userId }; // transport identity, never trust a field in a log
  }).filter(Boolean);
}
function healthySample(sample, config) {
  if (!integer(sample.tick)) return false;
  for (const side of ['source', 'target']) {
    const endpoint = sample[side];
    if (!object(endpoint) || endpoint.readStatus !== 'ok'
        || endpoint.terminalId !== config[side + 'TerminalId']
        || endpoint.roomName !== config[side + 'RoomName']
        || endpoint.ownerUsername !== config.username
        || !['resourceAmount', 'energy', 'freeCapacity', 'cooldown'].every(key => integer(endpoint[key]))) return false;
  }
  if (sample.feeQuote?.status !== 'ok' || !integer(sample.feeQuote.energyCost)) return false;
  for (const side of ['incoming', 'outgoing']) {
    const view = sample.transactions?.[side];
    if (view?.status !== 'ok' || !Array.isArray(view.records) || !view.records.every(object)) return false;
  }
  return true;
}

/**
 * Actual stop orchestration; injectable clock/ports for offline tests.
 * No resume/Memory/write/send port exists here. Deadline is armed before the
 * caller's sole resume request. A failed pause always reaches a bounded kill.
 */
function createStopController(options, ports) {
  const { userId, config, mode = 'formal', expectedArmed } = options;
  if (!userId || !config || !['formal', 'control'].includes(mode)) throw new Error('invalid stop binding');
  if (mode === 'formal' && (!integer(config.targetTick) || config.targetTick < 2 || config.targetTick > Number.MAX_SAFE_INTEGER - 20)) throw new Error('invalid target tick');
  const LIMIT = 180000, PAUSE_LIMIT = 5000, KILL_LIMIT = 5000;
  let state = 'idle', deadline, deadlineTimer, pauseTimer, pollTimer, killTimer;
  let resolveDone, report, lastPausedTick, stableSince, stableReads = 0;
  const seen = [], controlSamples = [], extraReasons = [], logErrors = [];
  const done = new Promise(resolve => { resolveDone = resolve; });
  const now = () => ports.now();
  function audit(event) {
    try { ports.audit({ monotonicMs: now(), ...event }); }
    catch (error) { logErrors.push(String(error)); }
  }
  function finish() {
    if (state === 'done') return;
    state = 'done';
    for (const handle of [deadlineTimer, pauseTimer, pollTimer, killTimer]) if (handle !== undefined) ports.clearTimer(handle);
    report.extraReasons = [...extraReasons]; report.logErrors = [...logErrors];
    report.sampleTicks = [...seen]; report.controlSamples = [...controlSamples];
    report.ok = ['window_complete', 'control_confirmed'].includes(report.reason)
      && report.pauseConfirmed === true && report.triggerLatencyMs <= 1000
      && logErrors.length === 0 && !report.error;
    audit({ kind: 'stop-result', ...report });
    if (logErrors.length) { report.ok = false; report.logErrors = [...logErrors]; }
    resolveDone(report);
  }
  function kill(error) {
    if (state === 'killing' || state === 'done') return;
    state = 'killing';
    ports.clearTimer(pauseTimer); ports.clearTimer(pollTimer);
    report.error = String(error); report.killRequestedAt = now();
    audit({ kind: 'kill-request', error: report.error });
    killTimer = ports.setTimer(() => {
      report.killConfirmed = false; report.error += '; kill confirmation timeout'; finish();
    }, KILL_LIMIT);
    Promise.resolve().then(() => ports.killTree()).then(() => {
      if (state !== 'killing') return;
      report.killConfirmed = true; finish();
    }, err => {
      if (state !== 'killing') return;
      report.killConfirmed = false; report.error += '; ' + String(err); finish();
    });
  }
  function confirmPause() {
    if (state !== 'stopping') return;
    Promise.resolve().then(() => ports.readState()).then(snapshot => {
      if (state !== 'stopping') return;
      audit({ kind: 'pause-state', snapshot });
      if (snapshot?.paused !== true || !integer(snapshot.tick)) { stableReads = 0; lastPausedTick = undefined; }
      else { if (snapshot.tick !== lastPausedTick) stableSince = now(); stableReads = snapshot.tick === lastPausedTick ? stableReads + 1 : 1; lastPausedTick = snapshot.tick; }
      // Stable samples span >= 1000ms. The write adapter independently repeats its
      // stable check before writes. This is a bounded stop observation, not an
      // assertion that an in-flight tick is atomically cancelled.
      if (stableReads >= 3 && now() - stableSince >= 1000) {
        report.pauseConfirmed = true; report.stableTick = snapshot.tick; report.pauseConfirmedAt = now(); finish();
      } else pollTimer = ports.setTimer(confirmPause, 250);
    }, error => kill(error));
  }
  function stop(reason, observedAt = now()) {
    if (state === 'done') return done;
    if (state === 'stopping' || state === 'killing') { extraReasons.push(reason); return done; }
    state = 'stopping'; ports.clearTimer(deadlineTimer);
    report = { reason, observedAt, deadline, stopRequestedAt: now(), windowComplete: reason === 'window_complete', pauseConfirmed: false, killConfirmed: false };
    report.triggerLatencyMs = report.stopRequestedAt - observedAt;
    audit({ kind: 'stop-trigger', ...report });
    pauseTimer = ports.setTimer(() => kill('pause/stability not confirmed within 5 seconds'), PAUSE_LIMIT);
    // Timestamp the actual call AFTER any preceding disk I/O. Slow audit writes
    // must not make a late pause look like a zero-latency request.
    report.stopRequestedAt = now();
    report.triggerLatencyMs = report.stopRequestedAt - observedAt;
    try {
      const request = ports.pause();
      audit({ kind: 'pause-request', ...report });
      Promise.resolve(request).then(result => {
        if (state !== 'stopping') return;
        audit({ kind: 'pause-response', result });
        if (result !== 'OK') return kill('pause returned non-OK');
        confirmPause();
      }, error => kill(error));
    } catch (error) { audit({ kind: 'pause-request-threw', ...report }); kill(error); }
    return done;
  }
  function start() {
    if (state !== 'idle') throw new Error('stop controller cannot restart or renew deadline');
    state = 'running'; deadline = now() + LIMIT;
    deadlineTimer = ports.setTimer(() => stop('deadline', deadline), LIMIT);
    audit({ kind: 'stop-ready', deadline, mode, userId });
    if (logErrors.length) stop('audit_failure');
    return deadline;
  }
  function receiveTime(envelope) {
    const received = envelope.recvMonotonicMs;
    return typeof received === 'number' && Number.isFinite(received) && received >= 0 && received <= now() ? received : now();
  }
  function ingest(envelope) {
    if (state !== 'running') return;
    if (now() >= deadline) { stop('deadline', deadline); return; }
    let rows;
    try { rows = decodeEnvelope(envelope, userId); }
    catch (error) { stop('console_decode_failure'); return; }
    for (const sample of rows) {
      if (state !== 'running') break;
      if (sample.kind === 'lab-control-read-error' || /(?:error|truncated)$/.test(sample.kind || '')) { stop('player_observation_error'); break; }
      if (mode === 'control' && sample.kind === 'lab-control-sample') {
        if (!healthySample(sample, config)) { stop('control_world_unhealthy'); break; }
        if (controlSamples.some(s => s.tick === sample.tick)) { stop('control_duplicate_tick'); break; }
        controlSamples.push(sample); seen.push(sample.tick);
        // Reject wrong control immediately; do not collect two bad rows as a
        // false positive. The pure checker requires two ticks for readiness.
        const check = assessControlSamples(controlSamples,
          { userId, username: config.username, experimentId: config.experimentId, armed: expectedArmed });
        if (check.issues.some(issue => issue !== 'two player ticks required')) { stop('control_mismatch'); break; }
        if (controlSamples.length >= 2) stop('control_confirmed', receiveTime(envelope));
      } else if (mode === 'formal' && sample.kind === 'lab-sample') {
        if (sample.experimentId !== config.experimentId || sample.configTargetTick !== config.targetTick
            || !healthySample(sample, config)) { stop('formal_sample_mismatch'); break; }
        const next = config.targetTick - 2 + seen.length;
        if (sample.tick !== next) { stop('window_gap_or_duplicate'); break; }
        seen.push(sample.tick);
        if (sample.tick === config.targetTick + 20) stop('window_complete', receiveTime(envelope));
      } else if (mode === 'formal' && sample.kind === 'lab-precondition-rejection') {
        stop('send_precondition_rejected');
      } else if (mode === 'formal' && sample.kind === 'lab-control-sample') {
        stop('wrong_active_entry');
      }
    }
  }
  return { start, ingest, stop, done, fault: reason => stop(reason),
    get state() { return state; }, get deadline() { return deadline; } };
}
module.exports = { decodeText, decodeEnvelope, healthySample, createStopController };
