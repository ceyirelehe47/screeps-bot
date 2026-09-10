'use strict';
const fs = require('node:fs');
const [file, userId, filterKind] = process.argv.slice(2);
const entities = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#x22;': '"', '&#x27;': "'", '&#x2F;': '/', '&#39;': "'" };
const unescapeOnce = s => s.replace(/&(quot|amp|lt|gt|#x22|#x27|#x2F|#39);/g, m => entities[m]);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const out = [];
for (const line of lines) {
  const envelope = JSON.parse(line);
  if (envelope.channel !== `user:${userId}/console`) continue;
  const payload = JSON.parse(String(envelope.payload));
  for (const item of payload.messages?.log ?? []) {
    const text = unescapeOnce(String(item));
    let s; try { s = JSON.parse(text); } catch { continue; }
    if (!s || !s.kind) continue;
    if (filterKind && !s.kind.includes(filterKind)) continue;
    out.push({ wall: envelope.recvWallClock, ...s });
  }
}
for (const e of out) console.log(JSON.stringify(e));
console.error('matched ' + out.length);
