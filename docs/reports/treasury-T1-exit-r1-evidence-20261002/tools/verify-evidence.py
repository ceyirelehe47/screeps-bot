#!/usr/bin/env python3
"""从冻结 main、真实引擎原件和完整生产任务推导结论；不读取既有 passed 文件。"""
import argparse, hashlib, json
from pathlib import Path
from datetime import datetime

ap=argparse.ArgumentParser(description=__doc__)
ap.add_argument('--candidate',type=Path,required=True)
ap.add_argument('--output',type=Path)
a=ap.parse_args()
r=Path(__file__).resolve().parents[1]
sha=lambda b:hashlib.sha256(b).hexdigest()
load=lambda p:json.loads(p.read_text())
manifest=load(r/'release/manifest.json')
main=(a.candidate/'main.js').read_bytes()
assert sha(main)==manifest['mainSha256'] and len(main)==manifest['mainBytes']<5_000_000
candidateManifest=load(a.candidate/'manifest.json')
assert candidateManifest==manifest
snapshots={}
for p in sorted((r/'engine/evidence').glob('*-snapshot.json')):
 s=load(p)
 assert s['schema']=='screeps-t1-exit-r1-engine-snapshot/v1'
 assert s['paused'] is True and s['user']['_id']=='7dad41a4bfc9d96'
 assert s['user']['_id']!=manifest['accountId']
 assert s['code']=={'sha256':manifest['mainSha256'],'bytes':manifest['mainBytes']}
 assert s['memoryUtf8Bytes']==len(s['rawMemory'].encode())
 assert len({t['_id'] for t in s['transactions']})==len(s['transactions'])
 s['m']=json.loads(s['rawMemory']); snapshots[p.stem.removesuffix('-snapshot')]=s

def snap(n):return snapshots[n]
def rt(s):return s['m']['runtime']
def control(s):
 c=rt(s)['treasuryT1FirstLiveControl']; assert c==rt(s)['treasuryT1FirstLiveControlMirror']
 assert c['runId']=='treasury-t1-first-live-2026-09-27'
 assert c['deadlineTick']==c['startedAtTick']+600
 assert c['deadlineMs']==c['startedAtMs']+1_800_000
 assert c['controlUntilMs']==c['lastHeartbeatAtMs']+60_000
 assert c['deployTag']==manifest['buildTag'] and c['deployBundleHash']==manifest['deployBundleHash']
 return c

def task(s,id):return s['m']['data']['resourceControl']['tasks'][id]
def obj(s,id):return next(x for x in s['objects'] if x['_id']==id)
def terminal(s,room):return next(x for x in s['objects'] if x['type']=='terminal' and x['room']==room)
def newtx(before,after):
 old={x['_id'] for x in before['transactions']}; now={x['_id'] for x in after['transactions']}
 assert old<=now
 return [x for x in after['transactions'] if x['_id'] not in old]
def ordinary(t,id):
 assert t['description']=='resourceControl:task:'+id and t['resourceType']=='H' and t['amount']==100

def clear(s,id):
 assert task(s,id)['status']=='done' and task(s,id)['remainingAmount']==0
 assert 'treasurySlice' not in task(s,id)
 assert control(s)['status']=='closed' and s['m']['cfg']['treasuryTerminalTransferSlice0']['mode']=='off'
 assert not rt(s).get('treasuryCore',{}).get('active')

def native(s,before,id):
 q=rt(s)['treasuryProductionT1Quota']; assert q['status']=='dispatching' and q['amount']==100
 assert q['runId']=='treasury-production-T1-2026-09-24'
 assert q['taskId']==id and q['taskCreatedAt']==task(s,id)['createdAt'] and q['taskAmount']==task(s,id)['amount']
 c=control(s); assert c['taskId']==id and c['taskCreatedAt']==q['taskCreatedAt']
 assert c['status']=='closed' and c['closeReason']=='native_attempt'
 k=rt(s)['treasuryCore']; assert len(k['active'])==1
 work=k['active'][q['attemptId']]; assert work['attemptId']==q['attemptId'] and work['workKey']==q['workKey']
 assert work['phase']=='outcome_unknown' and work['outcome']=='unknown'
 assert work['invocationBoundary']==work['invocation'] and work['external']['accepted'] is True
 assert task(s,id)['remainingAmount']==100 and task(s,id)['treasurySlice']['attemptId']==q['attemptId']
 delta=newtx(before,s); assert len(delta)==1; t=delta[0]
 assert t['description']=='treasury-T1-2026-09-24:'+q['attemptId']
 assert (t['from'],t['to'],t['resourceType'],t['amount'],t['time'])==('E3N59','E4N58','H',100,work['invocation']['atTick'])
 fields=work['identity']['durableFacts']['payload'].split('|')
 assert fields[:3]==['t1',q['runId'],id] and int(fields[6])==4
 source=obj(s,fields[8]);target=obj(s,fields[15])
 assert source['room']=='E3N59' and target['room']=='E4N58'
 assert source['store']['H']==int(fields[9])-100 and source['store']['energy']==int(fields[10])-4
 assert target['store']['H']==int(fields[16])+100
 assert target['store']['energy']==int(fields[17])
 return q,t

