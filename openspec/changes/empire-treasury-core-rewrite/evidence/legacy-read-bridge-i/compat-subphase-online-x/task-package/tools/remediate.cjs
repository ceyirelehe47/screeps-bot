'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
const LOCK=require('../references/remediation-lock.json');
const PAYLOAD=path.join(U.ROOT,'remediation/implementation');
const paths=LOCK.changes.map(x=>x.path).sort();
const partialPaths=[...LOCK.legacyPartialPaths].sort();
const completionPaths=[...LOCK.completionPaths].sort();
function bytesIdentity(b){return{bytes:b.length,sha256:C.sha256(b),blob:C.blob(b)};}
function sameIdentity(a,b){return a&&b&&a.bytes===b.bytes&&a.sha256===b.sha256&&a.blob===b.blob;}
function payload(rel){const p=path.join(PAYLOAD,rel);if(!fs.existsSync(p))C.fail('REMEDIATION_PAYLOAD_MISSING',{path:rel});return fs.readFileSync(p);}
function verifyPayload(){if(LOCK.compatBase!==K.COMPAT)C.fail('REMEDIATION_LOCK_BASE_CHANGED');for(const row of LOCK.changes)if(!sameIdentity(bytesIdentity(payload(row.path)),row.new))C.fail('REMEDIATION_PAYLOAD_CHANGED',{path:row.path});return true;}
function changed(repo,a,b){return U.git(repo,['diff','--name-only','-z',a,b],true).toString('utf8').split('\0').filter(Boolean).sort();}
function statusPaths(repo){
 const raw=U.git(repo,['status','--porcelain=v1','-z','--untracked-files=all'],true).toString('utf8');
 const records=raw.split('\0');if(records.at(-1)!=='')C.fail('PORCELAIN_OUTPUT_INVALID');records.pop();
 const out=[];
 for(let i=0;i<records.length;i++){
  const rec=records[i];if(rec.length<4||rec[2]!==' ')C.fail('PORCELAIN_OUTPUT_INVALID');
  const xy=rec.slice(0,2);if(/[RC]/.test(xy))C.fail('PORCELAIN_RENAME_UNSUPPORTED');
  out.push(rec.slice(3));
 }
 return out.sort();
}
function verifyBranchClean(repo){U.clean(repo);if(U.textGit(repo,['branch','--show-current'])!==LOCK.compatBranch)C.fail('WRONG_COMPAT_BRANCH');}
function verifyBase(repo){U.exactHead(repo,K.COMPAT,LOCK.compatBranch);if(U.remoteHead(repo,LOCK.compatBranch)!==K.COMPAT)C.fail('REMOTE_BASELINE_CHANGED');
 for(const row of LOCK.changes){if(row.old){const b=U.git(repo,['show',K.COMPAT+':'+row.path],true);if(!sameIdentity(bytesIdentity(b),row.old))C.fail('REMEDIATION_BASE_BYTES_CHANGED',{path:row.path});}
  else{const r=cp.spawnSync('git',['-C',repo,'cat-file','-e',K.COMPAT+':'+row.path],{encoding:'utf8',windowsHide:true});if(r.status===0)C.fail('REMEDIATION_NEW_PATH_ALREADY_EXISTS',{path:row.path});}}
 return true;}
function verifyLegacyPartial(repo,head=U.textGit(repo,['rev-parse','HEAD'])){
 verifyBranchClean(repo);
 if(U.textGit(repo,['rev-list','--parents','-n','1',head])!==head+' '+K.COMPAT)C.fail('PARTIAL_REMEDIATION_PARENT_MISMATCH');
 if(JSON.stringify(changed(repo,K.COMPAT,head))!==JSON.stringify(partialPaths))C.fail('PARTIAL_REMEDIATION_SCOPE_MISMATCH');
 for(const rel of partialPaths){const b=U.git(repo,['show',head+':'+rel],true);if(!b.equals(payload(rel)))C.fail('PARTIAL_REMEDIATION_BYTES_CHANGED',{path:rel});}
 return {status:'SOURCE_MANIFEST_PARTIAL_REMEDIATION_VERIFIED',base:K.COMPAT,head,tree:U.textGit(repo,['rev-parse',head+'^{tree}']),paths:partialPaths};
}
function verifyHead(repo,head=U.textGit(repo,['rev-parse','HEAD'])){
 verifyBranchClean(repo);
 if(JSON.stringify(changed(repo,K.COMPAT,head))!==JSON.stringify(paths))C.fail('REMEDIATION_SCOPE_MISMATCH');
 for(const row of LOCK.changes){const b=U.git(repo,['show',head+':'+row.path],true);if(!b.equals(payload(row.path)))C.fail('REMEDIATION_COMMITTED_BYTES_CHANGED',{path:row.path});}
 const parent=U.textGit(repo,['rev-parse',head+'^']);let mode,commits;
 if(parent===K.COMPAT){mode='fresh-full';commits=[head];}
 else{
  const partial=verifyLegacyPartial(repo,parent);
  if(JSON.stringify(changed(repo,parent,head))!==JSON.stringify(completionPaths))C.fail('REMEDIATION_COMPLETION_SCOPE_MISMATCH');
  mode='continued-exact-partial';commits=[partial.head,head];
 }
 return {status:'SOURCE_MANIFEST_REMEDIATION_COMMIT_VERIFIED',base:K.COMPAT,head,tree:U.textGit(repo,['rev-parse',head+'^{tree}']),paths,mode,remediationCommits:commits};
}
function inspectStart(repo){
 verifyBranchClean(repo);const head=U.textGit(repo,['rev-parse','HEAD']);
 if(head===K.COMPAT)return{mode:'root',head,base:K.COMPAT};
 try{return{mode:'complete',...verifyHead(repo,head)};}catch(e){if(!['REMEDIATION_SCOPE_MISMATCH','REMEDIATION_COMMITTED_BYTES_CHANGED','PARTIAL_REMEDIATION_PARENT_MISMATCH','PARTIAL_REMEDIATION_SCOPE_MISMATCH','PARTIAL_REMEDIATION_BYTES_CHANGED','REMEDIATION_COMPLETION_SCOPE_MISMATCH'].includes(e?.code))throw e;}
 return{mode:'partial',...verifyLegacyPartial(repo,head)};
}
function runCheck(repo){const r=cp.spawnSync(process.execPath,[path.join(repo,'scripts/build-treasury-compat-loader.cjs'),'--check'],{cwd:repo,encoding:'utf8',timeout:120000,maxBuffer:8*1048576,windowsHide:true,env:{...process.env,DEST:'',DEPLOY_ALLOW_DIRTY:''}});
 if(r.status!==0||r.error||!String(r.stdout).includes('COMPAT_LOADER_REGENERATION_VERIFIED'))C.fail('REMEDIATED_GENERATOR_CHECK_FAILED');return {stdout:r.stdout,stderr:r.stderr};}
