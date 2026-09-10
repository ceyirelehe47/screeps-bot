'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const {compileClosure,patchOldMain,patchOldMainTest,resolveDependency,PLAN,blob}=require('../kit/assemble.cjs');
const OBS=PLAN.roots[0],COM=PLAN.roots[1],TYPES='src/runtime/treasury/types.ts';
const sample=new Map([[OBS,'import { key } from "@/runtime/treasury/types"; export const buildTreasuryObservation = () => ({ key, kind: "observation" });'],
  [COM,'export function buildTreasuryCommitmentIndex() { return { kind: "commitments" }; }'],[TYPES,'export const key = "pinned-fixture";']]);
function read(m=sample){return p=>{if(!m.has(p))throw Error('missing file');return m.get(p);};}
function evalGenerated(text){const result=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}});const exports={};vm.runInNewContext(result.outputText,{exports},{timeout:5000});return exports;}
test('deterministic closure uses only reachable runtime dependencies, no type-only expansion',()=>{
 const a=compileClosure(read(),ts),b=compileClosure(read(),ts);assert.equal(a.generated,b.generated);assert.equal(a.sourceManifest.length,3);assert.equal(a.sourceManifest.find(x=>x.path===OBS).sourceBlob,blob(sample.get(OBS)));
});
test('generated read factories execute with static import map, expose only two builders',()=>{
 const core=evalGenerated(compileClosure(read(),ts).generated);const x=core.createCompatibilityReadCore();assert.deepEqual(Object.keys(x).sort(),['buildCommitments','buildObservation']);assert.equal(x.buildObservation().key,'pinned-fixture');assert.equal(x.buildCommitments().kind,'commitments');
});
test('type-only forbidden dependency does not enter runtime closure',()=>{
 const m=new Map(sample);m.set(COM,'import type { NoRuntime } from "@/runtime/runtimeServices"; export const buildTreasuryCommitmentIndex=()=>({ok:true});');assert.equal(compileClosure(read(m),ts).sourceManifest.length,3);
});
for(const dep of ['@/runtime/runtimeServices','@/runtime/treasury/facade','@/runtime/resourceReservation','@/runtime/homeDefense','node:fs','fs','../../../outside']){
 test('reject runtime closure escape '+dep,()=>{const m=new Map(sample);m.set(COM,`import { unsafe } from ${JSON.stringify(dep)}; export const buildTreasuryCommitmentIndex=()=>unsafe();`);assert.throws(()=>compileClosure(read(m),ts),/forbidden|escaped/);});
}
for(const expression of ['require(name)','import(name)','eval("x")','new Function("return 1")']){
 test('reject dynamic runtime loading '+expression,()=>{const m=new Map(sample);m.set(COM,`export const buildTreasuryCommitmentIndex=()=>${expression};`);assert.throws(()=>compileClosure(read(m),ts),/forbidden/);});
}
test('fresh factory graph has fresh module-local cache per sample',()=>{
 const m=new Map(sample);m.set(COM,'let n=0; export const buildTreasuryCommitmentIndex=()=>++n;');const core=evalGenerated(compileClosure(read(m),ts).generated);
 const a=core.createCompatibilityReadCore(),b=core.createCompatibilityReadCore();assert.equal(a.buildCommitments(),1);assert.equal(a.buildCommitments(),2);assert.equal(b.buildCommitments(),1);
});
const main='import { runEmpireInventoryShadowCheck } from "@/runtime/empireInventoryShadow";\nfunction gameLoop() {\n  cpuProfiler.measure("empireInventoryShadow", runEmpireInventoryShadowCheck);\n  cpuProfiler.flush();\n}\n';
test('old main patch adds only import and diagnostic call before original flush',()=>{
 const after=patchOldMain(main);assert.equal(after.replace('import { runTreasuryCompatRead } from "@/runtime/treasuryCompatRuntime";\n','').replace('  cpuProfiler.measure("treasuryCompatRead", runTreasuryCompatRead);\n',''),main);assert.throws(()=>patchOldMain(after));
});
test('main patch does not operate on current development Treasury main',()=>assert.throws(()=>patchOldMain(main+'getTreasuryService();'),/no-Treasury/));
test('test phase count updated by one without weakening old test contracts',()=>{
 const old='const canonicalTickPhases = [\n ["empireInventoryShadow", "runEmpireInventoryShadowCheck"],\n];\nexpect(order).toHaveLength(38);\n';
 const result=patchOldMainTest(old);assert.match(result,/toHaveLength\(39\)/);assert.match(result,/treasuryCompatRead/);assert.throws(()=>patchOldMainTest(old.replace('38','38); expect(order).toHaveLength(5')));
});
test('missing/duplicate main anchor is rejected, not fuzzy-applied',()=>{
 assert.throws(()=>patchOldMain(''));assert.throws(()=>patchOldMain(main+main));
});
test('source plan is exactly old-base branch plus eight new read files',()=>{
 assert.equal(PLAN.allowedRuntimeSources.length,8);assert.equal(PLAN.productionBase,'06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c');assert.equal(PLAN.sourceCommit,'01bd9831454950c4928df98dd8679692b55603e5');
});
test('actual old main and test anchors match independently fetched Git blobs',()=>{
 const dir=path.join(__dirname,'../references');
 const main=fs.readFileSync(path.join(dir,'online-base-main.ts'),'utf8');
 const testSource=fs.readFileSync(path.join(dir,'online-base-main.test.ts'),'utf8');
 assert.equal(blob(main),PLAN.productionMainBlob);assert.equal(blob(testSource),PLAN.productionMainTestBlob);
 assert.match(patchOldMain(main),/treasuryCompatRead/);assert.match(patchOldMainTest(testSource),/toHaveLength\(39\)/);
});
function runMain(text, preview, failingPhase) {
 const code=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}}).outputText;
 const ast=ts.createSourceFile('main.ts',text,ts.ScriptTarget.Latest,true);const imports={};const phases=[];let flushed=false;
 for(const n of ast.statements) if(ts.isImportDeclaration(n) && n.importClause && n.importClause.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
  const values={};for(const element of n.importClause.namedBindings.elements){const key=element.name.text;
   values[key]=key==='errorMapper'?fn=>fn:key==='createTickCpuProfiler'?()=>({measure:(name,fn)=>{phases.push(name);if(name===failingPhase)throw Error('old failure');return fn();},flush:()=>{flushed=true;}}):
     key==='getTickContextService'?()=>({getAllSpawns:()=>[],getAllCreeps:()=>[]}):key==='runTreasuryCompatRead'?preview:()=>{};
  }imports[n.moduleSpecifier.text]=values;
 }
 const exports={};vm.runInNewContext(code,{exports,require:k=>imports[k]},{timeout:5000});
 let thrown=false;try{exports.loop();}catch{thrown=true;}return{phases,flushed,thrown};
}
test('actual old main keeps every business phase and flush; diagnostic failure contained by its own wrapper',()=>{
 const before=fs.readFileSync(path.join(__dirname,'../references/online-base-main.ts'),'utf8');
 const a=runMain(before,()=>{}),b=runMain(patchOldMain(before),()=>{});
 assert.equal(a.phases.length,38);assert.equal(b.phases.length,39);assert.deepEqual(b.phases.filter(p=>p!=='treasuryCompatRead'),a.phases);assert.equal(b.flushed,true);
 const scene=require('./helpers.cjs').scene(); scene.ports.readers=()=>{throw Error('new read failure');};
 const contained=runMain(patchOldMain(before),()=>scene.observer.run()); assert.equal(contained.flushed,true); assert.equal(contained.thrown,false); assert.equal(scene.report().status,'fault_disabled');
 const fail=runMain(patchOldMain(before),()=>{},'resourceControl');assert.equal(fail.thrown,true);assert.equal(fail.flushed,false);assert.ok(!fail.phases.includes('treasuryCompatRead'));
});
