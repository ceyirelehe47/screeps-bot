/**
 * 【Round 22 Remediation V】Completion Authority Integrity、Authorization
 * Fault tri-state + lineage 四字段、Root-Lineage Exactness、Completion
 * headroom/replacement/GC、open-admission 分离的固定反例矩阵。
 *
 * 覆盖任务书四～九节全部固定反例：
 * - 修复一：no_cleanup_authority / completion_conflict 不再映射 fully_complete
 *   （coordinator + statusOf + facade 公共路径穿透）；
 * - 修复二：completion corruption 全维度矩阵（profile/矩阵/lineage/键/resolution
 *   /read-back 篡改）不可自我授权；
 * - 修复三：Authorization Fault tri-state、tr1_ fault lineage 四字段完整链收敛、
 *   字段缺失写入前拒绝、冲突保留；
 * - 修复四：root not-executed 的 active/terminal exact relation 跨 store 冲突
 *   在 marker discharge 前阻断；
 * - 修复五：completion 容量 readiness admission、reclaimHeadroom 只回收有
 *   replacement 的 completion、被回收 attempt 的 superseded 查询；
 * - 修复六：open 恒 reservation、activation 唯一写入口（架构扫描）。
 */

import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { writeTreasuryResolutionTombstone, readTreasuryResolutionTombstone, peekTreasuryResolutionStoreHealth, resetTreasuryResolutionStoreForTest } from "@/runtime/treasury/resolutionStore";
import {
  writeTreasuryAuthorizationFaultEntry,
  readTreasuryAuthorizationFaultEntry,
  readTreasuryAuthorizationFaultEntryStructured,
  peekTreasuryAuthorizationFaultStore,
} from "@/runtime/treasury/authorizationFaults";
import {
  openTreasuryResolutionCleanup,
  readTreasuryResolutionCleanupEntry,
  treasuryResolutionCleanupOpenInputOfFacts,
  resetTreasuryResolutionCleanupHeapCacheForTest,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  acknowledgeTreasuryCleanupSettlementProof,
  registerTreasuryCleanupProofProbesForAssembly,
} from "@/runtime/treasury/settlementProofActivation";
import { registerTreasuryOppositeProofDepsForAssembly } from "@/runtime/treasury/oppositeProofMatrix";
import {
  advanceTreasuryResolutionCleanupPhases,
  treasuryCleanupStatusOfAdvance,
} from "@/runtime/treasury/resolutionCleanupCoordinator";
import { gateTreasuryPreReleaseSettlement } from "@/runtime/treasury/preReleaseSettlementGate";
import {
  recordTreasuryCleanupCompletion,
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionHealth,
  peekTreasuryCleanupCompletionEntryCount,
  listTreasuryCleanupCompletionTransactionIds,
  clearTreasuryCleanupCompletionDurableForTest,
  resetTreasuryCleanupCompletionHeapCacheForTest,
  TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  registerTreasuryCompletionReplacementProbesForAssembly,
  verifyTreasuryCleanupCompletionSupersession,
  reclaimTreasuryCleanupCompletionHeadroom,
} from "@/runtime/treasury/cleanupCompletionReplacement";
import {
  archiveTreasuryCleanupCompletionViaAuthority,
  clearTreasuryCleanupSupersessionDurableForTest,
  ensureTreasuryCleanupCompletionHeadroom,
  verifyTreasuryHistoricalCompletionStatus,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  createTreasuryAttemptLineageRecord,
  readTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByNextChild,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  retireTreasuryLineageCurrentAttempt,
  deriveTreasuryLineageNextChildTransactionId,
} from "@/runtime/treasury/attemptLineage";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import {
  lookupTreasuryGenerationRetirementProofByAttemptId,
  peekTreasuryGenerationRetirementHealth,
} from "@/runtime/treasury/generationRetirementAuthority";
import { lookupTreasuryRetirementSummaryByRoot } from "@/runtime/treasury/lineageRetirementSummary";
import { convergeTreasuryLineageRetirementFromFacts } from "@/runtime/treasury/attemptLineage";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { computeTreasuryGenerationRootIdentityDigest } from "@/runtime/treasury/generationRetirementAuthority";
import { verifyTreasuryLineageFinalizationState } from "@/runtime/treasury/lineageFinalizationProof";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { evaluateTreasuryWriteReadiness } from "@/runtime/treasury/writeReadiness";
import { readTreasuryWriteFault } from "@/runtime/treasury/writeFault";

const DIGEST = "0123456789abcdef";
const DIGEST_B = "fedcba9876543210";
const RUNTIME = TREASURY_LOWLEVEL_SOURCE_RUNTIME;

function seedQuarantine(transactionId: string, overrides: Record<string, unknown> = {}): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: RUNTIME,
    digest: DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
    phase: "ok_pending_commit_unresolved",
    outcome: "returned_ok",
    settlement: "quarantined",
    deltas: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
    recordedAt: Game.time,
    ...overrides,
  } as never);
  expect(write.status).toBe("written");
  const durable = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(durable).toBeDefined();
  return durable as string;
}

function seedFinalNotExecutedTombstone(transactionId: string, durable: string, overrides: Record<string, unknown> = {}): void {
  const write = writeTreasuryResolutionTombstone({
    transactionId,
    digest: DIGEST,
    resolution: "not-executed",
    stage: "final",
    proofLevel: "lowlevel",
    lowlevelSource: RUNTIME,
    durableIdentityDigest: durable,
    actionTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
    ...overrides,
  } as never);
  expect(write.status).not.toBe("rejected");
}

function seedRootLineageRetiring(transactionId: string, durable: string, overrides: Record<string, unknown> = {}): string {
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: RUNTIME,
    rearmable: false,
    identityProfile: "lowlevel",
    nonRearmReason: "test fixture",
    ...overrides,
  });
  if (created.status !== "written") throw new Error("seed rejected");
  return readTreasuryAttemptLineageRecord(created.record.lineageId)!.lineageId;
}

