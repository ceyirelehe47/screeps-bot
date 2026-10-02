#!/usr/bin/env python3
"""在已许可实验主机运行冻结 main 的 C1/C2/C3；不接触正式服或凭据。"""
import hashlib, json, socket, subprocess, sys, time
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
def wait_lab():
    deadline=time.time()+30
    while time.time()<deadline:
        try:
            for host,port in [('::1',21027),('127.0.0.1',21026),('127.0.0.1',21025)]:
                with socket.create_connection((host,port),timeout=.5):pass
            return
        except OSError:time.sleep(.25)
    raise RuntimeError('隔离服务回环端口未就绪')
def arm(case):
    s=artifact(case+'-setup','setup')
    for i in range(4):
        label=case+'-arm'+('' if i==0 else '-retry-'+str(i))
        expression=f'Memory.runtime.__labT2ArmResult=armTreasuryT2FirstLive({json.dumps(s["taskId"])},{s["tick"]});Memory.runtime.__labT2ArmResultTick=Game.time;Memory.runtime.__labT2ArmResultNonce={json.dumps(label)}'
        call('queue',label,expression)
        until(label+'-executed','arm-observed',label)
        result=artifact(label+'-executed','driver')['last']['arm']
        if result['ok']:return
        if result['reason']!='terminal_action_this_tick':raise RuntimeError('产品正确拒绝arm:'+json.dumps(result))
    raise RuntimeError('旧actor连续触碰终端，4tick内未取得合法arm窗口')
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
    if subprocess.run(['systemctl','is-active','--quiet','screeps-treasury-t1']).returncode==0:
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
    wait_lab()
def align(case):
    capture(case+'-before-setup')
    if artifact(case+'-before-setup','snapshot')['tick']%5==0:
        until(case+'-align','ticks','1')
def setup(case,amount,enabled=True,taskMaxPerRun=5):
    independent_instance(case)
    align(case)
    call('setup',case+'-setup',json.dumps({'case':case,'amount':amount,'enabled':enabled,'taskMaxPerRun':taskMaxPerRun,'independentSyntheticInstance':True},separators=(',',':')))
