'use strict';
// Controlled stop of the lab-ti1-env launcher tree via the repo's (fixed) process-scope.
const s = require('D:/code/screeps/screeps-bot/test/lab/terminal-transfer/tools/process-scope.cjs');
const pid = Number(process.argv[2]);
const root = process.argv[3];
(async () => {
  const owner = await s.captureLauncher(pid, root);
  console.log('owner captured pid=' + owner.pid + ' started=' + owner.started);
  const r = await s.terminateLauncher(owner, e => console.log(JSON.stringify(e).slice(0, 240)));
  console.log('TERMINATED', JSON.stringify({ terminated: r.terminated, observed: r.observedPids.length, elapsedMs: Math.round(r.elapsedMs), polls: r.polls, auditErrors: r.auditErrors.length }));
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
