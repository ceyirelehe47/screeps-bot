'use strict';
const path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),S=require('../runtime/store.cjs'),A=require('../runtime/actions.cjs'),{client}=require('../runtime/transport.cjs');
if(require.main===module)U.cli(async()=>{const o=U.options(['compat','run','secret','out']);C.required(o,'compat','run','secret','out');U.verifyPackage();
 const guard=C.loadGuard(o.compat),s=S.loadRun(o.run,guard),secret=C.loadSecret(o.secret);U.outside(o.out,o.compat);U.outside(o.out,o.run);
 const r=await A.reconcileReadOnly(client(secret),guard,s,o.run);C.durable(path.resolve(o.out),r);console.log(JSON.stringify(r));if(!r.confirmed)process.exitCode=2;});
