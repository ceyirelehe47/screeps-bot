#!/usr/bin/env python3
"""从真实C2未知期私有DB独立副本，补证carrier调用前值；不再调用native、不造receipt。"""
import hashlib, json, runpy, subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path('/srv/screeps-treasury-t1');RUN=ROOT/'r6-t2-20261002';uid='7dad41a4bfc9d96'
helpers=runpy.run_path(str(RUN/'tools/run-scenarios.py'),run_name='lab_helpers')
source=RUN/'db-before-c2-unknown-restart.json';raw=source.read_bytes();db=json.loads(raw)
cs={c['name']:c['data'] for c in db['collections']};env=cs['env'][0]['data'];m=json.loads(env['memory:'+uid])
manifest=json.loads((RUN/'candidate/manifest.json').read_text());q=m['runtime']['treasuryProductionT2Quota']
code=next(c for c in cs['users.code'] if c.get('user')==uid and c.get('activeWorld'))
assert hashlib.sha256(code['modules']['main'].encode()).hexdigest()==manifest['mainSha256']
assert next(u for u in cs['users'] if u['_id']==uid)['username']=='forster' and uid!=manifest['accountId']
assert str(env['mainLoopPaused'])=='1' and q['status']=='dispatching'
assert m['runtime']['treasuryCore']['active'][q['attemptId']]['phase']=='outcome_unknown'
native=[t for t in cs['transactions'] if t.get('description')=='treasury-T2-2026-10-02:'+q['attemptId']]
assert len(native)==1 and native[0]['amount']==100 and native[0]['resourceType']=='UH'
for name in ('lab-r2-carrier','lab-t2-target-carrier'):
    assert next(o for o in cs['rooms.objects'] if o.get('name')==name and o.get('user')==uid)['store']['H']==50
assert next(o for o in cs['rooms.objects'] if o.get('type')=='terminal' and o.get('room')=='E1N57')['store']['UH']==101
subprocess.run(['systemctl','stop','screeps-treasury-t1'],check=True)
subprocess.run(['cp','-p',str(source),str(ROOT/'server/db.json')],check=True)
subprocess.run(['chown','screepslab:screepslab',str(ROOT/'server/db.json')],check=True)
assert hashlib.sha256((ROOT/'server/db.json').read_bytes()).hexdigest()==hashlib.sha256(raw).hexdigest()
record={'schema':'screeps-t2-carrier-trace-supplement-instance/v1','isolatedWorldOnly':True,
    'createdAtUtc':datetime.now(timezone.utc).isoformat(),'sourcePrivateDatabase':str(source),
    'sourceDatabaseSha256':hashlib.sha256(raw).hexdigest(),'sourceMemorySha256':hashlib.sha256(env['memory:'+uid].encode()).hexdigest(),
    'mainSha256':manifest['mainSha256'],'originalAttemptId':q['attemptId'],'originalWorkKey':q['workKey'],
    'originalNativeTransactionId':native[0]['_id'],'originalNativeAtTick':native[0]['time'],
    'replayBranchOnly':True,'newNativeNotRequested':True,'purpose':'仅补充真实role委托调用前标量与保护/交付，原C2连续恢复链保持独立原件'}
with (RUN/'evidence/c2-carrier-prestate-supplement-instance.json').open('x') as f:json.dump(record,f,ensure_ascii=False,indent=2);f.write('\n')
subprocess.run(['systemd-run','--unit=screeps-treasury-t1','--collect','--property=WorkingDirectory='+str(ROOT/'server'),str(ROOT/'r4/start-uts.sh')],check=True)
helpers['wait_lab']()
helpers['capture']('c2-carrier-prestate-supplement-before')
helpers['carrier_plan']('c2-carrier-prestate-supplement-plan',[('lab-r2-carrier','E4N58'),('lab-t2-target-carrier','E1N57')])
helpers['until']('c2-carrier-prestate-supplement-held-driver','ticks','3')
helpers['capture']('c2-carrier-prestate-supplement-held')
helpers['call']('restore','c2-carrier-prestate-supplement-restore')
helpers['until']('c2-carrier-prestate-supplement-settle-driver','settled')
helpers['capture']('c2-carrier-prestate-supplement-settled')
helpers['until']('c2-carrier-prestate-supplement-release-driver','ticks','5')
helpers['capture']('c2-carrier-prestate-supplement-released')
completed=helpers['persisted_database']('c2-carrier-prestate-supplement-completed')
with (RUN/'db-c2-carrier-prestate-supplement-completed.json').open('xb') as f:f.write(completed)
