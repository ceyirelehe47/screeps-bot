'use strict';
const C=require('./common.cjs');
const REFACTOR='bb1aa9900bfe6505ff6ef871ead0a0c61e7b1f1f';
const COMPAT='43b1b8e51caca0c17b975971a71fbbb0951823bf';
const CONFIG='src/runtime/treasuryCompatConfig.ts';
const ROOMS=Object.freeze(['E3N59','E4N58']),RESOURCES=Object.freeze(['energy','H']);
const COUNT=4,INTERVAL=100,LEAD_TICKS=150,WALL_MS=2700000,CONFIRM_MS=75000;
const EVIDENCE='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-cpu-diagnostic-ii';
const KIND='compat-cpu-diagnostic-II/v1',PUBLIC_KIND='compat-cpu-diagnostic-II-public/v1';
function profileFor(tick){C.integer(tick,0,Number.MAX_SAFE_INTEGER-2000,'GAME_TICK_UNREADABLE');
 const startTick=Math.ceil((tick+LEAD_TICKS)/INTERVAL)*INTERVAL;
 return {enabled:true,shardName:'shard1',rooms:[...ROOMS],resources:[...RESOURCES],startTick,endTick:startTick+(COUNT-1)*INTERVAL,
  intervalTicks:INTERVAL,minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384};}
function validProfile(p){
 if(!p||p.enabled!==true||p.shardName!=='shard1'||!C.same(p.rooms,ROOMS)||!C.same(p.resources,RESOURCES)
 ||!Number.isSafeInteger(p.startTick)||p.startTick<0||p.startTick%INTERVAL||p.endTick!==p.startTick+(COUNT-1)*INTERVAL
 ||p.intervalTicks!==INTERVAL||p.minBucket!==2000||p.maxSampleCpu!==2||p.reserveCpu!==5||p.maxLogBytes!==16384)C.fail('CPU_DIAGNOSTIC_PROFILE_INVALID');return p;}
function renderConfig(p){validProfile(p);return 'import type { CompatConfig } from "./treasuryCompatTypes";\n'+
 '/** CPU Diagnostic II: four fixed points. Budget unchanged; not a production rollout. */\n'+
 'export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({\n'+
 `  enabled: true,\n  shardName: "shard1",\n  rooms: Object.freeze(["E3N59", "E4N58"]),\n  resources: Object.freeze(["energy", "H"]),\n  startTick: ${p.startTick},\n  endTick: ${p.endTick},\n  intervalTicks: 100,\n  minBucket: 2000,\n  maxSampleCpu: 2,\n  reserveCpu: 5,\n  maxLogBytes: 16384,\n});\n`;}
const dueTicks=p=>{validProfile(p);return Array.from({length:COUNT},(_,i)=>p.startTick+i*INTERVAL);};
module.exports={REFACTOR,COMPAT,CONFIG,ROOMS,RESOURCES,COUNT,INTERVAL,LEAD_TICKS,WALL_MS,CONFIRM_MS,EVIDENCE,KIND,PUBLIC_KIND,
 profileFor,validProfile,renderConfig,dueTicks,runtimeMs:CONFIRM_MS,runtimeStartupMs:15000,channelSilenceMs:45000,
 // This is a post-factum external abort threshold, NOT a new sampler allowance.
 MAX_DIAGNOSTIC_OBSERVED_COST:5};
