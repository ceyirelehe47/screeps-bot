'use strict';
const path=require('node:path'),C=require('../runtime/common.cjs');
function analyze(dir,verification){
 const reads=C.jsonl(path.join(dir,'time-observations.jsonl'));
 const measurement=C.optional(dir,'timing-measurement.json'),binding=C.optional(dir,'timing-binding.json'),upload=C.optional(dir,'timing-upload.json');
 const worker=reads.filter(r=>r.purpose==='worker-progress'&&r.ok===true);
 return {kind:'XIV-retry-I-time-budget-analysis/v1',runId:C.POLICY.parentRunId,
   capture:verification.status,closure:verification.closure,
   measurement,binding,upload,independentVerification:verification.timeAdmission||null,
   successfulTimeReads:reads.filter(r=>r.ok).length,failedTimeReads:reads.filter(r=>!r.ok).length,
   workerProgress:{count:worker.length,firstTick:worker[0]?.tick??null,lastTick:worker.at(-1)?.tick??null},
   closing:C.optional(dir,'closing.json'),failure:C.optional(dir,'execution-failure.json'),
   interpretation:'Admission is a conservative estimate, not a guarantee. Fixed wall limit is never extended. Missing samples and not_called remain distinct from zero-cost work.',
   engineCpuGapRepaired:false};
}
module.exports={analyze};
