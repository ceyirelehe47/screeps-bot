'use strict';
const { isDeepStrictEqual } = require('node:util');
const { load } = require('./ts-module.cjs');
const SLOT = '__labTerminalTransferProbe';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value.length <= 100;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readMemory(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('runtime Memory absent/unreadable; do not replace it with {}');
  let memory;
  try { memory = JSON.parse(raw); } catch { throw new Error('runtime Memory is invalid JSON'); }
  if (!plain(memory)) throw new Error('runtime Memory root must be an object');
  // Reuse the frozen in-game reader/size semantics on a separate parsed snapshot.
  const reader = load('controlRecord.ts', { Memory: memory, console: { log() {} } });
  const read = reader.readControlRecord();
  return { memory, read: JSON.parse(JSON.stringify(read)),
    totalMemoryBytes: Buffer.byteLength(raw, 'utf8'),
    controlBytes: Object.hasOwn(memory, SLOT) ? Buffer.byteLength(JSON.stringify(memory[SLOT]), 'utf8') : null };
}

function planMemoryUpdate(raw, action, experimentId) {
  if (!validId(experimentId)) throw new Error('invalid experimentId');
  if (!['initialize', 'arm', 'disarm'].includes(action)) throw new Error('unsupported Memory action');
  const before = readMemory(raw);
  const { status, record } = before.read;
  let next;
  if (action === 'initialize') {
    if (status !== 'absent') throw new Error('initialize requires an absent control slot; no reset/overwrite');
    next = { experimentId, armed: false, attempted: false };
  } else {
    if (status !== 'ok' || record.experimentId !== experimentId) throw new Error('control corrupt/absent/experiment mismatch');
    if (action === 'arm') {
      if (record.armed !== false || record.attempted !== false || record.stopped === true
          || record.attemptedTick !== undefined || record.syncResult !== undefined) {
        throw new Error('arm requires a pristine unarmed record; no rearm');
      }
      next = { ...record, armed: true };
    } else {
      // Explicit disarm closes this experiment using the existing stopped flag.
      // Preserve attempted/result facts, including unknown; never make it re-armable.
      next = { ...record, armed: false, stopped: true };
    }
  }
  const updated = { ...before.memory, [SLOT]: next };
  const afterRaw = JSON.stringify(updated);
  const after = readMemory(afterRaw);
  if (after.read.status !== 'ok') throw new Error('updated control rejected by frozen reader/4096-byte limit');
  // The driver limit is on the whole serialized string; this conservative bound
  // avoids a successful admin write which would fail the normal subsequent save.
  if (afterRaw.length > 2 * 1024 * 1024) throw new Error('whole Memory exceeds driver string limit');
  return { beforeRaw: raw, afterRaw, record: next,
    beforeControlBytes: before.controlBytes, controlBytes: after.controlBytes,
    totalMemoryBytes: after.totalMemoryBytes };
}

async function updateMemory(io, action, experimentId, audit = () => {}) {
  // io is the verified env-only adapter. No db.users writer is accepted here.
  await io.assertIdentity();
  const tick = await io.assertPausedStable();
  const beforeRaw = await io.readRuntimeMemory();
  const plan = planMemoryUpdate(beforeRaw, action, experimentId);
  if (await io.assertPausedStable() !== tick || await io.readRuntimeMemory() !== beforeRaw) {
    throw new Error('world/Memory changed during preparation; zero writes');
  }
  audit({ kind: 'memory-write-request', action, tick, ...plan }); // must save before mutation
  await io.writeRuntimeMemory(plan.afterRaw); // exactly one write, never a fallback write
  const readback = await io.readRuntimeMemory();
  audit({ kind: 'memory-storage-readback', action, tick, raw: readback });
  if (readback !== plan.afterRaw) throw new Error('runtime storage readback mismatch; outcome unknown, no retry/rollback');
  if (await io.assertPausedStable() !== tick) throw new Error('world advanced after write; no automatic repair');
  return { ...plan, tick, storageConfirmed: true, playerConfirmed: false };
}

function assessControlSamples(samples, expected, storedRaw) {
  const issues = [];
  if (!Array.isArray(samples)) return { ready: false, issues: ['samples must be an array'] };
  if (samples.length < 2) issues.push('two player ticks required');
  const seen = new Set();
  let first;
  for (const sample of samples) {
    const record = sample?.control?.record;
    if (sample?.kind !== 'lab-control-sample' || sample.sampler?.name !== 'lab-control-probe'
        || sample.userId !== expected.userId || sample.user?.username !== expected.username
        || sample.expectedExperimentId !== expected.experimentId) issues.push('wrong player/sampler/experiment source');
    if (!Number.isSafeInteger(sample?.tick) || sample.tick < 0 || seen.has(sample.tick)) issues.push('invalid/duplicate tick');
    seen.add(sample?.tick);
    if (sample?.control?.status !== 'ok' || !plain(record)) { issues.push('control not readable'); continue; }
    const read = readMemory(JSON.stringify({ [SLOT]: record })).read;
    if (read.status !== 'ok' || record.experimentId !== expected.experimentId
        || record.armed !== expected.armed || record.attempted !== false
        || record.stopped === true || record.attemptedTick !== undefined || record.syncResult !== undefined) {
      issues.push('unexpected control facts');
    }
    if (first && !isDeepStrictEqual(first, record)) issues.push('control not stable');
    first = record;
  }
  if (storedRaw !== undefined) {
    try {
      const stored = readMemory(storedRaw).read;
      if (stored.status !== 'ok' || !isDeepStrictEqual(first, stored.record)) issues.push('post-pause runtime storage differs from player');
    } catch (error) { issues.push(error.message); }
  }
  return { ready: issues.length === 0, issues: [...new Set(issues)], ticks: [...seen] };
}
module.exports = { SLOT, validId, readMemory, planMemoryUpdate, updateMemory, assessControlSamples };
