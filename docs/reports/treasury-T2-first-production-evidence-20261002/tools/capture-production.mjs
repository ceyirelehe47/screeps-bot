import {resolve, dirname, relative, isAbsolute, sep} from 'node:path';
import {execFileSync} from 'node:child_process';
/** 本轮只读取证；完整代码/Memory仅保存到私有audit目录。 */
import {readFile, mkdir, writeFile, chmod, lstat, realpath} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const [secretPath, output, audit, allShards] = process.argv.slice(2);
if (!secretPath || !output || !audit || (allShards && allShards !== '--all-shards')) throw Error('usage: secret output audit [--all-shards]');
const secret = JSON.parse(await readFile(secretPath, 'utf8'));
const token = process.env.SCREEPS_TOKEN || secret.main?.token;
if (!token || secret.main?.hostname !== 'screeps.com' || secret.main?.branch !== 'default') throw Error('target mismatch');

async function preparePrivateAudit(audit) {
  await mkdir(audit,{recursive:true,mode:0o700});
  const stat=await lstat(audit);
  if(!stat.isDirectory() || stat.isSymbolicLink()) throw Error('audit must be a real directory');
  const actual=await realpath(audit);
  const common=execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim();
  for(const root of [resolve(process.cwd()),dirname(common)]) {
    const rel=relative(root,actual);
    if(rel==='' || (rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw Error('private audit cannot be inside repository');
  }
  await chmod(actual,0o700);
  if(((await lstat(actual)).mode & 0o777)!==0o700) throw Error('audit permissions not private');
}
const sha = s => createHash('sha256').update(s).digest('hex');
async function get(path) {
  const r = await fetch(new URL(path, 'https://screeps.com'), {headers:{'X-Token':token,'X-Username':token},signal:AbortSignal.timeout(30000)});
  if (!r.ok) throw Error(`GET ${path.split('?')[0]} HTTP ${r.status}`);
  const body = await r.json();
  if (body.ok !== 1) throw Error(`GET ${path.split('?')[0]} API not ok`);
  return body;
}
function unpack(body) {
  let raw = body.data;
  if (typeof raw !== 'string') throw Error('missing raw Memory');
  if (raw.startsWith('gz:')) raw = gunzipSync(Buffer.from(raw.slice(3),'base64')).toString('utf8');
  const m = JSON.parse(raw);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('bad Memory root');
  return {raw,m};
}
const capturedAtUtc = new Date().toISOString();
const me = await get('/api/auth/me');
if (me._id !== '634fe406347a7b69b28aeccb' || me.username !== 'forster') throw Error('account mismatch');
const shards = allShards ? ['shard0','shard1','shard2','shard3'] : ['shard1'];
const [code,...responses] = await Promise.all([get('/api/user/code?branch=default'), ...shards.map(s=>get(`/api/user/memory?shard=${s}`)), ...['E4N58','E1N57'].map(r=>get(`/api/game/room-objects?room=${r}&shard=shard1`))]);
if (code.branch !== 'default' || !code.modules || typeof code.modules !== 'object' || Array.isArray(code.modules) || Object.keys(code.modules).join() !== 'main' || typeof code.modules.main !== 'string' || code.modules.main.length === 0) throw Error('bad code root');
await preparePrivateAudit(audit);
await writeFile(`${audit}/production-code.json`,JSON.stringify(code),{flag:'wx',mode:0o600});
const pick = (obj, keys) => Object.fromEntries(keys.filter(k=>obj?.[k]!==undefined).map(k=>[k,obj[k]]));
const selected = {};
for (let i=0;i<shards.length;i++) {
  const {raw,m} = unpack(responses[i]);
  await writeFile(`${audit}/${shards[i]}-memory.json`,raw,{flag:'wx',mode:0o600});
  for (const k of ['runtime','cfg','data']) if(m[k]!==undefined && (!m[k] || typeof m[k]!=='object' || Array.isArray(m[k]))) throw Error(`bad ${k} root`);
  const runtime = m.runtime || {}, cfg = m.cfg || {};
  const treasuryKeys = Object.keys(runtime).filter(k=>/treasury/i.test(k));
  const taskTable = m.data?.resourceControl?.tasks;
  if(shards[i]==='shard1' && (!taskTable || typeof taskTable!=='object' || Array.isArray(taskTable))) throw Error('missing canonical tasks');
  selected[shards[i]] = {sha256:sha(raw),utf8Bytes:Buffer.byteLength(raw),latestTick:Math.max(0,...Object.values(m.analytics?.production?.rooms || {}).map(r=>r.updatedAt||0)),
    cfg:pick(cfg,[...Object.keys(cfg).filter(k=>/treasury/i.test(k)),'resourceControl','marketSaleAutomation','synthesisControl','hub','rooms']),
    runtime:pick(runtime,[...treasuryKeys,'lastDeployTag','lastDeployBundleHash','resourceControl','synthesisControl','resourceReservations','resourceReservationsOwnerVersion','marketSaleAutomation','marketBaseResourceEgressTrialR2','marketBaseResourceEgressTrialR2Mirror']),
    tasks:taskTable||null,
    relevantCreeps:Object.fromEntries(Object.entries(m.creeps||{}).filter(([,c])=>['E4N58','E1N57'].some(r=>JSON.stringify(c).includes(r)))),
    analytics:pick(m.analytics,['resourceControl','marketSaleAutomation','cpuMonitor']),
    marketData:m.data?.marketSaleAutomation || null,
  };
}
const record = {schema:'screeps-t2-production-capture/v1',capturedAtUtc,completedAtUtc:new Date().toISOString(),account:{id:me._id,username:me.username},
  code:{branch:code.branch,modules:Object.fromEntries(Object.entries(code.modules).map(([k,v])=>[k,{sha256:sha(v),bytes:Buffer.byteLength(v)}]))},shards:selected,
  rooms:{E4N58:responses[shards.length],E1N57:responses[shards.length+1]}};
await writeFile(output,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({capturedAtUtc,code:record.code,shards:Object.fromEntries(Object.entries(selected).map(([s,m])=>[s,{latestTick:m.latestTick,utf8Bytes:m.utf8Bytes,tag:m.runtime.lastDeployTag,treasuryKeys:Object.keys(m.runtime).filter(k=>/treasury/i.test(k))}])),matching:Object.values(selected.shard1?.tasks||{}).filter(t=>t.resource==='UH'&&t.fromRoomName==='E4N58'&&t.toRoomName==='E1N57')}));
