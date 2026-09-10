#!/usr/bin/env node
'use strict';
/**
 * 官方服通路探针 v2（只读）：
 *  - /api/user/overview?interval=8&statName=energyControl → 自有房间数组；
 *  - WebSocket 订阅 user/console + user/cpu：cpu 帧由服务器每 tick 推送，
 *    收到任一 user:<id>/cpu 帧即用户通道活性的正面证明；
 *  - tick 锚点（/api/game/time?shard=shard1）。
 * 用法：node probe2-live.cjs <secretPath> <outJsonl> [--seconds 45]
 */
const fs = require('node:fs');
const path = require('node:path');
const { ScreepsAPI } = require('screeps-api');

const args = process.argv.slice(2);
const secIdx = args.indexOf('--seconds');
const seconds = secIdx >= 0 ? Number(args[secIdx + 1]) : 45;
const [secretPath, outJsonl] = args.slice(0, 2);
if (!secretPath || !outJsonl) {
  console.error('usage: node probe2-live.cjs <secretPath> <outJsonl> [--seconds 45]');
  process.exit(2);
}
fs.mkdirSync(path.dirname(outJsonl), { recursive: true });
function emit(entry) { fs.appendFileSync(outJsonl, JSON.stringify(entry) + '\n'); }

(async () => {
  const secret = JSON.parse(fs.readFileSync(secretPath, 'utf8'))['main'];
  const api = new ScreepsAPI(secret);

  let rooms;
  try {
    const o = await api.raw.user.overview(8, 'energyControl');
    rooms = Array.isArray(o?.rooms) ? o.rooms : Object.keys(o?.rooms ?? {});
  } catch (e) {
    rooms = { error: String(e.message || e).slice(0, 120) };
  }

  const tickAnchor = await api.raw.game.time('shard1').catch((e) => ({ error: String(e.message || e).slice(0, 120) }));

  await api.socket.connect();
  api.socket.ws.on('message', (data) => {
    emit({ kind: 'ws-frame', receivedAt: new Date().toISOString(), bytes: Buffer.byteLength(String(data)), text: String(data) });
  });
  api.socket.on('console', (event) => {
    emit({ kind: 'console-event', receivedAt: new Date().toISOString(), event });
  });
  api.socket.on('cpu', (event) => {
    emit({ kind: 'cpu-event', receivedAt: new Date().toISOString(), event });
  });
  await api.socket.subscribe('user/console');
  await api.socket.subscribe('user/cpu');
  emit({ kind: 'probe2-header', at: new Date().toISOString(), rooms, tickAnchor });

  await new Promise((r) => setTimeout(r, seconds * 1000));
  emit({ kind: 'probe2-footer', at: new Date().toISOString(), reason: 'duration-elapsed' });
  try { api.socket.disconnect(); } catch { /* 忽略 */ }
  const lines = fs.readFileSync(outJsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const count = (k) => lines.filter((f) => f.kind === k).length;
  const maxBytes = lines.filter((f) => f.kind === 'ws-frame').reduce((a, f) => Math.max(a, f.bytes ?? 0), 0);
  console.log(JSON.stringify({
    status: 'PROBE2_DONE',
    rooms,
    tickTime: tickAnchor?.time,
    wsFrames: count('ws-frame'),
    consoleEvents: count('console-event'),
    cpuEvents: count('cpu-event'),
    maxFrameBytes: maxBytes,
  }, null, 1));
  setTimeout(() => process.exit(0), 300);
})().catch((e) => {
  console.error('probe failed:', String(e.message || e).slice(0, 200));
  process.exit(1);
});
