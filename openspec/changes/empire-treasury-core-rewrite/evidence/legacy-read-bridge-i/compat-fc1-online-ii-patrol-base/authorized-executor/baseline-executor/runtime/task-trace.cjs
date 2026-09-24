'use strict';
const C=require('./common.cjs');
const MARKS=Object.freeze(['tasksStart','firstPendingStart','firstPendingEnd','tasksEnd']);
const SEGMENTS=Object.freeze(['beforeFirstValidPending','firstPendingProcessing','remainingTable']);
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const near=(a,b)=>Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
const nn=x=>Number.isSafeInteger(x)&&x>=0;
const sameKeys=(o,keys)=>C.obj(o)&&C.same(Object.keys(o).sort(),[...keys].sort());
function need(v,c){if(!v)C.fail(c);}
function taskTrace(p){
 const e=p?.taskEnvelope,m=e?.marks;
 need(e?.version===1&&C.obj(m)&&['not_called','no_pending','complete','incomplete'].includes(e.status),'TASK_TRACE_IDENTITY');
 need(Object.keys(m).every(k=>MARKS.includes(k)&&finite(m[k])&&m[k]<=p.elapsed+1e-7),'TASK_TRACE_MARK_INVALID');
 let last=-1;for(const k of MARKS)if(Object.hasOwn(m,k)){need(m[k]>=last,'TASK_TRACE_ORDER');last=m[k];}
 if(p.calls?.commitmentBuild===0){need(e.status==='not_called'&&sameKeys(m,[])&&e.firstPendingOrdinal===null,'TASK_TRACE_WITHOUT_CALL');return {status:'not_called',firstPendingOrdinal:null,taskInterval:null};}
 const w=p.attribution?.work,outer=p.commitmentEnvelope?.marks;
 need(p.calls?.commitmentBuild===1&&nn(w?.commitmentTaskRecords)&&nn(w?.commitmentPendingTaskRecords)&&w.commitmentPendingTaskRecords<=w.commitmentTaskRecords,'TASK_TRACE_WORK_INVALID');
 need(finite(m.tasksStart)&&finite(m.tasksEnd)&&finite(p.attribution?.intervals?.commitmentTasks)&&near(m.tasksEnd-m.tasksStart,p.attribution.intervals.commitmentTasks),'TASK_TRACE_PARENT_SUM');
 need(finite(outer?.bodyStart)&&finite(outer?.bodyEnd)&&m.tasksStart>=outer.bodyStart&&m.tasksEnd<=outer.bodyEnd,'TASK_TRACE_OUTSIDE_BODY');
 if(e.status==='no_pending'){need(sameKeys(m,['tasksStart','tasksEnd'])&&e.firstPendingOrdinal===null&&w.commitmentPendingTaskRecords===0,'TASK_TRACE_FALSE_NO_PENDING');return {status:'no_pending',firstPendingOrdinal:null,taskInterval:m.tasksEnd-m.tasksStart};}
 need(e.status==='complete'&&sameKeys(m,MARKS)&&Number.isSafeInteger(e.firstPendingOrdinal)&&e.firstPendingOrdinal>=1&&e.firstPendingOrdinal<=w.commitmentTaskRecords&&w.commitmentPendingTaskRecords>0,'TASK_TRACE_INCOMPLETE');
 const segments={};for(let i=0;i<3;i++)segments[SEGMENTS[i]]=m[MARKS[i+1]]-m[MARKS[i]];
 const taskInterval=m.tasksEnd-m.tasksStart;
 need(near(Object.values(segments).reduce((a,b)=>a+b,0),taskInterval),'TASK_TRACE_PARTITION_SUM');
 return {status:'complete',firstPendingOrdinal:e.firstPendingOrdinal,segments,taskInterval,
  interpretation:'first valid pending record region only; before includes enumeration/validation and earlier records; remaining includes every later record. Not a function/JIT/GC causal verdict.'};
}
module.exports={MARKS,SEGMENTS,taskTrace};
