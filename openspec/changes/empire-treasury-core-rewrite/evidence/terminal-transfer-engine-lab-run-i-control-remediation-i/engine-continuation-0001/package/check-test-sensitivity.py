"""Offline sensitivity check. Mutate temporary copies only; never touch a game."""
from pathlib import Path
import json, os, shutil, subprocess, tempfile
w=Path(__file__).resolve().parent
root=w/'review-source'
rel=Path('test/lab/terminal-transfer/tools')
new=(root/rel/'independent.spec.cjs').read_bytes()
old=(w/'test-before.cjs').read_bytes()
mem=(root/rel/'memory-control.cjs').read_text()
stop=(root/rel/'stop-controller.cjs').read_text()
needle='record.armed !== expected.armed || '
assert mem.count(needle)==1
always="if (check.issues.some(issue => issue !== 'two player ticks required'))"
assert stop.count(always)==1
env=dict(os.environ)
env['NODE_PATH']=subprocess.check_output(['npm','root','-g'],text=True).strip()
records=[]
for test_name,test_bytes in [('old',old),('refined',new)]:
 for mutation in ['none','ignore-armed','reject-all-controls']:
  with tempfile.TemporaryDirectory(prefix='screeps-test-sensitivity-') as tmp:
   scratch=Path(tmp)/'selected-source'; shutil.copytree(root,scratch)
   (scratch/rel/'independent.spec.cjs').write_bytes(test_bytes)
   if mutation=='ignore-armed':
    (scratch/rel/'memory-control.cjs').write_text(mem.replace(needle,''))
   elif mutation=='reject-all-controls':
    (scratch/rel/'stop-controller.cjs').write_text(stop.replace(always, "if (true || check.issues.some(issue => issue !== 'two player ticks required'))"))
   command=['node','--test','--test-name-pattern','^control mode ',str(rel/'independent.spec.cjs')]
   run=subprocess.run(command,cwd=scratch,env=env,capture_output=True,timeout=12)
   name=f'sensitivity-{test_name}-{mutation}'
   for suffix,data in [('stdout.tap',run.stdout),('stderr.log',run.stderr),('exit-code.txt',f'{run.returncode}\n'.encode())]:
    (w/'validation'/f'{name}.{suffix}').write_bytes(data)
   expected=1 if test_name=='refined' and mutation!='none' else 0
   records.append({'test':test_name,'mutation':mutation,'command':command,'exit_code':run.returncode,'expected_exit_code':expected,'matched':run.returncode==expected})
   print(test_name,mutation,run.returncode,'expected',expected)
(w/'validation'/'sensitivity-results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
assert all(x['matched'] for x in records), 'Sensitivity result differs; inspect raw output'