def committed(s,id,q):
 clear(s,id);now=rt(s)['treasuryProductionT1Quota']
 assert now=={**q,'status':'drained'}
 k=rt(s)['treasuryCore']; assert k['counters']['dispatched']==1 and k['counters']['settledCommitted']==1
 rings=[x for x in k['ring'] if x['attemptId']==q['attemptId']]
 assert len(rings)==1 and rings[0]['terminalPhase']=='committed' and rings[0]['workKey']==q['workKey']

A0=snap('a-armed-no-responsibility'); A1=snap('a-expired-ordinary-restored')
assert control(A0)['status']=='active' and A0['m']['cfg']['resourceControl']['enabled'] is False
for s in [A0,A1]:
 assert 'treasuryProductionT1Quota' not in rt(s) and 'treasuryCore' not in rt(s)
 assert 'treasurySlice' not in task(s,'lab-exit-a-H')
assert task(A0,'lab-exit-a-H')['remainingAmount']==100
clear(A1,'lab-exit-a-H'); assert control(A1)['closeReason']=='control_lease_expired'
assert datetime.fromisoformat(A1['capturedAtUtc'].replace('Z','+00:00')).timestamp()*1000>=control(A0)['controlUntilMs']
assert {k:v for k,v in control(A0).items() if k not in ['hash','status','closeReason']}=={k:v for k,v in control(A1).items() if k not in ['hash','status','closeReason']}
Atx=newtx(A0,A1);assert len(Atx)==1;ordinary(Atx[0],'lab-exit-a-H')
assert terminal(A0,'E3N59')['store']['H']-terminal(A1,'E3N59')['store']['H']==100
assert terminal(A1,'E4N58')['store']['H']-terminal(A0,'E4N58')['store']['H']==100
assert terminal(A0,'E3N59')['store']['energy']-terminal(A1,'E3N59')['store']['energy']==4
# A 装夹只重新启用旧调度，不允许操作员 close/手写 mode。
assert load(r/'engine/evidence/a-enable-ordinary-queue.json')['expression']=='Memory.cfg.resourceControl.enabled=true'

B0=snap('b4-before-native');B1=snap('b4-real-native');Bend=snap('b4-confirmed-ordinary-and-carrier-restored')
Bq,Btx=native(B1,B0,'lab-exit-b4-H')
f=load(r/'engine/evidence/b4-inject-contradiction-fault.json');restore=load(r/'engine/evidence/b4-restore-true-store-restore.json')
assert f['beforeH']==1100 and f['afterH']==f['readbackH']==1101
assert restore['beforeH']==1101 and restore['afterH']==restore['readbackH']==1100
Bs=[snap(n) for n in ['b4-unknown-off-request-held','b4-unrelated-native-while-unknown','b4-unknown-after-real-restart','b4-carrier-held']]
for s in Bs:
 assert rt(s)['treasuryProductionT1Quota']==Bq
 assert rt(s)['treasuryCore']['active'][Bq['attemptId']]['phase']=='outcome_unknown'
 assert control(s)==control(B1) and s['m']['cfg']['treasuryTerminalTransferSlice0']['mode']=='drain'
 assert task(s,'lab-exit-b4-H')['remainingAmount']==100
 assert task(s,'lab-exit-b4-H')['treasurySlice']['attemptId']==Bq['attemptId']
 for id in ['lab-exit-b4-block-source-ordinary','lab-exit-b4-block-target-ordinary']:
  assert task(s,id)['status']=='pending' and task(s,id)['remainingAmount']==100 and task(s,id)['lastError']=='send_code_-4'
 assert len([t for t in newtx(B0,s) if t['description'].startswith('treasury-T1-')])==1
 assert terminal(s,'E4N58')['store']['H']==1101
assert load(r/'engine/evidence/b4-request-off-queue.json')['expression']=='Memory.cfg.treasuryTerminalTransferSlice0.mode="off"'
assert datetime.fromisoformat(Bs[-1]['capturedAtUtc'].replace('Z','+00:00')).timestamp()*1000>=control(B1)['controlUntilMs']
U=snap('b4-unrelated-native-while-unknown');Utx=newtx(Bs[0],U); assert len(Utx)==1
ordinary(Utx[0],'lab-exit-b4-unrelated-ordinary');assert (Utx[0]['from'],Utx[0]['to'])==('W9N8','W8N8')
R=snap('b4-unknown-after-real-restart');assert newtx(U,R)==[]
carrier=load(r/'engine/evidence/b4-carrier-cargo-carrier.json');cid=carrier['after']['_id']
assert carrier['kind']=='synthetic-already-carried-50-energy' and carrier['after']['store']['energy']==50
assert obj(snap('b4-carrier-held'),cid)['store']['energy']==50
committed(Bend,'lab-exit-b4-H',Bq)
assert obj(Bend,cid)['store']['energy']==0 and terminal(Bend,'E4N58')['store']['energy']>terminal(Bs[-1],'E4N58')['store']['energy']
Bordinary=newtx(R,Bend); assert len(Bordinary)==2
assert {t['description'] for t in Bordinary}=={'resourceControl:task:lab-exit-b4-block-source-ordinary','resourceControl:task:lab-exit-b4-block-target-ordinary'}
for t in Bordinary:ordinary(t,t['description'].removeprefix('resourceControl:task:'))
for id in ['lab-exit-b4-block-source-ordinary','lab-exit-b4-block-target-ordinary','lab-exit-b4-unrelated-ordinary']:clear(Bend,id)

