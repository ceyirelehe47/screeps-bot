// Calibration Rerun——console JSONL 解码（外层 JSONL → payload JSON →
// messages.log HTML 实体解码 → lab JSON）。只读，不改原件。
'use strict';
const fs = require('fs');
const [,, inFile, outFile] = process.argv;
if (!inFile || !outFile) { console.error('usage: node tools/decode-console.cjs <in.jsonl> <out.json>'); process.exit(2); }
const decode = (s) => s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const rows = [];
for (const line of fs.readFileSync(inFile, 'utf8').trim().split('\n')) {
  if (!line) continue;
  const outer = JSON.parse(line);
  const payload = JSON.parse(outer.payload);
  const logs = (payload.messages && payload.messages.log) || [];
  for (const entry of logs) {
    rows.push({ seq: outer.seq, recvWallClock: outer.recvWallClock, channel: outer.channel, userId: payload.userId, sample: JSON.parse(decode(entry)) });
  }
}
fs.writeFileSync(outFile, JSON.stringify(rows, null, 1) + '\n');
console.log('DECODED', rows.length, 'rows ->', outFile);
