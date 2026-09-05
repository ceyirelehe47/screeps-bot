// Core Rewrite II §6.4 最坏体积推导（与 src 常量一致性断言的依据）。
const maxStr = (n) => "x".repeat(n);
const worstRecord = {
  workKey: maxStr(128), attemptId: "tk1_9999999999_" + maxStr(16), generation: 1,
  parentAttemptId: "tk1_9999999999_" + maxStr(16), phase: "outcome_unknown",
  admittedAtTick: 999999999, updatedAtTick: 999999999,
  identity: { actionKind: maxStr(64), adapterVersion: 1, adapterRegistrationId: maxStr(128),
    adapterSemanticIdentity: maxStr(128), canonicalDigest: maxStr(64), postingsDigest: maxStr(64),
    retryFactsDigest: maxStr(64), durableFacts: { version: 1000000, payload: maxStr(512) } },
  worstCase: Array.from({length:16},()=>({roomName:maxStr(8),locationKind:"storage",resource:maxStr(16),delta:-999999999})),
  invocation: { atTick: 999999999 }, external: { accepted: true, atTick: 999999999 },
  outcome: "unknown",
  outcomeEvidence: { kind: "adapter_execution_semantics", conclusion: "executed", source: maxStr(64), atTick: 999999999 },
  cleanup: { consumerKeys: Array.from({length:8},(_,i)=>"ext:"+maxStr(4)+":"+maxStr(120)), failures: 999999999 },
  retryDeadlineTick: 999999999, lastError: maxStr(192),
};
const recordBytes = JSON.stringify(worstRecord).length;
const ringBytes = JSON.stringify({attemptId:"tk1_9999999999_"+maxStr(16),workKey:maxStr(128),generation:999,terminalPhase:"retry_expired",closedAtTick:999999999}).length;
const rootBytes = JSON.stringify({version:1,installEpochId:maxStr(16),issuance:{frontier:9999999999,burned:9999999999},lifecycle:{lastBeginTick:999999999,lastEndTick:999999999},recovery:{sweepCursor:64,cleanupCursor:64,budgetTick:999999999,budgetUsed:8},active:{},ring:[],ringCursor:128,counters:{admitted:9999999999,dispatched:9999999999,settledCommitted:9999999999,settledNotExecuted:9999999999,unknown:9999999999,rearmings:9999999999,rejectedAdmissions:9999999999,recoveryAdvances:9999999999,cleanupFailures:9999999999}}).length;
const total = rootBytes + 64*recordBytes + 128*ringBytes + 63;
console.log(`worst record=${recordBytes} ring=${ringBytes} root=${rootBytes} total(64+128)=${total} budget=360000 headroom=${(360000-total).toFixed(1)} (${(((360000-total)/total)*100).toFixed(1)}%)`);