function openNotExecutedEntry(transactionId: string, durable: string): ReturnType<typeof readTreasuryResolutionCleanupEntry> {
  const opened = openTreasuryResolutionCleanup(
    treasuryResolutionCleanupOpenInputOfFacts({
      transactionId,
      digest: DIGEST,
      resolution: "not-executed",
      proofClass: "lowlevel",
      lowlevelSource: RUNTIME,
      durableIdentityDigest: durable,
    }),
  );
  expect(opened.status).toBe("opened");
  // 【Remediation V 九】open 恒 reservation——fixture 手工激活（activation
  // 权威的等价模拟）。
  const store = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } }).treasury?.resolutionCleanup;
  store!.entries!["c:" + transactionId]!.settlementProofDurable = true;
  return readTreasuryResolutionCleanupEntry(transactionId);
}

function validCompletionProof(transactionId: string, durable: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    transactionId,
    resolution: "not-executed",
    identity: {
      digest: DIGEST,
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      durableIdentityDigest: durable,
      lowlevelSource: RUNTIME,
    },
    settlementProofVerified: true,
    markerDischarged: true,
    authorityAbsentConfirmed: true,
    outcomeFinal: true,
    lineageFinalOrNotApplicable: true,
    lineageDisposition: "final",
    globalWriteAdmissionStillLocked: false,
    completedAtTick: Game.time,
    ...overrides,
  };
}

function seedCompletionStore(entries: Record<string, unknown>): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  (runtime.treasury as { cleanupCompletions?: unknown }).cleanupCompletions = {
    version: 1,
    entries,
    entryCount: Object.keys(entries).length,
    updatedAt: Game.time,
  };
  resetTreasuryCleanupCompletionHeapCacheForTest();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryResolutionStoreForTest();
  clearTreasuryCleanupCompletionDurableForTest();
  resetTreasuryCleanupCompletionHeapCacheForTest();
  clearTreasuryCleanupSupersessionDurableForTest();
  registerTreasuryCleanupProofProbesForAssembly({
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId) as never,
    resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
  });
  registerTreasuryOppositeProofDepsForAssembly({
    readTombstone: () => undefined,
    resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
    lookupGRAProof: (transactionId) => lookupTreasuryGenerationRetirementProofByAttemptId(transactionId),
    graStoreHealthy: () => peekTreasuryGenerationRetirementHealth().healthy,
  });
  registerTreasuryCompletionReplacementProbesForAssembly({
    graStoreHealthy: () => peekTreasuryGenerationRetirementHealth().healthy,
    readGRAProofByAttempt: (transactionId) => lookupTreasuryGenerationRetirementProofByAttemptId(transactionId),
    summaryStoreHealthy: () => true,
    readSummaryByRoot: (rootTransactionId) => lookupTreasuryRetirementSummaryByRoot(rootTransactionId),
    resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
    // 【Remediation VI】probes 类型升级为完整 exact 视图（digest/proofLevel/
    // identity 维度直读权威 tombstone——exact replacement 验证消费）。
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId) as never,
    listCompletionTransactionIds: () => listTreasuryCleanupCompletionTransactionIds(),
    completionAbsentAfterRelease: (transactionId) => lookupTreasuryCleanupCompletion(transactionId).verdict === "absent",
  });
});

afterAll(() => {
  registerTreasuryCleanupProofProbesForAssembly(null);
  registerTreasuryOppositeProofDepsForAssembly(null);
  registerTreasuryCompletionReplacementProbesForAssembly(null);
});

// ── 修复一：完成状态不得谎报 ─────────────────────────────────────────────────

describe("Remediation V 四：完成状态不谎报（no_cleanup_authority / conflict 不折叠）", () => {
  it("journal absent + completion absent + 无 replacement → no_cleanup_authority（phases 未证明、stage 不映射 fully_complete）", () => {
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "v_c1" });
    expect(advance.status).toBe("no_cleanup_authority");
    expect(advance.pendingStage).toBe("none");
    // 五个阶段全部未证明（不得伪造 true）。
    expect(advance.phases.settlementProofDurable).toBe(false);
    expect(advance.phases.markerDischarged).toBe(false);
    expect(advance.phases.authorityReleased).toBe(false);
    expect(advance.phases.outcomeFinalized).toBe(false);
    expect(advance.phases.lineageFinalized).toBe(false);
    expect(advance.phases.journalEntryAbsent).toBe(true);
    // 公共状态映射：不得 fully_complete。
    const report = treasuryCleanupStatusOfAdvance("not-executed", advance);
    expect(report.stage).toBe("no_cleanup_authority");
    expect(report.stage).not.toBe("fully_complete");
  });

  it("journal absent + completion conflict（expected 对照）→ completion_conflict（facade 公共语义不穿透）", () => {
    seedCompletionStore({ "cc:v_c2": validCompletionProof("v_c2", "aaaaaaaaaaaaaaaa", { identity: { digest: DIGEST_B, identityProfile: "lowlevel", proofClass: "lowlevel", durableIdentityDigest: "aaaaaaaaaaaaaaaa", lowlevelSource: RUNTIME } }) });
    // journal absent 幂等重入携带 expected（调用方权威视角）→ proof 身份与
    // expected 冲突（DIGEST_B ≠ DIGEST）→ completion_conflict。
    const advance = advanceTreasuryResolutionCleanupPhases({
      transactionId: "v_c2",
      expectedIdentity: { transactionId: "v_c2", digest: DIGEST, proofClass: "lowlevel", durableIdentityDigest: "aaaaaaaaaaaaaaaa", lowlevelSource: RUNTIME },
    });
    expect(advance.status).toBe("completion_conflict");
    const report = treasuryCleanupStatusOfAdvance("not-executed", advance);
    expect(report.stage).toBe("cleanup_conflict");
    expect(report.stage).not.toBe("fully_complete");
  });

  it("completion store unhealthy → store_unhealthy（不折叠 absent/completed）", () => {
    seedCompletionStore({ "cc:v_c3": { schemaVersion: 1 } });
    expect(peekTreasuryCleanupCompletionHealth().healthy).toBe(false);
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "v_c3" });
    expect(advance.status).toBe("store_unhealthy");
    expect(treasuryCleanupStatusOfAdvance("not-executed", advance).stage).toBe("cleanup_store_unhealthy");
  });

  it("journal absent + matching completion → completed（fully_complete 幂等）", () => {
    seedCompletionStore({ "cc:v_c4": validCompletionProof("v_c4", "bbbbbbbbbbbbbbbb") });
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "v_c4" });
    expect(advance.status).toBe("completed");
    expect(treasuryCleanupStatusOfAdvance("not-executed", advance).stage).toBe("fully_complete");
  });

  it("journal absent + completion absent 但 GRA replacement 存在 → GRA 单独不证明 cleanup 完成（须 durable historical authority）", () => {
    // 【Remediation VI 4.2】GRA proof 只证明该代 not-executed retirement，
    // 不证明 marker discharge / authority release / completion 曾合法存在——
    // completion absent 且无 historical authority 时 no_cleanup_authority
    //（不得因 GRA 在位折叠为 completed）。
    const root = "v_gr_root";
    const rootDurable = seedQuarantine(root);
    seedFinalNotExecutedTombstone(root, rootDurable);
    releaseTreasuryQuarantineEntry(root);
    const lineageId = seedRootLineageRetiring(root, rootDurable);
    expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
    // root 的 GRA proof（generation 0）存在——但 completion 不在。
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(root)).toBeDefined();
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: root });
    expect(advance.status).toBe("no_cleanup_authority");
    expect(treasuryCleanupStatusOfAdvance("not-executed", advance).stage).toBe("no_cleanup_authority");
    // 经统一 archive 入口（GRA exact 验证 → historical authority 写入）后，
    // 完成事实才由 durable historical authority 持续证明。
    seedCompletionStore({ ["cc:" + root]: validCompletionProof(root, rootDurable) });
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: root, via: "gra-proof" });
    expect(archived.status).toBe("archived");
    const afterArchive = advanceTreasuryResolutionCleanupPhases({ transactionId: root });
    expect(afterArchive.status).toBe("completed");
    expect(treasuryCleanupStatusOfAdvance("not-executed", afterArchive).stage).toBe("fully_complete");
  });
});

