'use strict';
/** Offline only: first/repeated builds of synthetic task shapes. Never contacts Screeps,
 * never warms production, never substitutes Node ms for engine CPU, and never writes Memory. */
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),C=require('../runtime/common.cjs');
function profileLocal(repo){
 const req=createRequire(path.join(repo,'package.json')),compiler=req('typescript').version;
 const S=req('./test/treasury-compat/loader-test-support.cjs'),B=req('./test/treasury-compat/build-test-support.cjs');
 const old=fs.readFileSync(path.join(repo,'test/treasury-compat/fixtures/core-before-task-hotpath-xiv.ts.txt'),'utf8');
 const current=fs.readFileSync(path.join(repo,'src/runtime/treasuryCompatReadCore.generated.ts'),'utf8');
 const workloads=[{name:'empty',count:0},{name:'six-five-pending',count:6},{name:'six-mixed-invalid',count:6,invalid:true},{name:'bound256',count:256}];
 const cases=[];
 for(const w of workloads){const versions=[];let reference;
  for(const [name,source]of [['XIII',old],['XIV',current]]){
   const s=S.make(source,false);for(let i=0;i<w.count;i++)s.memory.data.resourceControl.tasks[i]=S.task({id:'local-'+i,status:i===0?'done':'pending',origin:i%2?'automatic':'manual',...(w.invalid&&i===2?{remainingAmount:-1}:{})});
   if(w.count===256)for(let i=0;i<32;i++)s.memory.runtime.resourceReservations[i]=S.reservation({holderId:'local-holder-'+i});
   const writes={writes:0};s.memory=S.H.guard(s.memory,writes);const observationMs=[],commitmentMs=[],snapshots=[];
   for(let invocation=0;invocation<8;invocation++){
    const reader=s.core.createCompatibilityReadCore(),a=process.hrtime.bigint();
    const observation=reader.buildObservation({scope:'market-fresh',epochSeq:1,rooms:Object.values(s.game.rooms)}),b=process.hrtime.bigint();
    const index=reader.buildCommitments({tick:s.game.time,tasks:s.memory.data.resourceControl.tasks,reservations:s.memory.runtime.resourceReservations,observation}),end=process.hrtime.bigint();
    observationMs.push(Number(b-a)/1e6);commitmentMs.push(Number(end-b)/1e6);snapshots.push(B.snapshot({observation,index}));
   }
   if(writes.writes!==0)C.fail('LOCAL_REPLAY_MEMORY_WRITE');
   if(reference&&!C.same(reference,snapshots))C.fail('LOCAL_REPLAY_SEMANTIC_MISMATCH');reference=snapshots;
   versions.push({name,sourceSha256:C.sha(source),firstActualLocalCallMs:commitmentMs[0],followingLocalCallMs:commitmentMs.slice(1),observationMs,memoryWrites:writes.writes});
  }
  cases.push({...w,iterationsPerVersion:8,fullApiEquivalent:true,versions});
 }
 return {status:'TASK_XIV_RETRY_LOCAL_REPLAY_VERIFIED',compiler,liveMemoryUsed:false,engineCpuMeasured:false,engineSpikeReproduced:null,exactOnlineTaskRecordsAvailable:false,
  interpretation:'Local VM, synthetic shapes and wall-clock milliseconds only. First local actual call is not an engine cold-start measurement. No speedup/GC/JIT conclusion.',cases};
}
module.exports={profileLocal};if(require.main===module)C.cli(async()=>{const o=C.options(['compat','out']);C.requireArgs(o,['compat','out']);C.verifyPackage();const result=profileLocal(path.resolve(o.compat));C.durable(o.out,result);console.log(JSON.stringify({status:result.status,cases:result.cases.length,compiler:result.compiler,engineCpuMeasured:false}));});
