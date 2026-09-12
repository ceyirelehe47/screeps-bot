'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs');
if(require.main===module)C.main(async()=>{const o=C.options(process.argv.slice(2),['repo','out']);C.required(o,'repo','out');U.verifyPackage();C.disjoint(o.out,o.repo);C.disjoint(o.out,U.ROOT);
 console.log(JSON.stringify(U.materialize(o.repo,o.out)));});
