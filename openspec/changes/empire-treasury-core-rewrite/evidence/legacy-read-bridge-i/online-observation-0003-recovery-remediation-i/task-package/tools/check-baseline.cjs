'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs');
if(require.main===module)C.main(async()=>{const o=C.options(process.argv.slice(2),['refactor','compat']);C.required(o,'refactor','compat');if(Number(process.versions.node.split('.')[0])!==22)C.fail('NODE22_REQUIRED');
 console.log(JSON.stringify({package:U.verifyPackage(),baseline:U.heads(o.refactor,o.compat)}));});
