'use strict';
const fs=require('node:fs'),path=require('node:path');const F=require('./fixture.cjs'),C=require('../runtime/common.cjs'),S=require('../runtime/store.cjs'),K=require('../runtime/policy.cjs');
function completeEvidence(d,s){
 F.saveSession(d,s);const t=Date.now()-600000,restoreTime=t+150000,confirmStart=restoreTime+2000,stop=confirmStart+75000+1000;
 const a={runId:s.runId,candidateHash:s.candidate.digest.hash,profileHead:s.profileHead,startedAtMs:t,observedTick:1000};
 S.newRecord(d,'upload-attempt.json',a);S.newRecord(d,'upload-result.json',{runId:s.runId,candidateHash:s.candidate.digest.hash,result:{status:'UPLOADED_AND_READBACK_VERIFIED',confirmed:true,digest:s.candidate.digest,build:s.build}});
 const samples=F.allSamples(s),lines=[{kind:'auth-confirmed',runId:s.runId,pid:100}];
 for(let at=t;at<=stop;at+=1000){
  const log=[];if(at===t)log.push('[deploy] '+s.build.tag);const i=(at-t)/10000;if(Number.isInteger(i)&&i>=1&&i<=12)log.push(JSON.stringify(samples[i-1]));if(at===restoreTime)log.push('[deploy] '+s.backupBuild.tag);
  for(const [ch,data]of[[`user:${s.userId}/console`,{shard:s.shard,messages:{log,results:[]}}],[`user:${s.userId}/cpu`,{cpu:50}]] )lines.push({kind:'ws-frame',runId:s.runId,receivedAt:new Date(at).toISOString(),text:JSON.stringify([ch,data])});
 }
 lines.push({kind:'collector-footer',runId:s.runId,pid:100,reason:'observation_closed',exitCode:0});
 fs.writeFileSync(path.join(d,'console.jsonl'),lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
 S.newRecord(d,'collector-result.json',{runId:s.runId,pid:100,status:'closed',exitCode:0,footerWritten:true,lockRemoved:true});
 S.newRecord(d,'restore-attempt.json',{runId:s.runId,backupHash:s.backup.digest.hash,startedAtMs:restoreTime});
 const readback={status:'CURRENT_IS_BACKUP',confirmed:true,checks:[{sameAsBackup:true,sameAsCandidate:false,observedTick:s.profile.endTick+1,digest:s.backup.digest,build:s.backupBuild}]};
 S.newRecord(d,'restore-independent-before.json',readback);S.newRecord(d,'restore-independent-after.json',readback);
 S.newRecord(d,'runtime-confirmation.json',{confirmed:true,durationMs:75000,startedAtMs:confirmStart,endedAtMs:confirmStart+75000,collectorPid:100});
 S.newRecord(d,'guard-result.json',{runId:s.runId,reason:'LAST_SAMPLE_RECEIVED',auditFailed:false});
 S.newRecord(d,'driver-result.json',{collectorExit:0,guardExit:0,failure:null});S.newRecord(d,'source-closed.json',{status:'SOURCE_DEFAULT_OFF_RESTORED',profileHead:s.profileHead,sameTreeAsCompatBase:true});
 return {t,restoreTime,confirmStart,lines};
}
module.exports={completeEvidence};
