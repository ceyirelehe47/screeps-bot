'use strict';
const C=require('./common.cjs'),D=require('./decoder.cjs'),W=require('../vendor/0003/samples.cjs');
/** Parse receipt first; acceptance is a separate decision. No budget or completeness relaxation. */
function replay(text,s){
 const reports=[],failures=[];let frames=0,lineNumber=0;
 for(const line of text.trimEnd().split('\n')){lineNumber++;let x;try{x=JSON.parse(line);}catch{C.fail('SOURCE_JSONL_INVALID');}
  if(x.runId!==s.runId)C.fail('SOURCE_RUN_ID_MISMATCH');
  if(x.kind!=='ws-frame')continue;frames++;
  let frame;try{frame=JSON.parse(x.text);}catch{continue;}
  if(!Array.isArray(frame)||frame.length!==2)continue;
  const [ch,data]=frame;
  if(ch!==`user:${s.userId}/console`||data?.shard!==s.shard||!Array.isArray(data.messages?.log))continue;
  for(const raw of data.messages.log){const r=D.parseBridge(raw);if(r.kind==='invalid')failures.push({line:lineNumber,error:r.error});
   if(r.kind==='bridge'){
    let reason;try{reason=W.sampleError(r.report,s.profile);}catch{reason='SAMPLE_STRUCTURE_INVALID';}
    reports.push({sourceLine:lineNumber,receivedAt:x.receivedAt,encoding:r.encoding,accepted:reason===null,rejection:reason,
      reportSha256:C.sha256(JSON.stringify(r.report)),report:r.report});
   }
  }
 }
 const due=Array.from({length:12},(_,i)=>s.profile.startTick+i*100),complete=reports.filter(x=>x.accepted);
 return {status:'SOURCE_0003_REPLAYED_NOT_OBSERVED',runId:s.runId,frames,rawBridgeReports:reports.length,
  completeBridgeReports:complete.length,receivedTicks:reports.map(x=>x.report.tick),completeTicks:complete.map(x=>x.report.tick),
  missingRawTicks:due.filter(t=>!reports.some(x=>x.report.tick===t)),missingCompleteTicks:due.filter(t=>!complete.some(x=>x.report.tick===t)),
  decodingFailures:failures,reports,cpuFindings:reports.map(x=>({tick:x.report.tick,status:x.report.status,
    cpuBeforeSerializationAndEmit:x.report.cpuBeforeSerializationAndEmit??null,budget:s.profile.maxSampleCpu,
    commitmentsStatus:x.report.commitments?.status??null,completeCost:'not_observed_no_following_report',
    phaseAttribution:'not_observable_from_existing_report',budgetChanged:false})),observationStatus:'ONLINE_COMPAT_READ_INCONCLUSIVE'};
}
module.exports={replay};
