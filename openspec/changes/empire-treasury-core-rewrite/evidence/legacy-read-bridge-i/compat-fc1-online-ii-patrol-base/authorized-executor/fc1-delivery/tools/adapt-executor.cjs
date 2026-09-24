'use strict';
const C=require('./common.cjs'),{fs,path,ROOT,P}=C;
function once(text,before,after){C.check(text.split(before).length===2,'EXECUTOR_PATCH_ANCHOR');return text.replace(before,after);}
function samples(text){
 text=once(text,"r.cpuBeforeSerializationAndEmit>=2||","(!P.fullCostMeasurement&&r.cpuBeforeSerializationAndEmit>=2)||");
 const old="need(r.status!=='sampled'||r.cpuProfile.elapsed<2,'SAMPLED_OVER_BUDGET');need(r.localSafety?.thresholdCpu===5&&typeof r.localSafety.latched==='boolean'&&r.localSafety.scope==='preview_heap_instance'&&r.localSafety.currentCallPreempted===false,'LOCAL_SAFETY_MISSING');need(r.cpuProfile.elapsed<=P.safetyCpu&&!r.localSafety.latched,'CPU_OBSERVED_SAFETY_STOP');";
 text=once(text,old,"if(P.fullCostMeasurement){need(s.profile.maxSampleCpu===10&&s.profile.reserveCpu===25,'FC1_PROFILE_POLICY');need(r.status!=='sampled'||r.cpuProfile.elapsed<10,'SAMPLED_OVER_EXPOSURE_CEILING');need(r.localSafety===undefined,'FC1_EXPECTS_OUTER_SAFETY');}else{"+old+"}");
 text=once(text,"need(tail.elapsed<=P.safetyCpu,'CPU_OBSERVED_SAFETY_STOP');","if(!P.fullCostMeasurement)need(tail.elapsed<=P.safetyCpu,'CPU_OBSERVED_SAFETY_STOP');");
 text=once(text,'const accepted=[],texts=[],raw=[],issues=[],traces=[],tails=[];','const accepted=[],texts=[],raw=[],issues=[],traces=[],tails=[],costs=[];');
 text=once(text,"if(p?.obj?.kind!=='treasury-legacy-read-bridge')continue;",`if(p?.obj?.kind==='treasury-full-cost-sample'){
 if(!P.fullCostMeasurement){issues.push('UNEXPECTED_COST_RECEIPT');continue;}
 try{if(costs.some(x=>x.tick===p.obj.tick))C.fail('DUPLICATE_COST_RECEIPT');require('./cost-receipts.cjs').validate(p.obj,accepted[costs.length],s,costs.at(-1));costs.push(p.obj);if(p.obj.stopsFutureSamples){safety=true;issues.push('FULL_COST_SAFETY_STOP');}}catch(e){issues.push(C.code(e));}continue;
 }if(p?.obj?.kind!=='treasury-legacy-read-bridge')continue;`);
 text=once(text,'return {frame,accepted,raw,texts,issues,traces,tails,state:()=>({','return {frame,accepted,raw,texts,issues,traces,tails,costs,state:()=>({costReceipts:costs.length,');
 return text;
}
function worker(text){return once(text,"if(h.accepted===4)return 'FOUR_REPORTS_CAPTURED';","if(h.accepted===4&&(!P.fullCostMeasurement||h.costReceipts===4))return 'FOUR_REPORTS_CAPTURED';");}
function verify(text){
 text=once(text,"need(w.accepted.length===4,'FOUR_REPORTS_REQUIRED');","need(w.accepted.length===4,'FOUR_REPORTS_REQUIRED');if(P.fullCostMeasurement)need(w.costs.length===4,'FOUR_COST_RECEIPTS_REQUIRED');");
 text=once(text,'rawSummary,completedTailProfiles:w.tails,','rawSummary,costReceipts:w.costs,measurementProtocol:P.measurementProtocol||null,completedTailProfiles:w.tails,');return text;
}
function archive(text){
 text=once(text,"const secret=C.loadSecret(o.secret),files={};","require('./raw-whitespace.cjs').createProof(out);const secret=C.loadSecret(o.secret),files={};");
 text=once(text,"R.git(refactor,['diff','--cached','--check']);","require('./raw-whitespace.cjs').checkStaged(refactor,P.evidencePath);");
 text=once(text,"kind:'read-envelope-XV-retry-I-archive/v1'","kind:'full-cost-FC1-archive/v1'");
 text=once(text,'# Read Envelope XV Online I Retry I\\n\\nCapture:','# Full Cost FC1 (no 2-CPU performance gate)\\n\\nCapture:');return text;
}
function repository(text){
 text=once(text,'minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384','minBucket:2000,maxSampleCpu:10,reserveCpu:25,maxLogBytes:16384');
 text=once(text,"return {head:P.compatBase,tree:P.compatBaseTree,base:P.compatBase,paths:Object.keys(m.files).length,sourceModified:false,implementationHead:P.implementationHead};",
  "const runtime=C.bytes(path.join(repo,P.runtimePath)),emitter=/\\bFULL_COST_EXPERIMENT\\s*=\\s*[\"']([^\"']+)[\"']/.exec(runtime.toString('utf8'))?.[1];if(m.runtimeEmitterId!==P.runtimeEmitterId||emitter!==P.runtimeEmitterId)C.fail('RUNTIME_EMITTER_IDENTITY_MISMATCH');return {head:P.compatBase,tree:P.compatBaseTree,base:P.compatBase,paths:Object.keys(m.files).length,sourceModified:false,implementationHead:P.implementationHead,runtimeEmitterId:emitter};");
 text=once(text,"a.terminationReason!=='TIME_BUDGET_INSUFFICIENT'","a.terminationReason!==P.priorAttemptTerminationReason");
 return text;
}
function offlineBuild(text){return once(text,"status:'READ_XV_RETRY_OFFLINE_VERIFIED',source,packageFingerprint:info.fingerprint,repositoryNodeTests:P.repositoryNodeTests,compiler:ts.version,jestSuites:P.jestSuites,jestTests:P.jestTests,atMs:Date.now()",
 "status:'FC1_OFFLINE_VERIFIED',source,packageFingerprint:info.fingerprint,onlineAttempted:false,repositoryNodeTests:P.repositoryNodeTests,compiler:ts.version,jestSuites:P.jestSuites,jestTests:P.jestTests,atMs:Date.now()");}
