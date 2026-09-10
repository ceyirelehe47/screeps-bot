#!/usr/bin/env node
'use strict';
/**
 * 离线替身：本地 HTTP + WebSocket 双协议 mock，模拟 screeps 官方 API 的
 * 子集（branches / code get/set / query-token / console 推送）。
 * 仅用于部署前的恢复链路与收集通路演练，绝不接触真实凭据或真实服务器。
 *
 * 用法：node mock-screeps.cjs --state <state.json> [--fail-set always|once] [--push-big-console]
 *  - state.json: { "modules": { "main": "..." } }（初值由演练脚本准备）
 *  - --fail-set always: POST /api/user/code 永远返回 ok:0
 *  - --fail-set once:   第一次 set 失败，之后成功
 *  - --push-big-console: 每个已认证 ws 连接在 subscribe user/console 后推一条
 *    >16KB 的 console 帧（验证收集器不截断）
 * 输出（stdout, 一行 JSON）：{"port": <port>, ...} 供演练脚本读取。
 */
const http = require('node:http');
const fs = require('node:fs');
const wsModule = require('ws');
const WebSocketServer = wsModule.WebSocketServer ?? wsModule.Server;

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
const statePath = opt('--state', null);
const failSet = opt('--fail-set', 'none');
const pushBig = argv.includes('--push-big-console');
const state = statePath ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { modules: {} };
let setAttempts = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/api/auth/query-token') {
    return send({ ok: 1, token: { _id: 'mock-token-id', full: true } });
  }
  if (url.pathname === '/api/auth/me') {
    return send({ ok: 1, _id: 'mock-user', username: 'mock' });
  }
  if (url.pathname === '/api/user/name') {
    return send({ ok: 1, username: 'mock' });
  }
  if (url.pathname === '/api/user/find') {
    return send({ ok: 1, user: { _id: 'mock-user', username: 'mock' } });
  }
  if (url.pathname === '/api/user/branches') {
    return send({ ok: 1, list: [{ branch: 'default', activeWorld: true, activeSim: false }] });
  }
  if (url.pathname === '/api/user/code' && req.method === 'GET') {
    return send({ ok: 1, branch: url.searchParams.get('branch') ?? 'default', modules: state.modules });
  }
  if (url.pathname === '/api/user/code' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    return req.on('end', () => {
      setAttempts += 1;
      const fail = failSet === 'always' || (failSet === 'once' && setAttempts === 1);
      if (fail) return send({ ok: 0, error: 'mock-set-failure' });
      const parsed = JSON.parse(body);
      state.modules = parsed.modules ?? {};
      return send({ ok: 1 });
    });
  }
  res.statusCode = 404;
  return send({ ok: 0, error: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/socket/websocket' });
wss.on('connection', (ws) => {
  let subscribedConsole = false;
  ws.on('message', (data) => {
    const text = String(data);
    if (text.startsWith('auth ')) {
      ws.send(`auth ok ${text.slice(5)}`);
      if (pushBig && subscribedConsole) pushBigFrame(ws);
    } else if (text.startsWith('subscribe ')) {
      if (/^subscribe user:.+\/console$/.test(text)) {
        subscribedConsole = true;
        if (pushBig) pushBigFrame(ws);
      }
    }
  });
});
function pushBigFrame(ws) {
  // 17KB 单行 log，超过 16384 字节：验证收集器不按 4096/8192 截断
  const big = 'x'.repeat(17_000);
  const payload = {
    error: [],
    messages: { log: [`MOCK_BIG_FRAME marker-start ${big} marker-end`], results: [] },
    result: [],
    tick: 12345,
    shard: 'shard1',
  };
  // Screeps ws 协议：["user:<id>/console", payload]（type:id/channel，冒号分隔）
  ws.send(JSON.stringify(['user:mock/console', payload]));
}

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({ port, failSet, pushBig }));
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