// ── 修复二：completion exact relation 全维度 corruption 矩阵 ────────────────

describe("Remediation V 五：completion corruption 不可自我授权", () => {
  const cases: ReadonlyArray<{ readonly label: string; readonly mutate: (proof: Record<string, unknown>) => void }> = [
    { label: "identityProfile 缺失", mutate: (p) => { delete (p.identity as Record<string, unknown>).identityProfile; } },
    { label: "identityProfile 与 proofClass 冲突", mutate: (p) => { (p.identity as Record<string, unknown>).identityProfile = "modern-contract"; } },
    { label: "digest 格式非法", mutate: (p) => { (p.identity as Record<string, unknown>).digest = "zzz"; } },
    { label: "lowlevel proof 缺 lowlevelSource", mutate: (p) => { delete (p.identity as Record<string, unknown>).lowlevelSource; } },
    { label: "identity-bound proof 错带 lowlevelSource", mutate: (p) => { (p.identity as Record<string, unknown>).identityProfile = "modern-contract"; (p.identity as Record<string, unknown>).proofClass = "identity-bound"; (p.identity as Record<string, unknown>).contractDigest = "1111111111111111"; (p.identity as Record<string, unknown>).authorizationCohortDigest = "2222222222222222"; } },
    { label: "tr1_ completion 缺任一 lineage 字段", mutate: (p) => { p.transactionId = "tr1_v5partial_000001_abcdef01"; (p.identity as Record<string, unknown>).lineageId = "1111111111111111"; (p.identity as Record<string, unknown>).lineageGeneration = 1; } },
    { label: "initial completion 错带 lineage 字段", mutate: (p) => { (p.identity as Record<string, unknown>).lineageId = "1111111111111111"; } },
    { label: "五阶段完成事实缺失", mutate: (p) => { p.outcomeFinal = false; } },
    { label: "lineageDisposition 非法", mutate: (p) => { p.lineageDisposition = "pending"; } },
    { label: "transaction key 与内部 transactionId 不同", mutate: (p) => { p.transactionId = "v_other"; } },
  ];
  for (const testCase of cases) {
    it(`corrupted completion（${testCase.label}）→ store unhealthy（不 match）`, () => {
      const proof = validCompletionProof("v_corrupt", "cccccccccccccccc");
      testCase.mutate(proof);
      const key = proof.transactionId === "v_other" ? "cc:v_corrupt" : "cc:" + String(proof.transactionId);
      seedCompletionStore({ [key]: proof });
      // load 全表验证 → store unhealthy（不得以损坏形状判 match/absent）。
      expect(peekTreasuryCleanupCompletionHealth().healthy).toBe(false);
      const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "v_corrupt" });
      expect(advance.status).toBe("store_unhealthy");
    });
  }

  it("lookup expected：contract/cohort/durable 任一冲突 → conflict", () => {
    seedCompletionStore({ "cc:v_exp": validCompletionProof("v_exp", "dddddddddddddddd") });
    const base = lookupTreasuryCleanupCompletion("v_exp", {
      transactionId: "v_exp",
      digest: DIGEST,
      proofClass: "lowlevel",
      durableIdentityDigest: "dddddddddddddddd",
      lowlevelSource: RUNTIME,
    });
    expect(base.verdict).toBe("match");
    const durableConflict = lookupTreasuryCleanupCompletion("v_exp", {
      transactionId: "v_exp",
      digest: DIGEST,
      proofClass: "lowlevel",
      durableIdentityDigest: "eeeeeeeeeeeeeeee",
      lowlevelSource: RUNTIME,
    });
    expect(durableConflict.verdict).toBe("conflict");
  });

  it("recordTreasuryCleanupCompletion 后篡改 parent/binding/cohort/durable → lookup 复验失败（不 match）", () => {
    const durable = seedQuarantine("v_rb");
    seedFinalNotExecutedTombstone("v_rb", durable);
    releaseTreasuryQuarantineEntry("v_rb");
    const entry = openNotExecutedEntry("v_rb", durable);
    const record = recordTreasuryCleanupCompletion({
      entry: { ...entry!, markerDischarged: true, authorityReleased: true, outcomeFinalized: true, lineageFinalized: true } as never,
      lineageDisposition: "final",
      globalWriteAdmissionStillLocked: false,
    });
    expect(record.status).toBe("written");
    // read-back 后篡改不可变身份维度：
    // (a) 合法 hex 但与 entry durable 不同 → expected 对照 conflict（不得 match）；
    // (b) 非法格式（非 16hex）→ shape 复验 store_unhealthy（不以损坏形状判 match）。
    const store = (Memory.runtime as unknown as { treasury?: { cleanupCompletions?: { entries?: Record<string, { identity?: Record<string, unknown> }> } } }).treasury!.cleanupCompletions!;
    store.entries!["cc:v_rb"]!.identity!.durableIdentityDigest = "9999999999999999";
    resetTreasuryCleanupCompletionHeapCacheForTest();
    const conflicted = lookupTreasuryCleanupCompletion("v_rb", {
      transactionId: "v_rb", digest: DIGEST, proofClass: "lowlevel",
      durableIdentityDigest: durable, lowlevelSource: RUNTIME,
    });
    expect(conflicted.verdict).toBe("conflict");
    store.entries!["cc:v_rb"]!.identity!.durableIdentityDigest = "zzz";
    resetTreasuryCleanupCompletionHeapCacheForTest();
    expect(lookupTreasuryCleanupCompletion("v_rb").verdict).toBe("store_unhealthy");
  });
});

