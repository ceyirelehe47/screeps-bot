'use strict';
const path=require('node:path'),U=require('./util.cjs'),C=require('../runtime/common.cjs'),X=require('./source.cjs');
function apply(repo,out){U.verifyPackage();U.outside(out,repo);if(require('node:fs').existsSync(out))C.fail('OUTPUT_ALREADY_EXISTS');const v=X.verifyHead(repo),r={...v,status:'ENVELOPE_XII_RETRY_SOURCE_REUSED_VERIFIED',resumed:true,migrated:false,sourceModified:false,atMs:Date.now()};C.durable(out,r);return r;}
module.exports={apply};if(require.main===module)U.cli(async()=>{const o=U.options(['compat','out']);C.required(o,'compat','out');console.log(JSON.stringify(apply(path.resolve(o.compat),path.resolve(o.out))));});
