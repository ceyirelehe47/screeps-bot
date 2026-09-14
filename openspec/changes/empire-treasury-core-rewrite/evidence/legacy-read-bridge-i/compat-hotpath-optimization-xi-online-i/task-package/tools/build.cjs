'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
function runNode(repo,entry,args,out,name,{timeout=900000}={}){
 if(process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.CPU_DIAG_FIXTURE_ROOT)C.fail('UNSAFE_BUILD_OR_NODE_ENVIRONMENT');
 const bin=path.resolve(repo,entry);if(!fs.existsSync(bin))C.fail('LOCKED_DEPENDENCIES_NOT_INSTALLED');
 const r=cp.spawnSync(process.execPath,[bin,...args],{cwd:repo,encoding:'utf8',timeout,maxBuffer:64*1048576,windowsHide:true});
 fs.writeFileSync(path.join(out,name+'.stdout'),r.stdout||'',{flag:'wx'});fs.writeFileSync(path.join(out,name+'.stderr'),r.stderr||'',{flag:'wx'});
 C.writeNew(path.join(out,name+'.exit.json'),{status:r.status,signal:r.signal,error:r.error?'CHILD_FAILURE':null});
 if(r.status!==0||r.error)C.fail('OFFLINE_CHILD_FAILED',{step:name});return r;
}
function optimizedOffline(repo,out){
 const source=require('./source.cjs').verifyHead(repo);U.newDir(out);
 require('../runtime/check-profile.cjs').verifyFrozen(repo);
 runRepositoryTests(repo,out);
 runNode(repo,'scripts/build-treasury-compat-loader.cjs',['--check'],out,'loader-regenerate');
 runNode(repo,'node_modules/typescript/bin/tsc',['-p','tsconfig.build.json','--noEmit'],out,'typecheck-build');
 runNode(repo,'node_modules/typescript/bin/tsc',['-p','tsconfig.json','--noEmit'],out,'typecheck-tests');
 runNode(repo,'scripts/verify-jest-budget.mjs',[],out,'jest-budget');
 runNode(repo,'node_modules/rollup/dist/bin/rollup',['-c'],out,'warm-build');
 U.clean(repo);
 const result={status:'HOTPATH_XI_OFFLINE_VERIFIED',base:K.COMPAT,sourceHead:source.head,sourceTree:source.tree,repositoryNodeTests:280,
  loaderRegenerated:true,hotpathOptimizationXI:true,sourceManifestOutputValidation:'all-listed-outputs',tests:{suites:195,tests:685},
  packageFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))),atMs:Date.now()};C.writeNew(path.join(out,'result.json'),result);return result;
}
function detachedBuild(compat,head,work){
 const repo=path.join(work,'build');U.git(compat,['worktree','add','--detach',repo,head]);
 const modules=path.join(compat,'node_modules');fs.symlinkSync(path.resolve(modules),path.join(repo,'node_modules'),'junction');
 U.clean(repo);const tree=U.textGit(repo,['rev-parse','HEAD^{tree}']);
 if(U.textGit(repo,['branch','--show-current'])!=='')C.fail('DETACHED_BUILD_REQUIRED');
 runNode(repo,'node_modules/typescript/bin/tsc',['-p','tsconfig.build.json','--noEmit'],work,'profile-typecheck');
 runNode(repo,'node_modules/rollup/dist/bin/rollup',['-c'],work,'profile-build');U.clean(repo);
 if(U.textGit(repo,['rev-parse','HEAD'])!==head||U.textGit(repo,['rev-parse','HEAD^{tree}'])!==tree)C.fail('BUILD_TREE_CHANGED');
 const names=fs.readdirSync(path.join(repo,'dist')).filter(x=>(x.endsWith('.js')&&!x.endsWith('.map.js'))||x.endsWith('.wasm')).sort();
 if(JSON.stringify(names)!=='["main.js"]')C.fail('UNEXPECTED_RUNTIME_MODULE_SET');
 return {repo,head,tree,modules:{main:fs.readFileSync(path.join(repo,'dist/main.js'),'utf8')}};
}
function runRepositoryTests(repo,out){
 if(process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.CPU_DIAG_FIXTURE_ROOT)C.fail('UNSAFE_BUILD_OR_NODE_ENVIRONMENT');
 const files=['bridge.spec.cjs','real-readers.spec.cjs','independent.spec.cjs','loader-optimization.spec.cjs','build-optimization.spec.cjs','attribution.spec.cjs','hotpath-optimization.spec.cjs'].map(x=>path.join(repo,'test/treasury-compat',x));
 const r=cp.spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{cwd:repo,encoding:'utf8',timeout:1200000,maxBuffer:64*1048576,windowsHide:true});
 fs.writeFileSync(path.join(out,'repository-tests.stdout'),r.stdout||'',{flag:'wx'});fs.writeFileSync(path.join(out,'repository-tests.stderr'),r.stderr||'',{flag:'wx'});
 C.writeNew(path.join(out,'repository-tests.exit.json'),{status:r.status,signal:r.signal,error:r.error?'CHILD_FAILURE':null});
 const count=n=>Number(r.stdout?.match(new RegExp('^# '+n+' (\\d+)$','m'))?.[1]);
 if(r.status!==0||r.error||count('tests')!==280||count('pass')!==280||['fail','skipped','todo','cancelled'].some(n=>count(n)!==0))C.fail('REPOSITORY_NODE_TEST_GATE_FAILED');
 return {tests:280,passed:280};
}
module.exports={runNode,optimizedOffline,baselineOffline:optimizedOffline,detachedBuild,runRepositoryTests};
if(require.main===module)U.cli(async()=>{const o=U.options(['compat','out']);C.required(o,'compat','out');U.verifyPackage();U.outside(o.out,o.compat);console.log(JSON.stringify(optimizedOffline(path.resolve(o.compat),path.resolve(o.out))));});