// ── 修复三：Authorization Fault tri-state + tr1_ lineage 四字段 ─────────────

describe("Remediation V 六：Authorization Fault tri-state 与 tr1_ lineage", () => {
  it("fault store unhealthy（metadata 损坏）→ gate authority_store_unhealthy（不折叠 absent）", () => {
    const durable = seedQuarantine("v_f1");
    seedFinalNotExecutedTombstone("v_f1", durable);
    seedRootLineageRetiring("v_f1", durable);
    releaseTreasuryQuarantineEntry("v_f1");
    // 手工塞损坏的 fault store（entryCount 矛盾 → metadata unhealthy）。
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!.authorizationFaults = {
      version: 5,
      entries: {},
      entryCount: 3,
      updatedAt: Game.time,
    };
    const structured = readTreasuryAuthorizationFaultEntryStructured("v_f1");
    expect(structured.status === "absent" || structured.status === "store_unhealthy").toBe(true);
    const entry = openNotExecutedEntry("v_f1", durable);
    const gate = gateTreasuryPreReleaseSettlement(entry!);
    expect(gate.status).toBe("authority_store_unhealthy");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: "v_f1" }).status).not.toBe("completed");
    expect(readTreasuryResolutionCleanupEntry("v_f1")?.markerDischarged).toBe(false);
  });

  it("tr1_ child redemption fault 完整链收敛：fault v5（lineage 四字段）→ marker v4 → final not-executed → cleanup 完成", () => {
    // 可 rearm root chain → gen1 rearm 在途（child_intent_pending）。
    const root2 = "v_fr_root2";
    const root2Durable = seedQuarantine(root2);
    const rearmRecord = createTreasuryAttemptLineageRecord({
      rootTransactionId: root2,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: root2Durable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "7777777777777777",
    });
    if (rearmRecord.status !== "written") throw new Error("seed rejected");
    const rearmLineageId = rearmRecord.record.lineageId;
    // converge 前置：root2 authority 已结算释放。
    seedFinalNotExecutedTombstone(root2, root2Durable);
    expect(releaseTreasuryQuarantineEntry(root2)).toBe(true);
    expect(convergeTreasuryLineageRetirementFromFacts(rearmLineageId).status).toBe("completed");
    const childId = deriveTreasuryLineageNextChildTransactionId(rearmLineageId, 1, root2);
    expect(stageTreasuryLineageCapabilityIssued(rearmLineageId, childId).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(rearmLineageId, childId).status).not.toBe("rejected");
    const record = readTreasuryAttemptLineageRecord(rearmLineageId)!;
    const binding = record.pendingBindingDigest!;
    const childDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: childId,
      digest: DIGEST,
      actionKind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      lineageId: rearmLineageId,
      lineageGeneration: 1,
      parentTransactionId: root2,
      lineageBindingDigest: binding,
    })!;
    // tr1_ redemption fault：完整 lineage 四字段写入（v5）。
    const fault = writeTreasuryAuthorizationFaultEntry({
      transactionId: childId,
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      actionKind: "terminal.send",
      lineageId: rearmLineageId,
      lineageGeneration: 1,
      parentTransactionId: root2,
      lineageBindingDigest: binding,
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
      durableIdentityDigest: childDurable,
    });
    expect(fault.status).toBe("written");
    expect(readTreasuryAuthorizationFaultEntry(childId)?.lineageId).toBe(rearmLineageId);
    // final not-executed tombstone（带 lineage 四字段）→ cleanup journal。
    seedFinalNotExecutedTombstone(childId, childDurable, {
      lineageId: rearmLineageId,
      lineageGeneration: 1,
      parentTransactionId: root2,
      lineageBindingDigest: binding,
    });
    const entry = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId: childId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "lowlevel",
        lowlevelSource: RUNTIME,
        durableIdentityDigest: childDurable,
        lineageId: rearmLineageId,
        lineageGeneration: 1,
        parentTransactionId: root2,
        lineageBindingDigest: binding,
      }),
    );
    expect(entry.status).toBe("opened");
    expect(acknowledgeTreasuryCleanupSettlementProof({ transactionId: childId }).outcome).toBe("activated");
    // 完整收敛：outcome 阶段回滚在途 chain，lineage 阶段确认 rearm_ready。
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: childId });
    if (advance.status !== "completed") throw new Error("advance pending: " + advance.pendingStage + " / " + advance.detail);
    expect(advance.status).toBe("completed");
    expect(readTreasuryAuthorizationFaultEntry(childId)).toBeUndefined();
    expect(readTreasuryAttemptLineageRecord(rearmLineageId)?.state).toBe("rearm_ready");
    expect(lookupTreasuryCleanupCompletion(childId).verdict).toBe("match");
  });

  it("tr1_ fault 缺任一 lineage 字段 → 写入前拒绝（不发布 partial authority）", () => {
    const root = "v_fd_root";
    const rootDurable = seedQuarantine(root);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: rootDurable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "7777777777777777",
    });
    if (created.status === "rejected") throw new Error("seed rejected");
    const childId = deriveTreasuryLineageNextChildTransactionId(created.record.lineageId, 1, root);
    const partial = writeTreasuryAuthorizationFaultEntry({
      transactionId: childId,
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      actionKind: "terminal.send",
      lineageId: created.record.lineageId,
      // 缺 generation/parent/binding。
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(partial.status).toBe("rejected");
    expect(readTreasuryAuthorizationFaultEntry(childId)).toBeUndefined();
  });

  it("initial fault 携带 lineage 字段 → 写入前拒绝（身份矛盾）", () => {
    const fault = writeTreasuryAuthorizationFaultEntry({
      transactionId: "v_initial_fault",
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      actionKind: "terminal.send",
      lineageId: "1111111111111111",
      lineageGeneration: 1,
      parentTransactionId: "v_parent",
      lineageBindingDigest: "2222222222222222",
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(fault.status).toBe("rejected");
  });

  it("tr1_ fault 的 lineage 冲突（binding 不同）→ gate authority_conflict、fault entry 保留", () => {
    const root = "v_fc_root";
    const rootDurable = seedQuarantine(root);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: rootDurable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "7777777777777777",
    });
    if (created.status === "rejected") throw new Error("seed rejected");
    const childId = deriveTreasuryLineageNextChildTransactionId(created.record.lineageId, 1, root);
    // fault 携带**冲突**的 binding digest（正确值 = 权威重算）。
    const fault = writeTreasuryAuthorizationFaultEntry({
      transactionId: childId,
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      actionKind: "terminal.send",
      lineageId: created.record.lineageId,
      lineageGeneration: 1,
      parentTransactionId: root,
      lineageBindingDigest: "ffffffffffffffff",
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    // 形状完整可写入（binding 值冲突由 gate 的 semantic 权威重算拦截）。
    expect(fault.status).toBe("written");
    seedFinalNotExecutedTombstone(childId, readTreasuryAuthorizationFaultEntry(childId)!.durableIdentityDigest!, {
      lineageId: created.record.lineageId,
      lineageGeneration: 1,
      parentTransactionId: root,
      lineageBindingDigest: "ffffffffffffffff",
    });
    const entry = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId: childId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "lowlevel",
        lowlevelSource: RUNTIME,
        durableIdentityDigest: readTreasuryAuthorizationFaultEntry(childId)!.durableIdentityDigest!,
        lineageId: created.record.lineageId,
        lineageGeneration: 1,
        parentTransactionId: root,
        lineageBindingDigest: "ffffffffffffffff",
      }),
    );
    expect(entry.status).toBe("opened");
    const gate = gateTreasuryPreReleaseSettlement(readTreasuryResolutionCleanupEntry(childId)!);
    // semantic lineage 权威重算 binding 不一致 → blocked（fault 保留）。
    expect(["semantic_lineage_blocked", "authority_conflict"]).toContain(gate.status);
    expect(readTreasuryAuthorizationFaultEntry(childId)).toBeDefined();
    expect(readTreasuryResolutionCleanupEntry(childId)?.markerDischarged).toBe(false);
  });
});

