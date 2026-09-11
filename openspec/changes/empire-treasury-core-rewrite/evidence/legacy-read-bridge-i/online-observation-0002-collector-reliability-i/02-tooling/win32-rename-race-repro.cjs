#!/usr/bin/env node
'use strict';
// 根因复现：Windows 上 fs.renameSync 覆盖已存在目标文件会间歇性 EPERM。
// 用法：node win32-rename-race-repro.cjs [child]
// 父进程模式：spawn 子进程做 N 次 tmp+rename，并可选并发读取目标文件。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const N = 400;

function childMain(target) {
  let ok = 0;
  const failures = [];
  for (let i = 0; i < N; i++) {
    const tmp = target + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ i, pad: 'y'.repeat(300) }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, target);
      ok++;
    } catch (e) {
      failures.push({ i, code: e.code, syscall: e.syscall });
    } finally {
      if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch {} }
    }
  }
  process.stdout.write(JSON.stringify({ ok, failed: failures.length, sample: failures.slice(0, 5) }) + '\n');
}

function parentMain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-rename-race-'));
  const target = path.join(dir, 'heartbeat.json');
  const concurrentReader = process.argv.includes('--reader');
  const child = spawn(process.execPath, [__filename, 'child', target], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', b => out += b);
  const timer = concurrentReader
    ? setInterval(() => { try { if (fs.existsSync(target)) JSON.parse(fs.readFileSync(target, 'utf8')); } catch {} }, 5)
    : null;
  child.once('close', code => {
    if (timer) clearInterval(timer);
    process.stdout.write(JSON.stringify({
      mode: concurrentReader ? 'concurrent-reader-5ms' : 'no-concurrent-reader',
      childExit: code, iterations: N, result: JSON.parse(out || '{}')
    }) + '\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

if (process.argv[2] === 'child') childMain(process.argv[3]);
else parentMain();