function observeGate(text){
 text=once(text,"if(!o.execute||!o['exclusive-target']||!o['prior-workers-stopped'])C.fail('EXPLICIT_EXECUTION_REQUIRED');",
  "if(!o.execute||!o['exclusive-target']||!o['prior-workers-stopped'])C.fail('EXPLICIT_EXECUTION_REQUIRED');if(P.newRoundAuthorization?.status!=='AUTHORIZED'||P.authorizationId===P.historicalAuthorizationId||P.parentRunId===P.historicalRunId||P.newRoundAuthorization.authorizationId!==P.authorizationId||P.newRoundAuthorization.runId!==P.parentRunId)C.fail('NEW_ROUND_AUTHORIZATION_REQUIRED');");
 return once(text,"if(tests.status!=='READ_XV_RETRY_PACKAGE_TESTS_VERIFIED'||tests.packageFingerprint!==fp||tests.passed!==require('../references/test-contract.json').count||tests.failed!==0||offline.status!=='READ_XV_RETRY_OFFLINE_VERIFIED'||offline.packageFingerprint!==fp||offline.source.head!==source.head||offline.source.tree!==source.tree)C.fail('OFFLINE_GATES_MISSING');",
  "if(!require('../runtime/test-results.cjs').validate(tests,C.json(path.join(R.ROOT,'references/test-contract.json')),fp)||offline.status!=='FC1_OFFLINE_VERIFIED'||offline.onlineAttempted!==false||offline.packageFingerprint!==fp||offline.source.head!==source.head||offline.source.tree!==source.tree||offline.source.runtimeEmitterId!==source.runtimeEmitterId)C.fail('OFFLINE_GATES_MISSING');");
}
function timeBudget(text){
 const before="  const start=profile.startTick,end=profile.endTick;\n  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%100!==0||end!==start+300||profile.intervalTicks!==100||\n    profile.maxSampleCpu!==2||profile.reserveCpu!==5||!C.same(profile.rooms,P.rooms)||!C.same(profile.resources,P.resources)) C.fail('TIMING_PROFILE_INVALID');";
 const after=`  const policy=P.measurementPolicy;
  if(P.fullCostMeasurement!==true) C.fail('TIMING_FULL_COST_REQUIRED');
  if(P.measurementProtocol!=='FC1'||P.safetyCpu!==10||P.performanceTargetCpu!==null||!policy||
    policy.performanceTargetCpu!==null||policy.cooperativeCeilingCpu!==10||policy.retainedReserveCpu!==25||
    policy.admissionHeadroomCpu!==55||policy.minBucket!==2000||policy.intervalTicks!==100||
    policy.points!==4||policy.receiptBytes!==16384) C.fail('TIMING_FULL_COST_POLICY_INVALID');
  const start=profile.startTick,end=profile.endTick;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%100!==0||end!==start+300||profile.intervalTicks!==100||
    profile.maxSampleCpu!==10||profile.reserveCpu!==25||
    !C.same(profile.rooms,P.rooms)||!C.same(profile.resources,P.resources)||
    profile.enabled!==true||profile.shardName!=='shard1'||profile.minBucket!==2000||profile.maxLogBytes!==16384) C.fail('TIMING_PROFILE_INVALID');`;
 return once(text,before,after);
}
const transforms={'runtime/samples.cjs':samples,'runtime/worker.cjs':worker,'runtime/time-budget.cjs':timeBudget,
 'tools/verify.cjs':verify,'tools/archive.cjs':archive,'tools/repository.cjs':repository,'tools/build.cjs':offlineBuild,'tools/observe.cjs':observeGate};