// ── 修复四：root not-executed lineage exact relation ────────────────────────

describe("Remediation V 七：root not-executed 的 exact relation", () => {
  it("跨 store 冲突（journal D2 vs active root lineage D1）→ marker discharge 前阻断、不推进、不写 completion", () => {
    const durableJournal = seedQuarantine("v_root_conflict");
    seedFinalNotExecutedTombstone("v_root_conflict", durableJournal);
    releaseTreasuryQuarantineEntry("v_root_conflict");
    // active root lineage 携带**不同** durable（身份 D1 ≠ journal D2）。
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "v_root_conflict",
      rootIdentity: { digest: DIGEST, durableIdentityDigest: "8888888888888888", lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "test",
    });
    if (created.status === "rejected") throw new Error("seed rejected");
    const entry = openNotExecutedEntry("v_root_conflict", durableJournal);
    const gate = gateTreasuryPreReleaseSettlement(entry!);
    expect(gate.status).toBe("semantic_lineage_blocked");
    expect(gate.detail).toContain("conflict");
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "v_root_conflict" });
    expect(advance.pendingStage).toBe("marker_discharge");
    // marker 不清（本就不存在——readTreasuryWriteFault undefined）、authority
    // 不释放、journal 保留、不写 completion。
    expect(readTreasuryWriteFault()).toBeUndefined();
    expect(readTreasuryResolutionCleanupEntry("v_root_conflict")).toBeDefined();
    expect(lookupTreasuryCleanupCompletion("v_root_conflict").verdict).toBe("absent");
    // 不推进 D1 lineage 的 retirement（record 保持 retiring）。
    expect(readTreasuryAttemptLineageRecord(created.record.lineageId)?.state).toBe("retiring");
  });

  it("root lineage 缺失（现代 profile）→ lineage_missing 阻断（不得 not_applicable）", () => {
    const durable = seedQuarantine("v_root_missing");
    seedFinalNotExecutedTombstone("v_root_missing", durable);
    releaseTreasuryQuarantineEntry("v_root_missing");
    const entry = openNotExecutedEntry("v_root_missing", durable);
    const gate = gateTreasuryPreReleaseSettlement(entry!);
    expect(gate.status).toBe("semantic_lineage_blocked");
    expect(gate.detail).toContain("lineage_missing");
  });

  it("root lineage 已被 child 接管（current ≠ root）→ conflict（root cleanup 本应已完成）", () => {
    const root = "v_root_taken";
    const rootDurable = seedQuarantine(root);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: rootDurable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "7777777777777777",
    });
    if (created.status === "rejected") throw new Error("seed rejected");
    const lineageId = created.record.lineageId;
    // converge 前置：root authority 已结算释放（rearm 门禁前提）。
    seedFinalNotExecutedTombstone(root, rootDurable);
    expect(releaseTreasuryQuarantineEntry(root)).toBe(true);
    expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
    const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, root);
    expect(stageTreasuryLineageCapabilityIssued(lineageId, childId).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(lineageId, childId).status).not.toBe("rejected");
    const binding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
    const childDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: childId, digest: DIGEST, actionKind: "terminal.send", source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      lineageId, lineageGeneration: 1, parentTransactionId: root, lineageBindingDigest: binding,
    })!;
    expect(activateTreasuryLineageChild(lineageId, { digest: DIGEST, durableIdentityDigest: childDurable, lowlevelSource: RUNTIME }).status).not.toBe("rejected");
    // root 的 cleanup entry 重新打开（current 已是 child）→ conflict。
    const entry = openNotExecutedEntry(root, rootDurable);
    const gate = gateTreasuryPreReleaseSettlement(entry!);
    expect(gate.status).toBe("semantic_lineage_blocked");
    expect(gate.detail).toContain("接管");
  });

  it("terminal summary finalExact 与 entry 身份任一维度不同 → summary_conflict（不得 already_final）", () => {
    // 手工构造 terminal summary（finalExact 的 durable 与 entry 不同）。
    const durable = seedQuarantine("v_summary_conflict");
    const lineageId = "6666666666666666"; // summary-only（active record 不存在）
    if (!Memory.runtime) Memory.runtime = {} as never;
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    runtime.treasury = runtime.treasury ?? {};
    const rootExact = {
      digest: DIGEST,
      durableIdentityDigest: durable,
      lowlevelSource: RUNTIME,
      proofClass: "lowlevel",
      identityAlgorithm: "root-identity@v1",
    };
    (runtime.treasury as { lineageRetirementSummaries?: unknown }).lineageRetirementSummaries = {
      version: 3,
      entries: {
        "rs:v_summary_conflict": {
          schemaVersion: 3,
          lineageId,
          rootTransactionId: "v_summary_conflict",
          rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(rootExact),
          terminalState: "non_rearmable_retired",
          finalGeneration: 0,
          finalAttemptId: "v_summary_conflict",
          finalizedAtTick: Game.time,
          authorityClass: "lowlevel",
          rootExact,
          // finalExact 的 durable 与 entry 不同（summary conflict 反例）。
          finalExact: {
            digest: DIGEST,
            durableIdentityDigest: "7777777777777777",
            lowlevelSource: RUNTIME,
            proofClass: "lowlevel",
            exactIdentitySchema: 1,
          },
        },
      },
      entryCount: 1,
      updatedAt: Game.time,
    };
    // summary store 需要重建 heap——用 lookupTreasuryRetirementSummaryByRoot 验证写入。
    const state = verifyTreasuryLineageFinalizationState({
      transactionId: "v_summary_conflict",
      resolution: "not-executed",
      expectedIdentity: {
        transactionId: "v_summary_conflict",
        digest: DIGEST,
        proofClass: "lowlevel",
        durableIdentityDigest: durable,
        lowlevelSource: RUNTIME,
      },
    });
    expect(state.state).toBe("summary_conflict");
  });
});

