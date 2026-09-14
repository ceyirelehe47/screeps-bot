'use strict';
const fs = require('node:fs'), path = require('node:path');
const S = require('./loader-test-support.cjs');
const H = S.H;
const beforeText = () => fs.readFileSync(path.join(__dirname, 'fixtures/core-before-subphase-attribution-ix.ts.txt'), 'utf8').replace(/\r\n/g, '\n');
const afterText = () => fs.readFileSync(H.file('treasuryCompatReadCore.generated.ts'), 'utf8').replace(/\r\n/g, '\n');
function diagnosticScene(setup = () => {}, step = 0.01) {
  const s = S.make(afterText(), true);
  s.cfg = { ...s.cfg, maxSampleCpu: 10 };
  s.step = step; s.cpuValue = 0.1;
  setup(s);
  s.observer = s.api.createTreasuryCompatPreview(s.cfg, s.ports, { cpuDiagnostics: true });
  return s;
}
function coreDiagnostics(s) {
  const boundaries = [], work = {};
  return {
    api: {
      boundary(phase) { boundaries.push(phase === undefined ? null : phase); },
      work(values) { for (const [k, v] of Object.entries(values)) work[k] = (work[k] || 0) + v; },
    }, boundaries, work,
  };
}
function directBuild(text = afterText(), setup = () => {}) {
  const s = S.make(text, false); setup(s); const d = coreDiagnostics(s); const r = s.core.createCompatibilityReadCore();
  const rooms = Object.values(s.game.rooms);
  const observation = r.buildObservation({ scope: 'market-fresh', epochSeq: 1, rooms, compatDiagnostics: d.api });
  const index = r.buildCommitments({ tick: s.game.time, tasks: s.memory.data.resourceControl.tasks,
    reservations: s.memory.runtime.resourceReservations, observation, compatDiagnostics: d.api });
  return { s, d, r, observation, index };
}
function compareScenario(name) {
  const a = S.make(beforeText(), false), b = S.make(afterText(), false);
  S.scenarios[name](a); S.scenarios[name](b);
  const ga = { writes: 0 }, gb = { writes: 0 };
  a.memory = H.guard(a.memory, ga); b.memory = H.guard(b.memory, gb);
  for (let i = 1; i <= 12; i++) {
    a.game.time = b.game.time = i * 100; a.cpuValue = b.cpuValue = 0.1;
    a.observer.run(); b.observer.run();
  }
  return { name, byteEquivalent: JSON.stringify(a.lines) === JSON.stringify(b.lines), writes: [ga.writes, gb.writes],
    readers: [a.calls.readers, b.calls.readers], observations: [a.calls.observation, b.calls.observation],
    commitments: [a.calls.commitments, b.calls.commitments] };
}
module.exports = { S, H, beforeText, afterText, diagnosticScene, coreDiagnostics, directBuild, compareScenario };
