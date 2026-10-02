import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeMemoryResponse,noT1Responsibility,requireScreepsOk} from '/Users/forst/.codex/worktrees/treasury-t1-exit-r1/screeps/scripts/deploy-frozen-t1-exit-r1.mjs';
const audit=process.argv[2];
const secret=JSON.parse(await readFile('/Users/forst/code/screeps/.secret.json','utf8'));const token=process.env.SCREEPS_TOKEN||secret.main?.token;
if(secret.main?.hostname!=='screeps.com'||secret.main?.branch!=='default'||!token)throw Error('identity target invalid');
const before=JSON.parse(await readFile(audit+'/before-memory.json','utf8'));
const capturedAtUtc=new Date().toISOString();
const after=await Promise.all(['shard0','shard1','shard2','shard3'].map(async shard=>{
 const r=await fetch('https://screeps.com/api/user/memory?shard='+shard,{headers:{'X-Token':token,'X-Username':token},signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('HTTP '+r.status);const m=decodeMemoryResponse(requireScreepsOk(await r.json()));
 if(!noT1Responsibility(m.value))throw Error('T1 responsibility or root invalid on '+shard);
 return {shard,...m};
}));
await writeFile(audit+'/after-shards.json',JSON.stringify(after),{flag:'wx',mode:0o600});
const sha=s=>createHash('sha256').update(s).digest('hex');
const keys=['treasuryT1FirstLiveControl','treasuryT1FirstLiveControlMirror','treasuryProductionT1Quota','treasuryCore'];
const summary={schema:'screeps-t1-exit-r1-post-deploy-shards/v1',capturedAtUtc,allShardsT1OffAndClear:true,records:after.map(s=>({
 shard:s.shard,memoryBytes:s.utf8Bytes,memorySha256:sha(s.raw),beforeSha256:sha(before.find(x=>x.shard===s.shard).raw),
 unchangedFromBefore:sha(s.raw)===sha(before.find(x=>x.shard===s.shard).raw),deployTag:s.value.runtime?.lastDeployTag||null,
 mode:s.value.cfg?.treasuryTerminalTransferSlice0?.mode||'off',responsibilityClear:noT1Responsibility(s.value),
 t1StatePresent:Object.fromEntries(keys.map(k=>[k,s.value.runtime?.[k]!==undefined])),
 canonicalTaskCount:Object.keys(s.value.data?.resourceControl?.tasks||{}).length,taskLeaseCount:Object.values(s.value.data?.resourceControl?.tasks||{}).filter(t=>t.treasurySlice!==undefined).length}))};
await writeFile('/tmp/t1-exit-r1-after-shards-summary.json',JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(summary,null,2));
