'use strict';
const C=require('./common.cjs'),K=require('./policy.cjs'),P=require('./protocol.cjs'),L=require('./live-baseline.cjs');
const TERMINAL=new Set(['ACCOUNT_MISMATCH_OR_UNREADABLE','ACTIVE_WORLD_CHANGED','ACTIVE_WORLD_NOT_UNIQUE','BRANCH_RESPONSE_INVALID','HTTP_AUTH_REJECTED','MODULES_NOT_OBJECT','MODULES_FIELD_MISSING','MODULE_VALUE_INVALID','MODULES_EMPTY_OR_MAIN_MISSING','BUILD_IDENTITY_NOT_UNIQUE','ROOM_OVERVIEW_UNREADABLE','OBSERVATION_ROOM_NOT_OWNED','LIVE_BASELINE_DRIFT_UNRESOLVED','LIVE_BASELINE_BUILD_IDENTITY_CHANGED','LIVE_MODULE_SET_UNEXPECTED','GAME_TICK_REGRESSED','GAME_TICK_UNREADABLE']);
function safeSample(x,tick,rooms,streak){return{capturedAtMs:x.capturedAtMs,tick,rooms:[...rooms],digest:L.safeDigest(x.digest),build:C.clone(x.build),streak};}
async function establish({guard,readIdentity,readOverview,readTime,record=()=>{},pause=C.pause,mono=()=>require('node:perf_hooks').performance.now(),now=Date.now,wallMs=K.READINESS_WALL_MS,stableReads=K.READINESS_STABLE_READS,intervalMs=K.READINESS_INTERVAL_MS}){
 if(typeof readIdentity!=='function'||typeof readOverview!=='function'||typeof readTime!=='function'||typeof record!=='function'||typeof pause!=='function'||typeof mono!=='function'||typeof now!=='function')C.fail('READINESS_ARGUMENT_INVALID');
 const begun=mono(),deadline=begun+wallMs;let streak=[],attempt=0,lastTick=null,lastFailure=null;
 const remaining=()=>Math.max(0,Math.floor(deadline-mono()));
 while(remaining()>0){attempt++;try{
   let budget=remaining();if(budget<100)break;const identity=await readIdentity(attempt,budget);
   budget=remaining();if(budget<100)break;const rooms=P.ownedRooms(await readOverview(attempt,budget));if(K.ROOMS.some(r=>!rooms.includes(r)))C.fail('OBSERVATION_ROOM_NOT_OWNED');
   budget=remaining();if(budget<100)break;const tr=await readTime(attempt,budget),tick=tr?.ok===1&&Number.isSafeInteger(tr.time)?tr.time:null;if(tick===null)C.fail('GAME_TICK_UNREADABLE');if(lastTick!==null&&tick<lastTick)C.fail('GAME_TICK_REGRESSED');lastTick=tick;
   if(!streak.length||!L.sameRead(streak.at(-1).identity,identity,guard))streak=[];
   streak.push({identity,tick,rooms,atMs:now()});if(streak.length>stableReads)streak=streak.slice(-stableReads);
   record({kind:'readiness-round',attempt,outcome:'success',...safeSample(identity,tick,rooms,streak.length),elapsedMs:Math.floor(mono()-begun)});
   if(streak.length===stableReads){let authorization;try{authorization=L.authorize(streak.map(x=>x.identity),guard,stableReads);}catch(e){e.readinessIdentity=streak.at(-1).identity;e.readinessSamples=streak.map(x=>safeSample(x.identity,x.tick,x.rooms,streak.length));record({kind:'readiness-terminal',attempt,outcome:'blocked',error:C.code(e),details:e.details||null,elapsedMs:Math.floor(mono()-begun)});throw e;}
    return{status:'ONLINE_READINESS_VERIFIED',authorization,baseline:streak.at(-1).identity,lastTick:tick,rooms:[...rooms],stableReads:streak.map(x=>safeSample(x.identity,x.tick,x.rooms,streak.length)),attempts:attempt,elapsedMs:Math.floor(mono()-begun),verifiedAtMs:now()};}
   lastFailure=null;
  }catch(e){lastFailure=C.code(e);if(TERMINAL.has(lastFailure))throw e;streak=[];record({kind:'readiness-round',attempt,outcome:'transient_failure',error:lastFailure,elapsedMs:Math.floor(mono()-begun)});}
  const left=remaining();if(left<=0)break;await pause(Math.min(intervalMs,Math.max(1,left)));
 }
 C.fail('ONLINE_READINESS_DEADLINE',{attempts:attempt,lastFailure,elapsedMs:Math.floor(mono()-begun)});
}
module.exports={TERMINAL,safeSample,establish};
