'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const H=require('./harness.cjs');
function compare(setup,options={}){
 const outputs=[];for(const v of ['old','new']){const f=H.fixture(options),r=H.loadReader(v);setup?.(f);const p=r.exports.createTreasuryCompatPreview(H.profile(),f.ports);const result=p.run();outputs.push({result:H.json(result),logs:f.logs,calls:f.calls,scans:r.scans(),stats:H.json(p.stats())});}
 assert.deepEqual(outputs[1].result,outputs[0].result);assert.deepEqual(outputs[1].logs,outputs[0].logs);assert.deepEqual(outputs[1].calls,outputs[0].calls);return outputs;
}
for(const [name,setup,opts] of [
 ['empty tables',null,{}],['missing tasks',f=>{delete f.memory.data.resourceControl.tasks;},{}],
 ['missing reservations',f=>{delete f.memory.runtime.resourceReservations;},{}],['invalid tasks array',f=>{f.memory.data.resourceControl.tasks=[];},{}],
 ['oversized table',f=>{for(let i=0;i<257;i++)f.memory.data.resourceControl.tasks['t'+i]={};},{}],
 ['exact table bound',f=>{for(let i=0;i<256;i++)f.memory.data.resourceControl.tasks['t'+i]={};},{}],
 ['table accessor must not execute',f=>{Object.defineProperty(f.memory.data.resourceControl.tasks,'evil',{enumerable:true,get(){throw new Error('must not run');}});},{}],
 ['inherited tasks ignored',f=>{Object.setPrototypeOf(f.memory.data.resourceControl.tasks,{fake:{}});},{}],
 ['invisible room',f=>{delete f.rooms.E3N59;},{}],['unowned room',f=>{f.rooms.E3N59.controller.my=false;},{}],
 ['absent terminal',f=>{delete f.rooms.E3N59.terminal;},{}],
 ['overcapacity store',f=>{f.rooms.E3N59.storage=f.structure('over',{energy:1200,H:0},1000);},{}],
 ['core mismatch',null,{mismatch:true}],['incomplete commitment index',null,{incomplete:true}],
 ['same-tick legacy projection',f=>{f.memory.runtime.resourceControl={updatedAt:100,rooms:{}};},{}],
 ['stale legacy projection',f=>{f.memory.runtime.resourceControl={updatedAt:99,rooms:{}};},{}],
 ['throwing reader',null,{loadThrow:true}],['throwing observation',null,{obsThrow:true}],['throwing commitment',null,{commitThrow:true}],
 ['overbudget loading',null,{cost:{readerLoad:2.5}}],['overbudget observation',null,{cost:{observationBuild:2.5}}],
])test('A/B with diagnostics OFF is byte-identical: '+name,()=>compare(setup,opts));
test('normal output UTF-8 scan count decreases from two to one',()=>{const r=compare();assert.equal(r[0].scans,2);assert.equal(r[1].scans,1);assert.equal(r[1].stats.previousRun.emittedBytes,Buffer.byteLength(r[1].logs[0]));});
test('output-limited fallback sizes the distinct fallback string correctly',()=>{for(const v of ['old','new']){const f=H.fixture(),r=H.loadReader(v),p=r.exports.createTreasuryCompatPreview({...H.profile(),maxLogBytes:1024},f.ports,{cpuDiagnostics:v==='new'});assert.equal(p.run().status,'output_limited');assert.equal(r.scans(),2);assert.equal(p.stats().previousRun.emittedBytes,Buffer.byteLength(f.logs[0]));assert.ok(Buffer.byteLength(f.logs[0])<=1024);assert.equal(JSON.parse(f.logs[0]).cpuProfile,undefined);assert.equal(p.stats().retainedEndpoints,0);}});
test('UTF-8 sizing matches Buffer for ASCII CJK astral and unpaired surrogates',()=>{const r=H.loadReader();for(const x of ['ASCII','中文','😀','\ud800','\udfff','\ud800x','é','\0','&quot;','𐐀中文😀'])assert.equal(r.exports.compatUtf8Bytes(x),Buffer.byteLength(x));});
test('diagnostics ON preserve semantic results with known injected costs',()=>{const results=[];for(const v of ['old','new']){const f=H.fixture(),r=H.loadReader(v);const p=r.exports.createTreasuryCompatPreview(H.profile(),f.ports,{cpuDiagnostics:v==='new'});p.run();f.setTime(200);p.run();results.push(f.logs.map(H.semantic));}assert.deepEqual(results[0],results[1]);});
test('output limiting cannot leak recursive diagnostic history after 12 samples',()=>{const r=H.loadReader(),f=H.fixture(),p=r.exports.createTreasuryCompatPreview({...H.profile(),maxLogBytes:1024},f.ports,{cpuDiagnostics:true});for(let i=1;i<=12;i++){f.setTime(i*100);p.run();}assert.equal(f.logs.length,12);assert.ok(f.logs.every(x=>Buffer.byteLength(x)<=1024));assert.equal(p.stats().cpuProfile.sampleOrdinal,12);assert.equal(p.stats().cpuProfile.previousCpuProfile,undefined);});
test('actual runtime composition stays OFF and never invokes sampling ports',()=>{const read=H.loadReader().exports,config=H.compile(fs.readFileSync(path.join(H.ROOT,'baseline/src/runtime/treasuryCompatConfig.ts'),'utf8'),'config.ts').exports;let factory=0;const source=fs.readFileSync(path.join(H.ROOT,'implementation/src/runtime/treasuryCompatRuntime.ts'),'utf8');const ctx=H.compile(source,'runtime.ts',{require:id=>id==='./treasuryCompatConfig'?config:id==='./treasuryCompatRead'?read:{createCompatibilityReadCore:()=>{factory++;throw new Error('must remain lazy');}}});ctx.exports.runTreasuryCompatRead();assert.equal(factory,0);});
test('both builders still receive independent actual Room objects and original tables',()=>{const f=H.fixture(),r=H.loadReader();const original=f.ports.readers;f.ports.readers=()=>{const b=original(),bo=b.buildObservation,bc=b.buildCommitments;let obs;b.buildObservation=o=>{assert.equal(o.rooms[0],f.rooms.E3N59);obs=bo(o);return obs;};b.buildCommitments=o=>{assert.equal(o.tasks,f.memory.data.resourceControl.tasks);assert.equal(o.reservations,f.memory.runtime.resourceReservations);assert.equal(o.observation,obs);return bc(o);};return b;};r.exports.createTreasuryCompatPreview(H.profile(),f.ports,{cpuDiagnostics:true}).run();assert.equal(f.calls.commitmentBuild,1);});
