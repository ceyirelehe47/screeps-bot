'use strict';
const fs=require('node:fs'),path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),S=require('../runtime/store.cjs');
function closeSource(compat,run){
 const done=S.optional(run,'source-closed.json');if(done){if(U.textGit(compat,['rev-parse','HEAD'])!==done.closedHead)C.fail('CLOSED_SOURCE_MOVED');return done;}
 if(U.textGit(compat,['branch','--show-current'])!=='compat/treasury-read-bridge-i')C.fail('COMPAT_BRANCH_CHANGED');
 const head=U.textGit(compat,['rev-parse','HEAD']);
 if(head===K.COMPAT){
  if(U.textGit(compat,['status','--porcelain'])){
   const intent=S.optional(run,'binding-intent.json');
   if(!intent||U.textGit(compat,['diff','--name-only','HEAD'])!==K.CONFIG||U.textGit(compat,['ls-files','--others','--exclude-standard'])
    ||fs.readFileSync(path.join(compat,K.CONFIG),'utf8')!==K.renderConfig(intent.profile))C.fail('UNRECOGNIZED_DIRTY_PROFILE');
   U.git(compat,['restore','--source='+K.COMPAT,'--staged','--worktree','--',K.CONFIG]);
  }
  U.clean(compat);return S.newRecord(run,'source-closed.json',{status:'SOURCE_DEFAULT_OFF_RESTORED',profileHead:null,closedHead:head,sameTreeAsCompatBase:true});
 }
 U.clean(compat);let binding=S.optional(run,'binding.json');
 if(!binding){const intent=S.optional(run,'binding-intent.json');
  if(intent&&U.textGit(compat,['rev-parse','HEAD^'])===K.COMPAT&&U.textGit(compat,['diff','--name-only',K.COMPAT,head])===K.CONFIG
   &&U.git(compat,['show','HEAD:'+K.CONFIG])===K.renderConfig(intent.profile))binding={profileHead:head};
 }
 if(!binding||head!==binding.profileHead||U.textGit(compat,['rev-parse','HEAD^'])!==K.COMPAT)C.fail('UNRECOGNIZED_PROFILE_HEAD');
 if(U.textGit(compat,['diff','--name-only',K.COMPAT,head])!==K.CONFIG)C.fail('SOURCE_SCOPE_CHANGED');
 const original=U.git(compat,['show',K.COMPAT+':'+K.CONFIG],true);
 fs.writeFileSync(path.join(compat,K.CONFIG),original);
 U.git(compat,['add','--',K.CONFIG]);U.git(compat,['commit','--no-gpg-sign','-m','evidence(compat): close observation 0003 profile to default OFF']);U.clean(compat);
 const closedHead=U.textGit(compat,['rev-parse','HEAD']),same=U.textGit(compat,['rev-parse','HEAD^{tree}'])===U.textGit(compat,['rev-parse',K.COMPAT+'^{tree}']);
 if(!same)C.fail('OFF_TREE_NOT_IDENTICAL');
 return S.newRecord(run,'source-closed.json',{status:'SOURCE_DEFAULT_OFF_RESTORED',profileHead:head,closedHead,sameTreeAsCompatBase:same,atMs:Date.now()});
}
module.exports={closeSource};if(require.main===module)U.cli(async()=>{const o=U.options(['compat','run']);C.required(o,'compat','run');U.verifyPackage();console.log(JSON.stringify(closeSource(o.compat,o.run)));});
