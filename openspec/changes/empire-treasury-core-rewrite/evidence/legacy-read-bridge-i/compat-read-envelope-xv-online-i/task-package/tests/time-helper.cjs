'use strict';
const path=require('node:path'),crypto=require('node:crypto');
function seed(dir,T=require('../runtime/time-budget.cjs'),C=require('../runtime/common.cjs'),options={}) {
 const id=crypto.randomBytes(16).toString('hex'),wallBase=Date.now()-201000;
 const c={id,now:200000,wallOffset:wallBase,mono(){return this.now;},wall(){return this.wallOffset+this.now;}};
 function row(tick,mono,purpose='rate-measurement') {return {runId:C.POLICY.parentRunId,id:crypto.randomBytes(16).toString('hex'),clockId:id,pid:process.pid,purpose,ok:true,tick,sentMonoMs:mono,receivedMonoMs:mono,sentAtMs:wallBase+mono,receivedAtMs:wallBase+mono};}
 const rows=Array.from({length:7},(_,i)=>row(i*5,i*20000));
 if(options.slow)for(const [i,r]of rows.entries()){r.tick=i;}
 for(const r of rows)C.append(path.join(dir,'time-observations.jsonl'),r);
 const m=T.measurement(rows); C.durable(path.join(dir,'timing-measurement.json'),m);
 const binding=row(50,190000,'bind-preflight');C.append(path.join(dir,'time-observations.jsonl'),binding);
 const profile=require('../tools/repository.cjs').profileFor(50);T.admit(dir,binding,profile,'binding');
 return {clock:c,profile,row,rows,measurement:m,binding,
  upload(){const r=row(50,200000,'upload-preflight');C.append(path.join(dir,'time-observations.jsonl'),r);return T.admit(dir,r,profile,'upload');},
  sessionFields(){return {timingMeasurementFileSha256:C.sha(C.bytes(path.join(dir,'timing-measurement.json'))),timingBindingFileSha256:C.sha(C.bytes(path.join(dir,'timing-binding.json')))};},
  markerFields(){return {wallBudgetMs:C.POLICY.wallMs,wallDeadlineAtMs:c.wall()+C.POLICY.wallMs,timingAdmissionSha256:C.sha(C.bytes(path.join(dir,'timing-upload.json')))};}};
}
module.exports={seed};
