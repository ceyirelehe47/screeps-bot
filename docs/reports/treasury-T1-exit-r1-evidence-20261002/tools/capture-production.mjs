/** Read-only production capture. Credentials stay outside output and git. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const [secretPath, output, privateAudit] = process.argv.slice(2);
if (!secretPath || !output || !privateAudit) throw Error('usage: secret-file output-json private-audit-dir');
const secret = JSON.parse(await readFile(secretPath, 'utf8'));
const token = process.env.SCREEPS_TOKEN || secret.main?.token;
if (!token || secret.main.hostname !== 'screeps.com' || secret.main.branch !== 'default') throw Error('credential target mismatch');
const digest = s => createHash('sha256').update(s).digest('hex');
async function get(path) {
  const response = await fetch(new URL(path, 'https://screeps.com'), {
    headers: {'X-Token': token, 'X-Username': token}, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`GET ${path.split('?')[0]} HTTP ${response.status}`);
  const body = await response.json();
  if (body.ok !== 1) throw Error(`GET ${path.split('?')[0]} not ok`);
  return body;
}
const capturedAtUtc = new Date().toISOString();
const me = await get('/api/auth/me');
if (me._id !== '634fe406347a7b69b28aeccb' || me.username !== 'forster') throw Error('account mismatch');
const [code, memoryResponse, sourceObjects, targetObjects] = await Promise.all([
  get('/api/user/code?branch=default'), get('/api/user/memory?shard=shard1'),
  get('/api/game/room-objects?room=E3N59&shard=shard1'),
  get('/api/game/room-objects?room=E4N58&shard=shard1'),
]);
let rawMemory = memoryResponse.data;
if (typeof rawMemory !== 'string') throw Error('memory raw response missing');
if (rawMemory.startsWith('gz:')) rawMemory = gunzipSync(Buffer.from(rawMemory.slice(3), 'base64')).toString('utf8');
const m = JSON.parse(rawMemory);
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
const tasks = m.data?.resourceControl?.tasks;
if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) throw Error('canonical task table incomplete');
const record = {
  schema: 'screeps-t1-exit-r1-production-readonly/v1', capturedAtUtc,
  completedAtUtc: new Date().toISOString(), account: {_id: me._id, username: me.username}, shard: 'shard1',
  code: {branch: code.branch, modules: Object.fromEntries(Object.entries(code.modules).map(([k,v]) => [k,{bytes:Buffer.byteLength(v),sha256:digest(v)}]))},
  memory: {sha256:digest(rawMemory), utf8Bytes:Buffer.byteLength(rawMemory), chars:rawMemory.length,
    latestTick: m.analytics?.production?.rooms ? Math.max(...Object.values(m.analytics.production.rooms).map(x=>x.updatedAt||0)) : m.runtime?.lastTick,
    cfg: pick(m.cfg,['treasuryTerminalTransferSlice0','resourceControl','marketSaleAutomation','synthesis','hub']),
    runtime: pick(m.runtime,['lastDeployTag','lastDeployBundleHash','treasuryT1FirstLiveControl','treasuryT1FirstLiveControlMirror','treasuryProductionT1Quota','treasuryCore','treasury','resourceReservations','resourceReservationsOwnerVersion','marketSaleAutomation','resourceControl','marketEgressR2']),
    data: pick(m.data,['resourceControl','marketSaleAutomation']),
    analytics: pick(m.analytics,['resourceControl','marketSaleAutomation','cpuMonitor','production','hub']),
    creeps: Object.fromEntries(Object.entries(m.creeps||{}).filter(([,c]) => JSON.stringify(c).includes('E3N59')||JSON.stringify(c).includes('E4N58'))),
  },
  canonicalTasks: {complete: true, count: Object.keys(tasks).length, records: tasks},
  rooms: {E3N59: sourceObjects, E4N58: targetObjects},
};
await mkdir(privateAudit,{recursive:true,mode:0o700});
await writeFile(`${privateAudit}/production-memory.json`,rawMemory,{flag:'wx',mode:0o600});
await writeFile(`${privateAudit}/production-code.json`,JSON.stringify(code),{flag:'wx',mode:0o600});
await writeFile(output,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({capturedAtUtc,code:record.code,memoryUtf8Bytes:record.memory.utf8Bytes,deployTag:m.runtime?.lastDeployTag,
  taskCount:record.canonicalTasks.count,matching:Object.values(tasks).filter(t=>t.fromRoomName==='E3N59'&&t.toRoomName==='E4N58'&&t.resource==='H'),
  runtimeKeys:Object.keys(m.runtime||{}),cfgKeys:Object.keys(m.cfg||{}),dataKeys:Object.keys(m.data||{})},null,2));
