'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),S=require('../runtime/store.cjs');
const {noLiveWorkers}=require('./archive.cjs'),{client}=require('../runtime/transport.cjs'),{closeout}=require('../runtime/closeout.cjs');
if(require.main===module)U.cli(async()=>{const o=U.options(['compat','run','secret'],['execute-recovery','exclusive-target','prior-workers-stopped']);C.required(o,'compat','run','secret');U.verifyPackage();
 if(!o['execute-recovery']||!o['exclusive-target']||!o['prior-workers-stopped'])C.fail('EXPLICIT_EXCLUSIVE_RECOVERY_REQUIRED');noLiveWorkers(o.run);
 const guard=C.loadGuard(o.compat),s=S.loadRun(o.run,guard),secret=C.loadSecret(o.secret);
 const r=await closeout({api:client(secret),guard,s,run:o.run,secret,actor:'operator'});console.log(JSON.stringify(r));if(!r.runtimeConfirmed)process.exitCode=2;});
