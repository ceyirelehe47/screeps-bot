'use strict';
const obj=x=>typeof x==='object'&&x!==null&&!Array.isArray(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const TAIL_PHASES=Object.freeze(['serializationAndSize','emit','retention']);
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const equal=(a,b)=>Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
function sum(o){return Object.values(o||{}).reduce((n,x)=>n+x,0);}
function validateTailShape(tail,tick,ordinal){
 if(!tail||tail.version!==1||tail.tick!==tick||tail.sampleOrdinal!==ordinal||tail.boundary!=='afterRetention'||tail.completion!=='tail_only'
 ||!finite(tail.elapsed)||!Number.isSafeInteger(tail.checkpoints)||tail.checkpoints<1||tail.checkpoints>100||!obj(tail.phases)||!obj(tail.calls))return 'CPU_TAIL_IDENTITY_INVALID';
 const keys=Object.keys(tail.phases);if(keys.some(k=>!TAIL_PHASES.includes(k)||!finite(tail.phases[k]))||tail.attribution!==undefined)return 'CPU_TAIL_SHAPE_INVALID';
 return null;
}
function mergeCompletion(prefix,tail){
 const shape=validateTailShape(tail,prefix?.tick,prefix?.sampleOrdinal);if(shape){const e=new Error(shape);e.code=shape;throw e;}
 if(!prefix||prefix.version!==1||prefix.boundary!=='beforeSerialization'||!obj(prefix.phases)||!obj(prefix.calls)){
  const e=new Error('CPU_PREFIX_IDENTITY_INVALID');e.code='CPU_PREFIX_IDENTITY_INVALID';throw e;}
 if(!same(tail.calls,prefix.calls)||tail.checkpoints<prefix.checkpoints||tail.elapsed+1e-7<prefix.elapsed){const e=new Error('CPU_TAIL_NOT_AN_EXTENSION');e.code='CPU_TAIL_NOT_AN_EXTENSION';throw e;}
 const phases={...prefix.phases,...tail.phases};if(!equal(sum(phases),tail.elapsed)){const e=new Error('CPU_COMPLETION_PHASE_SUM_INVALID');e.code='CPU_COMPLETION_PHASE_SUM_INVALID';throw e;}
 return Object.freeze({version:1,tick:prefix.tick,sampleOrdinal:prefix.sampleOrdinal,boundary:'afterRetention',elapsed:tail.elapsed,
  checkpoints:tail.checkpoints,calls:Object.freeze({...prefix.calls}),phases:Object.freeze(phases),
  ...(prefix.attribution?{attribution:prefix.attribution}:{})});
}
module.exports={TAIL_PHASES,finite,equal,sum,validateTailShape,mergeCompletion};
