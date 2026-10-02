/** 固定产品入口；未知POST只读回不重发，临时结果在调用前写边界。 */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {randomUUID,createHash} from 'node:crypto';
const [action,secretPath,output,...args] = process.argv.slice(2);
if(!['inspect','cargo','prepare','arm','heartbeat','close'].includes(action)||!secretPath||!output)throw Error('usage: inspect|arm|heartbeat|close secret output [manifest taskId createdAt requestedAmount]');
const s=JSON.parse(await readFile(secretPath,'utf8')),token=process.env.SCREEPS_TOKEN||s.main?.token;
if(!token||s.main.hostname!=='screeps.com'||s.main.branch!=='default')throw Error('target mismatch');
const marker=randomUUID(),key='__codexTreasuryT3Result';
async function req(path,init={}) {
 const r=await fetch(new URL(path,'https://screeps.com'),{...init,headers:{'X-Token':token,'X-Username':token,...init.headers},signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error(`Screeps HTTP ${r.status}`);
 const v=await r.json();if(v.ok!==1)throw Error(`API not ok: ${JSON.stringify({ok:v.ok,error:v.error}).slice(0,300)}`);return v;
}
async function readResult() {
 const b=await req(`/api/user/memory?shard=shard1&path=${key}`);
 if(!Object.hasOwn(b,'data')||typeof b.data!=='string')throw Error('diagnostic Memory response missing or invalid data');
 let raw=b.data;
 if(typeof raw==='string'&&raw.startsWith('gz:'))raw=gunzipSync(Buffer.from(raw.slice(3),'base64')).toString('utf8');
 return raw===undefined||raw==='undefined'?undefined:typeof raw==='string'?JSON.parse(raw):raw;
}
const me=await req('/api/auth/me');
if(me._id!=='634fe406347a7b69b28aeccb'||me.username!=='forster')throw Error('account mismatch');
if(await readResult()!==undefined)throw Error('prior diagnostic result exists; inspect it before another action');
let body=`({tick:Game.time,shard:Game.shard.name,ms:Date.now(),rooms:['E4N58','E1N57'].map(r=>{const t=Game.rooms[r].terminal;return {room:r,id:t.id,owner:t.owner.username,active:t.isActive(),cooldown:t.cooldown,store:t.store,free:t.store.getFreeCapacity()}}),labs:Game.rooms.E1N57.find(FIND_MY_STRUCTURES).filter(s=>s.structureType===STRUCTURE_LAB).map(s=>({id:s.id,store:s.store})),incoming:Game.market.incomingTransactions.slice(0,40),outgoing:Game.market.outgoingTransactions.slice(0,40)})`;
if(action==='cargo') body=`({tick:Game.time,shard:Game.shard.name,creeps:Object.values(Game.creeps).filter(c=>['E4N58','E1N57'].includes(c.room.name)).map(c=>({name:c.name,room:c.room.name,store:c.store,assignment:global.__creepAssignmentState?.[c.name]})),board:global.__carrierTaskBoard})`;
if(!['inspect','cargo'].includes(action)) {
 const [manifestPath,taskId,createdAt,requestedAmount]=args;
 if(!manifestPath)throw Error('frozen manifest required');
 const m=JSON.parse(await readFile(manifestPath,'utf8'));
 if(m.schema!=='screeps-t3-first-production-release/v1')throw Error('manifest mismatch');
 const code=await req('/api/user/code?branch=default');
 if(code.branch!=='default'||Object.keys(code.modules||{}).join()!=='main'||typeof code.modules.main!=='string'||createHash('sha256').update(code.modules.main).digest('hex')!==m.mainSha256)throw Error('live code SHA mismatch');
 if(['prepare','arm'].includes(action)&&(!/^[A-Za-z0-9:_.>\-]{1,80}$/.test(taskId||'')||!Number.isSafeInteger(Number(createdAt))||Number(createdAt)<0||!Number.isSafeInteger(Number(requestedAmount))||Number(requestedAmount)<1||Number(requestedAmount)>100))throw Error('invalid exact task');
 const call=action==='prepare'?`prepareTreasuryT3FirstLive(${JSON.stringify(taskId)},${Number(createdAt)},${Number(requestedAmount)})`:action==='arm'?`armTreasuryT3FirstLive(${JSON.stringify(taskId)},${Number(createdAt)},${Number(requestedAmount)})`:action==='heartbeat'?'heartbeatTreasuryT3FirstLive()':'closeTreasuryT3FirstLive()';
 body=`(()=>{if(Memory.runtime?.lastDeployTag!==${JSON.stringify(m.buildTag)}||Memory.runtime?.lastDeployBundleHash!==${JSON.stringify(m.deployBundleHash)})throw Error('deployment changed');return {tick:Game.time,ms:Date.now(),entryResult:${call}}})()`;
}
const expression=`(()=>{if(Game.shard.name!=='shard1'||Memory.${key}!==undefined)throw Error('guard');const r=Memory.${key}={marker:${JSON.stringify(marker)},action:${JSON.stringify(action)},status:'executing'};try{r.result=${body};r.status='returned'}catch(e){r.status='threw';r.error=String(e)}return r.status})()`;
if(expression.length>1024)throw Error('console expression exceeds local size guard; split diagnostic');
await mkdir(output,{recursive:true});
await writeFile(`${output}/request.json`,JSON.stringify({action,marker,expression,requestedAtUtc:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
let postStatus='unknown';
try {const response=await req('/api/user/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shard:'shard1',expression})});postStatus='accepted';await writeFile(`${output}/accepted.json`,JSON.stringify(response,null,2)+'\n',{flag:'wx'});}
catch(e){postStatus=`unconfirmed:${String(e.message).slice(0,300)}`;}
await writeFile(`${output}/post-status.json`,JSON.stringify({postStatus})+'\n',{flag:'wx'});
let observed;
for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,5000));const v=await readResult();if(v?.marker===marker){observed=v;break;}}
if(!observed)throw Error(`execution unobserved; do not replay (${postStatus})`);
await writeFile(`${output}/result.json`,JSON.stringify({capturedAtUtc:new Date().toISOString(),...observed},null,2)+'\n',{flag:'wx'});
if(observed.status!=='returned')throw Error('product did not return; preserve marker and inspect responsibility');
let cleanupStatus='unknown';
try{await req('/api/user/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shard:'shard1',expression:`if(Memory.${key}?.marker===${JSON.stringify(marker)})delete Memory.${key}`})});cleanupStatus='accepted';}catch(e){cleanupStatus=`unconfirmed:${String(e.message).slice(0,80)}`;}
await new Promise(r=>setTimeout(r,5000));
const cleared=(await readResult())===undefined;
await writeFile(`${output}/cleanup.json`,JSON.stringify({cleanupStatus,cleared})+'\n',{flag:'wx'});
console.log(JSON.stringify({action,postStatus,status:observed.status,result:observed.result,cleanup:{cleanupStatus,cleared}}));
if(!cleared)process.exitCode=1;