function resolve(inherited,out,source,manifest,receipt,runtimeArtifacts){
 C.check(!fs.existsSync(out),'EXECUTOR_DIR_EXISTS');C.verify(inherited);fs.cpSync(inherited,out,{recursive:true,errorOnExist:true,force:false});
 C.check(runtimeArtifacts?.compilerVersion===P.compilerVersion&&Object.keys(runtimeArtifacts.files??{}).length===4,'RUNTIME_TEST_ARTIFACTS_REQUIRED');
 const old=C.json(path.join(inherited,'policy.json'));
 C.check(old.authorizationId==='compat-read-envelope-XV-online-I-retry-I-2026-09-23'&&old.wallMs===4500000&&old.runtimeMs===75000&&old.points===4,'INHERITED_POLICY_CHANGED');
 const policy={...old,kind:P.kind,historicalAuthorizationId:P.historicalAuthorizationId,historicalRunId:P.historicalRunId,
  inheritedExecutorAuthorizationId:old.authorizationId,inheritedExecutorRunId:old.parentRunId,
  newRoundAuthorization:{status:'WAITING_FOR_EXPLICIT_AUTHORIZATION',authorizationId:null,runId:null},onlineExecutionReady:false,
  authorizationId:P.authorizationId,runId:P.runId,parentRunId:P.runId,compatBase:source.head,compatBaseTree:source.tree,
  implementationHead:source.head,implementationBase:P.compatBase,refactorBase:P.refactorBase,sourceMessage:P.sourceMessage,
  evidenceMessage:P.evidenceMessage,evidencePath:P.evidencePath,priorAttemptPath:P.priorAttemptPath,
  priorAttemptBlob:P.priorAttemptBlob,priorAttemptTerminationReason:P.priorAttemptTerminationReason,
  priorFinalPath:P.priorFinalPath,priorFinalBlob:P.priorFinalBlob,priorRecoveryPath:P.priorRecoveryPath,
  priorRecoveryBlob:P.priorRecoveryBlob,runtimePath:P.runtimePath,runtimeEmitterId:source.runtimeEmitterId,
  repositoryNodeTests:P.repositoryNodeTests,
  executorMeasurementTests:P.executorMeasurementTests,
  fullCostMeasurement:true,measurementProtocol:'FC1',safetyCpu:10,
  performanceTargetCpu:null,measurementPolicy:P.measurement};
 fs.writeFileSync(path.join(out,'policy.json'),JSON.stringify(policy,null,2)+'\n');
 fs.writeFileSync(path.join(out,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const changed=['policy.json','source-manifest.json','AGENT-RUN.md'];
 fs.copyFileSync(path.join(ROOT,'implementation/executor-AGENT-RUN.md'),path.join(out,'AGENT-RUN.md'));
 const runtimeSourceFiles={};for(const[name,file]of Object.entries(runtimeArtifacts.files)){
  const relative='runtime-source/'+name,bytes=Buffer.from(file.outputText,'utf8');
  C.check(bytes.length===file.outputBytes&&C.sha(bytes)===file.outputSha256,'RUNTIME_ARTIFACT_IDENTITY_MISMATCH:'+name);
  C.write(path.join(out,relative),bytes);changed.push(relative);
  runtimeSourceFiles[name]={path:relative,sourcePath:file.sourcePath,sourceBytes:file.sourceBytes,sourceSha256:file.sourceSha256,
   sourceGitBlob:file.sourceGitBlob,outputBytes:file.outputBytes,outputSha256:file.outputSha256};
 }
 C.durable(path.join(out,'runtime-source-manifest.json'),{kind:'full-cost-FC1-runtime-source-artifacts/v1',sourceHead:source.head,
  sourceTree:source.tree,runtimeEmitterId:source.runtimeEmitterId,compilerVersion:runtimeArtifacts.compilerVersion,files:runtimeSourceFiles});
 changed.push('runtime-source-manifest.json');
 for(const[n,fn]of Object.entries(transforms)){const before=C.read(path.join(out,n)).toString('utf8'),after=fn(before);fs.writeFileSync(path.join(out,n),after);changed.push(n);}
 for(const[from,to]of [['implementation/cost-receipts.cjs','runtime/cost-receipts.cjs'],['implementation/test-results.cjs','runtime/test-results.cjs'],
  ['implementation/raw-whitespace.cjs','tools/raw-whitespace.cjs'],['implementation/executor-run-tests.cjs','tools/run-tests.cjs'],
  ['tests/full-cost-executor.spec.cjs','tests/full-cost-executor.spec.cjs'],['tests/full-cost-admission.spec.cjs','tests/full-cost-admission.spec.cjs'],
  ['tests/test-results.spec.cjs','tests/test-results.spec.cjs'],['integration/entry-closure.integration.spec.cjs','tests/entry-closure.integration.spec.cjs'],
  ['integration/full-cost-source-custody.integration.spec.cjs','tests/full-cost-source-custody.spec.cjs'],
  ['tests/admission-fixtures.cjs','tests/admission-fixtures.cjs'],['tests/executor-fixtures.cjs','tests/executor-fixtures.cjs']]){
  fs.copyFileSync(path.join(ROOT,from),path.join(out,to));changed.push(to);
 }
 const testContract={kind:'full-cost-FC1-final-executor-tests/v1',
  legacySpecFiles:['actions.spec.cjs','time-budget.spec.cjs','window-selection.spec.cjs','workflow.spec.cjs'],minimumLegacyTests:20,
  fc1ExecutorSpecFiles:['full-cost-executor.spec.cjs','full-cost-admission.spec.cjs','test-results.spec.cjs','full-cost-source-custody.spec.cjs'],
  fc1ExecutorTests:P.executorMeasurementTests,
  historicalExecutorFullSuiteCount:P.inheritedToolTests};
 fs.writeFileSync(path.join(out,'references/test-contract.json'),JSON.stringify(testContract,null,2)+'\n');changed.push('references/test-contract.json');
 // Baseline tests execute against their exact old protocol in a separate child,
 // not against FC1 with its new cost policy. New protocol tests run separately.
 fs.cpSync(inherited,path.join(out,'baseline-executor'),{recursive:true,errorOnExist:true,force:false});
 fs.cpSync(ROOT,path.join(out,'fc1-delivery'),{recursive:true,errorOnExist:true,force:false});
 const beforeManifest=C.json(path.join(inherited,'INTEGRITY.json'));
 for(const[n,x]of Object.entries(beforeManifest.files)){if(changed.includes(n))continue;const b=C.read(path.join(out,n));C.check(b.length===x.bytes&&C.sha(b)===x.sha256,'UNINTENDED_EXECUTOR_CHANGE:'+n);}
 C.durable(path.join(out,'FC1-RESOLUTION.json'),{kind:'full-cost-FC1-resolution/v1',source,receipt,changedInheritedPaths:changed.sort(),
  preserved:['canonical source builders','preview algorithm','native CPU samples','full validation and eager indexes','actions/transport/observer','one candidate and one restore with no write retries','window selection and absolute deadlines'],
  changedProtocol:['sampled above 2 is no longer rejected','explicit ON ceiling 10 / reserve 25 / entry headroom 55','FC1 time admission matches the exact generated profile','online entry requires a separate new-round authorization','outer heap latch replaces old 5-CPU latch','four cost receipts required as well as four original reports','raw-log whitespace proof']});
 return C.seal(out);
}
module.exports={once,samples,worker,timeBudget,verify,archive,repository,observeGate,transforms,resolve};
