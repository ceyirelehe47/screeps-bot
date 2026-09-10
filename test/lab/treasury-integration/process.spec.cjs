'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { terminateWithPorts, TERMINATION_BUDGET_MS } = require('../terminal-transfer/tools/process-scope.cjs');
function portsFixture(latency = 700, count = 7) {
  let time = 0, killed = false;
  const targets = Array.from({ length: count }, (_,i) => ({ pid: 900000 + i, ppid: i ? 900000 : 800000, started: 'stable-' + i, executable: 'node.exe', command: 'node.exe C:\\lab\\launcher.js' }));
  const calls = [], events = [];
  async function delay(kind, ms) { calls.push({ kind, budget: ms }); if (latency > ms) { time += ms; throw new Error('OS timeout'); } time += latency; }
  const p = { platform: 'win32', now: () => time, inspectMany: async (ids, ms) => { await delay('inspect:' + ids.length, ms); return killed ? [] : targets.filter(t => ids.includes(t.pid)); },
    tree: async (root, ms) => { await delay('tree', ms); return targets; },
    killWindows: async (root, ms) => { await delay('kill', ms); killed = true; return { stdout: 'terminated', stderr: '' }; },
    // Kernel probe: after the tree kill every PID reports "no such process",
    // which alone is direct evidence of exit and skips identity re-reads.
    pidAlive: () => !killed,
    sleep: async ms => { time += ms; } };
  return { p, targets, calls, events, get killed() { return killed; }, setTime: t => { time = t; }, audit: e => events.push(e) };
}
for (const latency of [10, 700]) test('kernel-verified exit succeeds with seven PIDs, each OS operation ' + latency + 'ms', async () => {
  const f = portsFixture(latency), result = await terminateWithPorts(f.targets[0], f.p, f.audit);
  assert.equal(result.terminated, true); assert.equal(result.observedPids.length, 7); assert.equal(result.elapsedMs, 2 * latency);
  assert.deepEqual(f.calls.map(x => x.kind), ['tree', 'kill']);
  assert.ok(result.elapsedMs < 5000);
});
test('100 PID identity verification still uses one batched exit query when probes stay inconclusive', async () => {
  for (const probe of [() => true, () => { throw Error('EPERM'); }]) {
    const f = portsFixture(700, 100); f.p.pidAlive = probe;
    const r = await terminateWithPorts(f.targets[0], f.p);
    assert.equal(r.elapsedMs, 2100); assert.deepEqual(f.calls.map(x => x.kind), ['tree', 'kill', 'inspect:100']);
  }
});
test('vanished launcher before captured tree is not successful cleanup', async () => {
  const f = portsFixture(); f.p.tree = async () => [];
  await assert.rejects(terminateWithPorts(f.targets[0], f.p), /absent/); assert.equal(f.killed, false);
});
test('reused launcher PID is refused without any kill', async () => {
  const f = portsFixture(); f.p.tree = async () => [{ ...f.targets[0], started: 'different' }, ...f.targets.slice(1)];
  await assert.rejects(terminateWithPorts(f.targets[0], f.p), /identity changed/); assert.equal(f.killed, false);
});
test('surviving worker after launcher exit prevents confirmation until deadline', async () => {
  const f = portsFixture(100); const original = f.p.inspectMany;
  f.p.pidAlive = () => true;
  f.p.inspectMany = async (ids, ms) => f.killed ? [f.targets[1]] : original(ids, ms);
  await assert.rejects(terminateWithPorts(f.targets[0], f.p), /deadline/);
  assert.ok(f.p.now() <= TERMINATION_BUDGET_MS); assert.equal(f.calls.filter(x => x.kind === 'kill').length, 1);
});
test('remaining timeout is shared across all stages, not reset per PID', async () => {
  const f = portsFixture(1400); f.p.pidAlive = () => true; const original = f.p.inspectMany;
  f.p.inspectMany = async (ids, ms) => { const rows = await original(ids, ms); return f.killed ? [f.targets[1]] : rows; };
  await assert.rejects(terminateWithPorts(f.targets[0], f.p), /OS timeout/);
  assert.equal(f.p.now(), 4500); assert.equal(f.calls.at(-1).budget, 200);
});
test('unreadable exit identity is not interpreted as a reused or exited process', async () => {
  const f = portsFixture(10), original = f.p.inspectMany;
  f.p.pidAlive = () => true;
  f.p.inspectMany = (ids, ms) => f.killed ? Promise.resolve([{ pid: f.targets[1].pid }]) : original(ids, ms);
  await assert.rejects(terminateWithPorts(f.targets[0], f.p), /unreadable/);
});
test('reused worker identity after kill is recorded, never killed again', async () => {
  const f = portsFixture(10), original = f.p.inspectMany;
  f.p.pidAlive = () => true;
  f.p.inspectMany = (ids, ms) => f.killed ? Promise.resolve([{ ...f.targets[1], started: 'new-process' }]) : original(ids, ms);
  const result = await terminateWithPorts(f.targets[0], f.p, f.audit);
  assert.equal(result.terminated, true); assert.equal(f.calls.filter(x => x.kind === 'kill').length, 1);
  assert.ok(f.events.some(e => e.reusedPids?.includes(f.targets[1].pid)));
});
test('kill command failure does not become a success or automatic retry', async () => {
  const f = portsFixture(10); let calls = 0; f.p.killWindows = async () => { calls++; throw Error('taskkill failed'); };
  await assert.rejects(terminateWithPorts(f.targets[0], f.p), /taskkill failed/); assert.equal(calls, 1);
});
test('audit failure does not prevent kill but is retained in the result', async () => {
  const f = portsFixture(10); const r = await terminateWithPorts(f.targets[0], f.p, () => { throw Error('disk'); });
  assert.equal(r.terminated, true); assert.ok(r.auditErrors.length > 0);
});
test('final audit latency cannot disguise exceeding the whole termination deadline', async () => {
  const f = portsFixture(10);
  await assert.rejects(terminateWithPorts(f.targets[0], f.p, e => { if (e.phase === 'confirmed') f.setTime(6000); }), /deadline/);
  assert.equal(f.killed, true);
});
