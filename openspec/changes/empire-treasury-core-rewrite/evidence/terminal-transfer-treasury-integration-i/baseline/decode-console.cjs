'use strict';
// Decode lab console envelopes: payload = JSON.stringify({userId, messages:{log:[html-escaped JSON]}})
// One pass of HTML entity decoding per payload (server escapes once).
const fs = require('node:fs');
const file = process.argv[2];
const entities = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#x22;': '"', '&#x27;': "'", '&#x2F;': '/', '&#39;': "'" };
const unescapeOnce = s => s.replace(/&(quot|amp|lt|gt|#x22|#x27|#x2F|#39);/g, m => entities[m]);
const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const samples = [];
for (const line of raw) {
  const envelope = JSON.parse(line);
  const payload = JSON.parse(String(envelope.payload));
  for (const item of payload.messages?.log ?? []) {
    const text = unescapeOnce(String(item));
    try { const s = JSON.parse(text); if (s && s.kind) samples.push(s); } catch { samples.push({ kind: 'unparsed', text }); }
  }
}
console.log(JSON.stringify({ lines: raw.length, decoded: samples.length }));
const control = samples.filter(s => s.kind === 'lab-control-sample');
if (control.length) {
  const first = control[0], last = control[control.length - 1];
  const ticks = control.map(s => s.tick);
  const quotes = [...new Set(control.map(s => s.feeQuote && s.feeQuote.energyCost))];
  const shards = [...new Set(control.map(s => s.shard && s.shard.name))];
  const ids = [...new Set(control.map(s => s.expectedExperimentId))];
  const users = [...new Set(control.map(s => s.user && s.user.username))];
  const txCounts = [...new Set(control.map(s => s.transactions && JSON.stringify(Object.fromEntries(Object.entries(s.transactions).map(([k, v]) => [k, v.records ? v.records.length : 'none'])))))];
  const srcH = [...new Set(control.map(s => s.source.store && s.source.store.H))];
  const srcE = [...new Set(control.map(s => s.source.store && s.source.store.energy))];
  const tgtE = [...new Set(control.map(s => s.target.store && s.target.store.energy))];
  const srcTid = [...new Set(control.map(s => s.source.terminalId))];
  const tgtTid = [...new Set(control.map(s => s.target.terminalId))];
  console.log(JSON.stringify({ sampleCount: control.length, tickRange: [ticks[0], ticks[ticks.length - 1]], gaps: ticks.some((t, i) => i && t !== ticks[i - 1] + 1), quotes, shards, ids, users, srcTid, tgtTid, srcH, srcE, tgtE, txCounts, firstControl: first.control && first.control.status }, null, 1));
}
const kinds = {};
for (const s of samples) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
console.log(JSON.stringify({ kinds }));
