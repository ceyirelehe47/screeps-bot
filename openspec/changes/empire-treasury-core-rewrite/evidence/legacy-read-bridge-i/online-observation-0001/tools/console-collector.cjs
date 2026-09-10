#!/usr/bin/env node
'use strict';
/**
 * 本轮受控 console 收集器（会话级，非常驻服务；原生 ws 实现）：
 *  - 官方协议：auth <token> → subscribe user:<userId>/console（+ user:<userId>/cpu 活性心跳）；
 *  - 原帧同步追加落盘，不截断任何消息（16KB 单行按原样保存）；
 *  - userId 进程内经 /api/auth/me 取得；凭据不进命令行、不写日志。
 * 用法：node console-collector.cjs <secretPath> <outJsonl> [--max-minutes N] [--no-cpu]
 * 退出：SIGINT/SIGTERM 或 --max-minutes 到期时写 footer 后干净退出（exit 0）。
 */
const fs = require('node:fs');
const path = require('node:path');
const httpMod = require('node:http');
const httpsMod = require('node:https');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const maxMinutesIdx = args.indexOf('--max-minutes');
const maxMinutes = maxMinutesIdx >= 0 ? Number(args[maxMinutesIdx + 1]) : null;
const subscribeCpu = !args.includes('--no-cpu');
const [secretPath, outJsonl] = args.slice(0, 2);
if (!secretPath || !outJsonl) {
  console.error('usage: node console-collector.cjs <secretPath> <outJsonl> [--max-minutes N] [--no-cpu]');
  process.exit(2);
}

fs.mkdirSync(path.dirname(outJsonl), { recursive: true });
// 同步追加：进程被外部终止（Windows kill 不走 SIGTERM 处理器）时，
// 已接收的每一帧都已经在盘上，不依赖退出前的缓冲 flush。
function emit(entry) { fs.appendFileSync(outJsonl, JSON.stringify(entry) + '\n'); }

let consoleEvents = 0;
let cpuEvents = 0;
let otherEvents = 0;
let rawMax = 0;
let footerWritten = false;
function writeFooter(reason) {
  if (footerWritten) return;
  footerWritten = true;
  try {
    emit({ kind: 'collector-footer', reason, at: new Date().toISOString(), stats: { consoleEvents, cpuEvents, otherEvents, rawMaxFrameBytes: rawMax } });
  } catch { /* 已尽力；帧本体都已同步落盘 */ }
}
process.on('SIGINT', () => { writeFooter('sigint'); setTimeout(() => process.exit(0), 200); });
process.on('SIGTERM', () => { writeFooter('sigterm'); setTimeout(() => process.exit(0), 200); });
if (maxMinutes) {
  setTimeout(() => { writeFooter('max-minutes'); process.exit(0); }, maxMinutes * 60_000).unref();
}

function apiGet(secret, pathname) {
  const mod = secret.protocol === 'https' ? httpsMod : httpMod;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: secret.hostname,
      port: secret.port,
      path: (secret.path === '/' ? '' : secret.path) + pathname,
      method: 'GET',
      headers: { 'X-Token': secret.token, 'X-Username': secret.token },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const secret = JSON.parse(fs.readFileSync(secretPath, 'utf8'))['main'];
  const me = await apiGet(secret, '/api/auth/me');
  const userId = me?._id;
  if (!userId) throw new Error('cannot resolve userId');

  const wsUrl = `${secret.protocol === 'https' ? 'wss' : 'ws'}://${secret.hostname}${secret.port === 443 || secret.port === 80 ? '' : ':' + secret.port}/socket/websocket`;
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => { ws.send(`auth ${secret.token}`); });
  ws.on('message', (data) => {
    const text = String(data);
    const bytes = Buffer.byteLength(text);
    if (bytes > rawMax) rawMax = bytes;
    emit({ kind: 'ws-frame', receivedAt: new Date().toISOString(), bytes, text });
    if (text.startsWith('auth ok')) {
      ws.send(`subscribe user:${userId}/console`);
      if (subscribeCpu) ws.send(`subscribe user:${userId}/cpu`);
      emit({ kind: 'collector-header', at: new Date().toISOString(), subscribedConsole: `user:${userId}/console`, subscribedCpu: subscribeCpu ? `user:${userId}/cpu` : null, server: `${secret.protocol}://${secret.hostname}` });
    } else if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
          if (parsed[0].endsWith('/console')) consoleEvents += 1;
          else if (parsed[0].endsWith('/cpu')) cpuEvents += 1;
          else otherEvents += 1;
        }
      } catch { /* 已按原帧保存 */ }
    } else {
      otherEvents += 1;
    }
  });
  ws.on('error', (err) => {
    emit({ kind: 'socket-error', receivedAt: new Date().toISOString(), message: String(err?.message || err).slice(0, 200) });
  });
  ws.on('close', (code, reason) => {
    emit({ kind: 'socket-close', receivedAt: new Date().toISOString(), code, reason: String(reason).slice(0, 100) });
    writeFooter('socket-closed');
    process.exit(subscribeCpu ? 1 : 0);
  });
  console.log(`[collector] ws ${wsUrl} user:${userId}/console -> ${outJsonl}`);
  setInterval(() => {}, 30_000);
})().catch((e) => {
  writeFooter(`fatal:${String(e.message || e).slice(0, 120)}`);
  console.error('[collector] fatal:', String(e.message || e).slice(0, 200));
  process.exit(1);
});
