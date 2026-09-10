#!/usr/bin/env python3
"""Mutation checks in throwaway copies ONLY. No live environment or repo writes."""
from pathlib import Path
import shutil, tempfile, subprocess, json, re
root = Path(__file__).resolve().parents[1]
file = 'src/runtime/treasury/readOnlyObservation.ts'
scenarios = {
    'drop_reservation_deduction': ('subtractOutgoing: true, subtractReservations: true, withhold: 0', 'subtractOutgoing: true, subtractReservations: false, withhold: 0'),
    'hide_resource_mismatch': ('if ((observed.amounts[r] ?? 0) !== d.amounts[r]) mismatch.push(r);', 'if (false) mismatch.push(r);'),
    'accidental_memory_write': ('const absent = () => ({ status: "absent"', 'if (object(memory)) memory.accidentalWrite = true;\n  const absent = () => ({ status: "absent"'),
    'escape_observer_fault': ('disabledByFault = true; previous = undefined;', 'throw new Error("injected uncontained observer error");'),
}
results = []
for name, (before, after) in scenarios.items():
    with tempfile.TemporaryDirectory(prefix='treasury-ro-mutant-') as tmp:
        copied = Path(tmp)/'files'; shutil.copytree(root/'files', copied)
        target = copied/file; source = target.read_text(); assert source.count(before)==1, name
        target.write_text(source.replace(before, after))
        p=subprocess.run(['node','--test','test/treasury-read-only/local.spec.cjs'],cwd=copied,text=True,capture_output=True,timeout=30)
        (root/'validation'/f'mutant-{name}.stdout.log').write_text(p.stdout)
        (root/'validation'/f'mutant-{name}.stderr.log').write_text(p.stderr)
        failed=int(re.search(r'^# fail (\d+)$',p.stdout,re.M).group(1))
        results.append({'mutation':name,'exitCode':p.returncode,'failedTests':failed,'detected':p.returncode!=0 and failed>0})
(root/'validation'/'mutation-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
assert all(r['detected'] for r in results)
