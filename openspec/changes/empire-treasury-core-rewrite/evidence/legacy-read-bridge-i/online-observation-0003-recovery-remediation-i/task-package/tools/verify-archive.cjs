'use strict';
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/pins.cjs'),A=require('./archive.cjs');
if(require.main===module)C.main(async()=>{const o=C.options(process.argv.slice(2),['refactor','compat'],['staged','after-commit']);C.required(o,'refactor','compat');U.verifyPackage();
 if(U.git(o.compat,['rev-parse','HEAD'])!==K.compat||U.git(o.compat,['status','--porcelain']))C.fail('COMPAT_CHANGED');
 if(o['after-commit']){
  if(U.git(o.refactor,['rev-parse','HEAD^'])!==K.refactor||U.git(o.refactor,['status','--porcelain']))C.fail('COMMIT_PARENT_OR_CLEAN_STATE_INVALID');
  const names=U.git(o.refactor,['diff','--name-status',K.refactor,'HEAD']).split('\n').filter(Boolean);
  if(names.some(x=>!x.startsWith('A\t'+K.evidenceTarget+'/')))C.fail('COMMIT_SCOPE_INVALID');
 }else if(U.git(o.refactor,['rev-parse','HEAD'])!==K.refactor)C.fail('REFACTOR_BASELINE_CHANGED');
 console.log(JSON.stringify(A.verifyArchive(o.refactor,K.evidenceTarget,{staged:!!o.staged})));});
