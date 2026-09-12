'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('./fixture.cjs'),{completeEvidence}=require('./full-evidence.cjs'),U=require('../tools/util.cjs'),K=require('../runtime/policy.cjs'),C=require('../runtime/common.cjs');
const {archive,secretScan,ALLOW}=require('../tools/archive.cjs'),{verifyArchive}=require('../tools/publish.cjs');
test('real evidence assembly excludes private module snapshots and detects later tampering',()=>{
 const root=F.runDir(),repo=path.join(root,'repo'),run=path.join(root,'run'),pkg=path.join(root,'package'),tests=path.join(root,'tests'),offline=path.join(root,'offline');
 const old={base:K.REFACTOR,root:U.ROOT,verify:U.verifyPackage,digest:C.ORIGINAL_DIGEST};
 try{
  for(const d of [repo,run,pkg,tests,offline])fs.mkdirSync(d);
  U.git(repo,['init','-q']);U.git(repo,['config','user.email','fixture@example.invalid']);U.git(repo,['config','user.name','Fixture']);U.git(repo,['checkout','-b','refactor/empire-treasury-rearchitecture']);
  fs.mkdirSync(path.dirname(path.join(repo,K.EVIDENCE)),{recursive:true});fs.writeFileSync(path.join(repo,'.keep'),'fixture');U.git(repo,['add','.']);U.git(repo,['commit','-qm','base']);
  K.REFACTOR=U.textGit(repo,['rev-parse','HEAD']);U.ROOT=pkg;U.verifyPackage=()=>({});
  const s=F.makeSession();C.ORIGINAL_DIGEST=s.backup.digest;completeEvidence(run,s);
  fs.writeFileSync(path.join(pkg,'README.md'),'fixture package');fs.writeFileSync(path.join(tests,'summary.json'),'{}');fs.writeFileSync(path.join(offline,'result.json'),'{}');
  const secret=path.join(root,'secret.json');C.writeNew(secret,{main:{hostname:'screeps.com',branch:'default',token:'FAKE_ARCHIVE_SECRET_LONG_123456789'}});
  const r=archive({run,refactor:repo,tests,offline,secret});assert.equal(r.result,'ONLINE_COMPAT_READ_OBSERVED');verifyArchive(repo);
  for(const n of ['backup.json','candidate.json','session.json'])assert.equal(fs.existsSync(path.join(r.target,'run',n)),false);
  fs.appendFileSync(path.join(r.target,'EXECUTION-REPORT.md'),'changed');assert.throws(()=>verifyArchive(repo),{code:'ARCHIVE_BYTES_CHANGED'});
 }finally{K.REFACTOR=old.base;U.ROOT=old.root;U.verifyPackage=old.verify;C.ORIGINAL_DIGEST=old.digest;fs.rmSync(root,{recursive:true,force:true});}
});
test('archive allowlist never contains snapshots and scanner finds token representations',()=>{assert.equal(ALLOW.includes('candidate.json'),false);const s={token:'FAKE_ARCHIVE_SECRET_LONG_123456789'};assert.equal(secretScan(Buffer.from(s.token),s),true);assert.equal(secretScan(Buffer.from('normal evidence'),s),false);});
