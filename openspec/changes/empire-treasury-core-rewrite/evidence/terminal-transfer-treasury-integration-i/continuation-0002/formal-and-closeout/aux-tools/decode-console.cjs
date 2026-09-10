#!/usr/bin/env node
'use strict';
// Continuation 0002 evidence decoder (same one-pass rules as the frozen
// 2026-09-10 decoder, plus collector control lines and engine completion
// events). No writes, no game access.
//   outer JSONL -> payload JSON -> one-pass HTML entity decode -> inner JSON
const fs = require('node:fs');
const file = process.argv[2];
const userId = process.argv[3];
if (!file || !userId) { console.error('usage: decode-console.cjs <raw.jsonl> <userId> [--engine]'); process.exit(2); }
const entities = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#x22;': '"', '&#x27;': "'", '&#x2F;': '/', '&#39;': "'" };
const unescapeOnce = s => s.replace(/&(quot|amp|lt|gt|#x22|#x27|#x2F|#39);/g, m => entities[m]);
const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const samples = []; const errors = []; const channels = {}; const engine = [];
let playerLines = 0;
for (const line of raw) {
  let envelope;
  try { envelope = JSON.parse(line); } catch (error) { errors.push({ line: line.slice(0, 120), error: String(error) }); continue; }
  if (envelope.kind) { channels[envelope.kind] = (channels[envelope.kind] || 0) + 1; continue; }
  const channel = String(envelope.channel);
  channels[channel] = (channels[channel] || 0) + 1;
  if (channel === 'tickStarted' || channel === 'roomsDone' || channel.startsWith('queueDone:') || channel === 'runtimeRestart') {
    engine.push({ channel, payload: envelope.payload, recvWallClock: envelope.recvWallClock });
    continue;
  }
  if (channel !== `user:${userId}/console`) continue;
  playerLines += 1;
  let payload;
  try { payload = JSON.parse(String(envelope.payload)); } catch (error) { errors.push({ channel, error: String(error) }); continue; }
  for (const item of payload.messages?.log ?? []) {
    const text = unescapeOnce(String(item));
    try { const s = JSON.parse(text); if (s && s.kind) samples.push({ ...s, recvWallClock: envelope.recvWallClock }); else samples.push({ kind: 'unparsed', text }); }
    catch { samples.push({ kind: 'unparsed', text }); }
  }
}
console.log(JSON.stringify({ lines: raw.length, playerConsoleLines: playerLines, decoded: samples.length, errors: errors.length }, null, 1));
const control = samples.filter(s => s.kind === 'lab-control-sample');
if (control.length) {
  const ticks = control.map(s => s.tick);
  const quotes = [...new Set(control.map(s => s.feeQuote && s.feeQuote.energyCost))];
  const shards = [...new Set(control.map(s => s.shard && s.shard.name))];
  const ids = [...new Set(control.map(s => s.expectedExperimentId))];
  const users = [...new Set(control.map(s => s.user && s.user.username))];
  const txCounts = [...new Set(control.map(s => s.transactions && JSON.stringify(Object.fromEntries(Object.entries(s.transactions).map(([k, v]) => [k, v.records ? v.records.length : 'none'])))))];
  const srcH = [...new Set(control.map(s => s.source.resourceAmount))];
  const srcE = [...new Set(control.map(s => s.source.energy))];
  const tgtH = [...new Set(control.map(s => s.target.resourceAmount))];
  const tgtE = [...new Set(control.map(s => s.target.energy))];
  const srcFree = [...new Set(control.map(s => s.source.freeCapacity))];
  const tgtFree = [...new Set(control.map(s => s.target.freeCapacity))];
  const srcCd = [...new Set(control.map(s => s.source.cooldown))];
  const tgtCd = [...new Set(control.map(s => s.target.cooldown))];
  const srcTid = [...new Set(control.map(s => s.source.terminalId))];
  const tgtTid = [...new Set(control.map(s => s.target.terminalId))];
  const srcCtrl = [...new Set(control.map(s => JSON.stringify(s.source.controller)))];
  const tgtCtrl = [...new Set(control.map(s => JSON.stringify(s.target.controller)))];
  console.log(JSON.stringify({ sampleCount: control.length, tickRange: [ticks[0], ticks[ticks.length - 1]], gaps: ticks.some((t, i) => i && t !== ticks[i - 1] + 1), quotes, shards, ids, users, srcTid, tgtTid, srcH, srcE, tgtH, tgtE, srcFree, tgtFree, srcCd, tgtCd, srcCtrl, tgtCtrl, txCounts, firstControl: control[0].control && control[0].control.status }, null, 1));
}
const kinds = {};
for (const s of samples) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
console.log(JSON.stringify({ kinds }));
console.log(JSON.stringify({ channels }));
if (process.argv.includes('--engine')) {
  console.log(JSON.stringify({ engineCount: engine.length }));
  for (const e of engine.slice(0, 4)) console.log(JSON.stringify(e));
  console.log('...');
  for (const e of engine.slice(-4)) console.log(JSON.stringify(e));
}
