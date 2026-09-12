'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('./fixture.cjs'),{completeEvidence}=require('./full-evidence.cjs'),V=require('../runtime/verify-run.cjs'),C=require('../runtime/common.cjs');
function trial(fn){const d=F.runDir(),s=F.makeSession(),old=C.ORIGINAL_DIGEST;C.ORIGINAL_DIGEST=s.backup.digest;try{const f=completeEvidence(d,s);fn(d,s,f);}finally{C.ORIGINAL_DIGEST=old;fs.rmSync(d,{recursive:true,force:true});}}
function edit(d,n,fn){const p=path.join(d,n),x=JSON.parse(fs.readFileSync(p));fn(x);fs.writeFileSync(p,JSON.stringify(x));}
test('independent raw-log verification accepts a complete 12-slot restored observation',()=>trial(d=>{const r=V.verifyRun(d);assert.equal(r.status,'ONLINE_COMPAT_READ_OBSERVED');assert.equal(r.closure,'RESTORED');assert.equal(r.cpuIncludingEmit.length,11);}));
for(const[n,file,fn,issue]of[
 ['missing source closure','source-closed.json',x=>x.sameTreeAsCompatBase=false,'SOURCE_NOT_CLOSED'],
 ['uncertain upload','upload-result.json',x=>x.result.confirmed=false,'UPLOAD_UNCONFIRMED'],
 ['changed restore bytes','restore-independent-after.json',x=>x.checks[0].sameAsBackup=false,'RESTORE_CONFIRMATION_INCOMPLETE'],
 ['missing footer flag','collector-result.json',x=>x.footerWritten=false,'COLLECTOR_TERMINAL_INVALID'],
 ['failed guard','guard-result.json',x=>x.reason='WALL_DEADLINE','GUARD_NOT_NORMAL_COMPLETION'],
 ['different runtime PID','runtime-confirmation.json',x=>x.collectorPid=101,'POST_RESTORE_PID_CHANGED'],
 ['driver failure','driver-result.json',x=>x.failure={error:'FAILED'},'DRIVER_OR_PROCESS_FAILURE']
])test('independent verifier rejects '+n,()=>trial(d=>{edit(d,file,fn);assert.ok(V.verifyRun(d).issues.includes(issue));}));
test('raw missing sample cannot be hidden by healthy guard summary',()=>trial((d,s,f)=>{const lines=f.lines.filter(x=>!x.text?.includes('\\"tick\\":'+(s.profile.startTick+400)));fs.writeFileSync(path.join(d,'console.jsonl'),lines.map(x=>JSON.stringify(x)).join('\n'));assert.equal(V.verifyRun(d).observed,false);}));
test('duplicate footer is rejected',()=>trial((d,s,f)=>{fs.appendFileSync(path.join(d,'console.jsonl'),JSON.stringify(f.lines.at(-1))+'\n');assert.ok(V.verifyRun(d).issues.includes('FOOTER_INVALID'));}));
test('long console gap is rejected rather than relying on row counts',()=>trial((d,s,f)=>{const lines=f.lines.filter(x=>!(x.text?.includes('/console')&&Date.parse(x.receivedAt)>f.confirmStart+1000&&Date.parse(x.receivedAt)<f.confirmStart+60000));fs.writeFileSync(path.join(d,'console.jsonl'),lines.map(x=>JSON.stringify(x)).join('\n'));assert.ok(V.verifyRun(d).issues.includes('RESTORED_CONSOLE_COVERAGE'));}));
test('retained action lock prevents a successful final label',()=>trial(d=>{fs.writeFileSync(path.join(d,'action.lock'),'{}');assert.ok(V.verifyRun(d).issues.includes('RESIDUAL_ACTION.LOCK'));}));
