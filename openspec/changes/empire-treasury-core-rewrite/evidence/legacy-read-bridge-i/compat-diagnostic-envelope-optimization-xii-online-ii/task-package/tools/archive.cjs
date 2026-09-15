'use strict';
const fs=require('node:fs'),path=require('node:path');
const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),S=require('../runtime/store.cjs'),V=require('../runtime/verify-run.cjs');
const ALLOW=Object.freeze(['binding-intent.json','binding.json','public-session.json','prepare-result.json','preparation-failure.json','close-source-failure.json','preflight-read-events.jsonl',
 'execution-attempt.json','upload-attempt.json','upload-result.json','restore-attempt.json','actions.jsonl','guard-events.jsonl','guard-ready.json','guard-result.json',
 'collector-diagnostics.jsonl','collector-result.json','collector-stop.json','heartbeat.json','console.jsonl','collector.lock','guard.lock',
 'collector.process.json','collector.exit.json','collector.stdout','collector.stderr','recovery-worker.process.json','recovery-worker.exit.json','recovery-worker.stdout','recovery-worker.stderr',
 'driver-result.json','source-closed.json','diagnostic-verification.json','closing.json']);
const RECOVERY_ALLOW=Object.freeze(['closure-start.json','restore-result.json','code-before-runtime.json','code-after-runtime.json','runtime-console.jsonl','runtime-observer-result.json','closure-result.json']);
const CHECK_ALLOW=['repository-tests','loader-regenerate','typecheck-build','typecheck-tests','jest-budget','warm-build'].flatMap(x=>[x+'.stdout',x+'.stderr',x+'.exit.json']).concat(['result.json']);
function noLiveWorkers(run){
 if(fs.existsSync(path.join(run,'action.lock')))C.fail('ACTION_LOCK_STILL_PRESENT');
 for(const n of ['collector','recovery-worker']){const p=S.optional(run,n+'.process.json');if(!p)continue;const e=S.optional(run,n+'.exit.json');if(e?.pid===p.pid&&Number.isInteger(e.code))continue;
  try{process.kill(p.pid,0);C.fail('WORKER_STILL_RUNNING');}catch(err){if(err?.code!=='ESRCH')C.fail('WORKER_EXIT_NOT_CONFIRMED');}}
}
function secretScan(b,secret){return [...new Set([secret.token,encodeURIComponent(secret.token),secret.token.slice(0,8),secret.token.slice(0,16)])].some(x=>b.includes(Buffer.from(x)));}
function archive(o){
 U.verifyPackage();const run=path.resolve(o.run),repo=path.resolve(o.refactor),target=path.join(repo,K.EVIDENCE);
 U.exactHead(repo,K.REFACTOR,'refactor/empire-treasury-rearchitecture');U.outside(run,repo);noLiveWorkers(run);if(fs.existsSync(target))C.fail('EVIDENCE_TARGET_ALREADY_EXISTS');
 const secret=C.loadSecret(o.secret),files=new Map();
 function put(n,b){if(secretScan(b,secret))C.fail('SECRET_IN_ARCHIVE_INPUT');files.set(n,b);}
 function read(src,n){const b=C.bytes(src);if(/\.(stdout|stderr|tap)$/.test(n)){if(!Buffer.from(b.toString('utf8'),'utf8').equals(b))C.fail('NON_UTF8_ARCHIVE_TEXT');
   put(n+'.json',Buffer.from(JSON.stringify({encoding:'utf8',bytes:b.length,sha256:C.sha256(b),text:b.toString('utf8')},null,2)+'\n'));}else put(n,b);}
 for(const n of ALLOW)if(fs.existsSync(path.join(run,n)))read(path.join(run,n),'run/'+n);
 for(const actor of ['worker','supervisor','operator'])for(const n of RECOVERY_ALLOW){const rel='recovery-'+actor+'/'+n,f=path.join(run,rel);if(fs.existsSync(f))read(f,'run/'+rel);}
 for(const n of ['summary.json','tests.tap','tests.stderr','tests.exit.json']){const f=path.join(o.tests,n);if(!fs.existsSync(f))C.fail('TEST_EVIDENCE_MISSING');read(f,'tool-tests/'+n);}
 for(const n of CHECK_ALLOW){const f=path.join(o.offline,n);if(!fs.existsSync(f))C.fail('BASELINE_EVIDENCE_MISSING');read(f,'offline-checks/'+n);}
 if(!o.application||!fs.existsSync(o.application))C.fail('SOURCE_APPLICATION_EVIDENCE_MISSING');read(o.application,'source-application.json');
 const work=path.dirname(run);for(const name of ['profile-typecheck','profile-build'])for(const suffix of ['stdout','stderr','exit.json']){const n=name+'.'+suffix;if(fs.existsSync(path.join(work,n)))read(path.join(work,n),'candidate-build/'+n);}
 const inventory=C.readJson(path.join(U.ROOT,'INTEGRITY.json'));for(const n of [...Object.keys(inventory.files),'INTEGRITY.json'])put('task-package/'+n,fs.readFileSync(path.join(U.ROOT,n)));
 let verified;try{verified=V.verifyRun(run);}catch(e){verified={status:'CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE',closure:'ONLINE_CLOSE_UNCONFIRMED',captureVerified:false,issues:[C.code(e)]};}
 put('FINAL-VERIFICATION.json',Buffer.from(JSON.stringify(verified,null,2)+'\n'));
 const M=require('./compare.cjs'),attribution=M.makeAttribution(run),comparison=M.makeComparison(run);
 put('SUBPHASE-ATTRIBUTION.json',Buffer.from(JSON.stringify(attribution,null,2)+'\n'));
 put('ENVELOPE-COMPARISON.json',Buffer.from(JSON.stringify(comparison,null,2)+'\n'));
 const closed=S.optional(run,'source-closed.json'),offline=C.readJson(path.join(o.offline,'result.json')),application=C.readJson(o.application),sourceHead=closed?.sourceHead||offline.sourceHead||application.head;
 const text=`# Compat Diagnostic Envelope Optimization XII Online II\n\n状态：${verified.status}\n归因：${attribution.status}\n比较：${comparison.status}\n恢复：${verified.closure}\n\nrefactor base: ${K.REFACTOR}\ncompat root base: ${K.COMPAT}\noptimized source head: ${sourceHead}\ncompat OFF head: ${closed?.closedHead||'unconfirmed'}\n\nraw reports: ${verified.rawReports??0}; diagnostic reports: ${verified.diagnosticReports??0}; attributed reports: ${attribution.reports?.attributed??0}; complete samples: ${verified.completeSamples??0}\n\n本轮先应用固定 XII 诊断封套与有界 Preview 优化并完成真实仓库门禁，再以同一 2 CPU、两房两资源、四点协议执行在线复测。性能改善不是采集成功门槛，比较结果按原始报告重算。\n\n九个 IX 子阶段嵌套于父阶段，不能相加；primitive counters 不是 CPU 权重。partial_cpu_budget 仍不是完整样本，末点尾部仍不可观测。\n\n候选和恢复 POST 各最多一次且不自动重发。恢复使用独立 closureId 和 75 秒运行确认。私有模块快照、凭据和构建产物不入库；原生 git whitespace 检查无例外。\n`;
 put('EXECUTION-REPORT.md',Buffer.from(text));put('.gitattributes',Buffer.from('* -text\n'));
 const manifest={kind:'compat-diagnostic-envelope-optimization-XII-online-II-archive/v1',refactorBase:K.REFACTOR,compatBase:K.COMPAT,sourceHead,sourceTree:closed?U.textGit(o.compat,['rev-parse',sourceHead+'^{tree}']):offline.sourceTree,compatClosedHead:closed?.closedHead||sourceHead,
  packageFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))),implementationFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'references/implementation-lock.json'))),secretScan:{hits:0,forms:['raw','url-encoded','prefix8','prefix16']},
  readRetry:{readOnly:true,attemptsMaximum:3,totalDeadlineMs:8000,writeRetries:0},priorBasis:require('../references/prior-online-basis.json').attribution,files:Object.fromEntries([...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([n,b])=>[n,{bytes:b.length,sha256:C.sha256(b)}]))};
 put('ARCHIVE-MANIFEST.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 fs.mkdirSync(target,{recursive:false});try{for(const[n,b]of files){const f=path.join(target,n);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b,{flag:'wx'});}}catch(e){fs.rmSync(target,{recursive:true,force:true});throw e;}
 return {status:'ENVELOPE_XII_EVIDENCE_ASSEMBLED',target,files:files.size,result:verified.status,comparison:comparison.status};
}
module.exports={archive,ALLOW,RECOVERY_ALLOW,CHECK_ALLOW,secretScan,noLiveWorkers};
if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat','run','tests','offline','application','secret']);C.required(o,'refactor','compat','run','tests','offline','application','secret');console.log(JSON.stringify(archive(o)));});
