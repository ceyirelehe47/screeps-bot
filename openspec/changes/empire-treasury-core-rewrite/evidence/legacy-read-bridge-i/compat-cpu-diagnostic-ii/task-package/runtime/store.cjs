'use strict';
const fs=require('node:fs'),path=require('node:path');
const C=require('./common.cjs'),P=require('./protocol.cjs'),K=require('./policy.cjs');
function file(run,name){if(!/^[a-zA-Z0-9_.-]+$/.test(name))C.fail('ARTIFACT_NAME_INVALID');return path.join(run,name);}
function optional(run,name){const p=file(run,name);return fs.existsSync(p)?C.readJson(p):null;}
function newRecord(run,name,value){
 const fd=fs.openSync(file(run,name),'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return value;
}
function loadRun(run,guard){
 const s=C.readJson(file(run,'session.json'),65536);
 if(s.toolFingerprint!==C.sha256(C.bytes(path.join(__dirname,'..','INTEGRITY.json'))))C.fail('SESSION_TOOL_FINGERPRINT_MISMATCH');
 if(s.kind!==K.KIND||!/^[a-f0-9]{32}$/.test(s.runId)||s.wallLimitMs!==K.WALL_MS
  ||s.refactorBase!==K.REFACTOR||s.compatBase!==K.COMPAT||!/^[a-f0-9]{40}$/.test(s.profileHead)||!/^[a-f0-9]{40}$/.test(s.profileTree))C.fail('FORMAL_SESSION_INVALID');
 for(const [k,v] of Object.entries(C.EXPECTED))if(s[k]!==v)C.fail('SESSION_IDENTITY_MISMATCH');
 K.validProfile(s.profile);
 if(s.profile.startTick!==K.profileFor(s.observedTick).startTick)C.fail('WINDOW_BINDING_MISMATCH');
 for(const name of ['backup','candidate']){
  const snapshotPath=file(run,name+'.json'),st=fs.lstatSync(snapshotPath);if(!st.isFile()||st.isSymbolicLink()||st.size>20*1048576)C.fail('SNAPSHOT_FILE_INVALID');
  const b=fs.readFileSync(snapshotPath);if(C.sha256(b)!==s[name+'FileSha256'])C.fail('SNAPSHOT_FILE_CHANGED');
  s[name]=P.validateSnapshot(JSON.parse(b),guard);
 }
 if(JSON.stringify(s.backup.digest)!==JSON.stringify(C.ORIGINAL_DIGEST))C.fail('ONLINE_BASELINE_BYTES_CHANGED');
 if(P.equalModules(s.backup.modules,s.candidate.modules,guard))C.fail('IDENTICAL_BACKUP_AND_CANDIDATE');
 const build=P.confirmBuild(s.candidate.modules,s.profileHead,s.profileTree);
 if(JSON.stringify(build)!==JSON.stringify(s.build))C.fail('CANDIDATE_BUILD_CHANGED');
 return s;
}
function assertAttempt(a,s){if(!a||a.runId!==s.runId||a.candidateHash!==s.candidate.digest.hash||a.profileHead!==s.profileHead
 ||!Number.isSafeInteger(a.startedAtMs)||a.startedAtMs<0)C.fail('ATTEMPT_IDENTITY_INVALID');return a;}
module.exports={file,optional,newRecord,loadRun,assertAttempt};