def persisted_database(label):
    capture(label+'-before-persistence')
    s=artifact(label+'-before-persistence','snapshot')
    deadline=time.time()+25
    while time.time()<deadline:
        try:
            raw=(ROOT/'server/db.json').read_bytes();d=json.loads(raw)
            cs={c['name']:c['data'] for c in d['collections']};e=cs['env'][0]['data']
            code=next(c for c in cs['users.code'] if c.get('user')=='7dad41a4bfc9d96' and c.get('activeWorld'))
            objects={o['_id']:o for o in cs['rooms.objects']}
            stores_ok=all(objects.get(o['_id'],{}).get('store')==o.get('store') for o in s['objects'] if o.get('user')=='7dad41a4bfc9d96')
            tx_ids={t['_id'] for t in cs['transactions']}
            if (e.get('memory:7dad41a4bfc9d96')==s['rawMemory'] and stores_ok and
                hashlib.sha256(code['modules']['main'].encode()).hexdigest()==s['code']['sha256'] and
                all(t['_id'] in tx_ids for t in s['transactions'])):
                result={'schema':'screeps-t2-paused-database-persistence/v1','isolatedWorldOnly':True,
                    'capturedAtUtc':datetime.now(timezone.utc).isoformat(),'snapshotLabel':s['label'],
                    'databaseSha256':hashlib.sha256(raw).hexdigest(),'memorySha256':hashlib.sha256(s['rawMemory'].encode()).hexdigest(),
                    'codeSha256':s['code']['sha256'],'transactions':len(s['transactions']),'tick':e['gameTime']}
                with (RUN/'evidence'/f'{label}-persistence.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
                return raw
        except (ValueError,KeyError,StopIteration):pass
        time.sleep(.3)
    raise RuntimeError('paused live Memory/code/Store/transactions not persisted within 25 seconds')
def restart(label):
    assert label in ('c2-unknown-restart','c3-closed-restart')
    backup=RUN/f'db-before-{label}.json'
    assert not backup.exists(), '只追加私有备份，拒绝覆盖'
    persisted_database(label)
    subprocess.run(['systemctl','stop','screeps-treasury-t1'],check=True)
    # service 已停止后备份；旧备份与旧证据不覆盖。
    with backup.open('xb') as f:f.write((ROOT/'server/db.json').read_bytes())
    subprocess.run(['systemd-run','--unit=screeps-treasury-t1','--collect',
        '--property=WorkingDirectory='+str(ROOT/'server'),str(ROOT/'r4/start-uts.sh')],check=True)
    wait_lab()

def carrier_plan(label,plans):
    # 只记录真实调度对原.work的调用；不改原role选择、动作调用、决策或返回值。
    expression='global.__creepAssignmentState=global.__creepAssignmentState||Object.create(null);'
    for name,room in plans:
        expression+=f'global.__creepAssignmentState[{json.dumps(name)}]={{synthesisCarrierPendingToId:Game.rooms.{room}.terminal.id,synthesisCarrierPendingResource:"H",synthesisCarrierPendingTaskType:"terminal_feed",carrierStorageOnlyMode:false}};'
    expression+='Memory.runtime.__labT2CarrierPlanReadbacks=Memory.runtime.__labT2CarrierPlanReadbacks||[];'
    for name,room in plans:
        expression+=f'Memory.runtime.__labT2CarrierPlanReadbacks.push({{atTick:Game.time,name:{json.dumps(name)},targetId:Game.rooms.{room}.terminal.id,resource:"H",plan:{{...global.__creepAssignmentState[{json.dumps(name)}]}},storeH:Game.creeps[{json.dumps(name)}].store.H||0}});'
    expression+='if(!global.__labT2CarrierBaseWork){global.__labT2CarrierBaseWork=Creep.prototype.work;Creep.prototype.work=function(){let p=global.__creepAssignmentState?.[this.name],b=this.store.H||0,o,e=null,m={role:this.memory.role,ready:this.memory.ready,working:this.memory.working,_spawnYield:this.memory._spawnYield??null,configName:this.memory.configName??null};try{return o=global.__labT2CarrierBaseWork.apply(this,arguments)}catch(x){e=String(x);throw x}finally{if(["lab-r2-carrier","lab-t2-target-carrier"].includes(this.name)){let a=Memory.runtime.__labT2CarrierWork=Memory.runtime.__labT2CarrierWork||[];a.push({tick:Game.time,name:this.name,role:m.role,ready:m.ready,working:m.working,spawnYield:m._spawnYield,configName:m.configName,beforeH:b,afterH:this.store.H||0,toId:p?.synthesisCarrierPendingToId,resource:p?.synthesisCarrierPendingResource,roleResult:o,throwError:e,traceSchemaVersion:2});if(a.length>128)a.shift()}}}}'
    call('queue',label,expression)

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
    setup(case,100,taskMaxPerRun=2)
    call('ordinary','c2-pre-source','E4N58,W9N8,H')
    call('ordinary','c2-pre-target','E1N57,W8N8,H')
    capture('c2-ordinary-pre-baseline')
    until('c2-conflict-driver','pre-inbound','lab-t2-c2-pre-source-ordinary,lab-t2-c2-pre-target-ordinary')
    capture('c2-ordinary-pre-observed')
    arm(case)
    capture('c2-bound-after-ordinary-pre')
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
    carrier_plan('c2-carrier-target-plan',[('lab-t2-target-carrier','E1N57')])
    until('c2-carrier-target-driver','ticks','2')
    capture('c2-carrier-target-held')
    call('carrier','c2-carrier-source','E4N58,lab-r2-carrier,H')
    carrier_plan('c2-carrier-source-plan',[('lab-r2-carrier','E4N58')])
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
    carrier_plan('c2-carrier-source-plan-after-reset',[('lab-r2-carrier','E4N58'),('lab-t2-target-carrier','E1N57')])
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
    s=artifact('c3-setup','setup')
    call('queue','c3-rearm-after-close',f'Memory.runtime.__labT2RearmResult=armTreasuryT2FirstLive({json.dumps(s["taskId"])},{s["tick"]})')
    until('c3-rearm-rejected-driver','ticks','1')
    capture('c3-rearm-rejected')

if __name__=='__main__':
    case=sys.argv[1]
    assert case in ('c1-1715','c1-100','c2','c3')
    variant=sys.argv[2] if len(sys.argv)>2 else ''
    assert not variant or variant in ('r2','r3','r4','r5')
    if variant:
        assert case.startswith('c1-')
        case=case+'-'+variant
    if case.startswith('c1-1715'):c1(case,1715)
    if case.startswith('c1-100'):c1(case,100)
    if case=='c2':c2()
    if case=='c3':c3()
    completed=persisted_database(case+'-completed')
    with (RUN/f'db-{case}-completed.json').open('xb') as f:f.write(completed)
