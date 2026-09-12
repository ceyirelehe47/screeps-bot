'use strict';
/** Explicit allowlist; never recursively copy the live run directory. */
const fs=require('node:fs'),path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/policy.cjs'),S=require('../runtime/store.cjs'),V=require('../runtime/verify-run.cjs');
const ALLOW=Object.freeze(['binding-intent.json','binding.json','public-session.json','prepare-result.json','preparation-failure.json','close-source-failure.json',
 'execution-attempt.json','upload-attempt.json','upload-result.json','restore-attempt.json','restore-result.json','supervisor-restore-result.json',
 'guard-events.jsonl','guard-ready.json','guard-result.json','collector-diagnostics.jsonl','collector-result.json','collector-stop.json','heartbeat.json','console.jsonl',
 'collector.process.json','collector.exit.json','collector.stdout','collector.stderr','recovery-worker.process.json','recovery-worker.exit.json','recovery-worker.stdout','recovery-worker.stderr',
 'restore-independent-before.json','restore-independent-after.json','runtime-confirmation.json','driver-result.json','source-closed.json','observation-verification.json','closing.json']);
function secretScan(bytes,secret){const text=bytes.toString('utf8'),t=secret.token;return [...new Set([t,encodeURIComponent(t),t.slice(0,8),t.slice(0,16)])].some(x=>text.includes(x));}
function archive(o){
 U.verifyPackage();const run=path.resolve(o.run),repo=path.resolve(o.refactor),target=path.join(repo,K.EVIDENCE);U.outside(run,repo);
 U.exactHead(repo,K.REFACTOR,'refactor/empire-treasury-rearchitecture');if(fs.existsSync(target))C.fail('EVIDENCE_TARGET_ALREADY_EXISTS');
 const secret=C.loadSecret(o.secret);let verification;
 if(fs.existsSync(S.file(run,'public-session.json'))){try{verification=V.verifyRun(run);}catch(e){verification={status:'ONLINE_COMPAT_READ_INCONCLUSIVE',observed:false,issues:[e?.code||'EVIDENCE_PARSE_OR_VALIDATION_FAILED']};}}
 else verification={status:'NOT_DEPLOYED',observed:false,issues:[S.optional(run,'preparation-failure.json')?.error||'PREPARATION_NOT_COMPLETE']};
 const files=new Map();const put=(name,bytes)=>{if(secretScan(bytes,secret))C.fail('LIVE_SECRET_FOUND_IN_ARCHIVE_INPUT');files.set(name,bytes);};
 for(const n of ALLOW){const f=S.file(run,n);if(fs.existsSync(f)){
  const st=fs.lstatSync(f);if(!st.isFile()||st.isSymbolicLink()||st.size>70*1048576)C.fail('ARCHIVE_INPUT_INVALID');put('run/'+n,fs.readFileSync(f));}}
 for(const n of ['backup.json','candidate.json','session.json'])if(files.has('run/'+n))C.fail('FORBIDDEN_ARCHIVE_FILE');
 for(const [src,scope]of[[o.tests,'test-results'],[o.offline,'candidate-offline']]){
  for(const n of fs.readdirSync(src).sort()){
   const f=path.join(src,n),st=fs.lstatSync(f);if(!st.isFile()||st.isSymbolicLink()||st.size>32*1048576)C.fail('OFFLINE_ARCHIVE_INPUT_INVALID');
   if(!/^[A-Za-z0-9_.-]+$/.test(n))C.fail('ARCHIVE_FILENAME_INVALID');put(scope+'/'+n,fs.readFileSync(f));
  }
 }
 // Embed the complete package as files so an independent reviewer can reproduce it.
 function walk(dir){for(const name of fs.readdirSync(dir).sort()){const f=path.join(dir,name),st=fs.lstatSync(f);if(st.isDirectory())walk(f);else{const rel=path.relative(U.ROOT,f).split(path.sep).join('/');put('task-package/'+rel,fs.readFileSync(f));}}}walk(U.ROOT);
 put('FINAL-VERIFICATION.json',Buffer.from(JSON.stringify(verification,null,2)+'\n'));
 const sourceClosed=S.optional(run,'source-closed.json'),pub=S.optional(run,'public-session.json');
 const report=`# 正式兼容观察 0003\n\n终态：\`${verification.status}\`${verification.closure?' / '+verification.closure:''}\n\n`+
 `refactor 起点：${K.REFACTOR}\n\ncompat 起点：${K.COMPAT}\n\n候选 profile：${pub?.profileHead||'未生成'}\n\n源码关闭 HEAD：${sourceClosed?.closedHead||'未确认'}\n\n`+
 `收到采样 tick：${JSON.stringify(verification.receivedTicks||[])}\n\n未通过项：${JSON.stringify(verification.issues)}\n\n`+
 '本轮只审查 E3N59 / E4N58 的 storage、terminal，资源 energy / H。只读桥不签发许可、不运行完整 Treasury 生命周期。\n\n'+
 'CPU 口径：12 个样本的序列化/输出前成本，加上由下一样本报告的前 11 个样本完整成本。最后样本完整成本没有后继样本可报告，必须保留不可观测标记。\n\n'+
 'legacyProjection 的 stale/absent/mismatch 按原值归档；直接 Store 与核心 observation 的选定范围一致，不等于旧投影、全资源、全帝国或新 Treasury 决策全部等价。\n\n'+
 '唯一候选 POST 与最多一次恢复 POST 均有执行前持久标记。目标代码 API 没有服务端 CAS；本轮以部署目标排他使用为先决条件。\n\n'+
 '完整 backup、candidate 模块正文与凭据只留在工作树外，本目录没有复制这些文件。\n';
 put('EXECUTION-REPORT.md',Buffer.from(report));
 const manifest={status:'FORMAL_0003_ARCHIVE_ASSEMBLED',refactorBase:K.REFACTOR,compatBase:K.COMPAT,secretScan:{hitCount:0,needleKinds:['raw','url-encoded','prefix8','prefix16']},
  files:Object.fromEntries([...files].map(([n,b])=>[n,{bytes:b.length,sha256:C.sha256(b)}]))};
 put('ARCHIVE-MANIFEST.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 // All files and secrets are validated before touching the repository.
 fs.mkdirSync(target,{recursive:false});try{for(const[n,b]of files){const f=path.join(target,n);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b,{flag:'wx'});}}catch(e){fs.rmSync(target,{recursive:true,force:true});throw e;}
 return {status:'FORMAL_0003_ARCHIVE_ASSEMBLED',target,files:files.size,result:verification.status};
}
module.exports={ALLOW,secretScan,archive};if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','run','tests','offline','secret']);C.required(o,'refactor','run','tests','offline','secret');console.log(JSON.stringify(archive(o)));});
