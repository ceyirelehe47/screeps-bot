'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),S=require('../runtime/store.cjs'),A=require('../runtime/actions.cjs'),{client}=require('../runtime/transport.cjs');
if(require.main===module)U.cli(async()=>{const o=U.options(['compat','run','secret']);C.required(o,'compat','run','secret');U.verifyPackage();
 const guard=C.loadGuard(o.compat),s=S.loadRun(o.run,guard),secret=C.loadSecret(o.secret);
 console.log(JSON.stringify(await A.reconcileReadOnly(client(secret),guard,s,o.run)));});
