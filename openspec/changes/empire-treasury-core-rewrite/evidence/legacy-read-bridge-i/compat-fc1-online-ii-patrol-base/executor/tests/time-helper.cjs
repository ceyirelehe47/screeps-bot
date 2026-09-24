'use strict';
// Deterministic complete selection evidence for unit fixtures, never used by runtime.
const path=require('node:path'),crypto=require('node:crypto'),fs=require('node:fs');
function seed(dir,T=require('../runtime/time-budget.cjs'),C=require('../runtime/common.cjs'),options={}) {
 const owner=Object.values(require.cache).find(m=>m.exports===T);
 const Sel=require(path.join(path.dirname(owner.filename),'window-selection.cjs'));
 const id=crypto.randomBytes(16).toString('hex'),wallBase=Date.now()-201000;
 const c={id,now:0,wallOffset:wallBase,mono(){return this.now;},wall(){return this.wallOffset+this.now;}};
 function row(tick,mono,purpose='rate-measurement') {return {runId:C.POLICY.parentRunId,id:crypto.randomBytes(16).toString('hex'),clockId:id,pid:process.pid,purpose,ok:true,tick,sentMonoMs:mono,receivedMonoMs:mono,sentAtMs:wallBase+mono,receivedAtMs:wallBase+mono};}
 const root=path.join(dir,'window-selection'),rd=path.join(root,'round-01');fs.mkdirSync(rd,{recursive:true});
 const start=Sel.startRecord(c);C.durable(path.join(root,'start.json'),start);
 const began={atMs:c.wall(),monoMs:c.mono()};C.durable(path.join(rd,'start.json'),{runId:C.POLICY.parentRunId,round:1,...began});
 const rows=Array.from({length:7},(_,i)=>row(i*5,i*20000));
 if(options.slow)for(const [i,r]of rows.entries()){r.tick=i;}
 for(const r of rows)C.append(path.join(rd,'time-observations.jsonl'),r);
 const m=T.measurement(rows);C.durable(path.join(rd,'timing-measurement.json'),m);
 const proposed=row(48,180000,'bind-preflight');C.append(path.join(rd,'time-observations.jsonl'),proposed);c.now=180000;
 Sel.decision(rd,1,'probe',proposed,m,c);
 const identityId=crypto.randomBytes(16).toString('hex');
 C.append(path.join(rd,'identities.jsonl'),{id:identityId,runId:C.POLICY.parentRunId,round:1,clockId:id,pid:process.pid,status:'CANONICAL_REVALIDATED',
   sent:{atMs:wallBase+182000,monoMs:182000},received:{atMs:wallBase+189000,monoMs:189000},
   digest:C.POLICY.backupDigest,build:C.POLICY.backupBuild,rooms:[...C.POLICY.rooms].sort()});
 const binding=row(50,190000,'bind-preflight');C.append(path.join(rd,'time-observations.jsonl'),binding);c.now=190000;
 const selected=Sel.decision(rd,1,'after_identity',binding,m,c,identityId);
 C.durable(path.join(rd,'result.json'),{runId:C.POLICY.parentRunId,round:1,reason:'SELECTED',selectedOrdinal:2,started:began,ended:{atMs:c.wall(),monoMs:c.mono()}});
 const promoted=Sel.promote(dir,1,selected);Sel.seal(dir,start,1,'WINDOW_SELECTED','FIRST_ADMISSIBLE_REVALIDATED_PROPOSAL',promoted,c);
 const profile=selected.profile;c.now=200000;
 return {clock:c,profile,row,rows,measurement:m,binding,
   upload(){const r=row(50,200000,'upload-preflight');C.append(path.join(dir,'time-observations.jsonl'),r);return T.admit(dir,r,profile,'upload');},
   sessionFields(){return {windowSelectionFileSha256:C.sha(C.bytes(path.join(root,'result.json'))),timingMeasurementFileSha256:C.sha(C.bytes(path.join(dir,'timing-measurement.json'))),timingBindingFileSha256:C.sha(C.bytes(path.join(dir,'timing-binding.json')))};},
   markerFields(){return {wallBudgetMs:C.POLICY.wallMs,wallDeadlineAtMs:c.wall()+C.POLICY.wallMs,timingAdmissionSha256:C.sha(C.bytes(path.join(dir,'timing-upload.json')))};}};
}
module.exports={seed};
