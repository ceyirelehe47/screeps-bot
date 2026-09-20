'use strict';
const fs=require('node:fs'),path=require('node:path');
const C=require('./common.cjs'),P=C.POLICY,G=require('../vendor/deployGuard.cjs');
function modules(m){if(!C.obj(m)||Object.keys(m).length!==1||typeof m.main!=='string'||!m.main.length)C.fail('UNRECOGNIZED_MODULE_SET');return m;}
function digest(m){modules(m);const b=Buffer.from(m.main,'utf8');return {algorithm:'deployGuard.computeModulesHash/NUL-v1',hash:G.computeModulesHash(m),files:[{name:'main',kind:'text',bytes:b.length,sha256:C.sha(b)}]};}
function eq(a,b){const d=G.diffRemoteModules(a,b);return d.match&&!d.missing.length&&!d.extra.length&&!d.changed.length;}
function build(m){const get=n=>{const x=[...m.main.matchAll(new RegExp('const '+n+' = "([^"\\r\\n]*)"\\s*;','g'))];if(x.length!==1)C.fail('BUILD_IDENTITY_INVALID');return x[0][1];};return {commit:get('BUILD_COMMIT'),tree:get('BUILD_TREE'),deployBranch:get('BUILD_DEPLOY_BRANCH')};}
function validateSnapshot(s,expected){if(!C.obj(s)||s.kind!=='compat-online-modules-v1')C.fail('SNAPSHOT_INVALID');for(const[k,v]of Object.entries(P.expected))if(s[k]!==v)C.fail('SNAPSHOT_TARGET_MISMATCH');const d=digest(s.modules);if(!C.same(d,expected)||!C.same(s.digest,expected))C.fail('SNAPSHOT_DIGEST_MISMATCH');return s;}
function loadOrigin(run){run=fs.realpathSync(run);if(C.blob(C.bytes(path.join(__dirname,'../vendor/deployGuard.cjs')))!==P.guardBlob)C.fail('CANONICAL_GUARD_CHANGED');
 for(const[n,x]of Object.entries(P.originFiles)){const b=C.bytes(path.join(run,n));if(b.length!==x.bytes||C.sha(b)!==x.sha256)C.fail('ORIGINAL_EVIDENCE_CHANGED');}
 const s=C.json(path.join(run,'session.json')),pub=C.json(path.join(run,'public-session.json'));
 if(s.runId!==P.parentRunId||pub.runId!==P.parentRunId||s.profileHead!==P.candidateHead||pub.profileHead!==P.candidateHead)C.fail('ORIGIN_RUN_MISMATCH');
 const backup=validateSnapshot(C.json(path.join(run,'backup.json')),P.backupDigest),candidate=validateSnapshot(C.json(path.join(run,'candidate.json')),P.candidateDigest);
 for(const[n,v]of [['backup',backup],['candidate',candidate]]){const want=n==='backup'?P.backupBuild:P.candidateBuild;if(!C.same(build(v.modules),{commit:want.commit,tree:want.tree,deployBranch:want.deployBranch}))C.fail('SNAPSHOT_BUILD_MISMATCH');}
 if(eq(candidate.modules,backup.modules))C.fail('IDENTICAL_CANDIDATE_AND_BACKUP');
 const text=C.bytes(path.join(run,'actions.jsonl')).toString('utf8');if(!text.endsWith('\n'))C.fail('TRUNCATED_ORIGINAL_LEDGER');
 const events=text.trimEnd().split('\n').filter(Boolean).map(x=>JSON.parse(x)),writes=events.filter(x=>x.kind==='code-write-boundary');
 if(writes.length!==2||writes[0].action!=='candidate'||writes[1].action!=='restore'||writes.some(x=>x.runId!==P.parentRunId))C.fail('ORIGINAL_WRITE_LEDGER_CHANGED');
 for(const name of ['collector','recovery-worker']){const a=C.json(path.join(run,name+'.process.json')),b=C.json(path.join(run,name+'.exit.json'));if(a.pid!==b.pid||!Number.isInteger(b.code))C.fail('ORIGINAL_WORKER_EXIT_UNPROVEN');}
 return {run,s,pub,backup,candidate,originSummary:{parentRunId:P.parentRunId,originalWrites:{candidate:1,restore:1},backupDigest:backup.digest,candidateDigest:candidate.digest,privateSnapshotsVerified:true}};
}
function account(x){if(x?.ok!==1||x._id!==P.expected.userId||x.username!==P.expected.username)C.fail('ACCOUNT_MISMATCH');}
function active(x){if(x?.ok!==1||!Array.isArray(x.list))C.fail('ACTIVE_BRANCH_INVALID');const names=new Set();for(const b of x.list){if(!C.obj(b)||typeof b.branch!=='string'||names.has(b.branch)||(b.activeWorld!==undefined&&typeof b.activeWorld!=='boolean'))C.fail('ACTIVE_BRANCH_INVALID');names.add(b.branch);}const a=x.list.filter(b=>b.activeWorld===true);if(a.length!==1||a[0].branch!==P.expected.branch)C.fail('ACTIVE_BRANCH_CHANGED');}
function classify(m,origin){if(eq(origin.backup.modules,m))return 'CURRENT_IS_BACKUP';if(eq(origin.candidate.modules,m))return 'CURRENT_IS_CANDIDATE';return 'CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT';}
async function readIdentity(api,origin,budget){await api.me(budget(15000)).then(account);await api.branches(budget(15000)).then(active);const r=await api.code(budget(P.readRequestMaxMs));if(r?.ok!==1||!C.obj(r.modules))C.fail('MODULE_RESPONSE_INVALID');await api.branches(budget(15000)).then(active);
 const state=classify(r.modules,origin);if(state==='CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT')C.fail(state);
 return {state,digest:state==='CURRENT_IS_BACKUP'?P.backupDigest:P.candidateDigest,build:state==='CURRENT_IS_BACKUP'?P.backupBuild:P.candidateBuild,atMs:Date.now()};}
module.exports={modules,digest,eq,build,validateSnapshot,loadOrigin,account,active,classify,readIdentity};
