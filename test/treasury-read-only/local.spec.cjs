'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '../..');
const corePath = 'src/runtime/treasury/readOnlyObservation.ts';
function load(file, imports = {}, globals = {}) {
  const input = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const result = ts.transpileModule(input, { fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, strict: true } });
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const exports = {};
  const context = vm.createContext({ exports, module: { exports }, require: id => {
    if (!(id in imports)) throw new Error('unexpected runtime dependency: ' + id);
    return imports[id];
  }, ...globals });
  new vm.Script(result.outputText, { filename: file }).runInContext(context, { timeout: 3000 });
  return { exports, context };
}
const api = load(corePath).exports;
const json = value => JSON.parse(JSON.stringify(value));
function readOnly(value, counter = { writes: 0 }, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const no = () => { counter.writes++; throw new Error('forbidden mutation'); };
  const p = new Proxy(value, { get: (t, k) => readOnly(Reflect.get(t, k), counter, seen), set: no, defineProperty: no, deleteProperty: no, setPrototypeOf: no });
  seen.set(value, p); return p;
}
function makeRoom(name = 'W1N1') {
  const mk = (id, amounts) => {
    const store = { ...amounts };
    Object.defineProperties(store, {
      getUsedCapacity: { value: r => r === undefined ? Object.values(store).reduce((a,b) => a+b,0) : store[r] ?? 0, configurable: true },
      getCapacity: { value: () => 300000, configurable: true },
      getFreeCapacity: { value: () => 300000 - store.getUsedCapacity(), configurable: true },
    });
    return { id, my: true, owner: { username: 'fixture' }, store, isActive: () => true, cooldown: 0 };
  };
  return { name, controller: { my: true, level: 8 }, storage: mk('storage-'+name, { energy: 5000, H: 300 }), terminal: mk('terminal-'+name, { energy: 1000, H: 100 }) };
}
function fixture(overrides = {}) {
  const c = { enabled: true, shardName: 'shard-fixture', rooms: ['W1N1'], resources: ['energy','H'], intervalTicks: 100, maxSampleCpu: 2, reserveCpu: 5, minBucket: 2000, maxLogBytes: 16384, ...overrides };
  let tick = 100, used = 10, cpuStep = 0.001;
  const calls = [], lines = [], rooms = { W1N1: makeRoom() }, memory = {}, writes = { writes: 0 };
  const epoch = () => ({ scope: 'shared', epochSeq: 1, observedAtTick: tick, worldSequence: 0 });
  const loc = (r, k) => {
    const s = rooms[r]?.[k];
    return { exists: !!s, structureId: s?.id, amounts: s ? { ...s.store } : {}, usedCapacity: s?.store.getUsedCapacity() ?? 0, freeCapacity: s?.store.getFreeCapacity() ?? 0 };
  };
  const observation = { epoch: epoch(), isStale: () => false, hasRoom: r => !!rooms[r], location: loc };
  const index = { builtAtTick: tick, revision: 1, completeness: { complete: true, globalIncomplete: false, invalidRecords: 0, incompleteScopeCount: 0 },
    metrics: { taskRecords: 1, reservationRecords: 1, globallyIncomplete: false },
    commitmentCompleteness: () => 'complete', outgoing: () => 10, incoming: () => 20, reservedProduction: () => 5 };
  const service = {
    observation: () => { calls.push('observation'); observation.epoch = epoch(); return observation; },
    commitments: () => { calls.push('commitments'); return index; },
    query: ctx => { calls.push(['query', json(ctx)]); const n = loc(ctx.rooms[0], ctx.locations[0]).amounts[ctx.resource] ?? 0;
      return { observed: n, committed: 15, incoming: 20, spendable: Math.max(0,n-15), contextStatus: 'valid', commitmentStatus: 'complete',
        authorizationSafe: true, authorizationBlockers: [], writeAdmission: { ready: false, blockers: ['adapter_missing'] }, epoch: epoch() }; },
    riskAdjustedFreeCapacity: (r,k) => { calls.push('capacity'); return loc(r,k).freeCapacity - 20; },
    kernelJournal: () => { calls.push('kernelJournal'); return { health: { status: 'healthy', reason: null, ringDegraded: null }, active: [], ring: [] }; },
  };
  // Any accidental call outside the read capability is immediately observable.
  const servicePort = new Proxy(service, { get(t,k) { if (!(k in t)) throw new Error('forbidden service method: '+String(k)); return t[k]; } });
  const ports = {
    getTick: () => { calls.push('tick'); return tick; }, getShard: () => c.shardName,
    cpu: () => { used += cpuStep; return { used, tickLimit: 100, bucket: 10000 }; },
    getRoom: r => { calls.push(['room',r]); return readOnly(rooms[r], writes); },
    getResourceCatalog: () => ['energy','H','O','X','Z'],
    getMemory: () => readOnly(memory, writes), getService: () => { calls.push('getService'); return servicePort; },
    emit: s => { lines.push(s); used += 0.04; },
  };
  const o = api.createTreasuryReadOnlyObserver(c, ports);
  return { c, o, ports, rooms, memory, observation, index, service, calls, lines, writes,
    next: n => { tick = n; used = 10; }, step: n => { cpuStep = n; }, cost: n => { used += n; },
    report: () => JSON.parse(lines.at(-1)) };
}

