'use strict';
const path=require('node:path');const {performance}=require('node:perf_hooks');
const C=require('./common.cjs'),K=require('./pins.cjs'),D=require('./decoder.cjs');
/** New recovery-only stream. Never appends to 0003 console.jsonl and never signs off bridge samples. */
async function observeRuntime({out,closureId,parentRunId,secret,WebSocketClass=global.WebSocket,
 durationMs=K.runtimeMs,startupMs=K.runtimeStartupMs,silenceMs=K.channelSilenceMs,pollMs=250,isCancelled=()=>false}){
 if(typeof WebSocketClass!=='function')C.fail('NODE22_WEBSOCKET_REQUIRED');
 const logFile=path.join(out,'runtime-console.jsonl'),mono=()=>performance.now();
 let ws,timer,finished=false,auth=0,startedAtMs=null,startedMono=null,lastConsole=null,lastCpu=null,positive=false,bytes=0,resolve;
 const begun=mono(),createdAtMs=Date.now(),pid=process.pid;const done=new Promise(r=>resolve=r);
 function record(v){C.log(logFile,{closureId,parentRunId,pid,...v});}
 function finish(reason){
  if(finished)return;finished=true;clearInterval(timer);try{ws?.close();}catch{}
  const endedAtMs=Date.now(),elapsedMs=startedMono===null?0:mono()-startedMono;
  let result={kind:'recovery-runtime-observer/v1',closureId,parentRunId,pid,createdAtMs,startedAtMs,endedAtMs,
   monotonicDurationMs:Math.floor(elapsedMs),requestedDurationMs:durationMs,status:reason==='runtime_complete'?'RECOVERY_RUNTIME_COLLECTED':'RECOVERY_RUNTIME_UNCONFIRMED',
   reason,authentications:auth,positiveCpuObserved:positive,observationSamplesAccepted:0,
   continuityWithOriginalCollectorClaimed:false,scope:'fresh shard1 console plus account-level CPU; code bytes checked separately'};
  try{record({kind:'recovery-runtime-footer',reason,startedAtMs,endedAtMs,monotonicDurationMs:Math.floor(elapsedMs)});
   C.durable(path.join(out,'runtime-observer-result.json'),result);
  }catch{result={...result,status:'RECOVERY_RUNTIME_UNCONFIRMED',reason:'RUNTIME_EVIDENCE_WRITE_FAILED'};}
  resolve(result);
 }
 try{
  record({kind:'recovery-runtime-start',createdAtMs});
  ws=new WebSocketClass('wss://screeps.com/socket/websocket');
  ws.addEventListener('open',()=>{try{ws.send('auth '+secret.token);}catch{finish('AUTH_SEND_FAILED');}});
  ws.addEventListener('message',ev=>{if(finished)return;try{
   const text=typeof ev.data==='string'?ev.data:Buffer.from(ev.data).toString('utf8');
   if(Buffer.byteLength(text)>1048576||bytes+Buffer.byteLength(text)>4*1048576){finish('RUNTIME_LOG_SIZE_LIMIT');return;}
   const now=Date.now();
   if(text==='auth ok'||text.startsWith('auth ok ')){
    if(++auth!==1){finish('AUTHENTICATION_REPEATED');return;}
    record({kind:'auth-confirmed'});ws.send(`subscribe user:${C.EXPECTED.userId}/console`);ws.send(`subscribe user:${C.EXPECTED.userId}/cpu`);return;
   }
   if(text.startsWith('auth ')){finish('AUTHENTICATION_FAILED');return;} // Never persist any auth reply.
   const safe=secret.redact(text);record({kind:'ws-frame',text:safe,redacted:safe!==text});bytes+=Buffer.byteLength(safe);
   let frame;try{frame=JSON.parse(text);}catch{return;}
   if(auth!==1||!Array.isArray(frame)||frame.length!==2)return;
   const [ch,data]=frame;
   if(ch===`user:${C.EXPECTED.userId}/console`&&data?.shard===C.EXPECTED.shard&&Array.isArray(data.messages?.log)&&Array.isArray(data.messages?.results)){
    lastConsole=now;
    // A bridge frame cannot turn recovery confirmation into an observation success.
    for(const line of data.messages.log){const p=D.parseBridge(line);if(p.kind==='bridge'||p.kind==='invalid'){finish('UNEXPECTED_BRIDGE_DURING_RECOVERY_CONFIRMATION');return;}}
   }
   if(ch===`user:${C.EXPECTED.userId}/cpu`&&typeof data?.cpu==='number'&&Number.isFinite(data.cpu)&&data.cpu>=0){lastCpu=now;if(startedMono!==null&&data.cpu>0)positive=true;}
   if(startedMono===null&&lastConsole!==null&&lastCpu!==null){startedAtMs=now;startedMono=mono();record({kind:'recovery-runtime-ready',startedAtMs});}
  }catch{finish('RUNTIME_FRAME_OR_IO_FAILURE');}});
  ws.addEventListener('close',()=>finish('SOCKET_CLOSED'));ws.addEventListener('error',()=>finish('SOCKET_ERROR'));
  timer=setInterval(()=>{
   if(finished)return;const now=Date.now();
   if(isCancelled()){finish('OPERATOR_STOP');return;}
   if(startedMono===null){if(mono()-begun>startupMs)finish('RUNTIME_STARTUP_TIMEOUT');return;}
   if(now-lastConsole>silenceMs||now-lastCpu>silenceMs){finish('RUNTIME_CHANNEL_STALE');return;}
   const elapsed=mono()-startedMono;
   if(Math.abs((now-startedAtMs)-elapsed)>2000){finish('RUNTIME_CLOCK_DISCONTINUITY');return;}
   if(elapsed>=durationMs){finish(positive?'runtime_complete':'NO_POSITIVE_CPU_AFTER_READY');}
  },pollMs);
 }catch{finish('RUNTIME_OBSERVER_START_FAILED');}
 return done;
}
module.exports={observeRuntime};
