#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { LAB, load } = require('./ts-module.cjs');
const { readMemory, updateMemory, assessControlSamples } = require('./memory-control.cjs');
const { buildProbe } = require('./build-control-probe.cjs');
const { decodeEnvelope, healthySample, createStopController } = require('./stop-controller.cjs');
const { bounded, connectLocal } = require('./local-runtime.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const COMMANDS = ['inspect', 'initialize', 'arm', 'disarm', 'observe-false', 'observe-armed', 'facts', 'run-formal'];

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {}, allowed = new Set(['command','environment','host','port','pid','user','username','experiment','out','probe','proof','facts','last-world-change','observer','single-shot','main']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('unknown/duplicate/incomplete argument: ' + args[i]);
    options[key] = args[i + 1];
  }
  for (const key of ['command','environment','host','port','pid','user','username','experiment','out']) if (!options[key]) throw new Error('required --' + key);
  if (!COMMANDS.includes(options.command)) throw new Error('unknown command');
  if (['initialize','arm','observe-false','observe-armed'].includes(options.command) && !options.probe) throw new Error('--probe required for no-send entry verification');
  if (['arm','facts','run-formal'].includes(options.command) && !options.proof) throw new Error('--proof raw player console required');
  if (options.command === 'facts' && !options['last-world-change']) throw new Error('--last-world-change actual fixture/map change timestamp required');
  if (options.command === 'run-formal') for (const key of ['facts','observer','single-shot','main']) if (!options[key]) throw new Error('required --' + key);
  return options;
}
function createEvidence(dir) {
  dir = path.resolve(dir);
  fs.mkdirSync(dir); // explicitly NEW directory; never merge/overwrite a prior attempt
  const auditFd = fs.openSync(path.join(dir, 'actions.jsonl'), 'wx');
  const rawFd = fs.openSync(path.join(dir, 'console.jsonl'), 'wx');
  const write = (fd, data) => {
    const bytes = Buffer.from(JSON.stringify(data) + '\n'); let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
  };
  return {
    dir, audit: event => write(auditFd, { wallClock: new Date().toISOString(), ...event }),
    raw: envelope => write(rawFd, envelope),
    file: (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }),
    close() { fs.closeSync(rawFd); fs.closeSync(auditFd); },
  };
}
function proofSamples(file, userId) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('proof unexpectedly large');
  const samples = [];
  for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
    const envelope = JSON.parse(line);
    for (const sample of decodeEnvelope(envelope, userId)) {
      if (sample.kind === 'lab-control-sample') samples.push({ ...sample, collectedAtWallClock: envelope.recvWallClock });
      else if (/error|truncated/.test(sample.kind || '')) throw new Error('proof contains an observation error');
    }
  }
  return { samples, sha256: hash(bytes) };
}
async function verifyProof(file, io, config, armed) {
  const proof = proofSamples(file, io.binding.userId);
  const report = assessControlSamples(proof.samples, { userId: io.binding.userId, username: config.username, experimentId: config.experimentId, armed }, await io.readRuntimeMemory());
  const tick = await io.assertPausedStable();
  if (!report.ready || !proof.samples.every(s => healthySample(s, config) && s.tick <= tick)) throw new Error('player roundtrip not confirmed: ' + report.issues.join(';'));
  return { ...proof, tick };
}
async function assertProbe(io, file) {
  const local = fs.readFileSync(file, 'utf8');
  if (local !== buildProbe().code) throw new Error('probe file does not match current trusted sources');
  const modules = await io.activeModules();
  if (Object.keys(modules).length !== 1 || modules.main !== local) throw new Error('only the byte-verified no-send probe may be active during preparation');
}
async function assertFormalModules(io, options) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(LAB, '../../..'), encoding: 'utf8' }).trim();
  const modules = await io.activeModules();
  if (Object.keys(modules).sort().join(',') !== 'main,observer,single-shot') throw new Error('unexpected active module set');
  for (const name of ['observer','single-shot','main']) {
    const file = path.resolve(options[name]), bytes = fs.readFileSync(file);
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'manifest.json')));
    if (manifest.repoSourceCommit !== head || manifest.output?.sha256 !== hash(bytes) || manifest.output?.bytes !== bytes.length
        || modules[name] !== bytes.toString('utf8')) throw new Error('active/generated module identity mismatch: ' + name);
  }
}

