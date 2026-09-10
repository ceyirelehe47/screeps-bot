"""Local bridge-only fault seeding. Does not modify delivered templates or Git."""
import os, pathlib, shutil, subprocess, tempfile, json, hashlib
root=pathlib.Path(__file__).resolve().parents[1]
source=root/'templates/treasuryCompatRead.ts'
original=source.read_text()
mutations={
 'invent_spendable': ('spendable: null, kernelLifecycleRun: false', 'spendable: 999, kernelLifecycleRun: false'),
 'missing_as_empty': ('if (found.status !== "present") return { status: found.status, count: null, value: undefined };', 'if (found.status !== "present") return { status: "empty", count: 0, value: {} };'),
 'accidental_memory_write': ('const memory = ports.memory();', 'const memory = ports.memory();\n      (memory as Record<string, unknown>).__compatAccidentalWrite = true;'),
 'reuse_changed_capacity': ('old.id !== d.value.id || old.capacity !== d.value.capacity', 'old.id !== d.value.id'),
}
results=[]
for name,(old,new) in mutations.items():
 assert original.count(old)==1,(name,original.count(old))
 with tempfile.TemporaryDirectory(prefix='compat-mutation-') as temp:
  work=pathlib.Path(temp)
  shutil.copytree(root/'templates',work/'templates')
  shutil.copytree(root/'tests',work/'tests')
  (work/'templates/treasuryCompatRead.ts').write_text(original.replace(old,new))
  p=subprocess.run(['node','--test',str(work/'tests/bridge.spec.cjs')],text=True,capture_output=True,timeout=35,env=os.environ.copy())
  (root/'validation'/f'mutant-{name}.stdout.log').write_text(p.stdout)
  (root/'validation'/f'mutant-{name}.stderr.log').write_text(p.stderr)
  results.append({'mutation':name,'exitCode':p.returncode,'detected':p.returncode!=0})
assert source.read_text()==original
(root/'validation'/'mutations.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
assert all(r['detected'] for r in results)
