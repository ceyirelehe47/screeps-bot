'use strict';
const fs=require('node:fs');const C=require('./common.cjs'),S=require('./store.cjs'),P=require('./protocol.cjs');
const {client}=require('./transport.cjs'),W=require('./samples.cjs'),D=require('./collector-diagnostics.cjs');
async function collect({s,run,secret,api,WebSocketClass=global.WebSocket,maxLifeMs=5700000}){
 P.account(await api.me(8000));if(typeof WebSocketClass!=='function')C.fail('NODE22_WEBSOCKET_REQUIRED');
 S.newRecord(run,'collector.lock',{runId:s.runId,pid:process.pid});
 const watch=W.createWatch(s,process.pid),out=S.file(run,'console.jsonl');let closed=false,timer,life,ws,bytes=0,resolve;
 const done=new Promise(r=>resolve=r),opened=Date.now();
 const save=()=>C.atomicJson(S.file(run,'heartbeat.json'),watch.state);
 function finish(reason,code){
  if(closed)return;closed=true;clearInterval(timer);clearTimeout(life);let lockRemoved=false,footerWritten=false;
  watch.state.state=code===0?'closed':'failed';watch.state.socketState='closed';watch.state.stopReason=reason;watch.state.updatedAtMs=Date.now();
  try{save();fs.unlinkSync(S.file(run,'collector.lock'));lockRemoved=true;}catch{code=1;}
  try{ws?.close();}catch{}
  try{C.audit(out,{kind:'collector-footer',runId:s.runId,pid:process.pid,reason,exitCode:code},secret.redact);footerWritten=true;}catch{code=1;}
  const result={kind:'collector-result-v3',runId:s.runId,pid:process.pid,status:code===0?'closed':'failed',reason,exitCode:code,closedAtMs:Date.now(),footerWritten,lockRemoved};
  try{S.newRecord(run,'collector-result.json',result);}catch{code=1;}
  process.exitCode=code;resolve(result);
 }
 const fatal=e=>{try{C.audit(S.file(run,'collector-diagnostics.jsonl'),D.safeError(e,secret.redact),secret.redact);}catch{}finish('COLLECTOR_IO_OR_PARSE_FAILURE',1);};
 const stop=()=>finish('OPERATOR_STOP',1);
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  save();ws=new WebSocketClass('wss://screeps.com/socket/websocket');
  ws.addEventListener('open',()=>{try{watch.state.socketState='open';watch.state.updatedAtMs=Date.now();save();ws.send('auth '+secret.token);}catch(e){fatal(e);}});
  ws.addEventListener('message',ev=>{try{
   const text=typeof ev.data==='string'?ev.data:Buffer.from(ev.data).toString('utf8');
   if(Buffer.byteLength(text)>1048576||bytes>64*1048576){finish('COLLECTOR_SIZE_LIMIT',1);return;}
   const kind=watch.frame(text);
   if(kind==='auth'){
    C.audit(out,{kind:'auth-confirmed',runId:s.runId,pid:process.pid},secret.redact);
    ws.send(`subscribe user:${s.userId}/console`);ws.send(`subscribe user:${s.userId}/cpu`);
   }else if(kind==='auth-failure'){finish('AUTHENTICATION_FAILED',1);return;}
   else{
    const safe=secret.redact(text),line=JSON.stringify({kind:'ws-frame',runId:s.runId,receivedAt:new Date().toISOString(),redacted:safe!==text,text:safe})+'\n';
    fs.appendFileSync(out,line,{mode:0o600});bytes+=Buffer.byteLength(line);
   }
   save();if(watch.state.stopReason)finish(watch.state.stopReason,1);
  }catch(e){fatal(e);}});
  ws.addEventListener('close',ev=>{if(!closed){try{C.audit(S.file(run,'collector-diagnostics.jsonl'),{kind:'socket-close',...D.safeClose(ev,secret.redact)},secret.redact);}catch{}finish('SOCKET_CLOSED',1);}});
  ws.addEventListener('error',ev=>{if(!closed)fatal(ev);});
  timer=setInterval(()=>{try{
   if(watch.state.state!=='streaming'&&Date.now()-opened>15000){finish('AUTHENTICATION_TIMEOUT',1);return;}
   const stopRecord=S.optional(run,'collector-stop.json');
   if(stopRecord){if(stopRecord.runId!==s.runId||!['observation_closed','no_upload'].includes(stopRecord.reason))finish('INVALID_STOP_REQUEST',1);else finish(stopRecord.reason,0);return;}
   watch.state.updatedAtMs=Date.now();save();
  }catch(e){fatal(e);}},500);
  life=setTimeout(()=>finish('COLLECTOR_LIFETIME',1),maxLifeMs);
 }catch(e){fatal(e);}
 const result=await done;process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);return result;
}
async function main(){const o=C.options(process.argv.slice(2),['repo','run','secret']);C.required(o,'repo','run','secret');
 const secret=C.loadSecret(o.secret),s=S.loadRun(o.run,C.loadGuard(o.repo));await collect({s,run:o.run,secret,api:client(secret)});
 // Close-handshake stalls may not retain the process indefinitely.
 setTimeout(()=>process.exit(process.exitCode||0),500).unref();
}
module.exports={collect};if(require.main===module)C.entrypoint(main);
