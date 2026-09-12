'use strict';
const fs=require('node:fs'),path=require('node:path');
const C=require('./common.cjs'),K=require('./pins.cjs'),P=require('../vendor/0003/protocol.cjs');
const guard=require('../vendor/deployGuard.cjs');
function checkMarker(value,s){if(!value||value.runId!==s.runId||value.candidateHash!==s.candidate.digest.hash
 ||value.backupHash!==s.backup.digest.hash||!Number.isSafeInteger(value.startedAtMs))C.fail('RESTORE_MARKER_INVALID');return value;}
function ledger(prior,s){
 const p=path.join(prior,'restore-attempt.json');return fs.existsSync(p)?checkMarker(C.json(p,16384),s):null;
}
function loadInput(source,prior,policy=K){
 const s=C.json(path.join(source,'run','public-session.json'));
 if(s.runId!==policy.runId||s.profileHead!==policy.profileHead||s.kind!=='formal-compat-observation-0003-public/v1')C.fail('SOURCE_SESSION_MISMATCH');
 for(const [k,v]of Object.entries(C.EXPECTED))if(s[k]!==v)C.fail('SOURCE_IDENTITY_MISMATCH');
 if(!C.same(s.backupDigest,policy.originalDigest||C.ORIGINAL_DIGEST))C.fail('BACKUP_DIGEST_MISMATCH');
 for(const n of ['public-session.json','upload-attempt.json','upload-result.json']){
  if(!C.bytes(path.join(prior,n)).equals(C.bytes(path.join(source,'run',n))))C.fail('PRIOR_RUN_RECEIPT_MISMATCH');
 }
 const a=C.json(path.join(prior,'upload-attempt.json')),u=C.json(path.join(prior,'upload-result.json'));
 if(a.runId!==s.runId||a.profileHead!==s.profileHead||a.candidateHash!==s.candidateDigest.hash||u.runId!==s.runId
   ||u.candidateHash!==s.candidateDigest.hash||u.result?.confirmed!==true||u.result.status!=='UPLOADED_AND_READBACK_VERIFIED')C.fail('UPLOAD_CONFIRMATION_INVALID');
 for(const n of ['backup','candidate']){
  const b=C.bytes(path.join(prior,n+'.json'));
  if(C.sha256(b)!==policy[n+'FileSha256']||C.sha256(b)!==s[n+'FileSha256'])C.fail('SNAPSHOT_BYTES_CHANGED');
  let snapshot;try{snapshot=JSON.parse(b);}catch{C.fail('SNAPSHOT_JSON_INVALID');}
  s[n]=P.validateSnapshot(snapshot,guard);
  if(!C.same(s[n].digest,s[n+'Digest']))C.fail('SNAPSHOT_DIGEST_CHANGED');
 }
 if(!C.same(P.confirmBuild(s.candidate.modules,s.profileHead,s.profileTree),s.build))C.fail('CANDIDATE_BUILD_MISMATCH');
 if(!C.same(P.buildIdentity(s.backup.modules.main),s.backupBuild))C.fail('BACKUP_BUILD_MISMATCH');
 if(P.equalModules(s.backup.modules,s.candidate.modules,guard))C.fail('SNAPSHOTS_NOT_DISTINCT');
 ledger(prior,s);return s;
}
function ensureStopped(prior){for(const n of ['action.lock','guard.lock','collector.lock','recovery-closure.lock'])if(fs.existsSync(path.join(prior,n)))C.fail('PRIOR_LOCK_PRESENT_NO_AUTOMATIC_REMOVAL');}
module.exports={loadInput,ledger,checkMarker,ensureStopped,guard};
