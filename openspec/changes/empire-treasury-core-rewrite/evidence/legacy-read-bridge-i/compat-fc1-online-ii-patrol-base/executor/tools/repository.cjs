'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const C=require('../runtime/common.cjs'),P=C.POLICY,ROOT=path.resolve(__dirname,'..');
function git(repo,args){try{return cp.execFileSync('git',['-c','core.autocrlf=false','-c','core.eol=lf','-C',repo,...args],{encoding:null,maxBuffer:64*1048576,timeout:120000,stdio:['ignore','pipe','pipe']});}catch{C.fail('GIT_OPERATION_FAILED');}}
const text=(repo,args)=>git(repo,args).toString('utf8').trim();
function clean(repo){if(git(repo,['status','--porcelain=v1','-z','--untracked-files=all']).length)C.fail('WORKTREE_NOT_CLEAN');}
function head(repo){return text(repo,['rev-parse','HEAD']);}
function tree(repo,ref='HEAD'){return text(repo,['rev-parse',ref+'^{tree}']);}
function branch(repo,n){if(text(repo,['branch','--show-current'])!==n)C.fail('BRANCH_CHANGED');}
function remote(repo,n){const out=text(repo,['ls-remote','--exit-code','origin','refs/heads/'+n]).split(/\s+/);if(!/^[a-f0-9]{40}$/.test(out[0]))C.fail('REMOTE_UNREADABLE');return out[0];}
function paths(repo,a,b){return git(repo,['diff','--name-only','-z',a,b]).toString('utf8').split('\0').filter(Boolean).sort();}
function outside(file,repo){const real=p=>{p=path.resolve(p);return fs.existsSync(p)?fs.realpathSync(p):path.join(real(path.dirname(p)),path.basename(p));};const r=path.relative(real(repo),real(file));if(r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r)))C.fail('WORK_INSIDE_REPOSITORY');}
function manifest(){return C.json(path.join(ROOT,'source-manifest.json'));}
function verifyImplementation(repo){
 const m=manifest(),h=P.implementationHead;
 const overlay=P.patrolOverlay;
 if((!overlay&&h!==P.compatBase)||m.expectedSourceTree!==P.compatBaseTree||
    tree(repo,h)!==(overlay?overlay.originalSourceTree:P.compatBaseTree)||
    text(repo,['show','-s','--format=%P',h])!==P.implementationBase||
    text(repo,['show','-s','--format=%s',h])!==P.sourceMessage||
    !C.same(paths(repo,P.implementationBase,h),Object.keys(m.files).sort()))C.fail('REUSED_SOURCE_PROVENANCE_CHANGED');
 if(overlay){
  if(overlay.originalSourceHead!==h||overlay.head!==P.compatBase||
     tree(repo,overlay.head)!==P.compatBaseTree||
     text(repo,['show','-s','--format=%P',overlay.patrolCommit])!==h||
     text(repo,['show','-s','--format=%P',overlay.head])!==overlay.patrolCommit||
     text(repo,['show','-s','--format=%P',overlay.livePatrolCommit])!==P.measurementSourceBaseCommit||
     !C.same(paths(repo,h,overlay.patrolCommit),overlay.patrolPaths)||
     !C.same(paths(repo,overlay.patrolCommit,overlay.head),overlay.budgetPaths))C.fail('PATROL_OVERLAY_LINEAGE_CHANGED');
  for(const name of overlay.patrolPaths){
   if(text(repo,['rev-parse',`${overlay.patrolCommit}:${name}`])!==
      text(repo,['rev-parse',`${overlay.livePatrolCommit}:${name}`]))C.fail('PATROL_OVERLAY_BYTES_CHANGED');
  }
  for(const[name,blob]of Object.entries(overlay.budgetBlobs)){
   if(text(repo,['rev-parse',`${overlay.head}:${name}`])!==blob)C.fail('PATROL_BUDGET_BYTES_CHANGED');
  }
  if(!C.same(Object.keys(overlay.budgetBlobs).sort(),overlay.budgetPaths))C.fail('PATROL_BUDGET_SCOPE_CHANGED');
 }
 return m;
}
function source(repo){
 clean(repo);branch(repo,P.compatBranch);const m=verifyImplementation(repo);
 if(head(repo)!==P.compatBase||tree(repo)!==P.compatBaseTree)C.fail('REUSED_SOURCE_IDENTITY_CHANGED');
 for(const[n,v]of Object.entries(m.files)){const b=C.bytes(path.join(repo,n));if(b.length!==v.after.bytes||C.sha(b)!==v.after.sha256)C.fail('SOURCE_BYTES_CHANGED');}
 const runtime=C.bytes(path.join(repo,P.runtimePath)),emitter=/\bFULL_COST_EXPERIMENT\s*=\s*["']([^"']+)["']/.exec(runtime.toString('utf8'))?.[1];if(m.runtimeEmitterId!==P.runtimeEmitterId||emitter!==P.runtimeEmitterId)C.fail('RUNTIME_EMITTER_IDENTITY_MISMATCH');return {head:P.compatBase,tree:P.compatBaseTree,base:P.compatBase,paths:Object.keys(m.files).length,sourceModified:false,implementationHead:P.implementationHead,runtimeEmitterId:emitter};
}
function baseline(refactor,compat,{network=true}={}){
 clean(refactor);branch(refactor,P.refactorBranch);if(head(refactor)!==P.refactorBase)C.fail('REFACTOR_BASE_CHANGED');const s=source(compat);
 const b=git(refactor,['show',P.refactorBase+':'+P.priorRecoveryPath]);if(C.blob(b)!==P.priorRecoveryBlob||JSON.parse(b).status!=='RESTORED_BYTES_AND_RUNTIME_VERIFIED')C.fail('PRIOR_RECOVERY_NOT_VERIFIED');
 const v=git(refactor,['show',P.refactorBase+':'+P.priorAttemptPath]),a=JSON.parse(v);
 if(C.blob(v)!==P.priorAttemptBlob||a.status!=='NOT_DEPLOYED'||a.terminationReason!==P.priorAttemptTerminationReason||!a.sourceOff||!C.same(a.writeBoundaries,{candidate:0,restore:0}))C.fail('PRIOR_ATTEMPT_NOT_VERIFIED');
 if(network&&(remote(refactor,P.refactorBranch)!==P.refactorBase||remote(compat,P.compatBranch)!==P.compatBase))C.fail('REMOTE_BASE_CHANGED');
 return {status:'READ_XV_RETRY_BASELINES_VERIFIED',source:{state:'reused',...s},priorRecovery:'verified',priorAttempt:'not_deployed_verified'};
}
function apply(compat){return {...source(compat),status:'READ_XV_RETRY_SOURCE_REUSED_VERIFIED',resumed:true,sourceModified:false};}
function closed(repo){
 clean(repo);branch(repo,P.compatBranch);verifyImplementation(repo);if(tree(repo)!==P.compatBaseTree)C.fail('OFF_TREE_MISMATCH');const h=head(repo);
 if(h===P.compatBase){source(repo);return {head:h,bound:false,sourceHead:P.compatBase};}
 const parents=text(repo,['show','-s','--format=%P',h]).split(' ');if(parents.length!==1)C.fail('CLOSED_LINEAGE_CHANGED');const on=parents[0];
 if(text(repo,['show','-s','--format=%P',on])!==P.compatBase||!C.same(paths(repo,P.compatBase,on),[CONFIG])||!C.same(paths(repo,on,h),[CONFIG])||text(repo,['rev-list','--count',P.compatBase+'..HEAD'])!=='2')C.fail('CLOSED_LINEAGE_CHANGED');
 return {head:h,bound:true,sourceHead:P.compatBase,profileHead:on};
}
function profileFor(t){const startTick=Math.ceil((t+150)/100)*100;return {enabled:true,shardName:'shard1',rooms:P.rooms,resources:P.resources,startTick,endTick:startTick+300,intervalTicks:100,minBucket:2000,maxSampleCpu:10,reserveCpu:25,maxLogBytes:16384};}
function render(p){return 'import type { CompatConfig } from "./treasuryCompatTypes";\nexport const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({\n'+Object.entries(p).map(([k,v])=>'  '+k+': '+(Array.isArray(v)?'Object.freeze('+JSON.stringify(v)+')':JSON.stringify(v))+',').join('\n')+'\n});\n';}
const CONFIG='src/runtime/treasuryCompatConfig.ts';
function bind(repo,dir,t){const s=source(repo),profile=profileFor(t);const selected=require('../runtime/window-selection.cjs').verifySelected(dir);if(selected.currentTick!==t)C.fail('SELECTION_BIND_TICK_CHANGED');const admission=require('../runtime/time-budget.cjs').verifyPlan(dir,profile,'binding');if(admission.currentTick!==t)C.fail('TIMING_BIND_TICK_CHANGED');C.durable(path.join(dir,'binding-intent.json'),{runId:P.parentRunId,source:s,observedTick:t,profile,atMs:Date.now()});fs.writeFileSync(path.join(repo,CONFIG),render(profile));git(repo,['add','--',CONFIG]);git(repo,['diff','--cached','--check']);git(repo,['commit','-m',`evidence(compat): bind read envelope XV retry I ${profile.startTick}-${profile.endTick}`]);clean(repo);if(!C.same(paths(repo,s.head,'HEAD'),[CONFIG])||text(repo,['rev-parse','HEAD^'])!==s.head)C.fail('BIND_SCOPE_CHANGED');const b={runId:P.parentRunId,source:s,profile,observedTick:t,profileHead:head(repo),profileTree:tree(repo)};C.durable(path.join(dir,'binding.json'),b);return b;}
async function closeSource(repo,dir){return C.lock(dir,'source-close',async()=>{const b=C.optional(dir,'binding.json'),intent=C.optional(dir,'binding-intent.json');if(!intent)return {status:'NO_PROFILE_BOUND',head:head(repo)};branch(repo,P.compatBranch);const src=intent.source,old=C.optional(dir,'source-closed.json');if(old){if(head(repo)!==old.closedHead||tree(repo)!==src.tree)C.fail('CLOSED_SOURCE_CHANGED');clean(repo);return old;}
 let h=head(repo),closed;
 if(h===src.head){if(git(repo,['status','--porcelain=v1','-z']).length){if(!C.same(git(repo,['diff','--name-only','-z','HEAD']).toString('utf8').split('\0').filter(Boolean).sort(),[CONFIG]))C.fail('DIRTY_PROFILE_NOT_RECOGNIZED');if(fs.readFileSync(path.join(repo,CONFIG),'utf8')!==render(intent.profile))C.fail('DIRTY_PROFILE_CHANGED');fs.writeFileSync(path.join(repo,CONFIG),git(repo,['show',src.head+':'+CONFIG]));git(repo,['add','--',CONFIG]);}clean(repo);closed=h;}
 else if(b&&tree(repo)===src.tree&&text(repo,['rev-parse','HEAD^'])===b.profileHead){clean(repo);closed=h;}
 else{clean(repo);if(text(repo,['rev-parse','HEAD^'])!==src.head||!C.same(paths(repo,src.head,h),[CONFIG])||git(repo,['show',h+':'+CONFIG]).toString('utf8')!==render(intent.profile))C.fail('UNRECOGNIZED_PROFILE_HEAD');fs.writeFileSync(path.join(repo,CONFIG),git(repo,['show',src.head+':'+CONFIG]));git(repo,['add','--',CONFIG]);git(repo,['commit','-m','evidence(compat): close read envelope XV retry I to default OFF']);clean(repo);closed=head(repo);}
 if(tree(repo)!==src.tree)C.fail('OFF_TREE_MISMATCH');const r={status:'SOURCE_DEFAULT_OFF_RESTORED',sourceHead:src.head,closedHead:closed,sameTreeAsSource:true,atMs:Date.now()};C.durable(path.join(dir,'source-closed.json'),r);return r;});}
