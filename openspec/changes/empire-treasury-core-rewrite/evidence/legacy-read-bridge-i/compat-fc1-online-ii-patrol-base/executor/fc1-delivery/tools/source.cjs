'use strict';
const C=require('./common.cjs'),A=require('./adapt-executor.cjs'),{fs,path,ROOT,P}=C;
function runtimeIdentity(b){return {bytes:b.length,sha256:C.sha(b),gitBlob:C.blob(b)};}
function runtimeEmitterId(b){const id=/\bFULL_COST_EXPERIMENT\s*=\s*["']([^"']+)["']/.exec(b.toString('utf8'))?.[1];C.check(id===P.runtimeEmitterId,'RUNTIME_EMITTER_IDENTITY_MISMATCH');return id;}
const runtimeModuleSpecs=[
 {sourcePath:P.runtimePath,outputName:'treasuryCompatRuntime.cjs'},
 {sourcePath:P.previewPath,outputName:'treasuryCompatRead.cjs'},
 {sourcePath:P.corePath,outputName:'treasuryCompatReadCore.generated.cjs'},
 {sourcePath:'src/runtime/treasuryCompatCpu.ts',outputName:'treasuryCompatCpu.cjs'},
];
function compileRuntimeArtifacts(repo,sourceHead,typescriptPath=path.join(repo,'node_modules/typescript')){
 const tsPackage=C.json(path.join(typescriptPath,'package.json'));C.check(tsPackage.version===P.compilerVersion,'PINNED_TYPESCRIPT_REQUIRED');
 const ts=require(typescriptPath),files={};
 for(const spec of runtimeModuleSpecs){
  const source=C.git(repo,['show',sourceHead+':'+spec.sourcePath]);
  if(spec.sourcePath===P.runtimePath)runtimeEmitterId(source);
  if(spec.sourcePath===P.previewPath)C.check(C.blob(source)===P.previewBlob,'R1_PREVIEW_SOURCE_CHANGED');
  if(spec.sourcePath===P.corePath)C.check(C.sha(source)===P.coreSha256,'R1_CORE_SOURCE_CHANGED');
  const result=ts.transpileModule(source.toString('utf8'),{reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}});
  C.check(!(result.diagnostics??[]).some(d=>d.category===ts.DiagnosticCategory.Error),'RUNTIME_SOURCE_TRANSPILE_FAILED:'+spec.sourcePath);
  const emitted=Buffer.from(result.outputText,'utf8');
  files[spec.outputName]={sourcePath:spec.sourcePath,sourceBytes:source.length,sourceSha256:C.sha(source),sourceGitBlob:C.blob(source),outputBytes:emitted.length,outputSha256:C.sha(emitted),outputText:result.outputText};
 }
 return{compilerVersion:ts.version,files};
}
function runtimeArtifactsManifest(artifacts){return{compilerVersion:artifacts.compilerVersion,files:Object.fromEntries(Object.entries(artifacts.files).map(([name,file])=>[name,{sourcePath:file.sourcePath,sourceBytes:file.sourceBytes,sourceSha256:file.sourceSha256,sourceGitBlob:file.sourceGitBlob,outputBytes:file.outputBytes,outputSha256:file.outputSha256}]))};}
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
 const runtime=C.read(path.join(ROOT,'implementation/treasuryCompatRuntime.ts')),emitter=runtimeEmitterId(runtime),beforeRuntime=C.git(repo,['show',P.compatBase+':'+P.runtimePath]);C.check(C.blob(beforeRuntime)===P.runtimeBeforeBlob,'RUNTIME_BASE_CHANGED');
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
 const source={head:C.head(repo),tree:C.tree(repo),base:P.compatBase,paths:P.sourcePaths.length,defaultOff:true,readersUnchanged:true,runtimeEmitterId:emitter};
 C.check(C.text(repo,['show','-s','--format=%P',source.head])===P.compatBase,'SOURCE_PARENT_CHANGED');
 const files={};for(const n of P.sourcePaths){const before=C.git(repo,['show',P.compatBase+':'+n],{allowFailure:true}),after=C.git(repo,['show',source.head+':'+n]);files[n]={before:before?runtimeIdentity(before):null,after:runtimeIdentity(after)};}
 const runtimeArtifacts=compileRuntimeArtifacts(repo,source.head),artifactManifest=runtimeArtifactsManifest(runtimeArtifacts);
 source.runtimeArtifacts={compilerVersion:runtimeArtifacts.compilerVersion,modules:Object.keys(runtimeArtifacts.files).length};
 const manifest={kind:'full-cost-FC1-source/v1',base:P.compatBase,baseTree:P.compatBaseTree,expectedSourceTree:source.tree,runtimeEmitterId:emitter,runtimeArtifacts:artifactManifest,files};return {source,manifest,runtimeArtifacts};
}
module.exports={runtimeIdentity,runtimeEmitterId,runtimeModuleSpecs,compileRuntimeArtifacts,runtimeArtifactsManifest,generator,historicalTest,authorizationUnused,verifyFrozenReaders,apply};