function writeRows(repo,out,rows){const snap=path.join(out,'snapshot');fs.mkdirSync(snap);for(const row of rows){const dst=path.join(repo,row.path);fs.mkdirSync(path.dirname(dst),{recursive:true});if(row.old){const b=fs.readFileSync(dst);const expected=row.path===completionPaths[0]?row.old:row.old;if(!sameIdentity(bytesIdentity(b),expected))C.fail('REMEDIATION_WORKTREE_BASE_CHANGED',{path:row.path});const sp=path.join(snap,row.path);fs.mkdirSync(path.dirname(sp),{recursive:true});fs.writeFileSync(sp,b);}else if(fs.existsSync(dst))C.fail('REMEDIATION_NEW_PATH_DIRTY',{path:row.path});fs.writeFileSync(dst,payload(row.path));}return snap;}
function rollback(repo,snap,rows){try{U.git(repo,['reset']);for(const row of rows){const dst=path.join(repo,row.path);if(row.old){const sp=path.join(snap,row.path);if(fs.existsSync(sp))fs.writeFileSync(dst,fs.readFileSync(sp));}else fs.rmSync(dst,{force:true});}}catch{}}
function commitRows(repo,out,rows,expectedPaths,message,extra={}){
 let committed=false,snap;try{
  snap=writeRows(repo,out,rows);
  const actual=statusPaths(repo);if(JSON.stringify(actual)!==JSON.stringify(expectedPaths))C.fail('REMEDIATION_DIRTY_SCOPE_MISMATCH',{actual});
  const check=runCheck(repo);C.durable(path.join(out,'generator-check.json'),{status:'REMEDIATED_GENERATOR_CHECK_VERIFIED',stdout:check.stdout,stderr:check.stderr});
  U.git(repo,['diff','--check']);U.git(repo,['add','--',...expectedPaths]);U.git(repo,['diff','--cached','--check']);
  for(const rel of expectedPaths)if(!U.git(repo,['show',':'+rel],true).equals(payload(rel)))C.fail('REMEDIATION_STAGED_BYTES_CHANGED',{path:rel});
  U.git(repo,['commit','-m',message]);committed=true;const head=U.textGit(repo,['rev-parse','HEAD']),v=verifyHead(repo,head);
  const result={...v,resumed:false,generatorCheck:'all-listed-outputs',packageFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))),...extra};C.durable(path.join(out,'result.json'),result);return result;
 }catch(e){if(!committed&&snap)rollback(repo,snap,rows);throw e;}
}
function execute(repo,out){verifyPayload();U.outside(out,repo);if(fs.existsSync(out))C.fail('OUTPUT_ALREADY_EXISTS');fs.mkdirSync(out,{recursive:false});
 const state=inspectStart(repo);
 if(state.mode==='complete'){
  const check=runCheck(repo);C.durable(path.join(out,'generator-check.json'),{status:'REMEDIATED_GENERATOR_CHECK_VERIFIED',stdout:check.stdout,stderr:check.stderr});
  const result={...state,resumed:true,generatorCheck:'all-listed-outputs',packageFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json')))};C.durable(path.join(out,'result.json'),result);return result;
 }
 if(U.remoteHead(repo,LOCK.compatBranch)!==K.COMPAT)C.fail('REMOTE_BASELINE_CHANGED');
 if(state.mode==='partial'){
  const rows=LOCK.changes.filter(x=>completionPaths.includes(x.path));
  return commitRows(repo,out,rows,completionPaths,LOCK.completionCommitMessage,{continuedFromPartial:state.head});
 }
 verifyBase(repo);return commitRows(repo,out,LOCK.changes,paths,LOCK.commitMessage,{continuedFromPartial:null});
}
module.exports={execute,verifyHead,verifyLegacyPartial,inspectStart,verifyPayload,statusPaths,paths,partialPaths,completionPaths,LOCK};
if(require.main===module)U.cli(async()=>{const o=U.options(['compat','out']);C.required(o,'compat','out');U.verifyPackage();console.log(JSON.stringify(execute(path.resolve(o.compat),path.resolve(o.out))));});