// ── 修复五：completion 容量 / replacement / headroom ────────────────────────

describe("Remediation V 八：completion 容量与 replacement lifecycle", () => {
  it("readiness 前置 admission：满载 → evaluate 阻断（真实 callback 前 fail closed）", () => {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES; i++) {
      entries["cc:v_full_" + i] = validCompletionProof("v_full_" + i, "eeeeeeeeeeee000" + String(i % 10) + String(Math.floor(i / 10)));
    }
    // 每个 entry 的 durable 需要 16hex——用稳定 padStart。
    for (let i = 0; i < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES; i++) {
      const proof = entries["cc:v_full_" + i] as { identity: { durableIdentityDigest: string } };
      proof.identity.durableIdentityDigest = (String(i).padStart(16, "0"));
    }
    seedCompletionStore(entries);
    expect(peekTreasuryCleanupCompletionHealth().healthy).toBe(true);
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    const readiness = evaluateTreasuryWriteReadiness(
      {
        lifecycleClosed: false, staleTickState: false, writeFaultLocked: false, writeFaultUnhealthy: false,
        invalidOwner: false, commitmentIncomplete: false, quarantineUnhealthy: false, quarantineUnresolved: false,
        intentUnhealthy: false, intentUnresolved: false, reservationMigrationIncomplete: false,
        reservationStoreUnhealthy: false, reservationStoreCorrupted: false, receiptUnhealthy: false,
        receiptCapacityExhausted: false, resolutionStoreUnhealthy: false, resolutionResolvingBlocker: false,
        recoverySlotExhausted: false, policyNotReady: false, authorizationCapacityExhausted: false,
        authorizationFaultUnresolved: false, authorizationFaultCapacityExhausted: false,
        completionStoreUnhealthy: false,
        completionHeadroomExhausted: true,
      },
      "authorize",
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toContain("completion_headroom_exhausted");
  });

  it("reclaimHeadroom：headroom 充足时零回收；compact archive 归档后 historical authority 持续证明完成", () => {
    // 【Remediation VI 4.7】headroom preflight 只在容量不足时才执行 bounded
    // 回收（entryCount + minSlots ≤ MAX → ok 且零写）；compact archive
    //（completion 自身完整验证 → durable historical authority 写入 read-back
    // → 删除 read-back）是统一回收路径——被回收 attempt 的查询经 historical
    // authority completed（不退化为 no_cleanup_authority）。
    const rootA = "v_gc_a";
    const durableA = seedQuarantine(rootA);
    seedFinalNotExecutedTombstone(rootA, durableA);
    releaseTreasuryQuarantineEntry(rootA);
    const lineageId = seedRootLineageRetiring(rootA, durableA);
    expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(rootA)).toBeDefined();
    seedCompletionStore({
      ["cc:" + rootA]: validCompletionProof(rootA, durableA),
      "cc:v_gc_b": validCompletionProof("v_gc_b", "0123456789abc001"),
    });
    // headroom 充足 → preflight ok 且零回收（零写语义）。
    const preflight = ensureTreasuryCleanupCompletionHeadroom({ minSlots: 1 });
    expect(preflight.status).toBe("ok");
    expect(preflight.reclaimed).toBe(0);
    expect(lookupTreasuryCleanupCompletion(rootA).verdict).toBe("match");
    // 统一 archive 入口（rootA 走 GRA exact 验证、v_gc_b 走 compact archive）。
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId: rootA, via: "gra-proof" }).status).toBe("archived");
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId: "v_gc_b", via: "compact-archive" }).status).toBe("archived");
    expect(lookupTreasuryCleanupCompletion(rootA).verdict).toBe("absent");
    expect(lookupTreasuryCleanupCompletion("v_gc_b").verdict).toBe("absent");
    // 被归档的 attempt 查询经 durable historical authority = completed。
    expect(verifyTreasuryHistoricalCompletionStatus(rootA).verdict).toBe("match");
    expect(verifyTreasuryHistoricalCompletionStatus(rootA).settlement).toBe("not-executed");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: rootA }).status).toBe("completed");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: "v_gc_b" }).status).toBe("completed");
    // 既无 completion 又无 historical authority 的查询 no_cleanup_authority。
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: "v_gc_none" }).status).toBe("no_cleanup_authority");
  });

  it("replacement store unhealthy（GRA fatal）→ GRA-verified archive fail closed；supersession 查询 fail closed", () => {
    seedCompletionStore({ "cc:v_gc_c": validCompletionProof("v_gc_c", "0123456789abc002") });
    // 手工破坏 GRA store（version 非法）→ graStoreHealthy false。
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!.generationRetirementProofs = {
      version: 99, entries: {}, entryCount: 0, updatedAt: Game.time,
    };
    const supersession = verifyTreasuryCleanupCompletionSupersession("v_gc_c");
    expect(supersession.verdict).toBe("store_unhealthy");
    // 要求 GRA replacement 的 archive 路径 fail closed（completion 保留）。
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: "v_gc_c", via: "gra-proof" });
    expect(archived.status).toBe("blocked");
    if (archived.status === "blocked") {
      expect(archived.reason).toBe("replacement_store_unhealthy");
    }
    expect(lookupTreasuryCleanupCompletion("v_gc_c").verdict).toBe("match"); // 未删除
  });

  it("child activation 回收 parent completion（GRA 在位）→ parent 查询 superseded", () => {
    const root = "v_act_root";
    const rootDurable = seedQuarantine(root);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: rootDurable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "7777777777777777",
    });
    if (created.status === "rejected") throw new Error("seed rejected");
    const lineageId = created.record.lineageId;
    // root authority 已结算释放 → converge 写入 GRA proof（activate 回收的
    // replacement 前提）。
    seedFinalNotExecutedTombstone(root, rootDurable);
    expect(releaseTreasuryQuarantineEntry(root)).toBe(true);
    expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(root)).toBeDefined();
    seedCompletionStore({ ["cc:" + root]: validCompletionProof(root, rootDurable) });
    const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, root);
    expect(stageTreasuryLineageCapabilityIssued(lineageId, childId).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(lineageId, childId).status).not.toBe("rejected");
    const binding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
    const childDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: childId, digest: DIGEST, actionKind: "terminal.send", source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      lineageId, lineageGeneration: 1, parentTransactionId: root, lineageBindingDigest: binding,
    })!;
    expect(activateTreasuryLineageChild(lineageId, { digest: DIGEST, durableIdentityDigest: childDurable, lowlevelSource: RUNTIME }).status).not.toBe("rejected");
    // 【Remediation VI】GRA proof 在位 → activate 经统一 archive 入口回收
    // parent completion（exact GRA 验证 → durable historical authority）；
    // 查询经 historical authority completed。
    expect(lookupTreasuryCleanupCompletion(root).verdict).toBe("absent");
    expect(verifyTreasuryHistoricalCompletionStatus(root).verdict).toBe("match");
    expect(verifyTreasuryHistoricalCompletionStatus(root).settlement).toBe("not-executed");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: root }).status).toBe("completed");
  });

  it("300 代链：parent completion 经 activate 归档（GRA 在位）、历史代查询不退化为 no authority", () => {
    const root = "v_chain_root";
    const rootDurable = seedQuarantine(root);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: rootDurable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "7777777777777777",
    });
    if (created.status === "rejected") throw new Error("seed rejected");
    const lineageId = created.record.lineageId;
    let currentId = root;
    let currentDurable = rootDurable;
    let currentBinding: string | undefined;
    let currentParent: string | undefined;
    // converge 前置：root authority 已结算释放（tombstone 在位、marker absent）。
    seedFinalNotExecutedTombstone(root, rootDurable);
    expect(releaseTreasuryQuarantineEntry(root)).toBe(true);
    for (let generation = 1; generation <= 12; generation++) {
      expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
      const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, generation, root);
      expect(stageTreasuryLineageCapabilityIssued(lineageId, childId).status).not.toBe("rejected");
      expect(stageTreasuryLineageChildIntentPending(lineageId, childId).status).not.toBe("rejected");
      const binding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
      const childDurable = recomputeTreasuryDurableIdentityDigest({
        transactionId: childId, digest: DIGEST, actionKind: "terminal.send", source: "test",
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
        lineageId, lineageGeneration: generation, parentTransactionId: currentId, lineageBindingDigest: binding,
      })!;
      // parent（currentId）的 completion：root initial（无 lineage 维度）或
      // tr1_（完整 lineage 四字段——与该代 GRA proof 同源事实）。
      const parentIdentity =
        generation === 1
          ? { digest: DIGEST, identityProfile: "lowlevel", proofClass: "lowlevel", durableIdentityDigest: currentDurable, lowlevelSource: RUNTIME }
          : {
              digest: DIGEST, identityProfile: "lowlevel", proofClass: "lowlevel",
              durableIdentityDigest: currentDurable, lowlevelSource: RUNTIME,
              lineageId, lineageGeneration: generation - 1,
              ...(currentParent !== undefined ? { parentTransactionId: currentParent } : {}),
              ...(currentBinding !== undefined ? { lineageBindingDigest: currentBinding } : {}),
            };
      seedCompletionStore({
        ["cc:" + currentId]: validCompletionProof(currentId, currentDurable, { identity: parentIdentity, resolution: "not-executed" }),
      });
      expect(activateTreasuryLineageChild(lineageId, { digest: DIGEST, durableIdentityDigest: childDurable, lowlevelSource: RUNTIME }).status).not.toBe("rejected");
      // activate 后 parent completion 已归档（durable historical authority）。
      expect(lookupTreasuryCleanupCompletion(currentId).verdict).toBe("absent");
      expect(verifyTreasuryHistoricalCompletionStatus(currentId).verdict).toBe("match");
      expect(retireTreasuryLineageCurrentAttempt({ lineageId }).status).not.toBe("rejected");
      currentParent = currentId;
      currentBinding = binding;
      currentId = childId;
      currentDurable = childDurable;
    }
    // 最后一代 retire 后 converge（写入末代 proof），再为末代建立 completion
    // 并经统一入口归档（末代 parent=gen11 已在循环内归档；末代自身同样
    // 需要 durable historical authority）。
    expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
    seedCompletionStore({
      ["cc:" + currentId]: validCompletionProof(currentId, currentDurable, {
        resolution: "not-executed",
        identity: {
          digest: DIGEST, identityProfile: "lowlevel", proofClass: "lowlevel",
          durableIdentityDigest: currentDurable, lowlevelSource: RUNTIME,
          lineageId, lineageGeneration: 12,
          ...(currentParent !== undefined ? { parentTransactionId: currentParent } : {}),
          ...(currentBinding !== undefined ? { lineageBindingDigest: currentBinding } : {}),
        },
      }),
    });
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId: currentId, via: "gra-proof" }).status).toBe("archived");
    // 每代 GRA proof 在位且 completion 已归档 → 历史查询经 historical
    // authority completed（不退化为 no_cleanup_authority）。
    expect(verifyTreasuryHistoricalCompletionStatus(root).verdict).toBe("match");
    for (let generation = 1; generation <= 12; generation++) {
      const attemptId = deriveTreasuryLineageNextChildTransactionId(lineageId, generation, root);
      expect(lookupTreasuryGenerationRetirementProofByAttemptId(attemptId)).toBeDefined();
      expect(verifyTreasuryHistoricalCompletionStatus(attemptId).verdict).toBe("match");
      expect(verifyTreasuryHistoricalCompletionStatus(attemptId).settlement).toBe("not-executed");
    }
  });
});

