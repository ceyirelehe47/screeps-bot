'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),S=require('../runtime/store.cjs'),{verifyRun}=require('../runtime/verify-run.cjs');
if(require.main===module)U.cli(async()=>{const o=U.options(['run']);C.required(o,'run');U.verifyPackage();const r=verifyRun(o.run);S.newRecord(o.run,'observation-verification.json',r);console.log(JSON.stringify(r));if(!r.observed)process.exitCode=2;});