test('module has no runtime imports, Game or Memory dependency at evaluation', () => {
  const { exports } = load(corePath, {}, { Game: undefined, Memory: undefined });
  assert.equal(typeof exports.createTreasuryReadOnlyObserver, 'function');
});
test('shipped default config is disabled and does not select the experiment rooms', () => {
  const config = load('src/config/treasuryReadOnly.ts').exports.TREASURY_READ_ONLY_CONFIG;
  assert.equal(config.enabled, false); assert.deepEqual(json(config.rooms), []); assert.equal(config.shardName, '');
  const ports = new Proxy({}, { get() { throw new Error('no port permitted while disabled'); } });
  assert.equal(api.createTreasuryReadOnlyObserver(config, ports).run().status, 'disabled');
});
test('non-due tick and repeat invocation do not read service, memory or stores', () => {
  const f=fixture(); f.next(101); assert.equal(f.o.run().status,'not_due'); assert.deepEqual(f.calls,['tick']);
  f.next(200); f.o.run(); const n=f.lines.length, q=f.calls.filter(x=>Array.isArray(x)&&x[0]==='query').length;
  assert.equal(f.o.run().status,'not_due'); assert.equal(f.lines.length,n); assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='query').length,q);
});
for (const change of [{rooms:[]},{rooms:['W1N1','W1N1']},{resources:[]},{resources:['H','H']},{intervalTicks:0},{maxSampleCpu:NaN},{maxLogBytes:10},{shardName:''},{rooms:['__proto__']},{rooms:['W1N1','W1N2','W1N3','W1N4','W1N5']}]) {
  test('invalid configuration stops without invoking ports: '+JSON.stringify(change), () => {
    const f=fixture(change); assert.equal(f.o.run().status,'invalid_config'); assert.equal(f.calls.length,0); assert.equal(f.lines.length,0);
  });
}
test('unknown resource and wrong shard skip without service access', () => {
  const f=fixture({resources:['BAD']}); assert.equal(f.o.run().status,'invalid_resource'); assert.ok(!f.calls.includes('getService'));
  const g=fixture(); g.ports.getShard=()=> 'other'; assert.equal(g.o.run().status,'wrong_shard'); assert.ok(!g.calls.includes('getService'));
});
for (const badCpu of [{used:10,tickLimit:14,bucket:10000},{used:10,tickLimit:100,bucket:100}]) {
  test('low CPU headroom/bucket skips before querying: '+JSON.stringify(badCpu), () => {
    const f=fixture(); f.ports.cpu=()=>badCpu; assert.equal(f.o.run().status,'cpu_skipped'); assert.ok(!f.calls.includes('getService')); assert.equal(f.lines.length,0);
  });
}
test('valid populated world: exact read-only query flags, stock vs occupancy, no Memory writes', () => {
  const f=fixture(); const before=JSON.stringify(f.memory); assert.equal(f.o.run().status,'sampled');
  const r=f.report(); assert.equal(r.authorizesActions,false); assert.equal(r.strategyPolicyEvaluated,false); assert.equal(r.queryWithhold,0);
  assert.equal(r.scope.isEmpireTotal,false); assert.equal(r.endpoints.length,2); assert.equal(r.endpoints[1].direct.amounts.H,100);
  assert.equal(r.endpoints[1].balances.H.committed,15); assert.equal(r.endpoints[1].balances.H.spendable,85);
  assert.equal(r.endpoints[1].balances.H.writeReady,false); assert.deepEqual(r.endpoints[1].balances.H.writeBlockers,['adapter_missing']);
  for(const [_,q] of f.calls.filter(x=>Array.isArray(x)&&x[0]==='query')) {
    assert.deepEqual(q.rooms,['W1N1']); assert.equal(q.locations.length,1); assert.equal(q.allowProjected,false); assert.equal(q.allowIncoming,false);
    assert.equal(q.subtractOutgoing,true); assert.equal(q.subtractReservations,true); assert.equal(q.withhold,0); assert.equal('owner' in q,false);
  }
  assert.equal(JSON.stringify(f.memory),before); assert.equal(f.writes.writes,0); assert.equal(r.marketHints.status,'absent');
  assert.equal(r.selectedCommitments[0].scope,'room_not_endpoint');
});
for (const [scenario, prepare, expected] of [
  ['invisible',f=>{delete f.rooms.W1N1;},'not_visible'],
  ['not-owned',f=>{f.rooms.W1N1.controller.my=false;},'not_owned'],
  ['no-terminal',f=>{delete f.rooms.W1N1.terminal;},'absent'],
  ['null-capacity',f=>Object.defineProperty(f.rooms.W1N1.terminal.store,'getCapacity',{value:()=>null}),'unreadable'],
  ['NaN-resource',f=>{f.rooms.W1N1.terminal.store.H=NaN;},'unreadable'],
  ['negative-resource',f=>{f.rooms.W1N1.terminal.store.H=-1;},'unreadable'],
  ['getter-throws',f=>Object.defineProperty(f.rooms.W1N1.terminal.store,'getUsedCapacity',{value:()=>{throw Error('read');}}),'unreadable'],
]) test('unavailable facts are explicit, never zero stock: '+scenario,()=>{
  const f=fixture(); prepare(f); f.o.run(); const row=f.report().endpoints.find(e=>e.location==='terminal');
  assert.equal(row.directStatus,expected); assert.equal('balances' in row,false); assert.equal('direct' in row,false);
});
test('real zero stock is distinguishable from unreadable/absent',()=>{
  const f=fixture(); f.rooms.W1N1.terminal.store.H=0; f.o.run(); const row=f.report().endpoints[1];
  assert.equal(row.directStatus,'ok');assert.equal(row.direct.amounts.H,0);assert.equal(row.comparison,'match_selected_scope');
});
test('stale observation does not query balances or label equivalence',()=>{
  const f=fixture(); f.observation.isStale=()=>true; f.o.run(); const r=f.report(); assert.equal(r.observationStatus,'stale');
  assert.ok(r.endpoints.every(e=>e.comparison==='unavailable_stale_observation')); assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='query').length,0);
});
test('independent direct store detects wrong cached amount AND wrong structure ID',()=>{
  const f=fixture(); const read=f.observation.location;f.observation.location=(r,k)=>({...read(r,k),structureId:'old',amounts:{energy:999,H:99}});
  f.o.run();assert.equal(f.report().endpoints[1].comparison,'mismatch');assert.ok(f.report().endpoints[1].mismatches.includes('H'));assert.ok(f.report().endpoints[1].mismatches.includes('structure'));
});
test('high physical stock never hides query incompleteness and write blockers',()=>{
  const f=fixture(); const q=f.service.query;f.service.query=c=>({...q(c),spendable:0,authorizationSafe:false,commitmentStatus:'globally-incomplete',authorizationBlockers:['commitment_incomplete']});
  f.o.run();const row=f.report().endpoints[1];assert.equal(row.direct.amounts.H,100);assert.equal(row.balances.H.spendable,0);assert.equal(row.balances.H.authorizationSafe,false);
});
test('unhealthy kernel is not reported as zero active work',()=>{
  const f=fixture();f.service.kernelJournal=()=>({health:{status:'unhealthy',reason:'corrupt',ringDegraded:null},active:[],ring:[]});f.o.run();
  assert.equal(f.report().kernel.activeCount,null);assert.equal(f.report().kernel.phases,null);
});
test('unresolved kernel phase is reported without calling settle or deleting a record',()=>{
  const f=fixture();const active=readOnly([{phase:'outcome_unknown',attemptId:'a',worstCase:[{delta:-100}]}],f.writes);
  f.service.kernelJournal=()=>({health:{status:'healthy',reason:null,ringDegraded:null},active,ring:[]});f.o.run();
  assert.equal(f.report().kernel.phases.outcome_unknown,1);assert.equal(active.length,1);assert.equal(f.writes.writes,0);
});
test('net changes use detached primitives and never claim to know the writer',()=>{
  const f=fixture();f.o.run();f.rooms.W1N1.terminal.store.H-=25; f.next(200);f.o.run();
  const d=f.report().endpoints[1].changeSinceSample;assert.equal(d.status,'net_change_unattributed');assert.equal(d.amounts.H,-25);assert.equal(d.fromTick,100);assert.equal(d.toTick,200);
});
test('replacement and stale sample gap invalidate net-change comparison',()=>{
  const f=fixture();f.o.run();f.next(200);f.rooms.W1N1.terminal.id='replacement';f.o.run();assert.equal(f.report().endpoints[1].changeSinceSample.status,'endpoint_changed');
  f.next(1000);f.o.run();assert.equal(f.report().endpoints[1].changeSinceSample.status,'gap_not_comparable');
});
test('no retained live Store reference is needed on the next sample',()=>{
  const f=fixture();f.o.run(); const old=f.rooms.W1N1;
  f.rooms.W1N1=makeRoom();f.rooms.W1N1.terminal.store.H=10;
  Object.defineProperty(old.terminal,'store',{get(){throw Error('retained live object');}});f.next(200);f.o.run();
  assert.equal(f.report().endpoints[1].changeSinceSample.amounts.H,-90);
});
test('market hints preserve intent vs outcome and have explicit limited coverage',()=>{
  const f=fixture();f.memory.data={marketSaleAutomation:{marketActionJournal:[
    {id:'a',tick:99,actor:'seller',kind:'market_deal',outcome:'intent',roomName:'W1N1'},
    {id:'b',tick:100,actor:'seller',kind:'market_deal',outcome:'ok',roomName:'W1N1'},
    {id:'c',tick:100,actor:'other',kind:'market_deal',outcome:'ok',roomName:'W9N9'},
  ]}};const before=JSON.stringify(f.memory);f.o.run();const h=f.report().marketHints;
  assert.equal(h.coverage,'existing_market_journal_only');assert.equal(h.rows.length,2);assert.deepEqual(h.rows.map(r=>r.outcome),['ok','intent']);assert.equal(JSON.stringify(f.memory),before);
});
for (const [name,value,status] of [['null',null,'unreadable'],['object',{},'unreadable'],['oversize',Array(101).fill(null),'over_bound'],['malformed',[{tick:100}],'unreadable']]) {
  test('invalid journal does not look empty/healthy: '+name,()=>{
    const f=fixture();f.memory.data={marketSaleAutomation:{marketActionJournal:value}};f.o.run();assert.equal(f.report().marketHints.status,status);assert.equal(f.writes.writes,0);
  });
}
test('bounded journal keeps recent hints with explicit omissions',()=>{
  const f=fixture();f.memory.data={marketSaleAutomation:{marketActionJournal:Array.from({length:100},(_,i)=>({id:'a'+i,tick:i,actor:'worker',kind:'market_deal',outcome:'ok',roomName:'W1N1'}))}};
  f.o.run();assert.equal(f.report().marketHints.rows.length,8);assert.equal(f.report().marketHints.omittedCount,92);assert.equal(f.report().marketHints.rows[0].tick,99);
});
test('large output yields a small valid JSON omission notice, never a PASS or malformed slice',()=>{
  const f=fixture({maxLogBytes:1024});const result=f.o.run();assert.equal(result.status,'output_limited');assert.equal(f.report().status,'output_limited');assert.ok(Buffer.byteLength(f.lines[0])<=1024);
});
test('UTF-8 byte length equals independent Buffer oracle for unicode, surrogate and escaping cases',()=>{
  for(const s of ['a','中文','🧪','\ud800','\udfff','a\u0000b','\\"',JSON.stringify({x:'中🧪\ud800\n'})]) assert.equal(api.treasuryReadOnlyUtf8Bytes(s),Buffer.byteLength(s));
});
test('cooperative budget records partial coverage rather than completing all getters',()=>{
  const f=fixture({maxSampleCpu:0.15});f.step(0.02);f.o.run();assert.equal(f.report().status,'partial_cpu_budget');assert.ok(f.calls.filter(x=>Array.isArray(x)&&x[0]==='query').length<4);
});
test('previous total CPU includes serialization/logging phase, not a fictitious zero overhead',()=>{
  const f=fixture(); const emit=f.ports.emit;f.ports.emit=s=>{emit(s);f.cost(0.5);};f.o.run();const prev=f.o.stats().previousRun;
  assert.ok(prev.totalCpuIncludingEmit>=0.54);f.next(200);f.o.run();assert.equal(f.report().previousRun.tick,100);assert.equal(f.report().previousRun.totalCpuIncludingEmit,prev.totalCpuIncludingEmit);
});
test('failure in Treasury query latches this observer off and does not escape',()=>{
  const f=fixture();f.service.query=()=>{throw Error('oops');};assert.equal(f.o.run().status,'fault_disabled');assert.equal(f.report().status,'disabled_after_read_or_output_error');
  f.next(200);assert.equal(f.o.run().status,'disabled_after_fault');assert.equal(f.lines.length,1);assert.equal(f.writes.writes,0);
});
test('throwing logger cannot escape or force a Treasury mutation',()=>{
  const f=fixture();f.ports.emit=()=>{throw Error('sink');};assert.doesNotThrow(()=>f.o.run());assert.equal(f.o.stats().disabledByFault,true);assert.equal(f.writes.writes,0);
});
test('fresh observer after reset does not invent continuity or persist a disable latch',()=>{
  const f=fixture();f.o.run();const restored=api.createTreasuryReadOnlyObserver(f.c,f.ports);f.next(200);restored.run();assert.equal(f.report().previousRun,null);assert.equal(f.report().endpoints[1].changeSinceSample.status,'no_comparable_previous_sample');
});
test('long sampling run retains at most one bounded previous snapshot',()=>{
  const f=fixture();for(let i=1;i<=300;i++){f.next(i*100);f.o.run();f.lines.length=0;}const s=f.o.stats();assert.equal(s.retainedEndpoints,2);assert.ok(s.previousRun.retainedPrimitiveChars<2000);assert.equal(f.writes.writes,0);
});

