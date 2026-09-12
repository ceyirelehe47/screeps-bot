'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),{verifyRun}=require('../runtime/verify-run.cjs');
if(require.main===module)U.cli(async()=>{const o=U.options(['run','out']);C.required(o,'run','out');U.verifyPackage();U.outside(o.out,U.ROOT);U.outside(o.out,o.run);const r=verifyRun(o.run);C.durable(o.out,r);console.log(JSON.stringify(r));if(!r.captureVerified)process.exitCode=2;});
