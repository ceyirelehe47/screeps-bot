'use strict';
const cp=require('node:child_process');
function failure(code,details){const e=new Error(code);e.code=code;e.details=details;throw e;}
function git(repo,args){const r=cp.spawnSync('git',['-c','core.autocrlf=false','-c','core.eol=lf','-C',repo,...args],{encoding:'utf8',maxBuffer:16*1048576,timeout:120000,windowsHide:true});if(r.status!==0||r.error)failure('SOURCE_MIGRATION_GIT_FAILED',{args,status:r.status,stderr:r.stderr||null});return (r.stdout||'').trim();}
function clean(repo){if(git(repo,['status','--porcelain']))failure('SOURCE_MIGRATION_WORKTREE_NOT_CLEAN');}
function syncIndexAndWorktree(repo,commit){git(repo,['read-tree',commit]);git(repo,['checkout-index','-a','-f']);}
function replaceBranchCommit(repo,{current,base,tree,message,ref}){
 if(!/^[0-9a-f]{40}$/.test(current||'')||!/^[0-9a-f]{40}$/.test(base||'')||!/^[0-9a-f]{40}$/.test(tree||'')||typeof message!=='string'||!message||typeof ref!=='string'||!ref.startsWith('refs/heads/'))failure('SOURCE_MIGRATION_ARGUMENT_INVALID');
 clean(repo);git(repo,['cat-file','-e',tree+'^{tree}']);const next=git(repo,['commit-tree',tree,'-p',base,'-m',message]);
 if(git(repo,['rev-parse',next+'^'])!==base||git(repo,['show','-s','--format=%s',next])!==message||git(repo,['rev-parse',next+'^{tree}'])!==tree)failure('SOURCE_MIGRATION_COMMIT_INVALID');
 let refMoved=false;
 try{
  git(repo,['update-ref',ref,next,current]);refMoved=true;
  syncIndexAndWorktree(repo,next);clean(repo);return next;
 }catch(e){
  if(refMoved){
   try{if(git(repo,['rev-parse',ref])===next)git(repo,['update-ref',ref,current,next]);syncIndexAndWorktree(repo,current);clean(repo);}catch{}
  }
  throw e;
 }
}
module.exports={git,clean,syncIndexAndWorktree,replaceBranchCommit};
