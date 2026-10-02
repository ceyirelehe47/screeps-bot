"use strict";
// 本工具只连接已许可回环隔离世界；无正式服 HTTP、token 或凭据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const root='/srv/screeps-treasury-t1', run=root+'/r6-t2-20261002', uid='7dad41a4bfc9d96';
const [op,label,arg] = process.argv.slice(2);
assert.match(label || '', /^[a-z0-9-]{1,64}$/);
process.env.STORAGE_HOST='::1'; process.env.STORAGE_PORT='21027';
const common=createRequire(root+'/server/package.json')('@screeps/common');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const record=(suffix,x)=>fs.writeFileSync(`${run}/evidence/${label}-${suffix}.json`,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});
const summary=m=>({control:m.runtime?.treasuryT2FirstLiveControl?.status,closeReason:m.runtime?.treasuryT2FirstLiveControl?.closeReason,
 mode:m.cfg?.treasuryTerminalTransferT2?.mode,quota:m.runtime?.treasuryProductionT2Quota?.status,active:Object.keys(m.runtime?.treasuryCore?.active||{}).length,
 tasks:Object.values(m.data?.resourceControl?.tasks||{}).map(t=>({id:t.id,status:t.status,remaining:t.remainingAmount,error:t.lastError,lease:t.treasurySlice?.phase}))});
