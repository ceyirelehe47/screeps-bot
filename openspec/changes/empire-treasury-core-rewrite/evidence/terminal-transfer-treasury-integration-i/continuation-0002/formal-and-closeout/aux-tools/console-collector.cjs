#!/usr/bin/env node
'use strict';
// Lab-only read-only console collector: subscribes to the isolated server's
// pubsub and appends every envelope (channel + payload + receive wall clock)
// to a JSONL file. It never publishes, writes storage, or touches game state.
// Usage: node console-collector.cjs <out.jsonl>   (env: STORAGE_HOST, STORAGE_PORT)
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2];
if (!out) { console.error('usage: console-collector.cjs <out.jsonl>'); process.exit(2); }
const serverRoot = process.env.LAB_SERVER_ROOT;
if (!serverRoot) { console.error('LAB_SERVER_ROOT required'); process.exit(2); }
const { createRequire } = require('node:module');
const localRequire = createRequire(path.join(serverRoot, 'package.json'));
const common = localRequire('@screeps/common');
const fd = fs.openSync(out, 'a');
function write(record) {
  const bytes = Buffer.from(JSON.stringify(record) + '\n'); let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}
(async () => {
  await common.storage._connect();
  const { pubsub } = common.storage;
  await pubsub.subscribe('*', function (payload) {
    write({ channel: this.channel, payload, recvWallClock: new Date().toISOString() });
  });
  write({ kind: 'collector-ready', pid: process.pid, at: new Date().toISOString() });
  console.log('collector ready pid=' + process.pid + ' -> ' + out);
})().catch(error => { console.error(String(error)); process.exit(1); });