function command(repo,args,out,stem,timeout=600000){const r=cp.spawnSync(process.execPath,args,{cwd:repo,encoding:'utf8',maxBuffer:64*1048576,timeout,windowsHide:true,env:{...process.env,DEST:'',DEPLOY_ALLOW_DIRTY:'',NODE_OPTIONS:'',NODE_PATH:''}});fs.writeFileSync(path.join(out,stem+'.stdout'),r.stdout||'');fs.writeFileSync(path.join(out,stem+'.stderr'),r.stderr||'');C.durable(path.join(out,stem+'.exit.json'),{exit:r.status,signal:r.signal,error:r.error?.code||null});if(r.status!==0||r.error)C.fail('OFFLINE_COMMAND_FAILED');return r;}
function detachedBuild(repo,ref,out){const d=path.join(out,'build');if(fs.existsSync(d))C.fail('BUILD_DIR_EXISTS');git(repo,['worktree','add','--detach',d,ref]);const target=path.join(repo,'node_modules');fs.symlinkSync(target,path.join(d,'node_modules'),process.platform==='win32'?'junction':'dir');clean(d);command(d,[path.join(target,'rollup/dist/bin/rollup'),'-c'],out,'bundle',600000);clean(d);return {modules:{main:fs.readFileSync(path.join(d,'dist/main.js'),'utf8')},head:head(d),tree:tree(d)};}
module.exports={ROOT,git,text,clean,head,tree,branch,remote,paths,outside,manifest,verifyImplementation,source,closed,baseline,apply,profileFor,render,bind,closeSource,command,detachedBuild,CONFIG};