// Actual new main and actual observer wrapper, with all OLD business modules
// supplied as test ports. This is a loop-regression test, not a full bot run.
function mainHarness({enabled=false,brokenObserver=false,brokenBusiness=false}={}) {
  const f=fixture({enabled});const phases=[],events=[];
  const runtimeServices={getTreasuryService:()=>f.service,
    getMemoryService:()=>({}),getTickContextService:()=>({getAllSpawns:()=>[{room:{name:'W1N1'},work:()=>events.push('spawn.work')}],getAllCreeps:()=>[{work:()=>events.push('creep.work')}]})};
  // Main's existing lifecycle must remain usable when the new read port fails.
  f.service.beginTick=()=>events.push('begin');f.service.endTick=()=>events.push('end');
  const ro=load('src/runtime/treasuryReadOnlyRuntime.ts',{
    '@/config/treasuryReadOnly':{TREASURY_READ_ONLY_CONFIG:f.c},
    '@/runtime/runtimeServices':{getTreasuryService:()=>{if(brokenObserver)throw Error('observer');return f.service;}},
    '@/runtime/treasury/readOnlyObservation':api,
  },{Game:{time:100,shard:{name:f.c.shardName},rooms:readOnly(f.rooms,f.writes),cpu:{getUsed:()=>10,tickLimit:100,bucket:10000}},Memory:readOnly(f.memory,f.writes),RESOURCES_ALL:['H','energy'],console:{log:s=>f.lines.push(s)}}).exports;
  const profiler={measure:(name,fn)=>{phases.push(name);return fn();},measureRoomPhase:(_,__,fn)=>fn(),measureCreep:(_,fn)=>fn(),flush:()=>events.push('flush')};
  const modules={
    '@/modules/errorMapper':{errorMapper:fn=>fn},'@/runtime/runtimeServices':runtimeServices,
    '@/runtime/cpuPhaseProfiler':{createTickCpuProfiler:()=>profiler,setActiveTickCpuProfiler:()=>{}},
    '@/runtime/treasuryReadOnlyRuntime':ro,
  };
  const source=fs.readFileSync(path.join(ROOT,'src/main.ts'),'utf8');
  for(const m of source.matchAll(/from\s+"([^"]+)"/g)) if(!(m[1] in modules)) modules[m[1]]=new Proxy({}, {get:(_,name)=>()=>{
    if(brokenBusiness&&name==='runHomeDefense')throw Error('business fail');events.push(String(name));
  }});
  const main=load('src/main.ts',modules).exports;
  return {f,phases,events,main};
}
test('production main keeps the former 41 phases, with exactly one diagnostic before end',()=>{
  const h=mainHarness();h.main.loop();assert.equal(h.phases.length,42);assert.deepEqual(h.phases.slice(-4),['empireInventoryShadow','treasuryShadow','treasuryReadOnly','treasuryEndTick']);
  assert.equal(h.phases[0],'treasuryBeginTick');assert.ok(h.events.includes('spawn.work'));assert.ok(h.events.includes('creep.work'));assert.equal(h.events.at(-1),'flush');assert.equal(h.f.lines.length,0);
});
test('actual observer failure does not prevent production endTick and profiler flush',()=>{
  const h=mainHarness({enabled:true,brokenObserver:true});assert.doesNotThrow(()=>h.main.loop());assert.deepEqual(h.events.slice(-2),['end','flush']);assert.equal(JSON.parse(h.f.lines[0]).status,'disabled_after_read_or_output_error');
});
test('business errors retain original fail-fast behavior, not swallowed by observer',()=>{
  const h=mainHarness({brokenBusiness:true});assert.throws(()=>h.main.loop(),/business fail/);assert.ok(!h.events.includes('flush'));assert.ok(!h.phases.includes('treasuryReadOnly'));
});
test('new code never imports lab modules or action writers, and no new Memory root is assigned',()=>{
  for(const file of [corePath,'src/runtime/treasuryReadOnlyRuntime.ts']) {
    const s=fs.readFileSync(path.join(ROOT,file),'utf8');const out=ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
    assert.doesNotMatch(out,/test\/lab|test\/mock|\.send\(|\.deal\(|\.beginTick\(|\.endTick\(|\.settleUnknownOutcome\(|\.authorizeTreasuryActionContract\(|\.executeAuthorizedDispatch\(|\.bumpTreasuryWorldSequence\(/);
    assert.doesNotMatch(out,/(?:Memory|Game)\.[\w.]+\s*=(?!=)/);
  }
});

test('an output-limited notice never creates an invisible previous endpoint baseline',()=>{
  const f=fixture({maxLogBytes:1024});f.o.run();assert.equal(f.report().status,'output_limited');
  assert.equal(f.o.stats().retainedEndpoints,0);assert.equal(f.o.stats().previousRun.retainedPrimitiveChars,0);
});
test('caller mutation cannot change the frozen sampling profile midway through a run',()=>{
  const f=fixture();f.o.run();f.c.resources.push('O');f.c.rooms.push('W9N9');f.c.maxLogBytes=1024;
  f.next(200);f.o.run();const r=f.report();assert.deepEqual(r.scope.resources,['energy','H']);assert.deepEqual(r.scope.rooms,['W1N1']);
  assert.equal(r.endpoints[1].changeSinceSample.amounts.H,0);assert.equal(f.o.stats().retainedEndpoints,2);
});

test('kernel absence does not erase separately detected legacy stores from diagnostics',()=>{
  const f=fixture();f.service.kernelJournal=()=>({health:{status:'absent',reason:null,ringDegraded:null},legacyStores:['legacy-pending'],active:[],ring:[]});
  f.o.run();const k=f.report().kernel;assert.equal(k.scope,'global_kernel_only');assert.equal(k.activeCount,0);assert.deepEqual(k.legacyStores,['legacy-pending']);
});
