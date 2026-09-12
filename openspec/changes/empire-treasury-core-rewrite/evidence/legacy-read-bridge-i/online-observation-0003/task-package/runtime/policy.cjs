'use strict';
const C=require('./common.cjs');
const REFACTOR='ee03fb4a871b1a707a4244d2f3a7819e5982324d';
const COMPAT='fcfc125f0e5cd6c3370318b4fee0450f4d09af53';
const CONFIG='src/runtime/treasuryCompatConfig.ts';
const ROOMS=Object.freeze(['E3N59','E4N58']),RESOURCES=Object.freeze(['energy','H']);
const WALL_MS=5400000, CONFIRM_MS=75000, LEAD_TICKS=150;
const EVIDENCE='openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/online-observation-0003';
function profileFor(tick){
 C.integer(tick,0,Number.MAX_SAFE_INTEGER-2000,'GAME_TICK_UNREADABLE');
 const startTick=Math.ceil((tick+LEAD_TICKS)/100)*100;
 return {enabled:true,shardName:'shard1',rooms:[...ROOMS],resources:[...RESOURCES],startTick,endTick:startTick+1100,
  intervalTicks:100,minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384};
}
function validProfile(p){
 if(!p||p.enabled!==true||p.shardName!=='shard1'||JSON.stringify(p.rooms)!==JSON.stringify(ROOMS)
  ||JSON.stringify(p.resources)!==JSON.stringify(RESOURCES)||!Number.isSafeInteger(p.startTick)||p.startTick<0||p.startTick%100
  ||p.endTick!==p.startTick+1100||p.intervalTicks!==100||p.minBucket!==2000||p.maxSampleCpu!==2||p.reserveCpu!==5||p.maxLogBytes!==16384)C.fail('FORMAL_PROFILE_INVALID');
 return p;
}
function renderConfig(p){validProfile(p);return 'import type { CompatConfig } from "./treasuryCompatTypes";\n'+
 '/** Observation 0003: one frozen absolute window; no Memory or environment override. */\n'+
 'export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({\n'+
 `  enabled: true,\n  shardName: "shard1",\n  rooms: Object.freeze(["E3N59", "E4N58"]),\n  resources: Object.freeze(["energy", "H"]),\n  startTick: ${p.startTick},\n  endTick: ${p.endTick},\n  intervalTicks: 100,\n  minBucket: 2000,\n  maxSampleCpu: 2,\n  reserveCpu: 5,\n  maxLogBytes: 16384,\n});\n`;
}
const dueTicks=p=>{validProfile(p);return Array.from({length:12},(_,i)=>p.startTick+i*100);};
module.exports={REFACTOR,COMPAT,CONFIG,ROOMS,RESOURCES,WALL_MS,CONFIRM_MS,LEAD_TICKS,EVIDENCE,profileFor,validProfile,renderConfig,dueTicks};
