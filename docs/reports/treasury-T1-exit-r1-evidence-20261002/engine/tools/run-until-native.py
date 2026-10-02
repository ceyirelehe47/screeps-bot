#!/usr/bin/env python3
"""只推进暂停的隔离世界，首次 quota dispatching 后立即再次暂停。"""
import re,subprocess,time
cli='/srv/screeps-treasury-t1/cli-query.py'
uid='7dad41a4bfc9d96'
def query(expr):
 p=subprocess.run([cli],input=expr,text=True,capture_output=True,timeout=8,check=True)
 if 'Error:' in p.stdout:raise RuntimeError(p.stdout[:300])
 return p.stdout
expr="(async()=>{const m=JSON.parse(await storage.env.get(storage.env.keys.MEMORY+'"+uid+"')||'{}');return m.runtime?.treasuryProductionT1Quota?.status==='dispatching'?1:0})()"
query("storage.env.set(storage.env.keys.MAIN_LOOP_PAUSED,'0')")
try:
 deadline=time.monotonic()+25
 while time.monotonic()<deadline:
  x=query(expr)
  if re.search(r"<\s*'?1'?",x):break
  time.sleep(.05)
 else:raise TimeoutError('no dispatching quota within 25 seconds')
finally:query("storage.env.set(storage.env.keys.MAIN_LOOP_PAUSED,'1')")
time.sleep(.4)
print('firstDispatchingObserved=1 paused=1')
