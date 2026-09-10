#!/usr/bin/env node
'use strict';
// Lab-only admin CLI client for the isolated standalone server.
//
// Wire protocol (from @screeps/backend/lib/cli/server.js + sandbox.js):
//   on connect : greeting + "< \r\n"                       (fake prompt line)
//   per command: "< " + util.inspect(result) + "\r\n"      (isResult=true)
//                raw console output lines (no prefix) may precede it
//                a promise resolving to a FALSY value emits NOTHING at all
//   undefined/falsy results therefore leave the response unterminated, so this
//   client only sends expressions whose completion value is defined and truthy.
//
// Usage: node adm-cli.cjs <expression> [more expressions...]
const net = require('node:net');
const HOST = process.env.CLI_HOST || '::1';
const PORT = Number(process.env.CLI_PORT || 21026);
const TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS || 60000);
const expressions = process.argv.slice(2).filter(a => a !== '');
if (!expressions.length) { console.error('usage: adm-cli.cjs <expression> [more...]'); process.exit(2); }

const socket = net.connect(PORT, HOST);
socket.setEncoding('utf8');
let buffer = '';        // everything received
let cursor = 0;         // start of the unprocessed region
let sent = 0;
let settled = false;
const timer = setTimeout(() => {
  if (settled) return; settled = true; socket.destroy();
  console.error('CLI timeout after ' + TIMEOUT_MS + 'ms; responses received=' + sent + '/' + expressions.length);
  process.exit(1);
}, TIMEOUT_MS);

function next() {
  if (sent >= expressions.length) { settled = true; clearTimeout(timer); socket.end(); return; }
  socket.write(expressions[sent] + '\r\n');
}
function unquote(text) {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}
socket.on('error', error => {
  if (settled) return; settled = true; clearTimeout(timer);
  console.error('CLI socket error: ' + error.message); process.exit(1);
});
socket.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const region = buffer.slice(cursor);
    // The greeting's own prompt is consumed lazily as the first "< " line.
    const marker = region.indexOf('< ');
    if (marker === -1) return;
    if (marker !== 0 && !/[\r\n]$/.test(region.slice(0, marker))) return; // "< " mid-line: not a marker
    const body = region.slice(marker + 2);
    const eol = body.indexOf('\r\n');
    if (eol === -1) return; // result line not terminated yet
    const text = body.slice(0, eol);
    cursor += marker + 2 + eol + 2;
    if (sent === 0 && text === '' && !output.started) { output.started = true; next(); return; } // banner prompt
    if (text === '') { // unterminated-undefined response style: refuse to guess
      console.error('empty response for: ' + expressions[sent]); process.exit(3);
    }
    console.log('EXPR> ' + expressions[sent]);
    console.log(unquote(text));
    sent += 1;
    next();
    return;
  }
});
const output = { started: false };
socket.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); process.exit(0); } });
