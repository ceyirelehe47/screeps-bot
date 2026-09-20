'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),cp=require('node:child_process'),vm=require('node:vm');
const Q=require('../tools/source-contract.cjs');
const fixture=require('./fixtures/authenticated-source-scope.json');
const original=fs.readFileSync(path.join(__dirname,'fixtures/retry-v1-source.cjs.txt'),'utf8');
const manifest=fs.readFileSync(path.join(__dirname,'../references/implementation-lock.json'));
const hash=(type,b)=>crypto.createHash('sha1').update(Buffer.from(type+' '+b.length+'\0')).update(b).digest('hex');
function git(repo,args){return cp.execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}
function withObjects(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'retry-authenticated-source-'));
 try{
  git(root,['init','--quiet']);
  for(const o of fixture.objects){
   const b=Buffer.from(o.dataBase64,'base64');assert.equal(hash(o.type,b),o.sha);
   const p=path.join(root,'.git','objects',o.sha.slice(0,2),o.sha.slice(2));
   fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,zlib.deflateSync(Buffer.concat([Buffer.from(o.type+' '+b.length+'\0'),b])));
  }
  return fn(root);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
function loadOriginal(){
 const exports={},module={exports};
 // Real Git is used. The unused full-worktree freeze dependency is absent in
 // this intentionally sparse object fixture; verifyPinned never calls it.
 const C={fail(code){const e=new Error(code);e.code=code;throw e;}};
 const U={textGit:(repo,args)=>git(repo,args).trim()};
 const K={COMPAT:Q.SOURCE_HEAD,SOURCE_TREE:Q.SOURCE_TREE};
 vm.runInNewContext(original,{exports,module,require:n=>{
  if(n==='./util.cjs')return U;if(n==='../runtime/common.cjs')return C;
  if(n==='../runtime/policy.cjs')return K;if(n==='../runtime/check-profile.cjs')return {};
  throw new Error('unexpected import');
 }});return module.exports;
}
test('source path authority is the exact archived v4 manifest, not another hand-written list',()=>{
 const m=JSON.parse(manifest);assert.deepEqual(Q.PATHS,[...m.sourceImplementation.paths].sort());
 assert.equal(Q.CONTRACT.manifestBlob,'b94574b9f8a5cd0b6b61842f9200d0f18a3843e7');assert.ok(Object.isFrozen(Q.PATHS));
});
test('one-byte manifest edits fail before any Git or network access',()=>{const b=Buffer.from(manifest);b[0]^=1;assert.throws(()=>Q.parseManifest(b),e=>e.code==='ENVELOPE_XII_RETRY_SOURCE_MANIFEST_CHANGED');});
test('all 20 regression objects authenticate to their real Git SHAs',()=>{assert.equal(fixture.objects.length,20);for(const o of fixture.objects)assert.equal(hash(o.type,Buffer.from(o.dataBase64,'base64')),o.sha);});
test('real Git resolves the exact source commit, tree and parent from authenticated objects',()=>withObjects(repo=>{
 assert.equal(git(repo,['rev-parse',Q.SOURCE_HEAD+'^{tree}']).trim(),Q.SOURCE_TREE);
 assert.equal(git(repo,['show','-s','--format=%P',Q.SOURCE_HEAD]).trim(),Q.SOURCE_PARENT);
}));
test('real Git diff of the authentic two commits matches all eleven authoritative paths',()=>withObjects(repo=>{
 const paths=git(repo,['diff','--no-renames','--name-only','-z',Q.SOURCE_PARENT,Q.SOURCE_HEAD]).slice(0,-1).split('\0');
 assert.deepEqual(paths,Q.PATHS);assert.deepEqual(paths,fixture.expectedChangedPaths);
}));
test('unmodified Retry v1 verifier reproduces the reported deterministic failure on the authentic commit',()=>withObjects(repo=>{
 assert.throws(()=>loadOriginal().verifyPinned(repo),e=>e.code==='ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED');
}));
test('corrected production verifier accepts the same authentic source commit without source edits',()=>withObjects(repo=>{
 const before=git(repo,['rev-parse',Q.SOURCE_HEAD+'^{tree}']).trim(),r=Q.verifyPinned(repo);
 assert.equal(r.status,'ENVELOPE_XII_RETRY_SOURCE_OBJECT_VERIFIED');assert.equal(r.changedPaths,11);
 assert.deepEqual(r.paths,Q.PATHS);assert.equal(r.tree,before);assert.equal(r.head,Q.SOURCE_HEAD);
}));
test('same-count replacement of attribution with an unchanged test is rejected',()=>{
 const a=Q.PATHS.map(p=>p==='test/treasury-compat/attribution.spec.cjs'?'test/treasuryCompatRead.test.ts':p);
 assert.throws(()=>Q.assertScope(a),e=>e.code==='ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED');
});
test('each wrong diagnostic-envelope fixture name is rejected independently',()=>{
 for(const prefix of ['cpu','reader']){const a=Q.PATHS.map(p=>p.endsWith(prefix+'-before-envelope-optimization-xii.ts.txt')?p.replace('before-envelope-optimization','before-diagnostic-envelope'):p);
 assert.throws(()=>Q.assertScope(a),e=>e.code==='ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED');}
});
test('missing, extra and duplicated paths fail closed',()=>{
 for(const a of [Q.PATHS.slice(1),[...Q.PATHS,'src/unrelated.ts'],[...Q.PATHS.slice(1),Q.PATHS[1]]])assert.throws(()=>Q.assertScope(a),e=>e.code==='ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED');
});
test('path order does not alter exact set membership',()=>assert.deepEqual(Q.assertScope([...Q.PATHS].reverse()),Q.PATHS));
test('source wrapper and publish reuse the same pinned verifier',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../tools/source.cjs'),'utf8'),publish=fs.readFileSync(path.join(__dirname,'../tools/publish.cjs'),'utf8');
 assert.match(source,/Q\.verifyPinned\(repo\)/);assert.match(publish,/X\.verifyPinned\(compat\)/);
 assert.doesNotMatch(source,/const PATHS=Object\.freeze\(\[/);
});

test('source reuse keeps its explicit terminal status instead of a spread overriding it',()=>{
 const text=fs.readFileSync(path.join(__dirname,'../tools/apply.cjs'),'utf8'),module={exports:{}};let written;
 const U={verifyPackage(){},outside(){},cli(){throw new Error('CLI must not run');}};
 const C={durable(_out,r){written=r;return r;}};const X={verifyHead(){return {status:'ENVELOPE_XII_RETRY_SOURCE_VERIFIED',head:Q.SOURCE_HEAD,tree:Q.SOURCE_TREE};}};
 const requireStub=n=>{if(n==='node:path')return path;if(n==='node:fs')return {existsSync:()=>false};if(n==='./util.cjs')return U;if(n==='../runtime/common.cjs')return C;if(n==='./source.cjs')return X;throw new Error(n);};
 vm.runInNewContext(text,{module,exports:module.exports,require:requireStub});
 const r=module.exports.apply('unit-repo','unit-output');assert.equal(r.status,'ENVELOPE_XII_RETRY_SOURCE_REUSED_VERIFIED');
 assert.equal(r.sourceModified,false);assert.equal(r.migrated,false);assert.equal(r.resumed,true);assert.equal(written,r);
});
