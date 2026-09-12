'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const F=require('./fixture.cjs'),C=require('../runtime/common.cjs');
function executeFixture(options){const root=F.tmp(),run=path.join(root,'run');fs.mkdirSync(run);const s=F.session();F.save(run,s);
 C.durable(path.join(root,'fake-world.json'),{s,modules:s.backup.modules,mode:'backup',writes:0,reports:F.reports(s,{partialFirst:true}),...options});
 const r=cp.spawnSync(process.execPath,[path.join(__dirname,'process-runner.cjs')],{env:{...process.env,CPU_DIAG_FIXTURE_ROOT:root,NODE_OPTIONS:'--require='+JSON.stringify(path.join(__dirname,'process-fixture.cjs').split(path.sep).join('/'))},encoding:'utf8',timeout:20000,maxBuffer:3*1048576});
 assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return {root,run,world:C.readJson(path.join(root,'fake-world.json')),...C.readJson(path.join(root,'test-result.json'))};}
test('real child collector and independent recovery worker capture hex-encoded partial then close',()=>{const r=executeFixture({});
 assert.equal(r.world.writes,2);assert.equal(r.verified.status,'CPU_DIAGNOSTIC_CAPTURE_VERIFIED');assert.equal(r.verified.diagnosticReports,4);assert.equal(r.verified.completeSamples,3);assert.equal(r.verified.partialCpuSamples,1);assert.equal(r.verified.analysis.completeTailProfiles,3);
 assert.equal(r.verified.closure,'RESTORED_BYTES_AND_RUNTIME_VERIFIED');assert.equal(r.result.guardExit,0);assert.equal(r.result.collectorExit,0);assert.deepEqual(r.verified.issues,[]);});
test('lost restore POST response is resolved independently without resend',()=>{const r=executeFixture({lostRestoreReply:true});assert.equal(r.world.writes,2);assert.equal(r.verified.captureVerified,true);});
test('real collector transport failure still reaches new recovery-only stream',()=>{const r=executeFixture({failCollector:true});assert.equal(r.world.writes,2);assert.equal(r.verified.captureVerified,false);assert.equal(r.verified.closure,'RESTORED_BYTES_AND_RUNTIME_VERIFIED');});
test('sample decoding failure does not cut off safety closeout',()=>{const r=executeFixture({corruptReport:true});assert.equal(r.world.writes,2);assert.equal(r.verified.captureVerified,false);assert.equal(r.verified.closure,'RESTORED_BYTES_AND_RUNTIME_VERIFIED');assert.ok(r.verified.issues.includes('BRIDGE_JSON_INVALID'));});
test('exited recovery worker enables supervisor using the same one-use marker',()=>{const r=executeFixture({crashGuard:true});assert.equal(r.world.writes,2);assert.equal(r.verified.captureVerified,false);assert.equal(r.verified.closure,'RESTORED_BYTES_AND_RUNTIME_VERIFIED');assert.equal(r.verified.restoration.selectedActor,'supervisor');});
module.exports={executeFixture};

for(const [tamper,issue] of [['profile','CPU_PHASE_SUM_INVALID'],['runtime-footer','RESTORE_CLOSURE_INCOMPLETE'],['postflight','RESTORE_CLOSURE_INCOMPLETE'],['write-boundary','WRITE_QUOTA_INVALID']])test('independent verifier rejects '+tamper+' raw evidence mutation',()=>{const r=executeFixture({tamper});assert.equal(r.verified.captureVerified,false);assert.ok(r.verified.issues.includes(issue),JSON.stringify(r.verified.issues));});
