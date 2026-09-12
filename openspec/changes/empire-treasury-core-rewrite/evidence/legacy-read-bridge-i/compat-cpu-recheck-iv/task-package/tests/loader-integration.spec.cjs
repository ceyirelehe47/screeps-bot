'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const H=require('./reader-fixture.cjs'),K=require('../runtime/policy.cjs'),W=require('../runtime/samples.cjs'),C=require('../runtime/common.cjs');
const root=path.resolve(__dirname,'..');
function runActual({old=false,instrument=false,enabled=true}={}){
 const file=old?'references/loader-III/test/treasury-compat/fixtures/core-before-loader-optimization.ts.txt':'references/treasuryCompatReadCore.generated.ts';
 const source=fs.readFileSync(path.join(root,file));assert.equal(C.blob(source),old?'c44d8a306f2b11986c6556e098be7d2e10315fa6':'7c20e7544bdc45bee11b1ee059ac5df2a12f2bf3');
 let text=source.toString('utf8');const executions=[];
 if(instrument)text=text.replace(/^"([^"]+)": function\(exports, require\) \{/gm,(m,id)=>m+'\n__testFactory('+JSON.stringify(id)+');');
 const f=H.fixture({probeCost:0.001}),game={time:0,rooms:f.rooms,getObjectById:()=>null};
 const core=H.compile(text,'treasuryCompatReadCore.generated.ts',{Game:game,Memory:f.memory,RESOURCES_ALL:f.ports.resources(),__testFactory:id=>{executions.push(id);f.charge(0.01);}}).exports;
 let calls=0;f.ports.readers=()=>{calls++;return core.createCompatibilityReadCore();};
 const profile={...K.profileFor(1000),enabled};
 const preview=H.loadReader().exports.createTreasuryCompatPreview(profile,f.ports,{cpuDiagnostics:true});
 const factoryCounts=[];for(const tick of K.dueTicks({...profile,enabled:true})){game.time=tick;f.setTime(tick);const before=executions.length;preview.run();factoryCounts.push(executions.length-before);}
 return {f,profile,preview,core,calls,executions,factoryCounts,reports:f.logs.map(JSON.parse)};
}
test('IV uninstrumented optimized real core emits four reports accepted by unchanged diagnostic validator',()=>{
 const r=runActual();assert.equal(r.reports.length,4);
 r.reports.forEach((report,i)=>{assert.equal(W.diagnosticError(report,r.profile,i,r.reports[i-1]||null,r.f.logs[i-1]||null),null);assert.equal(W.sampleError(report,r.profile),null);});
});
test('IV real core four-point fixture executes 8 then 2 factories without cached observations',()=>{
 const r=runActual({instrument:true});assert.deepEqual(r.factoryCounts,[8,2,2,2]);assert.equal(r.calls,4);
 assert.deepEqual(r.reports.map(x=>H.json(x.cpuProfile.calls)),Array.from({length:4},()=>({readerLoad:1,observationBuild:1,commitmentBuild:1})));
});
test('IV previous real core fixture executes 32 factories over four calls rather than fourteen',()=>{const r=runActual({old:true,instrument:true});assert.deepEqual(r.factoryCounts,[8,8,8,8]);assert.equal(r.executions.length,32);});
test('IV real reader plus optimized definitions retains original OFF admission behavior',()=>{const r=runActual({enabled:false,instrument:true});assert.equal(r.calls,0);assert.equal(r.executions.length,0);assert.equal(r.reports.length,0);assert.equal(r.f.calls.memory,0);});
test('IV optimized emitted profiles preserve three successor tails and no fourth tail',()=>{const r=runActual();assert.equal(r.reports[0].previousCpuProfile,null);for(let i=1;i<4;i++){assert.equal(r.reports[i].previousCpuProfile.tick,r.reports[i-1].tick);assert.equal(r.reports[i].previousCpuProfile.boundary,'afterRetention');}assert.equal(r.reports.filter(x=>x.previousCpuProfile).length,3);});
