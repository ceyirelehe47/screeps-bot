import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {requireScreepsOk,decodeMemoryResponse,noT1Responsibility,validateFrozenMetadata} from '../../../../scripts/deploy-frozen-t1-exit-r1.mjs';
test('HTTP 200 API错误和缺失数据不会变成无责任',()=>{
 for (const x of [{ok:0,error:'unavailable'},{ok:1},{ok:1,data:'null'},{ok:1,data:'[]'},{ok:1,data:'undefined'}]) assert.throws(()=>decodeMemoryResponse(x));
 assert.throws(()=>requireScreepsOk({ok:'1'}));
});
test('完整压缩 Memory 成功读回与主镜像门禁',()=>{
 const memory={runtime:{},data:{resourceControl:{tasks:{}}}};
 const decoded=decodeMemoryResponse({ok:1,data:'gz:'+gzipSync(JSON.stringify(memory)).toString('base64')});
 assert.deepEqual(decoded.value,memory);assert.equal(noT1Responsibility(memory),true);
 for(const key of ['treasuryT1FirstLiveControl','treasuryT1FirstLiveControlMirror','treasuryProductionT1Quota','treasuryCore']) {
  assert.equal(noT1Responsibility({...memory,runtime:{[key]:{}}}),false);
 }
 assert.equal(noT1Responsibility({data:{resourceControl:{tasks:[]}}}),false);
 assert.equal(noT1Responsibility({cfg:{treasuryTerminalTransferSlice0:{mode:'canary'}}}),false);
});
test('坏 resourceControl 根与全部旧责任字段拒绝发布',()=>{
 assert.equal(noT1Responsibility({data:{resourceControl:[]}}),false);
 for(const key of ['receipts','intents','quarantine','resolutions','resolutionCleanup','attemptLineage','attemptIssuer',
  'issuedAttemptTickets','writeFault','authorizationFaults','retiredAttemptRanges','cleanupCompletions',
  'cleanupSupersessions','chainRetirementCertificates','generationRetirementProofs','lineageRetirementSummaries',
  'completionHeadroomReservations']) {
  assert.equal(noT1Responsibility({runtime:{treasury:{[key]:{oldAttempt:{status:'unknown'}}}}}),false,key);
 }
});
test('冻结身份、追加前摘要、工具摘要不允许误配',async()=>{
 const folder=process.env.SCREEPS_T1_EXIT_CANDIDATE_DIR||'/Users/forst/Downloads/screeps-t1-exit-r1-candidate-20261002';
 const m=JSON.parse(await readFile(folder+'/manifest.json','utf8'));const bundle=await readFile(folder+'/main.js','utf8');
 const tool=await readFile(new URL('../../../../scripts/deploy-frozen-t1-exit-r1.mjs',import.meta.url));
 const toolHash=createHash('sha256').update(tool).digest('hex');assert.equal(m.deployToolSha256,toolHash);
 assert.equal(validateFrozenMetadata(m,bundle,m.sourceTree,toolHash),true);
 for(const key of ['sourceCommit','sourceTree','buildTag','deployBundleHash','deployToolSha256']) assert.equal(validateFrozenMetadata({...m,[key]:'mismatch'},bundle,m.sourceTree,toolHash),false);
 assert.equal(validateFrozenMetadata(m,bundle+' ',m.sourceTree,toolHash),false);
});
