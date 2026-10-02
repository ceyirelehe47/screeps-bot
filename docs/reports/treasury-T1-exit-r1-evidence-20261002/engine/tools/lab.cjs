"use strict";
// 仅限已备份的回环隔离世界；不含正式服 HTTP 或凭据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const root='/srv/screeps-treasury-t1', run=root+'/r5-exit-20261002', uid='7dad41a4bfc9d96';
const [op,label,arg] = process.argv.slice(2);
assert.match(label || '', /^[a-z0-9-]{1,50}$/);
process.env.STORAGE_HOST='::1'; process.env.STORAGE_PORT='21027';
const common=createRequire(root+'/server/package.json')('@screeps/common');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const record=(suffix,x)=>fs.writeFileSync(`${run}/evidence/${label}-${suffix}.json`,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
(async()=>{
 await common.storage._connect();const {db,env}=common.storage;
 assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)),'1');
 const user=await db.users.findOne({_id:uid});
 assert.ok(['lab_treasury_t1','forster'].includes(user.username));
 const code=await db['users.code'].findOne({user:uid,activeWorld:true});
 const manifest=JSON.parse(fs.readFileSync(run+'/candidate/manifest.json','utf8'));
 const tick=Number(await env.get(env.keys.GAMETIME));const key=env.keys.MEMORY+uid;
 if(op==='upload'){
  const source=fs.readFileSync(run+'/candidate/main.js','utf8');assert.equal(sha(source),manifest.mainSha256);
  assert.ok([manifest.expectedLiveSha256,manifest.mainSha256].includes(sha(code.modules.main)));
  await db['users.code'].update({_id:code._id},{$set:{modules:{main:source},timestamp:Date.now()}});
  await env.del(`scrScriptCachedData:${uid}`);await db.users.update({_id:uid},{$set:{active:10000,username:'forster'}});
  const after=await db['users.code'].findOne({_id:code._id});assert.equal(sha(after.modules.main),manifest.mainSha256);
  record('upload',{isolatedWorldOnly:true,tick,userId:uid,sourceCommit:manifest.sourceCommit,oldSha256:sha(code.modules.main),sha256:sha(after.modules.main),bytes:Buffer.byteLength(source)});
 }else{
  assert.equal(sha(code.modules.main),manifest.mainSha256);
  const raw=await env.get(key);const m=JSON.parse(raw);
  if(op==='capture'){
   const objects=await db['rooms.objects'].find({room:{$in:['E3N59','E4N58','W9N8','W8N8','W1N1']}});
   const transactions=await db.transactions.find({$or:[{sender:uid},{recipient:uid}]});
   record('snapshot',{schema:'screeps-t1-exit-r1-engine-snapshot/v1',capturedAtUtc:new Date().toISOString(),label,tick,paused:true,
    user:{_id:uid,username:user.username,cpu:user.cpu,cpuAvailable:user.cpuAvailable},code:{sha256:sha(code.modules.main),bytes:Buffer.byteLength(code.modules.main)},
    rawMemory:raw,memoryUtf8Bytes:Buffer.byteLength(raw),objects,transactions});
   console.log(JSON.stringify({label,tick,control:m.runtime?.treasuryT1FirstLiveControl?.status,closeReason:m.runtime?.treasuryT1FirstLiveControl?.closeReason,
    mode:m.cfg?.treasuryTerminalTransferSlice0?.mode,quota:m.runtime?.treasuryProductionT1Quota?.status,active:Object.keys(m.runtime?.treasuryCore?.active||{}).length,
    tasks:Object.values(m.data?.resourceControl?.tasks||{}).map(t=>({id:t.id,status:t.status,remaining:t.remainingAmount,error:t.lastError,lease:t.treasurySlice?.phase})),transactions:transactions.length}));return;
  }
  if(op==='setup'){
   assert.equal(Object.keys(m.runtime?.treasuryCore?.active||{}).length,0);
   assert.ok(m.runtime?.treasuryProductionT1Quota===undefined || m.runtime.treasuryProductionT1Quota.status==='drained');
   m.cfg.treasuryTerminalTransferSlice0={mode:'off'};
   m.cfg.resourceControl={enabled:arg!=='a',sampleInterval:1,taskMaxPerRun:5,market:{enabled:false},capacityBalancing:{enabled:false}};
   m.runtime ||= {};for(const k of ['treasuryCore','treasuryProductionT1Quota','treasuryT1FirstLiveControl','treasuryT1FirstLiveControlMirror'])delete m.runtime[k];
   m.data.resourceControl.tasks={};delete m.runtime.__labArmResult;
   const taskId='lab-exit-'+arg+'-H';m.data.resourceControl.tasks[taskId]={id:taskId,resource:'H',fromRoomName:'E3N59',toRoomName:'E4N58',amount:100,remainingAmount:100,status:'pending',origin:'manual',createdAt:tick,updatedAt:tick,lastProgressAt:tick};
   for(const room of ['E3N59','E4N58','W9N8']){
    const terminal=await db['rooms.objects'].findOne({room,type:'terminal',user:uid});assert.ok(terminal);
    await db['rooms.objects'].update({_id:terminal._id},{$set:{store:{H:room==='E4N58'?1000:500,energy:room==='E4N58'?2000:10000},cooldownTime:tick}});
   }
   // 只重置合成世界的一次测试实例；不在正式服清额度或内核。
   record('setup',{isolatedWorldOnly:true,tick,arg,taskId,beforeMemorySha256:sha(raw),beforeRawMemory:raw,afterRawMemory:JSON.stringify(m)});
  }else if(op==='queue'){
   const expression=arg;assert.ok(expression.length<1000);
   await db['users.console'].insert({user:uid,expression,hidden:true});
   record('queue',{isolatedWorldOnly:true,tick,expression});console.log(JSON.stringify({label,tick,queued:true}));return;
  }else if(op==='ordinary'){
   const [destination,sender='W9N8']=arg.split(',');assert.ok(['E3N59','E4N58','W8N8'].includes(destination));assert.ok(['W9N8','W8N8'].includes(sender));
   const id='lab-exit-'+label+'-ordinary';m.data.resourceControl.tasks[id]={id,resource:'H',fromRoomName:sender,toRoomName:destination,amount:100,remainingAmount:100,status:'pending',origin:'manual',createdAt:Math.max(0,tick-10),updatedAt:tick,lastProgressAt:Math.max(0,tick-10)};
   record('ordinary',{isolatedWorldOnly:true,tick,id,destination});
  }else if(op==='carrier'){
   const creep=await db['rooms.objects'].findOne({user:uid,type:'creep',name:'lab-r2-carrier'});assert.ok(creep);
   const target=await db['rooms.objects'].findOne({user:uid,type:'terminal',room:'E4N58'});
   await db['rooms.objects'].update({_id:creep._id},{$set:{room:'E4N58',x:target.x+1,y:target.y-1,store:{energy:50},ageTime:tick+1500}});
   m.creeps['lab-r2-carrier']={role:'carrier',ready:true,working:true};
   record('carrier',{isolatedWorldOnly:true,tick,kind:'synthetic-already-carried-50-energy',before:creep,after:await db['rooms.objects'].findOne({_id:creep._id}),targetTerminalId:target._id});
  }else if(op==='fault'||op==='restore'){
   const target=await db['rooms.objects'].findOne({room:'E4N58',type:'terminal',user:uid});
   const amount=op==='fault'?1:-1;const old=target.store.H;
   await db['rooms.objects'].update({_id:target._id},{$set:{store:{...target.store,H:old+amount}}});
   const readback=await db['rooms.objects'].findOne({_id:target._id});assert.equal(readback.store.H,old+amount);
   record(op,{isolatedWorldOnly:true,tick,readbackH:readback.store.H,kind:'target-H-contradiction',terminalId:target._id,beforeH:old,afterH:old+amount,
     rawMemory:raw,transactionCount:(await db.transactions.find({$or:[{sender:uid},{recipient:uid}]})).length});
   console.log(JSON.stringify({label,tick,op,beforeH:old,afterH:old+amount}));return;
  }else throw Error('unsupported operation');
  const next=JSON.stringify(m);await env.set(key,next);assert.equal(await env.get(key),next);
 }
 console.log(JSON.stringify({label,tick,op,isolatedWorldOnly:true}));
})().then(()=>process.exit(0),e=>{console.error(String(e.stack||e));process.exit(1)});
