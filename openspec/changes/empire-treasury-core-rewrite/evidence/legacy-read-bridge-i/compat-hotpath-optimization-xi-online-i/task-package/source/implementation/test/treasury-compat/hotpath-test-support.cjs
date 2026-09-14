'use strict';
/** XI differential harness. Synthetic Room/Memory inputs and operation counters
 * are not Screeps CPU measurements. They prove exact behavior and reduced work. */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const S = require('./loader-test-support.cjs');
const B = require('./build-test-support.cjs');
const { H, ts, task, reservation } = S;
const beforeCore = () => fs.readFileSync(path.join(__dirname,'fixtures/core-before-hotpath-optimization-xi.ts.txt'),'utf8').replace(/\r\n/g,'\n');
const afterCore = () => fs.readFileSync(H.file('treasuryCompatReadCore.generated.ts'),'utf8').replace(/\r\n/g,'\n');
const beforeReader = () => fs.readFileSync(path.join(__dirname,'fixtures/reader-before-hotpath-optimization-xi.ts.txt'),'utf8').replace(/\r\n/g,'\n');
const afterReader = () => fs.readFileSync(H.file('treasuryCompatRead.ts'),'utf8').replace(/\r\n/g,'\n');
function api(text, counters) {
  const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}}).outputText;
  const ctx=vm.createContext({exports:{},require:k=>{if(k==='./treasuryCompatCpu')return H.load('treasuryCompatCpu.ts');throw new Error('unexpected reader import:'+k);},__count:k=>{if(counters)counters[k]=(counters[k]||0)+1;}});
  vm.runInContext(`{
    const values=Object.values; Object.values=function(o){__count('values');return values(o);};
    const map=Array.prototype.map, filter=Array.prototype.filter;
    Array.prototype.map=function(...a){__count('map');return Reflect.apply(map,this,a);};
    Array.prototype.filter=function(...a){__count('filter');return Reflect.apply(filter,this,a);};
  }`,ctx);
  vm.runInContext(js,ctx,{timeout:5000}); return ctx.exports;
}
function make(coreText, readerText, diagnostics=false, readerCounters) {
  const s=H.scene({rooms:['W1N1','W2N1']}); s.game.rooms.W2N1=H.makeRoom('W2N1');
  s.resources=['energy','H','O','U']; s.resourcePortCalls=0;
  s.api=api(readerText,readerCounters); s.factories=[];
  s.core=S.capsule(coreText,s,id=>s.factories.push(id));
  const baseResources=s.ports.resources; s.ports.resources=()=>{s.resourcePortCalls++;return baseResources();};
  s.ports.readers=()=>{s.calls.readers++;const c=s.core.createCompatibilityReadCore();return Object.freeze({
    buildObservation:o=>{s.calls.observation++;return c.buildObservation(o);},
    buildCommitments:o=>{s.calls.commitments++;return c.buildCommitments(o);},
  });};
  s.observer=s.api.createTreasuryCompatPreview(s.cfg,s.ports,{cpuDiagnostics:diagnostics}); return s;
}
function pair(name, diagnostics=false) {
  const a=make(beforeCore(),beforeReader(),diagnostics),b=make(afterCore(),afterReader(),diagnostics);
  S.scenarios[name](a);S.scenarios[name](b);const ga={writes:0},gb={writes:0};a.memory=H.guard(a.memory,ga);b.memory=H.guard(b.memory,gb);
  for(let i=1;i<=12;i++){a.game.time=b.game.time=i*100;a.cpuValue=b.cpuValue=.1;a.observer.run();b.observer.run();}
  return {name,byteEquivalent:JSON.stringify(a.lines)===JSON.stringify(b.lines),writes:[ga.writes,gb.writes],
    readers:[a.calls.readers,b.calls.readers],observations:[a.calls.observation,b.calls.observation],commitments:[a.calls.commitments,b.calls.commitments],reports:b.lines.length,a,b};
}
function coreBuild(text, setup=()=>{}) {
  const s=make(text,text===beforeCore()?beforeReader():afterReader(),false);setup(s);const r=s.core.createCompatibilityReadCore();
  const observation=r.buildObservation({scope:'market-fresh',epochSeq:1,rooms:Object.values(s.game.rooms)});
  const index=r.buildCommitments({tick:s.game.time,tasks:s.memory.data.resourceControl.tasks,reservations:s.memory.runtime.resourceReservations,observation});
  return {s,r,observation,index};
}
function snapshot(build){return B.snapshot(build);}
const emptyCounts=()=>({mapNew:0,mapGet:0,mapSet:0,mapHas:0,keys:0,values:0});
function measuredCore(text,s){
  const ctx=vm.createContext({exports:{},require:x=>{throw new Error('unlisted host import:'+x);},__count:k=>{if(s.measure)s.counts[k]++;}});
  for(const [n,get] of Object.entries({Game:()=>s.game,Memory:()=>s.memory,RESOURCES_ALL:()=>s.resources}))Object.defineProperty(ctx,n,{get});
  vm.runInContext(`{
    const Base=Map;Map=class extends Base{constructor(...a){super(...a);__count('mapNew')}get(k){__count('mapGet');return super.get(k)}set(k,v){__count('mapSet');return super.set(k,v)}has(k){__count('mapHas');return super.has(k)}};
    const keys=Object.keys,values=Object.values;Object.keys=function(o){__count('keys');return keys(o)};Object.values=function(o){__count('values');return values(o)};
  }`,ctx);
  const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}}).outputText;vm.runInContext(js,ctx,{timeout:5000});return ctx.exports;
}
function operationCounts(text,count=37,selfRoute=false,resourcesPerEndpoint=32){
  const s=make(text,text===beforeCore()?beforeReader():afterReader(),false);s.measure=false;s.counts=emptyCounts();s.core=measuredCore(text,s);
  for(let n=0;n<count;n++)s.memory.data.resourceControl.tasks['t'+n]=task({id:'t'+n,reason:'reason-a',...(selfRoute?{toRoomName:'W1N1'}:{})});
  for(const room of Object.values(s.game.rooms))for(const kind of ['storage','terminal'])for(let j=0;j<resourcesPerEndpoint;j++)room[kind].store['synthetic_'+j]=j+1;
  const r=s.core.createCompatibilityReadCore();s.counts=emptyCounts();s.measure=true;
  const observation=r.buildObservation({scope:'market-fresh',epochSeq:1,rooms:Object.values(s.game.rooms)});s.measure=false;const observationCounts={...s.counts};
  s.counts=emptyCounts();s.measure=true;const index=r.buildCommitments({tick:100,tasks:s.memory.data.resourceControl.tasks,reservations:{},observation});s.measure=false;
  return {observation:observationCounts,commitment:{...s.counts},semantics:snapshot({observation,index})};
}
function readerCounts(coreText,readerText){const counters={values:0,map:0,filter:0};const s=make(coreText,readerText,false,counters);s.cfg={...s.cfg,maxSampleCpu:10};s.observer=s.api.createTreasuryCompatPreview(s.cfg,s.ports,{cpuDiagnostics:false});s.cpuValue=.1;s.observer.run();return {counters,resourcePortCalls:s.resourcePortCalls,line:s.lines[0]};}
module.exports={S,H,B,task,reservation,beforeCore,afterCore,beforeReader,afterReader,make,pair,coreBuild,snapshot,operationCounts,readerCounts};
