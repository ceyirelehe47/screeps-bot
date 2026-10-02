#!/usr/bin/env node
import {resolve, dirname, relative, isAbsolute, sep} from 'node:path';
/** T3-PROD-01：只发布已冻结默认 OFF 字节；不 arm，不发送，不重试 POST。 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile, chmod, lstat, realpath} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

async function preparePrivateAudit(audit) {
  await mkdir(audit,{recursive:true,mode:0o700});
  const stat=await lstat(audit);
  if(!stat.isDirectory() || stat.isSymbolicLink()) throw Error('audit must be a real directory');
  const actual=await realpath(audit);
  const common=execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim();
  for(const root of [resolve(process.cwd()),dirname(common)]) {
    const rel=relative(root,actual);
    if(rel==='' || (rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw Error('private audit cannot be inside repository');
  }
  await chmod(actual,0o700);
  if(((await lstat(actual)).mode & 0o777)!==0o700) throw Error('audit permissions not private');
}
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function requireScreepsOk(body) {
  if (!object(body) || body.ok !== 1) throw Error('Screeps response did not confirm success');
  return body;
}
export function decodeMemoryResponse(body) {
  requireScreepsOk(body);
  if (typeof body.data !== 'string') throw Error('complete Memory response missing');
  const raw = body.data.startsWith('gz:') ? gunzipSync(Buffer.from(body.data.slice(3),'base64')).toString('utf8') : body.data;
  const value = JSON.parse(raw);
  if (!object(value)) throw Error('Memory root invalid');
  return {raw, value, utf8Bytes:Buffer.byteLength(raw)};
}
export function noTreasuryResponsibility(memory) {
  if (!object(memory) || (memory.cfg !== undefined && !object(memory.cfg)) ||
      (memory.runtime !== undefined && !object(memory.runtime)) || (memory.data !== undefined && !object(memory.data))) return false;
  for (const [key,cfg] of Object.entries(memory.cfg || {})) {
    if (/treasury/i.test(key) && (!object(cfg) || (cfg.mode !== undefined && cfg.mode !== 'off'))) return false;
  }
  const runtime=memory.runtime || {};
  // 本轮现场基线没有旧/新活动；任何出现的相关持久状态需重新审查，绝不当空。
  for (const key of Object.keys(runtime)) {
    if (/treasury/i.test(key) && key !== 'treasury' && runtime[key] !== undefined) return false;
  }
  const resourceControl=memory.data?.resourceControl;
  if (resourceControl !== undefined && !object(resourceControl)) return false;
  const tasks=resourceControl?.tasks;
  if (tasks !== undefined && (!object(tasks) || Object.entries(tasks).some(([id,t])=>!object(t)||t.id!==id||t.treasurySlice!==undefined))) return false;
  const legacy=runtime.treasury;
  if (legacy !== undefined && (!object(legacy) || Object.keys(legacy).length > 0)) return false;
  for (const key of ['receipts','intents','quarantine','resolutions','resolutionCleanup','attemptLineage','attemptIssuer',
    'issuedAttemptTickets','writeFault','authorizationFaults','retiredAttemptRanges','cleanupCompletions',
    'cleanupSupersessions','chainRetirementCertificates','generationRetirementProofs','lineageRetirementSummaries',
    'completionHeadroomReservations']) {
    const v=legacy?.[key];
    if (v !== undefined && v !== null && (!object(v) || Object.keys(v).length>0)) return false;
  }
  return true;
}
export function validateFrozenMetadata(manifest,bundle,sourceTree,toolHash) {
  const end=bundle.match(/\n;globalThis\.__DEPLOY_BUNDLE_HASH__="([a-f0-9]{64})";\n$/);
  const literal=key=>{const m=bundle.match(new RegExp('\\b'+key+'=("[^"\\n]*")'));return m?JSON.parse(m[1]):null;};
  return manifest.schema==='screeps-t3-first-production-release/v1' &&
    manifest.target==='screeps.com/default/shard1' && manifest.accountId==='634fe406347a7b69b28aeccb' && manifest.accountName==='forster' &&
    manifest.expectedLiveSha256==='1bf02d8415f552239dd034865c4e62d5c6a00a978af36f78b64640ea05f6f061' &&
    /^[a-f0-9]{40}$/.test(manifest.sourceCommit||'') && manifest.sourceTree===sourceTree &&
    literal('BUILD_COMMIT')===manifest.sourceCommit && literal('BUILD_TREE')===manifest.sourceTree &&
    literal('BUILD_TAG')===manifest.buildTag && literal('BUILD_DIRTY')==='false' &&
    manifest.mainSha256===sha(bundle) && manifest.mainBytes===Buffer.byteLength(bundle) &&
    manifest.mainBytes>=1_000_000 && manifest.mainBytes<5_000_000 &&
    !!end && end[1]===manifest.deployBundleHash && sha(bundle.slice(0,end.index))===manifest.deployBundleHash &&
    manifest.deployToolSha256===toolHash;
}
async function run() {
  const [mode,manifestPath,bundlePath]=process.argv.slice(2);
  if (!['--check','--apply'].includes(mode)||!manifestPath||!bundlePath||process.argv.length!==5) throw Error('usage: --check|--apply manifest.json main.js');
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const bundle=await readFile(bundlePath,'utf8');
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit||'')) throw Error('source commit invalid');
  const sourceTree=git('rev-parse',`${manifest.sourceCommit}^{tree}`);
  const toolHash=sha(await readFile(fileURLToPath(import.meta.url)));
  if (!validateFrozenMetadata(manifest,bundle,sourceTree,toolHash)||git('status','--porcelain')!=='' ||
      git('merge-base','--is-ancestor',manifest.sourceCommit,'HEAD')!=='' ||
      git('diff','--name-only',manifest.sourceCommit,'HEAD','--','.',':!docs',':!scripts/deploy-frozen-t2.mjs')!=='' ||
      git('remote','get-url','origin')!=='https://github.com/ceyirelehe47/screeps-bot.git' ||
      git('remote','get-url','--push','--all','origin')!=='https://github.com/ceyirelehe47/screeps-bot.git') throw Error('frozen input, source, tool, remote or size gate failed');
  const secret=JSON.parse(await readFile(process.env.SCREEPS_SECRET_FILE||'.secret.json','utf8'));
  const token=process.env.SCREEPS_TOKEN||secret.main?.token;
  if (!token||secret.main?.hostname!=='screeps.com'||secret.main?.branch!=='default') throw Error('credential target mismatch');
  async function request(path,init={}) {
    const response=await fetch(new URL(path,'https://screeps.com'),{...init,headers:{'X-Token':token,'X-Username':token,...init.headers},signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw Error(`Screeps HTTP ${response.status}`);
    return requireScreepsOk(await response.json());
  }
  async function code() {
    const body=await request('/api/user/code?branch=default');
    if (body.branch!=='default'||!object(body.modules)||Object.keys(body.modules).join()!=='main'||typeof body.modules.main!=='string') throw Error('live module set invalid');
    return {body,sha256:sha(body.modules.main),bytes:Buffer.byteLength(body.modules.main)};
  }
  const me=await request('/api/auth/me');
  if (me._id!==manifest.accountId||me.username!==manifest.accountName) throw Error('account mismatch');
  const live=await code();
  if (live.sha256!==manifest.expectedLiveSha256) throw Error('live code changed');
  const shards=[];
  for (const shard of ['shard0','shard1','shard2','shard3']) {
    const memory=decodeMemoryResponse(await request(`/api/user/memory?shard=${shard}`));
    if (!noTreasuryResponsibility(memory.value)) throw Error(`unsettled or unreadable Treasury state on ${shard}`);
    shards.push({shard,...memory});
  }
  const active=shards.find(s=>s.shard==='shard1');
  if (active.value.runtime?.lastDeployTag!==manifest.expectedLiveDeployTag||active.utf8Bytes>=1_900_000 ||
      !object(active.value.data?.resourceControl?.tasks)) throw Error('active shard identity, Memory or complete task gate failed');
  console.log(JSON.stringify({gate:'passed',mode,sourceCommit:manifest.sourceCommit,releaseHead:git('rev-parse','HEAD'),
    currentSha256:live.sha256,candidateSha256:manifest.mainSha256,candidateBytes:manifest.mainBytes,
    memoryUtf8Bytes:active.utf8Bytes,shardsVerified:shards.map(s=>s.shard),canonicalTaskCount:Object.keys(active.value.data.resourceControl.tasks).length}));
  if (mode==='--check') return;
  const audit=process.env.SCREEPS_T3_AUDIT_DIR;
  if (!audit) throw Error('SCREEPS_T3_AUDIT_DIR required for pre-upload backup');
  await preparePrivateAudit(audit);
  await writeFile(`${audit}/before-code.json`,JSON.stringify(live.body),{flag:'wx',mode:0o600});
  await writeFile(`${audit}/before-memory.json`,JSON.stringify(shards),{flag:'wx',mode:0o600});
  const finalLive=await code();
  if(finalLive.sha256!==live.sha256) throw Error('live code changed during preflight; zero POST');
  // 正式 API 没有 compare-and-swap；检查后立即一次上传，发布窗口须串行。
  let postStatus='unknown';
  try { await request('/api/user/code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({branch:'default',modules:{main:bundle}})});postStatus='accepted'; }
  catch(error) {postStatus=`unconfirmed:${String(error.message).slice(0,80)}`;}
  const after=await code(); // 未知响应也只独立读回；没有第二次 POST。
  console.log(JSON.stringify({postStatus,readback:{sha256:after.sha256,bytes:after.bytes},applied:after.sha256===manifest.mainSha256}));
  if (after.sha256!==manifest.mainSha256) process.exitCode=1;
}
if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  await run();
}
