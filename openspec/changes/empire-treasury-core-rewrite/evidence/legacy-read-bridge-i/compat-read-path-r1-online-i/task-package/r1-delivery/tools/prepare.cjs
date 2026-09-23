'use strict';
const C=require('./common.cjs'),N=require('./integration.cjs'),I=require('../implementation/core-identities.json');
const {fs,path,P,ROOT}=C;
function verifyArchiveEntries(manifest,entries){
 C.check(manifest.kind==='package-integrity/v1'&&manifest.files&&typeof manifest.files==='object','INHERITED_MANIFEST_INVALID');
 const names=Object.keys(manifest.files).sort();C.check(names.length===66,'INHERITED_PAYLOAD_COUNT_CHANGED');
 const seen=new Set();for(const n of [...names,'INTEGRITY.json']){C.safePath(n);C.check(!seen.has(n.toLowerCase()),'CASE_COLLISION');seen.add(n.toLowerCase());}
 C.check(C.same(entries.map(x=>x.name).sort(),[...names,'INTEGRITY.json'].sort()),'INHERITED_FILE_SET_CHANGED');
 for(const e of entries)C.check(e.mode==='100644'&&e.type==='blob'&&/^[a-f0-9]{40}$/.test(e.sha),'INHERITED_MODE_CHANGED');
 for(const n of names){const v=manifest.files[n];C.check(Number.isSafeInteger(v.bytes)&&v.bytes>=0&&v.bytes<20*1048576&&/^[a-f0-9]{64}$/.test(v.sha256),'INHERITED_IDENTITY_INVALID');}
 return names;
}
function extractInherited(repo,out){
 const spec=P.refactorBase+':'+P.inheritedPrefix;
 const raw=C.git(repo,['show',spec+'/INTEGRITY.json']);C.check(C.sha(raw)===P.inheritedIntegritySha256,'INHERITED_PACKAGE_IDENTITY_CHANGED');
 const m=JSON.parse(raw),tree=C.git(repo,['ls-tree','-r','-z',spec]).toString('utf8').split('\0').filter(Boolean);
 const entries=tree.map(line=>{const i=line.indexOf('\t');C.check(i>0,'GIT_TREE_INVALID');const [mode,type,sha]=line.slice(0,i).split(' ');return{mode,type,sha,name:line.slice(i+1)};});
 const names=verifyArchiveEntries(m,entries),buffers=new Map();
 for(const n of names){const b=C.git(repo,['show',spec+'/'+n]);const e=entries.find(x=>x.name===n);C.check(b.length===m.files[n].bytes&&C.sha(b)===m.files[n].sha256&&C.blob(b)===e.sha,'INHERITED_BYTES_CHANGED:'+n);buffers.set(n,b);}
 C.check(!fs.existsSync(out),'INHERITED_DIR_EXISTS');fs.mkdirSync(out);
 for(const[n,b]of buffers)C.write(path.join(out,n),b);C.write(path.join(out,'INTEGRITY.json'),raw);C.verify(out);
 return{commit:P.refactorBase,prefix:P.inheritedPrefix,files:names.length,integritySha256:C.sha(raw)};
}
function priorEvidence(repo){
 const f=C.git(repo,['show',P.refactorBase+':'+P.priorFinalPath]);C.check(C.blob(f)===P.priorFinalBlob,'PRIOR_FINAL_CHANGED');const v=JSON.parse(f);
 C.check(v.captureVerified===true&&v.rawReports===4&&v.acceptedReports===4&&v.completeSamples===0&&v.sourceOff===true&&v.closure==='RESTORED_BYTES_AND_RUNTIME_VERIFIED'&&v.writeBoundaries.candidate===1&&v.writeBoundaries.restore===1,'PRIOR_RESULT_NOT_VERIFIED');
 const r=C.git(repo,['show',P.refactorBase+':'+P.priorRecoveryPath]);C.check(C.blob(r)===P.priorRecoveryBlob,'PRIOR_RECOVERY_CHANGED');const recovery=JSON.parse(r);C.check(recovery.status==='RESTORED_BYTES_AND_RUNTIME_VERIFIED'&&recovery.bytesConfirmed===true&&recovery.runtimeConfirmed===true,'PRIOR_RECOVERY_NOT_VERIFIED');
 return{finalBlob:C.blob(f),recoveryBlob:C.blob(r),status:v.status};
}
function changed(repo){return [...new Set([...C.git(repo,['diff','--name-only','-z','HEAD']).toString('utf8').split('\0'),...C.git(repo,['ls-files','--others','--exclude-standard','-z']).toString('utf8').split('\0')].filter(Boolean))].sort();}
function resolvedPolicy(old,source){
 C.check(old.authorizationId==='compat-read-envelope-XV-online-I-retry-I-2026-09-23'&&old.compilerVersion==='5.9.3'&&old.wallMs===4500000&&old.points===4&&old.runtimeMs===75000&&old.selection?.minimumSlackMs===180000,'INHERITED_POLICY_CHANGED');
 return {...old,authorizationId:P.authorizationId,parentRunId:P.runId,compatBase:source.head,compatBaseTree:source.tree,
  implementationHead:source.head,implementationBase:source.base||P.compatBase,refactorBase:P.refactorBase,
  sourceMessage:source.repaired?P.repairMessage:P.sourceMessage,evidenceMessage:P.evidenceMessage,evidencePath:P.evidencePath,
  repositoryNodeTests:P.repositoryNodeTests,priorRecoveryPath:P.priorRecoveryPath,priorRecoveryBlob:P.priorRecoveryBlob,
  readPathImplementation:'READ-PATH-R1',inheritedExecutionProtocol:old.kind};
}
function resolveExecutor(inherited,out,source,manifest,receipt){
 C.check(!fs.existsSync(out),'EXECUTOR_DIR_EXISTS');fs.cpSync(inherited,out,{recursive:true,errorOnExist:true,force:false});
 const before=C.json(path.join(out,'policy.json')),after=resolvedPolicy(before,source);
 fs.writeFileSync(path.join(out,'policy.json'),JSON.stringify(after,null,2)+'\n');
 fs.writeFileSync(path.join(out,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 // Keep every runtime/tool/test/vendor byte EXACT. Historical documentation and
 // XV status identifiers are retained as provenance, never relabeled as R1 tests.
 fs.cpSync(ROOT,path.join(out,'r1-delivery'),{recursive:true,errorOnExist:true,force:false});
 C.durable(path.join(out,'READ-PATH-R1.json'),{kind:'resolved-read-path-R1/v1',receipt,source,sourcePaths:source.repaired?P.repairSourcePaths:P.sourcePaths,
   inheritedIntegrity:P.inheritedIntegritySha256,changedInheritedFiles:['policy.json','source-manifest.json'],
   reusedRuntimeBytesUnchanged:true,inheritedStatusLabelsAreProtocolOnly:true,
   historicalPriorAttempt:'XV zero-deployment record remains an inherited historical gate; the outer preparer additionally pins the latest successful XV trial and recovery.',
   makerBoundary:'See r1-delivery/MAKER-VALIDATION.json for actual maker coverage. The complete 165-tool and 467-repository gates, both tsc projects, replay, Jest and Rollup remain mandatory on the execution host before upload.'});
 const im=C.json(path.join(inherited,'INTEGRITY.json'));
 for(const[n,v]of Object.entries(im.files)){if(['policy.json','source-manifest.json'].includes(n))continue;const b=C.read(path.join(out,n));C.check(b.length===v.bytes&&C.sha(b)===v.sha256,'INHERITED_RUNTIME_MUTATED:'+n);}
 return C.seal(out);
}
function prepare(o){
 C.verify();C.required(o,['compat','refactor','work','prior-work']);
 for(const k of ['compat','refactor','work','prior-work'])o[k]=path.resolve(o[k]);
 C.outside(o.work,o.compat);C.outside(o.work,o.refactor);C.outside(o.work,ROOT);
 C.outside(ROOT,o.compat);C.outside(ROOT,o.refactor);
 C.outside(o.work,o['prior-work']);C.outside(o['prior-work'],o.work);
 C.outside(o['prior-work'],o.compat);C.outside(o['prior-work'],o.refactor);
 C.check(!fs.existsSync(o.work),'WORK_DIR_ALREADY_EXISTS');
 C.baseline(o.refactor,P.refactorBranch,P.refactorBase);
 C.clean(o.compat);C.origin(o.compat);
 C.check(C.text(o.compat,['branch','--show-current'])===P.compatBranch,'COMPAT_BRANCH_CHANGED');
 C.check(C.remote(o.compat,P.compatBranch)===P.compatBase,'REMOTE_BASE_CHANGED');
 C.check(C.tree(o.compat,P.compatBase)===P.compatBaseTree,'BASE_TREE_CHANGED');
 const ts=C.json(path.join(o.compat,'node_modules/typescript/package.json'));
 C.check(ts.version===P.compilerVersion,'PINNED_TYPESCRIPT_REQUIRED');
 const F=require('./repair.cjs');
 F.authorizationUnused(o.compat);
 const prior=F.priorAttempt(o['prior-work']);
 const candidate=F.verifyExistingR1(o.compat,prior);
 fs.mkdirSync(o.work);
 const receipt={package:C.verify(),prior:priorEvidence(o.refactor),repairOfPackage:P.priorPackageFingerprint,at:new Date().toISOString()};
 C.durable(path.join(o.work,'prepare-start.json'),receipt);
 C.durable(path.join(o.work,'PRIOR-ATTEMPT.json'),prior);
 for(const[n,v]of Object.entries(prior.files)){const bytes=C.read(path.join(prior.directory,n));C.check(bytes.length===v.bytes&&C.sha(bytes)===v.sha256,'PRIOR_LOG_CHANGED_DURING_COPY');C.write(path.join(o.work,'prior-attempt-files',n),bytes);}
 const inherited=path.join(o.work,'inherited-executor'),inheritance=extractInherited(o.refactor,inherited);
 const log=path.join(o.work,'source-checks');
 // Generator and runtime bytes were verified against the R1-v1 recipe above.
 // This check recomputes every generated output, not merely Core byte length.
 C.command(o.compat,['scripts/build-treasury-compat-loader.cjs','--check'],log,'generator-r1-before-repair');
 const source=F.commitRepair(o.compat,candidate);
 C.command(o.compat,['scripts/build-treasury-compat-loader.cjs','--check'],log,'generator-r1-after-repair');
 N.verifyCurrentCore(C.read(path.join(o.compat,P.corePath)));
 C.clean(o.compat);F.authorizationUnused(o.compat);
 const manifest=F.manifest(o.compat,source);
 const repair={status:'R1_HISTORICAL_ASSERTIONS_REPAIRED',originalSource:candidate.original,source,
  runtimeCoreUnchanged:true,changedPaths:P.repairSourcePaths,authorizationId:P.authorizationId,
  authorizationRefreshed:false,priorAttemptDirectory:prior.directory,at:new Date().toISOString()};
 C.durable(path.join(o.work,'R1-REPAIR.json'),repair);
 C.durable(path.join(o.work,'source-preparation.json'),{status:'R1_V2_FORWARD_REPAIR_COMMITTED_NOT_YET_PUBLISHED',source,manifest,inheritance,receipt,originalR1:candidate.original});
 const executor=path.join(o.work,'executor'),info=resolveExecutor(inherited,executor,source,manifest,receipt);
 const result={status:'R1_V2_PREPARED',source,executor,executorFingerprint:info.fingerprint,inheritance,fullOfflineGatePassed:false,onlinePosts:0};
 C.durable(path.join(o.work,'prepared.json'),result);return result;
}
module.exports={prepare,verifyArchiveEntries,extractInherited,priorEvidence,resolvedPolicy,resolveExecutor,changed};
if(require.main===module)C.cli(()=>{const o=C.args(['compat','refactor','work','prior-work']);C.required(o,['compat','refactor','work','prior-work']);return prepare(o);});
