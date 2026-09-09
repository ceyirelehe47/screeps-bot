'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

function pidNumber(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 1 || n === process.pid) throw new Error('invalid launcher PID');
  return n;
}
async function inspectProcess(pid) {
  pid = pidNumber(pid);
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (tail[0] === 'Z') return null;
      return { pid, ppid: Number(tail[1]), started: tail[19],
        executable: fs.readlinkSync(`/proc/${pid}/exe`),
        cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
        command: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
  }
  if (process.platform === 'win32') {
    const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){ [PSCustomObject]@{pid=$p.ProcessId;ppid=$p.ParentProcessId;started=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;command=$p.CommandLine} | ConvertTo-Json -Compress }`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 2000, windowsHide: true });
    return stdout.trim() ? JSON.parse(stdout) : null;
  }
  throw new Error('process ownership adapter supports Linux and Windows only');
}
function identityMatches(a, b) {
  return a && b && a.pid === b.pid && a.started === b.started && a.executable === b.executable
    && JSON.stringify(a.command) === JSON.stringify(b.command);
}
function belongsToEnvironment(info, environmentRoot) {
  if (!info || !/^(node|node\.exe)$/i.test(path.basename(info.executable || ''))) return false;
  const argv = Array.isArray(info.command) ? info.command : [...String(info.command || '').matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
  // This tool intentionally supports the unambiguous `node <absolute-script>`
  // launch form only. A random later --config=/lab/path is not ownership proof.
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
async function treeSnapshot(root) {
  if (process.platform === 'linux') {
    // Discover ancestry using stat only; do not read unrelated users' command
    // lines or executable links (which may legitimately be inaccessible).
    const rows = [];
    for (const name of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
      try {
        const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const tail = text.slice(text.lastIndexOf(')') + 2).split(' ');
        rows.push({ pid: Number(name), ppid: Number(tail[1]) });
      } catch (error) { if (!['ENOENT','ESRCH','EACCES'].includes(error.code)) throw error; }
    }
    const result = [];
    for (const pid of descendantIds(rows, root)) { const p = await inspectProcess(pid); if (p) result.push(p); }
    return result;
  }
  if (process.platform === 'win32') {
    const command = `$all=@(Get-CimInstance Win32_Process); $ids=@(${root}); do { $n=$ids.Count; $ids=@($ids + @($all | Where-Object {$ids -contains $_.ParentProcessId} | ForEach-Object {$_.ProcessId}) | Select-Object -Unique); if($ids.Count -gt 256){throw 'unexpected process tree'} } while($ids.Count -ne $n); @($all | Where-Object {$ids -contains $_.ProcessId} | ForEach-Object {[PSCustomObject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;command=$_.CommandLine}}) | ConvertTo-Json -Compress`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile','-NonInteractive','-Command',command], { timeout: 2000, windowsHide: true });
    return stdout.trim() ? [].concat(JSON.parse(stdout)) : [];
  }
  throw new Error('unsupported platform');
}
async function captureLauncher(pid, environmentRoot) {
  const info = await inspectProcess(pid);
  if (!belongsToEnvironment(info, environmentRoot)) throw new Error('launcher is not an explicitly bound Node process in this environment');
  return info;
}
function requireOwnedRoot(owner, current) {
  // A vanished root does not prove that its former workers exited. Do not report
  // successful whole-tree cleanup from this single absence fact.
  if (!current) throw new Error('launcher absent; descendant cleanup unconfirmed');
  if (!identityMatches(owner, current)) throw new Error('launcher identity changed; refusing to kill a reused/unrelated PID');
}
async function terminateLauncher(owner) {
  const current = await inspectProcess(owner.pid);
  requireOwnedRoot(owner, current);
  let targets = await treeSnapshot(owner.pid);
  const savedRoot = targets.find(p => p.pid === owner.pid);
  if (!identityMatches(owner, savedRoot)) throw new Error('launcher changed during process snapshot');
  if (process.platform === 'win32') {
    await exec('taskkill.exe', ['/PID', String(owner.pid), '/T', '/F'], { timeout: 4000, windowsHide: true });
  } else if (process.platform === 'linux') {
    // Freeze the known tree before killing it so a launcher cannot replenish it.
    // Re-scan to include children created while the first snapshot was taken.
    const stopped = new Map();
    for (let pass = 0; pass < 3; pass++) {
      for (const target of targets) {
        const fresh = await inspectProcess(target.pid);
        if (!fresh) continue;
        if (!identityMatches(target, fresh)) throw new Error('process identity changed; kill refused');
        try { process.kill(target.pid, 'SIGSTOP'); stopped.set(target.pid, target); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      const freshTree = await treeSnapshot(owner.pid);
      if (freshTree.every(p => stopped.has(p.pid))) break;
      targets = freshTree;
      if (pass === 2) throw new Error('process tree did not stabilize');
    }
    targets = [...stopped.values()];
    const ordered = targets.filter(p => p.pid !== owner.pid).reverse().concat(owner);
    for (const target of ordered) {
      const fresh = await inspectProcess(target.pid);
      if (!fresh) continue;
      if (!identityMatches(target, fresh)) throw new Error('process identity changed; kill refused');
      try { process.kill(target.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  for (let i = 0; i < 10; i++) {
    let remaining = false;
    for (const target of targets) {
      const fresh = await inspectProcess(target.pid);
      if (identityMatches(target, fresh)) { remaining = true; break; }
    }
    if (!remaining) return { terminated: true, observedPids: targets.map(p => p.pid) };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('launcher exit not confirmed');
}
module.exports = { pidNumber, inspectProcess, identityMatches, belongsToEnvironment, captureLauncher, terminateLauncher, descendantIds, requireOwnedRoot };
