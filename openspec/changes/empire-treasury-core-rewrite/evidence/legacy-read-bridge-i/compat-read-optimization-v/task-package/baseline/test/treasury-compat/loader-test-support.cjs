'use strict';
/** Tests only. All Room/Memory values below are synthetic, not recovered live data. */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const H = require('./helpers.cjs');
const OLD_BLOB = 'c44d8a306f2b11986c6556e098be7d2e10315fa6';
const oldText = () => fs.readFileSync(path.join(__dirname, 'fixtures/core-before-loader-optimization.ts.txt'), 'utf8').replace(/\r\n/g, '\n');
const newText = () => fs.readFileSync(H.file('treasuryCompatReadCore.generated.ts'), 'utf8').replace(/\r\n/g, '\n');
const task = (o = {}) => ({ id: 't', origin: 'manual', status: 'pending', resource: 'H', fromRoomName: 'W1N1', toRoomName: 'W2N1', amount: 100, remainingAmount: 70, createdAt: 1, updatedAt: 1, lastProgressAt: 1, ...o });
const reservation = (o = {}) => ({ roomName: 'W1N1', resource: 'H', holderId: 'synthesis:W1N1:H', amount: 25, updatedAt: 1, expiresAt: 500, ...o });
function capsule(text, s, hook = () => {}) {
  // The hook counts actual factory execution in a test-only compiled copy.
  const needle = 'factories[id](exports, spec => {';
  if (text.split(needle).length !== 2) throw new Error('TEST_FACTORY_HOOK_BOUNDARY');
  const marked = text.replace(needle, '__onFactory(id);\n    ' + needle);
  const js = ts.transpileModule(marked, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const context = vm.createContext({ exports: {}, require: k => { throw new Error('unexpected host import:' + k); }, __onFactory: hook });
  for (const [name, get] of Object.entries({ Game: () => s.game, Memory: () => s.memory, RESOURCES_ALL: () => s.resources })) Object.defineProperty(context, name, { get });
  vm.runInContext(js, context, { timeout: 5000 });
  return context.exports;
}
function make(text = newText(), diagnostics = true, hook) {
  const s = H.scene({ rooms: ['W1N1', 'W2N1'] });
  s.game.rooms.W2N1 = H.makeRoom('W2N1');
  s.resources = ['energy', 'H', 'O', 'U'];
  s.factories = [];
  s.core = capsule(text, s, id => { s.factories.push(id); if (hook) hook(id, s); });
  s.ports.readers = () => { s.calls.readers++; const c = s.core.createCompatibilityReadCore();
    return Object.freeze({ buildObservation: o => { s.calls.observation++; return c.buildObservation(o); },
      buildCommitments: o => { s.calls.commitments++; return c.buildCommitments(o); } }); };
  s.observer = s.api.createTreasuryCompatPreview(s.cfg, s.ports, { cpuDiagnostics: diagnostics });
  return s;
}
function build(s, readers = s.core.createCompatibilityReadCore()) {
  const observation = readers.buildObservation({ scope: 'market-fresh', epochSeq: 1, rooms: Object.values(s.game.rooms) });
  const index = readers.buildCommitments({ tick: s.game.time, tasks: s.memory.data.resourceControl.tasks, reservations: s.memory.runtime.resourceReservations, observation });
  return { readers, observation, index };
}
const scenarios = {
  empty: () => {},
  manual: s => { s.memory.data.resourceControl.tasks.t = task(); },
  sixteen: s => { for (let i = 0; i < 16; i++) s.memory.data.resourceControl.tasks[i] = task({ id: 't' + i }); },
  bound256: s => { for (let i = 0; i < 256; i++) s.memory.data.resourceControl.tasks[i] = task({ id: 't' + i }); },
  overBound257: s => { for (let i = 0; i < 257; i++) s.memory.data.resourceControl.tasks[i] = task({ id: 't' + i }); },
  invalidRecord: s => { s.memory.data.resourceControl.tasks.t = task({ remainingAmount: -1 }); },
  invalidResource: s => { s.memory.data.resourceControl.tasks.t = task({ resource: 'not-a-resource' }); },
  missingTasks: s => { delete s.memory.data.resourceControl.tasks; },
  invalidReservationContainer: s => { s.memory.runtime.resourceReservations = []; },
  activeReservation: s => { s.memory.runtime.resourceReservations.r = reservation({ expiresAt: 1300 }); },
  expiredReservation: s => { s.memory.runtime.resourceReservations.r = reservation({ expiresAt: 99 }); },
  exactExpiry: s => { s.memory.runtime.resourceReservations.r = reservation({ expiresAt: 200 }); },
  missingOwner: s => { s.memory.runtime.resourceReservations.r = reservation({ holderId: 'opaque-missing' }); },
  typedOwner: s => { s.memory.runtime.resourceReservations.r = reservation({ holderId: 'x', owner: { kind: 'task', id: 'task:1' } }); },
  capacity8M: s => { const e = s.game.rooms.W1N1.storage; e.capState.cap = 8000000; e.store.H = 4400000; },
  saturatedCapacity: s => { const e = s.game.rooms.W1N1.storage; e.store.H = 4400000; e.capState.saturated = true; },
  missingTerminal: s => { delete s.game.rooms.W2N1.terminal; },
  unseenRoom: s => { delete s.game.rooms.W2N1; },
  sparseMismatch: s => { const store = s.game.rooms.W1N1.terminal.store; Object.defineProperty(store, 'getUsedCapacity', { value: r => r === 'H' ? 800 : r ? store[r] || 0 : store.energy + store.H }); },
  legacyMismatch: s => { s.memory.runtime.resourceControl = { updatedAt: 100, rooms: { W1N1: { terminalUsedCapacity: 1, terminalFreeCapacity: 1, terminalEnergy: 1 } } }; },
};
function compareScenario(name) {
  const a = make(oldText()), b = make(newText());
  scenarios[name](a); scenarios[name](b);
  const guardA = { writes: 0 }, guardB = { writes: 0 };
  a.memory = H.guard(a.memory, guardA); b.memory = H.guard(b.memory, guardB);
  for (let i = 1; i <= 12; i++) {
    a.game.time = b.game.time = i * 100;
    a.cpuValue = b.cpuValue = 0.1;
    a.observer.run(); b.observer.run();
  }
  const equivalent = JSON.stringify(a.lines) === JSON.stringify(b.lines);
  return { name, input: 'synthetic', byteEquivalent: equivalent, writes: [guardA.writes, guardB.writes],
    oldFactoryExecutions: a.factories.length, newFactoryExecutions: b.factories.length,
    readers: [a.calls.readers, b.calls.readers], observations: [a.calls.observation, b.calls.observation],
    commitments: [a.calls.commitments, b.calls.commitments], reports: b.lines.length,
    actualEngineMeasurement: false };
}
module.exports = { H, ts, fs, path, oldText, newText, OLD_BLOB, capsule, make, build, task, reservation, scenarios, compareScenario };
