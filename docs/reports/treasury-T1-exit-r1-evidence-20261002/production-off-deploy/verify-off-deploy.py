#!/usr/bin/env python3
"""从批准、上传/独立GET、新tick及四shard完整任务投影复核默认OFF发布。"""
import json,hashlib
from pathlib import Path
r=Path(__file__).resolve().parent
load=lambda p:json.loads(p.read_text())
mf=load(r.parent/'release/manifest.json'); auth=load(r/'authorization.json')
assert auth['userMessage']=='批准' and auth['mainSha256']==mf['mainSha256']
assert auth['releaseHead']=='f0b606fedffe12e0bcd0bd1d05ffb6b03ef60ff7'
lines=[json.loads(l) for l in (r/'apply.log').read_text().splitlines()]
assert len(lines)==2 and lines[0]['gate']=='passed' and lines[0]['mode']=='--apply'
assert lines[0]['sourceCommit']==mf['sourceCommit'] and lines[0]['candidateSha256']==mf['mainSha256']
assert lines[0]['shardsVerified']==['shard0','shard1','shard2','shard3']
assert lines[1]['postStatus']=='accepted' and lines[1]['applied'] is True
assert lines[1]['readback']=={'sha256':mf['mainSha256'],'bytes':mf['mainBytes']}
p=load(r/'post-production-selected.json');summary=load(r/'publication-summary.json')
assert p['account']=={'_id':mf['accountId'],'username':mf['accountName']} and p['shard']=='shard1'
assert p['code']['branch']=='default' and list(p['code']['modules'])==['main']
assert p['code']['modules']['main']=={'sha256':mf['mainSha256'],'bytes':mf['mainBytes']}
rt=p['memory']['runtime'];assert rt['lastDeployTag']==mf['buildTag'] and rt['lastDeployBundleHash']==mf['deployBundleHash']
assert rt['resourceControl']['updatedAt']==summary['runtimeTick']>summary['beforeMonitorTick']
assert p['canonicalTasks']['complete'] is True and p['canonicalTasks']['count']==len(p['canonicalTasks']['records'])
assert summary['codePosts']==1 and summary['armCalls']==summary['treasuryNativeCalls']==0
assert summary['marketCfgUnchanged'] is True
market=load(r/'market-cfg-before-after.json');assert market['before']==market['after']
sha=lambda x:hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
assert sha(market['before'])==summary['marketCfgBeforeSha256']==summary['marketCfgAfterSha256']
legacyKeys=['receipts','intents','quarantine','resolutions','resolutionCleanup','attemptLineage','attemptIssuer','issuedAttemptTickets','writeFault','authorizationFaults','retiredAttemptRanges','cleanupCompletions','cleanupSupersessions','chainRetirementCertificates','generationRetirementProofs','lineageRetirementSummaries','completionHeadroomReservations']
def clear(cfg,rt,tasks):
 assert isinstance(cfg,dict) and isinstance(rt,dict) and isinstance(tasks,dict)
 assert cfg.get('treasuryTerminalTransferSlice0',{}).get('mode','off')=='off'
 for k in ['treasuryT1FirstLiveControl','treasuryT1FirstLiveControlMirror','treasuryProductionT1Quota','treasuryCore']:assert k not in rt
 legacy=rt.get('treasury',{});assert isinstance(legacy,dict)
 for k in legacyKeys:assert legacy.get(k) is None or legacy.get(k)=={}
 assert all(isinstance(t,dict) and t['id']==id and 'treasurySlice' not in t for id,t in tasks.items())
clear(p['memory']['cfg'],rt,p['canonicalTasks']['records'])
assert rt['marketBaseResourceEgressTrialR2']['status']==rt['marketBaseResourceEgressTrialR2Mirror']['status']=='closed'
assert not [t for t in p['canonicalTasks']['records'].values() if t['resource']=='H' and t['fromRoomName']=='E3N59' and t['toRoomName']=='E4N58']
shards=load(r/'post-shards-selected.json')['records'];observations=load(r/'post-shards-summary.json')['records']
assert [x['shard'] for x in shards]==['shard0','shard1','shard2','shard3']
for x in shards:
 assert x['canonicalTasksComplete'] is True
 clear(x['cfg'],x['runtime'],x['data']['resourceControl']['tasks'])
 o=next(y for y in observations if y['shard']==x['shard'])
 assert o['memorySha256']==x['fullMemorySha256'] and o['memoryBytes']==x['fullMemoryBytes']
 assert o['canonicalTaskCount']==len(x['data']['resourceControl']['tasks'])
 if x['shard']!='shard1':assert o['memorySha256']==o['beforeSha256']
print(json.dumps({'passed':True,'scope':'仅默认OFF代码发布及读回，首次Treasury业务未执行','mainSha256':mf['mainSha256'],'runtimeTick':summary['runtimeTick'],'fourShardsOffAndClear':True,'codePosts':1,'treasuryNativeCalls':0},ensure_ascii=False,indent=2))
