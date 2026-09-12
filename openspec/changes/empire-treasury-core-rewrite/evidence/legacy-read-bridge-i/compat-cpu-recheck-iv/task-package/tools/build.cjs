'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs');
function runNode(repo,entry,args,out,name,{timeout=900000}={}){
 if(process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.CPU_DIAG_FIXTURE_ROOT)C.fail('UNSAFE_BUILD_OR_NODE_ENVIRONMENT');
 const bin=path.resolve(repo,entry);if(!fs.existsSync(bin))C.fail('LOCKED_DEPENDENCIES_NOT_INSTALLED');
 const r=cp.spawnSync(process.execPath,[bin,...args],{cwd:repo,encoding:'utf8',timeout,maxBuffer:32*1048576,windowsHide:true});
 fs.writeFileSync(path.join(out,name+'.stdout'),r.stdout||'',{flag:'wx'});fs.writeFileSync(path.join(out,name+'.stderr'),r.stderr||'',{flag:'wx'});
 C.writeNew(path.join(out,name+'.exit.json'),{status:r.status,signal:r.signal,error:r.error?'CHILD_FAILURE':null});
 if(r.status!==0||r.error)C.fail('OFFLINE_CHILD_FAILED',{step:name});return r;
}
function baselineOffline(repo,out){
 U.exactHead(repo,K.COMPAT,'compat/treasury-read-bridge-i');U.newDir(out);
 require('../runtime/check-profile.cjs').verifyFrozen(repo);
 runNode(repo,'scripts/build-treasury-compat-loader.cjs',['--check'],out,'loader-regenerate');
 runNode(repo,'node_modules/typescript/bin/tsc',['-p','tsconfig.build.json','--noEmit'],out,'typecheck-build');
 runNode(repo,'node_modules/typescript/bin/tsc',['-p','tsconfig.json','--noEmit'],out,'typecheck-tests');
 runNode(repo,'scripts/verify-jest-budget.mjs',[],out,'jest-budget');
 runNode(repo,'node_modules/rollup/dist/bin/rollup',['-c'],out,'warm-build');
 U.clean(repo);
 const result={status:'COMPAT_BASELINE_OFFLINE_VERIFIED',head:K.COMPAT,loaderRegenerated:true,tests:{suites:195,tests:685},packageFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))),atMs:Date.now()};C.writeNew(path.join(out,'result.json'),result);return result;
}
function detachedBuild(compat,head,work){
 const repo=path.join(work,'build');U.git(compat,['worktree','add','--detach',repo,head]);
 const modules=path.join(compat,'node_modules');fs.symlinkSync(path.resolve(modules),path.join(repo,'node_modules'),'junction');
 U.clean(repo);const tree=U.textGit(repo,['rev-parse','HEAD^{tree}']);
 // Detached + no DEST is required: frozen Rollup maps build-only named branches differently.
 if(U.textGit(repo,['branch','--show-current'])!=='')C.fail('DETACHED_BUILD_REQUIRED');
 runNode(repo,'node_modules/typescript/bin/tsc',['-p','tsconfig.build.json','--noEmit'],work,'profile-typecheck');
 runNode(repo,'node_modules/rollup/dist/bin/rollup',['-c'],work,'profile-build');U.clean(repo);
 if(U.textGit(repo,['rev-parse','HEAD'])!==head||U.textGit(repo,['rev-parse','HEAD^{tree}'])!==tree)C.fail('BUILD_TREE_CHANGED');
 const names=fs.readdirSync(path.join(repo,'dist')).filter(x=>(x.endsWith('.js')&&!x.endsWith('.map.js'))||x.endsWith('.wasm')).sort();
 if(JSON.stringify(names)!=='["main.js"]')C.fail('UNEXPECTED_RUNTIME_MODULE_SET');
 return {repo,head,tree,modules:{main:fs.readFileSync(path.join(repo,'dist/main.js'),'utf8')}};
}
module.exports={runNode,baselineOffline,detachedBuild};
if(require.main===module)U.cli(async()=>{const o=U.options(['compat','out']);C.required(o,'compat','out');U.verifyPackage();U.outside(o.out,o.compat);console.log(JSON.stringify(baselineOffline(path.resolve(o.compat),path.resolve(o.out))));});
