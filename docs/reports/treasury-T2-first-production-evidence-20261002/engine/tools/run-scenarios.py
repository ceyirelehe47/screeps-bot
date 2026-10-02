#!/usr/bin/env python3
"""在已许可实验主机运行冻结 main 的 C1/C2/C3；不接触正式服或凭据。"""
import hashlib, json, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path('/srv/screeps-treasury-t1')
RUN=ROOT/'r6-t2-20261002'
NODE=str(ROOT/'runtime/node22/bin/node')
LAB=RUN/'tools/lab.cjs'
DRIVER=RUN/'tools/run-until.cjs'

def call(*args):
    print('实验步骤:', args[0], args[1], flush=True)
    subprocess.run([NODE,str(LAB),*args],check=True)
def until(label,kind,arg=''):
    subprocess.run([NODE,str(DRIVER),label,kind,arg],check=True)
def capture(label):call('capture',label)
def artifact(label,suffix):return json.loads((RUN/'evidence'/f'{label}-{suffix}.json').read_text())
def arm(case):
    s=artifact(case+'-setup','setup')
    expression=f'Memory.runtime.__labT2ArmResult=armTreasuryT2FirstLive({json.dumps(s["taskId"])},{s["tick"]})'
    call('queue',case+'-arm',expression)
    until(case+'-arm-executed','armed')
def independent_instance(case):
    baseline=RUN/'db-frozen-pre-t2.json'
    raw=baseline.read_bytes(); database=json.loads(raw)
    collections={c['name']:c['data'] for c in database['collections']}
    uid='7dad41a4bfc9d96'
    user=next(u for u in collections['users'] if u['_id']==uid)
    assert user['username']=='forster'
    code=next(c for c in collections['users.code'] if c['user']==uid and c.get('activeWorld'))
    manifest=json.loads((RUN/'candidate/manifest.json').read_text())
    assert hashlib.sha256(code['modules']['main'].encode()).hexdigest()==manifest['mainSha256']
    env=collections['env'][0]['data'];assert str(env['mainLoopPaused'])=='1'
    m=json.loads(env['memory:'+uid]);rt=m['runtime']
    assert not rt.get('treasuryCore',{}).get('active')
    assert 'treasuryProductionT2Quota' not in rt and 'treasuryT2FirstLiveControl' not in rt
    assert not any(x['workKey'].startswith('biz:treasury-production-T2-') for x in rt.get('treasuryCore',{}).get('ring',[]))
    subprocess.run(['systemctl','stop','screeps-treasury-t1'],check=True)
    subprocess.run(['cp','-p',str(baseline),str(ROOT/'server/db.json')],check=True)
    assert hashlib.sha256((ROOT/'server/db.json').read_bytes()).hexdigest()==hashlib.sha256(raw).hexdigest()
    record={'schema':'screeps-t2-independent-lab-instance/v1','isolatedWorldOnly':True,'case':case,
        'restoredAtUtc':datetime.now(timezone.utc).isoformat(),'baselineFile':str(baseline),'baselineSha256':hashlib.sha256(raw).hexdigest(),
        'mainSha256':manifest['mainSha256'],'mainBytes':len(code['modules']['main'].encode()),'baselineTick':env['gameTime'],
        'oldHControl':rt.get('treasuryT1FirstLiveControl'),'oldHQuota':rt.get('treasuryProductionT1Quota'),'oldKernel':rt.get('treasuryCore'),
        't2QuotaAbsent':True,'t2ControlAbsent':True,'t2RingAbsent':True,'paused':True}
    with (RUN/'evidence'/f'{case}-independent-instance.json').open('x') as f:json.dump(record,f,ensure_ascii=False,indent=2);f.write('\n')
    subprocess.run(['systemd-run','--unit=screeps-treasury-t1','--collect','--property=WorkingDirectory='+str(ROOT/'server'),str(ROOT/'r4/start-uts.sh')],check=True)
    time.sleep(2)
def align(case):
    capture(case+'-before-setup')
    if artifact(case+'-before-setup','snapshot')['tick']%5==0:
        until(case+'-align','ticks','1')
def setup(case,amount,enabled=True):
    independent_instance(case)
    align(case)
    call('setup',case+'-setup',json.dumps({'case':case,'amount':amount,'enabled':enabled,'independentSyntheticInstance':True},separators=(',',':')))
def restart(label):
    assert label in ('c2-unknown-restart','c3-closed-restart')
    subprocess.run(['systemctl','stop','screeps-treasury-t1'],check=True)
    # service 已停止后备份；旧备份与旧证据不覆盖。
    subprocess.run(['cp','-p',str(ROOT/'server/db.json'),str(RUN/f'db-before-{label}.json')],check=True)
    subprocess.run(['systemd-run','--unit=screeps-treasury-t1','--collect',
        '--property=WorkingDirectory='+str(ROOT/'server'),str(ROOT/'r4/start-uts.sh')],check=True)
    time.sleep(2)

def c1(case,amount):
    setup(case,amount)
    arm(case)
    capture(case+'-before-native')
    until(case+'-native-driver','native')
    capture(case+'-real-native')
    until(case+'-settle-driver','settled')
    capture(case+'-first-settlement')
    until(case+'-repeat-recovery-driver','ticks','2')
    capture(case+'-recovered-no-rededuct')
    if amount>100:
        until(case+'-ordinary-driver','task-done','lab-t2-'+case+'-UH')
        capture(case+'-ordinary-restored')