C0=snap('c-expired-calibration');Ch=snap('c2-endpoint-conflicts');C1=snap('c2-real-native');Cend=snap('c2-confirmed');Cr=snap('c2-off-after-real-restart')
assert control(Ch)['status']=='active' and 'treasuryProductionT1Quota' not in rt(Ch) and 'treasuryCore' not in rt(Ch)
assert task(Ch,'lab-exit-c2-H')['status']=='pending' and task(Ch,'lab-exit-c2-H')['remainingAmount']==100
Ctx=newtx(C0,Ch); assert len(Ctx)==2
assert {(x['from'],x['to']) for x in Ctx}=={('W9N8','E3N59'),('W8N8','E4N58')}
assert {x['time'] for x in Ctx}=={720,725}
for t in Ctx:ordinary(t,t['description'].removeprefix('resourceControl:task:'))
Cq,Ctx1=native(C1,Ch,'lab-exit-c2-H');assert Ctx1['time']>max(t['time'] for t in Ctx)
committed(Cend,'lab-exit-c2-H',Cq);committed(Cr,'lab-exit-c2-H',Cq)
assert control(Cend)==control(Cr) and rt(Cend)['treasuryCore']==rt(Cr)['treasuryCore']
assert newtx(C1,Cr)==[]
journal=[json.loads(x) for x in (r/'engine/service-journal-original.jsonl').read_text().splitlines()]
def timestamp(s):return datetime.fromisoformat(s['capturedAtUtc'].replace('Z','+00:00')).timestamp()
def real_restart(before,after):
 events=[x for x in journal if timestamp(before)<int(x['__REALTIME_TIMESTAMP'])/1e6<timestamp(after)]
 stops=[x for x in events if x.get('_PID')=='1' and x.get('MESSAGE','').startswith('Stopped screeps-treasury-t1.service')]
 starts=[x for x in events if x.get('_PID')=='1' and x.get('MESSAGE','').startswith('Started screeps-treasury-t1.service')]
 assert len(stops)==len(starts)==1
 assert int(stops[0]['__REALTIME_TIMESTAMP'])<int(starts[0]['__REALTIME_TIMESTAMP'])
 return {'stoppedMicroseconds':stops[0]['__REALTIME_TIMESTAMP'],'startedMicroseconds':starts[0]['__REALTIME_TIMESTAMP']}
B_restart=real_restart(U,R);C_restart=real_restart(Cend,Cr)
service=(r/'engine/service-ending.txt').read_text()
assert 'Id=dsh.service\nActiveState=active' in service and 'Id=nginx.service\nActiveState=active' in service
assert 'Id=screeps-treasury-t1.service\nActiveState=inactive' in service
prod=[]
for p in sorted(r.glob('production-preflight*.json')):
 s=load(p);t=s['canonicalTasks'];assert t['complete'] is True and t['count']==len(t['records'])
 assert all(k==v['id'] for k,v in t['records'].items())
 assert not [x for x in t['records'].values() if x['resource']=='H' and x['fromRoomName']=='E3N59' and x['toRoomName']=='E4N58']
 assert list(s['code']['modules'])==['main'] and s['code']['modules']['main']['sha256']==manifest['expectedLiveSha256']
 assert s['memory']['runtime']['lastDeployTag']==manifest['expectedLiveDeployTag']
 assert s['memory']['utf8Bytes']<1_900_000
 for key in ['treasuryT1FirstLiveControl','treasuryT1FirstLiveControlMirror','treasuryProductionT1Quota','treasuryCore']:assert key not in s['memory']['runtime']
 prod.append({'file':p.name,'capture':s['capturedAtUtc'],'taskCount':t['count'],'matching':0,'memoryBytes':s['memory']['utf8Bytes']})
result={'schema':'screeps-t1-exit-r1-evidence-verification/v1','scope':'冻结工程与发布前原件；后续默认OFF发布另见production-off-deploy记录','passed':True,'inputSnapshotCount':len(snapshots),
 'mainSha256':sha(main),'A':{'ordinaryTransaction':Atx[0]['_id'],'nativeT1':0},
 'B':{'attemptId':Bq['attemptId'],'transactionId':Btx['_id'],'nativeT1':1,'amount':100,'actualEnergyFee':4,'committed':True,'unknownRestartHeld':True,'systemdRestart':B_restart,'carrierSyntheticCargoRestored':True},
 'C':{'attemptId':Cq['attemptId'],'transactionId':Ctx1['_id'],'ordinaryBeforeT1':[t['_id'] for t in Ctx],'nativeT1':1,'committed':True,'offRestartNoResend':True,'systemdRestart':C_restart},'production':prod,'productionWrites':0}
if a.output:a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
