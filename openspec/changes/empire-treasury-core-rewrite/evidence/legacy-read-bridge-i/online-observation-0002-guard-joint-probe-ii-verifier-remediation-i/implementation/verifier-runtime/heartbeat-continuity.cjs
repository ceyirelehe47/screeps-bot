'use strict';

const C=require('./common.cjs');

const POLICY=Object.freeze({
  producerIntervalMs:5000,
  firstHeartbeatMaxLagMs:10000,
  lastHeartbeatMaxLeadMs:10000,
  minimumCoverageSlackMs:10000,
  ordinaryGapMaxMs:8000,
  retryExplainedGapMaxMs:15000,
  p95GapMaxMs:8000,
  retryAttemptsPerFailedCycle:3,
});

function eventTime(value){
  if(C.safeTime(value?.atMs))return value.atMs;
  if(typeof value?.at==='string'){
    const parsed=Date.parse(value.at);
    if(Number.isFinite(parsed)&&parsed>=0)return parsed;
  }
  return null;
}
function percentileNearestRank(values,p){
  if(!Array.isArray(values)||!values.length||typeof p!=='number'||p<=0||p>1)C.fail('HEARTBEAT_PERCENTILE_ARGUMENT_INVALID');
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
}
function median(values){
  if(!values.length)C.fail('HEARTBEAT_PERCENTILE_ARGUMENT_INVALID');
  const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
function classifyGaps(times){
  const gaps=[];
  for(let index=1;index<times.length;index++)gaps.push({
    index:index-1,fromAtMs:times[index-1],toAtMs:times[index],gapMs:times[index]-times[index-1],
  });
  return gaps;
}
function explainExtendedGaps(gaps,cycleFailures,attemptFailures,policy=POLICY){
  const cycles=cycleFailures.map((line,index)=>({line,index,atMs:eventTime(line)}));
  if(cycles.some(item=>!C.safeTime(item.atMs)))C.fail('PROBE_FAILURE_CYCLE_TIMELINE_INVALID');
  if(cycles.length>1&&!C.strictIncreasing(cycles.map(item=>item.atMs)))C.fail('PROBE_FAILURE_CYCLE_TIMELINE_INVALID');
  const attempts=attemptFailures.map((line,index)=>({line,index,atMs:eventTime(line)}));
  if(attempts.some(item=>!C.safeTime(item.atMs)))C.fail('PROBE_FAILURE_ATTEMPT_TIMELINE_INVALID');
  if(attempts.length>1&&!C.strictIncreasing(attempts.map(item=>item.atMs)))C.fail('PROBE_FAILURE_ATTEMPT_TIMELINE_INVALID');
  const usedCycles=new Set();
  const explained=[];
  for(const gap of gaps.filter(item=>item.gapMs>policy.ordinaryGapMaxMs)){
    if(gap.gapMs>policy.retryExplainedGapMaxMs)C.fail('PROBE_HEARTBEAT_GAP_TOO_LARGE',{
      gapMs:gap.gapMs,limitMs:policy.retryExplainedGapMaxMs,fromAtMs:gap.fromAtMs,toAtMs:gap.toAtMs,
    });
    const candidates=cycles.filter(item=>!usedCycles.has(item.index)&&item.atMs>gap.fromAtMs&&item.atMs<=gap.toAtMs);
    if(candidates.length!==1)C.fail('PROBE_HEARTBEAT_GAP_UNEXPLAINED',{
      gapMs:gap.gapMs,fromAtMs:gap.fromAtMs,toAtMs:gap.toAtMs,matchingFailureCycles:candidates.length,
    });
    const cycle=candidates[0];
    const inGap=attempts.filter(item=>item.atMs>gap.fromAtMs&&item.atMs<=cycle.atMs);
    const attemptNumbers=inGap.map(item=>item.line.attempt);
    const expected=Array.from({length:policy.retryAttemptsPerFailedCycle},(_,index)=>index+1);
    if(inGap.length!==expected.length||!C.exact(attemptNumbers,expected))C.fail('PROBE_HEARTBEAT_GAP_RETRY_EVIDENCE_INVALID',{
      gapMs:gap.gapMs,attemptNumbers,
    });
    usedCycles.add(cycle.index);
    explained.push({...gap,explainingFailureCycleAtMs:cycle.atMs,retryAttempts:attemptNumbers});
  }
  return explained;
}

function analyze({health,cycleFailures,attemptFailures,probe,session,policy=POLICY}){
  if(!Array.isArray(health)||health.length<2||!Array.isArray(cycleFailures)||!Array.isArray(attemptFailures)
    ||!C.obj(probe)||!C.obj(session))C.fail('PROBE_HEARTBEAT_TIMELINE_INVALID');
  const times=health.map(line=>line.atMs);
  if(times.some(value=>!C.safeTime(value))||!C.strictIncreasing(times))C.fail('PROBE_HEARTBEAT_TIME_ORDER_INVALID');
  if(!C.safeTime(probe.startedAtMs)||!Number.isSafeInteger(probe.durationMs)||probe.durationMs<session.durationMs)
    C.fail('PROBE_HEARTBEAT_BOUNDARY_INVALID');
  const requiredEndAtMs=probe.startedAtMs+session.durationMs;
  const reportedEndAtMs=probe.startedAtMs+probe.durationMs;
  const firstAtMs=times[0],lastAtMs=times[times.length-1];
  if(firstAtMs<probe.startedAtMs-1000||lastAtMs>reportedEndAtMs+1000)C.fail('PROBE_HEARTBEAT_BOUNDARY_INVALID',{
    firstAtMs,lastAtMs,probeStartedAtMs:probe.startedAtMs,reportedEndAtMs,
  });
  const firstLagMs=Math.max(0,firstAtMs-probe.startedAtMs);
  const lastLeadMs=Math.max(0,requiredEndAtMs-lastAtMs);
  const spanMs=lastAtMs-firstAtMs;
  if(firstLagMs>policy.firstHeartbeatMaxLagMs||lastLeadMs>policy.lastHeartbeatMaxLeadMs
    ||spanMs<session.durationMs-policy.minimumCoverageSlackMs)C.fail('PROBE_HEARTBEAT_COVERAGE_INSUFFICIENT',{
      firstLagMs,lastLeadMs,spanMs,requiredSpanMs:session.durationMs-policy.minimumCoverageSlackMs,
    });
  const gaps=classifyGaps(times);
  const p95GapMs=percentileNearestRank(gaps.map(item=>item.gapMs),0.95);
  const medianGapMs=median(gaps.map(item=>item.gapMs));
  if(p95GapMs>policy.p95GapMaxMs)C.fail('PROBE_HEARTBEAT_DISTRIBUTION_INVALID',{
    p95GapMs,limitMs:policy.p95GapMaxMs,medianGapMs,
  });
  const extendedGaps=explainExtendedGaps(gaps,cycleFailures,attemptFailures,policy);
  return {
    policy:{...policy},
    rows:health.length,
    firstAtMs,lastAtMs,firstLagMs,lastLeadMs,spanMs,
    minimumGapMs:Math.min(...gaps.map(item=>item.gapMs)),
    medianGapMs,p95GapMs,
    averageGapMs:Math.round(gaps.reduce((sum,item)=>sum+item.gapMs,0)/gaps.length),
    maximumGapMs:Math.max(...gaps.map(item=>item.gapMs)),
    extendedGapCount:extendedGaps.length,
    extendedGaps,
  };
}

module.exports={POLICY,eventTime,percentileNearestRank,median,classifyGaps,explainExtendedGaps,analyze};
