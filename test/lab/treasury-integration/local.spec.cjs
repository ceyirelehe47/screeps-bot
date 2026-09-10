'use strict';
// These tests execute the real adapter/coordinator/control-record implementation.
// Only Game/OS ports are synthetic. They are NOT a substitute for real-kernel
// Jest integration tests or the Agent's new standalone run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const BASE = path.resolve(__dirname, '../../..');
const KEY = '__labTerminalTransferProbe';
const fixtureConfig = () => ({ experimentId: 'lab-treasury-unit-0001', mode: 'observer', shardName: 'unit-shard', username: 'lab-unit-user',
  sourceRoomName: 'W1N57', targetRoomName: 'W10N57', sourceTerminalId: 'a100000000000001', targetTerminalId: 'a100000000000002',
  resourceType: 'H', amount: 100, description: 'lab-treasury-unit-0001 exact 100H', targetTick: 100, maxFeeEnergy: 26, maxSamples: 32 });
function scene() {
  const config = fixtureConfig(), events = [], calls = [];
  let quote = 26, result = 0, sendError;
  const memory = { [KEY]: { experimentId: config.experimentId, armed: true, attempted: false } };
  function terminal(id, h, energy) {
    const store = { H: h, energy };
    Object.defineProperties(store, {
      getUsedCapacity: { value(r) { return r ? (this[r] ?? 0) : Object.keys(this).reduce((s,k) => s + this[k], 0); } },
      getFreeCapacity: { value() { return 300000 - this.getUsedCapacity(); } }, getCapacity: { value() { return 300000; } },
    });
    return { id, store, my: true, owner: { username: config.username }, isActive: () => true, cooldown: 0,
      send(...args) { calls.push({ receiver: this.id, args }); if (sendError) throw sendError; return result; } };
  }
  const source = terminal(config.sourceTerminalId, 1000, 10000), target = terminal(config.targetTerminalId, 0, 2000);
  const room = (name, t) => ({ name, terminal: t, controller: { my: true, owner: { username: config.username }, level: 8 } });
  const game = { time: 100, shard: { name: config.shardName }, rooms: { W1N57: room('W1N57', source), W10N57: room('W10N57', target) },
    market: { calcTransactionCost: () => quote, incomingTransactions: [], outgoingTransactions: [] } };
  const cache = new Map(), globals = { Game: game, Memory: memory, OK: 0, console: { log: s => events.push(JSON.parse(s)) } };
  function load(relative) {
    const file = path.resolve(BASE, relative);
    if (!file.startsWith(BASE + path.sep)) throw new Error('test loader path escape');
    if (cache.has(file)) return cache.get(file).exports;
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const m = { exports: {} }; cache.set(file, m);
    vm.runInNewContext(code, { ...globals, exports: m.exports, module: m, require(name) {
      if (!name.startsWith('.')) throw new Error('unexpected runtime dependency in local adapter: ' + name);
      return load(path.relative(BASE, path.resolve(path.dirname(file), name + '.ts')));
    } }, { filename: file, timeout: 2000 });
    return m.exports;
  }
  const api = load('test/lab/treasury-integration/adapter.ts');
  const adapter = api.makeLiveTransferAdapter(config);
  const args = api.prepareLiveTransfer(config);
  const txn = (amount = 100, id = 'tx100') => ({ transactionId: id, time: 100, sender: { username: config.username }, recipient: { username: config.username },
    resourceType: 'H', amount, from: config.sourceRoomName, to: config.targetRoomName, description: config.description });
  function arrive(fee = 26, amount = 100) {
    game.time = 101; source.store.H -= amount; source.store.energy -= fee; target.store.H += amount; source.cooldown = 9;
    game.market.incomingTransactions = [txn(amount)]; game.market.outgoingTransactions = [txn(amount)];
  }
  function observation() {
    const snapshots = {};
    for (const [name, r] of Object.entries(game.rooms)) {
      const t = r.terminal;
      snapshots[name] = { exists: true, structureId: t.id, amounts: { H: t.store.H, energy: t.store.energy },
        usedCapacity: t.store.getUsedCapacity(), freeCapacity: t.store.getFreeCapacity() };
    }
    return { epoch: { observedAtTick: game.time, worldSequence: 0 }, location: name => snapshots[name] };
  }
  const reconcile = () => api.reconcileLiveTransfer(args, observation());
  return { config, api, adapter, args, memory, game, source, target, calls, events, txn, arrive, observation, reconcile,
    quote: x => { quote = x; }, result: x => { result = x; }, sendError: x => { sendError = x; }, load };
}
const committed = s => assert.equal(s.reconcile().conclusion, 'observed_committed');
const uncertain = s => assert.equal(s.reconcile().conclusion, 'still_uncertain');

