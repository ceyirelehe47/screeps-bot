'use strict';
const fs=require('node:fs'),path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
function verifyArchive(repo){const dir=path.join(repo,K.EVIDENCE),m=C.readJson(path.join(dir,'ARCHIVE-MANIFEST.json'));const list=[];
 function walk(p){for(const n of fs.readdirSync(p)){const f=path.join(p,n),st=fs.lstatSync(f);if(st.isSymbolicLink())C.fail('ARCHIVE_SYMLINK');if(st.isDirectory())walk(f);else list.push(path.relative(dir,f).split(path.sep).join('/'));}}walk(dir);
 if(JSON.stringify(list.filter(x=>x!=='ARCHIVE-MANIFEST.json').sort())!==JSON.stringify(Object.keys(m.files).sort()))C.fail('ARCHIVE_FILE_SET_CHANGED');
 for(const[n,x]of Object.entries(m.files)){const b=fs.readFileSync(path.join(dir,n));if(b.length!==x.bytes||C.sha256(b)!==x.sha256)C.fail('ARCHIVE_BYTES_CHANGED');}
 return dir;
}
function publish(refactor,compat,push){
 U.verifyPackage();verifyArchive(refactor);
 if(U.textGit(refactor,['rev-parse','HEAD'])!==K.REFACTOR||U.textGit(refactor,['branch','--show-current'])!=='refactor/empire-treasury-rearchitecture')C.fail('REFACTOR_MOVED');
 if(U.textGit(refactor,['diff','--name-only'])||U.textGit(refactor,['diff','--cached','--name-only']))C.fail('UNRELATED_TRACKED_CHANGES');
 const untracked=U.textGit(refactor,['ls-files','--others','--exclude-standard']).split('\n').filter(Boolean);
 if(untracked.some(x=>!x.startsWith(K.EVIDENCE+'/')))C.fail('UNRELATED_UNTRACKED_FILES');
 U.clean(compat);const compatHead=U.textGit(compat,['rev-parse','HEAD']);
 const closedPath=path.join(refactor,K.EVIDENCE,'run/source-closed.json');
 if(compatHead!==K.COMPAT){const closed=C.readJson(closedPath);if(compatHead!==closed.closedHead||!closed.sameTreeAsCompatBase)C.fail('COMPAT_NOT_CLOSED');
  if(U.textGit(compat,['rev-parse','HEAD^{tree}'])!==U.textGit(compat,['rev-parse',K.COMPAT+'^{tree}']))C.fail('COMPAT_TREE_NOT_DEFAULT_OFF');}
 if(U.remoteHead(refactor,'refactor/empire-treasury-rearchitecture')!==K.REFACTOR||U.remoteHead(compat,'compat/treasury-read-bridge-i')!==K.COMPAT)C.fail('REMOTE_MOVED_NO_FORCE_PUSH');
 U.git(refactor,['add','--',K.EVIDENCE]);const staged=U.textGit(refactor,['diff','--cached','--name-only']).split('\n').filter(Boolean);if(staged.some(p=>!p.startsWith(K.EVIDENCE+'/')))C.fail('COMMIT_SCOPE_INVALID');
 U.git(refactor,['commit','--no-gpg-sign','-m','evidence(compat): formal observation 0003 execution and closure']);const head=U.textGit(refactor,['rev-parse','HEAD']);
 if(push){if(compatHead!==K.COMPAT)U.git(compat,['push','origin','HEAD:refs/heads/compat/treasury-read-bridge-i']);U.git(refactor,['push','origin','HEAD:refs/heads/refactor/empire-treasury-rearchitecture']);}
 return {status:push?'FORMAL_0003_EVIDENCE_PUSHED':'FORMAL_0003_EVIDENCE_COMMITTED',refactorHead:head,compatHead};
}
module.exports={verifyArchive,publish};if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat'],['push']);C.required(o,'refactor','compat');console.log(JSON.stringify(publish(o.refactor,o.compat,!!o.push)));});