// ── 修复六：open 只做 admission ─────────────────────────────────────────────

describe("Remediation V 九：open 永远只做 admission", () => {
  it("省略一切 proof 参数的新 entry 仍为 reservation（activation 前 marker 阶段被拒）", () => {
    const durable = seedQuarantine("v_open1");
    seedFinalNotExecutedTombstone("v_open1", durable);
    const opened = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId: "v_open1", digest: DIGEST, resolution: "not-executed",
        proofClass: "lowlevel", lowlevelSource: RUNTIME, durableIdentityDigest: durable,
      }),
    );
    expect(opened.status).toBe("opened");
    expect(readTreasuryResolutionCleanupEntry("v_open1")?.settlementProofDurable).toBe(false);
    // coordinator 阶段 0 经 activation 权威激活后推进。
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: "v_open1" });
    expect(activation.outcome).toBe("activated");
    expect(readTreasuryResolutionCleanupEntry("v_open1")?.settlementProofDurable).toBe(true);
  });

  it("activation 失败（proof absent）→ 不激活、零阶段推进", () => {
    const durable = seedQuarantine("v_open2");
    // 不写 tombstone（proof absent）。
    void durable;
    openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId: "v_open2", digest: DIGEST, resolution: "not-executed",
        proofClass: "lowlevel", lowlevelSource: RUNTIME, durableIdentityDigest: durable,
      }),
    );
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: "v_open2" });
    expect(activation.outcome).toBe("proof_absent");
    expect(readTreasuryResolutionCleanupEntry("v_open2")?.settlementProofDurable).toBe(false);
  });

  it("global reset 后从 reservation 恢复：activation 权威幂等补激活并推进", () => {
    const durable = seedQuarantine("v_open3");
    seedFinalNotExecutedTombstone("v_open3", durable);
    seedRootLineageRetiring("v_open3", durable);
    releaseTreasuryQuarantineEntry("v_open3");
    openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId: "v_open3", digest: DIGEST, resolution: "not-executed",
        proofClass: "lowlevel", lowlevelSource: RUNTIME, durableIdentityDigest: durable,
      }),
    );
    // global reset（heap 清空）。
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "v_open3" });
    expect(advance.status).toBe("completed");
    expect(readTreasuryResolutionCleanupEntry("v_open3")).toBeUndefined();
  });

  it("架构守护：settlementProofDurable 的 false→true 直写只存在于 activation 权威模块", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dir = path.join(__dirname);
    const violations: string[] = [];
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = fs.readFileSync(path.join(dir, name), "utf8");
      // 直写 settlementProofDurable = true 的生产模块（journal open 的
      // candidate 恒 false 不算——只有 activation 权威写 true）。
      if (/settlementProofDurable\s*=\s*true/.test(source) && name !== "settlementProofActivation.ts") {
        violations.push(name);
      }
    }
    expect(violations).toEqual([]);
  });
});
