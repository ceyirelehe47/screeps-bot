'use strict';
const C=require('./common.cjs');
const REFACTOR='33cfbd4e2192d65723cf3d9d85ae8cae8e8a06c0';
const COMPAT='ae15ec55b0363933d31c93acc2480b6adbea306a';
const CONFIG='src/runtime/treasuryCompatConfig.ts';
const ROOMS=Object.freeze(['E3N59','E4N58']),RESOURCES=Object.freeze(['energy','H']);
const COUNT=4,INTERVAL=100,LEAD_TICKS=150,WALL_MS=2700000,CONFIRM_MS=75000;
const EVIDENCE='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-cpu-recheck-iv';
const KIND='compat-cpu-recheck-IV/v1',PUBLIC_KIND='compat-cpu-recheck-IV-public/v1';
function profileFor(tick){C.integer(tick,0,Number.MAX_SAFE_INTEGER-2000,'GAME_TICK_UNREADABLE');
 const startTick=Math.ceil((tick+LEAD_TICKS)/INTERVAL)*INTERVAL;
 return {enabled:true,shardName:'shard1',rooms:[...ROOMS],resources:[...RESOURCES],startTick,endTick:startTick+(COUNT-1)*INTERVAL,
  intervalTicks:INTERVAL,minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384};}
function validProfile(p){
 if(!p||p.enabled!==true||p.shardName!=='shard1'||!C.same(p.rooms,ROOMS)||!C.same(p.resources,RESOURCES)
 ||!Number.isSafeInteger(p.startTick)||p.startTick<0||p.startTick%INTERVAL||p.endTick!==p.startTick+(COUNT-1)*INTERVAL
 ||p.intervalTicks!==INTERVAL||p.minBucket!==2000||p.maxSampleCpu!==2||p.reserveCpu!==5||p.maxLogBytes!==16384)C.fail('CPU_DIAGNOSTIC_PROFILE_INVALID');return p;}
function renderConfig(p){validProfile(p);return 'import type { CompatConfig } from "./treasuryCompatTypes";\n'+
 '/** CPU Recheck IV: four fixed points. Budget unchanged; not a production rollout. */\n'+
 'export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({\n'+
 `  enabled: true,\n  shardName: "shard1",\n  rooms: Object.freeze(["E3N59", "E4N58"]),\n  resources: Object.freeze(["energy", "H"]),\n  startTick: ${p.startTick},\n  endTick: ${p.endTick},\n  intervalTicks: 100,\n  minBucket: 2000,\n  maxSampleCpu: 2,\n  reserveCpu: 5,\n  maxLogBytes: 16384,\n});\n`;}
const dueTicks=p=>{validProfile(p);return Array.from({length:COUNT},(_,i)=>p.startTick+i*INTERVAL);};
module.exports={REFACTOR,COMPAT,CONFIG,ROOMS,RESOURCES,COUNT,INTERVAL,LEAD_TICKS,WALL_MS,CONFIRM_MS,EVIDENCE,KIND,PUBLIC_KIND,
 profileFor,validProfile,renderConfig,dueTicks,runtimeMs:CONFIRM_MS,runtimeStartupMs:15000,channelSilenceMs:45000,
 // This is a post-factum external abort threshold, NOT a new sampler allowance.
 MAX_DIAGNOSTIC_OBSERVED_COST:5};
