/** 仅无网络模拟：部署坏状态与控制台一次动作、身份、结果键生命周期反例。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {decodeMemoryResponse, noTreasuryResponsibility, requireScreepsOk} from './deploy-frozen-t3.mjs';

test('完整 Memory 解码拒绝 API 失败、缺失、非对象，接受压缩对象', () => {
  assert.throws(() => requireScreepsOk({ok:0}));
  for (const body of [{ok:1}, {ok:1,data:'null'}, {ok:1,data:'[]'}, {ok:1,data:'undefined'}]) {
    assert.throws(() => decodeMemoryResponse(body));
  }
  assert.deepEqual(decodeMemoryResponse({ok:1,data:'gz:'+gzipSync('{"runtime":{}}').toString('base64')}).value,{runtime:{}});
});

test('默认无责任可通过，坏根、活动、任务租约、核心责任拒绝', () => {
  assert.equal(noTreasuryResponsibility({}),true);
  for (const memory of [
    {runtime:null},{cfg:[]},{data:0},
    {cfg:{treasuryTerminalTransferSlice0:{mode:'canary'}}},
    {runtime:{treasuryProductionT1Quota:{status:'drained'}}},
    {runtime:{treasuryCore:{schemaVersion:999}}},
    {data:{resourceControl:{tasks:{task:{id:'other'}}}}},
    {data:{resourceControl:{tasks:{task:{id:'task',treasurySlice:{}}}}}},
  ]) assert.equal(noTreasuryResponsibility(memory),false,JSON.stringify(memory));
});

test('未知 legacy treasury 字段或版本不能解释为空责任', () => {
  for (const legacy of [{schemaVersion:999},{unknownResponsibility:{attemptId:'x'}}]) {
    assert.equal(noTreasuryResponsibility({runtime:{treasury:legacy}}),false,JSON.stringify(legacy));
  }
});

test('legacy 已知安全表的 null 坏值不能解释为空表', () => {
  for (const legacy of [{receipts:null},{writeFault:null},{attemptIssuer:null}]) {
    assert.equal(noTreasuryResponsibility({runtime:{treasury:legacy}}),false,JSON.stringify(legacy));
  }
});

// 独立子进程替换 fetch 与等待；没有任何网络请求或真实凭据。
function mockedTool(name, action, scenario) {
  const root=mkdtempSync(join(tmpdir(),'t3-tool-guard-'));
  const secret=join(root,'secret.json'), out=join(root,'out');
  let audit=join(root,'audit'),cwd;
  if(scenario==='repo-audit') {
    cwd=join(root,'repository');mkdirSync(cwd);
    assert.equal(spawnSync('git',['init','-q',cwd],{encoding:'utf8'}).status,0);
    audit=join(cwd,'..audit');
  }
  const trace=join(root,'trace.json'), preload=join(root,'mock-fetch.mjs');
  const bundle='mock-frozen-bundle';
  const manifest={schema:'screeps-t3-first-production-release/v1',target:'screeps.com/default/shard1',
    accountId:'634fe406347a7b69b28aeccb',accountName:'forster',buildTag:'mock-t3-frozen',
    deployBundleHash:'a'.repeat(64),mainSha256:createHash('sha256').update(bundle).digest('hex'),
    sourceCommit:'b'.repeat(40),sourceTree:'c'.repeat(40),mainBytes:Buffer.byteLength(bundle)};
  const manifestPath=join(root,'manifest.json');
  writeFileSync(secret,JSON.stringify({main:{hostname:'screeps.com',branch:'default',token:'not-a-real-token'}}));
  writeFileSync(manifestPath,JSON.stringify(manifest));
  writeFileSync(preload,`
import {writeFileSync} from 'node:fs';
const calls=[];let stored=null;let cleanup=false;
const scenario=${JSON.stringify(scenario)},trace=${JSON.stringify(trace)},action=${JSON.stringify(action)};
const manifest=${JSON.stringify(manifest)},bundle=${JSON.stringify(bundle)};
const record=()=>writeFileSync(trace,JSON.stringify(calls));
const response=v=>({ok:true,status:200,json:async()=>v});
globalThis.setTimeout=(callback)=>{queueMicrotask(callback);return 1;};
globalThis.fetch=async(input,init={})=>{
  const url=new URL(input),path=url.pathname,method=init.method||'GET';
  const isCleanup=path==='/api/user/console'&&method==='POST'&&JSON.parse(init.body).expression.includes('delete Memory.');
  calls.push({path,search:url.search,method,cleanup,isCleanup});record();
  if(path==='/api/auth/me')return response({ok:1,_id:scenario==='wrong-account'?'foreign-account':manifest.accountId,username:scenario==='wrong-account'?'foreign-owner':manifest.accountName});
  if(path==='/api/user/code')return response({ok:1,branch:'default',modules:scenario==='empty-code'?{}:{main:scenario==='wrong-code'?'unexpected-running-bytes':bundle}});
  if(path==='/api/game/room-objects')return response({ok:1,objects:[]});
  if(path==='/api/user/memory'){
    if(url.searchParams.has('path')){if(scenario==='missing-data'||scenario==='cleanup-missing-data'&&cleanup)return response({ok:1});return response({ok:1,data:stored?JSON.stringify(stored):'undefined'});}
    return response({ok:1,data:JSON.stringify({runtime:{lastDeployTag:manifest.buildTag,lastDeployBundleHash:manifest.deployBundleHash},cfg:{},data:{resourceControl:{tasks:{}}}})});
  }
  if(path==='/api/user/console'&&method==='POST'){
    const expression=JSON.parse(init.body).expression;
    if(expression.includes('delete Memory.')){cleanup=true;if(scenario==='cleanup-missing-data'){record();throw Error('cleanup response lost and action not observed');}stored=null;record();return response({ok:1});}
    const match=expression.match(/marker\\s*:\\s*(\"[^\"]+\")/);
    if(!match)throw Error('mock could not extract action marker');
    stored={marker:JSON.parse(match[1]),action,status:'returned',result:action==='inspect'?{tick:123,shard:'shard1',rooms:{},transactions:{}}:{entryResult:{ok:true,reason:'armed'},snapshot:{tick:123,shard:'shard1',rooms:{},transactions:{}}}};
    if(scenario==='unknown-post')throw Error('mock response lost after server accepted action');
    return response({ok:1});
  }
  throw Error('mock unexpected endpoint '+path);
};
`);
  const tool=name==='capture-production.mjs'?fileURLToPath(new URL('../docs/reports/treasury-T2-first-production-evidence-20261002/tools/capture-production.mjs',import.meta.url)):fileURLToPath(new URL(`./${name}`,import.meta.url));
  const args=name==='capture-production.mjs'?[secret,join(root,'capture.json'),audit,'--all-shards']:
    [action,secret,out,...(action==='inspect'?[]:[manifestPath,'74075640:1:OH:E4N58->E1N57','74075640','26'])];
  const child=spawnSync(process.execPath,['--import',preload,tool,...args],{encoding:'utf8',timeout:5000,cwd,
    env:{...process.env,SCREEPS_TOKEN:''}});
  const calls=existsSync(trace)?JSON.parse(readFileSync(trace,'utf8')):[];
  const resultExists=existsSync(join(out,'result.json'));
  const fullBackupExists=existsSync(join(audit,'production-code.json'));
  rmSync(root,{recursive:true,force:true});
  return {child,calls,resultExists,fullBackupExists};
}

test('写临时诊断键前须验证实际 account，而非只看 secret target', () => {
  const {child,calls}=mockedTool('treasury-t3-production.mjs','inspect','wrong-account');
  assert.equal(calls.some(c=>c.path==='/api/auth/me'),true);
  assert.notEqual(child.status,0);
  assert.equal(calls.some(c=>c.path==='/api/user/console'&&c.method==='POST'),false);
});

test('产品 arm 在当前实际 code SHA 漂移时不得提交 console', () => {
  const {child,calls}=mockedTool('treasury-t3-production.mjs','arm','wrong-code');
  assert.equal(calls.some(c=>c.path==='/api/user/code'),true);
  assert.notEqual(child.status,0);
  assert.equal(calls.some(c=>c.path==='/api/user/console'&&c.method==='POST'),false);
});

test('产品动作 POST 响应未知仍读取原 marker，不能重发产品动作', () => {
  const {child,calls,resultExists}=mockedTool('treasury-t3-production.mjs','arm','unknown-post');
  assert.equal(child.status,0,child.stderr);
  assert.equal(resultExists,true);
  assert.equal(calls.filter(c=>c.path==='/api/user/console'&&c.method==='POST'&&!c.isCleanup).length,1);
});

test('正确身份和实际 code 对应的 arm 能保存一次结果，防止拒绝全部的假通过', () => {
  const {child,calls,resultExists}=mockedTool('treasury-t3-production.mjs','arm','normal');
  assert.equal(child.status,0,child.stderr);
  assert.equal(resultExists,true);
  assert.equal(calls.filter(c=>c.path==='/api/user/console'&&c.method==='POST'&&!c.isCleanup).length,1);
});

test('清理临时键必须有 cleanup 后 Memory GET 正向读回', () => {
  const {child,calls}=mockedTool('treasury-t3-production.mjs','inspect','normal');
  assert.equal(child.status,0,child.stderr);
  assert.equal(calls.some(c=>c.path==='/api/user/memory'&&c.cleanup),true);
});

test('现场代码证据不接受缺失 main 的模块集', () => {
  const {child}=mockedTool('capture-production.mjs',null,'empty-code');
  assert.notEqual(child.status,0);
});

test('私有 audit 拒绝仓库中的 ..audit 子目录，不能把双点名字当父目录', () => {
  const {child,fullBackupExists}=mockedTool('capture-production.mjs',null,'repo-audit');
  assert.notEqual(child.status,0);
  assert.equal(fullBackupExists,false);
});

test('缺失 diagnostic data 不得解释为 absent 或开始动作', () => {
 const {child,calls}=mockedTool('treasury-t3-production.mjs','inspect','missing-data');
 assert.notEqual(child.status,0);
 assert.equal(calls.some(c=>c.path==='/api/user/console'&&c.method==='POST'),false);
});
test('未知 cleanup 后缺失data不能宣称已清除', () => {
 const {child,calls,resultExists}=mockedTool('treasury-t3-production.mjs','inspect','cleanup-missing-data');
 assert.notEqual(child.status,0);
 assert.equal(resultExists,true);
 assert.equal(calls.filter(c=>c.path==='/api/user/console'&&c.method==='POST'&&!c.isCleanup).length,1);
 assert.equal(calls.some(c=>c.path==='/api/user/memory'&&c.cleanup),true);
});
