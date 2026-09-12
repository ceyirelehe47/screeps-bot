'use strict';
const fs=require('node:fs'),path=require('node:path');const F=require('./fixture.cjs'),C=require('../runtime/common.cjs');
function worldApi(root){
 const file=path.join(root,'fake-world.json'),read=()=>C.readJson(file);
 return {me:async()=>({ok:1,_id:C.EXPECTED.userId,username:C.EXPECTED.username}),branches:async()=>({ok:1,list:[{branch:'default',activeWorld:true}]}),
  time:async()=>{const w=read();return {ok:1,time:w.mode==='candidate'?Math.min(w.s.profile.endTick,w.s.profile.startTick+Math.floor((Date.now()-w.changedAtMs)/100)*100):(w.writes>=2?w.s.profile.endTick+1:w.s.observedTick)};},
  overview:async()=>({ok:1,shards:{shard1:{rooms:['E3N59','E4N58']}}}),code:async()=>({ok:1,modules:read().modules}),
  setCode:async(branch,modules)=>{const w=read();w.writes++;w.mode=F.guard.diffRemoteModules(modules,w.s.candidate.modules).match?'candidate':'backup';w.modules=modules;w.changedAtMs=Date.now();C.atomicJson(file,w);return {ok:1};}};
}
function preload(root){
 const world=C.readJson(path.join(root,'fake-world.json')),s=world.s,api=worldApi(root);
 C.ORIGINAL_DIGEST=s.backup.digest;C.loadGuard=()=>F.guard;C.loadSecret=()=>({token:'FAKE_PROCESS_TOKEN_1234567890',redact:C.redactor(['FAKE_PROCESS_TOKEN_1234567890'])});
 require('../runtime/transport.cjs').client=()=>api;
 if(world.crashRecovery&&process.argv[1]?.endsWith('recovery-worker.cjs'))require('../runtime/actions.cjs').restoreOnce=async()=>process.exit(23);
 const reports=F.allSamples(s);
 global.WebSocket=class FakeWebSocket{
  constructor(){this.callbacks={};this.subs=0;this.lastMode=null;this.nextSample=0;setImmediate(()=>this.emit('open',{}));}
  addEventListener(n,fn){(this.callbacks[n]??=[]).push(fn);}
  emit(n,x){for(const f of this.callbacks[n]||[])f(x);}
  send(x){if(x.startsWith('auth '))setImmediate(()=>this.emit('message',{data:'auth ok'}));else if(x.startsWith('subscribe ')&&++this.subs===2){this.timer=setInterval(()=>this.step(),50);this.step();}}
  step(){try{const w=C.readJson(path.join(root,'fake-world.json'));const log=[];
   if(w.mode!==this.lastMode){this.lastMode=w.mode;log.push('[deploy] '+(w.mode==='candidate'?s.build.tag:s.backupBuild.tag));}
   if(w.mode==='candidate'&&w.failCollector){this.emit('error',new Error('synthetic collector failure'));return;}
   if(w.mode==='candidate'){const index=Math.min(11,Math.floor((Date.now()-w.changedAtMs)/100));while(this.nextSample<=index)log.push(JSON.stringify(reports[this.nextSample++]));}
   this.emit('message',{data:JSON.stringify([`user:${s.userId}/console`,{shard:s.shard,messages:{log,results:[]}}])});
   this.emit('message',{data:JSON.stringify([`user:${s.userId}/cpu`,{cpu:50}])});
  }catch(e){this.emit('error',e);}}
  close(){clearInterval(this.timer);}
 };
}
if(process.env.FORMAL_0003_FIXTURE_ROOT)preload(process.env.FORMAL_0003_FIXTURE_ROOT);
module.exports={worldApi,preload};
