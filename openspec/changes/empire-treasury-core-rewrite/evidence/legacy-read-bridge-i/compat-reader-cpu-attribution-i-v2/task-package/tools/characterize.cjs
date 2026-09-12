'use strict';
const {performance}=require('node:perf_hooks'),C=require('./common.cjs'),H=require('../tests/harness.cjs');
function semantic(x){return H.semantic(x);}
/** Executes the REAL pinned generated builders in a VM, but with synthetic
 * Room/Memory inputs and a zero-cost CPU-port model. External wall-clock timing
 * is Node timing only; neither it nor the CPU-port model is Screeps CPU evidence.
 */
function characterize(generated){
 const scenarios=[['empty',0],['two-manual',2],['sixteen-manual',16],['bound',256],['over-bound',257],['invalid',1],['missing',0],['mutation-no-revision',2],['active-reservations',0],['expired-reservations',0]];
 const rows=[];
 for(const [name,n]of scenarios){
  const variants=[];
  for(const [variant,diagnostics]of [['old',false],['new',false],['new',true]]){
   const f=H.fixture(),game={time:100,shard:{name:"shard1"},cpu:{getUsed:()=>0,tickLimit:100,bucket:10000},rooms:f.rooms,creeps:{},powerCreeps:{},spawns:{},flags:{},structures:{},getObjectById:()=>null};
   const core=H.compile(generated,'treasuryCompatReadCore.generated.ts',{Game:game,Memory:f.memory,RESOURCES_ALL:['energy','H','O','X'],RESOURCE_ENERGY:'energy',STRUCTURE_STORAGE:'storage',STRUCTURE_TERMINAL:'terminal'});
   for(let i=0;i<n;i++)f.memory.data.resourceControl.tasks['t'+i]={id:'t'+i,status:'pending',resource:'H',fromRoomName:'E3N59',toRoomName:'E4N58',amount:10,remainingAmount:10,origin:'manual',createdAt:1,updatedAt:1,lastProgressAt:1};
   if(name==='active-reservations'||name==='expired-reservations')for(let j=0;j<256;j++)f.memory.runtime.resourceReservations['r'+j]={roomName:'E3N59',resource:'H',amount:7,expiresAt:name==='active-reservations'?2000:99,holderId:'synthetic-unresolved-holder'};
   if(name==='invalid')f.memory.data.resourceControl.tasks.t0.status='pendng';
   if(name==='missing')delete f.memory.runtime.resourceReservations;
   const before=JSON.stringify(f.memory);let loads=0,obsCalls=0,commitCalls=0;
   f.ports.readers=()=>{loads++;const b=core.exports.createCompatibilityReadCore();return {
    buildObservation:o=>{obsCalls++;return b.buildObservation(o);},buildCommitments:o=>{commitCalls++;return b.buildCommitments(o);}};};
   const r=H.loadReader(variant),p=r.exports.createTreasuryCompatPreview(H.profile(),f.ports,{cpuDiagnostics:diagnostics});
   const durations=[],results=[];
   for(let k=0;k<12;k++){
    game.time=(k+1)*100;f.setTime(game.time);
    if(name==='mutation-no-revision'&&k===1)f.memory.data.resourceControl.tasks.t0.remainingAmount=5;
    const a=performance.now();results.push(p.run().status);durations.push(performance.now()-a);
   }
   if(name!=='mutation-no-revision'&&JSON.stringify(f.memory)!==before)C.fail('MEMORY_MUTATED');
   if(results.some(x=>x==='fault_disabled'||x==='disabled_after_fault'))C.fail('REAL_CORE_FIXTURE_FAULT',{name,variant});
   const logs=f.logs.map(JSON.parse);if(logs.length!==12)C.fail('REAL_CORE_LOG_COUNT');
   if(name==='two-manual'&&logs[0].commitments.rows.find(x=>x.room==='E3N59'&&x.resource==='H').outgoing!==20)C.fail('REAL_CORE_COMMITMENT_ORACLE');
   if(name==='mutation-no-revision'&&logs[1].commitments.rows.find(x=>x.room==='E3N59'&&x.resource==='H').outgoing!==15)C.fail('REAL_CORE_STALE_CACHE');
   if(name==='invalid'&&logs[0].commitments.status!=='read_incomplete')C.fail('REAL_CORE_INCOMPLETE_ORACLE');
   if(name==='active-reservations'&&logs[0].commitments.rows.find(x=>x.room==='E3N59'&&x.resource==='H').productionReserved!==1792)C.fail('REAL_CORE_RESERVATION_ORACLE');
   if(name==='expired-reservations'&&logs[0].commitments.rows.find(x=>x.room==='E3N59'&&x.resource==='H').productionReserved!==0)C.fail('REAL_CORE_EXPIRY_ORACLE');
   if(name==='over-bound'&&commitCalls!==0)C.fail('REAL_CORE_BOUND_BYPASS');
   const sorted=[...durations].sort((a,b)=>a-b);
   variants.push({variant,diagnostics,results,logs,loads,obsCalls,commitCalls,utf8Scans:r.scans(),nodeWallMs:{first:durations[0],median:sorted[Math.floor(sorted.length/2)],max:sorted.at(-1)}});
  }
  if(JSON.stringify(variants[0].logs)!==JSON.stringify(variants[1].logs))C.fail('REAL_CORE_OFF_AB_DIFFERENCE',name);
  if(JSON.stringify(variants[0].logs.map(semantic))!==JSON.stringify(variants[2].logs.map(semantic)))C.fail('REAL_CORE_DIAGNOSTIC_SEMANTIC_DIFFERENCE',name);
  rows.push({name,input:'synthetic, not reconstructed live Memory',tasks:n,offByteEquivalent:true,diagnosticSemanticEquivalent:true,
   variants:variants.map(({logs,...x})=>({...x,logSha256:logs.map(r=>C.sha(Buffer.from(JSON.stringify(r)))),semanticSha256:logs.map(r=>C.sha(Buffer.from(JSON.stringify(semantic(r))))),firstStatus:logs[0].status,firstCommitments:logs[0].commitments.status}))});
 }
 return {status:'REAL_PINNED_CORE_OFFLINE_CHARACTERIZED',generatedBlob:C.blob(Buffer.from(generated)),scenarios:rows,
  timingScope:'Node wall clock only; zero CPU-port model ensures full-path semantic comparison; not engine CPU',engineCpuGapRepaired:false,
  liveFirstSample:{tick:73646500,cpuBeforeSerializationAndEmit:2.4981476000029943,budget:2,phaseAttribution:'unknown; new instrumentation has not run online'}};
}
module.exports={characterize};
