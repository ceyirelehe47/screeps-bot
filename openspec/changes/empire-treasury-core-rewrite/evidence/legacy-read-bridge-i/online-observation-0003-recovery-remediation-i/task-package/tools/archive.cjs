'use strict';
const fs=require('node:fs'),path=require('node:path');const R=require('../runtime/replay.cjs');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),K=require('../runtime/pins.cjs'),V=require('../runtime/verify-closure.cjs');
const CLOSURE_FILES=['closure-start.json','closure-events.jsonl','initial-code-state.json','prewrite-code-state.json','restore-marker.json','restore-write-result.json',
 'code-before-runtime.json','code-after-runtime.json','runtime-console.jsonl','runtime-observer-result.json','prior-file-hashes-before.json','prior-file-hashes-after.json','closure-result.json','CLOSURE-VERIFICATION.json'];
function secretScan(b,token){return [token,encodeURIComponent(token),token.slice(0,8),token.slice(0,16)].some(n=>b.toString('utf8').includes(n));}
function writeArchive(repo,targetRel,files,metadata){
 const target=path.join(repo,targetRel);if(fs.existsSync(target))C.fail('ARCHIVE_TARGET_EXISTS');
 const payload=new Map(files);payload.set('.gitattributes',Buffer.from('* -text\n'));
 const m={...metadata,files:Object.fromEntries([...payload].sort().map(([n,b])=>[n,{bytes:b.length,sha256:C.sha256(b)}]))};
 payload.set('ARCHIVE-MANIFEST.json',Buffer.from(JSON.stringify(m,null,2)+'\n'));
 fs.mkdirSync(target,{recursive:false});for(const [n,b]of payload){const f=path.join(target,n);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b,{flag:'wx',mode:0o600});}
 return {target,files:payload.size,manifest:m};
}
function verifyArchive(repo,targetRel=K.evidenceTarget,{staged=false}={}){
 const root=path.join(repo,targetRel),m=C.json(path.join(root,'ARCHIVE-MANIFEST.json'));
 if(!C.same(C.list(root),[...Object.keys(m.files),'ARCHIVE-MANIFEST.json'].sort()))C.fail('ARCHIVE_FILE_SET_MISMATCH');
 for(const [n,e]of Object.entries(m.files)){
  const b=C.bytes(path.join(root,n));if(b.length!==e.bytes||C.sha256(b)!==e.sha256)C.fail('ARCHIVE_BYTES_CHANGED');
  if(staged&&!U.gitBytes(repo,['show',':'+targetRel+'/'+n]).equals(b))C.fail('STAGED_BYTES_CHANGED');
 }
 if(staged){
  if(!U.gitBytes(repo,['show',':'+targetRel+'/ARCHIVE-MANIFEST.json']).equals(C.bytes(path.join(root,'ARCHIVE-MANIFEST.json'))))C.fail('STAGED_MANIFEST_CHANGED');
  const rows=U.git(repo,['diff','--cached','--name-status']).split('\n').filter(Boolean);
  const actual=rows.map(row=>{if(!row.startsWith('A\t'))C.fail('ONLY_NEW_EVIDENCE_FILES_ALLOWED');return row.slice(2);}).sort();
  const wanted=C.list(root).map(n=>targetRel+'/'+n).sort();if(!C.same(actual,wanted))C.fail('STAGED_SCOPE_MISMATCH');
 }
 return {status:'RECOVERY_0003_ARCHIVE_VERIFIED',files:Object.keys(m.files).length+1,staged,sourceCommit:m.sourceCommit,closure:m.closureStatus};
}
function archive(o){
 U.verifyPackage();U.heads(o.refactor,o.compat);U.verifySource(o.source);
 const secret=C.loadSecret(o.secret),pub=C.json(path.join(o.source,'run/public-session.json')),v=V.verifyClosure(o.closure,pub);
 const r=C.json(path.join(o.replay,'replay.json')),rr=R.replay(C.bytes(path.join(o.source,'run/console.jsonl')).toString('utf8'),pub);
 if(!C.same(r,{...rr,source:U.verifySource(o.source)}))C.fail('REPLAY_OUTPUT_CHANGED');
 const cpu=C.json(path.join(o.replay,'CPU-EVIDENCE.json'));if(!C.same(cpu.reports,rr.cpuFindings)||cpu.budgetModified!==false||cpu.productionOptimizationImplemented!==false)C.fail('CPU_REPORT_CHANGED');
 const t=C.json(path.join(o.tests,'summary.json')),contract=C.json(path.join(U.ROOT,'references/test-contract.json'));
 if(r.status!=='SOURCE_0003_REPLAYED_NOT_OBSERVED'||r.rawBridgeReports!==1||r.completeBridgeReports!==0||r.source?.runTree!==K.runTree)C.fail('REPLAY_GATE_INVALID');
 if(t.status!=='RECOVERY_0003_IMPLEMENTATION_TESTS_VERIFIED'||t.tests!==contract.tests||t.passed!==contract.tests||t.failed!==0||t.skipped!==0
 ||t.packageFingerprint!==C.sha256(C.bytes(path.join(U.ROOT,'INTEGRITY.json'))))C.fail('TEST_GATE_INVALID');
 if(C.list(o.closure).some(n=>!CLOSURE_FILES.includes(n)))C.fail('CLOSURE_ARCHIVE_INPUT_UNEXPECTED');
 const tap=C.bytes(path.join(o.tests,'tests.tap')).toString('utf8');
 const count=k=>Number(tap.match(new RegExp('^# '+k+' (\\d+)$','m'))?.[1]??-1);
 if(count('tests')!==contract.tests||count('pass')!==contract.tests||['fail','skipped','todo','cancelled'].some(k=>count(k)!==0)||C.json(path.join(o.tests,'tests.exit.json')).code!==0)C.fail('RAW_TEST_RESULTS_INVALID');
 const files=new Map(),put=(n,b)=>{if(secretScan(b,secret.token))C.fail('SECRET_FOUND_ARCHIVE_ABORTED');files.set(n,b);};
 for(const n of CLOSURE_FILES){const f=path.join(o.closure,n);if(fs.existsSync(f))put('recovery/'+n,C.bytes(f));}
 for(const n of ['summary.json','tests.tap','tests.stderr','tests.exit.json'])put('test-results/'+n,C.bytes(path.join(o.tests,n)));
 for(const n of ['replay.json','CPU-EVIDENCE.json'])put('analysis/'+n,C.bytes(path.join(o.replay,n)));
 put('SOURCE-MANIFEST.json',C.bytes(path.join(o.source,'MANIFEST.json')));
 for(const n of C.list(U.ROOT))put('task-package/'+n,C.bytes(path.join(U.ROOT,n)));
 put('FINAL-VERIFICATION.json',Buffer.from(JSON.stringify(v,null,2)+'\n'));
 const report=`# 0003 Recovery & Evidence Remediation I\n\n`+
 `恢复闭合裁决：\`${v.status}\`。原始观察仍为 \`ONLINE_COMPAT_READ_INCONCLUSIVE\`。\n\n`+
 `证据基线：${K.refactor}；compat 保持 ${K.compat}。本轮不生成或上传新的候选，不改 CPU 配置。\n\n`+
 `本次闭合命令的恢复 POST 边界：${v.restorePostBoundaries}；代码字节确认：${v.bytesConfirmed}；新的恢复专用运行确认：${v.runtimeConfirmed}。\n\n`+
 `代码字节依据是本轮实时只读回读；不是由 Git 默认 OFF、窗口过期或旧 guard 标签推导。运行确认使用新的 closureId，与 0003 的失败 collector 不拼接。\n\n`+
 `旧原始日志重新解码后收到 ${r.rawBridgeReports} 条桥报告、${r.completeBridgeReports} 条完整样本。首点 tick=73646500，partial_cpu_budget，commitments=not_read_cpu_budget，序列化/输出前 CPU=2.4981476000029943，配置预算=2。\n\n`+
 `CPU 子阶段归因、冷启动与稳态的差别及完整输出成本未知；本轮只保留证据，不宣称优化完成，不提高预算。\n\n`+
 `原 run 已有文件哈希复核：${v.originalRecordsPreserved?'通过':'未通过或未完成，不能声称原件完整性已确认'}。仅允许新增此前未消耗的 restore-attempt.json，另有执行期间的原 action.lock。历史 Git 证据不改写；完整模块正文与凭据不归档。\n\n`+
 `服务器代码写接口没有 CAS；执行恢复以 --exclusive-target 和 --prior-workers-stopped 的真实确认作为先决条件。读取可有限重试，恢复写入不重试；已有标记、第三方代码或无法确认状态均禁止补发。\n`;
 put('EXECUTION-REPORT.md',Buffer.from(report));
 const result=writeArchive(o.refactor,K.evidenceTarget,files,{status:'RECOVERY_0003_ARCHIVED',sourceCommit:K.refactor,compatHead:K.compat,
  closureStatus:v.status,originalObservationStatus:'ONLINE_COMPAT_READ_INCONCLUSIVE',newCandidateUploads:0,secretScan:{hitCount:0}});
 verifyArchive(o.refactor);return {status:'RECOVERY_0003_ARCHIVED',target:result.target,files:result.files,closure:v.status};
}
module.exports={archive,writeArchive,verifyArchive,secretScan,CLOSURE_FILES};
if(require.main===module)C.main(async()=>{const o=C.options(process.argv.slice(2),['refactor','compat','source','closure','replay','tests','secret']);C.required(o,'refactor','compat','source','closure','replay','tests','secret');console.log(JSON.stringify(archive(o)));});
