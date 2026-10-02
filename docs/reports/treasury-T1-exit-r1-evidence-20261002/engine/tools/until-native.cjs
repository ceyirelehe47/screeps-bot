const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
process.env.STORAGE_HOST='::1';process.env.STORAGE_PORT='21027';
const common=createRequire('/srv/screeps-treasury-t1/server/package.json')('@screeps/common');
(async()=>{
 await common.storage._connect();const {env}=common.storage;
 assert.equal(String(await env.get(env.keys.MAIN_LOOP_PAUSED)),'1');
 const key=env.keys.MEMORY+'7dad41a4bfc9d96';
 assert.equal(JSON.parse(await env.get(key)).runtime.treasuryProductionT1Quota,undefined);
 await env.set(env.keys.MAIN_LOOP_PAUSED,'0');
 try {
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
   const m=JSON.parse(await env.get(key));
   if(m.runtime?.treasuryProductionT1Quota?.status==='dispatching'){
    await env.set(env.keys.MAIN_LOOP_PAUSED,'1');
    await new Promise(r=>setTimeout(r,500));
    console.log(JSON.stringify({firstDispatchingObserved:true,tick:await env.get(env.keys.GAMETIME),paused:true}));return;
   }
   await new Promise(r=>setTimeout(r,40));
  }
  throw Error('no quota dispatching within 25 seconds');
 }finally{await env.set(env.keys.MAIN_LOOP_PAUSED,'1')}
})().then(()=>process.exit(0),e=>{console.error(String(e.stack||e));process.exit(1)});
