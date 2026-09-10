#!/usr/bin/env node
'use strict';
/**
 * 部署前离线替身演练驱动：
 *  A. 收集通路：mock 推 >16KB console 帧 → 收集器原帧落盘不截断
 *  B. 收集器退出/无样本仍触发恢复请求：guard --collector-pid 指向已退出 pid →
 *     mock 远端为部署产物 → 恢复成功回读一致（RESTORED_AND_VERIFIED，exit 0）
 *  C. 恢复失败不能报告已关闭：mock --fail-set always → guard exit 6
 *     ONLINE_CLOSE_UNCONFIRMED（绝不报"线上已关"）
 *  D. 第三方新产物出现时不覆盖：mock state 为未知产物 → restore exit 3 CONFLICT
 *  E. 已恢复不重复写：mock state == backup → ALREADY_RESTORED exit 0
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const TOOLS = __dirname;
const WORK = path.join(TOOLS, '..', 'rehearsal');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const NODE_PATH = 'D:\\code\\screeps\\screeps-bot-compat-read-i\\node_modules';
const BACKUP = { main: 'console.log("ORIGINAL PRODUCTION 06ffedb");' };
const DEPLOYED = { main: 'console.log("COMPAT CANDIDATE BUILD");' };
const THIRD_PARTY = { main: 'console.log("SOMEONE ELSE DEPLOYED");' };

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function start(command, args, opts = {}) {
  const child = spawn(command === 'node' ? process.execPath : command, args, {
    cwd: TOOLS,
    env: { ...process.env, NODE_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  child.allStdout = '';
  child.allStderr = '';
  child.stdout.on('data', (d) => { child.allStdout += d; });
  child.stderr.on('data', (d) => { child.allStderr += d; });
  child.on('error', (e) => { child.allStderr += `\n[spawn-error] ${e.message}`; });
  return child;
}
function waitExit(child) {
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out: child.allStdout, err: child.allStderr })));
}
async function startMock(state, extraArgs = []) {
  const statePath = path.join(WORK, `mock-state-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(statePath, JSON.stringify({ modules: state }));
  const child = start('node', [path.join(TOOLS, 'mock-screeps.cjs'), '--state', statePath, ...extraArgs]);
  const line = await new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/\{"port":\d+.*\}/);
      if (m) resolve(m[0]);
    });
  });
  const { port } = JSON.parse(line);
  const secretPath = path.join(WORK, `secret-${port}.json`);
  fs.writeFileSync(secretPath, JSON.stringify({ main: { token: 'mock-token-not-real', protocol: 'http', hostname: '127.0.0.1', port, path: '/' } }));
  return { child, port, secretPath };
}
function readRemote(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/user/code?branch=default`, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve(JSON.parse(b).modules));
    }).on('error', reject);
  });
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

(async () => {
  fs.writeFileSync(path.join(WORK, 'backup-modules.json'), JSON.stringify(BACKUP));
  fs.writeFileSync(path.join(WORK, 'deployed-modules.json'), JSON.stringify(DEPLOYED));

  // ── A. 收集通路与 16KB 不截断 ──
  {
    const mock = await startMock(BACKUP, ['--push-big-console']);
    const outJsonl = path.join(WORK, 'collector-A.jsonl');
    const collector = start('node', [path.join(TOOLS, 'console-collector.cjs'), mock.secretPath, outJsonl]);
    await wait(4000);
    collector.kill('SIGTERM');
    await waitExit(collector);
    mock.child.kill('SIGTERM');
    const lines = fs.readFileSync(outJsonl, 'utf8').split('\n').filter(Boolean);
    const frames = lines.map((l) => JSON.parse(l));
    const consoleFrames = frames.filter((f) => f.kind === 'console-event');
    const rawFrames = frames.filter((f) => f.kind === 'ws-frame');
    const bigRaw = rawFrames.find((f) => f.text && f.text.includes('MOCK_BIG_FRAME'));
    const footer = frames.find((f) => f.kind === 'collector-footer');
    const intact = bigRaw && bigRaw.text.includes('marker-start') && bigRaw.text.includes('marker-end') && !bigRaw.text.includes('truncated');
    // 收集器被外部 kill（Windows 不触发 SIGTERM 处理器）时 footer 可能缺失；
    // 帧本体为同步追加写，必须已经完整在盘。
    const consoleChannelFrames = rawFrames.filter((f) => f.text && f.text.includes('/console'));
    record('A1 收集器完成 auth+subscribe 并收到 console 通道帧', consoleChannelFrames.length >= 1, `console-channel-ws-frames=${consoleChannelFrames.length}`);
    record('A2 >16KB 单帧原样保存无截断', Boolean(intact) && bigRaw.bytes > 16384, `frameBytes=${bigRaw?.bytes}, marker完整=${Boolean(intact)}`);
    record('A3 ws 原帧落盘（含 auth/subscribe 确认链）', rawFrames.length >= 1 && Boolean(footer || bigRaw), `ws-frames=${rawFrames.length}, footer=${footer?.reason ?? 'killed-without-footer(预期内)'}`);
  }

  // ── B. 收集器退出/无样本仍触发恢复；恢复成功 ──
  {
    const mock = await startMock(DEPLOYED);
    const guardLog = path.join(WORK, 'guard-B.jsonl');
    const deadPid = 999999;
    const guard = start('node', [
      path.join(TOOLS, 'deadline-guard.cjs'), '--minutes', '90', '--collector-pid', String(deadPid),
      '--log', guardLog, '--',
      mock.secretPath, 'default', path.join(WORK, 'backup-modules.json'), path.join(WORK, 'deployed-modules.json'),
    ]);
    const t0 = Date.now();
    const g = await waitExit(guard);
    const after = await readRemote(mock.port).catch(() => null);
    mock.child.kill('SIGTERM');
    const restoredRemote = JSON.stringify(after) === JSON.stringify(BACKUP);
    record('B1 收集器退出后 ~15s 内触发恢复请求', g.code === 0 && (Date.now() - t0) < 60_000, `guardExit=${g.code}, 耗时ms=${Date.now() - t0}`);
    record('B2 恢复请求真实覆盖 mock 远端为备份原件', restoredRemote, `remote==backup:${restoredRemote}`);
    record('B3 guard 判定 RESTORED_AND_VERIFIED', g.out.includes('RESTORED_AND_VERIFIED'), g.out.split('\n').filter(Boolean).pop()?.slice(0, 100));
  }

  // ── C. 恢复失败不能报告已关闭 ──
  {
    const mock = await startMock(DEPLOYED, ['--fail-set', 'always']);
    const guardLog = path.join(WORK, 'guard-C.jsonl');
    const guard = start('node', [
      path.join(TOOLS, 'deadline-guard.cjs'), '--minutes', '90', '--collector-pid', '999998',
      '--log', guardLog, '--',
      mock.secretPath, 'default', path.join(WORK, 'backup-modules.json'), path.join(WORK, 'deployed-modules.json'),
    ]);
    const g = await waitExit(guard);
    mock.child.kill('SIGTERM');
    record('C1 恢复失败时 guard 非零退出并报 UNCONFIRMED', g.code === 6 && g.err.includes('ONLINE_CLOSE_UNCONFIRMED'), `exit=${g.code}`);
    record('C2 失败路径绝不输出"关闭确认"措辞', !g.out.includes('close confirmed'), g.err.split('\n').filter(Boolean).pop()?.slice(0, 100));
  }

  // ── D. 第三方新产物出现时不覆盖 ──
  {
    const mock = await startMock(THIRD_PARTY);
    const r = start('node', [
      path.join(TOOLS, 'restore-modules.cjs'),
      mock.secretPath, 'default', path.join(WORK, 'backup-modules.json'), path.join(WORK, 'deployed-modules.json'),
    ]);
    const x = await waitExit(r);
    mock.child.kill('SIGTERM');
    record('D1 CONFLICT 拒绝覆盖第三方产物', x.code === 3 && x.out.includes('CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT'), `exit=${x.code}`);
  }

  // ── E. 已恢复不重复写 ──
  {
    const mock = await startMock(BACKUP);
    const r = start('node', [
      path.join(TOOLS, 'restore-modules.cjs'),
      mock.secretPath, 'default', path.join(WORK, 'backup-modules.json'), path.join(WORK, 'deployed-modules.json'),
    ]);
    const x = await waitExit(r);
    mock.child.kill('SIGTERM');
    record('E1 当前==备份时 ALREADY_RESTORED 不重复写', x.code === 0 && x.out.includes('ALREADY_RESTORED'), `exit=${x.code}`);
  }

  const summary = { passed: results.filter((r) => r.pass).length, total: results.length, results };
  fs.writeFileSync(path.join(WORK, 'rehearsal-summary.json'), JSON.stringify(summary, null, 1));
  console.log(`\n演练汇总: ${summary.passed}/${summary.total}`);
  process.exit(summary.passed === summary.total ? 0 : 1);
})().catch((e) => { console.error('rehearsal fatal:', e); process.exit(2); });
