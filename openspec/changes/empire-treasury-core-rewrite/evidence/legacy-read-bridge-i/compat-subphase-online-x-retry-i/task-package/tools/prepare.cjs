'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const {createRequire}=require('node:module');
const U=require('./util.cjs'),B=require('./build.cjs'),X=require('./source.cjs'),{closeSource}=require('./close-source.cjs');
const C=require('../runtime/common.cjs'),P=require('../runtime/protocol.cjs'),K=require('../runtime/policy.cjs'),S=require('../runtime/store.cjs'),A=require('../runtime/actions.cjs');
const {client}=require('../runtime/transport.cjs'),RR=require('../runtime/read-retry.cjs'),{inspectProfile,validateProfileLead}=require('../runtime/check-profile.cjs');
async function prepare(o){
 const compat=path.resolve(o.compat),refactor=path.resolve(o.refactor),work=path.resolve(o.work);
 const source=X.verifyHead(compat);U.exactHead(refactor,K.REFACTOR,'refactor/empire-treasury-rearchitecture');
 if(U.remoteHead(refactor,'refactor/empire-treasury-rearchitecture')!==K.REFACTOR||U.remoteHead(compat,'compat/treasury-read-bridge-i')!==K.COMPAT)C.fail('REMOTE_BASELINE_CHANGED');
 U.outside(work,compat);U.outside(work,refactor);U.outside(U.ROOT,compat);U.outside(U.ROOT,refactor);
 const offline=C.readJson(path.join(o.offline,'result.json'));if(offline.sourceHead!==source.head||offline.status!=='SUBPHASE_X_RETRY_OFFLINE_VERIFIED'||offline.repositoryNodeTests!==246||offline.sourceManifestOutputValidation!=='all-listed-outputs'||offline.packageFingerprint!==C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))))C.fail('OFFLINE_BASELINE_GATE_MISSING');
 const selfTests=C.readJson(path.join(o.tests,'summary.json'));if(selfTests.status!=='SUBPHASE_X_RETRY_TOOL_TESTS_VERIFIED'||selfTests.tests!==require('../references/test-contract.json').count||selfTests.passed!==selfTests.tests||['failed','skipped','todo','cancelled'].some(k=>selfTests[k]!==0)||selfTests.packageFingerprint!==C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))))C.fail('PACKAGE_TEST_GATE_MISSING');
 const secret=C.loadSecret(o.secret),guard=C.loadGuard(compat),ts=createRequire(path.join(compat,'package.json'))('typescript');
 inspectProfile(compat,'off',undefined,ts);U.newDir(work);const run=path.join(work,'run');U.newDir(run);
 const api=client(secret),preflight=v=>C.log(S.file(run,'preflight-read-events.jsonl'),{component:'prepare',...v});
 const read=(operation,fn)=>RR.readWithRetry({operation,budgetMs:8000,read:fn,record:preflight});
 try{
  const before=await A.current(api,guard,{record:v=>C.log(S.file(run,'preflight-read-events.jsonl'),{component:'prepare-identity',...v})});
  if(JSON.stringify(before.digest)!==JSON.stringify(C.ORIGINAL_DIGEST)||before.build.commit!==C.PRODUCTION_BASE)C.fail('ONLINE_BASELINE_BYTES_CHANGED');
  const rooms=P.ownedRooms(await read('prepare.overview',ms=>api.overview(C.EXPECTED.shard,ms)));if(K.ROOMS.some(r=>!rooms.includes(r)))C.fail('OBSERVATION_ROOM_NOT_OWNED');
  // Anchor immediately before config binding, AFTER all slow offline validation.
  const live=await read('prepare.time.anchor',ms=>api.time(C.EXPECTED.shard,ms));if(live?.ok!==1)C.fail('GAME_TICK_UNREADABLE');
  const profile=K.profileFor(live.time),runId=crypto.randomBytes(16).toString('hex');
  S.newRecord(run,'binding-intent.json',{runId,sourceHead:source.head,sourceTree:source.tree,observedTick:live.time,profile,atMs:Date.now()});
  fs.writeFileSync(path.join(compat,K.CONFIG),K.renderConfig(profile));
  U.git(compat,['add','--',K.CONFIG]);U.git(compat,['commit','-m',`evidence(compat): bind subphase online X retry I ${profile.startTick}-${profile.endTick}`]);U.clean(compat);
  const head=U.textGit(compat,['rev-parse','HEAD']);if(U.textGit(compat,['rev-parse','HEAD^'])!==source.head||U.textGit(compat,['diff','--name-only',source.head,head])!==K.CONFIG)C.fail('PROFILE_COMMIT_SCOPE_INVALID');
  S.newRecord(run,'binding.json',{runId,sourceHead:source.head,sourceTree:source.tree,profileHead:head,observedTick:live.time,profile,atMs:Date.now()});
  inspectProfile(compat,'on',live.time,ts);
  const b=B.detachedBuild(compat,head,work),build=P.confirmBuild(b.modules,b.head,b.tree);
  const current=await A.current(api,guard,{record:v=>C.log(S.file(run,'preflight-read-events.jsonl'),{component:'prepare-identity-after-build',...v})});const fresh=await read('prepare.time.fresh',ms=>api.time(C.EXPECTED.shard,ms));if(fresh?.ok!==1)C.fail('GAME_TICK_UNREADABLE');if(fresh.time<live.time)C.fail('GAME_TICK_REGRESSED');validateProfileLead(profile,fresh.time);current.observedTick=fresh.time;
  if(!P.equalModules(before.modules,current.modules,guard))C.fail('BASELINE_CHANGED_DURING_BUILD');
  const backup=P.makeSnapshot(current.modules,guard),candidate=P.makeSnapshot(b.modules,guard);
  S.newRecord(run,'backup.json',backup);S.newRecord(run,'candidate.json',candidate);
  const s={kind:K.KIND,runId,...C.EXPECTED,refactorBase:K.REFACTOR,compatRootBase:K.COMPAT,compatBase:source.head,sourceHead:source.head,sourceTree:source.tree,observedTick:live.time,
   profile,profileHead:head,profileTree:b.tree,build,backupBuild:current.build,preparedAtMs:Date.now(),wallLimitMs:K.WALL_MS,toolFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))),
   backupFileSha256:C.sha256(fs.readFileSync(S.file(run,'backup.json'))),candidateFileSha256:C.sha256(fs.readFileSync(S.file(run,'candidate.json')))};
  S.newRecord(run,'session.json',s);S.loadRun(run,guard);
  const pub={...s,kind:K.PUBLIC_KIND,backupDigest:backup.digest,candidateDigest:candidate.digest};
  S.newRecord(run,'public-session.json',pub);
  const r={status:'SUBPHASE_X_RETRY_PREPARED_NOT_DEPLOYED',runId,profileHead:head,startTick:profile.startTick,endTick:profile.endTick,latestObservedTick:current.observedTick,work};
  S.newRecord(run,'prepare-result.json',r);return r;
 }catch(e){
  S.newRecord(run,'preparation-failure.json',{error:A.codeOf(e),atMs:Date.now(),noUpload:true});
  if(S.optional(run,'binding-intent.json')){try{closeSource(compat,run);}catch(err){S.newRecord(run,'close-source-failure.json',{error:A.codeOf(err)});}}
  throw e;
 }
}
module.exports={prepare};if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat','work','secret','offline','tests'],['bind-profile']);C.required(o,'refactor','compat','work','secret','offline','tests');if(!o['bind-profile'])C.fail('EXPLICIT_PROFILE_BINDING_REQUIRED');U.verifyPackage();console.log(JSON.stringify(await prepare(o)));});