test('prepared inputs/postings/payload are frozen facts, not re-quoted derivatives', () => {
  const s = scene(), raw = s.api.encodeLivePayload(s.args);
  s.quote(999);
  assert.equal(s.api.encodeLivePayload(s.args), raw);
  assert.equal(s.api.livePostings(s.args)[1].delta, -26);
  assert.equal(s.api.encodeLivePayload(s.api.decodeLivePayload(raw)), raw);
  assert.equal(s.calls.length, 0);
});
for (const [name, mutate] of Object.entries({
  'wrong route': s => { s.config.sourceRoomName = 'W2N57'; },
  'wrong shard': s => { s.game.shard.name = 'other'; },
  'missing shard': s => { delete s.game.shard; },
  'missing terminal': s => { delete s.game.rooms.W1N57.terminal; },
  'wrong ID': s => { s.source.id = 'replacement'; },
  'wrong owner': s => { s.source.owner.username = 'other'; },
  'not my': s => { s.source.my = false; },
  'inactive': s => { s.source.isActive = () => false; },
  'controller too low': s => { s.game.rooms.W1N57.controller.level = 5; },
  'power effect': s => { s.source.effects = [{ effect: 1 }]; },
  'other resource': s => { s.source.store.O = 1; },
  'cooldown': s => { s.source.cooldown = 1; },
  'quote unavailable': s => { s.game.market.calcTransactionCost = () => { throw Error('unavailable'); }; },
  'quote fractional': s => s.quote(1.5),
  'quote above cap': s => s.quote(27),
  'quote below frozen experimental quote': s => s.quote(25),
  'energy shortage': s => { s.source.store.energy = 20; },
  'H shortage': s => { s.source.store.H = 99; },
  'capacity shortage': s => { s.target.store.energy = 299950; },
  'missed tick': s => { s.game.time = 101; },
})) test('prepare rejects ' + name + ' with no API call', () => {
  const s = scene(); mutate(s); assert.throws(() => s.api.prepareLiveTransfer(s.config)); assert.equal(s.calls.length, 0);
});
test('real adapter uses member send once; OK does not change the world or imply settlement', () => {
  const s = scene(); assert.equal(s.adapter.execute(s.args).ok, true);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].receiver, s.config.sourceTerminalId);
  assert.deepEqual(s.calls[0].args, ['H', 100, 'W10N57', s.config.description]);
  assert.equal(s.source.store.H, 1000); assert.equal(s.target.store.H, 0);
  assert.equal(s.adapter.settlesOnAccept, false); assert.equal(s.adapter.retryFacts, undefined);
  assert.equal(s.memory[KEY].attempted, true); assert.equal(s.adapter.execute(s.args).ok, false); assert.equal(s.calls.length, 1);
});
for (const [name, mutate] of Object.entries({
  absent: s => { delete s.memory[KEY]; }, disarmed: s => { s.memory[KEY].armed = false; },
  attempted: s => { s.memory[KEY].attempted = true; }, wrongID: s => { s.memory[KEY].experimentId = 'other'; },
  corrupt: s => { s.memory[KEY] = 'bad'; },
  oversized: s => { s.memory[KEY].syncResult = { ok: false, error: 'x'.repeat(4096) }; },
  silentWriteLoss: s => { const saved = s.memory[KEY]; Object.defineProperty(s.memory, KEY, { get: () => saved, set: () => {} }); },
  changedQuote: s => s.quote(25), changedBaseline: s => { s.source.store.H += 1; },
})) test('execute rejects ' + name + ' before send', () => {
  const s = scene(); mutate(s); assert.equal(s.adapter.execute(s.args).ok, false); assert.equal(s.calls.length, 0);
});
test('API throw/non-OK preserve attempted and never create a second attempt', () => {
  for (const mode of ['throw', 'non-OK']) {
    const s = scene(); if (mode === 'throw') s.sendError(Error('after call')); else s.result(-6);
    if (mode === 'throw') assert.throws(() => s.adapter.execute(s.args)); else assert.equal(s.adapter.execute(s.args).ok, false);
    assert.equal(s.memory[KEY].attempted, true); assert.equal(s.adapter.execute(s.args).ok, false); assert.equal(s.calls.length, 1);
  }
});
for (const fee of [26, 10]) test('exact full transfer reconciles observed fee ' + fee + ' without rewriting quote', () => {
  const s = scene(); s.arrive(fee); committed(s);
  assert.equal(s.reconcile().observedFee, fee); assert.equal(s.api.livePostings(s.args)[1].delta, -26);
  assert.equal(s.calls.length, 0); // reconciliation itself never calls send
});
for (const [name, mutate] of Object.entries({
  'no records': s => { s.game.market.incomingTransactions = []; s.game.market.outgoingTransactions = []; },
  'missing outgoing view': s => { delete s.game.market.outgoingTransactions; },
  'missing outgoing mirror': s => { s.game.market.outgoingTransactions = []; },
  'partial related second ID': s => { s.game.market.incomingTransactions.push(s.txn(60, 'tx200')); },
  'second full transaction': s => { s.game.market.incomingTransactions.push(s.txn(100, 'tx200')); },
  'same ID conflicting amount': s => { s.game.market.outgoingTransactions[0].amount = 60; },
  'same ID conflicting route': s => { s.game.market.outgoingTransactions[0].to = 'W2N57'; },
  'same ID conflicting description': s => { s.game.market.outgoingTransactions[0].description = 'other'; },
  'wrong parties': s => { for (const v of [s.game.market.incomingTransactions, s.game.market.outgoingTransactions]) v[0].sender.username = 'other'; },
  'old time': s => { for (const v of [s.game.market.incomingTransactions, s.game.market.outgoingTransactions]) v[0].time = 99; },
  'future time': s => { for (const v of [s.game.market.incomingTransactions, s.game.market.outgoingTransactions]) v[0].time = 101; },
  'market order': s => { for (const v of [s.game.market.incomingTransactions, s.game.market.outgoingTransactions]) v[0].order = { id: 'o' }; },
  'description substring only': s => { for (const v of [s.game.market.incomingTransactions, s.game.market.outgoingTransactions]) v[0].description += ' extra'; },
  'target replacement': s => { s.target.id = 'replacement'; },
  'source overspend': s => { s.source.store.energy = 9973; },
  'zero fee': s => { s.source.store.energy = 10000; },
  'target energy changed': s => { s.target.store.energy += 1; },
  'target amount wrong': s => { s.target.store.H = 60; },
})) test('settlement remains unknown: ' + name, () => {
  const s = scene(); s.arrive(); mutate(s); uncertain(s); assert.equal(s.calls.length, 0);
});
test('consistent same-ID copies and unrelated transactions do not create false ambiguity', () => {
  const s = scene(); s.arrive(); s.game.market.incomingTransactions.push(s.txn());
  s.game.market.outgoingTransactions.push({ ...s.txn(60, 'unrelated'), description: 'different request' }); committed(s);
});
test('stale Treasury observation cannot be replaced by newer Game data during reconcile', () => {
  const s = scene(), old = s.observation(); s.arrive();
  assert.equal(s.api.reconcileLiveTransfer(s.args, old).conclusion, 'still_uncertain');
});
test('malformed durable payloads and different postings/versions stay unknown', () => {
  const s = scene(), raw = s.api.encodeLivePayload(s.args); s.arrive();
  for (const bad of ['', raw + '|extra', raw.replace('|100|', '|0100|'), raw.replace('|26|26|', '||26|'), 'x'.repeat(513)]) assert.equal(s.api.decodeLivePayload(bad), null);
  const f = { actionKind: s.api.LIVE_TRANSFER_KIND, transactionId: 'tk1_test', durablePayload: raw, durablePayloadVersion: 1, postings: s.api.livePostings(s.args) };
  assert.equal(s.adapter.reconcile(f, s.observation()), 'observed_committed');
  assert.equal(s.adapter.reconcile({ ...f, durablePayloadVersion: 2 }, s.observation()), 'still_uncertain');
  assert.equal(s.adapter.reconcile({ ...f, postings: [] }, s.observation()), 'still_uncertain');
});
module.exports = { scene };
