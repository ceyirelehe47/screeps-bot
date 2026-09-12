'use strict';
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),S=require('../runtime/store.cjs'),V=require('../runtime/verify-run.cjs');
const ALLOW=Object.freeze(['binding-intent.json','binding.json','public-session.json','prepare-result.json','preparation-failure.json','close-source-failure.json',
 'execution-attempt.json','upload-attempt.json','upload-result.json','restore-attempt.json','actions.jsonl','guard-events.jsonl','guard-ready.json','guard-result.json',
 'collector-diagnostics.jsonl','collector-result.json','collector-stop.json','heartbeat.json','console.jsonl','collector.lock','guard.lock',
 'collector.process.json','collector.exit.json','collector.stdout','collector.stderr','recovery-worker.process.json','recovery-worker.exit.json','recovery-worker.stdout','recovery-worker.stderr',
 'driver-result.json','source-closed.json','diagnostic-verification.json','closing.json']);
const RECOVERY_ALLOW=Object.freeze(['closure-start.json','restore-result.json','code-before-runtime.json','code-after-runtime.json','runtime-console.jsonl','runtime-observer-result.json','closure-result.json']);
const CHECK_ALLOW=['loader-regenerate','typecheck-build','typecheck-tests','jest-budget','warm-build'].flatMap(x=>[x+'.stdout',x+'.stderr',x+'.exit.json']).concat(['result.json']);
function noLiveWorkers(run){
 if(fs.existsSync(path.join(run,'action.lock')))C.fail('ACTION_LOCK_STILL_PRESENT');
 for(const n of ['collector','recovery-worker']){const p=S.optional(run,n+'.process.json');if(!p)continue;
  const e=S.optional(run,n+'.exit.json');if(e?.pid===p.pid&&Number.isInteger(e.code))continue;
  try{process.kill(p.pid,0);C.fail('WORKER_STILL_RUNNING');}catch(err){if(err?.code!=='ESRCH')C.fail('WORKER_EXIT_NOT_CONFIRMED');}
 }
}
function secretScan(b,secret){return [...new Set([secret.token,encodeURIComponent(secret.token),secret.token.slice(0,8),secret.token.slice(0,16)])].some(x=>b.includes(Buffer.from(x)));}
function archive(o){
 U.verifyPackage();const run=path.resolve(o.run),repo=path.resolve(o.refactor),target=path.join(repo,K.EVIDENCE);
 U.exactHead(repo,K.REFACTOR,'refactor/empire-treasury-rearchitecture');U.outside(run,repo);noLiveWorkers(run);
 if(fs.existsSync(target))C.fail('EVIDENCE_TARGET_ALREADY_EXISTS');
 const secret=C.loadSecret(o.secret),files=new Map();
 function put(n,b){if(secretScan(b,secret))C.fail('SECRET_IN_ARCHIVE_INPUT');files.set(n,b);}
 function read(src,n){const b=C.bytes(src);if(/\.(stdout|stderr|tap)$/.test(n)){
  if(!Buffer.from(b.toString('utf8'),'utf8').equals(b))C.fail('NON_UTF8_ARCHIVE_TEXT');
  // Retain exact originals in JSON wrappers. Native git whitespace checks remain meaningful.
  put(n+'.json',Buffer.from(JSON.stringify({encoding:'utf8',bytes:b.length,sha256:C.sha256(b),text:b.toString('utf8')},null,2)+'\n'));
 }else put(n,b);}
 for(const n of ALLOW)if(fs.existsSync(path.join(run,n)))read(path.join(run,n),'run/'+n);
 for(const actor of ['worker','supervisor','operator'])for(const n of RECOVERY_ALLOW){const rel='recovery-'+actor+'/'+n,f=path.join(run,rel);if(fs.existsSync(f))read(f,'run/'+rel);}
 for(const n of ['summary.json','tests.tap','tests.stderr','tests.exit.json']){const f=path.join(o.tests,n);if(!fs.existsSync(f))C.fail('TEST_EVIDENCE_MISSING');read(f,'tool-tests/'+n);}
 for(const n of CHECK_ALLOW){const f=path.join(o.offline,n);if(!fs.existsSync(f))C.fail('BASELINE_EVIDENCE_MISSING');read(f,'baseline-checks/'+n);}
 const work=path.dirname(run);for(const name of ['profile-typecheck','profile-build'])for(const suffix of ['stdout','stderr','exit.json']){
  const n=name+'.'+suffix;if(fs.existsSync(path.join(work,n)))read(path.join(work,n),'candidate-build/'+n);
 }
 const inventory=C.readJson(path.join(U.ROOT,'INTEGRITY.json'));for(const n of [...Object.keys(inventory.files),'INTEGRITY.json'])put('task-package/'+n,fs.readFileSync(path.join(U.ROOT,n)));
 let verified;try{verified=V.verifyRun(run);}catch(e){verified={status:'CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE',closure:'ONLINE_CLOSE_UNCONFIRMED',captureVerified:false,issues:[C.code(e)]};}
 put('FINAL-VERIFICATION.json',Buffer.from(JSON.stringify(verified,null,2)+'\n'));
 const comparison=require('./compare.cjs').makeComparison(run);
 put('LOADER-COMPARISON.json',Buffer.from(JSON.stringify(comparison,null,2)+'\n'));
 const closed=S.optional(run,'source-closed.json');
 const text=`# Compat CPU Recheck IV\n\n状态：${verified.status}\n恢复：${verified.closure}\n\nrefactor base: ${K.REFACTOR}\ncompat base: ${K.COMPAT}\ncompat OFF head: ${closed?.closedHead||'unconfirmed'}\n\n`+
 `raw reports: ${verified.rawReports??0}; diagnostic reports: ${verified.diagnosticReports??0}; complete samples: ${verified.completeSamples??0}\n\n`+
 '本轮四点诊断与完整兼容验收分开。partial_cpu_budget 可提供阶段成本，但不是完整样本。原0003仍为1 raw / 0 complete，已有恢复闭合事实不变。\n\n'+
 '已新增 LOADER-COMPARISON.json：以固定CPU II归档为历史对照，仅实际calls=1的区间参与构建调用成本统计。首次准入和首次reader调用分别标记。跨轮工作负载不可控，不计算精确提速百分比，不把降低成本设成采集通过条件。\n\n'+
 'firstAdmitted 指本模块生命周期首次准入，不证明引擎冷启动。阶段为含诊断开销的区间；末样本尾部缺少后继报告，不可观测。没有推导真实CPU提速百分比，没有提高预算2。\n\n'+
 '每个运行最多一次候选POST、一次恢复POST，共用持久标记；只读复核可以有界重试。代码API没有CAS，部署排他使用是前提。新恢复流使用独立closureId，不拼接观察连续性。\n\n'+
 '私有模块快照、凭据、构建产物不入库。stdout/stderr/TAP以带原字节摘要的JSON包装保留，不修剪原件。原生git whitespace检查无例外。\n';
 put('EXECUTION-REPORT.md',Buffer.from(text));put('.gitattributes',Buffer.from('* -text\n'));
 const manifest={kind:'cpu-recheck-IV-archive/v1',refactorBase:K.REFACTOR,compatBase:K.COMPAT,compatClosedHead:closed?.closedHead||null,
  packageFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))),secretScan:{hits:0,forms:['raw','url-encoded','prefix8','prefix16']},
  files:Object.fromEntries([...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([n,b])=>[n,{bytes:b.length,sha256:C.sha256(b)}]))};
 put('ARCHIVE-MANIFEST.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 fs.mkdirSync(target,{recursive:false});try{for(const[n,b]of files){const f=path.join(target,n);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b,{flag:'wx'});}}
 catch(e){fs.rmSync(target,{recursive:true,force:true});throw e;}
 return {status:'CPU_DIAGNOSTIC_EVIDENCE_ASSEMBLED',target,files:files.size,result:verified.status};
}
module.exports={archive,ALLOW,RECOVERY_ALLOW,CHECK_ALLOW,secretScan,noLiveWorkers};
if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','run','tests','offline','secret']);C.required(o,'refactor','run','tests','offline','secret');console.log(JSON.stringify(archive(o)));});
