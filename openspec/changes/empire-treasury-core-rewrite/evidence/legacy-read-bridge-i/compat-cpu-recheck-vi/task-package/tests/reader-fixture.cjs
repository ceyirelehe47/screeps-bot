'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const ROOT=path.resolve(__dirname,'..');
function typescript(){
 if(process.env.CPU_DIAG_TS_REPO)return createRequire(path.resolve(process.env.CPU_DIAG_TS_REPO,'package.json'))('typescript');
 if(process.env.CPU_DIAG_TS_MODULE)return require(process.env.CPU_DIAG_TS_MODULE);
 throw new Error('TYPESCRIPT_PATH_REQUIRED');
}
function compile(source,file,extras={}){
 const ts=typescript(),out=ts.transpileModule(source,{fileName:file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,strict:true}});
 const errors=(out.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);if(errors.length)throw new Error('TS_TRANSPILE_ERROR');
 const context=vm.createContext({exports:{},...extras});context.globalThis=context;context.global=context;
 vm.runInContext(out.outputText,context,{filename:file,timeout:5000});return context;
}
function loadReader(variant='new',extras={}){
 const prefix='references';
 const accounting=compile(fs.readFileSync(path.join(ROOT,'references/treasuryCompatCpu.ts'),'utf8'),'treasuryCompatCpu.ts').exports;
 const context=compile(fs.readFileSync(path.join(ROOT,prefix,'treasuryCompatRead.ts'),'utf8'),'treasuryCompatRead.ts',{
  require:id=>{if(id==='./treasuryCompatCpu')return accounting;throw new Error('UNEXPECTED_IMPORT:'+id);},...extras});
 let scans=0;const count=context.compatUtf8Bytes;context.compatUtf8Bytes=s=>{scans++;return count(s);};
 return {exports:context.exports,context,scans:()=>scans};
}
const profile=()=>({enabled:true,shardName:'shard1',rooms:['E3N59','E4N58'],resources:['energy','H'],startTick:100,endTick:1200,intervalTicks:100,minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384});
function fixture(opts={}){
 let time=100,used=0,cpuCalls=0;const calls={memory:0,room:0,readerLoad:0,observationBuild:0,commitmentBuild:0,emit:0};
 const cost={legacyInputs:0,directRead:0,readerLoad:0,observationBuild:0,coreCompare:0,commitmentBuild:0,commitmentProjection:0,emit:0,...opts.cost};
 const logs=[],health={complete:true,globalIncomplete:false,incompleteScopeCount:0,invalidRecords:0};
 const memory={cfg:{},data:{resourceControl:{tasks:{}}},runtime:{resourceReservations:{}}};
 const rooms={};
 function charge(n){used+=n;}
 function structure(id,amounts={energy:1000,H:50},capacity=300000){
  const store={...amounts};
  Object.defineProperties(store,{
   getUsedCapacity:{value:r=>{charge(cost.directRead);return r?(store[r]||0):Object.keys(store).reduce((n,k)=>n+store[k],0);}},
   getCapacity:{value:()=>capacity},getFreeCapacity:{value:()=>capacity-Object.keys(store).reduce((n,k)=>n+store[k],0)}});
  return {id,my:true,store,isActive:()=>true,cooldown:0};
 }
 for(const name of profile().rooms)rooms[name]={name,controller:{my:true},storage:structure(name+'storage',undefined,1000000),terminal:structure(name+'terminal')};
 const ports={tick:()=>time,shard:()=>opts.shard||'shard1',resources:()=>['energy','H','O','X'],
  cpu:()=>{cpuCalls++;used+=opts.probeCost||0;return opts.cpu?opts.cpu({used,cpuCalls,emitted:calls.emit}):{used,tickLimit:opts.tickLimit??100,bucket:opts.bucket??10000};},
  memory:()=>{calls.memory++;charge(cost.legacyInputs);if(opts.memoryThrow)throw new Error('memory');return memory;},
  room:n=>{calls.room++;return rooms[n];},
  readers:()=>{calls.readerLoad++;charge(cost.readerLoad);if(opts.loadThrow)throw new Error('loader');return {
   buildObservation:({rooms:actual})=>{calls.observationBuild++;charge(cost.observationBuild);if(opts.obsThrow)throw new Error('observation');
    return {epoch:{observedAtTick:time+(opts.stale?1:0)},location:(n,k)=>{charge(cost.coreCompare);const st=actual.find(r=>r.name===n)?.[k];
     return st?{exists:true,structureId:st.id,usedCapacity:st.store.getUsedCapacity()+(opts.mismatch?1:0),freeCapacity:st.store.getFreeCapacity(),amounts:{energy:st.store.energy||0,H:st.store.H||0}}:{exists:false,usedCapacity:0,freeCapacity:0,amounts:{}};}};},
   buildCommitments:()=>{calls.commitmentBuild++;charge(cost.commitmentBuild);if(opts.commitThrow)throw new Error('commitment');const value=Object.keys(memory.data.resourceControl.tasks).length;
    return {completeness:opts.incomplete?{...health,complete:false,invalidRecords:1}:health,metrics:{},outgoing:()=>{charge(cost.commitmentProjection);return opts.invalidNumber?-1:value;},incoming:()=>0,reservedProduction:()=>0,commitmentCompleteness:()=> 'complete'};}
  };},
  emit:line=>{calls.emit++;charge(cost.emit);if(opts.emitThrow)throw new Error('emit');logs.push(line);}};
 return {ports,memory,rooms,logs,calls,charge,used:()=>used,cpuCalls:()=>cpuCalls,setTime:t=>{time=t;used=0;},structure};
}
function json(x){return JSON.parse(JSON.stringify(x));}
function semantic(log){const r=typeof log==='string'?JSON.parse(log):json(log);delete r.cpuProfile;delete r.previousCpuProfile;
 if(r.previousRun){delete r.previousRun.emittedBytes;delete r.previousRun.cpuIncludingEmit;}delete r.cpuBeforeSerializationAndEmit;return r;}
module.exports={ROOT,typescript,compile,loadReader,profile,fixture,json,semantic};
