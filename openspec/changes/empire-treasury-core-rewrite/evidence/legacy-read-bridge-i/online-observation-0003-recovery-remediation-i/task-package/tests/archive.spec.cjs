'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const A=require('../tools/archive.cjs'),U=require('../tools/util.cjs'),C=require('../runtime/common.cjs'),F=require('./fixture.cjs');
test('archive is byte-exact through Git with autocrlf true including CRLF stderr',()=>{const root=F.root(),repo=path.join(root,'repo');try{F.initGit(repo);F.git(repo,['config','core.autocrlf','true']);
 const payload=new Map([['failure.stderr',Buffer.from('line one\r\nline two\r\n')],['runtime/foo.cjs',Buffer.from('module.exports = {};\n')]]);
 const r=A.writeArchive(repo,'evidence',payload,{sourceCommit:'fixture',closureStatus:'ONLINE_CLOSE_UNCONFIRMED'});assert.equal(r.files,4);
 F.git(repo,['add','evidence']);assert.equal(A.verifyArchive(repo,'evidence',{staged:true}).files,4);
 }finally{fs.rmSync(root,{recursive:true,force:true});}});
test('archive verifier rejects bytes changed after assembly',()=>{const root=F.root(),repo=path.join(root,'repo');try{F.initGit(repo);A.writeArchive(repo,'evidence',new Map([['result.json',Buffer.from('{}\n')]]),{});fs.appendFileSync(path.join(repo,'evidence/result.json'),' ');assert.throws(()=>A.verifyArchive(repo,'evidence'),{code:'ARCHIVE_BYTES_CHANGED'});}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('archive whitelist excludes original private snapshots and old private session',()=>{for(const n of ['backup.json','candidate.json','session.json','.secret.json'])assert.equal(A.CLOSURE_FILES.includes(n),false);});
test('secret scan detects all supported representations and never returns secret text',()=>{const token='SECRET_FIXTURE/slash+long=value';for(const n of [token,encodeURIComponent(token),token.slice(0,8),token.slice(0,16)])assert.equal(A.secretScan(Buffer.from(n),token),true);assert.equal(A.secretScan(Buffer.from('safe report'),token),false);});
test('package integrity uses exact case and ignores enumeration ordering only',()=>{const root=F.root();try{fs.writeFileSync(path.join(root,'Z-file.txt'),'z',{flag:'wx'});fs.writeFileSync(path.join(root,'a-other.txt'),'a',{flag:'wx'});
 const files={'a-other.txt':{bytes:1,sha256:C.sha256('a')},'Z-file.txt':{bytes:1,sha256:C.sha256('z')}};C.durable(path.join(root,'INTEGRITY.json'),{files});assert.equal(U.verifyPackage(root).files,2);
 const m={files:{...files,'z-file.txt':files['Z-file.txt']}};delete m.files['Z-file.txt'];fs.writeFileSync(path.join(root,'INTEGRITY.json'),JSON.stringify(m));assert.throws(()=>U.verifyPackage(root),{code:'PACKAGE_FILE_SET_MISMATCH'});
 }finally{fs.rmSync(root,{recursive:true,force:true});}});
async function assemblyFixture(mutate=false){
 const K=require('../runtime/pins.cjs'),R=require('../runtime/replay.cjs'),V=require('../runtime/verify-closure.cjs'),G=require('../runtime/closure.cjs');
 const root=F.root(),repo=path.join(root,'repo'),pkg=path.join(root,'package'),source=path.join(root,'source'),prior=path.join(root,'prior'),closure=path.join(root,'closure'),tests=path.join(root,'tests'),replay=path.join(root,'replay');
 F.initGit(repo);for(const p of [pkg,source,tests,replay])fs.mkdirSync(p);fs.mkdirSync(path.join(pkg,'references'));fs.mkdirSync(path.join(source,'run'));
 const s=F.session();const pub=F.priorFiles(prior,s),w=F.fakeApi(s);
 await G.close0003({api:w.api,s,prior,out:closure,executeRecovery:true,exclusiveTarget:true,priorWorkersStopped:true,secret:F.secret,pause:async()=>{},observer:F.fastObserver});
 C.durable(path.join(source,'run/public-session.json'),pub);fs.writeFileSync(path.join(source,'run/console.jsonl'),F.firstFrame(s));
 const sourceRecord={status:'SOURCE_0003_BYTES_VERIFIED',files:29,sourceCommit:K.refactor,runTree:K.runTree};
 C.durable(path.join(source,'MANIFEST.json'),sourceRecord);
 const rr=R.replay(F.firstFrame(s),pub);C.durable(path.join(replay,'replay.json'),{...rr,source:sourceRecord});
 C.durable(path.join(replay,'CPU-EVIDENCE.json'),{reports:rr.cpuFindings,budgetModified:false,productionOptimizationImplemented:false});
 C.durable(path.join(pkg,'INTEGRITY.json'),{files:{}});C.durable(path.join(pkg,'references/test-contract.json'),{tests:1});
 C.durable(path.join(tests,'summary.json'),{status:'RECOVERY_0003_IMPLEMENTATION_TESTS_VERIFIED',tests:1,passed:1,failed:0,skipped:0,packageFingerprint:C.sha256(C.bytes(path.join(pkg,'INTEGRITY.json')))});
 fs.writeFileSync(path.join(tests,'tests.tap'),'# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n');fs.writeFileSync(path.join(tests,'tests.stderr'),'');C.durable(path.join(tests,'tests.exit.json'),{code:0});
 const secretFile=path.join(root,'credential.json');C.durable(secretFile,{main:{hostname:'screeps.com',branch:'default',token:F.secret.token}});
 fs.mkdirSync(path.dirname(path.join(repo,K.evidenceTarget)),{recursive:true});
 const saved={root:U.ROOT,heads:U.heads,verifyPackage:U.verifyPackage,verifySource:U.verifySource,verifyClosure:V.verifyClosure};
 try{
  // Provenance gates are tested with real Git separately. This case tests deterministic assembly wiring only.
  U.ROOT=pkg;U.heads=()=>({});U.verifyPackage=()=>({});U.verifySource=()=>sourceRecord;V.verifyClosure=(out,p)=>saved.verifyClosure(out,p,{runtimeMs:250,silenceMs:1000});
  if(mutate){const r=C.json(path.join(replay,'replay.json'));r.completeBridgeReports=12;fs.writeFileSync(path.join(replay,'replay.json'),JSON.stringify(r));
   assert.throws(()=>A.archive({refactor:repo,compat:repo,source,closure,replay,tests,secret:secretFile}),{code:'REPLAY_OUTPUT_CHANGED'});assert.equal(fs.existsSync(path.join(repo,K.evidenceTarget)),false);
  }else{
   const r=A.archive({refactor:repo,compat:repo,source,closure,replay,tests,secret:secretFile});assert.equal(r.closure,'RECOVERY_CLOSURE_VERIFIED');
   F.git(repo,['add',K.evidenceTarget]);assert.equal(A.verifyArchive(repo,K.evidenceTarget,{staged:true}).status,'RECOVERY_0003_ARCHIVE_VERIFIED');
   assert.equal(C.list(r.target).some(n=>n==='recovery/backup.json'||n==='recovery/candidate.json'),false);
  }
 }finally{U.ROOT=saved.root;U.heads=saved.heads;U.verifyPackage=saved.verifyPackage;U.verifySource=saved.verifySource;V.verifyClosure=saved.verifyClosure;fs.rmSync(root,{recursive:true,force:true});}
}
test('closure, replay, deterministic archive and staged byte checks compose without extra implementation',async()=>assemblyFixture(false));
test('assembly recomputes replay and refuses a forged complete sample count',async()=>assemblyFixture(true));
