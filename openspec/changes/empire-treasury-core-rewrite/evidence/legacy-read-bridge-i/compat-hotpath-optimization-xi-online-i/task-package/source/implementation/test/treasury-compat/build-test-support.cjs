'use strict';
/** VII differential harness. All Room, Memory and CPU values are synthetic.
 * Operation counters instrument VM intrinsics in test-only compiled copies.
 * They are NEVER emitted into production and are NOT an engine CPU model. */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const S = require('./loader-test-support.cjs');
const { H, ts, task, reservation } = S;
const beforeText = () => fs.readFileSync(path.join(__dirname, 'fixtures/core-before-build-optimization-vii.ts.txt'), 'utf8').replace(/\r\n/g, '\n');
const afterText = () => fs.readFileSync(path.join(__dirname, 'fixtures/core-before-subphase-attribution-ix.ts.txt'), 'utf8').replace(/\r\n/g, '\n');
const emptyCounts = () => ({ mapNew: 0, mapGet: 0, mapSet: 0, mapHas: 0, entryCalls: 0, entryPairs: 0, keysCalls: 0, valuesCalls: 0, roomCloneCalls: 0 });
function measuredCore(text, state) {
  const context = vm.createContext({ exports: {}, require: x => { throw new Error('unlisted host import:' + x); },
    __count: (k, n = 1) => { if (state.measure) state.counts[k] += n; } });
  for (const [name, get] of Object.entries({ Game: () => state.game, Memory: () => state.memory, RESOURCES_ALL: () => state.resources })) Object.defineProperty(context, name, { get });
  vm.runInContext(`{
    const Base = Map;
    Map = class extends Base {
      constructor(...args) { super(...args); __count('mapNew'); }
      get(k) { __count('mapGet'); return super.get(k); }
      set(k,v) { __count('mapSet'); return super.set(k,v); }
      has(k) { __count('mapHas'); return super.has(k); }
    };
    const entries = Object.entries, keys = Object.keys, values = Object.values;
    Object.entries = function(o) { const a = entries(o); __count('entryCalls'); __count('entryPairs', a.length); return a; };
    Object.keys = function(o) { __count('keysCalls'); return keys(o); };
    Object.values = function(o) { __count('valuesCalls'); return values(o); };
  }`, context);
  const marked = text.replace('function deepFreezeRoom(room) {', "function deepFreezeRoom(room) { __count('roomCloneCalls');");
  const js = ts.transpileModule(marked, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  vm.runInContext(js, context, { timeout: 5000 });
  return context.exports;
}
function make(text = afterText(), instrument = false) {
  const s = S.make(text, true);
  s.measure = false; s.counts = emptyCounts();
  if (instrument) s.core = measuredCore(text, s);
  return s;
}
function build(s, extra = {}, reader) {
  const r = reader || s.core.createCompatibilityReadCore();
  const observation = r.buildObservation({ scope: 'market-fresh', epochSeq: 1, rooms: Object.values(s.game.rooms), ...extra.observation });
  const index = r.buildCommitments({ tick: s.game.time, tasks: s.memory.data.resourceControl.tasks,
    reservations: s.memory.runtime.resourceReservations, observation, ...extra.index });
  return { reader: r, observation, index };
}
function snapshot(b, roomNames = ['W1N1', 'W2N1', 'W3N1'], resources = ['H', 'energy', 'U', 'invalid']) {
  const i = b.index, o = b.observation, rows = [];
  // Detached calls must keep working (the original API did not depend on this).
  const { commitmentCompleteness, outgoing, incoming, pendingIncoming, pendingOutgoing, reservedProduction,
    incomingTaskCount, outgoingTaskCount, findMergeableTaskId, receiverCommitments, reservationSnapshot } = i;
  for (const room of roomNames) for (const resource of resources) rows.push({ room, resource,
    completeness: commitmentCompleteness(room, resource), outgoing: outgoing(room, resource), incoming: incoming(room, resource),
    pendingIncoming: pendingIncoming(room, resource), pendingOutgoing: pendingOutgoing(room, resource),
    reason: pendingOutgoing(room, resource, 'reason'), reasonAbsent: pendingOutgoing(room, resource, 'missing-prefix'),
    production: reservedProduction(room, resource),
    excludes: ['task', 'contract', 'legacy-unresolved'].map(kind => reservedProduction(room, resource, { kind, id: 'same-id' })),
    logical: reservedProduction(room, resource, { kind: 'logical-service', namespace: 'synthesis', id: 'synthesis:W1N1:H' }) });
  const rooms = roomNames.map(room => ({ room, incoming: incomingTaskCount(room), outgoing: outgoingTaskCount(room), receiver: receiverCommitments(room) }));
  const merges = [];
  for (const from of roomNames) for (const to of roomNames) for (const origin of ['manual', 'automatic']) for (const reason of ['', 'reason-a', 'reason-b'])
    merges.push(findMergeableTaskId('H', from, to, origin, reason));
  const observation = { data: o.data, roomNames: o.roomNames(), empireResources: o.empireResources(),
    resourceTotals: resources.map(r => o.empireTotal(r)),
    rooms: roomNames.map(r => ({ r, has: o.hasRoom(r), resources: o.roomResources(r), amounts: resources.map(k => [o.roomAmount(r,k),o.amount(r,'storage',k),o.amount(r,'terminal',k)]), locations: [o.location(r,'storage'),o.location(r,'terminal')] })), stale: o.isStale() };
  return H.json({ keys: Object.keys(i), revision: i.revision, builtAtTick: i.builtAtTick,
    completeness: i.completeness, rows, rooms, merges, reservations: reservationSnapshot(), metrics: i.metrics, observation });
}
function compareScenario(name) {
  const a = make(beforeText(), false), b = make(afterText(), false); S.scenarios[name](a); S.scenarios[name](b);
  const ga = { writes: 0 }, gb = { writes: 0 }; a.memory = H.guard(a.memory,ga); b.memory = H.guard(b.memory,gb);
  for (let n = 1; n <= 12; n++) {
    a.game.time = b.game.time = n * 100; a.cpuValue = b.cpuValue = .1;
    a.observer.run(); b.observer.run();
  }
  return { name, input: 'synthetic', byteEquivalent: JSON.stringify(a.lines) === JSON.stringify(b.lines),
    writes: [ga.writes,gb.writes], readers: [a.calls.readers,b.calls.readers], observations: [a.calls.observation,b.calls.observation],
    commitments: [a.calls.commitments,b.calls.commitments], reports: b.lines.length,
    oldFactoryExecutions: a.factories.length, newFactoryExecutions: b.factories.length, actualEngineMeasurement: false };
}
function operationCounts(count = 37, resourcesPerEndpoint = 32) {
  return [beforeText(),afterText()].map(text => {
    const s = make(text,true); const r = s.core.createCompatibilityReadCore();
    for (let n = 0; n < count; n++) s.memory.data.resourceControl.tasks['t'+n] = task({ id:'t'+n,reason: 'reason-a' });
    for (const room of Object.values(s.game.rooms)) for (const kind of ['storage','terminal'])
      for (let j = 0; j < resourcesPerEndpoint; j++) room[kind].store['synthetic_'+j] = j+1;
    s.counts = emptyCounts(); s.measure = true;
    const o = r.buildObservation({scope:'market-fresh',epochSeq:1,rooms:Object.values(s.game.rooms)});
    s.measure = false; const observation = { ...s.counts };
    s.counts = emptyCounts(); s.measure = true;
    const index = r.buildCommitments({tick:100,tasks:s.memory.data.resourceControl.tasks,reservations:{},observation:o});
    s.measure = false; const commitment = { ...s.counts };
    return { tasks: count, resourcesPerEndpointIncludingEnergyH: resourcesPerEndpoint + 2, observation, commitment,
      semantics: snapshot({observation:o,index}) };
  });
}
function deterministicCorpus(seed = 1, count = 50) {
  let x = seed >>> 0; const next = n => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
  const rooms = ['W1N1','W2N1','W3N1']; const resources = ['H','energy','U','unknown'];
  const tasks = {}, reservations = {};
  for (let n = 0; n < count; n++) {
    const t = task({id:'t'+n,fromRoomName:rooms[next(3)],toRoomName:rooms[next(3)],resource:resources[next(4)],
      origin: next(3) ? 'manual' : 'automatic',status: ['pending','pending','pending','done','cancelled','failed'][next(6)],
      reason:['','reason-a','reason-b'][next(3)],remainingAmount:next(101)});
    const v = next(13);
    if (v === 0) { t.amount = Number.MAX_SAFE_INTEGER; t.remainingAmount = Number.MAX_SAFE_INTEGER; }
    if (v === 1) t.remainingAmount = -1;
    if (v === 2) t.status = 'damaged';
    if (v === 3) t.fromRoomName = '';
    if (v === 4) t.blockedReason = 'source_depleted';
    if (v === 5) t.blockedReason = 'receiver_capacity';
    if (v === 6) t.lastProgressAt = 98;
    tasks[n] = t;
  }
  for (let n = 0; n < Math.floor(count/4); n++) reservations[n] = reservation({roomName:rooms[next(3)], resource:resources[next(4)],
    holderId:['same-id','synthesis:W1N1:H','missing'][next(3)],owner: {kind:['task','contract','legacy-unresolved'][next(3)],id:'same-id'},
    expiresAt:[99,100,200][next(3)],amount:next(100)});
  return { tasks, reservations };
}
module.exports = { S,H,task,reservation,beforeText,afterText,make,build,snapshot,compareScenario,operationCounts,deterministicCorpus };
