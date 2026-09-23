'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),C=require('../runtime/common.cjs');
const ROOT=path.resolve(__dirname,'..');
function tap(text,count){return new RegExp('^# tests '+count+'\\r?$','m').test(text)&&new RegExp('^# pass '+count+'\\r?$','m').test(text)&&['fail','skipped','todo','cancelled'].every(k=>new RegExp('^# '+k+' 0\\r?$','m').test(text));}
function run(out){const p=C.verifyPackage(),k=require('../references/test-contract.json');fs.mkdirSync(out);
 const base=cp.spawnSync(process.execPath,[path.join(ROOT,'baseline-executor/tools/run-tests.cjs'),'--out',path.join(out,'baseline')],{cwd:ROOT,encoding:'utf8',timeout:1200000,maxBuffer:64*1048576});
 fs.writeFileSync(path.join(out,'baseline-command.stdout'),base.stdout||'');fs.writeFileSync(path.join(out,'baseline-command.stderr'),base.stderr||'');
 if(base.error||base.status!==0)C.fail('BASELINE_EXECUTOR_TESTS_FAILED');
 const b=C.json(path.join(out,'baseline/result.json'));if(b.tests!==165||b.passed!==165||b.failed!==0)C.fail('BASELINE_TEST_COUNT_CHANGED');
 const r=cp.spawnSync(process.execPath,['--test','--test-concurrency=1',path.join(ROOT,'tests/full-cost-executor.spec.cjs')],{cwd:ROOT,encoding:'utf8',timeout:600000,maxBuffer:64*1048576});
 fs.writeFileSync(path.join(out,'measurement.tap'),r.stdout||'');fs.writeFileSync(path.join(out,'measurement.stderr'),r.stderr||'');
 if(r.error||r.status!==0||!tap(r.stdout,k.measurementTests)||k.count!==165+k.measurementTests)C.fail('FC1_EXECUTOR_TESTS_FAILED');
 const result={status:'READ_XV_RETRY_PACKAGE_TESTS_VERIFIED',protocol:'FC1',packageFingerprint:p.fingerprint,tests:k.count,passed:k.count,failed:0,
  baseline:{tests:165,passed:165,protocol:'unaltered XV retry executor'},measurement:{tests:k.measurementTests,passed:k.measurementTests,protocol:'resolved FC1'},atMs:Date.now()};C.durable(path.join(out,'result.json'),result);return result;
}
module.exports={run,tap};if(require.main===module)C.cli(async()=>{const o=C.options(['out']);C.requireArgs(o,['out']);console.log(JSON.stringify(run(o.out)));});
