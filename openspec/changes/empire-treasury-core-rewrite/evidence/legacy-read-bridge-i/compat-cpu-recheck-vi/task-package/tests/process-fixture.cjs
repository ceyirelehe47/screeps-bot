'use strict';
const path=require('node:path'),fs=require('node:fs');const F=require('./fixture.cjs'),C=require('../runtime/common.cjs');
function apiWorld(root){const file=path.join(root,'fake-world.json'),read=()=>C.readJson(file);return {
 me:async()=>({ok:1,_id:C.EXPECTED.userId,username:C.EXPECTED.username}),branches:async()=>({ok:1,list:[{branch:'default',activeWorld:true}]}),
 code:async()=>({ok:1,modules:read().modules}),overview:async()=>({ok:1,shards:{shard1:{rooms:['E3N59','E4N58']}}}),
 time:async()=>{const w=read();return {ok:1,time:w.mode==='candidate'?w.s.profile.startTick:w.s.observedTick};},
 setCode:async(branch,modules)=>{const w=read();w.writes++;w.mode=F.guard.diffRemoteModules(modules,w.s.candidate.modules).match?'candidate':'backup';w.modules=modules;w.changedAtMs=Date.now();C.atomicJson(file,w);if(w.lostRestoreReply&&w.writes===2)C.fail('HTTP_DEADLINE');return {ok:1};}};}
function preload(root){const w=C.readJson(path.join(root,'fake-world.json')),s=w.s;C.ORIGINAL_DIGEST=s.backup.digest;C.loadGuard=()=>F.guard;C.loadSecret=()=>({...F.secret});
 const K=require('../runtime/policy.cjs');K.runtimeMs=300;K.CONFIRM_MS=300;
 require('../runtime/transport.cjs').client=()=>apiWorld(root);
 if(w.crashGuard&&process.argv[1]?.endsWith('recovery-worker.cjs'))require('../runtime/actions.cjs').restoreOnce=async()=>process.exit(23);
 global.WebSocket=class FakeWebSocket{
  constructor(){this.handlers={};this.subs=0;this.lastMode=null;this.next=0;setImmediate(()=>this.emit('open',{}));}
  addEventListener(k,f){(this.handlers[k]??=[]).push(f);}
  emit(k,v){for(const f of this.handlers[k]||[])f(v);}
  send(text){if(text.startsWith('auth '))setImmediate(()=>this.emit('message',{data:'auth ok'}));else if(text.startsWith('subscribe ')&&++this.subs===2){this.timer=setInterval(()=>this.step(),50);this.step();}}
  step(){try{const w=C.readJson(path.join(root,'fake-world.json')),logs=[];
   if(w.mode==='candidate'&&w.failCollector){this.emit('error',{});return;}
   if(this.lastMode!==w.mode){this.lastMode=w.mode;logs.push('[deploy] '+(w.mode==='candidate'?s.build.tag:s.backupBuild.tag));}
   if(w.mode==='candidate'){
    const index=Math.min(3,Math.floor((Date.now()-w.changedAtMs)/100));
    while(this.next<=index){const report=w.reports[this.next++];logs.push(w.corruptReport?'{&#x22;kind&#x22;:&#x22;treasury-legacy-read-bridge&#x22;,INVALID}':JSON.stringify(report).replaceAll('"','&#x22;'));}
   }
   this.emit('message',{data:F.frame(s,logs)});this.emit('message',{data:JSON.stringify([`user:${s.userId}/cpu`,{cpu:50}])});
  }catch{this.emit('error',{});}}
  close(){clearInterval(this.timer);}
 };
}
if(process.env.CPU_DIAG_FIXTURE_ROOT)preload(process.env.CPU_DIAG_FIXTURE_ROOT);
module.exports={apiWorld,preload};
