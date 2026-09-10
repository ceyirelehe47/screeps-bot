'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const exec = promisify(execFile);
const TERMINATION_BUDGET_MS = 4500; // one budget; callers retain their 5000ms watchdog
const FIELDS = "[PSCustomObject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;command=$_.CommandLine}";
function pidNumber(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 1 || n === process.pid) throw new Error('invalid launcher PID');
  return n;
}
function timeoutValue(ms) {
  if (!Number.isFinite(ms) || ms < 1) throw new Error('process operation deadline exhausted');
  return Math.max(1, Math.floor(ms));
}
function validateIdentity(p) {
  if (!p || !Number.isSafeInteger(p.pid) || p.pid <= 1 || p.started === undefined || p.started === null || p.started === ''
      || typeof p.executable !== 'string' || !p.executable || !(typeof p.command === 'string' && p.command.length || Array.isArray(p.command) && p.command.length)) {
    throw new Error('process identity unreadable (pid=' + (p && p.pid) + '); not evidence of exit');
  }
  return p;
}
async function windowsQuery(command, timeoutMs) {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + command],
    { timeout: timeoutValue(timeoutMs), windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim() ? [].concat(JSON.parse(stdout)).map(validateIdentity) : [];
}
function linuxProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (tail[0] === 'Z') return null;
    return validateIdentity({ pid, ppid: Number(tail[1]), started: tail[19], executable: fs.readlinkSync(`/proc/${pid}/exe`),
      cwd: fs.readlinkSync(`/proc/${pid}/cwd`), command: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) });
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
/** One OS query for ALL target PIDs, never one fresh PowerShell per PID. */
async function inspectProcesses(pids, timeoutMs = 2000) {
  const ids = [...new Set(pids.map(pidNumber))];
  if (!ids.length) return [];
  if (ids.length > 256) throw new Error('unexpectedly large lab process set');
  if (process.platform === 'linux') return ids.map(linuxProcess).filter(Boolean);
  if (process.platform === 'win32') {
    const filter = ids.map(id => `ProcessId = ${id}`).join(' OR ');
    return windowsQuery(`@(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {${FIELDS}}) | ConvertTo-Json -Compress`, timeoutMs);
  }
  throw new Error('process ownership adapter supports Linux and Windows only');
}
async function inspectProcess(pid, timeoutMs = 2000) { return (await inspectProcesses([pid], timeoutMs))[0] || null; }
function identityMatches(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.started === b.started && a.executable === b.executable
    && JSON.stringify(a.command) === JSON.stringify(b.command));
}
function belongsToEnvironment(info, environmentRoot) {
  if (!info || !/^(node|node\.exe)$/i.test(path.basename(info.executable || ''))) return false;
  const argv = Array.isArray(info.command) ? info.command : [...String(info.command || '').matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
  const script = argv[1];
  if (!script || script.startsWith('-') || !path.isAbsolute(script)) return false;
  const relative = path.relative(environmentRoot, script);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function descendantIds(rows, root) {
  const ids = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
    if (ids.size > 256) throw new Error('unexpectedly large lab process tree');
  }
  return [...ids];
}
async function treeSnapshot(root, timeoutMs = 2000) {
  root = pidNumber(root);
  if (process.platform === 'linux') {
    const rows = [];
    for (const name of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
      try {
        const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const tail = text.slice(text.lastIndexOf(')') + 2).split(' ');
        rows.push({ pid: Number(name), ppid: Number(tail[1]) });
      } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
    }
    return inspectProcesses(descendantIds(rows, root), timeoutMs);
  }
  if (process.platform === 'win32') {
    return windowsQuery(`$all=@(Get-CimInstance Win32_Process); $ids=@(${root}); do { $n=$ids.Count; $ids=@($ids + @($all | Where-Object {$ids -contains $_.ParentProcessId} | ForEach-Object {$_.ProcessId}) | Select-Object -Unique); if($ids.Count -gt 256){throw 'unexpected process tree'} } while($ids.Count -ne $n); @($all | Where-Object {$ids -contains $_.ProcessId} | ForEach-Object {${FIELDS}}) | ConvertTo-Json -Compress`, timeoutMs);
  }
  throw new Error('unsupported platform');
}
async function captureLauncher(pid, environmentRoot) {
  const info = await inspectProcess(pid);
  if (!belongsToEnvironment(info, environmentRoot)) throw new Error('launcher is not an explicitly bound Node process in this environment');
  return info;
}
function requireOwnedRoot(owner, current) {
  if (!current) throw new Error('launcher absent; descendant cleanup unconfirmed');
  if (!identityMatches(owner, current)) throw new Error('launcher identity changed; refusing to kill a reused/unrelated PID');
}

/** The small port boundary permits deterministic latency/reuse/error tests. The
 * CLI never accepts ports; real termination below always selects OS adapters. */
function portReportsDead(ports, pid) {
  // Synchronous kernel liveness probe: false only on a definite ESRCH ("no such
  // process"). true, an errored probe or a missing port all mean "must verify
  // by identity read", never "must be alive".
  if (typeof ports.pidAlive !== 'function') return false;
  try { return ports.pidAlive(pid) === false; } catch { return false; }
}
async function terminateWithPorts(owner, ports, audit = () => {}) {
  validateIdentity(owner);
  const start = ports.now(), deadline = start + TERMINATION_BUDGET_MS;
  const auditErrors = [];
  const note = e => { try { audit({ kind: 'process-termination', elapsedMs: ports.now() - start, ...e }); } catch (error) { auditErrors.push(String(error)); } };
  function remaining() {
    const ms = deadline - ports.now();
    if (ms <= 0) throw new Error('process-tree termination deadline exhausted');
    return ms;
  }
  // Individual OS commands receive only the remaining budget. They cannot
  // each independently consume two seconds beyond the caller's five seconds.
  async function call(label, fn, ceiling = 2000) {
    const ms = Math.min(remaining(), ceiling);
    const result = await fn(ms);
    remaining();
    note({ phase: label });
    return result;
  }
  note({ phase: 'start', rootPid: owner.pid, budgetMs: TERMINATION_BUDGET_MS });
  // The tree snapshot itself contains the launcher, so one OS query both
  // re-validates the root identity and captures descendants. On real Windows
  // every CIM query costs well over a second; a separate root read made the
  // shared 4500ms budget structurally unreachable (see smoke evidence).
  let targets = await call('tree-read', ms => ports.tree(owner.pid, ms));
  if (!Array.isArray(targets) || targets.length > 256) throw new Error('invalid process tree');
  targets.forEach(validateIdentity);
  requireOwnedRoot(owner, targets.find(p => p.pid === owner.pid));
  if (targets.some(p => p.pid === process.pid)) throw new Error('control process must not belong to terminated tree');
  note({ phase: 'targets', targets }); // captured identities survive root exit/reparenting
  if (ports.platform === 'win32') {
    const result = await call('kill-request-completed', ms => ports.killWindows(owner.pid, ms), 4000);
    note({ phase: 'kill-response', result });
  } else if (ports.platform === 'linux') {
    const stopped = new Map();
    for (let pass = 0; pass < 3; pass++) {
      for (const target of targets) {
        remaining();
        const [fresh] = await ports.inspectMany([target.pid], remaining());
        if (!fresh) continue;
        if (!identityMatches(target, fresh)) throw new Error('process identity changed; kill refused');
        try { ports.signal(target.pid, 'SIGSTOP'); stopped.set(target.pid, target); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      const freshTree = await call('stopped-tree-read', ms => ports.tree(owner.pid, ms));
      if (freshTree.every(p => stopped.has(p.pid))) break;
      targets = freshTree;
      if (pass === 2) throw new Error('process tree did not stabilize');
    }
    targets = [...stopped.values()];
    for (const target of targets.filter(p => p.pid !== owner.pid).reverse().concat(owner)) {
      remaining();
      const [fresh] = await ports.inspectMany([target.pid], remaining());
      if (!fresh) continue;
      if (!identityMatches(target, fresh)) throw new Error('process identity changed; kill refused');
      try { ports.signal(target.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } else throw new Error('unsupported platform');
  let polls = 0;
  for (;;) {
    remaining();
    // Kernel liveness first: a PID with no process at all is direct evidence of
    // exit. Only PIDs that still exist (or whose probe is inconclusive) cost an
    // identity read, keeping whole-tree confirmation inside one real-OS budget.
    const live = targets.filter(p => !portReportsDead(ports, p.pid));
    polls++;
    if (!live.length) {
      const result = { terminated: true, observedPids: targets.map(p => p.pid), elapsedMs: ports.now() - start, polls, auditErrors };
      note({ phase: 'exit-snapshot', survivingPids: [], reusedPids: [] });
      note({ phase: 'confirmed', ...result });
      remaining(); // final audit time is part of the SAME deadline
      result.elapsedMs = ports.now() - start;
      return result;
    }
    const rows = await call('exit-read', ms => ports.inspectMany(live.map(p => p.pid), ms));
    rows.forEach(validateIdentity);
    const survivors = live.filter(p => rows.some(fresh => identityMatches(p, fresh)));
    const reused = rows.filter(p => live.some(old => old.pid === p.pid && !identityMatches(old, p)));
    note({ phase: 'exit-snapshot', survivingPids: survivors.map(p => p.pid), reusedPids: reused.map(p => p.pid) });
    if (!survivors.length) {
      const result = { terminated: true, observedPids: targets.map(p => p.pid), elapsedMs: ports.now() - start, polls, auditErrors };
      note({ phase: 'confirmed', ...result });
      remaining(); // final audit time is part of the SAME deadline
      result.elapsedMs = ports.now() - start;
      return result;
    }
    await ports.sleep(Math.min(100, remaining()));
  }
}
async function terminateLauncher(owner, audit) {
  return terminateWithPorts(owner, {
    platform: process.platform, now: () => performance.now(), inspectMany: inspectProcesses, tree: treeSnapshot,
    // Signal 0 is a pure kernel liveness probe. EPERM on a foreign process is
    // reported as "alive" so it still gets the full identity verification.
    pidAlive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } },
    killWindows: async (pid, timeout) => {
      const result = await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: timeoutValue(timeout), windowsHide: true });
      return { stdout: result.stdout, stderr: result.stderr };
    },
    signal: (pid, signal) => process.kill(pid, signal), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }, audit);
}
module.exports = { pidNumber, inspectProcess, inspectProcesses, identityMatches, belongsToEnvironment,
  captureLauncher, terminateLauncher, terminateWithPorts, descendantIds, requireOwnedRoot, TERMINATION_BUDGET_MS };
