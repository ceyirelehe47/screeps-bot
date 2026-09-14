'use strict';
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),X=require('./source.cjs');
function verifyArchive(repo,{staged=false}={}){
 const dir=path.join(repo,K.EVIDENCE),m=C.readJson(path.join(dir,'ARCHIVE-MANIFEST.json')),files=[];
 function walk(p){for(const n of fs.readdirSync(p)){const f=path.join(p,n),st=fs.lstatSync(f);if(st.isSymbolicLink())C.fail('ARCHIVE_SYMLINK');if(st.isDirectory())walk(f);else files.push(path.relative(dir,f).split(path.sep).join('/'));}}walk(dir);
 if(!C.same(files.filter(n=>n!=='ARCHIVE-MANIFEST.json').sort(),Object.keys(m.files).sort()))C.fail('ARCHIVE_FILE_SET_CHANGED');
 if(m.kind!=='compat-subphase-online-X-retry-I-archive/v1'||m.refactorBase!==K.REFACTOR||m.compatBase!==K.COMPAT||m.sourceHead!==K.COMPAT
  ||!/^[0-9a-f]{40}$/.test(m.compatClosedHead||'')||m.packageFingerprint!==C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json')))
  ||m.readRetry?.readOnly!==true||m.readRetry?.writeRetries!==0)C.fail('ARCHIVE_IDENTITY_CHANGED');
 const inv=C.readJson(path.join(U.ROOT,'INTEGRITY.json'));
 for(const[n,x]of Object.entries(m.files)){const b=fs.readFileSync(path.join(dir,n));if(b.length!==x.bytes||C.sha256(b)!==x.sha256)C.fail('ARCHIVE_BYTES_CHANGED');
  if(n.startsWith('task-package/')){const rel=n.slice(13);if(!Object.hasOwn(inv.files,rel)&&rel!=='INTEGRITY.json')C.fail('UNEXPECTED_EMBEDDED_PACKAGE_FILE');if(!b.equals(fs.readFileSync(path.join(U.ROOT,rel))))C.fail('EMBEDDED_PACKAGE_CHANGED');}
  if(staged&&!U.git(repo,['show',':'+K.EVIDENCE+'/'+n],true).equals(b))C.fail('STAGED_BYTES_CHANGED');}
 if(staged&&!U.git(repo,['show',':'+K.EVIDENCE+'/ARCHIVE-MANIFEST.json'],true).equals(fs.readFileSync(path.join(dir,'ARCHIVE-MANIFEST.json'))))C.fail('STAGED_MANIFEST_CHANGED');
 const recomputed=require('./compare.cjs').makeComparison(path.join(dir,'run'));if(!C.same(C.readJson(path.join(dir,'SUBPHASE-ATTRIBUTION.json')),recomputed))C.fail('ATTRIBUTION_EVIDENCE_CHANGED');
 return m;
}
function sourceClosed(compat,m){
 U.clean(compat);if(U.textGit(compat,['branch','--show-current'])!=='compat/treasury-read-bridge-i')C.fail('COMPAT_BRANCH_CHANGED');
 const head=U.textGit(compat,['rev-parse','HEAD']);
 if(head===K.COMPAT){X.verifyHead(compat);if(m.compatClosedHead!==K.COMPAT)C.fail('ARCHIVE_CLOSE_HEAD_MISMATCH');return head;}
 if(head!==m.compatClosedHead||U.textGit(compat,['rev-parse','HEAD~2'])!==K.COMPAT)C.fail('COMPAT_CHAIN_CHANGED');
 const on=U.textGit(compat,['rev-parse','HEAD^']);if(U.textGit(compat,['rev-parse',on+'^'])!==K.COMPAT
  ||U.textGit(compat,['rev-parse','HEAD^{tree}'])!==X.SOURCE_TREE||U.textGit(compat,['rev-parse',K.COMPAT+'^{tree}'])!==X.SOURCE_TREE
  ||U.textGit(compat,['diff','--name-only',K.COMPAT,on])!==K.CONFIG||U.textGit(compat,['diff','--name-only',on,head])!==K.CONFIG)C.fail('COMPAT_NOT_EXACT_OFF_CLOSE');
 return head;
}
function stageGate(refactor,compat){
 U.verifyPackage();const m=verifyArchive(refactor);sourceClosed(compat,m);
 if(U.textGit(refactor,['rev-parse','HEAD'])!==K.REFACTOR||U.textGit(refactor,['branch','--show-current'])!=='refactor/empire-treasury-rearchitecture')C.fail('REFACTOR_MOVED');
 const allowed=x=>x.startsWith(K.EVIDENCE+'/');for(const args of [['diff','--name-only'],['diff','--cached','--name-only'],['ls-files','--others','--exclude-standard']])if(U.textGit(refactor,args).split('\n').filter(Boolean).some(x=>!allowed(x)))C.fail('UNRELATED_CHANGES');
 U.git(refactor,['add','--',K.EVIDENCE]);verifyArchive(refactor,{staged:true});const staged=U.textGit(refactor,['diff','--cached','--name-only']).split('\n').filter(Boolean);
 if(!staged.length||staged.some(x=>!allowed(x)))C.fail('STAGED_SCOPE_INVALID');U.git(refactor,['diff','--cached','--check']);
 return {status:'SUBPHASE_X_RETRY_STAGED_BYTES_AND_WHITESPACE_VERIFIED',tree:U.textGit(refactor,['write-tree']),files:staged.length,whitespaceExceptions:0};
}
function publish(refactor,compat,{out,push=false}={}){
 U.verifyPackage();U.outside(out,refactor);U.outside(out,compat);if(fs.existsSync(out))C.fail('OUTPUT_ALREADY_EXISTS');
 const m=verifyArchive(refactor),compatHead=sourceClosed(compat,m);let head=U.textGit(refactor,['rev-parse','HEAD']),gate;
 if(head===K.REFACTOR){gate=stageGate(refactor,compat);U.git(refactor,['commit','-m','evidence(compat): subphase online X retry I attribution and recovery']);head=U.textGit(refactor,['rev-parse','HEAD']);
  if(U.textGit(refactor,['rev-parse','HEAD^'])!==K.REFACTOR||U.textGit(refactor,['rev-parse','HEAD^{tree}'])!==gate.tree)C.fail('POST_COMMIT_TREE_CHANGED');}
 else{U.clean(refactor);if(U.textGit(refactor,['rev-parse','HEAD^'])!==K.REFACTOR||U.textGit(refactor,['diff','--name-only',K.REFACTOR,head]).split('\n').filter(Boolean).some(x=>!x.startsWith(K.EVIDENCE+'/')))C.fail('UNRECOGNIZED_EVIDENCE_HEAD');
  U.git(refactor,['diff','--check',K.REFACTOR,head]);for(const n of [...Object.keys(m.files),'ARCHIVE-MANIFEST.json'])if(!U.git(refactor,['show',head+':'+K.EVIDENCE+'/'+n],true).equals(fs.readFileSync(path.join(refactor,K.EVIDENCE,n))))C.fail('COMMITTED_BYTES_CHANGED');
  gate={status:'EXISTING_EVIDENCE_COMMIT_VERIFIED',tree:U.textGit(refactor,['rev-parse','HEAD^{tree}']),whitespaceExceptions:0};}
 U.clean(refactor);U.clean(compat);
 if(push){const r=U.remoteHead(refactor,'refactor/empire-treasury-rearchitecture'),c=U.remoteHead(compat,'compat/treasury-read-bridge-i');if(![K.REFACTOR,head].includes(r)||![K.COMPAT,compatHead].includes(c))C.fail('REMOTE_DRIFT_NO_FORCE_PUSH');
  if(c!==compatHead)U.git(compat,['push','origin','HEAD:refs/heads/compat/treasury-read-bridge-i']);if(r!==head)U.git(refactor,['push','origin','HEAD:refs/heads/refactor/empire-treasury-rearchitecture']);
  if(U.remoteHead(refactor,'refactor/empire-treasury-rearchitecture')!==head||U.remoteHead(compat,'compat/treasury-read-bridge-i')!==compatHead)C.fail('PUSH_READBACK_MISMATCH');}
 const result={status:push?'SUBPHASE_X_RETRY_EVIDENCE_PUSHED':'SUBPHASE_X_RETRY_EVIDENCE_COMMITTED',refactorHead:head,compatHead,sourceHead:K.COMPAT,gate,pushed:push};C.durable(out,result);return result;
}
module.exports={verifyArchive,stageGate,publish,sourceClosed};
if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat','out'],['push','check-only']);C.required(o,'refactor','compat');if(o['check-only'])console.log(JSON.stringify(stageGate(o.refactor,o.compat)));else{C.required(o,'out');console.log(JSON.stringify(publish(o.refactor,o.compat,{out:o.out,push:!!o.push})));}});
