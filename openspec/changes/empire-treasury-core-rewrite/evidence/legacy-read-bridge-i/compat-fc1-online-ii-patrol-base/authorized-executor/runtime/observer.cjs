'use strict';
const path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');const C=require('./common.cjs'),P=C.POLICY;
function frameKind(text){let a;try{a=JSON.parse(text);}catch{return {kind:'other'};}if(!Array.isArray(a)||a.length!==2)return {kind:'other'};const[ch,d]=a;
 if(ch===`user:${P.expected.userId}/console`&&d?.shard===P.expected.shard&&Array.isArray(d.messages?.log)&&Array.isArray(d.messages?.results)){
  if(d.error||d.messages.error)return {kind:'bad',reason:'CONSOLE_RUNTIME_ERROR'};
  for(const s of d.messages.log){if(typeof s!=='string')continue;if(s.includes('treasury-legacy-read-bridge'))return {kind:'bad',reason:'UNEXPECTED_BRIDGE_DURING_RECOVERY'};if(s.startsWith('[deploy] ')&&s!==`[deploy] ${P.backupBuild.tag}`)return {kind:'bad',reason:'UNEXPECTED_DEPLOY_DURING_RECOVERY'};}
  return {kind:'console'};
 }
 if(ch===`user:${P.expected.userId}/cpu`&&typeof d?.cpu==='number'&&Number.isFinite(d.cpu)&&d.cpu>=0)return {kind:'cpu',cpu:d.cpu};
 if(d?.shard===P.expected.shard&&d.error)return {kind:'bad',reason:'CONSOLE_RUNTIME_ERROR'};
 return {kind:'other'};
}
async function observe({out,secret,invocationId,WebSocketClass=global.WebSocket,durationMs=P.runtimeMs,startupMs=P.runtimeStartupMs,silenceMs=P.runtimeSilenceMs,pollMs=250}){
 if(typeof WebSocketClass!=='function')C.fail('NODE22_WEBSOCKET_REQUIRED');const closureId=crypto.randomBytes(16).toString('hex'),parentRunId=P.parentRunId,pid=process.pid,log=path.join(out,'runtime-console.jsonl'),begun=performance.now(),createdAtMs=Date.now();
 let ws,timer,finished=false,auth=0,start=null,startedAtMs=null,lastConsole=null,lastCpu=null,positive=false,size=0,resolve;
 const result=new Promise(r=>resolve=r);const record=v=>C.append(log,{atMs:Date.now(),parentRunId,invocationId,closureId,pid,...v});
 function finish(reason){if(finished)return;finished=true;clearInterval(timer);try{ws?.close();}catch{}const endedAtMs=Date.now(),duration=start===null?0:performance.now()-start;
  let r={status:reason==='runtime_complete'?'RECOVERY_RUNTIME_COLLECTED':'RECOVERY_RUNTIME_UNCONFIRMED',reason,parentRunId,invocationId,closureId,pid,createdAtMs,startedAtMs,endedAtMs,monotonicDurationMs:Math.floor(duration),requestedDurationMs:durationMs,authentications:auth,observationSamplesAccepted:0,scope:'fresh shard1 console plus account-level CPU; code bytes verified separately'};
  try{record({kind:'runtime-footer',...r});C.durable(path.join(out,'runtime-result.json'),r);}catch{r={...r,status:'RECOVERY_RUNTIME_UNCONFIRMED',reason:'RUNTIME_EVIDENCE_IO_FAILED'};}resolve(r);
 }
 try{record({kind:'runtime-start',createdAtMs});ws=new WebSocketClass('wss://screeps.com/socket/websocket');
  ws.addEventListener('open',()=>{try{ws.send('auth '+secret.token);}catch{finish('AUTH_SEND_FAILED');}});
  ws.addEventListener('message',e=>{if(finished)return;try{const text=typeof e.data==='string'?e.data:Buffer.from(e.data).toString('utf8');if(Buffer.byteLength(text)>1048576||size+Buffer.byteLength(text)>4*1048576){finish('RUNTIME_LOG_LIMIT');return;}
   if(text==='auth ok'||text.startsWith('auth ok ')){if(++auth!==1){finish('REPEATED_AUTH');return;}record({kind:'auth-confirmed'});ws.send(`subscribe user:${P.expected.userId}/console`);ws.send(`subscribe user:${P.expected.userId}/cpu`);return;}
   if(text.startsWith('auth ')){finish('AUTH_FAILED');return;}const safe=secret.redact(text);record({kind:'ws-frame',text:safe,redacted:safe!==text});size+=Buffer.byteLength(safe);if(auth!==1)return;if(safe!==text){finish('REDACTED_RUNTIME_EVIDENCE');return;}
   const k=frameKind(text),now=Date.now();if(k.kind==='bad'){finish(k.reason);return;}if(k.kind==='console')lastConsole=now;if(k.kind==='cpu'){lastCpu=now;if(start!==null&&k.cpu>0)positive=true;}if(start===null&&lastConsole!==null&&lastCpu!==null){start=performance.now();startedAtMs=now;record({kind:'runtime-ready',startedAtMs});}
  }catch{finish('RUNTIME_FRAME_OR_IO_FAILED');}});
  ws.addEventListener('error',()=>finish('SOCKET_ERROR'));ws.addEventListener('close',()=>finish('SOCKET_CLOSED'));
  timer=setInterval(()=>{if(finished)return;if(start===null){if(performance.now()-begun>=startupMs)finish('RUNTIME_STARTUP_TIMEOUT');return;}const now=Date.now(),elapsed=performance.now()-start;if(now-lastConsole>silenceMs||now-lastCpu>silenceMs){finish('RUNTIME_CHANNEL_STALE');return;}if(Math.abs(now-startedAtMs-elapsed)>2000){finish('CLOCK_DISCONTINUITY');return;}if(elapsed>=durationMs)finish(positive?'runtime_complete':'NO_POSITIVE_CPU');},pollMs);
 }catch{finish('OBSERVER_START_FAILED');}
 return result;
}
function gap(times,start,end){const sorted=times.filter(t=>t>=start&&t<=end);const a=[start,...sorted,end];let max=0;for(let i=1;i<a.length;i++)max=Math.max(max,a[i]-a[i-1]);return max;}
function verify(out,{durationMs=P.runtimeMs,silenceMs=P.runtimeSilenceMs}={}){const r=C.json(path.join(out,'runtime-result.json')),raw=C.bytes(path.join(out,'runtime-console.jsonl')).toString('utf8');if(!raw.endsWith('\n'))C.fail('TRUNCATED_RUNTIME_EVIDENCE');const e=raw.trimEnd().split('\n').map(s=>JSON.parse(s));
 if(r.status!=='RECOVERY_RUNTIME_COLLECTED'||r.reason!=='runtime_complete'||r.parentRunId!==P.parentRunId||r.requestedDurationMs!==durationMs||r.monotonicDurationMs<durationMs||r.authentications!==1||r.observationSamplesAccepted!==0||!Number.isSafeInteger(r.startedAtMs)||!Number.isSafeInteger(r.endedAtMs)||r.endedAtMs-r.startedAtMs<durationMs-1000||Math.abs(r.endedAtMs-r.startedAtMs-r.monotonicDurationMs)>2000)C.fail('RUNTIME_RESULT_INVALID');
 if(e.some((x,i)=>x.parentRunId!==r.parentRunId||x.closureId!==r.closureId||x.invocationId!==r.invocationId||x.pid!==r.pid||!Number.isSafeInteger(x.atMs)||(i&&x.atMs<e[i-1].atMs)))C.fail('RUNTIME_EVENT_IDENTITY_INVALID');
 const one=k=>{const a=e.filter(x=>x.kind===k);if(a.length!==1)C.fail('RUNTIME_EVENT_COUNT_INVALID');return a[0];};const begin=one('runtime-start'),ready=one('runtime-ready'),auth=one('auth-confirmed'),footer=one('runtime-footer');if(begin.atMs>auth.atMs||auth.atMs>ready.atMs||ready.startedAtMs!==r.startedAtMs||footer.endedAtMs!==r.endedAtMs||footer.reason!=='runtime_complete'||e.at(-1)!==footer)C.fail('RUNTIME_BOUNDARY_INVALID');
 const consoles=[],cpus=[];let positive=0;for(const x of e){if(x.kind!=='ws-frame')continue;if(x.redacted!==false)C.fail('REDACTED_RUNTIME_EVIDENCE');const k=frameKind(x.text);if(k.kind==='bad')C.fail(k.reason);if(k.kind==='console')consoles.push(x.atMs);if(k.kind==='cpu'){cpus.push(x.atMs);if(x.atMs>r.startedAtMs&&x.atMs<=r.endedAtMs&&k.cpu>0)positive++;}}
 const cg=gap(consoles,r.startedAtMs,r.endedAtMs),pg=gap(cpus,r.startedAtMs,r.endedAtMs);if(!positive||!consoles.some(t=>t>r.startedAtMs)||!cpus.some(t=>t>r.startedAtMs)||cg>silenceMs||pg>silenceMs)C.fail('RUNTIME_CHANNEL_GAP');return {status:'RECOVERY_RUNTIME_INDEPENDENTLY_VERIFIED',durationMs:r.monotonicDurationMs,consoleFrames:consoles.length,cpuFrames:cpus.length,positiveCpuFramesAfterReady:positive,maxConsoleGapMs:cg,maxCpuGapMs:pg,closureId:r.closureId};
}
module.exports={frameKind,observe,verify,gap};