async function subscribeReady(io, onEnvelope) {
  // A separate external ping proves subscription works. It NEVER impersonates
  // user console output and cannot count as a player sample or readiness fact.
  const channel = 'lab-watcher:' + randomUUID();
  let acknowledge;
  const acknowledged = new Promise(resolve => { acknowledge = resolve; });
  await Promise.resolve(io.pubsub.subscribe('*', function(payload) {
    const receivedChannel = this.channel;
    if (receivedChannel === channel && payload === 'ready') acknowledge();
    else onEnvelope({ channel: receivedChannel, payload, recvWallClock: new Date().toISOString(), recvMonotonicMs: performance.now() });
  }));
  await bounded(async () => {
    for (let i = 0; i < 8; i++) {
      await io.pubsub.publish(channel, 'ready');
      const heard = await Promise.race([acknowledged.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
      if (heard) return;
    }
    throw new Error('subscription ping was not received');
  }, 2000, 'subscription handshake');
}

async function runSession(io, config, mode, armed, evidence) {
  let controller, seq = 0, lastConsoleAt, healthTimer, fatalBeforeStart;
  const audit = evidence.audit;
  await subscribeReady(io, envelope => {
    try {
      evidence.raw({ seq: ++seq, ...envelope }); // durable raw append precedes any decision
      if (envelope.channel === `user:${io.binding.userId}/console`) lastConsoleAt = performance.now();
      if (controller) controller.ingest(envelope);
    } catch (error) {
      if (controller) controller.fault('collector_write_or_decode_failure');
      else fatalBeforeStart = error;
    }
  });
  if (fatalBeforeStart) throw fatalBeforeStart;
  await io.assertIdentity();
  await io.assertPausedStable();
  controller = createStopController({ userId: io.binding.userId, config, mode, expectedArmed: armed }, {
    now: () => performance.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: handle => clearTimeout(handle),
    audit, pause: () => io.pause(), readState: () => io.readState(), killTree: () => io.killTree(),
  });
  const signal = () => controller.fault('operator_interrupt');
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  controller.start(); // immutable 180s deadline BEFORE the sole resume request
  lastConsoleAt = performance.now();
  let healthBusy = false;
  healthTimer = setInterval(() => {
    if (controller.state !== 'running' || healthBusy) return;
    healthBusy = true;
    bounded(() => io.readState(), 1000, 'storage heartbeat').catch(() => controller.fault('storage_disconnected')).finally(() => { healthBusy = false; });
    // The isolated one-second-tick fixture emits user console envelopes even
    // for empty logs. Missing transport for 5 seconds is a failed experiment,
    // not evidence that send did not execute. No reconnection or deadline reset.
    if (performance.now() - lastConsoleAt > 5000) controller.fault('user_console_stalled');
  }, 250);
  try {
    if (controller.state === 'running') {
      audit({ kind: 'resume-request', monotonicMs: performance.now(), deadline: controller.deadline });
      bounded(() => io.resume(), 2000, 'resume').then(result => {
        if (result !== 'OK') controller.fault('resume_non_ok');
        else audit({ kind: 'resume-response', result, monotonicMs: performance.now() });
      }).catch(() => controller.fault('resume_failed_or_unconfirmed'));
    }
    const result = await controller.done;
    evidence.file('stop-result.json', result);
    if (!result.pauseConfirmed) throw new Error('pause not confirmed; see stop-result.json');
    const snapshot = await bounded(() => io.finalSnapshot(), 4000, 'final snapshot');
    evidence.file('paused-snapshot.json', snapshot);
    if (mode === 'control') {
      const report = assessControlSamples(result.controlSamples, { userId: io.binding.userId, username: config.username, experimentId: config.experimentId, armed }, snapshot.memory);
      evidence.file('roundtrip-result.json', report);
      if (!result.ok || !report.ready) throw new Error('control roundtrip failed');
      return { result, pausedForNextStage: true }; // no send reachable; same record retained
    }
    // Formal run always remains stopped, even when observation/rejection failed.
    try { await updateMemory(io, 'disarm', config.experimentId, audit); }
    finally { await bounded(() => io.killTree(), 5000, 'final process-tree stop'); }
    return { result, processTreeStopped: true };
  } finally {
    clearInterval(healthTimer); process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
  }
}

async function execute(options, evidence) {
  const config = load('labConfig.ts').LAB_EXAMPLE_EXPERIMENT;
  if (options.experiment !== config.experimentId || options.username !== config.username) throw new Error('CLI identity must equal compiled labConfig.ts; no runtime override');
  const io = await connectLocal({ environmentRoot: options.environment, host: options.host, port: options.port,
    pid: options.pid, userId: options.user, username: options.username }, evidence.audit);
  try {
    if (options.command === 'inspect') {
      const tick = await io.assertPausedStable(); return { tick, ...readMemory(await io.readRuntimeMemory()) };
    }
    if (['initialize','arm'].includes(options.command)) await assertProbe(io, options.probe);
    if (options.command === 'arm') await verifyProof(options.proof, io, config, false);
    if (['initialize','arm','disarm'].includes(options.command)) return await updateMemory(io, options.command, config.experimentId, evidence.audit);
    if (options.command === 'facts') {
      const proof = await verifyProof(options.proof, io, config, true);
      const stamp = options['last-world-change'];
      if (!Number.isFinite(Date.parse(stamp)) || !proof.samples.every(s => Date.parse(s.collectedAtWallClock) > Date.parse(stamp))) throw new Error('baseline is not after last world modification');
      const facts = { factsKind: 'lab-calibration-facts', context: {
        runId: config.experimentId, paused: true, pauseConfirmedTick: proof.tick, lastAdminChangeWallClock: stamp,
        user: { id: io.binding.userId, idSource: 'verified local user + player console envelope' },
        sampler: { name: 'lab-control-probe', version: '1' },
      }, samples: proof.samples.map(sample => ({ ...sample, runId: config.experimentId })) };
      evidence.file('calibration-facts.json', facts); return { proofSha256: proof.sha256, facts };
    }
    if (options.command.startsWith('observe-')) {
      await assertProbe(io, options.probe);
      return await runSession(io, config, 'control', options.command === 'observe-armed', evidence);
    }
    await verifyProof(options.proof, io, config, true);
    await assertFormalModules(io, options);
    const facts = JSON.parse(fs.readFileSync(options.facts, 'utf8'));
    const tick = await io.assertPausedStable();
    if (facts.context?.pauseConfirmedTick !== tick || config.targetTick < tick + 3) throw new Error('stale pause point / unreachable formal window');
    const effectiveFacts = { ...facts, context: { ...facts.context, codeSource: {
      repoHead: execFileSync('git', ['rev-parse','HEAD'], { cwd: path.resolve(LAB, '../../..'), encoding: 'utf8' }).trim(),
      labConfigSha256: hash(fs.readFileSync(path.join(LAB, 'labConfig.ts'))),
    } } };
    const calibration = load('calibrationCheck.ts').checkLabCalibration(config, effectiveFacts);
    evidence.file('formal-preflight.json', { config, factsSha256: hash(fs.readFileSync(options.facts)), report: calibration });
    if (calibration.status !== 'pass') throw new Error('calibration rejected');
    // Inspect paused raw world again. C02 labels alone cannot validate changed
    // endpoint state after code reload or the long offline validation phase.
    const snapshot = await io.finalSnapshot(); evidence.file('formal-before.json', snapshot);
    const newest = [...facts.samples].sort((a,b) => a.tick - b.tick).at(-1);
    for (const side of ['source','target']) {
      const object = snapshot.objects.find(o => o._id === config[side + 'TerminalId']);
      const sample = newest[side];
      if (!object || object.type !== 'terminal' || object.room !== config[side + 'RoomName']
          || (object.store?.H ?? 0) !== sample.resourceAmount || (object.store?.energy ?? 0) !== sample.energy) throw new Error('paused endpoint differs from baseline');
    }
    return await runSession(io, config, 'formal', true, evidence);
  } catch (error) {
    // Failure never re-arms, resumes again or clears attempted. Persist what is
    // obtainable, then stop only the bound environment, including prepare errors.
    try { evidence.audit({ kind: 'command-failed', error: String(error) }); } catch {}
    try { await bounded(() => io.pause(), 2000, 'failure pause'); } catch {}
    try { await bounded(() => io.killTree(), 5000, 'failure process stop'); }
    catch (killError) { throw new Error(`${error}; PROCESS_STOP_UNCONFIRMED: ${killError}`); }
    throw error;
  }
}
if (require.main === module) {
  let evidence;
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('lab-control.cjs --command <' + COMMANDS.join('|') + '> --environment <new-lab-dir> --host <127.0.0.1|::1> --port <storage-port> --pid <bound-launcher> --user <synthetic-id> --username <lab-name> --experiment <compiled-id> --out <NEW-evidence-dir> [--probe <main.js>] [--proof <raw-console.jsonl>] [--facts <facts.json>] [--last-world-change <ISO>] [--observer <file> --single-shot <file> --main <file>]'); return 0;
    }
    evidence = createEvidence(options.out);
    evidence.audit({ kind: 'command', options, node: process.version });
    const result = await execute(options, evidence);
    evidence.file('result.json', result); console.log(JSON.stringify(result, null, 2));
    return result?.result && !result.result.ok ? 1 : 0;
  })().then(code => { evidence?.close(); process.exit(code); }, error => {
    try { evidence?.audit({ kind: 'fatal', error: String(error) }); evidence?.close(); } catch {}
    console.error(String(error)); process.exit(1);
  });
}
module.exports = { parseArgs, createEvidence, proofSamples, verifyProof, assertProbe, assertFormalModules, subscribeReady, runSession, execute };
