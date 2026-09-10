#!/usr/bin/env node
'use strict';
/**
 * 独立墙钟截止执行者（会话级；不属于游戏主循环）：
 *  - 从启动时刻起 --minutes 分钟（默认 90）到点，或收集器 pid 消失时，
 *    触发一次恢复请求（调用 restore-modules.cjs）；
 *  - 恢复失败 / ONLINE_CLOSE_UNCONFIRMED 时以非零退出并如实上报，
 *    绝不把"本地停止收集"报告为"线上已关闭"；
 *  - 所有动作与判定追加写入 guard 日志 jsonl。
 * 用法：node deadline-guard.cjs --minutes 90 [--collector-pid N] -- <restore args...>
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
const sep = argv.indexOf('--');
const restoreArgs = sep >= 0 ? argv.slice(sep + 1) : [];
const minutes = Number(opt('--minutes', '90'));
const collectorPid = opt('--collector-pid', null) ? Number(opt('--collector-pid', null)) : null;
const guardLog = opt('--log', null);
const startedAt = Date.now();
const deadlineMs = startedAt + minutes * 60_000;

if (restoreArgs.length === 0) {
  console.error('usage: node deadline-guard.cjs --minutes 90 [--collector-pid N] --log g.jsonl -- <restore args...>');
  process.exit(2);
}

const logPath = guardLog || path.join(process.cwd(), `deadline-guard-${startedAt}.jsonl`);
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
function log(entry) {
  logStream.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function pidAlive(pid) {
  if (!pid) return true; // 未指定 pid 时不以进程存活为停止条件
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function runRestore(trigger) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'restore-modules.cjs'), ...restoreArgs], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      resolve({ trigger, code: code ?? -1, stdout: out.trim(), stderr: err.trim().slice(0, 500) });
    });
    child.on('error', (e) => {
      resolve({ trigger, code: -1, stdout: '', stderr: String(e.message || e).slice(0, 500) });
    });
  });
}

(async () => {
  log({ kind: 'guard-start', minutes, deadline: new Date(deadlineMs).toISOString(), collectorPid, restoreArgsCount: restoreArgs.length });
  console.log(`[guard] deadline ${new Date(deadlineMs).toISOString()} collectorPid=${collectorPid ?? 'n/a'}`);

  let fired = false;
  let outcome = null;
  // 15s 周期检查；触发条件二选一：到点 / 收集器进程消失
  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      if (fired) return;
      const now = Date.now();
      const collectorGone = collectorPid !== null && !pidAlive(collectorPid);
      if (now >= deadlineMs || collectorGone) {
        fired = true;
        clearInterval(timer);
        log({ kind: 'trigger', reason: collectorGone ? 'collector-exited' : 'deadline', at: new Date(now).toISOString() });
        resolve();
      }
    }, 15_000);
  });

  outcome = await runRestore(fired ? 'scheduled' : 'scheduled');
  let status = 'UNKNOWN';
  try { status = JSON.parse(outcome.stdout.split('\n').pop()).status; } catch { /* 保持 UNKNOWN */ }
  log({ kind: 'restore-result', exitCode: outcome.code, status, stdout: outcome.stdout.slice(0, 800), stderr: outcome.stderr });
  logStream.end();

  if (outcome.code === 0 && (status === 'RESTORED_AND_VERIFIED' || status === 'ALREADY_RESTORED')) {
    console.log(`[guard] close confirmed: ${status}`);
    process.exit(0);
  }
  console.error(`[guard] ONLINE_CLOSE_UNCONFIRMED (restore exit=${outcome.code} status=${status})`);
  process.exit(6);
})().catch((e) => {
  log({ kind: 'guard-fatal', message: String(e.message || e).slice(0, 300) });
  logStream.end();
  console.error('[guard] ONLINE_CLOSE_UNCONFIRMED (guard fatal)');
  process.exit(7);
});
