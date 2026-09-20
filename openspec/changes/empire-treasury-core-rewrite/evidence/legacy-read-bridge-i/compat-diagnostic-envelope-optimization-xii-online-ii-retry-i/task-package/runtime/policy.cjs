'use strict';
const C=require('./common.cjs');
const REFACTOR='4f0cbf7a2a991665d6089841eeb10954e834ddbf';
const COMPAT='982ac514d06428ffd5cea1a38add774438d7bb6e';
const SOURCE_TREE='dcec716dfad41cb95e07bbed5988f1d5fde5c531';
const CONFIG='src/runtime/treasuryCompatConfig.ts';
const ROOMS=Object.freeze(['E3N59','E4N58']),RESOURCES=Object.freeze(['energy','H']);
const COUNT=4,INTERVAL=100,LEAD_TICKS=150,WALL_MS=2700000,CONFIRM_MS=75000;
const READINESS_WALL_MS=1800000,READINESS_STABLE_READS=3,READINESS_INTERVAL_MS=15000;
const READINESS_OPERATION_MS=45000,READINESS_RETRY_PAUSE_MS=5000;
const EVIDENCE='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-diagnostic-envelope-optimization-xii-online-ii-retry-i';
const KIND='compat-diagnostic-envelope-XII-online-II-retry-I/v1';
const PUBLIC_KIND='compat-diagnostic-envelope-XII-online-II-retry-I-public/v1';
function profileFor(tick){C.integer(tick,0,Number.MAX_SAFE_INTEGER-2000,'GAME_TICK_UNREADABLE');
 const startTick=Math.ceil((tick+LEAD_TICKS)/INTERVAL)*INTERVAL;
 return {enabled:true,shardName:'shard1',rooms:[...ROOMS],resources:[...RESOURCES],startTick,endTick:startTick+(COUNT-1)*INTERVAL,
  intervalTicks:INTERVAL,minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384};}
function validProfile(p){
 if(!p||p.enabled!==true||p.shardName!=='shard1'||!C.same(p.rooms,ROOMS)||!C.same(p.resources,RESOURCES)
 ||!Number.isSafeInteger(p.startTick)||p.startTick<0||p.startTick%INTERVAL||p.endTick!==p.startTick+(COUNT-1)*INTERVAL
 ||p.intervalTicks!==INTERVAL||p.minBucket!==2000||p.maxSampleCpu!==2||p.reserveCpu!==5||p.maxLogBytes!==16384)C.fail('CPU_DIAGNOSTIC_PROFILE_INVALID');return p;}
function renderConfig(p){validProfile(p);return 'import type { CompatConfig } from "./treasuryCompatTypes";\n'+
 '/** Diagnostic Envelope XII Online II Retry I: four fixed points. Budget unchanged. */\n'+
 'export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({\n'+
 `  enabled: true,\n  shardName: "shard1",\n  rooms: Object.freeze(["E3N59", "E4N58"]),\n  resources: Object.freeze(["energy", "H"]),\n  startTick: ${p.startTick},\n  endTick: ${p.endTick},\n  intervalTicks: 100,\n  minBucket: 2000,\n  maxSampleCpu: 2,\n  reserveCpu: 5,\n  maxLogBytes: 16384,\n});\n`;}
const dueTicks=p=>{validProfile(p);return Array.from({length:COUNT},(_,i)=>p.startTick+i*INTERVAL);};
module.exports={REFACTOR,COMPAT,SOURCE_TREE,CONFIG,ROOMS,RESOURCES,COUNT,INTERVAL,LEAD_TICKS,WALL_MS,CONFIRM_MS,EVIDENCE,KIND,PUBLIC_KIND,
 READINESS_WALL_MS,READINESS_STABLE_READS,READINESS_INTERVAL_MS,READINESS_OPERATION_MS,READINESS_RETRY_PAUSE_MS,
 profileFor,validProfile,renderConfig,dueTicks,runtimeMs:CONFIRM_MS,runtimeStartupMs:15000,channelSilenceMs:45000,
 MAX_DIAGNOSTIC_OBSERVED_COST:5};
