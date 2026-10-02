"use strict";
// 只推进既有许可 lab；所有条件都通过 Memory/真实环境读取，不注入执行结果。
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root='/srv/screeps-treasury-t1',run=root+'/r6-t2-20261002',uid='7dad41a4bfc9d96';
const [label,kind,arg]=process.argv.slice(2);assert.match(label||'',/^[a-z0-9-]{1,64}$/);
const allowed=['ticks','native','settled','conflict','armed','task-done'];assert.ok(allowed.includes(kind));
process.env.STORAGE_HOST='::1';process.env.STORAGE_PORT='21027';
const common=createRequire(root+'/server/package.json')('@screeps/common');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 await common.storage._connect();const {db,env}=common.storage;
 assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)),'1');
 assert.equal((await db.users.findOne({_id:uid}))?.username,'forster');
 const manifest=JSON.parse(fs.readFileSync(run+'/candidate/manifest.json','utf8'));
 assert.equal(sha((await db['users.code'].findOne({user:uid,activeWorld:true})).modules.main),manifest.mainSha256);
 const key=env.keys.MEMORY+uid,startTick=Number(await env.get(env.keys.GAMETIME));
 const startedAtUtc=new Date().toISOString();
 let observations=0,matched=false,last;
 await env.set(env.keys.MAIN_LOOP_PAUSED,'0');
 try{
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
   const m=JSON.parse(await env.get(key)),tick=Number(await env.get(env.keys.GAMETIME));
   observations++;last={tick,quota:m.runtime?.treasuryProductionT2Quota?.status,control:m.runtime?.treasuryT2FirstLiveControl?.status,
    mode:m.cfg?.treasuryTerminalTransferT2?.mode,active:Object.keys(m.runtime?.treasuryCore?.active||{}).length,arm:m.runtime?.__labT2ArmResult};
   if(kind==='ticks')matched=tick>=startTick+Number(arg);
   if(kind==='native')matched=m.runtime?.treasuryProductionT2Quota?.status==='dispatching';
   if(kind==='settled')matched=m.runtime?.treasuryProductionT2Quota?.status==='drained' && last.active===0;
   if(kind==='armed')matched=m.runtime?.treasuryT2FirstLiveControl?.status==='active' && m.runtime?.__labT2ArmResult?.ok===true;
   if(kind==='task-done')matched=m.data?.resourceControl?.tasks[arg]?.status==='done';
   if(kind==='conflict')matched=m.runtime?.treasuryProductionT2Quota===undefined && m.runtime?.treasuryT2FirstLiveControl?.status==='active' &&
    arg.split(',').every(id=>m.data?.resourceControl?.tasks[id]?.status==='done');
   if(matched){await env.set(env.keys.MAIN_LOOP_PAUSED,'1');await sleep(500);break;}
   await sleep(25);
  }
 }finally{await env.set(env.keys.MAIN_LOOP_PAUSED,'1')}
 const endedAtUtc=new Date().toISOString(),endTick=Number(await env.get(env.keys.GAMETIME));
 const result={schema:'screeps-t2-lab-driver/v1',isolatedWorldOnly:true,label,kind,arg,startTick,endTick,startedAtUtc,endedAtUtc,observations,matched,last,paused:true};
 fs.writeFileSync(`${run}/evidence/${label}-driver.json`,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify(result));assert.ok(matched,'condition not reached within 25 seconds');
})().then(()=>setTimeout(()=>process.exit(0),50),e=>{console.error(String(e.stack||e));setTimeout(()=>process.exit(1),50)});
