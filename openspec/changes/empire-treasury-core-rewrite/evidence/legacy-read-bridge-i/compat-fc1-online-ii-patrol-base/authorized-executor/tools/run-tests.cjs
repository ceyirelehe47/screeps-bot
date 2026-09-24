'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),C=require('../runtime/common.cjs');
const ROOT=path.resolve(__dirname,'..');
const REQUIRED_LEGACY=['actions.spec.cjs','time-budget.spec.cjs','window-selection.spec.cjs','workflow.spec.cjs'];
const REQUIRED_FC1=['full-cost-executor.spec.cjs','full-cost-admission.spec.cjs','test-results.spec.cjs','full-cost-source-custody.spec.cjs'];
const check=(ok,code)=>{if(!ok)C.fail(code);};
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
function counts(text){
 const n=k=>{const x=text.match(new RegExp('^# '+k+' (\\d+)\\r?$','m'));return x?Number(x[1]):null;};
 return{tests:n('tests'),passed:n('pass'),failed:n('fail'),skipped:n('skipped'),todo:n('todo'),cancelled:n('cancelled')};
}
function healthy(r,c,min){return !r.error&&r.status===0&&Number.isInteger(c.tests)&&c.tests>=min&&c.passed===c.tests&&
 [c.failed,c.skipped,c.todo,c.cancelled].every(n=>n===0);}
function run(o){
 const pkg=C.verifyPackage(),contract=C.json(path.join(ROOT,'references/test-contract.json'));
 check(contract.kind==='full-cost-FC1-final-executor-tests/v1'&&
  JSON.stringify(contract.legacySpecFiles)===JSON.stringify(REQUIRED_LEGACY)&&
  JSON.stringify(contract.fc1ExecutorSpecFiles)===JSON.stringify(REQUIRED_FC1)&&
  contract.minimumLegacyTests>=20&&contract.fc1ExecutorTests===C.POLICY.executorMeasurementTests,
  'FINAL_EXECUTOR_TEST_CONTRACT_INVALID');
 check(o&&typeof o.out==='string'&&o.out.length>0,'TEST_OUTPUT_REQUIRED');
 const out=path.resolve(o.out);check(!fs.existsSync(out),'TEST_OUTPUT_EXISTS');fs.mkdirSync(out,{recursive:true});
 const invoke=(root,names,dir)=>{
  const files=names.map(n=>path.join(root,n));
  check(files.every(f=>fs.existsSync(f)&&fs.statSync(f).isFile()),'REQUIRED_TEST_FILE_MISSING');
  const r=cp.spawnSync(process.execPath,['--test','--test-concurrency=1',...files],
   {cwd:ROOT,encoding:'utf8',maxBuffer:64*1048576,timeout:1200000});
  write(path.join(dir,'tests.tap'),r.stdout||'');write(path.join(dir,'tests.stderr'),r.stderr||'');
  return{raw:r,counts:counts(r.stdout||'')};
 };
 const baseline=invoke(path.join(ROOT,'baseline-executor/tests'),contract.legacySpecFiles,path.join(out,'legacy-risk-regressions'));
 check(healthy(baseline.raw,baseline.counts,contract.minimumLegacyTests),'LEGACY_RISK_REGRESSIONS_FAILED');
 const fc1=invoke(path.join(ROOT,'tests'),contract.fc1ExecutorSpecFiles,path.join(out,'final-fc1-composition'));
 check(healthy(fc1.raw,fc1.counts,contract.fc1ExecutorTests)&&fc1.counts.tests===contract.fc1ExecutorTests,
  'FC1_FINAL_COMPOSITION_TESTS_FAILED');
 const legacyGroup={files:contract.legacySpecFiles,...baseline.counts};
 const fc1Group={files:contract.fc1ExecutorSpecFiles,...fc1.counts};
 const result={kind:'full-cost-FC1-final-executor-tests-result/v2',status:'FC1_FINAL_EXECUTOR_VERIFIED',
  packageFingerprint:pkg.fingerprint,groups:{legacyRiskRegressions:legacyGroup,finalFc1Composition:fc1Group},
  tests:legacyGroup.tests+fc1Group.tests,passed:legacyGroup.passed+fc1Group.passed,
  failed:legacyGroup.failed+fc1Group.failed,skipped:legacyGroup.skipped+fc1Group.skipped,
  todo:legacyGroup.todo+fc1Group.todo,cancelled:legacyGroup.cancelled+fc1Group.cancelled,
  fullHistoricalExecutorSuiteRun:false,onlineAttempted:false,atMs:Date.now()};
 check(require('../runtime/test-results.cjs').validate(result,contract,pkg.fingerprint),'FINAL_RESULT_CONTRACT_VIOLATED');
 C.durable(path.join(out,'result.json'),result);return result;
}
module.exports={counts,healthy,run};
if(require.main===module)C.cli(()=>{const o=C.options(['out']);C.requireArgs(o,['out']);console.log(JSON.stringify(run(o)));});
