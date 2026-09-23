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
function repository(text){return once(text,'minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384','minBucket:2000,maxSampleCpu:10,reserveCpu:25,maxLogBytes:16384');}
const transforms={'runtime/samples.cjs':samples,'runtime/worker.cjs':worker,'tools/verify.cjs':verify,'tools/archive.cjs':archive,'tools/repository.cjs':repository};
function resolve(inherited,out,source,manifest,receipt){
 C.check(!fs.existsSync(out),'EXECUTOR_DIR_EXISTS');C.verify(inherited);fs.cpSync(inherited,out,{recursive:true,errorOnExist:true,force:false});
 const old=C.json(path.join(inherited,'policy.json'));
 C.check(old.authorizationId==='compat-read-envelope-XV-online-I-retry-I-2026-09-23'&&old.wallMs===4500000&&old.runtimeMs===75000&&old.points===4,'INHERITED_POLICY_CHANGED');
 const policy={...old,authorizationId:P.authorizationId,parentRunId:P.runId,compatBase:source.head,compatBaseTree:source.tree,
  implementationHead:source.head,implementationBase:P.compatBase,refactorBase:P.refactorBase,sourceMessage:P.sourceMessage,
  evidenceMessage:P.evidenceMessage,evidencePath:P.evidencePath,repositoryNodeTests:P.repositoryNodeTests,
  priorRecoveryPath:P.priorRecoveryPath,priorRecoveryBlob:P.priorRecoveryBlob,fullCostMeasurement:true,measurementProtocol:'FC1',safetyCpu:10,
  performanceTargetCpu:null,measurementPolicy:P.measurement};
 fs.writeFileSync(path.join(out,'policy.json'),JSON.stringify(policy,null,2)+'\n');
 fs.writeFileSync(path.join(out,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const changed=['policy.json','source-manifest.json'];
 for(const[n,fn]of Object.entries(transforms)){const before=C.read(path.join(out,n)).toString('utf8'),after=fn(before);fs.writeFileSync(path.join(out,n),after);changed.push(n);}
 for(const[from,to]of [['implementation/cost-receipts.cjs','runtime/cost-receipts.cjs'],['implementation/raw-whitespace.cjs','tools/raw-whitespace.cjs'],['implementation/executor-run-tests.cjs','tools/run-tests.cjs'],['tests/full-cost-executor.spec.cjs','tests/full-cost-executor.spec.cjs'],['tests/executor-fixtures.cjs','tests/executor-fixtures.cjs']]){
  fs.copyFileSync(path.join(ROOT,from),path.join(out,to));changed.push(to);
 }
 const testContract={kind:'full-cost-FC1-test-contract/v1',count:P.inheritedToolTests+P.executorMeasurementTests,baselineTests:P.inheritedToolTests,measurementTests:P.executorMeasurementTests};
 fs.writeFileSync(path.join(out,'references/test-contract.json'),JSON.stringify(testContract,null,2)+'\n');changed.push('references/test-contract.json');
 // Baseline tests execute against their exact old protocol in a separate child,
 // not against FC1 with its new cost policy. New protocol tests run separately.
 fs.cpSync(inherited,path.join(out,'baseline-executor'),{recursive:true,errorOnExist:true,force:false});
 fs.cpSync(ROOT,path.join(out,'fc1-delivery'),{recursive:true,errorOnExist:true,force:false});
 const beforeManifest=C.json(path.join(inherited,'INTEGRITY.json'));
 for(const[n,x]of Object.entries(beforeManifest.files)){if(changed.includes(n))continue;const b=C.read(path.join(out,n));C.check(b.length===x.bytes&&C.sha(b)===x.sha256,'UNINTENDED_EXECUTOR_CHANGE:'+n);}
 C.durable(path.join(out,'FC1-RESOLUTION.json'),{kind:'full-cost-FC1-resolution/v1',source,receipt,changedInheritedPaths:changed.sort(),
  preserved:['canonical source builders','preview algorithm','native CPU samples','full validation and eager indexes','actions/transport/observer','one candidate and one restore with no write retries','window selection and absolute deadlines'],
  changedProtocol:['sampled above 2 is no longer rejected','explicit ON ceiling 10 / reserve 25 / entry headroom 55','outer heap latch replaces old 5-CPU latch','four cost receipts required as well as four original reports','raw-log whitespace proof']});
 return C.seal(out);
}
module.exports={once,samples,worker,verify,archive,repository,transforms,resolve};
