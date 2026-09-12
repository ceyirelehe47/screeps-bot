#!/usr/bin/env node
'use strict';
const C=require('./common.cjs'),W=require('./workflow.cjs');
function opts(argv){const result={};for(let i=0;i<argv.length;i+=2){const k=argv[i];if(!/^--[a-z-]+$/.test(k)||!argv[i+1]||argv[i+1].startsWith('--')||k.slice(2) in result)C.fail('ARGUMENT_INVALID');result[k.slice(2)]=argv[i+1];}return result;}
function need(o,...keys){for(const k of keys)if(!o[k])C.fail('ARGUMENT_REQUIRED',k);}
function outside(dir,repos=[]){const dest=C.path.resolve(dir);for(const repo of [...repos,C.ROOT].filter(Boolean)){const r=C.path.resolve(repo),rel=C.path.relative(r,dest);if(!rel||(!rel.startsWith('..'+C.path.sep)&&rel!=='..'&&!C.path.isAbsolute(rel)))C.fail('OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');}if(C.fs.existsSync(dest))C.fail('OUTPUT_ALREADY_EXISTS');C.fs.mkdirSync(dest,{recursive:true});return dest;}
function capture(dir,name,args,{cwd,env}={}){const r=C.spawnSync(process.execPath,args,{cwd,env:env||C.safeEnv(),encoding:null,maxBuffer:32*1024*1024,timeout:300000});C.put(C.path.join(dir,name+'.stdout'),r.stdout||Buffer.alloc(0));C.put(C.path.join(dir,name+'.stderr'),r.stderr||Buffer.alloc(0));C.put(C.path.join(dir,name+'.exit.json'),{code:r.status,signal:r.signal,error:r.error?.code||null});if(r.status!==0)C.fail('CHECK_FAILED',{name,code:r.status});return r.stdout.toString('utf8');}
function test(o){need(o,'out');const out=outside(o.out,[o.compat,o.refactor]),env=C.safeEnv();if(o['typescript-repo'])env.CPU_I_TS_REPO=C.path.resolve(o['typescript-repo']);else if(process.env.CPU_I_TS_MODULE)env.CPU_I_TS_MODULE=process.env.CPU_I_TS_MODULE;else C.fail('TYPESCRIPT_REPO_REQUIRED');
 const testFiles=C.read(C.path.join(C.ROOT,'references/test-set.json'));const tap=capture(out,'tests',['--test',...testFiles.files.map(n=>C.path.join(C.ROOT,n))],{env});
 const normalizedTap=tap.replace(/\r\n/g,'\n');
 const get=n=>+(normalizedTap.match(new RegExp('^# '+n+' (\\d+)$','m'))||[])[1];if(get('tests')!==testFiles.tests||get('pass')!==testFiles.tests||['fail','skipped','todo','cancelled'].some(n=>get(n)!==0))C.fail('TEST_SET_OR_TOTAL_MISMATCH');
 const H=require('../tests/harness.cjs');if(o['typescript-repo'])process.env.CPU_I_TS_REPO=C.path.resolve(o['typescript-repo']);const ts=H.typescript();
 const tmp=C.path.join(out,'type-fixture');C.fs.mkdirSync(tmp);for(const n of ['treasuryCompatRead.ts','treasuryCompatCpu.ts','treasuryCompatRuntime.ts'])C.fs.copyFileSync(C.path.join(C.ROOT,'implementation/src/runtime',n),C.path.join(tmp,n));for(const n of ['treasuryCompatConfig.ts','treasuryCompatTypes.ts'])C.fs.copyFileSync(C.path.join(C.ROOT,'baseline/src/runtime',n),C.path.join(tmp,n));C.fs.copyFileSync(C.path.join(C.ROOT,'tests/screeps.d.ts'),C.path.join(tmp,'screeps.d.ts'));
 C.put(C.path.join(tmp,'treasuryCompatReadCore.generated.ts'),'import type { CompatReadBuilders } from "./treasuryCompatTypes";\nexport declare function createCompatibilityReadCore(): CompatReadBuilders;\n');
 const program=ts.createProgram(C.files(tmp).map(n=>C.path.join(tmp,n)),{strict:true,noEmit:true,target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,types:[]});const ds=ts.getPreEmitDiagnostics(program);C.put(C.path.join(out,'type-fixture-result.json'),{compiler:ts.version,diagnostics:ds.map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')})),scope:'minimal type fixture, not full repository typecheck'});if(ds.length)C.fail('TYPE_FIXTURE_FAILED');
 const summary={status:'COMPAT_CPU_IMPLEMENTATION_OFFLINE_VERIFIED',tests:testFiles.tests,passed:testFiles.tests,failed:0,skipped:0,todo:0,cancelled:0,platform:process.platform,node:process.version,typescript:ts.version,packageFingerprint:C.sha(C.fs.readFileSync(C.path.join(C.ROOT,'INTEGRITY.json'))),onlineCpuClaim:false};C.put(C.path.join(out,'summary.json'),summary);return summary;}
function characterize(o){need(o,'compat','out','typescript-repo');const out=outside(o.out,[o.compat,o.refactor]);process.env.CPU_I_TS_REPO=C.path.resolve(o['typescript-repo']);W.checkSources(o.compat);const lock=C.read(C.path.join(C.ROOT,'references/source-lock.json')),n='src/runtime/treasuryCompatReadCore.generated.ts',b=C.git(o.compat,['show',C.COMPAT+':'+n]);if(C.blob(b)!==lock.protectedBlobs[n])C.fail('CORE_BLOB_MISMATCH');
 const r=require('./characterize.cjs').characterize(b.toString('utf8'));C.put(C.path.join(out,'characterization.json'),r);return {status:r.status,scenarios:r.scenarios.length,engineCpuGapRepaired:false};}
function full(o){need(o,'compat','out');const out=outside(o.out,[o.compat,o.refactor]),repo=C.path.resolve(o.compat);W.checkSources(repo);
 const testLock=C.read(C.path.join(C.ROOT,'references/repository-test-lock.json'));
 for(const [n,identity]of Object.entries(testLock.unchangedFiles)){
  const original=C.git(repo,['show',C.COMPAT+':'+n]);
  if(C.blob(original)!==identity||C.fs.readFileSync(C.path.join(repo,n),'utf8').replace(/\r\n/g,'\n')!==original.toString('utf8'))C.fail('REPOSITORY_TEST_SOURCE_CHANGED',n);
 }
 const tap=capture(out,'repository-tests',['--test','--test-reporter=tap',...['bridge.spec.cjs','real-readers.spec.cjs','independent.spec.cjs'].map(n=>C.path.join(repo,'test/treasury-compat',n))],{cwd:repo});
 const nt=tap.replace(/\r\n/g,'\n');
 const count=n=>+(nt.match(new RegExp('^# '+n+' (\\d+)$','m'))||[])[1];
 if(!(count('tests')>0)||count('pass')!==count('tests')||['fail','skipped','todo','cancelled'].some(n=>count(n)!==0))C.fail('REPOSITORY_NODE_TESTS_INCOMPLETE');
 const entry=n=>C.path.join(repo,'node_modules',...n.split('/'));capture(out,'typecheck-build',[entry('typescript/bin/tsc'),'-p','tsconfig.build.json','--noEmit'],{cwd:repo});capture(out,'typecheck-test',[entry('typescript/bin/tsc'),'-p','tsconfig.json','--noEmit'],{cwd:repo});
 capture(out,'jest-budget',[C.path.join(repo,'scripts/verify-jest-budget.mjs')],{cwd:repo});capture(out,'build-only',[entry('rollup/dist/bin/rollup'),'-c'],{cwd:repo});W.checkSources(repo);
 const r={status:'COMPAT_FULL_OFFLINE_CHECKS_VERIFIED',base:C.COMPAT,repositoryNodeTests:{tests:count('tests'),pass:count('pass'),fail:0,skipped:0},productionBudgetUnchanged:{suites:195,tests:685},buildOnly:true,notDeployed:true};C.put(C.path.join(out,'summary.json'),r);return r;}
function archive(o){need(o,'compat','refactor','tests','characterization','checks','out');C.clean(o.refactor);if(C.gt(o.refactor,['rev-parse','HEAD'])!==C.REF||C.gt(o.refactor,['branch','--show-current'])!==C.REFBRANCH)C.fail('REFACTOR_BASELINE_MISMATCH');const compatHead=W.checkCommitted(o.compat);
 const tests=C.read(C.path.join(o.tests,'summary.json')),ab=C.read(C.path.join(o.characterization,'characterization.json')),checks=C.read(C.path.join(o.checks,'summary.json'));
 if(tests.status!=='COMPAT_CPU_IMPLEMENTATION_OFFLINE_VERIFIED'||tests.packageFingerprint!==C.sha(C.fs.readFileSync(C.path.join(C.ROOT,'INTEGRITY.json')))||ab.status!=='REAL_PINNED_CORE_OFFLINE_CHARACTERIZED'||ab.engineCpuGapRepaired!==false||checks.status!=='COMPAT_FULL_OFFLINE_CHECKS_VERIFIED')C.fail('REQUIRED_VALIDATION_MISSING');
 const testSet=C.read(C.path.join(C.ROOT,'references/test-set.json'));
 const tap=C.fs.readFileSync(C.path.join(o.tests,'tests.stdout'),'utf8').replace(/\r\n/g,'\n');
 if(!tap.includes('# pass '+testSet.tests+'\n')||!tap.includes('# fail 0\n')||tests.tests!==testSet.tests)C.fail('TEST_RAW_EVIDENCE_MISMATCH');
 const coreBlob=C.read(C.path.join(C.ROOT,'references/source-lock.json')).protectedBlobs['src/runtime/treasuryCompatReadCore.generated.ts'];
 if(ab.generatedBlob!==coreBlob||ab.scenarios.length!==10||ab.scenarios.some(x=>x.offByteEquivalent!==true||x.diagnosticSemanticEquivalent!==true))C.fail('REAL_CORE_EVIDENCE_MISMATCH');
 for(const name of ['repository-tests','typecheck-build','typecheck-test','jest-budget','build-only'])if(C.read(C.path.join(o.checks,name+'.exit.json')).code!==0)C.fail('FULL_CHECK_EXIT_MISMATCH');
 const target=C.path.join(o.refactor,C.TARGET);if(C.fs.existsSync(target))C.fail('EVIDENCE_TARGET_EXISTS');const plan=new Map();
 plan.set('.gitattributes',Buffer.from('* -text\n'));for(const n of C.files(C.ROOT))plan.set('task-package/'+n,C.fs.readFileSync(C.path.join(C.ROOT,n)));
 for(const [base,prefix]of [[o.tests,'tests'],[o.characterization,'characterization'],[o.checks,'checks']])for(const n of C.files(base)){if(n.startsWith('type-fixture/'))continue;if(!/\.(json|stdout|stderr)$/.test(n))C.fail('UNEXPECTED_RESULT_FILE',n);plan.set(prefix+'/'+n,C.fs.readFileSync(C.path.join(base,n)));}
 const report='# Compat Reader CPU Attribution I · v2 Repository Integration\n\n'+
  '实现与离线验收完成；本轮无新线上实验，无候选上传，无恢复 POST。\n\n'+
  'v1 未通过真实仓库全量检查：既有沙箱缺少 ./treasuryCompatCpu 的精确导入适配。v2 不修改三份生产实现，不删除或改写历史失败结果。应用输入快照与此前失败现场保留在工作树外。\n\n'+
  `Compat: ${C.COMPAT} → ${compatHead}\nRefactor evidence base: ${C.REF}\n\n`+
  '实际修改：三个与 v1 字节一致的 CPU 源文件，以及 test/treasury-compat/helpers.cjs 的精确沙箱导入适配；既有 spec、Jest 包装器和 195/685 预算不变。配置仍 OFF，预算仍为 2；生成核心、每样本缓存生命周期、市场/物流/Treasury 内核不改。\n\n'+
  '测试使用真实读取器源代码和模型端口；real-core characterization 使用固定 Git 核心及合成 Room/Memory。Node wall clock 与模拟 CPU 都不是 Screeps CPU。普通输出 UTF-8 计数由两次降为一次，不代表首点 2.498 CPU 缺口已修复。\n\n'+
  '已有线上样本仍为 1 条 raw / 0 条完整。新阶段诊断尚未在线执行，阶段瓶颈、首次与后续采样差异及真实净开销仍未知。下一轮须先审查本包结果，再决定受控性能实验；本包没有授权 0004。\n';plan.set('EXECUTION-REPORT.md',Buffer.from(report));
 const final={status:'COMPAT_CPU_OFFLINE_READY_NOT_DEPLOYED',compatHead,refactorBase:C.REF,implementationTests:tests.tests,realCoreScenarios:ab.scenarios.length,engineBudgetGapRepaired:false,generatedCoreChanged:false,budgetChanged:false,onlineCallsAuthorized:false};plan.set('FINAL-VERIFICATION.json',Buffer.from(JSON.stringify(final,null,2)+'\n'));
 const manifest={files:Object.fromEntries([...plan].map(([n,b])=>[n,{bytes:b.length,sha256:C.sha(b)}]))};plan.set('ARCHIVE-MANIFEST.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 try{for(const [n,b]of plan)C.put(C.path.join(target,n),b);}catch(e){C.fs.rmSync(target,{recursive:true,force:true});throw e;}
 C.put(o.out,final);return final;}
function verifyArchive(repo,staged=false){const target=C.path.join(repo,C.TARGET),m=C.read(C.path.join(target,'ARCHIVE-MANIFEST.json'));const files=C.files(target);if(JSON.stringify(files)!==JSON.stringify([...Object.keys(m.files),'ARCHIVE-MANIFEST.json'].sort()))C.fail('ARCHIVE_FILE_SET_MISMATCH');for(const[n,info]of Object.entries(m.files)){const b=staged?C.git(repo,['show',':'+C.TARGET+'/'+n]):C.fs.readFileSync(C.path.join(target,n));if(b.length!==info.bytes||C.sha(b)!==info.sha256)C.fail('ARCHIVE_BYTES_MISMATCH',n);}
 if(staged&&!C.git(repo,['show',':'+C.TARGET+'/ARCHIVE-MANIFEST.json']).equals(C.fs.readFileSync(C.path.join(target,'ARCHIVE-MANIFEST.json'))))C.fail('STAGED_MANIFEST_MISMATCH');
 const diff=C.gt(repo,['diff',...(staged?['--cached']:[]),'--name-only',C.REF]).split('\n').filter(Boolean);if(diff.some(n=>!n.startsWith(C.TARGET+'/')))C.fail('EVIDENCE_SCOPE_MISMATCH');if(staged&&diff.length!==files.length)C.fail('STAGED_EVIDENCE_COUNT_MISMATCH');return {status:'COMPAT_CPU_ARCHIVE_BYTES_VERIFIED',staged,files:files.length};}
function main(argv){const command=argv.shift(),o=opts(argv);if(command!=='verify-package')C.integrity();let r;
 if(command==='verify-package')r=C.integrity();else if(command==='baseline'){need(o,'compat','refactor');r=W.baseline(o.compat,o.refactor);}
 else if(command==='test')r=test(o);else if(command==='apply'){need(o,'compat');r=W.apply(o.compat,o.snapshot);}
 else if(command==='check'){need(o,'compat');r=W.checkSources(o.compat);}
 else if(command==='characterize')r=characterize(o);else if(command==='full-check')r=full(o);
 else if(command==='verify-staged'){need(o,'compat');r=W.checkSources(o.compat,{staged:true});}
 else if(command==='archive')r=archive(o);else if(command==='verify-archive'){need(o,'refactor');r=verifyArchive(o.refactor,o.staged==='yes');}else C.fail('UNKNOWN_COMMAND');console.log(JSON.stringify(r));}
module.exports={opts,outside,applyBytes:W.applyBytes,archive,verifyArchive,main};if(require.main===module)try{main(process.argv.slice(2));}catch(e){console.error(JSON.stringify({status:'STOP',code:e.code||'LOCAL_CHECK_FAILED',detail:e.detail||null}));process.exitCode=1;}