def c2():
    case='c2'
    setup(case,100)
    call('ordinary','c2-pre-source','E4N58,W9N8,H')
    call('ordinary','c2-pre-target','E1N57,W8N8,H')
    capture('c2-ordinary-pre-baseline')
    arm(case)
    until('c2-conflict-driver','conflict','lab-t2-c2-pre-source-ordinary,lab-t2-c2-pre-target-ordinary')
    capture('c2-ordinary-pre-observed')
    until('c2-native-driver','native')
    capture('c2-real-native')
    call('fault','c2-inject-contradiction')
    call('ordinary','c2-block-source','E4N58,W9N8,H')
    call('ordinary','c2-block-target','E1N57,W8N8,H')
    call('ordinary','c2-unrelated','W8N8,E3N59,H')
    call('queue','c2-request-off','Memory.cfg.treasuryTerminalTransferT2.mode="off"')
    until('c2-unknown-off-driver','ticks','6')
    capture('c2-unknown-off-held')
    until('c2-unrelated-driver','task-done','lab-t2-c2-unrelated-ordinary')
    capture('c2-unrelated-native-while-unknown')
    call('carrier','c2-carrier-target','E1N57,lab-t2-target-carrier,H')
    call('queue','c2-carrier-target-plan','global.__creepAssignmentState=global.__creepAssignmentState||Object.create(null);global.__creepAssignmentState["lab-t2-target-carrier"]={synthesisCarrierPendingToId:Game.rooms.E1N57.terminal.id,synthesisCarrierPendingResource:"H",synthesisCarrierPendingTaskType:"terminal_feed",carrierStorageOnlyMode:false}')
    until('c2-carrier-target-driver','ticks','2')
    capture('c2-carrier-target-held')
    call('carrier','c2-carrier-source','E4N58,lab-r2-carrier,H')
    call('queue','c2-carrier-source-plan','global.__creepAssignmentState=global.__creepAssignmentState||Object.create(null);global.__creepAssignmentState["lab-r2-carrier"]={synthesisCarrierPendingToId:Game.rooms.E4N58.terminal.id,synthesisCarrierPendingResource:"H",synthesisCarrierPendingTaskType:"terminal_feed",carrierStorageOnlyMode:false}')
    until('c2-carrier-source-driver','ticks','2')
    capture('c2-carrier-source-held')
    # 责任存在时故意失联，真实wall clock；既不延长心跳也不清attempt。
    control=json.loads(artifact('c2-real-native','snapshot')['rawMemory'])['runtime']['treasuryT2FirstLiveControl']
    remaining=max(0,(control['controlUntilMs']+3000-int(time.time()*1000))/1000)
    while remaining>0:
        delay=min(remaining,30);time.sleep(delay);remaining-=delay
    restart('c2-unknown-restart')
    until('c2-post-restart-driver','ticks','2')
    capture('c2-unknown-after-real-restart')
    # 这个已持货装夹使用堆内plan；真实reset后明确恢复同一合成plan，不伪称它自身持久化。
    call('queue','c2-carrier-source-plan-after-reset','global.__creepAssignmentState=global.__creepAssignmentState||Object.create(null);global.__creepAssignmentState["lab-r2-carrier"]={synthesisCarrierPendingToId:Game.rooms.E4N58.terminal.id,synthesisCarrierPendingResource:"H",synthesisCarrierPendingTaskType:"terminal_feed",carrierStorageOnlyMode:false};global.__creepAssignmentState["lab-t2-target-carrier"]={synthesisCarrierPendingToId:Game.rooms.E1N57.terminal.id,synthesisCarrierPendingResource:"H",synthesisCarrierPendingTaskType:"terminal_feed",carrierStorageOnlyMode:false}')
    until('c2-carrier-source-post-reset-driver','ticks','2')
    capture('c2-carrier-source-after-reset-held')
    call('restore','c2-restore-true-store')
    until('c2-restored-settle-driver','settled')
    capture('c2-first-restored-settlement')
    until('c2-restored-source-driver','task-done','lab-t2-c2-block-source-ordinary')
    until('c2-restored-target-driver','task-done','lab-t2-c2-block-target-ordinary')
    until('c2-carrier-restored-driver','ticks','3')
    capture('c2-confirmed-ordinary-and-carrier-restored')

def c3():
    setup('c3',100,False)
    arm('c3')
    capture('c3-armed-bound-no-responsibility')
    control=json.loads(artifact('c3-armed-bound-no-responsibility','snapshot')['rawMemory'])['runtime']['treasuryT2FirstLiveControl']
    remaining=max(0,(control['controlUntilMs']+3000-int(time.time()*1000))/1000)
    while remaining>0:
        delay=min(remaining,30);time.sleep(delay);remaining-=delay
    call('queue','c3-enable-ordinary','Memory.cfg.resourceControl.enabled=true')
    until('c3-expired-ordinary-driver','task-done','lab-t2-c3-UH')
    capture('c3-expired-ordinary-restored')
    restart('c3-closed-restart')
    until('c3-restart-driver','ticks','4')
    capture('c3-off-after-real-restart')

case=sys.argv[1]
assert case in ('c1-1715','c1-100','c2','c3')
if case=='c1-1715':c1(case,1715)
if case=='c1-100':c1(case,100)
if case=='c2':c2()
if case=='c3':c3()
