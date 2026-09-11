#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const path=require('node:path');
const C=require('./common.cjs');const {client}=require('./transport.cjs');const P=require('./protocol.cjs');const {loadSession}=require('./session.cjs');const {createWatch}=require('./watch.cjs');
async function main(argv) {
  const o=C.options(argv,['repo','secret','run']);C.required(o,'repo','secret','run');
  const secret=C.loadSecret(o.secret),s=loadSession(o.run,C.loadGuard(o.repo));
  P.account(await client(secret).me());
  if(typeof WebSocket!=='function')C.fail('NODE_22_WEBSOCKET_REQUIRED');
  const hb=path.join(o.run,'heartbeat.json'),raw=path.join(o.run,'console.jsonl');
  const lock=path.join(o.run,'collector.lock');C.writeNew(lock,{runId:s.runId,pid:process.pid});
  const watch=createWatch(s,process.pid);let bytes=0,closed=false,ws,timer,life,opened=Date.now();
  const save=()=>C.atomicJson(hb,{...watch.state,updatedAtMs:Date.now()});
  function finish(reason,code=1){
    if(closed)return;closed=true;clearInterval(timer);clearTimeout(life);
    watch.state.state='closed';watch.state.stopReason=reason;
    try{save();C.audit(raw,{kind:'collector-footer',reason,totalLoggedBytes:bytes},secret.redact);}catch{code=1;}
    try{if(ws)ws.close();}catch{}
    try{fs.unlinkSync(lock);}catch{}
    process.exitCode=code;
    // Own process only. Do not wait forever for a WebSocket close handshake.
    setTimeout(()=>process.exit(code),300).unref();
  }
  try {
    save();ws=new WebSocket('wss://screeps.com/socket/websocket');
    ws.addEventListener('open',()=>ws.send('auth '+secret.token));
    ws.addEventListener('message',ev=>{
      try {
        const text=typeof ev.data==='string'?ev.data:Buffer.from(ev.data).toString('utf8');
        const n=Buffer.byteLength(text);if(n>1024*1024||bytes+n>64*1024*1024){finish('collector_size_bound');return;}
        const kind=watch.frame(text);
        // Never retain auth replies: some server versions echo rotated credentials.
        if(kind==='auth'){C.audit(raw,{kind:'auth-confirmed'},secret.redact);ws.send(`subscribe user:${s.userId}/console`);ws.send(`subscribe user:${s.userId}/cpu`);}
        else {
          const sanitized=secret.redact(text);
          const line=JSON.stringify({kind:'ws-frame',runId:s.runId,receivedAt:new Date().toISOString(),
            bytes:n,redacted:sanitized!==text,text:sanitized})+'\n';
          fs.appendFileSync(raw,line,{mode:0o600});bytes+=Buffer.byteLength(line);
          if(kind==='auth-failure')finish('authentication_failed');
        }
        if(!closed)save();
      }catch{finish('collector_parse_or_io_failure');}
    });
    ws.addEventListener('error',()=>finish('socket_error'));
    ws.addEventListener('close',()=>finish('socket_closed'));
    timer=setInterval(()=>{
      try {
        if(watch.state.state!=='streaming'&&Date.now()-opened>15000){finish('authentication_timeout');return;}
        if(watch.state.stopReason){finish(watch.state.stopReason);return;}
        if(fs.existsSync(path.join(o.run,'guard-result.json'))){
          const end=C.readJson(path.join(o.run,'guard-result.json'),16384);
          if(end.runId!==s.runId){finish('foreign_guard_result');return;}
          finish('guard_finished',end.status==='ONLINE_BYTES_RESTORED'?0:1);return;
        }
        save();
      }catch{finish('heartbeat_io_failure');}
    },1000);
    life=setTimeout(()=>finish('collector_lifetime_ended',0),105*60*1000);
    process.once('SIGTERM',()=>finish('operator_stop',0));process.once('SIGINT',()=>finish('operator_stop',0));
  }catch{finish('collector_start_failed');}
}
module.exports={main};if(require.main===module)C.entrypoint(()=>main(process.argv.slice(2)));
