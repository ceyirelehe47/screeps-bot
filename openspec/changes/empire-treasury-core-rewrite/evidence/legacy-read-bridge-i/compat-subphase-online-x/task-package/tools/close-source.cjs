'use strict';
const fs=require('node:fs'),path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),S=require('../runtime/store.cjs');
function sourceIdentity(run){const s=S.optional(run,'session.json')||S.optional(run,'binding.json')||S.optional(run,'binding-intent.json');if(!s||!/^[0-9a-f]{40}$/.test(s.sourceHead)||!/^[0-9a-f]{40}$/.test(s.sourceTree))C.fail('SOURCE_IDENTITY_MISSING');return s;}
function closeSource(compat,run){
 const done=S.optional(run,'source-closed.json');if(done){if(U.textGit(compat,['rev-parse','HEAD'])!==done.closedHead)C.fail('CLOSED_SOURCE_MOVED');return done;}
 if(U.textGit(compat,['branch','--show-current'])!=='compat/treasury-read-bridge-i')C.fail('COMPAT_BRANCH_CHANGED');
 const source=sourceIdentity(run),head=U.textGit(compat,['rev-parse','HEAD']);
 if(head===source.sourceHead){
  if(U.textGit(compat,['status','--porcelain'])){
   const intent=S.optional(run,'binding-intent.json');
   if(!intent||U.textGit(compat,['diff','--name-only','HEAD'])!==K.CONFIG||U.textGit(compat,['ls-files','--others','--exclude-standard'])
    ||fs.readFileSync(path.join(compat,K.CONFIG),'utf8')!==K.renderConfig(intent.profile))C.fail('UNRECOGNIZED_DIRTY_PROFILE');
   U.git(compat,['restore','--source='+source.sourceHead,'--staged','--worktree','--',K.CONFIG]);
  }
  U.clean(compat);return S.newRecord(run,'source-closed.json',{status:'SOURCE_DEFAULT_OFF_RESTORED',sourceHead:source.sourceHead,profileHead:null,closedHead:head,sameTreeAsSource:true,atMs:Date.now()});
 }
 U.clean(compat);let binding=S.optional(run,'binding.json');
 if(!binding){const intent=S.optional(run,'binding-intent.json');
  if(intent&&U.textGit(compat,['rev-parse','HEAD^'])===source.sourceHead&&U.textGit(compat,['diff','--name-only',source.sourceHead,head])===K.CONFIG
   &&U.git(compat,['show','HEAD:'+K.CONFIG])===K.renderConfig(intent.profile))binding={profileHead:head,sourceHead:source.sourceHead};
 }
 if(!binding||head!==binding.profileHead||binding.sourceHead!==source.sourceHead||U.textGit(compat,['rev-parse','HEAD^'])!==source.sourceHead)C.fail('UNRECOGNIZED_PROFILE_HEAD');
 if(U.textGit(compat,['diff','--name-only',source.sourceHead,head])!==K.CONFIG)C.fail('SOURCE_SCOPE_CHANGED');
 const original=U.git(compat,['show',source.sourceHead+':'+K.CONFIG],true);fs.writeFileSync(path.join(compat,K.CONFIG),original);
 U.git(compat,['add','--',K.CONFIG]);U.git(compat,['commit','-m','evidence(compat): close subphase online X to default OFF']);U.clean(compat);
 const closedHead=U.textGit(compat,['rev-parse','HEAD']),same=U.textGit(compat,['rev-parse','HEAD^{tree}'])===U.textGit(compat,['rev-parse',source.sourceHead+'^{tree}']);
 if(!same)C.fail('OFF_TREE_NOT_IDENTICAL');
 return S.newRecord(run,'source-closed.json',{status:'SOURCE_DEFAULT_OFF_RESTORED',sourceHead:source.sourceHead,profileHead:head,closedHead,sameTreeAsSource:same,atMs:Date.now()});
}
module.exports={closeSource,sourceIdentity};if(require.main===module)U.cli(async()=>{const o=U.options(['compat','run']);C.required(o,'compat','run');U.verifyPackage();console.log(JSON.stringify(closeSource(o.compat,o.run)));});
