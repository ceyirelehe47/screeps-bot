'use strict';
const path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),S=require('../runtime/store.cjs'),K=require('../runtime/policy.cjs');
const {client}=require('../runtime/transport.cjs'),{execute}=require('../runtime/driver.cjs'),{closeSource}=require('./close-source.cjs');
if(require.main===module)U.cli(async()=>{
 const o=U.options(['compat','run','secret'],['execute','exclusive-target']);C.required(o,'compat','run','secret');if(!o.execute||!o['exclusive-target'])C.fail('EXPLICIT_EXCLUSIVE_EXECUTION_REQUIRED');
 if(process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY||process.env.NODE_OPTIONS)C.fail('UNSAFE_BUILD_OR_NODE_ENVIRONMENT');U.verifyPackage();
 const compat=path.resolve(o.compat),run=path.resolve(o.run),guard=C.loadGuard(compat),s=S.loadRun(run,guard);U.outside(run,compat);
 U.exactHead(compat,s.profileHead,'compat/treasury-read-bridge-i');
 if(U.textGit(compat,['rev-parse',s.profileHead+'^'])!==K.COMPAT||U.textGit(compat,['diff','--name-only',K.COMPAT,s.profileHead])!==K.CONFIG)C.fail('PROFILE_SCOPE_CHANGED');
 const secret={...C.loadSecret(o.secret),path:path.resolve(o.secret)};
 try{const result=await execute({repo:compat,run,secret,s,guard,api:client(secret)});console.log(JSON.stringify(result));}
 finally{closeSource(compat,run);}
});
