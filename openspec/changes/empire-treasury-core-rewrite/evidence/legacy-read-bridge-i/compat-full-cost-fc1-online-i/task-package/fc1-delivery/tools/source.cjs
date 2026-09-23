'use strict';
const C=require('./common.cjs'),A=require('./adapt-executor.cjs'),{fs,path,ROOT,P}=C;
function runtimeIdentity(b){return {bytes:b.length,sha256:C.sha(b),gitBlob:C.blob(b)};}
function generator(text,b){const v=runtimeIdentity(b);return A.once(text,
 "'src/runtime/treasuryCompatRuntime.ts': { bytes: 956, sha256: '7250f9554baca9c2431d109f14c45ebece7df04de95e79e53146f9996dfffe6c', gitBlob: '13e8e356784da1c606e9c1cc8fccdaaa8d436b0c' }",
 `'src/runtime/treasuryCompatRuntime.ts': { bytes: ${v.bytes}, sha256: '${v.sha256}', gitBlob: '${v.gitBlob}' }`);}
function historicalTest(text){return A.once(text,
 "test('XIII runtime enables trace and local stop without modifying frozen OFF config',()=>{const text=fs.readFileSync(H.file('treasuryCompatRuntime.ts'),'utf8');assert.match(text,/commitmentBoundaryDiagnostics: true/);assert.match(text,/localSafetyStop: true/);assert.match(fs.readFileSync(H.file('treasuryCompatConfig.ts'),'utf8'),/enabled: false/);});",
 `test('XIII historical runtime retains its original latch; FC1 explicitly owns native admission',()=>{
 const historical=fs.readFileSync(path.join(__dirname,'fixtures/runtime-before-full-cost-fc1.ts.txt'),'utf8');
 assert.equal(G.blob(Buffer.from(historical)),'13e8e356784da1c606e9c1cc8fccdaaa8d436b0c');
 assert.match(historical,/commitmentBoundaryDiagnostics: true/);assert.match(historical,/localSafetyStop: true/);
 const current=fs.readFileSync(H.file('treasuryCompatRuntime.ts'),'utf8');
 assert.match(current,/commitmentBoundaryDiagnostics: true/);assert.match(current,/localSafetyStop: false/);
 assert.match(current,/admissionHeadroomCpu: 55/);assert.match(current,/CPU_OBSERVED_EXPOSURE_STOP/);
 assert.match(fs.readFileSync(H.file('treasuryCompatConfig.ts'),'utf8'),/enabled: false/);
});`);}
function authorizationUnused(repo){let common=C.text(repo,['rev-parse','--git-common-dir']);common=path.resolve(repo,common);C.check(!fs.existsSync(path.join(common,'treasury-experiments',P.authorizationId+'.json')),'FC1_AUTHORIZATION_ALREADY_CONSUMED');}
function verifyFrozenReaders(repo){const core=C.read(path.join(repo,P.corePath)),preview=C.read(path.join(repo,P.previewPath));C.check(C.sha(core)===P.coreSha256&&C.blob(preview)===P.previewBlob,'R1_READERS_CHANGED');}
function apply(repo,out){C.baseline(repo,P.compatBranch,P.compatBase);C.check(C.tree(repo)===P.compatBaseTree,'BASE_TREE_CHANGED');authorizationUnused(repo);verifyFrozenReaders(repo);
 const runtime=C.read(path.join(ROOT,'implementation/treasuryCompatRuntime.ts')),beforeRuntime=C.git(repo,['show',P.compatBase+':'+P.runtimePath]);C.check(C.blob(beforeRuntime)===P.runtimeBeforeBlob,'RUNTIME_BASE_CHANGED');
 const hist='test/treasury-compat/boundary-attribution-xiii.spec.cjs',histBytes=C.git(repo,['show',P.compatBase+':'+hist]);C.check(C.blob(histBytes)==='d06bacf843f8d1e9d38b00fedb66c4bf99ada05a','HISTORICAL_RUNTIME_TEST_CHANGED');
 C.command(repo,[P.generatorPath,'--check'],out,'generator-before');
 const writes={
  [P.runtimePath]:runtime,
  [P.generatorPath]:Buffer.from(generator(C.git(repo,['show',P.compatBase+':'+P.generatorPath]).toString('utf8'),runtime)),
  [hist]:Buffer.from(historicalTest(histBytes.toString('utf8'))),
  'test/treasury-compat/fixtures/runtime-before-full-cost-fc1.ts.txt':beforeRuntime,
  'test/treasury-compat/full-cost-fc1.spec.cjs':C.read(path.join(ROOT,'tests/full-cost-fc1.spec.cjs')),
 };
 for(const[n,b]of Object.entries(writes)){const f=path.join(repo,n);if(fs.existsSync(f))C.check(!fs.lstatSync(f).isSymbolicLink(),'SOURCE_SYMLINK');fs.writeFileSync(f,b);}
 C.command(repo,[P.generatorPath,'--write'],out,'generator-write');C.command(repo,[P.generatorPath,'--check'],out,'generator-after');verifyFrozenReaders(repo);
 const dirty=[...new Set([...C.git(repo,['diff','--name-only','-z','HEAD']).toString('utf8').split('\0'),...C.git(repo,['ls-files','--others','--exclude-standard','-z']).toString('utf8').split('\0')].filter(Boolean))].sort();C.check(C.same(dirty,P.sourcePaths),'SOURCE_PATH_SET_CHANGED');
 C.git(repo,['add','--',...P.sourcePaths]);C.git(repo,['diff','--cached','--check']);C.git(repo,['commit','-m',P.sourceMessage]);C.clean(repo);
 const source={head:C.head(repo),tree:C.tree(repo),base:P.compatBase,paths:P.sourcePaths.length,defaultOff:true,readersUnchanged:true};
 C.check(C.text(repo,['show','-s','--format=%P',source.head])===P.compatBase,'SOURCE_PARENT_CHANGED');
 const files={};for(const n of P.sourcePaths){const before=C.git(repo,['show',P.compatBase+':'+n],{allowFailure:true}),after=C.git(repo,['show',source.head+':'+n]);files[n]={before:before?runtimeIdentity(before):null,after:runtimeIdentity(after)};}
 const manifest={kind:'full-cost-FC1-source/v1',base:P.compatBase,baseTree:P.compatBaseTree,expectedSourceTree:source.tree,files};return {source,manifest};
}
module.exports={runtimeIdentity,generator,historicalTest,authorizationUnused,verifyFrozenReaders,apply};
