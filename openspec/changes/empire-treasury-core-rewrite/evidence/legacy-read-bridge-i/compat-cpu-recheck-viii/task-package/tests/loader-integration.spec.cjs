'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const H=require('./reader-fixture.cjs'),K=require('../runtime/policy.cjs'),W=require('../runtime/samples.cjs'),C=require('../runtime/common.cjs');
const root=path.resolve(__dirname,'..');
function runActual({old=false,instrument=false,enabled=true}={}){
 const file=old?'references/build-VII/test/treasury-compat/fixtures/core-before-build-optimization-vii.ts.txt':'references/treasuryCompatReadCore.generated.ts';
 const source=fs.readFileSync(path.join(root,file));assert.equal(C.blob(source),old?'fe94ebece8f5118b76701007ce3906adfbb4da08':'4f94acf1c06a60de9ca8ff2f0cdd2910cb6913be');
 let text=source.toString('utf8');const executions=[];
 if(instrument)text=text.replace(/^"([^"]+)": function\(exports, require\) \{/gm,(m,id)=>m+'\n__testFactory('+JSON.stringify(id)+');');
 const f=H.fixture({probeCost:0.001}),game={time:0,rooms:f.rooms,getObjectById:()=>null};
 const core=H.compile(text,'treasuryCompatReadCore.generated.ts',{Game:game,Memory:f.memory,RESOURCES_ALL:f.ports.resources(),__testFactory:id=>{executions.push(id);f.charge(0.01);}}).exports;
 let calls=0;f.ports.readers=()=>{calls++;return core.createCompatibilityReadCore();};
 const profile={...K.profileFor(1000),enabled};const preview=H.loadReader().exports.createTreasuryCompatPreview(profile,f.ports,{cpuDiagnostics:true});
 const factoryCounts=[];for(const tick of K.dueTicks({...profile,enabled:true})){game.time=tick;f.setTime(tick);const before=executions.length;preview.run();factoryCounts.push(executions.length-before);}
 return {f,profile,preview,core,calls,executions,factoryCounts,reports:f.logs.map(JSON.parse)};
}
test('VIII VII-core integration: optimized real core emits four reports accepted by unchanged diagnostic validator',()=>{
 const r=runActual();assert.equal(r.reports.length,4);r.reports.forEach((report,i)=>{assert.equal(W.diagnosticError(report,r.profile,i,r.reports[i-1]||null,r.f.logs[i-1]||null),null);assert.equal(W.sampleError(report,r.profile),null);});
});
test('VIII VII-core integration: current and Read V cores both execute 7 then 0 definitions without cached business results',()=>{
 const n=runActual({instrument:true}),o=runActual({old:true,instrument:true});assert.deepEqual(n.factoryCounts,[7,0,0,0]);assert.deepEqual(o.factoryCounts,[7,0,0,0]);assert.equal(n.calls,4);assert.equal(o.calls,4);
 assert.deepEqual(n.reports.map(x=>H.json(x.cpuProfile.calls)),Array.from({length:4},()=>({readerLoad:1,observationBuild:1,commitmentBuild:1})));
});
test('VIII VII-core integration: deterministic preview output remains byte-equal to Read V for the base fixture',()=>{
 const n=runActual(),o=runActual({old:true});assert.deepEqual(n.f.logs,o.f.logs);
});
test('VIII VII-core integration: current core retains original OFF admission behavior',()=>{const r=runActual({enabled:false,instrument:true});assert.equal(r.calls,0);assert.equal(r.executions.length,0);assert.equal(r.reports.length,0);assert.equal(r.f.calls.memory,0);});
test('VIII VII-core integration: emitted profiles preserve three successor tails and no invented fourth tail',()=>{const r=runActual();assert.equal(r.reports[0].previousCpuProfile,null);for(let i=1;i<4;i++){assert.equal(r.reports[i].previousCpuProfile.tick,r.reports[i-1].tick);assert.equal(r.reports[i].previousCpuProfile.boundary,'afterRetention');}assert.equal(r.reports.filter(x=>x.previousCpuProfile).length,3);});
