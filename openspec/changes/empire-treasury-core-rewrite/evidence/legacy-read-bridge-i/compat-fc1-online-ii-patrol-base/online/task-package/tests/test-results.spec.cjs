'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const commonPath=fs.existsSync(path.join(__dirname,'../runtime/common.cjs'))
 ?'../runtime/common.cjs':'../tools/common.cjs';
const C=require(commonPath);
const contract=require('../references/test-contract.json');
const validatorPath=fs.existsSync(path.join(__dirname,'../runtime/test-results.cjs'))
 ?'../runtime/test-results.cjs':'../implementation/test-results.cjs';
const validate=require(validatorPath).validate;
const packageFingerprint=()=>typeof C.verifyPackage==='function'
 ?C.verifyPackage().fingerprint:C.verify(C.ROOT).fingerprint;

function group(files,count){return{files:[...files],tests:count,passed:count,failed:0,skipped:0,todo:0,cancelled:0};}
function result(){
 const legacy=group(contract.legacySpecFiles,contract.minimumLegacyTests);
 const fc1=group(contract.fc1ExecutorSpecFiles,contract.fc1ExecutorTests);
 return{kind:'full-cost-FC1-final-executor-tests-result/v2',status:'FC1_FINAL_EXECUTOR_VERIFIED',
  packageFingerprint:packageFingerprint(),groups:{legacyRiskRegressions:legacy,finalFc1Composition:fc1},
  tests:legacy.tests+fc1.tests,passed:legacy.passed+fc1.passed,failed:0,skipped:0,todo:0,cancelled:0,
  onlineAttempted:false};
}

test('producer contract accepts positive runs of every required group',()=>{
 assert.equal(validate(result(),contract,packageFingerprint()),true);
});
test('missing required group is not a green result',()=>{
 const r=result();delete r.groups.legacyRiskRegressions;
 assert.equal(validate(r,contract,r.packageFingerprint),false);
});
test('zero tests cannot satisfy a required group',()=>{
 const r=result();r.groups.legacyRiskRegressions=group(contract.legacySpecFiles,0);r.tests=contract.fc1ExecutorTests;r.passed=r.tests;
 assert.equal(validate(r,contract,r.packageFingerprint),false);
});
test('partial failures and skipped, todo or cancelled cases are rejected',()=>{
 for(const field of ['failed','skipped','todo','cancelled']){
  const r=result();r.groups.finalFc1Composition[field]=1;
  assert.equal(validate(r,contract,r.packageFingerprint),false,field);
 }
});
test('stale package fingerprints are rejected',()=>{
 const r=result();r.packageFingerprint='0'.repeat(64);
 assert.equal(validate(r,contract,packageFingerprint()),false);
});
test('file sets and exact FC1 composition counts are part of the contract',()=>{
 const wrongFiles=result();wrongFiles.groups.legacyRiskRegressions.files.pop();
 assert.equal(validate(wrongFiles,contract,wrongFiles.packageFingerprint),false);
 const wrongCount=result();wrongCount.groups.finalFc1Composition.tests++;
 assert.equal(validate(wrongCount,contract,wrongCount.packageFingerprint),false);
});
test('top-level summary counts must equal the per-group results',()=>{
 const r=result();r.passed--;
 assert.equal(validate(r,contract,r.packageFingerprint),false);
});
test('unexpected groups or online claims are rejected',()=>{
 const extra=result();extra.groups.historicalFullSuite={};
 assert.equal(validate(extra,contract,extra.packageFingerprint),false);
 const online=result();online.onlineAttempted=true;
 assert.equal(validate(online,contract,online.packageFingerprint),false);
});
