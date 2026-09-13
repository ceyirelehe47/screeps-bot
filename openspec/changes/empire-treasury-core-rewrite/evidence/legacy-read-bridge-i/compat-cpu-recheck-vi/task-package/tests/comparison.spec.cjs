'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),U=require('../tools/util.cjs');
const P=require('../tools/prerequisites.cjs'),M=require('../tools/compare.cjs'),F=require('./fixture.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const prior=()=>C.readJson(path.join(U.ROOT,'references/diagnostic-II-result.json')); // Historical regression oracle only; runtime comparison uses packaged IV.
function current(){const v=clone(prior());v.runId='e'.repeat(32);v.profileHead='f'.repeat(40);return v;}
test('VI adapted regression: prior comparison reference is the exact accepted Git blob, not rounded table data',()=>{
 const p=P.LOCK.priorDiagnostic,b=fs.readFileSync(path.join(U.ROOT,p.file));assert.equal(C.blob(b),'6837368a22db1fe4de9c74be3120d6af106f59cb');assert.equal(b.length,13915);assert.equal(prior().diagnosticReports,4);
});
test('VI adapted regression: loader acceptance binds the newly accepted source, not the CPU I predecessor',()=>{const {accepted}=P.packaged();assert.equal(accepted.compatHead,K.COMPAT);assert.equal(accepted.status,'READ_V_OFFLINE_VERIFIED_NOT_DEPLOYED');});
test('VI adapted regression: prerequisite read checks both exact Git commit and repository path',()=>{
 const saved=U.git,seen=[];U.git=(repo,args,buffer)=>{assert.equal(repo,'fixture');assert.equal(buffer,true);seen.push(args);const e=Object.values(P.LOCK).find(x=>args[1]===x.commit+':'+x.path);assert.ok(e);return fs.readFileSync(path.join(U.ROOT,e.file));};
 try{assert.equal(P.checkPrerequisites('fixture').status,'READ_VI_PREREQUISITES_VERIFIED');assert.equal(seen.length,2);}finally{U.git=saved;}
});
test('VI adapted regression: mutated prerequisite cannot pass by merely preserving its success label',()=>{const p=P.LOCK.priorDiagnostic,b=fs.readFileSync(path.join(U.ROOT,p.file));assert.throws(()=>P.checkedBytes(Buffer.from(b.toString().replace('2.5783225','2.4783225')),p),e=>e.code==='PREREQUISITE_BYTES_MISMATCH');});
test('VI adapted regression: source lock pins loader definitions, generator and unchanged CPU boundary together',()=>{
 const lock=require('../references/source-lock.json');assert.equal(lock['src/runtime/treasuryCompatReadCore.generated.ts'].blob,'fe94ebece8f5118b76701007ce3906adfbb4da08');
 assert.equal(lock['src/runtime/treasuryCompatCpu.ts'].blob,'46ba986151dd115250e1c5bebd95c970c0fcf9af');assert.ok(lock['scripts/build-treasury-compat-loader.cjs']);assert.ok(lock['scripts/lib/treasury-compat-loader.template.txt']);
});
test('VI adapted regression: full frozen source slice passes, replacing only generated loader with old bytes fails',()=>{
 const root=F.tmp(),lock=require('../references/source-lock.json');
 for(const rel of Object.keys(lock)){
  const candidate=path.join(U.ROOT,'references/read-V',rel),fallback=path.join(U.ROOT,'references',path.basename(rel));
  const src=fs.existsSync(candidate)?candidate:fallback;assert.ok(fs.existsSync(src),rel);
  const out=path.join(root,rel);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(src,out);
 }
 const {verifyFrozen}=require('../runtime/check-profile.cjs');assert.equal(verifyFrozen(root),true);
 fs.copyFileSync(path.join(U.ROOT,'references/read-V/test/treasury-compat/fixtures/core-before-loader-optimization.ts.txt'),path.join(root,'src/runtime/treasuryCompatReadCore.generated.ts'));
 assert.throws(()=>verifyFrozen(root),e=>e.code==='FROZEN_SOURCE_CHANGED');
});
test('VI adapted regression: first admitted sample and first real reader invocation are distinct in actual baseline',()=>{
 const m=M.measures(prior());assert.equal(m.firstAdmittedTick,73654400);assert.equal(m.firstReaderInvocationTick,73654500);assert.equal(m.firstAdmissionIsFirstReaderInvocation,false);
});
test('VI adapted regression: subsequent loader median excludes first initialization and uninvoked points',()=>{const m=M.measures(prior()).invocations.readerLoad;assert.equal(m.count,3);assert.equal(m.followingInvocationCount,2);assert.equal(m.firstInvocation.inclusiveInterval,0.5945108000014443);assert.equal(m.followingInvokedIntervalMedian,(1.6839718999981415+1.1415482000011252)/2);});
test('VI adapted regression: observation gate-only intervals never become fast builder measurements',()=>{const m=M.measures(prior()).invocations.observationBuild;assert.equal(m.count,1);assert.equal(m.allInvokedIntervalMedian,0.71176170000399);assert.equal(m.boundaryOnlyIntervals.length,2);assert.equal(m.followingInvokedIntervalMedian,null);});
test('VI adapted regression: commitment cost stays unknown when all four invocation counts are zero',()=>{const m=M.measures(prior()).invocations.commitmentBuild;assert.equal(m.count,0);assert.equal(m.allInvokedIntervalMedian,null);assert.equal(m.boundaryOnlyIntervals[0].interval,0.01618890000099782);});
test('VI adapted regression: previous raw accepted artifact remains unchanged during interpretation',()=>{const p=prior(),s=JSON.stringify(p);M.compareResults(current(),p);assert.equal(JSON.stringify(p),s);});
test('VI adapted regression: lower observed post-first median is descriptive, not causal speedup or repaired budget',()=>{const v=current();for(const r of v.analysis.rows.slice(2))r.phaseIntervals.readerLoad=0.3;const x=M.compareResults(v,prior());assert.equal(x.postFirstReaderInvocationComparison.relation,'lower_observed_median');assert.equal(x.interpretation.causalSpeedupClaim,false);assert.equal(x.interpretation.engineCpuGapRepaired,false);assert.equal(x.currentCaptureVerified,true);});
test('VI adapted regression: a higher loader cost still records a successful capture without making performance a gate',()=>{const v=current();for(const r of v.analysis.rows.slice(2))r.phaseIntervals.readerLoad=3;const x=M.compareResults(v,prior());assert.equal(x.postFirstReaderInvocationComparison.relation,'higher_observed_median');assert.equal(x.status,'READ_VI_COMPARISON_RECORDED');assert.equal(x.postFirstReaderInvocationComparison.lowerCostRequiredForCaptureAcceptance,false);});
test('VI adapted regression: equal observed median is retained rather than forced into an improvement label',()=>{assert.equal(M.compareResults(current(),prior()).postFirstReaderInvocationComparison.relation,'equal_observed_median');});
test('VI adapted regression: too few post-first invocations are insufficient, not a reason to add a fifth point',()=>{const v=current();v.analysis.rows[3].calls.readerLoad=0;const x=M.compareResults(v,prior());assert.equal(x.postFirstReaderInvocationComparison.relation,'insufficient_following_invocations');assert.equal(x.current.measurements.lastSampleTail,'unobservable without a successor; no fifth point');});
test('VI adapted regression: all uninvoked loader samples yield null medians and no fake initialization',()=>{const v=current();v.analysis.rows.forEach(r=>{r.calls={readerLoad:0,observationBuild:0,commitmentBuild:0};});const x=M.measures(v);assert.equal(x.firstReaderInvocationTick,null);assert.equal(x.invocations.readerLoad.allInvokedIntervalMedian,null);});
test('VI adapted regression: missing phase interval for a claimed invocation cannot silently become zero',()=>{const v=current();delete v.analysis.rows[1].phaseIntervals.observationBuild;assert.throws(()=>M.measures(v),e=>e.code==='COMPARISON_INVOCATION_INTERVAL_MISSING');});
test('VI adapted regression: failed current verification never becomes a valid comparison just because values exist',()=>{const v=current();v.captureVerified=false;v.status='CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE';const x=M.compareResults(v,prior());assert.equal(x.status,'READ_VI_COMPARISON_INCONCLUSIVE');assert.equal(x.currentCaptureVerified,false);assert.equal(x.postFirstReaderInvocationComparison.relation,'insufficient_following_invocations');});
test('VI adapted regression: absent current evidence is recorded without borrowing old diagnostic points',()=>{const dir=F.tmp();const x=M.makeComparison(dir);assert.equal(x.currentCaptureVerified,false);assert.equal(x.current.measurements,null);assert.deepEqual(x.inputDigests,{});assert.equal(x.historical.measurements.diagnosticReports,4);});
test('VI adapted regression: last tail stays null, and known tails over budget do not become qualified samples',()=>{const x=M.measures(prior());assert.equal(x.successorTailProfiles,3);assert.equal(x.prefixRows[3].afterRetentionCpu,null);assert.equal(x.reportedTailCostsWithinTwoCpu,false);assert.equal(x.completeSamples,0);});
test('VI adapted regression: actual commitment call progress and complete samples remain separate fields',()=>{const v=current();v.analysis.rows[3].calls.commitmentBuild=1;v.analysis.rows[3].phaseIntervals.commitmentBuild=0.4;const x=M.measures(v);assert.equal(x.commitmentActuallyInvoked,true);assert.equal(x.completeSamples,0);});
test('VI adapted regression: comparison emits no percentage or engine factory-count measurement claim',()=>{const x=M.compareResults(current(),prior());assert.equal(x.interpretation.exactSpeedupPercentNotComputed,true);assert.equal(x.interpretation.engineFactoryExecutionCountMeasured,false);assert.equal(x.historical.fullHistoricalRunReverifiedHere,false);});
test('VI adapted regression: safety thresholds, point count and cooperative budget are unchanged from accepted runner',()=>{assert.equal(K.COUNT,4);assert.equal(K.INTERVAL,100);assert.equal(K.MAX_DIAGNOSTIC_OBSERVED_COST,5);assert.equal(K.CONFIRM_MS,75000);assert.equal(K.profileFor(73660000).maxSampleCpu,2);assert.equal(K.profileFor(73660000).endTick-K.profileFor(73660000).startTick,300);});
test('VI adapted regression: corrupted current raw log remains failure evidence rather than preventing comparison record',()=>{const dir=F.tmp();fs.writeFileSync(path.join(dir,'console.jsonl'),'{broken\n');const r=M.makeComparison(dir);assert.equal(r.currentCaptureVerified,false);assert.ok(r.currentRawInspectionError);assert.equal(r.inputDigests['console.jsonl'].bytes,8);});