(async()=>{
 await common.storage._connect(); const {db,env}=common.storage;
 assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)),'1');
 const user=await db.users.findOne({_id:uid}); assert.equal(user?.username,'forster');
 const tick=Number(await env.get(env.keys.GAMETIME)), key=env.keys.MEMORY+uid;
 const code=await db['users.code'].findOne({user:uid,activeWorld:true}); assert.ok(code);
 const raw=await env.get(key), m=JSON.parse(raw);
 if(op==='environment'){
  const packages=['screeps','@screeps/engine','@screeps/common'].map(p=>({name:p,version:createRequire(root+'/server/package.json')(p+'/package.json').version}));
  const objects=await db['rooms.objects'].find({user:uid,type:{$in:['controller','terminal','storage']}});
  record('environment',{schema:'screeps-t2-lab-environment/v1',capturedAtUtc:new Date().toISOString(),isolatedWorldOnly:true,root,run,userId:uid,username:user.username,
   node:process.version,packages,tick,paused:true,code:{sha256:sha(code.modules.main),bytes:Buffer.byteLength(code.modules.main)},
   previousT1:{control:m.runtime?.treasuryT1FirstLiveControl,quota:m.runtime?.treasuryProductionT1Quota,activeCount:Object.keys(m.runtime?.treasuryCore?.active||{}).length},objects});
  console.log(JSON.stringify({op,label,tick,packages,paused:true,codeSha256:sha(code.modules.main)})); return;
 }
 if(op==='add-room'){
  const room='E1N57';assert.ok((await db.rooms.findOne({_id:room})) == null);
  const previous=await db.rooms.findOne({_id:'E4N58'});assert.ok(previous);
  await db.rooms.insert({_id:room,status:'normal',sourceKeepers:false});
  const terrain=await db['rooms.terrain'].findOne({room:'E4N58'});assert.ok(terrain);
  await db['rooms.terrain'].insert({room,terrain:terrain.terrain});
  const clone=(source,extra)=>{const {_id,$loki,meta,...copy}=source;return {...copy,room,user:uid,...extra}};
  const controller=await db['rooms.objects'].insert(clone(await db['rooms.objects'].findOne({room:'E4N58',type:'controller'}),{level:8,progress:0,downgradeTime:tick+200000,safeMode:null}));
  const terminal=await db['rooms.objects'].insert(clone(await db['rooms.objects'].findOne({room:'E4N58',type:'terminal'}),{x:25,y:25,store:{UH:0,energy:50000},cooldown:0,cooldownTime:tick}));
  const storage=await db['rooms.objects'].insert(clone(await db['rooms.objects'].findOne({room:'E4N58',type:'storage'}),{x:26,y:25,store:{energy:100000}}));
  const accessible=JSON.parse(await env.get(env.keys.ACCESSIBLE_ROOMS));accessible.push(room);await env.set(env.keys.ACCESSIBLE_ROOMS,JSON.stringify(accessible));
  await env.del(env.keys.TERRAIN_DATA);
  record('room',{schema:'screeps-t2-lab-room/v1',isolatedWorldOnly:true,tick,room,ownerUserId:uid,controllerId:controller._id,terminalId:terminal._id,storageId:storage._id,terrainSource:'E4N58'});
  console.log(JSON.stringify({op,label,tick,room,terminalId:terminal._id}));return;
 }
 if(op==='add-labs'){
  const room='E1N57';assert.equal((await db['rooms.objects'].find({room,type:'lab'})).length,0);
  const labs=[];
  for(const [x,y] of [[25,27],[27,27],[26,28]]){
   labs.push(await db['rooms.objects'].insert({type:'lab',room,user:uid,x,y,store:{energy:2000},storeCapacity:5000,
    storeCapacityResource:{energy:2000},hits:500,hitsMax:500,cooldownTime:tick,notifyWhenAttacked:false}));
  }
  record('labs',{isolatedWorldOnly:true,tick,room,labs});
  console.log(JSON.stringify({op,label,tick,labIds:labs.map(x=>x._id)}));return;
 }
 const manifest=JSON.parse(fs.readFileSync(run+'/candidate/manifest.json','utf8'));
 if(op==='upload'){
  const source=fs.readFileSync(run+'/candidate/main.js','utf8');assert.equal(sha(source),manifest.mainSha256);
  assert.ok([manifest.expectedLabSha256,manifest.mainSha256].includes(sha(code.modules.main)));
  await db['users.code'].update({_id:code._id},{$set:{modules:{main:source},timestamp:Date.now()}});
  await env.del(`scrScriptCachedData:${uid}`);await db.users.update({_id:uid},{$set:{active:10000}});
  const after=await db['users.code'].findOne({_id:code._id});assert.equal(sha(after.modules.main),manifest.mainSha256);
  record('upload',{isolatedWorldOnly:true,tick,userId:uid,sourceCommit:manifest.sourceCommit,oldSha256:sha(code.modules.main),sha256:sha(after.modules.main),bytes:Buffer.byteLength(source)});
  console.log(JSON.stringify({op,label,tick,sha256:sha(after.modules.main)}));return;
 }
 assert.equal(sha(code.modules.main),manifest.mainSha256);
 if(op==='capture'){
  const objects=await db['rooms.objects'].find({room:{$in:['E3N59','E4N58','E1N57','W9N8','W8N8','W1N1']}});
  const transactions=await db.transactions.find({$or:[{sender:uid},{recipient:uid}]});
  record('snapshot',{schema:'screeps-t2-first-production-engine-snapshot/v1',capturedAtUtc:new Date().toISOString(),label,tick,paused:true,
   user:{_id:uid,username:user.username,cpu:user.cpu,cpuAvailable:user.cpuAvailable},code:{sha256:sha(code.modules.main),bytes:Buffer.byteLength(code.modules.main)},
   rawMemory:raw,memoryUtf8Bytes:Buffer.byteLength(raw),objects,transactions});
  console.log(JSON.stringify({label,tick,...summary(m),transactions:transactions.length}));return;
 }
 if(op==='setup'){
  const spec=JSON.parse(arg);assert.match(spec.case,/^[a-z0-9-]+$/);assert.ok([100,1715].includes(spec.amount));
  assert.equal(Object.keys(m.runtime?.treasuryCore?.active||{}).length,0);
  assert.equal(m.runtime?.treasuryProductionT2Quota,undefined);
  assert.equal(m.runtime?.treasuryT2FirstLiveControl,undefined);
  assert.equal(m.runtime?.treasuryT2FirstLiveControlMirror,undefined);
  assert.ok(!(m.runtime?.treasuryCore?.ring||[]).some(x=>x.workKey?.startsWith('biz:treasury-production-T2-')));
  // 每个用例由停态 pre-T2 DB 副本启动；绝不在同一世界清已消费T2额度再开。
  // 旧 H control/quota/kernel closed facts 原样保留。
  m.cfg.treasuryTerminalTransferSlice0={mode:'off'};m.cfg.treasuryTerminalTransferT2={mode:'off'};
  assert.ok([2,5].includes(spec.taskMaxPerRun||5));
  m.cfg.resourceControl={enabled:spec.enabled!==false,sampleInterval:1,taskMaxPerRun:spec.taskMaxPerRun||5,market:{enabled:false},capacityBalancing:{enabled:false}};
  m.runtime ||= {};delete m.runtime.__labT2ArmResult;
  m.data.resourceControl.tasks={};const taskId='lab-t2-'+spec.case+'-UH';
  m.data.resourceControl.tasks[taskId]={id:taskId,resource:'UH',fromRoomName:'E4N58',toRoomName:'E1N57',amount:spec.amount,remainingAmount:spec.amount,status:'pending',origin:'automatic',reason:'synthesis:E1N57:UH2O',createdAt:tick,updatedAt:tick,lastProgressAt:tick};
  const labs=(await db['rooms.objects'].find({room:'E1N57',type:'lab',user:uid})).sort((a,b)=>a.x-b.x||a.y-b.y);assert.equal(labs.length,3);
  m.cfg.synthesisControl={enabled:true,sampleInterval:5,defaultBatchSize:spec.amount,rooms:{E1N57:{enabled:true,batchSize:spec.amount,
   donorRoomNames:['E4N58'],reagentLabIds:[labs[0]._id,labs[2]._id],reactions:[{product:'UH2O',targetAmount:spec.amount,batchSize:spec.amount,donorRoomNames:['E4N58']}]}}};
  m.runtime.synthesisControl={updatedAt:tick,generatedTaskCount:0,failedTaskCount:0,successfulRunCount:0,lastActions:[],bindings:{},rooms:{E1N57:{
   stage:'loading',activeProduct:'UH2O',reagentA:'UH',reagentB:'OH',targetAmount:spec.amount,batchSize:spec.amount,
   reagentLabIds:[labs[0]._id,labs[2]._id],productLabIds:[labs[1]._id],successfulRuns:0,pendingTasks:1,missing:{UH:spec.amount},lastTransitionAt:tick,loadingSinceTick:tick}}};
  for(const lab of labs)await db['rooms.objects'].update({_id:lab._id},{$set:{store:lab._id===labs[2]._id?{energy:2000,OH:spec.amount}:{energy:2000}}});
  const targetStorage=await db['rooms.objects'].findOne({room:'E1N57',type:'storage',user:uid});
  await db['rooms.objects'].update({_id:targetStorage._id},{$set:{store:{energy:100000}}});
  for(const room of ['E3N59','E4N58','E1N57','W9N8','W8N8']){
   const terminal=await db['rooms.objects'].findOne({room,type:'terminal',user:uid});assert.ok(terminal);
   const ordinaryHStock=spec.case==='c2'?10000:1000;
   await db['rooms.objects'].update({_id:terminal._id},{$set:{store:{UH:room==='E1N57'?0:5000,H:ordinaryHStock,energy:100000},cooldownTime:tick}});
  }
  for(const name of ['lab-r2-carrier','lab-t2-target-carrier']){
   const creep=await db['rooms.objects'].findOne({type:'creep',name,user:uid});
   if(creep)await db['rooms.objects'].update({_id:creep._id},{$set:{store:{},ageTime:tick+1500}});
  }
  record('setup',{isolatedWorldOnly:true,tick,spec,taskId,beforeMemorySha256:sha(raw),beforeRawMemory:raw,afterRawMemory:JSON.stringify(m)});
 }else if(op==='queue'){
  assert.ok(arg.length<3000);await db['users.console'].insert({user:uid,expression:arg,hidden:true});
  record('queue',{isolatedWorldOnly:true,tick,expression:arg});console.log(JSON.stringify({op,label,tick,queued:true}));return;
 }else if(op==='ordinary'){
  const [destination,sender='W9N8',resource='H']=arg.split(',');
  assert.ok(['E3N59','E4N58','E1N57','W8N8'].includes(destination));assert.ok(['E3N59','W9N8','W8N8'].includes(sender));assert.ok(['H','UH'].includes(resource));
  const id='lab-t2-'+label+'-ordinary';m.data.resourceControl.tasks[id]={id,resource,fromRoomName:sender,toRoomName:destination,amount:100,remainingAmount:100,status:'pending',origin:'manual',createdAt:Math.max(0,tick-20),updatedAt:tick,lastProgressAt:Math.max(0,tick-20)};
  record('ordinary',{isolatedWorldOnly:true,tick,id,destination,sender,resource});
 }else if(op==='carrier'){
  const [room='E1N57',name='lab-r2-carrier',resource='H']=(arg||'E1N57').split(',');assert.ok(['E1N57','E4N58'].includes(room));
  assert.ok(['lab-r2-carrier','lab-t2-target-carrier'].includes(name));assert.ok(['H','energy'].includes(resource));
  let creep=await db['rooms.objects'].findOne({user:uid,type:'creep',name});
  if(!creep){
   const source=await db['rooms.objects'].findOne({user:uid,type:'creep',name:'lab-r2-carrier'});assert.ok(source);
   const {_id,$loki,meta,...copy}=source;creep=await db['rooms.objects'].insert({...copy,name,store:{},ageTime:tick+1500});
  }
  const target=await db['rooms.objects'].findOne({user:uid,type:'terminal',room});
  await db['rooms.objects'].update({_id:creep._id},{$set:{room,x:target.x+1,y:target.y-1,store:{[resource]:50},ageTime:tick+1500}});
  m.creeps[name]={role:'carrier',ready:true,working:true};
  record('carrier',{isolatedWorldOnly:true,tick,kind:'synthetic-already-carried-50-'+resource,resource,name,before:creep,after:await db['rooms.objects'].findOne({_id:creep._id}),targetTerminalId:target._id});
 }else if(op==='fault'||op==='restore'){
  const target=await db['rooms.objects'].findOne({room:'E1N57',type:'terminal',user:uid});
  const amount=op==='fault'?1:-1,old=target.store.UH;
  await db['rooms.objects'].update({_id:target._id},{$set:{store:{...target.store,UH:old+amount}}});
  const readback=await db['rooms.objects'].findOne({_id:target._id});assert.equal(readback.store.UH,old+amount);
  record(op,{isolatedWorldOnly:true,tick,readbackUH:readback.store.UH,kind:'target-UH-contradiction',terminalId:target._id,beforeUH:old,afterUH:old+amount,rawMemory:raw,
   transactionCount:(await db.transactions.find({$or:[{sender:uid},{recipient:uid}]})).length});
  console.log(JSON.stringify({op,label,tick,beforeUH:old,afterUH:old+amount}));return;
 }else throw Error('unsupported operation');
 const next=JSON.stringify(m);await env.set(key,next);assert.equal(await env.get(key),next);
 console.log(JSON.stringify({op,label,tick,...summary(m),isolatedWorldOnly:true}));
})().then(()=>setTimeout(()=>process.exit(0),50),e=>{console.error(String(e.stack||e));setTimeout(()=>process.exit(1),50)});
