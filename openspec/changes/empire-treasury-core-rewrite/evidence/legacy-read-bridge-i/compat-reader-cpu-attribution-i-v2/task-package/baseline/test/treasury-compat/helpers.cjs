'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const localKit = fs.existsSync(path.join(__dirname, '..', 'templates'));
const ROOT = localKit ? path.resolve(__dirname, '..') : path.resolve(__dirname, '../..');
function file(name) { return path.join(ROOT, localKit ? 'templates' : 'src/runtime', name); }
function load(name, globals = {}, imports = {}) {
  const location = file(name);
  const input = fs.readFileSync(location, 'utf8');
  const result = ts.transpileModule(input, { fileName: name, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, strict: true } });
  assert.deepEqual((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
  const exports = {};
  const ctx = vm.createContext({ ...globals, exports, require: k => {
    if (!(k in imports)) throw new Error('unexpected runtime import: ' + k);
    return imports[k];
  } });
  if (globals.__memoryAccessor) Object.defineProperty(ctx, 'Memory', { get: globals.__memoryAccessor });
  new vm.Script(result.outputText, { filename: name }).runInContext(ctx, { timeout: 5000 });
  return exports;
}
function guard(value, counter = { writes: 0 }, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const deny = () => { counter.writes++; throw new Error('attempted state mutation'); };
  const p = new Proxy(value, { get: (t, k) => guard(Reflect.get(t, k), counter, seen),
    getOwnPropertyDescriptor: (t, k) => { const d = Reflect.getOwnPropertyDescriptor(t,k);
      return d && 'value' in d && d.configurable ? { ...d, value: guard(d.value,counter,seen) } : d; }, set: deny,
    deleteProperty: deny, defineProperty: deny, setPrototypeOf: deny });
  seen.set(value, p); return p;
}
const json = x => JSON.parse(JSON.stringify(x));
function makeRoom(name = 'W1N1', capacity = 1000000) {
  function endpoint(kind, cap, amounts) {
    const store = { ...amounts };
    const state = { cap, saturated: false };
    Object.defineProperties(store, {
      getUsedCapacity: { value: r => r === undefined ? Object.values(store).reduce((a, b) => a + b, 0) : store[r] || 0, configurable: true },
      getCapacity: { value: () => state.cap, configurable: true },
      getFreeCapacity: { value: () => state.saturated ? Math.max(0, state.cap - store.getUsedCapacity()) : state.cap - store.getUsedCapacity(), configurable: true },
    });
    return { id: kind + '-' + name, my: true, isActive: () => true, cooldown: 0, store, capState: state };
  }
  return { name, controller: { my: true }, storage: endpoint('storage', capacity, { energy: 4000, H: 300 }),
    terminal: endpoint('terminal', 300000, { energy: 10000, H: 1000 }) };
}
const BASE = { enabled: true, shardName: 'test-shard', rooms: ['W1N1'], resources: ['energy', 'H'],
  startTick: 100, endTick: 1300, intervalTicks: 100, minBucket: 2000, maxSampleCpu: 2, reserveCpu: 5, maxLogBytes: 16384 };
/** Synthetic reader for bridge-only tests, NOT the production commitment model. */
function syntheticReaders(s) {
  return {
    buildObservation({ rooms }) {
      s.calls.observation++;
      const locs = {};
      for (const room of rooms) for (const k of ['storage', 'terminal']) {
        const x = room[k];
        locs[room.name + ':' + k] = x ? { exists: true, structureId: x.id, amounts: { ...x.store }, usedCapacity: x.store.getUsedCapacity(), freeCapacity: x.store.getFreeCapacity() }
          : { exists: false, amounts: {}, usedCapacity: 0, freeCapacity: 0 };
      }
      if (s.mutateObservation) s.mutateObservation(locs);
      return { epoch: { observedAtTick: s.game.time }, location: (r, k) => locs[r + ':' + k] };
    },
    buildCommitments(options) {
      s.calls.commitments++; s.lastInputs = options;
      return { completeness: { complete: true, globalIncomplete: false, incompleteScopeCount: 0, invalidRecords: 0 },
        metrics: {}, outgoing: () => 7, incoming: () => 11, reservedProduction: () => 13, commitmentCompleteness: () => 'complete' };
    },
  };
}
function scene(overrides = {}, useReal = false) {
  const cfg = { ...BASE, ...overrides };
  const memory = { data: { resourceControl: { tasks: {} } }, runtime: { resourceReservations: {} } };
  const s = { cfg, game: { time: 100, shard: { name: cfg.shardName }, rooms: { W1N1: makeRoom() }, getObjectById: () => null }, memory,
    calls: { readers: 0, observation: 0, commitments: 0, room: 0, memory: 0, cpu: 0 }, lines: [], cpuValue: 0.1, step: 0, bucket: 9000, emitCost: 0 };
  const globals = { Game: s.game, Memory: s.memory, __memoryAccessor: () => s.memory, RESOURCES_ALL: ['energy', 'H', 'O', 'U'], console };
  const api = load('treasuryCompatRead.ts', globals);
  let core;
  if (useReal) core = load('treasuryCompatReadCore.generated.ts', globals);
  const ports = {
    tick: () => s.game.time, shard: () => s.game.shard.name,
    cpu: () => { s.calls.cpu++; const n = s.cpuValue; s.cpuValue += s.step; return { used: n, tickLimit: 100, bucket: s.bucket }; },
    room: name => { s.calls.room++; return s.game.rooms[name]; },
    memory: () => { s.calls.memory++; return s.memory; },
    resources: () => ['energy', 'H', 'O', 'U'],
    readers: () => {
      s.calls.readers++;
      if (!useReal) return syntheticReaders(s);
      const real = core.createCompatibilityReadCore();
      // Count attempted calls BEFORE delegation. Preserve receiver, arguments,
      // result identity and exceptions; never modify the generated readers.
      return Object.freeze({
        buildObservation(...args) {
          s.calls.observation++;
          return Reflect.apply(real.buildObservation, real, args);
        },
        buildCommitments(...args) {
          s.calls.commitments++;
          s.lastInputs = args[0];
          return Reflect.apply(real.buildCommitments, real, args);
        },
      });
    },
    emit: line => { if (s.throwEmit) throw new Error('logger unavailable'); s.lines.push(line); s.cpuValue += s.emitCost; },
  };
  s.ports = ports; s.api = api; s.core = core;
  s.observer = api.createTreasuryCompatPreview(cfg, ports);
  s.report = () => JSON.parse(s.lines.at(-1));
  return s;
}
module.exports = { ROOT, file, load, guard, json, makeRoom, BASE, scene };
